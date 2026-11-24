import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_PHASE_RULES, behaviorOf, phaseRulesOf } from '../autonomy.js'
import { readFileSync } from 'node:fs'
import { makeFixture } from './dev-v4-support.mjs'

test('Dev-AutoGuard: V4 has no L0–L4 fields and defaults to full auto', () => {
  const f = makeFixture()
  try {
    const project = f.store.getProject(f.project.id)
    assert.equal('autonomy' in project, false)
    assert.equal('autoDispatch' in project, false)
    assert.deepEqual(project.phaseRules, DEFAULT_PHASE_RULES)
    assert.deepEqual(behaviorOf(), { intake: true, dispatch: true, approve: true, selfReview: true, remoteSync: true })
  } finally { f.cleanup() }
})

test('Dev-AutoGuard: advanced rules may only narrow a stage', () => {
  const f = makeFixture()
  try {
    assert.throws(() => f.store.updatePhaseRules(f.project.id, { plan: { widenWrite: true } }), /收窄|未知/)
    const next = f.store.updatePhaseRules(f.project.id, { plan: { autoApprove: false } })
    assert.equal(next.phaseRules.plan.autoApprove, false)
    assert.equal(next.phaseRules.build.autoStart, true)
    assert.deepEqual(phaseRulesOf(next), next.phaseRules)
  } finally { f.cleanup() }
})

test('Dev-AutoGuard: legacy autonomy is migrated out of persisted state', () => {
  const f = makeFixture()
  try {
    f.store._project(f.project.id).autonomy = 'manual'
    f.store._commit()
    const reloaded = new f.store.constructor({ file: f.store.file })
    const project = reloaded.getProject(f.project.id)
    assert.equal('autonomy' in project, false)
    assert.equal(project.phaseRules.plan.autoApprove, false, 'legacy manual maps to narrowed rules')
    reloaded.db.close()
  } finally { f.cleanup() }
})

test('Dev-AutoGuard: hook still strips Git env before nested repos', () => {
  const hook = readFileSync(new URL('../../../.husky/pre-commit', import.meta.url), 'utf8')
  assert.match(hook, /unset GIT_DIR/)
  assert.match(hook, /GIT_INDEX_FILE/)
  assert.match(hook, /GIT_WORK_TREE/)
})

test('Dev-AutoGuard: no L4-only delivery route survives in the API surface', () => {
  const api = readFileSync(new URL('../api.js', import.meta.url), 'utf8')
  assert.doesNotMatch(api, /retry-auto-delivery/, 'L4 retry route removed')
  assert.match(api, /remote-sync/, 'merge→done sync remains')
})

test('Dev-AutoGuard: the new stage tools are present and gated', () => {
  const tools = readFileSync(new URL('../tools.js', import.meta.url), 'utf8')
  for (const name of ['factory_push_branch', 'factory_self_review_verdict', 'factory_open_draft_pr']) {
    assert.match(tools, new RegExp(`name: '${name}'`))
  }
  assert.match(tools, /approved 自审结论/)
})

test('Dev-AutoGuard: done is syncRule-only, not a stage tool', () => {
  const state = readFileSync(new URL('../state.js', import.meta.url), 'utf8')
  assert.match(state, /SYNC_AUTO_EDGES = Object\.freeze\(\['pr-review->done'\]\)/)
  assert.doesNotMatch(state, /'pr-review->done': \[/)
})
