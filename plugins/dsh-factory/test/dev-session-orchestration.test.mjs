/**
 * Dev self-check — V4 session orchestration: the builder must stop at
 * self-review, and an idle independent reviewer must be redispatchable without
 * loosening the reviewer-only identity gate.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { continueCard } from '../dispatch.js'
import { buildSessionContext } from '../session-context.js'
import { createEngineStatus, runTick } from '../autonomy.js'
import { makeFixture, makeTools, HEAD } from './dev-v4-support.mjs'

const idleDeps = (f, { active = false, dispatched = [] } = {}) => ({
  intake: async () => ({ created: [] }),
  dispatch: async () => ({ mode: 'none' }),
  approve: async () => ({ approved: false }),
  continue: async () => ({}),
  isSessionActive: async () => active,
  reviewDispatch: async ({ cardId }) => { dispatched.push(cardId); return {} },
})

test('Dev-Orchestration: builder cannot continue into self-review', async () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    await assert.rejects(
      () => continueCard({ store: f.store, cardId: f.card.id, port: { isSessionActive: async () => false } }),
      /waiting-for-human/,
    )
  } finally { f.cleanup() }
})

test('Dev-Orchestration: builder context in self-review is a standing-by shell, not a review skill', () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    const built = buildSessionContext({ card: f.store.getCard(f.card.id), project: f.store.getProject(f.project.id), builderMode: true })
    assert.equal(built.skill, null, 'no factory-self-review skill is injected into the builder')
    assert.deepEqual(built.nextPhases, [])
    assert.match(built.sectionText, /standing by/i)
    assert.match(built.sectionText, /do not (?:review|submit).*verdict/i)
    assert.doesNotMatch(built.sectionText, /factory_self_review_verdict/)
  } finally { f.cleanup() }
})

test('Dev-Orchestration: generic builder wording no longer claims review runs in the same session', () => {
  const f = makeFixture({ status: 'build' })
  try {
    const built = buildSessionContext({ card: f.store.getCard(f.card.id), project: f.store.getProject(f.project.id), builderMode: true })
    assert.doesNotMatch(built.sectionText, /Advance through[\s\S]{0,160}review[\s\S]{0,80}single session/i)
    assert.match(built.sectionText, /self-review[\s\S]{0,120}independent review session/i)
  } finally { f.cleanup() }
})

test('Dev-Orchestration: an idle reviewer is redispersed once with audit', async () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    f.store.setReviewSession(f.card.id, 'reviewer-session', 'created')
    const dispatched = []
    await runTick({ store: f.store, status: createEngineStatus(), deps: idleDeps(f, { dispatched }) })
    assert.deepEqual(dispatched, [f.card.id])
    const card = f.store.getCard(f.card.id)
    assert.equal(card.selfReviewDispatchFailures, 1)
    assert.equal(card.stalled, false)
    const audit = f.store.state.events.filter((e) => e.type === 'self-review-idle-redispatch' && e.targetId === f.card.id)
    assert.equal(audit.length, 1)
    assert.equal(audit[0].decision, 'redispatch')
  } finally { f.cleanup() }
})

test('Dev-Orchestration: a live reviewer is never redispersed', async () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    f.store.setReviewSession(f.card.id, 'reviewer-session', 'created')
    const dispatched = []
    await runTick({ store: f.store, status: createEngineStatus(), deps: idleDeps(f, { active: true, dispatched }) })
    assert.deepEqual(dispatched, [])
    assert.equal(f.store.getCard(f.card.id).selfReviewDispatchFailures, 0)
  } finally { f.cleanup() }
})

test('Dev-Orchestration: three idle rounds park the card and stop auto redispatch', async () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    f.store.setReviewSession(f.card.id, 'reviewer-session', 'created')
    f.store._card(f.card.id).selfReviewDispatchFailures = 2
    f.store._commit()
    const dispatched = []
    await runTick({ store: f.store, status: createEngineStatus(), deps: idleDeps(f, { dispatched }) })
    assert.deepEqual(dispatched, [], 'cap reached: no fourth reviewer')
    const card = f.store.getCard(f.card.id)
    assert.equal(card.selfReviewDispatchFailures, 3)
    assert.equal(card.stalled, true)
    const parked = f.store.state.events.filter((e) => e.type === 'self-review-idle-redispatch' && e.targetId === f.card.id && e.decision === 'parked')
    assert.equal(parked.length, 1)
  } finally { f.cleanup() }
})

test('Dev-Orchestration: after redispatch the reviewer-only gate still protects the draft PR', async () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    f.store.recordCommit(f.card.id, { sha: HEAD, message: 'build', actor: 'agent' })
    f.store.setReviewSession(f.card.id, 'reviewer-session', 'recreated')
    const t = makeTools(f)
    await assert.rejects(
      () => t.find('factory_self_review_verdict').execute({ cardId: f.card.id, head: HEAD, verdict: 'approved', blocking: [], followUps: [], checks: [] }, t.builder),
      /评审会话/,
    )
    await t.find('factory_self_review_verdict').execute({ cardId: f.card.id, head: HEAD, verdict: 'approved', blocking: [], followUps: [], checks: [] }, t.reviewer)
    await assert.rejects(
      () => t.find('factory_open_draft_pr').execute({ cardId: f.card.id, title: 'T', body: 'B' }, t.builder),
      /评审会话/,
    )
    const out = await t.find('factory_open_draft_pr').execute({ cardId: f.card.id, title: 'T', body: 'B' }, t.reviewer)
    assert.equal(out.url, 'https://example/pr/1')
    assert.equal(out.head, HEAD)
  } finally { f.cleanup() }
})
