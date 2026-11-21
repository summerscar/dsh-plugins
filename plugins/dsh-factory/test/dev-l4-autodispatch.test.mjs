/**
 * Dev self-check for the L4 auto-dispatch defect:
 *  - an auto-delivery project with an Inbox card actually dispatches on tick
 *  - L4 dispatch is independent of the (forced-false) autoDispatch switch
 *  - you-approve + autoDispatch=false still does NOT dispatch (regression guard)
 *  - machine-approve behavior is unchanged
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FactoryStore } from '../store.js'
import { runTick, createEngineStatus, behaviorOf, AUTO_DELIVERY_TIER } from '../autonomy.js'

function fixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'dev-l4-dispatch-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: '/workspace/p' })
  const board = store.createBoard({ projectId: project.id, name: 'main' })
  return { tmp, store, project, board, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

function deps() {
  const calls = { intake: 0, dispatch: 0, approve: 0, deliver: 0 }
  const active = new Map()
  return {
    calls,
    deps: {
      ghPort: {},
      intake: async () => { calls.intake += 1; return { created: [] } },
      dispatch: async ({ store: s, cardId, transitionActor }) => {
        calls.dispatch += 1
        s.transitionCard(cardId, 'triage', transitionActor)
        const sid = `s-${cardId}`; active.set(sid, true)
        s.setWorktree(cardId, { worktreePath: `/tmp/wt-${cardId}`, branch: 'b', baseBranch: 'main', sessionId: sid })
        return { mode: 'created' }
      },
      approve: async () => { calls.approve += 1; return { approved: true } },
      deliver: async () => { calls.deliver += 1; return { delivered: false } },
      isSessionActive: async (id) => active.get(id) === true,
    },
  }
}

async function runOne(f, autonomy, autoDispatch) {
  f.store.updateAutonomy(f.project.id, { autonomy, autoDispatch })
  f.store.updateIntake(f.project.id, { issueRepo: 'owner/repo', intakeBoardId: f.board.id })
  f.store.createCard({ boardId: f.board.id, title: 'c', source: 'issue:owner/repo#1' })
  const d = deps()
  const report = await runTick({ store: f.store, status: createEngineStatus(), deps: d.deps })
  return { report, calls: d.calls, card: f.store.listCards({})[0] }
}

test('Dev-L4: auto-delivery project dispatches its Inbox card on tick', async () => {
  assert.equal(behaviorOf(AUTO_DELIVERY_TIER).dispatch, true, 'L4 has dispatch capability')
  const f = fixture()
  try {
    const { calls, card } = await runOne(f, 'auto-delivery', false)
    assert.equal(calls.dispatch, 1, 'L4 dispatched the Inbox card once')
    assert.equal(card.status, 'triage', 'card left Inbox for triage')
  } finally { f.cleanup() }
})

test('Dev-L4: dispatch is independent of the forced-false autoDispatch switch', async () => {
  const f = fixture()
  try {
    // normalizeAutonomy forces autoDispatch=false for L4; both values must still dispatch.
    for (const sw of [false, true]) {
      const g = fixture()
      try {
        const { calls } = await runOne(g, 'auto-delivery', sw)
        assert.equal(calls.dispatch, 1, `L4 dispatches regardless of autoDispatch=${sw}`)
        assert.equal(g.store.getProject(g.project.id).autoDispatch, false, 'L4 stored autoDispatch is always false')
      } finally { g.cleanup() }
    }
  } finally { f.cleanup() }
})

test('Dev-L4 regression: you-approve + autoDispatch=false still does NOT dispatch', async () => {
  const f = fixture()
  try {
    const { calls, card } = await runOne(f, 'you-approve', false)
    assert.equal(calls.dispatch, 0, 'you-approve off stays discover-only')
    assert.equal(card.status, 'inbox', 'card remains in Inbox')
  } finally { f.cleanup() }
})

test('Dev-L4 regression: machine-approve still dispatches (unchanged)', async () => {
  const f = fixture()
  try {
    const { calls, card } = await runOne(f, 'machine-approve', false)
    assert.equal(calls.dispatch, 1, 'machine-approve dispatch unchanged')
    assert.equal(card.status, 'triage')
  } finally { f.cleanup() }
})
