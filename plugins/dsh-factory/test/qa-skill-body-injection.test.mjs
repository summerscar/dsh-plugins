/**
 * QA — stage skill BODY delivered through the systemPrompt section.
 *
 * Root cause this covers (2026-11-16): the factory builds dispatched sessions with
 * `agents.create()`, which does NOT mount a preset, so the session has no `skill`
 * tool. A message that merely says "Load the `factory-triage` skill" is therefore
 * un-executable. The fix injects the stage's SKILL.md body directly into the
 * systemPrompt section (the same live channel factory_repo/cardId use), so the
 * model reads the instructions without needing any tool.
 *
 * Offline criteria (Chief):
 *   1. sectionText contains the CURRENT stage's skill body (inside <skill_content>);
 *   2. soft-fallback when the body cannot be read — still returns valid text,
 *      never throws, says the body is unavailable;
 *   3. only the CURRENT stage's one skill is injected, not all of them.
 *
 * All filesystem access goes through an injected port; the real disk is never hit.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { attachSessionContext, readSkillBody } from '../session-context.js'

// ---------------------------------------------------------------------------
// Fake agent.ctx capturing the registered section provider
// ---------------------------------------------------------------------------
function fakeAgentCtx() {
  const captured = { variables: {}, section: null }
  const agentCtx = {
    systemPrompt: {
      variable: (name, provider) => { captured.variables[name] = provider; return () => {} },
      section: (definition) => { captured.section = definition; return () => {} },
      getSectionOrder: () => 61,
    },
  }
  return { agentCtx, captured }
}

// Minimal in-memory store: one card in a chosen phase.
function fakeStore(status, extra = {}) {
  const card = {
    id: 'card-1', title: 'Do the thing', status,
    repoPath: '/tmp/repo', repo: 'owner/repo', source: 'issue:owner/repo#1',
    branch: 'factory/card-1', worktreePath: '/tmp/wt/card-1', prUrl: null,
    projectId: 'proj-1', ...extra,
  }
  return {
    getCard: (id) => (id === 'card-1' ? card : undefined),
    getProject: () => ({ rootPath: '/tmp/repo' }),
  }
}

// Distinct marker bodies per stage, so we can prove ONLY the current one is used.
const BODIES = {
  'factory-triage': 'TRIAGE_BODY_MARKER: verify the issue, classify, then move to plan.',
  'factory-plan': 'PLAN_BODY_MARKER: write a phased plan and submit for approval.',
  'factory-build': 'BUILD_BODY_MARKER: implement in the worktree, prove with tests.',
  'factory-review': 'REVIEW_BODY_MARKER: independent review, record verdict.',
}
function fakeReadSkill(map) {
  return (name) => (name in map ? map[name] : null)
}

// ---------------------------------------------------------------------------
// Criterion 1: sectionText contains the CURRENT stage's body inside <skill_content>
// ---------------------------------------------------------------------------
test('sectionText injects the current stage skill body inside <skill_content>', () => {
  for (const [status, skill] of [['triage', 'factory-triage'], ['plan', 'factory-plan'], ['build', 'factory-build'], ['review', 'factory-review']]) {
    const { agentCtx, captured } = fakeAgentCtx()
    attachSessionContext({ agentCtx, store: fakeStore(status), cardId: 'card-1', readSkill: fakeReadSkill(BODIES) })
    const text = captured.section.text()
    assert.match(text, new RegExp(`<skill_content[^>]*name="${skill}"`), `missing <skill_content name="${skill}"> for phase ${status}`)
    assert.ok(text.includes(BODIES[skill]), `body of ${skill} not present for phase ${status}`)
    assert.match(text, /<\/skill_content>/)
  }
})

// ---------------------------------------------------------------------------
// Criterion 3: only the CURRENT stage's skill — not the others
// ---------------------------------------------------------------------------
test('only the current stage skill body is injected, not the others', () => {
  const { agentCtx, captured } = fakeAgentCtx()
  attachSessionContext({ agentCtx, store: fakeStore('triage'), cardId: 'card-1', readSkill: fakeReadSkill(BODIES) })
  const text = captured.section.text()
  assert.ok(text.includes(BODIES['factory-triage']))
  for (const other of ['factory-plan', 'factory-build', 'factory-review']) {
    assert.ok(!text.includes(BODIES[other]), `must not inject ${other} body while in triage`)
  }
})

// ---------------------------------------------------------------------------
// Criterion 2: soft-fallback when the body cannot be read — no throw, valid text
// ---------------------------------------------------------------------------
test('soft-fallback when skill body is unreadable: no throw, says unavailable, keeps base section', () => {
  const { agentCtx, captured } = fakeAgentCtx()
  // readSkill returns null (missing file)
  attachSessionContext({ agentCtx, store: fakeStore('triage'), cardId: 'card-1', readSkill: () => null })
  let text
  assert.doesNotThrow(() => { text = captured.section.text() })
  assert.ok(typeof text === 'string' && text.length > 0)
  // base work-item context still present
  assert.ok(text.includes('card-1'))
  // and it flags the body unavailable rather than pretending success
  assert.match(text, /(不可用|unavailable)/i)
  assert.ok(!text.includes('<skill_content'))
})

test('soft-fallback also covers a readSkill that THROWS', () => {
  const { agentCtx, captured } = fakeAgentCtx()
  attachSessionContext({
    agentCtx, store: fakeStore('plan'), cardId: 'card-1',
    readSkill: () => { throw new Error('EACCES: permission denied') },
  })
  let text
  assert.doesNotThrow(() => { text = captured.section.text() })
  assert.ok(text.includes('card-1'))
  assert.match(text, /(不可用|unavailable)/i)
})

// ---------------------------------------------------------------------------
// readSkillBody port: reads <skillsDir>/<name>/SKILL.md via injected readFileSync
// ---------------------------------------------------------------------------
test('readSkillBody strips frontmatter and returns the body via the injected port', () => {
  const md = '---\nname: factory-triage\ndescription: x\n---\nBODY_LINE_ONE\nBODY_LINE_TWO\n'
  const body = readSkillBody('factory-triage', { skillsDir: '/skills', readFileSync: (path) => {
    assert.equal(path, '/skills/factory-triage/SKILL.md')
    return md
  } })
  assert.ok(body.includes('BODY_LINE_ONE') && body.includes('BODY_LINE_TWO'))
  assert.ok(!body.includes('frontmatter') && !body.includes('description: x'))
})

test('readSkillBody returns null when the read throws (missing file)', () => {
  const body = readSkillBody('factory-triage', { skillsDir: '/skills', readFileSync: () => { throw new Error('ENOENT') } })
  assert.equal(body, null)
})

test('readSkillBody returns null for empty/invalid skill name', () => {
  assert.equal(readSkillBody(''), null)
  assert.equal(readSkillBody(undefined), null)
})

// ---------------------------------------------------------------------------
// Live-phase behaviour: a phase change swaps the injected body (section reads live)
// ---------------------------------------------------------------------------
test('section text reflects a live phase change (triage body -> plan body)', () => {
  const store = fakeStore('triage')
  const { agentCtx, captured } = fakeAgentCtx()
  attachSessionContext({ agentCtx, store, cardId: 'card-1', readSkill: fakeReadSkill(BODIES) })
  assert.ok(captured.section.text().includes(BODIES['factory-triage']))
  // move the card to plan
  store.getCard('card-1').status = 'plan'
  const text = captured.section.text()
  assert.ok(text.includes(BODIES['factory-plan']))
  assert.ok(!text.includes(BODIES['factory-triage']))
})

// ---------------------------------------------------------------------------
// Terminal / human-gated phases: no skill body, and a clear "do not advance" note
// ---------------------------------------------------------------------------
test('terminal / waiting phase injects NO skill body and says not to advance', () => {
  for (const status of ['plan-review', 'done', 'canceled']) {
    const { agentCtx, captured } = fakeAgentCtx()
    // readSkill would return a body if called with a real name; it must not be for terminal phases
    attachSessionContext({ agentCtx, store: fakeStore(status), cardId: 'card-1', readSkill: fakeReadSkill(BODIES) })
    const text = captured.section.text()
    assert.ok(!text.includes('<skill_content'), `terminal phase ${status} must not inject a skill body`)
    for (const body of Object.values(BODIES)) assert.ok(!text.includes(body))
    assert.match(text, /(do NOT advance|不要自己推进|等人|waiting for a human|terminal)/i)
    // A correct terminal phase returns the plain section text EARLY — it must not
    // even attempt a skill read, so no "body unavailable / read null failed" trace.
    assert.ok(!/(技能正文不可用|body unavailable|读取 .*失败)/i.test(text),
      `terminal phase ${status} must not attempt a skill-body read at all`)
  }
})
