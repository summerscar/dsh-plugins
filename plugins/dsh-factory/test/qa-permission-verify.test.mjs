/**
 * QA — "已绑定 → 完整权限验证" regression (fast lane).
 *
 * Covers: four-read-only checks + no-false-green, persistence + repo-change
 * invalidation, /identity/:id/check checkedAt, three UI trigger points + no client-side create, repoBound
 * tightening, five dictionary keys self-contained, engine dispatch independent
 * of the UI permission state. All offline against the real modules with injected
 * seams; client-only judgements use source guards. No git show HEAD baseline.
 *
 * No business code changed; no commit.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'

import { FactoryStore } from '../store.js'
import { apply } from '../index.js'
import { IDENTITY_SOURCE, SOURCE_TYPE, OAUTH_KEY_ID } from '../identity.js'
import { probePermission, identityCardFor } from '../github-api.js'
import { runTick, createEngineStatus } from '../autonomy.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const clientSrc = readFileSync(join(packageRoot, 'client.js'), 'utf8')
const zh = JSON.parse(readFileSync(join(packageRoot, 'locale', 'zh.json'), 'utf8'))
const en = JSON.parse(readFileSync(join(packageRoot, 'locale', 'en.json'), 'utf8'))

const DECISION = { source: IDENTITY_SOURCE.OAUTH, sourceType: SOURCE_TYPE.OAUTH_APP, globalShared: true, keyId: null, login: 'summerscar', token: 'sekret-token' }

/** Fake GitHub REST: one 200 JSON body per path, token-checked, records calls. */
function ghFetch(map) {
  const calls = []
  const fetchImpl = async (url, opts) => {
    calls.push({ url, auth: opts?.headers?.authorization })
    const path = String(url).replace('https://api.github.com', '')
    const entry = Object.prototype.hasOwnProperty.call(map, path) ? map[path] : undefined
    // A map value may be a body (200) or { __status, body } for HTTP errors.
    const status = entry && typeof entry === 'object' && '__status' in entry ? entry.__status : (entry === undefined ? 404 : 200)
    const body = status === 200 ? entry : (entry?.body ?? { message: `HTTP ${status}` })
    const text = async () => JSON.stringify(body)
    return { status, text }
  }
  return { fetchImpl, calls }
}

function withStore(fn) {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-perm-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  try { return fn({ store, tmp }) }
  finally { rmSync(tmp, { recursive: true, force: true }) }
}

// ---- index.js HTTP harness (mirrors qa-pgh-wiring) --------------------------
function harness(dir) {
  const captured = {}
  const ctx = {
    get: (name) => ({ connection: { requestRejection: () => undefined } })[name],
    inject: (names, cb) => cb({ effect: () => () => {} }),
    effect: (fn) => { if (typeof fn === 'function') fn(); return () => {} },
    webServer: { register: (opts) => { captured.handler = opts.handler; return () => {} } },
  }
  apply(ctx, { dataDir: dir })
  return captured.handler
}
async function callApi(handler, method, route, body) {
  const req = { method, url: `/api/dsh-factory${route}`, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) } }
  const res = { headersSent: false, status: null, writeHead(s) { this.status = s; this.headersSent = true }, end(p) { this.payload = p?.toString?.() ?? p } }
  await handler(req, res)
  for (let i = 0; i < 50 && !res.headersSent; i += 1) await new Promise((r) => setTimeout(r, 2))
  let json; try { json = JSON.parse(res.payload) } catch { /* empty */ }
  return { status: res.status, body: json }
}

// ==============================================================================
// 1. Four checks + no false green
// ==============================================================================
test('P-1 four checks all pass when repo+issues+pulls readable and write=true', async () => {
  const g = ghFetch({
    '/repos/o/r': { permissions: { push: true, pull: true } },
    '/repos/o/r/issues?state=all&per_page=1': [],
    '/repos/o/r/pulls?state=all&per_page=1': [],
  })
  const r = await probePermission({ decision: DECISION, repo: 'o/r', fetchImpl: g.fetchImpl })
  assert.equal(r.status, 'ok', JSON.stringify(r))
  assert.deepEqual(r.checks.map((c) => c.key).sort(), ['issues', 'pulls', 'repo', 'write'])
  assert.ok(r.checks.every((c) => c.ok))
  assert.ok(g.calls.every((c) => c.auth === 'Bearer sekret-token'), 'all calls authenticated')
  assert.equal(JSON.stringify(r).includes('sekret-token'), false, 'no token echoed')
  assert.ok(g.calls.every((c) => /api\.github\.com/.test(c.url) && c.url.startsWith('https://')), 'real HTTPS GitHub paths')
})

test('P-1 fine-grained token hiding write permission => write check FAILS (no false green)', async () => {
  const g = ghFetch({
    '/repos/o/r': { permissions: { pull: true } }, // no push/admin/maintain
    '/repos/o/r/issues?state=all&per_page=1': [],
    '/repos/o/r/pulls?state=all&per_page=1': [],
  })
  const r = await probePermission({ decision: DECISION, repo: 'o/r', fetchImpl: g.fetchImpl })
  assert.equal(r.status, 'insufficient')
  const write = r.checks.find((c) => c.key === 'write')
  assert.equal(write.ok, false, 'write check is a real FAIL, not a green guess')
  assert.ok(write.reason && write.reason.length > 0, 'failure carries a reason')
})

test('P-1 admin/maintain also count as write; missing issues or pulls => insufficient', async () => {
  for (const perms of [{ admin: true }, { maintain: true }]) {
    const g = ghFetch({
      '/repos/o/r': { permissions: perms },
      '/repos/o/r/issues?state=all&per_page=1': [],
      '/repos/o/r/pulls?state=all&per_page=1': [],
    })
    const r = await probePermission({ decision: DECISION, repo: 'o/r', fetchImpl: g.fetchImpl })
    assert.equal(r.status, 'ok', `write via ${Object.keys(perms)[0]} accepted`)
  }
  const g2 = ghFetch({
    '/repos/o/r': { permissions: { push: true } },
    '/repos/o/r/issues?state=all&per_page=1': { __status: 403, body: { message: 'Resource not accessible' } },
    '/repos/o/r/pulls?state=all&per_page=1': [],
  })
  const r2 = await probePermission({ decision: DECISION, repo: 'o/r', fetchImpl: g2.fetchImpl })
  assert.equal(r2.status, 'insufficient', 'issues read failure blocks green')
  assert.equal(r2.checks.find((c) => c.key === 'issues').ok, false)
})

test('P-1 probeImpl injection still works; token redacted from upstream reasons', async () => {
  const ok = await probePermission({ decision: DECISION, repo: 'o/r', probeImpl: async () => ({ ok: true }) })
  assert.equal(ok.status, 'ok')
  const g = ghFetch({
    '/repos/o/r': { __status: 401, body: { message: 'Bad credentials for sekret-token' } },
    '/repos/o/r/issues?state=all&per_page=1': [],
    '/repos/o/r/pulls?state=all&per_page=1': [],
  })
  const r = await probePermission({ decision: DECISION, repo: 'o/r', fetchImpl: g.fetchImpl })
  assert.equal(r.status, 'insufficient')
  assert.equal(JSON.stringify(r).includes('sekret-token'), false, 'token redacted from backend reason')
  assert.ok(r.reason.includes('[redacted]'), 'redaction marker present')
})

// ==============================================================================
// 2. Persistence + repo-change invalidation
// ==============================================================================
test('P-2 recordPermissionCheck persists all fields; changing issueRepo clears the result', () => withStore(({ store }) => {
  const p = store.createProject({ name: 'p', rootPath: '/workspace/p' })
  const result = { status: 'ok', reason: null, checks: [{ key: 'repo', ok: true, reason: null }, { key: 'write', ok: true, reason: null }, { key: 'issues', ok: true, reason: null }, { key: 'pulls', ok: true, reason: null }] }
  const saved = store.recordPermissionCheck(p.id, result, 'o/r')
  assert.equal(saved.permissionStatus, 'ok')
  assert.equal(saved.permissionRepo, 'o/r')
  assert.ok(typeof saved.permissionCheckedAt === 'string' && !Number.isNaN(Date.parse(saved.permissionCheckedAt)))
  assert.equal(saved.permissionChecks.length, 4)
  // reload persists
  // Reopen the SAME database file to prove the fields persisted to disk.
  const reopened = new FactoryStore({ file: store.file })
  assert.equal(reopened.getProject(p.id).permissionStatus, 'ok', 'persisted across reload')
  // changing issueRepo clears every permission field
  const cleared = store.updateIntake(p.id, { issueRepo: 'other/repo' })
  assert.equal(cleared.permissionStatus, null)
  assert.equal(cleared.permissionReason, null)
  assert.equal(cleared.permissionCheckedAt, null)
  assert.deepEqual(cleared.permissionChecks, [])
  assert.equal(cleared.permissionRepo, null)
}))

test('P-2 identityCardFor exposes the persisted permission summary, token-free', () => withStore(({ store }) => {
  const p = store.createProject({ name: 'p', rootPath: '/workspace/p' })
  store.updateIntake(p.id, { issueRepo: 'o/r' })
  store.recordPermissionCheck(p.id, { status: 'ok', checks: [{ key: 'repo', ok: true }] }, 'o/r')
  const fresh = store.getProject(p.id)
  const card = identityCardFor({ project: fresh, decision: DECISION })
  assert.equal(card.permission.status, 'ok')
  assert.equal(card.permission.repo, 'o/r')
  assert.equal(card.permission.checks[0].key, 'repo')
  assert.equal(JSON.stringify(card).includes('sekret-token'), false)
}))

// ==============================================================================
// 3. /identity/:id/check returns checkedAt and saves the result
// ==============================================================================
test('P-3 POST /identity/:id/check saves result and returns checkedAt', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-perm-route-'))
  try {
    const handler = harness(tmp)
    // Create the project THROUGH the handler so it lives in the same store the
    // route handler uses (apply() picks its own file under dataDir).
    const created = await callApi(handler, 'POST', '/projects', { name: 'p', rootPath: '/workspace/p', issueRepo: 'o/r' })
    assert.equal(created.status, 201, JSON.stringify(created))
    const id = created.body.project.id
    // No credential service → decision NONE → not-connected, but route still saves + returns checkedAt.
    const res = await callApi(handler, 'POST', `/identity/${id}/check`, {})
    assert.equal(res.status, 200, JSON.stringify(res))
    assert.ok(typeof res.body.checkedAt === 'string' && !Number.isNaN(Date.parse(res.body.checkedAt)), 'checkedAt returned')
    assert.ok(['ok', 'insufficient', 'not-connected'].includes(res.body.status))
    // Read back via the same handler's GET project route.
    const proj = await callApi(handler, 'GET', `/projects/${id}`)
    const saved = proj.body.project
    assert.equal(saved.permissionCheckedAt, res.body.checkedAt, 'checkedAt persisted identically')
    assert.equal(saved.permissionStatus, res.body.status, 'status persisted')
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

// ==============================================================================
// 4. UI trigger points (source guards — no real-device deploy)
// ==============================================================================
test('P-4 three UI triggers present (open auto-check, recheck button, save-binding recheck); client never POSTs /projects directly', () => {
  // Open: effect auto-runs when bound+connected and no fresh result for this repo.
  assert.match(clientSrc, /card\?\.binding\?\.bound && card\?\.identity\?\.connected && !checking[\s\S]{0,160}p\.repo !== card\.binding\.issueRepo \|\| !p\.status\) void checkPermission\(\)/, 'auto-check on open')
  // Recheck button: explicit, uses ghRecheckPerm key, calls checkPermission.
  assert.match(clientSrc, /onClick: \(\) => void checkPermission\(\)[\s\S]{0,120}t\('ghRecheckPerm'\)/, 'recheck button')
  // Save binding: PATCH then checkPermission when value non-empty.
  assert.match(clientSrc, /if \(value !== ''\) await checkPermission\(\)/, 'save-binding recheck')
  // Create project: the client no longer creates projects (form removed);
  // creation goes through the factory-add-project skill → factory_create_project.
  assert.doesNotMatch(clientSrc, /callApi\('POST', '\/projects'/, 'client never creates a project directly')
})

test('P-4 four check chips render per-item with reason title, failure shows backend reason', () => {
  assert.match(clientSrc, /const PERM_CHECK_KEY = \{\s*repo: 'permCheckRepo', write: 'permCheckWrite', issues: 'permCheckIssues', pulls: 'permCheckPulls'/, 'four keys mapped')
  assert.match(clientSrc, /permChecks\.map\(\(c\)[\s\S]{0,260}title: c\.reason \|\| ''[\s\S]{0,120}t\(PERM_CHECK_KEY\[c\.key\] \|\| c\.key\)/, 'four chips with reason title')
  assert.match(clientSrc, /perm === 'insufficient' && permReason[\s\S]{0,160}color: T\.dangerInk/, 'failure shows backend reason verbatim')
})

// ==============================================================================
// 5. repoBound tightening
// ==============================================================================
test('P-5 repoBound requires ok status AND repo match; unchecked/failed show 未绑定 with reason title', () => {
  const m = clientSrc.match(/const repoBound = [\s\S]*?project\.permissionRepo === project\.issueRepo\)/)?.[0]
  assert.ok(m, 'repoBound expression found')
  assert.match(m, /permissionStatus === 'ok'/, 'requires ok status')
  assert.match(m, /permissionRepo === project\.issueRepo/, 'requires repo match')
  const title = clientSrc.match(/title: repoBound \?[^,]+: \([^)]+\)/)?.[0]
  assert.ok(title && title.includes('permissionReason'), 'not-bound title shows failure reason')
  assert.match(clientSrc, /repoBound \? `?\$\{t\('ghLinked'\)\}/, 'green only when repoBound')
})

// ==============================================================================
// 6. Five dictionary keys + self-contained counts
// ==============================================================================
test('P-6 five new keys byte-identical in all four dictionaries; relational counts', () => {
  const inline = (() => {
    let registered = null
    const shim = { createElement: () => ({}), useState: (v) => [v, () => {}], useEffect: () => {}, useCallback: (f) => f, useRef: (v) => ({ current: v }) }
    const require = (n) => n === 'react' ? shim : (() => { throw new Error(n) })()
    const sandbox = { window: { __ModuleLoader__: { load: (d) => { registered = d } } }, require, fetch: async () => ({ ok: true, text: async () => '{}' }), console }
    vm.runInNewContext(clientSrc, sandbox)
    let cap = null
    registered.factory(require).apply({ effect: (f) => { f(); return () => {} }, locale: { register: (_n, d) => { cap = d; return () => {} }, bind: () => (k) => k }, slots: { inject: (_o, cb) => cb(), register: () => () => {} } })
    return JSON.parse(JSON.stringify(cap))
  })()
  const keys = ['ghRecheckPerm', 'permCheckRepo', 'permCheckWrite', 'permCheckIssues', 'permCheckPulls']
  const expected = {
    zh: ['重新检查权限', '仓库读取', '推送与建 PR', 'Issue 读取', 'PR 读取'],
    en: ['Recheck GitHub access', 'Repository access', 'Push and pull requests', 'Issue access', 'Pull request access'],
  }
  for (const [lang, dict] of [['zh', zh], ['en', en]]) {
    keys.forEach((k, i) => {
      assert.equal(inline[lang][k], expected[lang][i], `inline ${lang}.${k}`)
      assert.equal(dict[k], expected[lang][i], `locale ${lang}.${k}`)
      assert.equal(inline[lang][k], dict[k], `four-place ${lang}.${k}`)
    })
  }
  // relational self-contained counts (no HEAD baseline, no hardcoded total)
  const zhUi = { ...zh }; delete zhUi.meta
  const enUi = { ...en }; delete enUi.meta
  assert.deepEqual(Object.keys(inline.zh).sort(), Object.keys(inline.en).sort())
  assert.deepEqual(Object.keys(zhUi).sort(), Object.keys(inline.zh).sort())
  assert.deepEqual(Object.keys(enUi).sort(), Object.keys(inline.en).sort())
  assert.equal(Object.keys(zh).length, Object.keys(zhUi).length + 1, 'locale zh = UI + meta')
  assert.equal(Object.keys(en).length, Object.keys(enUi).length + 1, 'locale en = UI + meta')
})

// ==============================================================================
// 7. Engine dispatch independent of UI permission state
// ==============================================================================
test('P-7 engine dispatch does not consult permissionStatus (UI state is not a gate)', async () => {
  let dispatched = 0
  const src = readFileSync(join(packageRoot, 'autonomy.js'), 'utf8')
  assert.ok(!src.includes('permissionStatus'), 'autonomy.js never reads UI permission state')
  // A real tick with permissionStatus absent still dispatches (source-agnostic).
  const tmp = mkdtempSync(join(tmpdir(), 'qa-perm-engine-'))
  try {
    const store = new FactoryStore({ file: join(tmp, 'factory.json') })
    const p = store.createProject({ name: 'p', rootPath: '/workspace/p' })
    store.updateAutonomy(p.id, { autonomy: 'you-approve', autoDispatch: true })
    store.updateIntake(p.id, { issueRepo: 'owner/repo', intakeBoardId: store.createBoard({ projectId: p.id, name: 'main' }).id })
    store.createCard({ boardId: store.listBoards(p.id)[0].id, title: 'c' })
    const deps = {
      ghPort: {}, intake: async () => ({ created: [] }),
      dispatch: async ({ store: s, cardId, transitionActor }) => { dispatched += 1; s.transitionCard(cardId, 'triage', transitionActor); return { mode: 'created' } },
      isSessionActive: async () => false,
    }
    await runTick({ store, status: createEngineStatus(), deps })
    assert.equal(dispatched, 1, 'dispatch proceeds even with no permission check recorded')
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})
