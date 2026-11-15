/**
 * dsh-factory — card dispatch and stage continuation.
 *
 * Two entry points, one shared guard:
 *
 *  - `dispatchCard` is the FIRST dispatch of a card: it creates the worktree,
 *    runs the project's preparation, creates a session and sends the first
 *    message. Every step is ordered so a failure can never leave the card in a
 *    fake "dispatched" state.
 *
 *  - `continueCard` is every LATER stage. The card already has a worktree and a
 *    branch; only a session has to be obtained. It walks a three-level chain,
 *    highest availability first, and records every fallback:
 *
 *        1. session still live  → `agent.followup(message)`   (cheapest)
 *        2. session gone, history on disk → `agents.resume({ resumeSessionId })`
 *        3. history unusable    → new session + history digest, RECORDED
 *
 *    Level 3 must be recorded on the card (see `recordContinuationFallback`).
 *    Without that record, "the agent suddenly does not know the context" becomes
 *    a bug nobody can trace.
 *
 * Both run `claimForDispatch` first. A card's `sessionId` no longer blocks a
 * later stage (it used to, which deadlocked every card after its first turn);
 * what blocks is a session that is genuinely still live, which only the host can
 * answer, so the port resolves it and passes `sessionActive` in.
 *
 * The module takes an injectable `port`, so the orchestration, the fallback
 * chain and the rollbacks are exercised without a running host; `createHostPort`
 * is the thin adapter over `ctx.agents`.
 */
import { randomUUID } from 'node:crypto'

import { attachSessionContext, buildSessionContext } from './session-context.js'
import { createWorktree, removeWorktree, worktreePathFor } from './worktree.js'
import { hasPreparation, prepareWorktree } from './worktree-setup.js'

/** Branch name a card's work gets in its worktree. */
export function branchForCard(cardId) {
  return `factory/${cardId}`
}

/** Statuses a session may work in. `plan-review` / `review` wait for a human. */
const AGENT_STATUSES = new Set(['inbox', 'triage', 'plan', 'build'])

/**
 * Whether a card may be dispatched at all. Terminal cards and cards waiting for
 * a human are never dispatched: the agent cannot move them, so a dispatch would
 * only spin.
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function assertDispatchable(card) {
  if (card === undefined || card === null) return { ok: false, reason: 'missing-card' }
  if (card.stalled === true) return { ok: false, reason: 'stalled' }
  if (card.status === 'done' || card.status === 'canceled') return { ok: false, reason: 'terminal' }
  if (!AGENT_STATUSES.has(card.status)) return { ok: false, reason: 'waiting-for-human' }
  return { ok: true }
}

/** Resolve the project + card pair both entry points need. */
function resolveTargets({ store, cardId }) {
  const card = store.getCard(cardId)
  if (card === undefined || card === null) throw new Error(`卡片不存在：${cardId}`)
  const project = store.getProject(card.projectId)
  if (project === undefined || project === null) throw new Error(`项目不存在：${card.projectId}`)
  return { card, project }
}

/**
 * First dispatch: provision worktree + session, then advance Inbox → Triage.
 *
 * `port` supplies the side effects:
 *   { createWorktree, removeWorktree, prepareWorktree?, createSession,
 *     disposeSession, isSessionActive? }
 */
export async function dispatchCard({ store, cardId, port, baseBranch = 'main', transitionActor = 'human', transitionMeta = undefined } = {}) {
  const { card, project } = resolveTargets({ store, cardId })
  const gate = assertDispatchable(card)
  if (gate.ok !== true) throw new Error(`该卡当前不可派发：${gate.reason}`)

  // FIRST dispatch only. A card that already has a worktree or a session has
  // been provisioned once; dispatching again would create a second worktree and
  // a second session and orphan the first. This guard lives here, not in
  // `claimForDispatch`, because that claim is now purely the concurrency lock —
  // and a *continuation* legitimately wants the live session the old guard used
  // to refuse. "Dispatch" (create) and "continue" (reuse) are different intents,
  // so the caller is told what already exists and decides.
  const alreadyProvisioned = (typeof card.worktreePath === 'string' && card.worktreePath !== '')
    || (typeof card.sessionId === 'string' && card.sessionId !== '')
  if (alreadyProvisioned) {
    return {
      mode: 'already-dispatched',
      sessionId: card.sessionId ?? null,
      worktreePath: card.worktreePath ?? null,
      hint: 'this card already has a worktree/session; POST /cards/:id/continue to move it to its next stage',
    }
  }

  const claim = store.claimForDispatch(cardId)
  if (claim.claimed !== true) {
    if (claim.reason === 'busy') throw new Error('该卡正在被派发（并发锁），请稍后重试')
    throw new Error(`该卡当前不可派发：${claim.reason}`)
  }

  const branch = branchForCard(cardId)
  let worktreePath = null
  let created = null
  let worktreeMade = false
  try {
    worktreePath = worktreePathFor(project, cardId)
    port.createWorktree({ repoPath: project.rootPath, worktreePath, branch, baseBranch })
    worktreeMade = true

    // A fresh worktree holds only git-tracked files. Run the project's own
    // preparation (copyFiles → postCreate) BEFORE the session exists, so a
    // failure can never leave an agent working in a half-built environment.
    // Skipped entirely when neither field is configured (backwards compatible).
    if (hasPreparation(project)) {
      if (typeof port.prepareWorktree !== 'function') {
        throw new Error('项目配置了 worktree 准备步骤，但派发端口未提供 prepareWorktree')
      }
      port.prepareWorktree({ project, worktreePath, branch, baseBranch })
    }

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
    store.clearDispatchFailures(cardId)
    const fresh = store.getCard(cardId)
    // G2: a person pressing "start" dispatches as `human`; the L1 engine passes
    // `autoRule` (plus tier/rule/channel) so audits can tell the two apart. The
    // actor is validated by assertTransition against `inbox->triage`.
    if (fresh.status === 'inbox') store.transitionCard(cardId, 'triage', transitionActor, undefined, transitionMeta)
    return { sessionId: created.sessionId, worktreePath, mode: 'created' }
  } catch (error) {
    // Roll back everything we created; the card stays as it was (never transitioned).
    try { if (created !== null) await port.disposeSession(created) } catch { /* best effort */ }
    try { if (worktreeMade) port.removeWorktree({ repoPath: project.rootPath, worktreePath, force: true, branch }) } catch { /* best effort */ }
    store.recordDispatchFailure(cardId, { reason: error instanceof Error ? error.message : String(error) })
    store.releaseClaim(cardId, claim.token)
    throw error
  }
}

/**
 * Continue a card into its next stage.
 *
 * Reuses the existing worktree and branch — a continuation never creates a new
 * one and never switches branches. Only a session is obtained, through the
 * three-level chain documented at the top of this file.
 *
 * @returns {{ sessionId: string, worktreePath: string, mode: 'followup'|'resumed'|'created', fallbackRecorded?: boolean }}
 */
export async function continueCard({ store, cardId, port, message, failureLimit } = {}) {
  const { card, project } = resolveTargets({ store, cardId })
  const gate = assertDispatchable(card)
  if (gate.ok !== true) throw new Error(`该卡当前不可接续：${gate.reason}`)

  const worktreePath = card.worktreePath
  const branch = card.branch
  if (typeof worktreePath !== 'string' || worktreePath === '') {
    throw new Error('该卡没有 worktree，应使用首次派发而不是接续')
  }

  // Only a session the host says is still live decides which level answers; it
  // never blocks the claim itself (a live session is what level 1 wants).
  const previousSessionId = typeof card.sessionId === 'string' && card.sessionId !== '' ? card.sessionId : undefined
  const sessionActive = previousSessionId !== undefined && typeof port.isSessionActive === 'function'
    ? await port.isSessionActive(previousSessionId)
    : false

  const claim = store.claimForDispatch(cardId)
  if (claim.claimed !== true) {
    throw new Error('该卡正在被接续（并发锁），请稍后重试')
  }

  const built = buildSessionContext({ card, project })
  const text = typeof message === 'string' && message !== '' ? message : built.firstMessage
  let created = null
  let resumeFailure
  try {
    // Level 1 — the session is still live: cheapest, no rebuild.
    if (sessionActive === true && previousSessionId !== undefined) {
      await port.followupSession({ sessionId: previousSessionId, message: text })
      store.releaseClaim(cardId, claim.token)
      store.clearDispatchFailures(cardId)
      store.recordContinuation(cardId, { sessionId: previousSessionId, mode: 'followup' })
      return { sessionId: previousSessionId, worktreePath, mode: 'followup' }
    }

    // Level 2 — session gone but its history is on disk: rebuild on it.
    if (previousSessionId !== undefined && typeof port.resumeSession === 'function') {
      try {
        created = await port.resumeSession({
          resumeSessionId: previousSessionId,
          cwd: worktreePath,
          setup: (agentCtx) => { attachSessionContext({ agentCtx, store, cardId }) },
          firstMessage: text,
        })
        store.setWorktree(cardId, { sessionId: created.sessionId })
        store.clearDispatchFailures(cardId)
        store.releaseClaim(cardId, claim.token)
        store.recordContinuation(cardId, { sessionId: created.sessionId, mode: 'resumed' })
        return { sessionId: created.sessionId, worktreePath, mode: 'resumed' }
      } catch (resumeError) {
        // Level 3 handles it below; keep the reason for the record.
        created = null
        resumeFailure = resumeError
      }
    }

    // Level 3 — history unusable: a fresh session, with the digest injected, and
    // a RECORD on the card so a context-less agent is explainable later.
    created = await port.createSession({
      cwd: worktreePath,
      permission: project.defaultPermission,
      model: project.defaultModel,
      setup: (agentCtx) => { attachSessionContext({ agentCtx, store, cardId }) },
      firstMessage: text,
    })
    store.setWorktree(cardId, { sessionId: created.sessionId })
    store.clearDispatchFailures(cardId)
    store.releaseClaim(cardId, claim.token)
    store.recordContinuationFallback(cardId, {
      from: previousSessionId,
      reason: typeof resumeFailure === 'undefined'
        ? 'no persisted session to resume'
        : (resumeFailure instanceof Error ? resumeFailure.message : String(resumeFailure)),
    })
    store.recordContinuation(cardId, { sessionId: created.sessionId, mode: 'created' })
    return { sessionId: created.sessionId, worktreePath, mode: 'created', fallbackRecorded: true }
  } catch (error) {
    try { if (created !== null) await port.disposeSession(created) } catch { /* best effort */ }
    // A failed continuation never deletes the worktree: it is shared with earlier
    // stages and may already hold work. The card status is left untouched too.
    store.recordDispatchFailure(cardId, {
      reason: error instanceof Error ? error.message : String(error),
      ...(failureLimit === undefined ? {} : { limit: failureLimit }),
    })
    store.releaseClaim(cardId, claim.token)
    throw error
  }
}

/**
 * Real host port: wires the orchestration to the DSH `agents` service and real
 * git. Contract verified against the live host (2026-11-15):
 *   - `agents.create({ sessionId, meta: { cwd }, setup })` → `{ agent, dispose }`
 *     (dsh-agent CreateAgentOptions / AgentHandle).
 *   - `agents.resume({ resumeSessionId, agentOptions, setup })` → `{ agent, dispose }`
 *     (dsh-agent ResumeAgentOptions; `resumeSessionId` and `sessionId` are
 *     mutually exclusive, and persistence must be mounted or resume throws).
 *   - a missing/unreadable persisted session rejects with
 *     `SessionPersistenceNotFoundError` (dsh-session-persistence).
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

  /** Deliver one message to an agent handle, as a real user message. */
  async function send(handle, text) {
    const agent = handle?.agent
    if (agent === undefined || agent === null || typeof agent.followup !== 'function') return
    const makeUserMessage = createUserMessage ?? await resolveCreateUserMessage()
    agent.followup(makeUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  }

  return {
    createWorktree: (options) => createWorktree(options),
    removeWorktree: (options) => removeWorktree(options),
    prepareWorktree: (options) => prepareWorktree(options),

    /** Is this session still live? `agents.get` returns a bare Agent or undefined. */
    isSessionActive(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return false
      if (typeof agents.get !== 'function') return false
      return agents.get(sessionId) !== undefined && agents.get(sessionId) !== null
    },

    /** Level 1: push a message into the session that is still alive. */
    async followupSession({ sessionId, message }) {
      const agent = agents.get(sessionId)
      if (agent === undefined || agent === null || typeof agent.followup !== 'function') {
        throw new Error(`会话 ${sessionId} 已不可用，无法直接接续`)
      }
      await send({ agent }, message)
      return { sessionId }
    },

    async createSession({ cwd, setup, firstMessage }) {
      const sessionId = randomUUID()
      const handle = await agents.create({ sessionId, meta: { cwd }, setup })
      try {
        await send(handle, firstMessage)
      } catch (error) {
        try { await handle.dispose() } catch { /* best effort */ }
        throw error
      }
      return { sessionId, handle }
    },

    /**
     * Level 2: rebuild an agent on a persisted session. `sessionId` is
     * deliberately absent — the host rejects it alongside `resumeSessionId`.
     * A missing or corrupt history rejects, which is what drives level 3.
     */
    async resumeSession({ resumeSessionId, cwd, setup, firstMessage }) {
      if (typeof agents.resume !== 'function') throw new Error('host has no agents.resume; cannot rebuild the session')
      const handle = await agents.resume({
        resumeSessionId,
        ...(cwd === undefined ? {} : { agentOptions: { cwd } }),
        setup,
      })
      try {
        await send(handle, firstMessage)
      } catch (error) {
        try { await handle.dispose() } catch { /* best effort */ }
        throw error
      }
      return { sessionId: resumeSessionId, handle }
    },

    async disposeSession(created) {
      if (created !== null && created !== undefined && typeof created.handle?.dispose === 'function') {
        await created.handle.dispose()
      }
    },
  }
}
