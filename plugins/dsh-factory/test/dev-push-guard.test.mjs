import assert from 'node:assert/strict'
import test from 'node:test'
import { makeFixture, makeTools, HEAD, STALE } from './dev-v4-support.mjs'
import { evaluateAutoDelivery } from '../delivery.js'

test('Dev-PushGuard: a missing worktree is named before git reads', async () => {
  const f = makeFixture({ status: 'pr-review' })
  try {
    f.store.setWorktree(f.card.id, { worktreePath: '', branch: 'factory/card' })
    f.store._project(f.project.id).autonomy = 'auto-delivery'
    f.store.setReviewSession(f.card.id, 'reviewer-session', 'created')
    f.store.appendReportWithVerdict(f.card.id, 'approved', { cardId: f.card.id, source: 'review', verdict: 'approved', reviewedHead: 'a'.repeat(40), blocking: [], followUps: [], checks: [], reviewerSessionId: 'reviewer-session' }, 'agent')
    const out = await evaluateAutoDelivery({
      store: f.store, cardId: f.card.id, readHead: () => HEAD,
      port: { worktreeExists: () => false },
      resolveIdentity: async () => ({ git: {} }),
    })
    assert.equal(out.ok, false)
    assert.match(out.reason, /工作树已失效/)
  } finally { f.cleanup() }
})

test('Dev-PushGuard: protected and base branches refuse before any build write', async () => {
  for (const branch of ['main', 'master']) {
    const f = makeFixture({ branch })
    try {
      const t = makeTools(f)
      await assert.rejects(() => t.find('factory_push_branch').execute({ cardId: f.card.id, message: 'm' }, t.builder), /受保护分支/)
      assert.deepEqual(t.calls, [])
    } finally { f.cleanup() }
  }
})

test('Dev-PushGuard: no diff refuses before staging', async () => {
  const f = makeFixture()
  try {
    const events = []
    const t = makeTools(f, { gitPort: {
      changedPaths: () => { events.push('changedPaths'); return ['README.md'] },
      hasDiff: () => { events.push('hasDiff'); return false },
    } })
    await assert.rejects(() => t.find('factory_push_branch').execute({ cardId: f.card.id, message: 'm' }, t.builder), /没有可交付的改动/)
    assert.deepEqual(events, ['changedPaths', 'hasDiff'])
    assert.deepEqual(t.calls, [])
  } finally { f.cleanup() }
})

test('Dev-PushGuard: HEAD drift closes the mis-opened PR', async () => {
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
    assert.deepEqual(closed, ['https://example/pr/1'])
  } finally { f.cleanup() }
})
