/**
 * QA — P4 autonomy-UI acceptance (PRD .scratch/prd-p4-autonomy-ui.md §6).
 *
 * Backend-side judgements are exercised against the REAL store/api/autonomy
 * code with only the documented injectable boundaries faked (fake `remove`,
 * fake host deps for runTick, throwaway DSH_HOME). No business source is mocked
 * and no assertions are written to make a particular outcome pass.
 *
 * Covers: P4-0 (settings scope isolation), P4-4/P4-5 (three disjoint PATCH
 * blocks + verbatim errors), P4-7/7a/7b (effective cap priority, write-takes-
 * effect-next-tick, cross-reload persistence), P4-9 (delete really removes
 * this project's worktrees with all safety gates).
 *
 * Client-only judgements (P4-2 badge, naming, 44px, read-back) live in
 * qa-p4-client.test.mjs.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createApi, deleteProjectWithWorktrees } from '../api.js'
import { FactoryStore } from '../store.js'
import { createEngineStatus, effectiveGlobalMaxActive, runTick, DEFAULT_GLOBAL_MAX_ACTIVE } from '../autonomy.js'

function setup(engineConfig = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-p4-be-'))
  const file = join(tmp, 'factory.json')
  const store = new FactoryStore({ file })
  const api = createApi({
    store, build: 'test', engineConfig,
    runtime: { engine: createEngineStatus(), toolsRegistered: true },
  })
  const get = (route) => api({ method: 'GET', route })
  const patch = (route, body) => api({ method: 'PATCH', route, body })
  return { tmp, file, store, api, get, patch, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

function makeProject(store, name = 'p') {
  const project = store.createProject({ name, rootPath: `/workspace/${name}` })
  const board = store.createBoard({ projectId: project.id, name: 'main' })
  return { project, board }
}

// ---------------------------------------------------------------------------
// P4-0 — settings scope isolation: worktreeRoot and globalMaxActive each have
// their own setter; writing one must never clobber the other.
// ---------------------------------------------------------------------------

test('P4-0: PATCH /settings writes worktreeRoot and globalMaxActive independently', () => {
  const f = setup()
  try {
    const wt = f.patch('/settings', { worktreeRoot: '/tmp/qa-wt-root' })
    assert.equal(wt.status, 200)
    assert.equal(wt.body.settings.worktreeRoot, '/tmp/qa-wt-root')

    const cap = f.patch('/settings', { globalMaxActive: 3 })
    assert.equal(cap.status, 200)
    assert.equal(cap.body.settings.globalMaxActive, 3)
    assert.equal(cap.body.settings.worktreeRoot, '/tmp/qa-wt-root', 'a cap write must not clobber worktreeRoot')

    // Clearing the cap leaves worktreeRoot alone.
    const cleared = f.patch('/settings', { globalMaxActive: '' })
    assert.equal(cleared.body.settings.globalMaxActive, null)
    assert.equal(cleared.body.settings.worktreeRoot, '/tmp/qa-wt-root')
  } finally { f.cleanup() }
})

test('P4-0: a GET /settings round-trips both fields across a store reload', () => {
  const f = setup()
  try {
    f.patch('/settings', { worktreeRoot: '/tmp/qa-wt-root', globalMaxActive: 4 })
    const reopened = new FactoryStore({ file: f.file })
    const api2 = createApi({ store: reopened, engineConfig: {} })
    const settings = api2({ method: 'GET', route: '/settings' }).body.settings
    assert.equal(settings.worktreeRoot, '/tmp/qa-wt-root')
    assert.equal(settings.globalMaxActive, 4)
  } finally { f.cleanup() }
})

// ---------------------------------------------------------------------------
// P4-7 — effective cap priority and source (single source of truth).
// ---------------------------------------------------------------------------

test('P4-7: effective cap priority is settings > config > built-in default', () => {
  const f = setup()
  try {
    assert.deepEqual(effectiveGlobalMaxActive(f.store, {}), { value: DEFAULT_GLOBAL_MAX_ACTIVE, source: 'default' })
    assert.deepEqual(effectiveGlobalMaxActive(f.store, { globalMaxActive: 9 }), { value: 9, source: 'config' })
    f.store.updateGlobalMaxActive(2)
    assert.deepEqual(effectiveGlobalMaxActive(f.store, { globalMaxActive: 9 }), { value: 2, source: 'settings' },
      'a saved HTTP value outranks the launch config')
  } finally { f.cleanup() }
})

test('P4-7: GET /settings exposes effective value + source and project default without hard-coding', () => {
  const f = setup({ projectMaxActive: 7 })
  try {
    const s = f.get('/settings').body.settings
    assert.equal(s.effectiveGlobalMaxActive.value, DEFAULT_GLOBAL_MAX_ACTIVE)
    assert.equal(s.effectiveGlobalMaxActive.source, 'default')
    assert.equal(s.projectDefaultMaxActive, 7, 'launch-config project default is exposed, not guessed by UI')
    f.patch('/settings', { globalMaxActive: 3 })
    const after = f.get('/settings').body.settings
    assert.equal(after.effectiveGlobalMaxActive.value, 3)
    assert.equal(after.effectiveGlobalMaxActive.source, 'settings')
    assert.equal(after.projectDefaultMaxActive, 7, 'cap write must not change the project default')
  } finally { f.cleanup() }
})

test('P4-5: illegal global cap is refused with the verbatim backend reason', () => {
  const f = setup()
  try {
    for (const bad of [0, -1, 1.5, 'abc']) {
      const res = f.patch('/settings', { globalMaxActive: bad })
      assert.equal(res.status, 400, `globalMaxActive=${bad} must be refused`)
      assert.equal(res.body.error, 'globalMaxActive 必须是正整数或 null', 'error text surfaced unchanged')
      assert.equal(f.store.getGlobalMaxActiveSetting(), null, 'a refused write changed nothing')
    }
  } finally { f.cleanup() }
})

// ---------------------------------------------------------------------------
// P4-4/P4-5 — three disjoint PATCH blocks and verbatim errors, including the
// intake block (maxActiveSessions) that api.test.mjs did not cover.
// ---------------------------------------------------------------------------

test('P4-4: autonomy / preparation / intake each save alone; mixing blocks is 400', () => {
  const f = setup()
  try {
    const { project } = makeProject(f.store)
    const id = project.id

    assert.equal(f.patch(`/projects/${id}`, { autonomy: 'you-approve', autoDispatch: true }).status, 200)
    const prep = f.patch(`/projects/${id}`, { copyFiles: ['a.env'], postCreate: 'echo hi' })
    assert.equal(prep.status, 200)
    assert.deepEqual(prep.body.project.copyFiles, ['a.env'])
    assert.equal(prep.body.project.autonomy, 'you-approve', 'a preparation write kept the saved autonomy')
    const intake = f.patch(`/projects/${id}`, { maxActiveSessions: 2, issueRepo: 'o/r' })
    assert.equal(intake.status, 200)
    assert.equal(intake.body.project.maxActiveSessions, 2)
    assert.equal(intake.body.project.copyFiles.length, 1, 'an intake write kept the saved preparation')

    const mixed = f.patch(`/projects/${id}`, { autonomy: 'machine-approve', maxActiveSessions: 3 })
    assert.equal(mixed.status, 400)
    assert.match(mixed.body.error, /混改/)
    assert.equal(f.store.getProject(id).autonomy, 'you-approve', 'the refused mixed write changed nothing')
    assert.equal(f.store.getProject(id).maxActiveSessions, 2)
  } finally { f.cleanup() }
})

test('P4-5: illegal maxActiveSessions is refused with the verbatim backend reason', () => {
  const f = setup()
  try {
    const { project } = makeProject(f.store)
    for (const bad of [0, -2, 1.2]) {
      const res = f.patch(`/projects/${project.id}`, { maxActiveSessions: bad })
      assert.equal(res.status, 400)
      assert.equal(res.body.error, 'maxActiveSessions 必须是正整数或 null')
    }
  } finally { f.cleanup() }
})

// ---------------------------------------------------------------------------
// P4-7a — a PATCH to store.settings.globalMaxActive takes effect on the NEXT
// tick with no restart. `config` stays fixed to mimic the startup closure.
// ---------------------------------------------------------------------------

test('P4-7a: writing a smaller global cap throttles dispatch on the next tick without restart', async () => {
  const f = setup()
  try {
    const { project, board } = makeProject(f.store, 'throttle')
    f.store.updateAutonomy(project.id, { autonomy: 'you-approve', autoDispatch: true })
    f.store.updateIntake(project.id, { issueRepo: 'o/r', intakeBoardId: board.id, maxActiveSessions: 10 })
    for (let i = 0; i < 4; i += 1) f.store.createCard({ boardId: board.id, title: `c${i}` })

    const status = createEngineStatus()
    const active = new Map()
    let dispatchCalls = 0
    const deps = {
      intake: async () => ({ created: [] }),
      dispatch: async ({ cardId }) => {
        dispatchCalls += 1
        const sid = `s-${cardId}`
        active.set(sid, true)
        f.store.transitionCard(cardId, 'triage', 'autoRule')
        f.store.setWorktree(cardId, { worktreePath: `/tmp/wt-${cardId}`, branch: 'b', baseBranch: 'main', sessionId: sid })
        return { mode: 'created' }
      },
      isSessionActive: async (id) => active.get(id) === true,
    }
    // Fixed launch config says 10; only the store value changes between ticks.
    const config = { globalMaxActive: 10 }

    f.store.updateGlobalMaxActive(1)
    await runTick({ store: f.store, status, deps, config })
    assert.equal(dispatchCalls, 1, 'a saved cap of 1 admits exactly one session even though config says 10')
    assert.equal(status.projects[0].dispatched, 1)
    assert.equal(status.projects[0].queued, 3)

    // Raise the saved cap; next tick must admit one more (one slot is still busy).
    f.store.updateGlobalMaxActive(2)
    await runTick({ store: f.store, status, deps, config })
    assert.equal(dispatchCalls, 2, 'the new cap of 2 took effect on the next tick — no restart, config unchanged')
    assert.equal(status.projects[0].dispatched, 1)
  } finally { f.cleanup() }
})

test('P4-7a: status.engine echoes the effective cap from the same source the scheduler reads', () => {
  const f = setup({ globalMaxActive: 9 })
  try {
    const before = f.get('/status').body.engine
    assert.equal(before.globalMaxActive, 9)
    assert.equal(before.globalMaxActiveSource, 'config')
    f.patch('/settings', { globalMaxActive: 2 })
    const after = f.get('/status').body.engine
    assert.equal(after.globalMaxActive, 2)
    assert.equal(after.globalMaxActiveSource, 'settings', 'UI number and scheduler source agree')
  } finally { f.cleanup() }
})

// ---------------------------------------------------------------------------
// P4-7b — a saved cap survives a reload and is read back from persisted store.
// ---------------------------------------------------------------------------

test('P4-7b: saved global cap survives a new FactoryStore and reports source=settings', () => {
  const f = setup({ globalMaxActive: 9 })
  try {
    f.store.updateGlobalMaxActive(3)
    const reopened = new FactoryStore({ file: f.file })
    assert.equal(reopened.getGlobalMaxActiveSetting(), 3)
    assert.deepEqual(effectiveGlobalMaxActive(reopened, { globalMaxActive: 9 }), { value: 3, source: 'settings' })
    const api2 = createApi({
      store: reopened, engineConfig: { globalMaxActive: 9 },
      runtime: { engine: createEngineStatus(), toolsRegistered: true },
    })
    const engine = api2({ method: 'GET', route: '/status' }).body.engine
    assert.equal(engine.globalMaxActive, 3)
    assert.equal(engine.globalMaxActiveSource, 'settings')
  } finally { f.cleanup() }
})

// ---------------------------------------------------------------------------
// P4-9 — delete really removes this project's worktrees before dropping the
// registration, with every safety gate. `remove` is the documented injectable
// boundary so no real git worktree is touched.
// ---------------------------------------------------------------------------

function deleteFixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-p4-del-'))
  const file = join(tmp, 'factory.json')
  const store = new FactoryStore({ file })
  const wtRoot = join(tmp, 'wts') // absolute, outside the DSH data root → passes assertWorktreeRoot
  const calls = []
  function projectWithRoot(name) {
    const project = store.createProject({ name, rootPath: `/workspace/${name}`, worktreeRoot: wtRoot })
    const board = store.createBoard({ projectId: project.id, name: 'main' })
    return { project, board }
  }
  function cardWithWorktree(board, rel, tag) {
    const card = store.createCard({ boardId: board.id, title: 'c' })
    const worktreePath = join(wtRoot, rel)
    store.setWorktree(card.id, { worktreePath, branch: `b-${tag}`, baseBranch: 'main', sessionId: `s-${tag}` })
    return card
  }
  return { tmp, store, wtRoot, calls, projectWithRoot, cardWithWorktree, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

test('P4-9: delete removes every worktree then the registration, with a human audit record', () => {
  const f = deleteFixture()
  try {
    const a = f.projectWithRoot('a')
    f.cardWithWorktree(a.board, 'a1', 'a1')
    f.cardWithWorktree(a.board, 'a2', 'a2')

    const remove = ({ worktreePath }) => { f.calls.push(worktreePath) }
    const res = deleteProjectWithWorktrees(f.store, a.project.id, { remove })

    assert.deepEqual(f.calls.sort(), [join(f.wtRoot, 'a1'), join(f.wtRoot, 'a2')].sort())
    assert.equal(f.store.getProject(a.project.id), undefined, 'registration removed')
    assert.equal(f.store.listCards({ projectId: a.project.id }).length, 0)
    assert.equal(res.worktreesRemoved.length, 2)
    const ev = f.store.state.events.find((e) => e.type === 'project-deleted' && e.targetId === a.project.id)
    assert.ok(ev, 'a project-deleted audit event exists')
    assert.equal(ev.actor, 'human')
    assert.match(ev.note, /worktrees removed: 2/)
  } finally { f.cleanup() }
})

test('P4-9: delete never touches another project worktree', () => {
  const f = deleteFixture()
  try {
    const a = f.projectWithRoot('a')
    const aCard = f.cardWithWorktree(a.board, 'a1', 'a1')
    const b = f.projectWithRoot('b')
    const bCard = f.cardWithWorktree(b.board, 'b1', 'b1')
    const remove = ({ worktreePath }) => { f.calls.push(worktreePath) }

    deleteProjectWithWorktrees(f.store, a.project.id, { remove })

    assert.deepEqual(f.calls, [join(f.wtRoot, 'a1')], 'only project A worktree was cleaned')
    assert.ok(f.store.getProject(b.project.id), 'project B registration survives')
    assert.equal(f.store.getCard(bCard.id).worktreePath, join(f.wtRoot, 'b1'), 'project B worktree untouched')
    assert.ok(f.store.getCard(aCard.id) === undefined, 'project A card gone')
  } finally { f.cleanup() }
})

test('P4-9: a dirty worktree is refused with its change list and the registration is kept', () => {
  const f = deleteFixture()
  try {
    const a = f.projectWithRoot('a')
    const card = f.cardWithWorktree(a.board, 'a1', 'a1')
    const dirtyError = new Error('工作区有未提交改动，拒绝强删；请先处理：\n M src/app.js\n?? note.txt')
    dirtyError.changes = [' M src/app.js', '?? note.txt']
    const remove = () => { throw dirtyError }

    assert.throws(() => deleteProjectWithWorktrees(f.store, a.project.id, { remove }), /工作区有未提交改动/)
    assert.ok(f.store.getProject(a.project.id), 'registration kept on a rejected delete')
    assert.equal(f.store.getCard(card.id).worktreePath, join(f.wtRoot, 'a1'))
    assert.equal(f.store.state.events.some((e) => e.type === 'project-deleted'), false, 'no delete audit on refusal')
  } finally { f.cleanup() }
})

test('P4-9: a partial clean failure keeps the registration (no "registration gone, worktree left")', () => {
  const f = deleteFixture()
  try {
    const a = f.projectWithRoot('a')
    f.cardWithWorktree(a.board, 'a1', 'a1')
    f.cardWithWorktree(a.board, 'a2', 'a2')
    const remove = ({ worktreePath }) => {
      f.calls.push(worktreePath)
      if (worktreePath === join(f.wtRoot, 'a2')) throw new Error('git worktree remove failed')
    }
    assert.throws(() => deleteProjectWithWorktrees(f.store, a.project.id, { remove }), /git worktree remove failed/)
    assert.equal(f.calls.length, 2, 'both cleanups were attempted before the delete step')
    assert.ok(f.store.getProject(a.project.id), 'registration kept when any clean failed')
    assert.equal(f.store.listCards({ projectId: a.project.id }).length, 2)
    assert.equal(f.store.state.events.some((e) => e.type === 'project-deleted'), false)
  } finally { f.cleanup() }
})

test('P4-9: a worktree path outside this project root is a hard refusal before any clean', () => {
  const f = deleteFixture()
  try {
    const a = f.projectWithRoot('a')
    f.cardWithWorktree(a.board, 'a1', 'a1')
    // Craft a card that points outside the project's frozen worktreeRoot.
    const rogue = f.store.createCard({ boardId: a.board.id, title: 'rogue' })
    f.store.setWorktree(rogue.id, { worktreePath: '/tmp/qa-elsewhere/rogue', branch: 'b-r', baseBranch: 'main' })
    const remove = ({ worktreePath }) => { f.calls.push(worktreePath) }

    assert.throws(() => deleteProjectWithWorktrees(f.store, a.project.id, { remove }), /拒绝删除/)
    assert.equal(f.calls.length, 0, 'no cleanup ran once an escaping path was found')
    assert.ok(f.store.getProject(a.project.id), 'registration kept')
  } finally { f.cleanup() }
})

test('P4-9: force is opt-in and passed through to the remover', () => {
  const f = deleteFixture()
  try {
    const a = f.projectWithRoot('a')
    f.cardWithWorktree(a.board, 'a1', 'a1')
    const forceSeen = []
    const remove = ({ force }) => { forceSeen.push(force) }
    deleteProjectWithWorktrees(f.store, a.project.id, { remove, force: true })
    assert.deepEqual(forceSeen, [true], 'force=true reaches removeWorktree explicitly')

    const b = f.projectWithRoot('b')
    f.cardWithWorktree(b.board, 'b1', 'b1')
    const forceSeen2 = []
    deleteProjectWithWorktrees(f.store, b.project.id, { remove: ({ force }) => forceSeen2.push(force) })
    assert.deepEqual(forceSeen2, [false], 'force defaults to false — dirty trees are refused by default')
  } finally { f.cleanup() }
})

test('P4-9: DELETE route forwards the dialog force flag to the injected deleter', () => {
  const f = setup()
  try {
    const { project } = makeProject(f.store)
    let seen
    const api = createApi({ store: f.store, deleteProject: (_store, _id, opts) => { seen = opts; return { id: _id } } })
    api({ method: 'DELETE', route: `/projects/${project.id}`, body: { force: true } })
    assert.deepEqual(seen, { force: true })
    api({ method: 'DELETE', route: `/projects/${project.id}`, body: {} })
    assert.deepEqual(seen, { force: false })
  } finally { f.cleanup() }
})
