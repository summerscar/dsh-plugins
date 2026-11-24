import assert from 'node:assert/strict'
import test from 'node:test'
import { factoryToolSpecs } from '../tools.js'
import { makeFixture } from './dev-v4-support.mjs'

const specs = factoryToolSpecs({ store: makeFixture().store })
const create = specs.find((spec) => spec.name === 'factory_create_project')

test('Dev-AddProject: new-project dialog is instruction-only — no form, no direct POST', () => {
  assert.ok(create)
  assert.doesNotMatch(create.description, /autonomy|L0|L4/, 'no tier question in create tool')
  assert.match(create.description, /workMode/, 'permission boundary remains')
})

test('Dev-AddProject: skill asks workMode only; stage rules default to full auto', () => {
  assert.equal(Object.prototype.hasOwnProperty.call(create.parameters, 'workMode'), true)
  assert.equal(Object.prototype.hasOwnProperty.call(create.parameters, 'autonomy'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(create.parameters, 'autoDispatch'), false)
})

test('Dev-AddProject: only factory-add-project is user-invocable among shipped skills', async () => {
  const { readFileSync } = await import('node:fs')
  const skill = readFileSync(new URL('../skills/factory-add-project/SKILL.md', import.meta.url), 'utf8')
  assert.match(skill, /^user-invocable: true/m)
  assert.match(skill, /only factory skill a human can invoke directly/)
})

test('Dev-AddProject: create tool persists workMode and no legacy tier fields', async () => {
  const f = makeFixture()
  try {
    const spec = factoryToolSpecs({ store: f.store }).find((s) => s.name === 'factory_create_project')
    const out = await spec.execute({ name: 'new', rootPath: '/workspace/dsh-plugins', workMode: 'full-access' })
    const project = f.store.getProject(out.id)
    assert.equal(project.workMode, 'full-access')
    assert.equal('autonomy' in project, false)
    assert.equal(project.phaseRules.plan.autoApprove, true)
  } finally { f.cleanup() }
})
