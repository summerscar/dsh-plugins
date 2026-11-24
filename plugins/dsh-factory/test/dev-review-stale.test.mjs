import assert from 'node:assert/strict'
import test from 'node:test'
import { makeFixture, makeTools, HEAD, STALE, PR_URL } from './dev-v4-support.mjs'

test('Dev-Stale: card defaults clean; markReviewStale carries both heads', () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    assert.equal(f.store.getCard(f.card.id).reviewStale, false)
    const card = f.store.markReviewStale(f.card.id, { previousReviewedHead: HEAD, head: STALE })
    assert.equal(card.reviewStale, true)
    assert.equal(card.reviewStaleInfo.head, STALE)
    assert.equal(card.reviewStaleInfo.previousReviewedHead, HEAD)
  } finally { f.cleanup() }
})

test('Dev-Stale: a fresh reviewer session clears stale', () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    f.store.markReviewStale(f.card.id, { previousReviewedHead: HEAD, head: STALE })
    const card = f.store.setReviewSession(f.card.id, 'reviewer-session', 'created')
    assert.equal(card.reviewStale, false)
  } finally { f.cleanup() }
})

test('Dev-Stale: a verdict on the stale head clears it; an old head does not', () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    f.store.markReviewStale(f.card.id, { previousReviewedHead: HEAD, head: STALE })
    f.store.recordSelfReviewVerdict(f.card.id, { head: HEAD, verdict: 'approved', blocking: [], followUps: [], checks: [] })
    assert.equal(f.store.getCard(f.card.id).reviewStale, true)
    f.store.recordSelfReviewVerdict(f.card.id, { head: STALE, verdict: 'approved', blocking: [], followUps: [], checks: [] })
    assert.equal(f.store.getCard(f.card.id).reviewStale, false)
  } finally { f.cleanup() }
})

test('Dev-Stale: leaving self-review clears stale', () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    f.store.markReviewStale(f.card.id, { previousReviewedHead: HEAD, head: STALE })
    f.store.transitionCard(f.card.id, 'build', 'agent')
    assert.equal(f.store.getCard(f.card.id).reviewStale, false)
  } finally { f.cleanup() }
})

test('Dev-Stale: verdict tool refuses a stale HEAD before recording', async () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    f.store.setReviewSession(f.card.id, 'reviewer-session', 'created')
    const t = makeTools(f, { readHead: () => HEAD })
    await assert.rejects(() => t.find('factory_self_review_verdict').execute({ cardId: f.card.id, head: STALE, verdict: 'approved', blocking: [], followUps: [], checks: [] }, t.reviewer), /不一致/)
  } finally { f.cleanup() }
})

test('Dev-Stale: entering pr-review closes a PR whose approved head drifted', async () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    f.store.recordCommit(f.card.id, { sha: HEAD, message: 'build', actor: 'agent' })
    f.store.setReviewSession(f.card.id, 'reviewer-session', 'created')
    const closed = []
    const t = makeTools(f, { closePrFor: async (card) => closed.push(card.prUrl) })
    await t.find('factory_self_review_verdict').execute({ cardId: f.card.id, head: HEAD, verdict: 'approved', blocking: [], followUps: [], checks: [] }, t.reviewer)
    await t.find('factory_open_draft_pr').execute({ cardId: f.card.id, title: 'T', body: 'B' }, t.reviewer)
    f.store._card(f.card.id).prHead = STALE
    await assert.rejects(() => t.find('factory_transition_work_item').execute({ cardId: f.card.id, to: 'pr-review' }, t.reviewer), /漂移/)
    assert.deepEqual(closed, [PR_URL])
  } finally { f.cleanup() }
})
