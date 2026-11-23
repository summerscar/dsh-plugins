/**
 * Dev self-check for AC43 return/takeover risk hints:
 *  - two new copy keys exist in all four dictionaries
 *  - the risk notice / toast line are gated to machine-approve + auto-delivery
 *  - NoteModal's optional notice never becomes the textarea placeholder
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

const RISK_ZH = '当前档位会自动接管此卡，修订后的计划不会被自动批准；批准时可交还引擎。'
const RISK_EN = "This tier takes over the card automatically, so the revised plan won't be auto-approved; release it when approving."
const NOTICE_ZH = '这张计划评审卡会在下一 tick 被自动批准。'
const NOTICE_EN = 'This plan-review card will be auto-approved on the next tick.'

test('Dev-AC43: two new keys exist in all four dictionaries', () => {
  assert.equal(zh.notePromptReturnPlanRisk, RISK_ZH)
  assert.equal(en.notePromptReturnPlanRisk, RISK_EN)
  assert.equal(zh.returnWithAutoApproveNotice, NOTICE_ZH)
  assert.equal(en.returnWithAutoApproveNotice, NOTICE_EN)
  assert.ok(client.includes(`notePromptReturnPlanRisk: ${JSON.stringify(RISK_ZH)}`), 'inline zh mirrors locale')
  assert.ok(client.includes(`notePromptReturnPlanRisk: ${JSON.stringify(RISK_EN)}`), 'inline en mirrors locale')
  assert.ok(client.includes(`returnWithAutoApproveNotice: ${JSON.stringify(NOTICE_ZH)}`), 'inline zh notice mirrors locale')
  assert.ok(client.includes(`returnWithAutoApproveNotice: ${JSON.stringify(NOTICE_EN)}`), 'inline en notice mirrors locale')
})

test('Dev-AC43: risk notice and toast line are gated to the two auto-approve tiers', () => {
  // tier is wired from the project's saved autonomy level into CardActions.
  assert.match(client, /function CardActions\(\{ card, run, t, busy, working, reviewWorking, onToast, onModal, tier, orphan \}\)/)
  assert.match(client, /h\(CardActions,[\s\S]{0,260}tier: project\?\.autonomy/)
  // The gate itself names exactly the two tiers.
  const gate = client.match(/const needsAutoApproveNotice = \(tier\) =>[^\n]*/)?.[0]
  assert.ok(gate, 'tier gate helper found')
  assert.match(gate, /machine-approve/)
  assert.match(gate, /auto-delivery/)
  // Return-to-plan computes the notice through the gate, then passes it to askNote.
  assert.match(client, /const risk = needsAutoApproveNotice\(tier\) \? t\('notePromptReturnPlanRisk'\) : undefined/)
  assert.match(client, /await askNote\(t\('notePromptReturnPlan'\), risk\)/)
  // Release toast appends only for auto-approve tiers AND plan-review cards.
  assert.match(client, /needsAutoApproveNotice\(tier\) && card\.status === 'plan-review'[\s\S]{0,160}returnWithAutoApproveNotice/)
})

test('Dev-AC43: NoteModal notice never becomes the textarea placeholder', () => {
  const noteModal = client.slice(client.indexOf('function NoteModal('), client.indexOf('function AutonomySection('))
  assert.ok(noteModal.length > 0, 'NoteModal found')
  assert.match(noteModal, /function NoteModal\(\{ message, t, onSubmit, onCancel, notice, context \}\)/, 'notice and read-only context props accepted')
  assert.match(noteModal, /placeholder: message/, 'placeholder stays the plain message')
  assert.doesNotMatch(noteModal, /placeholder: notice/, 'notice never becomes the placeholder')
  // Warning notice rendered between the hint and the textarea, using theme tokens.
  assert.match(noteModal, /notice \?[\s\S]{0,260}T\.warningWash[\s\S]{0,260}T\.warningInk[\s\S]{0,160}notice/)
  const hintAt = noteModal.indexOf("key: 'hint'")
  const contextAt = noteModal.indexOf('context ?')
  const noticeAt = noteModal.indexOf('notice ?')
  const textareaAt = noteModal.indexOf("key: 'note'")
  assert.ok(hintAt < contextAt && contextAt < noticeAt && noticeAt < textareaAt, 'context and notice sit between hint and textarea')
})
