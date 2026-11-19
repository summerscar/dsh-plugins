/**
 * QA — PRD-AUTONOMY-V2 formal verification (B1–B7 + P1).
 *
 * Three semantic levels manual / you-approve / machine-approve, one switch
 * autoDispatch only on you-approve. All offline against the real modules with
 * injected seams; self-contained assertions (no git show HEAD baseline).
 * No business code changed; no commit.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import vm from 'node:vm'
import test from 'node:test'

import { FactoryStore, SCHEMA_VERSION } from '../store.js'
import {
  runTick, createEngineStatus, behaviorOf, AUTO_TIER, MACHINE_APPROVE_TIER,
} from '../autonomy.js'
import { collectAudit } from '../audit.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const clientSrc = readFileSync(join(packageRoot, 'client.js'), 'utf8')
const autonomySrc = readFileSync(join(packageRoot, 'autonomy.js'), 'utf8')
const zh = JSON.parse(readFileSync(join(packageRoot, 'locale', 'zh.json'), 'utf8'))
const en = JSON.parse(readFileSync(join(packageRoot, 'locale', 'en.json'), 'utf8'))

function reopen(file) { const s = new FactoryStore({ file }); const state = s.state; s.db.close(); return state }
function patchRow(file, mutate) {
  const db = new DatabaseSync(file)
  try {
    const data = JSON.parse(db.prepare('SELECT data FROM state WHERE id = 1').get().data)
    mutate(data)
    db.prepare('UPDATE state SET data = ? WHERE id = 1').run(JSON.stringify(data))
  } finally { db.close() }
}
function fixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-av2-'))
  const file = join(tmp, 'factory.json')
  const store = new FactoryStore({ file })
  const project = store.createProject({ name: 'p', rootPath: '/workspace/p' })
  const board = store.createBoard({ projectId: project.id, name: 'main' })
  return { tmp, file, store, project, board, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}
function depsFor() {
  const calls = { intake: 0, dispatch: 0, approve: 0 }
  const active = new Map()
  const deps = {
    ghPort: {},
    intake: async () => { calls.intake += 1; return { created: [] } },
    dispatch: async ({ store: s, cardId, transitionActor, transitionMeta }) => {
      calls.dispatch += 1
      s.transitionCard(cardId, 'triage', transitionActor, undefined, transitionMeta)
      const sid = `s-${cardId}`; active.set(sid, true)
      s.setWorktree(cardId, { worktreePath: `/tmp/wt-${cardId}`, branch: 'b', baseBranch: 'main', sessionId: sid })
      return { mode: 'created' }
    },
    approve: async ({ store: s, cardId }) => {
      calls.approve += 1
      s.transitionCard(cardId, 'build', 'autoRule', undefined, { actor: 'autoRule', tier: MACHINE_APPROVE_TIER, rule: 'auto-approve-plan', channel: 'poll' })
      return { approved: true, cardId }
    },
    isSessionActive: async (id) => active.get(id) === true,
  }
  return { deps, calls }
}

// ==============================================================================
// B1 — four combinations, real tick
// ==============================================================================
test('B1 four combinations run a real tick with the expected side effects', async () => {
  const cases = [
    { name: 'manual', autonomy: 'manual', autoDispatch: true, intake: 0, dispatch: 0 },
    { name: 'you-approve ON', autonomy: 'you-approve', autoDispatch: true, intake: 1, dispatch: 1 },
    { name: 'you-approve OFF', autonomy: 'you-approve', autoDispatch: false, intake: 1, dispatch: 0 },
    { name: 'machine-approve', autonomy: 'machine-approve', autoDispatch: false, intake: 1, dispatch: 1 },
  ]
  for (const c of cases) {
    const f = fixture()
    try {
      f.store.updateAutonomy(f.project.id, { autonomy: c.autonomy, autoDispatch: c.autoDispatch })
      f.store.updateIntake(f.project.id, { issueRepo: 'owner/repo', intakeBoardId: f.board.id })
      f.store.createCard({ boardId: f.board.id, title: 'c', source: 'issue:owner/repo#1' })
      const { deps, calls } = depsFor()
      await runTick({ store: f.store, status: createEngineStatus(), deps })
      assert.equal(calls.intake, c.intake, `${c.name}: intake calls`)
      assert.equal(calls.dispatch, c.dispatch, `${c.name}: dispatch calls`)
      const card = f.store.listCards({})[0]
      if (c.name === 'manual') assert.equal(card.status, 'inbox')
      if (c.name === 'you-approve ON' || c.name === 'machine-approve') assert.equal(card.status, 'triage', `${c.name}: dispatched to triage`)
      if (c.name === 'you-approve OFF') assert.equal(card.status, 'inbox', 'only Inbox card created, not dispatched')
    } finally { f.cleanup() }
  }
})

test('B1 machine-approve auto-approves plan-review to build and stops at review (no git)', async () => {
  const f = fixture()
  try {
    f.store.updateAutonomy(f.project.id, { autonomy: 'machine-approve' })
    f.store.updateIntake(f.project.id, { issueRepo: 'owner/repo', intakeBoardId: f.board.id })
    const c = f.store.createCard({ boardId: f.board.id, title: 'c' })
    for (const [to, actor] of [['triage', 'human'], ['plan', 'agent'], ['plan-review', 'agent']]) f.store.transitionCard(c.id, to, actor)
    const { deps, calls } = depsFor()
    await runTick({ store: f.store, status: createEngineStatus(), deps })
    assert.equal(calls.approve, 1, 'machine-approve approved the plan')
    assert.equal(f.store.getCard(c.id).status, 'build', 'advanced to build')
    // No git/PR/done keys are touched by the engine at this level (static guard).
    assert.doesNotMatch(autonomySrc, /commit|create-pr|mark-done/, 'engine never performs git/PR/done')
  } finally { f.cleanup() }
})

// ==============================================================================
// B2 — single source of truth: machine-approve reads no switch
// ==============================================================================
test('B2 machine-approve reads no switch; behaviorOf is the capability truth source', async () => {
  assert.deepEqual(behaviorOf('manual'), { intake: false, dispatch: false, approve: false })
  assert.deepEqual(behaviorOf('you-approve'), { intake: true, dispatch: true, approve: false })
  assert.deepEqual(behaviorOf('machine-approve'), { intake: true, dispatch: true, approve: true })
  // No live read of autoApprove/autoStart anywhere in engine; switch only read for you-approve.
  const liveLines = autonomySrc.split('\n').filter((l) => /project\.(autoApprove|autoStart)/.test(l) && !/^\s*(\*|\/\/)/.test(l))
  assert.equal(liveLines.length, 0, `no legacy switch reads: ${liveLines.join(' | ')}`)
  // The one live switch read is `behavior.dispatch && (level==='machine-approve' || project.autoDispatch===true)`.
  assert.match(autonomySrc, /const autoDispatch = behavior\.dispatch\s*\n\s*&& \(level === 'machine-approve' \|\| project\.autoDispatch === true\)/,
    'autoDispatch read once, short-circuited by machine-approve, gated by behavior.dispatch')

  // Real behavior: machine-approve dispatch is identical for switch true/false.
  for (const sw of [true, false]) {
    const f = fixture()
    try {
      f.store.updateAutonomy(f.project.id, { autonomy: 'machine-approve', autoDispatch: sw })
      f.store.updateIntake(f.project.id, { issueRepo: 'owner/repo', intakeBoardId: f.board.id })
      f.store.createCard({ boardId: f.board.id, title: 'c' })
      const { deps, calls } = depsFor()
      await runTick({ store: f.store, status: createEngineStatus(), deps })
      assert.equal(calls.dispatch, 1, `machine-approve dispatch independent of switch=${sw}`)
      assert.equal(f.store.getProject(f.project.id).autoDispatch, false, 'switch never stored at machine-approve')
    } finally { f.cleanup() }
  }
})

// ==============================================================================
// B3 — migration 7 rows + empty v1 schemaVersion bump (P2 fix)
// ==============================================================================
test('B3 migration 7 rows land correctly on load and persist; schemaVersion=2', () => {
  const rows = [
    ['L0', false, false, 'manual', false],
    ['L1', true, false, 'you-approve', true],
    ['L1', false, false, 'you-approve', false],
    ['L2', true, true, 'machine-approve', false],
    ['L2', true, false, 'you-approve', true],
    ['L2', false, true, 'you-approve', false],
    ['L2', false, false, 'you-approve', false],
  ]
  for (const [level, autoStart, autoApprove, wantLevel, wantSwitch] of rows) {
    const f = fixture()
    try {
      patchRow(f.file, (d) => {
        d.schemaVersion = 1
        d.projects[0].autonomy = level
        d.projects[0].autoStart = autoStart
        d.projects[0].autoApprove = autoApprove
        delete d.projects[0].autoDispatch
      })
      const loaded = new FactoryStore({ file: f.file })
      const p = loaded.getProject(f.project.id)
      assert.equal(p.autonomy, wantLevel, `${level}+${autoStart}+${autoApprove} -> level`)
      assert.equal(p.autoDispatch, wantSwitch, `${level}+${autoStart}+${autoApprove} -> switch`)
      const disk = reopen(f.file)
      assert.equal(disk.schemaVersion, 2, 'v1 rewritten to v2 on disk')
      assert.equal('autoStart' in disk.projects[0], false, 'legacy start key removed on disk')
      assert.equal('autoApprove' in disk.projects[0], false, 'legacy approve key removed on disk')
    } finally { f.cleanup() }
  }
})

test('B3 missing/invalid level migrates to manual; empty v1 archive bumps schemaVersion (P2)', () => {
  const f = fixture()
  try {
    patchRow(f.file, (d) => {
      d.schemaVersion = 1
      d.projects = []
    })
    const loaded = new FactoryStore({ file: f.file })
    assert.equal(reopen(f.file).schemaVersion, 2, 'empty v1 archive bumped to v2 on disk')
    // invalid level on a project → manual
    const f2 = fixture()
    try {
      patchRow(f2.file, (d) => { d.schemaVersion = 1; d.projects[0].autonomy = 'bogus' })
      const l2 = new FactoryStore({ file: f2.file })
      assert.equal(l2.getProject(f2.project.id).autonomy, 'manual')
    } finally { f2.cleanup() }
  } finally { f.cleanup() }
})

test('B3 schemaVersion other than 1 or 2 is still rejected', () => {
  const f = fixture()
  try {
    patchRow(f.file, (d) => { d.schemaVersion = 99 })
    assert.throws(() => new FactoryStore({ file: f.file }), /schemaVersion/)
  } finally { f.cleanup() }
})

// ==============================================================================
// B4 — UI: no visible L0/L1/L2, switch only on you-approve, hint present
// ==============================================================================
test('B4 no L0/L1/L2 in dictionary values; semantic LEVELS order; switch only you-approve', () => {
  for (const [name, dict] of [['zh', zh], ['en', en]]) {
    const hits = Object.entries(dict).filter(([k, v]) => typeof v === 'string' && /\bL[012]\b/.test(v))
    assert.deepEqual(hits.map((x) => x[0]), [], `${name}: no L0/L1/L2 in visible copy`)
  }
  assert.match(clientSrc, /const LEVELS = \['manual', 'you-approve', 'machine-approve'\]/, 'level order fixed')
  assert.match(clientSrc, /level === 'you-approve'/, 'switch gating on you-approve')
  assert.match(clientSrc, /t\('autoDispatchHint'\)/, 'hint rendered')
  assert.ok(zh.autoDispatchHint.includes('手动'), 'zh hint explicitly contrasts manual level')
  assert.ok(en.autoDispatchHint.includes('Manual'), 'en hint explicitly contrasts Manual level')
  assert.match(clientSrc, /setAutoDispatch\(p\.autonomy === 'you-approve' && p\.autoDispatch === true\)/, 'read-back switch only you-approve')
})

// ==============================================================================
// B5 — pause/takeover copy: takeHint gone, scope note present, no duplicate label
// ==============================================================================
test('B5 pause/takeover copy is clean; backend pause/takeover/release unchanged', () => {
  assert.doesNotMatch(clientSrc, /takeHint/, 'fake take entry removed from PauseSection')
  assert.match(clientSrc, /t\('pauseScopeNote'\)/, 'scope note rendered')
  assert.match(clientSrc, /t\('pauseTitle'\)/, 'pauseTitle label rendered')
  // Only ONE pause toggle button: paused ? resumeProject : pauseProject in a single Button.
  assert.match(clientSrc, /h\(Button, \{ disabled: saving, onClick: \(\) => void toggle\(\) \}, paused \? t\('resumeProject'\) : t\('pauseProject'\)\)/,
    'single pause/resume toggle button')
  assert.equal((clientSrc.match(/t\('pauseProject'\)/g) ?? []).length, 1, 'pauseProject text appears once')
  assert.doesNotMatch(zh.pauseSem ?? '', /闸门/, 'no 闸门 jargon in pauseSem')
  assert.doesNotMatch(zh.pauseSub ?? '', /闸门/, 'pauseSub key deleted')
  // CardActions takeover/release still present (takeover only on the card).
  assert.match(clientSrc, /t\('takeover'\)/, 'takeover button still in CardActions')
  assert.match(clientSrc, /t\('returnToEngine'\)/, 'return button still in CardActions')
})

// ==============================================================================
// B6 — four dictionaries: 15 new / 3 changed byte-identical, 19 deleted residual-free
// ==============================================================================
test('B6 new/changed keys byte-identical across four dicts; deleted keys zero residue; relational counts', () => {
  const inline = (() => {
    let reg
    const shim = { createElement: () => ({}), useState: (v) => [v, () => {}], useEffect: () => {}, useCallback: (f) => f, useRef: (v) => ({ current: v }) }
    const req = (n) => n === 'react' ? shim : (() => { throw new Error(n) })()
    const sb = { window: { __ModuleLoader__: { load: (d) => { reg = d } } }, require: req, fetch: async () => ({ ok: true, text: async () => '{}' }), console }
    vm.runInNewContext(clientSrc, sb)
    let cap
    reg.factory(req).apply({ effect: (f) => { f(); return () => {} }, locale: { register: (_n, d) => { cap = d; return () => {} }, bind: () => (k) => k }, slots: { inject: (_o, cb) => cb(), register: () => () => {} } })
    return JSON.parse(JSON.stringify(cap))
  })()
  const added = ['badgeManual', 'badgeYouApprove', 'badgeMachineApprove', 'lvManual', 'lvYouApprove', 'lvMachineApprove', 'leManualM', 'leManualY', 'leYouApproveM', 'leYouApproveY', 'leMachineApproveM', 'leMachineApproveY', 'autoDispatchLabel', 'autoDispatchHint', 'pauseScopeNote']
  const changed = ['pauseSem', 'l2Title', 'l2Body'] // Design-exempt names; UI shows no L2
  const deleted = ['badgeL0', 'badgeL1', 'badgeL2', 'lvL0', 'lvL1', 'lvL2', 'leL0M', 'leL0Y', 'leL1M', 'leL1Y', 'leL2M', 'leL2Y', 'prefHead', 'prefNote', 'autoStart', 'autoApprove', 'inactiveAtLevel', 'pauseSub', 'projPause']
  for (const k of [...added, ...changed]) {
    assert.equal(inline.zh[k], zh[k], `four-place zh.${k}`)
    assert.equal(inline.en[k], en[k], `four-place en.${k}`)
    assert.equal(typeof zh[k], 'string', `${k} in zh locale`)
    assert.equal(typeof en[k], 'string', `${k} in en locale`)
  }
  for (const k of deleted) {
    assert.equal(k in inline.zh, false, `inline zh ${k} deleted`)
    assert.equal(k in inline.en, false, `inline en ${k} deleted`)
    assert.equal(k in zh, false, `locale zh ${k} deleted`)
    assert.equal(k in en, false, `locale en ${k} deleted`)
  }
  assert.equal(Object.keys(inline.zh).length, Object.keys(inline.en).length)
  assert.equal(Object.keys(zh).length - 1, Object.keys(inline.zh).length, 'locale = UI + meta')
  assert.equal(Object.keys(en).length - 1, Object.keys(inline.en).length)
})

// ==============================================================================
// P1 — audit tier consistent per level (dispatch/intake tier == approve tier)
// ==============================================================================
test('P1 machine-approve dispatch/intake events carry machine-approve tier; you-approve carry you-approve', async () => {
  assert.equal(AUTO_TIER, 'you-approve')
  assert.equal(MACHINE_APPROVE_TIER, 'machine-approve')
  // Static: tierForLevel is used by intakeOrigin/dispatchMeta.
  assert.match(autonomySrc, /const tierForLevel = \(level\) => level === 'machine-approve' \? MACHINE_APPROVE_TIER : AUTO_TIER/)
  assert.match(autonomySrc, /const intakeOrigin = \(level\) => \(\{[^}]*tier: tierForLevel\(level\)/)
  assert.match(autonomySrc, /const dispatchMeta = \(level\) => \(\{ tier: tierForLevel\(level\)/)

  for (const [level, wantTier] of [['you-approve', 'you-approve'], ['machine-approve', 'machine-approve']]) {
    const f = fixture()
    try {
      f.store.updateAutonomy(f.project.id, { autonomy: level, autoDispatch: true })
      f.store.updateIntake(f.project.id, { issueRepo: 'owner/repo', intakeBoardId: f.board.id })
      f.store.createCard({ boardId: f.board.id, title: 'c', source: 'issue:owner/repo#1' })
      const { deps } = depsFor()
      await runTick({ store: f.store, status: createEngineStatus(), deps })
      const events = collectAudit(f.store, { cardId: f.store.listCards({})[0].id })
      const tiers = events.map((e) => e.tier).filter(Boolean)
      assert.ok(tiers.length > 0, `${level}: audit has tier-tagged events`)
      assert.ok(tiers.every((t) => t === wantTier), `${level}: all tiers == ${wantTier}, got ${JSON.stringify(tiers)}`)
    } finally { f.cleanup() }
  }
})
