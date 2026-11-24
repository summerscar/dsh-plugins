/**
 * Dev self-check — board/settings PR-review wording and the stage-rule
 * advanced panel's empty state.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { clientSource } from './dev-v4-support.mjs'

const source = clientSource()
const zh = JSON.parse(readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))
const en = JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))

test('Dev-Copy: board column and settings stage both say PR review', () => {
  assert.equal(zh.colReview, 'PR 评审')
  assert.equal(en.colReview, 'PR review')
  assert.equal(zh.stagePrReview, 'PR 评审')
  assert.equal(en.stagePrReview, 'PR review')
  assert.match(source, /colReview:\s*"PR 评审"/)
  assert.match(source, /colReview:\s*"PR review"/)
  assert.match(source, /stagePrReview:\s*"PR 评审"/)
})

test('Dev-Copy: advanced panel title and hint use the final read-only wording', () => {
  const titleZh = '高级：收窄状态（只读）'
  const titleEn = 'Advanced: narrowing status (read-only)'
  const hintZh = '取消上面阶段的勾选即可让它停等人；此处只显示当前收窄摘要，不可编辑。'
  const hintEn = 'Uncheck a stage above to pause it for a human; this area only shows the current narrowing summary and is read-only.'
  assert.equal(zh.whenAdvancedTitle, titleZh)
  assert.equal(en.whenAdvancedTitle, titleEn)
  assert.equal(zh.whenAdvancedHint, hintZh)
  assert.equal(en.whenAdvancedHint, hintEn)
  for (const value of [titleZh, titleEn, hintZh, hintEn]) assert.ok(source.includes(value), `inline copy missing: ${value}`)
  assert.ok(!source.includes('收窄条件（仅让人审）') && !zh.whenAdvancedTitle.includes('收窄条件（仅让人审）'))
  assert.ok(!source.includes('narrow the rules (human review only)') && !en.whenAdvancedTitle.includes('narrow the rules (human review only)'))
})

test('Dev-Copy: advanced stage rules are not blank when nothing is narrowed', () => {
  const body = source.slice(source.indexOf("h('button', { key: 'advanced'"), source.indexOf("h('div', { key: 'safety'"))
  assert.match(body, /t\('whenAdvancedHint'\)/)
  assert.match(body, /whenNoNarrow/, 'the empty state must show the default-full-auto hint')
  assert.doesNotMatch(body, /disabled:\s*true/, 'the advanced block stays readable even with all defaults')
})
