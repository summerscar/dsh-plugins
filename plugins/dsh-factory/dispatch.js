/**
 * dsh-factory — card dispatch (batch-1 close: card → session → worktree → context).
 *
 * Dispatch is the one action that actually creates a session, so it must never
 * leave a card in a fake "dispatched" state when a step fails. The order is
 * deliberate:
 *
 *   1. create the per-card worktree
 *   2. create the session, registering the work-item context on that session's
 *      own `agent.ctx` inside the factory `setup` step (so it exists before the
 *      first prompt assembly)
 *   3. send the first message
 *   4. only now persist `worktreePath/branch/sessionId` and move Inbox→Triage
 *
 * Any failure unwinds: the session is disposed and the worktree removed, while
 * the card is left exactly as it was (the status transition happens last, so a
 * failure can never strand it in "dispatched"). That is why this module takes an
 * injectable `port`: the orchestration and rollback are unit-tested with a fake
 * port, and the real host adapter (`createHostPort`) is a thin, separately
 * verifiable seam over `ctx.agents.create` + real git.
 */
import { randomUUID } from 'node:crypto'

import { attachSessionContext, buildSessionContext } from './session-context.js'
import { createWorktree, removeWorktree, worktreePathFor } from './worktree.js'

/** Branch name a card's work gets in its worktree. */
export function branchForCard(cardId) {
  return `factory/${cardId}`
}

/**
 * Provision a session + worktree for a card. `port` supplies the side effects:
 *   { createWorktree(opts), removeWorktree(opts), createSession(opts), disposeSession(created) }
 *
 * @returns {{ sessionId: string, worktreePath: string } | { reused: true, sessionId: string }}
 */
export async function dispatchCard({ store, cardId, port, baseBranch = 'main' } = {}) {
  const card = store.getCard(cardId)
  if (card === undefined || card === null) throw new Error(`卡片不存在：${cardId}`)
  const project = store.getProject(card.projectId)
  if (project === undefined || project === null) throw new Error(`项目不存在：${card.projectId}`)

  // Atomically reserve the card before any await, so two concurrent dispatches
  // cannot both spawn a session for the same card (the race the sync claim closes).
  const claim = store.claimForDispatch(cardId)
  if (claim.claimed !== true) {
    if (claim.reason === 'already-dispatched') return { reused: true, sessionId: claim.sessionId }
    throw new Error('该卡正在被派发（并发锁），请稍后重试')
  }

  const branch = branchForCard(cardId)
  let worktreePath = null
  let created = null
  let worktreeMade = false
  try {
    worktreePath = worktreePathFor(project, cardId)
    port.createWorktree({ repoPath: project.rootPath, worktreePath, branch, baseBranch })
    worktreeMade = true

    // The first message and the injected section share the same field set; build
    // it against the worktree we just made so worktreePath is populated.
    const built = buildSessionContext({ card: { ...card, worktreePath, branch }, project })

    created = await port.createSession({
      cwd: worktreePath,
      permission: project.defaultPermission,
      model: project.defaultModel,
      // `setup(agentCtx)` runs before the first prompt assembly: this is where the
      // per-session work-item context is registered, scoped to this agent alone.
      // DSH runs `setupCommit?.commit()` on whatever `setup` returns (dsh-agent-loop
      // index.js:1591-1593). Returning the disposer function would crash on `.commit`;
      // so register the per-session context and return nothing, exactly like DSH's own
      // setup callbacks (dsh-api-session-controller / dsh-agent-loop return undefined).
      setup: (agentCtx) => {
        attachSessionContext({ agentCtx, store, cardId })
      },
      firstMessage: built.firstMessage,
    })

    // Success path — persist and only now advance the card.
    store.setWorktree(cardId, { worktreePath, branch, baseBranch, sessionId: created.sessionId })
    const fresh = store.getCard(cardId)
    if (fresh.status === 'inbox') store.transitionCard(cardId, 'triage', 'human')
    return { sessionId: created.sessionId, worktreePath }
  } catch (error) {
    // Roll back everything we created; the card stays as it was (never transitioned).
    try { if (created !== null) await port.disposeSession(created) } catch { /* best effort */ }
    try { if (worktreeMade) port.removeWorktree({ repoPath: project.rootPath, worktreePath, force: true, branch }) } catch { /* best effort */ }
    store.releaseClaim(cardId, claim.token)
    throw error
  }
}

/**
 * Real host port: wires the orchestration to the DSH `agents` service and real
 * git. Contract verified against the live host (2026-11-15):
 *   - `agents.create({ sessionId, meta: { cwd }, setup })` → `{ agent, dispose }`
 *     (dsh-agent CreateAgentOptions / AgentHandle).
 *   - `setup` must return `undefined` or an object with a real `commit()`; the loop
 *     runs `setupCommit?.commit()` once it resolves (dsh-agent-loop index.js:1591-1593).
 *   - the first message must be a real UserMessage: `agent.followup(createUserMessage({
 *     content: [{ type: 'text', text }], source: { kind: 'user' } }))` — see
 *     dsh-headless index.ts:420. A bare `{ content }` object is not a valid message.
 *
 * `createUserMessage` is the host `@deepseek-ai/dsh-llm` peer, loaded via dynamic
 * import with a minimal fallback shape. `permission`/`model` on createSession are
 * accepted but not yet wired into the live session (PRD §12 option surface); they
 * do not block dispatch.
 */
let cachedCreateUserMessage = null
async function resolveCreateUserMessage() {
  if (cachedCreateUserMessage !== null) return cachedCreateUserMessage
  try {
    const mod = await import('@deepseek-ai/dsh-llm')
    if (typeof mod.createUserMessage === 'function') {
      cachedCreateUserMessage = mod.createUserMessage
      return cachedCreateUserMessage
    }
  } catch { /* host peer unavailable: fall back to a bare user-role shape */ }
  cachedCreateUserMessage = ({ content, source }) => ({ role: 'user', content, source })
  return cachedCreateUserMessage
}

export function createHostPort({ ctx, createUserMessage } = {}) {
  const agents = typeof ctx?.get === 'function' ? ctx.get('agents') : undefined
  if (agents === undefined || agents === null || typeof agents.create !== 'function') {
    throw new Error('host has no agents service; cannot dispatch a session')
  }
  return {
    createWorktree: (options) => createWorktree(options),
    removeWorktree: (options) => removeWorktree(options),
    async createSession({ cwd, setup, firstMessage }) {
      const sessionId = randomUUID()
      const handle = await agents.create({ sessionId, meta: { cwd }, setup })
      try {
        const agent = handle.agent
        if (agent !== undefined && agent !== null && typeof agent.followup === 'function') {
          const makeUserMessage = createUserMessage ?? await resolveCreateUserMessage()
          agent.followup(makeUserMessage({ content: [{ type: 'text', text: firstMessage }], source: { kind: 'user' } }))
        }
      } catch (error) {
        try { await handle.dispose() } catch { /* best effort */ }
        throw error
      }
      return { sessionId, handle }
    },
    async disposeSession(created) {
      if (created !== null && created !== undefined && typeof created.handle?.dispose === 'function') {
        await created.handle.dispose()
      }
    },
  }
}
