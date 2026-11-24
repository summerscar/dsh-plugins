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
  projects: [{ id: 'p1', name: 'owner/demo', rootPath: '/workspace/demo', paused: false }],
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
// P4-2 — V4: no tier badge at all; the stage-rule panel is the control, and it
// reads ONLY the saved phaseRules.
// ---------------------------------------------------------------------------

test('P4-2 source guard: no tier badge; the stage-rule panel reads only the saved phaseRules', () => {
  assert.doesNotMatch(clientSrc, /LEVEL_META|storedToLevel|levelToStored/, 'the tier mapping is gone from the client')
  assert.match(clientSrc, /function StageConfigSection\(/)
  const section = clientSrc.slice(clientSrc.indexOf('function StageConfigSection'), clientSrc.indexOf('function PauseSection'))
  assert.match(section, /useState\(project\?\.phaseRules \?\? defaults\)/, 'rules read the saved phaseRules, falling back to the full-auto default only when the field is absent')
  // The badge in this section is a static "default" marker, never a state.
  const badgeStart = section.indexOf("key: 'badge'")
  const badgeBlock = section.slice(badgeStart, badgeStart + 300)
  assert.match(badgeBlock, /stageDefaultBadge/)
  assert.doesNotMatch(badgeBlock, /autoDispatch|pending|confirmed/, 'the badge block must not read any switch')
})

test('P4-2 render: the main page renders with no tier text at all', () => {
  const slots = loadClientModule({ fetchImpl: apiFetch(oneProject) })
  const main = slots.find((s) => s.o.name === 'main')
  assert.ok(main, 'main page registered')
  const tree = main.C({ t: (k) => k })
  assert.ok(tree && typeof tree === 'object', 'page renders')
  const all = texts(tree).join('\n')
  // The panel itself lives in the project-scope settings branch (gated on the
  // selected project, unreachable with a frozen useState shim); the naming
  // test covers its dictionary keys and the P4-2 source guard covers the wiring.
  // What this render proves: no tier copy anywhere on the default view.
  for (const k of ['lvManual', 'lvYouApprove', 'lvMachineApprove', 'badgeManual', 'badgeYouApprove', 'badgeMachineApprove']) {
    assert.doesNotMatch(all, new RegExp(k), `${k} does not render`)
  }
  const inlineZh = captureZh()
  for (const k of ['badgeL0', 'badgeL1', 'badgeL2', 'lvManual', 'lvYouApprove', 'lvMachineApprove']) assert.equal(k in inlineZh, false, `${k} deleted`)
  assert.match(inlineZh.stageConfigTitle, /自动化流程/, 'the panel title is the stage-rule wording')
})

// ---------------------------------------------------------------------------
// Naming — V4: tier level and badge names are gone; the stage names are plain
// language, mirrored in zh and en.
// ---------------------------------------------------------------------------
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

test('naming: tier level and badge names are gone; stage-rule keys are mirrored in zh/en', () => {
  const zh = captureZh()
  const en = (() => {
    let dicts = null
    const shim = { createElement: () => ({}), useState: (v) => [v, () => {}], useEffect: () => {}, useCallback: (f) => f, useRef: (v) => ({ current: v }) }
    const sandbox = {
      window: { __ModuleLoader__: { load: (def) => { sandbox.__def = def } } },
      require: (n) => { if (n === 'react') return shim; throw new Error(n) },
      fetch: async () => ({ ok: true, text: async () => '{}' }), console,
    }
    vm.runInNewContext(clientSrc, sandbox)
    const mod = sandbox.__def.factory(sandbox.require)
    mod.apply({ effect: (f) => { f(); return () => {} }, locale: { register: (_n, d) => { dicts = d; return () => {} }, bind: () => (k) => k }, slots: { inject: (_o, cb) => cb(), register: () => () => {} } })
    return JSON.parse(JSON.stringify(dicts.en))
  })()
  // Every legacy tier key: zero survivors, in both languages.
  for (const k of ['lvManual', 'lvYouApprove', 'lvMachineApprove', 'badgeManual', 'badgeYouApprove', 'badgeMachineApprove',
    'lvL0', 'lvL1', 'lvL2', 'lvL3', 'lvL4', 'leL0End', 'leL4End', 'autoDispatchLabel']) {
    assert.equal(k in zh, false, `zh ${k} deleted`)
    assert.equal(k in en, false, `en ${k} deleted`)
  }
  // The stage names exist and are plain language: no L codes, no 半自动/Assisted.
  for (const k of ['stageTriage', 'stagePlan', 'stageBuild', 'stageSelfReview', 'stagePrReview']) {
    assert.equal(typeof zh[k], 'string', `zh has ${k}`)
    assert.doesNotMatch(zh[k], /半自动|L[0-4]/, `${k} zh is plain language`)
    assert.equal(typeof en[k], 'string', `en has ${k}`)
    assert.doesNotMatch(en[k], /Assisted|L[0-4]/i, `${k} en is plain language`)
  }
  // The narrowing-only rule is stated in both languages.
  assert.match(zh.whenAdvancedHint, /收窄|不能放宽/, 'zh states the narrowing-only rule')
  assert.match(en.whenAdvancedHint, /narrow|cannot be widened/i, 'en states the narrowing-only rule')
  // No 半自动 / Assisted copy survives anywhere in either dictionary value.
  for (const [k, v] of Object.entries(zh)) if (typeof v === 'string') assert.doesNotMatch(v, /半自动/, `${k} zh value`)
  for (const [k, v] of Object.entries(en)) if (typeof v === 'string') assert.doesNotMatch(v, /Assisted/i, `${k} en value`)
})

// ---------------------------------------------------------------------------
// P4-3 — after save the UI adopts the backend's read-back values, never the
// form originals. Guard the exact save() call shape.
// ---------------------------------------------------------------------------

test('P4-3 source guard: save() PATCHes phaseRules and adopts the server read-back', () => {
  const section = clientSrc.slice(clientSrc.indexOf('function StageConfigSection'), clientSrc.indexOf('function PauseSection'))
  assert.match(section, /callApi\('PATCH', `\/projects\/\$\{encodeURIComponent\(project\.id\)\}`, \{ phaseRules: next \}\)/, 'save PATCHes the rule object only')
  assert.match(section, /setRules\(data\.project\.phaseRules \?\? next\)/, 'the panel adopts the server read-back, never the form original')
  assert.doesNotMatch(section, /levelToStored|storedToLevel|LEVEL_META/, 'no tier mapping left in the panel')
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
