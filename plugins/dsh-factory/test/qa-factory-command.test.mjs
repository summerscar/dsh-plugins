/**
 * QA — /factory slash command, PRD v4.7 K group (trigger chain).
 *
 * The command is a TRIGGER: `/factory add` hands the intent to the agent, which
 * picks up the `factory-add-project` skill and does the work. So the old
 * "the command creates a project" assertions are GONE (contract changed). What
 * is testable offline is: the grammar, the intent message, the path fallback,
 * the read-only inspect, registration tolerance, and the guarantee that the
 * command itself writes NOTHING.
 *
 * K6 (real machine: menu shows /factory, agent really loads the skill and
 * creates the project) is a bcdp e2e and cannot pass here — it needs the user's
 * go-ahead, so nothing in this file claims K6.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  ADD_SKILL_NAME, COMMAND_HINT, COMMAND_NAME, buildAddIntent, factoryHelp,
  handleFactoryCommand, parseFactoryLine, registerFactoryCommands, runInspect, triggerAgentAdd,
} from '../commands.js'
import { FactoryStore } from '../store.js'

const VALID_ROOT = (raw) => {
  const p = String(raw ?? '').trim()
  if (!p.startsWith('/')) throw new Error('rootPath 必须是绝对路径')
  return p
}

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-cmd-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  return { store, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

/** A fake invocation: the host's CommandInvocation carries `agent`. */
function fakeInvocation({ rawInput = '', cwd = '/workspace/session-cwd', followup } = {}) {
  const sent = []
  return {
    sent,
    invocation: {
      commandId: COMMAND_NAME,
      rawInput,
      agent: {
        session: { header: { cwd } },
        followup: followup ?? ((message) => { sent.push(message) }),
      },
    },
  }
}

// The loader only *builds* a message; the agent's followup is what records it.
// Pushing in both would double-count and make the assertion lie.
const fakeLoader = () => async () => (payload) => payload

// --- grammar -----------------------------------------------------------------

test('K3: bare /factory and unknown subcommands give help and write nothing', () => {
  for (const line of ['', '   ', 'help', 'frobnicate /workspace/x']) {
    const parsed = parseFactoryLine(line)
    assert.equal(parsed.action, 'help', `${JSON.stringify(line)} must fall back to help`)
  }
  assert.match(parseFactoryLine('frobnicate /workspace/x').error, /未知子命令/)
  assert.match(factoryHelp(), /\/factory add/)
  assert.match(factoryHelp(), /commit \/ push \/ PR still need human approval/)
})

test('K2: /factory add with no path is VALID and means the session cwd (not an error)', () => {
  // Distinct from bare `/factory`, which is help. This one is an explicit action.
  assert.deepEqual(parseFactoryLine('add'), { action: 'add' })
  assert.deepEqual(parseFactoryLine('add /workspace/repo'), { action: 'add', rootPath: '/workspace/repo' })
  assert.deepEqual(parseFactoryLine('add /workspace/repo My Project'), {
    action: 'add', rootPath: '/workspace/repo', name: 'My Project',
  })
  // inspect still requires a path.
  assert.match(parseFactoryLine('inspect').error, /用法/)
})

test('K2: buildAddIntent falls back to the session cwd, and errors clearly when neither exists', () => {
  const noPath = buildAddIntent({ parsed: parseFactoryLine('add'), cwd: '/workspace/session-cwd' })
  assert.match(noPath.text, /\/workspace\/session-cwd/, 'no path means the session working directory')

  const explicit = buildAddIntent({ parsed: parseFactoryLine('add /workspace/repo X'), cwd: '/workspace/session-cwd' })
  assert.match(explicit.text, /\/workspace\/repo/)
  assert.match(explicit.text, /Project name to use: X/)

  const nothing = buildAddIntent({ parsed: parseFactoryLine('add'), cwd: undefined })
  assert.match(nothing.error, /无法确定要添加的路径/)
})

// --- the intent message ------------------------------------------------------

test('K1: the intent message tells the agent to use the skill and the tools, not to guess', () => {
  const { text } = buildAddIntent({ parsed: parseFactoryLine('add /workspace/repo'), cwd: '/w' })
  assert.match(text, new RegExp(`\\\`${ADD_SKILL_NAME}\\\` skill`), 'must name the skill')
  assert.match(text, /factory_inspect_repo/, 'must inspect via the tool')
  assert.match(text, /factory_create_project/, 'must create via the tool')
  assert.match(text, /AGENTS\.md \/ CONTRIBUTING/, 'must defer to the target repository')
  assert.match(text, /do not read files and guess/i)
  // The trigger must not smuggle a plugin-prescribed command in.
  for (const cmd of ['pnpm install', 'npm ci', 'bun install', 'yarn install']) {
    assert.equal(text.includes(cmd), false, `intent must not hardcode ${cmd}`)
  }
})

test('K1: triggering hands the message to the agent and writes NOTHING to the store', async () => {
  const { store, cleanup } = setup()
  try {
    const { invocation, sent } = fakeInvocation({ rawInput: 'add /workspace/repo' })
    const result = await handleFactoryCommand({
      invocation, inspect: () => { throw new Error('must not inspect on add') },
      loadCreateUserMessage: fakeLoader(),
    })
    assert.equal(result.kind, 'success')
    assert.equal(sent.length, 1, 'exactly one followup message')
    assert.match(JSON.stringify(sent[0]), /factory_inspect_repo/)
    assert.equal(store.listProjects().length, 0, 'the command itself must never create a project')
  } finally { cleanup() }
})

test('K1: an invocation without an agent degrades to a clear error, not a crash', async () => {
  const { store, cleanup } = setup()
  try {
    const result = await handleFactoryCommand({ invocation: { rawInput: 'add /workspace/repo' }, inspect: () => ({}) })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /没有可用的 agent/)
    assert.equal(store.listProjects().length, 0)
  } finally { cleanup() }
})

test('K1: a missing host peer for createUserMessage reports the reason instead of throwing', async () => {
  const { invocation } = fakeInvocation({ rawInput: 'add /workspace/repo' })
  const result = await triggerAgentAdd({
    invocation,
    parsed: parseFactoryLine('add /workspace/repo'),
    loadCreateUserMessage: async () => { throw new Error('peer not installed') },
  })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /无法创建会话消息/)
})

// --- inspect stays direct and read-only --------------------------------------

/** A real temp git repo — inspect goes through the REAL assertRepoRoot. */
function makeRepo() {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-cmd-repo-'))
  const root = join(tmp, 'repo')
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{}')
  return { root, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

test('inspect: read-only, reports objective signals, creates nothing', async () => {
  const repo = makeRepo()
  const { store, cleanup } = setup()
  try {
    const result = await handleFactoryCommand({
      invocation: { rawInput: `inspect ${repo.root}` },
      inspect: () => ({
        rootPath: repo.root, packageManager: 'pnpm@11.28.5',
        rootFiles: ['pnpm-lock.yaml', '.env.example'], rootDirectories: ['.git', 'src'],
        ignoreFiles: { '.gitignore': ['.env.local'] }, manifestFiles: ['pnpm-lock.yaml'],
      }),
    })
    assert.equal(result.kind, 'success', result.text)
    assert.match(result.text, /packageManager: pnpm@11\.28\.5/)
    assert.match(result.text, /root files: .*pnpm-lock\.yaml/, 'renders raw root files')
    assert.match(result.text, /root directories: .*src/, 'renders raw root directories')
    assert.match(result.text, /manifests worth a look/, 'flags manifests without judging the type')
    assert.equal(store.listProjects().length, 0, 'inspect never creates a project')

    const noInspect = await handleFactoryCommand({ invocation: { rawInput: `inspect ${repo.root}` } })
    assert.equal(noInspect.kind, 'error')
    assert.match(noInspect.text, /未提供仓库分析能力/)
  } finally { repo.cleanup(); cleanup() }
})

test('K3: illegal inspect paths are refused with a clear reason and never throw', () => {
  // Real assertRepoRoot: a recursion regression would throw RangeError here.
  for (const [path, reason] of [
    ['relative/path', /绝对路径/],
    ['/workspace/qa-no-such-dir', /不存在/],
    ['/etc', /不是 git 仓库/],
    ['/data/dsh/inside', /数据根内/],
  ]) {
    let out
    assert.doesNotThrow(() => {
      out = runInspect({ parsed: { action: 'inspect', rootPath: path }, inspect: () => ({}) })
    }, `${path} must not throw`)
    assert.equal(out.kind, 'error')
    assert.match(out.text, reason)
  }
})

// --- registration ------------------------------------------------------------

test('K4: registration is tolerant — no commands service means skip, not fail', () => {
  const { store, cleanup } = setup()
  try {
    assert.equal(registerFactoryCommands({ ctx: {}, store }), null)
    const seen = []
    const ctx = { get: (k) => (k === 'commands' ? { register: (spec) => { seen.push(spec); return () => {} } } : undefined) }
    const disposer = registerFactoryCommands({ ctx, store })
    assert.equal(typeof disposer, 'function')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].name, COMMAND_NAME)
    assert.equal(typeof seen[0].handler, 'function')
    assert.equal(seen[0].input.hint, COMMAND_HINT)
  } finally { cleanup() }
})

test('K5: the command module ships no token mechanism and no hard-coded install command', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../commands.js', import.meta.url), 'utf8')
  for (const needle of ['confirmToken', 'consume(', 'adopt', 'pnpm install', 'npm ci', 'bun install']) {
    assert.equal(src.includes(needle), false, `commands.js must not contain ${needle}`)
  }
})

const commandsExports = await import('../commands.js')
