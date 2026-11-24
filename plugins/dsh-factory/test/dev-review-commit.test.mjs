import assert from 'node:assert/strict'
import test from 'node:test'
import { ensureCommittedForAutoDelivery } from '../delivery.js'
import { makeFixture, makeTools, HEAD, SHA, STALE } from './dev-v4-support.mjs'

test('Dev-ReviewCommit: a clean build tree at the reviewed HEAD is skipped by the legacy guard', async () => {
  const f = makeFixture({ status: 'pr-review' })
  try {
    f.store._project(f.project.id).autonomy = 'auto-delivery'
    f.store.recordCommit(f.card.id, { sha: HEAD, message: 'build', actor: 'agent' })
    const calls = []
    const out = await ensureCommittedForAutoDelivery({
      store: f.store, cardId: f.card.id, readHead: () => HEAD,
      port: { isWorktreeClean: () => true, headOf: () => HEAD, deletedCount: () => 0, changedPaths: () => { calls.push('changedPaths'); return [] }, add: () => calls.push('add'), commit: () => calls.push('commit') },
    })
    assert.equal(out.ok, true)
    assert.equal(out.skipped, true)
    assert.deepEqual(calls, [])
  } finally { f.cleanup() }
})

test('Dev-ReviewCommit: V4 build commits the dirty tree once and records the sha', async () => {
  const f = makeFixture()
  try {
    const t = makeTools(f)
    const out = await t.find('factory_push_branch').execute({ cardId: f.card.id, message: 'fix it' }, t.builder)
    assert.equal(out.sha, SHA)
    assert.equal(f.store.getCard(f.card.id).commitSha, SHA)
    assert.equal(f.store.getCard(f.card.id).commitMessage, 'fix it')
    assert.deepEqual(t.calls.map((c) => c[0]), ['changedPaths', 'hasDiff', 'add', 'commit', 'push'])
  } finally { f.cleanup() }
})

test('Dev-ReviewCommit: an old commitSha does not let a rebuilt dirty tree skip', async () => {
  const f = makeFixture()
  try {
    f.store.recordCommit(f.card.id, { sha: STALE, message: 'old', actor: 'agent' })
    const t = makeTools(f, { gitPort: { hasDiff: () => true } })
    await assert.rejects(() => t.find('factory_push_branch').execute({ cardId: f.card.id, message: 'again' }, t.builder), /已提交|重复推送/)
  } finally { f.cleanup() }
})

test('Dev-ReviewCommit: protected and base branches refuse a build push', async () => {
  const f = makeFixture({ branch: 'main' })
  try {
    const t = makeTools(f)
    await assert.rejects(() => t.find('factory_push_branch').execute({ cardId: f.card.id, message: 'm' }, t.builder), /受保护分支/)
    assert.deepEqual(t.calls, [])
  } finally { f.cleanup() }
})

test('Dev-ReviewCommit: a failed build commit leaves no commitSha', async () => {
  const f = makeFixture()
  try {
    const t = makeTools(f, { gitPort: { commit: () => { throw new Error('hook failed') } } })
    await assert.rejects(() => t.find('factory_push_branch').execute({ cardId: f.card.id, message: 'm' }, t.builder), /hook failed/)
    assert.equal(f.store.getCard(f.card.id).commitSha, null)
  } finally { f.cleanup() }
})

test('Dev-ReviewCommit: legacy non-L4 projects are untouched by the auto guard', async () => {
  const f = makeFixture({ status: 'pr-review' })
  try {
    const out = await ensureCommittedForAutoDelivery({ store: f.store, cardId: f.card.id, port: {}, readHead: () => HEAD })
    assert.equal(out.ok, false)
    assert.match(out.reason, /非 L4/)
  } finally { f.cleanup() }
})
