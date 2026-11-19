/**
 * Client-module structural test.
 *
 * client.js is a browser script (window.__ModuleLoader__), so it cannot be
 * `import`ed by Node. This runs it in a vm with a tiny React shim + a fake
 * ModuleLoader, then exercises the real factory/apply contract and renders the
 * page once with empty data. That catches a broken export, a bad slot id, or a
 * render-time reference error without pretending to be a browser.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')

function reactShim() {
  return {
    createElement: (type, props, ...kids) => ({ type, props, kids }),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
  }
}

test('client registers a sidebar entry + main page, applies cleanly, and renders', () => {
  const code = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  let registered = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => { registered = def } } },
    require: (name) => {
      if (name === 'react') return reactShim()
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: () => null }
      throw new Error(`unexpected require: ${name}`)
    },
    fetch: async () => ({ ok: true, text: async () => '{}' }),
    console,
  }

  vm.runInNewContext(code, sandbox)

  assert.ok(registered, 'module loader was called')
  assert.equal(registered.id, '@summerscar/dsh-factory')

  const mod = registered.factory(sandbox.require)
  // `inject` was built inside the vm realm, so its Array prototype differs from
  // this realm's; Array.from normalises it before a strict deep-equal.
  assert.deepEqual(Array.from(mod.inject), ['slots', 'locale', 'uiWorkspace', 'sessions'])

  const slotCalls = []
  let localeRegistered = false
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    locale: { register: () => { localeRegistered = true }, bind: () => (key) => key },
    sessions: { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} } },
    uiWorkspace: { openSession: () => {} },
    slots: {
      inject: (ownerKey, callback) => { callback() },
      register: (options, Component) => { slotCalls.push({ options, Component }) },
    },
  }

  mod.apply(ctx)

  assert.equal(localeRegistered, true, 'locale dictionaries registered')
  assert.equal(slotCalls.length, 2, 'sidebar entry + main page registered')

  const sidebar = slotCalls.find((call) => call.options.name === 'sidebar.panellist')
  const main = slotCalls.find((call) => call.options.name === 'main')
  assert.ok(sidebar, 'sidebar.panellist entry registered')
  assert.ok(main, 'main page registered')

  // The sidebar list id and the main keyed-slot key must match, or selecting the
  // entry throws in the host. Both are `dsh-factory`.
  assert.equal(sidebar.options.id, 'dsh-factory')
  assert.equal(main.options.key, 'dsh-factory')
  assert.equal(typeof sidebar.Component, 'function', 'sidebar icon is a component')
  assert.equal(typeof main.Component, 'function', 'main page is a component')

  // Sidebar glyph renders at its given size without throwing, and stays currentColor.
  const icon = sidebar.Component({ size: 16, active: false })
  assert.ok(icon && typeof icon === 'object', 'sidebar icon renders an element')
  assert.match(icon.props.dangerouslySetInnerHTML.__html, /stroke="currentColor"/)
  assert.match(icon.props.dangerouslySetInnerHTML.__html, /width="16"/)

  // Render the page once with empty data — must not throw.
  const tree = main.Component({ t: (key) => key })
  assert.ok(tree && typeof tree === 'object', 'page renders an element')
})

test('board polls ONE revision probe and only then reloads the full set', () => {
  const code = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  assert.match(code, /\/state\/revision\$\{query\}/, 'the probe is scoped to the selected project')
  assert.match(code, /setInterval\(\(\) => \{[\s\S]{0,300}?\}, 5000\)/, 'a 5s probe timer exists')
  assert.match(code, /void poll\(\)/, 'the timer calls the probe, not the five reads')
  assert.match(code, /await load\(\{ silent: true \}\)/, 'a changed revision triggers a silent full load')
  assert.match(code, /if \(silent\) polling\.current = false/, 'polls are single-flight')
  assert.match(code, /visibilitychange/, 'returning to the tab refreshes immediately')
})

test('report panel sorts newest-first by default and persists the choice', () => {
  const code = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  assert.match(code, /REPORT_ORDER_KEY = `\$\{NS\}:reportOrder`/)
  assert.match(code, /=== 'asc' \? 'asc' : 'desc'/, 'unknown or missing preference is descending')
  assert.match(code, /localStorage\.setItem\(REPORT_ORDER_KEY, order\)/, 'choice persists in the browser')
  assert.match(code, /\.sort\(\(a, b\) => \(timeOf\(a\.entry\) - timeOf\(b\.entry\)\)/, 'ordinals follow chronological order')
  assert.match(code, /ordinal: index \+ 1/, 'numbers restart at 1 for this card')
  assert.match(code, /reports\.map\(\(\{ entry, ordinal \}\) =>/, 'display order never renumbers')
})

test('approve-plan waits for the session to finish', () => {
  const code = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  assert.match(code, /function CardActions\(\{ card, run, t, busy, working, onToast \}\)/)
  assert.match(code, /disabled: busy \|\| extra\.disabled === true/)
  assert.match(code, /card\.history\.some\(\(entry\) => entry && entry\.type === 'report'\)/, 'requires a plan report')
  assert.match(code, /\(working \|\| !hasReport\) \? \{ disabled: true, title: working \? t\('approvePlanWaiting'\) : t\('approvePlanNoReport'\) \}/)
  assert.match(code, /h\(CardActions, \{ key: 'actions', card, run, t, busy, working, onToast/)
})

test('session and report entries are part of the card body', () => {
  const code = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  assert.match(code, /h\(CardExtras, \{ key: 'extras', card, t, sessionRows, uiWorkspace, onOpenReports \}\)/, 'rendered inside Card')
  assert.doesNotMatch(code, /h\(Card, \{ key: 'card'[\s\S]{0,400}?\}\),\s*\n\s*h\(CardExtras/, 'no detached extras row')
})

test('commit and PR state travel with the card in every column', () => {
  const code = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  assert.match(code, /function DeliveryStatus\(/)
  assert.match(code, /h\(DeliveryStatus, \{ key: 'deliveryStatus', card, t \}\)/, 'rendered by Card itself, no stage gate')
  assert.match(code, /card\.commitSha/)
  assert.match(code, /card\.prUrl/)
  assert.match(code, /target: '_blank', rel: 'noopener noreferrer'/, 'the PR badge is a safe link')
  assert.match(code, /parsed\.protocol === 'http:' \|\| parsed\.protocol === 'https:'/, 'only http(s) links open')
})

test('the selected project is persisted and falls back when it disappears', () => {
  const code = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  assert.match(code, /PROJECT_KEY = `\$\{NS\}:selectedProject`/)
  assert.match(code, /localStorage\.getItem\(PROJECT_KEY\) \|\| ''/, 'restores the last project')
  assert.match(code, /localStorage\.setItem\(PROJECT_KEY, projectId\)/, 'saves each switch')
  assert.match(code, /!projects\.some\(\(entry\) => entry\.id === projectId\)/, 'missing project falls back')
})

test('report bodies render through the host Markdown primitive with raw HTML off', () => {
  const code = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  assert.match(code, /require\('@deepseek-ai\/dsh-client-ui-primitives'\)/, 'uses the host module-table package')
  assert.match(code, /h\(MarkdownText, \{[^}]*omitHtml: true/, 'raw HTML is not executed')
  assert.match(code, /labels: markdownLabels\(t\)/, 'fence/footnote copy is localized')
})

test('a running host session drives the card working animation', () => {
  const code = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  // The signal is the host session catalog's live Agent-busy bit, read from
  // the subscribed list snapshot — not a guessed status or a new backend field.
  assert.match(code, /sessionRows\[card\.sessionId\]\.running === true/)
  assert.match(code, /className: working \? 'df-card df-card-working' : 'df-card'/)
  assert.match(code, /@keyframes df-working-glow/)
  assert.match(code, /@keyframes df-working-pulse/)
  assert.match(code, /@keyframes df-working-sweep/, 'a top sweep bar is visible at a glance')
  assert.match(code, /className: 'df-working-bar'/)
  assert.doesNotMatch(code, /className: 'df-working-badge'/, 'no extra text on the card')
})
