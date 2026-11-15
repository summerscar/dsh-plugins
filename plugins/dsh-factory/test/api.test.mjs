/**
 * API handler tests — the pure `{method, route, body}` surface that index.js
 * mounts under /api/dsh-factory. Covers CRUD filtering and the two safety edges:
 * an illegal transition and an out-of-Review authorization both come back 400.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createApi } from '../api.js'
import { FactoryStore } from '../store.js'

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'factory-api-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const api = createApi({ store, build: 'test' })
  return { store, api, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

test('project / board / card round-trip through the API', () => {
  const { api, cleanup } = setup()
  try {
    const status = api({ method: 'GET', route: '/status' })
    assert.equal(status.status, 200)
    assert.deepEqual(status.body.counts, { projects: 0, boards: 0, cards: 0 })

    const created = api({ method: 'POST', route: '/projects', body: { name: 'p1', rootPath: '/workspace/p1' } })
    assert.equal(created.status, 201)
    const projectId = created.body.project.id

    api({ method: 'POST', route: '/boards', body: { projectId, name: 'b1' } })
    const boards = api({ method: 'GET', route: `/boards?projectId=${projectId}` })
    assert.equal(boards.body.boards.length, 1)
    const boardId = boards.body.boards[0].id

    api({ method: 'POST', route: '/cards', body: { boardId, title: 'c1' } })
    const cards = api({ method: 'GET', route: `/cards?projectId=${projectId}` })
    assert.equal(cards.body.cards.length, 1)
    assert.equal(cards.body.cards[0].status, 'inbox')
  } finally {
    cleanup()
  }
})

test('an illegal transition and an out-of-Review authorization both return 400', () => {
  const { api, cleanup } = setup()
  try {
    const project = api({ method: 'POST', route: '/projects', body: { name: 'p', rootPath: '/workspace/p' } }).body.project
    const board = api({ method: 'POST', route: '/boards', body: { projectId: project.id, name: 'b' } }).body.board
    const card = api({ method: 'POST', route: '/cards', body: { boardId: board.id, title: 'c' } }).body.card

    const illegal = api({ method: 'POST', route: `/cards/${card.id}/transition`, body: { to: 'build', actor: 'human' } })
    assert.equal(illegal.status, 400)
    assert.match(illegal.body.error, /非法转移/)

    const badAuth = api({ method: 'POST', route: `/cards/${card.id}/authorize`, body: { action: 'create-pr' } })
    assert.equal(badAuth.status, 400)
    assert.match(badAuth.body.error, /仅 Review/)

    const legal = api({ method: 'POST', route: `/cards/${card.id}/transition`, body: { to: 'triage', actor: 'human' } })
    assert.equal(legal.status, 200)
    assert.equal(legal.body.card.status, 'triage')
  } finally {
    cleanup()
  }
})
