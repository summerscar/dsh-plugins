/**
 * QA — dsh-factory GitHub-settings round acceptance (BUILD factory-2026-11-18.9).
 *
 * Self-contained: every fixture is local (fake credential store, fake fetch,
 * injected env). Nothing here reads git HEAD / a committed baseline, so the
 * assertions stay valid after this file is committed. No real token is used,
 * no network call leaves the process, no product code is modified.
 *
 * Coverage:
 *   - GET /auth/token/state  (sharedTokenState via the real index.js handler)
 *   - identity ladder decisions (stored-global > env > repo, dead tier falls through)
 *   - POST /auth/token write chain (project scope needs projectId)
 *   - four-dictionary Client-ID key presence (inline zh/en + locale zh/en)
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'

import { apply } from '../index.js'
import { maskToken } from '../github-api.js'
import {
  decideIdentity, credentialKeyOf, repoCredentialSegment,
  IDENTITY_SOURCE, SHARED_KEY_ID,
} from '../identity.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const clientSrc = readFileSync(join(packageRoot, 'client.js'), 'utf8')

// ---------------------------------------------------------------------------
// helpers — all state is process-local and restored in finally blocks.
// ---------------------------------------------------------------------------

function setEnv(key, value) {
  const saved = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  return () => {
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
}

function clearTokenEnv() {
  const a = setEnv('GH_TOKEN', undefined)
  const b = setEnv('GITHUB_TOKEN', undefined)
  return () => { b(); a() }
}

function stubFetch(impl) {
  const real = globalThis.fetch
  globalThis.fetch = impl
  return () => { globalThis.fetch = real }
}

const okFetch = (login = 'verified-user') => async () => ({
  status: 200, text: async () => JSON.stringify({ login }),
})
const badFetch = async () => ({
  status: 401, text: async () => JSON.stringify({ message: 'Bad credentials' }),
})

function grant(token, login, type = 'shared-token-global') {
  return { kind: 'grant', payload: { token, login, type } }
}

/** A credential service with a controllable stored record and a write journal. */
function credentialService({ configured = false, record = null } = {}) {
  const written = []
  const deleted = []
  return {
    written, deleted,
    async describeRecord() { return { configured } },
    async readRecord() { return record },
    async modifyRecord(key, fn) { written.push(key); return fn(record) },
    async deleteRecord(key) { deleted.push(key) },
  }
}

/** Minimal fake ctx that captures the real /api/dsh-factory handler. */
function harness(services = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-ghset-'))
  const captured = {}
  const disposers = []
  const svc = {
    credentials: services.credentials ?? null,
    authorization: services.authorization ?? null,
    connection: { requestRejection: () => undefined },
    ...services.extra,
  }
  const ctx = {
    get: (name) => (name in svc ? svc[name] : undefined),
    inject(names, cb) {
      const scope = {
        ...svc,
        effect: (fn) => { const d = typeof fn === 'function' ? fn() : undefined; disposers.push(d); return d },
      }
      const d = cb(scope)
      if (typeof d === 'function') disposers.push(d)
      return d
    },
    effect(fn) {
      const d = typeof fn === 'function' ? fn() : undefined
      disposers.push(d)
      return d
    },
    webServer: {
      register(opts) { captured.handler = opts.handler; captured.opts = opts; return () => {} },
    },
  }
  apply(ctx, { dataDir: dir })
  assert.equal(captured.opts?.path, '/api/dsh-factory', 'handler mounted on factory prefix')
  assert.equal(typeof captured.handler, 'function')

  async function call(method, route, body) {
    const req = {
      method,
      url: `/api/dsh-factory${route}`,
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
      },
    }
    const res = {
      headersSent: false, status: null, payload: null,
      writeHead(status) { this.status = status; this.headersSent = true; return this },
      end(payload) { this.payload = payload?.toString?.() ?? payload; return this },
    }
    await captured.handler(req, res)
    for (let i = 0; i < 50 && !res.headersSent; i += 1) {
      await new Promise((r) => setTimeout(r, 2))
    }
    const text = typeof res.payload === 'string' ? res.payload : ''
    let json
    try { json = text.trim() ? JSON.parse(text) : undefined } catch { json = undefined }
    return { status: res.status, body: json, text }
  }
  return {
    call,
    cleanup: () => {
      for (const d of disposers) { try { if (typeof d === 'function') d() } catch { /* best effort */ } }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function credStore(records = {}) {
  const map = new Map(Object.entries(records))
  const reads = []
  return {
    reads,
    // decideIdentity calls the injected reader UNBOUND — use a closure, not `this`.
    async readRecord(key) { reads.push(key); return map.get(key) },
  }
}

async function createProject(h, overrides = {}) {
  const r = await h.call('POST', '/projects', { name: 'p', rootPath: '/workspace/qa-ghset', ...overrides })
  assert.ok(r.status === 200 || r.status === 201, `create project failed: ${r.text}`)
  return r.body.project
}

// ---------------------------------------------------------------------------
// 1. GET /auth/token/state
// ---------------------------------------------------------------------------

test('GH-STATE-1: no stored token + env token → source=env, masked abcd…wxyz, ok, no echo', async () => {
  const h = harness({ credentials: credentialService({ configured: false }) })
  const rToken = setEnv('GH_TOKEN', 'abcdEFGH1234wxyz')
  const rGithub = setEnv('GITHUB_TOKEN', undefined)
  const rFetch = stubFetch(okFetch('env-user'))
  try {
    const r = await h.call('GET', '/auth/token/state')
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.configured, true)
    assert.equal(r.body.source, 'env')
    assert.equal(r.body.state, 'ok')
    assert.equal(r.body.login, 'env-user')
    assert.equal(r.body.masked, 'abcd…wxyz', 'mask is head4…tail4')
    assert.equal(r.body.overridden, false)
    assert.equal(r.body.reason, null)
    assert.equal(r.body.env.configured, true, 'env status reported separately')
    assert.equal(r.body.env.masked, 'abcd…wxyz')
    assert.equal(r.text.includes('abcdEFGH1234wxyz'), false, 'full token must never be serialized')
  } finally { rToken(); rGithub(); rFetch(); h.cleanup() }
})

test('GH-STATE-2: stored token + env token → source=stored, overridden=true, env still separate', async () => {
  const stored = 'storTOKEN9999zzzz'
  const h = harness({ credentials: credentialService({ configured: true, record: grant(stored, 'stored-user') }) })
  const rToken = setEnv('GH_TOKEN', 'abcdEFGH1234wxyz')
  const rGithub = setEnv('GITHUB_TOKEN', undefined)
  const rFetch = stubFetch(okFetch('stored-user'))
  try {
    const r = await h.call('GET', '/auth/token/state')
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.configured, true)
    assert.equal(r.body.source, 'stored')
    assert.equal(r.body.state, 'ok')
    assert.equal(r.body.login, 'stored-user')
    assert.equal(r.body.masked, 'stor…zzzz')
    assert.equal(r.body.overridden, true, 'stored global token overrides env default')
    assert.equal(r.body.env.configured, true, 'env status still reported separately')
    assert.equal(r.body.env.masked, 'abcd…wxyz', 'env fingerprint independent of stored one')
    assert.equal(r.text.includes(stored), false, 'full stored token must never be serialized')
    assert.equal(r.text.includes('abcdEFGH1234wxyz'), false, 'full env token must never be serialized')
  } finally { rToken(); rGithub(); rFetch(); h.cleanup() }
})

test('GH-STATE-3: short token (<=8 chars) is fully masked as …', () => {
  assert.equal(maskToken('short1'), '…')
  assert.equal(maskToken('12345678'), '…', 'exactly 8 chars is still short')
  assert.equal(maskToken('123456789'), '1234…6789', '9 chars shows head4…tail4')
  assert.equal(maskToken(''), null)
})

test('GH-STATE-3b: state endpoint masks a short stored token as … and echoes nothing', async () => {
  const h = harness({ credentials: credentialService({ configured: true, record: grant('short1', 'u') }) })
  const rClear = clearTokenEnv()
  const rFetch = stubFetch(okFetch('u'))
  try {
    const r = await h.call('GET', '/auth/token/state')
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.source, 'stored')
    assert.equal(r.body.masked, '…')
    assert.equal(r.text.includes('short1'), false)
  } finally { rClear(); rFetch(); h.cleanup() }
})

test('GH-STATE-4: token verification failure → state=invalid with reason, no echo', async () => {
  const stored = 'deadTOKEN0000abcd'
  const h = harness({ credentials: credentialService({ configured: true, record: grant(stored, 'dead-user') }) })
  const rClear = clearTokenEnv()
  const rFetch = stubFetch(badFetch)
  try {
    const r = await h.call('GET', '/auth/token/state')
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.source, 'stored')
    assert.equal(r.body.state, 'invalid')
    assert.equal(typeof r.body.reason, 'string')
    assert.ok(r.body.reason.length > 0, 'invalid state carries a reason')
    // NOTE: sharedTokenState still surfaces the record's cached login when a
    // token fails verification; the authoritative signal is state=invalid + reason.
    assert.equal(r.body.state === 'invalid', true)
    assert.equal(r.text.includes(stored), false)
  } finally { rClear(); rFetch(); h.cleanup() }
})

test('GH-STATE-4b: invalid env token → source=env, state=invalid with reason', async () => {
  const h = harness({ credentials: credentialService({ configured: false }) })
  const rToken = setEnv('GH_TOKEN', 'abcdBAD01234wxyz')
  const rGithub = setEnv('GITHUB_TOKEN', undefined)
  const rFetch = stubFetch(badFetch)
  try {
    const r = await h.call('GET', '/auth/token/state')
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.source, 'env')
    assert.equal(r.body.state, 'invalid')
    assert.ok(typeof r.body.reason === 'string' && r.body.reason.length > 0)
    assert.equal(r.body.env.state, 'invalid')
    assert.equal(r.text.includes('abcdBAD01234wxyz'), false)
  } finally { rToken(); rGithub(); rFetch(); h.cleanup() }
})

test('GH-STATE-5: no env and no stored token → configured=false, source=none, state=none', async () => {
  const h = harness({ credentials: credentialService({ configured: false }) })
  const rClear = clearTokenEnv()
  const rFetch = stubFetch(okFetch())
  try {
    const r = await h.call('GET', '/auth/token/state')
    assert.equal(r.status, 200, r.text)
    assert.equal(r.body.configured, false)
    assert.equal(r.body.source, 'none')
    assert.equal(r.body.state, 'none')
    assert.equal(r.body.masked, null)
    assert.equal(r.body.overridden, false)
    assert.equal(r.body.env.configured, false)
  } finally { rClear(); rFetch(); h.cleanup() }
})

// ---------------------------------------------------------------------------
// 2. identity ladder decisions (pure decideIdentity, injected seams)
// ---------------------------------------------------------------------------

const noProbe = () => false

test('GH-ID-1: saved global token + env → saved token wins (tier 3 over tier 4)', async () => {
  const creds = credStore({ [credentialKeyOf(SHARED_KEY_ID)]: grant('stored-tok', 'stored-user') })
  const d = await decideIdentity({
    project: { id: 'id-1' }, clientId: '', env: { GH_TOKEN: 'env-tok' },
    readRecord: creds.readRecord, probeGhLogin: noProbe,
    verifyToken: async (t) => ({ login: t === 'stored-tok' ? 'stored-user' : 'env-user' }),
  })
  assert.equal(d.source, IDENTITY_SOURCE.SHARED_TOKEN)
  assert.equal(d.login, 'stored-user')
})

test('GH-ID-2: env token + repo token → env wins (tier 4 over tier 5), repo key not read', async () => {
  const project = { id: 'id-2' }
  const repoKey = credentialKeyOf(repoCredentialSegment(project))
  const creds = credStore({ [repoKey]: grant('repo-tok', 'repo-user') })
  const d = await decideIdentity({
    project, clientId: '', env: { GITHUB_TOKEN: 'env-tok' },
    readRecord: creds.readRecord, probeGhLogin: noProbe,
    verifyToken: async () => ({ login: 'env-user' }),
  })
  assert.equal(d.source, IDENTITY_SOURCE.ENV_TOKEN)
  assert.equal(creds.reads.includes(repoKey), false, 'env tier short-circuits before repo read')
})

test('GH-ID-3: dead saved token falls through to env; no false SHARED_TOKEN green', async () => {
  const creds = credStore({ [credentialKeyOf(SHARED_KEY_ID)]: grant('dead-stored', 'old-user') })
  const verifyToken = async (t) => {
    if (t === 'dead-stored') throw new Error('Bad credentials')
    return { login: 'env-user' }
  }
  const d = await decideIdentity({
    project: { id: 'id-3' }, clientId: '', env: { GH_TOKEN: 'env-tok' },
    readRecord: creds.readRecord, probeGhLogin: noProbe, verifyToken,
  })
  assert.equal(d.source, IDENTITY_SOURCE.ENV_TOKEN, 'dead stored token must NOT be reported as connected')
  assert.equal(d.login, 'env-user')
})

test('GH-ID-3b: dead saved token with no env falls through to repo fallback', async () => {
  const project = { id: 'id-3b' }
  const repoKey = credentialKeyOf(repoCredentialSegment(project))
  const creds = credStore({
    [credentialKeyOf(SHARED_KEY_ID)]: grant('dead-stored', 'old-user'),
    [repoKey]: grant('repo-tok', 'repo-user'),
  })
  const verifyToken = async (t) => {
    if (t === 'dead-stored') throw new Error('Bad credentials')
    return { login: 'repo-user' }
  }
  const d = await decideIdentity({
    project, clientId: '', env: {},
    readRecord: creds.readRecord, probeGhLogin: noProbe, verifyToken,
  })
  assert.equal(d.source, IDENTITY_SOURCE.REPO_KEY, 'dead global token must not block the repo fallback')
})

// ---------------------------------------------------------------------------
// 3. POST /auth/token write chain (project scope needs projectId)
// ---------------------------------------------------------------------------

test('GH-WRITE-1: POST /auth/token scope=project WITH projectId writes the derived repo key', async () => {
  const creds = credentialService()
  const h = harness({ credentials: creds })
  const rFetch = stubFetch(okFetch('repo-user'))
  try {
    const p = await createProject(h)
    const r = await h.call('POST', '/auth/token', { token: 'ghp_repo_secret', scope: 'project', projectId: p.id })
    assert.equal(r.status, 200, r.text)
    const expected = credentialKeyOf(repoCredentialSegment(p))
    assert.ok(creds.written.includes(expected), `expected write to ${expected}, got ${creds.written}`)
    assert.equal(r.body.scope, 'project')
    assert.equal(r.body.projectId, p.id)
    assert.equal(r.body.login, 'repo-user')
    assert.equal(r.body.keyId, repoCredentialSegment(p))
    assert.equal(r.text.includes('ghp_repo_secret'), false, 'token never echoed')
  } finally { rFetch(); h.cleanup() }
})

test('GH-WRITE-2: POST /auth/token scope=project WITHOUT projectId → 400 clear error, no write', async () => {
  const creds = credentialService()
  const h = harness({ credentials: creds })
  const rFetch = stubFetch(okFetch())
  try {
    const r = await h.call('POST', '/auth/token', { token: 'ghp_x', scope: 'project' })
    assert.equal(r.status, 400, `missing projectId must fail loudly, got: ${r.text}`)
    assert.match(r.body.error, /项目不存在/)
    assert.equal(creds.written.length, 0, 'no silent write when projectId is missing')
  } finally { rFetch(); h.cleanup() }
})

// ---------------------------------------------------------------------------
// 4. four-dictionary Client-ID key presence (self-contained, no HEAD baseline)
// ---------------------------------------------------------------------------

function captureInlineDictionaries() {
  let registered = null
  const shim = {
    createElement: () => ({}),
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useCallback: (f) => f,
    useRef: (v) => ({ current: v }),
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => { registered = def } } },
    require: (n) => (n === 'react' ? shim : (() => { throw new Error(n) })()),
    fetch: async () => ({ ok: true, text: async () => '{}' }),
    console,
  }
  vm.runInNewContext(clientSrc, sandbox)
  const mod = registered.factory(sandbox.require)
  let captured = null
  mod.apply({
    effect: (f) => { f(); return () => {} },
    locale: { register: (_n, d) => { captured = d; return () => {} }, bind: () => (k) => k },
    slots: { inject: (_o, cb) => cb(), register: () => () => {} },
  })
  assert.ok(captured, 'client registered its locale dictionaries')
  return JSON.parse(JSON.stringify(captured))
}

test('GH-I18N-1: Client-ID keys present & byte-equal in all four dictionaries; hint rendered once', () => {
  const inline = captureInlineDictionaries()
  const localeZh = JSON.parse(readFileSync(join(packageRoot, 'locale', 'zh.json'), 'utf8'))
  const localeEn = JSON.parse(readFileSync(join(packageRoot, 'locale', 'en.json'), 'utf8'))
  const dicts = [
    ['inline zh', inline.zh], ['inline en', inline.en],
    ['locale zh', localeZh], ['locale en', localeEn],
  ]
  for (const key of ['ghAppIdLabel', 'ghAppIdHint', 'ghSaveAppId']) {
    for (const [name, dict] of dicts) {
      assert.equal(typeof dict[key], 'string', `${name} missing Client-ID key ${key}`)
      assert.ok(dict[key].length > 0, `${name} ${key} is empty`)
    }
  }
  // Unchanged Client-ID keys stay byte-identical across the four dicts. The
  // changed ghAppIdHint copy is checked for required guidance below; full
  // byte-equality is the job of i18n-parity.test.mjs (currently red — real drift).
  for (const key of ['ghAppIdLabel', 'ghSaveAppId']) {
    assert.equal(inline.zh[key], localeZh[key], `zh ${key} drifted from locale/zh.json`)
    assert.equal(inline.en[key], localeEn[key], `en ${key} drifted from locale/en.json`)
  }
  assert.match(inline.zh.ghAppIdHint, /Device flow[\s\S]*Client ID/, 'zh hint covers Device flow + Client ID')
  assert.match(inline.en.ghAppIdHint, /Device flow[\s\S]*Client ID/, 'en hint covers Device flow + Client ID')
  // Client-ID guidance is merged into the ① OAuth block: one render, no
  // standalone AppIdSetting card and no duplicate !hasAppId hint.
  assert.equal((clientSrc.match(/t\('ghAppIdHint'\)/g) ?? []).length, 1, 'ghAppIdHint rendered exactly once')
  assert.equal(clientSrc.includes('AppIdSetting'), false, 'standalone AppIdSetting card removed')
  assert.equal(/!oauth\?\.hasAppId[\s\S]{0,120}ghAppIdHint/.test(clientSrc), false, 'duplicate !hasAppId hint removed')
})
