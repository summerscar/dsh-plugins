/**
 * QA — `card.repo` vs `card.repoPath` separation (ROADMAP §5 prerequisite).
 *
 * The bug this guards: `intake.js` writes a GitHub identifier (`owner/name`) into
 * `card.repo`, while `session-context.js` used to read `card.repo` as a LOCAL
 * filesystem path and hand it to the session. The agent then received
 * `summerscar/dsh-plugins` where it expected `/workspace/dsh-plugins`.
 *
 * Contract under test:
 *   - `card.repo`     = remote identifier (unchanged, still what intake writes)
 *   - `card.repoPath` = local filesystem path (new)
 *   - `repoOf` prefers `repoPath`, then project.repos[0].path, then project.rootPath
 *   - OLD cards (no repoPath) still resolve to a usable path — never crash
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FactoryStore } from '../store.js'
import { buildSessionContext } from '../session-context.js'
import { intakeIssues } from '../intake.js'

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-repo-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: '/workspace/dsh-plugins' })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  return { store, project, board, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

test('new card: repo is the remote id, repoPath is the local path — never mixed', () => {
  const { store, project, board, cleanup } = setup()
  try {
    const card = store.createCard({
      boardId: board.id, title: 't', repo: 'summerscar/dsh-plugins', repoPath: '/workspace/dsh-plugins',
    })
    const fresh = store.getCard(card.id)
    assert.equal(fresh.repo, 'summerscar/dsh-plugins', 'repo stays the remote identifier')
    assert.equal(fresh.repoPath, '/workspace/dsh-plugins', 'repoPath holds the local path')

    const built = buildSessionContext({ card: fresh, project })
    assert.equal(built.repo, '/workspace/dsh-plugins',
      'the session context must present the LOCAL PATH, not the GitHub id')
    assert.ok(!String(built.repo).includes('summerscar/'),
      'the GitHub identifier must never leak into the session repo field')
  } finally { cleanup() }
})

test('old archived card (only repo, no repoPath) still resolves to a usable path', () => {
  const { store, project, board, cleanup } = setup()
  try {
    // Simulate a card written before this change: only `repo` (a remote id), and
    // no `repoPath` key at all.
    const card = store.createCard({ boardId: board.id, title: 'legacy', repo: 'summerscar/dsh-plugins' })
    const fresh = store.getCard(card.id)
    assert.equal(fresh.repoPath, null, 'a card created without repoPath has it null, not undefined')

    const built = buildSessionContext({ card: fresh, project })
    assert.equal(built.repo, '/workspace/dsh-plugins',
      'a legacy card must fall back to project.rootPath, not emit the GitHub id or null')
  } finally { cleanup() }
})

test('repoOf falls back through project.repos[0].path when neither card path is set', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-repo2-'))
  try {
    const store = new FactoryStore({ file: join(tmp, 'factory.json') })
    const project = store.createProject({ name: 'p', rootPath: '/workspace/root', repos: ['/workspace/repo-a'] })
    const board = store.createBoard({ projectId: project.id, name: 'b' })
    const card = store.createCard({ boardId: board.id, title: 't', repo: 'owner/name' })
    const built = buildSessionContext({ card: store.getCard(card.id), project: store.getProject(project.id) })
    assert.equal(built.repo, '/workspace/repo-a', 'project.repos[0].path wins over rootPath')
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('intake writes repoPath = project root while leaving repo as the GitHub id', async () => {
  const { store, project, board, cleanup } = setup()
  try {
    const ghPort = {
      listIssues: async () => JSON.stringify([
        { number: 1, title: 'first', body: 'b1' },
      ]),
    }
    const result = await intakeIssues({
      store, projectId: project.id, boardId: board.id, repo: 'summerscar/dsh-plugins', ghPort,
    })
    assert.ok(Array.isArray(result.created) && result.created.length === 1)
    const card = store.getCard(result.created[0])
    assert.equal(card.repo, 'summerscar/dsh-plugins', 'repo keeps the remote identifier')
    assert.equal(card.repoPath, '/workspace/dsh-plugins', 'repoPath is set to the project root')

    const built = buildSessionContext({ card, project: store.getProject(project.id) })
    assert.equal(built.repo, '/workspace/dsh-plugins', 'session gets the local path, not the id')
  } finally { cleanup() }
})

test('intake without a projectId leaves repoPath unusable and does not crash', async () => {
  // Chief's boundary: a global intake call has no project. There is no local root
  // to record, so repoPath must not carry an invented path.
  //
  // VERIFIED BEHAVIOUR (not assumed): the KEY exists with value null — createCard
  // always normalises `repoPath: optionalString(input.repoPath)`, exactly like
  // `repo`. It is NOT an absent key. What matters is that it is unusable (not a
  // non-empty string) so `repoOf` falls through, and nothing throws.
  const { store, board, cleanup } = setup()
  try {
    const ghPort = { listIssues: async () => JSON.stringify([{ number: 202, title: 'g', body: '' }]) }
    const result = await intakeIssues({
      store, projectId: undefined, boardId: board.id, repo: 'owner/name', ghPort,
    })
    assert.ok(Array.isArray(result.created) && result.created.length === 1)
    const card = store.getCard(result.created[0])
    assert.equal(card.repo, 'owner/name')
    assert.ok(!(typeof card.repoPath === 'string' && card.repoPath !== ''),
      `a global intake card must not record a usable repoPath, got ${JSON.stringify(card.repoPath)}`)
    // Behaviour that actually matters: the fallback still yields a sane value and
    // does not throw. With no project passed, repo is null (no root to fall back to).
    assert.doesNotThrow(() => buildSessionContext({ card, project: undefined }))
  } finally { cleanup() }
})
