/**
 * Intake tests — issue normalisation, dedupe, and the intake orchestration with a
 * fake gh port. No network, no host.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FactoryStore } from '../store.js'
import { intakeIssues, parseIssueList, selectNewIssues } from '../intake.js'

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'factory-intake-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: '/workspace/example-repo' })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  return { store, project, board, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

const ISSUES = [
  { number: 1, title: 'Fix bug', body: 'details', url: 'https://github.com/o/r/issues/1', labels: [{ name: 'bug' }] },
  { number: 2, title: 'Add feature', body: '', url: 'https://github.com/o/r/issues/2', labels: [] },
]

test('parseIssueList normalises gh JSON and skips entries without a number', () => {
  const issues = parseIssueList('o/r', JSON.stringify([...ISSUES, { title: 'no number' }]))
  assert.equal(issues.length, 2)
  assert.equal(issues[0].key, 'issue:o/r#1')
  assert.equal(issues[0].title, 'Fix bug')
  assert.deepEqual(issues[0].labels, ['bug'])
})

test('selectNewIssues drops issues whose key already exists', () => {
  const issues = parseIssueList('o/r', ISSUES)
  const fresh = selectNewIssues(issues, new Set(['issue:o/r#1']))
  assert.deepEqual(fresh.map((issue) => issue.number), [2])
})

test('intake turns new issues into Inbox cards and dedupes on a second poll', async () => {
  const { store, project, board, cleanup } = setup()
  try {
    const ghPort = { listIssues: () => JSON.stringify(ISSUES) }
    const first = await intakeIssues({ store, projectId: project.id, boardId: board.id, repo: 'o/r', ghPort })
    assert.equal(first.created.length, 2)
    assert.equal(first.skipped, 0)

    const cards = store.listCards({ projectId: project.id })
    assert.equal(cards.length, 2)
    assert.ok(cards.every((card) => card.status === 'inbox'))
    assert.deepEqual(cards.map((card) => card.source).sort(), ['issue:o/r#1', 'issue:o/r#2'])

    // Poll again: nothing new, everything skipped, no duplicate cards.
    const second = await intakeIssues({ store, projectId: project.id, boardId: board.id, repo: 'o/r', ghPort })
    assert.equal(second.created.length, 0)
    assert.equal(second.skipped, 2)
    assert.equal(store.listCards({ projectId: project.id }).length, 2)
  } finally {
    cleanup()
  }
})
