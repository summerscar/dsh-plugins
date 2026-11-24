import assert from 'node:assert/strict'
import test from 'node:test'
import { createEngineStatus, runTick } from '../autonomy.js'
import { makeFixture } from './dev-v4-support.mjs'

async function tick(f) {
  const seen = []
  await runTick({
    store: f.store, status: createEngineStatus(),
    deps: {
      intake: async () => ({ created: [] }),
      dispatch: async ({ cardId }) => { seen.push(cardId); return { mode: 'created' } },
      approve: async () => ({ approved: false }),
      continue: async () => ({}),
      isSessionActive: async () => false,
    },
  })
  return seen
}

test('Dev-Auto: a default project auto-dispatches an Inbox card', async () => {
  const f = makeFixture({ status: 'inbox' })
  try {
    f.store.setWorktree(f.card.id, { worktreePath: '', branch: '' })
    f.store._card(f.card.id).sessionId = null
    f.store.updateIntake(f.project.id, { issueRepo: 'summerscar/factory-e2e-hono' })
    assert.deepEqual(await tick(f), [f.card.id])
  } finally { f.cleanup() }
})

test('Dev-Auto: narrowing inbox autoStart stops dispatch', async () => {
  const f = makeFixture({ status: 'inbox', phaseRules: { inbox: { autoStart: false } } })
  try {
    f.store.setWorktree(f.card.id, { worktreePath: '', branch: '' })
    f.store._card(f.card.id).sessionId = null
    f.store.updateIntake(f.project.id, { issueRepo: 'summerscar/factory-e2e-hono' })
    assert.deepEqual(await tick(f), [])
  } finally { f.cleanup() }
})

test('Dev-Auto: no autonomy or autoDispatch field is read by the engine', () => {
  const f = makeFixture()
  try {
    const project = f.store.getProject(f.project.id)
    assert.equal(project.autonomy, undefined)
    assert.equal(project.autoDispatch, undefined)
  } finally { f.cleanup() }
})

test('Dev-Auto: stage rules are the only automation configuration', () => {
  const f = makeFixture()
  try {
    assert.deepEqual(Object.keys(f.store.getProject(f.project.id).phaseRules).sort(),
      ['build', 'inbox', 'plan', 'pr-review', 'self-review', 'triage'].sort())
  } finally { f.cleanup() }
})
