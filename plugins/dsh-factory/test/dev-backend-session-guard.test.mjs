/**
 * Dev self-check: the backend must not trust a disabled UI button. While a
 * builder or reviewer session is live, the same write paths the UI hides must
 * refuse a direct API call too, before any git/port write happens.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createApi } from '../api.js'
import { commitCard, commitForExistingPr, createPrForCard, pushExistingCard } from '../git-exec.js'
import { assertNoActiveSession, sessionActiveFor } from '../session-guard.js'
import { FactoryStore } from '../store.js'

function setup({ builder = false, reviewer = false } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'factory-session-guard-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: '/workspace/example-repo' })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  const card = store.createCard({ boardId: board.id, title: 'Ship it' })
  store.setWorktree(card.id, {
    worktreePath: '/tmp/fake-worktree', branch: 'factory/card',
    ...(builder ? { sessionId: 'builder-1' } : {}),
  })
  store.transitionCard(card.id, 'triage', 'human')
  store.transitionCard(card.id, 'plan', 'agent')
  store.transitionCard(card.id, 'plan-review', 'agent')
  store.transitionCard(card.id, 'build', 'human')
  store.transitionCard(card.id, 'review', 'agent')
  if (reviewer) store.setReviewSession(card.id, 'reviewer-1')
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

// Host agents keep their handle after a turn ends; only `status === 'running'`
// is the live busy bit (the frontend reads the same bit via sessions.list).
function ctxWithAgentStatus(status) {
  return { get: (name) => name === 'agents' ? { get: () => ({ status }) } : undefined }
}

test('Dev-Guard: an ended session (handle kept, status idle) no longer blocks writes', async () => {
  const isSessionActive = (id) => sessionActiveFor(ctxWithAgentStatus('idle'), id)
  assert.equal(isSessionActive('builder-1'), false, 'idle handle is not a running session')
  assert.doesNotThrow(() => assertNoActiveSession({
    card: { sessionId: 'builder-1', reviewSessionId: 'reviewer-1' }, isSessionActive,
  }), 'both ended sessions let the write through')

  const { store, card, cleanup } = setup({ builder: true, reviewer: true })
  try {
    const api = createApi({ store, build: 'test', isSessionActive })
    const taken = api({ method: 'POST', route: `/cards/${card.id}/takeover`, body: {} })
    assert.equal(taken.status, 200, 'takeover works after the session ended')
    assert.equal(store.getCard(card.id).takenOver, true)
  } finally { cleanup() }

  const ended = setup({ reviewer: true })
  try {
    ended.store.authorize(ended.card.id, 'confirm-commit')
    const { port, calls } = fakePort()
    const result = await commitCard({ store: ended.store, cardId: ended.card.id, port, isSessionActive })
    assert.equal(result.sha, 'deadbeef', 'commit works after the reviewer ended')
    assert.deepEqual(calls.map((c) => c.name), ['add', 'commit'])
  } finally { ended.cleanup() }
})

test('Dev-Guard: status running still blocks, and a missing agents service fails open', () => {
  const running = (id) => sessionActiveFor(ctxWithAgentStatus('running'), id)
  assert.equal(running('reviewer-1'), true)
  assert.throws(() => assertNoActiveSession({
    card: { reviewSessionId: 'reviewer-1' }, isSessionActive: running,
  }), /会话仍在进行/)
  assert.equal(sessionActiveFor({ get: () => undefined }, 'any'), false, 'no agents service means no known running session')
})

test('Dev-Guard: helper refuses a live builder, a live reviewer, and allows idle', () => {
  assert.throws(() => assertNoActiveSession({
    card: { sessionId: 'b', reviewSessionId: null }, isSessionActive: (id) => id === 'b',
  }), /会话仍在进行/)
  assert.throws(() => assertNoActiveSession({
    card: { sessionId: null, reviewSessionId: 'r' }, isSessionActive: (id) => id === 'r',
  }), /会话仍在进行/)
  assert.doesNotThrow(() => assertNoActiveSession({
    card: { sessionId: 'b', reviewSessionId: 'r' }, isSessionActive: () => false,
  }))
  assert.doesNotThrow(() => assertNoActiveSession({ card: {}, isSessionActive: undefined }))
})

test('Dev-Guard: authorized commit refuses while the reviewer runs, with zero git writes', async () => {
  const { store, card, cleanup } = setup({ reviewer: true })
  try {
    store.authorize(card.id, 'confirm-commit')
    const { port, calls } = fakePort()
    await assert.rejects(
      () => commitCard({ store, cardId: card.id, port, isSessionActive: (id) => id === 'reviewer-1' }),
      /会话仍在进行/,
    )
    assert.equal(calls.length, 0, 'no add/commit/reset on a refused call')
    assert.ok(!store.getCard(card.id).commitSha, 'no commit sha recorded by a refused call')
    assert.notEqual(store.getCard(card.id).pendingAuthorization, null, 'authorization not consumed by a refusal')
  } finally { cleanup() }
})

test('Dev-Guard: PR creation refuses while the builder runs, with zero remote writes', async () => {
  const { store, card, cleanup } = setup({ builder: true })
  try {
    store.authorize(card.id, 'confirm-commit')
    const first = fakePort()
    await commitCard({ store, cardId: card.id, port: first.port })
    store.authorize(card.id, 'create-pr')
    const { port, calls } = fakePort()
    await assert.rejects(
      () => createPrForCard({ store, cardId: card.id, port, isSessionActive: (id) => id === 'builder-1' }),
      /会话仍在进行/,
    )
    assert.equal(calls.length, 0, 'no push/createPr on a refused call')
  } finally { cleanup() }
})

test('Dev-Guard: rework commit and push-existing both refuse while a session runs', async () => {
  const { store, card, cleanup } = setup({ reviewer: true })
  try {
    store.setPrUrl(card.id, 'https://example/pr/1')
    store.recordCommit(card.id, { sha: 'deadbeef', message: 'first' })
    store.authorize(card.id, 'confirm-commit')
    const a = fakePort()
    await assert.rejects(
      () => commitForExistingPr({ store, cardId: card.id, port: a.port, isSessionActive: () => true }),
      /会话仍在进行/,
    )
    assert.equal(a.calls.length, 0)
    store.authorize(card.id, 'push-existing')
    const b = fakePort()
    await assert.rejects(
      () => pushExistingCard({ store, cardId: card.id, port: b.port, isSessionActive: () => true }),
      /会话仍在进行/,
    )
    assert.equal(b.calls.length, 0, 'no push on a refused update')
  } finally { cleanup() }
})

test('Dev-Guard: API transition to done/canceled, takeover and release refuse a live session', () => {
  const { store, card, cleanup } = setup({ builder: true })
  try {
    const api = createApi({ store, build: 'test', isSessionActive: (id) => id === 'builder-1' })
    for (const [route, body] of [
      ['transition', { to: 'done', actor: 'human' }],
      ['transition', { to: 'canceled', actor: 'human' }],
      ['takeover', {}],
      ['release', {}],
    ]) {
      const res = api({ method: 'POST', route: `/cards/${card.id}/${route}`, body })
      assert.equal(res.status, 400, `${route} ${body.to ?? ''} refused`)
      assert.match(res.body.error, /会话仍在进行/)
    }
    assert.equal(store.getCard(card.id).status, 'review', 'no status changed by a refused call')
  } finally { cleanup() }
})

test('Dev-Guard: idle card keeps every path actionable', async () => {
  const { store, card, cleanup } = setup()
  try {
    store.authorize(card.id, 'confirm-commit')
    const { port, calls } = fakePort()
    const result = await commitCard({ store, cardId: card.id, port, isSessionActive: () => false })
    assert.equal(result.sha, 'deadbeef')
    assert.deepEqual(calls.map((c) => c.name), ['add', 'commit'])
    const api = createApi({ store, build: 'test', isSessionActive: () => false })
    const taken = api({ method: 'POST', route: `/cards/${card.id}/takeover`, body: {} })
    assert.equal(taken.status, 200)
    assert.equal(store.getCard(card.id).takenOver, true)
  } finally { cleanup() }
})
