/**
 * dsh-factory — project creation assistant: shared repo-root validation and
 * read-only repo inspection.
 *
 * Design rule (learned from a user correction, 2026-11-15): DO NOT enumerate
 * project types. A hardcoded list of lock files can never cover Python, Java,
 * Ruby, PHP, C#, Elixir, monorepos, CMake, Gradle… and the agent reading
 * `pom.xml` / `Cargo.toml` / `go.mod` knows far more than any list we could
 * ship. So inspection returns RAW FACTS (root file names, subdirectory names,
 * ignore-file contents, plus a few objective conveniences) and lets the agent
 * decide what the project is.
 *
 * Two hard rules still hold:
 *  - No command is ever returned, and no package manager is ever presented as
 *    the answer: the target repository's own AGENTS.md / CONTRIBUTING decide
 *    what to run.
 *  - Project creation is local and reversible; the human approval gates apply to
 *    commit / push / PR, not to registering a project.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { checkProjectRoot } from './worktree.js'

/**
 * Ignore files worth reading. These are FACTS the agent may need (which local
 * files a worktree is missing), not a project-type taxonomy.
 */
export const IGNORE_FILE_NAMES = Object.freeze([
  '.gitignore', '.dockerignore', '.npmignore', '.eslintignore', '.prettierignore',
])

/** How many root entries to report; enough to recognise a stack, bounded. */
export const MAX_ROOT_ENTRIES = 200

export function defaultInspectPort() {
  return {
    exists: (path) => existsSync(path),
    isDirectory: (path) => statSync(path).isDirectory(),
    readText: (path) => {
      try { return readFileSync(path, 'utf8') } catch { return null }
    },
    readDir: (path) => readdirSync(path, { withFileTypes: true })
      .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() })),
  }
}

function readJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  try { return JSON.parse(text) } catch { return null }
}

/** Non-comment, non-blank, non-negated entries of an ignore file. */
function ignoreEntries(text, limit = 50) {
  if (typeof text !== 'string') return []
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('!'))
    .slice(0, limit)
}

/**
 * Read-only repository inspection. Throws a clear error for an unusable path —
 * no guessing, no auto-correction, zero writes.
 *
 * @param {{ rootPath: string, fsPort?: object }} args
 */
export function assertRepoRoot(rootPath, fsPort = defaultInspectPort()) {
  // Registration and inspection share one judgement with the store's project-root
  // check: a git repo under the DSH data root is a valid project to register. It
  // is reported with a warning (never used as a session cwd, worktree forced out),
  // not rejected — otherwise the agent's `/factory add` cannot register repos that
  // legitimately live in the data root (user requirement, 2026-11-15).
  const check = checkProjectRoot(rootPath)
  if (!check.ok) throw new Error(check.error)
  const root = rootPath.trim()
  if (!fsPort.exists(root)) throw new Error(`rootPath 不存在：${root}`)
  if (!fsPort.isDirectory(root)) throw new Error(`rootPath 不是目录：${root}`)
  if (!fsPort.exists(join(root, '.git'))) throw new Error(`rootPath 不是 git 仓库（缺少 .git）：${root}`)
  return root
}

/**
 * Inspect a repository and return raw facts.
 *
 * The agent — not this function — decides what kind of project it is. We only
 * report what is literally on disk:
 *  - `rootFiles` / `rootDirectories`: the repository root listing
 *  - `ignoreFiles`: name → its entries, for every ignore file present
 *  - `packageManager`: the one field `package.json` declares, when it does
 *  - `manifestFiles`: which of the well-known manifests exist (a HINT list for
 *    the agent's attention, never a type judgement — anything not listed is
 *    still visible in `rootFiles`)
 */
export function inspectRepo({ rootPath, fsPort = defaultInspectPort() } = {}) {
  const root = assertRepoRoot(rootPath, fsPort)

  const entries = typeof fsPort.readDir === 'function' ? fsPort.readDir(root) : []
  const rootFiles = entries.filter((entry) => !entry.isDirectory).map((entry) => entry.name).slice(0, MAX_ROOT_ENTRIES)
  const rootDirectories = entries.filter((entry) => entry.isDirectory).map((entry) => entry.name).slice(0, MAX_ROOT_ENTRIES)

  const pkg = readJson(fsPort.readText(join(root, 'package.json')))
  const packageManager = typeof pkg?.packageManager === 'string' ? pkg.packageManager.trim() : ''

  const ignoreFiles = {}
  for (const name of IGNORE_FILE_NAMES) {
    const text = fsPort.readText(join(root, name))
    if (text !== null) ignoreFiles[name] = ignoreEntries(text)
  }

  // Pointers, not classification: these only save the agent a lookup, and the
  // full listing above remains authoritative for anything not named here.
  const manifestFiles = rootFiles.filter((name) => MANIFEST_HINTS.has(name)).sort()

  const notes = [
    'Read-only inspection: raw facts only, no recommended command, and nothing was created.',
    'Decide what this project is and what a new worktree needs from these files — and from the target repository\'s own AGENTS.md / CONTRIBUTING, which decides the setup command.',
  ]
  if (packageManager !== '') {
    notes.push(`package.json declares packageManager="${packageManager}".`)
  }
  if (Object.keys(ignoreFiles).length > 0) {
    notes.push(`Ignore file(s) present: ${Object.keys(ignoreFiles).join(', ')}. Their entries suggest which local files a worktree is missing.`)
  }
  if (rootFiles.length === 0 && rootDirectories.length === 0) {
    notes.push('The repository root listing came back empty; inspect the path directly before proposing a config.')
  }

  // A data-root repo is registrable, but the agent must see the constraint: it can
  // never be a session cwd and its worktree is forced outside the data root.
  const warning = checkProjectRoot(root).warning ?? null
  if (warning !== null) notes.push(warning)

  return { rootPath: root, warning, packageManager, rootFiles, rootDirectories, ignoreFiles, manifestFiles, notes }
}

/**
 * Well-known manifests, used only to flag "worth a look" in `manifestFiles`.
 * This is deliberately NOT a type map: it never says what a file implies, and
 * an unlisted manifest is still present in `rootFiles`.
 */
const MANIFEST_HINTS = new Set([
  // JS / TS
  'package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'tsconfig.json', 'turbo.json', 'nx.json', 'lerna.json',
  // Python
  'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile', 'poetry.lock', 'Pipfile.lock',
  // Go / Rust
  'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock',
  // JVM
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradlew',
  // Ruby / PHP / .NET / Elixir / C++
  'Gemfile', 'Gemfile.lock', 'composer.json', 'composer.lock', 'composer.phar',
  'global.json', 'Directory.Build.props',
  'mix.exs', 'mix.lock',
  'CMakeLists.txt', 'Makefile', 'meson.build',
  // Containers / docs
  'Dockerfile', 'docker-compose.yml', 'compose.yaml',
  'AGENTS.md', 'CONTRIBUTING.md', 'README.md',
])
