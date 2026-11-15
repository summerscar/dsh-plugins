/**
 * Structural smoke test for the package layout.
 *
 * The package is zero-build and zero-runtime-dependency, so this asserts the
 * Host entry loads and the manifest is complete; behavioural coverage lives in
 * the per-module test files.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))

test('package identity and workspace location', () => {
  assert.equal(manifest.name, '@summerscar/dsh-factory')
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.main, 'index.js')
  assert.equal(manifest.license, 'SEE LICENSE IN LICENSE')
  // The two declarations must agree, and both must be an open lower bound — an
  // upper bound would make the loader miss a newer host and disable the plugin.
  assert.equal(manifest.engines.dsh, manifest.dsh.compatibility.dsh)
  assert.match(manifest.engines.dsh, /^>=/)
  assert.equal(manifest.repository.directory, 'plugins/dsh-factory')
  assert.equal(manifest.publishConfig.access, 'public')
  assert.equal(manifest.publishConfig.registry, 'https://registry.npmjs.org/')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale'))
})

test('every declared export subpath resolves to a real file', () => {
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    const resolved = subpath.includes('*')
      ? join(packageRoot, target.replace('*', 'en'))
      : join(packageRoot, target)
    assert.ok(existsSync(resolved), `${subpath} -> ${target} is missing`)
  }
})

test('every packed file exists', () => {
  for (const entry of manifest.files) {
    if (entry.includes('*')) continue // glob: the directory is checked below
    assert.ok(existsSync(join(packageRoot, entry)), `packed file missing: ${entry}`)
  }
  assert.ok(existsSync(join(packageRoot, 'locale')))
  assert.ok(existsSync(join(packageRoot, 'docs')))
})

test('the Host entry loads and declares its contract', async () => {
  const host = await import(new URL('../index.js', import.meta.url))
  assert.equal(host.name, 'dsh-factory')
  assert.equal(typeof host.BUILD, 'string')
  assert.ok(Array.isArray(host.inject))
  assert.equal(typeof host.apply, 'function')
})

test('Chinese and English discovery metadata stay in step', () => {
  const dictionaries = ['zh', 'en'].map((language) => {
    const file = join(packageRoot, 'locale', `${language}.json`)
    assert.ok(existsSync(file), `${language}.json is missing`)
    return JSON.parse(readFileSync(file, 'utf8'))
  })
  for (const dictionary of dictionaries) {
    assert.ok(typeof dictionary.meta?.title === 'string' && dictionary.meta.title.trim())
    assert.ok(typeof dictionary.meta?.description === 'string' && dictionary.meta.description.trim())
  }
  assert.deepEqual(Object.keys(dictionaries[0]).sort(), Object.keys(dictionaries[1]).sort())
})
