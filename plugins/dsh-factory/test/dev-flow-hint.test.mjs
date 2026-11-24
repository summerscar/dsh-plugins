import assert from 'node:assert/strict'
import test from 'node:test'
import { clientSource } from './dev-v4-support.mjs'

const source = clientSource()
const body = source.slice(source.indexOf('function cardFlowHintKey('), source.indexOf('const STAGE_FLOW'))
const cardFlowHintKey = new Function('ctx', `${body}\nreturn cardFlowHintKey`)()

test('Dev-Flow: base text follows V4 stages', () => {
  assert.equal(cardFlowHintKey({ status: 'inbox' }), 'flowInboxAuto')
  assert.equal(cardFlowHintKey({ status: 'triage' }), 'flowTriageAuto')
  assert.equal(cardFlowHintKey({ status: 'plan' }), 'flowPlanAuto')
  assert.equal(cardFlowHintKey({ status: 'build' }), 'flowBuildAuto')
  assert.equal(cardFlowHintKey({ status: 'self-review' }), 'selfReviewRunning')
  assert.equal(cardFlowHintKey({ status: 'pr-review' }), 'prReviewWaitMerge')
})

test('Dev-Flow: terminal and blocked states keep their priority', () => {
  assert.equal(cardFlowHintKey({ status: 'done' }), 'flowDone')
  assert.equal(cardFlowHintKey({ status: 'canceled' }), 'flowCanceled')
  assert.equal(cardFlowHintKey({ status: 'build', orphan: true }), 'orphanWhy')
  assert.equal(cardFlowHintKey({ status: 'build', needsHumanInfo: true }), 'flowNeedsInfo')
  assert.equal(cardFlowHintKey({ status: 'build', paused: true }), 'flowPaused')
})

test('Dev-Flow: stopped session overrides auto text where it matters', () => {
  assert.equal(cardFlowHintKey({ status: 'build', sessionId: 's1', working: false }), 'flowSessionStopped')
  assert.equal(cardFlowHintKey({ status: 'build', sessionId: 's1', working: true }), 'flowBuildAuto')
})

test('Dev-Flow: no legacy tier or plan-review hint survives', () => {
  assert.doesNotMatch(source, /flowPlanReviewAuto|flowReviewManual|flowReviewAuto/)
  assert.doesNotMatch(body, /autoDispatch|tier === 'auto-delivery'/)
})

test('Dev-Flow: stage strip is present', () => {
  assert.match(source, /const STAGE_FLOW = \[/)
  assert.match(source, /\['self-review', 'stageSelfReview'\]/)
  assert.match(source, /\['pr-review', 'stagePrReview'\]/)
})
