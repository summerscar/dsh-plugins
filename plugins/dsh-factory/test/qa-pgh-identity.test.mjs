/**
 * QA — P4-github project identity acceptance (PRD .scratch/prd-github-project-identity.md §4).
 *
 * The decision layer (identity.js), the HTTP/write/permission surface
 * (github-api.js) and the OAuth primitives (github-oauth.js) are all pure or
 * injected-seam factories, so the five-tier ladder is exercised offline against
 * the REAL code with fake credentials/fetch/gh — no host, no network, no token
 * ever leaves a closure. Client-only judgements (PGH-13 copy, PGH-18 scope-switch
 * placement) use source guards, the same discipline the repo already uses.
 *
 * Covers the Chief's named focuses: PGH-16 (digit-leading id → repoCredentialSegment
 * derivation, read/write same function, no TypeError), PGH-18 (scope switch only on
 * gh token, global tiers never show it, chosen shared is reused), PGH-13 (no jargon),
 * PGH-11 (six source states from the PANEL view), PGH-15 (judge-before-inject mapping),
 * PGH-8 (locked five-tier order), PGH-4 (ambient globals read, no hard-binding).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  decideIdentity, identityView, mapDecisionToGitEnv,
  repoCredentialSegment, isKeySegment, credentialKeyOf,
  IDENTITY_SOURCE, SOURCE_TYPE, OAUTH_KEY_ID, SHARED_KEY_ID, CREDENTIAL_SCOPE,
} from '../identity.js'
import {
  identityCardFor, probePermission, writeGithubToken, removeGithubToken,
  createAuthorizationBridge,
} from '../github-api.js'
import {
  requestDeviceCode, pollDeviceToken, verifyLogin, registerGithubOAuthFlow, storeUserToken,
} from '../github-oauth.js'
import { buildGitEnv } from '../git-exec.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const clientSrc = readFileSync(join(packageRoot, 'client.js'), 'utf8')

// A credential store fake keyed by the exact `scope/id` string.
function credStore(records = {}) {
  const map = new Map(Object.entries(records))
  const calls = { reads: [], writes: [], deletes: [] }
  return {
    calls,
    async readRecord(key) { calls.reads.push(key); return map.get(key) },
    async modifyRecord(key, fn) {
      calls.writes.push(key)
      const prev = map.get(key)
      const next = await fn(prev)
      map.set(key, next)
      return next
    },
    async deleteRecord(key) { calls.deletes.push(key); map.delete(key) },
    get(key) { return map.get(key) },
  }
}
function grant(token, login, type = 'repo-credential') {
  return { kind: 'grant', payload: { token, login, type } }
}
const noProbe = () => false
const EMPTY_ENV = {}

// ---------------------------------------------------------------------------
// PGH-16 — key grammar + digit-leading id derivation (the Chief's #1).
// ---------------------------------------------------------------------------

test('PGH-16: isKeySegment enforces lowercase-letter start; credentialKeyOf rejects bad ids', () => {
  for (const ok of ['a', 'oauth-global', 'token-global', 'p-1234-abcd', 'repo2']) {
    assert.equal(isKeySegment(ok), true, `${ok} should be legal`)
    assert.equal(credentialKeyOf(ok), `${CREDENTIAL_SCOPE}/${ok}`)
  }
  for (const bad of ['1234-abcd', '9f8e', 'HasUpper', 'has_underscore', '-lead', '', null, 42]) {
    assert.equal(isKeySegment(bad), false, `${String(bad)} must be rejected`)
    assert.throws(() => credentialKeyOf(bad), TypeError, `credentialKeyOf(${String(bad)}) must throw TypeError`)
  }
})

test('PGH-16: digit-leading UUID derives a legal p- segment; explicit id wins when legal', () => {
  const uuid = '9f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8'
  const d = repoCredentialSegment({ id: uuid })
  assert.equal(d, `p-${uuid}`)
  assert.equal(isKeySegment(d), true, 'derived segment must be host-legal')

  // Explicit githubCredentialId is used when valid, ignored when not.
  assert.equal(repoCredentialSegment({ id: uuid, githubCredentialId: 'my-repo' }), 'my-repo')
  assert.equal(repoCredentialSegment({ id: uuid, githubCredentialId: 'BadUpper' }), `p-${uuid}`)
  // An already-legal project id is used as-is (no p- prefix).
  assert.equal(repoCredentialSegment({ id: 'myproject' }), 'myproject')
})

test('PGH-16: read and write use the SAME derived key — digit-leading id round-trips without TypeError', async () => {
  const uuid = '7a3c0000-1111-2222-3333-444455556666'
  const project = { id: uuid, githubCredentialId: null }
  const derived = repoCredentialSegment(project)
  const creds = credStore({ [`${CREDENTIAL_SCOPE}/${derived}`]: grant('ghp_repo', 'repo-user') })

  // Writer path (github-api writeGithubToken, project scope) derives the same id.
  const fetchImpl = async () => ({ status: 200, text: async () => JSON.stringify({ login: 'repo-user' }) })
  await writeGithubToken({ store: { getProject: () => project }, credentials: creds, token: 'ghp_new', scope: 'project', projectId: uuid, fetchImpl })
  assert.ok(creds.calls.writes.includes(`${CREDENTIAL_SCOPE}/${derived}`), 'writer used the derived key')

  // Reader path (decideIdentity) with the ambient tiers empty must hit that SAME key.
  const decision = await decideIdentity({ project, clientId: '', env: EMPTY_ENV, readRecord: creds.readRecord, probeGhLogin: noProbe })
  assert.equal(decision.source, IDENTITY_SOURCE.REPO_KEY)
  assert.equal(decision.keyId, derived)
  assert.ok(creds.calls.reads.includes(`${CREDENTIAL_SCOPE}/${derived}`), 'reader used the derived key')
  assert.equal(decision.token, 'ghp_new')
})

// ---------------------------------------------------------------------------
// PGH-8 / PGH-15 — locked five-tier order + one-winner mapping (judge before inject).
// ---------------------------------------------------------------------------

test('PGH-8: five-tier priority — OAuth > gh CLI > env > shared > repo; stops at first hit', async () => {
  const project = { id: '1111-aaaa', githubCredentialId: null }
  const allRecords = {
    [`${CREDENTIAL_SCOPE}/${OAUTH_KEY_ID}`]: grant('oauth-tok', 'oauth-user', 'oauth-device-flow'),
    [`${CREDENTIAL_SCOPE}/${SHARED_KEY_ID}`]: grant('shared-tok', 'shared-user', 'shared-token-global'),
    [`${CREDENTIAL_SCOPE}/${repoCredentialSegment(project)}`]: grant('repo-tok', 'repo-user'),
  }
  const creds = credStore(allRecords)

  // All present + clientId set + gh probed true + env token present → OAuth wins (tier 1).
  let d = await decideIdentity({ project, clientId: 'client-123', env: { GH_TOKEN: 'env-tok' }, readRecord: creds.readRecord, probeGhLogin: () => true })
  assert.equal(d.source, IDENTITY_SOURCE.OAUTH)
  assert.equal(d.login, 'oauth-user')

  // Remove OAuth → gh CLI wins (tier 2), even though env/shared/repo all present.
  creds.calls.reads.length = 0
  const creds2 = credStore({ [`${CREDENTIAL_SCOPE}/${SHARED_KEY_ID}`]: allRecords[`${CREDENTIAL_SCOPE}/${SHARED_KEY_ID}`], [`${CREDENTIAL_SCOPE}/${repoCredentialSegment(project)}`]: allRecords[`${CREDENTIAL_SCOPE}/${repoCredentialSegment(project)}`] })
  d = await decideIdentity({ project, clientId: 'client-123', env: { GH_TOKEN: 'env-tok' }, readRecord: creds2.readRecord, probeGhLogin: () => true })
  assert.equal(d.source, IDENTITY_SOURCE.GH_CLI)

  // gh not logged in → env wins (tier 3).
  d = await decideIdentity({ project, clientId: '', env: { GITHUB_TOKEN: 'env-tok' }, readRecord: creds2.readRecord, probeGhLogin: noProbe })
  assert.equal(d.source, IDENTITY_SOURCE.ENV_TOKEN)

  // env empty → shared wins (tier 4), repo present but not reached.
  d = await decideIdentity({ project, clientId: '', env: EMPTY_ENV, readRecord: creds2.readRecord, probeGhLogin: noProbe })
  assert.equal(d.source, IDENTITY_SOURCE.SHARED_TOKEN)
  assert.equal(creds2.calls.reads.includes(`${CREDENTIAL_SCOPE}/${repoCredentialSegment(project)}`), false, 'repo key not even read when shared wins')

  // shared removed → repo fallback wins (tier 5).
  const creds3 = credStore({ [`${CREDENTIAL_SCOPE}/${repoCredentialSegment(project)}`]: allRecords[`${CREDENTIAL_SCOPE}/${repoCredentialSegment(project)}`] })
  d = await decideIdentity({ project, clientId: '', env: EMPTY_ENV, readRecord: creds3.readRecord, probeGhLogin: noProbe })
  assert.equal(d.source, IDENTITY_SOURCE.REPO_KEY)
})

test('PGH-8: adding a global tier back overrides the repo fallback (pitfall ⑤, no mis-shadow)', async () => {
  const project = { id: '2222-bbbb', githubCredentialId: null }
  const repoKey = `${CREDENTIAL_SCOPE}/${repoCredentialSegment(project)}`
  const creds = credStore({ [repoKey]: grant('repo-tok', 'repo-user') })
  let d = await decideIdentity({ project, env: EMPTY_ENV, readRecord: creds.readRecord, probeGhLogin: noProbe })
  assert.equal(d.source, IDENTITY_SOURCE.REPO_KEY)

  // Add a gh CLI login back → global tier now wins, repo token must NOT shadow it.
  d = await decideIdentity({ project, env: EMPTY_ENV, readRecord: creds.readRecord, probeGhLogin: () => true })
  assert.equal(d.source, IDENTITY_SOURCE.GH_CLI)
})

test('PGH-15: each tier maps to exactly ONE buildGitEnv argument group', () => {
  assert.deepEqual(mapDecisionToGitEnv({ source: IDENTITY_SOURCE.OAUTH, token: 't' }), { credentialToken: 't', ghLoggedIn: false })
  assert.deepEqual(mapDecisionToGitEnv({ source: IDENTITY_SOURCE.SHARED_TOKEN, token: 't' }), { credentialToken: 't', ghLoggedIn: false })
  assert.deepEqual(mapDecisionToGitEnv({ source: IDENTITY_SOURCE.REPO_KEY, token: 't' }), { credentialToken: 't', ghLoggedIn: false })
  assert.deepEqual(mapDecisionToGitEnv({ source: IDENTITY_SOURCE.GH_CLI }), { ghLoggedIn: true })
  assert.deepEqual(mapDecisionToGitEnv({ source: IDENTITY_SOURCE.ENV_TOKEN }), {}, 'env tier maps no args (inherits)')
  assert.deepEqual(mapDecisionToGitEnv({ source: IDENTITY_SOURCE.NONE }), {})
  // Never two tokens at once, even if a buggy decision carried both.
  const mapped = mapDecisionToGitEnv({ source: IDENTITY_SOURCE.OAUTH, token: 't', ghLoggedIn: true })
  assert.equal('ghLoggedIn' in mapped && mapped.ghLoggedIn === true, false, 'winner mapping must not pass ghLoggedIn=true alongside a token')
})

test('PGH-3: buildGitEnv 403-fix branch semantics unchanged', () => {
  const base = { GITHUB_TOKEN: 'inherited', PATH: '/bin' }
  assert.equal(buildGitEnv(base, { credentialToken: 'explicit' }).GH_TOKEN, 'explicit')
  assert.equal('GITHUB_TOKEN' in buildGitEnv(base, { credentialToken: 'explicit' }), false)
  const gh = buildGitEnv(base, { ghLoggedIn: true })
  assert.equal('GITHUB_TOKEN' in gh, false)
  assert.equal('GH_TOKEN' in gh, false)
  const fallback = buildGitEnv(base, {})
  assert.equal(fallback.GITHUB_TOKEN, 'inherited', 'no args keeps inherited token (CI case)')
  assert.equal('GITHUB_TOKEN' in base, true, 'processEnv not mutated')
})

// ---------------------------------------------------------------------------
// PGH-4 — ambient globals read, but NO hard-binding record written.
// ---------------------------------------------------------------------------

test('PGH-4: gh CLI / env token are recognised from ambient state with zero record writes', async () => {
  const project = { id: '3333-cccc', githubCredentialId: null }
  const creds = credStore({})
  let d = await decideIdentity({ project, env: EMPTY_ENV, readRecord: creds.readRecord, probeGhLogin: () => true })
  assert.equal(d.source, IDENTITY_SOURCE.GH_CLI)
  assert.equal(creds.calls.writes.length, 0, 'decision never writes a record')
  d = await decideIdentity({ project, env: { GH_TOKEN: 'env' }, readRecord: creds.readRecord, probeGhLogin: noProbe })
  assert.equal(d.source, IDENTITY_SOURCE.ENV_TOKEN)
  assert.equal(creds.calls.writes.length, 0)
})

// ---------------------------------------------------------------------------
// PGH-11 / PGH-5 — six source states in the token-free PANEL view; no "GitHub App".
// ---------------------------------------------------------------------------

test('PGH-11: identityView yields the six states with correct sourceType/globalShared; no token', async () => {
  const project = { id: '4444-dddd', githubCredentialId: null, rootPath: '/repo/local', issueRepo: 'owner/remote' }
  const mk = (source, sourceType, globalShared, token = 'secret-tok') => ({ source, sourceType, globalShared, keyId: null, login: 'who', token })
  const cases = [
    [mk(IDENTITY_SOURCE.OAUTH, SOURCE_TYPE.OAUTH_APP, true), IDENTITY_SOURCE.OAUTH, true],
    [mk(IDENTITY_SOURCE.GH_CLI, SOURCE_TYPE.GH_CLI, true), IDENTITY_SOURCE.GH_CLI, true],
    [mk(IDENTITY_SOURCE.ENV_TOKEN, SOURCE_TYPE.GH_TOKEN, true), IDENTITY_SOURCE.ENV_TOKEN, true],
    [mk(IDENTITY_SOURCE.SHARED_TOKEN, SOURCE_TYPE.GH_TOKEN, true), IDENTITY_SOURCE.SHARED_TOKEN, true],
    [mk(IDENTITY_SOURCE.REPO_KEY, SOURCE_TYPE.GH_TOKEN, false), IDENTITY_SOURCE.REPO_KEY, false],
    [mk(IDENTITY_SOURCE.NONE, null, false), IDENTITY_SOURCE.NONE, false],
  ]
  for (const [decision, source, shared] of cases) {
    const v = identityView(decision)
    assert.equal(v.source, source)
    assert.equal(v.globalShared, shared)
    assert.equal('token' in v, false, 'view must NEVER carry the token')
  }
  const card = identityCardFor({ project, decision: mk(IDENTITY_SOURCE.OAUTH, SOURCE_TYPE.OAUTH_APP, true) })
  assert.deepEqual(
    { rootPath: card.binding.rootPath, issueRepo: card.binding.issueRepo, bound: card.binding.bound },
    { rootPath: '/repo/local', issueRepo: 'owner/remote', bound: true },
  )
  assert.equal(Object.hasOwn(card.binding, 'reason'), true, 'binding exposes the detection reason field')
  assert.equal(card.binding.reason, null, 'explicit issueRepo has no detection reason')
  assert.equal(JSON.stringify(card).includes('secret-tok'), false, 'card JSON has no token value')
  assert.equal(JSON.stringify(card).includes('token"'), false, 'card JSON has no token field')
  assert.equal(JSON.stringify(cases).toLowerCase().includes('github-app'), false)
})

test('PGH-5: identityCardFor handles an unbound project without throwing', () => {
  const card = identityCardFor({ project: { id: 'x', rootPath: '', issueRepo: null }, decision: null })
  assert.equal(card.binding.bound, false)
  assert.equal(card.identity.connected, false)
  assert.equal(card.identity.source, IDENTITY_SOURCE.NONE)
})

// ---------------------------------------------------------------------------
// PGH-7 — permission probe is read-only, token stays in closure, three states.
// ---------------------------------------------------------------------------

test('PGH-7: probePermission returns ok/insufficient/not-connected, never the token', async () => {
  const r = await probePermission({ decision: null, repo: 'o/r' })
  assert.equal(r.status, 'not-connected')
  const bad = await probePermission({ decision: { source: IDENTITY_SOURCE.OAUTH, token: 'tok' }, repo: 'not a repo' })
  assert.equal(bad.status, 'insufficient')
  const ok = await probePermission({ decision: { source: IDENTITY_SOURCE.OAUTH, token: 'tok' }, repo: 'o/r', probeImpl: async () => ({ ok: true }) })
  assert.equal(ok.status, 'ok')
  const no = await probePermission({ decision: { source: IDENTITY_SOURCE.OAUTH, token: 'tok' }, repo: 'o/r', probeImpl: async () => ({ ok: false, reason: 'Bad credentials' }) })
  assert.equal(no.status, 'insufficient')
  assert.equal(no.reason, 'Bad credentials', 'backend reason passed through verbatim')
  assert.equal(JSON.stringify(no).includes('tok'), false, 'probe result must not carry the token')
})

// ---------------------------------------------------------------------------
// PGH-18 / PGH-1 — scope: global writes token-global, project writes derived key;
// client_id is a plain settings field, not a token.
// ---------------------------------------------------------------------------

test('PGH-18: writeGithubToken global → token-global, project → derived repo key; bad scope rejected', async () => {
  const fetchImpl = async () => ({ status: 200, text: async () => JSON.stringify({ login: 'u' }) })
  const creds = credStore()
  const project = { id: '5555-eeee', githubCredentialId: null }
  const g = await writeGithubToken({ store: { getProject: () => project }, credentials: creds, token: 'tok', scope: 'global', fetchImpl })
  assert.equal(g.keyId, SHARED_KEY_ID)
  const p = await writeGithubToken({ store: { getProject: () => project }, credentials: creds, token: 'tok', scope: 'project', projectId: project.id, fetchImpl })
  assert.equal(p.keyId, repoCredentialSegment(project))
  assert.deepEqual(creds.calls.writes, [`${CREDENTIAL_SCOPE}/${SHARED_KEY_ID}`, `${CREDENTIAL_SCOPE}/${repoCredentialSegment(project)}`])
  await assert.rejects(
    () => writeGithubToken({ store: { getProject: () => project }, credentials: creds, token: 't', scope: 'bogus', fetchImpl }),
    /作用域必须是/,
  )
})

test('PGH-18: a saved shared token is reused by a NEW project (auto-inherit token-global)', async () => {
  const creds = credStore({ [`${CREDENTIAL_SCOPE}/${SHARED_KEY_ID}`]: grant('shared-tok', 'shared-user', 'shared-token-global') })
  const newProject = { id: '6666-ffff', githubCredentialId: null }
  const d = await decideIdentity({ project: newProject, env: EMPTY_ENV, readRecord: creds.readRecord, probeGhLogin: noProbe })
  assert.equal(d.source, IDENTITY_SOURCE.SHARED_TOKEN, 'new project inherits the shared token without its own record')
  assert.equal(creds.calls.reads.includes(`${CREDENTIAL_SCOPE}/${newProject.id}`), false, 'no per-project record was created/read')
})

test('PGH-1: githubClientId is a non-secret settings field with no token echo', () => {
  assert.match(clientSrc, /githubClientId/, 'client_id surfaced through settings UI')
  // No UI string instructs the user to paste a token/password as the client id.
  const appIdHint = /ghAppIdHint:\s*["'][^"']*["']/.exec(clientSrc)
  assert.ok(appIdHint, 'ghAppIdHint copy present')
  assert.doesNotMatch(appIdHint[0], /token|密码|凭据/, 'client_id hint must not ask for a token')
})

test('PGH-18 source guard: scope switch exists ONLY in the add-account modal', () => {
  // The two switch BUTTONS (ghScopeAll/ghScopeRepo) are rendered only inside
  // dialog==='add'. ghScopeTitle alone is also used as a validation hint in
  // submitAdd, so it cannot mark the switch; the buttons are the reliable signal.
  const addModalStart = clientSrc.indexOf("dialog === 'add'")
  // The dead dialog==='connect' block was removed; use the next component as
  // a stable right boundary for AccountManager's add-account modal.
  const nextComponent = clientSrc.indexOf('function EngineBar', addModalStart)
  assert.ok(addModalStart > 0 && nextComponent > addModalStart, 'add-account modal boundaries found')
  for (const key of ['ghScopeAll', 'ghScopeRepo']) {
    const calls = [...clientSrc.matchAll(new RegExp(`t\\('${key}'\\)`, 'g'))].map((m) => m.index)
    assert.equal(calls.length, 1, `${key} switch button rendered exactly once`)
    assert.ok(calls[0] > addModalStart && calls[0] < nextComponent,
      `${key} switch (${calls[0]}) must be inside the add-account modal [${addModalStart}, ${nextComponent}]`)
  }
  // No scope switch in the connected / CLI tiers (guarded by the modal boundary above).
  assert.match(clientSrc, /if \(scope === ''\) \{ setError\(t\('ghScopeTitle'\)\); return \}/,
    'unpicked scope is blocked in submitAdd, not defaulted')
  assert.match(clientSrc, /if \(scope === 'global'\) \{ setConfirmShared\(true\); return \}/,
    'shared choice needs an explicit danger confirm')
})

// ---------------------------------------------------------------------------
// PGH-12 / OAuth — device flow primitives: /user verify before write, token never echoed.
// ---------------------------------------------------------------------------

test('PGH-12: verifyLogin calls /user with bearer and returns the real login', async () => {
  let seen
  const fetchImpl = async (url, opts) => {
    seen = { url, opts }
    return { status: 200, text: async () => JSON.stringify({ login: 'real-user' }) }
  }
  assert.equal(await verifyLogin({ token: 'tok', fetchImpl }), 'real-user')
  assert.match(seen.url, /api\.github\.com\/user$/)
  assert.equal(seen.opts.headers.authorization, 'Bearer tok')
})

test('PGH-12: storeUserToken verifies /user BEFORE writing and never returns the token', async () => {
  const order = []
  const creds = {
    async modifyRecord(key, fn) { order.push('write'); await fn(undefined); return {} },
  }
  const fetchImpl = async () => { order.push('verify'); return { status: 200, text: async () => JSON.stringify({ login: 'u' }) } }
  const res = await storeUserToken({ credentials: creds, id: SHARED_KEY_ID, token: 'tok', type: 'shared-token-global', fetchImpl })
  assert.deepEqual(order, ['verify', 'write'], 'verify before write (pitfall ⑦)')
  assert.deepEqual(res, { login: 'u' }, 'no token in the result')
})

test('PGH-12: pollDeviceToken honours authorization_pending, slow_down and expiry', async () => {
  let n = 0
  const fetchImpl = async () => {
    n += 1
    if (n === 1) return { status: 200, text: async () => JSON.stringify({ error: 'authorization_pending' }) }
    return { status: 200, text: async () => JSON.stringify({ access_token: 'final-tok' }) }
  }
  const tok = await pollDeviceToken({ deviceCode: 'dc', clientId: 'cid', fetchImpl, interval: 1, sleep: async () => {} })
  assert.equal(tok, 'final-tok')
  assert.equal(n, 2)
  await assert.rejects(
    () => pollDeviceToken({ deviceCode: 'dc', clientId: 'cid', fetchImpl: async () => ({ status: 200, text: async () => JSON.stringify({ error: 'expired_token' }) }), interval: 1, sleep: async () => {} }),
    /已过期/,
  )
})

// ---------------------------------------------------------------------------
// PGH-11 / PGH-13 / client — source labels are human copy, not PM internal ids;
// user-facing copy has no jargon.
// ---------------------------------------------------------------------------

test('PGH-13: no jargon tokens in the user-facing zh/en dictionaries', () => {
  // Read the two inline dictionaries out of client.js via a vm, same as parity test.
  let dicts = null
  const shim = { createElement: () => ({}), useState: (v) => [v, () => {}], useEffect: () => {}, useCallback: (f) => f, useRef: (v) => ({ current: v }) }
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => { sandbox.__def = def } } },
    require: (n) => (n === 'react' ? shim : (() => { throw new Error(n) })()),
    fetch: async () => ({ ok: true, text: async () => '{}' }), console,
  }
  vm.runInNewContext(clientSrc, sandbox)
  const mod = sandbox.__def.factory(sandbox.require)
  mod.apply({ effect: (f) => { f(); return () => {} }, locale: { register: (_n, d) => { dicts = d; return () => {} }, bind: () => (k) => k }, slots: { inject: (_o, cb) => cb(), register: () => () => {} } })
  const zh = JSON.stringify(dicts.zh)
  const en = JSON.stringify(dicts.en)
  // GitHub OAuth App is a required product term; bare OAuth or paraphrases
  // like 授权登录 remain banned. Keep every other jargon token on the ban list.
  for (const jargon of ['device flow', 'client_id', '授权码', '兜底', '优先级', 'GitHub App']) {
    assert.equal(zh.includes(jargon), false, `zh copy must not contain "${jargon}"`)
    assert.equal(en.toLowerCase().includes(jargon.toLowerCase()), false, `en copy must not contain "${jargon}"`)
  }
  // Only the OAuth inside "GitHub OAuth App" is allowed; any isolated OAuth
  // (or a paraphrase such as 授权登录) is still rejected in both languages.
  assert.equal(/(?<!GitHub )OAuth/.test(zh), false, 'zh copy must not contain a bare OAuth outside GitHub OAuth App')
  assert.equal(/(?<!GitHub )OAuth/.test(en), false, 'en copy must not contain a bare OAuth outside GitHub OAuth App')
  // Source labels are human copy, not the internal machine ids (PGH-11).
  // The UI/UX iteration standardised the shared-account label on
  // 「所有项目共用」/“Shared by all projects”; the old wording is gone.
  assert.match(zh, /所有项目共用/)
  assert.match(en, /shared by all projects|all projects \(shared\)/i)
})
