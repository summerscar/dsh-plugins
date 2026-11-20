/**
 * QA — P1 acceptance tests (PRD .scratch/prd-review-and-auto-delivery.md
 * §5.2 / §5.3 / §9 P1 AC 1–3).
 *
 * Self-contained: a throwaway real git repo supplies the head, fixed constants
 * describe the verdict shape, and no assertion depends on HEAD, git show,
 * rebase or commit state of this project. Safe to run after P1 is committed.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FactoryStore } from '../store.js'
import { factoryToolSpecs } from '../tools.js'
import { buildSessionContext, attachSessionContext } from '../session-context.js'
import {
  normalizeVerdict, reviewedHeadFor, readHeadFromGit,
  FULL_SHA_RE, VERDICT_SOURCES, VERDICT_VALUES,
} from '../verdict.js'

const SHA40 = 'a'.repeat(40)
const SHA64 = 'b'.repeat(64)

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'qa-p1-repo-'))
  git(dir, 'init', '-q')
  git(dir, '-c', 'user.name=QA', '-c', 'user.email=qa@local', 'commit', '-q', '--allow-empty', '-m', 'initial')
  return { dir, head: () => git(dir, 'rev-parse', 'HEAD').trim() }
}

function setup({ cardStatus = 'inbox', repo = makeRepo(), receiptPorts = {}, readHead } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-p1-store-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: repo.dir })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  const card = store.createCard({ boardId: board.id, title: 'review me', repo: 'owner/repo' })
  store.setWorktree(card.id, { worktreePath: repo.dir, branch: 'factory/test', baseBranch: 'main' })
  // P2a hole-A closure: a structured verdict requires a registered reviewer.
  // These P1 capability tests exercise the verdict shape/idempotency, so give
  // the card a reviewer and let calls without an explicit exec act as it.
  const REVIEWER = 'p1-reviewer'
  store.setReviewSession(card.id, REVIEWER, 'created')
  if (cardStatus !== 'inbox') {
    store.transitionCard(card.id, 'triage', 'human')
    store.transitionCard(card.id, 'plan', 'agent')
    store.transitionCard(card.id, 'plan-review', 'agent')
    store.transitionCard(card.id, 'build', 'human')
    store.transitionCard(card.id, 'review', 'agent')
  }
  const allSpecs = factoryToolSpecs({ store, receiptPorts, readHead })
  const reportSpec = allSpecs.find((s) => s.name === 'factory_report')
  const baseExecute = reportSpec.execute
  reportSpec.execute = (args, exec) => baseExecute(args, exec ?? { agent: { id: REVIEWER, session: { id: REVIEWER } } })
  const specs = new Map(allSpecs.map((s) => [s.name, s]))
  return {
    store, project, card, repo, specs,
    cleanup: () => { rmSync(tmp, { recursive: true, force: true }); rmSync(repo.dir, { recursive: true, force: true }) },
  }
}

const verdictArgs = (cardId, extra = {}) => ({
  cardId,
  report: 'reviewed the diff; one blocker',
  source: 'review',
  verdict: 'changes-requested',
  blocking: [{ file: 'src/x.js', line: 12, reason: 'off-by-one' }],
  followUps: [{ text: 'rename the helper' }],
  checks: [{ name: 'tests', result: 'pass', tests: 'pnpm test' }],
  reviewerSessionId: 'sess-arg',
  ...extra,
})

const reportOf = (store, id) => store.getCard(id).history.filter((h) => h.type === 'report')
const verdictsOf = (store, id) => store.getCard(id).history.filter((h) => h.type === 'verdict')

// ===========================================================================
// AC1 — structured verdict writes eight fields, head from git, fail-closed
// ===========================================================================

test('P1-AC1 shape: constants are closed and full-SHA validation rejects short ids', () => {
  assert.deepEqual([...VERDICT_SOURCES], ['review', 'rereview'])
  assert.deepEqual([...VERDICT_VALUES], ['approved', 'changes-requested', 'verification-incomplete'])
  assert.equal(FULL_SHA_RE.test(SHA40), true)
  assert.equal(FULL_SHA_RE.test(SHA64), true)
  for (const bad of ['abc123', 'z'.repeat(40), '', SHA40.slice(0, 39)]) {
    assert.equal(FULL_SHA_RE.test(bad), false, `${bad} must not pass as a full SHA`)
  }
})

test('P1-AC1 eight fields land in history + mirror; head equals git rev-parse HEAD; fake head ignored', async () => {
  const f = setup()
  try {
    const gitHead = f.repo.head()
    const fake = 'f'.repeat(40)
    const out = await f.specs.get('factory_report').execute(verdictArgs(f.card.id, {
      reviewedHead: fake, // extra key: deliberately NOT in the parameter schema
    }))
    assert.equal(out.reports, 1)
    assert.equal(out.verdict, 'changes-requested')

    const card = f.store.getCard(f.card.id)
    assert.equal(reportOf(f.store, f.card.id).length, 1)
    assert.equal(reportOf(f.store, f.card.id)[0].body, 'reviewed the diff; one blocker')
    assert.equal(verdictsOf(f.store, f.card.id).length, 1)
    const v = verdictsOf(f.store, f.card.id)[0]
    assert.deepEqual(Object.keys(v).sort(), ['actor', 'at', 'blocking', 'cardId', 'checks', 'followUps', 'reviewerSessionId', 'reviewedHead', 'source', 'type', 'verdict'].sort())
    assert.equal(v.reviewedHead, gitHead, 'head is computed by git, not taken from the model')
    assert.notEqual(v.reviewedHead, fake, 'a fake reviewedHead must be ignored')
    assert.equal(v.cardId, f.card.id)
    assert.equal(v.source, 'review')
    assert.equal(v.verdict, 'changes-requested')
    assert.deepEqual(v.blocking, [{ file: 'src/x.js', line: 12, reason: 'off-by-one' }])
    assert.deepEqual(v.followUps, [{ text: 'rename the helper' }])
    assert.deepEqual(v.checks, [{ name: 'tests', result: 'pass', tests: 'pnpm test' }])
    assert.equal(v.reviewerSessionId, 'p1-reviewer', 'host exec identity wins over the argument')
    assert.equal(card.reviewVerdict.reviewedHead, gitHead, 'mirror matches too')
    assert.equal(card.reviewVerdict.recordedBy, 'agent')
  } finally { f.cleanup() }
})

test('P1-AC1 dirty worktree still reports the committed HEAD, not uncommitted edits', async () => {
  const f = setup()
  try {
    writeFileSync(join(f.repo.dir, 'dirty.txt'), 'uncommitted')
    const gitHead = f.repo.head()
    await f.specs.get('factory_report').execute(verdictArgs(f.card.id))
    assert.equal(verdictsOf(f.store, f.card.id)[0].reviewedHead, gitHead)
    assert.equal(f.store.getCard(f.card.id).reviewVerdict.reviewedHead, gitHead)
    assert.notEqual(gitHead, undefined)
  } finally { f.cleanup() }
})

test('P1-AC1 reviewerSessionId comes from host exec context; the argument cannot impersonate it', async () => {
  for (const [label, exec, expected] of [
    ['session id wins', { agent: { id: 'agent-id', session: { id: 'exec-session-id' } } }, 'exec-session-id'],
    ['agent id fallback', { agent: { id: 'exec-agent-id' } }, 'exec-agent-id'],
    ['argument ignored', { agent: { id: 'sess-arg' } }, 'sess-arg'],
  ]) {
    const f = setup()
    try {
      f.store.setReviewSession(f.card.id, expected, 'created')
      await f.specs.get('factory_report').execute(verdictArgs(f.card.id), exec)
      assert.equal(verdictsOf(f.store, f.card.id).at(-1).reviewerSessionId, expected, label)
    } finally { f.cleanup() }
  }
})

test('P1-AC1 partial / invalid verdict writes NOTHING (no report, no verdict, no mirror)', async () => {
  const cases = [
    ['missing verdict value', { verdict: undefined }],
    ['bad source', { source: 'rereview-twice' }],
    ['bad verdict enum', { verdict: 'maybe' }],
    ['missing blocking', { blocking: undefined }],
    ['missing checks', { checks: undefined }],
    ['bad blocking line', { blocking: [{ file: 'a', line: '12', reason: 'x' }] }],
    ['empty reviewer id', { reviewerSessionId: '' }],
  ]
  for (const [label, patch] of cases) {
    const f = setup()
    try {
      const args = verdictArgs(f.card.id, patch)
      if (patch.verdict === undefined) delete args.verdict
      if (patch.blocking === undefined) delete args.blocking
      if (patch.checks === undefined) delete args.checks
      await assert.rejects(() => f.specs.get('factory_report').execute(args), Error, label)
      const card = f.store.getCard(f.card.id)
      assert.equal(reportOf(f.store, f.card.id).length, 0, `${label}: report must not land`)
      assert.equal(verdictsOf(f.store, f.card.id).length, 0, `${label}: verdict must not land`)
      assert.equal(card.reviewVerdict, null, `${label}: mirror must stay null`)
    } finally { f.cleanup() }
  }
})

test('P1-AC1 receipt precheck failure aborts before any write and reports the stage', async () => {
  const failures = []
  const f = setup({
    receiptPorts: {
      validateSchema: () => ['value.verdict is not allowed'],
      onFailure: (e) => failures.push(e),
    },
  })
  try {
    await assert.rejects(
      () => f.specs.get('factory_report').execute(verdictArgs(f.card.id)),
      /output schema violations/,
    )
    assert.equal(reportOf(f.store, f.card.id).length, 0, 'no report on precheck failure')
    assert.equal(verdictsOf(f.store, f.card.id).length, 0, 'no verdict on precheck failure')
    assert.equal(f.store.getCard(f.card.id).reviewVerdict, null)
    assert.equal(failures.length, 1)
    assert.equal(failures[0].stage, 'value-schema')
    assert.equal(failures[0].tool, 'factory_report')
  } finally { f.cleanup() }
})

test('P1-AC1 plain report path is unchanged (no verdict keys → no verdict)', async () => {
  const f = setup()
  try {
    const out = await f.specs.get('factory_report').execute({ cardId: f.card.id, report: 'plain' })
    assert.deepEqual(Object.keys(out).sort(), ['id', 'reports'])
    assert.equal(out.reports, 1)
    assert.equal(reportOf(f.store, f.card.id).length, 1)
    assert.equal(verdictsOf(f.store, f.card.id).length, 0)
    assert.equal(f.store.getCard(f.card.id).reviewVerdict, null)
  } finally { f.cleanup() }
})

test('P1-AC1 tool schema keeps additionalProperties:false and excludes reviewedHead', () => {
  const f = setup()
  try {
    const spec = f.specs.get('factory_report')
    assert.equal('reviewedHead' in spec.parameters, false, 'agent must not supply a head')
    for (const key of ['blocking', 'followUps', 'checks']) {
      assert.equal(spec.parameters[key].items.additionalProperties, false, `${key} items are closed`)
    }
    assert.deepEqual(spec.output.schema.properties.verdict.enum, [...VERDICT_VALUES])
  } finally { f.cleanup() }
})

// ===========================================================================
// AC2 — idempotency by reviewed head
// ===========================================================================

test('P1-AC2 same head twice: idempotent, one verdict, two reports, mirror unchanged', async () => {
  const f = setup()
  try {
    const tool = f.specs.get('factory_report')
    const first = await tool.execute(verdictArgs(f.card.id))
    const second = await tool.execute(verdictArgs(f.card.id))
    assert.equal(first.idempotent === true, false, 'first submission is not idempotent')
    assert.equal(second.reports, 2)
    assert.equal(reportOf(f.store, f.card.id).length, 2)
    assert.equal(verdictsOf(f.store, f.card.id).length, 1, 'no second verdict for the same head')
    assert.equal(f.store.getCard(f.card.id).reviewVerdict.reviewedHead, f.repo.head())
  } finally { f.cleanup() }
})

test('P1-AC2 new commit: mirror advances, verdict history keeps both, reports keep all three', async () => {
  const f = setup()
  try {
    const tool = f.specs.get('factory_report')
    const oldHead = f.repo.head()
    await tool.execute(verdictArgs(f.card.id))
    await tool.execute(verdictArgs(f.card.id))
    git(f.repo.dir, '-c', 'user.name=QA', '-c', 'user.email=qa@local', 'commit', '-q', '--allow-empty', '-m', 'new head')
    const newHead = f.repo.head()
    assert.notEqual(newHead, oldHead)
    const third = await tool.execute(verdictArgs(f.card.id, { verdict: 'approved', blocking: [], source: 'rereview' }))
    assert.equal(third.verdict, 'approved')
    const card = f.store.getCard(f.card.id)
    assert.equal(card.reviewVerdict.reviewedHead, newHead, 'mirror follows the new head')
    assert.equal(verdictsOf(f.store, f.card.id).length, 2)
    assert.deepEqual(verdictsOf(f.store, f.card.id).map((v) => v.reviewedHead), [oldHead, newHead])
    assert.equal(verdictsOf(f.store, f.card.id)[0].verdict, 'changes-requested', 'older verdict retained')
    assert.equal(reportOf(f.store, f.card.id).length, 3)
  } finally { f.cleanup() }
})

// ===========================================================================
// AC3 — review session context isolation + fail-closed
// ===========================================================================

const REVIEW_OPTS = (head = SHA40) => ({ reviewMode: true, review: { reviewedHead: head, sandboxMode: 'read-only' } })
const ADVANCE_RE = /advance through|move the card yourself|factory_transition_work_item to advance/i

test('P1-AC3 review context has no advance/move wording, nine fields, empty nextPhases, review skill', () => {
  const f = setup({ cardStatus: 'review' })
  try {
    const built = buildSessionContext({ card: f.store.getCard(f.card.id), project: f.project, ...REVIEW_OPTS() })
    assert.equal(ADVANCE_RE.test(built.sectionText), false, 'sectionText must not tell the reviewer to advance')
    assert.equal(ADVANCE_RE.test(built.firstMessage), false, 'firstMessage must not tell the reviewer to advance')
    for (const key of ['cardId', 'phase', 'repo', 'branch', 'worktreePath', 'prUrl', 'reviewedHead', 'previousVerdict', 'commitSha']) {
      assert.ok(key in built, `missing review field ${key}`)
    }
    assert.equal(built.reviewedHead, SHA40)
    assert.deepEqual(built.nextPhases, [])
    assert.equal(built.skill, 'factory-review')
    assert.match(built.sectionText, /read-only/i)
    assert.ok(built.sectionText.includes('factory_report'))
  } finally { f.cleanup() }
})

test('P1-AC3 builder path stays unchanged: advance wording present, no review-only fields', () => {
  const f = setup()
  try {
    const built = buildSessionContext({ card: f.store.getCard(f.card.id), project: f.project })
    assert.equal(ADVANCE_RE.test(built.sectionText), true, 'builder still gets the advance instruction')
    assert.equal('reviewedHead' in built, false)
    assert.equal('previousVerdict' in built, false)
    assert.equal('commitSha' in built, false)
    assert.equal(built.skill, 'factory-triage')
  } finally { f.cleanup() }
})

test('P1-AC3 missing head / invalid SHA / writable sandbox fail closed at build time', () => {
  for (const [label, opts] of [
    ['missing head', { reviewMode: true, review: { sandboxMode: 'read-only' } }],
    ['invalid SHA', REVIEW_OPTS('deadbeef')],
    ['workspace-write sandbox', { reviewMode: true, review: { reviewedHead: SHA40, sandboxMode: 'workspace-write' } }],
  ]) {
    const f = setup({ cardStatus: 'review' })
    try {
      // A missing head with no injectable reader must fail: the fixture repo
      // exists, so supply a reader returning null to model "no readable head".
      const review = label === 'missing head'
        ? { sandboxMode: 'read-only', readHead: () => null }
        : opts.review
      assert.throws(
        () => buildSessionContext({ card: f.store.getCard(f.card.id), project: f.project, reviewMode: true, review }),
        /reviewedHead|只读沙箱/,
        label,
      )
    } finally { f.cleanup() }
  }
})

test('P1-AC3 attach fails before registering anything; valid attach exposes review variables', () => {
  for (const [label, review] of [
    ['no head', { sandboxMode: 'read-only', readHead: () => null }],
    ['writable', { reviewedHead: SHA40, sandboxMode: 'workspace-write' }],
  ]) {
    const f = setup({ cardStatus: 'review' })
    try {
      const variables = {}
      let section = null
      const agentCtx = {
        systemPrompt: {
          variable: (name) => { variables[name] = () => ''; return () => {} },
          section: () => { section = true; return () => {} },
          getSectionOrder: () => 61,
        },
      }
      assert.throws(
        () => attachSessionContext({ agentCtx, store: f.store, cardId: f.card.id, reviewMode: true, review }),
        /reviewedHead|只读沙箱/,
        label,
      )
      assert.deepEqual(Object.keys(variables), [], `${label}: no variable registered before the failure`)
      assert.equal(section, null, `${label}: no section registered before the failure`)
    } finally { f.cleanup() }
  }

  const f = setup({ cardStatus: 'review' })
  try {
    const variables = {}
    const agentCtx = {
      systemPrompt: {
        variable: (name, provider) => { variables[name] = provider; return () => {} },
        section: () => () => {},
        getSectionOrder: () => 61,
      },
    }
    const dispose = attachSessionContext({
      agentCtx, store: f.store, cardId: f.card.id, reviewMode: true,
      review: { reviewedHead: SHA40, sandboxMode: 'read-only' },
    })
    assert.equal(typeof dispose, 'function')
    assert.equal(variables.factory_reviewed_head(), SHA40)
    assert.equal(variables.factory_previous_verdict(), '')
    assert.equal(variables.factory_commit_sha(), '')
  } finally { f.cleanup() }
})

test('P1 AC helpers: git head read and injected port are both fail-closed', () => {
  const f = setup()
  try {
    assert.equal(reviewedHeadFor({ worktreePath: f.repo.dir }), f.repo.head())
    assert.throws(() => reviewedHeadFor({ worktreePath: f.repo.dir, readHead: () => 'short' }), /完整 SHA/)
    assert.throws(() => readHeadFromGit({ worktreePath: '' }), /worktreePath/)
    const canonical = normalizeVerdict({
      cardId: f.card.id, source: 'review', verdict: 'approved', blocking: [], followUps: [], checks: [], reviewerSessionId: 's',
    }, { reviewedHead: SHA64, reviewerSessionId: 'exec-wins' })
    assert.equal(canonical.reviewedHead, SHA64)
    assert.equal(canonical.reviewerSessionId, 'exec-wins')
    assert.throws(() => normalizeVerdict({}, { reviewedHead: 'short' }), /reviewedHead/)
  } finally { f.cleanup() }
})
