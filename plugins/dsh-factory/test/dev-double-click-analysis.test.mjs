import assert from 'node:assert/strict'
import test from 'node:test'
import { makeFixture, makeTools, HEAD } from './dev-v4-support.mjs'

test('Dev-DblClick: a second build push is refused after the first records a sha', async () => {
  const f = makeFixture()
  try {
    const t = makeTools(f)
    await t.find('factory_push_branch').execute({ cardId: f.card.id, message: 'first' }, t.builder)
    const callsBefore = t.calls.length
    await assert.rejects(() => t.find('factory_push_branch').execute({ cardId: f.card.id, message: 'second' }, t.builder), /已提交|重复推送/)
    assert.equal(t.calls.length, callsBefore, 'no extra git call after the idempotency gate')
  } finally { f.cleanup() }
})

test('Dev-DblClick: a second verdict does not open two PRs', async () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    f.store.recordCommit(f.card.id, { sha: HEAD, message: 'build', actor: 'agent' })
    f.store.setReviewSession(f.card.id, 'reviewer-session', 'created')
    const t = makeTools(f)
    const verdict = t.find('factory_self_review_verdict')
    await verdict.execute({ cardId: f.card.id, head: HEAD, verdict: 'approved', blocking: [], followUps: [], checks: [] }, t.reviewer)
    await verdict.execute({ cardId: f.card.id, head: HEAD, verdict: 'approved', blocking: [], followUps: [], checks: [] }, t.reviewer)
    await t.find('factory_open_draft_pr').execute({ cardId: f.card.id, title: 'T', body: 'B' }, t.reviewer)
    await assert.rejects(() => t.find('factory_open_draft_pr').execute({ cardId: f.card.id, title: 'T2', body: 'B2' }, t.reviewer), /已有 PR/)
    assert.equal(t.calls.filter((c) => c[0] === 'createPr').length, 1)
  } finally { f.cleanup() }
})

test('Dev-DblClick: repeated merge sync cannot move a done card twice', () => {
  const f = makeFixture({ status: 'pr-review' })
  try {
    f.store.setPrUrl(f.card.id, 'https://example/pr/1', 'agent')
    const before = f.store.getCard(f.card.id).history.length
    f.store.transitionCard(f.card.id, 'done', 'syncRule')
    const after = f.store.getCard(f.card.id).history.length
    assert.equal(after, before + 1)
    assert.throws(() => f.store.transitionCard(f.card.id, 'done', 'syncRule'), /终态/)
  } finally { f.cleanup() }
})

test('Dev-DblClick: precheck runs before the git write', () => {
  const t = makeTools(makeFixture())
  assert.match(t.find('factory_push_branch').execute.toString(), /precheck\('factory_push_branch'/)
})
