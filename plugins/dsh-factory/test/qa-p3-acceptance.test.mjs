/**
 * QA — P3 V4 acceptance (upstream order; intent-level assertions).
 *
 * V4 removed the L0–L4 tiers: automation is full-auto by default, narrowed only
 * by phase rules; delivery happens in SESSION tools (build commits+pushes, an
 * independent reviewer records the verdict and opens ONE draft PR from the
 * approved head); `done` is reached only by a merged-PR fact via syncRule.
 *
 * These cases keep the security gates that Chief locked in: no write while a
 * live session runs, HEAD re-read (never model-reported), protected/base
 * branch refusal, frozen dirty paths only, approved-head PR gate, non-force,
 * stop at draft PR. Nothing here asserts a removed concept (tiers, sliders,
 * the old engine deliver loop, the "exactly 6 tools" rule).
 *
 * Self-contained: temp dirs + fake ports; real git/gh wiring is verified on
 * the live machine (separate evidence). No HEAD/git-show baseline.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync as readFs, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FactoryStore } from '../store.js'
import { DEFAULT_PHASE_RULES, runTick, createEngineStatus, defaultEngineDeps } from '../autonomy.js'
import { PHASES, phaseAllows, normalizePhaseRules, migrateLegacyAutonomyToPhaseRules } from '../phase-rules.js'
import { applyRemoteSync, deriveRemoteTarget } from '../sync.js'
import { factoryToolSpecs } from '../tools.js'
import { SYNC_AUTO_EDGES, canTransition } from '../state.js'

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const HEAD = 'a'.repeat(40)
const SHA = 'b'.repeat(40)

function setup({ status = 'build', phaseRules } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-p3-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: '/repo', ...(phaseRules ? { phaseRules } : {}) })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  const card = store.createCard({ boardId: board.id, title: 'probe' })
  store.setWorktree(card.id, { worktreePath: '/worktree', branch: 'factory/card', baseBranch: 'main', sessionId: 'builder-1' })
  const path = ['inbox', 'triage', 'plan', 'build', 'self-review', 'pr-review']
  const actors = { triage: 'human', plan: 'agent', build: 'agent', 'self-review': 'agent', 'pr-review': 'agent' }
  for (const to of path.slice(1, path.indexOf(status) + 1)) store.transitionCard(card.id, to, actors[to])
  return { store, project, card: store.getCard(card.id), cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

/** Fake git port shaped like the real createGitPort; records every call. */
function toolsFor(f, { liveHead = HEAD, active = false } = {}) {
  const calls = []
  const gitPort = {
    headOf: (cwd, base) => { calls.push(['headOf', base]); return HEAD },
    hasDiff: (cwd, base) => { calls.push(['hasDiff', base]); return true },
    changedPaths: (cwd) => { calls.push(['changedPaths']); return ['src/a.js', 'src/b.js'] },
    add: (cwd, paths) => { calls.push(['add', [...paths]]) },
    commit: (cwd, message, paths) => { calls.push(['commit', message, [...paths]]); return SHA },
    push: (cwd, branch) => { calls.push(['push', branch]) },
    reset: (cwd) => { calls.push(['reset']) },
    createPr: (cwd, input) => { calls.push(['createPr', input]); return 'https://github.com/o/r/pull/99' },
    forcePush: () => { calls.push(['forcePush']); throw new Error('force push must never be called') },
    merge: () => { calls.push(['merge']); throw new Error('merge must never be called') },
  }
  const closePrFor = async (card) => { calls.push(['closePr', card.prUrl]) }
  const specs = factoryToolSpecs({
    store: f.store,
    receiptPorts: { validateSchema: () => true },
    readHead: () => liveHead,
    buildGitPortFor: async () => gitPort,
    isSessionActive: async () => active,
    closePrFor,
  })
  const find = (name) => {
    const spec = specs.find((entry) => entry.name === name)
    assert.ok(spec, `${name} is registered`)
    return spec
  }
  return {
    calls, find, specs,
    builder: { agent: { id: 'builder-1', session: { id: 'builder-1' } } },
    reviewer: { agent: { id: 'reviewer-1', session: { id: 'reviewer-1' } } },
  }
}

// ===========================================================================
// A — stage rules replace the five tiers (intent level)
// ===========================================================================

test('P3-A1 new projects are full-auto by default and carry NO tier fields', () => {
  const f = setup()
  try {
    const p = f.store.getProject(f.project.id)
    assert.equal('autonomy' in p, false, 'no legacy autonomy field persisted')
    assert.equal('autoDispatch' in p, false, 'no legacy autoDispatch field persisted')
    assert.deepEqual(p.phaseRules, DEFAULT_PHASE_RULES, 'default rules are full auto')
    for (const phase of PHASES) assert.equal(phaseAllows(p.phaseRules, phase, 'autoStart'), true, `default ${phase} autoStart`)
  } finally { f.cleanup() }
})

test('P3-A2 phase rules only narrow: widen or unknown keys are refused', () => {
  const f = setup()
  try {
    assert.throws(() => f.store.updatePhaseRules(f.project.id, { plan: { widenWrite: true } }), /收窄|不存在|只能是|未知/, 'cannot widen writes')
    assert.throws(() => f.store.updatePhaseRules(f.project.id, { plan: { bogus: false } }), /不存在|未知|收窄/, 'unknown action refused')
    assert.throws(() => f.store.updatePhaseRules(f.project.id, { plan: { autoStart: 'yes' } }), /布尔|布尔值|boolean/, 'non-boolean refused')
    const p = f.store.updatePhaseRules(f.project.id, { plan: { autoApprove: false }, 'self-review': { autoStart: false } })
    assert.equal(p.phaseRules.plan.autoApprove, false, 'narrowing persists')
    assert.equal(p.phaseRules.build.autoStart, true, 'untouched phases stay full auto')
  } finally { f.cleanup() }
})

test('P3-A3 legacy tiers migrate to rules on load; new behavior is expressed by rules', async () => {
  for (const [legacy, want] of [
    ['manual', { inbox: { autoStart: false }, plan: { autoApprove: false } }],
    ['you-approve', { plan: { autoApprove: false } }],
    ['L3', undefined],
    ['auto-delivery', undefined],
  ]) {
    const rules = migrateLegacyAutonomyToPhaseRules({ autonomy: legacy, autoDispatch: false })
    for (const [phase, patch] of Object.entries(want ?? [])) {
      for (const [key, value] of Object.entries(patch)) {
        assert.equal(rules[phase][key], value, `${legacy} → ${phase}.${key}`)
      }
    }
    if (want === undefined) {
      assert.deepEqual(rules, DEFAULT_PHASE_RULES, `${legacy} migrates to full auto`)
    }
  }
  // The engine reads phase rules, not a tier: a fully-narrowed project still
  // discovers but never dispatches; the default project dispatches.
  const narrow = setup({ phaseRules: normalizePhaseRules({ inbox: { autoStart: false } }) })
  try {
    narrow.store.updateIntake(narrow.project.id, { issueRepo: 'o/r', intakeBoardId: narrow.store.listBoards(narrow.project.id)[0].id })
    let dispatched = 0
    const status = createEngineStatus()
    const deps = {
      ghPort: {}, intake: async () => ({ created: [] }),
      dispatch: async () => { dispatched += 1; return { mode: 'created' } },
      isSessionActive: async () => false,
    }
    await runTick({ store: narrow.store, status, deps })
    assert.equal(dispatched, 0, 'narrowed inbox autoStart=false never dispatches')
  } finally { narrow.cleanup() }

  const full = setup()
  try {
    full.store.updateIntake(full.project.id, { issueRepo: 'o/r', intakeBoardId: full.store.listBoards(full.project.id)[0].id })
    let dispatched = 0
    const status = createEngineStatus()
    const board = full.store.listBoards(full.project.id)[0]
    const deps = {
      ghPort: {}, intake: async () => { const c = full.store.createCard({ boardId: board.id, title: 'i1' }); return { created: [c.id] } },
      dispatch: async ({ store, cardId, transitionActor, transitionMeta }) => {
        dispatched += 1
        store.transitionCard(cardId, 'triage', transitionActor, undefined, transitionMeta)
        store.setWorktree(cardId, { worktreePath: '/wt', branch: 'b', baseBranch: 'main', sessionId: `s-${cardId}` })
        return { mode: 'created' }
      },
      isSessionActive: async () => false,
    }
    await runTick({ store: full.store, status, deps })
    await runTick({ store: full.store, status, deps })
    assert.equal(dispatched, 1, 'default full-auto dispatches on the next tick')
    const meta = full.store.getCard(full.store.listCards({}).find((c) => c.title === 'i1').id).history.filter((h) => h.type === 'transition').at(-1)
    assert.equal(meta.tier, 'phase-rules', 'audit tier is the rule set, not a level')
  } finally { full.cleanup() }
})

test('P3-A4 done is unreachable by human/autoRule/agent: only syncRule via SYNC_AUTO_EDGES', () => {
  assert.ok(SYNC_AUTO_EDGES.includes('pr-review->done'))
  assert.equal(canTransition('pr-review', 'done', 'human'), false, 'no human mark-done edge')
  assert.equal(canTransition('pr-review', 'done', 'autoRule'), false, 'engine never marks done')
  assert.equal(canTransition('pr-review', 'done', 'agent'), false, 'agent never marks done')
  assert.equal(canTransition('pr-review', 'done', 'syncRule'), true, 'merged-PR fact is the only path')
})

test('P3-A6 defaultEngineDeps wires remoteSync; the engine no longer owns a deliver port', async () => {
  const f = setup()
  try {
    const ctx = { get: () => undefined }
    const deps = defaultEngineDeps({ ctx, store: f.store })
    assert.equal(typeof deps.remoteSync, 'function', 'merge→done remote-sync is wired')
    assert.equal(deps.remoteSync, applyRemoteSync, 'reuses the idempotent sync.js applier')
    assert.equal(Object.hasOwn(deps, 'deliver'), false, 'the L4 engine deliver loop is gone')
  } finally { f.cleanup() }
})

test('P3-A7 index.js keeps BOTH verdict and delivery namespace exports', () => {
  const src = readFs(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(src, /export \* as verdict from '\.\/verdict\.js'/)
  assert.match(src, /export \* as delivery from '\.\/delivery\.js'/)
})

// ===========================================================================
// B — no tier UI; stage-rule panel + boundary copy in all four dicts
// ===========================================================================

const clientSrc = readFs(new URL('../client.js', import.meta.url), 'utf8')
const zhDict = JSON.parse(readFs(new URL('../locale/zh.json', import.meta.url), 'utf8'))
const enDict = JSON.parse(readFs(new URL('../locale/en.json', import.meta.url), 'utf8'))

test('P3-B1 no L0–L4 slider or level badges; a stage-rule panel drives PATCH phaseRules', () => {
  assert.doesNotMatch(clientSrc, /type: 'range', min: '0', max: '4'/, 'no tier range slider')
  assert.doesNotMatch(clientSrc, /LEVEL_TIERS/, 'no five-level mapping')
  assert.match(clientSrc, /StageConfigSection/, 'stage-rule section exists')
  assert.match(clientSrc, /\{ phaseRules: next \}/, 'saves via PATCH phaseRules')
  assert.match(clientSrc, /'stagePrReview'/, 'pr-review stage rendered')
  for (const action of ['autoStart', 'autoApprove']) assert.match(clientSrc, new RegExp(`'${action}'`), `${action} toggle present`)
  assert.match(clientSrc, /writeBoundaryNotice/, 'write boundary is always visible in settings')
})

test('P3-B2 tier copy is gone from all four dictionaries; stage keys are new and complete', () => {
  const deleted = ['axisTitle', 'axisHint', 'currentLevel', 'ariaLevel', 'autoEndLabel', 'machineLabel', 'youLabel',
    'lvL0', 'lvL1', 'lvL2', 'lvL3', 'lvL4', 'leL0End', 'leL4End', 'lvManual', 'lvYouApprove', 'lvMachineApprove',
    'badgeManual', 'badgeYouApprove', 'badgeMachineApprove', 'saveLevel', 'l2Title', 'l2Body', 'enableL2',
    'autoDispatchLabel', 'autoDispatchHint']
  for (const k of deleted) {
    assert.equal(k in zhDict, false, `zh locale deleted ${k}`)
    assert.equal(k in enDict, false, `en locale deleted ${k}`)
  }
  for (const k of ['stageTriage', 'stagePlan', 'stageBuild', 'stageSelfReview', 'stagePrReview', 'stageConfigTitle',
    'stageConfigPurpose', 'stageDefaultBadge', 'autoStartLabel', 'autoApproveLabel', 'whenAdvancedTitle', 'whenAdvancedHint',
    'whenNoNarrow', 'resetDefault', 'stageSaved', 'writeBoundaryNotice', 'writeBoundaryDetail', 'stageSafetyTitle',
    'stageStripTitle', 'stageStripHint', 'selfReviewApproved', 'selfReviewChanges', 'selfReviewParked', 'flowMergedDone']) {
    assert.equal(typeof zhDict[k], 'string', `zh has ${k}`)
    assert.equal(typeof enDict[k], 'string', `en has ${k}`)
  }
  assert.match(zhDict.whenAdvancedHint, /收窄|更保守|不能放宽/, 'narrowing-only rule stated in zh')
  assert.match(zhDict.writeBoundaryDetail, /草稿 PR|draft/i, 'boundary stops at draft PR in zh')
  assert.match(enDict.writeBoundaryNotice, /draft PR/i, 'boundary stops at draft PR in en')
  assert.match(zhDict.writeBoundaryNotice, /不合并|不关 issue|不强制推送/, 'zh boundary: no merge, no issue close, no force')
})

test('P3-B3 card UI: stage strip + live boundary line; no mark-done or git-write buttons', () => {
  assert.match(clientSrc, /key: 'stageStrip'/, 'stage strip on the card')
  assert.match(clientSrc, /writeBoundaryNotice/ , 'boundary notice on the card')
  for (const k of ['actMarkDone', 'actConfirmCommit', 'actCreatePr', 'actPushExisting', 'actCommitExisting']) {
    const cardActions = clientSrc.slice(clientSrc.indexOf('function CardActions'), clientSrc.indexOf('function Column'))
    assert.ok(cardActions.includes(`'${k}'`) === false, `CardActions no longer has ${k}`)
  }
})

// ===========================================================================
// C — session delivery tools exist AND carry every gate (P3-C9 intent level)
// ===========================================================================

test('P3-C9 the delivery tools are registered with gates (not "no delivery tool")', async () => {
  const f = setup()
  try {
    const names = f.store && factoryToolSpecs({ store: f.store }).map((s) => s.name).sort()
    assert.deepEqual(names, [
      'factory_create_project', 'factory_inspect_repo', 'factory_list_attention',
      'factory_list_work_items', 'factory_open_draft_pr', 'factory_push_branch',
      'factory_report', 'factory_self_review_verdict', 'factory_transition_work_item',
    ].sort(), 'nine tools: the old six plus three gated delivery tools')
    for (const n of ['factory_push_branch', 'factory_self_review_verdict', 'factory_open_draft_pr']) {
      const spec = factoryToolSpecs({ store: f.store }).find((s) => s.name === n)
      assert.match(spec.description, /ONLY|只能|仅/, `${n} documents its own gate`)
    }
  } finally { f.cleanup() }
})

test('P3-C1 build tool: builder-only, build-only, commits frozen paths and pushes — NO PR', async () => {
  const f = setup()
  try {
    f.store.setReviewSession(f.card.id, 'reviewer-1', 'created')
    const t = toolsFor(f)
    const out = await t.find('factory_push_branch').execute({ cardId: f.card.id, message: 'fix: ship it' }, t.builder)
    assert.equal(out.sha, SHA)
    assert.equal(out.prUrl, '', 'build never opens a PR')
    assert.deepEqual(t.calls.map((c) => c[0]), ['headOf', 'changedPaths', 'hasDiff', 'add', 'commit', 'push'], 'verify base, then commit only the frozen dirty paths and push')
    assert.deepEqual(t.calls[4][2], ['src/a.js', 'src/b.js'], 'frozen paths go to add/commit')
    assert.equal(t.calls[5][1], 'factory/card', 'pushes this card branch only')
    const card = f.store.getCard(f.card.id)
    assert.equal(card.commitSha, SHA)
    assert.equal(card.prUrl, null, 'no PR at build time')
    assert.equal(card.deliverySource, 'build-session')
    // A second push on the same card is refused before any git write.
    const before = t.calls.length
    await assert.rejects(() => t.find('factory_push_branch').execute({ cardId: f.card.id, message: 'again' }, t.builder), /已提交|不能重复/)
    assert.equal(t.calls.length, before, 'refusal writes nothing')
  } finally { f.cleanup() }
})

test('P3-C2 build tool refuses: other session, wrong stage, live reviewer, protected or base branch, no diff', async () => {
  const cases = [
    ['non-builder session', (f, t) => t.find('factory_push_branch').execute({ cardId: f.card.id, message: 'x' }, { agent: { id: 'stranger' } }), /builder 会话|只能由本卡/],
    ['outside build', (f, t) => { f.store.transitionCard(f.card.id, 'self-review', 'agent'); return t.find('factory_push_branch').execute({ cardId: f.card.id, message: 'x' }, t.builder) }, /仅 build/],
    ['live reviewer session blocks the write', (f, t) => { f.store.setReviewSession(f.card.id, 'reviewer-1', 'created'); const live = toolsFor(f, { active: true }); return live.find('factory_push_branch').execute({ cardId: f.card.id, message: 'x' }, live.builder) }, /评审会话仍在运行|禁止写入/],
    ['protected branch', (f, t) => { f.store._card(f.card.id).branch = 'main'; f.store._commit(); return t.find('factory_push_branch').execute({ cardId: f.card.id, message: 'x' }, t.builder) }, /受保护分支/],
    ['base branch', (f, t) => { f.store._card(f.card.id).branch = 'dev'; f.store._card(f.card.id).baseBranch = 'dev'; f.store._commit(); return t.find('factory_push_branch').execute({ cardId: f.card.id, message: 'x' }, t.builder) }, /base 分支/],
    ['HEAD diverged from base tip', (f) => { const bad = toolsFor(f, { liveHead: 'c'.repeat(40) }); return bad.find('factory_push_branch').execute({ cardId: f.card.id, message: 'x' }, bad.builder) }, /HEAD 与基线不一致/],
  ]
  for (const [label, run, expected] of cases) {
    const f = setup()
    try {
      const t = toolsFor(f)
      await assert.rejects(async () => {
        const r = run(f, t)
        return typeof r === 'function' ? r() : r
      }, expected, label)
    } finally { f.cleanup() }
  }
  const g = setup()
  try {
    const t = toolsFor(g)
    const nt = factoryToolSpecs({
      store: g.store, receiptPorts: { validateSchema: () => true }, readHead: () => HEAD,
      buildGitPortFor: async () => ({ headOf: () => HEAD, deletedCount: () => 0, hasDiff: () => false, changedPaths: () => [], commit: () => SHA, push: () => {} }),
      isSessionActive: async () => false,
    })
    await assert.rejects(() => nt.find((s) => s.name === 'factory_push_branch').execute({ cardId: g.card.id, message: 'x' }, t.builder), /没有可交付的改动|脏文件/, 'missing diff or dirty paths: readable refusal, zero writes')
  } finally { g.cleanup() }
})

test('P3-C3 self-review verdict tool: reviewer-only, backend head, rounds counted', async () => {
  const f = setup({ status: 'self-review' })
  try {
    f.store.setReviewSession(f.card.id, 'reviewer-1', 'created')
    const t = toolsFor(f)
    const ok = await t.find('factory_self_review_verdict').execute({
      cardId: f.card.id, head: HEAD, verdict: 'approved', blocking: [], followUps: [], checks: [{ name: 'test', result: 'pass' }],
    }, t.reviewer)
    assert.equal(ok.verdict, 'approved')
    assert.equal(ok.head, HEAD, 'the recorded head is the backend read, not the model argument')
    // A builder session can never record a verdict.
    await assert.rejects(
      () => t.find('factory_self_review_verdict').execute({ cardId: f.card.id, head: HEAD, verdict: 'approved', blocking: [], followUps: [], checks: [] }, t.builder),
      /评审会话/,
    )
    // The tool refuses a head that does not match the live git HEAD.
    const stale = toolsFor(f, { liveHead: HEAD })
    await assert.rejects(
      () => stale.find('factory_self_review_verdict').execute({ cardId: f.card.id, head: 'f'.repeat(40), verdict: 'approved', blocking: [], followUps: [], checks: [] }, stale.reviewer),
      /head 与当前 git HEAD 不一致/,
    )
    // changes-requested consumes a round; the cap is 3, and a parked card is recorded.
    const c = f.store
    c.recordSelfReviewVerdict(f.card.id, { head: HEAD, verdict: 'changes-requested', blocking: [{ file: 'a', line: 1, reason: 'r' }], followUps: [], checks: [], sessionId: 'reviewer-1' })
    c.recordSelfReviewVerdict(f.card.id, { head: HEAD, verdict: 'changes-requested', blocking: [], followUps: [], checks: [], sessionId: 'reviewer-1' })
    c.recordSelfReviewVerdict(f.card.id, { head: HEAD, verdict: 'changes-requested', blocking: [], followUps: [], checks: [], sessionId: 'reviewer-1' })
    assert.equal(f.store.getCard(f.card.id).selfReviewRounds, 3, 'cap reached')
  } finally { f.cleanup() }
})

test('P3-C4 draft PR tool: approved head only, reviewer only, ONE draft PR', async () => {
  const f = setup({ status: 'self-review' })
  try {
    f.store.setReviewSession(f.card.id, 'reviewer-1', 'created')
    const t = toolsFor(f)
    // No verdict yet: refused before any git/gh write.
    await assert.rejects(() => t.find('factory_open_draft_pr').execute({ cardId: f.card.id, title: 'T' }, t.reviewer), /没有 approved/)
    assert.equal(t.calls.length, 0)
    // Unapproved verdict: refused.
    f.store.recordSelfReviewVerdict(f.card.id, { head: HEAD, verdict: 'changes-requested', blocking: [{ file: 'a', line: 1, reason: 'r' }], followUps: [], checks: [], sessionId: 'reviewer-1' })
    await assert.rejects(() => t.find('factory_open_draft_pr').execute({ cardId: f.card.id, title: 'T' }, t.reviewer), /没有 approved/)
    assert.equal(t.calls.length, 0, 'refusals happen before any git/gh call')
    // Approved verdict: exactly one draft PR from that head.
    f.store.recordSelfReviewVerdict(f.card.id, { head: HEAD, verdict: 'approved', blocking: [], followUps: [], checks: [], sessionId: 'reviewer-1' })
    const out = await t.find('factory_open_draft_pr').execute({ cardId: f.card.id, title: 'T', body: 'B' }, t.reviewer)
    assert.equal(out.url, 'https://github.com/o/r/pull/99')
    assert.equal(t.calls.find((c) => c[0] === 'createPr')[1].draft, true, 'draft PR only')
    assert.equal(f.store.getCard(f.card.id).prHead, HEAD, 'PR head recorded for drift checks')
    // Second PR on the same card: refused.
    await assert.rejects(() => t.find('factory_open_draft_pr').execute({ cardId: f.card.id, title: 'T2' }, t.reviewer), /已有 PR|不能重复/)
    // A builder session can never open the PR, even with an approved verdict.
    await assert.rejects(() => t.find('factory_open_draft_pr').execute({ cardId: f.card.id, title: 'T3' }, t.builder), /评审会话/)
  } finally { f.cleanup() }
})

test('P3-C5 head drift: entering pr-review closes the mis-opened PR and refuses the move', async () => {
  const f = setup({ status: 'self-review' })
  try {
    f.store.setReviewSession(f.card.id, 'reviewer-1', 'created')
    const t = toolsFor(f)
    f.store.recordSelfReviewVerdict(f.card.id, { head: HEAD, verdict: 'approved', blocking: [], followUps: [], checks: [], sessionId: 'reviewer-1' })
    await t.find('factory_open_draft_pr').execute({ cardId: f.card.id, title: 'T' }, t.reviewer)
    // HEAD moved past the approved head (a later commit): the move must close the PR.
    const drifted = toolsFor(f, { liveHead: 'c'.repeat(40) })
    await assert.rejects(
      () => drifted.find('factory_transition_work_item').execute({ cardId: f.card.id, to: 'pr-review' }, drifted.reviewer),
      /漂移|drift|不一致/,
    )
    assert.ok(drifted.calls.some((c) => c[0] === 'closePr' && c[1] === 'https://github.com/o/r/pull/99'), 'the drifted draft PR is closed through the gh port')
    assert.equal(f.store.getCard(f.card.id).status, 'self-review', 'a drifted card never reaches pr-review')
  } finally { f.cleanup() }
})

test('P3-C6 merge→done: tick polls the active PR, feeds remote-sync, and is idempotent', async () => {
  for (const merged of ['MERGED', 'OPEN']) {
    const f = setup({ status: 'pr-review' })
    try {
      f.store.setPrUrl(f.card.id, 'https://github.com/o/r/pull/99', 'agent')
      const seen = []
      const status = createEngineStatus()
      const deps = {
        ghPortFor: async () => ({ prState: async ({ prUrl }) => { seen.push(prUrl); return merged } }),
        remoteSync: applyRemoteSync,
        isSessionActive: async () => false,
        intake: async () => ({ created: [] }),
        dispatch: async () => ({ mode: 'none' }),
        approve: async () => ({ approved: false }),
        continue: async () => ({}),
        reviewDispatch: async () => ({}),
      }
      await runTick({ store: f.store, status, deps })
      assert.deepEqual(seen, ['https://github.com/o/r/pull/99'], 'only the card\'s active PR is polled')
      if (merged === 'MERGED') {
        assert.equal(f.store.getCard(f.card.id).status, 'done', 'merged fact auto-completes the card')
        const transitions = f.store.getCard(f.card.id).history.filter((h) => h.type === 'transition')
        assert.equal(transitions.at(-1).actor, 'syncRule', 'done was taken by syncRule, not a human')
        // Idempotent: a repeated tick performs NO further write.
        const historyBefore = f.store.getCard(f.card.id).history.length
        await runTick({ store: f.store, status, deps })
        assert.equal(f.store.getCard(f.card.id).history.length, historyBefore, 'repeat tick writes nothing (terminal card)')
      } else {
        assert.equal(f.store.getCard(f.card.id).status, 'pr-review', 'an open PR does not move the card')
      }
    } finally { f.cleanup() }
  }
  // Closed-unmerged: never auto-moved (a human/engine decision, not a fact).
  const f = setup({ status: 'pr-review' })
  try {
    f.store.setPrUrl(f.card.id, 'https://github.com/o/r/pull/99', 'agent')
    assert.deepEqual(deriveRemoteTarget({ pr: { state: 'CLOSED' } }), { target: 'build', reason: 'PR closed without merge' })
    const result = applyRemoteSync({ store: f.store, cardId: f.card.id, remote: { pr: { state: 'CLOSED' } } })
    assert.equal(result.changed, false, 'close-without-merge never auto-moves the card')
    assert.equal(f.store.getCard(f.card.id).status, 'pr-review')
  } finally { f.cleanup() }
})

test('P3-C7 the removed engine deliver loop is not brought back: no git write ports on runTick', () => {
  const src = readFs(new URL('../autonomy.js', import.meta.url), 'utf8')
  const runTickSrc = src.slice(src.indexOf('export async function runTick'), src.indexOf('export function defaultEngineDeps'))
  assert.doesNotMatch(runTickSrc, /deps\.deliver/, 'runTick has no deliver port')
  assert.doesNotMatch(runTickSrc, /deps\.autoCommit/, 'runTick has no autoCommit port')
  assert.match(runTickSrc, /deps\.remoteSync/, 'the merge fact feeds the existing remote-sync port')
})
