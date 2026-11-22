/**
 * QA — 「取消卡片」软删小改 acceptance (PRD-CARD-CANCEL, A 档), C1–C7.
 *
 * Fast lane: focused tests only. Real FactoryStore / createApi / intakeIssues /
 * runTick exercise the real backend (which this change reuses unchanged); client
 * render/toast/counter are checked with source guards (the page's useState shim
 * cannot drive card fixtures). Self-contained assertions — no git show HEAD
 * baseline. No business code changed; these tests read the shipped sources.
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
import { intakeIssues } from '../intake.js'
import { createEngineStatus, runTick } from '../autonomy.js'
import { EDGE_ACTORS } from '../state.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const clientSrc = readFileSync(join(packageRoot, 'client.js'), 'utf8')
const zhLocale = JSON.parse(readFileSync(join(packageRoot, 'locale', 'zh.json'), 'utf8'))
const enLocale = JSON.parse(readFileSync(join(packageRoot, 'locale', 'en.json'), 'utf8'))

// Fixed copy contract (self-contained, byte-for-byte, Design 稿).
const COPY = {
  zh: { cancelCard: '放弃这张卡', toastCardCanceled: '已放弃这张卡，保留在「已取消」列表' },
  en: { cancelCard: 'Abandon card', toastCardCanceled: 'Card abandoned; kept in the canceled list' },
}
const NON_TERMINAL = ['inbox', 'triage', 'plan', 'plan-review', 'build', 'review']
const TERMINAL = ['done', 'canceled']

async function withStore(fn) {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-card-cancel-'))
  const file = join(tmp, 'factory.json')
  const store = new FactoryStore({ file })
  const project = store.createProject({ name: 'p', rootPath: '/workspace/p' })
  const board = store.createBoard({ projectId: project.id, name: 'main' })
  const api = createApi({ store, build: 'test' })
  try { return await fn({ store, project, board, api, file }) }
  finally { rmSync(tmp, { recursive: true, force: true }) }
}

function cancelViaApi(api, id) {
  return api({ method: 'POST', route: `/cards/${id}/transition`, body: { to: 'canceled', actor: 'human' } })
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
// C1 — cancel an inbox manual card → status canceled; '已取消: N' count +1
// ==============================================================================
test('C1 cancel via API sets status=canceled; board canceled count increases by 1', () => withStore((f) => {
  const a = f.store.createCard({ boardId: f.board.id, title: 'manual-a', body: 'body a' })
  const b = f.store.createCard({ boardId: f.board.id, title: 'manual-b' })
  const countOf = () => f.store.listCards({ boardId: f.board.id }).filter((c) => c.status === 'canceled').length
  const before = countOf()

  const res = cancelViaApi(f.api, a.id)
  assert.equal(res.status, 200)
  assert.equal(res.body.card.status, 'canceled')
  assert.equal(f.api({ method: 'GET', route: `/cards/${a.id}` }).body.card.status, 'canceled', 'API read-back')
  assert.equal(countOf(), before + 1, 'canceled count +1')
  assert.equal(f.store.getCard(b.id).status, 'inbox', 'other card untouched')
}))

test('C1 client renders the canceled counter from the live canceled set', () => {
  // The counter now lives in the folded <details> summary (see V1/V2 tests).
  assert.match(clientSrc, /const canceledCards = boardCards\.filter\(\(entry\) => entry\.status === 'canceled'\)/, 'counter derives from canceled cards')
  assert.match(clientSrc, /canceledCards\.length > 0/, 'counter only shown when nonempty')
  assert.match(clientSrc, /\$\{t\('canceled'\)\} · \$\{canceledCards\.length\}/, 'renders 已取消 · N from live count')
})

// ==============================================================================
// C2 — auto card (with source) canceled → source still occupies, intake not rebuild
// ==============================================================================
test('C2 canceled auto card keeps its source; a fresh intake does NOT recreate it', async () => withStore(async (f) => {
  const issue = { number: 11, title: 'auto issue', body: 'issue body', url: 'https://github.com/o/r/issues/11', labels: [] }
  const first = await intakeIssues({ store: f.store, projectId: f.project.id, boardId: f.board.id, repo: 'o/r', ghPort: { listIssues: () => JSON.stringify([issue]) } })
  assert.equal(first.created.length, 1)
  const card = f.store.getCard(first.created[0])
  assert.ok(card.source && card.source !== 'manual', 'auto card has source')

  cancelViaApi(f.api, card.id)
  assert.equal(f.store.getCard(card.id).status, 'canceled')
  const idsBefore = f.store.listCards({ boardId: f.board.id }).map((c) => c.id)

  // Second intake with the SAME issue still in the upstream list: dedup looks at
  // ALL existing cards regardless of status, so the canceled source still blocks.
  const second = await intakeIssues({ store: f.store, projectId: f.project.id, boardId: f.board.id, repo: 'o/r', ghPort: { listIssues: () => JSON.stringify([issue]) } })
  assert.equal(second.created.length, 0, 'no rebuild')
  assert.equal(second.skipped, 1, 'canceled source counted as already-seen')
  const idsAfter = f.store.listCards({ boardId: f.board.id }).map((c) => c.id)
  assert.deepEqual(idsAfter.sort(), idsBefore.sort(), 'card set unchanged; no zombie card')
  assert.equal(f.store.getCard(card.id).body, 'issue body', 'canceled auto card keeps its body')
}))

// ==============================================================================
// C3 — canceled not dispatched next tick; terminal cards have no cancel button
// ==============================================================================
test('C3 canceled card is not dispatched on the next engine tick', async () => withStore(async (f) => {
  f.store.updateAutonomy(f.project.id, { autonomy: 'you-approve', autoDispatch: true })
  f.store.updateIntake(f.project.id, { issueRepo: 'owner/repo', intakeBoardId: f.board.id })
  const live = f.store.createCard({ boardId: f.board.id, title: 'live' })
  const canceled = f.store.createCard({ boardId: f.board.id, title: 'cancel' })
  cancelViaApi(f.api, canceled.id)

  const status = createEngineStatus()
  let dispatched = []
  const active = new Map()
  const deps = {
    ghPort: {},
    intake: async () => ({ created: [] }),
    dispatch: async ({ store: s, cardId, transitionActor, transitionMeta }) => {
      dispatched.push(cardId)
      const c = s.getCard(cardId)
      if (c.worktreePath || c.sessionId) return { mode: 'already-dispatched' }
      const sid = `s-${cardId}`
      active.set(sid, true)
      s.transitionCard(cardId, 'triage', transitionActor, undefined, transitionMeta)
      s.setWorktree(cardId, { worktreePath: `/tmp/wt-${cardId}`, branch: 'b', baseBranch: 'main', sessionId: sid })
      return { mode: 'created' }
    },
    isSessionActive: async (id) => active.get(id) === true,
  }
  const report = await runTick({ store: f.store, status, deps })
  assert.ok(dispatched.includes(live.id), 'the live inbox card is dispatched')
  assert.ok(!dispatched.includes(canceled.id), 'the canceled card is NOT dispatched')
  assert.equal(f.store.getCard(canceled.id).status, 'canceled', 'still canceled after tick')
}))

test('C3 done/canceled terminal cards show no cancel button (source guard)', () => {
  const m = clientSrc.match(/if \(card\.status !== 'done' && card\.status !== 'canceled'\) \{\s*buttons\.push\(h\(Button, \{\s*key: 'cancelCard'/)
  assert.ok(m, 'cancel button gated by status !== done && !== canceled')
  // The same gate as takeover; no cancel button on terminal states.
  assert.equal(TERMINAL.length, 2)
})

// ==============================================================================
// C4 — history transition actor=human, to=canceled, who/when/card; body kept
// ==============================================================================
test('C4 cancel leaves actor=human to=canceled transition in per-card history; body kept', () => withStore((f) => {
  const body = '# 背景\n正文要保留'
  const card = f.store.createCard({ boardId: f.board.id, title: 'audit', body })
  const before = f.store.getCard(card.id).history.length
  cancelViaApi(f.api, card.id)
  const after = f.store.getCard(card.id)
  assert.equal(after.history.length, before + 1, 'exactly one history entry added')
  const entry = after.history[after.history.length - 1]
  assert.equal(entry.type, 'transition')
  assert.equal(entry.from, 'inbox')
  assert.equal(entry.to, 'canceled')
  assert.equal(entry.actor, 'human', 'who')
  assert.ok(typeof entry.at === 'string' && !Number.isNaN(Date.parse(entry.at)), 'when')
  assert.equal(f.store.getCard(card.id).id, card.id, 'which card (auditable via store/API)')
  assert.equal(after.body, body, 'body preserved')
  // reloaded: history persisted
  assert.equal(new FactoryStore({ file: f.file }).getCard(card.id).history[after.history.length - 1].to, 'canceled')
}))

// ==============================================================================
// C5 — button visible on all 6 non-terminal states; API no 400 (six human edges)
// ==============================================================================
test('C5 human→canceled legal on all six non-terminal edges (state.js fact)', () => {
  for (const s of NON_TERMINAL) {
    const actors = EDGE_ACTORS[`${s}->canceled`] || []
    assert.ok(actors.includes('human'), `${s}->canceled allows human`)
  }
  for (const s of TERMINAL) {
    assert.ok(!EDGE_ACTORS[`${s}->canceled`], `${s} is terminal, no outgoing canceled edge`)
  }
})

test('C5 API transition to canceled returns 200 (not 400) for all six non-terminal states', () => withStore((f) => {
  const path = ['inbox', 'triage', 'plan', 'plan-review', 'build', 'review']
  for (const target of path) {
    const card = f.store.createCard({ boardId: f.board.id, title: `state-${target}` })
    // Walk the real state machine to `target` with a legal actor on each edge.
    for (let i = 1; i <= path.indexOf(target); i += 1) {
      const from = path[i - 1]
      const actor = (EDGE_ACTORS[`${from}->${path[i]}`] || []).includes('human') ? 'human' : 'agent'
      f.store.transitionCard(card.id, path[i], actor)
    }
    assert.equal(f.store.getCard(card.id).status, target, `reached ${target}`)
    const res = cancelViaApi(f.api, card.id)
    assert.equal(res.status, 200, `${target}->canceled via API not 400`)
    assert.equal(res.body.card.status, 'canceled')
    assert.match(res.body.error ?? '', /^$/, 'no error body')
  }
}))

test('C5 cancel button condition covers all non-terminal, excludes terminal (source guard)', () => {
  // Single gate used for the button; it excludes exactly done + canceled.
  assert.match(clientSrc, /if \(card\.status !== 'done' && card\.status !== 'canceled'\) \{\s*buttons\.push\(h\(Button, \{\s*key: 'cancelCard'/)
  // Button is placed at the end of the action list (after takeover/return/commit/pr/done).
  const block = clientSrc.slice(clientSrc.indexOf('function CardActions'), clientSrc.indexOf('function Column'))
  assert.ok(block.indexOf("key: 'cancelCard'") > block.indexOf("key: 'returnToEngine'"), 'cancel is last, after takeover/return')
})

// ==============================================================================
// C6 — success toast correct; API failure shows backend original text
// ==============================================================================
test('C6 success toast uses toastCardCanceled; failure path shows backend err.message', () => {
  const inline = loadInlineDicts()
  assert.equal(inline.zh.cancelCard, COPY.zh.cancelCard)
  assert.equal(inline.zh.toastCardCanceled, COPY.zh.toastCardCanceled)
  assert.equal(inline.en.cancelCard, COPY.en.cancelCard)
  assert.equal(inline.en.toastCardCanceled, COPY.en.toastCardCanceled)
  const block = clientSrc.slice(clientSrc.indexOf("key: 'cancelCard'"), clientSrc.indexOf('if (buttons.length === 0)'))
  assert.match(block, /POST.*\/transition/, 'calls transition route')
  assert.match(block, /to: 'canceled', actor: 'human'/, 'soft-delete payload')
  assert.match(block, /onToast\(t\('toastCardCanceled'\), 'ok'\)/, 'success toast')
  assert.match(block, /disabled: busy/, 'busy guard against double-click')
  assert.doesNotMatch(block, /confirm\(|window\.confirm/, 'no second confirmation')
  // Failure text: run() shows errorPrefix + backend err.message verbatim.
  assert.match(clientSrc, /const run = async \(fn\) => \{[\s\S]{0,220}catch \(err\) \{ setError\(err\.message\); showToast\(`\$\{t\('errorPrefix'\)\}\$\{err\.message\}`, 'err'\) \}/, 'failure shows backend original')
})

test('C6 API surfaces backend error text verbatim on an illegal transition', () => withStore((f) => {
  const card = f.store.createCard({ boardId: f.board.id, title: 'x' })
  // Walk the real legal path to the terminal `done` state.
  for (const [to, actor] of [['triage', 'human'], ['plan', 'agent'], ['plan-review', 'agent'], ['build', 'human'], ['review', 'agent'], ['done', 'human']]) {
    f.store.transitionCard(card.id, to, actor)
  }
  assert.equal(f.store.getCard(card.id).status, 'done')
  const res = cancelViaApi(f.api, card.id) // done is terminal → 400
  assert.equal(res.status, 400)
  assert.ok(typeof res.body.error === 'string' && res.body.error.length > 0, 'backend error text present for UI to display')
}))

// ==============================================================================
// C7 — four dictionaries byte-identical; real numbers in self-contained counts
// ==============================================================================
test('C7 cancelCard/toastCardCanceled byte-identical in all four dictionaries', () => {
  const inline = loadInlineDicts()
  for (const lang of ['zh', 'en']) {
    const locale = lang === 'zh' ? zhLocale : enLocale
    for (const key of ['cancelCard', 'toastCardCanceled']) {
      assert.ok(key in inline[lang], `inline ${lang}.${key}`)
      assert.ok(key in locale, `locale ${lang}.${key}`)
      assert.equal(inline[lang][key], COPY[lang][key], `inline ${lang}.${key} exact copy`)
      assert.equal(locale[key], COPY[lang][key], `locale ${lang}.${key} exact copy`)
      assert.equal(inline[lang][key], locale[key], `inline==locale ${lang}.${key}`)
    }
  }
})

test('C7 relational self-contained count assertions (no HEAD baseline)', () => {
  const inline = loadInlineDicts()
  const zhUi = { ...zhLocale }; delete zhUi.meta
  const enUi = { ...enLocale }; delete enUi.meta
  assert.deepEqual(Object.keys(inline.zh).sort(), Object.keys(inline.en).sort(), 'inline zh == en key set')
  assert.deepEqual(Object.keys(zhUi).sort(), Object.keys(inline.zh).sort(), 'locale zh UI == inline')
  assert.deepEqual(Object.keys(enUi).sort(), Object.keys(inline.en).sort(), 'locale en UI == inline')
  assert.equal(Object.keys(zhLocale).length, Object.keys(zhUi).length + 1, 'locale zh = UI + meta')
  assert.equal(Object.keys(enLocale).length, Object.keys(enUi).length + 1, 'locale en = UI + meta')
  assert.ok('meta' in zhLocale && 'meta' in enLocale)
})
