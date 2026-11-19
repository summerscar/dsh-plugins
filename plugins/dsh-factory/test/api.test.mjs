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

test('state/revision is one cheap probe scoped to the selected project', () => {
  const { api, cleanup } = setup()
  try {
    const rev = (projectId) => api({ method: 'GET', route: projectId ? `/state/revision?projectId=${projectId}` : '/state/revision' }).body.revision
    const first = rev()
    assert.equal(typeof first, 'string')
    assert.equal(rev(), first, 'a stable store gives a stable digest')

    const makeProject = (name) => {
      const project = api({ method: 'POST', route: '/projects', body: { name, rootPath: `/workspace/${name}` } }).body.project
      const board = api({ method: 'POST', route: '/boards', body: { projectId: project.id, name: 'b' } }).body.board
      const card = api({ method: 'POST', route: '/cards', body: { boardId: board.id, title: 'c' } }).body.card
      return { project, card }
    }
    const a = makeProject('a')
    const b = makeProject('b')
    const aBefore = rev(a.project.id)
    const bBefore = rev(b.project.id)
    const allBefore = rev()
    assert.notEqual(aBefore, bBefore)

    api({ method: 'POST', route: `/cards/${b.card.id}/transition`, body: { to: 'triage', actor: 'human' } })
    assert.equal(rev(a.project.id), aBefore, 'work in another project does not churn this board')
    assert.notEqual(rev(b.project.id), bBefore)
    assert.notEqual(rev(), allBefore)

    api({ method: 'POST', route: `/cards/${a.card.id}/transition`, body: { to: 'triage', actor: 'human' } })
    assert.notEqual(rev(a.project.id), aBefore)
  } finally {
    cleanup()
  }
})

test('POST /projects/inspect is read-only, returns signals, and writes nothing', () => {
  const { store, api, cleanup } = setup()
  try {
    // A fake inspect port keeps the test offline; the route must pass rootPath through.
    const fake = ({ rootPath }) => ({
      rootPath,
      packageManager: 'example@1',
      rootFiles: ['example.lock', 'main.py'],
      rootDirectories: ['src'],
      ignoreFiles: { '.gitignore': ['local.ini'] },
      manifestFiles: ['example.lock'],
      notes: ['raw facts only'],
    })
    const readOnly = createApi({ store, inspect: fake })
    const before = JSON.stringify(store.state)
    const res = readOnly({ method: 'POST', route: '/projects/inspect', body: { rootPath: '/workspace/repo' } })
    assert.equal(res.status, 200)
    assert.equal(res.body.signals.packageManager, 'example@1')
    assert.deepEqual(res.body.signals.rootFiles, ['example.lock', 'main.py'])
    assert.deepEqual(res.body.signals.rootDirectories, ['src'])
    assert.deepEqual(res.body.signals.ignoreFiles, { '.gitignore': ['local.ini'] })
    assert.equal('lockFiles' in res.body.signals, false, 'the old Node-only field must be gone')
    assert.equal('confirmToken' in res.body, false, 'inspection must NOT mint a token')
    assert.equal(JSON.stringify(store.state), before, 'inspection must not write anything')
  } finally {
    cleanup()
  }
})

test('POST /projects/inspect reports an illegal rootPath clearly without writing', () => {
  const { store, cleanup } = setup()
  try {
    const readOnly = createApi({ store, inspect: ({ rootPath }) => {
      throw new Error(`rootPath 不存在：${rootPath}`)
    } })
    const before = JSON.stringify(store.state)
    const res = readOnly({ method: 'POST', route: '/projects/inspect', body: { rootPath: '/nope' } })
    assert.equal(res.status, 400)
    assert.match(res.body.error, /不存在/)
    assert.equal(JSON.stringify(store.state), before)
  } finally {
    cleanup()
  }
})

test('PATCH /projects/:id writes autonomy separately from preparation', () => {
  const { store, api, cleanup } = setup()
  try {
    const created = api({ method: 'POST', route: '/projects', body: { name: 'auto', rootPath: '/workspace/dsh-plugins' } })
    const id = created.body.project.id
    assert.equal(created.body.project.autonomy, 'manual', 'a new project starts with the engine off')
    assert.equal('autoDispatch' in created.body.project, true, 'semantic switch field present')
    assert.equal(created.body.project.autoDispatch, false)

    const patched = api({ method: 'PATCH', route: `/projects/${id}`, body: { autonomy: 'you-approve', autoDispatch: true } })
    assert.equal(patched.status, 200)
    assert.equal(patched.body.project.autonomy, 'you-approve')
    assert.equal(patched.body.project.autoDispatch, true)
    assert.equal('autoApprove' in patched.body.project, false, 'legacy switch never stored')

    // machine-approve ignores the switch (single source of truth is the level).
    const machine = api({ method: 'PATCH', route: `/projects/${id}`, body: { autonomy: 'machine-approve', autoDispatch: true } })
    assert.equal(machine.body.project.autonomy, 'machine-approve')
    assert.equal(machine.body.project.autoDispatch, false, 'machine-approve never stores a switch')

    // Identity and rootPath are not writable through this route.
    const attempt = api({ method: 'PATCH', route: `/projects/${id}`, body: { autonomy: 'manual', rootPath: '/etc' } })
    assert.equal(attempt.body.project.rootPath, '/workspace/dsh-plugins', 'rootPath must stay put')

    // Dirty values are refused, never normalised into "running".
    const bad = api({ method: 'PATCH', route: `/projects/${id}`, body: { autonomy: 'L9' } })
    assert.equal(bad.status, 400)
    assert.match(String(bad.body.error), /autonomy/)

    // Mixing the two concerns in one PATCH is refused.
    const mixed = api({ method: 'PATCH', route: `/projects/${id}`, body: { autonomy: 'you-approve', copyFiles: ['a'] } })
    assert.equal(mixed.status, 400)
  } finally { cleanup() }
})
