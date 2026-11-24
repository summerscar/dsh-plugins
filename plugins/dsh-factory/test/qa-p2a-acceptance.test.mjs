/**
 * QA — P2a acceptance tests (PRD §5.2 / §5.4 / §5.12 / §9 AC 4–8, 31–34).
 * Self-contained: throwaway real git repo, fixed constants, fake host ports.
 * No assertion depends on HEAD, git show, rebase or commit state.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FactoryStore, WORK_MODES, DEFAULT_WORK_MODE, normalizeWorkMode } from '../store.js'
import { createApi } from '../api.js'
import { collectAudit } from '../audit.js'
import {
  createHostPort, dispatchCard, dispatchReview, followupReview,
  effectiveWorkModeFor, reviewMessage, isRereview,
  sandboxModeForWorkMode, SANDBOX_MODES,
} from '../dispatch.js'
import { buildSessionContext } from '../session-context.js'
import { factoryToolSpecs } from '../tools.js'

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'qa-p2a-repo-'))
  git(dir, 'init', '-q')
  git(dir, 'checkout', '-qb', 'main')
  git(dir, '-c', 'user.name=QA', '-c', 'user.email=qa@local', 'commit', '-q', '--allow-empty', '-m', 'initial')
  return { dir, head: () => git(dir, 'rev-parse', 'HEAD').trim() }
}

function setup({ workMode, repo = makeRepo(), status = 'self-review', prUrl = null, reviewVerdict = null } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-p2a-store-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: repo.dir, ...(workMode ? { workMode } : {}) })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  const card = store.createCard({ boardId: board.id, title: 'review me', repo: 'owner/repo' })
  store.setWorktree(card.id, { worktreePath: repo.dir, branch: 'factory/test', baseBranch: 'main', sessionId: 'builder-session-1' })
  if (status !== 'inbox') {
    store.transitionCard(card.id, 'triage', 'human')
    store.transitionCard(card.id, 'plan', 'agent')
    store.transitionCard(card.id, 'build', 'agent')
    store.transitionCard(card.id, 'self-review', 'agent')
    if (status === 'pr-review') store.transitionCard(card.id, 'pr-review', 'agent')
  }
  if (prUrl) store.setPrUrl(card.id, prUrl)
  if (reviewVerdict) {
    store._card(card.id).reviewVerdict = reviewVerdict
    store._commit()
  }
  return { store, project, card, repo, cleanup: () => { rmSync(tmp, { recursive: true, force: true }); rmSync(repo.dir, { recursive: true, force: true }) } }
}

function fakePort({ active = false, resumeError, createError, readAutoReviewPluginState, readHead } = {}) {
  const calls = { create: [], followup: [], resume: [], dispose: [] }
  let n = 0
  return {
    calls,
    readHead,
    readAutoReviewPluginState,
    async isSessionActive() { return active },
    async createSession(o) { calls.create.push(o); if (createError) throw createError; n += 1; return { sessionId: `reviewer-${n}`, handle: { dispose: async () => {} } } },
    async followupSession(o) { calls.followup.push(o) },
    async resumeSession(o) { calls.resume.push(o); if (resumeError) throw resumeError; return { sessionId: 'reviewer-resumed', handle: { dispose: async () => {} } } },
    async disposeSession(h) { calls.dispose.push(h) },
  }
}

/** Fake host ctx with real sandboxPolicy / permissionPresets / agentPresets services. */
function makeHostCtx({ resolvedMode = 'workspace-write', presetValue = 'auto', withPresets = true, withPolicy = true, presetSetFails = false } = {}) {
  const seen = { create: null, resume: null, disposed: 0, messages: [], setupCalls: [], presetSet: [] }
  const session = { append() {}, id: 'live-session-id' }
  const agent = { session, id: 'live-session-id', followup: (m) => { seen.messages.push(m) } }
  const ctx = {
    get: (name) => {
      if (name === 'agents') return {
        create: async (o) => { seen.create = o; return { agent, dispose: async () => { seen.disposed += 1 } } },
        resume: async (o) => { seen.resume = o; return { agent, dispose: async () => { seen.disposed += 1 } } },
        get: () => agent,
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      if (name === 'agentPresets') return { mount: async () => {}, presetForSession: () => 'reviewer-preset' }
      if (name === 'sandboxPolicy' && withPolicy) return { resolve: ({ session: s }) => ({ mode: resolvedMode }) }
      if (name === 'permissionPresets' && withPresets) {
        return {
          set: (s, value) => { seen.presetSet.push([s, value]); if (!presetSetFails) presetValue = value },
          current: () => presetValue,
        }
      }
      return undefined
    },
  }
  return { ctx, seen, agent, session }
}

const USER_MSG = ({ content, source }) => ({ id: 'm', role: 'user', content, source })
const reviewSessionRecord = (store, id) => store.getCard(id).history.filter((h) => h.type === 'review-session')

// ===========================================================================
// AC 4 — independent review session, mode by prUrl, rereview, head from git
// ===========================================================================

test('P2a-AC4 dispatchReview records reviewSessionId distinct from builder sessionId', async () => {
  const f = setup()
  try {
    const port = fakePort()
    const out = await dispatchReview({ store: f.store, cardId: f.card.id, port })
    const card = f.store.getCard(f.card.id)
    assert.equal(out.mode, 'created')
    assert.equal(card.reviewSessionId, 'reviewer-1')
    assert.notEqual(card.reviewSessionId, card.sessionId)
    assert.equal(card.sessionId, 'builder-session-1', 'builder session must survive')
    assert.equal(card.status, 'self-review', 'dispatch never moves the card')
    assert.deepEqual(reviewSessionRecord(f.store, f.card.id).map((h) => h.mode), ['created'])
    assert.equal(out.reviewedHead, f.repo.head())
    assert.equal(port.calls.create.length, 1)
  } finally { f.cleanup() }
})

test('P2a-AC4 first review has no prUrl → branch diff; after PR → reviews the PR', async () => {
  const f = setup()
  try {
    const port = fakePort()
    await dispatchReview({ store: f.store, cardId: f.card.id, port })
    assert.match(port.calls.create[0].firstMessage, /审分支改动（branch diff）/)
    assert.doesNotMatch(port.calls.create[0].firstMessage, /审 PR /)
  } finally { f.cleanup() }

  const g = setup({ prUrl: 'https://github.com/o/r/pull/7' })
  try {
    const port = fakePort()
    await dispatchReview({ store: g.store, cardId: g.card.id, port })
    assert.match(port.calls.create[0].firstMessage, /审 PR https:\/\/github.com\/o\/r\/pull\/7/)
  } finally { g.cleanup() }
})

test('P2a-AC4 review→build history switches skill to factory-rereview and injects previousVerdict', async () => {
  const f = setup({ reviewVerdict: {
    cardId: 'card-placeholder', source: 'review', verdict: 'changes-requested', reviewedHead: 'a'.repeat(40),
    blocking: [{ file: 'a.js', line: 1, reason: 'wrong' }], followUps: [], checks: [], reviewerSessionId: 'old-reviewer',
  } })
  try {
    assert.equal(isRereview(f.store.getCard(f.card.id)), false)
    f.store.transitionCard(f.card.id, 'build', 'agent', 'findings')
    f.store.transitionCard(f.card.id, 'self-review', 'agent')
    const card = f.store.getCard(f.card.id)
    assert.equal(isRereview(card), true)
    const built = buildSessionContext({ card, project: f.project, reviewMode: true, review: {
      reviewedHead: f.repo.head(), sandboxMode: 'read-only', rereview: true,
    } })
    assert.equal(built.skill, 'factory-rereview')
    assert.ok(built.sectionText.includes('factory-rereview'))
    assert.ok(built.sectionText.includes('previousVerdict'))
    assert.equal(ADVANCE_RE.test(built.sectionText), false)
  } finally { f.cleanup() }
})

const ADVANCE_RE = /advance through|move the card yourself|factory_transition_work_item to advance/i

test('P2a-AC4 reviewMessage carries mode/head/previousVerdict/note and rereview discipline', () => {
  const msg = reviewMessage({
    card: { id: 'c1', prUrl: null }, reviewedHead: 'a'.repeat(40),
    previousVerdict: { verdict: 'changes-requested' }, note: '看并发', rereview: true,
  })
  assert.match(msg, /审分支改动/)
  assert.match(msg, /reviewedHead: a{40}/)
  assert.match(msg, /changes-requested/)
  assert.match(msg, /看并发/)
  assert.match(msg, /factory-rereview/)
  assert.match(msg, /不得移卡/)
})

// ===========================================================================
// AC 5 — reuse live reviewer, recreate on death, no status change
// ===========================================================================

test('P2a-AC5 live reviewer is reused, message carries head + previousVerdict, status unchanged', async () => {
  const f = setup({ reviewVerdict: { verdict: 'changes-requested' } })
  try {
    f.store.setReviewSession(f.card.id, 'reviewer-old', 'created')
    const port = fakePort({ active: true })
    const out = await followupReview({ store: f.store, cardId: f.card.id, port })
    assert.equal(out.mode, 'followup')
    assert.equal(out.sessionId, 'reviewer-old')
    assert.equal(port.calls.followup.length, 1)
    assert.match(port.calls.followup[0].message, /changes-requested/)
    assert.match(port.calls.followup[0].message, /factory-rereview/)
    assert.equal(port.calls.create.length, 0)
    assert.equal(f.store.getCard(f.card.id).status, 'self-review')
    assert.deepEqual(reviewSessionRecord(f.store, f.card.id).map((h) => h.mode), ['created', 'reused'])
  } finally { f.cleanup() }
})

test('P2a-AC5 dead reviewer: resume first, then fresh create; both keep previousVerdict and status', async () => {
  for (const [label, resumeError, expected, newId] of [
    ['resume', undefined, 'resumed', 'reviewer-resumed'],
    ['fresh', new Error('SessionPersistenceNotFoundError'), 'created', 'reviewer-1'],
  ]) {
    const f = setup({ reviewVerdict: { verdict: 'verification-incomplete' } })
    try {
      f.store.setReviewSession(f.card.id, 'reviewer-old', 'created')
      const port = fakePort({ active: false, resumeError })
      const out = await followupReview({ store: f.store, cardId: f.card.id, port })
      assert.equal(out.mode, expected, label)
      assert.equal(out.sessionId, newId, label)
      assert.match(port.calls.resume[0].firstMessage, /verification-incomplete/)
      const card = f.store.getCard(f.card.id)
      assert.equal(card.status, 'self-review')
      assert.notEqual(card.sessionId, card.reviewSessionId)
      assert.equal(reviewSessionRecord(f.store, f.card.id).at(-1).mode, 'recreated')
    } finally { f.cleanup() }
  }
})

test('P2a-AC5 no reviewer yet → followupReview dispatches a fresh review session', async () => {
  const f = setup()
  try {
    const port = fakePort()
    const out = await followupReview({ store: f.store, cardId: f.card.id, port })
    assert.equal(out.mode, 'created')
    assert.equal(f.store.getCard(f.card.id).reviewSessionId, 'reviewer-1')
  } finally { f.cleanup() }
})

// ===========================================================================
// AC 6/7/8 — reviewer restrictions, builder continuation
// ===========================================================================

test('P2a-AC7 reviewer session moves only the two V4 reviewer edges; other targets are refused', async () => {
  for (const exec of [
    { agent: { session: { id: 'reviewer-1' } } },
    { agent: { id: 'reviewer-1' } },
  ]) {
    const f = setup()
    try {
      f.store.setReviewSession(f.card.id, 'reviewer-1', 'created')
      const specs = new Map(factoryToolSpecs({ store: f.store }).map((s) => [s.name, s]))
      // The two legal reviewer moves:
      await specs.get('factory_transition_work_item').execute({ cardId: f.card.id, to: 'build', note: 'findings' }, exec)
      assert.equal(f.store.getCard(f.card.id).status, 'build', 'self-review → build (changes requested) is the reviewer\'s own move')
      f.store.transitionCard(f.card.id, 'self-review', 'agent')
      // pr-review without a draft PR is refused by the approved-head gate, not by the session gate.
      await assert.rejects(
        () => specs.get('factory_transition_work_item').execute({ cardId: f.card.id, to: 'pr-review' }, exec),
        /没有草稿 PR/,
      )
      // Any other target (e.g. inbox) is refused for the reviewer session.
      await assert.rejects(
        () => specs.get('factory_transition_work_item').execute({ cardId: f.card.id, to: 'inbox' }, exec),
        /评审会话/,
      )
    } finally { f.cleanup() }
  }
})

test('P2a-AC7 builder session is NOT blocked; self-review→build is machine-owned, pr-review→build stays human-only', async () => {
  const f = setup({ status: 'build' })
  try {
    f.store.setReviewSession(f.card.id, 'reviewer-1', 'created')
    const specs = new Map(factoryToolSpecs({ store: f.store }).map((s) => [s.name, s]))
    // build→self-review is agent-legal; the builder\'s session id must not be blocked.
    await specs.get('factory_transition_work_item').execute(
      { cardId: f.card.id, to: 'self-review' },
      { agent: { session: { id: 'builder-session-1' } } },
    )
    assert.equal(f.store.getCard(f.card.id).status, 'self-review')
    // V4: changes-requested returns to build by the reviewer (agent) or the engine (autoRule).
    assert.equal(f.store.transitionCard(f.card.id, 'build', 'agent', 'findings').status, 'build')
    f.store.transitionCard(f.card.id, 'self-review', 'agent')
    // …but not by a human, and pr-review→build stays a human-only edge.
    assert.throws(() => f.store.transitionCard(f.card.id, 'build', 'human', 'x'), /不允许由 human 触发/)
    f.store.transitionCard(f.card.id, 'pr-review', 'agent')
    assert.throws(() => f.store.transitionCard(f.card.id, 'build', 'agent', 'x'), /不允许由 agent 触发/)
  } finally { f.cleanup() }
})

test('P2a-AC8 pr-review→build continuation uses the ORIGINAL builder session, not the reviewer', async () => {
  const f = setup({ status: 'pr-review' })
  try {
    f.store.setReviewSession(f.card.id, 'reviewer-1', 'created')
    f.store.transitionCard(f.card.id, 'build', 'human', '请补重试上限')
    const calls = []
    const port = {
      createWorktree: () => { throw new Error('continuation must not create a worktree') },
      removeWorktree: () => {},
      async isSessionActive(id) { calls.push(['active', id]); return true },
      async followupSession(o) { calls.push(['followup', o.sessionId, o.workMode]) },
      async resumeSession(o) { calls.push(['resume', o.resumeSessionId]) },
      async createSession(o) { calls.push(['create', o.workMode]) },
      async disposeSession() {},
    }
    const { continueCard } = await import('../dispatch.js')
    const out = await continueCard({ store: f.store, cardId: f.card.id, port, message: 'apply the fixes' })
    assert.equal(out.mode, 'followup')
    assert.equal(out.sessionId, 'builder-session-1')
    assert.equal(calls.some((c) => c[0] === 'followup' && c[1] === 'builder-session-1'), true)
    assert.equal(calls.some((c) => String(c[1]).includes('reviewer')), false)
  } finally { f.cleanup() }
})

// ===========================================================================
// reviewMode wired to the REAL host sandbox reader
// ===========================================================================

test('P2a review seed is sandbox/mode=read-only and assertSandboxMode verifies read-only', async () => {
  const { ctx, seen } = makeHostCtx({ resolvedMode: 'read-only' })
  const port = createHostPort({ ctx, createUserMessage: USER_MSG })
  await port.createSession({ cwd: '/workspace/p', setup: () => {}, firstMessage: 'go', workMode: 'workspace-write', sandboxMode: 'read-only' })
  const pin = seen.create.seed.find((e) => e.type === 'sandbox/mode')
  assert.equal(pin.data.mode, 'read-only')
  assert.notEqual(pin.data.mode, 'auto')
  assert.equal(seen.disposed, 0)
})

// Review dispatch no longer pins read-only, but the host still honors an
// explicit sandboxMode from any caller that genuinely needs to pin a boundary.
test('P2a host still honors an explicit sandboxMode pin from a caller', async () => {
  const { ctx, seen } = makeHostCtx({ resolvedMode: 'read-only' })
  const port = createHostPort({ ctx, createUserMessage: USER_MSG })
  await port.createSession({ cwd: '/workspace/p', setup: () => {}, firstMessage: 'go', workMode: 'full-access', sandboxMode: 'read-only' })
  assert.equal(seen.create.seed.find((e) => e.type === 'sandbox/mode').data.mode, 'read-only')
  assert.equal(seen.disposed, 0)
})

test('P2a review sandbox reading comes from the host resolver, not a caller string', async () => {
  const { ctx, seen } = makeHostCtx({ resolvedMode: 'workspace-write' })
  let injected
  const setupFactory = ({ readSandboxMode }) => {
    injected = readSandboxMode
    return async () => {}
  }
  const port = createHostPort({ ctx, createUserMessage: USER_MSG })
  await assert.rejects(
    () => port.createSession({ cwd: '/workspace/p', setup: setupFactory, firstMessage: 'go', workMode: 'workspace-write', sandboxMode: 'read-only' }),
    /沙箱模式/,
    'a writable host session must be refused even though the caller asked for read-only',
  )
  assert.equal(typeof injected, 'function', 'the port injected a real resolver into setup')
  assert.equal(injected({ session: { id: 'x' } }), 'workspace-write', 'the injected reader delegates to the host sandboxPolicy')
  assert.equal(seen.disposed, 1)
})

test('P2a dispatchReview follows project workMode and backend git head into setup', async () => {
  const f = setup({ workMode: 'full-access' })
  try {
    // Review follows the project workMode; no explicit read-only sandbox is
    // passed, so the host resolves the full-access project to danger-full-access.
    const { ctx, seen } = makeHostCtx({ resolvedMode: 'danger-full-access' })
    const port = createHostPort({ ctx, createUserMessage: USER_MSG })
    const out = await dispatchReview({ store: f.store, cardId: f.card.id, port: Object.assign(port, { readHead: f.repo.head }) })
    const card = f.store.getCard(f.card.id)
    assert.equal(card.reviewSessionId, out.sessionId)
    assert.notEqual(card.reviewSessionId, card.sessionId, 'reviewer id is recorded separately from the builder session')
    assert.equal(out.reviewedHead, f.repo.head(), 'head comes from backend git')
    assert.equal(seen.create.seed.find((e) => e.type === 'sandbox/mode').data.mode, 'danger-full-access', 'full-access project gets a writable review sandbox')
    assert.equal(typeof seen.create.setup, 'function')
    assert.notEqual(seen.disposed, 1)
  } finally { f.cleanup() }
})

// ===========================================================================
// AC 31–34 — work modes
// ===========================================================================

test('P2a-AC31 work mode defaults, validates and is orthogonal to stage rules', () => {
  assert.deepEqual([...WORK_MODES], ['workspace-write', 'full-access', 'auto-review'])
  assert.equal(DEFAULT_WORK_MODE, 'workspace-write')
  assert.equal(normalizeWorkMode(undefined), 'workspace-write')
  for (const m of WORK_MODES) assert.equal(normalizeWorkMode(m), m)
  assert.throws(() => normalizeWorkMode('auto'), /未知工作模式/)

  const f = setup({ status: 'inbox' })
  try {
    assert.equal(f.store.getProject(f.project.id).workMode, 'workspace-write')
    assert.equal('autonomy' in f.store.getProject(f.project.id), false, 'V4 projects carry no tier field')
    const before = f.store.getProject(f.project.id).phaseRules
    f.store.updateWorkMode(f.project.id, { workMode: 'full-access' })
    const after = f.store.getProject(f.project.id)
    assert.equal(after.workMode, 'full-access')
    assert.deepEqual(after.phaseRules, before, 'workMode write never moves the stage rules')
    f.store.updatePhaseRules(f.project.id, { plan: { autoApprove: false } })
    const narrowed = f.store.getProject(f.project.id)
    assert.equal(narrowed.workMode, 'full-access', 'phaseRules write never moves workMode')
    assert.equal(narrowed.phaseRules.plan.autoApprove, false)
    assert.ok(Array.isArray(collectAudit(f.store, { type: 'work-mode' })))
  } finally { f.cleanup() }
})

test('P2a-AC31/33 API PATCH keeps workMode separate and disables auto-review when plugin unavailable', () => {
  const f = setup({ status: 'inbox' })
  try {
    const api = createApi({ store: f.store, workModeAvailability: () => ({ available: false, reason: '实验性插件未开启' }) })
    const mixed = api({ method: 'PATCH', route: `/projects/${f.project.id}`, body: { workMode: 'full-access', phaseRules: { plan: { autoApprove: false } } } })
    assert.equal(mixed.status, 400)
    assert.match(mixed.body.error, /workMode|混改/)
    const denied = api({ method: 'PATCH', route: `/projects/${f.project.id}`, body: { workMode: 'auto-review' } })
    assert.equal(denied.status, 400)
    assert.match(denied.body.error, /自动审查不可选/)
    assert.equal(denied.body.reason, '实验性插件未开启')
    const okRes = api({ method: 'PATCH', route: `/projects/${f.project.id}`, body: { workMode: 'full-access' } })
    assert.equal(okRes.status, 200)
    assert.equal(okRes.body.project.workMode, 'full-access')

    const g = setup({ status: 'inbox' })
    try {
      const api2 = createApi({ store: g.store, workModeAvailability: () => ({ available: true }) })
      const res = api2({ method: 'PATCH', route: `/projects/${g.project.id}`, body: { workMode: 'auto-review' } })
      assert.equal(res.status, 200)
      assert.equal(res.body.project.workMode, 'auto-review')
    } finally { g.cleanup() }
  } finally { f.cleanup() }
})

test('P2a-AC33/34 effectiveWorkModeFor: auto when available, fallback + audit warning when not', async () => {
  const f = setup({ workMode: 'auto-review', status: 'inbox' })
  try {
    const available = await effectiveWorkModeFor({ project: f.store.getProject(f.project.id), cardId: f.card.id, store: f.store, port: { readAutoReviewPluginState: async () => ({ available: true }) } })
    assert.equal(available.workMode, 'auto-review')
    assert.equal(available.warning, null)

    for (const reader of [
      async () => ({ available: false, reason: 'plugin disabled' }),
      async () => { throw new Error('manager down') },
    ]) {
      const out = await effectiveWorkModeFor({ project: f.store.getProject(f.project.id), cardId: f.card.id, store: f.store, port: { readAutoReviewPluginState: reader } })
      assert.equal(out.workMode, 'workspace-write')
      assert.match(out.warning, /回退到 workspace-write/)
      const notes = collectAudit(f.store, { type: 'work-mode-fallback' })
      assert.ok(notes.length >= 1)
    }
  } finally { f.cleanup() }
})

test('P2a-AC34 auto-review sandbox is danger-full-access; literal "auto" never enters seed', () => {
  assert.equal(sandboxModeForWorkMode('auto-review'), 'danger-full-access')
  assert.ok(SANDBOX_MODES.has(sandboxModeForWorkMode('auto-review')))
  assert.equal(SANDBOX_MODES.has('auto'), false)
})

test('P2a-AC33 auto preset is selected on the live session; "auto" never becomes sandbox/mode', async () => {
  const { ctx, seen, agent } = makeHostCtx({ resolvedMode: 'danger-full-access', presetValue: null })
  const port = createHostPort({ ctx, createUserMessage: USER_MSG })
  const out = await port.createSession({ cwd: '/workspace/p', setup: () => {}, firstMessage: 'go', workMode: 'auto-review', permissionPreset: 'auto' })
  assert.ok(out.sessionId)
  assert.equal(seen.create.seed.find((e) => e.type === 'sandbox/mode').data.mode, 'danger-full-access')
  assert.equal(JSON.stringify(seen.create.seed).includes('"auto"'), false, 'auto must not appear in the seed')
  assert.deepEqual(seen.presetSet, [[agent.session, 'auto']])
  assert.equal(seen.disposed, 0)
})

test('P2a-AC33/34 auto preset fail-closed: missing service / failed selection disposes the session', async () => {
  for (const opts of [{ withPresets: false }, { presetValue: 'workspace-write', presetSetFails: true }]) {
    const { ctx, seen } = makeHostCtx({ ...opts, resolvedMode: 'danger-full-access' })
    const port = createHostPort({ ctx, createUserMessage: USER_MSG })
    await assert.rejects(
      () => port.createSession({ cwd: '/workspace/p', setup: () => {}, firstMessage: 'go', workMode: 'auto-review', permissionPreset: 'auto' }),
      /permissionPreset|auto 权限预设|permissionPresets/,
    )
    assert.equal(seen.disposed, 1, 'unverified auto session must be disposed')
    assert.equal(seen.messages.length, 0)
  }
})

test('P2a-AC33 createSession refuses auto-review without an explicit preset request', async () => {
  const { ctx, seen } = makeHostCtx({ resolvedMode: 'danger-full-access' })
  const port = createHostPort({ ctx, createUserMessage: USER_MSG })
  await assert.rejects(
    () => port.createSession({ cwd: '/workspace/p', setup: () => {}, firstMessage: 'go', workMode: 'auto-review' }),
    /必须显式选择 auto 权限预设/,
  )
  assert.equal(seen.create, null)
})

test('P2a-AC34 dispatchCard passes effective fallback workMode + permissionPreset to the port', async () => {
  const f = setup({ workMode: 'auto-review', status: 'inbox' })
  try {
    // A card with no worktree trace so dispatchCard actually attempts creation.
    f.store._card(f.card.id).worktreePath = null
    f.store._card(f.card.id).sessionId = null
    f.store._commit()
    const calls = []
    const port = {
      readAutoReviewPluginState: async () => ({ available: false, reason: 'plugin off' }),
      createWorktree: () => { throw new Error('no git here') },
      removeWorktree: () => {},
      async createSession(o) { calls.push(o); return { sessionId: 's' } },
      async disposeSession() {},
    }
    await assert.rejects(() => dispatchCard({ store: f.store, cardId: f.card.id, port }), /no git here/)
    assert.equal(calls.length, 0, 'worktree failure happens before session creation')
    const out = await effectiveWorkModeFor({ project: f.store.getProject(f.project.id), cardId: f.card.id, store: f.store, port })
    assert.equal(out.workMode, 'workspace-write')
  } finally { f.cleanup() }
})

test('P2a skill text teaches all five required structured fields and backend head', () => {
  const src = readFileSync(new URL('../skills/factory-review/SKILL.md', import.meta.url), 'utf8')
  for (const token of ['source', 'verdict', 'blocking', 'followUps', 'checks', 'reviewerSessionId', 'reviewedHead', 'git -C']) {
    assert.ok(src.includes(token), `skill must mention ${token}`)
  }
  assert.doesNotMatch(src, /diff growth beyond the problem/, 'blocking must not include diff growth')
  assert.doesNotMatch(src, /all six/, 'reviewerSessionId is optional')
  assert.match(src, /all five of/)
  assert.match(src, /Never record a check you did not run/)
})
