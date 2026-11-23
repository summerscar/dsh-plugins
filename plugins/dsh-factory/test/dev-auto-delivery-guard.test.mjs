/**
 * Dev self-check — L4 auto-commit head guard and human retry recovery.
 * Regression for the card whose branch head was a release-state fixture tree:
 * the engine must NEVER auto-commit on an unexpected head without a recorded
 * commit, and a human must be able to clear a latched commit stall once the
 * worktree is corrected.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createApi } from '../api.js'
import { ensureCommittedForAutoDelivery } from '../delivery.js'
import { FactoryStore } from '../store.js'
import { AUTO_DELIVERY_TIER } from '../autonomy.js'

const HEAD = 'a'.repeat(40)
const UNEXPECTED = 'b'.repeat(40)
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function setup({ tier = AUTO_DELIVERY_TIER, status = 'review' } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'dev-autoguard-'))
  const repo = join(tmp, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q')
  git(repo, 'checkout', '-qb', 'main')
  writeFileSync(join(repo, 'README.md'), '# p\n')
  git(repo, 'add', 'README.md')
  git(repo, '-c', 'user.name=T', '-c', 'user.email=t@l', 'commit', '-qm', 'init')
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: repo })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  const card = store.createCard({ boardId: board.id, title: 'c' })
  store.setWorktree(card.id, { worktreePath: repo, branch: 'factory/card', baseBranch: 'main', sessionId: '' })
  for (const [to, actor] of [['triage', 'human'], ['plan', 'agent'], ['plan-review', 'agent'], ['build', 'human'], ['review', 'agent']]) {
    store.transitionCard(card.id, to, actor)
  }
  if (status !== 'review') store.transitionCard(card.id, status, 'human')
  store.updateAutonomy(project.id, { autonomy: tier })
  return { store, project, card, repo, tmp, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

function guardedPort({ headOf = HEAD, clean = false, deleted = 0 } = {}) {
  const calls = []
  return {
    calls,
    headOf: (cwd, ref) => { calls.push(['headOf', ref]); return headOf },
    deletedCount: (cwd, ref) => { calls.push(['deletedCount', ref]); return deleted },
    isWorktreeClean: () => { calls.push(['isWorktreeClean']); return clean },
    changedPaths: () => { calls.push(['changedPaths']); return ['README.md'] },
    add: (cwd, paths) => { calls.push(['add', paths]); },
    commit: (cwd, message, paths) => { calls.push(['commit', paths]); return HEAD },
  }
}

test('Dev-AutoGuard: unexpected HEAD without commitSha refuses before any git write', async () => {
  const f = setup()
  try {
    const port = guardedPort({ headOf: HEAD })
    const r = await ensureCommittedForAutoDelivery({
      store: f.store, cardId: f.card.id, port, readHead: () => UNEXPECTED,
    })
    assert.equal(r.ok, false)
    assert.match(r.reason, /与基线.*不一致/)
    assert.deepEqual(port.calls, [['headOf', 'main']], 'no clean/add/commit on a stray head')
  } finally { f.cleanup() }
})

test('Dev-AutoGuard: matching HEAD keeps the normal dirty-tree commit path', async () => {
  const f = setup()
  try {
    const port = guardedPort({ headOf: HEAD })
    const r = await ensureCommittedForAutoDelivery({
      store: f.store, cardId: f.card.id, port, readHead: () => HEAD,
    })
    assert.equal(r.ok, true)
    assert.equal(r.committed, true)
    assert.deepEqual(port.calls, [['headOf', 'main'], ['deletedCount', HEAD], ['isWorktreeClean'], ['changedPaths'], ['add', ['README.md']], ['commit', ['README.md']]])
  } finally { f.cleanup() }
})

test('Dev-AutoGuard: a live session blocks auto-commit before any git read/write', async () => {
  const f = setup()
  try {
    f.store.setWorktree(f.card.id, { worktreePath: f.repo, branch: 'factory/card', baseBranch: 'main', sessionId: 'live' })
    const port = guardedPort()
    const r = await ensureCommittedForAutoDelivery({
      store: f.store, cardId: f.card.id, port, readHead: () => HEAD,
      isSessionActive: (id) => id === 'live',
    })
    assert.equal(r.ok, false)
    assert.match(r.reason, /会话仍在进行/)
    assert.deepEqual(port.calls, [], 'session gate runs before git reads')
  } finally { f.cleanup() }
})

test('Dev-AutoGuard: mass tracked-file deletion refuses before staging', async () => {
  const f = setup()
  try {
    const port = guardedPort({ deleted: 30 })
    const r = await ensureCommittedForAutoDelivery({
      store: f.store, cardId: f.card.id, port, readHead: () => HEAD,
    })
    assert.equal(r.ok, false)
    assert.match(r.reason, /删除了 30 个已跟踪文件/)
    assert.deepEqual(port.calls, [['headOf', 'main'], ['deletedCount', HEAD]], 'no clean/add/commit')
  } finally { f.cleanup() }
})

test('Dev-AutoGuard: a recorded commitSha may advance from the base head', async () => {
  const f = setup()
  try {
    f.store.recordCommit(f.card.id, { sha: HEAD, message: 'prior round' })
    const port = guardedPort({ headOf: HEAD })
    const r = await ensureCommittedForAutoDelivery({
      store: f.store, cardId: f.card.id, port, readHead: () => UNEXPECTED,
    })
    assert.equal(r.ok, true)
    assert.equal(r.committed, true)
    assert.deepEqual(port.calls, [['deletedCount', UNEXPECTED], ['isWorktreeClean'], ['changedPaths'], ['add', ['README.md']], ['commit', ['README.md']]], 'no base lookup once a commit is recorded')
  } finally { f.cleanup() }
})

test('Dev-AutoGuard: pre-commit hook strips Git env before nested test repos', () => {
  const hook = readFileSync(new URL('../../../.husky/pre-commit', import.meta.url), 'utf8')
  assert.match(hook, /unset GIT_DIR/, 'hook unsets GIT_DIR')
  assert.match(hook, /GIT_INDEX_FILE/, 'hook unsets the temporary index')
  assert.match(hook, /GIT_WORK_TREE/, 'hook unsets the hook work tree')
  assert.match(hook, /env -u GITHUB_TOKEN pnpm check/, 'known ambient-token false red is excluded from the gate')
})

test('Dev-AutoGuard: retry route clears the latched commit stall and failed notice', async () => {
  const f = setup()
  try {
    for (let i = 0; i < 3; i += 1) f.store.recordCommitFailure(f.card.id, { reason: 'pre-commit failed' })
    assert.equal(f.store.getCard(f.card.id).commitStalled, true)
    f.store.setAutoDelivery(f.card.id, { head: HEAD, state: 'failed', error: 'pre-commit failed' })
    const api = createApi({ store: f.store, isSessionActive: () => false })
    const res = api({ method: 'POST', route: `/cards/${f.card.id}/retry-auto-delivery`, body: { actor: 'human', commitSha: HEAD, message: 'recovered' } })
    assert.equal(res.status, 200)
    const card = f.store.getCard(f.card.id)
    assert.equal(card.commitSha, HEAD, 'human-repaired head is synced into the live store')
    assert.equal(card.commitFailures, 0)
    assert.equal(card.commitStalled, false)
    assert.equal(card.autoDelivery.state, 'retry')
    assert.equal(card.autoDelivery.error, undefined)
  } finally { f.cleanup() }
})

test('Dev-AutoGuard: retry route refuses non-L4 cards and live sessions', async () => {
  const nonL4 = setup({ tier: 'you-approve' })
  try {
    const api = createApi({ store: nonL4.store, isSessionActive: () => false })
    const res = api({ method: 'POST', route: `/cards/${nonL4.card.id}/retry-auto-delivery`, body: { actor: 'human' } })
    assert.equal(res.status, 400)
  } finally { nonL4.cleanup() }

  const busy = setup()
  try {
    const api = createApi({ store: busy.store, isSessionActive: () => true })
    const res = api({ method: 'POST', route: `/cards/${busy.card.id}/retry-auto-delivery`, body: { actor: 'human' } })
    assert.equal(res.status, 400)
  } finally { busy.cleanup() }
})
