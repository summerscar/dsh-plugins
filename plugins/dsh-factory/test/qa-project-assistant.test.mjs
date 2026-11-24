/**
 * QA — post-v4.5 project creation assistant (PRD §9.5 after the human-token
 * contract was dropped). Kept from the J group: J1 (read-only signals), J2
 * (illegal rootPath), J5 (open-source compliance), J6 (four original tools
 * unchanged), W-13 (worktree isolation mandatory). Dropped: J3 / J4 / J4a /
 * J4b / one-shot / expired-token — the confirmToken contract no longer exists.
 *
 * Deliberately NO injected assertRoot in the direct-create tests: injecting a
 * fake would hide a broken real validator behind a green test.
 */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_AUTONOMY, FactoryStore } from '../store.js'
import { DEFAULT_PHASE_RULES } from '../phase-rules.js'
import { createApi } from '../api.js'
import { factoryToolSpecs } from '../tools.js'
import { inspectRepo } from '../project-proposal.js'
import { loadSkillDirectory } from '../skills.js'
import { dispatchCard } from '../dispatch.js'
import { isInsideDataRoot } from '../worktree.js'
import { withTempDataRoot } from './qa-helpers.mjs'

const PLUGIN_ROOT = new URL('..', import.meta.url).pathname
const HARD_CODED_COMMANDS = ['pnpm install', 'npm ci', 'bun install', 'yarn install']
const PRIVATE_CONVENTIONS = ['pnpm lint', 'pnpm check', 'npm test', '/workspace/dsh-plugins']

function makeRepo() {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-assist-'))
  const root = join(tmp, 'repo')
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.28.5' }))
  writeFileSync(join(root, 'pnpm-lock.yaml'), '')
  writeFileSync(join(root, '.gitignore'), '# c\n.env.local\nnode_modules/\n')
  writeFileSync(join(root, '.env.example'), 'X=1\n')
  return { tmp, root, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-assist-store-'))
  const file = join(tmp, 'factory.sqlite')
  const store = new FactoryStore({ file })
  const specs = new Map(factoryToolSpecs({ store }).map((s) => [s.name, s]))
  return { store, specs, file, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

// Persistence is now SQLite: the file is a binary database, not JSON text.
// To prove a write really landed, REOPEN a fresh store on the same file and read
// through the public API — stronger than parsing a file, and the only correct way
// after the engine swap. To simulate a dirty on-disk field, edit the state.data
// JSON column directly via node:sqlite, exactly where the store persists it.
function reopen(file) {
  const store = new FactoryStore({ file })
  const state = store.state
  store.db.close()
  return state
}
function patchStateRow(file, mutate) {
  const db = new DatabaseSync(file)
  try {
    const row = db.prepare('SELECT data FROM state WHERE id = 1').get()
    const data = JSON.parse(row.data)
    mutate(data)
    db.prepare('UPDATE state SET data = ? WHERE id = 1').run(JSON.stringify(data))
  } finally { db.close() }
}

// --- J1 ----------------------------------------------------------------------

test('J1: inspect_repo returns RAW FACTS (files/dirs/ignores), creates nothing, returns no command', () => {
  const repo = makeRepo()
  const { store, specs, cleanup } = setup()
  try {
    const signals = inspectRepo({ rootPath: repo.root })
    assert.equal(signals.packageManager, 'pnpm@11.28.5')
    // Raw facts, not a hardcoded project-type verdict: the agent decides.
    assert.ok(signals.rootFiles.includes('pnpm-lock.yaml'), 'root files are listed as-is')
    assert.ok(signals.rootFiles.includes('.env.example'))
    assert.ok(signals.rootDirectories.includes('.git'))
    assert.deepEqual(signals.ignoreFiles['.gitignore'], ['.env.local', 'node_modules/'])
    assert.ok(Array.isArray(signals.manifestFiles))
    assert.ok(signals.manifestFiles.includes('pnpm-lock.yaml'), 'manifests are flagged for a look, not judged')
    assert.ok(Array.isArray(signals.notes) && signals.notes.length > 0)
    // The old enumerated fields are gone — keeping them would reintroduce the
    // "only Node projects" blind spot the user rejected.
    for (const gone of ['lockFiles', 'ignoredPaths', 'envTemplates']) {
      assert.equal(gone in signals, false, `${gone} must be gone: it enumerated a fixed list`)
    }
    const text = JSON.stringify(signals)
    for (const cmd of HARD_CODED_COMMANDS) assert.equal(text.includes(cmd), false)
    assert.equal(store.state.projects.length, 0, 'read-only inspection must not create a project')
    assert.equal(typeof specs.get('factory_inspect_repo').execute, 'function')
  } finally { repo.cleanup(); cleanup() }
})

test('J1b: a NON-Node repository is described just as completely (no Node blind spot)', () => {
  // The user's point: enumerating project types never covers them all. A Python
  // repo must come back fully described without a single Node file present.
  const tmp = mkdtempSync(join(tmpdir(), 'qa-py-'))
  const root = join(tmp, 'py')
  try {
    mkdirSync(join(root, '.git'), { recursive: true })
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'tests'), { recursive: true })
    writeFileSync(join(root, 'pyproject.toml'), '[project]\nname="x"\n')
    writeFileSync(join(root, 'requirements.txt'), 'requests\n')
    writeFileSync(join(root, '.gitignore'), '__pycache__/\n.venv/\n')

    const signals = inspectRepo({ rootPath: root })
    assert.deepEqual(signals.rootFiles.sort(), ['.gitignore', 'pyproject.toml', 'requirements.txt'])
    assert.deepEqual(signals.rootDirectories.sort(), ['.git', 'src', 'tests'])
    assert.deepEqual(signals.manifestFiles.sort(), ['pyproject.toml', 'requirements.txt'])
    assert.equal(signals.packageManager, '', 'no package.json means no packageManager field, and that is fine')
    // Nothing Node-specific leaked into the description of a Python repo.
    assert.equal(signals.rootFiles.includes('package.json'), false)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

// --- J2 ----------------------------------------------------------------------

test('J2: illegal rootPath is refused with a clear reason, zero writes', () => {
  const { store, cleanup } = setup()
  try {
    const bad = [
      ['relative/path', /绝对路径/], ['', /绝对路径/],
      ['/workspace/definitely-not-there-qa', /不存在/],
    ]
    for (const [rootPath, reason] of bad) {
      assert.throws(() => inspectRepo({ rootPath }), reason, `must refuse ${JSON.stringify(rootPath)}`)
      assert.equal(store.state.projects.length, 0)
    }
  } finally { cleanup() }
})

test('J2b: a git repo inside the data root is accepted with a warning, not refused', () => withTempDataRoot((dataRoot) => {
  // Behaviour change 2026-11-15 (user requirement): the agent's own /factory add
  // must be able to register repos living under the DSH data root. The surviving
  // constraint is narrower — never a session cwd, worktree forced outside — and it
  // is reported as a warning. Asserting the new behaviour keeps this case able to
  // catch a regression back to the old blanket refusal.
  //
  // The root is INJECTED, not borrowed from the machine: a fixture written into a
  // live harness home is not the test's business, and skipping when it is
  // unwritable would leave the behaviour unverified. resolveDataRoot() is lazy, so
  // the injected value is in force for every call inside this block; cleanup of the
  // root itself belongs to the helper.
  const root = join(dataRoot, 'repo')
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{}')
  assert.equal(isInsideDataRoot(root), true, 'the fixture really is inside the data root')
  const signals = inspectRepo({ rootPath: root })
  assert.equal(signals.rootPath, root)
  assert.equal(typeof signals.warning, 'string', 'a data-root repo must carry a warning')
  assert.match(signals.warning, /数据根/)
  assert.match(signals.warning, /worktree 强制外置/)
  assert.equal(signals.notes.includes(signals.warning), true, 'the warning is also visible in notes')
}))

test('J2c: a data-root repo with no .git is still refused (the warning is not a bypass)', () => withTempDataRoot((dataRoot) => {
  // No mkdtemp needed: any directory under the injected root without a .git does
  // the job, and the helper removes the root afterwards.
  const plain = join(dataRoot, 'plain-dir')
  mkdirSync(plain, { recursive: true })
  assert.equal(isInsideDataRoot(plain), true, 'the fixture really is inside the data root')
  assert.throws(() => inspectRepo({ rootPath: plain }), /不是 git 仓库/, 'warning never replaces the git check')
}))

// --- direct create (new contract): path validation is the safety gate --------

test('direct create: a valid git repo root is registered; no git write is attempted', async () => {
  const repo = makeRepo()
  const { store, specs, file, cleanup } = setup()
  try {
    const created = await specs.get('factory_create_project').execute({
      name: 'QA', rootPath: repo.root, copyFiles: ['.env.local'], postCreate: '',
    })
    assert.equal(store.state.projects.length, 1)
    // Reopen the SQLite store to prove the write really persisted (no JSON parse).
    assert.equal(reopen(file).projects.length, 1)
    const saved = store.getProject(created.id)
    assert.equal(saved.rootPath, repo.root)
    assert.deepEqual(saved.copyFiles, ['.env.local'])
    assert.equal(existsSync(join(repo.root, '.git', 'COMMIT_EDITMSG')), false, 'no commit was made')
  } finally { repo.cleanup(); cleanup() }
})

test('direct create: a non-existent / non-git path is refused with ZERO writes', async () => {
  const { store, specs, file, cleanup } = setup()
  try {
    for (const rootPath of ['/workspace/definitely-not-there-qa', '/etc']) {
      await assert.rejects(
        () => specs.get('factory_create_project').execute({ name: 'x', rootPath }),
        /不存在|不是 git 仓库|不是目录/,
        `must refuse ${rootPath}`,
      )
    }
    assert.equal(store.state.projects.length, 0)
    assert.equal(reopen(file).projects.length, 0, 'a refused create persisted nothing')
  } finally { cleanup() }
})

// --- tool output must survive the host's lossless-JSON boundary ----------------

test('tool outputs carry no undefined values (the host rejects them as "not lossless JSON")', async () => {
  // Real-machine bug 2026-11-15: both factory_inspect_repo and
  // factory_create_project returned `warning: undefined` for a repo outside the
  // data root. dsh-tools detaches every tool result through a lossless-JSON
  // boundary and refuses an `undefined` member outright, so the tool call failed
  // with `value is not lossless JSON` EVEN THOUGH the write had already happened.
  // The agent then had to fall back to bash and re-derive the signals by hand.
  //
  // Asserting on the raw execute() return — not on JSON.stringify(), which
  // silently drops undefined members and would hide exactly this bug.
  const repo = makeRepo()
  const { store, specs, cleanup } = setup()
  const assertLossless = (label, value) => {
    const stack = [['', value]]
    while (stack.length > 0) {
      const [path, node] = stack.pop()
      assert.notEqual(node, undefined, `${label}: ${path || '<root>'} must not be undefined`)
      if (node === null || typeof node !== 'object') continue
      for (const [key, child] of Object.entries(node)) stack.push([`${path}.${key}`, child])
    }
  }
  try {
    const inspected = await specs.get('factory_inspect_repo').execute({ rootPath: repo.root })
    assertLossless('factory_inspect_repo', inspected)

    const created = await specs.get('factory_create_project').execute({
      name: 'QA-lossless', rootPath: repo.root, copyFiles: [], postCreate: '',
    })
    assertLossless('factory_create_project', created)
  } finally { repo.cleanup(); cleanup() }
})

test('every tool render() returns a ContentBlock array, not a string', async () => {
  // Real-machine bug 2026-11-15 (second round): every factory tool returned a
  // plain string from output.render(). The host contract is
  // `render(args, value): ContentBlock[]` (dsh-tools ToolOutputDefinition), and
  // defineTool passes it through untouched. The string then became the tool
  // result's `content`, and the host's image walk called `content.some(...)` on
  // it — surfacing as `content.some is not a function` and failing EVERY factory
  // tool on a real machine, not just inspect.
  //
  // Asserting the shape here keeps this contract from regressing silently: a
  // string render looks fine in a unit test that only reads the text.
  const repo = makeRepo()
  const { store, specs, cleanup } = setup()
  const assertBlocks = (label, rendered) => {
    assert.equal(Array.isArray(rendered), true, `${label}: render must return an array, got ${typeof rendered}`)
    for (const block of rendered) {
      assert.equal(typeof block, 'object', `${label}: each block must be an object`)
      assert.equal(typeof block?.type, 'string', `${label}: each block needs a type`)
      if (block.type === 'text') assert.equal(typeof block.text, 'string', `${label}: a text block needs text`)
    }
  }
  try {
    const cases = [
      ['factory_list_work_items', {}],
      ['factory_list_attention', {}],
      ['factory_inspect_repo', { rootPath: repo.root }],
      ['factory_create_project', { name: 'QA-render', rootPath: repo.root, copyFiles: [], postCreate: '' }],
    ]
    for (const [name, args] of cases) {
      const spec = specs.get(name)
      const value = await spec.execute(args)
      assertBlocks(name, spec.output.render(args, value))
    }
  } finally { repo.cleanup(); cleanup() }
})

// --- J5 / J6 / W-13 ----------------------------------------------------------

function productFiles(dir = PLUGIN_ROOT, out = []) {
  for (const name of (awaitlessReadDir(dir))) {
    if (['node_modules', '.npm-cache', 'test', '.git'].includes(name)) continue
    const path = join(dir, name)
    if (isDir(path)) productFiles(path, out)
    else if (/\.(js|json|md|yml|svg)$/.test(name)) out.push(path)
  }
  return out
}
// Keep the walker synchronous (node:test assertions below are sync).
import { readdirSync, statSync } from 'node:fs'
const awaitlessReadDir = (dir) => readdirSync(dir)
const isDir = (path) => statSync(path).isDirectory()

test('J5: product source ships no hard-coded install commands or repo-private conventions', () => {
  const offenders = []
  for (const file of productFiles()) {
    const text = readFileSync(file, 'utf8')
    for (const needle of [...PRIVATE_CONVENTIONS, ...HARD_CODED_COMMANDS]) {
      if (text.includes(needle)) offenders.push(`${file.replace(PLUGIN_ROOT, '')}: ${needle}`)
    }
  }
  assert.deepEqual(offenders, [])
})

test('J6: the four original tools stay first, in order, and still execute', async () => {
  const { store, specs, cleanup } = setup()
  try {
    const all = factoryToolSpecs({ store })
    assert.deepEqual(all.slice(0, 4).map((s) => s.name), [
      'factory_list_work_items', 'factory_transition_work_item',
      'factory_report', 'factory_list_attention',
    ])
    const p = store.createProject({ name: 'p', rootPath: '/workspace/p' })
    const b = store.createBoard({ projectId: p.id, name: 'b' })
    const c = store.createCard({ boardId: b.id, title: 'c' })
    const list = await specs.get('factory_list_work_items').execute({})
    assert.equal(list.cards[0].id, c.id)
    assert.deepEqual(Object.keys(list.cards[0]).sort(), ['id', 'status', 'title'])
  } finally { cleanup() }
})

test('W-13: worktree isolation is mandatory, no off switch is persisted', async () => {
  const { store, file, cleanup } = setup()
  try {
    const p = store.createProject({ name: 'p', rootPath: '/workspace/p', worktreeIsolation: false })
    const b = store.createBoard({ projectId: p.id, name: 'b' })
    const c = store.createCard({ boardId: b.id, title: 'c' })
    const calls = []
    const port = {
      createWorktree: (o) => calls.push(o), removeWorktree: () => {}, prepareWorktree: () => {},
      createSession: async () => ({ sessionId: 's', handle: { dispose: () => {} } }),
      disposeSession: async () => {},
    }
    const r = await dispatchCard({ store, cardId: c.id, port })
    assert.equal(calls.length, 1, 'createWorktree must run unconditionally')
    assert.notEqual(r.worktreePath, '/workspace/p')
    assert.equal('worktreeIsolation' in reopen(file).projects[0], false,
      'the off switch must not be persisted (read back from SQLite)')
  } finally { cleanup() }
})

// --- shipped skills: the package must carry all seven, including add-project --

test('skills: every packaged skill loads and factory-add-project is present', () => {
  // The /factory add trigger depends on this skill existing and being loadable;
  // without it the command can only fall back to a bare function call.
  const dir = join(PLUGIN_ROOT, 'skills')
  const skills = loadSkillDirectory(dir)
  const names = skills.map((s) => s.name).sort()
  assert.deepEqual(names, [
    'factory-add-project', 'factory-build', 'factory-plan', 'factory-rereview',
    'factory-review', 'factory-self-review', 'factory-triage',
  ], 'the package must ship all seven skills')
  for (const skill of skills) {
    assert.ok(skill.description.length > 0, `${skill.name} needs a description to be discoverable`)
    assert.ok(skill.content.length > 0, `${skill.name} needs a body`)
  }
  const add = skills.find((s) => s.name === 'factory-add-project')
  // Its trigger text is what makes the skill auto-match; assert the concrete
  // entry points so a rewrite cannot silently drop them.
  assert.match(add.description, /\/factory add/, 'must name the /factory add trigger')
  assert.match(add.content, /factory_inspect_repo/, 'must tell the agent to inspect, not guess')
  assert.match(add.content, /factory_create_project/, 'must create through the tool')
  assert.match(add.content, /AGENTS\.md/, 'must defer the setup command to the target repo')
  for (const cmd of HARD_CODED_COMMANDS) {
    assert.equal(add.content.includes(cmd), false, `add-project must not hardcode ${cmd}`)
  }
})

// --- V4 stage rules: new projects start full auto; tiers are gone -----------

test('stage rules: new projects start full auto; tier keys are inert, narrowing is an explicit edit', () => {
  const { store, cleanup } = setup()
  try {
    const p = store.createProject({ name: 'default', rootPath: '/workspace/p' })
    assert.deepEqual(p.phaseRules, DEFAULT_PHASE_RULES, 'new project is full auto')
    assert.equal('autonomy' in p, false, 'no tier field on a new project')
    assert.equal('autoDispatch' in p, false, 'no legacy switch on a new project')

    // Legacy tier keys in a create payload no longer mean anything.
    const legacy = store.createProject({ name: 'legacy', rootPath: '/workspace/p', autonomy: 'L1', autoStart: true })
    assert.equal('autonomy' in legacy, false, 'the legacy tier key is dropped at create')
    assert.deepEqual(legacy.phaseRules, DEFAULT_PHASE_RULES, 'legacy keys must not smuggle rules in')

    // An explicit narrowing is accepted; absent rules keep their defaults.
    const api = createApi({ store, build: 'qa' })
    const patch = api({ method: 'PATCH', route: `/projects/${p.id}`, body: { phaseRules: { plan: { autoApprove: false } } } })
    assert.equal(patch.status, 200)
    assert.equal(patch.body.project.phaseRules.plan.autoApprove, false, 'a narrowing is accepted')
    assert.equal(patch.body.project.phaseRules.plan.autoStart, true, 'an absent rule keeps its default')
  } finally { cleanup() }
})

test('stage rules allow-list: only boolean autoStart / autoApprove narrow; junk is refused', () => {
  const { store, cleanup } = setup()
  try {
    const p = store.createProject({ name: 'p', rootPath: '/workspace/p' })
    const r = store.updatePhaseRules(p.id, { inbox: { autoStart: false }, 'self-review': { autoApprove: false } })
    assert.equal(r.phaseRules.inbox.autoStart, false, 'a valid narrowing is stored')
    assert.equal(r.phaseRules.inbox.autoApprove, true, 'an absent rule keeps its value')
    assert.equal(r.phaseRules.plan.autoApprove, true)

    // Junk is refused with a readable error and zero writes.
    const junk = [
      { plan: { autoApprove: 'yes' } },
      { plan: { widen: true } },
      { plan: 'off' },
      { 'self-review': [true] },
    ]
    for (const value of junk) {
      assert.throws(() => store.updatePhaseRules(p.id, value), /阶段规则/, `junk ${JSON.stringify(value)} refused`)
    }
    assert.equal(store.getProject(p.id).phaseRules.inbox.autoStart, false, 'a refused write changed nothing')

    // The API surfaces the refusal as 400, and legacy tier keys are inert there.
    const api = createApi({ store, build: 'qa' })
    for (const value of junk) {
      const r2 = api({ method: 'PATCH', route: `/projects/${p.id}`, body: { phaseRules: value } })
      assert.equal(r2.status, 400, `junk ${JSON.stringify(value)} is a 400, not a silent store`)
    }
    const beforeLegacy = store.getProject(p.id).phaseRules
    const legacy = api({ method: 'PATCH', route: `/projects/${p.id}`, body: { autonomy: 'you-approve', autoDispatch: true } })
    assert.equal(legacy.status, 200)
    assert.equal('autonomy' in legacy.body.project, false, 'legacy tier keys are no longer routed or stored')
    assert.deepEqual(legacy.body.project.phaseRules, beforeLegacy, 'a legacy PATCH cannot move the rules')
  } finally { cleanup() }
})

// --- PATCH /projects/:id stage rules (PM's four rules, V4 shapes) ----------

test('PATCH phaseRules: only the fields present change; identity and rootPath never move', () => {
  const { store, file, cleanup } = setup()
  try {
    const api = createApi({ store, build: 'qa' })
    const p = api({ method: 'POST', route: '/projects', body: { name: 'p', rootPath: '/workspace/p' } }).body.project
    assert.deepEqual(p.phaseRules, DEFAULT_PHASE_RULES)

    const narrowed = api({ method: 'PATCH', route: `/projects/${p.id}`, body: { phaseRules: { plan: { autoApprove: false } } } })
    assert.equal(narrowed.status, 200)
    assert.equal(narrowed.body.project.phaseRules.plan.autoApprove, false)
    assert.equal(narrowed.body.project.phaseRules.plan.autoStart, true, 'an absent rule must not flip')

    // A later PATCH preserves previously written narrowings and only moves the given fields.
    const again = api({ method: 'PATCH', route: `/projects/${p.id}`, body: { phaseRules: { inbox: { autoStart: false } } } })
    assert.equal(again.status, 200)
    assert.equal(again.body.project.phaseRules.plan.autoApprove, false, 'a previously written narrowing survives')
    assert.equal(again.body.project.phaseRules.inbox.autoStart, false)

    // Identity / path are not writable through PATCH.
    api({ method: 'PATCH', route: `/projects/${p.id}`, body: { rootPath: '/etc', name: 'hacked' } })
    const after = store.getProject(p.id)
    assert.equal(after.rootPath, '/workspace/p', 'rootPath cannot be retargeted')
    assert.equal(after.name, 'p', 'name cannot be changed here')

    // Mixing the two disjoint shapes is refused AND writes nothing.
    // A 400 alone is not enough — a handler could half-apply before rejecting.
    const beforeDisk = reopen(file).projects[0]
    const mixed = api({ method: 'PATCH', route: `/projects/${p.id}`, body: { phaseRules: { plan: { autoApprove: false } }, copyFiles: ['.other'] } })
    assert.equal(mixed.status, 400)
    assert.match(mixed.body.error, /混改/)
    const afterDisk = reopen(file).projects[0]
    assert.deepEqual(afterDisk.phaseRules, beforeDisk.phaseRules, 'a refused mixed PATCH must not write phaseRules')
    assert.deepEqual(afterDisk.copyFiles, beforeDisk.copyFiles, 'a refused mixed PATCH must not write copyFiles')
  } finally { cleanup() }
})

test('PATCH phaseRules: a junk value is REFUSED and leaves every field untouched', () => {
  // A refused PATCH writes nothing: the stored narrowing survives byte-identical.
  const { store, cleanup } = setup()
  try {
    const api = createApi({ store, build: 'qa' })
    const p = api({ method: 'POST', route: '/projects', body: { name: 'p', rootPath: '/workspace/p' } }).body.project
    api({ method: 'PATCH', route: `/projects/${p.id}`, body: { phaseRules: { plan: { autoApprove: false } } } })
    for (const junk of [{ plan: { autoApprove: 'yes' } }, { plan: { widen: true } }, { plan: 'off' }, { 'self-review': [true] }]) {
      const r = api({ method: 'PATCH', route: `/projects/${p.id}`, body: { phaseRules: junk } })
      assert.equal(r.status, 400, `junk ${JSON.stringify(junk)} must be refused, not silently stored`)
      const now = store.getProject(p.id)
      assert.equal(now.phaseRules.plan.autoApprove, false, 'a refused PATCH must not change the rules')
      assert.equal(now.phaseRules.inbox.autoStart, true, 'a refused PATCH must not touch other stages either')
    }
  } finally { cleanup() }
})

test('legacy/dirty tier fields on disk: the store still loads them, migrates to stage rules, and strips them', () => {
  // store._load() validates only schemaVersion — the tier fields are NOT checked
  // on read. That is deliberate (a bad field must not reject the whole store),
  // so the migration must make a dirty v1 row land somewhere safe: the rules,
  // never a silent auto-run that the owner never configured.
  const { store, file, cleanup } = setup()
  try {
    const p = store.createProject({ name: 'p', rootPath: '/workspace/p' })
    patchStateRow(file, (data) => {
      data.schemaVersion = 1
      data.projects[0].autonomy = 'L1'
      data.projects[0].autoDispatch = true
    })

    // L1 with the switch on migrates to the you-approve shape: the plan gate
    // stays for a human, self-review dispatches, and nothing looks like the
    // old auto-delivery tier.
    const reloaded = new FactoryStore({ file })
    const loaded = reloaded.getProject(p.id)
    assert.equal('autonomy' in loaded, false, 'the tier field is stripped on load')
    assert.equal('autoDispatch' in loaded, false, 'the legacy switch is stripped on load')
    assert.equal(loaded.phaseRules.plan.autoApprove, false, 'L1 keeps its human plan gate')
    assert.equal(loaded.phaseRules['self-review'].autoStart, true, 'L1 + switch on dispatches self-review')
    assert.equal(reopen(file).schemaVersion, 2, 'the v2 rewrite is committed to disk')

    // Junk tier values fall back to the full-auto default and are stripped too.
    patchStateRow(file, (data) => {
      data.schemaVersion = 1
      data.projects[0].autonomy = 'L9'
      data.projects[0].autoDispatch = true
    })
    const dirty = new FactoryStore({ file }).getProject(p.id)
    assert.deepEqual(dirty.phaseRules, DEFAULT_PHASE_RULES, 'junk lands on the default, never on a silent auto-run')
    assert.equal('autonomy' in dirty, false)
  } finally { cleanup() }
})
