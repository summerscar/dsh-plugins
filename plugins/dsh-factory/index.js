/**
 * dsh-factory — Host half (core).
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

import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

import { createEngineStatus, defaultEngineDeps, startEngine } from './autonomy.js'
import { createApi } from './api.js'
import { registerFactoryCommands } from './commands.js'
import { continueCard, createHostPort, dispatchCard } from './dispatch.js'
import { commitCard, createGitPort, createPrForCard } from './git-exec.js'
import { localeFromContext } from './session-context.js'
import { createGhPort, intakeIssues } from './intake.js'
import { inspectRepo } from './project-proposal.js'
import { registerFactorySkills } from './skills.js'
import { FactoryStore } from './store.js'
import { decideIdentity, identityView, OAUTH_KEY_ID, credentialKeyOf } from './identity.js'
import { registerGithubOAuthFlow, verifyLogin } from './github-oauth.js'
import {
  identityCardFor, probePermission, createAuthorizationBridge, writeGithubToken, removeGithubToken,
  disconnectOAuth, oauthState, ghCliState, sharedTokenState,
} from './github-api.js'

export { FactoryStore } from './store.js'
export { createApi } from './api.js'
export * as autonomy from './autonomy.js'
export { dispatchCard, continueCard, createHostPort } from './dispatch.js'
export { commitCard, createPrForCard, createGitPort } from './git-exec.js'
export { intakeIssues, createGhPort } from './intake.js'
export { buildSessionContext, attachSessionContext } from './session-context.js'
export * as state from './state.js'
export * as worktree from './worktree.js'
export * as identity from './identity.js'
export {
  registerGithubOAuthFlow, requestDeviceCode, pollDeviceToken, verifyLogin, storeUserToken,
} from './github-oauth.js'
export {
  identityCardFor, probePermission, createAuthorizationBridge, writeGithubToken, removeGithubToken,
  disconnectOAuth, oauthState, ghCliState, sharedTokenState,
} from './github-api.js'

/** Which build of this module is loaded. Bump on every host-side change. */
export const BUILD = 'factory-2026-11-18.9'

export const name = 'dsh-factory'

export const inject = ['webServer', 'connection']

/**
 * Where the SQLite database lives. `config.dataDir` wins, else
 * `DSH_FACTORY_DATA_DIR`, else `<DSH home>/dsh-factory`. The DSH home itself is
 * resolved by the host's canonical helper (explicit → `$DSH_HOME` → `~/.dsh`);
 * this is a DATA directory, not the worktrees root (`~/dsh-factory-worktrees`).
 */
export function resolveDataFile(config = {}) {
  const override = typeof config.dataDir === 'string' && config.dataDir.trim() !== ''
    ? config.dataDir.trim()
    : (typeof process.env.DSH_FACTORY_DATA_DIR === 'string' && process.env.DSH_FACTORY_DATA_DIR.trim() !== ''
      ? process.env.DSH_FACTORY_DATA_DIR.trim()
      : '')
  const dir = override !== '' ? override : join(resolveDshHome(), 'dsh-factory')
  return join(dir, 'factory.sqlite')
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
  // `config.engine` is the launch-config fallback for the global concurrency cap;
  // the HTTP-written value in store.settings takes priority (P4 §3.3). The API
  // needs it to report the effective value + source back to the UI.
  const handleApi = createApi({ store, build: BUILD, runtime, engineConfig: config.engine ?? {} })

  // The HTTP-written githubClientId (NON-secret) lives in store.settings; the
  // actual GitHub identities live in the host credential service, never here.
  // Both the two git chains and the identity card go through this ONE resolver.
  let credentialsService = null
  let authorizationService = null
  let authBridge = null

  // A liveness probe for token-backed tiers (PGH-22): a plain GET /user verifies
  // the token still works AND returns the real login in the same call (坑⑦⑨).
  // A dead/stale token makes that tier fall through — no false green. Uses the
  // default fetch so QA can stub globalThis.fetch; no secret-bearing endpoint.
  const verifyToken = async (token) => ({ login: await verifyLogin({ token }) })

  async function resolveIdentity(project) {
    const readRecord = async (key) => {
      const svc = credentialsService
      if (svc === null || typeof svc.readRecord !== 'function') return undefined
      return svc.readRecord(key)
    }
    return decideIdentity({
      project,
      clientId: store.getGithubClientIdSetting(),
      readRecord,
      verifyToken,
    })
  }

  // Credentials + authorization are optional host services. Register them the
  // LAZY way (same as commands / timer): a profile without them keeps the board,
  // API and engine fully working — only GitHub identity features go dormant with
  // a readable error, instead of taking the whole plugin down at apply().
  ctx.inject(['credentials', 'authorization'], (scope) => {
    credentialsService = scope.credentials ?? null
    authorizationService = scope.authorization ?? null
    const disposeFlow = registerGithubOAuthFlow({
      authorization: authorizationService,
      getClientId: () => store.getGithubClientIdSetting(),
    })
    authBridge = createAuthorizationBridge({
      authorization: authorizationService,
      key: credentialKeyOf(OAUTH_KEY_ID),
    })
    return () => {
      authBridge = null
      credentialsService = null
      authorizationService = null
      if (typeof disposeFlow === 'function') disposeFlow()
    }
  })

  // Autonomy engine: ONE plugin-level timer, owned by a ctx.effect. A missing
  // host timer service leaves `runtime.engine.timerReason` readable instead of
  // silently not running (P1 lesson / PRD §3, Chief hard constraint #2).
  // Engine intake resolves the identity PER PROJECT (no single global ghPort any
  // more — PGH-9), using the same resolveIdentity the manual chains use.
  startEngine({
    ctx, store, status: runtime.engine,
    deps: defaultEngineDeps({
      ctx,
      ghPort: createGhPort(),
      ghPortFor: async (project) => createGhPort((await resolveIdentity(project)).git),
    }),
    config: config.engine,
  })
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
        const result = await dispatchCard({ store, cardId: decodeURIComponent(dispatch[1]), port, locale: localeFromContext(ctx) })
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
          locale: localeFromContext(ctx),
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
        const cardId = decodeURIComponent(prMatch[1])
        const card = store.getCard(cardId)
        const project = card?.projectId ? store.getProject(card.projectId) : undefined
        // One decision, one env construction — the push chain uses the SAME
        // resolver as engine/manual intake (PGH-9, pitfall ①). buildGitEnv itself
        // is untouched; it only receives the winner's argument group.
        const decision = await resolveIdentity(project)
        const port = createGitPort(decision.git)
        const result = await createPrForCard({ store, cardId, port, title: body.title, body: body.body })
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
        // Archived boards are hidden from the one-board-per-project surface;
        // never let an old URL pull new cards into one.
        if (board === undefined || board === null) throw new Error('目标看板不存在或已归档 (boardId)')
        const project = board.projectId ? store.getProject(board.projectId) : undefined
        const decision = await resolveIdentity(project)
        const result = await intakeIssues({ store, projectId: board?.projectId, boardId, repo: body.repo, ghPort: createGhPort(decision.git) })
        sendJson(res, 200, result)
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    // ---- GitHub identity (P4-github, backend) --------------------------------
    // All identity routes are fail-closed: an absent credential/authorization
    // service yields a readable error, never a silent "not connected" that could
    // be mistaken for a real answer.

    // Identity card: binding relationship + the single winning identity (six
    // states) + its source. Token-free by construction (identityCardFor).
    const identityMatch = /^\/identity\/([^/?]+)(?:\?.*)?$/.exec(route)
    if (method === 'GET' && identityMatch !== null) {
      try {
        const id = decodeURIComponent(identityMatch[1])
        const project = store.getProject(id)
        if (project === undefined || project === null) throw new Error(`项目不存在：${id}`)
        const decision = await resolveIdentity(project)
        // gh CLI is a local login with no token in the decision; its account
        // name is resolved read-only by ghCliState (same probe env). Without
        // this the card knows the source but shows "account unknown".
        if (decision?.source === 'gh-cli' && decision.login === null) {
          const login = ghCliState({ env: process.env }).login
          if (login !== null) decision.login = login
        }
        sendJson(res, 200, identityCardFor({ project, decision }))
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    // Permission check: a user-triggered, READ-ONLY probe against the winning
    // identity. Never runs per tick, never changes the decision, never echoes a
    // token — only { status, reason } (PGH-7).
    const permMatch = /^\/identity\/([^/?]+)\/check(?:\?.*)?$/.exec(route)
    if (method === 'POST' && permMatch !== null) {
      try {
        const id = decodeURIComponent(permMatch[1])
        const project = store.getProject(id)
        if (project === undefined || project === null) throw new Error(`项目不存在：${id}`)
        const decision = await resolveIdentity(project)
        const repo = typeof body.repo === 'string' && body.repo.trim() !== '' ? body.repo : project.issueRepo
        const result = await probePermission({ decision, repo, env: process.env })
        const saved = store.recordPermissionCheck(id, result, repo)
        sendJson(res, 200, { ...result, checkedAt: saved.permissionCheckedAt })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    // ---- Global account management (PGH-19~21) ------------------------------
    // All three live in the GLOBAL settings area only; the per-repo identity
    // card's "which account this repo uses" row is untouched.

    // OAuth connection state (connected / in-flight / app-id present) for the
    // global block. Read-only; never returns a token.
    if (method === 'GET' && /^\/auth\/oauth\/state(?:\?.*)?$/.test(route)) {
      try {
        sendJson(res, 200, await oauthState({
          credentials: credentialsService,
          authorization: authorizationService,
          clientId: store.getGithubClientIdSetting(),
        }))
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    // OAuth 撤销 = local disconnect only + honest revoke-on-website guidance.
    // Idempotent; never calls a client_secret endpoint; never claims remote revoke.
    if (method === 'POST' && /^\/auth\/oauth\/disconnect(?:\?.*)?$/.test(route)) {
      try {
        sendJson(res, 200, await disconnectOAuth({
          credentials: credentialsService,
          clientId: store.getGithubClientIdSetting(),
        }))
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    // Global GitHub Token state (global, read-only). Describes the shared token
    // record + liveness; never echoes the token itself.
    if (method === 'GET' && /^\/auth\/token\/state(?:\?.*)?$/.test(route)) {
      try {
        sendJson(res, 200, await sharedTokenState({ credentials: credentialsService, verifyToken, env: process.env }))
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    // gh CLI login state (global, read-only). Reported whether logged in or not.
    if (method === 'GET' && /^\/auth\/ghcli\/state(?:\?.*)?$/.test(route)) {
      try { sendJson(res, 200, ghCliState({ env: process.env })) }
      catch (error) { sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) }) }
      return
    }

    // Authorization bridge (device flow). Notices/prompts live in an in-memory
    // session; the browser polls it and answers/cancels. A reload drops the
    // session (seam constraint — UX says keep the page open).
    if (method === 'POST' && /^\/auth\/connect\/begin(?:\?.*)?$/.test(route)) {
      try {
        if (authBridge === null) throw new Error('授权服务不可用，暂时无法连接 GitHub')
        sendJson(res, 200, authBridge.begin())
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    const connectMatch = /^\/auth\/connect\/([^/?]+)(?:\/answer|\/cancel)?(?:\?.*)?$/.exec(route)
    if (connectMatch !== null) {
      try {
        if (authBridge === null) throw new Error('授权服务不可用，暂时无法连接 GitHub')
        const sessionId = decodeURIComponent(connectMatch[1])
        if (method === 'GET') {
          const view = authBridge.read(sessionId)
          if (view === null) { sendJson(res, 404, { error: '连接会话不存在或已过期，请重新开始' }); return }
          sendJson(res, 200, view)
        } else if (method === 'POST' && route.includes('/answer')) {
          sendJson(res, 200, authBridge.answer(sessionId, body.value))
        } else if (method === 'POST' && route.includes('/cancel')) {
          sendJson(res, 200, authBridge.cancel(sessionId))
        } else {
          sendJson(res, 404, { error: `未知路由：${method} ${path}` })
        }
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    // User-supplied github token → credential store. The scope switch (global
    // vs per-repo) exists ONLY here for gh token; the token itself never leaves
    // the Host and is never echoed (PGH-18 / no echo).
    if (method === 'POST' && /^\/auth\/token(?:\?.*)?$/.test(route)) {
      try {
        const result = await writeGithubToken({
          store, credentials: credentialsService,
          token: body.token, scope: body.scope, projectId: body.projectId,
        })
        sendJson(res, 200, result)
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    if (method === 'DELETE' && /^\/auth\/token(?:\?.*)?$/.test(route)) {
      try {
        const result = await removeGithubToken({
          store, credentials: credentialsService, scope: body.scope, projectId: body.projectId,
        })
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
