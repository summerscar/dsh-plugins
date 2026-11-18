/**
 * i18n parity guard — the inline client dictionaries and the packaged
 * locale/*.json UI dictionaries must stay byte-for-byte equal.
 *
 * The page renders from the inline `ctx.locale.register(NS, { zh, en })` dicts
 * (the DSH pattern), while locale/*.json carries `meta` for the plugin manager
 * plus a redundant copy of the UI keys. Two copies drift silently otherwise —
 * this runs the real client factory in a vm, captures the dictionaries it
 * registers, and asserts they match the JSON files exactly.
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

function captureInlineDictionaries() {
  const code = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  let registered = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => { registered = def } } },
    require: (name) => { if (name === 'react') return reactShim(); throw new Error(`unexpected require: ${name}`) },
    fetch: async () => ({ ok: true, text: async () => '{}' }),
    console,
  }
  vm.runInNewContext(code, sandbox)
  const mod = registered.factory(sandbox.require)
  let captured = null
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    locale: { register: (ns, dicts) => { captured = dicts; return () => {} }, bind: () => (key) => key },
    slots: { inject: (ok, cb) => cb(), register: () => () => {} },
  }
  mod.apply(ctx)
  assert.ok(captured, 'client registered its locale dictionaries')
  // Normalise cross-realm objects to plain JSON.
  return JSON.parse(JSON.stringify(captured))
}

function localeUi(lang) {
  const file = JSON.parse(readFileSync(join(packageRoot, 'locale', `${lang}.json`), 'utf8'))
  const { meta, ...ui } = file
  assert.ok(meta && typeof meta.title === 'string')
  return ui
}

test('inline client dictionaries match the packaged locale UI keys exactly', () => {
  const inline = captureInlineDictionaries()
  for (const lang of ['zh', 'en']) {
    assert.deepEqual(inline[lang], localeUi(lang), `inline ${lang} dictionary drifted from locale/${lang}.json`)
  }
})
