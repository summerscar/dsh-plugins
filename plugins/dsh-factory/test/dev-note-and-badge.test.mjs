/**
 * Dev self-check for the ROADMAP 5.1 UI gaps:
 *  - window.prompt is gone; all four note actions use the in-page note modal
 *  - needsHumanInfo is rendered as a badge on the shared card component
 *  - needsInfoBadge copy exists in all four dictionaries
 */
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

test('Dev-Note: no native window.prompt; all four note actions await the in-page modal', () => {
  assert.doesNotMatch(client, /window\.prompt/, 'native browser prompt removed')
  assert.match(client, /const askNote = \(message\) => new Promise/, 'askNote is now promise-based')
  // The four actions that need a note: resupply, return-inbox, return-plan, return-build.
  assert.equal((client.match(/await askNote\(/g) || []).length, 4, 'all four actions await the note modal')
  const noteModal = client.slice(client.indexOf('function NoteModal('), client.indexOf('function AutonomySection('))
  assert.ok(noteModal.length > 0, 'NoteModal component found')
  assert.match(noteModal, /h\('textarea'/, 'note modal uses a textarea')
  assert.match(noteModal, /confirmDisabled:[^\n]*trim\(\)/, 'empty/whitespace note cannot be submitted')
  assert.match(noteModal, /onCancel/, 'cancel resolves to no note')
  // The badge copy is reused as the modal hint/placeholder via the notePrompt* keys.
  for (const key of ['notePromptResupply', 'notePromptReturnInbox', 'notePromptReturnPlan', 'notePromptReturnBuild']) {
    assert.ok(zh[key] && en[key], `${key} exists in both locales`)
  }
})

test('Dev-Note: needsHumanInfo renders a badge on the shared card (board + inbox)', () => {
  assert.match(client, /function NeedsInfoBadge\(/, 'NeedsInfoBadge component exists')
  const cardFn = client.slice(client.indexOf('function Card({'), client.indexOf('function CardExtras'))
  assert.match(cardFn, /card\.needsHumanInfo === true \? h\(NeedsInfoBadge/, 'flagged cards render the badge')
  const inboxMap = client.indexOf('inboxCards.map(renderCard)')
  assert.ok(inboxMap > 0, 'inbox list uses the same renderCard, so the badge shows there too')
})

test('Dev-Note: needsInfoBadge copy is present in all four dictionaries', () => {
  assert.equal(zh.needsInfoBadge, '待补充信息')
  assert.equal(en.needsInfoBadge, 'Needs info')
  assert.ok(client.includes(`needsInfoBadge: ${JSON.stringify(zh.needsInfoBadge)}`), 'inline zh mirrors locale/zh.json')
  assert.ok(client.includes(`needsInfoBadge: ${JSON.stringify(en.needsInfoBadge)}`), 'inline en mirrors locale/en.json')
})
