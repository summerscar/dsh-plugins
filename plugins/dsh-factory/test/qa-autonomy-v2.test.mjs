/**
 * QA — autonomy V4 verification (replaces the L0–L4 "autonomy-v2" suite).
 *
 * V4: no tier fields. The default is full auto, and project phase rules may
 * only NARROW a stage (stop it for a human). The engine therefore always has
 * the capability; what changes per project is which stage rules are narrowed.
 * All offline against the real modules with injected seams; self-contained
 * assertions, no git show HEAD baseline. No business code changed.
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
  runTick, createEngineStatus, behaviorOf, DEFAULT_PHASE_RULES,
} from '../autonomy.js'
import { DEFAULT_PHASE_RULES as PR_DEFAULTS, PHASES, phaseAllows } from '../phase-rules.js'
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
  // The git/review seams are ALWAYS injected as real counting functions, not
  // omitted: omitting them would make "never called" a fake green. The engine
  // in V4 owns no git writes at all — what the counters guard is that a
  // narrowing regression (or a re-introduced deliver loop) turns red here.
  const calls = { intake: 0, dispatch: 0, approve: 0, autoCommit: 0, reviewDispatch: 0, reviewRereview: 0, deliver: 0, remoteSync: 0 }
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
      s.transitionCard(cardId, 'build', 'autoRule', undefined, { actor: 'autoRule', tier: 'phase-rules', rule: 'auto-approve-plan', channel: 'poll' })
      return { approved: true, cardId }
    },
    isSessionActive: async (id) => active.get(id) === true,
    autoCommit: async () => { calls.autoCommit += 1; return { ok: true, committed: false } },
    reviewDispatch: async () => { calls.reviewDispatch += 1; return { dispatched: true } },
    reviewRereview: async () => { calls.reviewRereview += 1; return { sessionId: 'x', mode: 'followup' } },
    deliver: async () => { calls.deliver += 1; return { delivered: false } },
    remoteSync: async () => { calls.remoteSync += 1; return { changed: false } },
  }
  return { deps, calls }
}

// ==============================================================================
// B1 — three rule shapes, real tick
// ==============================================================================

test('B1 default full-auto dispatches; narrowed inbox autoStart discovers but never dispatches', async () => {
  const cases = [
    { name: 'default', rules: undefined, dispatch: 1, want: 'triage' },
    { name: 'narrowed inbox', rules: { inbox: { autoStart: false } }, dispatch: 0, want: 'inbox' },
  ]
  for (const c of cases) {
    const f = fixture()
    try {
      if (c.rules) f.store.updatePhaseRules(f.project.id, c.rules)
      f.store.updateIntake(f.project.id, { issueRepo: 'owner/repo', intakeBoardId: f.board.id })
      const card = f.store.createCard({ boardId: f.board.id, title: 'c', source: 'issue:owner/repo#1' })
      const { deps, calls } = depsFor()
      await runTick({ store: f.store, status: createEngineStatus(), deps })
      await runTick({ store: f.store, status: createEngineStatus(), deps })
      assert.equal(calls.dispatch, c.dispatch, `${c.name}: dispatch calls`)
      assert.equal(f.store.getCard(card.id).status, c.want, `${c.name}: card lands in ${c.want}`)
    } finally { f.cleanup() }
  }
})

test('B1 default rules auto-approve plan to build and stop there (no engine git writes)', async () => {
  const f = fixture()
  try {
    f.store.updateIntake(f.project.id, { issueRepo: 'owner/repo', intakeBoardId: f.board.id })
    const c = f.store.createCard({ boardId: f.board.id, title: 'c' })
    for (const [to, actor] of [['triage', 'human'], ['plan', 'agent']]) f.store.transitionCard(c.id, to, actor)
    const { deps, calls } = depsFor()
    await runTick({ store: f.store, status: createEngineStatus(), deps })
    assert.equal(calls.approve, 1, 'default rules approved the plan')
    assert.equal(f.store.getCard(c.id).status, 'build', 'advanced to build, does not self-advance further')
    // The engine must never write git itself in the approval path; the seams
    // are injected (depsFor), so a regression that re-introduces an engine
    // deliver loop turns these red.
    assert.equal(calls.autoCommit, 0, 'approval path must not auto-commit')
    assert.equal(calls.deliver, 0, 'approval path must not run an engine deliver loop')
  } finally { f.cleanup() }
})

// Intent-level boundary: the ENGINE dispatches the independent self-review
// session ONLY when the self-review.autoStart rule is open. A narrowed rule
// stops it — but nothing in the engine commits, re-reviews into git, or
// delivers on the reviewer's behalf. Two shapes, identical cards, identical
// injected seams; only the rule differs:
//   default            → the self-review card reaches deps.reviewDispatch
//   self-review off    → the very same card never reaches the seam
test('B1 self-review dispatch follows the self-review.autoStart rule; no engine git seam fires', async () => {
  for (const [name, rules, want] of [
    ['default', undefined, 1],
    ['self-review narrowed', { 'self-review': { autoStart: false } }, 0],
  ]) {
    const f = fixture()
    try {
      if (rules) f.store.updatePhaseRules(f.project.id, rules)
      f.store.updateIntake(f.project.id, { issueRepo: 'owner/repo', intakeBoardId: f.board.id })
      const c = f.store.createCard({ boardId: f.board.id, title: 'self-review' })
      for (const [to, actor] of [['triage', 'human'], ['plan', 'agent'], ['build', 'agent'], ['self-review', 'agent']]) {
        f.store.transitionCard(c.id, to, actor)
      }
      const { deps, calls } = depsFor()
      await runTick({ store: f.store, status: createEngineStatus(), deps })
      assert.equal(calls.reviewDispatch, want, `${name}: reviewDispatch calls`)
      assert.equal(calls.autoCommit, 0, `${name}: no engine commit`)
      assert.equal(calls.deliver, 0, `${name}: no engine deliver`)
      assert.equal(f.store.getCard(c.id).status, 'self-review', `${name}: card stays in self-review, not done`)
    } finally { f.cleanup() }
  }
})

// ==============================================================================
// B2 — single source of truth: phase rules, no legacy switch reads
// ==============================================================================

test('B2 behaviorOf is the capability truth source and is full auto', async () => {
  assert.deepEqual(behaviorOf(), { intake: true, dispatch: true, approve: true, selfReview: true, remoteSync: true })
  assert.deepEqual(DEFAULT_PHASE_RULES, PR_DEFAULTS, 'the exported default is the rule set itself')
  for (const phase of PHASES) assert.equal(phaseAllows(DEFAULT_PHASE_RULES, phase, 'autoStart'), true)
  // No live read of the removed legacy switches anywhere in the engine.
  const liveLines = autonomySrc.split('\n').filter((l) => /project\.(autoApprove|autoStart|autoDispatch|autonomy)/.test(l) && !/^\s*(\*|\/\/)/.test(l))
  assert.equal(liveLines.length, 0, `live code never reads legacy autonomy fields; found: ${liveLines.join(' | ')}`)
})

// ==============================================================================
// B3 — legacy tier archives migrate to phase rules on load
// ==============================================================================

test('B3 legacy L0–L4 archives migrate to phase rules and strip the tier fields on load', () => {
  const rows = [
    ['manual', { inbox: { autoStart: false }, plan: { autoApprove: false } }],
    ['L0', { inbox: { autoStart: false }, plan: { autoApprove: false } }],
    ['you-approve', { plan: { autoApprove: false } }],
    ['L1', { plan: { autoApprove: false } }],
    ['machine-approve', null],
    ['L3', null],
    ['auto-delivery', null],
    ['L4', null],
  ]
  for (const [legacy, want] of rows) {
    const f = fixture()
    try {
      patchRow(f.file, (d) => {
        d.schemaVersion = 1
        d.projects[0].autonomy = legacy
        d.projects[0].autoDispatch = false
      })
      const loaded = new FactoryStore({ file: f.file })
      const p = loaded.getProject(f.project.id)
      assert.equal('autonomy' in p, false, `${legacy}: tier field stripped`)
      assert.equal('autoDispatch' in p, false, `${legacy}: switch stripped`)
      if (want === null) assert.deepEqual(p.phaseRules, PR_DEFAULTS, `${legacy} migrates to full auto`)
      else for (const [phase, patch] of Object.entries(want)) {
        for (const [key, value] of Object.entries(patch)) assert.equal(p.phaseRules[phase][key], value, `${legacy} → ${phase}.${key}`)
      }
      const disk = reopen(f.file)
      assert.equal(disk.schemaVersion, 2, 'v1 rewritten to v2 on disk')
      assert.equal('autonomy' in disk.projects[0], false, 'legacy tier key removed on disk')
      assert.equal('autoDispatch' in disk.projects[0], false, 'legacy switch removed on disk')
    } finally { f.cleanup() }
  }
})

test('B3 missing/invalid legacy values migrate to the full-auto default', () => {
  const f = fixture()
  try {
    patchRow(f.file, (d) => {
      d.schemaVersion = 1
      d.projects = []
    })
    const loaded = new FactoryStore({ file: f.file })
    assert.equal(reopen(f.file).schemaVersion, 2, 'empty v1 archive bumped to v2 on disk')
    assert.equal(loaded, loaded, 'load succeeds with an empty project list')
    const f2 = fixture()
    try {
      patchRow(f2.file, (d) => { d.schemaVersion = 1; d.projects[0].autonomy = 'bogus' })
      const l2 = new FactoryStore({ file: f2.file })
      const p = l2.getProject(f2.project.id)
      assert.deepEqual(p.phaseRules, PR_DEFAULTS, 'junk legacy value falls back to the safe full-auto default')
      assert.equal('autonomy' in p, false)
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
// B4 — UI: no slider, no L-codes; the stage-rule panel is the control
// ==============================================================================

test('B4 no L0–L4 slider or level copy; stage rules are checkboxes in all four dicts', () => {
  for (const [name, dict] of [['zh', zh], ['en', en]]) {
    for (const n of [0, 1, 2, 3, 4]) {
      assert.equal(dict[`lvL${n}`], undefined, `${name}: no L${n} tick copy`)
      assert.equal(dict[`leL${n}End`], undefined, `${name}: no L${n} endpoint copy`)
    }
  }
  assert.doesNotMatch(clientSrc, /const LEVEL_TIERS/, 'five-level mapping is gone')
  assert.doesNotMatch(clientSrc, /type: 'range', min: '0', max: '4'/, 'no tier slider')
  assert.doesNotMatch(clientSrc, /role: 'switch', 'aria-checked': autoDispatch/, 'no independent autoDispatch switch')
  assert.match(clientSrc, /StageConfigSection/, 'the stage-rule section replaced the slider')
  for (const k of ['stageInbox', 'stageTriage', 'stagePlan', 'stageBuild', 'stageSelfReview', 'stagePrReview',
    'stageConfigTitle', 'stageConfigPurpose', 'stageRuleLockedHint', 'stageDefaultBadge', 'autoStartLabel', 'autoApproveLabel',
    'autoIntakeLabel', 'stageAutoIntakeHint', 'resetDefault', 'stageSaved']) {
    assert.equal(typeof zh[k], 'string', `zh locale has ${k}`)
    assert.equal(typeof en[k], 'string', `en locale has ${k}`)
  }
  for (const k of ['whenAdvancedTitle', 'whenAdvancedHint', 'whenNoNarrow']) {
    assert.equal(zh[k], undefined, `zh dead key ${k} removed`)
    assert.equal(en[k], undefined, `en dead key ${k} removed`)
  }
  const section = clientSrc.slice(clientSrc.indexOf('function StageConfigSection'), clientSrc.indexOf('function PauseSection'))
  assert.doesNotMatch(section, /whenAdvancedTitle|whenAdvancedHint|whenNoNarrow|setAdvance|advance \?/, 'advanced fold removed')
  assert.match(section, /\['autoStart', 'autoApprove'\]/, 'stage checkboxes remain')
  const stageArray = /const stages = \[([\s\S]*?)\n\s*\]/.exec(section)?.[1] ?? ''
  let at = -1
  for (const stage of ['inbox', 'triage', 'plan', 'build', 'self-review', 'pr-review']) {
    const found = stageArray.indexOf(`'${stage}'`, at + 1)
    assert.ok(found >= 0, `stage ${stage} rendered in order`)
    at = found
  }
  assert.match(section, /t\('stageRuleLockedHint'\)/, 'greyed checkboxes carry the locked hint')
  assert.match(section, /disabled:\s*true/, 'greyed checkboxes are disabled')
  for (const label of ['收件箱-自动启动', '规划-自动批准', '自审-自动启动', 'PR 评审-自动启动', '置灰不可改']) {
    assert.ok(zh.stageConfigPurpose.includes(label), `zh purpose names ${label}`)
  }
  assert.doesNotMatch(zh.stageConfigPurpose, /取消某阶段勾选即可停等人/, 'zh no longer promises every checkbox stops a stage')
  for (const label of ['Inbox auto-start', 'Planning auto-approve', 'Self-review auto-start', 'PR review auto-start', 'greyed out']) {
    assert.match(en.stageConfigPurpose, new RegExp(label, 'i'), `en purpose names ${label}`)
  }
  assert.doesNotMatch(en.stageConfigPurpose, /uncheck a stage/i, 'en no longer promises every checkbox stops a stage')
})

// ==============================================================================
// B5 — pause/takeover copy: takeHint gone, scope note present, no duplicate label
// ==============================================================================

test('B5 pause/takeover copy is clean; backend pause/takeover/release unchanged', () => {
  assert.match(clientSrc, /t\('pauseScopeNote'\)/, 'scope note rendered')
  assert.match(clientSrc, /t\('pauseTitle'\)/, 'pauseTitle label rendered')
  const pauseSection = clientSrc.slice(clientSrc.indexOf('function PauseSection'), clientSrc.indexOf('function GlobalTokenSetting'))
  assert.ok(pauseSection.length > 0, 'PauseSection boundaries found')
  // The removed fake entry was an element keyed `takeHint` inside PauseSection.
  // Match that exact token in that section only: the stage-rule hint key
  // `stageAutoIntakeHint` embeds the same letters but is a different key.
  assert.doesNotMatch(pauseSection, /\btakeHint\b/, 'fake take entry removed from PauseSection')
  assert.equal((pauseSection.match(/role: 'switch'/g) ?? []).length, 1, 'exactly one switch in PauseSection')
  assert.doesNotMatch(pauseSection, /h\(Button|resumeProject/, 'no pause/resume action button left')
  // CardActions takeover/release still present (takeover only on the card).
  assert.match(clientSrc, /t\('takeover'\)/, 'takeover button still in CardActions')
  assert.match(clientSrc, /t\('returnToEngine'\)/, 'return button still in CardActions')
})

// ==============================================================================
// B6 — four dictionaries: tier keys deleted residue-free; new stage keys present
// ==============================================================================

test('B6 tier keys are deleted residue-free and stage-rule keys exist in all four dicts', () => {
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
  const deleted = ['badgeManual', 'badgeYouApprove', 'badgeMachineApprove', 'lvManual', 'lvYouApprove', 'lvMachineApprove',
    'leManualM', 'leManualY', 'leYouApproveM', 'leYouApproveY', 'leMachineApproveM', 'leMachineApproveY',
    'axisTitle', 'axisHint', 'currentLevel', 'ariaLevel', 'autoEndLabel', 'machineLabel', 'youLabel',
    ...[0, 1, 2, 3, 4].flatMap((n) => [`lvL${n}`, `leL${n}End`, `leL${n}M`, `leL${n}Y`]),
    'l2Title', 'l2Body', 'enableL2', 'autoDispatchLabel', 'autoDispatchHint', 'saveLevel',
    'leManualM', 'leYouApproveM', 'leMachineApproveM', 'stageInboxIntakeNote']
  for (const k of new Set(deleted)) {
    assert.equal(k in inline.zh, false, `inline zh ${k} deleted`)
    assert.equal(k in inline.en, false, `inline en ${k} deleted`)
    assert.equal(k in zh, false, `locale zh ${k} deleted`)
    assert.equal(k in en, false, `locale en ${k} deleted`)
  }
  // Every inline key must be byte-identical in its locale twin.
  for (const [key, value] of Object.entries(inline.zh)) assert.equal(zh[key], value, `zh locale mirrors inline: ${key}`)
  for (const [key, value] of Object.entries(inline.en)) assert.equal(en[key], value, `en locale mirrors inline: ${key}`)
  assert.equal(Object.keys(inline.zh).length, Object.keys(inline.en).length, 'zh/en inline key sets match')
  assert.equal(Object.keys(zh).length - 1, Object.keys(inline.zh).length, 'locale = UI + meta')
  // The new stage keys are present and mirrored in all four carriers.
  for (const k of ['stageInbox', 'stageTriage', 'stagePlan', 'stageBuild', 'stageSelfReview', 'stagePrReview',
    'stageConfigTitle', 'stageConfigPurpose', 'stageRuleLockedHint', 'writeBoundaryNotice', 'writeBoundaryDetail',
    'autoIntakeLabel', 'stageAutoIntakeHint']) {
    assert.equal(typeof inline.zh[k], 'string', `inline zh has ${k}`)
    assert.equal(typeof inline.en[k], 'string', `inline en has ${k}`)
    assert.equal(inline.zh[k], zh[k], `${k} inline=locale zh`)
    assert.equal(inline.en[k], en[k], `${k} inline=locale en`)
  }
  assert.equal(inline.zh.stageInbox, '收件箱', 'inline zh stageInbox value')
  assert.equal(inline.en.stageInbox, 'Inbox', 'inline en stageInbox value')
  assert.equal(inline.zh.stageRuleLockedHint, '该阶段目前没有可单独关闭的自动步骤，此勾选固定开启、不可修改。', 'inline zh locked hint')
  assert.equal(inline.en.stageRuleLockedHint, 'This stage has no separately switchable automatic step; this checkbox is fixed on and cannot be changed.', 'inline en locked hint')
  // V4.60 intake copy: finalized wording, byte-identical across four carriers,
  // tied to the repo binding and honest that pausing the project cannot stop it.
  assert.equal(inline.zh.autoIntakeLabel, '自动拉取 issue', 'inline zh intake label')
  assert.equal(inline.en.autoIntakeLabel, 'Auto issue intake', 'inline en intake label')
  assert.match(zh.stageAutoIntakeHint, /远端 GitHub 仓库.*绑定/, 'zh intake hint ties intake to the repo binding')
  assert.match(zh.stageAutoIntakeHint, /暂停本项目也不停/, 'zh intake hint says pausing the project does not stop intake')
  assert.match(en.stageAutoIntakeHint, /GitHub repo binding/i, 'en intake hint ties intake to the repo binding')
  assert.match(en.stageAutoIntakeHint, /even while the project is paused/i, 'en intake hint says pausing does not stop intake')
  for (const [name, dict] of [['inline zh', inline.zh], ['inline en', inline.en], ['locale zh', zh], ['locale en', en]]) {
    for (const [key, value] of Object.entries(dict)) {
      if (typeof value !== 'string') continue
      assert.doesNotMatch(value, /与这个勾选无关|取消勾选即停止拉取/, `${name}.${key} has no self-contradictory intake claim`)
      assert.doesNotMatch(value, /regardless of this checkbox|uncheck(ing)?[^.;]{0,24}(stop|disable)[^.;]{0,12}(intake|pull)/i, `${name}.${key} has no fake uncheck-stops-intake promise`)
    }
  }
})

// ==============================================================================
// P1 — audit: automatic actions carry the rule-set tier, and are auditable
// ==============================================================================

test('P1 automatic dispatch events carry the phase-rules tier tag', async () => {
  const f = fixture()
  try {
    f.store.updateIntake(f.project.id, { issueRepo: 'owner/repo', intakeBoardId: f.board.id })
    const card = f.store.createCard({ boardId: f.board.id, title: 'c', source: 'issue:owner/repo#1' })
    const { deps } = depsFor()
    await runTick({ store: f.store, status: createEngineStatus(), deps })
    await runTick({ store: f.store, status: createEngineStatus(), deps })
    const events = collectAudit(f.store, { cardId: card.id })
    const transitions = events.filter((e) => e.type === 'transition' || (e.from && e.to))
    assert.ok(transitions.length > 0, 'the automatic dispatch is in the audit')
    for (const event of transitions) {
      assert.equal(event.actor, 'autoRule', 'the auto edge is audited as the engine, never as a human')
      assert.equal(event.tier, 'phase-rules', 'the tier tag is the rule set, not a level')
    }
  } finally { f.cleanup() }
})
