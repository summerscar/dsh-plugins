/**
 * dsh-factory — GitHub identity HTTP surface (backend of the identity card and
 * the authorization bridge). The React/zero-build UI is a separate concern; this
 * module only produces data and drives the host seam, and stays Host-only.
 *
 * Everything is a pure function or a small in-memory factory with injected seams
 * (fetch, gh exec, abort), so QA can exercise the whole surface offline. No token
 * value is EVER returned to a caller: identity cards carry only source/login/state,
 * and permission probes report only ok/reason.
 */
import { spawnSync } from 'node:child_process'

import { IDENTITY_SOURCE, identityView, repoCredentialSegment, SHARED_KEY_ID, OAUTH_KEY_ID, credentialKeyOf } from './identity.js'
import { storeUserToken, deleteUserToken } from './github-oauth.js'
import { probeEnv, probeGhLogin as realProbeGhLogin } from './git-exec.js'

/**
 * The identity card's read-only data: binding relationship + resolved identity.
 * `decision` comes straight from decideIdentity (which may hold a token); the
 * view produced here is token-free and safe to serialise (PGH-5/6/11).
 */
export function identityCardFor({ project, decision } = {}) {
  const rootPath = typeof project?.rootPath === 'string' ? project.rootPath : null
  const issueRepo = typeof project?.issueRepo === 'string' ? project.issueRepo : null
  return {
    binding: {
      rootPath,
      issueRepo,
      bound: rootPath !== null && rootPath !== '' && issueRepo !== null && issueRepo !== '',
    },
    identity: identityView(decision),
  }
}

/**
 * Permission check — a user-triggered, READ-ONLY probe of "can this identity
 * reach this repository". Never runs automatically per tick (no auto tier switch).
 * `probeImpl` is injected so it is offline-testable; the default runs in Host.
 * Returns { status: 'ok'|'insufficient'|'not-connected', reason }. No token leaks.
 */
export async function probePermission({
  decision, repo, env = process.env, fetchImpl = globalThis.fetch, ghExec = spawnSync, probeImpl,
} = {}) {
  if (!decision || decision.source === IDENTITY_SOURCE.NONE) {
    return { status: 'not-connected', reason: '还没有可用于这个仓库的 GitHub 账号' }
  }
  if (typeof repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repo.trim())) {
    return { status: 'insufficient', reason: '仓库标识格式不对，应形如 owner/name' }
  }
  const run = typeof probeImpl === 'function'
    ? probeImpl
    : defaultPermissionProbe({ fetchImpl, ghExec })
  try {
    const result = await run({ decision, repo: repo.trim(), env })
    return result?.ok === true
      ? { status: 'ok', reason: null }
      : { status: 'insufficient', reason: result?.reason || '这个账号没有访问该仓库的权限' }
  } catch (error) {
    return { status: 'insufficient', reason: error instanceof Error ? error.message : String(error) }
  }
}

function defaultPermissionProbe({ fetchImpl, ghExec }) {
  return async ({ decision, repo, env }) => {
    // Token-backed tiers call the REST API with the winner's token. The token
    // stays inside this Host-side closure — only ok/reason escapes.
    if (typeof decision.token === 'string' && decision.token !== '') {
      const response = await fetchImpl(`https://api.github.com/repos/${repo}`, {
        method: 'GET',
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${decision.token}`, 'user-agent': 'dsh-factory' },
      })
      if (response.status === 200) return { ok: true }
      let reason = `没有访问该仓库的权限（HTTP ${response.status}）`
      try {
        const body = await response.json()
        if (typeof body?.message === 'string' && body.message !== '') reason = body.message
      } catch { /* keep the status-based reason */ }
      return { ok: false, reason }
    }
    // gh CLI tier: use the real login (env tokens stripped so a low-scope PAT
    // cannot shadow it), identical to the probe used during decision.
    if (decision.source === IDENTITY_SOURCE.GH_CLI) {
      const result = ghExec('gh', ['api', `repos/${repo}`, '--silent'], { encoding: 'utf8', env: probeEnv(env) })
      if (result?.error) throw result.error
      if (result?.status === 0) return { ok: true }
      return { ok: false, reason: (result?.stderr || '').trim() || '没有访问该仓库的权限' }
    }
    // env-token tier: the inherited token is already in env; let gh use it.
    const envResult = ghExec('gh', ['api', `repos/${repo}`, '--silent'], { encoding: 'utf8', env: { ...env } })
    if (envResult?.error) throw envResult.error
    if (envResult?.status === 0) return { ok: true }
    return { ok: false, reason: (envResult?.stderr || '').trim() || '没有访问该仓库的权限' }
  }
}

/**
 * Authorization bridge (pitfalls ③④): `ctx.authorization.begin()` needs an
 * interaction that can show notices and collect a prompt answer, but the zero-
 * build browser can only do request/response. This factory keeps one in-memory
 * session per attempt: `begin()` starts the flow with an interaction that writes
 * into the session; the browser polls `read()` and posts `answer()`/`cancel()`.
 *
 * A session lives only in this process — a reload drops it (documented UX: keep
 * the page open). That is the seam's own constraint, not a bug we can fix here.
 */
export function createAuthorizationBridge({ authorization, key } = {}) {
  const sessions = new Map()
  let seq = 0

  function requireService() {
    if (authorization === undefined || authorization === null || typeof authorization.begin !== 'function') {
      throw new Error('授权服务不可用，暂时无法连接 GitHub')
    }
  }

  function begin() {
    requireService()
    // One attempt per key at a time; refuse early with a readable reason rather
    // than surfacing the seam's ALREADY_IN_FLIGHT as a generic failure.
    let inFlight = false
    try { inFlight = authorization.describe?.(key)?.inFlight === true } catch { /* older seam */ }
    if (inFlight) throw new Error('已有一个连接正在进行，请等它结束')

    const sessionId = `connect-${++seq}-${Date.now().toString(36)}`
    const session = {
      sessionId,
      status: 'running',
      notices: [],
      prompt: null,
      result: null,
      error: null,
      _resolve: null,
      _reject: null,
    }
    sessions.set(sessionId, session)

    const interaction = {
      notify(notice) {
        const clean = { message: typeof notice?.message === 'string' ? notice.message : '' }
        if (typeof notice?.url === 'string') clean.url = notice.url
        if (typeof notice?.code === 'string') clean.code = notice.code
        session.notices.push(clean)
      },
      prompt(prompt) {
        return new Promise((resolve, reject) => {
          const clean = { kind: prompt?.kind || 'text', message: typeof prompt?.message === 'string' ? prompt.message : '' }
          if (prompt?.placeholder) clean.placeholder = prompt.placeholder
          if (Array.isArray(prompt?.options)) {
            clean.options = prompt.options.map((option) => ({ id: option.id, label: option.label }))
          }
          session.prompt = clean
          session._resolve = resolve
          session._reject = reject
        })
      },
    }

    void authorization.begin({ key, interaction }).then((outcome) => {
      session.status = outcome?.status === 'authorized' ? 'authorized' : 'cancelled'
      session.result = session.status
    }).catch((error) => {
      // A declined prompt / withdrawn attempt is a normal 'cancelled' outcome,
      // not a failure — the seam already settles those as { status:'cancelled' },
      // so anything reaching here is a real breakage.
      session.status = 'failed'
      session.error = error instanceof Error ? error.message : String(error)
    }).finally(() => {
      session.prompt = null
      session._resolve = null
      session._reject = null
    })

    return { sessionId }
  }

  function read(sessionId) {
    const session = sessions.get(sessionId)
    if (session === undefined) return null
    return {
      sessionId: session.sessionId,
      status: session.status,
      notices: [...session.notices],
      prompt: session.prompt ? { ...session.prompt } : null,
      result: session.result,
      error: session.error,
    }
  }

  function answer(sessionId, value) {
    const session = sessions.get(sessionId)
    if (session === undefined || typeof session._resolve !== 'function') {
      throw new Error('这个连接当前没有等待输入的问题')
    }
    const resolve = session._resolve
    session.prompt = null
    session._resolve = null
    session._reject = null
    resolve(typeof value === 'string' ? value : String(value ?? ''))
    return { ok: true }
  }

  function cancel(sessionId) {
    const session = sessions.get(sessionId)
    if (session === undefined) return { ok: true }
    // Withdrawing through the seam aborts the attempt immediately and settles it
    // as 'cancelled', even if the flow never reacted to the signal (seam contract).
    try { authorization.cancel?.(key) } catch { /* best effort */ }
    if (typeof session._reject !== 'function') return { ok: true }
    const reject = session._reject
    session.prompt = null
    session._resolve = null
    session._reject = null
    reject(new Error('cancelled by user'))
    return { ok: true }
  }

  return { begin, read, answer, cancel }
}

/**
 * Write a user-supplied token to the chosen scope. The scope choice (global vs
 * per-repo) is the ONLY place the "all projects / this repo only" switch lives,
 * and it applies ONLY to gh token — gh CLI / OAuth have no such switch (PGH-18).
 * Returns no token, only the verified login + where it was stored.
 */
export async function writeGithubToken({ store, credentials, token, scope, projectId, fetchImpl, signal } = {}) {
  if (scope === 'global') {
    const { login } = await storeUserToken({ credentials, id: SHARED_KEY_ID, token, type: 'shared-token-global', fetchImpl, signal })
    return { scope: 'global', keyId: SHARED_KEY_ID, login }
  }
  if (scope === 'project') {
    const project = store.getProject(projectId)
    if (project === undefined || project === null) throw new Error(`项目不存在：${projectId}`)
    const id = repoCredentialSegment(project)
    if (id === null) throw new Error('这个项目没有合法的凭据标识')
    const { login } = await storeUserToken({ credentials, id, token, type: 'repo-credential', fetchImpl, signal })
    return { scope: 'project', projectId, keyId: id, login }
  }
  throw new Error('作用域必须是 global（所有项目共用）或 project（只给这个仓库）之一')
}

/** Remove a stored token for a scope (logout / re-scope). */
export async function removeGithubToken({ store, credentials, scope, projectId } = {}) {
  if (scope === 'global') {
    await deleteUserToken({ credentials, id: SHARED_KEY_ID })
    return { scope: 'global', keyId: SHARED_KEY_ID }
  }
  if (scope === 'project') {
    const project = store.getProject(projectId)
    if (project === undefined || project === null) throw new Error(`项目不存在：${projectId}`)
    const id = repoCredentialSegment(project)
    if (id === null) throw new Error('这个项目没有合法的凭据标识')
    await deleteUserToken({ credentials, id })
    return { scope: 'project', projectId, keyId: id }
  }
  throw new Error('作用域必须是 global 或 project')
}

/**
 * OAuth 撤销 = LOCAL disconnect only (PGH-19). `deleteRecord` is idempotent — a
 * missing record is a no-op — and does NOT notify the issuer. We can NOT revoke
 * the remote grant (that endpoint needs client_secret, which this scheme never
 * has), so the response carries HONEST copy + a deep link for the human to do it
 * on GitHub's website. The UI must never claim "we revoked it for you".
 */
export async function disconnectOAuth({ credentials, clientId, ghExec = spawnSync, env = process.env } = {}) {
  if (credentials === undefined || credentials === null || typeof credentials.deleteRecord !== 'function') {
    throw new Error('凭据服务不可用，无法断开连接')
  }
  await credentials.deleteRecord(credentialKeyOf(OAUTH_KEY_ID))
  const cid = typeof clientId === 'string' ? clientId.trim() : ''
  return {
    // Honest facts for the UI to render verbatim (copy keys live in i18n).
    disconnected: true,
    revokeUrl: cid !== '' ? `https://github.com/settings/connections/applications/${encodeURIComponent(cid)}` : 'https://github.com/settings/applications',
  }
}

/**
 * OAuth connection state for the global account-management block (PGH-19/20).
 * Read-only: describes the stored record WITHOUT ever returning the token, and
 * reports whether a connect flow is currently in flight so the UI can disable
 * the button (one attempt per key, pitfall ④).
 */
export async function oauthState({ credentials, authorization, clientId } = {}) {
  let configured = false
  if (credentials !== undefined && credentials !== null && typeof credentials.describeRecord === 'function') {
    try { configured = (await credentials.describeRecord(credentialKeyOf(OAUTH_KEY_ID)))?.configured === true } catch { configured = false }
  }
  let inFlight = false
  if (authorization !== undefined && authorization !== null && typeof authorization.describe === 'function') {
    try { inFlight = authorization.describe(credentialKeyOf(OAUTH_KEY_ID))?.inFlight === true } catch { inFlight = false }
  }
  // A client_id is required to run the device flow; report it so the UI can
  // guide the user to fill it in before connecting. It is NOT a secret.
  const hasAppId = typeof clientId === 'string' && clientId.trim() !== ''
  return { connected: configured, inFlight, hasAppId }
}

/**
 * gh CLI login state for the global block (PGH-21). This is a MACHINE-level fact
 * ("is this computer signed in?"), distinct from the per-repo identity card's
 * "电脑上已登录" source. Read-only: never creates/deletes a record or runs login.
 * Both logged-in and logged-out are reported (the UI shows the row either way).
 */
export function ghCliState({ env = process.env, probeGhLogin = realProbeGhLogin, ghExec = spawnSync, ghApi = true } = {}) {
  let loggedIn = false
  try { loggedIn = probeGhLogin(env) === true } catch { loggedIn = false }
  let login = null
  // Best-effort account name via `gh api user` with the PROBE env (ambient tokens
  // stripped) — read-only. Failure to resolve the name must not flip the state.
  if (loggedIn && ghApi === true) {
    try {
      const result = ghExec('gh', ['api', 'user', '--jq', '.login', '--silent'], { encoding: 'utf8', env: probeEnv(env) })
      if (result?.status === 0 && typeof result.stdout === 'string') {
        const name = result.stdout.trim()
        if (name !== '') login = name
      }
    } catch { /* login stays null — state still 'logged in' */ }
  }
  return { loggedIn, login }
}
