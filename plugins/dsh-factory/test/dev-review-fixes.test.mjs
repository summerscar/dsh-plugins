/**
 * Dev self-check — fixes from the high-risk Review report:
 * (1) pr-review session in the live-session gate, (2) untracked-only diffs,
 * (3) baseline/bulk-deletion gates in the V4 write path, (4)(6) stale code
 * removal, (5) typed cross-reject coverage.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { activeSessionsFor, assertNoActiveSession } from '../session-guard.js'
import { createGitPort } from '../git-exec.js'
import { clientSource, makeFixture, makeTools, HEAD, STALE } from './dev-v4-support.mjs'

test('Dev-Fix1: activeSessionsFor includes the PR-review session', () => {
  const card = { sessionId: null, reviewSessionId: null, prReviewSessionId: 'pr-reviewer-session' }
  const sessions = activeSessionsFor(card, (id) => id === 'pr-reviewer-session')
  assert.equal(sessions.prReviewer, true)
  assert.throws(
    () => assertNoActiveSession({ card, isSessionActive: (id) => id === card.prReviewSessionId, action: '提交推送' }),
    /PR 评审/,
  )
})

test('Dev-Fix1: factory_push_branch refuses while a PR reviewer session is live', async () => {
  const f = makeFixture()
  try {
    f.store.setPrReviewSession(f.card.id, 'pr-reviewer-session', 'created')
    const t = makeTools(f, { isSessionActive: async (id) => id === 'pr-reviewer-session' })
    await assert.rejects(
      () => t.find('factory_push_branch').execute({ cardId: f.card.id, message: 'm' }, t.builder),
      /PR 评审会话仍在运行/,
    )
    assert.deepEqual(t.calls, [], 'refusal happens before any git read/write')
  } finally { f.cleanup() }
})

test('Dev-Fix2: hasDiff counts untracked-only files and uses the injected exec', () => {
  const calls = []
  const port = createGitPort({
    ghLoggedIn: false,
    exec: (command, args, options) => {
      calls.push({ command, args, env: options.env })
      if (args[1] === '--quiet') return { status: 0, stdout: '', stderr: '' }
      return { status: 0, stdout: 'new-file.txt\n', stderr: '' }
    },
  })
  assert.equal(port.hasDiff('/w', 'main'), true)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].args, ['diff', '--quiet', 'main', '--'])
  assert.deepEqual(calls[1].args, ['ls-files', '--others', '--exclude-standard'])
})

test('Dev-Fix2: a real untracked-only worktree has a diff', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev-untracked-'))
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    git('init', '-q')
    git('config', 'user.email', 't@l')
    git('config', 'user.name', 'T')
    writeFileSync(join(dir, 'base.txt'), 'base\n')
    git('add', 'base.txt')
    git('commit', '-qm', 'base')
    writeFileSync(join(dir, 'new.txt'), 'new\n')
    assert.equal(createGitPort({ ghLoggedIn: false }).hasDiff(dir, 'HEAD'), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Dev-Fix2: factory_push_branch reads paths before hasDiff and can deliver untracked-only files', async () => {
  const f = makeFixture()
  try {
    const order = []
    const t = makeTools(f, { gitPort: {
      changedPaths: () => { order.push('changedPaths'); return ['new.txt'] },
      hasDiff: () => { order.push('hasDiff'); return true },
    } })
    const out = await t.find('factory_push_branch').execute({ cardId: f.card.id, message: 'add file' }, t.builder)
    assert.ok(out.sha)
    assert.deepEqual(order, ['changedPaths', 'hasDiff'])
  } finally { f.cleanup() }
})

test('Dev-Fix3: factory_push_branch fails closed on a non-baseline HEAD', async () => {
  const f = makeFixture()
  try {
    const t = makeTools(f, {
      readHead: () => STALE,
      gitPort: { headOf: () => HEAD },
    })
    await assert.rejects(
      () => t.find('factory_push_branch').execute({ cardId: f.card.id, message: 'm' }, t.builder),
      /HEAD 与基线不一致/,
    )
    assert.deepEqual(t.calls, [], 'no add/commit/push on a stray HEAD')
  } finally { f.cleanup() }
})

test('Dev-Fix3: factory_push_branch refuses bulk tracked deletions', async () => {
  const f = makeFixture()
  try {
    const t = makeTools(f, { gitPort: { deletedCount: () => 30 } })
    await assert.rejects(
      () => t.find('factory_push_branch').execute({ cardId: f.card.id, message: 'm' }, t.builder),
      /删除了 30 个已跟踪文件/,
    )
    assert.deepEqual(t.calls, [], 'no add/commit/push on a fixture-like tree')
  } finally { f.cleanup() }
})

test('Dev-Fix4: delivery.js has no legacy deliverySource session branch', () => {
  assert.doesNotMatch(clientSource('delivery.js'), /deliverySource === 'session'/)
})

test('Dev-Fix5: PR-review session cannot submit a self-review verdict via factory_report', async () => {
  const f = makeFixture({ status: 'pr-review' })
  try {
    f.store._card(f.card.id).prUrl = 'https://example/pr/9'
    f.store._commit()
    f.store.setPrReviewSession(f.card.id, 'pr-reviewer-session', 'created')
    f.store.setReviewSession(f.card.id, 'self-reviewer-session', 'created')
    const t = makeTools(f)
    await assert.rejects(() => t.find('factory_report').execute({
      cardId: f.card.id, report: 'cross', source: 'review', verdict: 'approved',
      blocking: [], followUps: [], checks: [],
    }, { agent: { id: 'pr-reviewer-session' } }), /PR 评审会话不能代交自审 verdict/)
    assert.equal(f.store.getCard(f.card.id).reviewVerdict, null)
  } finally { f.cleanup() }
})

test('Dev-Fix6: sync.js comment matches syncRule auto-done', () => {
  const source = clientSource('sync.js')
  assert.doesNotMatch(source, /human confirms; Done is human-only/)
  assert.match(source, /syncRule/)
})
