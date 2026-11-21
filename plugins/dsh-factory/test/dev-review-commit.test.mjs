/**
 * Dev self-check — L4 auto-commit at the Review entry (build leaves a dirty
 * worktree, delivery demands a clean/committed tree). Covers:
 *   1. idempotency = clean tree AND commitSha === HEAD (double condition)
 *   2. branch safety (protected / base branch refused, not bypassed)
 *   3. commit failure: no verdict dispatch, no delivery, bounded retry
 *   4. reviewed head after commit equals the NEW sha
 *   5. legacy review cards with an old commitSha but a dirty tree still commit
 *   6. non-L4 tiers are untouched
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FactoryStore } from '../store.js'
import { AUTO_DELIVERY_TIER, runTick, createEngineStatus } from '../autonomy.js'
import { ensureCommittedForAutoDelivery } from '../delivery.js'
import { createGitPort } from '../git-exec.js'
import { reviewedHeadFor } from '../verdict.js'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function setup({ branch = 'factory/probe', base = 'main', tier = AUTO_DELIVERY_TIER } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'dev-revcommit-'))
  const repo = join(tmp, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q')
  git(repo, 'checkout', '-qb', 'main')
  writeFileSync(join(repo, 'README.md'), '# p\n')
  git(repo, 'add', 'README.md')
  git(repo, '-c', 'user.name=T', '-c', 'user.email=t@l', 'commit', '-qm', 'init')
  const head = git(repo, 'rev-parse', 'HEAD').trim()
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: repo })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  const card = store.createCard({ boardId: board.id, title: 'c' })
  store.setWorktree(card.id, { worktreePath: repo, branch, baseBranch: base, sessionId: 'builder' })
  for (const [to, actor] of [['triage', 'human'], ['plan', 'agent'], ['plan-review', 'agent'], ['build', 'human'], ['review', 'agent']]) {
    store.transitionCard(card.id, to, actor)
  }
  store.updateAutonomy(project.id, { autonomy: tier })
  return { store, project, card, repo, head, tmp, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

function fakePort({ clean = false, sha = SHA_A, fail = null } = {}) {
  const calls = []
  return {
    calls,
    isWorktreeClean: () => { calls.push(['isWorktreeClean']); return clean },
    add: () => { calls.push(['add']); if (fail === 'add') throw new Error('add exploded') },
    commit: () => { calls.push(['commit']); if (fail === 'commit') throw new Error('commit exploded'); return sha },
  }
}

test('Dev-ReviewCommit: clean tree with commitSha===HEAD is skipped (no write)', async () => {
  const f = setup()
  try {
    f.store.recordCommit(f.card.id, { sha: f.head, message: 'x' })
    const port = fakePort({ clean: true })
    const r = await ensureCommittedForAutoDelivery({ store: f.store, cardId: f.card.id, port, readHead: () => f.head })
    assert.equal(r.ok, true)
    assert.equal(r.skipped, true)
    assert.notEqual(r.committed, true)
    assert.deepEqual(port.calls, [['isWorktreeClean']], 'no add/commit on the idempotent path')
  } finally { f.cleanup() }
})

test('Dev-ReviewCommit: dirty tree commits, records sha and audits committed', async () => {
  const f = setup()
  try {
    const port = fakePort({ clean: false, sha: SHA_A })
    const r = await ensureCommittedForAutoDelivery({ store: f.store, cardId: f.card.id, port, readHead: () => f.head })
    assert.equal(r.ok, true)
    assert.equal(r.committed, true)
    assert.equal(r.sha, SHA_A)
    assert.equal(f.store.getCard(f.card.id).commitSha, SHA_A)
    assert.deepEqual(port.calls, [['isWorktreeClean'], ['add'], ['commit']])
    const ev = f.store.state.events.filter((e) => e.type === 'auto-delivery' && e.decision === 'committed')
    assert.equal(ev.length, 1, 'committed audit recorded')
    assert.equal(ev[0].tier, AUTO_DELIVERY_TIER)
    assert.match(ev[0].note, new RegExp(SHA_A), 'audit note carries the commit head')
  } finally { f.cleanup() }
})

test('Dev-ReviewCommit: GAP A — old commitSha after review→build rebuild must not skip the new dirty tree', async () => {
  const f = setup()
  try {
    f.store.recordCommit(f.card.id, { sha: SHA_B, message: 'old round' }) // old commitSha survives send-back
    f.store.transitionCard(f.card.id, 'build', 'human')
    f.store.transitionCard(f.card.id, 'review', 'agent')
    const port = fakePort({ clean: false, sha: SHA_A })
    const r = await ensureCommittedForAutoDelivery({ store: f.store, cardId: f.card.id, port, readHead: () => f.head })
    assert.equal(r.ok, true)
    assert.equal(r.committed, true, 'dirty tree wins over a stale commitSha')
    assert.equal(f.store.getCard(f.card.id).commitSha, SHA_A, 'commitSha advances to the new head')
  } finally { f.cleanup() }
})

test('Dev-ReviewCommit: GAP B — legacy card with commitSha but dirty tree still commits', async () => {
  const f = setup()
  try {
    f.store.recordCommit(f.card.id, { sha: SHA_B, message: 'legacy' })
    // tree became dirty again after that commit; HEAD still SHA_B-family, tree not clean
    const port = fakePort({ clean: false, sha: SHA_A })
    const r = await ensureCommittedForAutoDelivery({ store: f.store, cardId: f.card.id, port, readHead: () => f.head })
    assert.equal(r.committed, true, 'non-empty commitSha does not skip a dirty tree')
    assert.equal(f.store.getCard(f.card.id).commitSha, SHA_A)
  } finally { f.cleanup() }
})

test('Dev-ReviewCommit: protected + base branches are refused, no git write', async () => {
  for (const branch of ['main', 'develop']) {
    const f = setup({ branch, base: 'main' })
    try {
      const port = fakePort({ clean: false })
      const r = await ensureCommittedForAutoDelivery({ store: f.store, cardId: f.card.id, port, readHead: () => f.head })
      assert.equal(r.ok, false, `${branch} refused`)
      assert.deepEqual(port.calls, [], 'no git write on a protected/base branch')
    } finally { f.cleanup() }
  }
  const f = setup({ branch: 'main', base: 'main' })
  try {
    const port = fakePort({ clean: false })
    const r = await ensureCommittedForAutoDelivery({ store: f.store, cardId: f.card.id, port, readHead: () => f.head })
    assert.equal(r.ok, false, 'base branch refused')
    assert.deepEqual(port.calls, [])
  } finally { f.cleanup() }
})

test('Dev-ReviewCommit: commit failure records failure reason + bounded retry, no commitSha', async () => {
  const f = setup()
  try {
    for (let i = 1; i <= 3; i += 1) {
      const port = fakePort({ clean: false, fail: 'add' })
      const r = await ensureCommittedForAutoDelivery({ store: f.store, cardId: f.card.id, port, readHead: () => f.head })
      assert.equal(r.ok, false)
      assert.equal(f.store.getCard(f.card.id).commitSha, null, 'no commitSha on failure')
    }
    const card = f.store.getCard(f.card.id)
    assert.equal(card.commitFailures, 3, 'commit failures counted (separate from dispatch)')
    assert.equal(card.commitStalled, true, 'commit stalled after limit')
    const errEv = f.store.state.events.filter((e) => e.type === 'auto-delivery' && e.decision === 'commit-failed')
    assert.equal(errEv.length, 3)
    assert.match(errEv[0].note, /add exploded/)
    // stalled: a 4th attempt does not touch the git port
    const port4 = fakePort({ clean: false })
    const r4 = await ensureCommittedForAutoDelivery({ store: f.store, cardId: f.card.id, port: port4, readHead: () => f.head })
    assert.equal(r4.ok, false)
    assert.equal(r4.stalled, true)
    assert.deepEqual(port4.calls, [], 'stalled → no more git writes')
  } finally { f.cleanup() }
})

test('Dev-ReviewCommit: non-L4 tiers are untouched', async () => {
  for (const tier of ['manual', 'you-approve', 'machine-approve']) {
    const f = setup({ tier })
    try {
      const port = fakePort({ clean: false })
      const r = await ensureCommittedForAutoDelivery({ store: f.store, cardId: f.card.id, port, readHead: () => f.head })
      assert.equal(r.ok, false, `${tier} refuses auto-commit`)
      assert.deepEqual(port.calls, [])
    } finally { f.cleanup() }
  }
})

test('Dev-ReviewCommit: real git port — reviewedHead after commit equals the NEW sha', async () => {
  const f = setup()
  try {
    writeFileSync(join(f.repo, 'src.ts'), 'export const x = 1\n') // dirty tree
    const port = createGitPort()
    const r = await ensureCommittedForAutoDelivery({ store: f.store, cardId: f.card.id, port })
    assert.equal(r.ok, true)
    assert.equal(r.committed, true)
    const sha = f.store.getCard(f.card.id).commitSha
    assert.match(sha, /^[0-9a-f]{40}$/)
    assert.equal(git(f.repo, 'rev-parse', 'HEAD').trim(), sha, 'git HEAD moved to the committed sha')
    assert.equal(reviewedHeadFor({ worktreePath: f.repo }), sha, 'review will see the new sha')
    assert.equal(port.isWorktreeClean(f.repo), true, 'tree is clean after commit')
  } finally { f.cleanup() }
})

function tickDeps(log, autoCommitResult) {
  return {
    ghPort: {}, intake: async () => ({ created: [] }), dispatch: async () => ({ mode: 'none' }),
    isSessionActive: async () => false,
    autoCommit: async ({ store, cardId }) => { log.push('commit'); return autoCommitResult },
    reviewDispatch: async () => { log.push('review') },
    deliver: async () => { log.push('deliver'); return { delivered: true } },
  }
}

test('Dev-ReviewCommit: tick order is commit → review → deliver', async () => {
  const f = setup()
  try {
    const log = []
    const status = createEngineStatus()
    await runTick({ store: f.store, status, deps: tickDeps(log, { ok: true, committed: true, sha: SHA_A }) })
    assert.deepEqual(log, ['commit', 'review', 'deliver'])
    assert.equal(status.projects[0].autoCommitted, 1)
  } finally { f.cleanup() }
})

test('Dev-ReviewCommit: tick skips review + deliver when commit fails', async () => {
  const f = setup()
  try {
    const log = []
    const status = createEngineStatus()
    await runTick({ store: f.store, status, deps: tickDeps(log, { ok: false, reason: 'commit exploded' }) })
    assert.deepEqual(log, ['commit'], 'no review/delivery after a failed commit')
    assert.equal(status.projects[0].autoCommitted, 0)
  } finally { f.cleanup() }
})
