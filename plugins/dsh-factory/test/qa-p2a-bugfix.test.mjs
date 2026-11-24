/**
 * QA — P2a bug-fix re-verification (builder self-verdict / swallowed reviewer).
 * Self-contained: throwaway git repo + fixed constants, no HEAD/git-state baseline.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FactoryStore } from '../store.js'
import { createApi } from '../api.js'
import { factoryToolSpecs } from '../tools.js'
import { normalizeVerdict } from '../verdict.js'
import { buildSessionContext, attachSessionContext } from '../session-context.js'
import { continueCard } from '../dispatch.js'

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function setup({ status = 'self-review', reviewSessionId = 'reviewer-1', prReviewSessionId = null } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-bugfix-'))
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
  const card = store.createCard({ boardId: board.id, title: 'review me' })
  store.setWorktree(card.id, { worktreePath: repo, branch: 'factory/test', baseBranch: 'main', sessionId: 'builder-1' })
  // Walk the REAL state machine to the requested phase (fixture only).
  const path = ['inbox', 'triage', 'plan', 'build', 'self-review', 'pr-review']
  const actorFor = { triage: 'human', plan: 'agent', build: 'agent', 'self-review': 'agent', 'pr-review': 'agent' }
  for (let i = 1; i <= path.indexOf(status); i += 1) {
    store.transitionCard(card.id, path[i], actorFor[path[i]])
  }
  if (reviewSessionId) store.setReviewSession(card.id, reviewSessionId, 'created')
  if (prReviewSessionId) store.setPrReviewSession(card.id, prReviewSessionId, 'created')
  return { store, project, card, repo, head: () => git(repo, 'rev-parse', 'HEAD').trim(), cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

const verdictArgs = (cardId, who = 'reviewer-1', source = 'review') => ({
  cardId, report: 'structured report', source, verdict: 'approved',
  blocking: [], followUps: [], checks: [{ name: 'probe', result: 'pass', tests: 'none' }],
  reviewerSessionId: who,
})
const execOf = (id) => ({ agent: { session: { id } } })
const historyOf = (store, id, type) => store.getCard(id).history.filter((h) => h.type === type)

// ---------- ① identity gate ----------

test('FIX-1 builder in self-review is REFUSED with a readable error; nothing written', async () => {
  const f = setup()
  try {
    const tool = new Map(factoryToolSpecs({ store: f.store }).map((s) => [s.name, s])).get('factory_report')
    await assert.rejects(
      () => tool.execute(verdictArgs(f.card.id, 'builder-1'), execOf('builder-1')),
      /builder 会话不能提交任何结构化 verdict/,
    )
    assert.equal(historyOf(f.store, f.card.id, 'report').length, 0, 'no report on refusal')
    assert.equal(historyOf(f.store, f.card.id, 'verdict').length, 0, 'no verdict on refusal')
    assert.equal(f.store.getCard(f.card.id).reviewVerdict, null)
  } finally { f.cleanup() }
})

test('FIX-1 reviewer in review succeeds; mirror reviewerSessionId equals reviewSessionId', async () => {
  const f = setup()
  try {
    const tool = new Map(factoryToolSpecs({ store: f.store }).map((s) => [s.name, s])).get('factory_report')
    const out = await tool.execute(verdictArgs(f.card.id, 'IGNORED-ARG'), execOf('reviewer-1'))
    assert.equal(out.verdict, 'approved')
    const v = historyOf(f.store, f.card.id, 'verdict')[0]
    assert.equal(v.reviewerSessionId, 'reviewer-1')
    assert.equal(f.store.getCard(f.card.id).reviewVerdict.reviewerSessionId, f.store.getCard(f.card.id).reviewSessionId)
    assert.equal(v.reviewedHead, f.head())
  } finally { f.cleanup() }
})

test('FIX-1 a self-review verdict needs a real self-review session: readable error, no write', async () => {
  const f = setup({ reviewSessionId: null })
  try {
    const tool = new Map(factoryToolSpecs({ store: f.store }).map((s) => [s.name, s])).get('factory_report')
    await assert.rejects(
      () => tool.execute(verdictArgs(f.card.id), execOf('outsider')),
      /尚未派出自审会话/,
      'no self session means no structured self verdict from any non-builder caller',
    )
    assert.equal(historyOf(f.store, f.card.id, 'report').length, 0)
    assert.equal(historyOf(f.store, f.card.id, 'verdict').length, 0)
  } finally { f.cleanup() }
})

test('FIX-1 non-review card without a self-review session rejects structured self verdicts', async () => {
  const f = setup({ status: 'build', reviewSessionId: null })
  try {
    const tool = new Map(factoryToolSpecs({ store: f.store }).map((s) => [s.name, s])).get('factory_report')
    await assert.rejects(
      () => tool.execute(verdictArgs(f.card.id, 'outsider'), execOf('outsider')),
      /尚未派出自审会话/,
      'no self-review session means no structured self verdict in ANY phase',
    )
    assert.equal(historyOf(f.store, f.card.id, 'report').length, 0, 'no free-text report on refusal')
    assert.equal(historyOf(f.store, f.card.id, 'verdict').length, 0, 'no verdict on refusal')
    assert.equal(f.store.getCard(f.card.id).reviewVerdict, null, 'mirror stays null')
  } finally { f.cleanup() }
})

test('FIX-1 builder with an existing reviewer session is refused at EVERY stage', async () => {
  for (const status of ['inbox', 'triage', 'plan', 'build', 'self-review', 'pr-review']) {
    const f = setup({ status, reviewSessionId: 'reviewer-1' })
    try {
      const tool = new Map(factoryToolSpecs({ store: f.store }).map((s) => [s.name, s])).get('factory_report')
      await assert.rejects(
        () => tool.execute(verdictArgs(f.card.id, 'builder-1'), execOf('builder-1')),
        /builder 会话不能提交任何结构化 verdict/,
        `${status}: builder must never self-certify`,
      )
      assert.equal(historyOf(f.store, f.card.id, 'report').length, 0, `${status}: no report`)
      assert.equal(historyOf(f.store, f.card.id, 'verdict').length, 0, `${status}: no verdict`)
      assert.equal(f.store.getCard(f.card.id).reviewVerdict, null, `${status}: mirror untouched`)
    } finally { f.cleanup() }
  }
})

test('FIX-1 a forged reviewerSessionId argument cannot impersonate the reviewer', async () => {
  for (const exec of [undefined, execOf('some-other-session')]) {
    const f = setup({ status: 'self-review', reviewSessionId: 'reviewer-1' })
    try {
      const tool = new Map(factoryToolSpecs({ store: f.store }).map((s) => [s.name, s])).get('factory_report')
      await assert.rejects(
        () => tool.execute(verdictArgs(f.card.id, 'reviewer-1'), exec),
        /只有本卡自审会话可以提交自审 verdict/,
      )
      assert.equal(historyOf(f.store, f.card.id, 'verdict').length, 0)
      assert.equal(f.store.getCard(f.card.id).reviewVerdict, null)
    } finally { f.cleanup() }
  }
})

test('FIX-1 typed gate: neither review session may submit the other verdict type', async () => {
  const f = setup({ status: 'pr-review', reviewSessionId: 'self-1', prReviewSessionId: 'pr-1' })
  try {
    const tool = new Map(factoryToolSpecs({ store: f.store }).map((s) => [s.name, s])).get('factory_report')
    await assert.rejects(
      () => tool.execute(verdictArgs(f.card.id, 'self-1', 'pr-review'), execOf('self-1')),
      /自审会话不能代交 PR 评审 verdict/,
    )
    await assert.rejects(
      () => tool.execute(verdictArgs(f.card.id, 'pr-1', 'review'), execOf('pr-1')),
      /PR 评审会话不能代交自审 verdict/,
    )
    assert.equal(historyOf(f.store, f.card.id, 'verdict').length, 0)
    assert.equal(f.store.getCard(f.card.id).reviewVerdict, null)
  } finally { f.cleanup() }
})

test('FIX-1 plain free-text reports are accepted at EVERY stage by the builder', async () => {
  for (const status of ['inbox', 'triage', 'plan', 'build', 'self-review', 'pr-review']) {
    const f = setup({ status, reviewSessionId: 'reviewer-1' })
    try {
      const tool = new Map(factoryToolSpecs({ store: f.store }).map((s) => [s.name, s])).get('factory_report')
      const out = await tool.execute({ cardId: f.card.id, report: `plain ${status}` }, execOf('builder-1'))
      assert.deepEqual(Object.keys(out).sort(), ['id', 'reports'], `${status}: plain report shape unchanged`)
      assert.equal(out.reports, 1)
      assert.equal(historyOf(f.store, f.card.id, 'report')[0].body, `plain ${status}`)
      assert.equal(historyOf(f.store, f.card.id, 'verdict').length, 0, `${status}: no verdict from plain report`)
    } finally { f.cleanup() }
  }
})

test('FIX-1 plain builder report in review still works (no false positive)', async () => {
  const f = setup()
  try {
    const tool = new Map(factoryToolSpecs({ store: f.store }).map((s) => [s.name, s])).get('factory_report')
    const out = await tool.execute({ cardId: f.card.id, report: 'plain builder note' }, execOf('builder-1'))
    assert.deepEqual(Object.keys(out).sort(), ['id', 'reports'])
    assert.equal(out.reports, 1)
    assert.equal(historyOf(f.store, f.card.id, 'report')[0].body, 'plain builder note')
    assert.equal(historyOf(f.store, f.card.id, 'verdict').length, 0)
  } finally { f.cleanup() }
})

// ---------- ② two-key idempotency ----------

test('FIX-2 early verdict by builder does NOT swallow reviewer verdict on the same head', () => {
  const f = setup({ status: 'build', reviewSessionId: null })
  try {
    const head = f.head()
    const base = verdictArgs(f.card.id, 'builder-1')
    const canonicalBuilder = normalizeVerdict(base, { reviewedHead: head, reviewerSessionId: 'builder-1' })
    const canonicalReviewer = normalizeVerdict(verdictArgs(f.card.id, 'reviewer-1'), { reviewedHead: head, reviewerSessionId: 'reviewer-1' })
    const first = f.store.appendReportWithVerdict(f.card.id, 'builder early', canonicalBuilder, 'agent')
    const second = f.store.appendReportWithVerdict(f.card.id, 'reviewer later', canonicalReviewer, 'agent')
    assert.equal(first.idempotent, false)
    assert.equal(second.idempotent, false, 'different session + same head is a new conclusion')
    const vs = historyOf(f.store, f.card.id, 'verdict')
    assert.equal(vs.length, 2)
    assert.deepEqual(vs.map((v) => v.reviewerSessionId), ['builder-1', 'reviewer-1'])
    assert.equal(historyOf(f.store, f.card.id, 'report').length, 2)
    assert.equal(f.store.getCard(f.card.id).reviewVerdict.reviewerSessionId, 'reviewer-1', 'mirror holds the latest accepted verdict')
  } finally { f.cleanup() }
})

test('FIX-2 same reviewer + same head stays idempotent', () => {
  const f = setup({ status: 'build', reviewSessionId: null })
  try {
    const canonical = normalizeVerdict(verdictArgs(f.card.id, 'reviewer-1'), { reviewedHead: f.head(), reviewerSessionId: 'reviewer-1' })
    const a = f.store.appendReportWithVerdict(f.card.id, 'first', canonical, 'agent')
    const b = f.store.appendReportWithVerdict(f.card.id, 'second', canonical, 'agent')
    assert.equal(a.idempotent, false)
    assert.equal(b.idempotent, true)
    assert.equal(historyOf(f.store, f.card.id, 'verdict').length, 1)
    assert.equal(historyOf(f.store, f.card.id, 'report').length, 2)
  } finally { f.cleanup() }
})

// ---------- ③ builder waiting state + AC8 ----------

const ADVANCE_RE = /advance through|factory_transition_work_item to advance/i
const REVIEW_SKILL_RE = /Read the `factory-review` skill|write a structured verdict with factory_report/i

test('FIX-3 builderMode in pr-review yields a WAITING context with no review/advance instructions', () => {
  const f = setup({ status: 'pr-review' })
  try {
    const built = buildSessionContext({
      card: f.store.getCard(f.card.id), project: f.project, builderMode: true,
    })
    assert.equal(built.skill, null)
    assert.deepEqual(built.nextPhases, [])
    assert.equal(REVIEW_SKILL_RE.test(built.sectionText), false)
    assert.match(built.sectionText, /Do NOT review/)
    assert.match(built.sectionText, /do NOT submit a structured verdict/)
    assert.match(built.firstMessage, /standing by/)
    assert.equal(ADVANCE_RE.test(built.firstMessage), false)
    assert.equal(REVIEW_SKILL_RE.test(built.firstMessage), false)
    assert.equal(built.sectionText.includes(f.card.id), true)
  } finally { f.cleanup() }
})

test('FIX-3 builderMode outside review leaves builder instructions untouched', () => {
  const f = setup({ status: 'build', reviewSessionId: null })
  try {
    const built = buildSessionContext({ card: f.store.getCard(f.card.id), project: f.project, builderMode: true })
    assert.match(built.sectionText, /advance through|factory_transition_work_item to advance/i)
    assert.notEqual(built.skill, null)
  } finally { f.cleanup() }
})

test('FIX-3 reviewMode wins over builderMode', () => {
  const f = setup({ status: 'self-review' })
  try {
    const built = buildSessionContext({
      card: f.store.getCard(f.card.id), project: f.project, builderMode: true,
      reviewMode: true, review: { reviewedHead: f.head(), sandboxMode: 'read-only' },
    })
    assert.equal(built.skill, 'factory-self-review')
    assert.match(built.sectionText, /INDEPENDENT REVIEW session/)
    assert.equal(built.sectionText.includes('standing by'), false)
  } finally { f.cleanup() }
})

test('FIX-3 attached section flips live: pr-review → waiting, pr-review→build → builder again (AC8)', () => {
  const f = setup({ status: 'pr-review' })
  try {
    const variables = {}
    let section = null
    const agentCtx = {
      systemPrompt: {
        variable: (name, provider) => { variables[name] = provider; return () => {} },
        section: (def) => { section = def; return () => {} },
        getSectionOrder: () => 61,
      },
    }
    const dispose = attachSessionContext({ agentCtx, store: f.store, cardId: f.card.id, builderMode: true })
    assert.equal(typeof dispose, 'function')
    const waiting = section.text()
    assert.match(waiting, /standing by|Do NOT review/i)
    assert.equal(waiting.includes('factory-self-review'), false)

    // A human sends the card back to build: the SAME session's live section must
    // become a builder section again without re-registration.
    f.store.transitionCard(f.card.id, 'build', 'human', '请补重试上限')
    const builderAgain = section.text()
    assert.match(builderAgain, /advance through|factory_transition_work_item to advance/i)
    assert.equal(builderAgain.includes('standing by'), false)
    dispose()
  } finally { f.cleanup() }
})

test('FIX-3/AC8 pr-review→build continuation still uses the ORIGINAL builder session', async () => {
  const f = setup({ status: 'pr-review' })
  try {
    f.store.transitionCard(f.card.id, 'build', 'human', '请补重试上限')
    const calls = []
    const port = {
      createWorktree: () => { throw new Error('no worktree on continuation') },
      removeWorktree: () => {},
      async isSessionActive() { return true },
      async followupSession(o) { calls.push(['followup', o.sessionId]) },
      async resumeSession(o) { calls.push(['resume', o.resumeSessionId]); return { sessionId: o.resumeSessionId } },
      async createSession(o) { calls.push(['create', o.workMode]); return { sessionId: 'new' } },
      async disposeSession() {},
    }
    const out = await continueCard({ store: f.store, cardId: f.card.id, port, message: 'please fix calc.js' })
    assert.equal(out.mode, 'followup')
    assert.equal(out.sessionId, 'builder-1')
    assert.deepEqual(calls, [['active', 'builder-1'], ['followup', 'builder-1']].filter((c) => c[0] !== 'active'))
  } finally { f.cleanup() }
})

test('FIX-3 API /status remains readable (no regression in route surface)', () => {
  const f = setup()
  try {
    const api = createApi({ store: f.store, build: 'test' })
    const res = api({ method: 'GET', route: '/status' })
    assert.equal(res.body.build, 'test')
    assert.ok('engine' in res.body)
  } finally { f.cleanup() }
})
