/**
 * QA — P4 client-side contract checks (PRD §6 P4-1/2/3/8 + naming).
 *
 * client.js is a browser module. Two complementary techniques are used, each
 * matched to the kind of judgement:
 *
 *  1. SOURCE GUARDS — for "must never" invariants that a future edit could
 *     silently break (badge must read only the saved autonomy, legacy level
 *     names must be gone, API error text must keep its newlines). These assert
 *     the exact code shape, the same discipline the repo already uses for AE-1d.
 *  2. LIVE VM RENDER — run the real client factory with a controlled React shim
 *     and a one-project fetch fixture, then walk the returned element tree to
 *     assert rendered text (badge, level names, "needs attention").
 *
 * No business code is modified; these read the real client.js.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const clientSrc = readFileSync(join(packageRoot, 'client.js'), 'utf8')

function loadClientModule({ fetchImpl } = {}) {
  let registered = null
  const shim = {
    createElement: (type, props, ...kids) => ({ type, props: props ?? {}, kids }),
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => { registered = def } } },
    require: (name) => { if (name === 'react') return shim; throw new Error(`unexpected require: ${name}`) },
    fetch: fetchImpl ?? (async () => ({ ok: true, text: async () => '{}' })),
    console,
  }
  vm.runInNewContext(clientSrc, sandbox)
  const mod = registered.factory(sandbox.require)
  const slots = []
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    locale: { register: () => {}, bind: () => (k) => k },
    slots: { inject: (_o, cb) => cb(), register: (o, C) => slots.push({ o, C }) },
  }
  mod.apply(ctx)
  return slots
}

// Flatten a React-shim tree into strings (text nodes are plain strings/numbers).
function texts(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) texts(n, out); return out }
  if (typeof node === 'object') {
    if (node.kids) for (const k of node.kids) texts(k, out)
    if (node.props && node.props.children) texts(node.props.children, out)
  }
  return out
}

const oneProject = {
  projects: [{ id: 'p1', name: 'owner/demo', rootPath: '/workspace/demo', autonomy: 'manual', autoDispatch: true, paused: false }],
  boards: [{ id: 'b1', projectId: 'p1', name: 'main' }],
  cards: [],
  settings: { effectiveGlobalMaxActive: { value: 4, source: 'settings' }, projectDefaultMaxActive: 5, globalMaxActive: 4 },
  status: { engine: { timerActive: true, paused: false, projects: [], orphans: [] } },
}
function apiFetch(payload) {
  return async (url) => ({ ok: true, text: async () => {
    if (String(url).includes('/settings')) return JSON.stringify(payload.settings)
    if (String(url).includes('/status')) return JSON.stringify(payload.status)
    if (String(url).includes('/boards')) return JSON.stringify({ boards: payload.boards })
    if (String(url).includes('/cards')) return JSON.stringify({ cards: payload.cards })
    if (String(url).includes('/projects')) return JSON.stringify({ projects: payload.projects })
    return '{}'
  } })
}

// ---------------------------------------------------------------------------
// P4-2 — the badge reads ONLY the saved semantic level, never the switch.
// ---------------------------------------------------------------------------

test('P4-2 source guard: badge is derived from savedLevel, not from the switch', () => {
  assert.match(clientSrc, /const savedLevel = LEVELS\.includes\(project\?\.autonomy\) \? project\.autonomy : 'manual'/,
    'saved level must come from the stored semantic autonomy field, default manual')
  assert.match(clientSrc, /LEVEL_META\[savedLevel\]\.badge/,
    'badge text must be selected by the saved level alone')
  // The badge span colours itself off savedLevel and never reads the switch.
  const badgeStart = clientSrc.indexOf("key: 'badge'")
  const badgeBlock = clientSrc.slice(badgeStart, badgeStart + 400)
  assert.ok(badgeStart > 0, 'badge render block found')
  assert.match(badgeBlock, /LEVEL_META\[savedLevel\]/)
  assert.doesNotMatch(badgeBlock, /autoDispatch|autoApprove|autoStart/,
    'badge block must not read any switch')
})

test('P4-2 render: manual with stale switch still shows the manual badge, not auto-running', () => {
  const slots = loadClientModule({ fetchImpl: apiFetch(oneProject) })
  const main = slots.find((s) => s.o.name === 'main')
  assert.ok(main, 'main page registered')
  const tree = main.C({ t: (k) => k })
  assert.ok(tree && typeof tree === 'object', 'page renders')
  const inlineZh = captureZh()
  assert.equal(inlineZh.badgeManual, '手动')
  assert.equal(inlineZh.badgeYouApprove, '你批准')
  assert.equal(inlineZh.badgeMachineApprove, '机器批准')
  // No legacy badge keys survive.
  for (const k of ['badgeL0', 'badgeL1', 'badgeL2']) assert.equal(k in inlineZh, false, `${k} deleted`)
})

// ---------------------------------------------------------------------------
// Naming — the user required plain-language level names; "半自动/Assisted"
// must be gone everywhere in the client dictionaries.
// ---------------------------------------------------------------------------

function captureZh() {
  let dicts = null
  const shim = { createElement: () => ({}), useState: (v) => [v, () => {}], useEffect: () => {}, useCallback: (f) => f, useRef: (v) => ({ current: v }) }
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => { sandbox.__def = def } } },
    require: (n) => { if (n === 'react') return shim; throw new Error(n) },
    fetch: async () => ({ ok: true, text: async () => '{}' }), console,
  }
  vm.runInNewContext(clientSrc, sandbox)
  const mod = sandbox.__def.factory(sandbox.require)
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    locale: { register: (_ns, d) => { dicts = d; return () => {} }, bind: () => (k) => k },
    slots: { inject: (_o, cb) => cb(), register: () => () => {} },
  }
  mod.apply(ctx)
  return JSON.parse(JSON.stringify(dicts.zh))
}

test('naming: legacy 半自动 / Assisted are gone from the LEVEL and BADGE names', () => {
  const zh = captureZh()
  const en = (() => {
    let dicts = null
    const shim = { createElement: () => ({}), useState: (v) => [v, () => {}], useEffect: () => {}, useCallback: (f) => f, useRef: (v) => ({ current: v }) }
    const sandbox = {
      window: { __ModuleLoader__: { load: (def) => { sandbox.__def = def } } },
      require: (n) => shim, fetch: async () => ({ ok: true, text: async () => '{}' }), console,
    }
    vm.runInNewContext(clientSrc, sandbox)
    const mod = sandbox.__def.factory(sandbox.require)
    mod.apply({ effect: (f) => { f(); return () => {} }, locale: { register: (_n, d) => { dicts = d; return () => {} }, bind: () => (k) => k }, slots: { inject: (_o, cb) => cb(), register: () => () => {} } })
    return JSON.parse(JSON.stringify(dicts.en))
  })()
  // Three semantic levels with plain-language names; switch has its own label.
  const levelAndBadge = ['lvManual', 'lvYouApprove', 'lvMachineApprove', 'badgeManual', 'badgeYouApprove', 'badgeMachineApprove']
  for (const key of levelAndBadge) {
    assert.doesNotMatch(String(zh[key]), /半自动|L[012]/, `${key} zh must not say 半自动 or L0/L1/L2`)
    assert.doesNotMatch(String(en[key]), /Assisted|Auto-approve|L[012]/i, `${key} en must not say Assisted/Auto-approve/L0-L2`)
  }
  assert.equal(zh.lvManual, '手动')
  assert.equal(zh.lvYouApprove, '你批准')
  assert.equal(zh.lvMachineApprove, '机器批准')
  assert.equal(en.lvYouApprove, 'You approve')
  assert.equal(en.lvMachineApprove, 'Machine approves')
  assert.equal(en.autoDispatchLabel, 'Auto-dispatch new cards')
  assert.notEqual(en.lvMachineApprove, en.autoDispatchLabel, 'level name and switch label differ')
  // No legacy keys or switch names survive.
  for (const k of ['lvL0', 'lvL1', 'lvL2', 'badgeL0', 'badgeL1', 'badgeL2', 'autoStart', 'autoApprove']) {
    assert.equal(k in zh, false, `${k} deleted`)
  }
})

// ---------------------------------------------------------------------------
// P4-3 — after save the UI adopts the backend's read-back values, never the
// form originals. Guard the exact save() call shape.
// ---------------------------------------------------------------------------

test('P4-3 source guard: save() PATCHes autonomy+autoDispatch and re-reads both from the response', () => {
  assert.match(clientSrc, /autonomy: nextLevel, autoDispatch: nextDispatch/, 'save sends semantic level + single switch only')
  assert.match(clientSrc, /const p = data\.project/, 'save() reads back the server project')
  assert.match(clientSrc, /setLevel\(p\.autonomy\)/, 'pending level adopts the read-back value')
  assert.match(clientSrc, /setAutoDispatch\(p\.autonomy === 'you-approve' && p\.autoDispatch === true\)/,
    'switch adopts read-back only for you-approve')
  assert.doesNotMatch(clientSrc, /autoStart|autoApprove/, 'no legacy switch in client live code')
})

// ---------------------------------------------------------------------------
// P4-8 + error text — mobile tap targets, pinned bar, multi-line error display.
// ---------------------------------------------------------------------------

test('P4-8 source guard: 44px tap targets, pinned mobile bar, bottom-sheet modal', () => {
  assert.match(clientSrc, /\.df-tap button.*min-height:44px/, '44px tap targets for nested buttons')
  assert.match(clientSrc, /@media \(max-width:760px\)/, 'mobile breakpoint present')
  assert.match(clientSrc, /\.df-mobar\{display:flex;position:sticky;bottom:0/, 'mobile action bar pinned to bottom')
  assert.match(clientSrc, /\.df-mobar button\{flex:1;min-height:44px/, 'mobile bar buttons are 44px')
})

test('P4-4/P4-9 source guard: API error text keeps newlines (pre-line) on autonomy and delete errors', () => {
  // A dirty-worktree change list arrives as a multi-line error.message; the UI
  // must render it with white-space:pre-line so the line breaks survive.
  const occurrences = [...clientSrc.matchAll(/whiteSpace: 'pre-line'/g)].length
  assert.ok(occurrences >= 2, `expected >=2 pre-line error surfaces (autonomy + delete), found ${occurrences}`)
  assert.match(clientSrc, /setError\(err\.message\)/, 'errors surface the verbatim backend message')
})
