/**
 * dsh-factory — GitHub credential acquisition (A scheme, PRD §3.4).
 *
 * Two ways a GitHub identity gets STORED as a record, both Host-only and both
 * injected for offline testing:
 *
 *   1. Global OAuth (oauth-global): register an authorization flow keyed by the
 *      credential record it writes. The flow runs GitHub's device flow — request
 *      a device code, show the human a URL + code, poll for the access token,
 *      verify the login via /user, then commit the grant. The seam only reports
 *      `authorized` once a record was actually committed during the attempt.
 *   2. User-supplied token (gh token): a shared (token-global) or per-repo record
 *      written after verifying the token against /user. NO scope switch lives in
 *      this module — the caller decides which id to write; this is just storage.
 *
 * Pitfalls handled here:
 *   ⑦ mixed accounts — /user is called before any write, so `login` is the real
 *      account behind the token, never a guess from the token string.
 *   ⑧ expiring OAuth tokens — NOT refreshed in this phase; a phase-two concern,
 *      recorded as a known gap. The payload carries scope so a future refresh
 *      has what it needs.
 *
 * Secrets discipline: the token is only ever passed to `session.commit` / the
 * credential store. It is never logged, returned to the UI, or written anywhere
 * else. `client_id` is not a secret and comes from settings, not a credential.
 */
import { OAUTH_KEY_ID, SHARED_KEY_ID, credentialKeyOf } from './identity.js'

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const USER_URL = 'https://api.github.com/user'
const DEFAULT_SCOPE = 'repo'

const sleepDefault = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  if (signal) {
    if (signal.aborted) { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); return }
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')) }, { once: true })
  }
})

async function readJson(response) {
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = undefined }
  if (body === undefined || body === null || typeof body !== 'object') {
    throw new Error(`GitHub 返回了无法解析的响应（HTTP ${response.status}）`)
  }
  return { status: response.status, body }
}

function form(fields) {
  return new URLSearchParams(fields).toString()
}

function githubHeaders() {
  return { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'dsh-factory' }
}

/** POST /login/device/code → { deviceCode, userCode, verificationUri, interval, expiresIn }. */
export async function requestDeviceCode({ clientId, fetchImpl = globalThis.fetch, scope = DEFAULT_SCOPE, signal } = {}) {
  if (typeof clientId !== 'string' || clientId.trim() === '') throw new Error('尚未配置 GitHub 连接所用的应用标识')
  const response = await fetchImpl(DEVICE_CODE_URL, {
    method: 'POST', headers: githubHeaders(), signal,
    body: form({ client_id: clientId.trim(), scope }),
  })
  const { body, status } = await readJson(response)
  if (status >= 400 || typeof body.device_code !== 'string' || typeof body.user_code !== 'string') {
    throw new Error(body.error_description || body.error || `请求授权码失败（HTTP ${status}）`)
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: typeof body.verification_uri === 'string' ? body.verification_uri : 'https://github.com/login/device',
    interval: Number.isInteger(body.interval) && body.interval > 0 ? body.interval : 5,
    expiresIn: Number.isFinite(body.expires_in) ? body.expires_in : null,
  }
}

/**
 * Poll /login/oauth/access_token until the human authorises, the code expires,
 * or the attempt is cancelled. Honours `interval` and `slow_down` (pitfall ④).
 * Returns the access token string.
 */
export async function pollDeviceToken({
  deviceCode, clientId, fetchImpl = globalThis.fetch, interval = 5,
  signal, sleep = sleepDefault, now = () => Date.now(), timeoutMs = 15 * 60 * 1000,
} = {}) {
  if (typeof deviceCode !== 'string' || deviceCode === '') throw new Error('pollDeviceToken 需要 deviceCode')
  const started = now()
  let delayMs = Math.max(1, interval) * 1000
  for (;;) {
    if (signal?.aborted === true) throw signal.reason ?? new Error('aborted')
    if (now() - started >= timeoutMs) throw new Error('授权码已过期，请重新开始')
    await sleep(delayMs, signal)
    if (signal?.aborted === true) throw signal.reason ?? new Error('aborted')
    const response = await fetchImpl(ACCESS_TOKEN_URL, {
      method: 'POST', headers: githubHeaders(), signal,
      body: form({ client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
    })
    const { body, status } = await readJson(response)
    if (typeof body.access_token === 'string' && body.access_token !== '') return body.access_token
    switch (body.error) {
      case 'authorization_pending': continue
      case 'slow_down': delayMs += 5000; continue
      case 'expired_token': throw new Error('授权码已过期，请重新开始')
      case 'access_denied': throw new Error('你取消了授权')
      default:
        throw new Error(body.error_description || body.error || `换取结果失败（HTTP ${status}）`)
    }
  }
}

/** GET /user with a bearer token → the real login (pitfall ⑦). */
export async function verifyLogin({ token, fetchImpl = globalThis.fetch, signal } = {}) {
  if (typeof token !== 'string' || token === '') throw new Error('verifyLogin 需要 token')
  const response = await fetchImpl(USER_URL, {
    method: 'GET', signal,
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'dsh-factory' },
  })
  const { body, status } = await readJson(response)
  if (status >= 400 || typeof body.login !== 'string' || body.login === '') {
    throw new Error(body.message || `确认账号失败（HTTP ${status}）：这个账号可能没有所需权限`)
  }
  return body.login
}

/**
 * Register the global-OAuth authorization flow on the host seam. Returns the
 * dispose function. `getClientId()` is read fresh at attempt time (settings are
 * HTTP-writable and must take effect without reload).
 *
 * The flow uses session.notify for the URL+code and session.prompt for a single
 * "I've finished" acknowledgement, then polls for the token. This is the zero-
 * build bridge story: the HTTP route supplies an interaction that forwards these
 * to the browser (notice queue + pending prompt), and the browser answers them.
 */
export function registerGithubOAuthFlow({ authorization, getClientId, fetchImpl = globalThis.fetch, sleep, key = credentialKeyOf(OAUTH_KEY_ID) } = {}) {
  if (authorization === undefined || authorization === null || typeof authorization.registerFlow !== 'function') {
    return () => {}
  }
  return authorization.registerFlow({
    key,
    label: '连接 GitHub',
    methods: [{ id: 'device', label: '在网页上登录' }],
    async run(session) {
      const clientId = typeof getClientId === 'function' ? getClientId() : ''
      const issued = await requestDeviceCode({ clientId, fetchImpl, signal: session.signal })
      session.notify({
        message: '打开下面的网址，登录后把看到的码填进去，然后回来点“我完成了”。',
        url: issued.verificationUri,
        code: issued.userCode,
      })
      await session.prompt({
        kind: 'select',
        message: '在上面那个网页完成授权后，点这里继续。',
        options: [
          { id: 'done', label: '我完成了，继续' },
          { id: 'cancel', label: '取消' },
        ],
      }).then((answer) => {
        if (answer === 'cancel') throw new Error('你取消了授权')
      })
      const token = await pollDeviceToken({
        deviceCode: issued.deviceCode, clientId, fetchImpl,
        interval: issued.interval, signal: session.signal, sleep,
      })
      const login = await verifyLogin({ token, fetchImpl, signal: session.signal })
      // commit (not a raw credentials write) so the authorization seam witnesses
      // the record landing inside THIS attempt and reports a truthful `authorized`.
      await session.commit({
        kind: 'grant',
        payload: { token, login, type: 'oauth-device-flow', scope: DEFAULT_SCOPE },
      })
    },
  })
}

/**
 * Store a user-supplied github token after verifying its login. Used for both
 * the shared (token-global) and per-repo records; the caller picks the id.
 * Returns the verified login. The token is written ONLY to the credential store
 * and is never returned (PGH-5 / no echo).
 */
export async function storeUserToken({ credentials, id, token, type, fetchImpl = globalThis.fetch, signal } = {}) {
  if (credentials === undefined || credentials === null || typeof credentials.modifyRecord !== 'function') {
    throw new Error('凭据服务不可用，无法保存 GitHub 账号')
  }
  if (typeof token !== 'string' || token.trim() === '') throw new Error('请提供一个 GitHub 凭据值')
  if (!isId(id)) throw new TypeError(`非法的凭据 id：${String(id)}`)
  const trimmed = token.trim()
  const login = await verifyLogin({ token: trimmed, fetchImpl, signal })
  await credentials.modifyRecord(credentialKeyOf(id), () => Promise.resolve({
    kind: 'grant',
    payload: { token: trimmed, login, type },
  }))
  return { login }
}

/** Remove a stored github token record (logout / re-scope). */
export async function deleteUserToken({ credentials, id } = {}) {
  if (credentials === undefined || credentials === null || typeof credentials.deleteRecord !== 'function') {
    throw new Error('凭据服务不可用，无法移除 GitHub 账号')
  }
  if (!isId(id)) throw new TypeError(`非法的凭据 id：${String(id)}`)
  await credentials.deleteRecord(credentialKeyOf(id))
  return { id }
}

function isId(id) {
  return typeof id === 'string' && /^[a-z][a-z0-9-]*$/.test(id)
}

export { OAUTH_KEY_ID, SHARED_KEY_ID }
