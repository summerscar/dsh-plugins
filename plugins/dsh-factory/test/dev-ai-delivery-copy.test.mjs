/**
 * Dev self-check for AI-drafted delivery copy: the model call shape, the
 * non-blocking fallback, both L4 generation points, the PR empty-string fix,
 * and the client's generate-before-write flow.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  createDeliveryCopyGenerator, parsePrDraft, sanitizeCommitMessage,
} from '../ai-copy.js'
import { commitCard, createPrForCard } from '../git-exec.js'
import { ensureCommittedForAutoDelivery, runAutoDelivery } from '../delivery.js'
import { FactoryStore } from '../store.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const SHA = 'a'.repeat(40)

function fakeCtx({ chunks = [], selection = { provider: 'gomodel', model: 'failover' }, streamError = null, hang = false } = {}) {
  const calls = []
  const ctx = {
    get(name) {
      if (name === 'llm') return {
        async *stream(options) {
          calls.push(options)
          if (streamError !== null) throw streamError
          if (hang) await new Promise(() => {})
          for (const chunk of chunks) yield chunk
        },
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => selection }
      return undefined
    },
  }
  return { ctx, calls }
}

const textChunks = (text) => [
  { type: 'text-delta', index: 0, text },
  { type: 'finish', reason: { kind: 'stop' } },
]

test('Dev-Copy 1: commit draft uses host default model and returns one clean line', async () => {
  const { ctx, calls } = fakeCtx({ chunks: textChunks('```text\n修复登录限流的重复提交\n```\n') })
  const generator = createDeliveryCopyGenerator({ ctx, timeoutMs: 1000, readDiff: () => 'diff --git a/x b/x\n+fix' })
  const result = await generator.commit({ card: { title: '修 bug', body: '', worktreePath: '/w' }, fallback: 'default' })
  assert.equal(result.generated, true)
  assert.equal(result.text, '修复登录限流的重复提交')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].provider, 'gomodel')
  assert.equal(calls[0].model, 'failover')
  assert.match(calls[0].messages[0].content[0].text, /diff --git a\/x b\/x/)
  assert.equal(calls[0].sessionId, undefined)
  assert.equal(calls[0].tools, undefined)
})

test('Dev-Copy 2: commit failure and timeout fall back without throwing', async () => {
  const broken = fakeCtx({ streamError: new Error('provider down') })
  const failed = await createDeliveryCopyGenerator({ ctx: broken.ctx, readDiff: () => '', timeoutMs: 1000 })
    .commit({ card: { worktreePath: '/w' }, fallback: 'factory: implement card' })
  assert.deepEqual(failed, { text: 'factory: implement card', generated: false, reason: 'error' })

  const stuck = fakeCtx({ hang: true })
  const timed = await createDeliveryCopyGenerator({ ctx: stuck.ctx, readDiff: () => '', timeoutMs: 10 })
    .commit({ card: { worktreePath: '/w' }, fallback: 'factory: auto-delivery abc' })
  assert.deepEqual(timed, { text: 'factory: auto-delivery abc', generated: false, reason: 'timeout' })
})

test('Dev-Copy 3: PR draft parses fenced JSON, keeps an empty body, and falls back', async () => {
  const { ctx } = fakeCtx({ chunks: textChunks('```json\n{"title":"登录限流修复","body":""}\n```') })
  const generated = await createDeliveryCopyGenerator({ ctx, readDiff: () => 'diff', timeoutMs: 1000 })
    .pr({ card: { worktreePath: '/w', baseBranch: 'main' }, fallbackTitle: 'old', fallbackBody: 'old body' })
  assert.deepEqual(generated, { title: '登录限流修复', body: '', generated: true })

  assert.deepEqual(parsePrDraft('{"title":" t ","body":" b "}'), { title: 't', body: 'b' })
  assert.throws(() => parsePrDraft('not json'), /PR 草稿/)
  assert.equal(sanitizeCommitMessage('  > "first\nsecond"  '), 'first')

  const broken = fakeCtx({ streamError: new Error('offline') })
  const fallback = await createDeliveryCopyGenerator({ ctx: broken.ctx, readDiff: () => '', timeoutMs: 1000 })
    .pr({ card: { worktreePath: '/w' }, fallbackTitle: 'card title', fallbackBody: '' })
  assert.deepEqual(fallback, { title: 'card title', body: '', generated: false, reason: 'error' })
})

function gitSetup(body = 'original body') {
  const tmp = mkdtempSync(join(tmpdir(), 'factory-copy-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: '/workspace/example-repo' })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  const card = store.createCard({ boardId: board.id, title: 'Ship it', body })
  store.setWorktree(card.id, { worktreePath: '/tmp/fake-worktree', branch: 'factory/card' })
  const transitions = [['triage', 'human'], ['plan', 'agent'], ['plan-review', 'agent'], ['build', 'human'], ['review', 'agent']]
  for (const [phase, actor] of transitions) store.transitionCard(card.id, phase, actor)
  return { store, card, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

function prPort(calls) {
  return {
    add() {}, commit: () => SHA, reset() {}, hasDiff: () => true,
    push() { calls.push(['push']) },
    createPr(_cwd, options) { calls.push(['createPr', options]); return 'https://example/pr/1' },
  }
}

test('Dev-Copy 4: PR body/title empty strings survive (the || fallback bug)', async () => {
  const { store, card, cleanup } = gitSetup()
  try {
    store.authorize(card.id, 'confirm-commit')
    await commitCard({ store, cardId: card.id, port: { add() {}, commit: () => SHA, reset() {}, hasDiff: () => true } })
    store.authorize(card.id, 'create-pr')
    const calls = []
    await createPrForCard({ store, cardId: card.id, port: prPort(calls), title: '', body: '' })
    const created = calls.find((call) => call[0] === 'createPr')[1]
    assert.equal(created.title, '', 'explicit empty title is not replaced by card.title')
    assert.equal(created.body, '', 'explicit empty body is not replaced by card.body')
  } finally {
    cleanup()
  }
})

test('Dev-Copy 5: an absent PR field still falls back to the card', async () => {
  const { store, card, cleanup } = gitSetup()
  try {
    store.authorize(card.id, 'confirm-commit')
    await commitCard({ store, cardId: card.id, port: { add() {}, commit: () => SHA, reset() {}, hasDiff: () => true } })
    store.authorize(card.id, 'create-pr')
    const calls = []
    await createPrForCard({ store, cardId: card.id, port: prPort(calls) })
    const created = calls.find((call) => call[0] === 'createPr')[1]
    assert.equal(created.title, card.title)
    assert.equal(created.body, 'original body')
  } finally {
    cleanup()
  }
})

function autoFixture({ clean = false, commitSha = null, prUrl = null } = {}) {
  const calls = []
  const events = []
  const card = {
    id: 'card-12345678', projectId: 'p', status: 'review',
    worktreePath: '/tmp/w', branch: 'factory/card', baseBranch: 'main',
    commitSha, prUrl, body: 'card body', title: 'card title',
    reviewSessionId: 'review-1',
    reviewVerdict: {
      verdict: 'approved', blocking: [], reviewerSessionId: 'review-1', reviewedHead: SHA,
    },
    autoDelivery: null,
    reviewStale: false,
  }
  const store = {
    getCard: () => card,
    getProject: () => ({ id: 'p', autonomy: 'auto-delivery' }),
    recordCommit(_id, data) { card.commitSha = data.sha; card.commitMessage = data.message; calls.push(['recordCommit', data]) },
    clearCommitFailures() {},
    setAutoDelivery(_id, data) { card.autoDelivery = data },
    setPrUrl(_id, url) { card.prUrl = url },
    recordPushUpdate() {},
    markReviewStale() {},
    recordEvent: (event) => events.push(event),
  }
  const port = {
    isWorktreeClean: () => clean,
    worktreeExists: () => true,
    add() { calls.push(['add']) },
    commit(_cwd, message) { calls.push(['commit', message]); return SHA },
    push() { calls.push(['push']) },
    createPr(_cwd, options) { calls.push(['createPr', options]); return 'https://example/pr/2' },
  }
  return { card, store, port, calls, events }
}

test('Dev-Copy 6: L4 auto commit drafts only on a dirty tree, and falls back safely', async () => {
  const dirty = autoFixture({ clean: false })
  const generatedCalls = []
  const result = await ensureCommittedForAutoDelivery({
    store: dirty.store, cardId: dirty.card.id, port: dirty.port,
    readHead: () => SHA,
    generateMessage: async () => { generatedCalls.push('draft'); return { text: '自动生成：修复登录缺陷', generated: true } },
  })
  assert.equal(result.ok, true)
  assert.equal(result.committed, true)
  assert.deepEqual(generatedCalls, ['draft'])
  assert.deepEqual(dirty.calls.find((call) => call[0] === 'commit'), ['commit', '自动生成：修复登录缺陷'])

  const clean = autoFixture({ clean: true, commitSha: SHA })
  let called = false
  const skipped = await ensureCommittedForAutoDelivery({
    store: clean.store, cardId: clean.card.id, port: clean.port,
    readHead: () => SHA,
    generateMessage: async () => { called = true; return { text: 'should not run', generated: true } },
  })
  assert.equal(skipped.skipped, true)
  assert.equal(called, false, 'clean tree never drafts a commit message')

  const failing = autoFixture({ clean: false })
  const fallbackResult = await ensureCommittedForAutoDelivery({
    store: failing.store, cardId: failing.card.id, port: failing.port,
    readHead: () => SHA,
    generateMessage: async () => { throw new Error('offline') },
  })
  assert.equal(fallbackResult.ok, true)
  assert.deepEqual(failing.calls.find((call) => call[0] === 'commit'), ['commit', 'factory: auto-delivery card-123'])
})

test('Dev-Copy 7: L4 first PR drafts title/body; failure keeps card copy', async () => {
  const ok = autoFixture({ clean: true, commitSha: SHA })
  const delivered = await runAutoDelivery({
    store: ok.store, cardId: ok.card.id, port: ok.port,
    readHead: () => SHA, resolveIdentity: async () => ({ git: {} }),
    generatePr: async () => ({ title: 'AI 标题', body: 'AI 正文', generated: true }),
  })
  assert.equal(delivered.delivered, true)
  assert.deepEqual(ok.calls.find((call) => call[0] === 'createPr')[1], {
    title: 'AI 标题', body: 'AI 正文', branch: 'factory/card', draft: true,
  })

  const failed = autoFixture({ clean: true, commitSha: SHA })
  await runAutoDelivery({
    store: failed.store, cardId: failed.card.id, port: failed.port,
    readHead: () => SHA, resolveIdentity: async () => ({ git: {} }),
    generatePr: async () => { throw new Error('offline') },
  })
  assert.deepEqual(failed.calls.find((call) => call[0] === 'createPr')[1], {
    title: 'card title', body: 'card body', branch: 'factory/card', draft: true,
  })
})

test('Dev-Copy 8: client drafts before writing, keeps cancel live, and adds no model UI', () => {
  const client = readFileSync(join(root, 'client.js'), 'utf8')
  const actions = client.slice(client.indexOf('function CardActions'), client.indexOf('function WorktreeSetup'))
  const draftModal = client.slice(client.indexOf('function DraftModal'), client.indexOf('function OrphanModal'))
  assert.match(draftModal, /draft-commit/, 'commit draft is requested from the modal')
  assert.match(draftModal, /draft-pr/, 'PR draft is requested from the modal')
  const authorizeIdx = actions.indexOf('/authorize')
  assert.ok(authorizeIdx > -1, 'authorization happens in the confirm callback, not on open')
  assert.match(actions, /onConfirm: async \(copy\)/, 'authorization is deferred to confirmation')
  assert.match(actions, /commit-existing/, 'rework commit route is preserved')
  assert.match(draftModal, /role: 'status'/, 'generation shows a live status region')
  assert.match(draftModal, /className: 'df-spinner'/, 'spinner is the existing CSS class')
  assert.match(draftModal, /let cancelled = false/, 'late generation results are guarded')
  assert.match(draftModal, /if \(cancelled\) return/, 'closed modals do not accept late results')
  assert.match(draftModal, /busy: submitting/, 'cancel stays enabled while generating')
  assert.doesNotMatch(client, /providerSelect|modelSelect|modelPicker|选择模型/, 'no model/provider selector was introduced')

  const index = readFileSync(join(root, 'index.js'), 'utf8')
  assert.match(index, /createDeliveryCopyGenerator/, 'generator is wired into the host')
  assert.match(index, /generateMessage:/, 'L4 commit generation is wired')
  assert.match(index, /generatePr:/, 'L4 PR generation is wired')
  assert.match(index, /factory-2026-11-20\.41/, 'BUILD bumped for the crash/layout fixes')
})

test('Dev-Copy 9: DraftModal renders all three entry labels without an undefined title', () => {
  const client = readFileSync(join(root, 'client.js'), 'utf8')
  const start = client.indexOf('function DraftModal')
  const end = client.indexOf('function OrphanModal')
  assert.ok(start > -1 && end > start, 'DraftModal source found')
  const source = client.slice(start, end)
  const makeDraftModal = new Function(
    'h', 'useState', 'useEffect', 'callApi', 'Modal', 'T',
    `${source}\nreturn DraftModal`,
  )(
    (type, props, ...kids) => ({ type, props, kids }),
    (value) => [value, () => {}],
    () => {},
    async () => ({}),
    function ModalStub() {},
    { mutedInk: '#666', warning: '#c90', warningWash: '#fff7', dangerInk: '#b00', line: '#ddd', radiusSm: 6, card: '#fff', ink: '#111' },
  )
  const entries = [
    { kind: 'commit', confirmLabel: 'actConfirmCommit' },
    { kind: 'commit', confirmLabel: 'actCommitExisting' },
    { kind: 'pr', confirmLabel: 'actCreatePr' },
  ]
  for (const entry of entries) {
    const card = { id: 'c1', title: 'card title', body: 'card body' }
    const t = (key) => key
    const element = makeDraftModal({ ...entry, card, t, onCancel: () => {}, onConfirm: async () => {} })
    assert.equal(element.type.name, 'ModalStub', `${entry.confirmLabel} renders the shared Modal`)
    assert.equal(element.props.title, entry.confirmLabel, `${entry.confirmLabel} is the modal title`)
    assert.equal(element.props.confirmLabel, entry.confirmLabel, `${entry.confirmLabel} is the confirm label`)
  }
})

test('Dev-Copy 10: tabs view sticks below the 56px topbar without self-clipping', () => {
  const client = readFileSync(join(root, 'client.js'), 'utf8')
  const rule = client.match(/\[data-dsh-factory-p4\]\[data-view="tabs"\] \.df-tabs\{([^}]*)\}/)?.[1]
  assert.ok(rule, 'tabs CSS rule found')
  assert.match(rule, /position:sticky/, 'tabs stick while the root scrolls')
  assert.match(rule, /top:56px/, 'tabs park directly below the opaque 56px topbar')
  assert.match(rule, /z-index:29/, 'tabs sit above content but below the topbar')
  assert.match(rule, /overflow-y:hidden/, 'tabs cannot be vertically clipped by their own scroller')
  assert.match(rule, /overflow-x:auto/, 'horizontal tab scrolling is preserved')
  assert.match(rule, /background:var\(--dsw-alias-bg,#fff\)/, 'tabs have an opaque background')
  assert.match(rule, /min-height:44px/, 'tabs keep a minimum height so they never collapse visually')
  assert.doesNotMatch(client, /\[data-dsh-factory-p4\]\{[^}]*height:100%;overflow-y:auto[^}]*position:sticky/, 'root scroll container is untouched')
  const rootRender = client.match(/const renderPage = \(\) => h\('div', \{[^\n]*/)?.[0]
  assert.ok(rootRender, 'root page container found')
  assert.doesNotMatch(rootRender, /gap: *16/, 'no 16px gap between topbar and tabs')
  assert.match(rootRender, /display: 'flex', flexDirection: 'column', position: 'relative'/, 'root remains a flex column')
})
