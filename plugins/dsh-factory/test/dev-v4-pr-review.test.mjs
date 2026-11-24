/**
 * Dev self-check — part (3): independent pr-review session, typed dual-field
 * verdict identity gate, and card UI entries/animation reuse.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createEngineStatus, runTick } from '../autonomy.js'
import { buildSessionContext } from '../session-context.js'
import { clientSource, makeFixture, makeTools, HEAD } from './dev-v4-support.mjs'

function prFixture() {
  const f = makeFixture({ status: 'pr-review' })
  f.store._card(f.card.id).prUrl = 'https://example/pr/9'
  f.store._card(f.card.id).commitSha = HEAD
  f.store._commit()
  return f
}

function prDeps(f, { active = false, dispatched = [], dispatchedIds = [] } = {}) {
  return {
    intake: async () => ({ created: [] }),
    dispatch: async () => ({ mode: 'none' }),
    approve: async () => ({ approved: false }),
    continue: async () => ({}),
    isSessionActive: async () => active,
    prReviewDispatch: async ({ cardId }) => { dispatched.push(cardId); dispatchedIds.push('pr-review') },
  }
}

test('V4-PRReview: pr-review session id is a separate persistent field', () => {
  const f = prFixture()
  try {
    f.store.setPrReviewSession(f.card.id, 'pr-reviewer-session', 'created')
    const card = f.store.getCard(f.card.id)
    assert.equal(card.prReviewSessionId, 'pr-reviewer-session')
    assert.equal(card.reviewSessionId, null)
  } finally { f.cleanup() }
})

test('V4-PRReview: engine dispatches one pr-review session and skips a live one', async () => {
  const f = prFixture()
  try {
    const dispatched = []
    await runTick({ store: f.store, status: createEngineStatus(), deps: prDeps(f, { dispatched }) })
    assert.deepEqual(dispatched, [f.card.id])
    const again = []
    f.store.setPrReviewSession(f.card.id, 'pr-reviewer-session', 'created')
    await runTick({ store: f.store, status: createEngineStatus(), deps: prDeps(f, { active: true, dispatched: again }) })
    assert.deepEqual(again, [], 'a live pr-review session is idempotent')
  } finally { f.cleanup() }
})

test('V4-PRReview: an idle session is audited once, parked for human, never auto-redispatched', async () => {
  const f = prFixture()
  try {
    f.store.setPrReviewSession(f.card.id, 'pr-reviewer-session', 'created')
    const dispatched = []
    await runTick({ store: f.store, status: createEngineStatus(), deps: prDeps(f, { dispatched }) })
    assert.deepEqual(dispatched, [])
    const card = f.store.getCard(f.card.id)
    assert.equal(card.prReviewIdle, true)
    const audits = f.store.state.events.filter((e) => e.type === 'pr-review-idle' && e.targetId === f.card.id)
    assert.equal(audits.length, 1)
    const second = []
    await runTick({ store: f.store, status: createEngineStatus(), deps: prDeps(f, { dispatched: second }) })
    assert.deepEqual(second, [], 'no auto redispatch on later ticks')
    const audits2 = f.store.state.events.filter((e) => e.type === 'pr-review-idle' && e.targetId === f.card.id)
    assert.equal(audits2.length, 1, 'idle is one-shot')
  } finally { f.cleanup() }
})

test('V4-PRReview: pr-review context is read-only and names the PR', () => {
  const f = prFixture()
  try {
    const built = buildSessionContext({
      card: f.store.getCard(f.card.id), project: f.store.getProject(f.project.id),
      reviewMode: true, review: { kind: 'pr-review', reviewedHead: HEAD, prNumber: 9, readHead: () => HEAD },
    })
    assert.equal(built.skill, 'factory-review')
    assert.equal(built.prReviewNumber, 9)
    assert.match(built.sectionText, /PR 9|https:\/\/example\/pr\/9/)
    assert.match(built.sectionText, /factory_report/)
    assert.match(built.sectionText, /source.*pr-review/)
    assert.doesNotMatch(built.sectionText, /factory_self_review_verdict|factory_open_draft_pr/)
    assert.doesNotMatch(built.sectionText, /merge|move the card/i)
  } finally { f.cleanup() }
})

test('V4-PRReview: typed gate accepts each verdict only from its own session', async () => {
  const f = prFixture()
  try {
    f.store.setReviewSession(f.card.id, 'self-reviewer-session', 'created')
    f.store.setPrReviewSession(f.card.id, 'pr-reviewer-session', 'created')
    const t = makeTools(f)
    const selfExec = { agent: { id: 'self-reviewer-session' } }
    const prExec = { agent: { id: 'pr-reviewer-session' } }
    const verdict = { source: 'pr-review', verdict: 'approved', blocking: [], followUps: [], checks: [] }

    await assert.rejects(() => t.find('factory_report').execute({ cardId: f.card.id, report: 'r', ...verdict }, selfExec), /自审会话不能代交 PR 评审 verdict/)
    const out = await t.find('factory_report').execute({ cardId: f.card.id, report: 'pr verdict', ...verdict }, prExec)
    f.store.transitionCard(f.card.id, 'build', 'human', 'identity cross-check')
    f.store.transitionCard(f.card.id, 'self-review', 'agent')
    await assert.rejects(() => t.find('factory_self_review_verdict').execute({
      cardId: f.card.id, head: HEAD, verdict: 'approved', blocking: [], followUps: [], checks: [],
    }, prExec), /PR 评审会话不能代交自审结论/)
    assert.equal(out.verdict, 'approved')
    assert.equal(f.store.getCard(f.card.id).reviewVerdict.source, 'pr-review')
  } finally { f.cleanup() }
})

test('V4-PRReview: client has three session entries, new copy keys and reused animations', () => {
  const source = clientSource()
  assert.doesNotMatch(source, /openSelfReviewSession/)
  assert.match(source, /openReviewSession:\s*"打开自审会话"/)
  assert.match(source, /openPrReviewSession:\s*"打开 PR 评审会话"/)
  for (const key of ['prReviewRunning', 'prReviewApproved', 'prReviewChanges', 'prReviewIncomplete', 'prReviewIdle', 'prReviewWaitMerge', 'actRedispatchPrReview']) {
    assert.match(source, new RegExp(`${key}:\\s*"`), `${key} inline zh`)
  }
  assert.match(source, /card\.prReviewSessionId/)
  assert.match(source, /prReviewWorking/)
  assert.match(source, /df-card-review-working/)
  assert.match(source, /df-working-dot/)
  assert.match(source, /df-working-bar/)
})

test('V4-PRReview: card flow hint picks the pr-review state copy', () => {
  const source = clientSource()
  const fn = source.slice(source.indexOf('function cardFlowHintKey('), source.indexOf('const STAGE_FLOW'))
  const cardFlowHintKey = new Function('ctx', `${fn}\nreturn cardFlowHintKey`)()
  assert.equal(cardFlowHintKey({ status: 'pr-review', prReviewIdle: true }), 'prReviewIdle')
  assert.equal(cardFlowHintKey({ status: 'pr-review', reviewVerdict: { verdict: 'approved' } }), 'prReviewApproved')
  assert.equal(cardFlowHintKey({ status: 'pr-review', reviewVerdict: { verdict: 'changes-requested' } }), 'prReviewChanges')
  assert.equal(cardFlowHintKey({ status: 'pr-review', reviewVerdict: { verdict: 'verification-incomplete' } }), 'prReviewIncomplete')
  assert.equal(cardFlowHintKey({ status: 'pr-review', prReviewSessionId: 's', prReviewWorking: true }), 'prReviewRunning')
  assert.equal(cardFlowHintKey({ status: 'pr-review' }), 'prReviewWaitMerge')
})
