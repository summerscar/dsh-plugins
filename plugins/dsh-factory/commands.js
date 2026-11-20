/**
 * dsh-factory — slash command contribution (`/factory ...`).
 *
 * The command is a TRIGGER, not the worker. `/factory add` does not register a
 * project itself: it hands the intent to the agent as an ordinary user message,
 * so the agent picks up the packaged `factory-add-project` skill, inspects the
 * repository with `factory_inspect_repo`, turns the objective signals into a
 * `copyFiles` / `postCreate` proposal, and calls `factory_create_project`.
 *
 * Why an agent and not a function: what a new worktree must copy or run is
 * decided by the TARGET repository's own AGENTS.md / CONTRIBUTING. A pure
 * function cannot read that convention without hardcoding one, and hardcoding a
 * package manager here would be exactly the plugin-prescribes-a-command mistake
 * this project forbids. The agent reads the target repo; the plugin ships the
 * knowledge, not the answer.
 *
 * Host contract (verified against the installed DSH):
 *  - `CommandInvocation` = { commandId, agent, rawInput, attachments, signal }
 *    (`dsh-commands`, execute()).
 *  - `agent.followup(message)` queues a message for the next turn and wakes the
 *    driver (`dsh-agent-loop`); the agent then runs a normal turn.
 *  - `agent.session.header.cwd` is the session's working directory.
 *  - `createUserMessage` lives in the host peer `@deepseek-ai/dsh-llm`, so it is
 *    imported at call time and a missing peer degrades to a clear error.
 *
 * `/factory inspect` stays a direct, read-only call: it writes nothing, and the
 * objective signals it prints are exactly what `factory_inspect_repo` returns.
 */
import { assertRepoRoot } from './project-proposal.js'

export const COMMAND_NAME = 'factory'
export const COMMAND_HINT = '[<absolute-repo-path>] [project name] | inspect <absolute-repo-path>'

/** The skill the triggered agent is told to follow. */
export const ADD_SKILL_NAME = 'factory-add-project'

/**
 * Resolve the host's `createUserMessage`. It lives in the host peer
 * `@deepseek-ai/dsh-llm`, so it is imported at call time — a package dependency
 * would be wrong (the loader injects the host's copy), and a top-level import
 * would break a profile that lacks the peer.
 */
export async function loadHostCreateUserMessage() {
  const module = await import('@deepseek-ai/dsh-llm')
  if (typeof module?.createUserMessage !== 'function') {
    throw new Error('@deepseek-ai/dsh-llm does not export createUserMessage')
  }
  return module.createUserMessage
}

/**
 * Parse the text after `/factory`. Quoted paths are NOT supported: this grammar
 * stays deliberately simple.
 *
 * `add` with no path is valid — it means "the current session's working
 * directory", which only the invocation knows, so the path stays absent here.
 *
 * @returns {{ action: 'add'|'inspect'|'help', rootPath?: string, name?: string, error?: string }}
 */
export function parseFactoryLine(rawInput) {
  const text = String(rawInput ?? '').trim()
  if (text === '') return { action: 'help' }
  const [action, ...rest] = text.split(/\s+/)
  if (action === 'help') return { action: 'help' }
  if (action !== 'add' && action !== 'inspect') {
    return { action: 'help', error: `未知子命令：${action}` }
  }
  const rootPath = rest[0]
  if (action === 'inspect') {
    if (rootPath === undefined || rootPath === '') {
      return { action: 'help', error: '用法：/factory inspect <absolute-repo-path>' }
    }
    return { action, rootPath }
  }
  const name = rest.slice(1).join(' ').trim()
  return {
    action,
    ...(rootPath === undefined || rootPath === '' ? {} : { rootPath }),
    ...(name === '' ? {} : { name }),
  }
}

/** Help text shown for a bare /factory or a bad subcommand. */
export function factoryHelp() {
  return [
    `/factory add [absolute-repo-path] [project name] — hand a git repo to the agent, which inspects it and creates the project`,
    `/factory inspect <absolute-repo-path> — show objective signals only`,
    `add without a path uses this session's working directory.`,
    `Creating a project is local and reversible; auto-delivery (L4) may commit, push and open a draft PR by itself, but merging and marking done always need you.`,
  ].join('\n')
}

/**
 * Build the message that hands an `add` request to the agent. Pure: no Host
 * access, so the wording and the path fallback are unit-testable.
 *
 * @returns {{ text: string } | { error: string }}
 */
export function buildAddIntent({ parsed, cwd } = {}) {
  const target = typeof parsed?.rootPath === 'string' && parsed.rootPath !== '' ? parsed.rootPath : cwd
  if (typeof target !== 'string' || target.trim() === '') {
    return {
      error: '无法确定要添加的路径：命令没有给出路径，当前会话也没有记录工作目录。请用 /factory add <absolute-repo-path>。',
    }
  }
  const rootPath = target.trim()
  const name = typeof parsed?.name === 'string' ? parsed.name.trim() : ''
  return {
    text: [
      `Add this repository to the project factory: ${rootPath}`,
      ...(name === '' ? [] : [`Project name to use: ${name}`]),
      '',
      `Follow the \`${ADD_SKILL_NAME}\` skill for this task:`,
      '1. Call `factory_inspect_repo` on that path — do not read files and guess.',
      '2. Turn the objective signals it returns (packageManager, lock files, .gitignore entries, env templates) into a `copyFiles` / `postCreate` proposal.',
      "3. Decide what to copy and what to run from the TARGET repository's own AGENTS.md / CONTRIBUTING — never from a default this plugin assumes.",
      '4. State the proposal you are about to use, then call `factory_create_project` with the path, name, copyFiles and postCreate.',
      '5. Report what was created and why each value was proposed.',
      '',
      'If a step fails, report the tool error verbatim. Do not retry with a different path on your own.',
    ].join('\n'),
  }
}

/** Render the read-only inspection result for `/factory inspect`. */
export function runInspect({ parsed, assertRoot = assertRepoRoot, inspect } = {}) {
  if (typeof inspect !== 'function') return { kind: 'error', text: '当前环境未提供仓库分析能力' }
  let root
  try {
    root = assertRoot(parsed?.rootPath)
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
  try {
    const signals = inspect({ rootPath: root })
    const ignore = Object.entries(signals.ignoreFiles ?? {})
      .map(([name, entries]) => `${name}: ${entries.join(', ') || '(empty)'}`)
    return {
      kind: 'success',
      text: [
        `Repository: ${signals.rootPath}`,
        `packageManager: ${signals.packageManager || '(none declared)'}`,
        `root files: ${signals.rootFiles.join(', ') || '(none)'}`,
        `root directories: ${signals.rootDirectories.join(', ') || '(none)'}`,
        `manifests worth a look: ${signals.manifestFiles.join(', ') || '(none)'}`,
        ...ignore,
      ].join('\n'),
    }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Hand an `add` request to the invoking agent. The agent — not this handler —
 * creates the project, because only the agent can read the target repository's
 * own conventions through the skill.
 */
export async function triggerAgentAdd({ invocation, parsed, loadCreateUserMessage = loadHostCreateUserMessage } = {}) {
  const agent = invocation?.agent
  if (agent === undefined || agent === null || typeof agent.followup !== 'function') {
    return {
      kind: 'error',
      text: '当前会话没有可用的 agent，无法把添加请求交给模型处理。请在会话里直接说明要添加的仓库路径。',
    }
  }
  const cwd = agent.session?.header?.cwd
  const intent = buildAddIntent({ parsed, cwd })
  if (intent.error !== undefined) return { kind: 'error', text: `${intent.error}\n${factoryHelp()}` }

  let createUserMessage
  try {
    createUserMessage = await loadCreateUserMessage()
  } catch (error) {
    return {
      kind: 'error',
      text: `无法创建会话消息（宿主未提供 @deepseek-ai/dsh-llm）：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: intent.text }],
    source: { kind: 'user' },
  }))
  const target = typeof parsed?.rootPath === 'string' && parsed.rootPath !== '' ? parsed.rootPath : cwd
  return {
    kind: 'success',
    text: `已把添加请求交给 agent：${target}\n它会按 ${ADD_SKILL_NAME} skill 分析仓库、生成配置并调用 factory_create_project。`,
  }
}

/** One `/factory ...` invocation: help, read-only inspect, or agent trigger. */
export async function handleFactoryCommand({ invocation, inspect, loadCreateUserMessage } = {}) {
  const parsed = parseFactoryLine(invocation?.rawInput ?? '')
  if (parsed.error !== undefined) return { kind: 'error', text: `${parsed.error}\n${factoryHelp()}` }
  if (parsed.action === 'help') return { kind: 'success', text: factoryHelp() }
  if (parsed.action === 'inspect') return runInspect({ parsed, inspect })
  return triggerAgentAdd({ invocation, parsed, loadCreateUserMessage })
}

/** Register /factory on the host command service. Returns a disposer or null. */
export function registerFactoryCommands({ ctx, inspect } = {}) {
  const commands = typeof ctx?.get === 'function' ? ctx.get('commands') : undefined
  if (commands === undefined || commands === null || typeof commands.register !== 'function') return null
  return commands.register({
    name: COMMAND_NAME,
    description: 'Manage factory projects: hand a git repository to the agent to add, or inspect objective signals',
    input: { hint: COMMAND_HINT },
    handler: (invocation) => handleFactoryCommand({ invocation, inspect }),
  })
}
