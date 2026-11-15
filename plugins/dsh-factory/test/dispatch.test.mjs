/**
 * Dispatch orchestration tests — the ordering and the failure rollback, which is
 * the part that matters most: a failed dispatch must never leave the card in a
 * fake "dispatched" state. Uses a fake port so no host and no git are involved.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FactoryStore } from '../store.js'
import { createHostPort, dispatchCard } from '../dispatch.js'

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'factory-dispatch-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: '/workspace/p' })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  const card = store.createCard({ boardId: board.id, title: 'Ship it', repo: '/workspace/p' })
  return { store, project, card, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

function makePort(overrides = {}) {
  const calls = { worktree: [], session: [], removed: [], disposed: [] }
  const port = {
    createWorktree: (options) => { calls.worktree.push(options) },
    removeWorktree: (options) => { calls.removed.push(options) },
    async createSession(options) {
      calls.session.push(options)
      return { sessionId: 'sess-1', handle: { dispose: () => {} } }
    },
    async disposeSession(created) { calls.disposed.push(created) },
    ...overrides,
  }
  return { port, calls }
}

test('a successful dispatch records the worktree + session and advances Inbox→Triage', async () => {
  const { store, card, cleanup } = setup()
  try {
    const { port, calls } = makePort()
    const result = await dispatchCard({ store, cardId: card.id, port })

    assert.equal(result.sessionId, 'sess-1')
    const fresh = store.getCard(card.id)
    assert.equal(fresh.sessionId, 'sess-1')
    assert.equal(fresh.status, 'triage')
    assert.ok(fresh.worktreePath.endsWith(card.id))
    // The first message handed to the session must name the card and its worktree.
    assert.ok(calls.session[0].firstMessage.includes(card.id))
    assert.ok(calls.session[0].firstMessage.includes(fresh.worktreePath))
    // The setup callback must be provided so injection happens before first prompt.
    assert.equal(typeof calls.session[0].setup, 'function')
    // …and it must return undefined: the host runs `setupCommit?.commit()`, so any
    // returned object without a real commit() would crash dispatch (live-e2e bug).
    assert.equal(calls.session[0].setup({ systemPrompt: {} }), undefined, 'setup must not return a non-commit value')
  } finally {
    cleanup()
  }
})

test('a failed session creation rolls back: card stays Inbox, worktree removed, session disposed', async () => {
  const { store, card, cleanup } = setup()
  try {
    const { port, calls } = makePort({
      async createSession() { throw new Error('permission denied') },
    })
    await assert.rejects(() => dispatchCard({ store, cardId: card.id, port }), /permission denied/)

    const fresh = store.getCard(card.id)
    assert.equal(fresh.status, 'inbox', 'card must not be left in a dispatched state')
    assert.equal(fresh.sessionId, null)
    assert.equal(fresh.worktreePath, null)
    assert.equal(calls.removed.length, 1, 'the created worktree is removed on failure')
    assert.equal(calls.removed[0].branch, `factory/${card.id}`, 'the card branch is cleaned up too, so a retry cannot deadlock on "branch already exists"')
  } finally {
    cleanup()
  }
})

test('a worktree failure leaves the card untouched and creates no session', async () => {
  const { store, card, cleanup } = setup()
  try {
    const { port, calls } = makePort({
      createWorktree() { throw new Error('git worktree add failed') },
    })
    await assert.rejects(() => dispatchCard({ store, cardId: card.id, port }), /git worktree add failed/)
    assert.equal(store.getCard(card.id).status, 'inbox')
    assert.equal(calls.session.length, 0, 'no session is created when the worktree fails')
  } finally {
    cleanup()
  }
})

test('an already-dispatched card is reused, not spawned twice', async () => {
  const { store, card, cleanup } = setup()
  try {
    const { port, calls } = makePort()
    await dispatchCard({ store, cardId: card.id, port })
    const again = await dispatchCard({ store, cardId: card.id, port })
    assert.deepEqual(again, { reused: true, sessionId: 'sess-1' })
    assert.equal(calls.session.length, 1, 'only one session ever created')
  } finally {
    cleanup()
  }
})

test('concurrent dispatch of the same card spawns exactly one session (card lock #9)', async () => {
  const { store, card, cleanup } = setup()
  try {
    let sessions = 0
    const port = {
      createWorktree: () => {},
      removeWorktree: () => {},
      // A real createSession awaits; model that so the two calls interleave.
      createSession: () => new Promise((resolve) => setTimeout(() => { sessions += 1; resolve({ sessionId: 'sess-1', handle: { dispose: () => {} } }) }, 5)),
      disposeSession: async () => {},
    }
    const results = await Promise.allSettled([
      dispatchCard({ store, cardId: card.id, port }),
      dispatchCard({ store, cardId: card.id, port }),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    assert.equal(fulfilled.length, 1, 'exactly one dispatch wins')
    assert.equal(rejected.length, 1, 'the other is refused by the lock')
    assert.match(String(rejected[0].reason?.message), /并发锁/)
    assert.equal(sessions, 1, 'only one session is created')
    assert.equal(store.getCard(card.id).sessionId, 'sess-1')
  } finally {
    cleanup()
  }
})

test('a failed dispatch releases the claim so the card can be retried', async () => {
  const { store, card, cleanup } = setup()
  try {
    const failing = makePort({ async createSession() { throw new Error('boom') } })
    await assert.rejects(() => dispatchCard({ store, cardId: card.id, port: failing.port }), /boom/)
    assert.equal(store.getCard(card.id).pendingDispatch, null, 'claim released after failure')
    // Retry with a good port succeeds.
    const good = makePort()
    const result = await dispatchCard({ store, cardId: card.id, port: good.port })
    assert.equal(result.sessionId, 'sess-1')
  } finally {
    cleanup()
  }
})

test('createHostPort sends the first message as a real user message (not a bare object)', async () => {
  const seen = {}
  const fakeAgent = { followup: (message) => { seen.message = message } }
  const ctx = {
    get: (name) => (name === 'agents'
      ? { create: async (options) => { seen.create = options; return { agent: fakeAgent, dispose: async () => {} } } }
      : undefined),
  }
  // Inject a createUserMessage so the test does not depend on the host peer.
  const port = createHostPort({ ctx, createUserMessage: ({ content, source }) => ({ id: 'msg-1', role: 'user', content, source }) })
  const created = await port.createSession({ cwd: '/workspace/repo', setup: () => {}, firstMessage: 'do the task' })

  assert.ok(created.sessionId, 'a session id is minted')
  assert.deepEqual(seen.create.meta, { cwd: '/workspace/repo' })
  assert.equal(typeof seen.create.setup, 'function')
  assert.equal(seen.message.role, 'user', 'followup gets a user-role message')
  assert.deepEqual(seen.message.source, { kind: 'user' })
  assert.deepEqual(seen.message.content, [{ type: 'text', text: 'do the task' }])
})

