import assert from 'node:assert/strict'
import test from 'node:test'
import { dispatchReview } from '../dispatch.js'
import { makeFixture } from './dev-v4-support.mjs'

async function dispatch(f, workMode = 'workspace-write') {
  const seen = []
  await dispatchReview({
    store: f.store, cardId: f.card.id,
    port: {
      readHead: () => 'a'.repeat(40),
      createSession: async (opts) => { seen.push(opts); return { sessionId: 'reviewer-session' } },
    },
    locale: 'zh',
  })
  return seen[0]
}

for (const mode of ['workspace-write', 'full-access', 'auto-review']) {
  test(`Dev-ReviewMode: self-review follows ${mode}`, async () => {
    const f = makeFixture({ status: 'self-review' })
    try {
      f.store.updateWorkMode(f.project.id, { workMode: mode }, { allowAutoReview: true })
      const opts = await dispatch(f)
      assert.equal(opts.workMode, mode === 'auto-review' ? 'workspace-write' : mode)
      assert.ok(opts.setup)
    } finally { f.cleanup() }
  })
}

test('Dev-ReviewMode: review reads the pushed full HEAD', async () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    const opts = await dispatch(f)
    assert.match(opts.firstMessage, /reviewedHead: a{40}/)
  } finally { f.cleanup() }
})

test('Dev-ReviewMode: review setup includes a real commit function', async () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    const opts = await dispatch(f)
    assert.notEqual(opts.setup, undefined)
  } finally { f.cleanup() }
})

test('Dev-ReviewMode: the reviewer is stored separately from the builder', async () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    await dispatch(f)
    const card = f.store.getCard(f.card.id)
    assert.equal(card.sessionId, 'builder-session')
    assert.equal(card.reviewSessionId, 'reviewer-session')
  } finally { f.cleanup() }
})
