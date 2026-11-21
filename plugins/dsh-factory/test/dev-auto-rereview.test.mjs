/**
 * Dev self-check — A: automatic re-review, full enable with a per-card cap of 3.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { FactoryStore } from '../store.js'
import { runTick, createEngineStatus, AUTO_DELIVERY_TIER, AUTO_REREVIEW_LIMIT } from '../autonomy.js'
import { evaluateAutoDelivery } from '../delivery.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const A = 'a'.repeat(40); const B = 'b'.repeat(40)
const autonomySrc = readFileSync(join(root, 'autonomy.js'), 'utf8')
const indexSrc = readFileSync(join(root, 'index.js'), 'utf8')
const dispatchSrc = readFileSync(join(root, 'dispatch.js'), 'utf8')

function fixture({ autonomy = AUTO_DELIVERY_TIER, stale = false, count = 0, withReviewSession = true, verdictHead = A, noVerdict = false } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'dev-autorerereview-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: '/workspace/p' })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  const card = store.createCard({ boardId: board.id, title: 'c' })
  store.setWorktree(card.id, { worktreePath: '/tmp/wt', branch: 'factory/probe', baseBranch: 'main', sessionId: 'builder' })
  for (const [to, actor] of [['triage', 'human'], ['plan', 'agent'], ['plan-review', 'agent'], ['build', 'human'], ['review', 'agent']]) store.transitionCard(card.id, to, actor)
  if (withReviewSession) store.setReviewSession(card.id, 'rev-1', 'created')
  store.updateAutonomy(project.id, { autonomy })
  if (!noVerdict) store.appendReportWithVerdict(card.id, 'v1', {
    cardId: card.id, source: 'review', verdict: 'approved', reviewedHead: verdictHead,
    blocking: [], followUps: [], checks: [], reviewerSessionId: 'rev-1',
  }, 'agent')
  if (count !== 0) { store._card(card.id).autoRereviewCount = count; store._commit() }
  if (stale) store.markReviewStale(card.id, { previousReviewedHead: verdictHead, head: B })
  return { store, project, board, card, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

function depsFor(log, { clearStale = true } = {}) {
  return {
    ghPort: {}, intake: async () => ({ created: [] }), dispatch: async () => ({ mode: 'none' }),
    isSessionActive: async () => false,
    reviewDispatch: async ({ store, cardId }) => { log.push(`first:${cardId}`); store.setReviewSession(cardId, 'fresh', 'created') },
    reviewRereview: async ({ store, cardId }) => { log.push(`rereview:${cardId}`); if (clearStale) store.setReviewSession(cardId, 'rev-r', 'reused') },
    deliver: async () => ({ delivered: false }),
  }
}

test('Dev-AutoRereview: cap constant is 3', () => {
  assert.equal(AUTO_REREVIEW_LIMIT, 3)
})

test('Dev-AutoRereview: stale L4 card auto-dispatches a followup re-review and counts once', async () => {
  const f = fixture({ stale: true })
  try {
    const log = []
    const status = createEngineStatus()
    await runTick({ store: f.store, status, deps: depsFor(log) })
    assert.deepEqual(log, [`rereview:${f.card.id}`], 'stale card takes the re-review path, not first review')
    assert.equal(f.store.getCard(f.card.id).autoRereviewCount, 1, 'engine-initiated attempt counted')
    assert.equal(status.projects[0].autoRereviewed, 1, 'report counts it')
  } finally { f.cleanup() }
})

test('Dev-AutoRereview: same head is idempotent — a second tick does not re-dispatch', async () => {
  const f = fixture({ stale: true })
  try {
    const log = []
    const deps = depsFor(log)
    await runTick({ store: f.store, status: createEngineStatus(), deps })
    assert.equal(f.store.getCard(f.card.id).reviewStale, false, 'dispatch cleared stale on the head')
    await runTick({ store: f.store, status: createEngineStatus(), deps })
    assert.deepEqual(log, [`rereview:${f.card.id}`], 'no second dispatch for the same head')
    assert.equal(f.store.getCard(f.card.id).autoRereviewCount, 1, 'count unchanged on the second tick')
  } finally { f.cleanup() }
})

test('Dev-AutoRereview: at cap (3) no auto re-review; card stays in review and stale', async () => {
  const f = fixture({ stale: true, count: 3 })
  try {
    const log = []
    await runTick({ store: f.store, status: createEngineStatus(), deps: depsFor(log) })
    assert.deepEqual(log, [], 'no auto dispatch at the cap')
    const c = f.store.getCard(f.card.id)
    assert.equal(c.status, 'review')
    assert.equal(c.reviewStale, true, 'notice still shows')
    assert.equal(c.autoRereviewCount, 3, 'count not increased')
  } finally { f.cleanup() }
})

test('Dev-AutoRereview: manual redispatch is not counted (HTTP path never calls recordAutoRereview)', () => {
  assert.doesNotMatch(indexSrc, /review-dispatch[\s\S]{0,400}recordAutoRereview/, 'route does not count')
  assert.doesNotMatch(dispatchSrc, /recordAutoRereview/, 'dispatchReview/followupReview never count; counting is engine-only')
  assert.match(autonomySrc, /store\.recordAutoRereview/, 'only the engine tick counts')
})

test('Dev-AutoRereview: non-L4 tiers never auto re-review', async () => {
  for (const autonomy of ['manual', 'you-approve', 'machine-approve']) {
    const f = fixture({ autonomy, stale: true })
    try {
      const log = []
      await runTick({ store: f.store, status: createEngineStatus(), deps: depsFor(log) })
      assert.deepEqual(log, [], `${autonomy} does not auto re-review`)
    } finally { f.cleanup() }
  }
})

test('Dev-AutoRereview: a fresh verdict on the new head clears stale and the delivery gate no longer refuses on head mismatch', async () => {
  const f = fixture({ stale: true })
  try {
    // simulate the re-review session recording a matching verdict
    f.store.appendReportWithVerdict(f.card.id, 'v2', {
      cardId: f.card.id, source: 'rereview', verdict: 'approved', reviewedHead: B,
      blocking: [], followUps: [], checks: [], reviewerSessionId: 'rev-r',
    }, 'agent')
    assert.equal(f.store.getCard(f.card.id).reviewStale, false, 'stale cleared')
    const result = await evaluateAutoDelivery({
      store: f.store, cardId: f.card.id, readHead: () => B,
      resolveIdentity: async () => ({ git: {} }),
    })
    assert.notEqual(result.reason, undefined)
    assert.doesNotMatch(result.reason ?? '', /评审 head 与当前 worktree HEAD 不一致/, 'head-mismatch refusal gone')
  } finally { f.cleanup() }
})

test('Dev-AutoRereview: first-review cards (no reviewer) still use reviewDispatch, unaffected', async () => {
  const f = fixture({ withReviewSession: false, noVerdict: true })
  try {
    const log = []
    await runTick({ store: f.store, status: createEngineStatus(), deps: depsFor(log) })
    assert.deepEqual(log, [`first:${f.card.id}`], 'first review still dispatched via dispatchReview')
    assert.equal(f.store.getCard(f.card.id).autoRereviewCount, 0, 'first review never counts')
  } finally { f.cleanup() }
})

// ---------- quota-exhausted UI (user 拍板「加上」) ----------

const clientSrc = readFileSync(join(root, 'client.js'), 'utf8')
const zhDict = JSON.parse(readFileSync(join(root, 'locale', 'zh.json'), 'utf8'))
const enDict = JSON.parse(readFileSync(join(root, 'locale', 'en.json'), 'utf8'))

test('Dev-AutoRereview: exhausted quota key in four dicts, no placeholders', () => {
  const inlineZh = clientSrc.slice(clientSrc.indexOf('const zh = {'), clientSrc.indexOf('const en = {'))
  const inlineEn = clientSrc.slice(clientSrc.indexOf('const en = {'))
  for (const [dict, zhOk] of [[zhDict, '自动重评审次数已用完'], [enDict, 'Automatic re-review']]) {
    assert.equal(typeof dict.autoRereviewExhaustedNotice, 'string')
    assert.match(dict.autoRereviewExhaustedNotice, new RegExp(zhOk))
    assert.doesNotMatch(dict.autoRereviewExhaustedNotice, /\{[^}]+\}/, 'no placeholders (AC-1.5)')
  }
  assert.match(inlineZh, /autoRereviewExhaustedNotice: "[^"]*自动重评审次数已用完/)
  assert.match(inlineEn, /autoRereviewExhaustedNotice: "Automatic re-review/)
  assert.equal((clientSrc.match(/autoRereviewExhaustedNotice:/g) ?? []).length, 2, 'inline zh + en only')
})

test('Dev-AutoRereview: exhausted notice outranks stale notice; button still available at cap', () => {
  const block = clientSrc.slice(clientSrc.indexOf('const rereviewExhausted ='), clientSrc.indexOf('}, noticeText'))
  assert.match(block, /autoRereviewCount[\s\S]{0,40}>= AUTO_REREVIEW_LIMIT_FROM_UI|autoRereviewCount[\s\S]{0,40}>= 3/, 'exhausted branch uses >= 3')
  assert.ok(block.indexOf("t('autoRereviewExhaustedNotice')") < block.indexOf("t('reviewStaleNotice')"), 'exhausted wins over generic stale')
  // canRedispatch must NOT be gated on autoRereviewCount — manual stays available at cap
  const dispatchBlock = clientSrc.slice(clientSrc.indexOf('const canRedispatch ='), clientSrc.indexOf('if (canRedispatch)'))
  assert.doesNotMatch(dispatchBlock, /autoRereviewCount/, 'manual redispatch not blocked by cap')
})

test('Dev-AutoRereview: re-review reuses the original reviewer session via followupReview ladder', () => {
  const d = dispatchSrc.slice(dispatchSrc.indexOf('export async function followupReview('), dispatchSrc.indexOf('export function createHostPort('))
  assert.match(d, /isSessionActive\(previousSessionId\)/, 'first tries the live original reviewer')
  assert.match(d, /followupSession\(\{ sessionId: previousSessionId/, 'follows up the original session id')
  assert.match(d, /resumeSession\(\{[\s\S]{0,120}resumeSessionId: previousSessionId/, 'then resumes it')
  assert.match(d, /createSession\(\{/, 'last resort: fresh session')
  assert.match(autonomySrc, /reviewRereview: \(args\) => followupReview/, 'engine re-review dep calls followupReview, not dispatchReview')
})
