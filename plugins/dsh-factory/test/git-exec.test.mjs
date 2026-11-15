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
import { buildGitEnv, commitCard, createPrForCard, createGitPort, probeEnv, probeGhLogin } from '../git-exec.js'

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

test('AG-1: no authorization ⇒ commit writes nothing to git', async () => {
  const { store, card, cleanup } = setup()
  try {
    const { port, calls } = fakePort()
    await assert.rejects(() => commitCard({ store, cardId: card.id, port }), /缺少「确认提交」授权|仅 Review/)
    assert.equal(calls.length, 0, 'the git port must not be touched without authorization')
  } finally {
    cleanup()
  }
})

test('AG-1: no authorization ⇒ PR creates no push and no PR', async () => {
  const { store, card, cleanup } = setup()
  try {
    const { port, calls } = fakePort()
    await assert.rejects(() => createPrForCard({ store, cardId: card.id, port }), /请先「确认提交」|缺少/)
    assert.equal(calls.length, 0)
  } finally {
    cleanup()
  }
})

test('an authorized commit runs git add + commit and records the sha', async () => {
  const { store, card, cleanup } = setup()
  try {
    store.authorize(card.id, 'confirm-commit')
    const { port, calls } = fakePort()
    const result = await commitCard({ store, cardId: card.id, port, message: 'do it' })
    assert.equal(result.sha, 'deadbeef')
    assert.deepEqual(calls.map((c) => c.name), ['add', 'commit'])
    const fresh = store.getCard(card.id)
    assert.equal(fresh.commitSha, 'deadbeef')
    assert.equal(fresh.pendingAuthorization, null, 'authorization is consumed')
  } finally {
    cleanup()
  }
})

test('a failing commit unstages and leaves the authorization armed for retry', async () => {
  const { store, card, cleanup } = setup()
  try {
    store.authorize(card.id, 'confirm-commit')
    const { port, calls } = fakePort({ commit: () => { throw new Error('commit failed') } })
    await assert.rejects(() => commitCard({ store, cardId: card.id, port, message: 'x' }), /commit failed/)
    assert.ok(calls.some((c) => c.name === 'reset'), 'a failed commit resets the index')
    assert.equal(store.getCard(card.id).commitSha, null)
    assert.equal(store.getCard(card.id).pendingAuthorization.action, 'confirm-commit', 'still armed to retry')
  } finally {
    cleanup()
  }
})

test('an authorized PR pushes + creates it, sets prUrl, and stays in Review', async () => {
  const { store, card, cleanup } = setup()
  try {
    store.authorize(card.id, 'confirm-commit')
    const { port } = fakePort()
    await commitCard({ store, cardId: card.id, port, message: 'do it' })

    store.authorize(card.id, 'create-pr')
    const { port: prPort, calls } = fakePort()
    const result = await createPrForCard({ store, cardId: card.id, port: prPort })
    assert.equal(result.url, 'https://example/pr/1')
    assert.deepEqual(calls.map((c) => c.name), ['push', 'createPr'])
    const fresh = store.getCard(card.id)
    assert.equal(fresh.prUrl, 'https://example/pr/1')
    assert.equal(fresh.status, 'review', 'PR success stays in Review (D6)')
    assert.equal(fresh.pendingAuthorization, null)
  } finally {
    cleanup()
  }
})

test('PR is refused before a commit, and a card cannot be committed twice', async () => {
  const { store, card, cleanup } = setup()
  try {
    const { port } = fakePort()
    await assert.rejects(() => createPrForCard({ store, cardId: card.id, port }), /请先「确认提交」/)

    store.authorize(card.id, 'confirm-commit')
    await commitCard({ store, cardId: card.id, port })
    // Second commit refused even if re-authorized.
    store.authorize(card.id, 'confirm-commit')
    await assert.rejects(() => commitCard({ store, cardId: card.id, port }), /已提交/)
  } finally {
    cleanup()
  }
})

test('refuses to push a protected branch (main) with zero git calls', async () => {
  const { store, card, cleanup } = setup()
  try {
    store.authorize(card.id, 'confirm-commit')
    const { port } = fakePort()
    await commitCard({ store, cardId: card.id, port })
    // A misconfigured card branched onto main must never reach the remote.
    store.setWorktree(card.id, { worktreePath: '/tmp/fake-worktree', branch: 'main' })
    store.authorize(card.id, 'create-pr')
    const { port: prPort, calls } = fakePort()
    await assert.rejects(() => createPrForCard({ store, cardId: card.id, port: prPort }), /受保护分支|base 分支/)
    assert.equal(calls.length, 0, 'no push/PR happens on a protected branch')
  } finally {
    cleanup()
  }
})

test('refuses an empty diff (HEAD == base) with zero git calls', async () => {
  const { store, card, cleanup } = setup()
  try {
    store.authorize(card.id, 'confirm-commit')
    const { port } = fakePort()
    await commitCard({ store, cardId: card.id, port })
    store.authorize(card.id, 'create-pr')
    const { port: prPort, calls } = fakePort({ hasDiff: () => false })
    await assert.rejects(() => createPrForCard({ store, cardId: card.id, port: prPort }), /无差异|没有可交付/)
    assert.equal(calls.length, 0, 'no push/PR happens without a real change')
  } finally {
    cleanup()
  }
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
