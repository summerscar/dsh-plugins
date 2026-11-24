/**
 * Authorized git execution tests. The fake port records calls, so we can assert
 * the AG-1 guarantee directly: with no human authorization the port is NEVER
 * touched, and it only runs after the right Review-time authorization.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FactoryStore } from '../store.js'
import { buildGitEnv, createGitPort, probeEnv, probeGhLogin } from '../git-exec.js'
import { makeFixture, makeTools, HEAD, SHA } from './dev-v4-support.mjs'

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'factory-git-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: '/workspace/example-repo' })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  const card = store.createCard({ boardId: board.id, title: 'Ship it' })
  store.setWorktree(card.id, { worktreePath: '/tmp/fake-worktree', branch: 'factory/card' })
  // Drive to Review.
  store.transitionCard(card.id, 'triage', 'human')
  store.transitionCard(card.id, 'plan', 'agent')
  store.transitionCard(card.id, 'plan-review', 'agent')
  store.transitionCard(card.id, 'build', 'human')
  store.transitionCard(card.id, 'review', 'agent')
  return { store, card, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

function fakePort(overrides = {}) {
  const calls = []
  const record = (name) => (...args) => { calls.push({ name, args }) }
  return {
    calls,
    port: {
      add: record('add'),
      commit: () => { calls.push({ name: 'commit' }); return 'deadbeef' },
      reset: record('reset'),
      hasDiff: () => true,
      push: record('push'),
      createPr: () => { calls.push({ name: 'createPr' }); return 'https://example/pr/1' },
      ...overrides,
    },
  }
}

test('V4 git boundary: non-builder session writes nothing', async () => {
  const f = makeFixture()
  try {
    const t = makeTools(f)
    await assert.rejects(() => t.find('factory_push_branch').execute({ cardId: f.card.id, message: 'm' }, t.other), /builder 会话/)
    assert.deepEqual(t.calls, [], 'all refusals happen before git reads or writes')
  } finally { f.cleanup() }
})

test('V4 git boundary: builder commits frozen dirty paths and pushes, without opening a PR', async () => {
  const f = makeFixture()
  try {
    const t = makeTools(f)
    const out = await t.find('factory_push_branch').execute({ cardId: f.card.id, message: 'fix: ship' }, t.builder)
    assert.equal(out.sha, SHA)
    assert.equal(out.prUrl, '')
    assert.deepEqual(t.calls.map((c) => c[0]), ['changedPaths', 'hasDiff', 'add', 'commit', 'push'])
    assert.deepEqual(t.calls.find((c) => c[0] === 'add')[1], ['README.md'])
    assert.deepEqual(t.calls.find((c) => c[0] === 'commit')[2], ['README.md'])
  } finally { f.cleanup() }
})

test('V4 git boundary: a failed commit unstages and leaves the card retryable', async () => {
  const f = makeFixture()
  try {
    const events = []
    const t = makeTools(f, { gitPort: { commit: () => { events.push('commit'); throw new Error('hook failed') }, reset: () => events.push('reset') } })
    await assert.rejects(() => t.find('factory_push_branch').execute({ cardId: f.card.id, message: 'm' }, t.builder), /hook failed/)
    assert.deepEqual(t.calls.map((c) => c[0]), ['changedPaths', 'hasDiff', 'add'])
    assert.deepEqual(events, ['commit', 'reset'])
    assert.equal(f.store.getCard(f.card.id).commitSha, null)
  } finally { f.cleanup() }
})

test('V4 git boundary: reviewer commits no code; it only opens a draft PR', async () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    f.store.recordCommit(f.card.id, { sha: HEAD, message: 'build commit', actor: 'agent' })
    f.store.setReviewSession(f.card.id, 'reviewer-session', 'created')
    const t = makeTools(f)
    await t.find('factory_self_review_verdict').execute({ cardId: f.card.id, head: HEAD, verdict: 'approved', blocking: [], followUps: [], checks: [] }, t.reviewer)
    const out = await t.find('factory_open_draft_pr').execute({ cardId: f.card.id, title: 'T', body: 'B' }, t.reviewer)
    assert.equal(out.url, 'https://example/pr/1')
    assert.deepEqual(t.calls.map((c) => c[0]), ['createPr'])
    assert.equal(t.calls.find((c) => c[0] === 'createPr')[1].draft, true)
  } finally { f.cleanup() }
})

test('V4 git boundary: PR tool refuses an unapproved self-review before any write', async () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    f.store.recordCommit(f.card.id, { sha: HEAD, message: 'build commit', actor: 'agent' })
    f.store.setReviewSession(f.card.id, 'reviewer-session', 'created')
    const t = makeTools(f)
    await assert.rejects(() => t.find('factory_open_draft_pr').execute({ cardId: f.card.id, title: 'T', body: 'B' }, t.reviewer), /approved/)
    assert.deepEqual(t.calls, [])
  } finally { f.cleanup() }
})

test('V4 git boundary: protected branch is refused with zero git calls', async () => {
  const f = makeFixture({ branch: 'main' })
  try {
    const t = makeTools(f)
    await assert.rejects(() => t.find('factory_push_branch').execute({ cardId: f.card.id, message: 'm' }, t.builder), /受保护分支/)
    assert.deepEqual(t.calls, [])
  } finally { f.cleanup() }
})

test('V4 git boundary: no diff is refused with zero git calls beyond the check', async () => {
  const f = makeFixture()
  try {
    const events = []
    const t = makeTools(f, { gitPort: { hasDiff: () => { events.push('hasDiff'); return false } } })
    await assert.rejects(() => t.find('factory_push_branch').execute({ cardId: f.card.id, message: 'm' }, t.builder), /没有可交付的改动/)
    assert.deepEqual(events, ['hasDiff'])
    assert.deepEqual(t.calls.map((c) => c[0]), ['changedPaths'])
  } finally { f.cleanup() }
})

test('buildGitEnv: an explicit DSH credential wins — set GH_TOKEN, drop inherited GITHUB_TOKEN', () => {
  const src = { PATH: '/bin', GITHUB_TOKEN: 'github_pat_limited_scope' }
  const env = buildGitEnv(src, { credentialToken: 'gho_app_token', ghLoggedIn: false })
  assert.equal(env.GH_TOKEN, 'gho_app_token')
  assert.equal('GITHUB_TOKEN' in env, false)
  assert.equal(src.GITHUB_TOKEN, 'github_pat_limited_scope', 'source env is not mutated')
})

test('buildGitEnv: with a gh login and no explicit token — drop both token vars so gh login is used', () => {
  const src = { PATH: '/bin', GITHUB_TOKEN: 'github_pat_limited_scope', GH_TOKEN: 'ghp_stale' }
  const env = buildGitEnv(src, { ghLoggedIn: true })
  assert.equal('GITHUB_TOKEN' in env, false, 'GITHUB_TOKEN must not shadow gh login')
  assert.equal('GH_TOKEN' in env, false, 'GH_TOKEN outranks gh login too and must be dropped')
  assert.equal(env.PATH, '/bin')
})

test('buildGitEnv: neither explicit token nor gh login — keep inherited GITHUB_TOKEN as the CI fallback', () => {
  const src = { PATH: '/bin', GITHUB_TOKEN: 'github_pat_ci_only' }
  const env = buildGitEnv(src, { ghLoggedIn: false })
  assert.equal(env.GITHUB_TOKEN, 'github_pat_ci_only', 'CI that only has GITHUB_TOKEN must still authenticate')
})

test('createGitPort can be constructed with an explicit credential token without touching git', () => {
  const port = createGitPort({ credentialToken: 'gho_x', ghLoggedIn: false })
  assert.equal(typeof port.push, 'function')
  assert.equal(typeof port.createPr, 'function')
})

// --- probeGhLogin: must reflect a REAL `gh` login, never an env token ---------
//
// Regression for the live-e2e bug: `gh auth status` exits 0 for a *valid* env
// GH_TOKEN/GITHUB_TOKEN even with no hosts.yml, so a pure-CI box (only
// GITHUB_TOKEN, no gh login) looked "logged in". The caller then took the
// "gh is logged in" branch and deleted CI's only credential.
//
// Deterministic, no network and no real gh: a fake `gh` on PATH that reports
// "logged in" only when it cannot see an env token — exactly how the real gh
// behaves for an env-supplied token. If the probe leaks the token through,
// the fake sees it, exits 0, and the probe wrongly says "logged in".

function withFakeGh(scriptBody, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-gh-'))
  const bin = join(dir, 'gh')
  writeFileSync(bin, `#!/bin/sh\n${scriptBody}\n`, { mode: 0o755 })
  const savedPath = process.env.PATH
  try {
    return fn({ PATH: `${dir}:${savedPath}` }, dir)
  } finally {
    process.env.PATH = savedPath
    rmSync(dir, { recursive: true, force: true })
  }
}

test('probeGhLogin: an env GITHUB_TOKEN must NOT count as a gh login (pure-CI regression)', () => {
  if (process.platform === 'win32') return
  // The fake gh mimics the real one: a token in the environment is treated as a
  // credential and exits 0. Only a hosts.yml login would exit 0 without a token.
  withFakeGh(
    'if [ -n "$GH_TOKEN" ] || [ -n "$GITHUB_TOKEN" ]; then exit 0; fi\nexit 1',
    (envPatch) => {
      const ciEnv = { ...process.env, ...envPatch, GITHUB_TOKEN: 'github_pat_ci_only' }
      assert.equal(
        probeGhLogin(ciEnv),
        false,
        'a token-only CI box has no gh login; the probe must not be fooled by GITHUB_TOKEN',
      )
      // ...and the downstream decision therefore keeps CI's only credential.
      const childEnv = buildGitEnv(ciEnv, { ghLoggedIn: probeGhLogin(ciEnv) })
      assert.equal(childEnv.GITHUB_TOKEN, 'github_pat_ci_only', 'CI keeps its only credential')
      assert.equal('GH_TOKEN' in childEnv, false)
    },
  )
})

test('probeGhLogin: a genuine gh login is detected when no env token is present', () => {
  if (process.platform === 'win32') return
  withFakeGh('exit 0', (envPatch) => {
    const env = { ...process.env, ...envPatch }
    delete env.GITHUB_TOKEN
    delete env.GH_TOKEN
    assert.equal(probeGhLogin(env), true, 'a real login must still be detected')
  })
})

test('probeGhLogin: a missing/failing gh binary is reported as not logged in', () => {
  if (process.platform === 'win32') return
  withFakeGh('exit 127', (envPatch) => {
    const env = { ...process.env, ...envPatch }
    delete env.GITHUB_TOKEN
    delete env.GH_TOKEN
    assert.equal(probeGhLogin(env), false, 'a broken gh must fall back to the token branch, not crash')
  })
})

test('probeEnv: strips both token vars and leaves everything else intact', () => {
  const src = { PATH: '/bin', HOME: '/home/u', GITHUB_TOKEN: 'github_pat_x', GH_TOKEN: 'ghp_y' }
  const probe = probeEnv(src)
  assert.equal('GITHUB_TOKEN' in probe, false, 'GITHUB_TOKEN must not reach the probe')
  assert.equal('GH_TOKEN' in probe, false, 'GH_TOKEN outranks a gh login and must not reach the probe')
  assert.equal(probe.PATH, '/bin', 'unrelated vars survive')
  assert.equal(probe.HOME, '/home/u')
  assert.equal(src.GITHUB_TOKEN, 'github_pat_x', 'the source env is never mutated')
  assert.equal(src.GH_TOKEN, 'ghp_y')
})
