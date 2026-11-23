/**
 * Dev self-check: one flow hint per card, with PM/Design's priority order.
 * Tests the real pure selector extracted from client.js — no source-word guards.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const client = readFileSync(join(root, 'client.js'), 'utf8')
const zh = JSON.parse(readFileSync(join(root, 'locale', 'zh.json'), 'utf8'))
const en = JSON.parse(readFileSync(join(root, 'locale', 'en.json'), 'utf8'))
const selector = client.slice(client.indexOf('function cardFlowHintKey('), client.indexOf('function Card({'))
assert.ok(selector.startsWith('function cardFlowHintKey('), 'flow selector found')
const flowHintKey = new Function(`${selector}\nreturn cardFlowHintKey`)()

const COPY = {
  flowInboxAuto: ['自动处理中：下次引擎检查（约 60 秒）会自动派发；也可点「派发给 AI」立即开始。', 'Auto: the next engine check (about 60s) will dispatch this card; or click Dispatch to AI to start now.'],
  flowInboxManual: ['需手动处理：本档位不自动派发，请点「派发给 AI」。', 'Manual: this tier does not auto-dispatch. Click Dispatch to AI.'],
  flowTriageAuto: ['自动处理中：会话正在整理任务，完成后自动进入计划。', 'Auto: the session is triaging the task, then moves to Plan automatically.'],
  flowPlanAuto: ['自动处理中：会话正在生成计划，完成后进入待批准计划。', 'Auto: the session is writing the plan, then stops at Plan review.'],
  flowPlanReviewAuto: ['自动处理中：下次引擎检查（约 60 秒）会自动批准计划并继续实现；也可点「批准计划」立即开始。', 'Auto: the next engine check (about 60s) approves the plan and continues; or click Approve plan now.'],
  flowPlanReviewManual: ['需手动处理：请点「批准计划」或「退回修改计划」。', 'Manual: click Approve plan or Return to plan.'],
  flowBuildAuto: ['自动处理中：会话正在实现，完成后自动进入待评审。', 'Auto: the session is building, then moves to Review automatically.'],
  flowReviewAuto: ['自动处理中：引擎将派出评审；approved 且无阻断项后自动提交、推送并开草稿 PR；标记完成仍需你。', 'Auto: the engine dispatches a reviewer; once approved with no blockers it commits, pushes and opens a draft PR. Marking done still needs you.'],
  flowReviewManual: ['需手动处理：评审通过后请确认提交、创建 PR 并标记完成；评审未通过请先退回构建。', 'Manual: after an approved verdict, confirm commit, create PR and mark done; if not approved, return to build first.'],
  flowDone: ['已完成，无后续自动步骤。', 'Done — no further automatic steps.'],
  flowCanceled: ['已放弃，无后续自动步骤；需要的话点「删除卡片」。', 'Abandoned — no further automatic steps; use Delete card if needed.'],
  flowPaused: ['自动推进已暂停：恢复项目或引擎后继续；等待期间仍可手动处理。', 'Auto advancement is paused; it resumes after unpausing. Manual actions remain available.'],
  flowCapacity: ['自动处理排队中：并发名额已满，有名额后继续。', 'Queued for auto processing: concurrency slots are full; it continues when a slot frees.'],
  flowTakenOver: ['已接管：引擎不会推进此卡；请手动处理，或点「交还引擎」。', "Taken over: the engine won't advance this card; act manually or return it to the engine."],
  flowNeedsInfo: ['需手动处理：请先「补充信息并重新派发」。', 'Manual: add the missing information and redispatch.'],
  flowStalled: ['需手动处理：自动派发已停止，请人工决定如何处理。', 'Manual: automatic dispatch has stopped; decide how to proceed.'],
  flowSessionStopped: ['需手动处理：会话已停止但卡片未结束，请手动派发或放弃这张卡。', 'Manual: the session stopped but the card is still open; dispatch it manually or abandon the card.'],
}

test('Dev-Flow: all 17 copy keys exist verbatim in all four dictionaries', () => {
  const inlineZh = client.slice(client.indexOf('const zh = {'), client.indexOf('const en = {'))
  const inlineEn = client.slice(client.indexOf('const en = {'))
  for (const [key, [zhText, enText]] of Object.entries(COPY)) {
    assert.equal(zh[key], zhText, `locale zh.${key}`)
    assert.equal(en[key], enText, `locale en.${key}`)
    assert.ok(inlineZh.includes(`${key}: ${JSON.stringify(zhText)}`), `inline zh.${key}`)
    assert.ok(inlineEn.includes(`${key}: ${JSON.stringify(enText)}`), `inline en.${key}`)
  }
})

const base = { status: 'inbox', tier: 'manual' }
const hint = (extra = {}) => flowHintKey({ ...base, ...extra })

test('Dev-Flow: base text follows status and tier', () => {
  assert.equal(hint(), 'flowInboxManual')
  assert.equal(hint({ tier: 'you-approve' }), 'flowInboxManual')
  assert.equal(hint({ tier: 'you-approve', autoDispatch: true }), 'flowInboxAuto')
  assert.equal(hint({ tier: 'machine-approve' }), 'flowInboxAuto')
  assert.equal(hint({ tier: 'auto-delivery' }), 'flowInboxAuto')
  assert.equal(hint({ status: 'plan-review' }), 'flowPlanReviewManual')
  assert.equal(hint({ status: 'plan-review', tier: 'you-approve', autoDispatch: true }), 'flowPlanReviewManual')
  assert.equal(hint({ status: 'plan-review', tier: 'machine-approve' }), 'flowPlanReviewAuto')
  assert.equal(hint({ status: 'plan-review', tier: 'auto-delivery' }), 'flowPlanReviewAuto')
  for (const status of ['triage', 'plan', 'build']) {
    for (const tier of ['manual', 'you-approve', 'machine-approve', 'auto-delivery']) {
      assert.equal(hint({ status, tier }), `flow${status[0].toUpperCase()}${status.slice(1)}Auto`, `${status}/${tier}`)
    }
  }
  assert.equal(hint({ status: 'review' }), 'flowReviewManual')
  assert.equal(hint({ status: 'review', tier: 'machine-approve' }), 'flowReviewManual')
  assert.equal(hint({ status: 'review', tier: 'auto-delivery' }), 'flowReviewAuto')
  assert.equal(hint({ status: 'done' }), 'flowDone')
  assert.equal(hint({ status: 'canceled' }), 'flowCanceled')
  assert.equal(hint({ status: 'unknown' }), '')
})

test('Dev-Flow: overlays win in the published priority order, one line only', () => {
  const all = {
    status: 'inbox', tier: 'auto-delivery', orphan: {}, needsHumanInfo: true, takenOver: true,
    paused: true, capacityHeld: true, stalled: true, sessionId: 's1', working: false,
    hasReviewNotice: true,
  }
  assert.equal(hint(all), 'orphanWhy')
  assert.equal(hint({ ...all, orphan: undefined }), '', 'an existing L4 review notice owns the line')
  assert.equal(hint({ status: 'review', tier: 'auto-delivery', hasReviewNotice: true }), '')
  const noOrphan = { ...all, orphan: undefined, sessionId: undefined, hasReviewNotice: false }
  assert.equal(hint(noOrphan), 'flowNeedsInfo')
  assert.equal(hint({ ...noOrphan, hasReviewNotice: false, needsHumanInfo: false }), 'flowTakenOver')
  assert.equal(hint({ ...noOrphan, hasReviewNotice: false, needsHumanInfo: false, takenOver: false }), 'flowPaused')
  assert.equal(hint({ ...noOrphan, hasReviewNotice: false, needsHumanInfo: false, takenOver: false, paused: false }), 'flowCapacity')
  assert.equal(hint({ ...noOrphan, hasReviewNotice: false, needsHumanInfo: false, takenOver: false, paused: false, capacityHeld: false }), 'flowStalled')
})

test('Dev-Flow: a stopped session overrides auto text for states that need one', () => {
  for (const status of ['triage', 'plan', 'build']) {
    assert.equal(hint({ status, sessionId: 's1', working: false }), 'flowSessionStopped', `${status} stopped`)
    assert.equal(hint({ status, sessionId: 's1', working: true }), `flow${status[0].toUpperCase()}${status.slice(1)}Auto`, `${status} running`)
  }
  assert.equal(hint({ status: 'review', reviewSessionId: 'r1', reviewWorking: false }), 'flowSessionStopped')
  assert.equal(hint({ status: 'review', reviewSessionId: 'r1', reviewWorking: true }), 'flowReviewManual')
  assert.equal(hint({ status: 'review', reviewSessionId: 'r1', reviewWorking: false, reviewVerdict: { verdict: 'approved' } }), 'flowReviewManual')
  assert.equal(hint({ status: 'review', reviewSessionId: 'r1', reviewWorking: false, reviewVerdict: { verdict: 'approved' }, reviewStale: true }), 'flowSessionStopped')
  assert.equal(hint({ status: 'plan-review', sessionId: 's1', working: false }), 'flowPlanReviewManual')
})

test('Dev-Flow: the hint is rendered at most once, below meta and above the actions', () => {
  const posMeta = client.indexOf("key: 'meta'")
  const posHint = client.indexOf("key: 'flowHint'")
  const posActions = client.indexOf("h(CardActions,")
  assert.ok(posMeta > 0 && posHint > posMeta && posActions > posHint, 'flow hint sits between meta and actions')
  assert.equal(client.split("key: 'flowHint'").length - 1, 1, 'exactly one flow hint node')
  assert.match(client, /h\(Card,[\s\S]{0,400}engine, project,/, 'the live engine/project snapshot reaches the card')
  assert.match(client, /key: 'flowHint'[\s\S]{0,260}t\(flowKey\)/, 'hint renders the selected key through t()')
  assert.doesNotMatch(client.slice(posHint - 100, posHint + 400), /whiteSpace: 'pre-line'/, 'flow hint stays one line')
})
