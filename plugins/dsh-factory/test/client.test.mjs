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
  }
}

test('client registers a sidebar entry + main page, applies cleanly, and renders', () => {
  const code = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  let registered = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => { registered = def } } },
    require: (name) => {
      if (name === 'react') return reactShim()
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
  assert.deepEqual(Array.from(mod.inject), ['slots', 'locale'])

  const slotCalls = []
  let localeRegistered = false
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    locale: { register: () => { localeRegistered = true }, bind: () => (key) => key },
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
