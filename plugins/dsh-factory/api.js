/**
 * dsh-factory — pure request handler (L0 domain surface).
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

import { collectAudit } from './audit.js'
import { inspectRepo } from './project-proposal.js'

export function createApi({ store, build = 'unknown', inspect = inspectRepo, runtime = {} }) {
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
          // L1 engine state, readable at any time: why nothing is happening is
          // never hidden. `permissionEnforced` stays false until the host really
          // wires the permission level into sessions (PRD §9.2, no false claim).
          engine: engineStatus(runtime.engine),
          counts: {
            projects: store.state.projects.length,
            boards: store.state.boards.length,
            cards: store.state.cards.length,
          },
        })
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
          const wantsAutonomy = ['autonomy', 'autoStart', 'autoApprove'].some((key) => key in body)
          const wantsPreparation = ['copyFiles', 'postCreate', 'postCreateTimeoutMs'].some((key) => key in body)
          const wantsIntake = ['issueRepo', 'intakeBoardId', 'maxActiveSessions', 'intakeLimit'].some((key) => key in body)
          const kinds = [wantsAutonomy, wantsPreparation, wantsIntake].filter(Boolean).length
          if (kinds > 1) {
            return { status: 400, body: { error: 'autonomy / preparation / intake 字段不能在同一次 PATCH 里混改' } }
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
        if (method === 'DELETE' && seg.length === 2) return ok({ deleted: store.deleteProject(seg[1]) })
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
          return ok({ card: store.transitionCard(seg[1], body.to, body.actor, body.note) })
        }
        if (method === 'POST' && seg.length === 3 && seg[2] === 'authorize') {
          return ok({ authorization: store.authorize(seg[1], body.action) })
        }
        // Take-over removes ONE card from the engine's control, persisted so a
        // reload cannot put it back (PRD §8). Never a project-wide pause.
        if (method === 'POST' && seg.length === 3 && seg[2] === 'takeover') {
          return ok({ card: store.takeOverCard(seg[1], 'human') })
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

/** Copy the observable engine state without leaking references to the caller. */
function engineStatus(engine) {
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
  }
}
