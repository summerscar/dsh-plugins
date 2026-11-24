import assert from 'node:assert/strict'
import test from 'node:test'
import { clientSource, renderCardActions, makeFixture } from './dev-v4-support.mjs'

const NO_WRITE_KEYS = ['actConfirmCommit', 'actCreatePr', 'actCommitExisting', 'actPushExisting', 'actMarkDone']

test('Dev-Session: no V4 stage exposes manual git-write buttons', () => {
  for (const status of ['build', 'self-review', 'pr-review']) {
    const f = makeFixture({ status })
    try {
      const { keys } = renderCardActions(f.card)
      for (const key of NO_WRITE_KEYS) assert.equal(keys.includes(key), false, `${status}: ${key} absent`)
    } finally { f.cleanup() }
  }
})

test('Dev-Session: takeover and abandon remain available on a live card', () => {
  const f = makeFixture({ status: 'pr-review' })
  try {
    const { keys } = renderCardActions(f.card)
    assert.ok(keys.includes('takeover'))
    assert.ok(keys.includes('cancelCard'))
  } finally { f.cleanup() }
})

test('Dev-Session: takeover button is disabled while a session runs', () => {
  const f = makeFixture({ status: 'pr-review' })
  try {
    const { buttons } = renderCardActions(f.card, { working: true })
    const takeover = buttons.find((b) => b.props.key === 'takeover')
    assert.equal(takeover.props.disabled, true)
    assert.ok(takeover.props.title)
  } finally { f.cleanup() }
})

test('Dev-Session: busy and session guards still gate board actions', () => {
  const source = clientSource()
  assert.match(source, /disabled: busy \|\| extra\.disabled === true/)
  assert.match(source, /const sessionRunning = working === true \|\| reviewWorking === true/)
})

test('Dev-Session: the V4 client source has no review-dispatch button path', () => {
  const source = clientSource()
  const actions = source.slice(source.indexOf('function CardActions('), source.indexOf('function Column('))
  assert.doesNotMatch(actions, /actRedispatchReview|actDispatchReview/)
})
