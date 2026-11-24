import assert from 'node:assert/strict'
import test from 'node:test'
import { AUTO_REREVIEW_LIMIT, createEngineStatus, runTick } from '../autonomy.js'
import { makeFixture, HEAD, STALE } from './dev-v4-support.mjs'

async function tick(f) {
  const seen = []
  await runTick({
    store: f.store, status: createEngineStatus(),
    deps: {
      intake: async () => ({ created: [] }),
      dispatch: async () => ({ mode: 'none' }),
      approve: async () => ({ approved: false }),
      continue: async () => ({}),
      reviewDispatch: async () => ({}),
      reviewRereview: async ({ cardId }) => { seen.push(cardId); f.store.setReviewSession(cardId, 'reviewer-session', 'reused'); return {} },
      isSessionActive: async () => false,
    },
  })
  return seen
}

function stale(f, count = 0) {
  f.store.setReviewSession(f.card.id, 'reviewer-session', 'created')
  f.store.markReviewStale(f.card.id, { previousReviewedHead: HEAD, head: STALE })
  for (let i = 0; i < count; i += 1) f.store.recordAutoRereview(f.card.id)
}

test('Dev-Rereview: a stale self-review is re-dispatched once', async () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    stale(f)
    assert.deepEqual(await tick(f), [f.card.id])
    assert.equal(f.store.getCard(f.card.id).autoRereviewCount, 1)
  } finally { f.cleanup() }
})

test('Dev-Rereview: the same head is not re-dispatched twice', async () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    stale(f)
    assert.deepEqual(await tick(f), [f.card.id])
    assert.equal(f.store.getCard(f.card.id).reviewStale, false)
    assert.deepEqual(await tick(f), [])
  } finally { f.cleanup() }
})

test('Dev-Rereview: cap stops automatic re-review', async () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    stale(f, AUTO_REREVIEW_LIMIT)
    assert.deepEqual(await tick(f), [])
    assert.equal(f.store.getCard(f.card.id).reviewStale, true)
  } finally { f.cleanup() }
})

test('Dev-Rereview: a card with no reviewer is first-review, not rereview', async () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    f.store.markReviewStale(f.card.id, { previousReviewedHead: HEAD, head: STALE })
    const dispatched = []
    await runTick({
      store: f.store, status: createEngineStatus(),
      deps: {
        intake: async () => ({ created: [] }), dispatch: async () => ({ mode: 'none' }),
        approve: async () => ({ approved: false }), continue: async () => ({}),
        reviewDispatch: async ({ cardId }) => { dispatched.push(cardId); return {} },
        isSessionActive: async () => false,
      },
    })
    assert.deepEqual(dispatched, [f.card.id])
  } finally { f.cleanup() }
})

test('Dev-Rereview: fresh verdict clears stale by reviewed head', async () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    stale(f)
    f.store.recordSelfReviewVerdict(f.card.id, { head: STALE, verdict: 'approved', blocking: [], followUps: [], checks: [] })
    assert.deepEqual(await tick(f), [])
  } finally { f.cleanup() }
})

test('Dev-Rereview: no L4 tier is involved in the cap', () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    assert.equal('autonomy' in f.store.getProject(f.project.id), false)
    assert.equal(AUTO_REREVIEW_LIMIT, 3)
  } finally { f.cleanup() }
})
