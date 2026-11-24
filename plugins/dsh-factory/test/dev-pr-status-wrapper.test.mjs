/**
 * Dev self-check — PR status must use the existing git/gh wrapper and the
 * project identity ladder, not a separate raw gh path.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createGitPort } from '../git-exec.js'
import { createEngineStatus, runTick } from '../autonomy.js'
import { applyRemoteSync } from '../sync.js'
import { makeFixture } from './dev-v4-support.mjs'

test('Dev-PRStatus: createGitPort.prState uses the shared git env wrapper', () => {
  const calls = []
  const exec = (command, args, options) => {
    calls.push({ command, args, env: options.env })
    return { status: 0, stdout: JSON.stringify({ state: 'MERGED' }), stderr: '' }
  }
  const port = createGitPort({ credentialToken: 'gho_test', ghLoggedIn: false, exec })
  assert.equal(port.prState({ prUrl: 'https://github.com/o/r/pull/12' }), 'MERGED')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'gh')
  assert.deepEqual(calls[0].args, ['pr', 'view', 'https://github.com/o/r/pull/12', '--json', 'state'])
  assert.equal(calls[0].env.GH_TOKEN, 'gho_test')
  assert.equal(calls[0].env.GITHUB_TOKEN, undefined)
})

test('Dev-PRStatus: engine prefers the per-project git port for PR state', async () => {
  const f = makeFixture({ status: 'pr-review' })
  f.store._card(f.card.id).prUrl = 'https://github.com/o/r/pull/12'
  f.store._commit()
  try {
    const seen = { git: [], gh: [] }
    await runTick({
      store: f.store, status: createEngineStatus(),
      deps: {
        intake: async () => ({ created: [] }),
        dispatch: async () => ({ mode: 'none' }),
        approve: async () => ({ approved: false }),
        continue: async () => ({}),
        isSessionActive: async () => false,
        ghPortFor: async () => ({ prState: async ({ prUrl }) => { seen.gh.push(prUrl); return 'OPEN' } }),
        gitPortFor: async () => ({ prState: async ({ prUrl }) => { seen.git.push(prUrl); return 'MERGED' } }),
        remoteSync: applyRemoteSync,
      },
    })
    assert.deepEqual(seen.git, ['https://github.com/o/r/pull/12'])
    assert.deepEqual(seen.gh, [], 'the legacy gh port is not used for PR status when git port is available')
    assert.equal(f.store.getCard(f.card.id).status, 'done')
  } finally { f.cleanup() }
})
