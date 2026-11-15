/**
 * Status-machine tests — the §8 transfer table and the hard human-only rules.
 * These are the highest-value assertions in the plugin: if the machine lets an
 * agent reach Done or skip a review gate, everything downstream is unsafe.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PR_SUCCESS_STAYS,
  STATUS,
  agentCanReach,
  assertTransition,
  canTransition,
  isTerminal,
} from '../state.js'

test('Review → Done is human-only; an agent can never move a card into Done', () => {
  assert.equal(canTransition(STATUS.REVIEW, STATUS.DONE, 'human'), true)
  assert.equal(canTransition(STATUS.REVIEW, STATUS.DONE, 'agent'), false)
  assert.equal(canTransition(STATUS.REVIEW, STATUS.DONE, 'autoRule'), false)
  assert.throws(() => assertTransition(STATUS.REVIEW, STATUS.DONE, 'agent'), /不允许由 agent 触发/)
  // The blanket rule holds no matter which status the agent starts from.
  assert.equal(agentCanReach(STATUS.DONE), false)
})

test('Plan-Review → Build admits a human and an autoRule, never an agent', () => {
  assert.equal(canTransition(STATUS.PLAN_REVIEW, STATUS.BUILD, 'human'), true)
  assert.equal(canTransition(STATUS.PLAN_REVIEW, STATUS.BUILD, 'autoRule'), true)
  assert.equal(canTransition(STATUS.PLAN_REVIEW, STATUS.BUILD, 'agent'), false)
})

test('agent-driven stages are the only ones an agent may advance', () => {
  assert.equal(canTransition(STATUS.TRIAGE, STATUS.PLAN, 'agent'), true)
  assert.equal(canTransition(STATUS.PLAN, STATUS.PLAN_REVIEW, 'agent'), true)
  assert.equal(canTransition(STATUS.BUILD, STATUS.REVIEW, 'agent'), true)
  // An agent cannot start work on its own from Inbox — that is a human/rule step.
  assert.equal(canTransition(STATUS.INBOX, STATUS.TRIAGE, 'agent'), false)
})

test('illegal jumps are rejected (Triage→Build, Plan→Done, skipping review)', () => {
  for (const [from, to] of [
    [STATUS.TRIAGE, STATUS.BUILD],
    [STATUS.PLAN, STATUS.DONE],
    [STATUS.PLAN, STATUS.BUILD],
    [STATUS.INBOX, STATUS.PLAN],
    [STATUS.BUILD, STATUS.DONE],
  ]) {
    assert.equal(canTransition(from, to, 'human'), false, `${from}->${to} must be illegal`)
    assert.throws(() => assertTransition(from, to, 'human'), /非法转移/)
  }
})

test('terminal statuses accept no outgoing edge', () => {
  for (const terminal of [STATUS.DONE, STATUS.CANCELED]) {
    assert.equal(isTerminal(terminal), true)
    for (const to of Object.values(STATUS)) {
      assert.equal(canTransition(terminal, to, 'human'), false)
    }
  }
})

test('a created PR keeps the card in Review', () => {
  assert.equal(PR_SUCCESS_STAYS, STATUS.REVIEW)
})
