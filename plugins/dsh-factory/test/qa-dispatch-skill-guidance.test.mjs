/**
 * QA — dispatched sessions must be TOLD which stage skill to load (Chief's root
 * cause for "session stalls at triage", 2026-11-16).
 *
 * The you-approve engine auto-dispatches a card and the session is supposed to advance the
 * stage using an in-session skill (`factory-triage`, `factory-plan`, …). The old
 * session context only said "use factory_transition_work_item" without ever
 * naming the skill, so the agent didn't know a skill existed for the phase and
 * sat at triage. These cases assert the dispatch message names the RIGHT skill
 * for each phase, in BOTH the system-prompt section and the first message, plus
 * an explicit "load the skill first" instruction.
 *
 * Behaviour, not wording: we assert the exact skill token appears / no wrong
 * skill appears, not a particular sentence.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSessionContext, skillForPhase } from '../session-context.js'

/** Chief's authoritative stage→skill mapping. V4: done/canceled = none.
 *  inbox is included: first dispatch lands there and is driven by triage too. */
const STAGE_SKILL = {
  inbox: 'factory-triage',
  triage: 'factory-triage',
  plan: 'factory-plan',
  build: 'factory-build',
  'self-review': 'factory-self-review',
  'pr-review': 'factory-review',
}
const NO_SKILL_STAGES = ['done', 'canceled']
const ALL_SKILLS = Object.values(STAGE_SKILL)
const SOME_SKILL = ALL_SKILLS[0]

function cardAt(status) {
  return {
    id: 'card-1', title: 'Do the thing', status,
    repoPath: '/tmp/repo', repo: 'owner/repo', source: 'issue:owner/repo#1',
    branch: 'factory/card-1', worktreePath: '/tmp/wt/card-1', prUrl: null,
  }
}

test('dispatch message names the correct stage skill in BOTH sectionText and firstMessage', () => {
  for (const [phase, skill] of Object.entries(STAGE_SKILL)) {
    const built = buildSessionContext({ card: cardAt(phase), project: { rootPath: '/tmp/repo' } })
    assert.match(built.sectionText, new RegExp(skill), `sectionText missing skill ${skill} for phase ${phase}`)
    assert.match(built.firstMessage, new RegExp(skill), `firstMessage missing skill ${skill} for phase ${phase}`)

    // Must not advertise a DIFFERENT stage's skill for this phase.
    for (const other of ALL_SKILLS.filter((s) => s !== skill)) {
      assert.ok(!built.sectionText.includes(other), `sectionText for ${phase} wrongly mentions ${other}`)
      assert.ok(!built.firstMessage.includes(other), `firstMessage for ${phase} wrongly mentions ${other}`)
    }
  }
})

test('terminal / waiting phases name NO stage skill', () => {
  for (const phase of NO_SKILL_STAGES) {
    const built = buildSessionContext({ card: cardAt(phase), project: { rootPath: '/tmp/repo' } })
    for (const skill of ALL_SKILLS) {
      assert.ok(!built.sectionText.includes(skill), `sectionText for ${phase} must not name ${skill}`)
      assert.ok(!built.firstMessage.includes(skill), `firstMessage for ${phase} must not name ${skill}`)
    }
  }
})

test('dispatch message instructs the agent to load the skill before acting', () => {
  const built = buildSessionContext({ card: cardAt('triage'), project: { rootPath: '/tmp/repo' } })
  for (const text of [built.sectionText, built.firstMessage]) {
    // Some explicit "load / use the skill" instruction, in either language.
    const saysLoad = /(load|use|read|invoke|加载|使用|阅读)[^.\n]*skill/is.test(text)
      || /skill[^.\n]*(first|before|先|之前)/i.test(text)
    assert.ok(saysLoad, `message must tell the agent to load the skill first; got: ${text}`)
  }
})

test('skill guidance is derived from the LIVE phase, not frozen at build time', () => {
  // buildSessionContext is called per assembly by attachSessionContext, so a
  // card that moved from triage to plan must now advertise factory-plan.
  const triage = buildSessionContext({ card: cardAt('triage'), project: {} })
  const plan = buildSessionContext({ card: cardAt('plan'), project: {} })
  assert.ok(triage.sectionText.includes('factory-triage') && !triage.sectionText.includes('factory-plan'))
  assert.ok(plan.sectionText.includes('factory-plan') && !plan.sectionText.includes('factory-triage'))
  // Sanity: the two messages are genuinely different.
  assert.notEqual(triage.sectionText, plan.sectionText)
})
