import assert from 'node:assert/strict'
import test from 'node:test'
import { createEngineStatus, runTick } from '../autonomy.js'
import { makeFixture } from './dev-v4-support.mjs'

async function tick(f, overrides = {}) {
  const seen = []
  const status = createEngineStatus()
  await runTick({
    store: f.store, status,
    deps: {
      intake: async () => ({ created: [] }),
      dispatch: async () => ({ mode: 'none' }),
      approve: async () => ({ approved: false }),
      continue: async () => ({}),
      reviewDispatch: async ({ cardId }) => { seen.push(cardId); return {} },
      isSessionActive: async () => false,
      ...overrides,
    },
  })
  return seen
}

test('Dev-AutoReview: a self-review card without a reviewer is dispatched', async () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    assert.deepEqual(await tick(f), [f.card.id])
  } finally { f.cleanup() }
})

test('Dev-AutoReview: a live reviewer is not re-dispatched', async () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    f.store.setReviewSession(f.card.id, 'reviewer-session', 'created')
    assert.deepEqual(await tick(f, { isSessionActive: async () => true }), [])
  } finally { f.cleanup() }
})

test('Dev-AutoReview: a dead reviewer is re-dispatched with a bounded counter', async () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    f.store.setReviewSession(f.card.id, 'reviewer-session', 'created')
    assert.deepEqual(await tick(f), [f.card.id])
    assert.equal(f.store.getCard(f.card.id).selfReviewDispatchFailures, 1)
  } finally { f.cleanup() }
})

test('Dev-AutoReview: narrowed self-review autoStart stops dispatch', async () => {
  const f = makeFixture({ status: 'self-review', phaseRules: { 'self-review': { autoStart: false } } })
  try {
    assert.deepEqual(await tick(f), [])
  } finally { f.cleanup() }
})

test('Dev-AutoReview: no legacy L4-only review gating remains', () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    assert.equal('autonomy' in f.store.getProject(f.project.id), false)
  } finally { f.cleanup() }
})
