/**
 * QA — P2 autonomy engine acceptance (PRD .scratch/prd-autonomy-l1.md §11).
 *
 * These cases exercise the REAL runTick / applyRemoteSync / state machine against
 * a real FactoryStore with injected host deps (fake gh / fake sessions / fake
 * dispatch). Nothing about the code under test is mocked: deps are the boundary
 * the engine was designed to accept, so the orchestration, gating and audit
 * behaviour are genuinely executed. A real timer, real `gh` and real sessions are
 * the only things faked — exactly what an offline test must fake.
 *
 * Evidence rules carried over from P1: numbers come from the actual run, agent
 * self-reports are not trusted, and each assertion is checked against store state
 * / audit events / status rather than a narrative.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FactoryStore } from '../store.js'
import { createApi } from '../api.js'
import {
  createEngineStatus, reconcileOrphans, runTick, startEngine,
} from '../autonomy.js'
import { applyRemoteSync, deriveRemoteTarget, resolveSync } from '../sync.js'
import { canSyncAutoApply, canTransition } from '../state.js'

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function setup({ autonomy = 'manual', autoDispatch = false, withIntake = true, maxActiveSessions } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-l1-'))
  const file = join(tmp, 'factory.json')
  const store = new FactoryStore({ file })

  const project = store.createProject({ name: 'qa-proj', rootPath: '/workspace/any' })
  const board = store.createBoard({ projectId: project.id, name: 'main' })

  const patch = { autonomy, autoDispatch }
  store.updateAutonomy(project.id, patch)
  if (withIntake) {
    // maxActiveSessions is part of the INTAKE config (normalizeIntake), not the
    // autonomy block: it is the per-project concurrency cap (PRD §10).
    store.updateIntake(project.id, {
      issueRepo: 'owner/repo',
      intakeBoardId: board.id,
      ...(maxActiveSessions === undefined ? {} : { maxActiveSessions }),
    })
  }

  const status = createEngineStatus()
  let intakeCalls = 0
  let dispatchCalls = 0
  const createdCards = []
  const activeSessions = new Map()

  const deps = {
    ghPort: {},
    intake: async ({ store: s, boardId, repo, origin }) => {
      intakeCalls += 1
      // Mimic intakeIssues' observable effect only: create Inbox cards with
      // provenance. The engine must not care how they were discovered.
      const issues = [{ number: 1 }, { number: 2 }]
      const created = []
      for (const issue of issues) {
        const key = `${repo}#${issue.number}`
        if (s.listCards({ boardId }).some((c) => c.source === key)) continue
        const card = s.createCard({ boardId, title: `issue ${issue.number}`, source: key, origin })
        createdCards.push(card.id)
        created.push(card.id)
      }
      return { created }
    },
    dispatch: async ({ store: s, cardId, transitionActor, transitionMeta }) => {
      dispatchCalls += 1
      const card = s.getCard(cardId)
      // Idempotency: a card with a worktree/session trace is already dispatched.
      if (card.worktreePath || card.sessionId) return { mode: 'already-dispatched' }
      const sessionId = `sess-${cardId}`
      activeSessions.set(sessionId, true)
      s.transitionCard(cardId, 'triage', transitionActor, undefined, transitionMeta)
      s.setWorktree(cardId, { worktreePath: `/tmp/wt-${cardId}`, branch: 'b', baseBranch: 'main', sessionId })
      return { mode: 'created' }
    },
    isSessionActive: async (id) => activeSessions.get(id) === true,
  }

  const api = createApi({ store, build: 'test', runtime: { engine: status, toolsRegistered: true } })
  const get = (path) => api({ method: 'GET', route: path })

  return {
    store, project, board, status, deps, api, get,
    state: {
      get intakeCalls() { return intakeCalls },
      get dispatchCalls() { return dispatchCalls },
      createdCards, activeSessions,
    },
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  }
}

const cardOf = (f, statusValue) => {
  const card = f.store.createCard({ boardId: f.board.id, title: `card-${statusValue}` })
  if (statusValue !== 'inbox') {
    // Walk the REAL state machine with an actor legal on each edge (EDGE_ACTORS):
    // inbox->triage human, then triage->plan / plan->plan-review are agent-only.
    const path = ['inbox', 'triage', 'plan', 'plan-review']
    for (let i = 1; i <= path.indexOf(statusValue); i += 1) {
      const actor = i === 1 ? 'human' : 'agent'
      f.store.transitionCard(card.id, path[i], actor)
    }
  }
  return card
}

// ---------------------------------------------------------------------------
// AE-1d — you-approve NEVER auto-approves; only machine-approve does
// ---------------------------------------------------------------------------

test('AE-1d: you-approve stops at plan-review; machine-approve is the only auto-approve level', async () => {
  const { behaviorOf, MACHINE_APPROVE_TIER, AUTO_TIER } = await import('../autonomy.js')
  const f = setup({ autonomy: 'you-approve', autoDispatch: true })
  try {
    const waiting = cardOf(f, 'plan-review')
    await runTick({ store: f.store, status: f.status, deps: f.deps })
    assert.equal(f.store.getCard(waiting.id).status, 'plan-review',
      'you-approve must not advance a plan-approval card')
    assert.equal(f.state.dispatchCalls, 0, 'no automatic dispatch for a non-Inbox card')
    const transitions = f.store.getCard(waiting.id).history.filter((h) => h.type === 'transition')
    assert.equal(transitions.filter((h) => h.actor === 'autoRule').length, 0, 'no autoRule transition on the plan-approval card')

    // Capability truth source: you-approve never approves, machine-approve does,
    // and the tiers are distinct semantic values (P1 audit fix).
    assert.deepEqual(behaviorOf('you-approve'), { intake: true, dispatch: true, approve: false })
    assert.deepEqual(behaviorOf('machine-approve'), { intake: true, dispatch: true, approve: true })
    assert.deepEqual(behaviorOf('manual'), { intake: false, dispatch: false, approve: false })
    assert.notEqual(AUTO_TIER, MACHINE_APPROVE_TIER)
    assert.equal(AUTO_TIER, 'you-approve')
    assert.equal(MACHINE_APPROVE_TIER, 'machine-approve')

    // The legacy autoApprove switch no longer exists anywhere in live code.
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../autonomy.js', import.meta.url), 'utf8')
    const live = src.split('\n').filter((l) => /project\.autoApprove/.test(l) && !/^\s*(\*|\/\/)/.test(l))
    assert.equal(live.length, 0, `live code never reads autoApprove; found: ${live.join(' | ')}`)
  } finally { f.cleanup() }
})

// ---------------------------------------------------------------------------
// AE-2b — the重点: remote sync must NOT approve on a human's behalf
// ---------------------------------------------------------------------------

test('AE-2b: PR CLOSED unmerged on a plan-review card records a suggestion, never moves it', () => {
  const f = setup({ autonomy: 'you-approve', autoDispatch: true })
  try {
    const waiting = cardOf(f, 'plan-review')
    const remote = { pr: { state: 'CLOSED', merged: false } }

    // Real chain: deriveRemoteTarget -> resolveSync -> applyRemoteSync.
    const derived = deriveRemoteTarget(remote)
    assert.equal(derived.target, 'build', 'the remote fact suggests a Build return')

    const resolved = resolveSync(f.store.getCard(waiting.id), remote)
    assert.equal(resolved.suggestion.autoApplicable, false)
    assert.equal(resolved.suggestion.requiresHuman, true)

    const result = applyRemoteSync({ store: f.store, cardId: waiting.id, remote })
    assert.equal(result.changed, false, 'sync must not move the card')
    assert.equal(result.needsHuman, true)

    const after = f.store.getCard(waiting.id)
    assert.equal(after.status, 'plan-review', 'still waiting for human plan approval')

    const syncRuleTransitions = after.history.filter((h) => h.type === 'transition' && h.actor === 'syncRule')
    assert.equal(syncRuleTransitions.length, 0, 'actor=syncRule transition count must be 0')

    // The suggestion is recorded for a human, not silently dropped.
    const suggestions = after.history.filter((h) => h.type === 'sync-suggestion' || h.type === 'suggestion')
    assert.ok(suggestions.length > 0, 'a needsHuman suggestion is recorded on the card')

    // audit?actor=autoRule must be empty for this card's transitions.
    const audit = f.get('/audit?actor=autoRule')
    assert.equal(audit.status, 200)
    const autoEvents = audit.body.events.filter((e) => e.cardId === waiting.id)
    assert.equal(autoEvents.length, 0, 'no autoRule audit event for the plan-approval card')
  } finally { f.cleanup() }
})

test('AE-2b guard: syncRule is frozen out of every auto edge, while autoRule keeps you-approve semantics', () => {
  // The fix must be narrow: sync's whitelist is empty (blocked), but the engine's
  // autoRule must remain legal on plan-review->build so machine-approve can open it.
  assert.equal(canSyncAutoApply('plan-review', 'build'), false)
  assert.equal(canTransition('plan-review', 'build', 'syncRule'), false)
  assert.equal(canTransition('plan-review', 'build', 'autoRule'), true,
    'autoRule semantics must not be broken by the G4 fix')
})

// ---------------------------------------------------------------------------
// AE-1 / AE-1b / AE-1c — default zero side effects and the you-approve stop point
// ---------------------------------------------------------------------------

test('AE-1: manual is a strict no-op across multiple ticks', async () => {
  const f = setup({ autonomy: 'manual', autoDispatch: false })
  try {
    const before = f.store.listCards({}).length
    for (let i = 0; i < 3; i += 1) await runTick({ store: f.store, status: f.status, deps: f.deps })

    assert.equal(f.store.listCards({}).length, before, 'no card was created')
    assert.equal(f.state.intakeCalls, 0, 'manual never runs discovery')
    assert.equal(f.state.dispatchCalls, 0, 'manual never dispatches')

    const audit = f.get('/audit?actor=autoRule')
    assert.equal(audit.body.events.length, 0, 'no autoRule audit events at manual')

    // A disabled engine must also be visible, not silently idle.
    assert.ok(f.status.ticks >= 3)
    assert.ok(f.status.projects.every((p) => p.action === 'skipped'))
    assert.match(f.status.projects[0].reason, /manual/)
  } finally { f.cleanup() }
})

test('AE-1b: autoDispatch=false discovers Inbox cards but never dispatches', async () => {
  const f = setup({ autonomy: 'you-approve', autoDispatch: false })
  try {
    await runTick({ store: f.store, status: f.status, deps: f.deps })

    const cards = f.store.listCards({})
    assert.ok(cards.length > 0, 'discovery still creates Inbox cards (discovery is not starting)')
    assert.ok(cards.every((c) => c.status === 'inbox'), 'nothing moved out of inbox')
    assert.equal(f.state.dispatchCalls, 0, 'no dispatch while autoDispatch=false')
    assert.equal(f.status.projects[0].reason, 'autoDispatch=false', 'the reason is readable in status')
  } finally { f.cleanup() }
})

test('AE-1c / AE-2: you-approve runs exactly one automatic edge, then stops at plan-review', async () => {
  const f = setup({ autonomy: 'you-approve', autoDispatch: true })
  try {
    // The tick snapshots cards at its start, so newly discovered cards are picked
    // up by the NEXT tick. Two ticks: discover, then dispatch.
    await runTick({ store: f.store, status: f.status, deps: f.deps })
    await runTick({ store: f.store, status: f.status, deps: f.deps })

    const cards = f.store.listCards({})
    assert.ok(cards.length > 0)
    for (const card of cards) {
      assert.equal(card.status, 'triage', 'the engine advances Inbox -> triage and no further')
      const autoEdges = card.history.filter((h) => h.type === 'transition' && h.actor === 'autoRule')
      assert.equal(autoEdges.length, 1, 'exactly ONE automatic transition per card')
      assert.equal(autoEdges[0].from, 'inbox')
      assert.equal(autoEdges[0].to, 'triage')
      // Governance fields present on the automatic transition (AE-6).
      assert.equal(autoEdges[0].tier, 'you-approve')
      assert.equal(autoEdges[0].rule, 'auto-dispatch-triage')
      assert.equal(autoEdges[0].channel, 'poll')
      assert.ok(autoEdges[0].at)
    }
  } finally { f.cleanup() }
})

// ---------------------------------------------------------------------------
// AE-3 — dedupe
// ---------------------------------------------------------------------------

test('AE-3: repeated ticks never duplicate a card for the same issue', async () => {
  const f = setup({ autonomy: 'you-approve', autoDispatch: false })
  try {
    await runTick({ store: f.store, status: f.status, deps: f.deps })
    const afterFirst = f.store.listCards({}).length
    await runTick({ store: f.store, status: f.status, deps: f.deps })
    await runTick({ store: f.store, status: f.status, deps: f.deps })

    assert.equal(f.store.listCards({}).length, afterFirst, 'no duplicate cards on later ticks')
    const sources = f.store.listCards({}).map((c) => c.source)
    assert.equal(new Set(sources).size, sources.length, 'each source key appears once')
  } finally { f.cleanup() }
})

// ---------------------------------------------------------------------------
// AE-4 — timer lifecycle
// ---------------------------------------------------------------------------

test('AE-4: one timer, mounted once, cleared on unload; missing service is visible', () => {
  const f = setup({ autonomy: 'you-approve', autoDispatch: true })
  try {
    const disposers = []
    let intervalCalls = 0
    // A plain-object ctx with NO `inject`/`get`: this is the offline-test shape,
    // which startEngine mounts directly. (A real Cordis ctx always has `inject`,
    // and reading an undeclared service property on it throws — see the
    // "Cordis inject discipline" cases below.)
    const scope = {
      interval: () => { intervalCalls += 1; return () => {} },
      effect: (fn) => { const d = fn(); disposers.push(d); return d },
    }
    startEngine({ ctx: scope, store: f.store, status: f.status, deps: f.deps })
    startEngine({ ctx: scope, store: f.store, status: f.status, deps: f.deps })
    assert.equal(intervalCalls, 1, 'calling startEngine twice still mounts ONE timer')
    assert.equal(f.status.timerActive, true)
    assert.equal(f.status.timerReason, null)

    // Unload: the effect disposer must stop the timer and say so.
    for (const d of disposers) if (typeof d === 'function') d()
    assert.equal(f.status.timerActive, false)
    assert.match(f.status.timerReason, /disposed/)
  } finally { f.cleanup() }
})

test('AE-4: after unload, a fresh load (new ctx) can mount a timer again', () => {
  // Guards the naive fix for the double-mount bug: a MODULE-LEVEL `mounted` flag
  // would stop the second mount forever, trading "two timers" for "no timer after
  // reload" — a worse bug, and one the double-call case above cannot see. The flag
  // must live on the engine state (or be reset by the disposer), so a genuinely
  // new mount after teardown still works.
  const f = setup({ autonomy: 'you-approve', autoDispatch: true })
  try {
    const makeScope = () => {
      const disposers = []
      const scope = {
        intervalCalls: 0,
        interval: () => { scope.intervalCalls += 1; return () => {} },
        effect: (fn) => { const d = fn(); disposers.push(d); return d },
        disposeAll: () => { for (const d of disposers) if (typeof d === 'function') d() },
      }
      return scope
    }

    const first = makeScope()
    startEngine({ ctx: first, store: f.store, status: f.status, deps: f.deps })
    assert.equal(first.intervalCalls, 1, 'first load mounts a timer')
    first.disposeAll()
    assert.equal(f.status.timerActive, false)

    // Simulate a plugin reload: a brand-new ctx/scope, same engine status object.
    const second = makeScope()
    startEngine({ ctx: second, store: f.store, status: f.status, deps: f.deps })
    assert.equal(second.intervalCalls, 1, 'a reload after unload must mount a timer again')
    assert.equal(f.status.timerActive, true)
    assert.equal(f.status.timerReason, null)
    second.disposeAll()
  } finally { f.cleanup() }
})

test('AE-4: a host without a timer service never pretends to run', () => {
  const f = setup({ autonomy: 'you-approve', autoDispatch: true })
  try {
    // ctx.inject exists but never fires the callback: the service is absent.
    startEngine({ ctx: { inject: () => {} }, store: f.store, status: f.status, deps: f.deps })
    assert.equal(f.status.timerActive, false)
    assert.equal(typeof f.status.timerReason, 'string')
    assert.ok(f.status.timerReason.length > 0, 'a readable reason, never a silent no-op')

    // And it must be readable through the API, not only in memory.
    const res = f.get('/status')
    assert.equal(res.body.engine.timerActive, false)
    assert.ok(res.body.engine.timerReason.length > 0)
  } finally { f.cleanup() }
})

// ---------------------------------------------------------------------------
// AE-5 — concurrency and queueing
// ---------------------------------------------------------------------------

test('AE-5: the project cap is honoured and queued cards stay in Inbox', async () => {
  const f = setup({ autonomy: 'you-approve', autoDispatch: true, maxActiveSessions: 1 })
  try {
    // Tick 1 discovers the cards; tick 2 dispatches them under the cap.
    await runTick({ store: f.store, status: f.status, deps: f.deps })
    await runTick({ store: f.store, status: f.status, deps: f.deps })
    const cards = f.store.listCards({})
    const dispatched = cards.filter((c) => c.status === 'triage')
    const queued = cards.filter((c) => c.status === 'inbox')

    assert.equal(dispatched.length, 1, 'only one card dispatched under a cap of 1')
    assert.ok(queued.length > 0, 'the rest stay in Inbox, not dropped')
    assert.ok(queued.every((c) => c.stalled !== true), 'queued cards are NOT marked stalled')

    // A further tick with the slot still occupied must report queueing, not "ran".
    await runTick({ store: f.store, status: f.status, deps: f.deps })
    assert.equal(f.status.projects[0].action, 'queued', 'a full cap reports queueing')
    assert.match(f.status.projects[0].reason, /concurrency limit/)

    // Release the active session, then the next tick must take one more.
    const activeId = [...f.state.activeSessions.keys()][0]
    f.state.activeSessions.set(activeId, false)
    await runTick({ store: f.store, status: f.status, deps: f.deps })
    assert.equal(f.store.listCards({}).filter((c) => c.status === 'triage').length, 2,
      'a freed slot is refilled on the next tick')
  } finally { f.cleanup() }
})

test('AE-5: the global cap counts runtime-active sessions across projects', async () => {
  const f = setup({ autonomy: 'you-approve', autoDispatch: true })
  try {
    // Simulate a global cap of 1 by occupying it with an active session elsewhere.
    const other = f.store.createProject({ name: 'other', rootPath: '/workspace/other' })
    const otherBoard = f.store.createBoard({ projectId: other.id, name: 'b2' })
    const busy = f.store.createCard({ boardId: otherBoard.id, title: 'busy' })
    f.store.setWorktree(busy.id, { worktreePath: '/tmp/wt-busy', branch: 'b', baseBranch: 'main', sessionId: 'sess-busy' })
    f.state.activeSessions.set('sess-busy', true)

    await runTick({ store: f.store, status: f.status, deps: f.deps, config: { globalMaxActive: 1 } })
    const mine = f.store.listCards({ projectId: f.project.id })
    assert.equal(mine.filter((c) => c.status === 'triage').length, 0,
      'the global cap blocks this project while another session is active')
    assert.ok(mine.every((c) => c.status === 'inbox'))
  } finally { f.cleanup() }
})

// ---------------------------------------------------------------------------
// AE-6 — audit distinguishes automatic from human
// ---------------------------------------------------------------------------

test('AE-6: automatic actions are auditable and never dyed as human', async () => {
  const f = setup({ autonomy: 'you-approve', autoDispatch: true })
  try {
    await runTick({ store: f.store, status: f.status, deps: f.deps })

    const auto = f.get('/audit?actor=autoRule')
    assert.equal(auto.status, 200)
    assert.ok(auto.body.events.length > 0, 'the automatic dispatch is in the audit')
    for (const event of auto.body.events) {
      assert.equal(event.actor, 'autoRule')
    }

    const human = f.get('/audit?actor=human')
    const overlap = human.body.events.filter((e) => auto.body.events.some((a) => a.at === e.at && a.cardId === e.cardId))
    assert.equal(overlap.length, 0, 'automatic actions are not also reported as human')
  } finally { f.cleanup() }
})

// ---------------------------------------------------------------------------
// AE-7 — pause / take-over
// ---------------------------------------------------------------------------

test('AE-7: a paused engine dispatches nothing, and resumes without backfilling', async () => {
  const f = setup({ autonomy: 'you-approve', autoDispatch: true })
  try {
    await runTick({ store: f.store, status: f.status, deps: f.deps })
    const dispatchedBefore = f.state.dispatchCalls

    f.status.paused = true
    await runTick({ store: f.store, status: f.status, deps: f.deps })
    assert.equal(f.state.dispatchCalls, dispatchedBefore, 'no new dispatch while paused')
    assert.equal(f.status.projects[0].reason, 'paused')

    f.status.paused = false
    await runTick({ store: f.store, status: f.status, deps: f.deps })
    assert.ok(f.state.dispatchCalls > dispatchedBefore, 'dispatch resumes after unpause')
  } finally { f.cleanup() }
})

test('AE-7: a taken-over card is never touched by later ticks', async () => {
  const f = setup({ autonomy: 'you-approve', autoDispatch: true })
  try {
    const card = f.store.createCard({ boardId: f.board.id, title: 'mine' })
    f.store.takeOverCard(card.id)

    await runTick({ store: f.store, status: f.status, deps: f.deps })
    await runTick({ store: f.store, status: f.status, deps: f.deps })

    const after = f.store.getCard(card.id)
    assert.equal(after.status, 'inbox', 'a taken-over card stays where the human left it')
    assert.equal(after.takenOver, true, 'the flag is persisted')
    const autoEdges = after.history.filter((h) => h.type === 'transition' && h.actor === 'autoRule')
    assert.equal(autoEdges.length, 0)
  } finally { f.cleanup() }
})

// ---------------------------------------------------------------------------
// AE-8 — missing config is a visible, zero-side-effect skip
// ---------------------------------------------------------------------------

test('AE-8: a project without intake config is skipped with a readable reason', async () => {
  const f = setup({ autonomy: 'you-approve', autoDispatch: true, withIntake: false })
  try {
    await runTick({ store: f.store, status: f.status, deps: f.deps })

    assert.equal(f.store.listCards({}).length, 0, 'no card created without an issue source')
    assert.equal(f.state.intakeCalls, 0, 'discovery not attempted without config')
    const report = f.status.projects[0]
    assert.equal(report.action, 'skipped')
    assert.match(report.reason, /issueRepo|intakeBoardId/, 'the reason names the missing config')
  } finally { f.cleanup() }
})

test('AE-8: a configured-but-missing board is also a visible skip', async () => {
  const f = setup({ autonomy: 'you-approve', autoDispatch: true, withIntake: false })
  try {
    f.store.updateIntake(f.project.id, { issueRepo: 'owner/repo', intakeBoardId: 'no-such-board' })
    await runTick({ store: f.store, status: f.status, deps: f.deps })
    assert.equal(f.store.listCards({}).length, 0)
    assert.match(f.status.projects[0].reason, /看板/)
  } finally { f.cleanup() }
})

// ---------------------------------------------------------------------------
// AE-9 — transaction boundary: idempotency + orphan reconciliation, no rebuild
// ---------------------------------------------------------------------------

test('AE-9: a card that already has a session trace is never dispatched twice', async () => {
  const f = setup({ autonomy: 'you-approve', autoDispatch: true })
  try {
    const card = f.store.createCard({ boardId: f.board.id, title: 'half-done' })
    // Simulate "write happened, receipt lost": the trace exists but status stayed inbox.
    f.store.setWorktree(card.id, { worktreePath: '/tmp/wt-x', branch: 'b', baseBranch: 'main', sessionId: 'sess-x' })

    await runTick({ store: f.store, status: f.status, deps: f.deps })

    const after = f.store.getCard(card.id)
    assert.equal(f.state.dispatchCalls, 0, 'the engine does not dispatch a card that already has a trace')
    assert.equal(after.status, 'inbox', 'it is left for reconciliation, not silently rebuilt')
  } finally { f.cleanup() }
})

test('AE-9: an orphan is reported for a human, never cleaned up or rebuilt', async () => {
  const f = setup({ autonomy: 'you-approve', autoDispatch: true })
  try {
    const card = f.store.createCard({ boardId: f.board.id, title: 'orphan' })
    f.store.setWorktree(card.id, { worktreePath: '/tmp/wt-o', branch: 'b', baseBranch: 'main', sessionId: 'sess-gone' })
    // sess-gone is not in activeSessions => the host says it is gone.

    const orphans = await reconcileOrphans({ store: f.store, deps: f.deps })
    assert.equal(orphans.length, 1)
    assert.equal(orphans[0].cardId, card.id)

    await runTick({ store: f.store, status: f.status, deps: f.deps })
    assert.equal(f.status.orphans.length, 1, 'the orphan appears on status for a human')
    // Not cleaned, not rebuilt: the trace is untouched and no new session started.
    const after = f.store.getCard(card.id)
    assert.equal(after.worktreePath, '/tmp/wt-o', 'the engine never removes the trace itself')
    assert.equal(f.state.dispatchCalls, 0, 'the orphan is not re-dispatched')
  } finally { f.cleanup() }
})

// ---------------------------------------------------------------------------
// AE-10 — the permission level is never over-claimed
// ---------------------------------------------------------------------------

test('AE-10: permissionEnforced stays false and is exposed as a config value only', async () => {
  const f = setup({ autonomy: 'you-approve', autoDispatch: true })
  try {
    await runTick({ store: f.store, status: f.status, deps: f.deps })
    assert.equal(f.status.permissionEnforced, false, 'the engine never claims enforcement')

    const res = f.get('/status')
    assert.equal(res.body.engine.permissionEnforced, false)
    // The project's permission is reported as a CONFIG value, not an enforcement claim.
    const project = res.body.counts && f.store.getProject(f.project.id)
    assert.equal(typeof project.defaultPermission, 'string')
  } finally { f.cleanup() }
})

// ---------------------------------------------------------------------------
// Single-flight — an overlapping tick must not double-act
// ---------------------------------------------------------------------------

test('single-flight: an overlapping tick returns immediately instead of double-dispatching', async () => {
  const f = setup({ autonomy: 'you-approve', autoDispatch: true })
  try {
    f.status.singleFlight = true
    const result = await runTick({ store: f.store, status: f.status, deps: f.deps })
    assert.equal(result.overlapped, true)
    assert.equal(f.state.dispatchCalls, 0, 'no work done while another tick is in flight')
    assert.equal(f.store.listCards({}).length, 0)
  } finally { f.cleanup() }
})

// ---------------------------------------------------------------------------
// Cordis inject discipline — the gap that let a fatal bug through 187 green tests
// ---------------------------------------------------------------------------

/**
 * A minimal stand-in for Cordis' ctx PROXY.
 *
 * The real ctx is a Proxy: reading a service property that was not declared in
 * the plugin's `inject` list THROWS ("cannot get property \"timer\" without
 * inject"). A plain object fake cannot reproduce that, which is exactly how
 * `typeof ctx?.interval === 'function'` passed 187 offline tests and then killed
 * the whole plugin on a real host (every /api/dsh-factory route 404'd).
 *
 * This fake throws on undeclared property reads and answers `get()` with
 * undefined instead, mirroring the host contract the plugin must follow.
 */
function cordisLikeCtx({ declared = [], services = {}, effect, inject } = {}) {
  const base = {
    get: (name) => services[name],
    // `inject: null` means "this ctx has no inject" (the get() fallback path).
    ...(inject === null ? {} : { inject: inject ?? ((names, cb) => { cb({ ...services }) }) }),
    effect: effect ?? ((fn) => fn()),
  }
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (typeof prop === 'symbol') return undefined
      if (!declared.includes(prop)) {
        throw new Error(`cannot get property "${String(prop)}" without inject`)
      }
      return services[prop]
    },
  })
}

test('startEngine must not read undeclared service properties (Cordis inject discipline)', () => {
  const f = setup({ autonomy: 'you-approve', autoDispatch: true })
  try {
    // The plugin's real inject list is ['webServer', 'connection'] — `timer` is
    // NOT declared, so touching ctx.interval on this proxy must throw.
    const ctx = cordisLikeCtx({ declared: ['webServer', 'connection'], services: {} })

    assert.doesNotThrow(
      () => startEngine({ ctx, store: f.store, status: f.status, deps: f.deps }),
      'startEngine must survive a ctx that enforces inject declarations',
    )

    // With no timer service available it must say so, not silently pretend.
    assert.equal(f.status.timerActive, false)
    assert.ok(String(f.status.timerReason).length > 0)
  } finally { f.cleanup() }
})

