import assert from 'node:assert/strict'
import test from 'node:test'
import { clientSource, makeFixture, makeTools, HEAD, STALE } from './dev-v4-support.mjs'
import { assertManualWritesAllowed } from '../verdict-guard.js'

test('Dev-Guard: V4 manual HTTP writes are refused until the card is taken over', () => {
  const f = makeFixture({ status: 'pr-review' })
  try {
    const card = f.store.getCard(f.card.id)
    assert.throws(
      () => assertManualWritesAllowed({ card, project: f.store.getProject(f.project.id), action: '确认提交' }),
      /接手|接管/,
    )
    f.store.takeOverCard(f.card.id, 'human')
    assert.doesNotThrow(() => assertManualWritesAllowed({
      card: f.store.getCard(f.card.id),
      project: f.store.getProject(f.project.id),
      action: '确认提交',
    }))
  } finally { f.cleanup() }
})

test('Dev-Verdict: self-review verdict requires the registered reviewer session', async () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    const t = makeTools(f)
    await assert.rejects(() => t.find('factory_self_review_verdict').execute({ cardId: f.card.id, head: HEAD, verdict: 'approved', blocking: [], followUps: [], checks: [] }, t.builder), /评审会话/)
    assert.deepEqual(t.calls, [])
  } finally { f.cleanup() }
})

test('Dev-Verdict: verdict is bound to the backend-read HEAD', async () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    f.store.setReviewSession(f.card.id, 'reviewer-session', 'created')
    const t = makeTools(f, { readHead: () => HEAD })
    await assert.rejects(() => t.find('factory_self_review_verdict').execute({ cardId: f.card.id, head: STALE, verdict: 'approved', blocking: [], followUps: [], checks: [] }, t.reviewer), /不一致/)
  } finally { f.cleanup() }
})

test('Dev-Verdict: blocking findings are stored with the verdict', async () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    f.store.setReviewSession(f.card.id, 'reviewer-session', 'created')
    const t = makeTools(f)
    const out = await t.find('factory_self_review_verdict').execute({
      cardId: f.card.id, head: HEAD, verdict: 'changes-requested',
      blocking: [{ file: 'a.js', line: 1, reason: 'bug' }], followUps: [{ text: 'nits' }], checks: [],
    }, t.reviewer)
    assert.equal(out.verdict, 'changes-requested')
    assert.equal(f.store.getCard(f.card.id).selfReview.blocking.length, 1)
  } finally { f.cleanup() }
})

test('Dev-Verdict: only approved verdict unlocks a draft PR', async () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    f.store.recordCommit(f.card.id, { sha: HEAD, message: 'build', actor: 'agent' })
    f.store.setReviewSession(f.card.id, 'reviewer-session', 'created')
    const t = makeTools(f)
    await t.find('factory_self_review_verdict').execute({ cardId: f.card.id, head: HEAD, verdict: 'changes-requested', blocking: [{ file: 'a', line: 1, reason: 'b' }], followUps: [], checks: [] }, t.reviewer)
    await assert.rejects(() => t.find('factory_open_draft_pr').execute({ cardId: f.card.id, title: 'T', body: 'B' }, t.reviewer), /approved/)
    assert.deepEqual(t.calls, [])
  } finally { f.cleanup() }
})

test('Dev-Verdict: no human done route remains in the API source', () => {
  const api = clientSource('api.js')
  assert.doesNotMatch(api, /assertApprovedVerdict|AUTO_DELIVERY_TIER/)
  assert.match(api, /remote-sync/)
})

test('Dev-Verdict: done is only reachable from pr-review by syncRule', () => {
  const f = makeFixture({ status: 'pr-review' })
  try {
    assert.throws(() => f.store.transitionCard(f.card.id, 'done', 'human'), /非法转移/)
    assert.equal(f.store.transitionCard(f.card.id, 'done', 'syncRule').status, 'done')
  } finally { f.cleanup() }
})

test('Dev-Verdict: no manual review verdict tool writes from the builder', () => {
  const t = makeTools(makeFixture())
  assert.equal(t.names.includes('factory_record_review_verdict'), false)
  assert.equal(t.names.includes('factory_self_review_verdict'), true)
})
