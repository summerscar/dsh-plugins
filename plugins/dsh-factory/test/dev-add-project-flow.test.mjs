import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { factoryToolSpecs } from '../tools.js'
import { makeFixture } from './dev-v4-support.mjs'

/** A throwaway git repo, so the test never depends on the checkout's own path. */
function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'dev-add-project-'))
  execFileSync('git', ['-C', dir, 'init', '--quiet'], { stdio: 'ignore' })
  return dir
}

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
  const repo = tempRepo()
  try {
    const spec = factoryToolSpecs({ store: f.store }).find((s) => s.name === 'factory_create_project')
    const out = await spec.execute({ name: 'new', rootPath: repo, workMode: 'full-access' })
    const project = f.store.getProject(out.id)
    assert.equal(project.rootPath, repo, 'the registered root is the repository that was inspected')
    assert.equal(project.workMode, 'full-access')
    assert.equal('autonomy' in project, false)
    assert.equal(project.phaseRules.plan.autoApprove, true)
    // The root must be validated for real, so an unregistered path can never be
    // persisted — the check that the CI-only failure exposed must stay live.
    await assert.rejects(
      () => spec.execute({ name: 'gone', rootPath: join(repo, 'does-not-exist'), workMode: 'full-access' }),
      /不存在/,
      'a missing root is refused instead of being persisted',
    )
  } finally {
    f.cleanup()
    rmSync(repo, { recursive: true, force: true })
  }
})
