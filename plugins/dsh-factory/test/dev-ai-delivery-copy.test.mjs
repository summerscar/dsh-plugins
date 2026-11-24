import assert from 'node:assert/strict'
import test from 'node:test'
import { createDeliveryCopyGenerator } from '../ai-copy.js'
import { createPrForCard } from '../git-exec.js'
import { makeFixture, makeTools, HEAD, PR_URL } from './dev-v4-support.mjs'

test('Dev-Copy 1: stage copy generator uses host default model and returns one clean line', async () => {
  const seen = []
  const gen = createDeliveryCopyGenerator({
    ctx: { get: (name) => name === 'llm' ? { stream: async function* () {
      yield { type: 'text-delta', text: 'fix: real fix' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } } : (name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'gomodel', model: 'failover' }) } : {}) },
    readDiff: () => 'diff',
  })
  const out = await gen.commit({ card: { worktreePath: '/w' }, fallback: 'fallback', mode: 'worktree' })
  assert.equal(out.text, 'fix: real fix')
  assert.equal(out.generated, true)
  assert.deepEqual(seen, [])
})

test('Dev-Copy 2: generator failure and timeout fall back without throwing', async () => {
  const timeout = createDeliveryCopyGenerator({
    ctx: { get: () => ({ stream: async function* () { yield { type: 'text-delta', text: 'never' } } }) },
    readDiff: () => 'diff', timeoutMs: 1,
  })
  assert.equal((await timeout.commit({ card: { worktreePath: '/w' }, fallback: 'fallback' })).generated, false)
  const failed = createDeliveryCopyGenerator({
    ctx: { get: () => ({ stream: async function* () { throw new Error('offline') } }) },
    readDiff: () => 'diff',
  })
  assert.equal((await failed.commit({ card: { worktreePath: '/w' }, fallback: 'fallback' })).text, 'fallback')
})

test('Dev-Copy 3: reviewer PR copy is taken from the self-review session', async () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    f.store.recordCommit(f.card.id, { sha: HEAD, message: 'build', actor: 'agent' })
    f.store.setReviewSession(f.card.id, 'reviewer-session', 'created')
    const t = makeTools(f)
    await t.find('factory_self_review_verdict').execute({ cardId: f.card.id, head: HEAD, verdict: 'approved', blocking: [], followUps: [], checks: [] }, t.reviewer)
    await t.find('factory_open_draft_pr').execute({ cardId: f.card.id, title: 'V4 title', body: 'V4 body' }, t.reviewer)
    const pr = t.calls.find((c) => c[0] === 'createPr')[1]
    assert.equal(pr.title, 'V4 title')
    assert.equal(pr.body, 'V4 body')
    assert.equal(pr.draft, true)
  } finally { f.cleanup() }
})

test('Dev-Copy 4: an explicitly empty PR body survives as a real edit', async () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    f.store.recordCommit(f.card.id, { sha: HEAD, message: 'build', actor: 'agent' })
    f.store.setReviewSession(f.card.id, 'reviewer-session', 'created')
    f.store.recordSelfReviewVerdict(f.card.id, { head: HEAD, verdict: 'approved', blocking: [], followUps: [], checks: [] })
    f.store.recordDraftPr(f.card.id, { url: PR_URL, head: HEAD, title: 'T', body: '' })
    const card = f.store.getCard(f.card.id)
    assert.equal(card.prUrl, PR_URL)
    assert.equal(card.history.at(-1).body, '')
  } finally { f.cleanup() }
})

test('Dev-Copy 5: no V4 stage tool auto-generates copy behind the reviewer', () => {
  const t = makeTools(makeFixture())
  const names = t.names
  assert.ok(!names.includes('factory_draft_commit'))
  assert.ok(!names.includes('factory_draft_pr'))
  assert.ok(names.includes('factory_push_branch'))
  assert.ok(names.includes('factory_self_review_verdict'))
  assert.ok(names.includes('factory_open_draft_pr'))
})

test('Dev-Copy 6: manual createPr retains empty-string semantics for legacy callers', async () => {
  const f = makeFixture({ status: 'pr-review' })
  try {
    f.store.recordCommit(f.card.id, { sha: HEAD, message: 'build', actor: 'agent' })
    f.store.authorize(f.card.id, 'create-pr')
    const calls = []
    const port = {
      push: () => calls.push('push'),
      createPr: (cwd, input) => { calls.push(input); return PR_URL },
      hasDiff: () => true,
    }
    await createPrForCard({ store: f.store, cardId: f.card.id, port, title: '', body: '' })
    assert.equal(calls.at(-1).title, '')
    assert.equal(calls.at(-1).body, '')
    assert.equal(calls.at(-1).draft, true)
  } finally { f.cleanup() }
})
