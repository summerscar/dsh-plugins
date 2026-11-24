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
import { createDeliveryCopyGenerator } from './ai-copy.js'
import { createApi } from './api.js'
import { registerFactoryCommands } from './commands.js'
import { continueCard, createHostPort, dispatchCard, dispatchPrReview, dispatchReview, followupReview } from './dispatch.js'
import { commitCard, commitForExistingPr, createGitPort, createPrForCard, pushExistingCard } from './git-exec.js'
import { runAutoDelivery, ensureCommittedForAutoDelivery } from './delivery.js'
import { localeFromContext } from './session-context.js'
import { assertNoActiveSession, sessionActiveFor } from './session-guard.js'
import { readHeadFromGit } from './verdict.js'
import { assertApprovedVerdict, assertManualWritesAllowed } from './verdict-guard.js'
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
export { dispatchPrReview, dispatchReview, followupReview } from './dispatch.js'
export { sandboxModeForWorkMode, readAutoReviewPluginState } from './dispatch.js'
export { commitCard, createPrForCard, createGitPort } from './git-exec.js'
export { commitForExistingPr, pushExistingCard } from './git-exec.js'
export { intakeIssues, createGhPort } from './intake.js'
export { buildSessionContext, attachSessionContext } from './session-context.js'
export * as verdict from './verdict.js'
export * as delivery from './delivery.js'
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
export const BUILD = 'factory-2026-11-20.58'

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
  // One liveness reader for the whole write boundary: the UI hides actions
  // while a session runs, and these routes refuse the same direct requests.
  const isSessionActive = (sessionId) => sessionActiveFor(ctx, sessionId)
  const deliveryCopy = createDeliveryCopyGenerator({ ctx })
  const handleApi = createApi({ store, build: BUILD, runtime, engineConfig: config.engine ?? {}, workModeAvailability: () => runtime.engine?.autoReviewPluginState, isSessionActive, requireApprovedVerdict: true })

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
      ctx, store,
      ghPort: createGhPort(),
      ghPortFor: async (project) => createGhPort((await resolveIdentity(project)).git),
      // PR status uses the SAME git wrapper as push/createPr. Pass an explicit
      // ghLoggedIn boolean from the identity decision (false for env/none) so
      // createGitPort never re-probes and overrides the resolved four-layer
      // fallback with a stray gh CLI login.
      gitPortFor: async (project) => {
        const git = (await resolveIdentity(project))?.git ?? {}
        return createGitPort({ ...git, ghLoggedIn: git.ghLoggedIn === true })
      },
      // L4 review-entry commit: real git port from the identity ladder, same
      // authorization boundary as deliver (pre-authorized L4, no forged
      // pendingAuthorization). ensureCommitted... gates on tier/branch/dirty
      // tree and applies the bounded retry; no commitSha means no review/deliver.
      autoCommit: async ({ store: s, cardId }) => {
        const card = s.getCard(cardId)
        const project = card?.projectId ? s.getProject(card.projectId) : undefined
        const identity = await resolveIdentity(project)
        return ensureCommittedForAutoDelivery({
          store: s, cardId, port: createGitPort(identity.git), isSessionActive,
          generateMessage: ({ store: copyStore, card: copyCard, fallback }) =>
            deliveryCopy.commit({ card: copyCard, fallback, mode: 'worktree' }).then((draft) => ({
              text: draft.text, generated: draft.generated, reason: draft.reason,
            })),
        })
      },
      deliver: async ({ store: s, cardId }) => {
        const card = s.getCard(cardId)
        const project = card?.projectId ? s.getProject(card.projectId) : undefined
        const identity = await resolveIdentity(project)
        return runAutoDelivery({
          store: s, cardId,
          port: createGitPort(identity.git),
          resolveIdentity: async () => identity,
          generatePr: ({ store: copyStore, card: copyCard, fallbackTitle, fallbackBody }) =>
            deliveryCopy.pr({ card: copyCard, fallbackTitle, fallbackBody, mode: 'branch' }),
        })
      },
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
          const buildGitPortFor = async (card) => {
            const project = card?.projectId ? store.getProject(card.projectId) : undefined
            const identity = await resolveIdentity(project)
            return createGitPort(identity.git)
          }
          for (const spec of factoryToolSpecs({
            store, receiptPorts, readHead: readHeadFromGit, buildGitPortFor, isSessionActive,
            closePrFor: async (card) => {
              const project = card?.projectId ? store.getProject(card.projectId) : undefined
              const identity = await resolveIdentity(project)
              createGhPort(identity.git).closePr({ prUrl: card.prUrl, reason: 'dsh-factory: approved head drifted; draft PR closed' })
            },
          })) {
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

    // DELETE /cards/:id — permanent deletion of a TERMINAL card only.
    // Deletion is irreversible, so it requires BOTH a terminal status (enforced
    // in store.deleteCard) and an explicit `{ confirm: true }` in the body. The
    // UI already gates it behind a confirm modal; the body flag is a second,
    // server-side guard so a stray/cached script or a mis-typed API call cannot
    // erase a card by accident. There is no standing delete permission here.
    const cardDelete = /^\/cards\/([^/?]+)(?:\?.*)?$/.exec(route)
    if (method === 'DELETE' && cardDelete !== null) {
      if (body.confirm !== true) {
        sendJson(res, 400, { error: '删除卡片需要请求体 { confirm: true } 明确确认' })
        return
      }
      try {
        const result = store.deleteCard(decodeURIComponent(cardDelete[1]), { actor: 'human' })
        sendJson(res, 200, result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const status = /仅终态卡可删除|卡片不存在/.test(message) ? 400 : 500
        sendJson(res, status, { error: message || 'delete card failed' })
      }
      return
    }

    // Dispatch is the one async, side-effecting route (it creates a session); it
    // runs outside the sync domain handler. A profile without the `agents`
    // service refuses it with a 400 rather than pretending to dispatch.
    const dispatch = /^\/cards\/([^/?]+)\/dispatch(?:\?.*)?$/.exec(route)
    if (method === 'POST' && dispatch !== null) {
      try {
        const port = createHostPort({ ctx })
        const result = await dispatchCard({ store, cardId: decodeURIComponent(dispatch[1]), port, locale: localeFromContext(ctx, store) })
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
          locale: localeFromContext(ctx, store),
          message: typeof body.message === 'string' ? body.message : undefined,
        })
        sendJson(res, 200, result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[dsh-factory] continuation failed:', message)
        // Approve-plan is two calls (transition plan-review->build, then this
        // /continue). If the session cannot start, the card would be stranded
        // in build with no session. Roll it back to plan-review using the
        // synthetic agent edge so the human can retry — symmetric to the
        // return-to-plan AC24 rollback. Only a build card is affected; engine
        // continuations (deps.continue) never pass through this HTTP route.
        const cardId = decodeURIComponent(continuation[1])
        if (store.getCard(cardId)?.status === 'build') {
          store.transitionCard(cardId, 'plan', 'agent', 'continuation failed; retry')
          // continueCard's failure path records a dispatch failure; after 3
          // tries that latches stalled=true. A synthetic rollback is not a
          // real dispatch failure, so clear the counter here too — otherwise
          // the retry this rollback promises is refused at assertDispatchable.
          // Only this approve-plan rollback clears it; engine deps.continue
          // failures keep their stall protection.
          store.clearDispatchFailures(cardId)
          store.recordEvent({
            type: 'approve-plan-continue-failed', scope: 'card', targetId: cardId,
            actor: 'human', decision: 'failed', note: message,
          })
          sendJson(res, 400, { error: message || 'continuation failed', retryable: true })
          return
        }
        sendJson(res, 400, { error: message || 'continuation failed' })
      }
      return
    }

    // P2a: independent review session (read-only, reviewMode wired to the
    // real host sandbox reader) and re-review reuse. Neither touches the
    // builder's sessionId nor the card status.
    const reviewDispatch = /^\/cards\/([^/?]+)\/review-dispatch(?:\?.*)?$/.exec(route)
    if (method === 'POST' && reviewDispatch !== null) {
      try {
        const port = createHostPort({ ctx })
        const result = await dispatchReview({
          store, cardId: decodeURIComponent(reviewDispatch[1]), port,
          locale: localeFromContext(ctx, store),
          note: typeof body.note === 'string' ? body.note : undefined,
          presetId: typeof config.reviewPresetId === 'string' ? config.reviewPresetId : undefined,
        })
        sendJson(res, 200, result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[dsh-factory] review dispatch failed:', message)
        sendJson(res, 400, { error: message || 'review dispatch failed' })
      }
      return
    }
    const prReviewDispatch = /^\/cards\/([^/?]+)\/pr-review-dispatch(?:\?.*)?$/.exec(route)
    if (method === 'POST' && prReviewDispatch !== null) {
      try {
        store.clearPrReviewIdle(decodeURIComponent(prReviewDispatch[1]))
        const port = createHostPort({ ctx })
        const result = await dispatchPrReview({
          store, cardId: decodeURIComponent(prReviewDispatch[1]), port,
          locale: localeFromContext(ctx, store),
          note: typeof body.note === 'string' ? body.note : undefined,
          presetId: typeof config.reviewPresetId === 'string' ? config.reviewPresetId : undefined,
        })
        sendJson(res, 200, result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[dsh-factory] pr-review dispatch failed:', message)
        sendJson(res, 400, { error: message || 'pr-review dispatch failed' })
      }
      return
    }
    const reviewContinue = /^\/cards\/([^/?]+)\/review-continue(?:\?.*)?$/.exec(route)
    if (method === 'POST' && reviewContinue !== null) {
      try {
        const port = createHostPort({ ctx })
        const result = await followupReview({
          store, cardId: decodeURIComponent(reviewContinue[1]), port,
          locale: localeFromContext(ctx, store),
          note: typeof body.note === 'string' ? body.note : undefined,
          presetId: typeof config.reviewPresetId === 'string' ? config.reviewPresetId : undefined,
        })
        sendJson(res, 200, result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[dsh-factory] review continuation failed:', message)
        sendJson(res, 400, { error: message || 'review continuation failed' })
      }
      return
    }

    // AC8: a human's review→build decision must immediately continue the ORIGINAL
    // builder session. `continueCard` reads card.sessionId only, never the
    // reviewer id, so the two sessions stay separate.
    const reviewToBuild = /^\/cards\/([^/?]+)\/transition(?:\?.*)?$/.exec(route)
    if (method === 'POST' && reviewToBuild !== null && body.to === 'build') {
      const cardId = decodeURIComponent(reviewToBuild[1])
      const current = store.getCard(cardId)
      if (current?.status === 'pr-review') {
        try {
          assertNoActiveSession({ card: current, isSessionActive, action: '「退回构建」' })
          const note = typeof body.note === 'string' ? body.note.trim() : ''
          if (note === '') throw new Error('退回构建必须填写修改意见；builder 需要据此修改')
          const card = store.transitionCard(cardId, 'build', 'human', note)
          let continued = null
          try {
            continued = await continueCard({ store, cardId, port: createHostPort({ ctx }), locale: localeFromContext(ctx, store) })
          } catch (continueError) {
            // The human decision is already valid; make the stranded build visible.
            store.recordEvent({
              type: 'review-build-continue-failed', scope: 'card', targetId: cardId,
              actor: 'human', decision: 'failed',
              note: continueError instanceof Error ? continueError.message : String(continueError),
            })
          }
          sendJson(res, 200, { card, continued })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          sendJson(res, 400, { error: message || 'transition failed' })
        }
        return
      }
    }

    // P2b A: mandatory-note human returns. These are dedicated routes so the
    // UI button cannot forget the note and no generic transition can forge the
    // decision record. State edges and actors stay exactly as state.js defines.
    const requireNote = (value) => {
      const text = typeof value === 'string' ? value.trim() : ''
      if (text === '') throw new Error('修改意见必填，不能为空')
      return text
    }
    const returnToBuild = /^\/cards\/([^/?]+)\/return-to-build(?:\?.*)?$/.exec(route)
    if (method === 'POST' && returnToBuild !== null) {
      const cardId = decodeURIComponent(returnToBuild[1])
      try {
        const text = requireNote(body.note)
        assertNoActiveSession({ card: store.getCard(cardId), isSessionActive, action: '「退回构建」' })
        const card = store.transitionCard(cardId, 'build', 'human', text)
        let continued = null
        try {
          continued = await continueCard({ store, cardId, port: createHostPort({ ctx }), locale: localeFromContext(ctx, store), message: text })
        } catch (continueError) {
          store.recordEvent({
            type: 'return-to-build-continue-failed', scope: 'card', targetId: cardId,
            actor: 'human', decision: 'failed',
            note: continueError instanceof Error ? continueError.message : String(continueError),
          })
        }
        sendJson(res, 200, { card, continued })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    const returnToPlan = /^\/cards\/([^/?]+)\/return-to-plan(?:\?.*)?$/.exec(route)
    if (method === 'POST' && returnToPlan !== null) {
      const cardId = decodeURIComponent(returnToPlan[1])
      const beforeCard = store.getCard(cardId)
      const tier = beforeCard?.projectId ? store.getProject(beforeCard.projectId)?.autonomy : undefined
      const text = typeof body.note === 'string' ? body.note.trim() : ''
      if (text === '') { sendJson(res, 400, { error: '修改意见必填，不能为空' }); return }
      const before = store.getCard(cardId)
      if (before?.status !== 'plan') { sendJson(res, 400, { error: `退回修改计划仅 Plan-review 可执行（当前 ${before?.status ?? '未知'}）` }); return }
      try {
        assertNoActiveSession({ card: before, isSessionActive, action: '「退回修改计划」' })
        const feedback = store.getCard(cardId).history.filter((h) => h && h.type === 'plan-feedback').at(-1) ?? null
        const takenOver = body.takeOver === undefined
          ? ['machine-approve', 'auto-delivery'].includes(tier)
          : body.takeOver === true
        if (takenOver) store.takeOverCard(cardId, 'human')
        store.transitionCard(cardId, 'plan', 'human', text)
        const card = store.getCard(cardId)
        try {
          const continued = await continueCard({
            store, cardId, port: createHostPort({ ctx }), locale: localeFromContext(ctx, store), message: text,
          })
          sendJson(res, 200, { feedback, card, takenOver, continued })
        } catch (continueError) {
          // AC24: a failed continuation must leave the card retryable in
          // plan-review. plan→plan-review is an agent-only edge, so this is a
          // deliberate synthetic rollback, not a permission widening.
          store.transitionCard(cardId, 'plan', 'agent', 'continuation failed; retry')
          const message = continueError instanceof Error ? continueError.message : String(continueError)
          store.recordEvent({
            type: 'return-to-plan-continue-failed', scope: 'card', targetId: cardId,
            actor: 'human', decision: 'failed', note: message,
          })
          sendJson(res, 400, { error: message, retryable: true })
        }
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    // P2b B: supply missing information and re-dispatch a returned Inbox card.
    // Dispatch FIRST (while needsHumanInfo is still true) so a failure cannot
    // clear the gate; success clears it and records the resupply.
    const resupply = /^\/cards\/([^/?]+)\/resupply(?:\?.*)?$/.exec(route)
    if (method === 'POST' && resupply !== null) {
      const cardId = decodeURIComponent(resupply[1])
      try {
        const text = requireNote(body.note ?? body.text)
        const card = store.getCard(cardId)
        if (card?.status !== 'inbox') throw new Error(`补充信息仅用于 Inbox 卡片（当前 ${card?.status ?? '未知'}）`)
        if (card.needsHumanInfo !== true) throw new Error('该卡不处于待补充信息状态')
        const lastReturn = [...card.history].reverse().find((entry) => entry && entry.type === 'triage-return')
        const extra = [
          '人工补充信息（新会话必须据此继续，不要重复追问已说明的信息）：',
          text,
          `上次退回原因：${typeof lastReturn?.reason === 'string' && lastReturn.reason !== '' ? lastReturn.reason : '（无）'}`,
        ].join('\n')
        const dispatched = await dispatchCard({
          store, cardId, port: createHostPort({ ctx }), locale: localeFromContext(ctx, store), firstMessageExtra: extra,
        })
        const updated = store.resupplyInbox(cardId, { text })
        sendJson(res, 200, { dispatched, card: updated })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error), retryable: true })
      }
      return
    }

    // Draft-only endpoints. They never authorize or write git/gh: the UI opens
    // its editor from these, then posts the edited text to the existing write
    // routes. The same session/verdict gates as the write routes are enforced
    // here so a direct request cannot generate around the board's write guard.
    const draftCommit = /^\/cards\/([^/?]+)\/draft-commit(?:\?.*)?$/.exec(route)
    if (method === 'POST' && draftCommit !== null) {
      try {
        const cardId = decodeURIComponent(draftCommit[1])
        const card = store.getCard(cardId)
        if (card === undefined || card === null) throw new Error(`卡片不存在：${cardId}`)
        assertManualWritesAllowed({ card, project: card.projectId ? store.getProject(card.projectId) : undefined, action: '生成提交信息' })
        assertNoActiveSession({ card, isSessionActive, action: '生成提交信息' })
        assertApprovedVerdict({ card, action: '生成提交信息' })
        const fallback = card.commitSha ? 'factory: address review feedback' : 'factory: implement card'
        const draft = await deliveryCopy.commit({ card, fallback, mode: 'worktree' })
        sendJson(res, 200, { message: draft.text, generated: draft.generated, reason: draft.reason })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    const draftPr = /^\/cards\/([^/?]+)\/draft-pr(?:\?.*)?$/.exec(route)
    if (method === 'POST' && draftPr !== null) {
      try {
        const cardId = decodeURIComponent(draftPr[1])
        const card = store.getCard(cardId)
        if (card === undefined || card === null) throw new Error(`卡片不存在：${cardId}`)
        assertManualWritesAllowed({ card, project: card.projectId ? store.getProject(card.projectId) : undefined, action: '生成 PR 文案' })
        assertNoActiveSession({ card, isSessionActive, action: '生成 PR 文案' })
        assertApprovedVerdict({ card, action: '生成 PR 文案' })
        if (!card.commitSha || card.prUrl) throw new Error('仅首次建 PR 可生成 PR 文案')
        const draft = await deliveryCopy.pr({ card, fallbackTitle: card.title, fallbackBody: card.body || '', mode: 'branch' })
        sendJson(res, 200, { ...draft, bodyEmpty: (card.body || '').trim() === '' })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    // P2b C: second commit + push to the SAME draft PR, each with its own
    // single-use human authorization. createPrForCard still refuses existing PRs.
    const commitExisting = /^\/cards\/([^/?]+)\/commit-existing(?:\?.*)?$/.exec(route)
    if (method === 'POST' && commitExisting !== null) {
      try {
        const cardId = decodeURIComponent(commitExisting[1])
        const card = store.getCard(cardId)
        assertManualWritesAllowed({ card, project: card?.projectId ? store.getProject(card.projectId) : undefined, action: '回炉提交' })
        const port = createGitPort()
        // Human git writes are gated on an approved review verdict; L4's
        // separate delivery path has its own gate and never reaches here.
        const result = await commitForExistingPr({
          store, cardId, port, message: body.message,
          isSessionActive, requireApprovedVerdict: true,
        })
        sendJson(res, 200, result)
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    const pushExisting = /^\/cards\/([^/?]+)\/push-existing(?:\?.*)?$/.exec(route)
    if (method === 'POST' && pushExisting !== null) {
      try {
        const cardId = decodeURIComponent(pushExisting[1])
        const card = store.getCard(cardId)
        const project = card?.projectId ? store.getProject(card.projectId) : undefined
        assertManualWritesAllowed({ card, project, action: '推送更新草稿 PR' })
        const decision = await resolveIdentity(project)
        const result = await pushExistingCard({ store, cardId, port: createGitPort(decision.git), isSessionActive, requireApprovedVerdict: true })
        sendJson(res, 200, result)
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    // Authorized git execution. The gate is enforced inside commitCard /
    // createPrForCard: without a Review-time human authorization they throw
    // before touching git. `message`/`title`/`body` are optional overrides.
    const commitMatch = /^\/cards\/([^/?]+)\/commit(?:\?.*)?$/.exec(route)
    if (method === 'POST' && commitMatch !== null) {
      try {
        const cardId = decodeURIComponent(commitMatch[1])
        const card = store.getCard(cardId)
        assertManualWritesAllowed({ card, project: card?.projectId ? store.getProject(card.projectId) : undefined, action: '确认提交' })
        const port = createGitPort()
        const result = await commitCard({ store, cardId, port, message: body.message, isSessionActive, requireApprovedVerdict: true })
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
        assertManualWritesAllowed({ card, project, action: '推送分支并创建 PR' })
        const decision = await resolveIdentity(project)
        const port = createGitPort(decision.git)
        const result = await createPrForCard({ store, cardId, port, title: body.title, body: body.body, isSessionActive, requireApprovedVerdict: true })
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
