/**
 * dsh-factory — autonomy engine (PRD-AUTONOMY-V2).
 *
 * ONE plugin-level timer, not one per project. Each tick enumerates every project
 * and decides, per project, whether to discover issues, dispatch Inbox cards,
 * and/or approve plans. All orchestration is pure over an injected `deps` port,
 * so the whole chain is exercised offline with a fake store and fake host — no
 * real timer, no real `gh`, no real sessions.
 *
 * Three semantic levels (the only stored values):
 *   - manual: strict no-op — the machine discovers, dispatches and approves
 *     nothing.
 *   - you-approve: discovers issues; autoDispatch decides whether new cards are
 *     dispatched. Plans always stop for a human.
 *   - machine-approve: discovers, dispatches and auto-approves plans, stopping
 *     at Review. It never checks any switch, and never touches git/PR/Done.
 *   - auto-delivery: inherits machine-approve's dispatch (so it never reads the
 *     autoDispatch switch), and additionally delivers at Review behind the
 *     seven hard gates in delivery.js.
 *
 * Default zero side effects: a manual project, a paused project, or one without
 * explicit intake config produces no cards/sessions/git writes. A you-approve
 * project with autoDispatch off still discovers cards into Inbox; a L4 project
 * dispatches those Inbox cards automatically without reading the switch.
 *
 * The engine deliberately does NOT reimplement dedupe, dispatch, continuation,
 * rollback, circuit breaking or the state machine — it calls the existing
 * `intakeIssues` / `dispatchCard` / `autoApprovePlan` / `continueCard` /
 * `isSessionActive` through `deps`. All orchestration is pure over an injected
 * `deps` port, so the whole chain is exercised offline with a fake store and
 * fake host — no real timer, no real `gh`, no real sessions.
 */
import { continueCard, createHostPort, dispatchCard, dispatchPrReview, dispatchReview, followupReview, readAutoReviewPluginState, SANDBOX_MODES } from './dispatch.js'
import { createGhPort, intakeIssues } from './intake.js'
import { localeFromContext } from './session-context.js'
import { precheckReceipt } from './receipt.js'
import { applyRemoteSync } from './sync.js'
import { DEFAULT_PHASE_RULES, phaseAllows, normalizePhaseRules } from './phase-rules.js'
import { SELF_REVIEW_DISPATCH_LIMIT } from './store.js'

export { DEFAULT_PHASE_RULES }
export const phaseRulesOf = (project) => normalizePhaseRules(project?.phaseRules ?? {}, DEFAULT_PHASE_RULES)

/** Conservative, overridable defaults. Never hard-code a host-specific path/command. */
export const DEFAULT_TICK_MS = 60_000
export const DEFAULT_GLOBAL_MAX_ACTIVE = 5
export const DEFAULT_PROJECT_MAX_ACTIVE = 5

/** Stable governance identifiers written into card history / audit events. */
export const AUTO_TIER = 'you-approve'
export const AUTO_CHANNEL = 'poll'
export const RULE_INTAKE = 'auto-issue-discovery'
export const RULE_DISPATCH = 'auto-dispatch-triage'
// Machine plan-approval belongs to the machine-approve level. arm-delivery stays
// human — no rule id here.
export const MACHINE_APPROVE_TIER = 'machine-approve'
export const AUTO_DELIVERY_TIER = 'auto-delivery'
export const RULE_APPROVE = 'auto-approve-plan'
export const RULE_DELIVER = 'auto-deliver-approved-head'

/** Hard cap on engine-initiated re-reviews per card for its whole life. */
export const AUTO_REREVIEW_LIMIT = 3

/** V4: the default is full auto; phase rules may only narrow stages. */
export function canDeliver() { return true }

export function behaviorOf() {
  return { intake: true, dispatch: true, approve: true, selfReview: true, remoteSync: true }
}

/**
 * The ONE machine approval action at machine-approve: approve a plan-review
 * card. It reuses the SAME gate a human button uses (store.transitionCard →
 * assertTransition, where autoRule is legal on plan-review->build, state.js:50).
 * It does NOT arm delivery authorization and never touches git — those stay
 * human-only (the conservative machine boundary).
 *
 * Before writing it runs the same write-before-receipt precheck (receipt.js) the
 * tools use, so the approval write cannot leave a half-applied card. Idempotent:
 * re-reading the card and refusing anything not in plan-review means repeated
 * ticks (or a human approving first) never double-approve.
 */
const APPROVE_OUTPUT = {
  schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, actor: { type: 'string' } } },
  render: (args, value) => [{ type: 'text', text: `Card ${value.id}: ${value.from} → ${value.to} by ${value.actor}` }],
}

/** Approve one plan-review card as autoRule. Returns { approved } or { skipped }. */
export function autoApprovePlan({ store, cardId, note, ports = {} } = {}) {
  // Re-read live: the status may have changed since the tick snapshot.
  const card = store.getCard(cardId)
  if (card === undefined || card === null) throw new Error(`卡片不存在：${cardId}`)
  if (card.status !== 'plan') return { skipped: true, reason: `status=${card.status}` }
  if (card.takenOver === true) return { skipped: true, reason: 'taken-over' }
  const value = { id: cardId, from: 'plan', to: 'build', actor: 'autoRule' }
  // Same write/receipt boundary as the model-facing tools: precheck, then write.
  precheckReceipt({ name: 'factory_auto_approve', schema: APPROVE_OUTPUT.schema, render: APPROVE_OUTPUT.render, args: {}, value, ports })
  store.transitionCard(cardId, 'build', 'autoRule', note, {
    actor: 'autoRule', tier: MACHINE_APPROVE_TIER, rule: RULE_APPROVE, channel: AUTO_CHANNEL,
  })
  return { approved: true, cardId }
}

function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/**
 * Effective global concurrency cap and its source — the SINGLE source of truth
 * used by both `runTick` (dispatch) and `GET /status` (UI read-back), so the
 * number the UI shows can never drift from the number the scheduler enforces.
 *
 * Priority: HTTP-saved `store.settings.globalMaxActive` > launch config
 * (`config.engine.globalMaxActive`) > built-in default (P4 §3.3). Reading the
 * store on every call is what makes a PATCH take effect on the NEXT tick with no
 * restart, and survive a reload (the value is read back from persisted settings).
 */
export function effectiveGlobalMaxActive(store, config = {}) {
  const saved = typeof store?.getGlobalMaxActiveSetting === 'function' ? store.getGlobalMaxActiveSetting() : null
  if (saved !== null) return { value: saved, source: 'settings' }
  const fromConfig = positiveInt(config.globalMaxActive, null)
  if (fromConfig !== null) return { value: fromConfig, source: 'config' }
  return { value: DEFAULT_GLOBAL_MAX_ACTIVE, source: 'default' }
}

/**
 * The engine's observable state, read fresh by `GET /status` on every request.
 * `timerReason` answers "why is nothing happening" instead of failing silently
 * (P1 lesson): a missing host timer service, or missing project config, is always
 * visible here. `permissionEnforced` is derived once per tick from the real
 * sandbox policy of live sessions (P0-2): the host has no global "is enforced"
 * read, so an unavailable resolver or an unreadable session fails closed.
 */
export function createEngineStatus() {
  return {
    timerActive: false,
    // Whether a timer has been claimed on this state (see startEngine). Kept on
    // the state, not in a module variable, so a reload with a fresh status can
    // mount again while a duplicate call on the same state cannot double-mount.
    timerMounted: false,
    // Readable initial reason: if the host timer service never becomes available
    // (inject never fires), this stays as the visible answer to "why is the
    // engine not running" instead of a silent no-op (P1 lesson).
    timerReason: 'host timer service not available; engine not started',
    paused: false,
    singleFlight: false,
    ticks: 0,
    lastTickAt: null,
    lastError: null,
    projects: [],
    orphans: [],
    permissionEnforced: false,
    permissionEnforcedReason: 'no tick has resolved a live sandbox policy yet',
    autoReviewPluginState: {
      available: false, enabled: false, moduleName: null, fiberPhase: null, diagnostic: null,
      reason: 'not checked yet',
    },
  }
}

/**
 * P0-2: derive the enforcement signal from LIVE session policy reads. A fake
 * deps without the resolver, an empty session set, or any unreadable mode all
 * fail closed to `false` with a reason a human can act on.
 */
export async function resolvePermissionEnforcement({ deps, activeSessionIds } = {}) {
  const resolveMode = typeof deps?.resolveSandboxMode === 'function' ? deps.resolveSandboxMode : undefined
  if (resolveMode === undefined) {
    return { enforced: false, reason: 'sandboxPolicy resolver unavailable (fail-closed)' }
  }
  const ids = activeSessionIds instanceof Set ? [...activeSessionIds] : Array.isArray(activeSessionIds) ? activeSessionIds : []
  if (ids.length === 0) return { enforced: false, reason: 'no active session to verify' }
  const modes = new Set()
  for (const sessionId of ids) {
    let mode = null
    try { mode = await resolveMode(sessionId) } catch { mode = null }
    if (typeof mode !== 'string' || !SANDBOX_MODES.has(mode)) {
      return { enforced: false, reason: `session ${sessionId} has no readable SandboxMode (fail-closed)` }
    }
    modes.add(mode)
  }
  return { enforced: true, reason: `verified ${ids.length} active session(s): ${[...modes].join(', ')}` }
}

/** P0-3: a missing/failed reader is reported as a disabled option, never as ready. */
export async function readAutoReviewStateForStatus(deps) {
  const read = typeof deps?.readAutoReviewPluginState === 'function' ? deps.readAutoReviewPluginState : undefined
  if (read === undefined) {
    return {
      available: false, enabled: false, moduleName: null, fiberPhase: null, diagnostic: null,
      reason: 'plugin state reader unavailable (auto-review disabled)',
    }
  }
  try {
    const state = await read()
    if (state === undefined || state === null || typeof state !== 'object') {
      return {
        available: false, enabled: false, moduleName: null, fiberPhase: null, diagnostic: null,
        reason: 'plugin state unreadable (auto-review disabled)',
      }
    }
    return {
      available: state.available === true,
      enabled: state.enabled === true,
      moduleName: typeof state.moduleName === 'string' ? state.moduleName : null,
      fiberPhase: typeof state.fiberPhase === 'string' ? state.fiberPhase : null,
      diagnostic: typeof state.diagnostic === 'string' ? state.diagnostic : null,
      reason: typeof state.reason === 'string' ? state.reason : null,
    }
  } catch (error) {
    return {
      available: false, enabled: false, moduleName: null, fiberPhase: null, diagnostic: null,
      reason: `plugin state read failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** The audit tier is the project's semantic level — one truth source for all events. */
const tierForLevel = (level) => level === AUTO_DELIVERY_TIER ? AUTO_DELIVERY_TIER
  : level === 'machine-approve' ? MACHINE_APPROVE_TIER : AUTO_TIER
/** Auto-discovery provenance attached to cards the engine creates. */
const intakeOrigin = (level) => ({ actor: 'autoRule', tier: tierForLevel(level), rule: RULE_INTAKE, channel: AUTO_CHANNEL })
/** Audit metadata for the single automatic transition (inbox -> triage). */
const dispatchMeta = (level) => ({ tier: tierForLevel(level), rule: RULE_DISPATCH, channel: AUTO_CHANNEL })

/**
 * Reconcile orphaned cards: ones that carry a worktree/session trace but whose
 * session the host says is gone. Exposed for a human to handle, NEVER cleaned up
 * or rebuilt automatically (PRD §9.1) — auto-rebuild is exactly how a lost
 * tool reply turns into a second worktree/session.
 */
export async function reconcileOrphans({ store, deps }) {
  const orphans = []
  for (const card of store.listCards({})) {
    const hasTrace = (typeof card.worktreePath === 'string' && card.worktreePath !== '')
      || (typeof card.sessionId === 'string' && card.sessionId !== '')
    if (!hasTrace) continue
    let active = false
    try {
      active = typeof card.sessionId === 'string' && card.sessionId !== ''
        ? (await deps.isSessionActive(card.sessionId)) === true
        : false
    } catch {
      active = false
    }
    if (!active) orphans.push({ cardId: card.id, projectId: card.projectId, status: card.status, sessionId: card.sessionId ?? null })
  }
  return orphans
}

/**
 * Run ONE tick. Single-flight: an in-flight tick is never overlapped. Every
 * project and every card is isolated in its own try/catch, so one failure can
 * never abort the tick or another project, and is recorded on the status.
 *
 * @returns a compact per-tick summary; also mutates `status` in place.
 */
export async function runTick({ store, status, deps, config = {}, now = () => new Date().toISOString() } = {}) {
  if (status.singleFlight === true) return { overlapped: true }
  status.singleFlight = true
  const projectReports = []
  let errors = 0
  try {
    // Read the global cap live from the store every tick: a PATCH to
    // store.settings.globalMaxActive takes effect on the next tick with no
    // restart, and the same effective value is what GET /status reports (P4 §3.3).
    // `config` (captured at startEngine) is only the fallback tier.
    const { value: globalMax } = effectiveGlobalMaxActive(store, config)
    const projectDefaultMax = positiveInt(config.projectMaxActive, DEFAULT_PROJECT_MAX_ACTIVE)
    const allCards = store.listCards({})

    // Count RUNTIME-active sessions globally, not store `sessionId` fields: a
    // sessionId is only a historical trace (PRD §6). One session id may appear
    // on more than one card; count distinct ids.
    const activeSessionIds = new Set()
    const activeByProject = new Map()
    for (const card of allCards) {
      if (typeof card.sessionId !== 'string' || card.sessionId === '') continue
      let active = false
      try { active = (await deps.isSessionActive(card.sessionId)) === true } catch { active = false }
      if (!active) continue
      activeSessionIds.add(card.sessionId)
      activeByProject.set(card.projectId, (activeByProject.get(card.projectId) ?? 0) + 1)
    }
    let activeCount = activeSessionIds.size
    // A session handle can die between the tick snapshot and the decision point.
    // Idle-review redispatch must re-check live state before sending work.
    const sessionLiveAtDecision = async (sessionId) => {
      if (typeof sessionId !== 'string' || sessionId === '') return false
      if (typeof deps.isSessionActive !== 'function') return false
      try { return (await deps.isSessionActive(sessionId)) === true } catch { return false }
    }

    // P0-2/P0-3: both signals are read from the LIVE host once per tick, never
    // from config. Fail-closed helpers keep the status honest on offline fakes,
    // during startup, and while the plugin manager is not ready yet.
    const enforcement = await resolvePermissionEnforcement({ deps, activeSessionIds })
    status.permissionEnforced = enforcement.enforced
    status.permissionEnforcedReason = enforcement.reason
    status.autoReviewPluginState = await readAutoReviewStateForStatus(deps)

    for (const project of store.listProjects()) {
      const report = {
        projectId: project.id,
        autonomy: 'phase-rules',
        action: 'skipped',
        reason: null,
        intakeCreated: 0,
        dispatched: 0,
        approved: 0,
        continued: 0,
        reviewDispatched: 0,
        autoRereviewed: 0,
        autoCommitted: 0,
        delivered: 0,
        approvalHeld: 0,
        queued: 0,
      }
      projectReports.push(report)
      try {
        // One source of truth: the stored semantic level decides capabilities.
        // The autoDispatch switch only gates the dispatch capability of
        // you-approve; machine-approve never reads it.
        const phaseRules = phaseRulesOf(project)
        const behavior = behaviorOf()

        // Shared per-project budget: approval continuations and Inbox dispatch
        // both keep/create active sessions, so they draw from the SAME cap.
        // Declared once here; each stage re-reads the live counters below.
        const projectMax = positiveInt(project.maxActiveSessions, projectDefaultMax)

        // Machine plan-approval is independent of intake config (issueRepo/board):
        // it judges LOCAL card status only. pause / takeover apply immediately.
        // A missing deps.approve port (offline fakes) simply skips.
        if (phaseAllows(phaseRules, 'plan', 'autoApprove') && typeof deps.approve === 'function') {
          const approvalPaused = status.paused === true || project.paused === true
          if (approvalPaused) {
            report.approvalReason = 'paused'
          } else {
            const approvable = allCards
              .filter((card) => card.projectId === project.id && card.status === 'plan')
              .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
            // A continue that reuses a still-live session (followup) adds no
            // new session and needs no slot; a resume/fresh fallback does.
            // Without this a tick could open N sessions under a cap of 1.
            const approvalProjectActive = activeByProject.get(project.id) ?? 0
            let approvalSlots = Math.max(0, Math.min(projectMax - approvalProjectActive, globalMax - activeCount))
            // Review P3 (TOCTOU): activeSessionIds is a tick-start snapshot, but
            // continueCard re-checks liveness at call time. A session dying in
            // between falls back to resume/fresh (a NEW session) even though the
            // hold decision above already let it through slot-free. Re-check at
            // the decision point too. Missing/failing port keeps the snapshot
            // behaviour, so offline fakes are unaffected.
            const liveAtDecision = async (sessionId) => {
              if (typeof deps.isSessionActive !== 'function') return true
              try { return (await deps.isSessionActive(sessionId)) === true } catch { return false }
            }
            for (const card of approvable) {
              const snapshottedLive = typeof card.sessionId === 'string' && card.sessionId !== ''
                && activeSessionIds.has(card.sessionId)
              const liveSession = snapshottedLive && await liveAtDecision(card.sessionId)
              // Hold the approval itself, not just the continuation: approving
              // without a slot would strand the card in build with no agent.
              if (!liveSession && approvalSlots <= 0) {
                report.approvalHeld += 1
                continue
              }
              try {
                const result = await deps.approve({
                  store, cardId: card.id,
                  note: 'machine-approve: plan approved by engine',
                })
                if (result?.approved === true) {
                  report.approved += 1
                  // plan-review is a stop-and-wait state: the plan session has
                  // ended its turn. Approving alone strands the card in build,
                  // so continue the same session here — the engine twin of the
                  // human "Approve plan" button. The port reuses the worktree
                  // and re-checks the state gate + per-card dispatch lock. A deps
                  // without it (offline fakes) leaves the approval intact.
                  if (typeof deps.continue === 'function') {
                    try {
                      const continued = await deps.continue({ store, cardId: card.id })
                      report.continued += 1
                      // Charge a genuinely new session against the same budget
                      // dispatch uses; a followup keeps an already-counted id.
                      const continuedId = typeof continued?.sessionId === 'string' ? continued.sessionId : undefined
                      if (continuedId !== undefined && continuedId !== '' && !activeSessionIds.has(continuedId)) {
                        activeSessionIds.add(continuedId)
                        activeCount += 1
                        activeByProject.set(project.id, (activeByProject.get(project.id) ?? 0) + 1)
                        approvalSlots -= 1
                      }
                    } catch (continueError) {
                      errors += 1
                      const message = continueError instanceof Error ? continueError.message : String(continueError)
                      status.lastError = `auto-approve continue failed for card ${card.id}: ${message}`
                      // Never roll the approval back — it is a valid gate
                      // decision. Make the stalled build observable instead.
                      try {
                        store.recordEvent({
                          type: 'auto-approve-continue-failed', scope: 'card', targetId: card.id,
                          actor: 'autoRule', decision: 'failed', note: message,
                          tier: MACHINE_APPROVE_TIER, rule: RULE_APPROVE, channel: AUTO_CHANNEL,
                        })
                      } catch { /* audit write must never abort the tick */ }
                    }
                  }
                }
              } catch (error) {
                errors += 1
                const message = error instanceof Error ? error.message : String(error)
                status.lastError = `auto-approve failed for card ${card.id}: ${message}`
                // Failure must be observable in the audit stream, not just a
                // transient status string — actor=autoRule + reason, same shape
                // as governance events (collectAudit merges state.events).
                try {
                  store.recordEvent({
                    type: 'auto-approve-failed', scope: 'card', targetId: card.id,
                    actor: 'autoRule', decision: 'failed', note: message,
                    tier: MACHINE_APPROVE_TIER, rule: RULE_APPROVE, channel: AUTO_CHANNEL,
                  })
                } catch { /* audit write must never abort the tick */ }
              }
            }
            const approvalBase = report.approved > 0
              ? `approved ${report.approved} plan(s)`
              : approvable.length === 0 ? 'no plan card' : 'none approved'
            report.approvalReason = report.approvalHeld > 0
              ? `${approvalBase}; ${report.approvalHeld} held for capacity`
              : approvalBase
          }
        }

        // L4 review-entry auto-commit. build leaves a dirty worktree on purpose;
        // the delivery gate needs a clean tree at the reviewed head. Commit HERE,
        // before review dispatch, so the reviewer and delivery share one head.
        // The gate + bounded retry live in ensureCommittedForAutoDelivery. Only
        // cards whose commit result is { ok:true } proceed to review + delivery.
        // Without the port wired (offline fakes / older hosts) this is a no-op
        // and review+delivery run unchanged.
        // V4 independent self-review: dispatch ONE reviewer on the pushed
        // branch. The reviewer (not the engine) later opens the draft PR from
        // the approved head via factory_open_draft_pr.
        if (phaseAllows(phaseRules, 'self-review', 'autoStart') && typeof deps.reviewDispatch === 'function'
          && status.paused !== true && project.paused !== true) {
          const needReview = allCards.filter((card) => card.projectId === project.id
            && card.status === 'self-review' && card.takenOver !== true && card.needsHumanInfo !== true
            && (card.reviewSessionId === null || card.reviewSessionId === undefined || card.reviewSessionId === ''))
          for (const card of needReview) {
            try {
              await deps.reviewDispatch({ store, cardId: card.id })
              report.reviewDispatched += 1
            } catch (error) {
              errors += 1
              status.lastError = `self-review dispatch failed for card ${card.id}: ${error instanceof Error ? error.message : String(error)}`
            }
          }
        }

        // An independent reviewer can end its turn without calling any tool.
        // The identity gate stays strict; we only redispatch a DEAD reviewer
        // with a bounded budget, then park for a human.
        if (phaseAllows(phaseRules, 'self-review', 'autoStart') && typeof deps.reviewDispatch === 'function'
          && status.paused !== true && project.paused !== true) {
          const idleReviews = allCards.filter((card) => card.projectId === project.id
            && card.status === 'self-review' && card.takenOver !== true && card.needsHumanInfo !== true
            && card.stalled !== true && card.selfReview == null && !card.prUrl
            && typeof card.reviewSessionId === 'string' && card.reviewSessionId !== ''
            && (card.selfReviewDispatchFailures ?? 0) < SELF_REVIEW_DISPATCH_LIMIT)
          for (const card of idleReviews) {
            if (await sessionLiveAtDecision(card.reviewSessionId)) continue
            const reason = `self-review session ${card.reviewSessionId} ended without a verdict or PR`
            const outcome = store.recordSelfReviewDispatchFailure(card.id, { reason })
            if (outcome.stalled === true) continue
            try {
              await deps.reviewDispatch({ store, cardId: card.id, note: reason })
              report.reviewDispatched += 1
            } catch (error) {
              errors += 1
              status.lastError = `idle self-review redispatch failed for card ${card.id}: ${error instanceof Error ? error.message : String(error)}`
            }
          }
        }

        // V4 part (3): one independent PR-review session per PR. Idle PR
        // reviewers are NEVER auto-redispatched (Q4) — only audited and
        // surfaced for the human redispatch button.
        if (phaseAllows(phaseRules, 'pr-review', 'autoStart') && typeof deps.prReviewDispatch === 'function'
          && status.paused !== true && project.paused !== true) {
          const needsPrReview = allCards.filter((card) => card.projectId === project.id
            && card.status === 'pr-review' && typeof card.prUrl === 'string' && card.prUrl !== ''
            && card.takenOver !== true && card.needsHumanInfo !== true && card.stalled !== true
            && card.prReviewIdle !== true
            && !(typeof card.prReviewSessionId === 'string' && card.prReviewSessionId !== ''))
          let prSlots = Math.max(0, Math.min(
            projectMax - (activeByProject.get(project.id) ?? 0),
            globalMax - activeCount,
          ))
          for (const card of needsPrReview) {
            if (prSlots <= 0) break
            try {
              await deps.prReviewDispatch({ store, cardId: card.id })
              report.reviewDispatched += 1
              activeCount += 1
              activeByProject.set(project.id, (activeByProject.get(project.id) ?? 0) + 1)
              prSlots -= 1
            } catch (error) {
              errors += 1
              status.lastError = `pr-review dispatch failed for card ${card.id}: ${error instanceof Error ? error.message : String(error)}`
            }
          }
        }
        const idlePrReviews = allCards.filter((card) => card.projectId === project.id
          && card.status === 'pr-review' && typeof card.prUrl === 'string' && card.prUrl !== ''
          && card.prReviewIdle !== true
          && typeof card.prReviewSessionId === 'string' && card.prReviewSessionId !== '')
        for (const card of idlePrReviews) {
          if (await sessionLiveAtDecision(card.prReviewSessionId)) continue
          store.recordPrReviewIdle(card.id, { reason: `pr-review session ${card.prReviewSessionId} ended without a verdict` })
        }

        // Stale self-review: bound rounds are recorded by the verdict tool;
        // here we only offer a re-review when the head moved and the cap allows.
        if (typeof deps.reviewRereview === 'function' && status.paused !== true && project.paused !== true) {
          const needRereview = allCards.filter((card) => card.projectId === project.id
            && card.status === 'self-review' && card.takenOver !== true && card.needsHumanInfo !== true
            && card.reviewStale === true
            && !(card.reviewSessionId === null || card.reviewSessionId === undefined || card.reviewSessionId === '')
            && (card.autoRereviewCount ?? 0) < AUTO_REREVIEW_LIMIT)
          for (const card of needRereview) {
            try {
              store.recordAutoRereview(card.id)
              await deps.reviewRereview({ store, cardId: card.id })
              report.autoRereviewed += 1
            } catch (error) {
              errors += 1
              status.lastError = `auto re-review failed for card ${card.id}: ${error instanceof Error ? error.message : String(error)}`
            }
          }
        }

        // G1/G3 explicit opt-in: without BOTH a GitHub issue source and a target
        // board the engine skips. It never guesses a repo from a local path, reads
        // `git remote`, or creates a board (PRD §10). The reason stays visible.
        const repo = typeof project.issueRepo === 'string' ? project.issueRepo.trim() : ''
        const boardId = typeof project.intakeBoardId === 'string' ? project.intakeBoardId.trim() : ''
        // AE-8: a config-missing skip is a STRICT no-op — no event write, no
        // card, no session, no git. The visible reason lives only in
        // `status.projects`, so repeated ticks stay zero-side-effect.
        if (repo === '' || boardId === '') {
          report.reason = repo === '' ? '未配置 issue 源 (issueRepo)' : '未配置目标看板 (intakeBoardId)'
          continue
        }
        if (store.getBoard(boardId) === undefined || store.getBoard(boardId) === null) {
          report.reason = '目标看板不存在 (intakeBoardId)'
          continue
        }

        // Discovery is allowed even when dispatch is off (AE-1b). A failed gh
        // call is isolated and must not stop dispatch of already-known cards.
        // The gh port is resolved PER PROJECT when the host supplies `ghPortFor`
        // (identity ladder, PGH-9: no single global ghPort). Fake deps that only
        // provide `ghPort` keep working unchanged.
        try {
          let ghPort = deps.ghPort
          if (typeof deps.ghPortFor === 'function') ghPort = await deps.ghPortFor(project)
          const result = await deps.intake({
            store, projectId: project.id, boardId, repo,
            ghPort, origin: intakeOrigin('machine-approve'),
            // Per-project poll cap; null/undefined means "port default (100)".
            // Bounds a single tick against a busy upstream (no card flood).
            limit: Number.isInteger(project.intakeLimit) && project.intakeLimit > 0 ? project.intakeLimit : undefined,
          })
          report.intakeCreated = Array.isArray(result?.created) ? result.created.length : 0
        } catch (error) {
          errors += 1
          status.lastError = `intake failed for ${project.id}: ${error instanceof Error ? error.message : String(error)}`
        }

        const paused = status.paused === true || project.paused === true
        const autoDispatch = behavior.dispatch && phaseAllows(phaseRules, 'inbox', 'autoStart')
        const projectCards = allCards.filter((card) => card.projectId === project.id)
        const inbox = projectCards
          .filter((card) => card.status === 'inbox')
          .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        const dispatchable = inbox.filter((card) => card.takenOver !== true
          && card.needsHumanInfo !== true
          && card.stalled !== true
          && !(card.pendingDispatch !== null && card.pendingDispatch !== undefined)
          // Idempotency (PRD §9.1): never re-dispatch a card that already has a
          // worktree or a session trace. Orphans are reconciled, not rebuilt.
          && !(typeof card.worktreePath === 'string' && card.worktreePath !== '')
          && !(typeof card.sessionId === 'string' && card.sessionId !== ''))

        if (paused || !autoDispatch || dispatchable.length === 0) {
          report.action = paused || !autoDispatch ? 'discover-only' : 'idle'
          report.reason = paused ? 'paused' : (!autoDispatch ? 'inbox autoStart=false' : 'no eligible Inbox card')
          report.queued = inbox.length
          continue
        }

        const projectActive = activeByProject.get(project.id) ?? 0
        let slots = Math.min(projectMax - projectActive, globalMax - activeCount)
        if (slots <= 0) {
          report.action = 'queued'
          report.reason = 'concurrency limit reached'
          report.queued = inbox.length
          continue
        }

        report.action = 'ran'
        for (const card of dispatchable) {
          if (slots <= 0) break
          try {
            const result = await deps.dispatch({
              store, cardId: card.id,
              transitionActor: 'autoRule',
              transitionMeta: { actor: 'autoRule', tier: 'phase-rules', rule: RULE_DISPATCH, channel: AUTO_CHANNEL },
            })
            // `already-dispatched` is a successfully handled card, NOT a failure
            // to retry or to shout about (PRD §9.1). Only a real creation wins a
            // slot; a returned hint means the write already happened earlier.
            if (result?.mode === 'created') {
              slots -= 1
              activeCount += 1
              activeByProject.set(project.id, (activeByProject.get(project.id) ?? 0) + 1)
              report.dispatched += 1
            }
          } catch (error) {
            errors += 1
            status.lastError = `dispatch failed for card ${card.id}: ${error instanceof Error ? error.message : String(error)}`
          }
        }
        report.queued = inbox.length - report.dispatched
      } catch (error) {
        errors += 1
        report.reason = `tick error: ${error instanceof Error ? error.message : String(error)}`
        status.lastError = report.reason
      }
    }

    // V4 merge→done: poll the ACTIVE PR of each pr-review card and feed the
    // existing remote-sync port. Multi-PR cards are deliberately keyed to
    // card.prUrl only; another PR cannot finish them early. Network failure is
    // isolated so the next tick self-heals.
    if (typeof deps.remoteSync === 'function') {
      for (const card of allCards) {
        if (card.status !== 'pr-review' || typeof card.prUrl !== 'string' || card.prUrl === '') continue
        try {
          // Prefer the same per-project git port used by push/createPr. It
          // runs buildGitEnv with the resolved identity, preserving the four
          // fallback layers. ghPortFor remains a compatibility fallback for
          // older hosts/fakes that only expose the issue-list port.
          let port = deps.ghPort
          if (typeof deps.gitPortFor === 'function') port = await deps.gitPortFor(store.getProject(card.projectId))
          else if (typeof deps.ghPortFor === 'function') port = await deps.ghPortFor(store.getProject(card.projectId))
          if (typeof port?.prState !== 'function') continue
          const state = await port.prState({ prUrl: card.prUrl })
          if (typeof state !== 'string') continue
          const outcome = await deps.remoteSync({ store, cardId: card.id, remote: { pr: { state } } })
          if (outcome?.changed === true) status.lastSyncDone = card.id
        } catch (error) {
          errors += 1
          status.lastError = `remote sync failed for card ${card.id}: ${error instanceof Error ? error.message : String(error)}`
        }
      }
    }

    status.orphans = await reconcileOrphans({ store, deps })
    status.projects = projectReports
    status.ticks += 1
    status.lastTickAt = now()
    if (errors === 0) status.lastError = null
    return { overlapped: false, projects: projectReports.length, orphans: status.orphans.length, errors }
  } finally {
    status.singleFlight = false
  }
}

/**
 * Default deps wired to the real host. `dispatch` builds the ctx-backed host port
 * lazily inside each call so a profile without the `agents` service fails only
 * that one card (caught by runTick), never the whole tick. Injectable `deps` let
 * QA exercise the same runTick with a fake store and fake host, offline.
 */
export function defaultEngineDeps({ ctx, store, ghPort = createGhPort(), ghPortFor, gitPortFor, deliver, autoCommit } = {}) {
  return {
    intake: intakeIssues,
    // Per-project gh port from the identity ladder (PGH-9). The host supplies it
    // via index.js; when absent, runTick falls back to the single `ghPort` above.
    ...(typeof ghPortFor === 'function' ? { ghPortFor } : {}),
    ...(typeof gitPortFor === 'function' ? { gitPortFor } : {}),
    dispatch: (args) => dispatchCard({ ...args, port: createHostPort({ ctx }), locale: localeFromContext(ctx, store) }),
    // Machine plan-approval: same store gate as a human button, write-before-
    // receipt prechecked, actor=autoRule. Ports left default (the approval value
    // schema is this repo's own, not a host tool's output — no host validator needed).
    approve: (args) => autoApprovePlan(args),
    // Machine approval's second half: continue the same session so build runs. Same
    // lazy host port as dispatch, so a profile without `agents` fails only this
    // card (caught by runTick), never the whole tick.
    continue: (args) => continueCard({ ...args, port: createHostPort({ ctx }), locale: localeFromContext(ctx, store) }),
    // L4 auto-review: an independent read-only reviewer session, wired with the
    // same lazy host port. Only consumes a slot when the tick offers a Review
    // card with no reviewer; a profile without `agents` fails only that card.
    remoteSync: applyRemoteSync,
    reviewDispatch: (args) => dispatchReview({ ...args, port: createHostPort({ ctx }), locale: localeFromContext(ctx, store) }),
    prReviewDispatch: (args) => dispatchPrReview({ ...args, port: createHostPort({ ctx }), locale: localeFromContext(ctx, store) }),
    // L4 auto re-review: reuse the existing reviewer (followup → resume → new)
    // for a card whose verdict went stale. Same lazy host port; counting and
    // the per-card cap live in runTick, not here.
    reviewRereview: (args) => followupReview({ ...args, port: createHostPort({ ctx }), locale: localeFromContext(ctx, store) }),
    isSessionActive: (sessionId) => {
      const agents = typeof ctx?.get === 'function' ? ctx.get('agents') : undefined
      if (agents === undefined || agents === null || typeof agents.get !== 'function') return false
      return agents.get(sessionId) !== undefined && agents.get(sessionId) !== null
    },
    // P0-2: the only real per-session read the host offers. Resolve against the
    // live agent's session so profile defaults and per-session overrides agree.
    resolveSandboxMode: (sessionId) => {
      try {
        const agents = typeof ctx?.get === 'function' ? ctx.get('agents') : undefined
        const policy = typeof ctx?.get === 'function' ? ctx.get('sandboxPolicy') : undefined
        if (agents === undefined || agents === null || typeof agents.get !== 'function') return null
        if (policy === undefined || policy === null || typeof policy.resolve !== 'function') return null
        const session = agents.get(sessionId)?.session
        if (session === undefined || session === null) return null
        const mode = policy.resolve({ session })?.mode
        return typeof mode === 'string' && SANDBOX_MODES.has(mode) ? mode : null
      } catch { return null }
    },
    // P0-3: inventory read on demand; P2 gates the work-mode option on this.
    readAutoReviewPluginState: () => readAutoReviewPluginState(ctx),
    // P3: L4 delivery is wired here. Without this the tick's `deps.deliver`
    // guard is always false and the host silently never delivers (QA BUG1).
    ...(typeof deliver === 'function' ? { deliver } : {}),
    ...(typeof autoCommit === 'function' ? { autoCommit } : {}),
    ghPort,
  }
}

/**
 * Mount exactly ONE timer on the host timer service, owned by a `ctx.effect` so
 * plugin unload clears it automatically. The service is fetched by injection
 * (same pattern as `commands`): if it never becomes available, the engine simply
 * does not start and `status.timerReason` says so — never a silent no-op.
 *
 * "Already mounted" is tracked on the ENGINE STATE, not in a local or module
 * variable, so it is correct in both directions (AE-4):
 *   - calling twice against the same state mounts exactly one timer (a local
 *     `let mounted` reset on every call and mounted a second one);
 *   - the disposer clears the flag, so after an unload a reload with a fresh
 *     ctx can mount again (a module-level boolean would never mount twice).
 *
 * Returns nothing; the effect disposer handles teardown.
 */
export function startEngine({ ctx, store, status, deps, config = {} } = {}) {
  const intervalMs = positiveInt(config.tickMs, DEFAULT_TICK_MS)
  if (status === undefined || status === null) throw new Error('startEngine needs an engine status object')

  const mount = (scope) => {
    if (status.timerMounted === true) return
    // `scope` is either a sub-Context that DECLARED `timer` (inject path) or an
    // adapter we built from the service object. Read the helpers once, defensively:
    // on a real Cordis ctx an undeclared service read throws, so never probe a
    // property we did not obtain from a declared/adapted source.
    let intervalFn
    let effectFn
    try {
      intervalFn = typeof scope?.interval === 'function' ? scope.interval : undefined
      effectFn = typeof scope?.effect === 'function' ? scope.effect : undefined
    } catch {
      intervalFn = undefined
      effectFn = undefined
    }
    if (typeof intervalFn !== 'function' || typeof effectFn !== 'function') {
      status.timerActive = false
      status.timerReason = 'host has no timer/effect service; engine not started'
      return
    }
    // Claim the mount on the state BEFORE registering, so a second call racing
    // this one (or re-entering through inject) cannot slip past the guard.
    status.timerMounted = true
    // `interval(cb, delay)` is itself a fiber effect and returns an idempotent
    // disposer (cordis-plugin-timer). We still HOLD that disposer in our own
    // plugin effect and call it on unload, without assuming which fiber the host
    // attached its internal effect to. clearInterval is idempotent, so this
    // guarantees cleanup with the plugin fiber even if the host's effect is
    // owned elsewhere (AE-4: no stray tick after unload).
    effectFn.call(scope, () => {
      let dispose
      try {
        dispose = intervalFn.call(scope, () => {
          void runTick({ store, status, deps, config }).catch((error) => {
            status.lastError = error instanceof Error ? error.message : String(error)
          })
        }, intervalMs)
      } catch (error) {
        status.timerMounted = false
        status.timerActive = false
        status.timerReason = `failed to start timer: ${error instanceof Error ? error.message : String(error)}`
        return () => {}
      }
      status.timerActive = true
      status.timerReason = null
      return () => {
        status.timerActive = false
        // Release the claim so a later load (fresh ctx after a reload) can mount.
        status.timerMounted = false
        status.timerReason = 'timer disposed (plugin unloaded)'
        if (typeof dispose === 'function') dispose()
      }
    }, 'dsh-factory: autonomy engine')
  }

  // Resolve the timer service WITHOUT probing `ctx.interval`. On a real Cordis
  // ctx the context is a proxy: reading a service-backed property that was not
  // declared in `inject` THROWS ("cannot get property "timer" without inject"),
  // and that throw happens inside `apply`, which takes the whole plugin down —
  // every route and tool 404s. `ctx.inject` is the safe, declared form (the same
  // pattern index.js uses for `commands`); the callback receives a sub-Context
  // that HAS `timer` in its inject set, so `scope.interval` is legal there.
  //
  // If the service never arrives, `timerReason` keeps a readable value and the
  // engine does NOT silently pretend to run (P1 silent-degradation lesson).
  if (typeof ctx?.inject === 'function') {
    ctx.inject(['timer'], (scope) => { mount(scope) })
    return
  }
  // Plain-object ctx (offline tests / fakes). A real Cordis ctx always has
  // `inject`, so this branch can never trip the proxy rule on a live host.
  if (typeof ctx?.interval === 'function' && typeof ctx?.effect === 'function') {
    mount(ctx)
    return
  }
  status.timerActive = false
  status.timerReason = 'host has no timer service (ctx.inject); engine not started'
}
