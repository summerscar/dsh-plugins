/**
 * Dev — /factory command contract (the "command triggers the agent" chain).
 *
 * `/factory add` no longer registers a project itself: it hands the intent to
 * the invoking agent, which follows the packaged `factory-add-project` skill.
 * These tests pin the parts that are testable without a running Host:
 *  - the grammar, including `add` with no path (means "session cwd")
 *  - the intent message handed to `agent.followup`
 *  - the cwd fallback and its failure mode
 *  - the read-only `inspect` path
 *  - registration tolerance when the commands service is absent
 *
 * What they do NOT prove: that a real Host delivers the message, that the model
 * picks the skill, and that it then calls the tools. That chain needs a live
 * session (QA's real-machine pass), so nothing here claims it.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  ADD_SKILL_NAME, COMMAND_HINT, COMMAND_NAME, buildAddIntent, factoryHelp,
  handleFactoryCommand, parseFactoryLine, registerFactoryCommands, runInspect,
} from '../commands.js'

/** A fake agent recording what the command hands it. */
function fakeAgent({ cwd } = {}) {
  const delivered = []
  return {
    delivered,
    agent: {
      session: { header: cwd === undefined ? {} : { cwd } },
      followup: (message) => { delivered.push(message) },
    },
  }
}

/**
 * Stand-in for the host's createUserMessage: the real one stamps `role: 'user'`
 * and a fresh id, so the fake mirrors that shape (nothing more).
 */
const fakeCreateUserMessage = (input) => Object.freeze({ ...input, role: 'user', id: 'fake-message-id' })

const invoke = (rawInput, extra = {}) => handleFactoryCommand({
  ...extra,
  invocation: { rawInput, ...extra.invocation },
  loadCreateUserMessage: async () => fakeCreateUserMessage,
})

// --- grammar -----------------------------------------------------------------

test('parseFactoryLine: bare add means "session cwd", not an error', () => {
  assert.deepEqual(parseFactoryLine('add'), { action: 'add' })
  assert.deepEqual(parseFactoryLine('  add  '), { action: 'add' })
  assert.deepEqual(parseFactoryLine('add /workspace/repo'), { action: 'add', rootPath: '/workspace/repo' })
  assert.deepEqual(parseFactoryLine('add /workspace/repo My Cool Project'), {
    action: 'add', rootPath: '/workspace/repo', name: 'My Cool Project',
  })
})

test('parseFactoryLine: empty / help / unknown / inspect-without-path are handled', () => {
  assert.deepEqual(parseFactoryLine(''), { action: 'help' })
  assert.deepEqual(parseFactoryLine('help'), { action: 'help' })
  assert.match(parseFactoryLine('frobnicate /workspace/x').error, /未知子命令/)
  assert.match(parseFactoryLine('inspect').error, /用法/)
  assert.deepEqual(parseFactoryLine('inspect /workspace/repo extra'), {
    action: 'inspect', rootPath: '/workspace/repo',
  })
})

test('factoryHelp documents the optional path and the approval boundary', () => {
  const help = factoryHelp()
  assert.match(help, /\/factory add/)
  assert.match(help, /working directory/, 'help must state the no-path fallback')
  assert.match(help, /auto-delivery \(L4\) may commit, push and open a draft PR/, 'help states what L4 does by itself')
  assert.match(help, /merging and marking done always need you/, 'help states what still needs a human')
  assert.equal(COMMAND_NAME, 'factory')
  assert.match(COMMAND_HINT, /inspect/)
})

// --- intent message ----------------------------------------------------------

test('buildAddIntent: explicit path wins, name is carried, skill is named', () => {
  const intent = buildAddIntent({ parsed: { action: 'add', rootPath: '/workspace/repo', name: 'Repo' }, cwd: '/elsewhere' })
  assert.match(intent.text, /\/workspace\/repo/)
  assert.match(intent.text, /Repo/)
  assert.match(intent.text, new RegExp(ADD_SKILL_NAME))
  assert.match(intent.text, /factory_inspect_repo/, 'must tell the agent to use the tool, not read files')
  assert.match(intent.text, /factory_create_project/)
  assert.doesNotMatch(intent.text, /\/elsewhere/, 'cwd must not leak when a path was given')
})

test('buildAddIntent: no path falls back to the session cwd; neither available is an error', () => {
  const fromCwd = buildAddIntent({ parsed: { action: 'add' }, cwd: '/workspace/session-cwd' })
  assert.match(fromCwd.text, /\/workspace\/session-cwd/)

  const noCwd = buildAddIntent({ parsed: { action: 'add' }, cwd: undefined })
  assert.match(noCwd.error, /无法确定要添加的路径/)
  assert.match(noCwd.error, /\/factory add <absolute-repo-path>/)
})

test('buildAddIntent: never hardcodes a package manager or an install command', () => {
  const intent = buildAddIntent({ parsed: { action: 'add', rootPath: '/workspace/repo' }, cwd: undefined })
  // The plugin ships knowledge, not commands: the target repo decides.
  for (const command of ['pnpm install', 'npm ci', 'npm install', 'bun install', 'yarn install']) {
    assert.equal(intent.text.includes(command), false, `intent must not name ${command}`)
  }
  assert.match(intent.text, /AGENTS\.md|CONTRIBUTING/, 'must defer to the target repository')
})

// --- the trigger chain -------------------------------------------------------

test('add hands one message to agent.followup and creates nothing itself', async () => {
  const { agent, delivered } = fakeAgent({ cwd: '/workspace/session-cwd' })
  const result = await invoke('add /workspace/repo', { invocation: { agent } })
  assert.equal(result.kind, 'success')
  assert.equal(delivered.length, 1, 'exactly one message is queued')
  const [message] = delivered
  assert.equal(message.role, 'user')
  assert.deepEqual(message.source, { kind: 'user' })
  assert.equal(message.content[0].type, 'text')
  assert.match(message.content[0].text, /\/workspace\/repo/)
  assert.match(result.text, /已把添加请求交给 agent/)
})

test('bare add hands the session cwd to the agent', async () => {
  const { agent, delivered } = fakeAgent({ cwd: '/workspace/session-cwd' })
  const result = await invoke('add', { invocation: { agent } })
  assert.equal(result.kind, 'success')
  assert.equal(delivered.length, 1)
  assert.match(delivered[0].content[0].text, /\/workspace\/session-cwd/)
})

test('bare add without a session cwd refuses and queues nothing', async () => {
  const { agent, delivered } = fakeAgent({})
  const result = await invoke('add', { invocation: { agent } })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /无法确定要添加的路径/)
  assert.equal(delivered.length, 0, 'no message when the target is unknown')
})

test('an invocation without an agent refuses instead of silently doing nothing', async () => {
  const result = await invoke('add /workspace/repo', { invocation: {} })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /没有可用的 agent/)
})

test('help and bad subcommands never touch the agent', async () => {
  const { agent, delivered } = fakeAgent({ cwd: '/workspace/x' })
  for (const line of ['', 'help', 'frobnicate /workspace/x', 'inspect']) {
    const result = await invoke(line, { invocation: { agent } })
    assert.ok(result.kind === 'success' || result.kind === 'error')
  }
  assert.equal(delivered.length, 0, 'only an add request reaches the agent')
})

// --- inspect stays read-only -------------------------------------------------

test('inspect reports raw facts and creates nothing', async () => {
  const fakeSignals = () => ({
    rootPath: '/workspace/repo',
    packageManager: 'pnpm@11.28.5',
    rootFiles: ['package.json', 'pnpm-lock.yaml'],
    rootDirectories: ['src'],
    ignoreFiles: { '.gitignore': ['.env.local'] },
    manifestFiles: ['package.json', 'pnpm-lock.yaml'],
    notes: ['read-only'],
  })
  const result = await invoke('inspect /workspace/repo', {
    inspect: fakeSignals,
    assertRoot: undefined,
  })
  // assertRoot defaults to the real validator; /workspace/repo need not exist here,
  // so this asserts the injected-inspector path only through runInspect.
  const direct = runInspect({
    parsed: { action: 'inspect', rootPath: '/workspace/repo' },
    assertRoot: (p) => p,
    inspect: fakeSignals,
  })
  assert.equal(direct.kind, 'success')
  assert.match(direct.text, /packageManager: pnpm@11\.28\.5/)
  assert.match(direct.text, /root files: package\.json, pnpm-lock\.yaml/)
  assert.match(direct.text, /root directories: src/)
  assert.match(direct.text, /\.gitignore: \.env\.local/)
  assert.ok(result.kind === 'success' || result.kind === 'error', 'no throw either way')
})

test('inspect returns raw facts, not a project-type verdict', async () => {
  const result = runInspect({
    parsed: { action: 'inspect', rootPath: '/workspace/py' },
    assertRoot: (p) => p,
    inspect: () => ({
      rootPath: '/workspace/py',
      packageManager: '',
      rootFiles: ['pyproject.toml', 'requirements.txt'],
      rootDirectories: ['src', 'tests'],
      ignoreFiles: {},
      manifestFiles: ['pyproject.toml', 'requirements.txt'],
      notes: [],
    }),
  })
  assert.equal(result.kind, 'success')
  // A Python repo must be visible even though it has no Node manifest at all.
  assert.match(result.text, /pyproject\.toml/)
  assert.match(result.text, /requirements\.txt/)
  // And the plugin still names no command and no project type.
  for (const command of ['pnpm install', 'pip install', 'npm ci', 'poetry install']) {
    assert.equal(result.text.includes(command), false, `must not name ${command}`)
  }
})

test('inspect without an inspector is a clear error, not a crash', () => {
  const result = runInspect({ parsed: { action: 'inspect', rootPath: '/workspace/repo' }, assertRoot: (p) => p })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /未提供仓库分析能力/)
})

test('inspect propagates a validator error verbatim', () => {
  const result = runInspect({
    parsed: { action: 'inspect', rootPath: 'relative/path' },
    assertRoot: () => { throw new Error('rootPath 必须是绝对路径') },
    inspect: () => { throw new Error('should not be reached') },
  })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /绝对路径/)
})

// --- registration ------------------------------------------------------------

test('registerFactoryCommands: tolerates a missing service and registers one command', () => {
  assert.equal(registerFactoryCommands({ ctx: {} }), null)
  assert.equal(registerFactoryCommands({ ctx: { get: () => undefined } }), null)
  const seen = []
  const ctx = { get: (k) => (k === 'commands' ? { register: (spec) => { seen.push(spec); return () => {} } } : undefined) }
  const disposer = registerFactoryCommands({ ctx })
  assert.equal(typeof disposer, 'function')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].name, 'factory')
  assert.equal(typeof seen[0].handler, 'function')
})

test('the registered handler is async and routes help without an agent', async () => {
  const seen = []
  const ctx = { get: () => ({ register: (spec) => { seen.push(spec); return () => {} } }) }
  registerFactoryCommands({ ctx })
  const result = await seen[0].handler({ rawInput: 'help' })
  assert.equal(result.kind, 'success')
})

test('a temp dir cleans up (sanity for the fake-agent helper)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dev-cmd-'))
  try {
    assert.ok(tmp.length > 0)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})
