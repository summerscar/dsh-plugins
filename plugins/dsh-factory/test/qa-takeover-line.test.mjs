/**
 * QA — takeover line acceptance (PRD-TAKEOVER Approved), Q1–Q7 + this round's
 * boundary ③ (idempotent repeated release).
 *
 * Self-contained assertions only: fixed constants, real store/API round-trips,
 * real runTick with injected host deps, and source guards on client.js for the
 * render layer. No `git show HEAD:<file>` baseline. No business code changed.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'

import { FactoryStore } from '../store.js'
import { createApi } from '../api.js'
import { collectAudit } from '../audit.js'
import { createEngineStatus, runTick } from '../autonomy.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const clientSrc = readFileSync(join(packageRoot, 'client.js'), 'utf8')
const zhLocale = JSON.parse(readFileSync(join(packageRoot, 'locale', 'zh.json'), 'utf8'))
const enLocale = JSON.parse(readFileSync(join(packageRoot, 'locale', 'en.json'), 'utf8'))

// Key counts asserted relationally (zh == en == locale UI, locale = UI + meta);
// adding keys never expires the test. Real numbers reported in the handoff.

// ---- helpers ------------------------------------------------------------------
function withStore(fn) {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-takeover-line-'))
  try { return fn(join(tmp, 'factory.json'), tmp) } finally { rmSync(tmp, { recursive: true, force: true }) }
}

function setup() {
  return withStore((file) => {
    const store = new FactoryStore({ file })
    const project = store.createProject({ name: 'p', rootPath: '/workspace/p' })
    const board = store.createBoard({ projectId: project.id, name: 'main' })
    const api = createApi({ store, build: 'test' })
    return { store, project, board, api, file }
  })
}

function dispatchableFixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-takeover-tick-'))
  const file = join(tmp, 'factory.json')
  const store = new FactoryStore({ file })
  const project = store.createProject({ name: 'p', rootPath: '/workspace/p' })
  const board = store.createBoard({ projectId: project.id, name: 'main' })
  store.updateAutonomy(project.id, { autonomy: 'L1', autoStart: true })
  store.updateIntake(project.id, { issueRepo: 'owner/repo', intakeBoardId: board.id })
  const status = createEngineStatus()
  const calls = { dispatch: 0, intake: 0 }
  const active = new Map()
  const deps = {
    ghPort: {},
    intake: async () => ({ created: [] }),
    dispatch: async ({ store: s, cardId, transitionActor, transitionMeta }) => {
      calls.dispatch += 1
      const card = s.getCard(cardId)
      if (card.worktreePath || card.sessionId) return { mode: 'already-dispatched' }
      const sessionId = `s-${cardId}`
      active.set(sessionId, true)
      s.transitionCard(cardId, 'triage', transitionActor, undefined, transitionMeta)
      s.setWorktree(cardId, { worktreePath: `/tmp/wt-${cardId}`, branch: 'b', baseBranch: 'main', sessionId })
      return { mode: 'created' }
    },
    isSessionActive: async (id) => active.get(id) === true,
  }
  return { store, project, board, status, deps, calls, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

function loadInlineDicts() {
  let registered = null
  const shim = {
    createElement: () => ({}), useState: (v) => [v, () => {}], useEffect: () => {},
    useCallback: (fn) => fn, useRef: (v) => ({ current: v }),
  }
  const require = (n) => { if (n === 'react') return shim; throw new Error(n) }
  const sandbox = { window: { __ModuleLoader__: { load: (d) => { registered = d } } }, require, fetch: async () => ({ ok: true, text: async () => '{}' }), console }
  vm.runInNewContext(clientSrc, sandbox)
  let captured = null
  registered.factory(require).apply({
    effect: (fn) => { fn(); return () => {} },
    locale: { register: (_n, d) => { captured = d; return () => {} }, bind: () => (k) => k },
    slots: { inject: (_o, cb) => cb(), register: () => () => {} },
  })
  return JSON.parse(JSON.stringify(captured))
}

// ==============================================================================
// Q1 — takeover persists across reload; badge stays; takeover btn gone, return shown
// ==============================================================================
test('Q1 takeover persists across reload; store flags the card', () => setup((f) => {
  const card = f.store.createCard({ boardId: f.board.id, title: 'c' })
  const taken = f.store.takeOverCard(card.id, 'human')
  assert.equal(taken.takenOver, true)
  assert.equal(f.store.getCard(card.id).takenOver, true)
  // Simulate refresh: a brand-new store reading the same file.
  const reloaded = new FactoryStore({ file: f.file })
  assert.equal(reloaded.getCard(card.id).takenOver, true, 'reload cannot put it back on auto-dispatch')
}))

test('Q1 client render conditions: badge when takenOver; takeover hidden, return shown', () => {
  assert.match(clientSrc, /card\.takenOver === true \? h\(TakenOverBadge/, 'badge renders when takenOver===true')
  assert.match(clientSrc, /card\.takenOver !== true\) \{[\s\S]{0,80}t\('takeover'\)/, 'takeover button only when NOT taken over')
  assert.match(clientSrc, /if \(card\.takenOver === true\) \{[\s\S]{0,900}t\('returnToEngine'\)/, 'return button when takenOver===true')
  // The takeover and return branches are mutually exclusive on the same field.
  const takeoverBlock = clientSrc.match(/if \(card\.status !== 'done'[\s\S]*?\n      \}/)[0]
  assert.match(takeoverBlock, /card\.takenOver !== true/)
  const returnBlock = clientSrc.match(/if \(card\.takenOver === true\) \{[\s\S]*?\n      \}/)[0]
  assert.match(returnBlock, /card\.takenOver === true/)
})

// ==============================================================================
// Q2 — release: read-back false; session/lock/worktree untouched; audit returned
// ==============================================================================
test('Q2 release sets takenOver=false via API and appends actor=human returned-to-engine audit', () => setup((f) => {
  const card = f.store.createCard({ boardId: f.board.id, title: 'c' })
  f.store.takeOverCard(card.id, 'human')
  const beforeAudit = collectAudit(f.store, { decision: 'returned-to-engine' }).length

  const res = f.api({ method: 'POST', route: `/cards/${card.id}/release` })
  assert.equal(res.status, 200)
  assert.equal(res.body.card.takenOver, false)
  assert.equal(f.api({ method: 'GET', route: `/cards/${card.id}` }).body.card.takenOver, false, 'API read-back false')

  const events = collectAudit(f.store, { decision: 'returned-to-engine' })
  assert.equal(events.length, beforeAudit + 1, 'exactly one returned-to-engine audit added')
  const ev = events.find((e) => e.cardId === card.id)
  assert.ok(ev, 'audit names the card')
  assert.equal(ev.actor, 'human')
  assert.equal(ev.decision, 'returned-to-engine')
  assert.ok(typeof ev.at === 'string' && ev.at.length > 0, 'audit has a timestamp (when)')
}))

test('Q2 release leaves sessionId/pendingDispatch/worktree untouched', () => setup((f) => {
  const card = f.store.createCard({ boardId: f.board.id, title: 'c' })
  // Give the card a live session, a dispatch lock and a worktree.
  f.store.setWorktree(card.id, { worktreePath: '/tmp/wt-c', branch: 'b', baseBranch: 'main', sessionId: 'sess-1' })
  f.store.claimForDispatch(card.id)
  f.store.takeOverCard(card.id, 'human')
  const before = f.store.getCard(card.id)

  f.store.releaseOverCard(card.id, 'human')
  const after = f.store.getCard(card.id)
  assert.equal(after.takenOver, false)
  assert.equal(after.sessionId, before.sessionId, 'sessionId unchanged')
  assert.equal(after.pendingDispatch, before.pendingDispatch, 'pendingDispatch unchanged')
  assert.equal(after.worktreePath, before.worktreePath, 'worktree unchanged')
}))

test('Q2 a released card with a live session/lock/worktree is NOT re-dispatched next tick', async () => {
  const f = dispatchableFixture()
  try {
    const card = f.store.createCard({ boardId: f.board.id, title: 'already-live' })
    f.store.setWorktree(card.id, { worktreePath: '/tmp/wt', branch: 'b', baseBranch: 'main', sessionId: 'live-1' })
    f.store.takeOverCard(card.id, 'human')
    f.store.releaseOverCard(card.id, 'human') // returned to engine, but still has session/worktree

    await runTick({ store: f.store, status: f.status, deps: f.deps })
    assert.equal(f.calls.dispatch, 0, 'idempotency gate: card with worktree/session is not dispatched again')
    assert.equal(f.store.getCard(card.id).status, 'inbox', 'still Inbox, never re-provisioned')
  } finally { f.cleanup() }
})

// ==============================================================================
// Q3 — no immediate dispatch on release; next tick dispatches under original tier
// ==============================================================================
test('Q3 release does not dispatch by itself; next tick dispatches under L1 autoRule', async () => {
  const f = dispatchableFixture()
  try {
    const card = f.store.createCard({ boardId: f.board.id, title: 'wait-for-next-tick' })
    f.store.takeOverCard(card.id, 'human')
    const res = f.store.releaseOverCard(card.id, 'human')
    assert.equal(res.takenOver, false)
    assert.equal(f.calls.dispatch, 0, 'release is a pure state write, no session created')

    await runTick({ store: f.store, status: f.status, deps: f.deps })
    assert.equal(f.calls.dispatch, 1, 'next tick dispatches once under the project tier')
    const moved = f.store.getCard(card.id)
    assert.equal(moved.status, 'triage', 'dispatched and advanced Inbox->Triage')
    const autoTransition = moved.history.find((h) => h.type === 'transition' && h.to === 'triage')
    assert.equal(autoTransition.actor, 'autoRule', 'dispatched by the original L1 tier (autoRule)')
    assert.equal(autoTransition.tier, 'L1', 'transitionMeta carries the tier')
  } finally { f.cleanup() }
})

// ==============================================================================
// Q4 — badge visible on board card AND inbox list card (shared component/condition)
// ==============================================================================
test('Q4 board card and inbox list card reuse one renderCard and one badge condition', () => {
  // Single Card component holds the badge; inbox list uses the same renderCard.
  const cardDef = clientSrc.slice(clientSrc.indexOf('function Card('), clientSrc.indexOf('// Per-card action buttons'))
  assert.match(cardDef, /card\.takenOver === true \? h\(TakenOverBadge/)
  assert.match(clientSrc, /function Column\(\{ title, cards, t, renderCard \}\)/)
  assert.match(clientSrc, /cards\.map\(renderCard\)/, 'board column renders via renderCard')
  assert.match(clientSrc, /inboxCards\.map\(renderCard\)/, 'inbox list renders via the SAME renderCard')
  // Badge styles: non-compressible, right-aligned, warning palette, <=20px tall.
  const badge = clientSrc.slice(clientSrc.indexOf('function TakenOverBadge'), clientSrc.indexOf('function Card('))
  assert.match(badge, /marginLeft: 'auto'/)
  assert.match(badge, /flex: '0 0 auto'/)
  assert.match(badge, /T\.warningWash/)
  assert.match(badge, /T\.warningInk/)
  assert.match(badge, /borderRadius: 6/)
  assert.match(badge, /height: 20/)
  assert.match(badge, /whiteSpace: 'nowrap'/)
  assert.match(badge, /t\('takenOverBadgeTitle'\)/, 'badge title uses the Design key')
  assert.doesNotMatch(badge, /onClick/, 'badge is not clickable')
})

// ==============================================================================
// Q5 — return button copy / no second confirm / active-session notice match Design
// ==============================================================================
test('Q5 return button copy, no confirm, active-session notice — source + dicts', () => {
  const inline = loadInlineDicts()
  assert.equal(inline.zh.returnToEngine, zhLocale.returnToEngine)
  assert.equal(inline.zh.returnToEngine, '交还引擎')
  assert.equal(inline.zh.toastReturned, '已交还引擎，恢复自动处理')
  assert.equal(inline.zh.returnWithSessionNotice, '会话继续，引擎不会重复派发')
  assert.equal(inline.en.returnToEngine, 'Return to engine')
  assert.equal(inline.en.toastReturned, 'Returned to engine; automatic processing resumed')
  assert.equal(inline.en.returnWithSessionNotice, 'The session continues; the engine will not dispatch again.')

  const actionBlock = clientSrc.slice(clientSrc.indexOf('if (card.takenOver === true) {', clientSrc.indexOf('function CardActions')), clientSrc.indexOf("if (card.status === 'review')"))
  assert.match(actionBlock, /POST.*\/release/, 'return button calls /release')
  assert.match(actionBlock, /t\('returnToEngineTitle'\)/, 'title from Design key')
  assert.match(actionBlock, /ariaLabel: t\('returnToEngineTitle'\)/, 'aria-label from Design key')
  assert.match(actionBlock, /disabled: busy/, 'busy guard only, no confirm dialog')
  assert.doesNotMatch(actionBlock, /confirm\(|window\.confirm|showConfirm/, 'no second confirmation')
  assert.match(actionBlock, /live \? `\$\{t\('toastReturned'\)\}\\n\$\{t\('returnWithSessionNotice'\)\}`/, 'active session appends notice as 2nd line')
  assert.match(actionBlock, /const live = Boolean\(card\.sessionId\) \|\| Boolean\(card\.pendingDispatch\)/, 'live = session or dispatch lock')
  assert.match(clientSrc, /white-space:pre-line/, 'toast renders the newline (pre-line)')
  // Button size per Design: padding 5x9, 11px, radius 6, min 28px tall / 88px wide.
  assert.match(actionBlock, /padding: '5px 9px'/)
  assert.match(actionBlock, /minHeight: 28/)
  assert.match(actionBlock, /minWidth: 88/)
})

// ==============================================================================
// Q6 — audit queryable by who/when/which card; takeover vs return distinguishable
// ==============================================================================
test('Q6 audit distinguishes takeover vs returned-to-engine by actor/time/card', () => setup((f) => {
  const card = f.store.createCard({ boardId: f.board.id, title: 'c' })
  f.store.takeOverCard(card.id, 'human')
  f.store.releaseOverCard(card.id, 'human')

  const taken = collectAudit(f.store, { decision: 'taken-over', cardId: card.id })
  const returned = collectAudit(f.store, { decision: 'returned-to-engine', cardId: card.id })
  assert.equal(taken.length, 1)
  assert.equal(returned.length, 1)
  assert.equal(taken[0].actor, 'human')
  assert.equal(returned[0].actor, 'human')
  assert.notEqual(taken[0].decision, returned[0].decision, 'two event kinds distinguishable')
  assert.ok(taken[0].at && returned[0].at, 'both have timestamps')
  assert.ok(new Date(returned[0].at) >= new Date(taken[0].at), 'return is not before takeover')
  // Filtering by actor narrows both events.
  const byHuman = collectAudit(f.store, { actor: 'human', cardId: card.id })
  assert.ok(byHuman.some((e) => e.decision === 'taken-over'))
  assert.ok(byHuman.some((e) => e.decision === 'returned-to-engine'))
}))

// ==============================================================================
// Q7 — four dictionaries byte-identical + self-contained counts with real numbers
// ==============================================================================
test('Q7 self-contained key-count assertions (no HEAD baseline)', () => {
  const inline = loadInlineDicts()
  const zhUi = { ...zhLocale }; delete zhUi.meta
  const enUi = { ...enLocale }; delete enUi.meta
  assert.deepEqual(Object.keys(inline.zh).sort(), Object.keys(inline.en).sort(), 'inline zh == en key set')
  assert.deepEqual(Object.keys(zhUi).sort(), Object.keys(inline.zh).sort(), 'locale zh UI == inline key set')
  assert.deepEqual(Object.keys(enUi).sort(), Object.keys(inline.en).sort(), 'locale en UI == inline key set')
  assert.equal(Object.keys(zhLocale).length, Object.keys(zhUi).length + 1, 'locale zh = UI + meta')
  assert.equal(Object.keys(enLocale).length, Object.keys(enUi).length + 1, 'locale en = UI + meta')
  assert.ok('meta' in zhLocale && 'meta' in enLocale, 'meta accounts for the +1')
})

// ==============================================================================
// Boundary ③ — repeated direct POST /release is idempotent (silent no-op)
// ==============================================================================
test('B3 repeated direct POST /release does NOT add a second history/audit entry', () => setup((f) => {
  const card = f.store.createCard({ boardId: f.board.id, title: 'c' })
  f.store.takeOverCard(card.id, 'human')

  const first = f.api({ method: 'POST', route: `/cards/${card.id}/release` })
  assert.equal(first.status, 200)
  assert.equal(first.body.card.takenOver, false)
  const histAfterFirst = f.store.getCard(card.id).history.filter((h) => h.type === 'returned-to-engine').length
  const auditAfterFirst = collectAudit(f.store, { decision: 'returned-to-engine', cardId: card.id }).length
  assert.equal(histAfterFirst, 1)
  assert.equal(auditAfterFirst, 1)

  // Direct, repeated calls: card is already released (takenOver===false).
  for (let i = 0; i < 3; i += 1) {
    const again = f.api({ method: 'POST', route: `/cards/${card.id}/release` })
    assert.equal(again.status, 200, 'silent no-op, not an error')
    assert.equal(again.body.card.takenOver, false)
  }
  assert.equal(f.store.getCard(card.id).history.filter((h) => h.type === 'returned-to-engine').length, 1, 'no extra history')
  assert.equal(collectAudit(f.store, { decision: 'returned-to-engine', cardId: card.id }).length, 1, 'no extra audit')
}))

test('B3 store-level releaseOverCard is idempotent on a never-taken-over card', () => setup((f) => {
  const card = f.store.createCard({ boardId: f.board.id, title: 'c' }) // takenOver=false by default
  const beforeHist = f.store.getCard(card.id).history.length
  const beforeAudit = collectAudit(f.store, { decision: 'returned-to-engine' }).length
  const result = f.store.releaseOverCard(card.id, 'human')
  assert.equal(result.takenOver, false)
  assert.equal(f.store.getCard(card.id).history.length, beforeHist, 'no history written')
  assert.equal(collectAudit(f.store, { decision: 'returned-to-engine' }).length, beforeAudit, 'no audit written')
}))
