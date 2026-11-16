/**
 * QA — session continuation (PRD session-continuation, BUILD .15).
 *
 * Covers the five things Chief asked for:
 *   1. level 1 — live session  → followup, no new session
 *   2. level 2 — dead session + history → resume on the SAME sessionId, turn++
 *   3. level 3 — history unusable → fresh session + `continuation-fallback` record
 *   4. circuit breaker — 3 consecutive failures → stalled, no further dispatch
 *   5. refusal paths — terminal, waiting-for-human, concurrency lock
 *
 * Plus two edges that would bite in production:
 *   - a continuation never creates a worktree and never deletes one on failure
 *   - the claim lock is released on every path (success, refusal, failure)
 *
 * Everything uses a fake port: no host, no git, no network.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FactoryStore, DEFAULT_DISPATCH_FAILURE_LIMIT } from '../store.js'
import { assertDispatchable, continueCard } from '../dispatch.js'

const WORKTREE = '/workspace/.dsh-worktrees/proj/card'
const BRANCH = 'factory/card-1'

/** A card already dispatched once, sitting in a status the agent may act on. */
function setup({ status = 'plan' } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-continue-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: '/workspace/p' })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  const card = store.createCard({ boardId: board.id, title: 'c' })
  // Drive the card to a status the agent owns, then attach the first session.
  store.transitionCard(card.id, 'triage', 'human')
  store.transitionCard(card.id, 'plan', 'agent')
  if (status !== 'plan') store.transitionCard(card.id, status, 'human')
  store.setWorktree(card.id, {
    worktreePath: WORKTREE, branch: BRANCH, baseBranch: 'main', sessionId: 'session-1',
  })
  return { store, card, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

function fakePort({ active = false, resumeError, followupError, createError } = {}) {
  const calls = { followup: [], resume: [], create: [], worktree: [], dispose: [] }
  return {
    calls,
    port: {
      createWorktree: (o) => calls.worktree.push(o),
      removeWorktree: () => {},
      async isSessionActive() { return active },
      async followupSession(o) {
        if (followupError) throw followupError
        calls.followup.push(o)
      },
      async resumeSession(o) {
        calls.resume.push(o) // count the ATTEMPT, even when it then rejects
        if (resumeError) throw resumeError
        return { sessionId: o.resumeSessionId, handle: { dispose: () => {} } }
      },
      async createSession(o) {
        calls.create.push(o) // count the ATTEMPT, even when it then rejects
        if (createError) throw createError
        return { sessionId: 'session-new', handle: { dispose: () => {} } }
      },
      async disposeSession(h) { calls.dispose.push(h) },
    },
  }
}

const historyTypes = (store, id) => store.getCard(id).history.map((h) => h.type)

// --- level 1 -----------------------------------------------------------------

test('level 1: a live session gets a followup and NO new session is created', async () => {
  const { store, card, cleanup } = setup()
  try {
    const { port, calls } = fakePort({ active: true })
    const result = await continueCard({ store, cardId: card.id, port, message: 'go on' })
    assert.equal(result.mode, 'followup')
    assert.equal(result.sessionId, 'session-1', 'the same session is reused')
    assert.equal(calls.followup.length, 1)
    assert.equal(calls.followup[0].message, 'go on')
    assert.equal(calls.resume.length, 0, 'level 2 must not run')
    assert.equal(calls.create.length, 0, 'no new session at level 1')
    assert.ok(historyTypes(store, card.id).includes('continuation'))
    assert.equal(store.getCard(card.id).pendingDispatch, null, 'claim released')
  } finally { cleanup() }
})

test('level 1: a live session is NOT a reason to refuse (the PRD contradiction, fixed)', async () => {
  // The old rule "active session ⇒ busy, refuse" would make level 1 unreachable.
  const { store, card, cleanup } = setup()
  try {
    const { port } = fakePort({ active: true })
    const claim = store.claimForDispatch(card.id)
    assert.equal(claim.claimed, true, 'a live session must not block the claim')
    store.releaseClaim(card.id, claim.token)
    const result = await continueCard({ store, cardId: card.id, port })
    assert.equal(result.mode, 'followup')
  } finally { cleanup() }
})

// --- level 2 -----------------------------------------------------------------

test('sandbox gate: a live session refused at level 1 falls through to a fresh sandboxed session', async () => {
  // Regression for the "card stranded in level 1" bug: followupSession refuses
  // an old unsafe session (e.g. no sandbox/mode event). Its error must NOT escape
  // to the outer catch — the card must fall through level 2 -> level 3 and get a
  // freshly seeded, sandboxed session. This is the REAL behaviour change.
  const { store, card, cleanup } = setup()
  try {
    const followupErr = new Error('无法派发会话：沙箱模式实际为 danger-full-access')
    const { port, calls } = fakePort({
      active: true,
      followupError: followupErr,
      resumeError: new Error('SessionPersistenceNotFoundError: no history'),
    })
    const result = await continueCard({ store, cardId: card.id, port, message: 'go on' })
    assert.equal(result.mode, 'created', 'a refused level-1 session must end at a fresh session')
    assert.equal(result.fallbackRecorded, true)
    assert.equal(calls.followup.length, 0, 'followup was attempted but rejected (error thrown before push)')
    assert.equal(calls.resume.length, 1, 'level 2 was attempted')
    assert.equal(calls.create.length, 1, 'level 3 rebuilt a fresh session')
    const record = store.getCard(card.id).history.find((h) => h.type === 'continuation-fallback')
    assert.ok(record, 'fallback must be recorded on the card')
    assert.match(String(record.reason), /danger-full-access/, 'the LEVEL 1 refusal reason wins over the level 2 one')
    assert.equal(store.getCard(card.id).sessionId, 'session-new')
    assert.equal(store.getCard(card.id).pendingDispatch, null, 'claim released after the fall through')
  } finally { cleanup() }
})

test('level 2: a dead session with history is resumed on the SAME sessionId', async () => {
  const { store, card, cleanup } = setup()
  try {
    const { port, calls } = fakePort({ active: false })
    const before = store.getCard(card.id).sessionTurn
    const result = await continueCard({ store, cardId: card.id, port })
    assert.equal(result.mode, 'resumed')
    assert.equal(result.sessionId, 'session-1', 'resume must reuse the original id')
    assert.equal(calls.resume.length, 1)
    assert.equal(calls.resume[0].resumeSessionId, 'session-1')
    assert.equal(calls.resume[0].cwd, WORKTREE, 'resumes in the existing worktree')
    assert.equal(calls.create.length, 0, 'no fresh session at level 2')
    const after = store.getCard(card.id)
    assert.ok(after.sessionTurn >= (before ?? 0), 'the turn counter moves forward, never back')
    assert.equal(after.sessionId, 'session-1')
    assert.equal(after.pendingDispatch, null)
  } finally { cleanup() }
})

// --- level 3 -----------------------------------------------------------------

test('level 3: unusable history falls back to a fresh session AND records why', async () => {
  const { store, card, cleanup } = setup()
  try {
    const { port, calls } = fakePort({
      active: false, resumeError: new Error('SessionPersistenceNotFoundError: no history'),
    })
    const result = await continueCard({ store, cardId: card.id, port })
    assert.equal(result.mode, 'created')
    assert.equal(result.sessionId, 'session-new')
    assert.equal(calls.resume.length, 1, 'it tried level 2 first')
    assert.equal(calls.create.length, 1, 'then fell back to a fresh session')
    const types = historyTypes(store, card.id)
    assert.ok(types.includes('continuation-fallback'), 'the fallback MUST be recorded on the card')
    const record = store.getCard(card.id).history.find((h) => h.type === 'continuation-fallback')
    assert.match(String(record.reason), /SessionPersistenceNotFoundError/, 'the reason is kept for later')
    assert.equal(record.fromSessionId, 'session-1')
    assert.equal(store.getCard(card.id).sessionId, 'session-new')
  } finally { cleanup() }
})

// --- circuit breaker ---------------------------------------------------------

test('circuit breaker: three consecutive failures stall the card and stop further dispatch', async () => {
  const { store, card, cleanup } = setup()
  try {
    // EVERY level must fail, otherwise level 2 succeeds and the breaker never trips.
    const { port } = fakePort({
      active: false,
      resumeError: new Error('history gone'),
      createError: new Error('host exploded'),
    })
    const results = []
    for (let i = 0; i < DEFAULT_DISPATCH_FAILURE_LIMIT; i += 1) {
      let threw = null
      try { await continueCard({ store, cardId: card.id, port }) } catch (error) { threw = error }
      results.push(threw === null ? 'no-error' : threw.message)
      // Check the claim separately so a failing assertion cannot truncate the loop.
      assert.equal(store.getCard(card.id).pendingDispatch, null, `claim released after failure ${i + 1}`)
    }
    assert.equal(results.length, DEFAULT_DISPATCH_FAILURE_LIMIT, 'every attempt ran')
    assert.equal(results.filter((r) => r === 'no-error').length, 0, 'all attempts failed')
    const after = store.getCard(card.id)
    assert.equal(after.dispatchFailures, DEFAULT_DISPATCH_FAILURE_LIMIT)
    assert.equal(after.stalled, true, 'the breaker tripped')
    const turnBefore = 1 // setWorktree seeds sessionTurn to 1
    assert.equal(after.sessionTurn, turnBefore, 'failed turns are not counted as turns')

    // A stalled card is refused before any side effect.
    const refused = fakePort({ active: true })
    await assert.rejects(
      () => continueCard({ store, cardId: card.id, port: refused.port }),
      /不可接续.*stalled/,
    )
    assert.equal(refused.calls.followup.length, 0, 'no side effect on a stalled card')
  } finally { cleanup() }
})

test('circuit breaker: a success clears the failure streak', async () => {
  const { store, card, cleanup } = setup()
  try {
    const failing = fakePort({ active: false, resumeError: new Error('gone'), createError: new Error('boom') })
    try { await continueCard({ store, cardId: card.id, port: failing.port }) } catch { /* expected */ }
    assert.equal(store.getCard(card.id).dispatchFailures, 1)

    const ok = fakePort({ active: true })
    await continueCard({ store, cardId: card.id, port: ok.port })
    const after = store.getCard(card.id)
    assert.equal(after.dispatchFailures, 0, 'a success resets the streak')
    assert.equal(after.stalled, false)
  } finally { cleanup() }
})

// --- refusal paths -----------------------------------------------------------

test('refusal: terminal and waiting-for-human statuses never reach the port', async () => {
  const { store, card, cleanup } = setup()
  try {
    const { port, calls } = fakePort({ active: true })
    // Move to review — a status a human owns, not the agent.
    store.transitionCard(card.id, 'plan-review', 'agent')
    store.transitionCard(card.id, 'build', 'human')
    store.transitionCard(card.id, 'review', 'agent')
    await assert.rejects(() => continueCard({ store, cardId: card.id, port }), /不可接续|waiting-for-human/)
    assert.equal(calls.followup.length, 0)

    assert.equal(assertDispatchable({ status: 'done' }).reason, 'terminal')
    assert.equal(assertDispatchable({ status: 'canceled' }).reason, 'terminal')
    assert.equal(assertDispatchable({ status: 'review' }).reason, 'waiting-for-human')
    assert.equal(assertDispatchable({ status: 'inbox' }).ok, true, 'inbox is agent-owned, not waiting')
    assert.equal(assertDispatchable({ status: 'triage' }).ok, true)
    assert.equal(assertDispatchable({ status: 'plan-review' }).reason, 'waiting-for-human')
    assert.equal(assertDispatchable({ status: 'build' }).ok, true)
    assert.equal(assertDispatchable({ status: 'plan', stalled: true }).reason, 'stalled')
    assert.equal(assertDispatchable(null).reason, 'missing-card')
  } finally { cleanup() }
})

test('refusal: a card with no worktree must use first dispatch, not continuation', async () => {
  const { store, cleanup } = setup()
  try {
    const project = store.listProjects()[0]
    const board = store.listBoards(project.id)[0]
    const fresh = store.createCard({ boardId: board.id, title: 'never dispatched' })
    store.transitionCard(fresh.id, 'triage', 'human')
    store.transitionCard(fresh.id, 'plan', 'agent')
    const { port, calls } = fakePort({ active: false })
    await assert.rejects(() => continueCard({ store, cardId: fresh.id, port }), /没有 worktree/)
    assert.equal(calls.create.length, 0, 'a continuation must not silently provision a worktree')
    assert.equal(calls.worktree.length, 0)
  } finally { cleanup() }
})

test('concurrency: a second continuation while one is in flight is refused', async () => {
  const { store, card, cleanup } = setup()
  try {
    const claim = store.claimForDispatch(card.id)
    assert.equal(claim.claimed, true)
    const { port, calls } = fakePort({ active: true })
    await assert.rejects(() => continueCard({ store, cardId: card.id, port }), /并发锁|正在被接续/)
    assert.equal(calls.followup.length, 0, 'the second call does no work')
    store.releaseClaim(card.id, claim.token)
  } finally { cleanup() }
})

// --- worktree invariants -----------------------------------------------------

test('a continuation never creates a worktree, and a failure never deletes one', async () => {
  const { store, card, cleanup } = setup()
  try {
    const failing = fakePort({ active: false, resumeError: new Error('gone'), createError: new Error('boom') })
    try { await continueCard({ store, cardId: card.id, port: failing.port }) } catch { /* expected */ }
    assert.equal(failing.calls.worktree.length, 0, 'no worktree is provisioned')
    const after = store.getCard(card.id)
    assert.equal(after.worktreePath, WORKTREE, 'the existing worktree survives a failed continuation')
    assert.equal(after.branch, BRANCH, 'the branch is untouched')
    assert.equal(after.status, 'plan', 'the status is left for a human to decide')
  } finally { cleanup() }
})

// --- dispatch ⇄ continue handoff (Chief's explicit check) --------------------

test('handoff: once dispatch is refused as already-dispatched, continueCard still works', async () => {
  // If the new "already provisioned" guard also blocked continuation, the card
  // would be stuck forever: dispatch says "use continue" and continue says no.
  const tmp = mkdtempSync(join(tmpdir(), 'qa-handoff-'))
  try {
    const { dispatchCard } = await import('../dispatch.js')
    const store = new FactoryStore({ file: join(tmp, 'factory.json') })
    const project = store.createProject({ name: 'p', rootPath: '/workspace/p' })
    const board = store.createBoard({ projectId: project.id, name: 'b' })
    const card = store.createCard({ boardId: board.id, title: 'c' })

    let sessions = 0
    const calls = { worktree: 0, followup: 0 }
    const port = {
      createWorktree: () => { calls.worktree += 1 },
      removeWorktree: () => {},
      prepareWorktree: () => {},
      async createSession() { sessions += 1; return { sessionId: `sess-${sessions}`, handle: { dispose: () => {} } } },
      async disposeSession() {},
      async isSessionActive() { return true },
      async followupSession() { calls.followup += 1 },
      async resumeSession(o) { return { sessionId: o.resumeSessionId, handle: { dispose: () => {} } } },
    }

    const first = await dispatchCard({ store, cardId: card.id, port })
    assert.equal(first.mode, 'created')
    assert.equal(calls.worktree, 1)

    const second = await dispatchCard({ store, cardId: card.id, port })
    assert.equal(second.mode, 'already-dispatched', 'a second dispatch is refused, not re-provisioned')
    assert.equal(calls.worktree, 1, 'no second worktree')
    assert.equal(sessions, 1, 'no second session')

    // The refusal must NOT be a dead end: continue still reaches level 1.
    const continued = await continueCard({ store, cardId: card.id, port })
    assert.equal(continued.mode, 'followup', 'a live session is reused after the dispatch refusal')
    assert.equal(continued.sessionId, first.sessionId, 'same session id all the way through')
    assert.equal(calls.followup, 1)
    assert.equal(calls.worktree, 1, 'continuation never provisions a worktree')
    assert.equal(sessions, 1, 'continuation never creates a session at level 1')
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})
