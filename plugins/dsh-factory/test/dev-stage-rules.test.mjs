/**
 * Dev self-check — stage rules: six flow rows, four editable gates, eight
 * fixed-on disabled gates, and the copy that says so in all four carriers.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { clientSource } from './dev-v4-support.mjs'

const source = clientSource()
const zh = JSON.parse(readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))
const en = JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))
const sectionStart = source.indexOf('function StageConfigSection')
const sectionEnd = source.indexOf('function PauseSection')
const section = source.slice(sectionStart, sectionEnd)

const EDITABLE = ['inbox:autoStart', 'plan:autoApprove', 'self-review:autoStart', 'pr-review:autoStart']
const LOCKED = [
  'inbox:autoApprove',
  'triage:autoStart', 'triage:autoApprove',
  'plan:autoStart',
  'build:autoStart', 'build:autoApprove',
  'self-review:autoApprove',
  'pr-review:autoApprove',
]

test('Dev-Stages: six rows render in flow order with a distinct inbox stage', () => {
  assert.ok(sectionStart >= 0 && sectionEnd > sectionStart, 'stage section is present')
  const table = section.match(/const stages = \[([\s\S]*?)\]\s*\n/)
  assert.ok(table, 'stage table is present')
  const rows = [...table[1].matchAll(/\['([^']+)', '([^']+)'\]/g)].map((m) => `${m[1]}:${m[2]}`)
  assert.deepEqual(rows, [
    'inbox:stageInbox', 'triage:stageTriage', 'plan:stagePlan',
    'build:stageBuild', 'self-review:stageSelfReview', 'pr-review:stagePrReview',
  ])
})

test('Dev-Stages: exactly four engine-backed gates stay editable', () => {
  const editable = section.match(/const editableRules = new Set\(\[([\s\S]*?)\]\)\s*\n/)
  assert.ok(editable, 'editable rule set is present')
  const rules = [...editable[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(rules, EDITABLE)
  for (const rule of LOCKED) assert.ok(!rules.includes(rule), `${rule} must not be editable`)
})

test('Dev-Stages: locked gates are fixed on, disabled, hinted and normalized on save', () => {
  assert.ok(section.includes('locked = !editableRules.has'), 'locked flag derives from the editable set')
  assert.ok(section.includes('checked: locked ? true'), 'locked checkbox is always checked')
  assert.ok(section.includes('disabled: true'), 'locked checkbox is disabled')
  assert.ok(section.includes("title: t('stageRuleLockedHint')"), 'locked input and label carry the hint')
  assert.ok(section.includes('onChange: (event) => setRules'), 'editable checkbox still updates local rules')
  assert.ok(section.includes('const payload = normalize(next)'), 'save normalizes the payload')
  assert.ok(section.includes('phaseRules: payload'), 'normalized payload is what gets saved')
  assert.ok(section.includes('next[key][action] = true'), 'locked stored values are forced true')
  assert.ok(section.includes('normalize(project?.phaseRules)'), 'initial state is normalized too')
})

test('Dev-Copy: new stage keys and purpose are mirrored in all four carriers', () => {
  const purposeZh = '默认全速自动。只有这 4 个勾选可取消，取消后该段停下等人：收件箱-自动启动、规划-自动批准、自审-自动启动、PR 评审-自动启动。其余勾选固定开启、置灰不可改——这些阶段当前没有可单独关闭的自动步骤。'
  const purposeEn = 'Full auto by default. Only four checkboxes can be turned off, pausing that stage for a human: Inbox auto-start, Planning auto-approve, Self-review auto-start, PR review auto-start. The rest are fixed on and greyed out — those stages currently have no separately switchable automatic step.'
  const hintZh = '该阶段目前没有可单独关闭的自动步骤，此勾选固定开启、不可修改。'
  const hintEn = 'This stage has no separately switchable automatic step; this checkbox is fixed on and cannot be changed.'
  assert.equal(zh.stageInbox, '收件箱')
  assert.equal(en.stageInbox, 'Inbox')
  assert.equal(zh.stageRuleLockedHint, hintZh)
  assert.equal(en.stageRuleLockedHint, hintEn)
  assert.equal(zh.stageConfigPurpose, purposeZh)
  assert.equal(en.stageConfigPurpose, purposeEn)
  for (const [key, value] of [
    ['stageInbox', '收件箱'], ['stageInbox', 'Inbox'],
    ['stageRuleLockedHint', hintZh], ['stageRuleLockedHint', hintEn],
    ['stageConfigPurpose', purposeZh], ['stageConfigPurpose', purposeEn],
  ]) assert.ok(source.includes(`${key}: "${value}"`), `client.js inline dictionary has ${key}`)
  for (const dict of [source, JSON.stringify(zh), JSON.stringify(en)]) {
    assert.doesNotMatch(dict, /取消某阶段的勾选即可让它停等人/)
    assert.doesNotMatch(dict, /uncheck a stage to pause it for a human/)
  }
})
