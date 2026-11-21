/**
 * Dev self-check — a TERMINAL orphan card (e.g. canceled + a dead session id)
 * must not show a "取消卡片" button (which would re-cancel it). It should only
 * offer the permanent-delete action. Source-structure guards, in the style of
 * the other client dev-* tests (client.js has no DOM environment here).
 *
 * Implementation note: finish() already gives EVERY terminal card a
 * makeDeleteButton() on the single exit, including the orphan early-return.
 * So the orphan fast-path only has to stop pushing makeCancelButton() for
 * terminal states; pushing a delete button there too would DUPLICATE it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const client = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js'), 'utf8')
const orphanBlock = client.slice(client.indexOf('if (orphan) {'), client.indexOf("if (card.status === 'inbox')"))
const finishBlock = client.slice(client.indexOf('function finish() {'), client.indexOf('function Column('))
const deleteBtn = client.slice(client.indexOf('function makeDeleteButton()'), client.indexOf('function finish() {'))

test('Dev-OrphanTerminal: orphan fast-path gates cancel on non-terminal status', () => {
  assert.ok(orphanBlock.length > 0, 'orphan block found')
  assert.match(orphanBlock, /\['done', 'canceled'\]\.includes\(card\.status\)/,
    'orphan branch checks terminal status')
})

test('Dev-OrphanTerminal: terminal orphan gets delete (actDeleteCard), not cancel', () => {
  // The cancel button must sit INSIDE a `!terminal` guard — a terminal orphan
  // cannot reach makeCancelButton().
  assert.match(orphanBlock,
    /!\['done', 'canceled'\]\.includes\(card\.status\)\)(?:\s*\{\s*)?\s*buttons\.push\(makeCancelButton\(\)\)/,
    'orphan cancel is pushed only when NOT terminal')
  // finish() supplies the delete button on the same early-return path.
  assert.match(finishBlock,
    /\['done', 'canceled'\]\.includes\(card\.status\)\)\s*buttons\.push\(makeDeleteButton\(\)\)/,
    'terminal early-return (orphan included) gets delete button')
  assert.match(deleteBtn, /t\('actDeleteCard'\)/, 'delete button renders actDeleteCard label')
})

test('Dev-OrphanTerminal: non-terminal orphan still renders only cancel (regression)', () => {
  assert.match(orphanBlock, /buttons\.push\(makeCancelButton\(\)\)/, 'non-terminal orphan keeps cancel')
  assert.doesNotMatch(orphanBlock, /buttons\.push\(makeDeleteButton\(\)\)/,
    'no duplicate delete push in the orphan branch (finish() owns it)')
})

test('Dev-OrphanTerminal: regular (non-orphan) terminal guard unchanged', () => {
  assert.match(client, /if \(card\.status !== 'done' && card\.status !== 'canceled'\) \{\s*buttons\.push\(h\(Button, \{\s*key: 'cancelCard'/,
    'regular-path cancel gate untouched')
})
