/**
 * QA — P2b acceptance tests (PRD §5.5 / §5.8 / §5.9 / §5.10, AC 9 / 17–30).
 * Self-contained: temp git repo, fixed constants, no HEAD/git-show baseline.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FactoryStore } from '../store.js'
import { createApi } from '../api.js'
import { runTick, createEngineStatus } from '../autonomy.js'
import { dispatchCard, continueCard, branchForCard, worktreeKeyForCard } from '../dispatch.js'
import { commitForExistingPr, pushExistingCard, createPrForCard } from '../git-exec.js'

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function setup({ status = 'inbox', withTraces = true } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-p2b-'))
  const repo = join(tmp, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q')
  git(repo, 'checkout', '-qb', 'main')
  writeFileSync(join(repo, 'README.md'), '# probe\n')
  git(repo, 'add', 'README.md')
  git(repo, '-c', 'user.name=QA', '-c', 'user.email=qa@local', 'commit', '-qm', 'initial')

  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: repo })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  const card = store.createCard({ boardId: board.id, title: 'probe' })
  if (withTraces) {
    store.setWorktree(card.id, {
      worktreePath: repo, branch: 'factory/probe', baseBranch: 'main',
      sessionId: 'builder-old',
    })
  }
  const path = ['inbox', 'triage', 'plan', 'build', 'self-review', 'pr-review']
  const actor = { triage: 'human', plan: 'agent', build: 'agent', 'self-review': 'agent', 'pr-review': 'agent' }
  for (let i = 1; i <= path.indexOf(status); i += 1) store.transitionCard(card.id, path[i], actor[path[i]])
  return {
    store, project, card, repo,
    head: () => git(repo, 'rev-parse', 'HEAD').trim(),
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  }
}

const historyOf = (store, id, type) => store.getCard(id).history.filter((h) => h.type === type)
const fakePort = ({ failWorktree = false } = {}) => {
  const calls = { worktree: [], session: [], followup: [], disposed: [] }
  return {
    calls,
    createWorktree: (o) => { calls.worktree.push(o); if (failWorktree) throw new Error('worktree boom') },
    removeWorktree: () => {},
    async createSession(o) { calls.session.push(o); return { sessionId: 'builder-new', handle: { dispose() {} } } },
    async isSessionActive() { return true },
    async followupSession(o) { calls.followup.push(o) },
    async resumeSession(o) { calls.resume.push(o); return { sessionId: o.resumeSessionId } },
    async disposeSession() {},
  }
}

// ===========================================================================
// A — human returns (AC 17–24)
// ===========================================================================

test('P2b-A1 human-review record: note mandatory, pr-review-only, all fields present', () => {
  const f = setup({ status: 'pr-review' })
  try {
    for (const bad of ['', '   ', undefined]) {
      assert.throws(() => f.store.recordHumanReview(f.card.id, { decision: 'return-to-build', text: bad }), /修改意见|缺少必填/)
    }
    assert.equal(historyOf(f.store, f.card.id, 'human-review').length, 0)
    f.store._card(f.card.id).reviewVerdict = { reviewedHead: f.head() }
    f.store._card(f.card.id).prUrl = 'https://github.com/o/r/pull/7'
    f.store._commit()
    const entry = f.store.recordHumanReview(f.card.id, { decision: 'return-to-build', text: '  修 calc.js  ', actor: 'human' })
    assert.equal(entry.type, 'human-review')
    assert.equal(entry.actor, 'human')
    assert.equal(entry.decision, 'return-to-build')
    assert.equal(entry.text, '修 calc.js')
    assert.equal(entry.head, f.head())
    assert.equal(entry.prUrl, 'https://github.com/o/r/pull/7')
    assert.equal(historyOf(f.store, f.card.id, 'human-review').length, 1)
  } finally { f.cleanup() }
})

test('P2b-A2 plan-feedback record: note mandatory, plan-only, fixed decision', () => {
  const f = setup({ status: 'plan' })
  try {
    assert.throws(() => f.store.recordPlanFeedback(f.card.id, { text: '  ' }), /缺少必填/)
    const e = f.store.recordPlanFeedback(f.card.id, { text: '重做计划' })
    assert.deepEqual(
      { type: e.type, actor: e.actor, decision: e.decision, text: e.text },
      { type: 'plan-feedback', actor: 'human', decision: 'return-to-plan', text: '重做计划' },
    )
    const g = setup({ status: 'pr-review' })
    try { assert.throws(() => g.store.recordPlanFeedback(g.card.id, { text: 'x' }), /Plan-review|计划修改意见/) } finally { g.cleanup() }
  } finally { f.cleanup() }
})

test('P2b-A3 self-review→build carries note to the ORIGINAL builder and keeps reviewSessionId', async () => {
  const f = setup({ status: 'self-review' })
  try {
    f.store.setReviewSession(f.card.id, 'reviewer-1', 'created')
    const reviewerBefore = f.store.getCard(f.card.id).reviewSessionId
    const moved = f.store.transitionCard(f.card.id, 'build', 'agent', '请补重试上限')
    assert.equal(moved.status, 'build')
    assert.equal(historyOf(f.store, f.card.id, 'transition').at(-1).note, '请补重试上限')
    const port = fakePort()
    const out = await continueCard({ store: f.store, cardId: f.card.id, port, message: '请补重试上限' })
    assert.equal(out.mode, 'followup')
    assert.equal(out.sessionId, 'builder-old', 'builder session, never reviewer')
    assert.equal(port.calls.followup[0].sessionId, 'builder-old')
    assert.equal(port.calls.followup[0].message, '请补重试上限')
    assert.equal(f.store.getCard(f.card.id).reviewSessionId, reviewerBefore, 'reviewer id unchanged')
  } finally { f.cleanup() }
})

test('P2b-A4 synthetic rollback edge stays agent-only; human cannot plan→plan-review', () => {
  const f = setup({ status: 'plan' })
  try {
    // V4 has no plan-review status: a failed continuation rolls back plan in
    // place, and plan→build is the autoRule/approval edge.
    assert.throws(() => f.store.transitionCard(f.card.id, 'plan', 'agent'), /already|幂等|非法|no transition|不允许/)
    assert.equal(f.store.getCard(f.card.id).status, 'plan', 'a same-status transition is refused or a no-op, never a state change')
    f.store.transitionCard(f.card.id, 'build', 'autoRule')
    assert.equal(f.store.getCard(f.card.id).status, 'build', 'the engine approves plan→build')
    assert.throws(() => f.store.transitionCard(f.card.id, 'build', 'syncRule'), /不允许|非法/, 'remote sync may never open the plan gate')
  } finally { f.cleanup() }
})

test('P2b-A5 generic pr-review→build with empty/missing note is refused with zero state change', () => {
  for (const body of [{ to: 'build', actor: 'human' }, { to: 'build', actor: 'human', note: '' }, { to: 'build', actor: 'human', note: '   ' }]) {
    const f = setup({ status: 'pr-review' })
    try {
      const api = createApi({ store: f.store })
      const before = historyOf(f.store, f.card.id, 'transition').length
      const res = api({ method: 'POST', route: `/cards/${f.card.id}/transition`, body })
      assert.equal(res.status, 400)
      assert.match(res.body.error, /退回构建必须填写修改意见/)
      assert.equal(f.store.getCard(f.card.id).status, 'pr-review', 'card stays in pr-review')
      assert.equal(historyOf(f.store, f.card.id, 'human-review').length, 0, 'no structured record')
      assert.equal(historyOf(f.store, f.card.id, 'transition').length, before, 'no new transition record')
    } finally { f.cleanup() }
  }
})

test('P2b-A5b generic plan→plan with empty/missing note is refused with zero state change', () => {
  for (const body of [{ to: 'plan', actor: 'human' }, { to: 'plan', actor: 'human', note: '' }]) {
    const f = setup({ status: 'plan' })
    try {
      const before = historyOf(f.store, f.card.id, 'transition').length
      const res = createApi({ store: f.store })({ method: 'POST', route: `/cards/${f.card.id}/transition`, body })
      // V4: plan is a live agent stage with no human return-to-plan edge; the
      // generic route must not silently accept a same-status "return".
      assert.notEqual(res.status, 200, 'a same-status plan→plan is not a legal transition')
      assert.equal(f.store.getCard(f.card.id).status, 'plan')
      assert.equal(historyOf(f.store, f.card.id, 'plan-feedback').length, 0)
      assert.equal(historyOf(f.store, f.card.id, 'transition').length, before, 'no new transition record')
    } finally { f.cleanup() }
  }
})

test('P2b-A6 a valid generic pr-review→build note IS recorded (single store-layer write)', () => {
  const f = setup({ status: 'pr-review' })
  try {
    createApi({ store: f.store })({ method: 'POST', route: `/cards/${f.card.id}/transition`, body: { to: 'build', actor: 'human', note: '补超时' } })
    assert.equal(f.store.getCard(f.card.id).status, 'build')
    assert.equal(historyOf(f.store, f.card.id, 'human-review').length, 1, 'written once by transitionCard')
    assert.equal(historyOf(f.store, f.card.id, 'human-review')[0].text, '补超时')
  } finally { f.cleanup() }

  const g = setup({ status: 'plan' })
  try {
    createApi({ store: g.store })({ method: 'POST', route: `/cards/${g.card.id}/transition`, body: { to: 'build', actor: 'human', note: '跳过自动批准' } })
    // V4 keeps no human plan→build edge (plan approval is machine/human-UI only);
    // the generic route refuses it rather than opening a new human edge.
    assert.notEqual(g.store.getCard(g.card.id).status, 'build')
  } finally { g.cleanup() }
})

// ===========================================================================
// B — return to Inbox + resupply (AC 25–30)
// ===========================================================================

test('P2b-B1 triage→inbox requires reason; archives traces; sets flag; writes both records', () => {
  const f = setup({ status: 'triage' })
  try {
    assert.throws(() => f.store.transitionCard(f.card.id, 'inbox', 'human', '  '), /退回 Inbox 必须填写原因/)
    assert.equal(f.store.getCard(f.card.id).status, 'triage')
    f.store.transitionCard(f.card.id, 'inbox', 'human', '缺少复现步骤')
    const card = f.store.getCard(f.card.id)
    assert.equal(card.status, 'inbox')
    assert.equal(card.needsHumanInfo, true)
    for (const k of ['sessionId', 'worktreePath', 'branch', 'baseBranch']) assert.equal(card[k], null, `${k} cleared`)
    assert.equal(card.pendingDispatch, null)
    assert.equal(card.dispatchFailures, 0)
    assert.equal(card.stalled, false)
    const archived = historyOf(f.store, f.card.id, 'session-archived')
    assert.equal(archived.length, 1)
    assert.equal(archived[0].sessionId, 'builder-old')
    assert.equal(archived[0].worktreePath, f.repo)
    assert.equal(archived[0].branch, 'factory/probe')
    assert.equal(archived[0].baseBranch, 'main')
    assert.equal(archived[0].reason, '缺少复现步骤')
    assert.equal(historyOf(f.store, f.card.id, 'triage-return')[0].reason, '缺少复现步骤')
  } finally { f.cleanup() }
})

test('P2b-B2 bare dispatch of a flagged card is refused; no session/worktree created', async () => {
  const f = setup({ status: 'inbox' })
  try {
    f.store.transitionCard(f.card.id, 'triage', 'human')
    f.store.transitionCard(f.card.id, 'inbox', 'human', '缺信息')
    const port = fakePort()
    await assert.rejects(() => dispatchCard({ store: f.store, cardId: f.card.id, port }), /待补充信息|不能绕过/)
    assert.equal(port.calls.worktree.length, 0)
    assert.equal(port.calls.session.length, 0)
    assert.equal(f.store.getCard(f.card.id).status, 'inbox')
    assert.equal(f.store.getCard(f.card.id).needsHumanInfo, true)
  } finally { f.cleanup() }
})

test('P2b-B3 resupply: new session, extra first message, card triage, flag cleared + inbox-resupply', async () => {
  const f = setup({ status: 'inbox' })
  try {
    f.store.transitionCard(f.card.id, 'triage', 'human')
    f.store.transitionCard(f.card.id, 'inbox', 'human', '上次缺少复现步骤')
    const port = fakePort()
    const extra = [
      '人工补充信息（新会话必须据此继续，不要重复追问已说明的信息）：',
      '复现步骤是按 F5 后点按钮',
      '上次退回原因：上次缺少复现步骤',
    ].join('\n')
    const out = await dispatchCard({ store: f.store, cardId: f.card.id, port, firstMessageExtra: extra })
    assert.equal(out.sessionId, 'builder-new')
    assert.notEqual(out.sessionId, 'builder-old')
    assert.notEqual(port.calls.worktree[0].worktreePath, f.repo, 'new worktree path')
    assert.match(port.calls.session[0].firstMessage, /复现步骤是按 F5 后点按钮/)
    assert.match(port.calls.session[0].firstMessage, /上次缺少复现步骤/)
    assert.match(port.calls.session[0].firstMessage, new RegExp(f.card.id), 'standard context preserved')

    const card = f.store.resupplyInbox(f.card.id, { text: '复现步骤是按 F5 后点按钮' })
    assert.equal(card.status, 'triage')
    assert.equal(card.needsHumanInfo, false)
    assert.equal(card.sessionId, 'builder-new')
    const entry = historyOf(f.store, f.card.id, 'inbox-resupply')[0]
    assert.equal(entry.text, '复现步骤是按 F5 后点按钮')
    assert.equal(entry.previousReason, '上次缺少复现步骤')
  } finally { f.cleanup() }
})

test('P2b-B4 engine tick skips flagged cards and dispatches them once unflagged', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-p2b-tick-'))
  try {
    const store = new FactoryStore({ file: join(tmp, 'f.json') })
    const project = store.createProject({ name: 'p', rootPath: '/workspace/p' })
    const board = store.createBoard({ projectId: project.id, name: 'b' })
    // V4: no tier to set; the default full-auto rules are what dispatches.
    store.updateIntake(project.id, { issueRepo: 'o/r', intakeBoardId: board.id })
    const flagged = store.createCard({ boardId: board.id, title: 'flagged' })
    store._card(flagged.id).needsHumanInfo = true
    store._commit()
    const status = createEngineStatus()
    let dispatchCalls = 0
    const deps = {
      ghPort: {}, intake: async () => ({ created: [] }),
      dispatch: async () => { dispatchCalls += 1; return { mode: 'created' } },
      isSessionActive: async () => false,
    }
    await runTick({ store, status, deps })
    assert.equal(dispatchCalls, 0, 'flagged card never auto-dispatched')
    assert.match(status.projects[0].reason, /no eligible Inbox card/)
    store.resupplyInbox(flagged.id, { text: '补充' })
    await runTick({ store, status, deps })
    assert.equal(dispatchCalls, 1, 'unflagged card is dispatchable again')
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('P2b-B5 failed resupply dispatch keeps flag + Inbox, retryable', async () => {
  const f = setup({ status: 'inbox' })
  try {
    f.store.transitionCard(f.card.id, 'triage', 'human')
    f.store.transitionCard(f.card.id, 'inbox', 'human', '缺信息')
    await assert.rejects(
      () => dispatchCard({ store: f.store, cardId: f.card.id, port: fakePort({ failWorktree: true }), firstMessageExtra: '补充' }),
      /worktree boom/,
    )
    const card = f.store.getCard(f.card.id)
    assert.equal(card.status, 'inbox')
    assert.equal(card.needsHumanInfo, true)
    assert.equal(historyOf(f.store, f.card.id, 'inbox-resupply').length, 0)
    const out = await dispatchCard({ store: f.store, cardId: f.card.id, port: fakePort(), firstMessageExtra: '补充' })
    assert.equal(out.mode, 'created')
  } finally { f.cleanup() }
})

// ===========================================================================
// C — push-existing (AC 9)
// ===========================================================================

function gitPort() {
  const calls = []
  return {
    calls,
    add: (...a) => calls.push(['add', ...a]),
    commit: (...a) => { calls.push(['commit', ...a]); return 'new-sha-' + a.length },
    reset: (...a) => calls.push(['reset', ...a]),
    push: (...a) => calls.push(['push', ...a]),
    createPr: () => { calls.push(['createPr']); throw new Error('createPr must not be called') },
    merge: () => { calls.push(['merge']); throw new Error('merge must not be called') },
    hasDiff: (...a) => { calls.push(['hasDiff', ...a]); return true },
  }
}

function reviewWithPr() {
  const f = setup({ status: 'pr-review' })
  f.store.recordCommit(f.card.id, { sha: 'old-sha', message: 'first' })
  f.store.setPrUrl(f.card.id, 'https://github.com/o/r/pull/7')
  return f
}

test('P2b-C1 second commit for existing PR changes commitSha; existing commitCard still refuses', async () => {
  const f = reviewWithPr()
  try {
    await assert.rejects(async () => {
      const { commitCard } = await import('../git-exec.js')
      const p = gitPort()
      await commitCard({ store: f.store, cardId: f.card.id, port: p })
    }, /已有 PR|已提交|授权/)
    const port = gitPort()
    await assert.rejects(() => commitForExistingPr({ store: f.store, cardId: f.card.id, port }), /缺少「确认提交」授权/)
    f.store.authorize(f.card.id, 'confirm-commit')
    const out = await commitForExistingPr({ store: f.store, cardId: f.card.id, port, message: 'rework' })
    assert.equal(out.sha.startsWith('new-sha'), true)
    assert.notEqual(f.store.getCard(f.card.id).commitSha, 'old-sha')
    assert.deepEqual(port.calls.map((c) => c[0]), ['add', 'commit'])
  } finally { f.cleanup() }
})

test('P2b-C2 push-existing updates the SAME draft PR: no force/createPr/merge, auth consumed', async () => {
  const f = reviewWithPr()
  try {
    const port = gitPort()
    await assert.rejects(() => pushExistingCard({ store: f.store, cardId: f.card.id, port }), /缺少「推送更新草稿 PR」授权/)
    assert.equal(port.calls.length, 0)
    f.store.authorize(f.card.id, 'push-existing')
    const out = await pushExistingCard({ store: f.store, cardId: f.card.id, port })
    assert.equal(out.url, 'https://github.com/o/r/pull/7')
    assert.equal(out.sha, 'old-sha')
    const card = f.store.getCard(f.card.id)
    assert.equal(card.prUrl, 'https://github.com/o/r/pull/7', 'same PR, never rewritten')
    assert.equal(card.pendingAuthorization, null, 'authorization consumed')
    assert.equal(historyOf(f.store, f.card.id, 'push-existing').length, 1)
    assert.deepEqual(port.calls.map((c) => c[0]), ['hasDiff', 'push'], 'no force/createPr/merge')
    assert.equal(port.calls.filter((c) => c[0] === 'push')[0].length, 3, 'push(worktree, branch) only')
  } finally { f.cleanup() }
})

test('P2b-C3 push-existing refuses protected / base branch and missing diff with zero git writes', async () => {
  for (const branch of ['main', 'master', 'trunk', 'develop', 'main']) {
    const f = reviewWithPr()
    try {
      f.store._card(f.card.id).branch = branch
      f.store._commit()
      f.store.authorize(f.card.id, 'push-existing')
      const port = gitPort()
      await assert.rejects(() => pushExistingCard({ store: f.store, cardId: f.card.id, port }), /受保护分支|base 分支/)
      assert.equal(port.calls.length, 0, `${branch}: zero writes`)
    } finally { f.cleanup() }
  }
  const f = reviewWithPr()
  try {
    f.store.authorize(f.card.id, 'push-existing')
    const port = gitPort()
    port.hasDiff = () => false
    await assert.rejects(() => pushExistingCard({ store: f.store, cardId: f.card.id, port }), /没有可推送的改动/)
    assert.equal(port.calls.length, 0)
  } finally { f.cleanup() }
})

test('P2b-C4 createPrForCard still refuses an existing PR', async () => {
  const f = reviewWithPr()
  try {
    f.store.authorize(f.card.id, 'create-pr')
    const port = gitPort()
    await assert.rejects(() => createPrForCard({ store: f.store, cardId: f.card.id, port }), /已有 PR/)
    assert.equal(port.calls.length, 0)
  } finally { f.cleanup() }
})

// ===========================================================================
// BUG 1 fix — per-attempt branch / worktree naming (AC29/30)
// ===========================================================================

test('P2b-B6 naming helpers are backward compatible and suffix per redispatch', () => {
  const id = 'card-xyz'
  assert.equal(branchForCard(id), 'factory/card-xyz')
  assert.equal(branchForCard(id, 0), 'factory/card-xyz')
  assert.equal(branchForCard(id, 1), 'factory/card-xyz-r2')
  assert.equal(branchForCard(id, 2), 'factory/card-xyz-r3')
  assert.equal(worktreeKeyForCard(id), 'card-xyz')
  assert.equal(worktreeKeyForCard(id, 1), 'card-xyz-r2')
  assert.equal(worktreeKeyForCard(id, 2), 'card-xyz-r3')
  for (const bad of [undefined, null, -1, 1.5, '2']) {
    assert.equal(branchForCard(id, bad), 'factory/card-xyz', `bad count ${String(bad)} must not change the name`)
  }
})

test('P2b-B7 three redispatch cycles: -r2/-r3 names, old traces kept, original cardId in first message', async () => {
  const f = setup({ status: 'inbox', withTraces: false })
  try {
    const port = fakePort()
    const original = f.card.id
    const names = []
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const extra = attempt === 1 ? undefined : `补充第 ${attempt} 轮信息`
      const out = await dispatchCard({ store: f.store, cardId: original, port, firstMessageExtra: extra })
      names.push(out.branch)
      assert.equal(out.redispatchCount, attempt - 1)
      assert.equal(out.worktreePath.endsWith(attempt === 1 ? `/${original}` : `/${original}-r${attempt}`), true)
      assert.equal(out.sessionId, 'builder-new')
      // The standard context (original cardId) is never replaced by the suffixed key.
      const firstLine = port.calls.session.at(-1).firstMessage.split('\n')[0]
      assert.equal(firstLine, `Factory task ${original}: probe`, 'the cardId in the header remains the ORIGINAL id')
      assert.doesNotMatch(firstLine, new RegExp(`${original}-r`))
      if (extra) assert.match(port.calls.session.at(-1).firstMessage, new RegExp(extra))

      // dispatchCard already advanced Inbox → Triage.
      assert.equal(f.store.getCard(original).status, 'triage')
      f.store.transitionCard(original, 'inbox', 'human', `退回原因 ${attempt}`)
      f.store.resupplyInbox(original, { text: extra ?? '补充' })
    }
    assert.deepEqual(names, [`factory/${original}`, `factory/${original}-r2`, `factory/${original}-r3`])
    const worktrees = port.calls.worktree.map((w) => w.worktreePath)
    assert.equal(new Set(worktrees).size, 3, 'no worktree path collision')
    const archived = historyOf(f.store, original, 'session-archived')
    assert.equal(archived.length, 3)
    assert.deepEqual(archived.map((a) => a.branch), names, 'old branch names retained in history')
    assert.deepEqual(archived.map((a) => a.worktreePath), worktrees.slice(0, 3), 'old worktrees retained in history')
  } finally { f.cleanup() }
})
