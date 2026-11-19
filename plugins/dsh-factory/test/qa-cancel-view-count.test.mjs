/**
 * QA — PRD-CANCEL-VIEW + COUNT acceptance (V1–V7), fast lane.
 *
 * These three changes are pure client.js render/count logic. Rather than merely
 * guarding source text, the counting/fold expressions are EXTRACTED FROM THE
 * SHIPPED client.js and EVALUATED against real FactoryStore/createApi data, so
 * the assertions run the actual shipped expressions. Render-only invariants
 * (read-only cards, 5-column layout, fold pattern) use source guards.
 *
 * Self-contained: fixed copy + real API/store read-back, no git show HEAD.
 * No business code changed; no commit. V6 reuses the existing C2 case.
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

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const clientSrc = readFileSync(join(packageRoot, 'client.js'), 'utf8')
const zhLocale = JSON.parse(readFileSync(join(packageRoot, 'locale', 'zh.json'), 'utf8'))
const enLocale = JSON.parse(readFileSync(join(packageRoot, 'locale', 'en.json'), 'utf8'))

// Exact shipped expressions, pulled from client.js (self-contained, no HEAD).
const STAT_EXPR = clientSrc.match(/stat\('sc', ([^,]+), t\('statCards'\)\)/)?.[1]
const CARDCOUNTS_LOOP = clientSrc.match(/const cardCounts = \{\}([\s\S]*?)\n\s*\/\/ 'auto' resolves/)?.[1]
const FOLD_SUMMARY_TPL = clientSrc.match(/key: 'ch',[\s\S]*?\}, (`[^`]*`)\),/)?.[1]

function fixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-cancel-view-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: '/workspace/p' })
  const board = store.createBoard({ projectId: project.id, name: 'main' })
  const api = createApi({ store, build: 'test' })
  return { store, project, board, api }
}

function cancel(api, id) {
  const r = api({ method: 'POST', route: `/cards/${id}/transition`, body: { to: 'canceled', actor: 'human' } })
  assert.equal(r.status, 200)
}

/** boardCards/canceledCards exactly as BoardPage derives them from a loaded board. */
function boardView(store, boardId) {
  const allCards = store.listCards({})
  const boardProject = new Map(store.listBoards().map((b) => [b.id, b.projectId]))
  const boardCards = allCards.filter((c) => c.boardId === boardId)
  const canceledCards = boardCards.filter((c) => c.status === 'canceled')
  return { allCards, boardProject, boardCards, canceledCards }
}

/** Evaluate the shipped stat expression against real arrays. */
function statCardsOf(view) {
  assert.ok(STAT_EXPR, 'stat expression extracted')
  return new Function('boardCards', 'canceledCards', `return ${STAT_EXPR}`)(view.boardCards, view.canceledCards)
}

/** Evaluate the shipped cardCounts loop against real arrays. */
function cardCountsOf(view) {
  assert.ok(CARDCOUNTS_LOOP, 'cardCounts loop extracted')
  return new Function('cards', 'boardProject', 'cardCounts', `${CARDCOUNTS_LOOP}\nreturn cardCounts`)(
    view.allCards, view.boardProject, {},
  )
}

/** Render the shipped fold-summary template with zh t() and real canceledCards. */
function foldSummaryOf(view) {
  assert.ok(FOLD_SUMMARY_TPL, 'fold summary template extracted')
  // Template references t('canceled') and canceledCards.length only.
  return new Function('t', 'canceledCards', `return ${FOLD_SUMMARY_TPL}`)(
    (k) => zhLocale[k], view.canceledCards,
  )
}

// ==============================================================================
// V1 — cancel one card → fold summary '已取消 · N' +1; expanded shows title+body
// ==============================================================================
test('V1 fold summary count comes from canceled set and increments on cancel', () => {
  const f = fixture()
  const a = f.store.createCard({ boardId: f.board.id, title: 'A', body: '正文 A' })
  f.store.createCard({ boardId: f.board.id, title: 'B' })
  const before = foldSummaryOf(boardView(f.store, f.board.id))
  assert.equal(before, '已取消 · 0')
  cancel(f.api, a.id)
  const after = foldSummaryOf(boardView(f.store, f.board.id))
  assert.equal(after, '已取消 · 1', 'N -> N+1')
  const canceled = f.store.getCard(a.id)
  assert.equal(canceled.title, 'A')
  assert.equal(canceled.body, '正文 A', 'title + body available to renderCard')
})

test('V1 fold bar renders canceledCards via renderCard (title + body summary)', () => {
  assert.match(clientSrc, /h\('details', \{ key: 'canceled'/, 'fold is a <details>')
  assert.match(clientSrc, /key: 'list',[\s\S]{0,160}canceledCards\.map\(renderCard\)/, 'expanded content = canceledCards.map(renderCard)')
  // renderCard renders Card (which shows title + 2-line body summary) + actions.
  // Card now also takes working/sessionRows/uiWorkspace/onOpenReports (live
  // session signal + reports entry); only assert it still renders Card with
  // `card` and the new `onOpenReports` entry, not the exact prop list.
  const renderCardBlock = clientSrc.slice(clientSrc.indexOf('const renderCard ='), clientSrc.indexOf('const renderPage ='))
  assert.match(renderCardBlock, /h\(Card, \{[\s\S]*?\bcard\b[\s\S]*?onOpenReports/, 'Card renders title + body summary and passes card + onOpenReports')
})

// ==============================================================================
// V2 — expanded canceled card read-only; fold does not disturb 5 columns / layout
// ==============================================================================
test('V2 every CardActions button is gated off at canceled (read-only)', () => {
  const actions = clientSrc.slice(clientSrc.indexOf('function CardActions'), clientSrc.indexOf('function Column'))
  // All six button branches key off non-terminal conditions; none is unconditional.
  for (const key of ['actDispatch', 'actApprovePlan', 'takeover', 'returnToEngine', 'actConfirmCommit', 'actMarkDone', 'cancelCard']) {
    const idx = actions.indexOf(`'${key}'`)
    assert.ok(idx > 0, `${key} present`)
  }
  assert.match(actions, /if \(card\.status !== 'done' && card\.status !== 'canceled'\)/, 'takeover + cancel gated off at canceled')
  assert.match(actions, /if \(card\.takenOver === true\)/, 'return gated by takenOver')
  assert.match(actions, /if \(card\.status === 'plan-review'\)/, 'approve gated')
  assert.match(actions, /if \(card\.status === 'review'\)/, 'commit/pr/done gated')
  assert.match(actions, /if \(buttons\.length === 0\) return null/, 'no buttons → no action bar')
})

test('V2 fold replicates the inbox details/summary pattern; five columns unchanged', () => {
  const inbox = clientSrc.slice(clientSrc.indexOf("key: 'inbox',"), clientSrc.indexOf('].filter(Boolean))', clientSrc.indexOf("key: 'inbox',")))
  const fold = clientSrc.slice(clientSrc.indexOf("key: 'canceled',"), clientSrc.indexOf("return renderPage()", clientSrc.indexOf("key: 'canceled',")))
  for (const style of ['cursor: \'pointer\'', 'fontWeight: 600', 'whiteSpace: \'nowrap\'', 'textOverflow: \'ellipsis\'']) {
    assert.ok(inbox.includes(style), `inbox summary has ${style}`)
    assert.ok(fold.includes(style), `canceled fold summary mirrors ${style}`)
  }
  assert.match(fold, /key: 'list', style: \{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 \}/, 'same list style as inbox')
  // Board still maps exactly the five COLUMNS; fold is appended after them.
  assert.match(clientSrc, /COLUMNS\.map\(\(column\)/, 'five-column board still rendered')
  assert.match(clientSrc, /COLUMNS = \[[\s\S]{0,600}\]/, 'COLUMNS intact')
})

// ==============================================================================
// V3 — cancel N cards → top-right stat and rail/tab counts both drop by N
// ==============================================================================
test('V3 shipped stat expression drops by N on cancel', () => {
  const f = fixture()
  const cards = ['a', 'b', 'c'].map((t) => f.store.createCard({ boardId: f.board.id, title: t }))
  assert.equal(statCardsOf(boardView(f.store, f.board.id)), 3)
  cancel(f.api, cards[0].id)
  assert.equal(statCardsOf(boardView(f.store, f.board.id)), 2, '1 cancel → 3-1')
  cancel(f.api, cards[1].id)
  assert.equal(statCardsOf(boardView(f.store, f.board.id)), 1, '2 cancel → 3-2')
})

test('V3 shipped cardCounts loop (rail + tab shared) drops by N on cancel', () => {
  const f = fixture()
  const cards = ['a', 'b', 'c'].map((t) => f.store.createCard({ boardId: f.board.id, title: t }))
  const view0 = boardView(f.store, f.board.id)
  assert.equal(cardCountsOf(view0)[f.project.id], 3, 'rail/tab count starts 3')
  cancel(f.api, cards[0].id)
  assert.equal(cardCountsOf(boardView(f.store, f.board.id))[f.project.id], 2)
  cancel(f.api, cards[1].id)
  assert.equal(cardCountsOf(boardView(f.store, f.board.id))[f.project.id], 1)
  // stat and cardCounts agree after each cancel (both exclude canceled).
  const v = boardView(f.store, f.board.id)
  assert.equal(statCardsOf(v), cardCountsOf(v)[f.project.id], 'top-right == rail/tab')
})

// ==============================================================================
// V4 — all three canceled → stat 0, fold '已取消 · 3', conservation
// ==============================================================================
test('V4 three canceled → stat 0, fold N=3, quantity conserved', () => {
  const f = fixture()
  const cards = ['a', 'b', 'c'].map((t) => f.store.createCard({ boardId: f.board.id, title: t }))
  cards.forEach((c) => cancel(f.api, c.id))
  const v = boardView(f.store, f.board.id)
  assert.equal(v.canceledCards.length, 3)
  assert.equal(statCardsOf(v), 0, 'top-right shows 0, not 3')
  assert.equal(cardCountsOf(v)[f.project.id] ?? 0, 0, 'rail/tab shows 0')
  assert.equal(foldSummaryOf(v), '已取消 · 3')
  // Conservation: non-canceled stat + canceled count == total cards on board.
  assert.equal(statCardsOf(v) + v.canceledCards.length, v.boardCards.length, 'conservation')
})

// ==============================================================================
// V5 — done card still counted and still visible in the 完成 column
// ==============================================================================
test('V5 done counted in stat and cardCounts; done column still includes it', () => {
  const f = fixture()
  const inbox = f.store.createCard({ boardId: f.board.id, title: 'inbox' })
  const done = f.store.createCard({ boardId: f.board.id, title: 'done' })
  for (const [to, actor] of [['triage', 'human'], ['plan', 'agent'], ['plan-review', 'agent'], ['build', 'human'], ['review', 'agent'], ['done', 'human']]) {
    f.store.transitionCard(done.id, to, actor)
  }
  assert.equal(f.store.getCard(done.id).status, 'done')
  const v = boardView(f.store, f.board.id)
  assert.equal(statCardsOf(v), 2, 'inbox + done both counted')
  assert.equal(cardCountsOf(v)[f.project.id], 2)
  assert.ok(v.boardCards.some((c) => c.id === done.id && c.status === 'done'), 'done card in boardCards → visible in 完成 column')
  // Cancel the inbox card: done alone still counts as 1.
  cancel(f.api, inbox.id)
  const v2 = boardView(f.store, f.board.id)
  assert.equal(statCardsOf(v2), 1, 'done survives cancellation of another card')
})

// ==============================================================================
// V6 — auto card cancellation no-revive: reuse the existing C2 case (run here too)
// ==============================================================================
test('V6 auto card source occupies after cancel; second intake does not rebuild', async () => {
  const { intakeIssues } = await import('../intake.js')
  const f = fixture()
  const issue = { number: 9, title: 'auto', body: 'b', url: 'https://github.com/o/r/issues/9', labels: [] }
  const ghPort = { listIssues: () => JSON.stringify([issue]) }
  const first = await intakeIssues({ store: f.store, projectId: f.project.id, boardId: f.board.id, repo: 'o/r', ghPort })
  assert.equal(first.created.length, 1)
  const card = f.store.getCard(first.created[0])
  assert.ok(card.source && card.source !== 'manual')
  cancel(f.api, card.id)
  const second = await intakeIssues({ store: f.store, projectId: f.project.id, boardId: f.board.id, repo: 'o/r', ghPort })
  assert.equal(second.created.length, 0, 'no rebuild (same as C2)')
  assert.equal(second.skipped, 1)
  assert.equal(f.store.getCard(card.id).status, 'canceled')
})

// ==============================================================================
// V7 — no dictionary change: key counts unchanged, 2/2 cancel keys consistent
// ==============================================================================
test('V7 four dictionaries unchanged (relational counts) + cancel keys intact', () => {
  let registered = null
  const shim = { createElement: () => ({}), useState: (v) => [v, () => {}], useEffect: () => {}, useCallback: (f) => f, useRef: (v) => ({ current: v }) }
  const require = (n) => { if (n === 'react') return shim; throw new Error(n) }
  const sandbox = { window: { __ModuleLoader__: { load: (d) => { registered = d } } }, require, fetch: async () => ({ ok: true, text: async () => '{}' }), console }
  vm.runInNewContext(clientSrc, sandbox)
  let captured = null
  registered.factory(require).apply({
    effect: (fn) => { fn(); return () => {} },
    locale: { register: (_n, d) => { captured = d; return () => {} }, bind: () => (k) => k },
    slots: { inject: (_o, cb) => cb(), register: () => () => {} },
  })
  const inline = JSON.parse(JSON.stringify(captured))
  const zhUi = { ...zhLocale }; delete zhUi.meta
  const enUi = { ...enLocale }; delete enUi.meta
  assert.deepEqual(Object.keys(inline.zh).sort(), Object.keys(inline.en).sort())
  assert.deepEqual(Object.keys(zhUi).sort(), Object.keys(inline.zh).sort())
  assert.deepEqual(Object.keys(enUi).sort(), Object.keys(inline.en).sort())
  assert.equal(Object.keys(zhLocale).length, Object.keys(zhUi).length + 1)
  assert.equal(Object.keys(enLocale).length, Object.keys(enUi).length + 1)
  assert.equal(inline.zh.cancelCard, zhLocale.cancelCard, '取消卡片')
  assert.equal(inline.zh.toastCardCanceled, zhLocale.toastCardCanceled)
  assert.equal(inline.en.cancelCard, enLocale.cancelCard, 'Cancel card')
  assert.equal(inline.en.toastCardCanceled, enLocale.toastCardCanceled)
})
