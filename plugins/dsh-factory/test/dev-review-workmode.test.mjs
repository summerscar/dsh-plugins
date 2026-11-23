/**
 * Dev self-check: a review session uses the project's configured work mode,
 * exactly like a build session. It is no longer pinned to a read-only sandbox.
 * Review-specific context safety (reviewedHead, previous head/verdict) stays.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { FactoryStore } from '../store.js'
import { dispatchReview, followupReview } from '../dispatch.js'
import { buildSessionContext } from '../session-context.js'

const here = dirname(fileURLToPath(import.meta.url))
const A = 'a'.repeat(40)

function fixture({ workMode = 'workspace-write', withReviewer = false } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'dev-reviewmode-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: '/workspace/p' })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  const card = store.createCard({ boardId: board.id, title: 'c' })
  store.setWorktree(card.id, { worktreePath: '/workspace/wt', branch: 'b', baseBranch: 'main', sessionId: 'builder' })
  for (const [to, actor] of [['triage', 'human'], ['plan', 'agent'], ['plan-review', 'agent'], ['build', 'human'], ['review', 'agent']]) {
    store.transitionCard(card.id, to, actor)
  }
  if (withReviewer) store.setReviewSession(card.id, 'rev-old', 'created')
  store.updateWorkMode(project.id, { workMode })
  return { store, project, card, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

function fakeAgentCtx() {
  return {
    get: (name) => (name === 'agentPresets' ? { mount: async () => {} } : undefined),
    systemPrompt: { variable: () => () => {}, section: () => () => {}, getSectionOrder: () => 60 },
  }
}

function portFor(calls, { active = false, pluginAvailable = true, setupResults = [] } = {}) {
  // Emulate agent-loop: it awaits the setup handed over by the host, then calls
  // setupCommit?.commit(). A factory that resolves to another function is the
  // real-machine bug — fake ports that never invoked setup missed it.
  const invokeSetup = async (opts) => { setupResults.push(await opts.setup(fakeAgentCtx(), { session: {} })) }
  return {
    readHead: () => A,
    createSession: async (opts) => { calls.push({ kind: 'create', ...opts }); await invokeSetup(opts); return { sessionId: 'rev-new' } },
    followupSession: async (opts) => { calls.push({ kind: 'followup', ...opts }); return { sessionId: 'rev-old' } },
    resumeSession: async (opts) => { calls.push({ kind: 'resume', ...opts }); await invokeSetup(opts); return { sessionId: 'rev-resume' } },
    isSessionActive: async () => active,
    readAutoReviewPluginState: async () => ({ available: pluginAvailable }),
  }
}

function assertWorkMode(call, workMode) {
  assert.equal(call.workMode, workMode, 'review session uses the configured work mode')
  assert.equal(call.permissionPreset, workMode === 'auto-review' ? 'auto' : undefined, 'auto preset only for auto-review')
  assert.equal(call.sandboxMode, undefined, 'no hardcoded sandbox override')
}

test('Dev-ReviewMode: dispatchReview follows every configured work mode', async () => {
  for (const workMode of ['workspace-write', 'full-access', 'auto-review']) {
    const f = fixture({ workMode })
    try {
      const calls = []
      const setupResults = []
      await dispatchReview({ store: f.store, cardId: f.card.id, port: portFor(calls, { setupResults }) })
      assert.equal(calls.length, 1, `${workMode}: one session created`)
      assertWorkMode(calls[0], workMode)
      assert.equal(setupResults[0], undefined, `${workMode}: setup is expanded, not a factory resolving to another function`)
    } finally { f.cleanup() }
  }
})

test('Dev-ReviewMode: auto-review falls back exactly like the build path when the plugin is unavailable', async () => {
  const f = fixture({ workMode: 'auto-review' })
  try {
    const calls = []
    await dispatchReview({ store: f.store, cardId: f.card.id, port: portFor(calls, { pluginAvailable: false }) })
    assertWorkMode(calls[0], 'workspace-write')
    assert.equal(f.store.state.events.some((e) => e.type === 'work-mode-fallback' && e.targetId === f.card.id), true)
  } finally { f.cleanup() }
})

test('Dev-ReviewMode: a live reviewer follows workMode on the followup path', async () => {
  const f = fixture({ workMode: 'full-access', withReviewer: true })
  try {
    const calls = []
    await followupReview({ store: f.store, cardId: f.card.id, port: portFor(calls, { active: true }) })
    assert.equal(calls[0].kind, 'followup')
    assert.equal(calls[0].workMode, 'full-access')
    assert.equal(calls[0].sandboxMode, undefined)
  } finally { f.cleanup() }
})

test('Dev-ReviewMode: resume and fresh-rebuild paths follow workMode too', async () => {
  for (const failResume of [false, true]) {
    const f = fixture({ workMode: 'auto-review', withReviewer: true })
    try {
      const calls = []
      const setupResults = []
      const port = portFor(calls, { setupResults })
      if (failResume) port.resumeSession = async () => { throw new Error('dead history') }
      await followupReview({ store: f.store, cardId: f.card.id, port })
      assertWorkMode(calls[0], 'auto-review')
      assert.equal(calls[0].kind, failResume ? 'create' : 'resume')
      assert.equal(setupResults[0], undefined, 'resume/create setup is expanded too')
    } finally { f.cleanup() }
  }
})

test('Dev-ReviewMode: review prompts drop read-only wording but keep the role boundary', () => {
  const f = fixture()
  try {
    const card = f.store.getCard(f.card.id)
    const built = buildSessionContext({ card, project: f.project, reviewMode: true, review: { reviewedHead: A } })
    assert.doesNotMatch(built.sectionText, /read-only/i, 'no misleading sandbox wording')
    assert.doesNotMatch(built.firstMessage, /read-only/i, 'first message agrees with the permissions')
    assert.match(built.sectionText, /Do not move the card, authorize git actions, commit, push or open a PR/i, 'git-write role boundary stays')
    assert.match(built.firstMessage, /independent review/i, 'independent-review framing stays')
  } finally { f.cleanup() }
})

test('Dev-ReviewMode: review context no longer demands a read-only sandbox but keeps its head gates', () => {
  const f = fixture({ workMode: 'full-access' })
  try {
    const card = f.store.getCard(f.card.id)
    for (const sandboxMode of [undefined, 'workspace-write', 'danger-full-access']) {
      const built = buildSessionContext({ card, project: f.project, reviewMode: true, review: { reviewedHead: A, sandboxMode } })
      assert.equal(built.reviewedHead, A, 'reviewedHead still injected')
      assert.equal(built.skill, 'factory-review', 'review skill still selected')
    }
    assert.throws(
      () => buildSessionContext({ card, project: f.project, reviewMode: true, review: {} }),
      /reviewedHead/,
      'missing reviewedHead still fails closed',
    )
  } finally { f.cleanup() }
})
