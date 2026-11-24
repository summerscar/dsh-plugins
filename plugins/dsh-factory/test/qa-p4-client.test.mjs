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

// V4.59 — render the REAL StageConfigSection with a small hook shim, so the
// assertions observe rendered checkbox props and the actual PATCH body rather
// than source identifiers. The 4 engine-readable rules are the only editable
// ones; the other 8 must be fixed-on and inert.
const STAGE_KEYS = ['inbox', 'triage', 'plan', 'build', 'self-review', 'pr-review']
const STAGE_LABELS = ['stageInbox', 'stageTriage', 'stagePlan', 'stageBuild', 'stageSelfReview', 'stagePrReview']
const RULE_ACTIONS = ['autoStart', 'autoApprove']
const EDITABLE_RULES = new Set([
  'inbox:autoStart', 'plan:autoApprove', 'self-review:autoStart', 'pr-review:autoStart',
])
const allRules = (value) => Object.fromEntries(STAGE_KEYS.map((stage) => [
  stage, { autoStart: value, autoApprove: value },
]))

function stageSectionFactory() {
  const start = clientSrc.indexOf('function StageConfigSection(')
  const end = clientSrc.indexOf('function PauseSection(')
  assert.ok(start >= 0 && end > start, 'StageConfigSection source found')
  return new Function(
    'h', 'useState', 'Button', 'callApi', 'T', 't',
    `${clientSrc.slice(start, end)}\nreturn StageConfigSection`,
  )
}

function renderStageRules(projectRules, { responseRules } = {}) {
  const Fac = stageSectionFactory()
  const states = []
  const calls = []
  const Button = (props, ...kids) => ({ tag: 'button', props: props ?? {}, kids })
  const h = (tag, props, ...kids) => typeof tag === 'function' ? tag(props, ...kids) : { tag, props: props ?? {}, kids }
  const T = new Proxy({}, { get: () => '' })
  const t = (key) => key
  const render = () => {
    let i = 0
    const useState = (initial) => {
      const n = i++
      if (!(n in states)) states[n] = typeof initial === 'function' ? initial() : initial
      return [states[n], (v) => { states[n] = typeof v === 'function' ? v(states[n]) : v }]
    }
    const callApi = async (method, url, body) => {
      calls.push({ method, url, body })
      return { project: { phaseRules: responseRules ?? body.phaseRules } }
    }
    const tree = Fac(h, useState, Button, callApi, T, t)({
      project: { id: 'p1', phaseRules: projectRules }, t, onSaved: () => {},
    })
    return tree
  }
  return { render, calls }
}

function flattenStage(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) { for (const n of node) flattenStage(n, out); return out }
  if (typeof node === 'object') {
    out.push(node)
    for (const k of node.kids ?? []) flattenStage(k, out)
    if (node.props?.children) flattenStage(node.props.children, out)
  }
  return out
}

function stageRows(tree) {
  return flattenStage(tree).filter((n) => STAGE_KEYS.includes(n.props?.key))
}

function stageBoxes(tree) {
  const out = []
  for (const row of stageRows(tree)) {
    for (const label of flattenStage(row)) {
      if (!RULE_ACTIONS.includes(label.props?.key)) continue
      const input = flattenStage(label).find((n) => n.props?.type === 'checkbox')
      if (!input) continue
      out.push({ stage: row.props.key, action: label.props.key, input, label })
    }
  }
  return out
}

function findButton(tree, key) {
  return flattenStage(tree).find((n) => n.tag === 'button' && n.props?.key === key)
}

// The component's onChange closes over its render's rules object, so each
// simulated click must be made on a fresh render to model real user clicks.
function clickEditable(view, stage, action, checked = false) {
  const key = `${stage}:${action}`
  const box = stageBoxes(view.render()).find((b) => `${b.stage}:${b.action}` === key)
  assert.ok(box?.input?.props?.onChange, `${key} is editable`)
  box.input.props.onChange({ target: { checked } })
}

// ---------------------------------------------------------------------------
// P4-2 — V4: no tier badge at all; the stage-rule panel is the control, and it
// reads ONLY the saved phaseRules.
// ---------------------------------------------------------------------------

test('P4-2 source guard: no tier badge; the stage-rule panel reads only the saved phaseRules', () => {
  assert.doesNotMatch(clientSrc, /LEVEL_META|storedToLevel|levelToStored/, 'the tier mapping is gone from the client')
  assert.match(clientSrc, /function StageConfigSection\(/)
  const section = clientSrc.slice(clientSrc.indexOf('function StageConfigSection'), clientSrc.indexOf('function PauseSection'))
  assert.match(section, /useState\([\s\S]{0,80}normalize\(project\?\.phaseRules\)\)/, 'rules read normalized saved phaseRules, falling back to the full-auto default only when absent')
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
  const zhLocale = JSON.parse(readFileSync(join(packageRoot, 'locale', 'zh.json'), 'utf8'))
  const enLocale = JSON.parse(readFileSync(join(packageRoot, 'locale', 'en.json'), 'utf8'))
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
  for (const k of STAGE_LABELS) {
    assert.equal(typeof zh[k], 'string', `zh has ${k}`)
    assert.doesNotMatch(zh[k], /半自动|L[0-4]/, `${k} zh is plain language`)
    assert.equal(typeof en[k], 'string', `en has ${k}`)
    assert.doesNotMatch(en[k], /Assisted|L[0-4]/i, `${k} en is plain language`)
  }
  // V4.59: new keys are present in all four carriers with identical values.
  const newKeys = ['stageInbox', 'stageRuleLockedHint', 'stageConfigPurpose']
  for (const k of newKeys) {
    assert.equal(zh[k], zhLocale[k], `zh inline mirrors locale: ${k}`)
    assert.equal(en[k], enLocale[k], `en inline mirrors locale: ${k}`)
    assert.equal(typeof zh[k], 'string', `zh has ${k}`)
    assert.equal(typeof en[k], 'string', `en has ${k}`)
  }
  assert.equal(zh.stageInbox, '收件箱', 'zh stageInbox value')
  assert.equal(en.stageInbox, 'Inbox', 'en stageInbox value')
  assert.equal(zh.stageRuleLockedHint, '该阶段目前没有可单独关闭的自动步骤，此勾选固定开启、不可修改。', 'zh locked hint')
  assert.equal(en.stageRuleLockedHint, 'This stage has no separately switchable automatic step; this checkbox is fixed on and cannot be changed.', 'en locked hint')
  // V4.59: the advanced fold is still gone; the narrowing contract now lives
  // in a named set of four editable rules plus fixed-on greyed-out rules.
  for (const k of ['whenAdvancedTitle', 'whenAdvancedHint', 'whenNoNarrow']) {
    assert.equal(k in zh, false, `zh dead key ${k} removed`)
    assert.equal(k in en, false, `en dead key ${k} removed`)
  }
  const section = clientSrc.slice(clientSrc.indexOf('function StageConfigSection'), clientSrc.indexOf('function PauseSection'))
  assert.doesNotMatch(section, /whenAdvancedTitle|whenAdvancedHint|whenNoNarrow|setAdvance|advance \?/, 'no advanced fold or expanded area')
  assert.match(section, /t\('stageConfigPurpose'\)/, 'purpose still rendered')
  assert.match(section, /t\('stageRuleLockedHint'\)/, 'locked-rule tooltip is rendered')
  assert.match(section, /disabled:\s*true/, 'locked checkboxes are disabled')
  assert.match(zh.stageConfigPurpose, /收件箱-自动启动/, 'zh purpose names inbox auto-start')
  assert.match(zh.stageConfigPurpose, /规划-自动批准/, 'zh purpose names plan auto-approve')
  assert.match(zh.stageConfigPurpose, /自审-自动启动/, 'zh purpose names self-review auto-start')
  assert.match(zh.stageConfigPurpose, /PR 评审-自动启动/, 'zh purpose names PR-review auto-start')
  assert.match(zh.stageConfigPurpose, /置灰不可改/, 'zh purpose explains greyed-out rules')
  assert.doesNotMatch(zh.stageConfigPurpose, /取消某阶段勾选即可停等人/, 'zh no longer promises every checkbox stops a stage')
  assert.match(en.stageConfigPurpose, /Inbox auto-start/i, 'en purpose names inbox auto-start')
  assert.match(en.stageConfigPurpose, /Planning auto-approve/i, 'en purpose names plan auto-approve')
  assert.match(en.stageConfigPurpose, /Self-review auto-start/i, 'en purpose names self-review auto-start')
  assert.match(en.stageConfigPurpose, /PR review auto-start/i, 'en purpose names PR-review auto-start')
  assert.match(en.stageConfigPurpose, /greyed out/i, 'en purpose explains greyed-out rules')
  assert.doesNotMatch(en.stageConfigPurpose, /uncheck a stage/i, 'en no longer promises every checkbox stops a stage')
  // No 半自动 / Assisted copy survives anywhere in either dictionary value.
  for (const [k, v] of Object.entries(zh)) if (typeof v === 'string') assert.doesNotMatch(v, /半自动/, `${k} zh value`)
  for (const [k, v] of Object.entries(en)) if (typeof v === 'string') assert.doesNotMatch(v, /Assisted/i, `${k} en value`)
})

// ---------------------------------------------------------------------------
// P4-3 — after save the UI adopts the backend's read-back values, never the
// form originals. Guard the exact save() call shape.
// ---------------------------------------------------------------------------

test('P4-3 save() PATCHes phaseRules and adopts the server read-back', async () => {
  const section = clientSrc.slice(clientSrc.indexOf('function StageConfigSection'), clientSrc.indexOf('function PauseSection'))
  assert.doesNotMatch(section, /levelToStored|storedToLevel|LEVEL_META/, 'no tier mapping left in the panel')
  const serverRules = allRules(false)
  const view = renderStageRules(allRules(true), { responseRules: serverRules })
  for (const key of EDITABLE_RULES) {
    const [stage, action] = key.split(':')
    clickEditable(view, stage, action, false)
  }
  findButton(view.render(), 'save').props.onClick()
  assert.equal(view.calls.length, 1, 'one PATCH on save')
  assert.equal(view.calls[0].method, 'PATCH')
  assert.match(view.calls[0].url, /\/projects\/p1$/, 'PATCH targets the current project')
  // The re-render must show the SERVER read-back, not the form original.
  const after = stageBoxes(view.render())
  assert.equal(after.find((b) => `${b.stage}:${b.action}` === 'inbox:autoStart').input.props.checked, false, 'adopts server false')
  assert.equal(after.find((b) => `${b.stage}:${b.action}` === 'plan:autoApprove').input.props.checked, false, 'adopts server false on another editable rule')
  assert.equal(after.find((b) => `${b.stage}:${b.action}` === 'triage:autoStart').input.props.checked, true, 'a locked rule stays checked regardless of server value')
})

test('V4.59 stage rules render six ordered rows; only four rules are editable', () => {
  const view = renderStageRules(allRules(false))
  const tree = view.render()
  const rows = stageRows(tree)
  assert.deepEqual(rows.map((r) => r.props.key), STAGE_KEYS, 'six rows in inbox→pr-review order')
  const labels = rows.map((r) => flattenStage(r).find((n) => n.props?.key === 'name')?.kids?.[0])
  assert.deepEqual(labels, STAGE_LABELS, 'each row uses its own stage label key')
  const boxes = stageBoxes(tree)
  assert.equal(boxes.length, 12, '6 stages × 2 checkboxes')
  for (const { stage, action, input, label } of boxes) {
    const editable = EDITABLE_RULES.has(`${stage}:${action}`)
    const titled = input.props.title === 'stageRuleLockedHint' || label.props.title === 'stageRuleLockedHint'
    if (editable) {
      assert.equal(input.props.checked, false, `${stage}:${action} follows the saved false rule`)
      assert.notEqual(input.props.disabled, true, `${stage}:${action} is not disabled`)
      assert.equal(typeof input.props.onChange, 'function', `${stage}:${action} can be changed`)
      assert.equal(titled, false, `${stage}:${action} has no locked tooltip`)
    } else {
      assert.equal(input.props.checked, true, `${stage}:${action} is shown checked even when stored false`)
      assert.equal(input.props.disabled, true, `${stage}:${action} is disabled`)
      assert.equal(input.props.onChange, undefined, `${stage}:${action} has no change handler`)
      assert.equal(titled, true, `${stage}:${action} carries stageRuleLockedHint`)
    }
  }
})

test('V4.59 only the four editable rules can be turned off and saved; locked rules normalize to true', () => {
  const view = renderStageRules(allRules(true))
  for (const b of stageBoxes(view.render())) {
    if (!EDITABLE_RULES.has(`${b.stage}:${b.action}`)) {
      assert.equal(b.input.props.onChange, undefined, `locked ${b.stage}:${b.action} cannot be clicked`)
    }
  }
  for (const key of EDITABLE_RULES) {
    const [stage, action] = key.split(':')
    clickEditable(view, stage, action, false)
  }
  findButton(view.render(), 'save').props.onClick()
  assert.equal(view.calls.length, 1, 'save sends one PATCH')
  const payload = view.calls[0].body.phaseRules
  for (const stage of STAGE_KEYS) {
    for (const action of RULE_ACTIONS) {
      const expected = EDITABLE_RULES.has(`${stage}:${action}`) ? false : true
      assert.equal(payload[stage][action], expected, `saved ${stage}:${action} is ${expected}`)
    }
  }
  findButton(view.render(), 'reset').props.onClick()
  assert.equal(view.calls.length, 2, 'reset also saves')
  const resetPayload = view.calls[1].body.phaseRules
  for (const stage of STAGE_KEYS) {
    for (const action of RULE_ACTIONS) {
      assert.equal(resetPayload[stage][action], true, `reset restores ${stage}:${action} to checked`)
    }
  }
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
