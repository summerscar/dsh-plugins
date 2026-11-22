/**
 * Dev self-check: an API git write must not happen without an approved review
 * verdict. The flag is opt-in so internal/offline callers keep their history;
 * the HTTP layer turns it on for the four human write routes.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { commitCard, commitForExistingPr, createPrForCard, pushExistingCard } from '../git-exec.js'
import { FactoryStore } from '../store.js'
import { assertApprovedVerdict } from '../verdict-guard.js'

const HEAD = 'a'.repeat(40)

function setup({ verdict = null, blocking = [] } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'factory-verdict-guard-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: '/workspace/example-repo' })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  const card = store.createCard({ boardId: board.id, title: 'Ship it' })
  store.setWorktree(card.id, { worktreePath: '/tmp/fake-worktree', branch: 'factory/card' })
  for (const [to, actor] of [['triage', 'human'], ['plan', 'agent'], ['plan-review', 'agent'], ['build', 'human'], ['review', 'agent']]) {
    store.transitionCard(card.id, to, actor)
  }
  store.setReviewSession(card.id, 'rev-1', 'created')
  if (verdict !== null) {
    store.appendReportWithVerdict(card.id, 'review', {
      cardId: card.id, source: 'review', verdict, reviewedHead: HEAD,
      blocking, followUps: [], checks: [], reviewerSessionId: 'rev-1',
    }, 'agent')
  }
  return { store, card: store.getCard(card.id), cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

function fakePort() {
  const calls = []
  const record = (name) => (...args) => { calls.push({ name, args }) }
  return {
    calls,
    port: {
      add: record('add'),
      commit: () => { calls.push({ name: 'commit' }); return 'deadbeef' },
      reset: record('reset'),
      hasDiff: () => true,
      push: record('push'),
      createPr: () => { calls.push({ name: 'createPr' }); return 'https://example/pr/1' },
    },
  }
}

test('Dev-Verdict: helper accepts only an approved, unblocked verdict', () => {
  assert.throws(() => assertApprovedVerdict({ card: {} }), /没有 approved 评审结论/)
  assert.throws(() => assertApprovedVerdict({
    card: { reviewVerdict: { verdict: 'changes-requested' } },
  }), /没有 approved 评审结论/)
  assert.throws(() => assertApprovedVerdict({
    card: { reviewVerdict: { verdict: 'approved', blocking: [{ file: 'a', line: 1, reason: 'x' }] } },
  }), /阻断项/)
  assert.doesNotThrow(() => assertApprovedVerdict({
    card: { reviewVerdict: { verdict: 'approved', blocking: [] } },
  }))
})

test('Dev-Verdict: commit without an approved verdict writes nothing and keeps the authorization', async () => {
  const { store, card, cleanup } = setup()
  try {
    store.authorize(card.id, 'confirm-commit')
    const { port, calls } = fakePort()
    await assert.rejects(
      () => commitCard({ store, cardId: card.id, port, requireApprovedVerdict: true }),
      /没有 approved 评审结论/,
    )
    assert.equal(calls.length, 0, 'git port untouched')
    assert.notEqual(store.getCard(card.id).pendingAuthorization, null, 'authorization still armed')
  } finally { cleanup() }
})

test('Dev-Verdict: an approved verdict allows the same commit and consumes the authorization', async () => {
  const { store, card, cleanup } = setup({ verdict: 'approved' })
  try {
    store.authorize(card.id, 'confirm-commit')
    const { port, calls } = fakePort()
    const result = await commitCard({ store, cardId: card.id, port, requireApprovedVerdict: true })
    assert.equal(result.sha, 'deadbeef')
    assert.deepEqual(calls.map((c) => c.name), ['add', 'commit'])
    assert.equal(store.getCard(card.id).pendingAuthorization, null)
  } finally { cleanup() }
})

test('Dev-Verdict: PR creation, push-existing and rework commit all refuse without a verdict', async () => {
  const { store, card, cleanup } = setup({ verdict: 'changes-requested' })
  try {
    store.recordCommit(card.id, { sha: 'deadbeef', message: 'first' })
    store.setPrUrl(card.id, 'https://example/pr/1')
    for (const [action, run] of [
      ['create-pr', (port) => createPrForCard({ store, cardId: card.id, port, requireApprovedVerdict: true })],
      ['push-existing', (port) => pushExistingCard({ store, cardId: card.id, port, requireApprovedVerdict: true })],
      ['confirm-commit', (port) => commitForExistingPr({ store, cardId: card.id, port, requireApprovedVerdict: true })],
    ]) {
      store.authorize(card.id, action)
      const { port, calls } = fakePort()
      await assert.rejects(() => run(port), /没有 approved 评审结论/, `${action} refused`)
      assert.equal(calls.length, 0, `${action} wrote nothing`)
    }
  } finally { cleanup() }
})
