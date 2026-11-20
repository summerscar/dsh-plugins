/**
 * Dev self-check for the add-project entry redesign:
 *  - the new-project dialog is instruction-only (no form, no direct POST)
 *  - only factory-add-project is user-invocable among the packaged skills
 *  - the skill asks workMode + autonomy through ask_user_question and passes
 *    both answers into factory_create_project, which persists them
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import test from 'node:test'

import { FactoryStore } from '../store.js'
import { factoryToolSpecs } from '../tools.js'
import { loadSkillDirectory, registerFactorySkills } from '../skills.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const client = readFileSync(join(root, 'client.js'), 'utf8')

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'dev-addproj-'))
  execFileSync('git', ['init', '-q', dir])
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('Dev-AddProject: new-project dialog is instruction-only — no form, no direct POST', () => {
  assert.doesNotMatch(client, /const \[newProject, setNewProject\]/, 'no form state remains')
  assert.doesNotMatch(client, /callApi\('POST', '\/projects'/, 'client never creates a project directly')
  const modal = client.slice(client.indexOf("showNewProject ? h(Modal"), client.indexOf("showNewCard ? h(Modal"))
  assert.ok(modal.length > 0, 'new-project modal block found')
  assert.doesNotMatch(modal, /h\(Field/, 'no form fields in the new-project dialog')
  assert.doesNotMatch(modal, /onConfirm: createProject/, 'no create action')
  assert.match(modal, /t\('newProjectHint'\)/, 'the dialog shows only the instruction')
  // The dialog is a one-way notice: no cancel button, only the single close.
  assert.match(modal, /hideCancel: true/, 'the notice dialog hides the cancel button')
  assert.equal((modal.match(/onCancel:/g) || []).length, 0, 'no cancel handler on the notice dialog')
  const modalDef = client.slice(client.indexOf('function Modal('), client.indexOf('function AutonomySection('))
  assert.match(modalDef, /hideCancel/, 'Modal supports hiding the cancel button')
  assert.match(modalDef, /!hideCancel[\s\S]{0,80}key: 'cancel'/, 'cancel button is conditional')
  for (const lang of ['zh', 'en']) {
    const dict = JSON.parse(readFileSync(join(root, 'locale', `${lang}.json`), 'utf8'))
    assert.match(dict.newProjectHint, /\/factory-add-project/)
    assert.match(dict.newProjectHint, /\[仓库路径\]|\[repo path\]/)
  }
})

test('Dev-AddProject: only factory-add-project is user-invocable among shipped skills', () => {
  const skills = loadSkillDirectory(join(root, 'skills'))
  assert.equal(skills.length, 7)
  const registered = []
  const ctx = {
    get: (name) => (name === 'skills' ? { register: (skill) => { registered.push(skill); return () => {} } } : undefined),
    effect: (fn) => { fn(); return () => {} },
  }
  registerFactorySkills({ ctx })
  assert.equal(registered.length, 7)
  for (const skill of registered) {
    if (skill.name === 'factory-add-project') {
      assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true })
    } else {
      assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: false }, `${skill.name} must not be user-invocable`)
    }
  }
})

test('Dev-AddProject: skill asks workMode + autonomy via ask_user_question before creating', () => {
  const skill = readFileSync(join(root, 'skills', 'factory-add-project', 'SKILL.md'), 'utf8')
  assert.match(skill, /ask_user_question/, 'uses the DSH built-in question tool')
  assert.match(skill, /id:\s*['"]?workMode/, 'asks the work-mode question with a stable id')
  assert.match(skill, /id:\s*['"]?autonomy/, 'asks the autonomy question with a stable id')
  for (const mode of ['workspace-write', 'full-access', 'auto-review']) {
    assert.match(skill, new RegExp(mode), `work-mode option ${mode} offered`)
  }
  for (const level of ['L0', 'L1', 'L2', 'L3', 'L4']) {
    assert.match(skill, new RegExp(level), `autonomy option ${level} offered`)
  }
  assert.match(skill, /selected/, 'reads the user answers from the tool result')
  assert.match(skill, /workMode: <mode>/, 'passes workMode into factory_create_project')
  assert.match(skill, /autonomy: <level>/, 'passes autonomy into factory_create_project')
  assert.match(skill, /autoDispatch/, 'maps L1/L2 to the autoDispatch switch')
  // The question step must come BEFORE the create step in the document.
  assert.ok(skill.indexOf('ask_user_question') < skill.indexOf('factory_create_project') || skill.match(/factory_create_project/g).length > 1,
    'question step is documented ahead of creation')
})

test('Dev-AddProject: factory_create_project persists workMode and autonomy from the answers', async () => {
  const repo = makeRepo()
  const tmp = mkdtempSync(join(tmpdir(), 'dev-addproj-store-'))
  try {
    const store = new FactoryStore({ file: join(tmp, 'factory.json') })
    const spec = factoryToolSpecs({ store }).find((s) => s.name === 'factory_create_project')
    assert.equal('workMode' in spec.parameters, true, 'workMode parameter declared')
    assert.equal('autonomy' in spec.parameters, true, 'autonomy parameter declared')
    assert.equal('autoDispatch' in spec.parameters, true, 'autoDispatch parameter declared')

    const created = await spec.execute({
      name: 'asked', rootPath: repo.dir, copyFiles: [], postCreate: '',
      workMode: 'full-access', autonomy: 'L2',
    })
    const project = store.getProject(created.id)
    assert.equal(project.workMode, 'full-access', 'work mode answer persisted')
    assert.equal(project.autonomy, 'you-approve', 'L2 maps to you-approve')
    assert.equal(project.autoDispatch, true, 'L2 maps to autoDispatch ON')
    assert.equal(project.issueRepo, null, 'no binding was invented')

    const l0 = await spec.execute({
      name: 'l0', rootPath: repo.dir, copyFiles: [], postCreate: '',
      workMode: 'workspace-write', autonomy: 'L0',
    })
    const manual = store.getProject(l0.id)
    assert.equal(manual.autonomy, 'manual')
    assert.equal(manual.autoDispatch, false)
  } finally {
    repo.cleanup()
    rmSync(tmp, { recursive: true, force: true })
  }
})
