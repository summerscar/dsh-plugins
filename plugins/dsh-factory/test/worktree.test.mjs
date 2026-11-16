/**
 * Worktree tests.
 *
 * The containment/path helpers are pure. The create/remove half runs the real
 * `git` against a throw-away repo, so the exact git invocation is proven to work
 * on this machine, not just described.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { cleanGitEnv } from '../git-env.js'
import {
  checkProjectRoot,
  createWorktree,
  defaultWorktreeRoot,
  isInsideDataRoot,
  removeWorktree,
  resolveDataRoot,
  worktreePathFor,
  worktreeStatus,
} from '../worktree.js'

test('worktree path is <root>/<name-slug>-<id8>/<cardId> and defaults outside the data root', () => {
  // The segment is now the readable name slug plus the first 8 chars of the id,
  // NOT the bare id. A fixture whose id happens to equal its slug (like the old
  // `{id:'proj-1'}`) would pass both shapes and hide a regression, so use a name
  // and an id that differ.
  const project = { id: 'a1b2c3d4-REST', name: 'My Blog' }
  assert.equal(
    worktreePathFor(project, 'card-9'),
    join(defaultWorktreeRoot(), 'my-blog-a1b2c3d4', 'card-9'),
  )
  // A custom root is honoured.
  assert.equal(
    worktreePathFor({ id: 'deadbeef', name: 'X', worktreeRoot: '/srv/wt' }, 'c'),
    join('/srv/wt', 'x-deadbeef', 'c'),
  )
})

test('a worktree root inside the data root is refused', () => {
  // Both sides are derived, never hard-coded: the data root follows DSH_HOME
  // (falling back to the host default ~/.dsh), so a literal /data/dsh would
  // assert the old behaviour and break on any machine that sets DSH_HOME.
  assert.equal(isInsideDataRoot(join(resolveDataRoot(), 'worktrees')), true)
  assert.equal(isInsideDataRoot('/workspace/.dsh-worktrees'), false)
  assert.throws(() => worktreePathFor({ id: 'p', worktreeRoot: join(resolveDataRoot(), 'wt') }, 'c'), /数据根/)
})

test('project root under the data root is allowed but warned; relative is an error', () => {
  const inside = join(resolveDataRoot(), 'home', 'default', 'repo')
  assert.deepEqual(
    { ok: checkProjectRoot(inside).ok, warned: Boolean(checkProjectRoot(inside).warning) },
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
    execFileSync('git', ['init', '-b', 'main', repo], { env: cleanGitEnv() })
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], { env: cleanGitEnv() })

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
    execFileSync('git', ['init', '-b', 'main', repo], { env: cleanGitEnv() })
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], { env: cleanGitEnv() })

    // Simulate the wreckage a failed dispatch used to leave: an orphan branch with
    // no worktree. `worktree add -b` would fail on this — createWorktree must clear it.
    execFileSync('git', ['-C', repo, 'branch', branch], { env: cleanGitEnv() })

    const created = createWorktree({ repoPath: repo, worktreePath, branch, baseBranch: 'main' })
    assert.equal(created.branch, branch)
    assert.ok(existsSync(worktreePath), 'stale branch cleared, worktree created')

    // Force-remove with the branch: the branch must be gone afterwards, so a fresh
    // create (the retry) starts clean instead of hitting "already exists".
    removeWorktree({ repoPath: repo, worktreePath, force: true, branch })
    assert.equal(
      execFileSync('git', ['-C', repo, 'branch', '--list', branch], { encoding: 'utf8', env: cleanGitEnv() }).trim(),
      '',
      'branch deleted together with the worktree',
    )
    const retry = createWorktree({ repoPath: repo, worktreePath, branch, baseBranch: 'main' })
    assert.equal(retry.branch, branch, 'retry succeeds once the leftover branch is gone')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('a git hook environment cannot redirect worktree git calls (GIT_DIR leak)', { concurrency: false }, () => {
  // husky exports the committing repository's GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE
  // into the child process; they override `-C` and would make every git call here
  // target that repository instead of our temp one. This test POLLUTES process.env
  // for real (the production code reads process.env), so a regression in
  // cleanGitEnv / worktree.git() actually fails.
  const tmp = mkdtempSync(join(tmpdir(), 'factory-wt-hook-'))
  const repo = join(tmp, 'repo')
  const worktreePath = join(tmp, 'worktrees', 'proj-1', 'card-hook')
  const polluted = {
    GIT_DIR: '/nonexistent/host.git',
    GIT_WORK_TREE: '/nonexistent/host',
    GIT_INDEX_FILE: '/nonexistent/host.git/index',
    GIT_OBJECT_DIRECTORY: '/nonexistent/host.git/objects',
    GIT_ALTERNATE_OBJECT_DIRECTORIES: '/nonexistent/host.git/objects',
    GIT_COMMON_DIR: '/nonexistent/host.git',
  }
  const saved = {}
  for (const key of Object.keys(polluted)) {
    saved[key] = process.env[key]
    process.env[key] = polluted[key]
  }
  // Setup must run clean (even `git init` is otherwise redirected), but the
  // production paths under test must run with the polluted process.env.
  const run = (args) => execFileSync('git', args, { encoding: 'utf8', env: cleanGitEnv() })
  try {
    run(['init', '-b', 'main', repo])
    run(['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'])

    // Control: with the hook variables intact, `git -C <temp repo>` really is
    // redirected and fails. Without this assertion the test could pass vacuously.
    assert.throws(
      () => execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8', env: { ...process.env } }),
      /index file open failed|not a git repository|Not a directory/i,
      'the polluted env must genuinely break an uncleaned git call',
    )

    // createWorktree strips the hook variables itself, so this must succeed even
    // though process.env points at a repository that does not exist.
    const created = createWorktree({ repoPath: repo, worktreePath, branch: 'factory/card-hook', baseBranch: 'main' })
    assert.equal(created.branch, 'factory/card-hook')
    assert.ok(existsSync(worktreePath), 'worktree created despite the polluted process.env')
    removeWorktree({ repoPath: repo, worktreePath, force: true, branch: 'factory/card-hook' })
    assert.equal(existsSync(worktreePath), false)
  } finally {
    for (const key of Object.keys(polluted)) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    rmSync(tmp, { recursive: true, force: true })
  }
})
