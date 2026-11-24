/**
 * Dev self-check — PR-review wording, stage-rule panel shape, purpose copy
 * and the build marker that lets the real machine distinguish this change.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { clientSource } from './dev-v4-support.mjs'

const source = clientSource()
const zh = JSON.parse(readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))
const en = JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))
const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const deadKeys = ['whenAdvancedTitle', 'whenAdvancedHint', 'whenNoNarrow']

test('Dev-Copy: board column and settings stage both say PR review', () => {
  assert.equal(zh.colReview, 'PR 评审')
  assert.equal(en.colReview, 'PR review')
  assert.equal(zh.stagePrReview, 'PR 评审')
  assert.equal(en.stagePrReview, 'PR review')
  assert.match(source, /colReview:\s*"PR 评审"/)
  assert.match(source, /colReview:\s*"PR review"/)
  assert.match(source, /stagePrReview:\s*"PR 评审"/)
})

test('Dev-UI: advanced fold and its three dictionary keys are gone', () => {
  for (const key of deadKeys) {
    assert.ok(!(key in zh), `locale/zh.json still has dead key ${key}`)
    assert.ok(!(key in en), `locale/en.json still has dead key ${key}`)
    assert.ok(!source.includes(key), `client.js still has dead key ${key}`)
  }
  assert.doesNotMatch(source, /setAdvance\(|key: 'advanced'|advancedBody/)
  assert.match(source, /stageConfigTitle/)
  assert.match(source, /autoStartLabel/)
  assert.match(source, /autoApproveLabel/)
  assert.match(source, /key: 'safety'/)
  assert.match(source, /key: 'save'/)
  assert.match(source, /key: 'reset'/)
})

test('Dev-Copy: stage purpose explains unchecking pauses a stage for a human', () => {
  const purposeZh = '默认全速自动；取消某阶段的勾选即可让它停等人。'
  const purposeEn = 'Full auto by default; uncheck a stage to pause it for a human.'
  assert.equal(zh.stageConfigPurpose, purposeZh)
  assert.equal(en.stageConfigPurpose, purposeEn)
  assert.ok(source.includes(`stageConfigPurpose: "${purposeZh}"`))
  assert.ok(source.includes(`stageConfigPurpose: "${purposeEn}"`))
  assert.doesNotMatch(JSON.stringify(zh), /高级设置只收窄/)
  assert.doesNotMatch(JSON.stringify(en), /advanced rules only narrow it/)
})

test('Dev-Build: build marker is .58 for real-machine distinction', () => {
  assert.match(indexSource, /export const BUILD = 'factory-2026-11-20\.58'/)
})
