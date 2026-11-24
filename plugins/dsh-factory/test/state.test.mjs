import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EDGE_ACTORS, STATUS, STATUSES, SYNC_AUTO_EDGES, SYNC_RULE_ACTOR,
  assertTransition, canTransition, isTerminal, nextStatuses,
} from '../state.js'

test('PR review → Done is syncRule-only; agents and humans cannot finish a card', () => {
  assert.equal(canTransition(STATUS.PR_REVIEW, STATUS.DONE, 'agent'), false)
  assert.equal(canTransition(STATUS.PR_REVIEW, STATUS.DONE, 'human'), false)
  assert.equal(canTransition(STATUS.PR_REVIEW, STATUS.DONE, 'autoRule'), false)
  assert.equal(canTransition(STATUS.PR_REVIEW, STATUS.DONE, SYNC_RULE_ACTOR), true)
  assert.equal(assertTransition(STATUS.PR_REVIEW, STATUS.DONE, SYNC_RULE_ACTOR), true)
  assert.throws(() => assertTransition(STATUS.PR_REVIEW, STATUS.DONE, 'human'), /非法转移/)
})

test('plan → build is automatic; self-review owns the reviewer edges', () => {
  assert.equal(canTransition(STATUS.PLAN, STATUS.BUILD, 'autoRule'), true)
  assert.equal(canTransition(STATUS.BUILD, STATUS.SELF_REVIEW, 'agent'), true)
  assert.equal(canTransition(STATUS.SELF_REVIEW, STATUS.BUILD, 'agent'), true)
  assert.equal(canTransition(STATUS.SELF_REVIEW, STATUS.PR_REVIEW, 'agent'), true)
  assert.equal(canTransition(STATUS.INBOX, STATUS.PR_REVIEW, 'agent'), false)
})

test('agent-driven stages are the only ones an agent may advance', () => {
  assert.equal(canTransition(STATUS.INBOX, STATUS.TRIAGE, 'agent'), false)
  assert.equal(canTransition(STATUS.TRIAGE, STATUS.PLAN, 'agent'), true)
  assert.equal(canTransition(STATUS.PLAN, STATUS.BUILD, 'agent'), true)
  assert.equal(canTransition(STATUS.BUILD, STATUS.SELF_REVIEW, 'agent'), true)
  assert.equal(canTransition(STATUS.PR_REVIEW, STATUS.DONE, 'agent'), false)
})

test('illegal jumps and removed legacy stages are rejected', () => {
  assert.equal(STATUSES.includes('plan-review'), false)
  assert.equal(STATUSES.includes('review'), false)
  assert.equal(canTransition(STATUS.TRIAGE, STATUS.BUILD, 'agent'), false)
  assert.equal(canTransition(STATUS.PLAN, STATUS.DONE, 'human'), false)
  assert.equal(canTransition(STATUS.BUILD, STATUS.PR_REVIEW, 'agent'), false)
  assert.throws(() => assertTransition(STATUS.TRIAGE, STATUS.BUILD, 'agent'), /非法转移/)
})

test('terminal statuses accept no outgoing edge, including remote sync', () => {
  for (const status of [STATUS.DONE, STATUS.CANCELED]) {
    assert.equal(isTerminal(status), true)
    assert.equal(canTransition(status, STATUS.BUILD, 'human'), false)
    assert.equal(canTransition(status, STATUS.DONE, SYNC_RULE_ACTOR), false)
  }
})

test('a draft PR keeps the card in pr-review; only the merge edge finishes it', () => {
  assert.ok(nextStatuses(STATUS.SELF_REVIEW).includes(STATUS.PR_REVIEW))
  assert.deepEqual(SYNC_AUTO_EDGES, ['pr-review->done'])
  assert.equal(Object.prototype.hasOwnProperty.call(EDGE_ACTORS, 'pr-review->done'), false)
})
