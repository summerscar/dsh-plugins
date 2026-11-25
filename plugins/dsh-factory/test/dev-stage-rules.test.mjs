/**
 * Dev self-check — stage rules: six flow rows, four editable gates, eight
 * fixed-on disabled gates, and the copy that says so in all four carriers.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { clientSource } from './dev-v4-support.mjs'

const source = clientSource()
const zh = JSON.parse(readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))
const en = JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))
const sectionStart = source.indexOf('function StageConfigSection')
const sectionEnd = source.indexOf('function PauseSection')
const section = source.slice(sectionStart, sectionEnd)

const EDITABLE = ['inbox:autoStart', 'plan:autoApprove', 'self-review:autoStart', 'pr-review:autoStart']
const LOCKED = [
  'inbox:autoApprove',
  'triage:autoStart', 'triage:autoApprove',
  'plan:autoStart',
  'build:autoStart', 'build:autoApprove',
  'self-review:autoApprove',
  'pr-review:autoApprove',
]

test('Dev-Stages: six rows render in flow order with a distinct inbox stage', () => {
  assert.ok(sectionStart >= 0 && sectionEnd > sectionStart, 'stage section is present')
  const table = section.match(/const stages = \[([\s\S]*?)\]\s*\n/)
  assert.ok(table, 'stage table is present')
  const rows = [...table[1].matchAll(/\['([^']+)', '([^']+)'\]/g)].map((m) => `${m[1]}:${m[2]}`)
  assert.deepEqual(rows, [
    'inbox:stageInbox', 'triage:stageTriage', 'plan:stagePlan',
    'build:stageBuild', 'self-review:stageSelfReview', 'pr-review:stagePrReview',
  ])
})

test('Dev-Stages: exactly four engine-backed gates stay editable', () => {
  const editable = section.match(/const editableRules = new Set\(\[([\s\S]*?)\]\)\s*\n/)
  assert.ok(editable, 'editable rule set is present')
  const rules = [...editable[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(rules, EDITABLE)
  for (const rule of LOCKED) assert.ok(!rules.includes(rule), `${rule} must not be editable`)
})

test('Dev-Stages: locked gates are fixed on, disabled, hinted and normalized on save', () => {
  assert.ok(section.includes('!editableRules.has'), 'locked gates still derive from the editable set')
  assert.ok(section.includes('checked: locked ? true'), 'locked checkbox is always checked')
  assert.ok(section.includes('disabled: true'), 'locked checkbox is disabled')
  assert.ok(section.includes("title: t('stageRuleLockedHint')"), 'locked input and label carry the hint')
  assert.ok(section.includes('onChange: (event) => setRules'), 'editable checkbox still updates local rules')
  assert.ok(section.includes('const payload = normalize(next)'), 'save normalizes the payload')
  assert.ok(section.includes('phaseRules: payload'), 'normalized payload is what gets saved')
  assert.ok(section.includes('next[key][action] = true'), 'locked stored values are forced true')
  assert.ok(section.includes('normalize(project?.phaseRules)'), 'initial state is normalized too')
})

test('Dev-Copy: new stage keys and purpose are mirrored in all four carriers', () => {
  const purposeZh = '默认全速自动。只有这 4 个勾选可取消，取消后该段停下等人：收件箱-自动启动、规划-自动批准、自审-自动启动、PR 评审-自动启动。其余勾选固定开启、置灰不可改——这些阶段当前没有可单独关闭的自动步骤。'
  const purposeEn = 'Full auto by default. Only four checkboxes can be turned off, pausing that stage for a human: Inbox auto-start, Planning auto-approve, Self-review auto-start, PR review auto-start. The rest are fixed on and greyed out — those stages currently have no separately switchable automatic step.'
  const hintZh = '该阶段目前没有可单独关闭的自动步骤，此勾选固定开启、不可修改。'
  const hintEn = 'This stage has no separately switchable automatic step; this checkbox is fixed on and cannot be changed.'
  assert.equal(zh.stageInbox, '收件箱')
  assert.equal(en.stageInbox, 'Inbox')
  assert.equal(zh.stageRuleLockedHint, hintZh)
  assert.equal(en.stageRuleLockedHint, hintEn)
  assert.equal(zh.stageConfigPurpose, purposeZh)
  assert.equal(en.stageConfigPurpose, purposeEn)
  for (const [key, value] of [
    ['stageInbox', '收件箱'], ['stageInbox', 'Inbox'],
    ['stageRuleLockedHint', hintZh], ['stageRuleLockedHint', hintEn],
    ['stageConfigPurpose', purposeZh], ['stageConfigPurpose', purposeEn],
  ]) assert.ok(source.includes(`${key}: "${value}"`), `client.js inline dictionary has ${key}`)
  for (const dict of [source, JSON.stringify(zh), JSON.stringify(en)]) {
    assert.doesNotMatch(dict, /取消某阶段的勾选即可让它停等人/)
    assert.doesNotMatch(dict, /uncheck a stage to pause it for a human/)
  }
})

// ---------------------------------------------------------------------------
// V4.60 — auto issue intake is a display-only third checkbox on the inbox row,
// not a side note. It mirrors the repo binding and is never a saved rule: the
// engine reads issueRepo + intakeBoardId, not a phaseRules field.
// ---------------------------------------------------------------------------

const FLOW = ['inbox', 'triage', 'plan', 'build', 'self-review', 'pr-review']
const NEW_COPY = {
  autoIntakeLabel: { zh: '自动拉取 issue', en: 'Auto issue intake' },
  stageAutoIntakeHint: {
    zh: 'issue 拉取由「远端 GitHub 仓库」绑定决定：绑定后引擎每轮都会拉取，暂停本项目也不停；此勾选固定开启、不可修改。',
    en: 'Issue intake follows the GitHub repo binding: once bound, the engine pulls every tick, even while the project is paused; this checkbox is fixed on and cannot be changed.',
  },
}

function renderStageSection({ projectRules = null } = {}) {
  const Fac = new Function(
    'h', 'useState', 'Button', 'callApi', 'T', 't',
    `${section}\nreturn StageConfigSection`,
  )
  const states = []
  const calls = []
  const h = (tag, props, ...kids) => typeof tag === 'function' ? tag(props, ...kids) : { tag, props: props ?? {}, kids }
  const Button = (props, ...kids) => ({ tag: 'button', props: props ?? {}, kids })
  const t = (key) => zh[key] ?? key
  const T = new Proxy({}, { get: () => '' })
  const render = () => {
    let i = 0
    const useState = (initial) => {
      const n = i++
      if (!(n in states)) states[n] = typeof initial === 'function' ? initial() : initial
      return [states[n], (v) => { states[n] = typeof v === 'function' ? v(states[n]) : v }]
    }
    const callApi = async (method, url, body) => {
      calls.push({ method, url, body })
      return { project: { phaseRules: body.phaseRules } }
    }
    return Fac(h, useState, Button, callApi, T, t)({
      project: { id: 'p1', phaseRules: projectRules }, t, onSaved: () => {},
    })
  }
  return { render, calls, t }
}

function flatten(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) { for (const n of node) flatten(n, out); return out }
  if (typeof node === 'object') {
    out.push(node)
    for (const kid of node.kids ?? []) flatten(kid, out)
    if (node.props?.children) flatten(node.props.children, out)
  }
  return out
}

function textOf(node) {
  if (typeof node === 'string') return node
  if (node === null || node === undefined || typeof node !== 'object') return ''
  return [ ...(node.kids ?? []), ...(node.props?.children ? [node.props.children] : []) ].map(textOf).join('')
}

function checkboxes(tree) {
  return flatten(tree).filter((n) => n.props?.type === 'checkbox')
}

test('Dev-Stages: six rows keep 13 checkboxes — 4 editable, 9 fixed-on with a title', () => {
  const tree = renderStageSection().render()
  const rows = flatten(tree).filter((n) => FLOW.includes(n.props?.key))
  assert.deepEqual(rows.map((r) => r.props.key), FLOW, 'six rows stay in flow order')
  const boxes = checkboxes(tree)
  assert.equal(boxes.length, 13, 'inbox has three, the other five have two')
  const editable = boxes.filter((b) => typeof b.props.onChange === 'function')
  const fixed = boxes.filter((b) => b.props.disabled === true)
  assert.equal(editable.length, 4, 'still only four engine-backed gates are editable')
  assert.equal(fixed.length, 9, 'nine checkboxes are fixed-on')
  for (const b of fixed) {
    assert.equal(b.props.checked, true, 'a fixed-on checkbox is always checked')
    assert.equal(b.props.onChange, undefined, 'a fixed-on checkbox has no change handler')
    assert.ok(typeof b.props.title === 'string' && b.props.title.length > 0, 'a fixed-on checkbox carries a hover hint')
  }
})

test('Dev-Stages: inbox order is intake (fixed) → auto-start (editable) → auto-approve (fixed)', () => {
  const { render, t } = renderStageSection()
  const tree = render()
  const inbox = flatten(tree).find((n) => n.props?.key === 'inbox')
  assert.ok(inbox, 'inbox row rendered')
  const labels = flatten(inbox).filter((n) => ['autoIntake', 'autoStart', 'autoApprove'].includes(n.props?.key))
  assert.deepEqual(labels.map((l) => l.props.key), ['autoIntake', 'autoStart', 'autoApprove'])
  assert.deepEqual(
    labels.map((l) => textOf(flatten(l).find((n) => n.props?.key === 'text'))),
    ['自动拉取 issue', '自动启动', '自动批准'],
    'the three inbox labels use the finalized copy in order',
  )
  const inputOf = (label) => flatten(label).find((n) => n.props?.type === 'checkbox')
  const intake = labels[0]
  const intakeInput = inputOf(intake)
  assert.equal(intakeInput.props.checked, true, 'intake is fixed on')
  assert.equal(intakeInput.props.disabled, true, 'intake cannot be unchecked')
  assert.equal(intakeInput.props.onChange, undefined, 'intake has no change handler')
  assert.equal(intakeInput.props.title, t('stageAutoIntakeHint'), 'intake carries the binding hint')
  assert.equal(intake.props.title, t('stageAutoIntakeHint'), 'intake label carries the same hint')
  assert.equal(typeof inputOf(labels[1]).props.onChange, 'function', 'inbox auto-start is still editable')
  assert.equal(inputOf(labels[2]).props.title, t('stageRuleLockedHint'), 'inbox auto-approve keeps the generic locked hint')
})

test('Dev-Stages: the display-only intake checkbox never reaches phaseRules or the PATCH', async () => {
  const { render, calls } = renderStageSection({ projectRules: null })
  const tree = render()
  const save = flatten(tree).find((n) => n.tag === 'button' && n.props?.key === 'save')
  assert.ok(save?.props?.onClick, 'save button is wired')
  save.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 1, 'one PATCH on save')
  const payload = calls[0].body.phaseRules
  for (const stage of FLOW) {
    assert.ok(payload[stage], `saved payload has ${stage}`)
    assert.equal('autoIntake' in payload[stage], false, `${stage} has no autoIntake rule`)
  }
  const after = checkboxes(render())
  assert.equal(after.filter((b) => b.props.disabled === true).length, 9, 'intake stays fixed-on after save/read-back')
  assert.equal(after.length, 13, 'no checkbox is added or lost on save')
})

test('Dev-Copy: new intake keys are mirrored in all four carriers; old side-note copy is gone', () => {
  for (const [key, copy] of Object.entries(NEW_COPY)) {
    assert.equal(zh[key], copy.zh, `locale zh has final ${key}`)
    assert.equal(en[key], copy.en, `locale en has final ${key}`)
    assert.ok(source.includes(`${key}: "${copy.zh}"`), `client.js inline zh has ${key}`)
    assert.ok(source.includes(`${key}: "${copy.en}"`), `client.js inline en has ${key}`)
  }
  assert.match(zh.stageAutoIntakeHint, /远端 GitHub 仓库.*绑定/, 'zh ties intake to the repo binding')
  assert.match(zh.stageAutoIntakeHint, /暂停本项目也不停/, 'zh says pausing the project does not stop intake')
  assert.match(en.stageAutoIntakeHint, /GitHub repo binding/i, 'en ties intake to the repo binding')
  assert.match(en.stageAutoIntakeHint, /even while the project is paused/i, 'en says pausing does not stop intake')
  for (const carrier of [source, JSON.stringify(zh), JSON.stringify(en)]) {
    assert.doesNotMatch(carrier, /stageInboxIntakeNote|inboxIntakeNote/, 'the rejected side-note key is gone')
    assert.doesNotMatch(carrier, /与这个勾选无关|regardless of this checkbox/i, 'no self-contradictory checkbox claim')
    assert.doesNotMatch(carrier, /取消勾选即停止拉取|uncheck.{0,20}(stop|disable).{0,10}pull/i, 'no fake promise that unchecking stops intake')
  }
})
