/**
 * dsh-factory — Host half (L0 core).
 *
 * Boots a JSON-backed three-layer store (Project → Board → Card) and mounts the
 * transport-agnostic API at `/api/dsh-factory/*`. The store enforces the §8 state
 * machine and the §9.4 Review-only authorization gate; the API never touches git
 * directly — actual commit/push/PR execution is the next layer, added once the
 * host session/credential/gh APIs are verified against `dsh-doc` (PRD §12).
 *
 * `inject` names only what this file actually uses: `webServer` to mount the
 * routes and `connection` to admit only requests the host vouches for. Both are
 * present in the web and desktop profiles this plugin targets.
 *
 * @module dsh-factory
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { createEngineStatus, defaultEngineDeps, startEngine } from './autonomy.js'
import { createApi } from './api.js'
import { registerFactoryCommands } from './commands.js'
import { continueCard, createHostPort, dispatchCard } from './dispatch.js'
import { commitCard, createGitPort, createPrForCard } from './git-exec.js'
import { createGhPort, intakeIssues } from './intake.js'
import { inspectRepo } from './project-proposal.js'
import { registerFactorySkills } from './skills.js'
import { FactoryStore } from './store.js'

export { FactoryStore } from './store.js'
export { createApi } from './api.js'
export * as autonomy from './autonomy.js'
export { dispatchCard, continueCard, createHostPort } from './dispatch.js'
export { commitCard, createPrForCard, createGitPort } from './git-exec.js'
export { intakeIssues, createGhPort } from './intake.js'
export { buildSessionContext, attachSessionContext } from './session-context.js'
export * as state from './state.js'
export * as worktree from './worktree.js'

/** Which build of this module is loaded. Bump on every host-side change. */
export const BUILD = 'factory-2026-11-16.38'

export const name = 'dsh-factory'

export const inject = ['webServer', 'connection']

/**
 * Where the JSON state file lives. `config.dataDir` wins, else
 * `DSH_FACTORY_DATA_DIR`, else `~/.dsh-factory`. A real deployment should point
 * this at a host-managed state directory; the default is a placeholder until the
 * host state-path API is confirmed.
 */
export function resolveDataFile(config = {}) {
  const dir = typeof config.dataDir === 'string' && config.dataDir.trim() !== ''
    ? config.dataDir.trim()
    : (process.env.DSH_FACTORY_DATA_DIR || join(homedir(), '.dsh-factory'))
  return join(dir, 'factory.json')
}

function sendJson(res, status, body) {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > 1_000_000) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new SyntaxError(`invalid JSON body: ${text.slice(0, 80)}`)
  }
}

export function apply(ctx, config = {}) {
  const store = new FactoryStore({ file: resolveDataFile(config) })
  // Mutable runtime signal, read fresh on every `status` request: the model-facing
  // tools either all registered or none did, and that fact must be observable
  // instead of hidden behind a swallowed import error.
  const runtime = { toolsRegistered: false, engine: createEngineStatus() }
  const handleApi = createApi({ store, build: BUILD, runtime })

  // L1 autonomy engine: ONE plugin-level timer, owned by a ctx.effect. A missing
  // host timer service leaves `runtime.engine.timerReason` readable instead of
  // silently not running (P1 lesson / PRD §3, Chief hard constraint #2).
  startEngine({ ctx, store, status: runtime.engine, deps: defaultEngineDeps({ ctx, ghPort: createGhPort() }), config: config.engine })
  // /factory slash command. `ctx.inject` waits for the commands service to be
  // ready instead of racing apply(): a profile that loads commands later still
  // gets the command, and a profile without it just skips registration while
  // the board/API keep working. Same optional-service pattern as tools/skills.
  ctx.inject(['commands'], (scope) => {
    scope.effect(() => registerFactoryCommands({ ctx: scope, inspect: (args) => inspectRepo(args) }) ?? (() => {}), 'dsh-factory: slash command')
  })

  // Admit only requests the host's connection service vouches for — these routes
  // read and write project/card state, so an unauthenticated local request must
  // never reach them. Mirrors dsh-mnemon-sync's guard: a missing guard rejects.
  const rejected = (req, res) => {
    const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
    if (connection === undefined || connection === null) {
      sendJson(res, 401, { error: 'unauthorized: no connection service' })
      return true
    }
    if (typeof connection.requestRejection === 'function') {
      const rejection = connection.requestRejection(req)
      if (rejection === undefined) return false
      sendJson(res, rejection, { error: 'request rejected by host policy' })
      return true
    }
    if (typeof connection.authorizeIndex === 'function') {
      return connection.authorizeIndex(req, res) === false
    }
    sendJson(res, 401, { error: 'unauthorized' })
    return true
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/dsh-factory',
    handler: (req, res) => {
      if (rejected(req, res)) return
      void handle(req, res).catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        const status = error instanceof SyntaxError ? 400 : 500
        if (!res.headersSent) sendJson(res, status, { error: message || 'internal error' })
      })
    },
  }), 'dsh-factory: http api')

  // Model-facing tools: the same store operations the HTTP API exposes, so an
  // agent can see and move its card (PRD I-group — the chain must not break
  // between "the card exists" and "the session can act on it"). Registration is
  // optional and lazy: a profile without the `tools` service, or an older host
  // without `@deepseek-ai/dsh-tools`, still runs the HTTP + UI halves. `defineTool`
  // is imported at call time because it is a host peer, never a package dependency.
  const toolsService = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
  if (toolsService !== undefined && toolsService !== null && typeof toolsService.register === 'function') {
    ctx.effect(() => {
      let cancelled = false
      const disposers = []
      void (async () => {
        try {
          const [{ defineTool, validateJsonSchemaValue }, { factoryToolSpecs }] = await Promise.all([
            import('@deepseek-ai/dsh-tools'),
            import('./tools.js'),
          ])
          if (cancelled) return
          // Inject the host's PUBLIC schema validator into the write-before-
          // receipt precheck so it is the EXACT function the host will run on
          // the receipt (zero semantic drift). lossless checking uses the
          // repo's default predicate — the host's snapshot helper is not a
          // declared peer export. Precheck failures are logged, never silent.
          const receiptPorts = {
            ...(typeof validateJsonSchemaValue === 'function' ? { validateSchema: validateJsonSchemaValue } : {}),
            onFailure: ({ tool, stage, reason }) => {
              console.error(`[dsh-factory] receipt precheck blocked ${tool} (${stage}) before write: ${reason}`)
            },
          }
          for (const spec of factoryToolSpecs({ store, receiptPorts })) {
            disposers.push(toolsService.register(defineTool(spec)))
          }
          runtime.toolsRegistered = true
        } catch (error) {
          // All-or-nothing: undo every tool registered before the failure, then
          // flip the signal. A partial set with toolsRegistered=false is worse
          // than none — it hides which tools are actually live. Splice so the
          // teardown below cannot dispose the same tools a second time.
          for (const dispose of disposers.splice(0)) {
            if (typeof dispose !== 'function') continue
            try { dispose() } catch { /* best-effort rollback */ }
          }
          runtime.toolsRegistered = false
          // Loud, greppable warning: a swallowed import used to leave the command
          // and API working while the agent silently had no factory_* tools at all.
          console.error('[dsh-factory] !!! MODEL-FACING TOOLS NOT REGISTERED — agents have NO factory_* tools.')
          console.error('[dsh-factory] !!! Ensure package.json declares @deepseek-ai/dsh-tools as an optional peer and the host loader injects it.')
          console.error('[dsh-factory] !!! cause:', error instanceof Error ? error.message : String(error))
        }
      })()
      return () => {
        cancelled = true
        runtime.toolsRegistered = false
        for (const dispose of disposers) if (typeof dispose === 'function') dispose()
      }
    }, 'dsh-factory: tools')
  }

  // Packaged flow skills: registered on the host `skills` service when present,
  // so installing the plugin installs its flow knowledge. No-op without it.
  registerFactorySkills({ ctx, skillsDir: config.skillsDir })

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://dsh-factory.invalid')
    const route = (url.pathname.slice('/api/dsh-factory'.length) || '/') + url.search
    const method = req.method ?? 'GET'
    const body = method === 'GET' || method === 'HEAD' ? {} : await readJsonBody(req)

    // Dispatch is the one async, side-effecting route (it creates a session); it
    // runs outside the sync domain handler. A profile without the `agents`
    // service refuses it with a 400 rather than pretending to dispatch.
    const dispatch = /^\/cards\/([^/?]+)\/dispatch(?:\?.*)?$/.exec(route)
    if (method === 'POST' && dispatch !== null) {
      try {
        const port = createHostPort({ ctx })
        const result = await dispatchCard({ store, cardId: decodeURIComponent(dispatch[1]), port })
        sendJson(res, 200, result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[dsh-factory] dispatch failed:', message)
        sendJson(res, 400, { error: message || 'dispatch failed' })
      }
      return
    }

    // Continuation: the card already has a worktree; only a session is obtained.
    // Three-level chain inside continueCard (followup → resume → fresh + record).
    const continuation = /^\/cards\/([^/?]+)\/continue(?:\?.*)?$/.exec(route)
    if (method === 'POST' && continuation !== null) {
      try {
        const port = createHostPort({ ctx })
        const result = await continueCard({
          store,
          cardId: decodeURIComponent(continuation[1]),
          port,
          message: typeof body.message === 'string' ? body.message : undefined,
        })
        sendJson(res, 200, result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[dsh-factory] continuation failed:', message)
        sendJson(res, 400, { error: message || 'continuation failed' })
      }
      return
    }

    // Authorized git execution. The gate is enforced inside commitCard /
    // createPrForCard: without a Review-time human authorization they throw
    // before touching git. `message`/`title`/`body` are optional overrides.
    const commitMatch = /^\/cards\/([^/?]+)\/commit(?:\?.*)?$/.exec(route)
    if (method === 'POST' && commitMatch !== null) {
      try {
        const port = createGitPort()
        const result = await commitCard({ store, cardId: decodeURIComponent(commitMatch[1]), port, message: body.message })
        sendJson(res, 200, result)
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    const prMatch = /^\/cards\/([^/?]+)\/create-pr(?:\?.*)?$/.exec(route)
    if (method === 'POST' && prMatch !== null) {
      try {
        const port = createGitPort()
        const result = await createPrForCard({ store, cardId: decodeURIComponent(prMatch[1]), port, title: body.title, body: body.body })
        sendJson(res, 200, result)
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    // Intake: poll a repo's open issues via gh and turn new ones into Inbox cards.
    const intakeMatch = /^\/boards\/([^/?]+)\/intake(?:\?.*)?$/.exec(route)
    if (method === 'POST' && intakeMatch !== null) {
      try {
        const boardId = decodeURIComponent(intakeMatch[1])
        const board = store.getBoard(boardId)
        const result = await intakeIssues({ store, projectId: board?.projectId, boardId, repo: body.repo, ghPort: createGhPort() })
        sendJson(res, 200, result)
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    const result = handleApi({ method, route, body })
    sendJson(res, result.status, result.body)
  }
}
