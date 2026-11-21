/**
 * Dev self-check — silent-stuck gap: reviewStale flag + incremental re-review
 * scope field + canRedispatch relaxation + reviewStaleNotice.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { FactoryStore } from '../store.js'
import { reviewMessage, dispatchReview, followupReview } from '../dispatch.js'
import { buildSessionContext } from '../session-context.js'
import { ensureCommittedForAutoDelivery } from '../delivery.js'
import { factoryToolSpecs } from '../tools.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const client = readFileSync(join(root, 'client.js'), 'utf8')
const zh = JSON.parse(readFileSync(join(root, 'locale', 'zh.json'), 'utf8'))
const en = JSON.parse(readFileSync(join(root, 'locale', 'en.json'), 'utf8'))
const A = 'a'.repeat(40); const B = 'b'.repeat(40); const C = 'c'.repeat(40)
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function fixture({ verdict = 'approved', blocking = [], reviewedHead } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'dev-stale-'))
  const repo = join(tmp, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q'); git(repo, 'checkout', '-qb', 'main')
  writeFileSync(join(repo, 'README.md'), '# p\n')
  git(repo, 'add', 'README.md'); git(repo, '-c', 'user.name=T', '-c', 'user.email=t@l', 'commit', '-qm', 'init')
  const head = reviewedHead ?? git(repo, 'rev-parse', 'HEAD').trim()
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: repo })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  const card = store.createCard({ boardId: board.id, title: 'c' })
  store.setWorktree(card.id, { worktreePath: repo, branch: 'factory/probe', baseBranch: 'main', sessionId: 'builder' })
  for (const [to, actor] of [['triage', 'human'], ['plan', 'agent'], ['plan-review', 'agent'], ['build', 'human'], ['review', 'agent']]) store.transitionCard(card.id, to, actor)
  store.setReviewSession(card.id, 'rev-1', 'created')
  store.updateAutonomy(project.id, { autonomy: 'auto-delivery' })
  if (verdict !== null) {
    store.appendReportWithVerdict(card.id, 'review', {
      cardId: card.id, source: 'review', verdict, reviewedHead: head,
      blocking, followUps: [], checks: [], reviewerSessionId: 'rev-1',
    }, 'agent')
  }
  return { store, project, card, repo, head, tmp, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

// ---------- store: reviewStale mark / clear ----------

test('Dev-Stale: card defaults clean; markReviewStale sets boolean + info + audit', () => {
  const f = fixture()
  try {
    assert.equal(f.store.getCard(f.card.id).reviewStale, false)
    assert.equal(f.store.getCard(f.card.id).reviewStaleInfo ?? null, null)
    f.store.markReviewStale(f.card.id, { previousReviewedHead: A, head: B })
    const c = f.store.getCard(f.card.id)
    assert.equal(c.reviewStale, true)
    assert.equal(c.reviewStaleInfo.previousReviewedHead, A)
    assert.equal(c.reviewStaleInfo.head, B)
    assert.equal(c.history.filter((e) => e.type === 'review-stale').length, 1)
    f.store.clearReviewStale(f.card.id, 'test')
    assert.equal(f.store.getCard(f.card.id).reviewStale, false)
    assert.equal(f.store.getCard(f.card.id).reviewStaleInfo ?? null, null)
  } finally { f.cleanup() }
})

test('Dev-Stale: setReviewSession clears stale (a dispatched reviewer owns the new head)', () => {
  const f = fixture()
  try {
    f.store.markReviewStale(f.card.id, { previousReviewedHead: A, head: B })
    f.store.setReviewSession(f.card.id, 'rev-2', 'reused')
    assert.equal(f.store.getCard(f.card.id).reviewStale, false)
  } finally { f.cleanup() }
})

test('Dev-Stale: a new verdict matching the stale head clears; a verdict on the old head does not', () => {
  for (const { vHead, expect } of [{ vHead: 'HEAD', expect: false }, { vHead: A, expect: true }]) {
    const f = fixture()
    try {
      f.store.markReviewStale(f.card.id, { previousReviewedHead: A, head: f.head })
      const head = vHead === 'HEAD' ? f.head : vHead
      f.store.appendReportWithVerdict(f.card.id, 'v2', {
        cardId: f.card.id, source: 'rereview', verdict: 'approved', reviewedHead: head,
        blocking: [], followUps: [], checks: [], reviewerSessionId: 'rev-1',
      }, 'agent')
      assert.equal(f.store.getCard(f.card.id).reviewStale, expect, `verdict on ${vHead}`)
    } finally { f.cleanup() }
  }
})

test('Dev-Stale: leaving review clears stale', () => {
  const f = fixture()
  try {
    f.store.markReviewStale(f.card.id, { previousReviewedHead: A, head: B })
    f.store.transitionCard(f.card.id, 'done', 'human')
    assert.equal(f.store.getCard(f.card.id).reviewStale, false)
  } finally { f.cleanup() }
})

// ---------- delivery: set stale on commit / head-sync ----------

test('Dev-Stale: autoCommit on a dirty tree marks the stale verdict', async () => {
  const f = fixture({ verdict: 'approved' })
  try {
    writeFileSync(join(f.repo, 'new.ts'), 'x') // dirty
    const port = { isWorktreeClean: () => false, add: () => {}, commit: () => B }
    const r = await ensureCommittedForAutoDelivery({ store: f.store, cardId: f.card.id, port })
    assert.equal(r.committed, true)
    const c = f.store.getCard(f.card.id)
    assert.equal(c.reviewStale, true)
    assert.equal(c.reviewStaleInfo.previousReviewedHead, f.head)
    assert.equal(c.reviewStaleInfo.head, B)
  } finally { f.cleanup() }
})

test('Dev-Stale: clean-tree commitSha≠head sync marks stale when verdict head drifted; skipped does not', async () => {
  const f = fixture({ verdict: 'approved', reviewedHead: C }) // verdict on C, current HEAD=f.head
  try {
    f.store.recordCommit(f.card.id, { sha: A, message: 'old' }) // commitSha ≠ current HEAD
    const port = { isWorktreeClean: () => true }
    const r = await ensureCommittedForAutoDelivery({ store: f.store, cardId: f.card.id, port })
    assert.equal(r.synced, true)
    assert.equal(f.store.getCard(f.card.id).reviewStale, true)
  } finally { f.cleanup() }
  const g = fixture()
  try {
    g.store.recordCommit(g.card.id, { sha: g.head, message: 'head' })
    const port = { isWorktreeClean: () => true }
    const r = await ensureCommittedForAutoDelivery({ store: g.store, cardId: g.card.id, port })
    assert.equal(r.skipped, true)
    assert.equal(g.store.getCard(g.card.id).reviewStale, false)
  } finally { g.cleanup() }
})

// ---------- reviewMessage: incremental scope lines ----------

test('Dev-Stale: reviewMessage emits previousReviewedHead + blocking-version scope line', () => {
  const msg = reviewMessage({
    card: { id: 'c1', prUrl: null }, reviewedHead: B, previousReviewedHead: A,
    previousVerdict: { verdict: 'changes-requested', blocking: [{ file: 'x', line: 1, reason: 'r' }] },
  })
  assert.match(msg, /previousReviewedHead: a{40}/)
  assert.match(msg, /reviewedHead: b{40}/)
  assert.match(msg, /Rereview scope: your previous verdict was on a{40}/)
  assert.match(msg, /delta a{40}\.\.b{40}/)
  assert.match(msg, /Verify each earlier blocking finding/)
})

test('Dev-Stale: reviewMessage approved-version scope line (no blocking reconciliation)', () => {
  const msg = reviewMessage({
    card: { id: 'c1', prUrl: null }, reviewedHead: B, previousReviewedHead: A,
    previousVerdict: { verdict: 'approved', blocking: [] },
  })
  assert.match(msg, /approved a{40} with no blocking findings/)
  assert.doesNotMatch(msg, /Verify each earlier blocking finding/)
})

test('Dev-Stale: no scope block when no previous head or heads equal (first-review regression)', () => {
  const none = reviewMessage({ card: { id: 'c1', prUrl: null }, reviewedHead: B, previousVerdict: null })
  assert.match(none, /previousReviewedHead: —/)
  assert.doesNotMatch(none, /Rereview scope:/)
  const same = reviewMessage({ card: { id: 'c1' }, reviewedHead: B, previousReviewedHead: B, previousVerdict: { verdict: 'approved', blocking: [] } })
  assert.doesNotMatch(same, /Rereview scope:/)
})

// ---------- session-context: fields + variables + skill choice ----------

test('Dev-Stale: buildSessionContext injects previousReviewedHead + scope + factory variable', () => {
  const f = fixture()
  try {
    const card = f.store.getCard(f.card.id)
    const built = buildSessionContext({ card, project: f.project, reviewMode: true, review: {
      reviewedHead: B, previousReviewedHead: f.head, sandboxMode: 'read-only',
    } })
    assert.equal(built.previousReviewedHead, f.head)
    assert.match(built.sectionText, /previousReviewedHead: [0-9a-f]{40}/)
    assert.match(built.sectionText, /Rereview scope:/)
    assert.match(built.firstMessage, /previousReviewedHead: [0-9a-f]{40}/)
    // variables map exposes the field for custom prompts
    const varsSrc = readFileSync(join(root, 'session-context.js'), 'utf8')
    assert.match(varsSrc, /factory_previous_reviewed_head/)
  } finally { f.cleanup() }
})

test('Dev-Stale: skill becomes factory-rereview on head drift even without review→build', () => {
  const f = fixture()
  try {
    const card = f.store.getCard(f.card.id)
    assert.equal(card.history.some((e) => e.type === 'transition' && e.from === 'review' && e.to === 'build'), false)
    const built = buildSessionContext({ card, project: f.project, reviewMode: true, review: {
      reviewedHead: B, previousReviewedHead: f.head, sandboxMode: 'read-only',
    } })
    assert.equal(built.skill, 'factory-rereview')
    // equal heads, no rereview flag -> stays first-review
    const first = buildSessionContext({ card, project: f.project, reviewMode: true, review: {
      reviewedHead: f.head, previousReviewedHead: f.head, sandboxMode: 'read-only',
    } })
    assert.equal(first.skill, 'factory-review')
  } finally { f.cleanup() }
})

test('Dev-Stale: dispatchReview + followupReview both pass previousReviewedHead from the verdict', async () => {
  const f = fixture()
  try {
    const captured = []
    const port = {
      createSession: async ({ firstMessage, setup }) => { captured.push(firstMessage); return { sessionId: 'rev-2' } },
      followupSession: async ({ message }) => { captured.push(message) },
      isSessionActive: async () => true,
      readHead: () => B,
    }
    await dispatchReview({ store: f.store, cardId: f.card.id, port })
    await followupReview({ store: f.store, cardId: f.card.id, port })
    assert.equal(captured.length, 2)
    for (const m of captured) assert.match(m, /previousReviewedHead: [0-9a-f]{40}/, 'both paths carry the field')
  } finally { f.cleanup() }
})

// ---------- safety ----------

test('Dev-Stale: factory_report schema never accepts previousReviewedHead / reviewedHead', () => {
  const toolsSrc = readFileSync(join(root, 'tools.js'), 'utf8')
  const block = toolsSrc.slice(toolsSrc.indexOf("name: 'factory_report'"), toolsSrc.indexOf("name: 'factory_", toolsSrc.indexOf("name: 'factory_report'") + 10))
  assert.ok(block.length > 0, 'factory_report block found')
  assert.doesNotMatch(block, /previousReviewedHead/, 'scope field is context only, never a report arg')
  assert.doesNotMatch(block, /reviewedHead: \{/, 'reviewedHead stays backend-computed (QA P1-AC1)')
  // verified against the real spec too (needs a store)
  const f = fixture()
  try {
    const specs = factoryToolSpecs({ store: f.store })
    const report = Array.isArray(specs) ? specs.find((x) => x.name === 'factory_report') : Object.values(specs).flat().find((x) => x?.name === 'factory_report')
    if (report) {
      assert.equal('previousReviewedHead' in report.parameters, false)
      assert.equal('reviewedHead' in report.parameters, false)
    }
  } finally { f.cleanup() }
})

// ---------- client UI ----------

test('Dev-Stale: canRedispatch relaxed to stale verdict; reviewStaleNotice priority + four dicts', () => {
  assert.match(client, /card\.reviewVerdict == null \|\| card\.reviewStale === true/, 'stale verdict also shows redispatch')
  const block = client.slice(client.indexOf('const noticeText ='), client.indexOf('}, noticeText'))
  assert.ok(block.indexOf("t('reviewStaleNotice')") < block.indexOf("t('autoDeliveryFailedNotice')"), 'stale notice outranks generic failure')
  assert.ok(block.indexOf("t('autoDeliveryFailedNotice')") < block.indexOf("t('reviewStalledNotice')"), 'generic failure outranks no-verdict')
  for (const [d, key] of [[zh, '自动'], [en, 'The code']]) {
    assert.equal(typeof d.reviewStaleNotice, 'string')
    assert.match(d.reviewStaleNotice, new RegExp(key))
    assert.doesNotMatch(d.reviewStaleNotice, /\{[^}]+\}/, 'no placeholders (AC-1.5)')
  }
  const inlineZh = client.slice(client.indexOf('const zh = {'), client.indexOf('const en = {'))
  const inlineEn = client.slice(client.indexOf('const en = {'))
  assert.match(inlineZh, /reviewStaleNotice: "[^"]*代码已提交/)
  assert.match(inlineEn, /reviewStaleNotice: "The code was committed/)
})
