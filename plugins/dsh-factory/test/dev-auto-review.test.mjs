/**
 * Dev self-check for L4 auto review dispatch (the missing link in auto-delivery):
 *  - the tick auto-dispatches a review session for an L4 Review card that has
 *    no reviewer yet, so a verdict can be produced and the delivery gate can
 *    later pass
 *  - it is idempotent: a card that already has a reviewSessionId is not
 *    dispatched again
 *  - it is L4-only: machine-approve / you-approve / manual never auto-review
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { FactoryStore } from '../store.js'
import { runTick, createEngineStatus, defaultEngineDeps, AUTO_DELIVERY_TIER } from '../autonomy.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const autonomySrc = readFileSync(join(root, 'autonomy.js'), 'utf8')

function fixture({ autonomy = AUTO_DELIVERY_TIER, withReviewSession = true } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'dev-autoreview-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: '/workspace/p' })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  const card = store.createCard({ boardId: board.id, title: 'c' })
  store.setWorktree(card.id, { worktreePath: '/tmp/wt', branch: 'b', baseBranch: 'main', sessionId: 'builder' })
  for (const [to, actor] of [['triage', 'human'], ['plan', 'agent'], ['plan-review', 'agent'], ['build', 'human'], ['review', 'agent']]) {
    store.transitionCard(card.id, to, actor)
  }
  if (withReviewSession) store.setReviewSession(card.id, 'reviewer-1', 'created')
  store.updateAutonomy(project.id, { autonomy })
  return { store, project, board, card, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

function depsFor(calls) {
  return {
    ghPort: {}, intake: async () => ({ created: [] }), dispatch: async () => ({ mode: 'none' }),
    isSessionActive: async () => false,
    deliver: async () => ({ delivered: false }),
    reviewDispatch: async ({ store, cardId }) => { calls.push(cardId); store.setReviewSession(cardId, 'reviewer-auto', 'created'); return { sessionId: 'reviewer-auto' } },
  }
}

test('Dev-AutoReview: L4 Review card without a reviewer auto-dispatches a review session', async () => {
  const f = fixture({ autonomy: AUTO_DELIVERY_TIER, withReviewSession: false })
  try {
    const calls = []
    const status = createEngineStatus()
    await runTick({ store: f.store, status, deps: depsFor(calls) })
    assert.deepEqual(calls, [f.card.id], 'review session dispatched for the L4 Review card')
    assert.equal(f.store.getCard(f.card.id).reviewSessionId, 'reviewer-auto', 'reviewer id recorded')
    assert.equal(status.projects[0].reviewDispatched, 1, 'report counts the review dispatch')
  } finally { f.cleanup() }
})

test('Dev-AutoReview: a card that already has a reviewSessionId is not re-dispatched', async () => {
  const f = fixture({ autonomy: AUTO_DELIVERY_TIER, withReviewSession: true })
  try {
    const calls = []
    await runTick({ store: f.store, status: createEngineStatus(), deps: depsFor(calls) })
    assert.equal(calls.length, 0, 'no duplicate review dispatch')
    assert.equal(f.store.getCard(f.card.id).reviewSessionId, 'reviewer-1', 'existing reviewer untouched')
  } finally { f.cleanup() }
})

test('Dev-AutoReview: non-L4 tiers never auto-dispatch a review', async () => {
  for (const autonomy of ['manual', 'you-approve', 'machine-approve']) {
    const f = fixture({ autonomy, withReviewSession: false })
    try {
      const calls = []
      await runTick({ store: f.store, status: createEngineStatus(), deps: depsFor(calls) })
      assert.equal(calls.length, 0, `${autonomy} does not auto-review`)
    } finally { f.cleanup() }
  }
})

test('Dev-AutoReview: defaultEngineDeps wires reviewDispatch via the host port', () => {
  assert.match(autonomySrc, /reviewDispatch:/, 'default deps expose reviewDispatch')
  assert.match(autonomySrc, /dispatchReview\(\{[\s\S]{0,160}createHostPort/, 'reviewDispatch uses a real host port')
})
