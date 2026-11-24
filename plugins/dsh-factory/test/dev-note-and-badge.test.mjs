import assert from 'node:assert/strict'
import test from 'node:test'
import { clientSource, makeFixture, renderCardActions } from './dev-v4-support.mjs'

const source = clientSource()

test('Dev-Note: no native window.prompt remains', () => {
  assert.doesNotMatch(source, /window\.prompt/)
  assert.match(source, /function NoteModal\(/)
  assert.match(source, /askNote\(/)
})

test('Dev-Note: no manual review writes remain; notes still use in-page modal', () => {
  const f = makeFixture({ status: 'self-review' })
  try {
    const { keys } = renderCardActions(f.card)
    assert.equal(keys.includes('actReturnToBuild'), false)
    assert.equal(keys.includes('actMarkDone'), false)
  } finally { f.cleanup() }
})

test('Dev-Note: taken-over badge and reason stay intact', () => {
  const f = makeFixture({ status: 'pr-review' })
  try {
    f.store.takeOverCard(f.card.id, 'human')
    const { keys } = renderCardActions(f.store.getCard(f.card.id))
    assert.ok(keys.includes('returnToEngine'))
  } finally { f.cleanup() }
})
