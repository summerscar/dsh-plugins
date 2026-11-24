import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FactoryStore } from '../store.js'
import { applyRemoteSync, deriveRemoteTarget, resolveSync } from '../sync.js'
import { STATUS } from '../state.js'

function fixture(status = STATUS.PR_REVIEW) {
  const tmp = mkdtempSync(join(tmpdir(), 'dev-sync-'))
  const store = new FactoryStore({ file: join(tmp, 'state.json') })
  const project = store.createProject({ name: 'p', rootPath: '/repo' })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  const card = store.createCard({ boardId: board.id, title: 't' })
  store.setWorktree(card.id, { worktreePath: '/w', branch: 'factory/card' })
  for (const to of ['triage', 'plan', 'build', 'self-review', 'pr-review'].slice(0, ['triage', 'plan', 'build', 'self-review', 'pr-review'].indexOf(status) + 1)) {
    store.transitionCard(card.id, to, to === 'triage' ? 'human' : 'agent')
  }
  store.setPrUrl(card.id, 'https://example/pr/1', 'agent')
  return { store, card: store.getCard(card.id), cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

test('deriveRemoteTarget maps MERGED to done and CLOSED to build', () => {
  assert.deepEqual(deriveRemoteTarget({ pr: { state: 'MERGED' } }), { target: 'done', reason: 'PR merged' })
  assert.deepEqual(deriveRemoteTarget({ pr: { state: 'CLOSED' } }), { target: 'build', reason: 'PR closed without merge' })
  assert.equal(deriveRemoteTarget({ pr: { state: 'OPEN' } }), null)
})

test('a merged ACTIVE PR auto-completes via syncRule and is idempotent', () => {
  const f = fixture()
  try {
    const first = applyRemoteSync({ store: f.store, cardId: f.card.id, remote: { pr: { state: 'MERGED' } } })
    assert.deepEqual(first, { changed: true, target: 'done' })
    assert.equal(f.store.getCard(f.card.id).status, 'done')
    const again = applyRemoteSync({ store: f.store, cardId: f.card.id, remote: { pr: { state: 'MERGED' } } })
    assert.deepEqual(again, { changed: false })
    const history = f.store.getCard(f.card.id).history.filter((h) => h.type === 'transition' && h.to === 'done')
    assert.equal(history.length, 1)
    assert.equal(history[0].actor, 'syncRule')
  } finally { f.cleanup() }
})

test('a closed-unmerged PR stays in pr-review as a human suggestion', () => {
  const f = fixture()
  try {
    const out = applyRemoteSync({ store: f.store, cardId: f.card.id, remote: { pr: { state: 'CLOSED' } } })
    assert.deepEqual(out, { changed: false, needsHuman: true, suggestion: { target: 'build', reason: 'PR closed without merge', autoApplicable: false, requiresHuman: true } })
    assert.equal(f.store.getCard(f.card.id).status, 'pr-review')
  } finally { f.cleanup() }
})

test('resolveSync reports no change for OPEN', () => {
  const f = fixture()
  try {
    assert.deepEqual(resolveSync(f.store.getCard(f.card.id), { pr: { state: 'OPEN' } }), { suggestion: null })
  } finally { f.cleanup() }
})
