/**
 * Skill-loading tests — frontmatter parsing, directory discovery, and
 * registration on a fake `ctx.skills` service. No host is involved.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadSkillDirectory, parseSkillMarkdown, registerFactorySkills } from '../skills.js'

test('parseSkillMarkdown splits frontmatter and body', () => {
  const { meta, content } = parseSkillMarkdown('---\nname: factory-plan\ndescription: Plan a card\n---\nDo the plan.\n')
  assert.equal(meta.name, 'factory-plan')
  assert.equal(meta.description, 'Plan a card')
  assert.equal(content, 'Do the plan.')
  // No frontmatter → whole text is the body.
  assert.equal(parseSkillMarkdown('just text').content, 'just text')
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'factory-skills-'))
  mkdirSync(join(dir, 'factory-plan'))
  writeFileSync(join(dir, 'factory-plan', 'SKILL.md'), '---\nname: factory-plan\ndescription: Plan a card\nwhenToUse: when planning\n---\n# Plan body\n')
  mkdirSync(join(dir, 'no-description'))
  writeFileSync(join(dir, 'no-description', 'SKILL.md'), '---\nname: no-description\n---\nbody without description\n')
  return dir
}

test('loadSkillDirectory returns skills that have a description, skipping the rest', () => {
  const dir = fixture()
  try {
    const skills = loadSkillDirectory(dir)
    assert.equal(skills.length, 1)
    assert.equal(skills[0].name, 'factory-plan')
    assert.equal(skills[0].description, 'Plan a card')
    assert.equal(skills[0].whenToUse, 'when planning')
    assert.ok(skills[0].content.includes('Plan body'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('registerFactorySkills registers each skill with a both-invocable policy', () => {
  const dir = fixture()
  try {
    const registered = []
    const ctx = {
      get: (name) => (name === 'skills' ? { register: (skill) => { registered.push(skill); return () => {} } } : undefined),
      effect: (fn) => { fn(); return () => {} },
    }
    const count = registerFactorySkills({ ctx, skillsDir: dir })
    assert.equal(count, 1)
    assert.equal(registered.length, 1)
    assert.equal(registered[0].name, 'factory-plan')
    assert.deepEqual(registered[0].invocation, { modelInvocable: true, userInvocable: true })
    assert.ok(registered[0].content.includes('Plan body'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('registerFactorySkills is a no-op without a skills service or a skills directory', () => {
  assert.equal(registerFactorySkills({ ctx: {}, skillsDir: '/nonexistent' }), 0)
  const ctx = { get: () => ({ register: () => () => {} }), effect: (fn) => fn() }
  assert.equal(registerFactorySkills({ ctx, skillsDir: '/nonexistent-xyz' }), 0)
})
