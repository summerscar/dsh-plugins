import assert from 'node:assert/strict'
import test from 'node:test'
import { makeFixture, renderCardActions } from './dev-v4-support.mjs'

test('Dev-Buttons: a build card has no manual git-write buttons', () => {
  const f = makeFixture({ status: 'build' })
  try {
    const { keys } = renderCardActions(f.card)
    for (const key of ['actConfirmCommit', 'actCreatePr', 'actMarkDone']) assert.equal(keys.includes(key), false)
  } finally { f.cleanup() }
})

test('Dev-Buttons: a pr-review card keeps only takeover/abandon', () => {
  const f = makeFixture({ status: 'pr-review' })
  try {
    const { keys } = renderCardActions(f.card)
    assert.ok(keys.includes('takeover'))
    assert.ok(keys.includes('cancelCard'))
    assert.equal(keys.includes('actMarkDone'), false)
  } finally { f.cleanup() }
})

test('Dev-Buttons: a self-review card has no manual write button', () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    const { keys } = renderCardActions(f.card)
    assert.equal(keys.includes('actRedispatchReview'), false)
    assert.equal(keys.includes('actCommitExisting'), false)
  } finally { f.cleanup() }
})

test('Dev-Buttons: a done card is read-only', () => {
  const f = makeFixture({ status: 'pr-review' })
  try {
    f.store.transitionCard(f.card.id, 'done', 'syncRule')
    const { keys } = renderCardActions(f.store.getCard(f.card.id))
    assert.deepEqual(keys, ['deleteCard'])
  } finally { f.cleanup() }
})
