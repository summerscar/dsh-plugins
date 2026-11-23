/**
 * Dev self-check: a returned Inbox card brings the human's previous return
 * explanation into the resupply modal, so it is visible and need not be retyped.
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

const h = (tag, props, ...children) => ({ tag, props: props || {}, children })
const T = { card: '#fff', line: '#ddd', panel: '#fff', mutedInk: '#888', dangerInk: '#c00', accent: '#00f', accentWash: '#eef', accentInk: '#00c' }

const helperSource = client.slice(client.indexOf('function lastTriageReturnReason('), client.indexOf('function OrphanModal('))
assert.ok(helperSource.startsWith('function lastTriageReturnReason('), 'history helper found')
const ModalStub = (props, ...children) => ({ tag: 'modal', props, children })
const { lastTriageReturnReason, NoteModal } = new Function(
  'h', 'Modal', 'useState', 'T',
  `${helperSource}\nreturn { lastTriageReturnReason, NoteModal }`,
)(h, ModalStub, (initial) => [initial, () => {}], T)

test('Dev-Resupply: picks the newest non-empty triage-return reason', () => {
  const history = [
    { type: 'triage-return', reason: 'old' },
    { type: 'transition', from: 'triage', to: 'inbox', note: 'old' },
    { type: 'triage-return', reason: '   ' },
    { type: 'triage-return', reason: 'latest' },
  ]
  assert.equal(lastTriageReturnReason(history), 'latest')
  assert.equal(lastTriageReturnReason([]), '')
  assert.equal(lastTriageReturnReason(undefined), '')
})

test('Dev-Resupply: modal shows the previous reason without prefilling the input', () => {
  const view = NoteModal({
    message: 'fill me', notice: '', context: 'previous: latest',
    t: (key) => key, onSubmit: () => {}, onCancel: () => {},
  })
  const children = view.children.flat().filter(Boolean)
  const textarea = children.find((node) => node.tag === 'textarea')
  const context = children.find((node) => node.props.key === 'context')
  assert.ok(textarea, 'textarea rendered')
  assert.equal(textarea.props.value, '', 'supplement starts empty — no duplicate prompt context')
  assert.ok(context, 'context line rendered')
  assert.equal(context.children[0], 'previous: latest')
  assert.equal(view.props.confirmDisabled, true, 'a real supplement is still required')
})

const actionsSource = client.slice(client.indexOf('function CardActions('), client.indexOf('function Column('))
assert.ok(actionsSource.startsWith('function CardActions('), 'CardActions source found')

function renderResupply(card) {
  let captured = null
  const actions = new Function(
    'h', 'Button', 'callApi', 'T', 'NoteModal', 'Modal', 'needsAutoApproveNotice', 'lastTriageReturnReason',
    `${actionsSource}\nreturn CardActions`,
  )(h, 'button', async () => ({}), T, 'note-modal', 'modal', () => false, lastTriageReturnReason)
  const view = actions({
    card, run: async (fn) => fn(),
    t: (key, vars) => (vars && vars.reason ? `${key}:${vars.reason}` : key),
    busy: false, working: false, reviewWorking: false, tier: 'manual',
    onToast: () => {}, onModal: (element) => { captured = element.props }, orphan: undefined,
  })
  const buttons = view.children.flat().filter((node) => node && node.tag === 'button')
  const resupply = buttons.find((node) => node.props.key === 'actResupply')
  assert.ok(resupply, 'resupply action rendered for a needs-info Inbox card')
  resupply.props.onClick()
  return () => captured
}

test('Dev-Resupply: the resupply action shows the last return reason above the input', async () => {
  const captured = renderResupply({
    id: 'card-1', status: 'inbox', history: [{ type: 'triage-return', actor: 'human', reason: '上次写的说明' }],
    needsHumanInfo: true, takenOver: false,
  })
  await new Promise(setImmediate)
  const props = captured()
  assert.ok(props, 'note modal opened')
  assert.equal(props.initial, undefined, 'no prefill is passed to the modal')
  assert.equal(props.context, 'notePreviousReason上次写的说明\nnoteResupplyGuidance', 'context explains where it came from')
})

test('Dev-Resupply: cards without a return reason keep the old empty modal', async () => {
  const captured = renderResupply({ id: 'card-2', status: 'inbox', history: [], needsHumanInfo: true })
  await new Promise(setImmediate)
  const props = captured()
  assert.ok(props, 'note modal opened')
  assert.equal(props.initial, undefined, 'no prefill without a reason either')
  assert.equal(props.context, '', 'no context line without a reason')
})

test('Dev-Resupply: new copy keys exist verbatim in all four dictionaries', () => {
  const inlineZh = client.slice(client.indexOf('const zh = {'), client.indexOf('const en = {'))
  const inlineEn = client.slice(client.indexOf('const en = {'))
  const expected = {
    notePreviousReason: ['上次退回原因：', 'Previous return reason: '],
    noteResupplyGuidance: ['本次请补充新的说明后提交。', 'Add your update below and submit.'],
  }
  for (const [key, [zhText, enText]] of Object.entries(expected)) {
    assert.equal(zh[key], zhText, `locale zh.${key}`)
    assert.equal(en[key], enText, `locale en.${key}`)
    assert.ok(inlineZh.includes(`${key}: ${JSON.stringify(zhText)}`), `inline zh.${key}`)
    assert.ok(inlineEn.includes(`${key}: ${JSON.stringify(enText)}`), `inline en.${key}`)
  }
})
