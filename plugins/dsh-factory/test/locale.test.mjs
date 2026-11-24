/**
 * Locale completeness guard (regression for the real-env nav bug).
 *
 * The board page drives every visible string through `t('key')`, and its sidebar
 * `sidebar.panellist` navigation label through `t('navLabel')`. A missing key
 * made that label undefined, so the page had no sidebar entry and rendered blank
 * text. This asserts the packaged zh/en dictionaries actually contain every key
 * the page uses, in both languages and in step.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')

// Every UI key client.js resolves via t(): literal keys plus the column labelKeys
// used through t(column.labelKey).
// V4 matrix: no human git-write / mark-done buttons; the self-review column is
// labelled by the stage dictionary key, and card actions are dispatch/resupply,
// return, takeover/release, cancel and terminal delete.
const REQUIRED_UI_KEYS = [
  'navLabel', 'refresh', 'loading', 'errorPrefix',
  'noProjects', 'projectName', 'rootPath', 'newBoard', 'newCard',
  'create', 'project', 'board', 'inbox', 'inboxEmpty',
  'colPlanning', 'colBuilding', 'colReview', 'colDone', 'stageSelfReview', 'canceled', 'emptyColumn',
  'actDispatch', 'actResupply', 'actReturnToInbox', 'takeover', 'cancelCard', 'actDeleteCard',
]

test('every UI key client.js uses exists in both zh and en dictionaries', () => {
  const dicts = Object.fromEntries(['zh', 'en'].map((lang) => [
    lang, JSON.parse(readFileSync(join(packageRoot, 'locale', `${lang}.json`), 'utf8')),
  ]))
  for (const lang of ['zh', 'en']) {
    for (const key of REQUIRED_UI_KEYS) {
      assert.ok(typeof dicts[lang][key] === 'string' && dicts[lang][key].length > 0, `${lang}.json missing UI key: ${key}`)
    }
    assert.ok(typeof dicts[lang].meta?.title === 'string' && dicts[lang].meta.title.length > 0)
  }
  // zh and en must stay structurally in step.
  assert.deepEqual(Object.keys(dicts.zh).sort(), Object.keys(dicts.en).sort())
})
