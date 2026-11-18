/**
 * dsh-factory — L1 autonomy engine (P2).
 *
 * ONE plugin-level timer, not one per project. Each tick enumerates every project
 * and decides, per project, whether to discover issues and/or dispatch Inbox
 * cards. All orchestration is pure over an injected `deps` port, so the whole
 * chain is exercised offline with a fake store and fake host — no real timer, no
 * real `gh`, no real sessions.
 *
 * The engine's boundaries by level (PRD §4):
 *   - L0 (default): strict no-op — no cards, no sessions, no writes.
 *   - L1: discovery + `inbox -> triage` dispatch only, via `dispatchCard`.
 *     It never reads `autoApprove`, so `L1 + autoApprove=true` still stops at
 *     plan-review (AE-1d); it never touches a card outside Inbox.
 *   - L2 (explicit opt-in + autoApprove): adds ONE machine action — approving a
 *     plan (`plan-review -> build`, actor=autoRule) through the same state gate,
 *     then continuing that card's session so build actually runs. Approving
 *     alone strands the card in build with no agent — the same dead-end the
 *     human button fixes. arm-delivery and git stay human-only; pause/takeover
 *     stop approval at once.
 *
 * Default zero side effects (PRD §5): a project at L0, or a paused project, or
 * one without explicit intake config, produces no cards, no sessions, no git
 * writes. Discovery (intake) may still create Inbox cards when `autoStart=false`;
 * dispatch is gated on `autoStart` (AE-1b).
 *
 * The engine deliberately does NOT reimplement dedupe, dispatch, continuation,
 * rollback, circuit breaking or the state machine — it calls the existing
 * `intakeIssues` / `dispatchCard` / `autoApprovePlan` / `continueCard` /
 * `isSessionActive` through `deps`. All orchestration is pure over an injected
 * `deps` port, so the whole chain is exercised offline with a fake store and
 * fake host — no real timer, no real `gh`, no real sessions.
 */
import { continueCard, createHostPort, dispatchCard } from './dispatch.js'
import { createGhPort, intakeIssues } from './intake.js'
import { precheckReceipt } from './receipt.js'

/** Conservative, overridable defaults. Never hard-code a host-specific path/command. */
export const DEFAULT_TICK_MS = 60_000
export const DEFAULT_GLOBAL_MAX_ACTIVE = 5
export const DEFAULT_PROJECT_MAX_ACTIVE = 5

/** Stable governance identifiers written into card history / audit events. */
export const AUTO_TIER = 'L1'
export const AUTO_CHANNEL = 'poll'
export const RULE_INTAKE = 'auto-issue-discovery'
export const RULE_DISPATCH = 'auto-dispatch-triage'
// L2 machine plan-approval (opt-in). arm-delivery stays human — no rule id here.
export const L2_TIER = 'L2'
export const RULE_APPROVE = 'auto-approve-plan'

/**
 * The ONE machine approval action in L2: approve the plan of a plan-review card.
 * It reuses the SAME gate a human button uses (store.transitionCard →
 * assertTransition, where autoRule is legal on plan-review->build, state.js:50).
 * It does NOT arm delivery authorization and never touches git — those stay
 * human-only (user's chosen conservative L2 boundary). `autoApprove` is read
 * ONLY by L2; L1/L0 ignore it even when true (AE-1d).
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
  if (card.status !== 'plan-review') return { skipped: true, reason: `status=${card.status}` }
  if (card.takenOver === true) return { skipped: true, reason: 'taken-over' }
  const value = { id: cardId, from: 'plan-review', to: 'build', actor: 'autoRule' }
  // Same write/receipt boundary as the model-facing tools: precheck, then write.
  precheckReceipt({ name: 'factory_auto_approve', schema: APPROVE_OUTPUT.schema, render: APPROVE_OUTPUT.render, args: {}, value, ports })
  store.transitionCard(cardId, 'build', 'autoRule', note, {
    actor: 'autoRule', tier: L2_TIER, rule: RULE_APPROVE, channel: AUTO_CHANNEL,
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
 * visible here. `permissionEnforced` is deliberately false and must stay that
 * way until the host actually wires the permission level into sessions (PRD §9.2
 * — do not claim write-restriction is enforced when it is only a config value).
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
  }
}

/** Auto-discovery provenance attached to cards the engine creates. */
const intakeOrigin = () => ({ actor: 'autoRule', tier: AUTO_TIER, rule: RULE_INTAKE, channel: AUTO_CHANNEL })
/** Audit metadata for the single automatic transition (inbox -> triage). */
const dispatchMeta = () => ({ tier: AUTO_TIER, rule: RULE_DISPATCH, channel: AUTO_CHANNEL })

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

    for (const project of store.listProjects()) {
      const report = {
        projectId: project.id,
        autonomy: project.autonomy,
        action: 'skipped',
        reason: null,
        intakeCreated: 0,
        dispatched: 0,
        approved: 0,
        continued: 0,
        approvalHeld: 0,
        queued: 0,
      }
      projectReports.push(report)
      try {
        // L0 (and anything else) is a strict no-op: no cards, no sessions, no
        // git writes (AE-1a). L1 and L2 both run discovery + dispatch; L2 adds
        // the machine plan-approval stage below (autoApprove opt-in only).
        const level = project.autonomy
        if (level !== 'L1' && level !== 'L2') {
          report.reason = `autonomy=${level} (engine acts only at L1/L2)`
          continue
        }

        // Shared per-project budget: L2 plan-approval continuations and Inbox
        // dispatch both keep/create active sessions, so they draw from the SAME
        // cap. Declared once here; each stage re-reads the live counters below.
        const projectMax = positiveInt(project.maxActiveSessions, projectDefaultMax)

        // L2 machine plan-approval — the ONE extra action L2 takes. Independent
        // of intake config (issueRepo/board): it judges LOCAL card status only,
        // never a remote snapshot (AE-2b). pause / takeover apply immediately.
        // autoApprove is read ONLY here at L2, so L1+autoApprove=true is inert
        // (AE-1d). A missing deps.approve port (offline L1 fakes) simply skips.
        if (level === 'L2' && project.autoApprove === true && typeof deps.approve === 'function') {
          const approvalPaused = status.paused === true || project.paused === true
          if (approvalPaused) {
            report.approvalReason = 'paused'
          } else {
            const approvable = allCards
              .filter((card) => card.projectId === project.id && card.status === 'plan-review')
              .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
            // A continue that reuses a still-live session (followup) adds no
            // new session and needs no slot; a resume/fresh fallback does.
            // Without this a tick could open N sessions under a cap of 1.
            const approvalProjectActive = activeByProject.get(project.id) ?? 0
            let approvalSlots = Math.max(0, Math.min(projectMax - approvalProjectActive, globalMax - activeCount))
            for (const card of approvable) {
              const liveSession = typeof card.sessionId === 'string' && card.sessionId !== ''
                && activeSessionIds.has(card.sessionId)
              // Hold the approval itself, not just the continuation: approving
              // without a slot would strand the card in build with no agent.
              if (!liveSession && approvalSlots <= 0) {
                report.approvalHeld += 1
                continue
              }
              try {
                const result = await deps.approve({
                  store, cardId: card.id,
                  note: 'L2 auto-approve: plan approved by engine (opt-in)',
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
                          tier: L2_TIER, rule: RULE_APPROVE, channel: AUTO_CHANNEL,
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
                    tier: L2_TIER, rule: RULE_APPROVE, channel: AUTO_CHANNEL,
                  })
                } catch { /* audit write must never abort the tick */ }
              }
            }
            const approvalBase = report.approved > 0
              ? `approved ${report.approved} plan(s)`
              : approvable.length === 0 ? 'no plan-review card' : 'none approved'
            report.approvalReason = report.approvalHeld > 0
              ? `${approvalBase}; ${report.approvalHeld} held for capacity`
              : approvalBase
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
            ghPort, origin: intakeOrigin(),
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
        const autoStart = project.autoStart === true
        const projectCards = allCards.filter((card) => card.projectId === project.id)
        const inbox = projectCards
          .filter((card) => card.status === 'inbox')
          .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        const dispatchable = inbox.filter((card) => card.takenOver !== true
          && card.stalled !== true
          && !(card.pendingDispatch !== null && card.pendingDispatch !== undefined)
          // Idempotency (PRD §9.1): never re-dispatch a card that already has a
          // worktree or a session trace. Orphans are reconciled, not rebuilt.
          && !(typeof card.worktreePath === 'string' && card.worktreePath !== '')
          && !(typeof card.sessionId === 'string' && card.sessionId !== ''))

        if (paused || !autoStart || dispatchable.length === 0) {
          report.action = paused || !autoStart ? 'discover-only' : 'idle'
          report.reason = paused ? 'paused' : (!autoStart ? 'autoStart=false' : 'no eligible Inbox card')
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
              transitionMeta: dispatchMeta(),
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
export function defaultEngineDeps({ ctx, ghPort = createGhPort(), ghPortFor } = {}) {
  return {
    intake: intakeIssues,
    // Per-project gh port from the identity ladder (PGH-9). The host supplies it
    // via index.js; when absent, runTick falls back to the single `ghPort` above.
    ...(typeof ghPortFor === 'function' ? { ghPortFor } : {}),
    dispatch: (args) => dispatchCard({ ...args, port: createHostPort({ ctx }) }),
    // L2 machine plan-approval: same store gate as a human button, write-before-
    // receipt prechecked, actor=autoRule. Ports left default (the approval value
    // schema is this repo's own, not a host tool's output — no host validator needed).
    approve: (args) => autoApprovePlan(args),
    // L2 approval's second half: continue the same session so build runs. Same
    // lazy host port as dispatch, so a profile without `agents` fails only this
    // card (caught by runTick), never the whole tick.
    continue: (args) => continueCard({ ...args, port: createHostPort({ ctx }) }),
    isSessionActive: (sessionId) => {
      const agents = typeof ctx?.get === 'function' ? ctx.get('agents') : undefined
      if (agents === undefined || agents === null || typeof agents.get !== 'function') return false
      return agents.get(sessionId) !== undefined && agents.get(sessionId) !== null
    },
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
    }, 'dsh-factory: L1 autonomy engine')
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
