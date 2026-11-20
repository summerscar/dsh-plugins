/**
 * dsh-factory — pure request handler (core domain surface).
 *
 * This is the transport-agnostic half of the HTTP API: it takes
 * `{ method, route, body }` and returns `{ status, body }`, so it is unit-tested
 * with no host and no socket. `index.js` mounts it under
 * `/api/dsh-factory/*` via `webServer.register`.
 *
 * It deliberately stops at the domain boundary. The actual `git commit` /
 * `git push` / `gh pr create` execution needs the host session service, the
 * credential store and a real repo, and belongs to the executor added once
 * those host APIs are verified against `dsh-doc` (PRD §12). What lives here is
 * the part that matters most for safety: every write path goes through the
 * store, which enforces the state machine and the Review-only authorization gate.
 */

import { createHash } from 'node:crypto'

import { collectAudit } from './audit.js'
import { inspectRepo } from './project-proposal.js'
import { applyRemoteSync } from './sync.js'
import { assertWorktreeRoot, isPathInside, removeWorktree, worktreeRootOf } from './worktree.js'
import { DEFAULT_PROJECT_MAX_ACTIVE, effectiveGlobalMaxActive } from './autonomy.js'

/**
 * Delete a project and really remove its worktrees (P4 §4 — the one sanctioned
 * "add a feature" exception). Kept as an injectable pure-ish function so QA can
 * exercise the safety boundaries offline with a fake `remove`.
 *
 * Order matters: clean worktrees FIRST, delete the registration LAST. Any failure
 * (dirty tree, path escaping the project root, git error) throws before the
 * registration is touched, so a rejected delete never leaves "registration gone
 * but worktree still on disk" — the exact new residue the PRD forbids. A partial
 * clean (some removed, then one fails) keeps the registration; the caller sees the
 * verbatim error and can retry with `force` after handling the dirty tree.
 *
 * Safety: every target must be a non-empty absolute path inside THIS project's
 * frozen worktreeRoot (checked with the same assertWorktreeRoot gate as creation),
 * so another project's worktree can never be swept in by a crafted card field.
 */
export function deleteProjectWithWorktrees(store, id, { force = false, remove = removeWorktree } = {}) {
  const project = store.getProject(id)
  if (project === undefined || project === null) throw new Error(`项目不存在：${id}`)
  const root = assertWorktreeRoot(worktreeRootOf(project))
  const cards = store.listCards({ projectId: id })
  const targets = cards
    .filter((card) => typeof card.worktreePath === 'string' && card.worktreePath !== '')
    .map((card) => ({ cardId: card.id, worktreePath: card.worktreePath, branch: card.branch }))
  for (const target of targets) {
    // `worktreeRootOf` returns an absolute resolved root; every stored path must
    // sit under it. A path outside is a hard refusal, never a best-effort skip.
    if (!isPathInside(root, target.worktreePath)) {
      throw new Error(`卡片 ${target.cardId} 的 worktree 不在本项目根 ${root} 下，拒绝删除：${target.worktreePath}`)
    }
  }
  const removed = []
  for (const target of targets) {
    // `removeWorktree` does its own dirty check: without `force` a dirty tree is
    // refused with the exact change list, preserving the user's uncommitted work.
    remove({ repoPath: project.rootPath, worktreePath: target.worktreePath, force, branch: target.branch })
    removed.push({ cardId: target.cardId, worktreePath: target.worktreePath })
  }
  // Only now, with every worktree gone, is the registration removed.
  const deleted = store.deleteProject(id)
  // Audit: actor=human, project id, cleaned worktree list (the cards that carried
  // the paths are already gone, so the list must be captured in the event note).
  store.recordEvent({
    type: 'project-deleted', scope: 'project', targetId: id, actor: 'human', decision: 'deleted',
    note: `worktrees removed: ${removed.length}`,
  })
  return { ...deleted, worktreesRemoved: removed }
}

/**
 * Concurrency view used by the settings UI. `projectDefaultMaxActive` is the
 * launch-config default (NOT HTTP-writable this round); exposing it lets the UI
 * render the effective slots = min(project value, effective global) with correct
 * sources without hard-coding any number (P4 §3.3.3 / §3.3.5).
 */
function concurrencyView(store, engineConfig) {
  const configured = engineConfig.projectMaxActive
  return {
    effectiveGlobalMaxActive: effectiveGlobalMaxActive(store, engineConfig),
    projectDefaultMaxActive: Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_PROJECT_MAX_ACTIVE,
  }
}

export function createApi({ store, build = 'unknown', inspect = inspectRepo, runtime = {}, deleteProject = deleteProjectWithWorktrees, engineConfig = {}, workModeAvailability } = {}) {
  return function handle(input = {}) {
    const method = String(input.method ?? 'GET').toUpperCase()
    const rawRoute = String(input.route ?? '/')
    const queryIndex = rawRoute.indexOf('?')
    const path = queryIndex === -1 ? rawRoute : rawRoute.slice(0, queryIndex)
    const query = new URLSearchParams(queryIndex === -1 ? '' : rawRoute.slice(queryIndex + 1))
    const body = input.body ?? {}
    const seg = path.split('/').filter(Boolean)

    try {
      if (method === 'GET' && seg.length === 1 && seg[0] === 'status') {
        return ok({
          build,
          // Objective signal for the real-machine check: the model-facing tools
          // either all registered or none did. A silent import failure must never
          // again look like "the command worked but the agent has no tools".
          toolsRegistered: runtime.toolsRegistered === true,
          // Autonomy engine state, readable at any time: why nothing is happening is
          // never hidden. `permissionEnforced` is derived each tick from live
          // session sandbox reads (P0-2); `autoReviewPluginState` is the host
          // plugin inventory read-back (P0-3). Both fail closed when unavailable.
          // The effective global cap and its source are computed from the same
          // helper the engine uses, so the UI cannot show a number that differs
          // from what the scheduler enforces (P4 §3.3.3/§3.3.4).
          engine: engineStatus(runtime.engine, effectiveGlobalMaxActive(store, engineConfig)),
          counts: {
            projects: store.state.projects.length,
            boards: store.listBoards().length,
            cards: store.state.cards.length,
          },
        })
      }

      // One cheap probe for the board to poll. It hashes ONLY the material the
      // page renders; engine ticks/audit events are excluded so a ticking timer
      // does not force a full reload every few seconds. The client fetches the
      // full set below only when this revision actually changes.
      if (method === 'GET' && seg.length === 2 && seg[0] === 'state' && seg[1] === 'revision') {
        return ok({ revision: panelRevision(store, engineConfig, runtime, query.get('projectId') ?? undefined) })
      }

      // The Client mirrors the browser-resolved display language here; the
      // Host cannot see that value from its own settings alone.
      if (seg.length === 1 && seg[0] === 'ui-locale') {
        if (method === 'GET') return ok({ uiLocale: store.getUiLocaleSetting() })
        if (method === 'POST') return ok(store.updateUiLocale(body.locale))
      }

      if (method === 'GET' && seg.length === 1 && seg[0] === 'settings') {
        return ok({
          settings: {
            ...store.getWorktreeSettings(),
            globalMaxActive: store.getGlobalMaxActiveSetting(),
            githubClientId: store.getGithubClientIdSetting(),
            ...concurrencyView(store, engineConfig),
          },
        })
      }
      if (method === 'PATCH' && seg.length === 1 && seg[0] === 'settings') {
        // Whichever field is present is written by its OWN setter; `undefined`
        // fields are not passed, so a global-cap write can never clobber
        // worktreeRoot and vice versa (P4 §3.3.1). Both may be sent together only
        // if the client deliberately wants both — each still goes through its
        // own validation, and an error in either surfaces verbatim.
        const out = { ...store.getWorktreeSettings(), globalMaxActive: store.getGlobalMaxActiveSetting(), githubClientId: store.getGithubClientIdSetting() }
        if ('worktreeRoot' in body) Object.assign(out, store.updateWorktreeRoot(body.worktreeRoot))
        if ('globalMaxActive' in body) Object.assign(out, store.updateGlobalMaxActive(body.globalMaxActive))
        // githubClientId is a NON-secret OAuth App id (not a token): HTTP-writable
        // settings, persisted, effective on the next connect with no reload.
        if ('githubClientId' in body) Object.assign(out, store.updateGithubClientId(body.githubClientId))
        Object.assign(out, concurrencyView(store, engineConfig))
        return ok({ settings: out })
      }

      if (method === 'GET' && seg.length === 1 && seg[0] === 'audit') {
        return ok({
          events: collectAudit(store, {
            actor: query.get('actor') ?? undefined,
            decision: query.get('decision') ?? undefined,
            cardId: query.get('cardId') ?? undefined,
            since: query.get('since') ?? undefined,
          }),
        })
      }

      if (seg[0] === 'projects') {
        if (method === 'GET' && seg.length === 1) return ok({ projects: store.listProjects() })
        if (method === 'POST' && seg.length === 1) return ok({ project: store.createProject(body) }, 201)
        // Read-only inspection for the UI's "propose config" step. The UI cannot
        // call the model-facing factory_inspect_repo tool, so it needs its own
        // read-only HTTP entry. Issues NO token and writes NOTHING.
        if (method === 'POST' && seg.length === 2 && seg[1] === 'inspect') {
          const signals = inspect({ rootPath: body.rootPath })
          return ok({ signals: {
            rootPath: signals.rootPath,
            packageManager: signals.packageManager,
            rootFiles: signals.rootFiles,
            rootDirectories: signals.rootDirectories,
            ignoreFiles: signals.ignoreFiles,
            manifestFiles: signals.manifestFiles,
            notes: signals.notes,
            warning: signals.warning,
          } })
        }
        if (method === 'GET' && seg.length === 2) return ok({ project: store.getProject(seg[1]) })
        // THREE disjoint PATCH shapes on purpose: preparation, autonomy, and the
        // explicit opt-in intake config (G1/G3) are separate concerns. A single
        // handler accepting two of them could silently retarget a project while
        // the caller thought it only changed a switch. Identity and rootPath are
        // never writable here. Pause/resume/takeover are separate actions below.
        if (method === 'PATCH' && seg.length === 2) {
          const wantsAutonomy = ['autonomy', 'autoDispatch'].some((key) => key in body)
          const wantsPreparation = ['copyFiles', 'postCreate', 'postCreateTimeoutMs'].some((key) => key in body)
          const wantsIntake = ['issueRepo', 'intakeBoardId', 'maxActiveSessions', 'intakeLimit', 'githubCredentialId'].some((key) => key in body)
          const wantsWorkMode = 'workMode' in body
          const kinds = [wantsAutonomy, wantsPreparation, wantsIntake, wantsWorkMode].filter(Boolean).length
          if (kinds > 1) {
            return { status: 400, body: { error: 'autonomy / preparation / intake / workMode 字段不能在同一次 PATCH 里混改' } }
          }
          if (wantsWorkMode) {
            const available = typeof workModeAvailability === 'function' ? workModeAvailability() : undefined
            const allowAutoReview = available === undefined || available.available === true
            try {
              return ok({ project: store.updateWorkMode(seg[1], body, { allowAutoReview }) })
            } catch (error) {
              return { status: 400, body: { error: error instanceof Error ? error.message : String(error), reason: available?.reason ?? null } }
            }
          }
          if (wantsAutonomy) return ok({ project: store.updateAutonomy(seg[1], body) })
          if (wantsIntake) return ok({ project: store.updateIntake(seg[1], body) })
          return ok({ project: store.updatePreparation(seg[1], body) })
        }
        // Pause / resume are a project-level gate, a distinct action from intake
        // config or autonomy (PRD §8: two actions, never one boolean meaning both).
        if (method === 'POST' && seg.length === 3 && (seg[2] === 'pause' || seg[2] === 'resume')) {
          return ok({ project: store.setProjectPaused(seg[1], seg[2] === 'pause', 'human') })
        }
        // Delete really removes this project's worktrees before dropping the
        // registration (P4 §4). `force` is opt-in from the confirm dialog and
        // never default — a dirty tree is refused with its change list intact.
        if (method === 'DELETE' && seg.length === 2) {
          return ok({ deleted: deleteProject(store, seg[1], { force: body.force === true }) })
        }
      }

      if (seg[0] === 'boards') {
        if (method === 'GET' && seg.length === 1) return ok({ boards: store.listBoards(query.get('projectId') ?? undefined) })
        if (method === 'POST' && seg.length === 1) return ok({ board: store.createBoard(body) }, 201)
      }

      if (seg[0] === 'cards') {
        if (method === 'GET' && seg.length === 1) {
          return ok({
            cards: store.listCards({
              projectId: query.get('projectId') ?? undefined,
              boardId: query.get('boardId') ?? undefined,
              status: query.get('status') ?? undefined,
            }),
          })
        }
        if (method === 'POST' && seg.length === 1) return ok({ card: store.createCard(body) }, 201)
        if (method === 'GET' && seg.length === 2) return ok({ card: store.getCard(seg[1]) })
        if (method === 'POST' && seg.length === 3 && seg[2] === 'transition') {
          // External callers always supply a string note; a missing note on a
          // human return becomes an explicit empty one and is refused by the
          // store hard boundary. Direct internal callers may still omit it.
          const transitionNote = typeof body.note === 'string' ? body.note : ''
          return ok({ card: store.transitionCard(seg[1], body.to, body.actor, transitionNote) })
        }
        if (method === 'POST' && seg.length === 3 && seg[2] === 'authorize') {
          return ok({ authorization: store.authorize(seg[1], body.action) })
        }
        // Take-over removes ONE card from the engine's control, persisted so a
        // reload cannot put it back (PRD §8). Never a project-wide pause.
        if (method === 'POST' && seg.length === 3 && seg[2] === 'takeover') {
          return ok({ card: store.takeOverCard(seg[1], 'human') })
        }
        // Reverse of takeover: one card goes back to the engine. Deliberately a
        // separate route from the dispatch concurrency lock (releaseClaim).
        // Auth is inherited from the host connection gate in index.js.
        if (method === 'POST' && seg.length === 3 && seg[2] === 'release') {
          return ok({ card: store.releaseOverCard(seg[1], 'human') })
        }
        // AE-2b remote-snapshot injection (controlled product entry). Feeds a
        // remote PR fact to the EXISTING applyRemoteSync, which only records a
        // suggestion and never changes the card's status. HARD CONSTRAINTS:
        //   - Only `remote` is forwarded. `actor` / `status` / `target` / `to`
        //     in the body are deliberately NOT read, so the caller cannot pick
        //     an actor (fake autoRule) or a target column — deriveRemoteTarget
        //     owns the target and sync.js owns the syncRule actor.
        //   - pr.state is restricted to the known snapshot states; anything
        //     else is a 400, not a silent suggestion. Errors are rethrown so the
        //     outer catch returns the backend reason verbatim.
        // Auth is inherited: every /api/dsh-factory route passed the host
        // connection gate in index.js:111-124 (401 fail-closed) before here.
        if (method === 'POST' && seg.length === 3 && seg[2] === 'remote-sync') {
          const remote = body?.remote
          const state = typeof remote?.pr?.state === 'string' ? remote.pr.state.toUpperCase() : ''
          if (!['MERGED', 'CLOSED', 'OPEN'].includes(state)) {
            throw new Error('remote.pr.state 必须是 MERGED / CLOSED / OPEN 之一')
          }
          // applyRemoteSync returns { changed:false, needsHuman:true, suggestion }
          // when a suggestion is recorded, or { changed:false } when the state
          // implies no column change (e.g. OPEN). No apply/force/approve exists.
          return ok(applyRemoteSync({ store, cardId: seg[1], remote }))
        }
      }

      // Global pause is a gate on new dispatches for ALL projects; running
      // sessions are never interrupted. The timer keeps ticking (PRD §8).
      if (method === 'POST' && seg.length === 2 && seg[0] === 'engine' && (seg[1] === 'pause' || seg[1] === 'resume')) {
        const paused = seg[1] === 'pause'
        const engine = runtime.engine
        if (engine === undefined || engine === null) {
          return { status: 400, body: { error: 'engine state unavailable' } }
        }
        engine.paused = paused
        store.recordEvent({ type: 'engine-pause', scope: 'global', actor: 'human', decision: paused ? 'paused' : 'resumed' })
        return ok({ engine: { paused } })
      }

      return { status: 404, body: { error: `未知路由：${method} ${path}` } }
    } catch (error) {
      return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } }
    }
  }
}

function ok(body, status = 200) {
  return { status, body }
}

/**
 * Short digest of one project's board (or all, when no id is given). The page
 * selects ONE project, so work on other projects must not churn its refresh.
 * Global controls the same page renders — settings, engine pause, effective
 * cap — stay in the digest either way. Engine ticks/audit events stay out.
 */
function panelRevision(store, engineConfig, runtime, projectId) {
  const state = store.state ?? {}
  const allBoards = state.boards ?? []
  const boardProject = new Map(allBoards.map((board) => [board.id, board.projectId]))
  const scoped = (row) => !projectId || boardProject.get(row.boardId) === projectId
  const material = JSON.stringify({
    projects: projectId ? (state.projects ?? []).filter((entry) => entry.id === projectId) : (state.projects ?? []),
    boards: projectId ? allBoards.filter((entry) => entry.projectId === projectId) : allBoards,
    cards: projectId ? (state.cards ?? []).filter(scoped) : (state.cards ?? []),
    settings: state.settings ?? {},
    enginePaused: runtime?.engine?.paused === true,
    effectiveGlobalMaxActive: effectiveGlobalMaxActive(store, engineConfig).value ?? null,
  })
  return createHash('sha1').update(material).digest('hex').slice(0, 16)
}

/** Copy the observable engine state without leaking references to the caller. */
function engineStatus(engine, globalCap) {
  if (engine === undefined || engine === null) return null
  return {
    timerActive: engine.timerActive === true,
    timerReason: engine.timerReason ?? null,
    paused: engine.paused === true,
    singleFlight: engine.singleFlight === true,
    ticks: engine.ticks ?? 0,
    lastTickAt: engine.lastTickAt ?? null,
    lastError: engine.lastError ?? null,
    projects: Array.isArray(engine.projects) ? engine.projects.map((entry) => ({ ...entry })) : [],
    orphans: Array.isArray(engine.orphans) ? engine.orphans.map((entry) => ({ ...entry })) : [],
    permissionEnforced: engine.permissionEnforced === true,
    permissionEnforcedReason: typeof engine.permissionEnforcedReason === 'string' ? engine.permissionEnforcedReason : null,
    // The host plugin inventory is async; only the latest tick's snapshot is
    // exposed here, so a route can never block on pluginManager. Missing state
    // is rendered as disabled, never as available.
    autoReviewPluginState: (() => {
      const plugin = engine.autoReviewPluginState ?? {}
      return {
        available: plugin.available === true,
        enabled: plugin.enabled === true,
        moduleName: typeof plugin.moduleName === 'string' ? plugin.moduleName : null,
        fiberPhase: typeof plugin.fiberPhase === 'string' ? plugin.fiberPhase : null,
        diagnostic: typeof plugin.diagnostic === 'string' ? plugin.diagnostic : null,
        reason: typeof plugin.reason === 'string' ? plugin.reason : null,
      }
    })(),
    // Effective global concurrency cap + where it came from (settings / config
    // / default), so the UI can render the read-back value and its source (P4 §3.3.4).
    globalMaxActive: globalCap?.value ?? null,
    globalMaxActiveSource: globalCap?.source ?? null,
  }
}
