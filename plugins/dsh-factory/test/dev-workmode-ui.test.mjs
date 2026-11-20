import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const client = readFileSync(join(root, 'client.js'), 'utf8')
const zh = JSON.parse(readFileSync(join(root, 'locale', 'zh.json'), 'utf8'))
const en = JSON.parse(readFileSync(join(root, 'locale', 'en.json'), 'utf8'))

const KEYS = [
  'workModeTitle', 'workModePurpose',
  'workModeWorkspace', 'workModeWorkspaceDesc',
  'workModeFull', 'workModeFullDesc',
  'workModeAuto', 'workModeAutoDesc',
  'autoReviewUnavailable', 'autoReviewRisk', 'autoReviewFallback',
  'workModeConfirm', 'confirmMode',
]

test('Dev-UI: work mode reuses the worktree block native save (no second save button)', () => {
  const setup = client.slice(client.indexOf('function WorktreeSetup('), client.indexOf('function WorktreesRootSetting('))
  assert.match(setup, /function WorktreeSetup\(\{ project, engine, t, onSaved, onModal \}\)/)
  assert.match(client, /block\('prep', '01'[\s\S]{0,300}project, engine, t[\s\S]{0,200}onModal: setPageModal/)
  assert.ok(setup.includes("key: 'modeBlock'"), 'mode selector inside WorktreeSetup')
  assert.match(setup, /role: 'radiogroup'/)
  assert.match(setup, /role: 'radio'/)
  for (const value of ['workspace-write', 'full-access', 'auto-review']) {
    assert.ok(setup.includes(`key: '${value}'`), `mode option ${value} present`)
  }
  // The API rejects mixed PATCH shapes, so the single worktree save button
  // sends the preparation PATCH and, when needed, a workMode PATCH in sequence.
  assert.match(setup, /if \(dirty\) \{[\s\S]{0,500}copyFiles:/, 'preparation PATCH gated by prep dirty')
  assert.match(setup, /if \(modeDirty\) \{[\s\S]{0,300}workMode: mode/, 'workMode PATCH gated by mode dirty')
  assert.doesNotMatch(setup, /saveMode\b|modeSaving|modeMessage|modeError/, 'no second save function/state remains')
  const modeBlock = setup.slice(setup.indexOf("key: 'modeBlock'"), setup.indexOf("key: 'saveRow'"))
  assert.doesNotMatch(modeBlock, /h\(Button/, 'mode block has no own save button')
  assert.match(setup, /disabled: saving \|\| invalid \|\| \(!dirty && !modeDirty\)/, 'the only save button covers both changes')
})

test('Dev-UI: auto-review is fail-closed in the selector and confirmed on risky switches', () => {
  assert.match(client, /autoAvailable = engine\?\.autoReviewPluginState\?\.available === true/)
  assert.match(client, /key: 'auto-review'[\s\S]{0,160}disabled: !autoAvailable/)
  assert.match(client, /t\('autoReviewUnavailable'\)/)
  assert.match(client, /savedMode === 'auto-review' && !autoAvailable/)
  assert.match(client, /t\('autoReviewFallback'\)/)
  assert.match(client, /next === 'full-access' \|\| next === 'auto-review'/)
  assert.match(client, /t\(next === 'full-access' \? 'workModeConfirm' : 'autoReviewRisk'\)/)
})

test('Dev-UI: project list badges use L0-L4 labels, not the legacy semantic names', () => {
  assert.doesNotMatch(client, /t\(LEVEL_META\[lv\]\.badge\)/)
  const levelBadges = client.match(/t\(`lvL\$\{lv\}`\)/g) || []
  assert.ok(levelBadges.length >= 2, 'sidebar rail and top tabs both render L0-L4')
  for (const n of [0, 1, 2, 3, 4]) {
    assert.ok(zh[`lvL${n}`] === `L${n}`, `zh lvL${n}`)
    assert.ok(en[`lvL${n}`] === `L${n}`, `en lvL${n}`)
  }
})

test('Dev-UI: work-mode copy is mirrored in inline dictionaries and locale files', () => {
  for (const key of KEYS) {
    assert.ok(zh[key], `zh.${key} present`)
    assert.ok(en[key], `en.${key} present`)
    assert.ok(client.includes(`${key}: ${JSON.stringify(zh[key])}`), `inline zh.${key} mirrors locale`)
    assert.ok(client.includes(`${key}: ${JSON.stringify(en[key])}`), `inline en.${key} mirrors locale`)
  }
})
