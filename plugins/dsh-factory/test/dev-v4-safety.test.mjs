/**
 * Dev safety-gate evidence for V4. These are the gates Chief required to
 * survive the tier removal; each one is asserted at the stage-tool boundary,
 * not by reading tool descriptions.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { ensureCommittedForAutoDelivery } from '../delivery.js'
import { makeFixture, makeTools, HEAD, STALE, SHA, PR_URL } from './dev-v4-support.mjs'

function gatePort(f, overrides = {}) {
  const calls = []
  const port = {
    headOf: (cwd, ref) => { calls.push(['headOf', ref]); return HEAD },
    deletedCount: () => 0,
    isWorktreeClean: () => false,
    changedPaths: () => ['README.md'],
    add: (cwd, paths) => calls.push(['add', paths]),
    commit: (cwd, message, paths) => { calls.push(['commit', paths]); return SHA },
    ...overrides,
  }
  return { port, calls }
}

test('gate 1: a live reviewer session blocks build writes before any git call', async () => {
  const f = makeFixture()
  try {
    f.store.setReviewSession(f.card.id, 'reviewer-session', 'created')
    const t = makeTools(f, { isSessionActive: async (id) => id === 'reviewer-session' })
    await assert.rejects(
      () => t.find('factory_push_branch').execute({ cardId: f.card.id, message: 'm' }, t.builder),
      /会话仍在运行/,
    )
    assert.deepEqual(t.calls, [])
  } finally { f.cleanup() }
})

test('gate 2: HEAD off the baseline with no commitSha fails closed before staging', async () => {
  const f = makeFixture({ status: 'pr-review' })
  try {
    // The legacy fail-closed guard is still available for imported/old projects.
    f.store._project(f.project.id).autonomy = 'auto-delivery'
    const { port, calls } = gatePort(f)
    const result = await ensureCommittedForAutoDelivery({ store: f.store, cardId: f.card.id, port, readHead: () => STALE })
    assert.equal(result.ok, false)
    assert.match(result.reason, /与基线.*不一致/)
    assert.deepEqual(calls, [['headOf', 'main']])
  } finally { f.cleanup() }
})

test('gate 3: mass tracked deletions are refused before staging', async () => {
  const f = makeFixture({ status: 'pr-review' })
  try {
    f.store._project(f.project.id).autonomy = 'auto-delivery'
    const events = []
    const { port, calls } = gatePort(f, { deletedCount: () => { events.push('deletedCount'); return 30 } })
    const result = await ensureCommittedForAutoDelivery({ store: f.store, cardId: f.card.id, port, readHead: () => HEAD })
    assert.equal(result.ok, false)
    assert.match(result.reason, /删除了 30 个已跟踪文件/)
    assert.deepEqual(events, ['deletedCount'])
    assert.deepEqual(calls, [['headOf', 'main']])
  } finally { f.cleanup() }
})

test('gate 4: build commits ONLY the paths frozen at decision time', async () => {
  const f = makeFixture()
  try {
    const t = makeTools(f, { gitPort: { changedPaths: () => ['README.md', 'src/a.js'] } })
    await t.find('factory_push_branch').execute({ cardId: f.card.id, message: 'm' }, t.builder)
    assert.deepEqual(t.calls.find((c) => c[0] === 'add')[1], ['README.md', 'src/a.js'])
    assert.deepEqual(t.calls.find((c) => c[0] === 'commit')[2], ['README.md', 'src/a.js'])
    assert.equal(t.calls.some((c) => c[0] === 'add' && c[1] === undefined), false, 'never git add -A')
  } finally { f.cleanup() }
})

test('gate 5: no approved verdict or drifted HEAD refuses to open a PR', async () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    f.store.recordCommit(f.card.id, { sha: HEAD, message: 'build', actor: 'agent' })
    f.store.setReviewSession(f.card.id, 'reviewer-session', 'created')
    const t = makeTools(f)
    await assert.rejects(
      () => t.find('factory_open_draft_pr').execute({ cardId: f.card.id, title: 'T', body: 'B' }, t.reviewer),
      /approved/,
    )
    await t.find('factory_self_review_verdict').execute({ cardId: f.card.id, head: HEAD, verdict: 'approved', blocking: [], followUps: [], checks: [] }, t.reviewer)
    const stale = makeTools(f, { readHead: () => STALE })
    await assert.rejects(
      () => stale.find('factory_open_draft_pr').execute({ cardId: f.card.id, title: 'T', body: 'B' }, t.reviewer),
      /head/,
    )
    assert.deepEqual(t.calls, [])
    assert.deepEqual(stale.calls, [])
  } finally { f.cleanup() }
})

test('gate 6: push is non-force and scoped to the card branch', async () => {
  const f = makeFixture({ branch: 'factory/safety' })
  try {
    const t = makeTools(f)
    await t.find('factory_push_branch').execute({ cardId: f.card.id, message: 'm' }, t.builder)
    const push = t.calls.find((c) => c[0] === 'push')
    assert.deepEqual(push, ['push', 'factory/safety'])
    assert.equal(push.length, 2, 'no force flag, no extra refspec')
  } finally { f.cleanup() }
})

test('gate 7: PR creation is always draft and no merge/close tool is invoked', async () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    f.store.recordCommit(f.card.id, { sha: HEAD, message: 'build', actor: 'agent' })
    f.store.setReviewSession(f.card.id, 'reviewer-session', 'created')
    const t = makeTools(f)
    await t.find('factory_self_review_verdict').execute({ cardId: f.card.id, head: HEAD, verdict: 'approved', blocking: [], followUps: [], checks: [] }, t.reviewer)
    const out = await t.find('factory_open_draft_pr').execute({ cardId: f.card.id, title: 'T', body: 'B' }, t.reviewer)
    assert.equal(out.url, PR_URL)
    assert.equal(t.calls.find((c) => c[0] === 'createPr')[1].draft, true)
    assert.equal(t.calls.some((c) => ['merge', 'close', 'closePr'].includes(c[0])), false)
  } finally { f.cleanup() }
})
