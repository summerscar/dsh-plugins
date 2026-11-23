/**
 * Dev self-check: while a card's builder or reviewer session is running, the
 * human action buttons on that card must be disabled (with a reason), so a
 * click cannot race a live agent or bypass an unfinished review.
 *
 * The test executes the real CardActions function from client.js with stubbed
 * host primitives and inspects the rendered button props — it does not pin
 * source wording.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const client = readFileSync(join(here, '..', 'client.js'), 'utf8')
const source = client.slice(client.indexOf('function CardActions('), client.indexOf('function Column('))
assert.ok(source.startsWith('function CardActions('), 'CardActions source found')

const T = { card: '#fff', line: '#ddd', panel: '#fff', mutedInk: '#888', dangerInk: '#c00', accent: '#00f', accentWash: '#eef', accentInk: '#00c' }
const h = (tag, props, ...children) => ({ tag, props: props || {}, children })
const apiCalls = []
const cardActions = new Function(
  'h', 'Button', 'callApi', 'T', 'NoteModal', 'Modal', 'needsAutoApproveNotice',
  `${source}\nreturn CardActions`,
)(h, 'button', async (...args) => { apiCalls.push(args); return {} }, T, 'note-modal', 'modal', () => false)

function render(card, { working = false, reviewWorking = false, tier = 'manual', busy = false } = {}) {
  apiCalls.length = 0
  const view = cardActions({
    card, run: async (fn) => fn(), t: (key) => key, busy, working, reviewWorking,
    onToast: () => {}, onModal: () => {}, tier, orphan: undefined,
  })
  return view === null ? [] : view.children.flat().filter((child) => child && child.tag === 'button')
}

const keysOf = (buttons) => buttons.map((button) => button.props.key)
const buttonOf = (buttons, key) => buttons.find((button) => button.props.key === key)
const report = { type: 'report' }

test('Dev-Session: builder running disables the takeover and cancel actions with a reason', () => {
  const card = { id: 'build-1', status: 'build', history: [report], sessionId: 's1', takenOver: false }
  const buttons = render(card, { working: true })
  assert.deepEqual(keysOf(buttons).sort(), ['cancelCard', 'takeover'], 'build card offers only the overlay actions')
  for (const button of buttons) {
    assert.equal(button.props.disabled, true, `${button.props.key} disabled while the builder runs`)
    assert.ok(button.props.title, `${button.props.key} says why it is disabled`)
  }
  for (const button of render(card)) {
    assert.notEqual(button.props.disabled, true, `${button.props.key} is actionable when idle`)
  }
})

test('Dev-Session: reviewer running disables every review action and overlay action', () => {
  const card = {
    id: 'review-1', status: 'review', history: [report], sessionId: 's1', reviewSessionId: 'r1',
    commitSha: 'abc', prUrl: 'https://example/pr/1', takenOver: false,
  }
  const buttons = render(card, { reviewWorking: true, tier: 'auto-delivery' })
  const keys = keysOf(buttons)
  for (const key of ['actRedispatchReview', 'actReturnToBuild', 'actPushExisting', 'actMarkDone', 'takeover', 'cancelCard']) {
    assert.ok(keys.includes(key), `${key} rendered`)
  }
  for (const button of buttons) {
    assert.equal(button.props.disabled, true, `${button.props.key} disabled while the reviewer runs`)
    assert.ok(button.props.title, `${button.props.key} says why it is disabled`)
  }
})

test('Dev-Session: confirm-commit is disabled too when review runs before a commit exists', () => {
  const card = { id: 'review-2', status: 'review', history: [report], reviewSessionId: 'r1', takenOver: false }
  const buttons = render(card, { reviewWorking: true })
  assert.ok(keysOf(buttons).includes('actConfirmCommit'), 'confirm-commit rendered before a commit exists')
  assert.equal(buttonOf(buttons, 'actConfirmCommit').props.disabled, true)
})

test('Dev-Session: idle review card keeps its actions enabled', () => {
  const card = {
    id: 'review-3', status: 'review', history: [report], commitSha: 'abc',
    prUrl: 'https://example/pr/1', takenOver: false, reviewVerdict: { verdict: 'approved' },
  }
  for (const key of ['actReturnToBuild', 'actPushExisting', 'actMarkDone', 'takeover', 'cancelCard']) {
    assert.notEqual(buttonOf(render(card), key).props.disabled, true, `${key} enabled when idle`)
  }
})

test('Dev-Session: inbox dispatch is disabled with a reason while a session runs', () => {
  const card = { id: 'inbox-1', status: 'inbox', history: [], needsHumanInfo: false, pendingDispatch: null, stalled: false }
  const running = buttonOf(render(card, { working: true }), 'actDispatch')
  assert.ok(running, 'dispatch button rendered')
  assert.equal(running.props.disabled, true, 'dispatch disabled while a session runs')
  assert.equal(running.props.title, 'working', 'reason names the running session')
  const idle = buttonOf(render(card), 'actDispatch')
  assert.notEqual(idle.props.disabled, true, 'dispatch enabled when idle')
})

function reviewCard(verdict, { commitSha, prUrl } = {}) {
  return {
    id: 'review-verdict', status: 'review', history: [report], takenOver: false,
    commitSha, prUrl, ...(verdict === undefined ? {} : { reviewVerdict: { verdict } }),
  }
}

const WRITE_BUTTONS = ['actConfirmCommit', 'actCreatePr', 'actPushExisting', 'actMarkDone']

function reviewWriteButtons(verdict) {
  const shapes = [
    reviewCard(verdict),
    reviewCard(verdict, { commitSha: 'abc' }),
    reviewCard(verdict, { commitSha: 'abc', prUrl: 'https://example/pr/1' }),
  ]
  return shapes.flatMap((card) => render(card))
}

test('Dev-Session: review writes grey out without an approved verdict, but return-to-build stays', () => {
  for (const verdict of [undefined, 'changes-requested']) {
    const buttons = reviewWriteButtons(verdict)
    const present = WRITE_BUTTONS.filter((key) => buttons.some((button) => button.props.key === key))
    assert.deepEqual(present.sort(), WRITE_BUTTONS.slice().sort(), 'all four write buttons rendered across the three shapes')
    for (const button of buttons.filter((b) => WRITE_BUTTONS.includes(b.props.key))) {
      assert.equal(button.props.disabled, true, `${button.props.key} disabled without approval`)
      assert.ok(button.props.title, `${button.props.key} explains why`)
    }
    const back = buttonOf(render(reviewCard(verdict)), 'actReturnToBuild')
    assert.notEqual(back.props.disabled, true, 'return-to-build is the way out of a failed review')
  }
})

test('Dev-Session: an approved verdict restores every review write button', () => {
  const buttons = reviewWriteButtons('approved')
  for (const key of WRITE_BUTTONS) {
    const button = buttons.find((b) => b.props.key === key)
    assert.ok(button, `${key} rendered`)
    assert.notEqual(button.props.disabled, true, `${key} enabled with approval`)
  }
})

test('Dev-ReviewEntry: L0/L2/L3 review cards can dispatch the first review through the existing route', async () => {
  for (const tier of ['manual', 'you-approve', 'machine-approve']) {
    const card = { id: 'review-entry', status: 'review', history: [report], takenOver: false }
    const buttons = render(card, { tier })
    const dispatch = buttonOf(buttons, 'actDispatchReview')
    assert.ok(dispatch, `${tier}: first-review button rendered`)
    assert.notEqual(dispatch.props.disabled, true, `${tier}: first-review button is clickable when idle`)
    dispatch.props.onClick()
    await new Promise(setImmediate)
    assert.deepEqual(apiCalls.at(-1), ['POST', '/cards/review-entry/review-dispatch'], `${tier}: uses the existing route`)
  }
})

test('Dev-ReviewEntry: L4 keeps its redispatch semantics and gains no new button', () => {
  const withSession = { id: 'l4-review', status: 'review', history: [report], takenOver: false, reviewSessionId: 'r1' }
  const buttons = render(withSession, { tier: 'auto-delivery' })
  assert.ok(buttonOf(buttons, 'actRedispatchReview'), 'L4 existing redispatch still rendered')
  assert.equal(buttonOf(buttons, 'actDispatchReview'), undefined, 'L4 does not get the first-review button')
  const noSession = render({ ...withSession, reviewSessionId: undefined }, { tier: 'auto-delivery' })
  assert.equal(buttonOf(noSession, 'actDispatchReview'), undefined, 'L4 without a session keeps its old behaviour')
  assert.equal(buttonOf(noSession, 'actRedispatchReview'), undefined, 'L4 without a session has nothing to redispatch')
})

test('Dev-ReviewEntry: a fresh approved verdict hides the review button in every tier', () => {
  for (const tier of ['manual', 'machine-approve', 'auto-delivery']) {
    const card = {
      id: 'approved-review', status: 'review', history: [report], takenOver: false,
      reviewSessionId: 'r1', reviewVerdict: { verdict: 'approved' },
    }
    const keys = keysOf(render(card, { tier }))
    assert.ok(!keys.includes('actDispatchReview') && !keys.includes('actRedispatchReview'), `${tier}: no review button with a fresh approval`)
    const stale = render({ ...card, reviewStale: true }, { tier })
    assert.ok(keysOf(stale).includes(tier === 'auto-delivery' ? 'actRedispatchReview' : 'actDispatchReview'), `${tier}: stale verdict can be re-reviewed`)
  }
})

test('Dev-ReviewEntry: runaway and blocked cards keep the old exclusions', () => {
  const card = { id: 'review-entry', status: 'review', history: [report] }
  for (const extra of [{ takenOver: true }, { needsHumanInfo: true }]) {
    assert.equal(buttonOf(render({ ...card, ...extra }), 'actDispatchReview'), undefined, `excluded by ${Object.keys(extra)[0]}`)
  }
  const running = render(card, { working: true })
  const button = buttonOf(running, 'actDispatchReview')
  assert.equal(button.props.disabled, true, 'disabled while a session runs')
  assert.equal(button.props.title, 'working', 'reason names the running session')
})

test('Dev-Session: plan-review running still gates approve and return-to-plan', () => {
  const card = { id: 'plan-1', status: 'plan-review', history: [report], sessionId: 's1', takenOver: false }
  const buttons = render(card, { working: true })
  for (const key of ['actApprovePlan', 'actReturnToPlan']) {
    assert.equal(buttonOf(buttons, key).props.disabled, true, `${key} disabled while the builder runs`)
  }
})
