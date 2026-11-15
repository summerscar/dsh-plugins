/**
 * Worktree tests.
 *
 * The containment/path helpers are pure. The create/remove half runs the real
 * `git` against a throw-away repo, so the exact git invocation is proven to work
 * on this machine, not just described.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

// Git hooks export GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE, which override -C and
// would make these temp-repo commands hit the host repository. Strip them.
const CLEAN_ENV = (() => {
  const env = { ...process.env }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR']) delete env[k]
  return env
})()
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_WORKTREE_ROOT,
  checkProjectRoot,
  createWorktree,
  isInsideDataRoot,
  removeWorktree,
  worktreePathFor,
  worktreeStatus,
} from '../worktree.js'

test('worktree path is <root>/<projectId>/<cardId> and defaults outside the data root', () => {
  const project = { id: 'proj-1' }
  assert.equal(
    worktreePathFor(project, 'card-9'),
    join(DEFAULT_WORKTREE_ROOT, 'proj-1', 'card-9'),
  )
  // A custom root is honoured.
  assert.equal(
    worktreePathFor({ id: 'p', worktreeRoot: '/srv/wt' }, 'c'),
    join('/srv/wt', 'p', 'c'),
  )
})

test('a worktree root inside the data root is refused', () => {
  assert.equal(isInsideDataRoot('/data/dsh/worktrees'), true)
  assert.equal(isInsideDataRoot('/workspace/.dsh-worktrees'), false)
  assert.throws(() => worktreePathFor({ id: 'p', worktreeRoot: '/data/dsh/wt' }, 'c'), /数据根/)
})

test('project root under the data root is allowed but warned; relative is an error', () => {
  assert.deepEqual(
    { ok: checkProjectRoot('/data/dsh/home/default/repo').ok, warned: Boolean(checkProjectRoot('/data/dsh/home/default/repo').warning) },
    { ok: true, warned: true },
  )
  assert.equal(checkProjectRoot('/workspace/example-repo').ok, true)
  assert.equal(checkProjectRoot('/workspace/example-repo').warning, undefined)
  assert.equal(checkProjectRoot('relative/path').ok, false)
})

test('real git: create a worktree, detect dirt, refuse unforced remove, force-remove', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'factory-wt-'))
  const repo = join(tmp, 'repo')
  const worktreePath = join(tmp, 'worktrees', 'proj-1', 'card-1')
  try {
    execFileSync('git', ['init', '-b', 'main', repo], { env: CLEAN_ENV })
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], { env: CLEAN_ENV })

    const created = createWorktree({ repoPath: repo, worktreePath, branch: 'factory/card-1', baseBranch: 'main' })
    assert.equal(created.branch, 'factory/card-1')
    assert.ok(existsSync(join(worktreePath, '.git')) || existsSync(worktreePath), 'worktree should exist')
    assert.deepEqual(worktreeStatus(worktreePath), [], 'fresh worktree is clean')

    // Make it dirty and prove unforced removal refuses with a change list.
    writeFileSync(join(worktreePath, 'work.txt'), 'hello\n')
    assert.ok(worktreeStatus(worktreePath).length > 0, 'worktree should be dirty')
    assert.throws(() => removeWorktree({ repoPath: repo, worktreePath }), (error) => {
      assert.ok(Array.isArray(error.changes) && error.changes.length > 0)
      return /拒绝强删/.test(error.message)
    })

    // Forced removal succeeds.
    removeWorktree({ repoPath: repo, worktreePath, force: true })
    assert.equal(existsSync(worktreePath), false, 'worktree removed')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('a leftover branch from a failed dispatch does not block a retry; force-remove deletes it', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'factory-wt-stale-'))
  const repo = join(tmp, 'repo')
  const worktreePath = join(tmp, 'worktrees', 'proj-1', 'card-2')
  const branch = 'factory/card-2'
  try {
    execFileSync('git', ['init', '-b', 'main', repo], { env: CLEAN_ENV })
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], { env: CLEAN_ENV })

    // Simulate the wreckage a failed dispatch used to leave: an orphan branch with
    // no worktree. `worktree add -b` would fail on this — createWorktree must clear it.
    execFileSync('git', ['-C', repo, 'branch', branch], { env: CLEAN_ENV })

    const created = createWorktree({ repoPath: repo, worktreePath, branch, baseBranch: 'main' })
    assert.equal(created.branch, branch)
    assert.ok(existsSync(worktreePath), 'stale branch cleared, worktree created')

    // Force-remove with the branch: the branch must be gone afterwards, so a fresh
    // create (the retry) starts clean instead of hitting "already exists".
    removeWorktree({ repoPath: repo, worktreePath, force: true, branch })
    assert.equal(
      execFileSync('git', ['-C', repo, 'branch', '--list', branch], { encoding: 'utf8', env: CLEAN_ENV }).trim(),
      '',
      'branch deleted together with the worktree',
    )
    const retry = createWorktree({ repoPath: repo, worktreePath, branch, baseBranch: 'main' })
    assert.equal(retry.branch, branch, 'retry succeeds once the leftover branch is gone')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('a git hook environment cannot redirect worktree git calls (GIT_DIR leak)', () => {
  // Inside husky the committing repository is exported; without stripping it,
  // every `git -C <temp repo>` below would target the host repository instead.
  const tmp = mkdtempSync(join(tmpdir(), 'factory-wt-hook-'))
  const repo = join(tmp, 'repo')
  const worktreePath = join(tmp, 'worktrees', 'proj-1', 'card-hook')
  const polluted = {
    ...process.env,
    GIT_DIR: '/nonexistent/host.git',
    GIT_WORK_TREE: '/nonexistent/host',
    GIT_INDEX_FILE: '/nonexistent/host.git/index',
  }
  // The setup itself must run clean: even `git init` is redirected otherwise.
  const run = (args) => execFileSync('git', args, { encoding: 'utf8', env: CLEAN_ENV })
  try {
    run(['init', '-b', 'main', repo])
    run(['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'])
    // createWorktree strips the hook variables itself, so this must succeed even
    // though the caller's environment points somewhere that does not exist.
    const created = createWorktree({ repoPath: repo, worktreePath, branch: 'factory/card-hook', baseBranch: 'main' })
    assert.equal(created.branch, 'factory/card-hook')
    assert.ok(existsSync(worktreePath), 'worktree created despite the polluted environment')
    removeWorktree({ repoPath: repo, worktreePath, force: true, branch: 'factory/card-hook' })
    assert.equal(existsSync(worktreePath), false)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
