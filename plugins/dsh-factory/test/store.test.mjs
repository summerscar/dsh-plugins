/**
 * Store tests — persistence (E3), multi-project isolation (A1/A2), the state
 * flow (C3/C4), and the Review-only authorization gate (AG-2/D4/D6).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FactoryStore } from '../store.js'
import { withTempDataRoot } from './qa-helpers.mjs'

function withStore(fn) {
  const tmp = mkdtempSync(join(tmpdir(), 'factory-store-'))
  try {
    return fn(join(tmp, 'factory.json'))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function projectWithBoardAndCard(store, name = 'p') {
  const project = store.createProject({ name, rootPath: `/workspace/${name}` })
  const board = store.createBoard({ projectId: project.id, name: 'board' })
  const card = store.createCard({ boardId: board.id, title: 'card' })
  return { project, board, card }
}

test('projects, boards and cards persist across a reload (E3)', () => withStore((file) => {
  const store = new FactoryStore({ file })
  const { project, card } = projectWithBoardAndCard(store, 'persist')

  const reopened = new FactoryStore({ file })
  assert.equal(reopened.getProject(project.id).name, 'persist')
  assert.equal(reopened.getCard(card.id).status, 'inbox')
  assert.equal(reopened.listBoards(project.id).length, 1)
}))

test('cards are isolated per project and deleting one project leaves others intact (A1/A2)', () => withStore((file) => {
  const store = new FactoryStore({ file })
  const a = projectWithBoardAndCard(store, 'alpha')
  const b = projectWithBoardAndCard(store, 'beta')

  assert.deepEqual(store.listCards({ projectId: a.project.id }).map((c) => c.id), [a.card.id])
  assert.deepEqual(store.listCards({ projectId: b.project.id }).map((c) => c.id), [b.card.id])

  store.deleteProject(a.project.id)
  assert.equal(store.getProject(a.project.id), undefined)
  assert.equal(store.listCards({ projectId: a.project.id }).length, 0)
  assert.equal(store.getCard(b.card.id).id, b.card.id, 'project B survives')
}))

test('a new card starts in Inbox and only legal edges move it (C3/C4)', () => withStore((file) => {
  const store = new FactoryStore({ file })
  const { card } = projectWithBoardAndCard(store)
  assert.equal(store.getCard(card.id).status, 'inbox')

  // Human starts processing: Inbox → Triage.
  assert.equal(store.transitionCard(card.id, 'triage', 'human').status, 'triage')
  // Agent cannot start from Inbox; illegal edge is refused outright.
  assert.throws(() => store.transitionCard(card.id, 'build', 'human'), /非法转移/)
}))

test('the delivery buttons are Review-only and leave an audit record (AG-2/D4)', () => withStore((file) => {
  const store = new FactoryStore({ file })
  const { card } = projectWithBoardAndCard(store)

  // From Inbox, authorizing a delivery action is refused.
  assert.throws(() => store.authorize(card.id, 'create-pr'), /仅 Review/)

  // Drive the card to Review via the legal path, then authorize.
  store.transitionCard(card.id, 'triage', 'human')
  store.transitionCard(card.id, 'plan', 'agent')
  store.transitionCard(card.id, 'plan-review', 'agent')
  store.transitionCard(card.id, 'build', 'human')
  store.transitionCard(card.id, 'review', 'agent')

  const entry = store.authorize(card.id, 'confirm-commit')
  assert.equal(entry.actor, 'human')
  assert.equal(entry.statusSnapshot, 'review')
  assert.ok(typeof entry.at === 'string' && entry.at.length > 0)
}))

test('a created PR keeps the card in Review; Done is still a separate human step (D6)', () => withStore((file) => {
  const store = new FactoryStore({ file })
  const { card } = projectWithBoardAndCard(store)
  for (const [to, actor] of [['triage', 'human'], ['plan', 'agent'], ['plan-review', 'agent'], ['build', 'human'], ['review', 'agent']]) {
    store.transitionCard(card.id, to, actor)
  }
  const after = store.setPrUrl(card.id, 'https://github.com/x/y/pull/1')
  assert.equal(after.status, 'review', 'PR success stays in Review')
  assert.equal(after.prUrl, 'https://github.com/x/y/pull/1')

  // The card cannot skip straight to Done by an agent.
  assert.throws(() => store.transitionCard(card.id, 'done', 'agent'), /不允许由 agent 触发/)
  // A human marks it done explicitly.
  assert.equal(store.transitionCard(card.id, 'done', 'human').status, 'done')
}))

test('uiLocale persists a BCP 47 id and can be cleared', () => withStore((file) => {
  const store = new FactoryStore({ file })
  assert.equal(store.getUiLocaleSetting(), '')
  assert.equal(store.updateUiLocale('fr').uiLocale, 'fr')
  assert.equal(new FactoryStore({ file }).getUiLocaleSetting(), 'fr', 'survives reload')
  assert.throws(() => store.updateUiLocale('bad id'), /BCP 47/)
  assert.equal(store.updateUiLocale('').uiLocale, '')
  assert.equal(store.getUiLocaleSetting(), '')
}))

test('a project under the data root is accepted with a warning; defaults are sane (E4/F1)', () => withTempDataRoot((dataRoot) => withStore((file) => {
  const store = new FactoryStore({ file })
  // The data root is INJECTED, not borrowed: a literal /data/dsh would pass on this
  // machine and fail wherever DSH_HOME points elsewhere, and using the machine's
  // real root would make the case depend on that root being writable.
  const project = store.createProject({ name: 'under-data', rootPath: join(dataRoot, 'home', 'default', 'repo') })
  assert.match(project.warning, /数据根/)
  assert.equal(project.defaultPermission, 'workspace-write')
  assert.equal(project.autonomy, 'manual')
  assert.equal(project.autoDispatch, false)
  assert.equal('autoStart' in project, false)
  assert.equal('autoApprove' in project, false)
})))
