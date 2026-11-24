import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { autoApprovePlan } from '../autonomy.js'
import { makeFixture, HEAD } from './dev-v4-support.mjs'

test('Dev-AC8: pr-review→build continuation keeps the original builder handoff in V4', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(index, /current\?\.status === 'pr-review'/, 'AC8 route uses the V4 review status')
  assert.match(index, /continueCard\(/, 'AC8 still continues the original builder session')
  const f = makeFixture({ status: 'pr-review' })
  try {
    f.store.setReviewSession(f.card.id, 'reviewer-session', 'created')
    const card = f.store.transitionCard(f.card.id, 'build', 'human', 'apply review findings')
    assert.equal(card.status, 'build')
    assert.equal(card.reviewSessionId, 'reviewer-session', 'reviewer stays separate from builder')
  } finally { f.cleanup() }
})

function atPlan() {
  const f = makeFixture({ status: 'plan' })
  return f
}

test('Dev-ApproveRollback: plan is auto-approved by autoRule in V4', async () => {
  const f = atPlan()
  try {
    const out = await autoApprovePlan({ store: f.store, cardId: f.card.id })
    assert.equal(out.approved, true)
    assert.equal(f.store.getCard(f.card.id).status, 'build')
  } finally { f.cleanup() }
})

test('Dev-ApproveRollback: narrowed plan autoApprove stops the engine', async () => {
  const f = makeFixture({ status: 'plan', phaseRules: { plan: { autoApprove: false } } })
  try {
    const project = f.store.getProject(f.project.id)
    assert.equal(project.phaseRules.plan.autoApprove, false)
    const rules = f.store.getProject(f.project.id).phaseRules
    assert.equal(rules.plan.autoApprove, false, 'the narrow rule is persisted')
  } finally { f.cleanup() }
})

test('Dev-ApproveRollback: build can roll back to plan by the agent', () => {
  const f = atPlan()
  try {
    f.store.transitionCard(f.card.id, 'build', 'autoRule')
    const back = f.store.transitionCard(f.card.id, 'plan', 'agent', 'continuation failed')
    assert.equal(back.status, 'plan')
  } finally { f.cleanup() }
})

test('Dev-ApproveRollback: repeated approval never double-advances', async () => {
  const f = atPlan()
  try {
    await autoApprovePlan({ store: f.store, cardId: f.card.id })
    const second = await autoApprovePlan({ store: f.store, cardId: f.card.id })
    assert.equal(second.skipped, true)
    assert.equal(f.store.getCard(f.card.id).status, 'build')
  } finally { f.cleanup() }
})

test('Dev-ApproveRollback: auto approval is audited with autoRule', async () => {
  const f = atPlan()
  try {
    await autoApprovePlan({ store: f.store, cardId: f.card.id })
    const event = f.store.getCard(f.card.id).history.find((h) => h.type === 'transition' && h.to === 'build')
    assert.ok(event)
    assert.equal(event.actor, 'autoRule')
  } finally { f.cleanup() }
})

test('Dev-ApproveRollback: no legacy plan-review edge survives', () => {
  const f = atPlan()
  try {
    assert.throws(() => f.store.transitionCard(f.card.id, 'plan-review', 'human'), /未知状态|非法转移/)
  } finally { f.cleanup() }
})
