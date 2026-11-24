import assert from 'node:assert/strict'
import test from 'node:test'
import { clientSource, makeFixture, renderCardActions } from './dev-v4-support.mjs'

const source = clientSource()

test('Dev-ReviewUI: no manual review-dispatch or write button in V4', () => {
  for (const status of ['self-review', 'pr-review']) {
    const f = makeFixture({ status })
    try {
      const { keys } = renderCardActions(f.card)
      assert.equal(keys.includes('actRedispatchReview'), false)
      assert.equal(keys.includes('actDispatchReview'), false)
      assert.equal(keys.includes('actConfirmCommit'), false)
    } finally { f.cleanup() }
  }
})

test('Dev-ReviewUI: stage strip and boundary are visible', () => {
  assert.match(source, /h\(StageStrip, /)
  assert.match(source, /t\('writeBoundaryNotice'\)/)
  assert.match(source, /t\('writeBoundaryDetail'\)/)
})

test('Dev-ReviewUI: project panel uses stage rules, not a level slider', () => {
  assert.match(source, /function StageConfigSection\(/)
  assert.doesNotMatch(source, /LEVEL_TIERS|storedToLevel|saveLevel/)
})

test('Dev-ReviewUI: pr-review cards remain actionable for takeover/abandon', () => {
  const f = makeFixture({ status: 'pr-review' })
  try {
    const { keys } = renderCardActions(f.card)
    assert.ok(keys.includes('takeover'))
    assert.ok(keys.includes('cancelCard'))
  } finally { f.cleanup() }
})
