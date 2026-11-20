/**
 * QA — P0 acceptance tests (PRD .scratch/prd-review-and-auto-delivery.md
 * §5.12 / §8 / §9 P0-1..3 / §10).
 *
 * Self-contained by design: fixed host-mode constants, placeholder plugin
 * inventories and real API read-back. No assertion depends on HEAD, git show,
 * rebase or commit state, so the suite stays valid after this work is committed.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FactoryStore } from '../store.js'
import { createApi } from '../api.js'
import { createEngineStatus, resolvePermissionEnforcement, runTick } from '../autonomy.js'
import {
  createHostPort, dispatchCard, continueCard,
  sandboxModeForWorkMode, readAutoReviewPluginState,
  SANDBOX_MODES, WORK_MODES, DEFAULT_WORK_MODE, AUTO_REVIEW_PLUGIN_MODULE,
} from '../dispatch.js'

const USER_MSG = ({ content, source }) => ({ id: 'm', role: 'user', content, source })

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Fake host ctx with the three hard services: agents, agentDefaultModel,
 * sandboxPolicy. `resolvedMode` is what the host READS BACK from the session —
 * deliberately independent of the seed, so a profile override is detectable.
 */
function makeHostCtx({ resolvedMode = 'workspace-write', resolve, withSandbox = true, withModel = true, agentsGet } = {}) {
  const seen = { create: null, resume: null, disposed: 0, messages: [], resolves: [] }
  const session = { append() {} }
  const agent = { session, followup: (m) => { seen.messages.push(m) } }
  const policyResolve = typeof resolve === 'function' ? resolve : ({ session: s }) => {
    seen.resolves.push(s)
    return { mode: resolvedMode }
  }
  const ctx = {
    get: (name) => {
      if (name === 'agents') {
        return {
          create: async (options) => {
            seen.create = options
            return { agent, dispose: async () => { seen.disposed += 1 } }
          },
          resume: async (options) => {
            seen.resume = options
            return { agent, dispose: async () => { seen.disposed += 1 } }
          },
          get: (id) => (typeof agentsGet === 'function' ? agentsGet(id, agent) : agent),
        }
      }
      if (withModel && name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) }
      }
      if (withSandbox && name === 'sandboxPolicy') return { resolve: policyResolve }
      return undefined
    },
  }
  return { ctx, seen, session, agent }
}

const portFor = (ctx, createUserMessage = USER_MSG) => createHostPort({ ctx, createUserMessage })
const seedOf = (seen) => seen.create?.seed?.find((e) => e.type === 'sandbox/mode')

function setupStore(workMode) {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-p0-store-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: '/workspace/p' })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  const card = store.createCard({ boardId: board.id, title: 'c' })
  if (workMode !== undefined) {
    // store.js has no workMode field yet (P2 wires persistence). Inject at the
    // store boundary only — this is a test fixture, not a business-code change.
    const baseGetProject = store.getProject.bind(store)
    store.getProject = (id) => {
      const p = baseGetProject(id)
      return p && p.id === project.id ? { ...p, workMode } : p
    }
  }
  return { store, project, board, card, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

function setupEngine({ withResolver = false, mode = 'workspace-write', pluginInventory = undefined, resolverThrows = false } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-p0-engine-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: '/workspace/p' })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  const card = store.createCard({ boardId: board.id, title: 'c' })
  store.transitionCard(card.id, 'triage', 'human')
  store.setWorktree(card.id, { worktreePath: '/tmp/wt-c', branch: 'b', baseBranch: 'main', sessionId: 'sess-live' })
  const status = createEngineStatus()
  const deps = {
    ghPort: {},
    intake: async () => ({ created: [] }),
    dispatch: async () => ({ mode: 'none' }),
    isSessionActive: async (id) => id === 'sess-live',
    ...(withResolver
      ? { resolveSandboxMode: async (id) => { if (resolverThrows) throw new Error('host lost'); return id === 'sess-live' ? mode : null } }
      : {}),
    ...(pluginInventory !== undefined ? { readAutoReviewPluginState: async () => pluginInventory } : {}),
  }
  const api = createApi({ store, build: 'test', runtime: { engine: status, toolsRegistered: true } })
  return { store, project, card, status, deps, api, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

// ===========================================================================
// P0-1 — fixed sandbox gate removed, workMode → SandboxMode, verified on 4 paths
// ===========================================================================

test('P0-1 map: workMode→SandboxMode table is exact and unknown modes fail closed', () => {
  assert.equal(DEFAULT_WORK_MODE, 'workspace-write')
  assert.deepEqual([...SANDBOX_MODES].sort(), ['danger-full-access', 'read-only', 'workspace-write'])
  assert.deepEqual([...WORK_MODES].sort(), ['auto-review', 'full-access', 'workspace-write'])
  assert.equal(sandboxModeForWorkMode('workspace-write'), 'workspace-write')
  assert.equal(sandboxModeForWorkMode('full-access'), 'danger-full-access')
  assert.equal(sandboxModeForWorkMode('auto-review'), null, 'auto is a preset, never a SandboxMode')
  for (const empty of [undefined, null, '']) {
    assert.equal(sandboxModeForWorkMode(empty), DEFAULT_WORK_MODE, 'empty workMode defaults to workspace-write')
  }
  for (const bad of ['auto', 'danger-full-access', 'Write', 'workspace']) {
    assert.equal(sandboxModeForWorkMode(bad), null, `unknown workMode ${bad} must fail closed`)
  }
  const mapped = ['workspace-write', 'full-access'].map(sandboxModeForWorkMode)
  assert.ok(mapped.every((m) => SANDBOX_MODES.has(m)), 'every dispatchable mode is a host SandboxMode')
})

test('P0-1 create workspace-write: seed and read-back agree; profile/permission cannot override the seed', async () => {
  const { ctx, seen, session } = makeHostCtx({ resolvedMode: 'workspace-write' })
  const port = portFor(ctx)
  const created = await port.createSession({
    cwd: '/workspace/p', setup: () => {}, firstMessage: 'go',
    workMode: 'workspace-write', permission: 'danger-full-access',
  })
  assert.ok(created.sessionId)
  assert.equal(seedOf(seen)?.data?.mode, 'workspace-write', 'seed is the required mode')
  assert.equal(seedOf(seen).seq, 0)
  assert.strictEqual(seen.resolves[0], session, 'read-back resolves the very session that was seeded')
  assert.equal(seen.disposed, 0)
  assert.equal(seen.messages.length, 1)
})

test('P0-1 create full-access: seed and read-back both danger-full-access', async () => {
  const { ctx, seen } = makeHostCtx({ resolvedMode: 'danger-full-access' })
  const port = portFor(ctx)
  await port.createSession({ cwd: '/workspace/p', setup: () => {}, firstMessage: 'go', workMode: 'full-access' })
  assert.equal(seedOf(seen)?.data?.mode, 'danger-full-access')
  assert.equal(seen.disposed, 0, 'a matching read-back is accepted, not disposed')
  assert.equal(seen.messages.length, 1)
})

test('P0-1 create read-back mismatch: rejects and disposes for BOTH modes, never sends the first message', async () => {
  for (const { workMode, wrong } of [
    { workMode: 'workspace-write', wrong: 'danger-full-access' },
    { workMode: 'full-access', wrong: 'workspace-write' },
  ]) {
    const { ctx, seen } = makeHostCtx({ resolvedMode: wrong })
    const port = portFor(ctx)
    await assert.rejects(
      () => port.createSession({ cwd: '/workspace/p', setup: () => {}, firstMessage: 'go', workMode }),
      /沙箱模式/,
      `${workMode}: a profile overriding the seed must be refused`,
    )
    assert.equal(seen.disposed, 1, `${workMode}: the unverified session is disposed`)
    assert.equal(seen.messages.length, 0, `${workMode}: no prompt is sent to an unverified session`)
  }
})

test('P0-1 create auto-review / unknown mode: explicit fail-closed rejection, no session created', async () => {
  for (const workMode of ['auto-review', 'auto', 'bogus']) {
    const { ctx, seen } = makeHostCtx({ resolvedMode: 'danger-full-access' })
    const port = portFor(ctx)
    await assert.rejects(
      () => port.createSession({ cwd: '/workspace/p', setup: () => {}, firstMessage: 'go', workMode }),
      workMode === 'auto-review' ? /auto-review|preset/ : /未知工作模式/,
      `${workMode} must be refused before any session is created`,
    )
    assert.equal(seen.create, null, `${workMode}: no agent created, no silent full-access fallthrough`)
  }
})

test('P0-1 followup: matching mode is accepted; mismatched live session is refused and NOT disposed', async () => {
  {
    const { ctx, seen } = makeHostCtx({ resolvedMode: 'workspace-write' })
    const port = portFor(ctx)
    await port.followupSession({ sessionId: 's1', message: 'go', workMode: 'workspace-write' })
    assert.equal(seen.messages.length, 1)
    assert.equal(seen.disposed, 0)
  }
  {
    // The live session is pinned to workspace-write; the project now asks for
    // full-access. followup must refuse it without killing a session we don't own.
    const { ctx, seen } = makeHostCtx({ resolvedMode: 'workspace-write' })
    const port = portFor(ctx)
    await assert.rejects(
      () => port.followupSession({ sessionId: 's1', message: 'go', workMode: 'full-access' }),
      /沙箱模式/,
    )
    assert.equal(seen.disposed, 0, 'never dispose the live session on a level-1 refusal')
    assert.equal(seen.messages.length, 0, 'no message reaches a session with the wrong boundary')
  }
})

test('P0-1 resume: assertSandboxMode on the resumed handle; a mismatch disposes only the new handle', async () => {
  {
    const { ctx, seen } = makeHostCtx({ resolvedMode: 'danger-full-access' })
    const port = portFor(ctx)
    const out = await port.resumeSession({ resumeSessionId: 's1', cwd: '/workspace/p', setup: () => {}, firstMessage: 'go', workMode: 'full-access' })
    assert.equal(seen.resume?.resumeSessionId, 's1')
    assert.equal(out.sessionId, 's1')
    assert.equal(seen.disposed, 0)
  }
  {
    const { ctx, seen } = makeHostCtx({ resolvedMode: 'workspace-write' })
    const port = portFor(ctx)
    await assert.rejects(
      () => port.resumeSession({ resumeSessionId: 's1', cwd: '/workspace/p', setup: () => {}, firstMessage: 'go', workMode: 'full-access' }),
      /沙箱模式/,
    )
    assert.equal(seen.disposed, 1, 'only the freshly resumed handle is disposed')
    assert.equal(seen.messages.length, 0)
  }
})

test('P0-1 four paths propagate the SAME workMode from the project to the port', async () => {
  for (const workMode of ['workspace-write', 'full-access']) {
    {
      const s = setupStore(workMode)
      try {
        const calls = []
        const port = {
          createWorktree: () => {}, removeWorktree: () => {}, prepareWorktree: () => {},
          async createSession(o) { calls.push(['create', o.workMode]); return { sessionId: 'new' } },
          async disposeSession() {},
        }
        await dispatchCard({ store: s.store, cardId: s.card.id, port })
        assert.deepEqual(calls, [['create', workMode]])
      } finally { s.cleanup() }
    }
    for (const [level, call, opts] of [
      ['followup', 'followup', { active: true }],
      ['resumed', 'resume', { active: false }],
      ['created', 'create', { active: false, resumeError: new Error('no history') }],
    ]) {
      const s = setupStore(workMode)
      try {
        s.store.transitionCard(s.card.id, 'triage', 'human')
        s.store.transitionCard(s.card.id, 'plan', 'agent')
        s.store.setWorktree(s.card.id, { worktreePath: '/tmp/wt', branch: 'b', baseBranch: 'main', sessionId: 'old' })
        const calls = []
        const port = {
          createWorktree: () => {}, removeWorktree: () => {},
          async isSessionActive() { return opts.active },
          async followupSession(o) { calls.push(['followup', o.workMode]) },
          async resumeSession(o) { calls.push(['resume', o.workMode]); if (opts.resumeError) throw opts.resumeError; return { sessionId: 'resumed' } },
          async createSession(o) { calls.push(['create', o.workMode]); return { sessionId: 'fresh' } },
          async disposeSession() {},
        }
        const result = await continueCard({ store: s.store, cardId: s.card.id, port, message: 'go' })
        assert.equal(result.mode, level)
        assert.equal(calls.at(-1)[0], call, `${level}: the expected port path is the last one taken`)
        assert.equal(calls.some(([name]) => name === 'resume'), level !== 'followup', 'resume is attempted on levels 2 and 3')
        assert.deepEqual(calls.map(([, wm]) => wm), calls.map(() => workMode), `${level}: every attempt carries the same workMode`)
      } finally { s.cleanup() }
    }
  }
})

test('P0-1 continueCard: a mode-mismatched refusal falls through to level 3, records why, and keeps the live session', async () => {
  const s = setupStore('full-access')
  try {
    s.store.transitionCard(s.card.id, 'triage', 'human')
    s.store.transitionCard(s.card.id, 'plan', 'agent')
    s.store.setWorktree(s.card.id, { worktreePath: '/tmp/wt', branch: 'b', baseBranch: 'main', sessionId: 'live-old' })
    const calls = { followup: [], resume: [], create: [], dispose: [] }
    const port = {
      createWorktree: () => {}, removeWorktree: () => {},
      async isSessionActive() { return true },
      async followupSession(o) { calls.followup.push(o); throw new Error('无法派发会话：沙箱模式实际为 workspace-write，所需为 danger-full-access') },
      async resumeSession(o) { calls.resume.push(o); throw new Error('SessionPersistenceNotFoundError: no history') },
      async createSession(o) { calls.create.push(o); return { sessionId: 'session-new' } },
      async disposeSession(h) { calls.dispose.push(h) },
    }
    const result = await continueCard({ store: s.store, cardId: s.card.id, port, message: 'go' })
    assert.equal(result.mode, 'created')
    assert.equal(result.fallbackRecorded, true)
    assert.equal(calls.create[0].workMode, 'full-access', 'the fresh session is seeded with the required mode')
    assert.equal(calls.dispose.length, 0, 'the live session we do not own is never disposed')
    const record = s.store.getCard(s.card.id).history.find((h) => h.type === 'continuation-fallback')
    assert.ok(record, 'fallback must be recorded')
    assert.match(String(record.reason), /沙箱模式/, 'the level-1 refusal reason wins')
    assert.equal(s.store.getCard(s.card.id).sessionId, 'session-new')
  } finally { s.cleanup() }
})

// ===========================================================================
// P0-2 — permissionEnforced derived from live sessions, fail-closed
// ===========================================================================

test('P0-2 resolver true: a live session with a host SandboxMode yields enforced=true', async () => {
  const out = await resolvePermissionEnforcement({
    deps: { resolveSandboxMode: async () => 'workspace-write' },
    activeSessionIds: new Set(['s1']),
  })
  assert.equal(out.enforced, true)
  assert.match(out.reason, /verified 1 active session/)
  assert.match(out.reason, /workspace-write/)

  const many = await resolvePermissionEnforcement({
    deps: { resolveSandboxMode: async (id) => (id === 's1' ? 'workspace-write' : 'danger-full-access') },
    activeSessionIds: new Set(['s1', 's2']),
  })
  assert.equal(many.enforced, true, 'mixed legal modes still enforce a real boundary')
  assert.match(many.reason, /verified 2 active session/)
  assert.match(many.reason, /danger-full-access/)

  const readOnly = await resolvePermissionEnforcement({
    deps: { resolveSandboxMode: async () => 'read-only' },
    activeSessionIds: ['s1'],
  })
  assert.equal(readOnly.enforced, true, 'read-only is a real SandboxMode')
})

test('P0-2 fail-closed: no resolver / no active session / unknown mode / throw all yield false + reason', async () => {
  const cases = [
    [{}, new Set(['s1']), /resolver unavailable/],
    [{ resolveSandboxMode: async () => 'workspace-write' }, new Set(), /no active session/],
    [{ resolveSandboxMode: async () => 'auto' }, new Set(['s1']), /no readable SandboxMode/],
    [{ resolveSandboxMode: async () => undefined }, new Set(['s1']), /no readable SandboxMode/],
    [{ resolveSandboxMode: async () => { throw new Error('host lost') } }, new Set(['s1']), /no readable SandboxMode/],
  ]
  for (const [deps, ids, reason] of cases) {
    const out = await resolvePermissionEnforcement({ deps, activeSessionIds: ids })
    assert.equal(out.enforced, false)
    assert.match(out.reason, reason)
    assert.match(out.reason, /fail-closed|no active session/, 'reason must be human-readable')
  }
})

test('P0-2 /status: permissionEnforced + reason agree with memory, true with a resolver', async () => {
  const f = setupEngine({ withResolver: true, mode: 'workspace-write' })
  try {
    await runTick({ store: f.store, status: f.status, deps: f.deps })
    assert.equal(f.status.permissionEnforced, true)
    assert.match(f.status.permissionEnforcedReason, /verified 1 active session/)
    const res = f.api({ method: 'GET', route: '/status' })
    assert.equal(res.body.engine.permissionEnforced, true, '/status mirrors memory')
    assert.equal(res.body.engine.permissionEnforcedReason, f.status.permissionEnforcedReason)
  } finally { f.cleanup() }
})

test('P0-2 /status: a non-enforced resolver readback is reflected as false with a reason', async () => {
  for (const opts of [
    {},
    { withResolver: true, mode: 'auto' },
    { withResolver: true, resolverThrows: true },
  ]) {
    const f = setupEngine(opts)
    try {
      await runTick({ store: f.store, status: f.status, deps: f.deps })
      assert.equal(f.status.permissionEnforced, false)
      assert.ok(f.status.permissionEnforcedReason)
      const res = f.api({ method: 'GET', route: '/status' })
      assert.equal(res.body.engine.permissionEnforced, false)
      assert.equal(res.body.engine.permissionEnforcedReason, f.status.permissionEnforcedReason)
    } finally { f.cleanup() }
  }
})

// ===========================================================================
// P0-3 — experimental auto-review plugin state readable, fail-closed
// ===========================================================================

const ACTIVE = {
  moduleName: AUTO_REVIEW_PLUGIN_MODULE, enabled: true, fiberPhase: 'active', diagnostic: null,
}

function pluginCtx(manager) {
  return { get: (name) => (name === 'pluginManager' ? manager : undefined) }
}

test('P0-3 active plugin: exact/scoped/subpath names all yield available=true', async () => {
  const names = [
    AUTO_REVIEW_PLUGIN_MODULE,
    'dsh-experimental-auto-review',
    `${AUTO_REVIEW_PLUGIN_MODULE}/dist/index.js`,
    'dsh-experimental-auto-review/sub',
  ]
  for (const moduleName of names) {
    const ctx = pluginCtx({ listPlugins: async () => [
      { moduleName: '@other/noise', enabled: true, fiberPhase: 'active' },
      { ...ACTIVE, moduleName },
    ] })
    const state = await readAutoReviewPluginState(ctx)
    assert.equal(state.available, true, `${moduleName} must be recognised`)
    assert.equal(state.enabled, true)
    assert.equal(state.fiberPhase, 'active')
    assert.equal(state.moduleName, moduleName)
    assert.equal(state.reason, null)
  }
})

test('P0-3 disabled / pending / failed / absent / error / missing manager: available=false with readable reason', async () => {
  const cases = [
    ['disabled', [{ ...ACTIVE, enabled: false }], /plugin disabled/],
    ['pending', [{ ...ACTIVE, fiberPhase: 'pending' }], /not active/],
    ['failed diagnostic', [{ ...ACTIVE, diagnostic: 'load error' }], /failed/],
    ['absent row', [{ moduleName: '@other/x', enabled: true, fiberPhase: 'active' }], /not installed/],
  ]
  for (const [label, rows, reason] of cases) {
    const state = await readAutoReviewPluginState(pluginCtx({ listPlugins: async () => rows }))
    assert.equal(state.available, false, label)
    assert.match(state.reason, reason, label)
  }
  for (const [label, manager, reason] of [
    ['listPlugins throws', { listPlugins: async () => { throw new Error('boom') } }, /listPlugins failed/],
    ['no inventory', { listPlugins: async () => null }, /no inventory/],
    ['no pluginManager', undefined, /pluginManager unavailable/],
    ['no listPlugins', {}, /pluginManager unavailable/],
    ['ctx.get throws', null, /pluginManager unavailable/],
  ]) {
    const ctx = manager === null
      ? { get: () => { throw new Error('service down') } }
      : pluginCtx(manager)
    const state = await readAutoReviewPluginState(ctx)
    assert.equal(state.available, false, label)
    assert.match(state.reason, reason, label)
  }
})

test('P0-3 /status: autoReviewPluginState mirrors the latest tick inventory, fail-closed when reader missing', async () => {
  {
    const f = setupEngine({ pluginInventory: { ...ACTIVE, available: true, reason: null } })
    try {
      await runTick({ store: f.store, status: f.status, deps: f.deps })
      assert.equal(f.status.autoReviewPluginState.available, true)
      const res = f.api({ method: 'GET', route: '/status' })
      assert.deepEqual(res.body.engine.autoReviewPluginState, f.status.autoReviewPluginState, '/status mirrors memory')
      assert.equal(res.body.engine.autoReviewPluginState.moduleName, AUTO_REVIEW_PLUGIN_MODULE)
    } finally { f.cleanup() }
  }
  {
    const f = setupEngine({})
    try {
      await runTick({ store: f.store, status: f.status, deps: f.deps })
      assert.equal(f.status.autoReviewPluginState.available, false)
      assert.match(f.status.autoReviewPluginState.reason, /reader unavailable/)
      const res = f.api({ method: 'GET', route: '/status' })
      assert.equal(res.body.engine.autoReviewPluginState.available, false)
      assert.deepEqual(res.body.engine.autoReviewPluginState, f.status.autoReviewPluginState)
    } finally { f.cleanup() }
  }
})
