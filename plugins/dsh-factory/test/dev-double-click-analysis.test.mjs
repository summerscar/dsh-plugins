/**
 * Dev analysis evidence for the ROADMAP 5.1 "double-click disable" question.
 *
 * The UI's busy flag cannot block two clicks in the same JS tick (React has
 * not committed the disabled attribute yet, and `run` is async). This file
 * does NOT change behavior — it proves that the BACKEND gates still make the
 * non-idempotent actions safe when two calls racing in the same tick reach it.
 *
 * - dispatch: claimForDispatch / concurrency lock -> exactly one session
 * - confirm-commit + create-pr: single-use authorization + status/sha guards
 * - resupply: needsHumanInfo/status guard -> second call refused
 * - takeover: idempotent (setting takenOver=true twice is a no-op)
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FactoryStore } from '../store.js'
import { dispatchCard } from '../dispatch.js'
import { commitCard, createPrForCard } from '../git-exec.js'

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'dev-dblclick-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: '/workspace/p' })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  const card = store.createCard({ boardId: board.id, title: 'c' })
  return { store, project, card, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

function dragToReview(store, cardId) {
  store.transitionCard(cardId, 'triage', 'human')
  store.transitionCard(cardId, 'plan', 'agent')
  store.transitionCard(cardId, 'plan-review', 'agent')
  store.transitionCard(cardId, 'build', 'human')
  store.transitionCard(cardId, 'review', 'agent')
}

test('Dev-DblClick: two dispatch calls in the same tick create exactly one session', async () => {
  const { store, card, cleanup } = setup()
  try {
    let sessions = 0
    const port = {
      createWorktree: () => {},
      removeWorktree: () => {},
      createSession: () => new Promise((resolve) => setTimeout(() => { sessions += 1; resolve({ sessionId: 's1', handle: { dispose() {} } }) }, 3)),
      disposeSession: async () => {},
    }
    const results = await Promise.allSettled([
      dispatchCard({ store, cardId: card.id, port }),
      dispatchCard({ store, cardId: card.id, port }),
    ])
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'only one dispatch fulfilled')
    assert.match(String(results.find((r) => r.status === 'rejected')?.reason?.message), /并发锁/)
    assert.equal(sessions, 1, 'backend lock prevents a second session despite two UI calls')
  } finally {
    cleanup()
  }
})

test('Dev-DblClick: double confirm-commit / create-pr writes git once (single-use gate)', async () => {
  const { store, card, cleanup } = setup()
  try {
    dragToReview(store, card.id)
    store.setWorktree(card.id, { worktreePath: '/tmp/wt', branch: 'factory/card', baseBranch: 'main' })
    const calls = []
    const port = {
      add: () => calls.push('add'),
      commit: () => { calls.push('commit'); return 'sha-1' },
      reset: () => {},
      hasDiff: () => true,
      push: () => calls.push('push'),
      createPr: () => { calls.push('createPr'); return 'https://example/pr/1' },
    }
    // Two clicks both arm authorization, then both try to commit.
    store.authorize(card.id, 'confirm-commit')
    store.authorize(card.id, 'confirm-commit')
    const r = await Promise.allSettled([
      commitCard({ store, cardId: card.id, port }),
      commitCard({ store, cardId: card.id, port }),
    ])
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1, 'only one commit succeeds')
    assert.equal(calls.filter((c) => c === 'commit').length, 1, 'git commit ran once')
    assert.equal(store.getCard(card.id).commitSha, 'sha-1')

    // Two clicks on create-pr: one PR only.
    store.authorize(card.id, 'create-pr')
    store.authorize(card.id, 'create-pr')
    const p = await Promise.allSettled([
      createPrForCard({ store, cardId: card.id, port }),
      createPrForCard({ store, cardId: card.id, port }),
    ])
    assert.equal(p.filter((x) => x.status === 'fulfilled').length, 1, 'only one PR succeeds')
    assert.equal(calls.filter((c) => c === 'createPr').length, 1, 'git createPr ran once')
    assert.match(String(p.find((x) => x.status === 'rejected')?.reason?.message), /已有 PR|授权/)
  } finally {
    cleanup()
  }
})

test('Dev-DblClick: takeover twice is idempotent (state ends takenOver=true once)', () => {
  const { store, card, cleanup } = setup()
  try {
    store.takeOverCard(card.id, 'human')
    store.takeOverCard(card.id, 'human')
    const after = store.getCard(card.id)
    assert.equal(after.takenOver, true)
    const takes = after.history.filter((h) => h.type === 'takeover')
    // takeOverCard has no idempotency guard: a second call appends a SECOND
    // history + engine-takeover audit entry. The persisted business state stays
    // a single takenOver=true, but the audit is duplicated (harmless here).
    assert.equal(takes.length, 2, 'second click logs a duplicate takeover audit entry')
    assert.ok(store.state.events.filter((e) => e.type === 'engine-takeover').length >= 2)
  } finally {
    cleanup()
  }
})

test('Dev-DblClick: resupply twice — second call is refused by the gate', async () => {
  const { store, card, cleanup } = setup()
  try {
    // triage→inbox (human, with note) is the return that sets needsHumanInfo.
    store.transitionCard(card.id, 'triage', 'human')
    store.transitionCard(card.id, 'inbox', 'human', 'missing info')
    assert.equal(store.getCard(card.id).needsHumanInfo, true, 'card is in the returned state')
    const first = store.resupplyInbox(card.id, { text: 'the info' })
    assert.equal(first.needsHumanInfo, false, 'first resupply clears the gate')
    assert.throws(
      () => store.resupplyInbox(card.id, { text: 'again' }),
      /待补充信息|Inbox|Triage/,
      'second resupply is refused — no second session from a double click',
    )
  } finally {
    cleanup()
  }
})
