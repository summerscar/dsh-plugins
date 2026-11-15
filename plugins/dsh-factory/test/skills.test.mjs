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

test('every registered skill carries the fields the host validates (source, provider)', () => {
  // Real-machine bug 2026-11-15 (round 5): the host refused every packaged skill
  // with `loaded skill "factory-add-project" source must be a string`. The plugin
  // sent `content` but no `source`; the host's register() defaults `provider` but
  // NOT `source`, and validateDefinition() requires both to be strings
  // (dsh-skill/lib/index.js:486-487). The failure was silent in the transcript —
  // the agent still had the prompt's step list, so it looked like it worked.
  //
  // The existing test above only asserted `content`, which is exactly why this
  // slipped through: asserting the fields the HOST validates is the point.
  const dir = fixture()
  try {
    const registered = []
    const ctx = {
      get: (name) => (name === 'skills' ? { register: (skill) => { registered.push(skill); return () => {} } } : undefined),
      effect: (fn) => { fn(); return () => {} },
    }
    registerFactorySkills({ ctx, skillsDir: dir })
    assert.ok(registered.length > 0, 'the fixture must register at least one skill')
    for (const skill of registered) {
      assert.equal(typeof skill.name, 'string', 'name must be a string')
      assert.equal(typeof skill.description, 'string', 'description must be a string')
      assert.equal(typeof skill.content, 'string', 'content must be a string')
      assert.equal(typeof skill.source, 'string',
        `${skill.name}: the host rejects a skill without a string source`)
      assert.notEqual(skill.source, '', `${skill.name}: an empty source is not a real source`)
      if (skill.whenToUse !== undefined) {
        assert.equal(typeof skill.whenToUse, 'string', `${skill.name}: whenToUse must be a string when present`)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the real packaged skills all carry a source (not just the fixture)', () => {
  // Guards the shipped SKILL.md set, not a synthetic directory: this is the exact
  // path /factory add takes on a real machine.
  const registered = []
  const ctx = {
    get: (name) => (name === 'skills' ? { register: (skill) => { registered.push(skill); return () => {} } } : undefined),
    effect: (fn) => { fn(); return () => {} },
  }
  const count = registerFactorySkills({ ctx })
  assert.ok(count > 0, 'the package must ship at least one skill')
  assert.equal(registered.length, count)
  for (const skill of registered) {
    assert.equal(typeof skill.source, 'string', `${skill.name}: shipped skill needs a string source`)
    assert.notEqual(skill.source, '', `${skill.name}: shipped skill source must not be empty`)
  }
})
