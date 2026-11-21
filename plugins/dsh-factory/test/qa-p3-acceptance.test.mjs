/**
 * QA — P3 acceptance tests (PRD §5.11 / §7 / §9 AC 35–44).
 * Self-contained: temp git repo + fixed constants, no HEAD/git-show baseline.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FactoryStore, AUTONOMY_LEVELS, DEFAULT_AUTONOMY } from '../store.js'
import { behaviorOf, canDeliver, runTick, createEngineStatus, defaultEngineDeps, AUTO_DELIVERY_TIER, RULE_DELIVER } from '../autonomy.js'
import {
  evaluateAutoDelivery, armAutoDelivery, executeAutoDelivery, runAutoDelivery,
} from '../delivery.js'
import { DEFAULT_PROTECTED_BRANCHES } from '../git-exec.js'
import { factoryToolSpecs } from '../tools.js'

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function setup({ autonomy = AUTO_DELIVERY_TIER, autoDispatch = false, verdict = 'approved', blocking = [], reviewer = 'reviewer-1', headOverride, branch = 'factory/probe' } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-p3-'))
  const repo = join(tmp, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q')
  git(repo, 'checkout', '-qb', 'main')
  writeFileSync(join(repo, 'README.md'), '# probe\n')
  git(repo, 'add', 'README.md')
  git(repo, '-c', 'user.name=QA', '-c', 'user.email=qa@local', 'commit', '-qm', 'initial')
  const head = headOverride ?? git(repo, 'rev-parse', 'HEAD').trim()

  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: repo })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  const card = store.createCard({ boardId: board.id, title: 'probe' })
  store.setWorktree(card.id, { worktreePath: repo, branch, baseBranch: 'main', sessionId: 'builder-1' })
  for (const [to, actor] of [['triage', 'human'], ['plan', 'agent'], ['plan-review', 'agent'], ['build', 'human'], ['review', 'agent']]) {
    store.transitionCard(card.id, to, actor)
  }
  store.setReviewSession(card.id, reviewer ?? 'reviewer-1', 'created')
  store.updateAutonomy(project.id, { autonomy, autoDispatch })
  if (verdict !== null) {
    store._card(card.id).reviewVerdict = {
      cardId: card.id, source: 'review', verdict, reviewedHead: head,
      blocking, followUps: [], checks: [], reviewerSessionId: reviewer,
    }
    store._commit()
  }
  return {
    store, project, card, repo, head,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  }
}

const gate = (f, extra = {}) => ({
  store: f.store, cardId: f.card.id, readHead: () => f.head,
  resolveIdentity: async () => ({ git: {} }), ...extra,
})

/** A port shaped like the REAL host: has isWorktreeClean, never commits a reviewed tree. */
const realPort = ({ clean = true } = {}) => {
  const calls = []
  return {
    calls,
    // Mirror the real host createGitPort: delivery's worktree-validity preflight
    // (arm + execute recheck) calls this before any git read/push. The fixture's
    // worktree is always valid, so it reports true — but it MUST be present so
    // this QA acceptance path exercises the same branches as the real machine
    // instead of silently skipping them via the typeof guard.
    worktreeExists: () => { calls.push(['worktreeExists']); return true },
    isWorktreeClean: () => { calls.push(['isWorktreeClean']); return clean },
    push: (...a) => { calls.push(['push', ...a]) },
    createPr: (w, opts) => { calls.push(['createPr', opts]); return 'https://github.com/o/r/pull/99' },
    // These must NEVER be reached on the real-host path (reviewed tree is HEAD).
    add: () => { calls.push(['add']); throw new Error('add must not be called') },
    commit: () => { calls.push(['commit']); throw new Error('commit must not be called') },
    forcePush: () => { calls.push(['forcePush']); throw new Error('force push must never be called') },
    merge: () => { calls.push(['merge']); throw new Error('merge must never be called') },
  }
}

const port = () => {
  const calls = []
  return {
    calls,
    add: (...a) => { calls.push(['add', ...a]) },
    commit: (worktree, message) => { calls.push(['commit', message]); return HEAD_FOR_PORT },
    createPr: (worktree, opts) => { calls.push(['createPr', opts]); return 'https://github.com/o/r/pull/99' },
    push: (...a) => { calls.push(['push', ...a]) },
    forcePush: () => { calls.push(['forcePush']); throw new Error('force must not be called') },
    merge: () => { calls.push(['merge']); throw new Error('merge must not be called') },
  }
}
// commit() must return the armed head; set by each test before execution.
let HEAD_FOR_PORT = 'unset'

// ===========================================================================
// A — five-tier mapping (AC 35–37, 42)
// ===========================================================================

test('P3-A1 five levels persist; default is manual; unknown rejected; L4 ignores autoDispatch', () => {
  assert.equal(DEFAULT_AUTONOMY, 'manual')
  for (const lv of ['manual', 'you-approve', 'machine-approve', 'auto-delivery']) {
    assert.equal(AUTONOMY_LEVELS.has(lv), true)
  }
  const f = setup({ autonomy: 'manual' })
  try {
    assert.equal(f.store.getProject(f.project.id).autonomy, 'manual')
    for (const flag of [true, false]) {
      f.store.updateAutonomy(f.project.id, { autonomy: 'auto-delivery', autoDispatch: flag })
      const p = f.store.getProject(f.project.id)
      assert.equal(p.autonomy, 'auto-delivery')
      assert.equal(p.autoDispatch, false, 'L4 never stores autoDispatch=true')
    }
    f.store.updateAutonomy(f.project.id, { autonomy: 'you-approve', autoDispatch: true })
    assert.equal(f.store.getProject(f.project.id).autoDispatch, true, 'L2 still expressible')
    assert.throws(() => f.store.updateAutonomy(f.project.id, { autonomy: 'bogus' }), /autonomy 只能是/)
    assert.equal(f.store.getProject(f.project.id).autonomy, 'you-approve', 'rejected write leaves tier intact')
  } finally { f.cleanup() }
})

test('P3-A2 behaviorOf(auto-delivery) inherits L3 plus canDeliver; not all-false', () => {
  const l3 = behaviorOf('machine-approve')
  const l4 = behaviorOf(AUTO_DELIVERY_TIER)
  assert.deepEqual(l4, l3)
  assert.deepEqual(l4, { intake: true, dispatch: true, approve: true })
  assert.equal(Object.values(l4).some((v) => v === true), true, 'the known dev trap: never all-false')
  assert.equal(canDeliver(AUTO_DELIVERY_TIER), true)
  assert.equal(canDeliver('machine-approve'), false)
  assert.deepEqual(behaviorOf('manual'), { intake: false, dispatch: false, approve: false })
})

test('P3-A3 engine offers Review cards to deliver only at L4; report.delivered counted', async () => {
  for (const autonomy of ['manual', 'you-approve', 'machine-approve', AUTO_DELIVERY_TIER]) {
    const f = setup({ autonomy })
    try {
      const status = createEngineStatus()
      const calls = []
      const deps = {
        ghPort: {}, intake: async () => ({ created: [] }), dispatch: async () => ({ mode: 'none' }),
        isSessionActive: async () => false,
        deliver: async ({ cardId }) => { calls.push(cardId); return { delivered: true } },
      }
      await runTick({ store: f.store, status, deps })
      assert.equal(calls.length, autonomy === AUTO_DELIVERY_TIER ? 1 : 0, `${autonomy} deliver calls`)
      const report = status.projects[0]
      assert.equal(report.delivered, autonomy === AUTO_DELIVERY_TIER ? 1 : 0)
      assert.equal(Object.hasOwn(report, 'delivered'), true)
    } finally { f.cleanup() }
  }
})

test('P3-A4 audit tier is auto-delivery for L4 engine events', () => {
  const f = setup({ autonomy: AUTO_DELIVERY_TIER })
  try {
    f.store.recordEvent({ type: 'test', scope: 'card', targetId: f.card.id, actor: 'autoRule', tier: AUTO_DELIVERY_TIER, rule: RULE_DELIVER })
    const events = f.store.state.events.filter((e) => e.type === 'test')
    assert.equal(events.length, 1)
    assert.equal(events[0].tier, AUTO_DELIVERY_TIER)
    assert.equal(events[0].rule, RULE_DELIVER)
  } finally { f.cleanup() }
})

test('P3-A5 return-to-plan default takeover is derived from tier, not hard-coded false', () => {
  const indexSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(indexSrc, /body\.takeOver === undefined/)
  assert.match(indexSrc, /\['machine-approve', 'auto-delivery'\]\.includes\(tier\)/)
  const clientSrc = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.doesNotMatch(clientSrc, /takeOver: false/, 'UI no longer forces takeOver:false')
})

test('P3-A6 defaultEngineDeps forwards deliver and runTick calls it at L4', async () => {
  const f = setup()
  try {
    const ctx = { get: () => undefined }
    const untouched = defaultEngineDeps({ ctx, store: f.store })
    assert.equal(Object.hasOwn(untouched, 'deliver'), false, 'backward compatible: no deliver key when omitted')

    const calls = []
    const deliver = async ({ cardId }) => { calls.push(cardId); return { delivered: true } }
    const deps = defaultEngineDeps({ ctx, store: f.store, deliver, ghPortFor: async () => ({}) })
    assert.equal(Object.hasOwn(deps, 'deliver'), true)
    assert.strictEqual(deps.deliver, deliver, 'the SAME function is forwarded')

    // The full 10-key contract runTick consumes must be present.
    for (const key of ['intake', 'ghPort', 'ghPortFor', 'dispatch', 'approve', 'continue', 'isSessionActive', 'resolveSandboxMode', 'readAutoReviewPluginState', 'deliver']) {
      assert.equal(Object.hasOwn(deps, key), true, `deps.${key} wired`)
    }

    const status = createEngineStatus()
    await runTick({ store: f.store, status, deps: {
      ...deps, intake: async () => ({ created: [] }),
      isSessionActive: async () => false,
    } })
    assert.deepEqual(calls, [f.card.id], 'runTick reached the forwarded deliver port')
    assert.equal(status.projects[0].delivered, 1)
  } finally { f.cleanup() }
})

test('P3-A7 index.js keeps BOTH verdict and delivery namespace exports', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(src, /export \* as verdict from '\.\/verdict\.js'/)
  assert.match(src, /export \* as delivery from '\.\/delivery\.js'/)
})

// ===========================================================================
// B — L0–L4 slider UI (AC 35, 44)
// ===========================================================================

const clientSrc = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const zhDict = JSON.parse(readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))
const enDict = JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))

test('P3-B1 single native range slider, pending/saved separation, upgrade confirm, independent save', () => {
  assert.match(clientSrc, /type: 'range', min: '0', max: '4', step: '1'/)
  assert.equal((clientSrc.match(/type: 'range'/g) || []).length, 1, 'exactly ONE range input')
  assert.ok(clientSrc.includes('const onRangeChange = (event) => setPending(Number(event?.target?.value))'), 'drag only changes pending')
  assert.match(clientSrc, /onPointerUp: onRangeCommit, onKeyUp: onRangeCommit/, 'commit on release / key up')
  assert.match(clientSrc, /if \(n > saved && n >= 3\) \{ setConfirmTarget\(n\); return \}/, 'L3/L4 upgrades confirm')
  assert.match(clientSrc, /const save = async \(\) => \{/, 'save is a separate explicit step')
  assert.match(clientSrc, /background: LEVEL_META\[saved\]\.wash/, 'badge reads saved only')
  assert.match(clientSrc, /minHeight: 44/, 'touch targets >= 44px')
  assert.match(clientSrc, /'aria-valuetext': ariaText/, 'aria-valuetext wired')
  assert.doesNotMatch(clientSrc, /role: 'switch', 'aria-checked': autoDispatch/, 'no independent autoDispatch switch')
})

test('P3-B2 cancel upgrade restores pending; downgrade never confirms', () => {
  assert.match(clientSrc, /onCancel: \(\) => \{ setConfirmTarget\(null\); setPending\(confirmed\) \}/, 'cancel rolls pending back')
  assert.match(clientSrc, /const moveTo = \(n\) => \{[\s\S]*?if \(n > saved && n >= 3\)/, 'only upgrades trigger confirm')
  assert.match(clientSrc, /const LEVEL_TIERS = \['manual', 'you-approve', 'you-approve', 'machine-approve', 'auto-delivery'\]/)
  assert.match(clientSrc, /autoDispatch: n === 2/, 'only L2 stores autoDispatch=true')
})

test('P3-B3 slider explainer copy is the PRD §7 endpoints, verbatim in both dicts', () => {
  // PRD §7 endpoint labels: 无 / Inbox 建卡 / 待批准计划 / 待评审 / 草稿 PR.
  const endpointLabels = ['无', 'Inbox 建卡', '待批准计划', '待评审', '草稿 PR']
  for (let n = 0; n <= 4; n += 1) {
    assert.equal(zhDict[`lvL${n}`], `L${n}`)
    assert.equal(enDict[`lvL${n}`], `L${n}`)
    assert.ok(zhDict[`leL${n}End`].startsWith(endpointLabels[n]), `zh L${n} endpoint label verbatim`)
    assert.match(zhDict[`leL${n}M`], /\S/, `zh L${n} machine line present`)
    assert.match(zhDict[`leL${n}Y`], /\S/, `zh L${n} human line present`)
    assert.equal(typeof enDict[`leL${n}End`], 'string')
  }
  assert.equal(zhDict.autoEndLabel, '自动化终点')
  assert.equal(zhDict.machineLabel, '机器')
  assert.equal(zhDict.youLabel, '你')
  assert.match(zhDict.ariaLevel, /L\{n\}.*第 \{ordinal\} 档/)
  assert.match(enDict.ariaLevel, /L\{n\}.*level \{ordinal\}/)
})

// ===========================================================================
// C — arm gate (AC 37–41)
// ===========================================================================

test('P3-C1 evaluate happy path: ok with head; no git writes during evaluation', async () => {
  const f = setup()
  try {
    const p = port()
    const out = await evaluateAutoDelivery(gate(f))
    assert.equal(out.ok, true)
    assert.equal(out.head, f.head)
    assert.equal(out.cardId, f.card.id)
    assert.equal(p.calls.length, 0)
  } finally { f.cleanup() }
})

test('P3-C2 every hard condition refuses before any git write', async () => {
  const cases = [
    ['tier not L4', (f) => f.store.updateAutonomy(f.project.id, { autonomy: 'machine-approve' }), /档位不是/],
    ['paused', (f) => { f.store._project(f.project.id).paused = true; f.store._commit() }, /已暂停/],
    ['taken over', (f) => { f.store._card(f.card.id).takenOver = true; f.store._commit() }, /已被人接管/],
    ['needs human info', (f) => { f.store._card(f.card.id).needsHumanInfo = true; f.store._commit() }, /待补充信息/],
    ['not review', (f) => f.store.transitionCard(f.card.id, 'build', 'human'), /仅用于 Review/],
    ['verdict not approved', (f) => { f.store._card(f.card.id).reviewVerdict.verdict = 'changes-requested'; f.store._commit() }, /不是 approved/],
    ['blocking present', (f) => { f.store._card(f.card.id).reviewVerdict.blocking = [{ file: 'a', line: 1, reason: 'x' }]; f.store._commit() }, /阻断项/],
    ['wrong reviewer', (f) => { f.store._card(f.card.id).reviewVerdict.reviewerSessionId = 'intruder'; f.store._commit() }, /不是本卡登记的评审会话/],
    ['head mismatch', (f) => { f.store._card(f.card.id).reviewVerdict.reviewedHead = 'f'.repeat(40); f.store._commit() }, /head 与当前 worktree HEAD 不一致/],
    ['protected branch', (f) => { f.store._card(f.card.id).branch = 'main'; f.store._commit() }, /受保护分支/],
    ['base branch', (f) => { f.store._card(f.card.id).branch = 'main'; f.store._card(f.card.id).baseBranch = 'main'; f.store._commit() }, /分支/],
    ['credential failure', (f, opts) => { opts.resolveIdentity = async () => { throw new Error('no token') } }, /凭证检查失败/],
    ['no resolver', (f, opts) => { opts.resolveIdentity = undefined }, /未提供仓库身份解析器/],
  ]
  for (const [label, mutate, expected] of cases) {
    const f = setup()
    try {
      const opts = gate(f)
      mutate(f, opts)
      const p = port()
      const out = await evaluateAutoDelivery(opts)
      assert.equal(out.ok, false, `${label} must refuse`)
      assert.match(out.reason, expected, label)
      assert.equal(p.calls.length, 0, `${label}: zero git calls`)
    } finally { f.cleanup() }
  }
})

test('P3-C3 forged / stale arm tokens are inert: execute re-evaluates the live card', async () => {
  const f = setup()
  try {
    HEAD_FOR_PORT = f.head
    const p = port()
    const forged = [
      { cardId: f.card.id, head: f.head, actor: 'auto-delivery', rule: RULE_DELIVER },
      { cardId: f.card.id, head: 'f'.repeat(40), actor: 'auto-delivery', rule: RULE_DELIVER },
      { cardId: f.card.id, head: f.head, actor: 'human', rule: RULE_DELIVER },
      undefined,
    ]
    // A malformed/unsigned token is always refused before git writes.
    for (const token of [forged[2], forged[3]]) {
      await assert.rejects(() => executeAutoDelivery({ store: f.store, token, port: p, readHead: () => f.head, resolveIdentity: async () => ({ git: {} }) }), /arm|令牌/)
      assert.equal(p.calls.length, 0, 'no git writes from a malformed token')
    }
    // Arm legitimately, then tamper the live verdict: even a perfectly formed
    // token must be re-checked against the seven conditions and refused.
    const arm = await armAutoDelivery(gate(f))
    assert.equal(arm.ok, true)
    f.store._card(f.card.id).reviewVerdict.verdict = 'changes-requested'
    f.store._commit()
    await assert.rejects(
      () => executeAutoDelivery({ store: f.store, token: arm.token, port: p, readHead: () => f.head, resolveIdentity: async () => ({ git: {} }) }),
      /arm 失效|不是 approved/,
    )
    assert.equal(p.calls.length, 0)
    // A forged-but-well-formed token cannot bypass a REFUSING gate either.
    await assert.rejects(
      () => executeAutoDelivery({ store: f.store, token: forged[0], port: p, readHead: () => f.head, resolveIdentity: async () => ({ git: {} }) }),
      /arm 失效|不是 approved/,
    )
    assert.equal(p.calls.length, 0)
  } finally { f.cleanup() }
})

test('P3-C4 head idempotency: second run writes nothing and reports alreadyDelivered', async () => {
  const f = setup()
  try {
    HEAD_FOR_PORT = f.head
    const p = port()
    const opts = gate(f)
    const first = await runAutoDelivery({ ...opts, port: p })
    assert.equal(first.delivered, true)
    const n = p.calls.length
    assert.ok(n >= 2)
    const second = await runAutoDelivery({ ...opts, port: p })
    assert.equal(second.delivered, false)
    assert.equal(second.alreadyDelivered, true)
    assert.equal(p.calls.length, n, 'repeat tick performs zero git calls')
    assert.equal(f.store.getCard(f.card.id).status, 'review', 'never auto-done')
  } finally { f.cleanup() }
})

test('P3-C5 clean reviewed tree: NO commit, push → DRAFT PR, full audit', async () => {
  const f = setup()
  try {
    const p = realPort()
    const res = await runAutoDelivery({ ...gate(f), port: p })
    assert.equal(res.delivered, true)
    assert.equal(res.state, 'delivered')
    assert.deepEqual(p.calls.map((c) => c[0]), ['worktreeExists', 'worktreeExists', 'isWorktreeClean', 'push', 'createPr'], 'real host checks worktree (arm+recheck), never commits the reviewed tree')
    assert.equal(p.calls.find((c) => c[0] === 'createPr')[1].draft, true, 'draft PR only')
    assert.equal(p.calls.find((c) => c[0] === 'push')[2], f.store.getCard(f.card.id).branch, 'pushes the card branch')
    const card = f.store.getCard(f.card.id)
    assert.equal(card.prUrl, 'https://github.com/o/r/pull/99')
    assert.equal(card.status, 'review', 'never auto-done')
    assert.equal(card.autoDelivery.state, 'delivered')
    const decisions = f.store.state.events.filter((e) => e.type === 'auto-delivery').map((e) => e.decision)
    for (const d of ['armed', 'commit-skipped', 'pushed', 'draft-pr', 'delivered']) {
      assert.ok(decisions.includes(d), `audit ${d}`)
    }
    assert.equal(decisions.includes('committed'), false, 'no commit on the real-host path')
    assert.equal(p.calls.some((c) => c[0] === 'forcePush' || c[0] === 'merge'), false)
  } finally { f.cleanup() }
})

test('P3-C5b dirty worktree: readable refusal with ZERO git writes', async () => {
  const f = setup()
  try {
    const p = realPort({ clean: false })
    const res = await runAutoDelivery({ ...gate(f), port: p })
    assert.equal(res.delivered, false)
    assert.match(res.reason, /工作树存在未提交改动；这些改动未经评审/)
    assert.equal(res.retryable, true)
    assert.deepEqual(p.calls.map((c) => c[0]), ['worktreeExists', 'worktreeExists', 'isWorktreeClean'], 'no push/createPr/commit/force')
    const card = f.store.getCard(f.card.id)
    assert.equal(card.status, 'review')
    assert.equal(card.autoDelivery.state, 'failed')
    assert.equal(card.prUrl, null)
    assert.equal(f.store.state.events.some((e) => e.type === 'auto-delivery' && e.decision === 'failed'), true)
  } finally { f.cleanup() }
})

test('P3-C6 existing PR: only push update, never a second createPr', async () => {
  const f = setup()
  try {
    f.store.setPrUrl(f.card.id, 'https://github.com/o/r/pull/1', 'human')
    const p = realPort()
    const res = await runAutoDelivery({ ...gate(f), port: p })
    assert.equal(res.delivered, true)
    assert.deepEqual(p.calls.map((c) => c[0]), ['worktreeExists', 'worktreeExists', 'isWorktreeClean', 'push'], 'existing PR: only push, no createPr, no commit')
    assert.equal(f.store.getCard(f.card.id).prUrl, 'https://github.com/o/r/pull/1')
    assert.equal(f.store.state.events.some((e) => e.type === 'auto-delivery' && e.decision === 'pushed'), true)
  } finally { f.cleanup() }
})

test('P3-C7 refusal audits carry tier auto-delivery', async () => {
  const f = setup({ autonomy: 'manual' })
  try {
    const out = await armAutoDelivery(gate(f))
    assert.equal(out.ok, false)
    const events = f.store.state.events.filter((e) => e.type === 'auto-delivery')
    assert.equal(events.length, 1)
    assert.equal(events[0].decision, 'refused')
    assert.equal(events[0].tier, AUTO_DELIVERY_TIER)
  } finally { f.cleanup() }
})

test('P3-C8 mid-execution failure keeps card in review with failed state (semantics probe)', async () => {
  const f = setup()
  try {
    const p = realPort()
    p.createPr = () => { p.calls.push(['createPr-failed']); throw new Error('gh down') }
    const res = await runAutoDelivery({ ...gate(f), port: p })
    assert.equal(res.delivered, false)
    assert.equal(res.retryable, true)
    const card = f.store.getCard(f.card.id)
    assert.equal(card.status, 'review')
    assert.equal(card.autoDelivery.state, 'failed')
    // The branch push already happened; commit did NOT (reviewed tree is HEAD).
    assert.deepEqual(p.calls.map((c) => c[0]), ['worktreeExists', 'worktreeExists', 'isWorktreeClean', 'push', 'createPr-failed'])
    assert.equal(f.store.state.events.some((e) => e.type === 'auto-delivery' && e.decision === 'failed'), true)
  } finally { f.cleanup() }
})

test('P3-C8b retry after mid-execution failure skips the already-done commit', async () => {
  const f = setup()
  try {
    const p = realPort()
    let failOnce = true
    p.createPr = (...a) => {
      p.calls.push(['createPr'])
      if (failOnce) { failOnce = false; throw new Error('gh down') }
      return 'https://github.com/o/r/pull/99'
    }
    const first = await runAutoDelivery({ ...gate(f), port: p })
    assert.equal(first.delivered, false)
    assert.equal(p.calls.filter((c) => c[0] === 'commit').length, 0)
    const pushesAfterFirst = p.calls.filter((c) => c[0] === 'push').length
    assert.equal(pushesAfterFirst, 1)
    const second = await runAutoDelivery({ ...gate(f), port: p })
    assert.equal(second.delivered, true, 'retry succeeds on the same head')
    assert.equal(p.calls.filter((c) => c[0] === 'commit').length, 0, 'real host never commits')
    assert.equal(p.calls.filter((c) => c[0] === 'push').length, pushesAfterFirst + 1, 'retry re-pushes the same head')
    assert.equal(f.store.getCard(f.card.id).status, 'review')
  } finally { f.cleanup() }
})

test('P3-C9 delivery is not a tool or an HTTP route (6 factory tools only)', async () => {
  const f = setup()
  try {
    const specs = factoryToolSpecs({ store: f.store }).map((s) => s.name)
    assert.deepEqual(specs.sort(), [
      'factory_create_project', 'factory_inspect_repo', 'factory_list_attention',
      'factory_list_work_items', 'factory_report', 'factory_transition_work_item',
    ].sort())
    assert.equal(specs.some((n) => /deliver/i.test(n)), false, 'no delivery tool is registered')
  } finally { f.cleanup() }
})
