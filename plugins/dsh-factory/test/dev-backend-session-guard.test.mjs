import assert from 'node:assert/strict'
import test from 'node:test'
import { makeFixture, makeTools, HEAD } from './dev-v4-support.mjs'

test('Dev-Guard: a live reviewer session blocks the builder push tool', async () => {
  const f = makeFixture()
  try {
    f.store.setReviewSession(f.card.id, 'reviewer-session', 'created')
    const t = makeTools(f, { isSessionActive: async (id) => id === 'reviewer-session' })
    await assert.rejects(() => t.find('factory_push_branch').execute({ cardId: f.card.id, message: 'm' }, t.builder), /会话仍在运行/)
    assert.deepEqual(t.calls, [])
  } finally { f.cleanup() }
})

test('Dev-Guard: a stale reviewer handle no longer blocks writes', async () => {
  const f = makeFixture()
  try {
    f.store.setReviewSession(f.card.id, 'reviewer-session', 'created')
    const t = makeTools(f, { isSessionActive: async () => false })
    const out = await t.find('factory_push_branch').execute({ cardId: f.card.id, message: 'm' }, t.builder)
    assert.ok(out.sha)
  } finally { f.cleanup() }
})

test('Dev-Guard: only the registered builder may push', async () => {
  const f = makeFixture()
  try {
    const t = makeTools(f)
    await assert.rejects(() => t.find('factory_push_branch').execute({ cardId: f.card.id, message: 'm' }, t.other), /builder 会话/)
    assert.deepEqual(t.calls, [])
  } finally { f.cleanup() }
})

test('Dev-Guard: only the registered reviewer may record a verdict', async () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    f.store.setReviewSession(f.card.id, 'reviewer-session', 'created')
    const t = makeTools(f)
    await assert.rejects(() => t.find('factory_self_review_verdict').execute({ cardId: f.card.id, head: HEAD, verdict: 'approved', blocking: [], followUps: [], checks: [] }, t.builder), /评审会话/)
    assert.deepEqual(t.calls, [])
  } finally { f.cleanup() }
})

test('Dev-Guard: only the registered reviewer may open the draft PR', async () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    f.store.recordCommit(f.card.id, { sha: HEAD, message: 'build', actor: 'agent' })
    f.store.setReviewSession(f.card.id, 'reviewer-session', 'created')
    const t = makeTools(f)
    await t.find('factory_self_review_verdict').execute({ cardId: f.card.id, head: HEAD, verdict: 'approved', blocking: [], followUps: [], checks: [] }, t.reviewer)
    await assert.rejects(() => t.find('factory_open_draft_pr').execute({ cardId: f.card.id, title: 'T', body: 'B' }, t.other), /评审会话/)
    assert.deepEqual(t.calls, [])
  } finally { f.cleanup() }
})

test('Dev-Guard: an idle card can still be written by its own stage session', async () => {
  const f = makeFixture()
  try {
    const t = makeTools(f)
    const out = await t.find('factory_push_branch').execute({ cardId: f.card.id, message: 'm' }, t.builder)
    assert.ok(out.sha)
    assert.equal(out.prUrl, '')
  } finally { f.cleanup() }
})
