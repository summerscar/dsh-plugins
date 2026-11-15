/**
 * Tool-layer tests — the model-facing operations, exercised through the exact
 * `execute` handlers the host would call. No host package is imported: the specs
 * are pure and call the same store the HTTP API uses.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FactoryStore } from '../store.js'
import { factoryToolSpecs } from '../tools.js'

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'factory-tools-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: '/workspace/p' })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  const card = store.createCard({ boardId: board.id, title: 'c' })
  const specs = new Map(factoryToolSpecs({ store }).map((spec) => [spec.name, spec]))
  return { store, card, specs, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

test('factory_list_work_items returns board cards with id/title/status', async () => {
  const { specs, card, cleanup } = setup()
  try {
    const value = await specs.get('factory_list_work_items').execute({})
    assert.equal(value.cards.length, 1)
    assert.deepEqual(Object.keys(value.cards[0]).sort(), ['id', 'status', 'title'])
    assert.equal(value.cards[0].id, card.id)
    assert.equal(value.cards[0].status, 'inbox')
  } finally {
    cleanup()
  }
})

test('factory_transition_work_item advances an agent-legal edge and refuses Done', async () => {
  const { store, card, specs, cleanup } = setup()
  try {
    const transition = specs.get('factory_transition_work_item')
    // Inbox→Triage is human-only, so an agent moving it must be refused.
    await assert.rejects(() => transition.execute({ cardId: card.id, to: 'triage' }), /不允许由 agent 触发|非法/)

    // Move to Triage as a human, then the agent can advance Triage→Plan.
    store.transitionCard(card.id, 'triage', 'human')
    const moved = await transition.execute({ cardId: card.id, to: 'plan' })
    assert.equal(moved.status, 'plan')

    // The tool must never be able to reach Done.
    await assert.rejects(() => transition.execute({ cardId: card.id, to: 'done' }), /非法转移/)
  } finally {
    cleanup()
  }
})

test('factory_report appends a report and factory_list_attention surfaces inbox cards', async () => {
  const { store, card, specs, cleanup } = setup()
  try {
    const reported = await specs.get('factory_report').execute({ cardId: card.id, report: 'looks good' })
    assert.equal(reported.reports, 1)
    assert.equal(store.getCard(card.id).history.filter((entry) => entry.type === 'report').length, 1)

    const attention = await specs.get('factory_list_attention').execute({})
    assert.ok(attention.attention.some((entry) => entry.id === card.id && entry.status === 'inbox'))
  } finally {
    cleanup()
  }
})

test('every tool spec declares the defineTool contract fields', () => {
  const { specs, cleanup } = setup()
  try {
    for (const spec of specs.values()) {
      assert.equal(typeof spec.name, 'string')
      assert.equal(typeof spec.description, 'string')
      assert.equal(typeof spec.execute, 'function')
      assert.equal(typeof spec.output.render, 'function')
      assert.ok(spec.output.schema && typeof spec.output.schema === 'object')
    }
  } finally {
    cleanup()
  }
})
