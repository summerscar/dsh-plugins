/**
 * QA — dsh-factory UI/UX iteration acceptance (offline, deterministic).
 *
 * Covers the static/unit half of the assignment: dual-source dictionary parity,
 * placeholder/meta/contract invariants, banned-word and proper-noun guards,
 * one-board-per-project CRUD and legacy multi-board convergence, and the real
 * index.js manual-intake route's error for archived/nonexistent boards.
 *
 * No business source is modified. Every fixture uses a throwaway SQLite file
 * and injected services; no network, no token, no local machine state.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { createApi } from '../api.js'
import { BIND_REASON, detectGithubRepo } from '../git-exec.js'
import { ghCliState, identityCardFor } from '../github-api.js'
import { apply } from '../index.js'
import { emptyState, FactoryStore, SCHEMA_VERSION } from '../store.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')

// Self-contained key contract (channel lesson): assert presence of the keys this
// iteration added rather than a raw total that expires on the next key addition
// or drifts with HEAD. Cross-dictionary consistency is asserted separately.
const ADDED_KEYS = [
  'cardBodyLabel', 'cardBodyPlaceholder', 'bodyUntrustedNotice',
  'bodySnapshotNotice', 'bodyTruncatedHint', 'takenOverBadge',
  'takenOverBadgeTitle', 'returnToEngine', 'returnToEngineTitle',
  'toastReturned', 'returnWithSessionNotice',
]

function source(file) {
  return readFileSync(join(packageRoot, file), 'utf8')
}

function reactShim() {
  return {
    createElement: (type, props, ...kids) => ({ type, props, kids }),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
  }
}

/** Run the real client factory in a vm and capture ctx.locale.register payloads. */
function inlineDictionaries(code) {
  let registered = null
  const requireShim = (name) => {
    if (name === 'react') return reactShim()
    throw new Error(`unexpected require: ${name}`)
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => { registered = def } } },
    require: requireShim,
    fetch: async () => ({ ok: true, text: async () => '{}' }),
    console,
  }
  vm.runInNewContext(code, sandbox)
  const mod = registered.factory(sandbox.require)
  let captured = null
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    locale: { register: (_ns, dicts) => { captured = dicts; return () => {} }, bind: () => (key) => key },
    slots: { inject: (_ok, cb) => cb(), register: () => () => {} },
  }
  mod.apply(ctx)
  assert.ok(captured, 'client registered its locale dictionaries')
  return JSON.parse(JSON.stringify(captured))
}

function localeJson(lang) {
  return JSON.parse(readFileSync(join(packageRoot, 'locale', `${lang}.json`), 'utf8'))
}

function placeholders(value) {
  return [...new Set(String(value).match(/\{[A-Za-z]+\}/g) ?? [])].sort()
}

// ---------------------------------------------------------------------------
// 1. Dictionary parity, banned words, proper nouns, contract constants
// ---------------------------------------------------------------------------

test('AC-1.5: all overlapping keys are byte-equal across inline and locale dictionaries; meta is well-formed', () => {
  const inline = inlineDictionaries(source('client.js'))
  for (const lang of ['zh', 'en']) {
    const { meta, ...ui } = localeJson(lang)
    const keys = Object.keys(inline[lang]).sort()
    const uiKeys = Object.keys(ui).sort()
    assert.deepEqual(keys, uiKeys, `${lang}: inline keys != locale UI keys`)
    for (const added of ADDED_KEYS) assert.ok(keys.includes(added), `${lang}: this iteration's key ${added} present`)
    const diff = keys.filter((key) => inline[lang][key] !== ui[key])
    assert.deepEqual(diff, [], `${lang}: drifted keys: ${diff.join(', ')}`)
    // meta is host-owned: present in the locale file only, never in the
    // runtime UI dictionaries. Assert its shape instead of comparing to a
    // git revision, which moves every time this work is committed.
    assert.equal(Object.hasOwn(inline[lang], 'meta'), false, `${lang}: meta must stay out of the UI dictionary`)
    assert.ok(meta && typeof meta.title === 'string' && meta.title.trim().length > 0, `${lang}: meta.title missing`)
    assert.ok(typeof meta.description === 'string' && meta.description.trim().length > 0, `${lang}: meta.description missing`)
    assert.deepEqual(placeholders(meta.title), [], `${lang}: meta.title has an unresolved template`)
    assert.deepEqual(placeholders(meta.description), [], `${lang}: meta.description has an unresolved template`)
  }
  const zhMeta = localeJson('zh').meta
  const enMeta = localeJson('en').meta
  assert.notEqual(zhMeta.title, enMeta.title, 'meta is localised, not copied verbatim')
  assert.notEqual(zhMeta.description, enMeta.description, 'meta is localised, not copied verbatim')
})

test('AC-1.5: every key keeps an explicit placeholder contract, mirrored byte-for-byte in both locales', () => {
  const current = inlineDictionaries(source('client.js'))
  // The complete template inventory: no other key may gain or lose a token.
  const PLACEHOLDERS = {
    delType: ['{name}'],
    effSrc: ['{src}'],
    ghConnectState: ['{state}'],
    ghEnvTokenBad: ['{masked}'],
    ghEnvTokenOn: ['{masked}'],
    ghFrom: ['{source}'],
    ghNowUsing: ['{account}'],
    ghPermOkVia: ['{layer}'],
    ghTokenOverrideOn: ['{masked}'],
    ghTokenState: ['{state}'],
    setupPathMissing: ['{path}'],
    toastSwitched: ['{name}'],
    wtRootResolved: ['{path}'],
    autoDeliveryFailedNotice: ['{reason}'],
    selfReviewApproved: ['{sha}'],
    selfReviewChanges: ['{n}', '{total}'],
    prReviewApproved: ['{verdict}'],
    prReviewChanges: ['{n}'],
    stageNextBy: ['{actor}'],
  }
  const keys = Object.keys(current.zh).sort()
  assert.deepEqual(keys, Object.keys(current.en).sort(), 'zh/en templates share one key set')
  for (const added of ADDED_KEYS) assert.ok(keys.includes(added), `placeholder contract: ${added} present`)
  for (const templated of Object.keys(PLACEHOLDERS)) assert.ok(keys.includes(templated), `template key ${templated} present`)
  // V4 PR-review copy is part of the template contract now, in all four carriers.
  for (const added of ['prReviewRunning', 'prReviewApproved', 'prReviewChanges', 'prReviewIncomplete', 'prReviewIdle', 'prReviewWaitMerge', 'actRedispatchPrReview']) {
    assert.ok(keys.includes(added), `placeholder contract: ${added} present`)
  }
  for (const lang of ['zh', 'en']) {
    const ui = localeJson(lang)
    for (const key of keys) {
      const expected = PLACEHOLDERS[key] ?? []
      assert.deepEqual(placeholders(current[lang][key]), expected, `${lang}.${key}: template token set changed`)
      assert.deepEqual(placeholders(ui[key]), expected, `${lang}.${key}: locale mirror token set drifted`)
    }
  }
})

test('AC-V4: three session entries read their own ids; pr-review hints are chosen by state', () => {
  const code = source('client.js')
  const current = inlineDictionaries(code)
  for (const lang of ['zh', 'en']) {
    const ui = localeJson(lang)
    assert.match(current[lang].openReviewSession, /自审|self-review/i, `${lang}: self-review session entry is labelled as such`)
    assert.ok(Object.hasOwn(current[lang], 'openPrReviewSession'), `${lang}: PR-review session entry exists`)
    assert.ok(Object.hasOwn(ui, 'openPrReviewSession'), `${lang}: locale carries the PR-review session entry`)
    assert.equal(Object.hasOwn(current[lang], 'openSelfReviewSession'), false, `${lang}: the cancelled third key stays absent`)
    assert.equal(Object.hasOwn(ui, 'openSelfReviewSession'), false, `${lang}: locale keeps the cancelled third key absent`)
  }
  assert.equal(code.includes('openSelfReviewSession'), false, 'client does not resurrect the cancelled third entry')
  // Guard the actual decision path, not a whole-file regex: only the
  // cardFlowHintKey body is inspected for state-based pr-review selection.
  const begin = code.indexOf('function cardFlowHintKey(ctx) {')
  assert.notEqual(begin, -1, 'cardFlowHintKey exists')
  const end = code.indexOf('\n    }\n', begin)
  const fn = code.slice(begin, end)
  assert.match(fn, /status === 'pr-review'/, 'pr-review gets its own hint branch')
  for (const key of ['prReviewIdle', 'prReviewApproved', 'prReviewChanges', 'prReviewIncomplete', 'prReviewRunning', 'prReviewWaitMerge']) {
    assert.ok(fn.includes(`return '${key}'`), `pr-review may show ${key}`)
  }
  assert.equal(fn.includes("return 'flowMergedDone'"), false, 'pr-review no longer shows the merged/done hint')
  // Three entries bind three different ids; a missing id must not open another session.
  assert.match(code, /card\.sessionId/, 'builder entry reads builder id')
  assert.match(code, /card\.reviewSessionId/, 'self-review entry reads reviewSessionId')
  assert.match(code, /card\.prReviewSessionId/, 'PR-review entry reads prReviewSessionId')
})

const BANNED = [
  '连接用的应用', '应用编号', '电脑上的登录',
  '这台电脑还没登录', '你的登录信息', '填写账号',
]
const PROPER_NOUNS = ['GitHub Token', 'gh CLI', 'GitHub OAuth App', 'Client ID']

// The twenty-one copy keys introduced by this iteration: presence and exact wording
// are the contract now, not "different from whichever commit was HEAD".
const ITERATION_COPY = {
  pauseProject: ['暂停本项目', 'Pause this project'],
  resumeProject: ['恢复本项目', 'Resume this project'],
  mobileProjectConfig: ['项目配置', 'Project config'],
  groupGithub: ['GitHub 连接', 'GitHub connection'],
  groupPaths: ['路径与并发', 'Paths & concurrency'],
  groupEngine: ['引擎', 'Engine'],
  viewLabel: ['视图', 'View'],
  viewSidebar: ['侧栏', 'Sidebar'],
  viewTabs: ['标签', 'Tabs'],
  toastSwitched: ['已切换到项目 {name}', 'Switched to {name}'],
  toastTaken: ['已接管卡片', 'Card taken over'],
  ghRepoBindLabel: ['GitHub 仓库（owner/repo）', 'GitHub repository (owner/repo)'],
  ghRepoBindHint: ['建项目时从 origin 自动识别；可手动修改，留空表示未绑定。', 'Detected from origin when the project was created; edit it here, or clear it to unbind.'],
  ghRepoBindSave: ['保存绑定', 'Save binding'],
  ghRepoBindInvalid: ['仓库格式必须是 owner/repo', 'Repository must be in owner/repo format'],
  bindNoOrigin: ['未识别到 GitHub 仓库：origin 不存在。', 'No GitHub repository detected: origin is missing.'],
  bindNotGithub: ['未识别到 GitHub 仓库：origin 不是 github.com。', 'No GitHub repository detected: origin is not on github.com.'],
  bindNotGit: ['未识别到 GitHub 仓库：仓库根目录不是 git 仓。', 'No GitHub repository detected: the project root is not a git repository.'],
  bindAmbiguous: ['未识别到 GitHub 仓库：origin 有多个地址，需手动填写。', 'No GitHub repository detected: origin has multiple URLs; enter one manually.'],
  bindInvalidUrl: ['未识别到 GitHub 仓库：origin 不是有效的 GitHub 地址。', 'No GitHub repository detected: origin is not a valid GitHub URL.'],
  repoNotBound: ['未绑定', 'Not bound'],
}

test('AC-1.4: the twenty-one iteration labels exist in all four dictionaries with the agreed copy', () => {
  const inline = inlineDictionaries(source('client.js'))
  const locale = { zh: localeJson('zh'), en: localeJson('en') }
  for (const [key, [zh, en]] of Object.entries(ITERATION_COPY)) {
    assert.equal(inline.zh[key], zh, `inline zh.${key}`)
    assert.equal(inline.en[key], en, `inline en.${key}`)
    assert.equal(locale.zh[key], zh, `locale zh.${key}`)
    assert.equal(locale.en[key], en, `locale en.${key}`)
  }
})

test('AC-1.1~1.3: banned generic wording is absent and proper nouns survive in all four dictionaries', () => {
  const inline = inlineDictionaries(source('client.js'))
  const dicts = {
    'inline zh': inline.zh,
    'inline en': inline.en,
    'locale zh': localeJson('zh'),
    'locale en': localeJson('en'),
  }
  for (const [name, dict] of Object.entries(dicts)) {
    for (const word of BANNED) {
      const hits = Object.entries(dict)
        .filter(([, value]) => typeof value === 'string' && value.includes(word))
        .map(([key]) => key)
      assert.deepEqual(hits, [], `${name}: banned wording "${word}" in keys: ${hits.join(', ')}`)
    }
    for (const term of PROPER_NOUNS) {
      assert.ok(
        Object.values(dict).some((value) => typeof value === 'string' && value.includes(term)),
        `${name}: proper noun "${term}" missing`,
      )
    }
  }
  const zh = dicts['locale zh']
  assert.equal(zh.ghAppIdLabel, 'GitHub OAuth App · Client ID')
  assert.match(zh.ghComputerLoginTitle, /gh CLI/)
  assert.match(zh.ghComputerLoginGuide, /gh CLI/)
  assert.equal(zh.ghAccountLabel, 'GitHub Token')
  assert.equal(zh.statSlots, '并发上限（生效）')
  assert.equal(zh.effLabel, '生效并发上限')
  assert.equal(zh.pauseProject, '暂停本项目')
  assert.equal(zh.enginePause, '暂停引擎')
})

test('AC-1.6: NS/RPC/schemaVersion/BUILD are self-consistent across client, store, api and index', () => {
  const client = source('client.js')
  const index = source('index.js')
  assert.equal(/(?:const|let)\s+NS\s*=\s*'([^']+)'/.exec(client)?.[1], 'dsh-factory')
  assert.match(index, /\/api\/dsh-factory/, 'the real RPC route is registered')
  assert.match(index, /createApi\(\{ store, build: BUILD\b/, 'the status build comes from the exported constant')

  // The storage version is a fixed contract; state from another version is
  // rejected by the real loader, so no git history is needed to prove it.
  assert.equal(SCHEMA_VERSION, 2)
  assert.equal(emptyState().schemaVersion, SCHEMA_VERSION)
  const schemaDir = mkdtempSync(join(tmpdir(), 'qa-uiux-schema-'))
  try {
    const file = join(schemaDir, 'factory.sqlite')
    seedState(file, { ...emptyState(), schemaVersion: SCHEMA_VERSION + 1 })
    assert.throws(() => new FactoryStore({ file }), /不支持的 schemaVersion/)
  } finally { rmSync(schemaDir, { recursive: true, force: true }) }

  const build = /export const BUILD = '([^']+)'/.exec(index)?.[1]
  assert.match(build ?? '', /^factory-\d{4}-\d{2}-\d{2}\.\d+$/, 'BUILD keeps its factory-<date>.<patch> shape')
  const buildDir = mkdtempSync(join(tmpdir(), 'qa-uiux-build-'))
  try {
    const store = new FactoryStore({ file: join(buildDir, 'factory.sqlite') })
    const status = createApi({ store, build })({ method: 'GET', route: '/status' })
    assert.equal(status.status, 200)
    assert.equal(status.body.build, build, '/status reports exactly the BUILD wired by index.js')
  } finally { rmSync(buildDir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// 2. One project, one board
// ---------------------------------------------------------------------------

function apiHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'qa-uiux-board-'))
  const store = new FactoryStore({ file: join(dir, 'factory.sqlite') })
  const api = createApi({ store, build: 'qa-uiux' })
  return { dir, store, api, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('AC-3.13/15/17: a new project owns exactly one board; POST /boards is idempotent and every project stays <= 1', () => {
  const f = apiHarness()
  try {
    const make = (name) => f.api({ method: 'POST', route: '/projects', body: { name, rootPath: `/workspace/${name}` } })
    const p1 = make('uiux-one').body.project
    const p2 = make('uiux-two').body.project

    for (const project of [p1, p2]) {
      const boards = f.api({ method: 'GET', route: `/boards?projectId=${project.id}` })
      assert.equal(boards.status, 200)
      assert.equal(boards.body.boards.length, 1, `${project.name} must start with exactly one board`)

      const repeated = f.api({ method: 'POST', route: '/boards', body: { projectId: project.id, name: 'another' } })
      assert.equal(repeated.status, 201, 'the POST /boards status contract is unchanged')
      assert.equal(repeated.body.board.id, boards.body.boards[0].id, 'a repeated create returns the existing board')
      assert.equal(f.api({ method: 'GET', route: `/boards?projectId=${project.id}` }).body.boards.length, 1)
    }

    const all = f.api({ method: 'GET', route: '/boards' }).body.boards
    for (const project of [p1, p2]) {
      assert.ok(all.filter((b) => b.projectId === project.id).length <= 1)
    }
    const status = f.api({ method: 'GET', route: '/status' }).body.counts
    assert.equal(status.projects, 2)
    assert.equal(status.boards, 2, '/status counts active boards via listBoards')
  } finally { f.cleanup() }
})

function seedState(file, state) {
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL)')
  db.prepare('INSERT OR REPLACE INTO state (id, data) VALUES (1, ?)').run(JSON.stringify(state))
  db.close()
}

function rawState(file) {
  const db = new DatabaseSync(file)
  const row = db.prepare('SELECT data FROM state WHERE id = 1').get()
  db.close()
  return row.data
}

/** A real legacy shape: one project, two active boards, intake pointing at the second. */
function legacyState() {
  const base = emptyState()
  const card = (id, boardId) => ({
    id, boardId, projectId: 'legacy-p', title: id, status: 'inbox', source: 'manual',
    repo: '', repoPath: '', body: '', sessionId: null, history: [], createdAt: '2026-01-01T00:00:00.000Z',
  })
  return {
    ...base,
    projects: [{ id: 'legacy-p', name: 'legacy', rootPath: '/workspace/legacy', intakeBoardId: 'legacy-b2' }],
    boards: [
      { id: 'legacy-b1', projectId: 'legacy-p', name: 'first', kind: 'dev', columns: ['planning', 'awaiting-approval', 'building', 'review', 'done'], createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'legacy-b2', projectId: 'legacy-p', name: 'second', kind: 'dev', createdAt: '2026-01-01T00:00:00.000Z' },
    ],
    cards: [card('legacy-c1', 'legacy-b1'), card('legacy-c2', 'legacy-b2'), card('legacy-c3', 'legacy-b2')],
  }
}

test('AC-3.16/18: legacy boards converge with zero card loss, intake repointed, archived board hidden, reload is a no-op', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-uiux-migrate-'))
  const file = join(dir, 'factory.sqlite')
  try {
    seedState(file, legacyState())
    const store = new FactoryStore({ file })

    const cards = store.listCards({ projectId: 'legacy-p' })
    assert.deepEqual(cards.map((c) => c.id).sort(), ['legacy-c1', 'legacy-c2', 'legacy-c3'], 'no card lost')
    assert.ok(cards.every((c) => c.boardId === 'legacy-b1'), 'all cards moved to the retained board')
    assert.ok(cards.every((c) => c.projectId === 'legacy-p'), 'projectId unchanged')
    assert.equal(store.getProject('legacy-p').intakeBoardId, 'legacy-b1', 'intakeBoardId repointed')
    assert.deepEqual(store.listBoards('legacy-p').map((b) => b.id), ['legacy-b1'])
    assert.equal(store.getBoard('legacy-b2'), undefined, 'archived board hidden from getBoard')
    assert.equal(store.listCards({ boardId: 'legacy-b2' }).length, 0, 'archived board ID returns no cards')
    assert.equal(store.state.boards.find((b) => b.id === 'legacy-b2').archived, true, 'extra board retained but archived')
    assert.equal(store.state.schemaVersion, SCHEMA_VERSION, 'schemaVersion not bumped')

    const beforeReload = rawState(file)
    const reopened = new FactoryStore({ file })
    assert.equal(rawState(file), beforeReload, 'a second load does not rewrite state')
    assert.deepEqual(reopened.listBoards('legacy-p').map((b) => b.id), ['legacy-b1'])
    assert.equal(reopened.listCards().length, 3)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// 3. Real index.js HTTP route: manual intake on hidden boards
// ---------------------------------------------------------------------------

function httpHarness(dir) {
  const captured = {}
  const disposers = []
  const svc = { connection: { requestRejection: () => undefined } }
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
      register(opts) {
        captured.handler = opts.handler
        return () => {}
      },
    },
  }
  apply(ctx, { dataDir: dir })
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
      await new Promise((done) => setTimeout(done, 2))
    }
    let json
    try { json = res.payload?.trim() ? JSON.parse(res.payload) : undefined } catch { json = undefined }
    return { status: res.status, body: json }
  }
  return {
    call,
    cleanup: () => { for (const d of disposers) { try { if (typeof d === 'function') d() } catch { /* best effort */ } } },
  }
}

test('manual intake against an archived or nonexistent board returns an explicit 400 (no silent skip)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-uiux-intake-'))
  try {
    seedState(join(dir, 'factory.sqlite'), legacyState())
    const h = httpHarness(dir)
    try {
      for (const boardId of ['legacy-b2', 'board-that-does-not-exist']) {
        const res = await h.call('POST', `/boards/${encodeURIComponent(boardId)}/intake`, { repo: 'owner/repo' })
        assert.equal(res.status, 400, `${boardId}: expected 400`)
        assert.match(res.body?.error ?? '', /目标看板不存在或已归档/, `${boardId}: readable error expected`)
      }
      assert.equal(new FactoryStore({ file: join(dir, 'factory.sqlite') }).listCards().length, 3, 'failed intake wrote no cards')
    } finally { h.cleanup() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// 4. GitHub repo binding: read-only detection at creation + manual rebinding
// ---------------------------------------------------------------------------

function tempGitRepo(label, origin, extraOrigin) {
  const dir = mkdtempSync(join(tmpdir(), `qa-bind-${label}-`))
  execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' })
  if (origin) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin], { stdio: 'ignore' })
  if (extraOrigin) execFileSync('git', ['-C', dir, 'remote', 'set-url', '--add', 'origin', extraOrigin], { stdio: 'ignore' })
  return dir
}

test('AC-bind-1: HTTPS/SSH GitHub origin is detected once into issueRepo with a default intake board', () => {
  const urls = [
    ['https', 'https://github.com/owner/repo.git'],
    ['https-plain', 'https://github.com/owner/repo'],
    ['https-user', 'https://user@github.com/owner/repo.git'],
    ['ssh-scp', 'git@github.com:owner/repo.git'],
    ['ssh-scp-plain', 'git@github.com:owner/repo'],
    ['ssh-url', 'ssh://git@github.com/owner/repo.git'],
  ]
  for (const [label, url] of urls) {
    const dir = tempGitRepo(label, url)
    const f = apiHarness()
    try {
      assert.deepEqual(detectGithubRepo(dir), { issueRepo: 'owner/repo', reason: null }, `${label}: remote parsed`)
      const project = f.store.createProject({ name: `auto-${label}`, rootPath: dir })
      assert.equal(project.issueRepo, 'owner/repo', `${label}: issueRepo written`)
      assert.equal(project.bindingReason, null, `${label}: no failure reason`)
      const boards = f.store.listBoards(project.id)
      assert.equal(boards.length, 1, `${label}: exactly one board`)
      assert.equal(project.intakeBoardId, boards[0].id, `${label}: intake points at the default board`)
      assert.equal(f.store.state.schemaVersion, SCHEMA_VERSION, `${label}: no schema bump`)
      assert.equal(identityCardFor({ project, decision: {} }).binding.bound, true, `${label}: identity card is bound`)
    } finally { f.cleanup(); rmSync(dir, { recursive: true, force: true }) }
  }
})

test('AC-bind-2: failed detection never blocks project creation and exposes a readable reason', () => {
  // The branch itself is reachable when the exec port returns multiple URLs.
  const multiUrlExec = (_cmd, args) => {
    if (args.includes('--is-inside-work-tree')) return { status: 0, stdout: 'true\n' }
    assert.ok(args.includes('--all'), 'origin lookup must request every URL')
    assert.equal(args.at(-1), 'origin')
    return { status: 0, stdout: 'https://github.com/owner/one.git\nhttps://github.com/owner/two.git\n' }
  }
  assert.equal(detectGithubRepo('/tmp/qa-ambiguous', multiUrlExec).reason, BIND_REASON.AMBIGUOUS, 'multi-line origin maps to ambiguous-origin')

  const cases = [
    ['not-git', () => mkdtempSync(join(tmpdir(), 'qa-bind-notgit-')), BIND_REASON.NOT_GIT, 'bindNotGit'],
    ['no-origin', () => tempGitRepo('no-origin', null), BIND_REASON.NO_ORIGIN, 'bindNoOrigin'],
    ['not-github', () => tempGitRepo('not-github', 'https://gitlab.com/owner/repo.git'), BIND_REASON.NOT_GITHUB, 'bindNotGithub'],
    ['invalid-url', () => tempGitRepo('invalid-url', 'https://github.com/owner'), BIND_REASON.INVALID_URL, 'bindInvalidUrl'],
    ['ambiguous', () => tempGitRepo('ambiguous', 'https://github.com/owner/one.git', 'https://github.com/owner/two.git'), BIND_REASON.AMBIGUOUS, 'bindAmbiguous'],
  ]
  const zh = inlineDictionaries(source('client.js')).zh
  for (const [label, makeDir, reason, copyKey] of cases) {
    const dir = makeDir()
    const f = apiHarness()
    try {
      assert.equal(detectGithubRepo(dir).reason, reason, `${label}: reason code`)
      const project = f.store.createProject({ name: `fail-${label}`, rootPath: dir })
      assert.equal(project.issueRepo, null, `${label}: issueRepo stays empty`)
      assert.equal(project.bindingReason, reason, `${label}: reason persisted`)
      assert.equal(f.store.listBoards(project.id).length, 1, `${label}: project still created with its board`)
      assert.ok(typeof zh[copyKey] === 'string' && zh[copyKey].trim().length > 0, `${label}: readable zh notice exists`)
      assert.equal(identityCardFor({ project, decision: {} }).binding.reason, reason, `${label}: identity card carries reason`)
    } finally { f.cleanup(); rmSync(dir, { recursive: true, force: true }) }
  }
})

test('AC-bind-3: detection is one-shot, explicit issueRepo wins, and history is not backfilled', () => {
  const dir = tempGitRepo('oneshot', 'https://github.com/original/repo.git')
  const f = apiHarness()
  try {
    const created = f.store.createProject({ name: 'oneshot', rootPath: dir })
    assert.equal(created.issueRepo, 'original/repo')
    execFileSync('git', ['-C', dir, 'remote', 'set-url', 'origin', 'https://github.com/changed/repo.git'], { stdio: 'ignore' })
    const reopened = new FactoryStore({ file: join(f.dir, 'factory.sqlite') })
    assert.equal(reopened.getProject(created.id).issueRepo, 'original/repo', 'remote change does not rebind')
    assert.equal(reopened.getProject(created.id).bindingReason, null)

    const explicit = f.store.createProject({ name: 'explicit', rootPath: dir, issueRepo: 'given/repo' })
    assert.equal(explicit.issueRepo, 'given/repo', 'explicit issueRepo wins')
    assert.equal(explicit.bindingReason, null, 'detection skipped')
    assert.throws(() => f.store.createProject({ name: 'dirty', rootPath: dir, issueRepo: 'bad/repo/extra' }), /owner\/repo/)
    assert.equal(f.store.listProjects().some((p) => p.name === 'dirty'), false, 'invalid issueRepo did not create a project')
  } finally { f.cleanup(); rmSync(dir, { recursive: true, force: true }) }

  const histDir = mkdtempSync(join(tmpdir(), 'qa-bind-history-'))
  try {
    const base = emptyState()
    const board = { id: 'hist-board', projectId: 'hist', name: 'Default', kind: 'dev', columns: ['planning', 'awaiting-approval', 'building', 'review', 'done'], createdAt: '2026-01-01T00:00:00.000Z' }
    base.boards = [board]
    base.projects = [{ id: 'hist', name: 'hist', rootPath: '/workspace/hist', autonomy: 'manual', autoDispatch: false, intakeBoardId: board.id }]
    const file = join(histDir, 'factory.sqlite')
    seedState(file, base)
    const store = new FactoryStore({ file })
    assert.equal(store.getProject('hist').issueRepo, undefined, 'no backfill on load')
    assert.equal(store.getProject('hist').bindingReason, undefined, 'no backfilled reason')
  } finally { rmSync(histDir, { recursive: true, force: true }) }
})

test('AC-bind-4: manual rebind persists, clears reason, rejects dirty/mixed PATCH, and never blocks on errors', () => {
  const dir = tempGitRepo('manual', 'https://github.com/auto/repo.git')
  const f = apiHarness()
  try {
    const created = f.api({ method: 'POST', route: '/projects', body: { name: 'manual', rootPath: dir } })
    assert.equal(created.status, 201)
    const id = created.body.project.id
    assert.equal(created.body.project.issueRepo, 'auto/repo')

    const rebound = f.api({ method: 'PATCH', route: `/projects/${id}`, body: { issueRepo: 'manual/repo' } })
    assert.equal(rebound.status, 200)
    assert.equal(rebound.body.project.issueRepo, 'manual/repo')
    assert.equal(rebound.body.project.bindingReason, null, 'manual edit clears detection reason')
    assert.equal(new FactoryStore({ file: join(f.dir, 'factory.sqlite') }).getProject(id).issueRepo, 'manual/repo', 'rebind persisted')

    const cleared = f.api({ method: 'PATCH', route: `/projects/${id}`, body: { issueRepo: null } })
    assert.equal(cleared.status, 200)
    assert.equal(cleared.body.project.issueRepo, null, 'clear returns to unbound')
    assert.equal(identityCardFor({ project: cleared.body.project, decision: {} }).binding.bound, false)
    assert.equal(new FactoryStore({ file: join(f.dir, 'factory.sqlite') }).getProject(id).issueRepo, null, 'clear persisted')

    for (const dirty of ['bad/repo/extra', 'https://github.com/owner/repo', 'not github', 'owner//repo']) {
      const res = f.api({ method: 'PATCH', route: `/projects/${id}`, body: { issueRepo: dirty } })
      assert.equal(res.status, 400, `dirty value ${dirty} rejected`)
      assert.match(res.body?.error ?? '', /owner\/repo/)
    }
    // The settings card says 「留空表示未绑定」: an empty string is the
    // documented CLEAR path (200 -> null), not a dirty value. Keep this
    // explicit so it is never mistaken for a validation hole; non-empty
    // malformed values above must still be rejected with 400.
    const empty = f.api({ method: 'PATCH', route: `/projects/${id}`, body: { issueRepo: '' } })
    assert.equal(empty.status, 200, 'empty string clears the binding by product design')
    assert.equal(empty.body.project.issueRepo, null)
    assert.equal(new FactoryStore({ file: join(f.dir, 'factory.sqlite') }).getProject(id).issueRepo, null, 'clear persisted')

    // V4: the disjoint PATCH shapes are phaseRules / preparation / intake /
    // workMode. A legacy tier key is inert, so the mix guard is exercised with
    // the shape that actually exists now.
    const mixed = f.api({ method: 'PATCH', route: `/projects/${id}`, body: { issueRepo: 'a/b', phaseRules: { plan: { autoApprove: false } } } })
    assert.equal(mixed.status, 400)
    assert.match(mixed.body?.error ?? '', /混改/)
    assert.equal(new FactoryStore({ file: join(f.dir, 'factory.sqlite') }).getProject(id).issueRepo, null, 'failed PATCH changed nothing')
    const inert = f.api({ method: 'PATCH', route: `/projects/${id}`, body: { issueRepo: 'a/b', autonomy: 'you-approve' } })
    assert.equal(inert.status, 200, 'a legacy tier key is inert: it no longer forms a PATCH shape')
    assert.equal(inert.body.project.issueRepo, 'a/b')
    assert.equal('autonomy' in inert.body.project, false, 'the inert key is not stored')
  } finally { f.cleanup(); rmSync(dir, { recursive: true, force: true }) }
})

test('AC-identity-display: connected sources never claim an unknown account', () => {
  const client = source('client.js')
  const zh = inlineDictionaries(client).zh
  const render = (key, args = {}) => String(zh[key]).replace(/\{(\w+)\}/g, (_, name) => args[name] ?? `{${name}}`)
  const cardFor = (decision) => identityCardFor({
    project: { id: 'p', rootPath: '/repo/local', issueRepo: 'owner/repo' },
    decision,
  })

  const named = cardFor({ source: 'gh-cli', sourceType: 'gh-cli', globalShared: true, login: 'summerscar', token: 'secret-tok' })
  assert.equal(named.identity.login, 'summerscar')
  assert.equal(render('ghNowUsing', { account: named.identity.login }), '当前身份：summerscar')
  assert.equal(JSON.stringify(named).includes('secret-tok'), false, 'identity card never echoes a token')

  // gh-cli connected with an unresolved login: fall back to the source label,
  // never the misleading 「无法识别账号」.
  const unnamed = cardFor({ source: 'gh-cli', sourceType: 'gh-cli', globalShared: true, login: null })
  assert.equal(unnamed.identity.connected, true)
  assert.equal(unnamed.identity.login, null)
  assert.equal(render('ghNowUsing', { account: zh.srcComputer }), '当前身份：gh CLI 已登录')
  assert.match(client, /id\.connected \? t\('ghNowUsing', \{ account: id\.login \|\| t\(SRC_LABEL\[id\.source\] \|\| 'srcNone'\) \}\) : t\('srcNone'\)/, 'UI falls back to SRC_LABEL')
  assert.doesNotMatch(client, /id\.login \|\| t\('ghUnknownAccount'\)/, 'UI no longer shows the unknown-account label')

  const offline = cardFor(null)
  assert.equal(offline.identity.connected, false)
  assert.equal(render('srcNone'), '未连接')

  // The global gh CLI row mirrors the same rule: account when known, source label otherwise.
  assert.match(client, /ghcli\.login \? `\$\{t\('ghComputerLoggedIn'\)\} · \$\{ghcli\.login\}` : t\('srcComputer'\)/, 'global row uses login or source label')
  assert.equal(`${render('ghComputerLoggedIn')} · summerscar`, '已登录 · summerscar')
  assert.equal(render('srcComputer'), 'gh CLI 已登录')

  // Account lookup is read-only and no longer passes the mutually exclusive --silent flag.
  const ghExec = (_cmd, args) => {
    assert.deepEqual(args, ['api', 'user', '--jq', '.login'])
    return { status: 0, stdout: 'summerscar\n' }
  }
  assert.deepEqual(ghCliState({ env: {}, probeGhLogin: () => true, ghExec }), { loggedIn: true, login: 'summerscar' })
})

test('AC-global-github-jump: project card delegates the GitHub action to the global drawer', () => {
  const client = source('client.js')
  const identityStart = client.indexOf('function IdentityCard(')
  const identityEnd = client.indexOf('function BoardPage', identityStart)
  assert.ok(identityStart > -1 && identityEnd > identityStart, 'IdentityCard source located')
  const cardSource = client.slice(identityStart, identityEnd)

  assert.match(cardSource, /onOpenGlobalGithub/, 'IdentityCard receives the global-jump callback')
  assert.match(cardSource, /onOpenGlobalGithub\(\)/, 'button only calls the callback')
  assert.match(cardSource, /\$\{t\('scopeGlobal'\)\} · \$\{t\('groupGithub'\)\}/, 'button reuses existing copy keys')
  assert.doesNotMatch(cardSource, /auth\/connect\/begin/, 'no dead device-flow call in the project card')
  assert.doesNotMatch(cardSource, /beginConnect|answerConnect|cancelConnect/, 'dead connect handlers removed')

  // The real connect flow survives once, in the global AccountManager only.
  assert.equal((client.match(/auth\/connect\/begin/g) ?? []).length, 1, 'only AccountManager can start OAuth')
  assert.match(client, /const openGlobalGithub = \(\) => \{[\s\S]*?setScope\('global'\)[\s\S]*?setDrawerOpen\(true\)[\s\S]*?scrollTop = 0/, 'jump switches scope and scrolls the drawer body to the top')
  assert.match(client, /ref: drawerBodyRef, className: 'df-drawer-body'/, 'drawer body is the scroll target')

  const dict = inlineDictionaries(client)
  assert.equal(`${dict.zh.scopeGlobal} · ${dict.zh.groupGithub}`, '全局设置 · GitHub 连接')
  assert.equal(`${dict.en.scopeGlobal} · ${dict.en.groupGithub}`, 'Global settings · GitHub connection')
})

test('AC-bind-badge: header badge shows binding state and only navigates to project binding', () => {
  const client = source('client.js')
  assert.match(client, /key: 'bind', type: 'button', className: 'df-bind-badge'/, 'header badge is a button')
  assert.match(client, /repoBound \? `\$\{t\('ghLinked'\)\} · \$\{project\.issueRepo\}` : t\('repoNotBound'\)/, 'bound/unbound copy composition')
  assert.match(client, /onClick: openProjectBinding/, 'badge calls the project-binding jump')
  const fnStart = client.indexOf('const openProjectBinding = () => {')
  const fn = client.slice(fnStart, client.indexOf('// Dialogs are rendered', fnStart))
  assert.ok(fnStart > -1 && fn.length > 0, 'openProjectBinding located')
  assert.match(fn, /setScope\('project'\)/, 'switches to the project scope')
  assert.match(fn, /setDrawerOpen\(true\)/, 'opens the drawer')
  assert.match(fn, /drawerBodyRef\.current\.scrollTop = 0/, 'scrolls the drawer to the binding block')
  assert.doesNotMatch(fn, /callApi|auth\/connect|PATCH|POST/, 'no OAuth, write or API side effect')
  assert.match(client, /\.df-bind-badge\{[^}]*min-height:28px/, 'desktop min height 28')
  assert.match(client, /\.df-bind-badge\{min-height:44px/, 'narrow touch target 44')

  const dict = inlineDictionaries(client)
  assert.equal(dict.zh.repoNotBound, '未绑定')
  assert.equal(dict.en.repoNotBound, 'Not bound')
})
