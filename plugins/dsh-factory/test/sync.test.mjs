/**
 * Remote-sync tests — the remote is the source of truth for facts, but Done and
 * Review→Build stay human-only, so those land as suggestions, never auto-moves.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FactoryStore } from '../store.js'
import { applyRemoteSync, deriveRemoteTarget, resolveSync } from '../sync.js'

function toReview(store, card) {
  store.transitionCard(card.id, 'triage', 'human')
  store.transitionCard(card.id, 'plan', 'agent')
  store.transitionCard(card.id, 'plan-review', 'agent')
  store.transitionCard(card.id, 'build', 'human')
  store.transitionCard(card.id, 'review', 'agent')
}

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'factory-sync-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: '/workspace/example-repo' })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  const card = store.createCard({ boardId: board.id, title: 'c' })
  toReview(store, card)
  return { store, card, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

test('deriveRemoteTarget maps PR state to a suggested column', () => {
  assert.deepEqual(deriveRemoteTarget({ pr: { state: 'MERGED' } }), { target: 'done', reason: 'PR merged' })
  assert.deepEqual(deriveRemoteTarget({ pr: { state: 'CLOSED' } }), { target: 'build', reason: 'PR closed without merge' })
  assert.equal(deriveRemoteTarget({ pr: { state: 'OPEN' } }), null)
  assert.equal(deriveRemoteTarget(null), null)
})

test('a merged PR becomes a human suggestion, never an auto-move to Done', () => {
  const { store, card, cleanup } = setup()
  try {
    const result = applyRemoteSync({ store, cardId: card.id, remote: { pr: { state: 'MERGED' } } })
    assert.equal(result.changed, false)
    assert.equal(result.needsHuman, true)
    assert.equal(result.suggestion.target, 'done')
    assert.equal(store.getCard(card.id).status, 'review', 'Done stays human-only')
    assert.ok(store.getCard(card.id).history.some((entry) => entry.type === 'sync-suggestion'))
  } finally {
    cleanup()
  }
})

test('a closed-unmerged PR suggests Build but does not auto-revert', () => {
  const { store, card, cleanup } = setup()
  try {
    const result = applyRemoteSync({ store, cardId: card.id, remote: { pr: { state: 'CLOSED' } } })
    assert.equal(result.needsHuman, true)
    assert.equal(result.suggestion.target, 'build')
    assert.equal(store.getCard(card.id).status, 'review')
  } finally {
    cleanup()
  }
})

test('an open PR (no state change) yields no suggestion', () => {
  const { store, card, cleanup } = setup()
  try {
    assert.deepEqual(resolveSync(store.getCard(card.id), { pr: { state: 'OPEN' } }), { suggestion: null })
    assert.deepEqual(applyRemoteSync({ store, cardId: card.id, remote: { pr: { state: 'OPEN' } } }), { changed: false })
  } finally {
    cleanup()
  }
})
