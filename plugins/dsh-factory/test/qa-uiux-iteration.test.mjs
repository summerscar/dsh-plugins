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
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { createApi } from '../api.js'
import { apply } from '../index.js'
import { emptyState, FactoryStore, SCHEMA_VERSION } from '../store.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')

function source(file) {
  return readFileSync(join(packageRoot, file), 'utf8')
}

function reactShim() {
  return {
    createElement: (type, props, ...kids) => ({ type, props, kids }),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
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

test('AC-1.5: all 213 overlapping keys are byte-equal across inline and locale dictionaries; meta is well-formed', () => {
  const inline = inlineDictionaries(source('client.js'))
  for (const lang of ['zh', 'en']) {
    const { meta, ...ui } = localeJson(lang)
    const keys = Object.keys(inline[lang]).sort()
    const uiKeys = Object.keys(ui).sort()
    assert.deepEqual(keys, uiKeys, `${lang}: inline keys != locale UI keys`)
    assert.equal(keys.length, 213, `${lang}: expected 213 overlapping keys, got ${keys.length}`)
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
    ghFrom: ['{source}'],
    ghNowUsing: ['{account}'],
    setupPathMissing: ['{path}'],
    wtRootResolved: ['{path}'],
  }
  const keys = Object.keys(current.zh).sort()
  assert.deepEqual(keys, Object.keys(current.en).sort(), 'zh/en templates share one key set')
  assert.equal(keys.length, 213)
  for (const lang of ['zh', 'en']) {
    const ui = localeJson(lang)
    for (const key of keys) {
      const expected = PLACEHOLDERS[key] ?? []
      assert.deepEqual(placeholders(current[lang][key]), expected, `${lang}.${key}: template token set changed`)
      assert.deepEqual(placeholders(ui[key]), expected, `${lang}.${key}: locale mirror token set drifted`)
    }
  }
})

const BANNED = [
  '连接用的应用', '应用编号', '电脑上的登录',
  '这台电脑还没登录', '你的登录信息', '填写账号',
]
const PROPER_NOUNS = ['GitHub Token', 'gh CLI', 'GitHub OAuth App', 'Client ID']

// The six copy keys introduced by this iteration: presence and exact wording
// are the contract now, not "different from whichever commit was HEAD".
const ITERATION_COPY = {
  pauseProject: ['暂停本项目', 'Pause this project'],
  resumeProject: ['恢复本项目', 'Resume this project'],
  mobileProjectConfig: ['项目配置', 'Project config'],
  groupGithub: ['GitHub 连接', 'GitHub connection'],
  groupPaths: ['路径与并发', 'Paths & concurrency'],
  groupEngine: ['引擎', 'Engine'],
}

test('AC-1.4: the six iteration labels exist in all four dictionaries with the agreed copy', () => {
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
  assert.equal(SCHEMA_VERSION, 1)
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
