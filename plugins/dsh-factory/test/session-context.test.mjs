/**
 * Session-context tests — the pure field builder and the scoped agent.ctx
 * registration. The registration is exercised against a fake `agent.ctx` whose
 * providers we call later, proving the closure reads the store live (a phase
 * change is reflected without re-registering).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FactoryStore } from '../store.js'
import { attachSessionContext, buildSessionContext } from '../session-context.js'

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'factory-ctx-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: '/workspace/p' })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  const card = store.createCard({ boardId: board.id, title: 'Fix the bug', repo: '/workspace/p' })
  store.setWorktree(card.id, { worktreePath: '/workspace/.dsh-worktrees/' + project.id + '/' + card.id, branch: 'factory/' + card.id })
  return { store, project, card, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

test('buildSessionContext carries the full field set and puts worktree + id in the first message', () => {
  const { store, project, card, cleanup } = setup()
  try {
    const fresh = store.getCard(card.id)
    const built = buildSessionContext({ card: fresh, project })
    for (const key of ['cardId', 'title', 'phase', 'nextPhases', 'repo', 'branch', 'worktreePath', 'planStatus', 'prUrl', 'skill']) {
      assert.ok(key in built, `missing field ${key}`)
    }
    assert.equal(built.cardId, card.id)
    assert.equal(built.phase, 'inbox')
    // The dispatch message must point the session at the stage skill it should load.
    assert.equal(built.skill, 'factory-triage')
    assert.ok(built.sectionText.includes('factory-triage'))
    assert.ok(built.firstMessage.includes('factory-triage'))
    // The first message must name the card and its worktree (our improvement
    // over kanban, which omits worktreePath).
    assert.ok(built.firstMessage.includes(card.id))
    assert.ok(built.firstMessage.includes(fresh.worktreePath))
    assert.ok(built.sectionText.includes(fresh.worktreePath))
    assert.deepEqual(built.nextPhases.sort(), ['canceled', 'triage'])
  } finally {
    cleanup()
  }
})

test('session context tells the agent which language to reply and report in', () => {
  const { store, project, card, cleanup } = setup()
  try {
    const fresh = store.getCard(card.id)
    const zh = buildSessionContext({ card: fresh, project, locale: 'zh' })
    const en = buildSessionContext({ card: fresh, project, locale: 'en' })
    assert.match(zh.sectionText, /Chinese \(zh\)[\s\S]*factory_report/)
    assert.match(zh.firstMessage, /Chinese \(zh\)[\s\S]*factory_report/)
    assert.match(en.sectionText, /English \(en\)[\s\S]*factory_report/)
    assert.match(en.firstMessage, /English \(en\)[\s\S]*factory_report/)
    const fr = buildSessionContext({ card: fresh, project, locale: 'fr' })
    assert.match(fr.sectionText, /French \(fr\)[\s\S]*factory_report/)
    const ko = buildSessionContext({ card: fresh, project, locale: 'ko' })
    assert.match(ko.sectionText, /Korean \(ko\)[\s\S]*factory_report/, 'new languages need no table entry')
    // Ahead of the card fields, so the instruction is not lost in the detail block.
    assert.ok(zh.sectionText.indexOf('Chinese (zh)') < zh.sectionText.indexOf('- cardId:'))
  } finally {
    cleanup()
  }
})

test('attachSessionContext registers variables + a section that read the store live', () => {
  const { store, card, cleanup } = setup()
  try {
    const variables = {}
    let section = null
    const agentCtx = {
      systemPrompt: {
        variable: (name, provider) => { variables[name] = provider; return () => {} },
        section: (definition) => { section = definition; return () => {} },
        getSectionOrder: () => 61,
      },
    }
    const dispose = attachSessionContext({ agentCtx, store, cardId: card.id })
    assert.equal(typeof dispose, 'function')

    assert.equal(variables.factory_card_id(), card.id)
    assert.equal(variables.factory_phase(), 'inbox')
    assert.ok(section && section.name === 'factory:work-item')
    assert.ok(section.text().includes(card.id))

    // Move the card: the section provider must reflect the new phase with no re-register.
    store.transitionCard(card.id, 'triage', 'human')
    assert.equal(variables.factory_phase(), 'triage')
    assert.ok(section.text().includes('triage'))
  } finally {
    cleanup()
  }
})

test('attachSessionContext refuses a ctx without systemPrompt', () => {
  assert.throws(() => attachSessionContext({ agentCtx: {}, store: {}, cardId: 'x' }), /systemPrompt/)
})
