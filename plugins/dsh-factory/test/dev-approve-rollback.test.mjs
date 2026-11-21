/**
 * Dev self-check for the approve-plan symmetric rollback (PM flow risk):
 *  - a failed /continue after plan-review->build can return the card to
 *    plan-review via a deliberate synthetic agent edge (like return-to-plan)
 *  - the HTTP continuation handler performs that rollback and records an audit
 *    event on failure, so a card is never stranded in build without a session
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { FactoryStore } from '../store.js'
import { canTransition, assertTransition } from '../state.js'
import { assertDispatchable } from '../dispatch.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const indexSrc = readFileSync(join(root, 'index.js'), 'utf8')

function fixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'dev-approve-rollback-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: '/workspace/p' })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  const card = store.createCard({ boardId: board.id, title: 'c' })
  return { store, project, board, card, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

test('Dev-ApproveRollback: build->plan-review is a deliberate synthetic agent edge', () => {
  assert.equal(canTransition('build', 'plan-review', 'agent'), true, 'agent may synthesize the rollback')
  assert.equal(canTransition('build', 'plan-review', 'human'), false, 'human tool cannot freely move build back')
  assert.doesNotThrow(() => assertTransition('build', 'plan-review', 'agent'))
})

test('Dev-ApproveRollback: store performs the rollback and keeps the card retryable', () => {
  const f = fixture()
  try {
    // Approve path: plan-review -> build (human), then a failed continue.
    f.store.transitionCard(f.card.id, 'triage', 'human')
    f.store.transitionCard(f.card.id, 'plan', 'agent')
    f.store.transitionCard(f.card.id, 'plan-review', 'agent')
    f.store.transitionCard(f.card.id, 'build', 'human')
    assert.equal(f.store.getCard(f.card.id).status, 'build')
    const back = f.store.transitionCard(f.card.id, 'plan-review', 'agent', 'continuation failed; retry')
    assert.equal(back.status, 'plan-review', 'card is retryable at plan-review, not stranded in build')
    const transitions = back.history.filter((h) => h.type === 'transition' && h.to === 'plan-review')
    assert.ok(transitions.length >= 1, 'rollback was recorded in history')
  } finally { f.cleanup() }
})

test('Dev-ApproveRollback: /continue handler rolls back on failure and audits it', () => {
  const continuation = indexSrc.slice(indexSrc.indexOf('const continuation ='), indexSrc.indexOf('// P2a: independent review'))
  assert.match(continuation, /transitionCard\(cardId, 'plan-review', 'agent'/, 'failed continue rolls back to plan-review')
  assert.match(continuation, /approve-plan-continue-failed/, 'records a dedicated audit event')
  assert.match(continuation, /status === 'build'/, 'only rolls back a card stranded in build')
  assert.match(continuation, /retryable: true/, 'signals the client it can retry')
})

test('Dev-ApproveRollback: rollback branch clears the failure counter so retries stay possible', () => {
  const continuation = indexSrc.slice(indexSrc.indexOf('const continuation ='), indexSrc.indexOf('// P2a: independent review'))
  const branch = continuation.match(/if \(store\.getCard\(cardId\)\?\.status === 'build'\) \{[\s\S]*?\n        \}/)?.[0]
  assert.ok(branch, 'build rollback branch found')
  assert.match(branch, /clearDispatchFailures\(cardId\)/, 'rollback clears dispatchFailures/stalled')
  // Outside the build branch, the generic failure path must NOT clear the count.
  const generic = continuation.slice(continuation.lastIndexOf('sendJson(res, 400, { error: message'))
  assert.doesNotMatch(generic, /clearDispatchFailures/, 'generic continuation failure keeps its stall protection')
})

test('Dev-ApproveRollback: three failed approve+rollback cycles never latch stalled', () => {
  const f = fixture()
  try {
    const id = f.card.id
    f.store.transitionCard(id, 'triage', 'human')
    f.store.transitionCard(id, 'plan', 'agent')
    f.store.transitionCard(id, 'plan-review', 'agent')
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      // approve: plan-review -> build, then continue fails -> recordDispatchFailure
      f.store.transitionCard(id, 'build', 'human')
      f.store.recordDispatchFailure(id, { reason: `fail ${attempt}` })
      // the /continue rollback: synthetic edge back + clear the counter
      f.store.transitionCard(id, 'plan-review', 'agent', 'continuation failed; retry')
      f.store.clearDispatchFailures(id)
      const card = f.store.getCard(id)
      assert.equal(card.status, 'plan-review', `cycle ${attempt}: back at plan-review`)
      assert.equal(card.stalled, false, `cycle ${attempt}: not stalled`)
      assert.equal(card.dispatchFailures, 0, `cycle ${attempt}: counter cleared`)
    }
    // The 4th approve transitions to build; the continue gate must now pass
    // (previously stalled latched here and refused before any session work).
    f.store.transitionCard(id, 'build', 'human')
    assert.deepEqual(assertDispatchable(f.store.getCard(id)), { ok: true }, '4th retry passes the dispatch gate')
  } finally { f.cleanup() }
})

test('Dev-ApproveRollback: recordDispatchFailure still latches stalled outside the rollback', () => {
  const f = fixture()
  try {
    const id = f.card.id
    for (let i = 0; i < 3; i += 1) f.store.recordDispatchFailure(id, { reason: 'real failure' })
    const card = f.store.getCard(id)
    assert.equal(card.dispatchFailures, 3, 'counter accumulates when not cleared')
    assert.equal(card.stalled, true, 'stall still trips for real repeated failures')
    assert.deepEqual(assertDispatchable(card), { ok: false, reason: 'stalled' }, 'stall protection intact')
  } finally { f.cleanup() }
})
