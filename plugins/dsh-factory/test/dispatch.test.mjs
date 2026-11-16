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

/**
 * Build a fake host ctx that satisfies every hard dependency of createSession:
 * agents, agentDefaultModel (model route) and sandboxPolicy (file boundary).
 * `resolvedMode` controls what the boundary check reads back.
 */
function makeHostCtx({ resolvedMode = 'workspace-write', withSandbox = true, withModel = true, onSessionAppend, onCreate } = {}) {
  const seen = { create: null, sessionAppends: [], disposed: 0 }
  const session = {
    append: (type, data) => {
      seen.sessionAppends.push({ type, data })
      if (onSessionAppend) onSessionAppend(type, data, seen)
    },
  }
  const agent = { session, followup: (m) => { seen.message = m } }
  const ctx = {
    get: (name) => {
      if (name === 'agents') {
        return {
          create: async (options) => {
            seen.create = options
            if (onCreate) onCreate(options, seen)
            return { agent, dispose: async () => { seen.disposed += 1 } }
          },
        }
      }
      if (withModel && name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) }
      }
      if (withSandbox && name === 'sandboxPolicy') {
        return { resolve: () => ({ mode: resolvedMode }) }
      }
      return undefined
    },
  }
  return { ctx, seen, agent, session }
}

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
    // Contract changed (BUILD .16): a second dispatch no longer says 'reused'; it
    // reports what already exists and leaves the choice to the caller.
    assert.equal(again.mode, 'already-dispatched')
    assert.equal(again.sessionId, 'sess-1', 'the original session is reported, not replaced')
    assert.equal(typeof again.worktreePath, 'string')
    assert.match(again.hint, /continue/)
    assert.equal(calls.session.length, 1, 'only one session ever created')
    assert.equal(calls.worktree.length, 1, 'only one worktree ever created')
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
  const { ctx, seen } = makeHostCtx()
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

test('createHostPort fail-fast: no model route rejects BEFORE creating a session', async () => {
  // Sandbox is present (so the model gate is what we test), but no model route.
  const { ctx, seen } = makeHostCtx({ withModel: false })
  const port = createHostPort({ ctx, createUserMessage: ({ content }) => ({ id: 'm', role: 'user', content }) })
  await assert.rejects(
    () => port.createSession({ cwd: '/workspace/repo', setup: () => {}, firstMessage: 'do the task' }),
    /模型/,
  )
  assert.equal(seen.create, null, 'fail-fast must reject before any session is created')
})

test('createHostPort model route: project model overrides only the model part, provider follows host', async () => {
  const { ctx, seen } = makeHostCtx({ withModel: false })
  // Supply a custom model selection but no project override for provider.
  const baseGet = ctx.get
  ctx.get = (name) => (name === 'agentDefaultModel'
    ? { currentSelection: () => ({ provider: 'host-provider', model: 'host-model', reasoningEffort: 'high' }) }
    : baseGet(name))
  const port = createHostPort({ ctx, createUserMessage: ({ content }) => ({ id: 'm', role: 'user', content }) })
  await port.createSession({ cwd: '/workspace/repo', setup: () => {}, firstMessage: 'go', model: 'project-model' })
  const opts = seen.create.agentOptions
  assert.equal(opts.provider, 'host-provider', 'provider follows the host default')
  assert.equal(opts.model, 'project-model', 'project override wins for model')
  assert.equal(opts.reasoningEffort, 'high', 'effort follows the host default')
})

// ---------------------------------------------------------------------------
// Dispatch sandbox safety (security fix): dispatched agents MUST run inside
// workspace-write, regardless of the profile default (which was danger-full-access).
// ---------------------------------------------------------------------------

test('createSession seeds sandbox/mode=workspace-write into the new session', async () => {
  const { ctx, seen } = makeHostCtx()
  const port = createHostPort({ ctx, createUserMessage: ({ content }) => ({ id: 'm', role: 'user', content }) })
  await port.createSession({ cwd: '/workspace/repo', setup: () => {}, firstMessage: 'go' })
  const seed = seen.create?.seed
  assert.ok(Array.isArray(seed), 'agents.create must receive a seed')
  const pin = seed.find((e) => e.type === 'sandbox/mode')
  assert.ok(pin, 'seed must contain a sandbox/mode event')
  assert.equal(pin.data?.mode, 'workspace-write', 'seed pins workspace-write')
  assert.equal(pin.seq, 0, 'seed event seq starts at 0')
})

test('createSession refuses when resolved sandbox mode is NOT workspace-write and disposes the session', async () => {
  // Host resolves back to danger-full-access even though we seeded workspace-write.
  const { ctx, seen } = makeHostCtx({ resolvedMode: 'danger-full-access' })
  const port = createHostPort({ ctx, createUserMessage: ({ content }) => ({ id: 'm', role: 'user', content }) })
  await assert.rejects(
    () => port.createSession({ cwd: '/workspace/repo', setup: () => {}, firstMessage: 'go' }),
    /沙箱模式/,
    'a non-workspace-write boundary must be refused',
  )
  assert.equal(seen.disposed, 1, 'the unverified session must be disposed')
})

test('createSession never allows a danger-full-access project permission (capped at workspace-write)', async () => {
  const { ctx, seen } = makeHostCtx()
  const port = createHostPort({ ctx, createUserMessage: ({ content }) => ({ id: 'm', role: 'user', content }) })
  await assert.rejects(
    () => port.createSession({ cwd: '/workspace/repo', setup: () => {}, firstMessage: 'go', permission: 'danger-full-access' }),
    /workspace-write/,
    'auto-dispatch must refuse a full-access permission request',
  )
  assert.equal(seen.create, null, 'no session created for a disallowed permission')
  // And the legitimate workspace-write permission is accepted.
  const ok = makeHostCtx()
  const okPort = createHostPort({ ctx: ok.ctx, createUserMessage: ({ content }) => ({ id: 'm', role: 'user', content }) })
  await okPort.createSession({ cwd: '/workspace/repo', setup: () => {}, firstMessage: 'go', permission: 'workspace-write' })
  assert.ok(ok.seen.create, 'workspace-write permission is allowed')
  const pin = ok.seen.create.seed.find((e) => e.type === 'sandbox/mode')
  assert.equal(pin.data.mode, 'workspace-write')
})

