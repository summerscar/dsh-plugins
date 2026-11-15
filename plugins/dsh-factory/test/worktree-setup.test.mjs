/**
 * worktree preparation tests — path safety, copyFiles behaviour, postCreate
 * outcomes, and the dispatch-level rollback when preparation fails.
 *
 * No host, no network, no real shell: fsPort / spawnPort are injected fakes.
 * The copyFiles part also runs once against a real temp directory so the actual
 * file copy is proven, not just described.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FactoryStore } from '../store.js'
import { dispatchCard } from '../dispatch.js'
import {
  DEFAULT_POST_CREATE_TIMEOUT_MS,
  POST_CREATE_VARIABLES,
  assertSafeRelativePath,
  copyConfiguredFiles,
  hasPreparation,
  normalizeCopyFiles,
  prepareWorktree,
  runPostCreate,
} from '../worktree-setup.js'

// --- path safety -------------------------------------------------------------

test('assertSafeRelativePath accepts plain relative paths and normalises separators', () => {
  assert.equal(assertSafeRelativePath('.env'), '.env')
  assert.equal(assertSafeRelativePath('  .env.local  '), '.env.local')
  assert.equal(assertSafeRelativePath('config/local.json'), 'config/local.json')
  assert.equal(assertSafeRelativePath('config\\local.json'), 'config/local.json')
})

test('assertSafeRelativePath rejects traversal, absolute paths, .git and empty segments', () => {
  const bad = [
    '../secret', 'config/../../secret', '/etc/passwd', 'C:\\secret',
    '.git/config', 'config/.git/HEAD', '.', '..', '', 'a/', 'a\0b',
  ]
  for (const value of bad) {
    assert.throws(() => assertSafeRelativePath(value), undefined, `must reject ${JSON.stringify(value)}`)
  }
})

test('normalizeCopyFiles validates the whole array and never mutates input', () => {
  assert.deepEqual(normalizeCopyFiles(null), [])
  assert.deepEqual(normalizeCopyFiles(['.env', 'config/local.json']), ['.env', 'config/local.json'])
  assert.throws(() => normalizeCopyFiles('.env'), /数组/)
  assert.throws(() => normalizeCopyFiles(['../escape']), /\.\. 逃逸/)
})

// --- copyFiles (real filesystem, fake not needed here) -----------------------

test('copyConfiguredFiles copies real files, skips missing ones with warnings, creates subdirs', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'factory-copy-'))
  const repo = join(tmp, 'repo')
  const worktree = join(tmp, 'worktree')
  try {
    mkdirSync(join(repo, 'config'), { recursive: true })
    mkdirSync(worktree, { recursive: true })
    writeFileSync(join(repo, '.env'), 'SECRET=1\n')
    writeFileSync(join(repo, 'config', 'local.json'), '{"a":1}')

    const result = copyConfiguredFiles({
      repoPath: repo, worktreePath: worktree,
      files: ['.env', '.env.local', 'config/local.json'],
    })
    assert.deepEqual(result.copied, ['.env', 'config/local.json'])
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0], /\env\.local.*不存在/)
    assert.equal(readFileSync(join(worktree, '.env'), 'utf8'), 'SECRET=1\n')
    assert.equal(readFileSync(join(worktree, 'config', 'local.json'), 'utf8'), '{"a":1}')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('copyConfiguredFiles keeps an existing target file instead of overwriting it', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'factory-copy-keep-'))
  const repo = join(tmp, 'repo')
  const worktree = join(tmp, 'worktree')
  try {
    mkdirSync(repo, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    writeFileSync(join(repo, '.env'), 'from-repo\n')
    writeFileSync(join(worktree, '.env'), 'tracked-in-worktree\n')
    const result = copyConfiguredFiles({ repoPath: repo, worktreePath: worktree, files: ['.env'] })
    assert.deepEqual(result.copied, [])
    assert.match(result.warnings[0], /已存在同名文件/)
    assert.equal(readFileSync(join(worktree, '.env'), 'utf8'), 'tracked-in-worktree\n')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('copyConfiguredFiles skips symlink sources instead of following them out of the repo', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'factory-copy-link-'))
  const repo = join(tmp, 'repo')
  const worktree = join(tmp, 'worktree')
  const outside = join(tmp, 'outside')
  try {
    mkdirSync(repo, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    writeFileSync(outside, 'outside\n')
    symlinkSync(outside, join(repo, '.env'))
    const result = copyConfiguredFiles({ repoPath: repo, worktreePath: worktree, files: ['.env'] })
    assert.deepEqual(result.copied, [])
    assert.match(result.warnings[0], /符号链接/)
    assert.equal(existsSync(join(worktree, '.env')), false, 'nothing leaks into the worktree')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('copyConfiguredFiles rejects an invalid configured path (dispatch will roll back)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'factory-copy-bad-'))
  const repo = join(tmp, 'repo')
  const worktree = join(tmp, 'worktree')
  try {
    mkdirSync(repo, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    assert.throws(
      () => copyConfiguredFiles({ repoPath: repo, worktreePath: worktree, files: ['../escape'] }),
      /\.\. 逃逸/,
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// --- postCreate --------------------------------------------------------------

function fakeSpawn(result) {
  const calls = []
  return {
    calls,
    port: (options) => { calls.push(options); return result },
  }
}

test('runPostCreate: no command is a no-op and never touches the spawn port', () => {
  const { calls, port } = fakeSpawn({ status: 0 })
  assert.deepEqual(runPostCreate({ worktreePath: '/tmp/w', command: null, spawnPort: port }), { ran: false })
  assert.equal(calls.length, 0)
})

test('runPostCreate: success passes context via env, strips git redirect vars, honours timeout', () => {
  const { calls, port } = fakeSpawn({ status: 0, stderr: '' })
  const run = runPostCreate({
    worktreePath: '/workspace/wt/card-1',
    command: 'echo ready',
    variables: { worktree_path: '/workspace/wt/card-1', worktree_name: 'card-1', branch_name: 'factory/card-1', base_ref: 'main' },
    timeoutMs: 1234,
    processEnv: { PATH: '/bin', GIT_DIR: '/host/.git', GIT_INDEX_FILE: '/host/.git/index', GITHUB_TOKEN: 'kept' },
    spawnPort: port,
  })
  assert.deepEqual(run, { ran: true })
  const options = calls[0]
  assert.equal(options.command, 'echo ready', 'the command is passed as-is, never interpolated')
  assert.equal(options.cwd, '/workspace/wt/card-1')
  assert.equal(options.timeoutMs, 1234)
  for (const key of POST_CREATE_VARIABLES) assert.equal(typeof options.env[key], 'string', `${key} must be exposed`)
  assert.equal(options.env.worktree_name, 'card-1')
  assert.equal('GIT_DIR' in options.env, false, 'cleanGitEnv strips hook redirect vars')
  assert.equal('GIT_INDEX_FILE' in options.env, false)
  assert.equal(options.env.GITHUB_TOKEN, 'kept', 'unrelated env survives (token is NOT the plugin\'s business)')
  assert.equal(options.env.PATH, '/bin')
})

test('runPostCreate: non-zero exit throws with the exit code and stderr', () => {
  const { port } = fakeSpawn({ status: 2, stderr: 'command not found' })
  assert.throws(
    () => runPostCreate({ worktreePath: '/tmp/w', command: 'false', spawnPort: port }),
    /exit 2.*command not found/,
  )
})

test('runPostCreate: timeout throws a distinct error', () => {
  const { port } = fakeSpawn({ status: null, error: { code: 'ETIMEDOUT', message: 'timed out' } })
  assert.throws(
    () => runPostCreate({ worktreePath: '/tmp/w', command: 'sleep 999', spawnPort: port }),
    /超时/,
  )
})

test('runPostCreate: spawn failure throws', () => {
  const { port } = fakeSpawn({ status: null, error: { code: 'ENOENT', message: 'no shell' } })
  assert.throws(
    () => runPostCreate({ worktreePath: '/tmp/w', command: 'true', spawnPort: port }),
    /启动失败/,
  )
})

test('runPostCreate rejects a non-positive timeout', () => {
  const { port } = fakeSpawn({ status: 0 })
  assert.throws(
    () => runPostCreate({ worktreePath: '/tmp/w', command: 'true', timeoutMs: 0, spawnPort: port }),
    /正数/,
  )
})

// --- prepareWorktree orchestration -------------------------------------------

test('prepareWorktree runs copyFiles then postCreate and reports both', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'factory-prepare-'))
  const repo = join(tmp, 'repo')
  const worktree = join(tmp, 'worktree')
  try {
    mkdirSync(repo, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    writeFileSync(join(repo, '.env'), 'A=1\n')
    const { calls, port } = fakeSpawn({ status: 0, stderr: '' })
    const result = prepareWorktree({
      project: { rootPath: repo, copyFiles: ['.env'], postCreate: 'echo ok' },
      worktreePath: worktree, branch: 'factory/c1', baseBranch: 'main',
      spawnPort: port, processEnv: { PATH: '/bin' },
    })
    assert.deepEqual(result.copied, ['.env'])
    assert.equal(result.postCreateRan, true)
    assert.equal(readFileSync(join(worktree, '.env'), 'utf8'), 'A=1\n')
    assert.equal(calls[0].env.branch_name, 'factory/c1')
    assert.equal(calls[0].env.base_ref, 'main')
    assert.equal(calls[0].env.worktree_path, worktree)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('hasPreparation is false for an unconfigured project (backwards compatible)', () => {
  assert.equal(hasPreparation(null), false)
  assert.equal(hasPreparation({}), false)
  assert.equal(hasPreparation({ copyFiles: [], postCreate: null }), false)
  assert.equal(hasPreparation({ copyFiles: ['.env'] }), true)
  assert.equal(hasPreparation({ postCreate: 'echo ok' }), true)
})

// --- store + dispatch integration -------------------------------------------

function setupStore() {
  const tmp = mkdtempSync(join(tmpdir(), 'factory-setup-store-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  return { store, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

test('createProject stores preparation config with defaults and rejects invalid paths', () => {
  const { store, cleanup } = setupStore()
  try {
    const plain = store.createProject({ name: 'p', rootPath: '/workspace/p' })
    assert.deepEqual(plain.copyFiles, [])
    assert.equal(plain.postCreate, null)
    assert.equal(plain.postCreateTimeoutMs, DEFAULT_POST_CREATE_TIMEOUT_MS)

    const configured = store.createProject({
      name: 'q', rootPath: '/workspace/q',
      copyFiles: ['.env', 'config/local.json'], postCreate: 'echo ok', postCreateTimeoutMs: 1000,
    })
    assert.deepEqual(configured.copyFiles, ['.env', 'config/local.json'])
    assert.equal(configured.postCreate, 'echo ok')
    assert.equal(configured.postCreateTimeoutMs, 1000)

    assert.throws(() => store.createProject({ name: 'r', rootPath: '/workspace/r', copyFiles: ['../x'] }), /\.\. 逃逸/)
    assert.throws(() => store.createProject({ name: 's', rootPath: '/workspace/s', postCreateTimeoutMs: -1 }), /正数/)
  } finally {
    cleanup()
  }
})

test('updatePreparation changes only the three preparation fields, old state files still load', () => {
  const { store, cleanup } = setupStore()
  try {
    const project = store.createProject({ name: 'p', rootPath: '/workspace/p' })
    const updated = store.updatePreparation(project.id, { copyFiles: ['.env'], postCreate: 'echo ok' })
    assert.deepEqual(updated.copyFiles, ['.env'])
    assert.equal(updated.postCreate, 'echo ok')
    assert.equal(updated.rootPath, '/workspace/p', 'repo identity is untouched')

    // A state file written before these fields existed must still load.
    const legacy = JSON.parse(readFileSync(store.file, 'utf8'))
    delete legacy.projects[0].copyFiles
    delete legacy.projects[0].postCreate
    delete legacy.projects[0].postCreateTimeoutMs
    writeFileSync(store.file, `${JSON.stringify(legacy, null, 2)}\n`)
    const reloaded = new FactoryStore({ file: store.file })
    assert.deepEqual(reloaded.getProject(project.id).copyFiles, undefined)
    assert.equal(hasPreparation(reloaded.getProject(project.id)), false, 'legacy project is a no-op')
  } finally {
    cleanup()
  }
})

test('dispatch: unconfigured project never calls prepareWorktree (no behaviour change)', async () => {
  const { store, cleanup } = setupStore()
  try {
    const project = store.createProject({ name: 'p', rootPath: '/workspace/p' })
    const board = store.createBoard({ projectId: project.id, name: 'b' })
    const card = store.createCard({ boardId: board.id, title: 'c' })
    let prepared = 0
    const port = {
      createWorktree: () => {}, removeWorktree: () => {},
      prepareWorktree: () => { prepared += 1 },
      createSession: async () => ({ sessionId: 's', handle: { dispose: () => {} } }),
      disposeSession: async () => {},
    }
    const result = await dispatchCard({ store, cardId: card.id, port })
    assert.equal(result.sessionId, 's')
    assert.equal(prepared, 0)
  } finally {
    cleanup()
  }
})

test('dispatch: preparation failure rolls back worktree + branch, card stays Inbox, retry works', async () => {
  const { store, cleanup } = setupStore()
  try {
    const project = store.createProject({
      name: 'p', rootPath: '/workspace/p', copyFiles: ['.env'], postCreate: 'echo ok',
    })
    const board = store.createBoard({ projectId: project.id, name: 'b' })
    const card = store.createCard({ boardId: board.id, title: 'c' })
    const calls = { removed: [], session: 0 }
    let fail = true
    const port = {
      createWorktree: () => {},
      removeWorktree: (options) => { calls.removed.push(options) },
      prepareWorktree: () => {
        if (fail) throw new Error('postCreate failed on purpose')
        return { copied: ['.env'], warnings: [], postCreateRan: true }
      },
      createSession: async () => { calls.session += 1; return { sessionId: 's', handle: { dispose: () => {} } } },
      disposeSession: async () => {},
    }
    await assert.rejects(() => dispatchCard({ store, cardId: card.id, port }), /postCreate failed on purpose/)
    const after = store.getCard(card.id)
    assert.equal(after.status, 'inbox')
    assert.equal(after.sessionId, null)
    assert.equal(after.worktreePath, null)
    assert.equal(calls.session, 0, 'no session starts when preparation fails')
    assert.equal(calls.removed.length, 1)
    assert.equal(calls.removed[0].branch, `factory/${card.id}`, 'branch cleaned so a retry cannot deadlock')
    assert.equal(store.getCard(card.id).pendingDispatch, null, 'claim released')

    fail = false
    const retry = await dispatchCard({ store, cardId: card.id, port })
    assert.equal(retry.sessionId, 's', 'retry succeeds once preparation is fixed')
  } finally {
    cleanup()
  }
})

test('dispatch: a configured project without a prepareWorktree port refuses to dispatch', async () => {
  const { store, cleanup } = setupStore()
  try {
    const project = store.createProject({ name: 'p', rootPath: '/workspace/p', copyFiles: ['.env'] })
    const board = store.createBoard({ projectId: project.id, name: 'b' })
    const card = store.createCard({ boardId: board.id, title: 'c' })
    const port = {
      createWorktree: () => {}, removeWorktree: () => {},
      createSession: async () => ({ sessionId: 's', handle: { dispose: () => {} } }),
      disposeSession: async () => {},
    }
    await assert.rejects(() => dispatchCard({ store, cardId: card.id, port }), /prepareWorktree/)
    assert.equal(store.getCard(card.id).status, 'inbox')
  } finally {
    cleanup()
  }
})

