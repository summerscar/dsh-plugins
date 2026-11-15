/**
 * Shared git subprocess environment tests.
 *
 * The regression that motivated this module: husky sets GIT_DIR / GIT_WORK_TREE /
 * GIT_INDEX_FILE in pre-commit, and those override `-C`, so a child git call
 * made by the plugin (or by a test's temp repo) silently targets the committing
 * repository instead. Only the redirecting vars are stripped; identity/config
 * vars and unrelated env must survive.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { GIT_CONTEXT_VARS, cleanGitEnv } from '../git-env.js'
import { buildGitEnv } from '../git-exec.js'

const POLLUTED = {
  PATH: '/bin',
  HOME: '/home/u',
  GIT_AUTHOR_NAME: 'kept',
  GIT_DIR: '/host/.git',
  GIT_WORK_TREE: '/host',
  GIT_INDEX_FILE: '/host/.git/index',
  GIT_COMMON_DIR: '/host/.git',
  GIT_OBJECT_DIRECTORY: '/host/.git/objects',
  GIT_ALTERNATE_OBJECT_DIRECTORIES: '/host/.git/objects',
  GIT_PREFIX: 'plugins/',
}

test('cleanGitEnv strips every git repo-redirect var and leaves everything else', () => {
  const env = cleanGitEnv(POLLUTED)
  for (const key of GIT_CONTEXT_VARS) {
    assert.equal(key in env, false, `${key} must not reach a git child`)
  }
  assert.equal(env.PATH, '/bin')
  assert.equal(env.HOME, '/home/u')
  assert.equal(env.GIT_AUTHOR_NAME, 'kept', 'identity vars are not redirections and must survive')
  assert.equal(POLLUTED.GIT_DIR, '/host/.git', 'the source env is never mutated')
})

test('buildGitEnv also strips hook vars in all three credential branches', () => {
  const cases = [
    { credentialToken: 'gho_x', ghLoggedIn: false },
    { ghLoggedIn: true },
    { ghLoggedIn: false },
  ]
  for (const options of cases) {
    const env = buildGitEnv(POLLUTED, options)
    for (const key of GIT_CONTEXT_VARS) {
      assert.equal(key in env, false, `${key} must be stripped with ${JSON.stringify(options)}`)
    }
    assert.equal(env.PATH, '/bin')
  }
})
