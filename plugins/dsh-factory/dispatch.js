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
import { reviewedHeadFor } from './verdict.js'
import { createWorktree, removeWorktree, worktreePathFor } from './worktree.js'
import { hasPreparation, prepareWorktree } from './worktree-setup.js'

/**
 * Work modes are a PROJECT setting orthogonal to the autonomy tier (PRD §5.12).
 * The host's SandboxMode enum has exactly three values; `auto` is NOT one of
 * them — it is a permission preset that must never be written into the
 * `sandbox/mode` seed. Mapping an unknown mode returns null so dispatch fails
 * closed instead of running an agent under the profile's implicit default.
 */
export const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access'])
export const WORK_MODES = new Set(['workspace-write', 'full-access', 'auto-review'])
export const DEFAULT_WORK_MODE = 'workspace-write'
export const AUTO_REVIEW_PLUGIN_MODULE = '@deepseek-ai/dsh-experimental-auto-review'

/**
 * Project work mode → host SandboxMode. `auto-review` has no SandboxMode of
 * its own: P2a selects `AUTO_PRESET='auto'` on the live session, whose fixed
 * bundle is full access plus a per-tool model review. Its SANDBOX mode is
 * therefore danger-full-access; `auto` itself is never written into the
 * `sandbox/mode` seed. Unknown values still return null and fail closed.
 */
export function sandboxModeForWorkMode(workMode) {
  const mode = workMode === undefined || workMode === null || workMode === '' ? DEFAULT_WORK_MODE : workMode
  if (mode === 'workspace-write') return 'workspace-write'
  if (mode === 'full-access' || mode === 'auto-review') return 'danger-full-access'
  return null
}

/** Resolve the required mode or throw a readable, fail-closed error. */
function requiredModeForWorkMode(workMode) {
  const mode = sandboxModeForWorkMode(workMode)
  if (mode !== null) return mode
  const label = workMode === undefined || workMode === null || workMode === '' ? DEFAULT_WORK_MODE : String(workMode)
  if (label === 'auto-review') {
    throw new Error('无法派发会话：auto-review 档宿主任命失败；拒绝在无审查边界的会话中运行')
  }
  throw new Error(`无法派发会话：未知工作模式 ${label}；拒绝在未知沙箱边界的会话中运行`)
}

/**
 * P0-3: read the experimental auto-review plugin's enablement from the host.
 * `listPlugins()` is async and may arrive after apply(); anything missing,
 * failed, disabled or not-yet-active is reported as unavailable so P2's
 * work-mode gate treats the option as disabled (fail closed). No UI wiring.
 */
export async function readAutoReviewPluginState(ctx) {
  const unavailable = (reason, extra = {}) => ({
    available: false, enabled: false, moduleName: null, fiberPhase: null, diagnostic: null, reason, ...extra,
  })
  let manager
  try {
    manager = typeof ctx?.get === 'function' ? ctx.get('pluginManager') : undefined
  } catch (error) {
    return unavailable(`pluginManager unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (manager === undefined || manager === null || typeof manager.listPlugins !== 'function') {
    return unavailable('pluginManager unavailable; auto-review treated as disabled')
  }
  let rows
  try {
    rows = await manager.listPlugins()
  } catch (error) {
    return unavailable(`pluginManager.listPlugins failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(rows)) return unavailable('pluginManager.listPlugins returned no inventory')
  const isAutoReview = (name) => typeof name === 'string'
    && (name === AUTO_REVIEW_PLUGIN_MODULE || name.startsWith(`${AUTO_REVIEW_PLUGIN_MODULE}/`)
      || name === 'dsh-experimental-auto-review' || name.startsWith('dsh-experimental-auto-review/'))
  const entry = rows.find((row) => isAutoReview(row?.moduleName))
  if (entry === undefined) return unavailable('experimental auto-review plugin not installed')
  const enabled = entry.enabled === true
  const fiberPhase = typeof entry.fiberPhase === 'string' ? entry.fiberPhase : null
  const diagnostic = typeof entry.diagnostic === 'string' && entry.diagnostic !== '' ? entry.diagnostic : null
  const available = enabled && fiberPhase === 'active' && diagnostic === null
  return {
    available,
    enabled,
    moduleName: typeof entry.moduleName === 'string' ? entry.moduleName : null,
    fiberPhase,
    diagnostic,
    reason: available ? null
      : !enabled ? 'plugin disabled'
        : fiberPhase !== 'active' ? `plugin not active (fiberPhase=${fiberPhase ?? 'none'})`
          : `plugin failed: ${diagnostic}`,
  }
}

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
function makeAgentSetup({ store, cardId, locale = 'zh', reviewMode = false, review = {}, presetId, builderMode = false } = {}) {
  return async (agentCtx, agent) => {
    const presets = typeof agentCtx?.get === 'function' ? agentCtx.get('agentPresets') : undefined
    if (presets === undefined || presets === null || typeof presets.mount !== 'function') {
      throw new Error('无法派发会话：宿主未提供 agentPresets 服务，无法挂载预设（agent 会缺少 bash 等必需工具）')
    }
    // An explicit id pins the reviewer to a dedicated preset; undefined follows
    // the deployment's default. Both bind at session scope before the first turn.
    await presets.mount(agentCtx, presetId)
    // P2a: reviewMode is passed only by the review-specific dispatch paths.
    // The sandbox reader receives the live agent from the host's setup callback,
    // so the value is resolved from sandboxPolicy on the REAL session — never
    // from a caller-supplied string (QA's P2 hard prerequisite).
    const reviewOptions = reviewMode === true ? {
      ...review,
      readSandboxMode: typeof review.readSandboxMode === 'function'
        ? () => review.readSandboxMode(agent)
        : review.sandboxMode,
    } : undefined
    attachSessionContext({ agentCtx, store, cardId, locale, reviewMode, review: reviewOptions ?? {}, builderMode })
  }
}

/** Branch name a card's work gets in its worktree. */
export function branchForCard(cardId, redispatchCount = 0) {
  const n = Number.isInteger(redispatchCount) && redispatchCount > 0 ? redispatchCount : 0
  // P2b bug fix: the old worktree/branch is deliberately kept in history and
  // not deleted, so a return→resupply cycle needs a fresh deterministic name.
  // First dispatch keeps the legacy name for backward compatibility.
  return n === 0 ? `factory/${cardId}` : `factory/${cardId}-r${n + 1}`
}

/** Worktree path segment for a dispatch attempt (same suffix convention). */
export function worktreeKeyForCard(cardId, redispatchCount = 0) {
  const n = Number.isInteger(redispatchCount) && redispatchCount > 0 ? redispatchCount : 0
  return n === 0 ? String(cardId) : `${cardId}-r${n + 1}`
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
export async function dispatchCard({ store, cardId, port, baseBranch = 'main', transitionActor = 'human', transitionMeta = undefined, locale = 'zh', firstMessageExtra } = {}) {
  const { card, project } = resolveTargets({ store, cardId })
  const gate = assertDispatchable(card)
  if (gate.ok !== true) throw new Error(`该卡当前不可派发：${gate.reason}`)
  // P2b: a returned card may only be re-dispatched through the resupply path,
  // which carries the human's information as extra first-message context.
  if (card.needsHumanInfo === true && (typeof firstMessageExtra !== 'string' || firstMessageExtra === '')) {
    throw new Error('该卡待补充信息，请先补充后再重新派发；不能绕过人工信息闸门')
  }
  const effective = await effectiveWorkModeFor({ project, cardId, store, port })

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

  // Each return-to-Inbox archives its traces; the count is the attempt number.
  // Old worktrees/branches stay on disk per PRD, so names must never collide.
  const redispatchCount = Array.isArray(card.history)
    ? card.history.filter((entry) => entry && entry.type === 'session-archived').length : 0
  const branch = branchForCard(cardId, redispatchCount)
  let worktreePath = null
  let created = null
  let worktreeMade = false
  try {
    worktreePath = worktreePathFor(project, worktreeKeyForCard(cardId, redispatchCount))
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

    const built = buildSessionContext({ card: { ...card, worktreePath, branch }, project, locale })

    created = await port.createSession({
      cwd: worktreePath,
      permission: project.defaultPermission,
      workMode: effective.workMode,
      permissionPreset: effective.workMode === 'auto-review' ? 'auto' : undefined,
      model: project.defaultModel,
      // `setup(agentCtx)` runs before the first prompt assembly: mount the user's
      // preset (gives the agent its real tool set) and register the per-session
      // work-item context. See makeAgentSetup for why mount must live here.
      setup: makeAgentSetup({ store, cardId, locale, builderMode: true }),
      // P2b: a resupplied Inbox card needs its extra context appended to the
      // standard card context — never a replacement that drops cardId/worktree.
      firstMessage: typeof firstMessageExtra === 'string' && firstMessageExtra !== ''
        ? `${built.firstMessage}\n\n${firstMessageExtra}` : built.firstMessage,
    })

    // Success path — persist and only now advance the card.
    store.setWorktree(cardId, { worktreePath, branch, baseBranch, sessionId: created.sessionId })
    store.clearDispatchFailures(cardId)
    const fresh = store.getCard(cardId)
    // G2: a person pressing "start" dispatches as `human`; the engine passes
    // `autoRule` (plus tier/rule/channel) so audits can tell the two apart. The
    // actor is validated by assertTransition against `inbox->triage`.
    if (fresh.status === 'inbox') store.transitionCard(cardId, 'triage', transitionActor, undefined, transitionMeta)
    return { sessionId: created.sessionId, worktreePath, branch, redispatchCount, mode: 'created' }
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
export async function continueCard({ store, cardId, port, message, failureLimit, locale = 'zh' } = {}) {
  const { card, project } = resolveTargets({ store, cardId })
  const gate = assertDispatchable(card)
  if (gate.ok !== true) throw new Error(`该卡当前不可接续：${gate.reason}`)
  const effective = await effectiveWorkModeFor({ project, cardId, store, port })

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

  const built = buildSessionContext({ card, project, locale })
  const text = typeof message === 'string' && message !== '' ? message : built.firstMessage
  let created = null
  let resumeFailure
  let followupFailure
  try {
    // Level 1 — the session is still live: cheapest, no rebuild.
    if (sessionActive === true && previousSessionId !== undefined) {
      try {
        await port.followupSession({ sessionId: previousSessionId, message: text, workMode: effective.workMode })
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
          workMode: effective.workMode,
          permissionPreset: effective.workMode === 'auto-review' ? 'auto' : undefined,
          setup: makeAgentSetup({ store, cardId, locale, builderMode: true }),
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
      workMode: effective.workMode,
      permissionPreset: effective.workMode === 'auto-review' ? 'auto' : undefined,
      model: project.defaultModel,
      setup: makeAgentSetup({ store, cardId, locale, builderMode: true }),
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
 * P2a: resolve the work mode actually usable for a NEW session. `auto-review`
 * depends on the experimental plugin; when it is disabled or unreadable we
 * fall back to workspace-write for new sessions only and leave a readable
 * warning on the card. Running sessions are never terminated here.
 */
export async function effectiveWorkModeFor({ project, cardId, store, port } = {}) {
  const requested = project?.workMode ?? DEFAULT_WORK_MODE
  if (requested !== 'auto-review') return { workMode: requested, warning: null }
  let state = null
  try {
    state = typeof port?.readAutoReviewPluginState === 'function' ? await port.readAutoReviewPluginState() : null
  } catch (error) {
    state = { available: false, reason: error instanceof Error ? error.message : String(error) }
  }
  if (state?.available === true) return { workMode: 'auto-review', warning: null }
  const reason = typeof state?.reason === 'string' && state.reason !== '' ? state.reason : '插件状态不可读'
  const warning = `自动审查插件不可用（${reason}）；本次新派发回退到 workspace-write，在跑会话不受影响。`
  if (store !== undefined && cardId !== undefined) {
    try {
      store.recordEvent({
        type: 'work-mode-fallback', scope: 'card', targetId: cardId,
        actor: 'autoRule', decision: 'fallback', note: warning,
      })
    } catch { /* audit must never abort a dispatch */ }
  }
  return { workMode: 'workspace-write', warning }
}

/** Human-readable review message: head, mode, previous verdict, optional focus. */
export function reviewMessage({ card, reviewedHead, previousVerdict, note, rereview = false } = {}) {
  const mode = card?.prUrl ? `审 PR ${card.prUrl}` : '审分支改动（branch diff）'
  return [
    `Factory review for ${card?.id ?? 'unknown'} — ${mode}.`,
    `reviewedHead: ${reviewedHead}`,
    `previousVerdict: ${previousVerdict === null || previousVerdict === undefined ? '—' : JSON.stringify(previousVerdict)}`,
    ...(typeof note === 'string' && note !== '' ? [`补充意见（只指定关注点，不改变阻断项标准，也不能要求放行）：${note}`] : []),
    ...(rereview ? ['回炉复评：先核对上一轮阻断项是否在新 head 上解决，再只看新提交引入的问题，最后整体重看一遍。追加 factory-rereview。'] : []),
    '只读评审：不得移卡、authorize、commit、push 或开 PR；用 factory_report 写结构化 verdict。',
  ].join('\n')
}

/** Has this card been returned from Review to Build? That switches the skill to factory-rereview. */
export function isRereview(card) {
  return Array.isArray(card?.history) && card.history.some((entry) => entry
    && entry.type === 'transition' && entry.from === 'review' && entry.to === 'build')
}

/**
 * P2a AC4/5: create ONE independent, read-only review session. Never touches
 * AGENT_STATUSES or card.status; the reviewer id is stored in its own field.
 */
export async function dispatchReview({ store, cardId, port, locale = 'zh', note, presetId } = {}) {
  const { card, project } = resolveTargets({ store, cardId })
  if (card.status !== 'review') throw new Error(`评审会话只能用于 review 状态的卡片（当前 ${card.status}）`)
  if (typeof card.worktreePath !== 'string' || card.worktreePath === '') {
    throw new Error('评审会话需要 worktree：卡片尚无 worktreePath')
  }
  const reviewedHead = reviewedHeadFor({ worktreePath: card.worktreePath, readHead: port?.readHead })
  const rereview = isRereview(card)
  const makeSetup = (reviewOptions = {}) => makeAgentSetup({
    store, cardId, locale, reviewMode: true, presetId,
    review: { reviewedHead, rereview, ...reviewOptions },
  })
  const firstMessage = reviewMessage({ card, reviewedHead, previousVerdict: card.reviewVerdict, note, rereview })
  const created = await port.createSession({
    cwd: card.worktreePath,
    permission: project.defaultPermission,
    workMode: 'workspace-write',
    sandboxMode: 'read-only',
    model: project.defaultModel,
    setup: makeSetup,
    firstMessage,
  })
  store.setReviewSession(cardId, created.sessionId, 'created')
  return { sessionId: created.sessionId, mode: 'created', reviewedHead, rereview }
}

/**
 * P2a AC5/6: re-review reuses the live reviewer, then a resume, then a fresh
 * reviewer. No status transitions and no builder session id is ever replaced.
 */
export async function followupReview({ store, cardId, port, locale = 'zh', note, presetId } = {}) {
  const { card, project } = resolveTargets({ store, cardId })
  if (card.status !== 'review') throw new Error(`复评只能用于 review 状态的卡片（当前 ${card.status}）`)
  const previousSessionId = typeof card.reviewSessionId === 'string' && card.reviewSessionId !== '' ? card.reviewSessionId : null
  if (previousSessionId === null) return dispatchReview({ store, cardId, port, locale, note, presetId })
  if (typeof card.worktreePath !== 'string' || card.worktreePath === '') {
    throw new Error('复评需要 worktree：卡片尚无 worktreePath')
  }
  const reviewedHead = reviewedHeadFor({ worktreePath: card.worktreePath, readHead: port?.readHead })
  const rereview = true
  const message = reviewMessage({ card, reviewedHead, previousVerdict: card.reviewVerdict, note, rereview })
  const makeSetup = (reviewOptions = {}) => makeAgentSetup({
    store, cardId, locale, reviewMode: true, presetId,
    review: { reviewedHead, rereview, ...reviewOptions },
  })

  const active = typeof port.isSessionActive === 'function' && await port.isSessionActive(previousSessionId)
  if (active) {
    try {
      await port.followupSession({ sessionId: previousSessionId, message, sandboxMode: 'read-only' })
      store.setReviewSession(cardId, previousSessionId, 'reused')
      return { sessionId: previousSessionId, mode: 'followup', reviewedHead, rereview }
    } catch { /* a stale/mismatched live reviewer falls through to resume */ }
  }
  if (typeof port.resumeSession === 'function') {
    try {
      const created = await port.resumeSession({
        resumeSessionId: previousSessionId, cwd: card.worktreePath, setup: makeSetup,
        firstMessage: message, sandboxMode: 'read-only',
      })
      store.setReviewSession(cardId, created.sessionId, 'recreated')
      return { sessionId: created.sessionId, mode: 'resumed', reviewedHead, rereview }
    } catch { /* dead history → fresh reviewer below */ }
  }
  const created = await port.createSession({
    cwd: card.worktreePath,
    permission: project.defaultPermission,
    workMode: 'workspace-write',
    sandboxMode: 'read-only',
    model: project.defaultModel,
    setup: makeSetup,
    firstMessage: message,
  })
  store.setReviewSession(cardId, created.sessionId, 'recreated')
  return { sessionId: created.sessionId, mode: 'created', reviewedHead, rereview }
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
 * leaving a session that silently does nothing. `permission` is kept for API
 * compatibility but is advisory: the live boundary comes from `workMode`.
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
  // P2a: preset services are optional at the service level but HARD required
  // when a session actually asks for them (auto preset / explicit reviewer id).
  const permissionPresets = typeof ctx?.get === 'function' ? ctx.get('permissionPresets') : undefined
  const agentPresets = typeof ctx?.get === 'function' ? ctx.get('agentPresets') : undefined
  // Per-project work mode decides the SandboxMode. A profile defaulting to
  // danger-full-access would otherwise give an agent the harness's full file
  // access; the required mode is always seeded and read back on every path.
  // Read the resolved policy back from a live session and refuse anything but
  // the required boundary. Used by all three session paths (create, resume,
  // followup): a pre-fix session may lack the sandbox/mode event and fall back
  // to the profile default, which on some profiles is danger-full-access.
  const assertSandboxMode = (session, expectedMode) => {
    if (sandboxPolicy === undefined || sandboxPolicy === null || typeof sandboxPolicy.resolve !== 'function') {
      throw new Error(`无法派发会话：宿主未提供 sandboxPolicy 服务，无法保证会话在 ${expectedMode} 沙箱内运行`)
    }
    const resolved = sandboxPolicy.resolve({ session })
    if (resolved?.mode !== expectedMode) {
      throw new Error(`无法派发会话：沙箱模式实际为 ${resolved?.mode ?? '未知'}，所需为 ${expectedMode}；拒绝在无 ${expectedMode} 边界的会话中运行`)
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
    async followupSession({ sessionId, message, workMode, sandboxMode }) {
      const expectedMode = sandboxMode ?? requiredModeForWorkMode(workMode)
      const agent = agents.get(sessionId)
      if (agent === undefined || agent === null || typeof agent.followup !== 'function') {
        throw new Error(`会话 ${sessionId} 已不可用，无法直接接续`)
      }
      // A session pinned to another work mode (e.g. an old workspace-write
      // session after upgrading to full-access) is refused here. Do not dispose
      // a live session we do not own — the error lets continueCard fall back.
      assertSandboxMode(agent.session, expectedMode)
      await send({ agent }, message)
      return { sessionId }
    },

    async createSession({ cwd, setup, firstMessage, model: projectModel, permission, workMode, sandboxMode, permissionPreset, presetId }) {
      // The work mode is authoritative; `permission` (project.defaultPermission)
      // is kept for API compatibility only and no longer gates dispatch.
      // A review session overrides the file boundary to read-only regardless of
      // the project's work mode (PRD §5.12 / AC34).
      const expectedMode = sandboxMode ?? requiredModeForWorkMode(workMode)
      // A caller on the auto-review tier must explicitly ask for the preset;
      // otherwise the port would grant full access with no per-tool review.
      if (workMode === 'auto-review' && permissionPreset !== 'auto') {
        throw new Error('无法派发会话：auto-review 档必须显式选择 auto 权限预设；拒绝无审查的完全权限会话')
      }
      // Safety gate: dispatch must run inside a real file boundary. If the host
      // cannot report a sandbox policy, refuse before creating anything — an
      // unverified session is an agent with the harness's full filesystem access.
      if (sandboxPolicy === undefined || sandboxPolicy === null || typeof sandboxPolicy.resolve !== 'function') {
        throw new Error(`无法派发会话：宿主未提供 sandboxPolicy 服务，无法保证会话在 ${expectedMode} 沙箱内运行`)
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
      const seed = [{ type: 'sandbox/mode', seq: 0, time: Date.now(), data: { mode: expectedMode } }]
      const sessionId = randomUUID()
      // Review paths pass a setup FACTORY so the host can inject the live
      // sandbox reader (agent.session) into the review context. Plain paths
      // still pass a plain function and are unchanged.
      const resolvedSetup = typeof setup === 'function' && sandboxMode === 'read-only'
        ? setup({ readSandboxMode: (agent) => sandboxPolicy.resolve({ session: agent?.session }).mode })
        : setup
      const handle = await agents.create({ sessionId, meta: { cwd }, seed, agentOptions, setup: resolvedSetup })
      // Verify what actually took effect, not what we asked for. Read the resolved
      // policy back from the live session; a mismatch means the profile overrode
      // us, so dispose and refuse rather than run with an unknown boundary.
      try {
        assertSandboxMode(handle.agent?.session, expectedMode)
        // AC33: auto-review is a permission PRESET, never a SandboxMode. Select
        // it on the live session AFTER creation and BEFORE the first message.
        // A missing live preset / failed verification fails closed.
        if (permissionPreset === 'auto') {
          if (permissionPresets === undefined || permissionPresets === null || typeof permissionPresets.set !== 'function') {
            throw new Error('无法派发会话：宿主未提供 permissionPresets 服务；自动审查预设不可用')
          }
          permissionPresets.set(handle.agent?.session, 'auto')
          if (permissionPresets.current(handle.agent?.session) !== 'auto') {
            throw new Error('无法派发会话：宿主未能选中 auto 权限预设；拒绝以未审查权限运行')
          }
          assertSandboxMode(handle.agent?.session, 'danger-full-access')
        }
        if (presetId !== undefined && agentPresets !== undefined && agentPresets !== null
          && typeof agentPresets.presetForSession === 'function') {
          if (agentPresets.presetForSession(handle.agent?.session) !== presetId) {
            throw new Error(`无法派发会话：评审会话未挂载指定预设 ${presetId}`)
          }
        }
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
    async resumeSession({ resumeSessionId, cwd, setup, firstMessage, workMode, sandboxMode, permissionPreset }) {
      const expectedMode = sandboxMode ?? requiredModeForWorkMode(workMode)
      if (typeof agents.resume !== 'function') throw new Error('host has no agents.resume; cannot rebuild the session')
      const resolvedSetup = typeof setup === 'function' && sandboxMode === 'read-only'
        ? setup({ readSandboxMode: (agent) => sandboxPolicy.resolve({ session: agent?.session }).mode })
        : setup
      const handle = await agents.resume({
        resumeSessionId,
        ...(cwd === undefined ? {} : { agentOptions: { cwd } }),
        setup: resolvedSetup,
      })
      try {
        // A persisted session from before the sandbox fix has no sandbox/mode
        // event, so it resumes in the profile default (possibly full-access).
        // Refuse it here; the error lets continueCard fall to level 3, which
        // goes through createSession's seed gate.
        assertSandboxMode(handle.agent?.session, expectedMode)
        if (permissionPreset === 'auto') {
          if (permissionPresets === undefined || permissionPresets === null || typeof permissionPresets.set !== 'function') {
            throw new Error('无法派发会话：宿主未提供 permissionPresets 服务；自动审查预设不可用')
          }
          permissionPresets.set(handle.agent?.session, 'auto')
          if (permissionPresets.current(handle.agent?.session) !== 'auto') {
            throw new Error('无法派发会话：宿主未能选中 auto 权限预设；拒绝以未审查权限运行')
          }
        }
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

    // P0-3 reader, reused by P2a to gate auto-review and to warn on fallback.
    readAutoReviewPluginState: () => readAutoReviewPluginState(ctx),
  }
}
