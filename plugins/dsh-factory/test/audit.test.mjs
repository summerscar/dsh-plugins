/**
 * Audit query tests — flattens per-card history into one filterable stream with
 * the { actor, decision, at, ... } governance fields QA H6 asks for.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FactoryStore } from '../store.js'
import { collectAudit } from '../audit.js'

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'factory-audit-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: '/workspace/example-repo' })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  const a = store.createCard({ boardId: board.id, title: 'A' })
  const b = store.createCard({ boardId: board.id, title: 'B' })
  store.transitionCard(a.id, 'triage', 'human')
  store.transitionCard(a.id, 'plan', 'agent')
  store.appendReport(a.id, 'done some work', 'agent')
  return { store, a, b, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

test('collectAudit returns a flat, newest-first event stream across cards', () => {
  const { store, a, b, cleanup } = setup()
  try {
    const events = collectAudit(store, {})
    assert.ok(events.length >= 5) // 2 created + 2 transitions + 1 report
    assert.ok(events.every((event) => typeof event.cardId === 'string'))
    // newest first
    for (let i = 1; i < events.length; i += 1) assert.ok(String(events[i - 1].at) >= String(events[i].at))
    // both cards represented
    assert.ok(events.some((event) => event.cardId === b.id))
  } finally {
    cleanup()
  }
})

test('collectAudit filters by actor, decision and cardId', () => {
  const { store, a, cleanup } = setup()
  try {
    const humanEvents = collectAudit(store, { actor: 'human' })
    assert.ok(humanEvents.length >= 1)
    assert.ok(humanEvents.every((event) => event.actor === 'human'))

    const reports = collectAudit(store, { decision: 'report' })
    assert.equal(reports.length, 1)
    assert.equal(reports[0].cardId, a.id)

    const onlyA = collectAudit(store, { cardId: a.id })
    assert.ok(onlyA.every((event) => event.cardId === a.id))
  } finally {
    cleanup()
  }
})
