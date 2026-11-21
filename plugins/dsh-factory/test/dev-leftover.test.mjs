/**
 * Dev self-check — leftover 1: terminal-card delete route; leftover 2: split
 * dispatch vs commit failure counters.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { FactoryStore } from '../store.js'
import { ensureCommittedForAutoDelivery } from '../delivery.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const A = 'a'.repeat(40); const B = 'b'.repeat(40)
const indexSrc = readFileSync(join(root, 'index.js'), 'utf8')
const storeSrc = readFileSync(join(root, 'store.js'), 'utf8')
const clientSrc = readFileSync(join(root, 'client.js'), 'utf8')
const deliverySrc = readFileSync(join(root, 'delivery.js'), 'utf8')

function store() {
  const tmp = mkdtempSync(join(tmpdir(), 'dev-leftover-'))
  const s = new FactoryStore({ file: join(tmp, 'factory.json') })
  const p = s.createProject({ name: 'p', rootPath: '/workspace/p' })
  const b = s.createBoard({ projectId: p.id, name: 'b' })
  return { s, p, b, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

function cardAt(s, b, status) {
  const c = s.createCard({ boardId: b.id, title: 'c' })
  // Test fixture: set the terminal/live status directly — this test targets
  // deleteCard's terminal gate, not the transition chain into that status.
  s._card(c.id).status = status
  s._commit()
  return c
}

// ---------- leftover 1: terminal-card delete ----------

test('Dev-Delete: store.deleteCard removes a terminal card and audits it; live card refused', () => {
  const f = store()
  try {
    const canceled = cardAt(f.s, f.b, 'canceled')
    const before = f.s.state.events.length
    const r = f.s.deleteCard(canceled.id, { actor: 'human' })
    assert.equal(r.deleted, true)
    assert.equal(f.s.getCard(canceled.id), undefined, 'card body gone')
    assert.equal(f.s.listCards({ boardId: f.b.id }).some((c) => c.id === canceled.id), false, 'not in board list')
    assert.match(storeSrc, /deleteCard[\s\S]{0,500}pendingAuthorization/, 'delete clears pending authorization')
    const evs = f.s.state.events.slice(before)
    assert.ok(evs.some((e) => e.type === 'card-deleted' && e.targetId === canceled.id && e.actor === 'human'), 'delete audit with id/actor')
    // live card refused
    const live = cardAt(f.s, f.b, 'review')
    assert.throws(() => f.s.deleteCard(live.id, { actor: 'human' }), /仅终态卡可删除/)
    assert.ok(f.s.getCard(live.id), 'live card untouched')
  } finally { f.cleanup() }
})

test('Dev-Delete: DELETE route exists, requires confirm, guards terminal status', () => {
  assert.match(indexSrc, /method === 'DELETE'/)
  const route = indexSrc.match(/\/cards\/[^'"]*delete|\/cards\\\/\$\{[^}]+\}[^\n]*DELETE|cards\/:[^'"]*/)
  assert.ok(indexSrc.includes('/cards/') && indexSrc.includes("DELETE"), 'delete route wired on /cards')
  assert.match(indexSrc, /confirm !== true/, 'backend requires explicit confirm')
  assert.match(storeSrc, /仅终态卡可删除/, 'terminal-only reason in store')
  // UI: terminal cards get a delete button behind a modal
  assert.match(clientSrc, /deleteCard|actDeleteCard/, 'UI delete action present')
  assert.match(clientSrc, /onModal\(h\(Modal/, 'delete uses the confirm modal')
})

// ---------- leftover 2: split counters ----------

test('Dev-Counters: card has separate dispatchFailures and commitFailures', () => {
  const f = store()
  try {
    const c = f.s.createCard({ boardId: f.b.id, title: 'c' })
    const card = f.s.getCard(c.id)
    assert.equal(card.dispatchFailures, 0)
    assert.equal(card.commitFailures, 0, 'commit counter field exists')
    assert.equal(card.commitStalled, false, 'commit stalled flag exists')
    assert.match(storeSrc, /recordCommitFailure\(/)
    assert.match(storeSrc, /clearCommitFailures\(/)
  } finally { f.cleanup() }
})

test('Dev-Counters: dispatch failures do not stall the commit stage', async () => {
  const f = store()
  try {
    const c = f.s.createCard({ boardId: f.b.id, title: 'c' })
    // simulate 2 inbox dispatch failures
    f.s.recordDispatchFailure(c.id, { reason: 'x' })
    f.s.recordDispatchFailure(c.id, { reason: 'x' })
    assert.equal(f.s.getCard(c.id).dispatchFailures, 2)
    // a first commit failure must NOT trip commit-stall just because dispatch is at 2
    const r = f.s.recordCommitFailure(c.id, { reason: 'commit x' })
    assert.equal(r.failures, 1)
    assert.equal(r.tripped, false, 'commit stage independent')
    assert.equal(f.s.getCard(c.id).commitStalled, false)
  } finally { f.cleanup() }
})

test('Dev-Counters: 3 commit failures stall commit stage but dispatch gate unaffected', async () => {
  const f = store()
  try {
    const c = f.s.createCard({ boardId: f.b.id, title: 'c' })
    for (let i = 0; i < 3; i += 1) {
      const r = f.s.recordCommitFailure(c.id, { reason: 'x' })
      assert.equal(r.tripped, i === 2)
    }
    const card = f.s.getCard(c.id)
    assert.equal(card.commitStalled, true)
    assert.equal(card.commitFailures, 3)
    assert.equal(card.stalled, false, 'dispatch stall flag untouched')
    assert.equal(card.dispatchFailures, 0)
  } finally { f.cleanup() }
})

test('Dev-Counters: clearCommitFailures resets only commit stage', () => {
  const f = store()
  try {
    const c = f.s.createCard({ boardId: f.b.id, title: 'c' })
    f.s.recordCommitFailure(c.id, { reason: 'x' })
    f.s.recordCommitFailure(c.id, { reason: 'x' })
    f.s.recordCommitFailure(c.id, { reason: 'x' })
    f.s.recordDispatchFailure(c.id, { reason: 'y' })
    f.s.clearCommitFailures(c.id)
    const card = f.s.getCard(c.id)
    assert.equal(card.commitFailures, 0)
    assert.equal(card.commitStalled, false)
    assert.equal(card.dispatchFailures, 1, 'dispatch failures preserved')
  } finally { f.cleanup() }
})

test('Dev-Counters: delivery commit path uses commit counter, not dispatch counter', () => {
  assert.match(deliverySrc, /recordCommitFailure\(cardId/, 'commit failure uses commit counter')
  assert.match(deliverySrc, /clearCommitFailures\(cardId/, 'commit success clears commit counter')
  assert.doesNotMatch(deliverySrc, /recordDispatchFailure\(cardId/, 'no dispatch counter on commit path')
})

// ---------- integration: real delivery path uses the split counter ----------

const git = (d, ...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const SHA = 'a'.repeat(40)

function commitFixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'dev-leftover-commit-'))
  const repo = join(tmp, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q'); git(repo, 'checkout', '-qb', 'main')
  writeFileSync(join(repo, 'README.md'), '# p\n')
  git(repo, 'add', 'README.md'); git(repo, '-c', 'user.name=T', '-c', 'user.email=t@l', 'commit', '-qm', 'init')
  const head = git(repo, 'rev-parse', 'HEAD').trim()
  const s = new FactoryStore({ file: join(tmp, 'factory.json') })
  const p = s.createProject({ name: 'p', rootPath: repo })
  const b = s.createBoard({ projectId: p.id, name: 'b' })
  const c = s.createCard({ boardId: b.id, title: 'c' })
  s.setWorktree(c.id, { worktreePath: repo, branch: 'factory/probe', baseBranch: 'main', sessionId: 'builder' })
  s.updateAutonomy(p.id, { autonomy: 'auto-delivery' })
  for (const to of ['triage', 'plan', 'plan-review', 'build', 'review']) {
    s.transitionCard(c.id, to, to === 'triage' ? 'human' : to === 'build' ? 'autoRule' : 'agent')
  }
  return { s, c, repo, head, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

test('Dev-Counters: 2 inbox failures then first real commit failure does not stall commit stage', async () => {
  const f = commitFixture()
  try {
    f.s.recordDispatchFailure(f.c.id, { reason: 'inbox x' })
    f.s.recordDispatchFailure(f.c.id, { reason: 'inbox x' })
    writeFileSync(join(f.repo, 'dirty.ts'), 'x') // dirty tree
    const port = { isWorktreeClean: () => false, add: () => { throw new Error('add exploded') }, commit: () => SHA }
    const r = await ensureCommittedForAutoDelivery({ store: f.s, cardId: f.c.id, port })
    assert.equal(r.ok, false)
    const card = f.s.getCard(f.c.id)
    assert.equal(card.commitFailures, 1)
    assert.equal(card.commitStalled, false, 'first commit failure does not stall even with 2 dispatch failures')
    assert.equal(card.stalled, false, 'dispatch stall untouched')
  } finally { f.cleanup() }
})

test('Dev-Counters: a successful commit resets commitFailures to zero', async () => {
  const f = commitFixture()
  try {
    f.s.recordCommitFailure(f.c.id, { reason: 'prior' })
    f.s.recordCommitFailure(f.c.id, { reason: 'prior' })
    assert.equal(f.s.getCard(f.c.id).commitFailures, 2)
    writeFileSync(join(f.repo, 'dirty.ts'), 'x')
    const port = { isWorktreeClean: () => false, add: () => {}, commit: () => SHA }
    const r = await ensureCommittedForAutoDelivery({ store: f.s, cardId: f.c.id, port })
    assert.equal(r.committed, true)
    assert.equal(f.s.getCard(f.c.id).commitFailures, 0, 'commit success resets commit counter')
    assert.equal(f.s.getCard(f.c.id).commitStalled, false)
  } finally { f.cleanup() }
})
