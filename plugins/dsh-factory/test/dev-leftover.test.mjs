import assert from 'node:assert/strict'
import test from 'node:test'
import { makeFixture, makeTools, HEAD } from './dev-v4-support.mjs'
import { createEngineStatus, runTick } from '../autonomy.js'

test('Dev-Leftover: no L4 counters remain on new cards', () => {
  const f = makeFixture()
  try {
    const card = f.store.getCard(f.card.id)
    assert.equal(card.commitFailures, 0)
    assert.equal(card.commitStalled, false)
    assert.equal(card.autoDelivery, null)
  } finally { f.cleanup() }
})

test('Dev-Leftover: stage delivery source is explicit', async () => {
  const f = makeFixture()
  try {
    const t = makeTools(f)
    await t.find('factory_push_branch').execute({ cardId: f.card.id, message: 'm' }, t.builder)
    assert.equal(f.store.getCard(f.card.id).deliverySource, 'build-session')
  } finally { f.cleanup() }
})

test('Dev-Leftover: pr-review cards can be polled for merge without a session', async () => {
  const f = makeFixture({ status: 'pr-review' })
  try {
    f.store.setPrUrl(f.card.id, 'https://example/pr/1', 'agent')
    const seen = []
    await runTick({
      store: f.store, status: createEngineStatus(),
      deps: {
        intake: async () => ({ created: [] }), dispatch: async () => ({ mode: 'none' }),
        approve: async () => ({ approved: false }), continue: async () => ({}),
        isSessionActive: async () => false,
        ghPortFor: async () => ({ prState: async ({ prUrl }) => { seen.push(prUrl); return 'MERGED' } }),
        remoteSync: async ({ remote }) => { assert.equal(remote.pr.state, 'MERGED'); return { changed: true } },
      },
    })
    assert.deepEqual(seen, ['https://example/pr/1'])
  } finally { f.cleanup() }
})

test('Dev-Leftover: no legacy retry-auto-delivery route', () => {
  const f = makeFixture()
  try {
    assert.equal(typeof f.store.clearCommitFailures, 'function')
    assert.equal(f.store.getCard(f.card.id).commitStalled, false)
  } finally { f.cleanup() }
})
