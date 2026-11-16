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

/**
 * Build the `setup(agentCtx)` a dispatched agent runs before its first turn.
 *
 * Mounts the deployment's CURRENT agent preset onto this agent's scope
 * (`mount(agentCtx)` with no id follows `defaultId`, i.e. whatever preset the
 * user has selected — no hardcoded preset name). Without this the agent has no
 * `tool-bash`/`tool-fs`/`skill` and reaches for whatever global tools happen to
 * exist (e.g. an SSH host-exec path the sandbox does not confine). Mount MUST
 * happen here: `mount` requires a scoped context and is refused after the first
 * turn opens (`agent-preset/locked`), so `setup` is the only legal window.
 * The preset service is a hard safety dependency: without it we refuse the
 * dispatch rather than silently produce a tool-less agent that grabs an SSH
 * path — the same fail-closed rule as the sandboxPolicy gate.
 *
 * Then registers the per-session work-item context. Returns a Promise resolving
 * to undefined: the loop awaits setup then calls `setupCommit?.commit()`, so a
 * disposer return value would crash.
 */
function makeAgentSetup({ store, cardId }) {
  return async (agentCtx) => {
    const presets = typeof agentCtx?.get === 'function' ? agentCtx.get('agentPresets') : undefined
    if (presets === undefined || presets === null || typeof presets.mount !== 'function') {
      throw new Error('无法派发会话：宿主未提供 agentPresets 服务，无法挂载预设（agent 会缺少 bash 等必需工具）')
    }
    await presets.mount(agentCtx)
    attachSessionContext({ agentCtx, store, cardId })
  }
}

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
      // `setup(agentCtx)` runs before the first prompt assembly: mount the user's
      // preset (gives the agent its real tool set) and register the per-session
      // work-item context. See makeAgentSetup for why mount must live here.
      setup: makeAgentSetup({ store, cardId }),
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
  let followupFailure
  try {
    // Level 1 — the session is still live: cheapest, no rebuild.
    if (sessionActive === true && previousSessionId !== undefined) {
      try {
        await port.followupSession({ sessionId: previousSessionId, message: text })
        store.releaseClaim(cardId, claim.token)
        store.clearDispatchFailures(cardId)
        store.recordContinuation(cardId, { sessionId: previousSessionId, mode: 'followup' })
        return { sessionId: previousSessionId, worktreePath, mode: 'followup' }
      } catch (followupError) {
        // A live but unsafe session (e.g. created before the sandbox fix) is
        // refused by followupSession's sandbox gate. Do NOT let this escape to
        // the outer catch — that would strand the card. Fall through to level 2
        // then level 3, which rebuilds a fresh, sandboxed session.
        followupFailure = followupError
      }
    }

    // Level 2 — session gone but its history is on disk: rebuild on it.
    if (previousSessionId !== undefined && typeof port.resumeSession === 'function') {
      try {
        created = await port.resumeSession({
          resumeSessionId: previousSessionId,
          cwd: worktreePath,
          setup: makeAgentSetup({ store, cardId }),
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
      setup: makeAgentSetup({ store, cardId }),
      firstMessage: text,
    })
    store.setWorktree(cardId, { sessionId: created.sessionId })
    store.clearDispatchFailures(cardId)
    store.releaseClaim(cardId, claim.token)
    store.recordContinuationFallback(cardId, {
      from: previousSessionId,
      reason: followupFailure !== undefined
        ? (followupFailure instanceof Error ? followupFailure.message : String(followupFailure))
        : resumeFailure !== undefined
          ? (resumeFailure instanceof Error ? resumeFailure.message : String(resumeFailure))
          : 'no persisted session to resume',
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
 * import with a minimal fallback shape. The model route is wired into the live
 * session through `agentOptions`: it follows the host's default-model service
 * using live getters (the same pattern the UI entry uses), and a project-level
 * `defaultModel` overrides only the model id. Dispatch fails fast when neither
 * source can provide a route, so the failure is recorded on the card instead of
 * leaving a session that silently does nothing. `permission` is accepted for API
 * compatibility but is not wired into the live session yet.
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
  // Sandbox policy is a hard safety dependency for dispatch: without it we
  // cannot pin or verify the session's file boundary. Read via ctx.get, never a
  // direct property (undeclared Cordis proxy properties throw).
  const sandboxPolicy = typeof ctx?.get === 'function' ? ctx.get('sandboxPolicy') : undefined
  // The only mode a dispatched agent may run in. A profile defaulting to
  // danger-full-access would otherwise give it the harness's full file access.
  const REQUIRED_SANDBOX_MODE = 'workspace-write'
  // Read the resolved policy back from a live session and refuse anything but
  // the required boundary. Used by all three session paths (create, resume,
  // followup): a pre-fix session may lack the sandbox/mode event and fall back
  // to the profile default, which on some profiles is danger-full-access.
  const assertSandboxMode = (session) => {
    if (sandboxPolicy === undefined || sandboxPolicy === null || typeof sandboxPolicy.resolve !== 'function') {
      throw new Error('无法派发会话：宿主未提供 sandboxPolicy 服务，无法保证会话在 workspace-write 沙箱内运行')
    }
    const resolved = sandboxPolicy.resolve({ session })
    if (resolved?.mode !== REQUIRED_SANDBOX_MODE) {
      throw new Error(`无法派发会话：沙箱模式实际为 ${resolved?.mode ?? '未知'}，所需为 ${REQUIRED_SANDBOX_MODE}；拒绝在无 workspace-write 边界的会话中运行`)
    }
  }
  // User-configured default route. Read via ctx.get, never ctx.agentDefaultModel:
  // an undeclared Cordis proxy property throws. The read is wrapped so a service
  // present but throwing still degrades into a clean "no model" dispatch failure.
  const defaultModel = typeof ctx?.get === 'function' ? ctx.get('agentDefaultModel') : undefined
  const readDefaultSelection = () => {
    try {
      return typeof defaultModel?.currentSelection === 'function'
        ? defaultModel.currentSelection()
        : undefined
    } catch { return undefined }
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
      // A session created before the sandbox fix may still be live in a
      // non-workspace-write mode. Refuse to continue it; do not dispose a live
      // session we do not own — the error lets continueCard fall back safely.
      assertSandboxMode(agent.session)
      await send({ agent }, message)
      return { sessionId }
    },

    async createSession({ cwd, setup, firstMessage, model: projectModel, permission: requestedPermission }) {
      // Safety gate: dispatch must run inside a real file boundary. If the host
      // cannot report a sandbox policy, refuse before creating anything — an
      // unverified session is an agent with the harness's full filesystem access.
      if (sandboxPolicy === undefined || sandboxPolicy === null || typeof sandboxPolicy.resolve !== 'function') {
        throw new Error('无法派发会话：宿主未提供 sandboxPolicy 服务，无法保证会话在 workspace-write 沙箱内运行')
      }
      // project.defaultPermission is advisory only: anything other than the
      // required mode is refused, never silently downgraded to full access.
      if (requestedPermission !== undefined && requestedPermission !== REQUIRED_SANDBOX_MODE) {
        throw new Error(`无法派发会话：请求的权限档 ${requestedPermission} 不等于 ${REQUIRED_SANDBOX_MODE}；派发会话只允许在 workspace-write 沙箱中运行`)
      }
      // Fail fast instead of leaning on the loop's silent catch: with no route a
      // session would start, do nothing, and never report why. AgentModel.current()
      // needs BOTH provider and model; projectModel only overrides the model part.
      const selection = readDefaultSelection()
      const provider = selection?.provider
      const model = projectModel ?? selection?.model
      if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
        throw new Error('无法派发会话：没有可用的模型路由（宿主默认模型和项目 defaultModel 均不可用）')
      }
      // Live getters mirror the host UI's agentOptions(): each read follows the
      // current default selection, so changing the default later is reflected.
      const agentOptions = {
        get provider() { return readDefaultSelection()?.provider },
        get model() { return projectModel ?? readDefaultSelection()?.model },
        get reasoningEffort() { return readDefaultSelection()?.reasoningEffort },
      }
      // Pin the sandbox mode via the session SEED, not via setup: agent-loop
      // writes the constructor seed before setup, and setup before announce
      // (pinInitialPermission). A seed event makes pinInitialPermission see
      // sandbox !== null and skip applying the profile default. Seed has no
      // timing race — unlike appending from setup. seed events need a full
      // envelope with seq contiguous from 0; sandbox/mode is a non-turn event
      // so it does not affect turn accounting.
      const seed = [{ type: 'sandbox/mode', seq: 0, time: Date.now(), data: { mode: REQUIRED_SANDBOX_MODE } }]
      const sessionId = randomUUID()
      const handle = await agents.create({ sessionId, meta: { cwd }, seed, agentOptions, setup })
      // Verify what actually took effect, not what we asked for. Read the resolved
      // policy back from the live session; a mismatch means the profile overrode
      // us, so dispose and refuse rather than run with an unknown boundary.
      try {
        assertSandboxMode(handle.agent?.session)
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
        // A persisted session from before the sandbox fix has no sandbox/mode
        // event, so it resumes in the profile default (possibly full-access).
        // Refuse it here; the error lets continueCard fall to level 3, which
        // goes through createSession's seed gate.
        assertSandboxMode(handle.agent?.session)
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
