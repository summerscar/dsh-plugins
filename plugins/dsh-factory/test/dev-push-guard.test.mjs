/**
 * Dev self-check — auto-delivery gives a readable error when the card's
 * worktree is already gone, and the happy path still writes real audits.
 *
 * A `git push -u origin <branch>` with an explicit refspec ALWAYS exits 0 only
 * when the branch is actually on the remote (verified: no-diff branch, real
 * commit, repeat push, push.default=nothing all exit 0 AND `ls-remote --heads`
 * finds them). So no ls-remote re-check is warranted; what IS missing is a
 * readable error when the worktree directory was cleaned up — today that
 * surfaces as `spawnSync git ENOENT` / "工作树存在未提交改动".
 *
 * Tests assert the PORT CALL SEQUENCE, not just the final value.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FactoryStore } from '../store.js'
import { AUTO_DELIVERY_TIER } from '../autonomy.js'
import { executeAutoDelivery, runAutoDelivery } from '../delivery.js'
import { createGitPort } from '../git-exec.js'

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'dev-pushguard-'))
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
  store.setWorktree(card.id, { worktreePath: repo, branch: 'factory/probe', baseBranch: 'main', sessionId: 'builder' })
  for (const [to, actor] of [['triage', 'human'], ['plan', 'agent'], ['plan-review', 'agent'], ['build', 'human'], ['review', 'agent']]) {
    store.transitionCard(card.id, to, actor)
  }
  store.setReviewSession(card.id, 'reviewer-1', 'created')
  store.updateAutonomy(project.id, { autonomy: AUTO_DELIVERY_TIER })
  store.recordCommit(card.id, { sha: head, message: 'x', actor: 'human' }) // reviewed tree IS HEAD
  store._card(card.id).reviewVerdict = {
    cardId: card.id, source: 'review', verdict: 'approved', reviewedHead: head,
    blocking: [], followUps: [], checks: [], reviewerSessionId: 'reviewer-1',
  }
  store._commit()
  return {
    store, card, head, repo,
    token: { cardId: card.id, head, actor: AUTO_DELIVERY_TIER },
    run: (port) => executeAutoDelivery({
      store, token: { cardId: card.id, head, actor: AUTO_DELIVERY_TIER }, port,
      readHead: () => head, resolveIdentity: async () => ({ git: {} }),
    }),
    runTop: (port) => runAutoDelivery({
      store, cardId: card.id, port,
      readHead: () => head, resolveIdentity: async () => ({ git: {} }),
    }),
    audits: () => store.state.events.filter((e) => e.type === 'auto-delivery').map((e) => e.decision),
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  }
}

function port({ exists = true } = {}) {
  const calls = []
  return {
    calls,
    worktreeExists: (p) => { calls.push(['worktreeExists', p]); return exists },
    // commitSha === reviewed head in this fixture, so the commit block is skipped.
    isWorktreeClean: () => true,
    push: (w, br) => { calls.push(['push', br]) },
    createPr: (w, opts) => { calls.push(['createPr', opts]); return 'https://github.com/o/r/pull/9' },
  }
}

test('Dev-PushGuard: missing worktree gives readable 工作树已失效, not ENOENT', async () => {
  const f = setup()
  const p = port({ exists: false })
  try {
    await assert.rejects(() => f.run(p), /卡片工作树已失效.*可能已被清理.*需重新派发/)
    assert.deepEqual(p.calls.map((c) => c[0]), ['worktreeExists'], 'no push/createPr after invalid worktree')
    assert.equal(f.audits().includes('pushed'), false, 'no pushed audit')
  } finally { f.cleanup() }
})

test('Dev-PushGuard: real entry runAutoDelivery reports 工作树已失效 at arm', async () => {
  const f = setup()
  const p = port({ exists: false })
  try {
    const r = await f.runTop(p)
    assert.equal(r.delivered, false)
    assert.match(r.reason, /卡片工作树已失效.*需重新派发/)
    assert.deepEqual(p.calls.map((c) => c[0]), ['worktreeExists'], 'no git read / push / createPr')
    assert.equal(f.audits().includes('pushed'), false)
  } finally { f.cleanup() }
})

test('Dev-PushGuard: happy path unchanged — worktreeExists→push→createPr, full audit', async () => {
  const f = setup()
  const p = port()
  try {
    const r = await f.run(p)
    assert.equal(r.state, 'delivered')
    assert.deepEqual(p.calls.map((c) => c[0]), ['worktreeExists', 'push', 'createPr'])
    assert.equal(p.calls.find((c) => c[0] === 'createPr')[1].draft, true)
    for (const d of ['pushed', 'draft-pr', 'delivered']) assert.ok(f.audits().includes(d), `audit ${d}`)
  } finally { f.cleanup() }
})

test('Dev-PushGuard: real createGitPort.worktreeExists checks non-empty + dir + git worktree', () => {
  const p = createGitPort({ ghLoggedIn: false })
  assert.equal(p.worktreeExists(''), false, 'empty path')
  const tmp = mkdtempSync(join(tmpdir(), 'dev-pushguard-port-'))
  try {
    assert.equal(p.worktreeExists(tmp), false, 'existing dir but not a git worktree')
    const repo = join(tmp, 'r')
    mkdirSync(repo)
    git(repo, 'init', '-q')
    assert.equal(p.worktreeExists(repo), true, 'real git worktree')
    assert.equal(p.worktreeExists(join(tmp, 'gone')), false, 'nonexistent dir')
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})
