/**
 * Dev self-check — V4 upstream-order core:
 * build commit/push → independent self-review → approved-head draft PR →
 * pr-review → PR merged → done (syncRule only).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { EDGE_ACTORS, STATUS, STATUSES, SYNC_AUTO_EDGES, assertTransition, canTransition } from '../state.js'
import { applyRemoteSync, deriveRemoteTarget, resolveSync } from '../sync.js'
import { FactoryStore } from '../store.js'
import { factoryToolSpecs } from '../tools.js'
import { DEFAULT_PHASE_RULES, phaseRulesOf, runTick, createEngineStatus } from '../autonomy.js'

const HEAD = 'a'.repeat(40)
const SHA = 'b'.repeat(40)

function setup({ status = 'build', phaseRules } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'dev-v4-core-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: '/repo', ...(phaseRules ? { phaseRules } : {}) })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  const card = store.createCard({ boardId: board.id, title: 'Ship it' })
  store.setWorktree(card.id, { worktreePath: '/worktree', branch: 'factory/card', baseBranch: 'main', sessionId: 'builder-session' })
  const path = ['inbox', 'triage', 'plan', 'build', 'self-review', 'pr-review']
  const actors = { triage: 'human', plan: 'agent', build: 'agent', 'self-review': 'agent', 'pr-review': 'agent' }
  for (const to of path.slice(1, path.indexOf(status) + 1)) store.transitionCard(card.id, to, actors[to])
  return { store, project, card: store.getCard(card.id), cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

function toolsFor(f, ports = {}) {
  const calls = []
  const gitPort = {
    changedPaths: (cwd) => { calls.push(['changedPaths', cwd]); return ['README.md'] },
    add: (cwd, paths) => calls.push(['add', paths]),
    commit: (cwd, message, paths) => { calls.push(['commit', message, paths]); return SHA },
    push: (cwd, branch) => calls.push(['push', branch]),
    createPr: (cwd, input) => { calls.push(['createPr', input]); return 'https://example/pr/1' },
    hasDiff: (cwd, base) => { calls.push(['hasDiff', base]); return true },
    headOf: () => HEAD,
    ...ports.gitPort,
  }
  const specs = factoryToolSpecs({
    store: f.store,
    receiptPorts: { validateSchema: () => true },
    readHead: () => HEAD,
    buildGitPortFor: async () => gitPort,
    isSessionActive: async () => false,
    ...ports,
  })
  const find = (name) => {
    const spec = specs.find((entry) => entry.name === name)
    assert.ok(spec, `${name} is registered`)
    return spec
  }
  return { calls, gitPort, find, builder: { agent: { id: 'builder-session' } }, reviewer: { agent: { id: 'reviewer-session' } } }
}

test('V4-Core: state machine has independent self-review and pr-review, done only by sync', () => {
  assert.equal(STATUS.SELF_REVIEW, 'self-review')
  assert.equal(STATUS.PR_REVIEW, 'pr-review')
  assert.ok(STATUSES.includes('self-review') && STATUSES.includes('pr-review'))
  assert.ok(!STATUSES.includes('plan-review') && !STATUSES.includes('review'))
  assert.deepEqual(EDGE_ACTORS['build->self-review'], ['agent'])
  assert.ok((EDGE_ACTORS['self-review->build'] || []).includes('agent'))
  assert.ok((EDGE_ACTORS['self-review->pr-review'] || []).includes('agent'))
  assert.equal(Object.prototype.hasOwnProperty.call(EDGE_ACTORS, 'pr-review->done'), false)
  assert.ok(SYNC_AUTO_EDGES.includes('pr-review->done'))
  assert.equal(canTransition('pr-review', 'done', 'human'), false)
  assert.equal(assertTransition('pr-review', 'done', 'syncRule'), true)
})

test('V4-Core: new projects start full-auto with phase rules and no autonomy fields', () => {
  const f = setup()
  try {
    assert.equal('autonomy' in f.project, false)
    assert.equal('autoDispatch' in f.project, false)
    assert.deepEqual(f.project.phaseRules, DEFAULT_PHASE_RULES)
    assert.deepEqual(phaseRulesOf(f.store.getProject(f.project.id)), DEFAULT_PHASE_RULES)
    assert.throws(() => f.store.updatePhaseRules(f.project.id, { plan: { autoApprove: false, widenWrite: true } }), /收窄|未知/)
  } finally { f.cleanup() }
})

test('V4-Core: remote MERGED only auto-completes a pr-review card via syncRule', () => {
  const f = setup({ status: 'pr-review' })
  try {
    f.store.setPrUrl(f.card.id, 'https://example/pr/1', 'agent')
    assert.deepEqual(deriveRemoteTarget({ pr: { state: 'MERGED' } }), { target: 'done', reason: 'PR merged' })
    const suggestion = resolveSync(f.store.getCard(f.card.id), { pr: { state: 'MERGED' } })
    assert.equal(suggestion.suggestion.autoApplicable, true)
  } finally { f.cleanup() }
})

test('V4-Core: build commits and pushes the frozen dirty paths, but opens no PR', async () => {
  const f = setup()
  try {
    const t = toolsFor(f)
    const out = await t.find('factory_push_branch').execute({
      cardId: f.card.id, message: 'fix: ship it',
    }, t.builder)
    assert.equal(out.sha, SHA)
    assert.equal(out.prUrl, '')
    assert.deepEqual(t.calls.map((call) => call[0]), ['changedPaths', 'hasDiff', 'add', 'commit', 'push'])
    const card = f.store.getCard(f.card.id)
    assert.equal(card.commitSha, SHA)
    assert.equal(card.prUrl, null)
    assert.equal(card.deliverySource, 'build-session')
  } finally { f.cleanup() }
})

test('V4-Core: reviewer records approved head and opens a draft PR from that exact head', async () => {
  const f = setup({ status: 'self-review' })
  try {
    f.store.recordCommit(f.card.id, { sha: HEAD, message: 'build commit', actor: 'agent' })
    f.store.setReviewSession(f.card.id, 'reviewer-session', 'created')
    const t = toolsFor(f)
    const verdict = await t.find('factory_self_review_verdict').execute({
      cardId: f.card.id, head: HEAD, verdict: 'approved',
      blocking: [], followUps: [], checks: [{ name: 'test', result: 'pass' }],
    }, t.reviewer)
    assert.equal(verdict.verdict, 'approved')
    const out = await t.find('factory_open_draft_pr').execute({
      cardId: f.card.id, title: 'T', body: 'B',
    }, t.reviewer)
    assert.equal(out.url, 'https://example/pr/1')
    assert.deepEqual(t.calls.map((call) => call[0]), ['createPr'])
    const card = f.store.getCard(f.card.id)
    assert.equal(card.prUrl, 'https://example/pr/1')
    assert.equal(card.prHead, HEAD)
    assert.equal(card.selfReview.verdict, 'approved')
  } finally { f.cleanup() }
})

test('V4-Core: opening a PR refuses a stale head or a builder session', async () => {
  const f = setup({ status: 'self-review' })
  try {
    f.store.recordCommit(f.card.id, { sha: HEAD, message: 'build commit', actor: 'agent' })
    f.store.setReviewSession(f.card.id, 'reviewer-session', 'created')
    const t = toolsFor(f)
    await t.find('factory_self_review_verdict').execute({
      cardId: f.card.id, head: HEAD, verdict: 'approved', blocking: [], followUps: [], checks: [],
    }, t.reviewer)
    await assert.rejects(
      () => t.find('factory_open_draft_pr').execute({ cardId: f.card.id, title: 'T', body: 'B' }, t.builder),
      /评审会话/,
    )
    const stale = toolsFor(f, { readHead: () => 'c'.repeat(40) })
    await assert.rejects(
      () => stale.find('factory_open_draft_pr').execute({ cardId: f.card.id, title: 'T', body: 'B' }, t.reviewer),
      /head/,
    )
    assert.deepEqual(t.calls, [], 'all refusals happen before git/gh writes')
  } finally { f.cleanup() }
})

test('V4-Core: request changes records findings and returns to build with a visible round', () => {
  const f = setup({ status: 'self-review' })
  try {
    f.store.setReviewSession(f.card.id, 'reviewer-session', 'created')
    const review = f.store.appendReportWithVerdict(f.card.id, 'needs work', {
      cardId: f.card.id, source: 'review', verdict: 'changes-requested', reviewedHead: HEAD,
      blocking: [{ file: 'a.js', line: 1, reason: 'bug' }], followUps: [], checks: [], reviewerSessionId: 'reviewer-session',
    }, 'agent')
    assert.equal(review.verdict.verdict, 'changes-requested')
    f.store.transitionCard(f.card.id, 'build', 'agent', 'findings')
    const card = f.store.getCard(f.card.id)
    assert.equal(card.status, 'build')
    assert.equal(card.selfReviewRounds, 0, 'plain report does not consume a self-review round')
  } finally { f.cleanup() }
})

test('V4-Core: a merged ACTIVE PR auto-completes once via syncRule', () => {
  const f = setup({ status: 'pr-review' })
  try {
    f.store.setPrUrl(f.card.id, 'https://example/pr/1', 'agent')
    const first = applyRemoteSync({ store: f.store, cardId: f.card.id, remote: { pr: { state: 'MERGED' } } })
    assert.deepEqual(first, { changed: true, target: 'done' })
    assert.equal(f.store.getCard(f.card.id).status, 'done')
    const second = applyRemoteSync({ store: f.store, cardId: f.card.id, remote: { pr: { state: 'MERGED' } } })
    assert.deepEqual(second, { changed: false })
  } finally { f.cleanup() }
})

test('V4-Core: tick polls only the active PR and feeds remote-sync', async () => {
  const f = setup({ status: 'pr-review' })
  try {
    f.store.setPrUrl(f.card.id, 'https://example/pr/active', 'agent')
    const seen = []
    const status = createEngineStatus()
    const deps = {
      ghPortFor: async () => ({ prState: async ({ prUrl }) => { seen.push(prUrl); return 'MERGED' } }),
      remoteSync: applyRemoteSync,
      isSessionActive: async () => false,
      intake: async () => ({ created: [] }),
      dispatch: async () => ({ mode: 'none' }),
      approve: async () => ({ approved: false }),
      continue: async () => ({}),
      reviewDispatch: async () => ({}),
    }
    await runTick({ store: f.store, status, deps, config: { tickMs: 60000 } })
    assert.deepEqual(seen, ['https://example/pr/active'])
    assert.equal(f.store.getCard(f.card.id).status, 'done')
  } finally { f.cleanup() }
})

test('V4-Core: entering pr-review closes a draft PR whose approved head drifted', async () => {
  const f = setup({ status: 'self-review' })
  try {
    f.store.recordCommit(f.card.id, { sha: HEAD, message: 'build commit', actor: 'agent' })
    f.store.setReviewSession(f.card.id, 'reviewer-session', 'created')
    const closed = []
    const t = toolsFor(f, { closePrFor: async (card) => closed.push(card.prUrl) })
    await t.find('factory_self_review_verdict').execute({ cardId: f.card.id, head: HEAD, verdict: 'approved', blocking: [], followUps: [], checks: [] }, t.reviewer)
    await t.find('factory_open_draft_pr').execute({ cardId: f.card.id, title: 'T', body: 'B' }, t.reviewer)
    f.store._card(f.card.id).prHead = 'd'.repeat(40)
    await assert.rejects(
      () => t.find('factory_transition_work_item').execute({ cardId: f.card.id, to: 'pr-review' }, t.reviewer),
      /漂移|drift/,
    )
    assert.deepEqual(closed, ['https://example/pr/1'])
  } finally { f.cleanup() }
})
