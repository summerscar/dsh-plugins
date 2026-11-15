/**
 * dsh-factory — worktree preparation: copyFiles + postCreate.
 *
 * A freshly created git worktree contains only git-tracked files. Local,
 * gitignored files (`.env`, `node_modules`, …) are NOT there, so a project can
 * list relative paths to copy in and a shell command to run inside the worktree
 * after creation. Both are entirely user-configured: this module never names a
 * package manager or a specific filename.
 *
 * Everything is injectable (`fsPort`, `spawnPort`, `processEnv`) so the path
 * safety rules and the success / non-zero / timeout / spawn-failure outcomes
 * are unit-testable offline, with no host, no network and no real shell.
 */

import { spawnSync } from 'node:child_process'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'

import { cleanGitEnv } from './git-env.js'
import { isPathInside } from './worktree.js'

/** Default postCreate timeout: 5 minutes, overridable per project. */
export const DEFAULT_POST_CREATE_TIMEOUT_MS = 5 * 60 * 1000

/** Context variables exposed to postCreate through its environment. */
export const POST_CREATE_VARIABLES = Object.freeze([
  'worktree_path', 'worktree_name', 'branch_name', 'base_ref',
])

/**
 * Validate one configured copy path and return its normalised (slash-joined)
 * form. Rejects anything that could escape the project root or touch git
 * internals. An invalid CONFIGURATION is an error (the dispatch rolls back) —
 * unlike a missing source file, which is only a warning.
 */
export function assertSafeRelativePath(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('copyFiles 的每一项必须是非空字符串相对路径')
  }
  const value = raw.trim()
  if (value.includes('\0')) throw new Error(`copyFiles 路径含非法字符：${JSON.stringify(value)}`)
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new Error(`copyFiles 只接受相对路径：${JSON.stringify(value)}`)
  }
  const segments = value.split(/[\\/]+/)
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`copyFiles 路径含空段或 .. 逃逸：${JSON.stringify(value)}`)
  }
  if (segments.some((segment) => segment.toLowerCase() === '.git')) {
    throw new Error(`copyFiles 不允许拷贝 .git 目录：${JSON.stringify(value)}`)
  }
  return segments.join('/')
}

/** Normalise a project's copyFiles config into validated relative paths. */
export function normalizeCopyFiles(value, field = 'copyFiles') {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`${field} 必须是字符串数组`)
  return value.map((entry) => assertSafeRelativePath(entry))
}

/** Real filesystem port; keep the surface minimal so a fake can replace it. */
export function defaultFsPort() {
  return {
    lstat: (path) => lstatSync(path),
    isFile: (stat) => stat.isFile(),
    isSymbolicLink: (stat) => stat.isSymbolicLink(),
    mkdir: (path) => mkdirSync(path, { recursive: true }),
    realpath: (path) => realpathSync.native(path),
    exists: (path) => existsSync(path),
    copyFile: (source, target) => copyFileSync(source, target),
  }
}

/**
 * Copy configured files from the project root into the worktree.
 *
 * - an invalid path (absolute / `..` / `.git`) throws → dispatch rolls back
 * - a missing source, a symlink, or a non-regular file is skipped with a
 *   warning (`.env.local` is often legitimately absent)
 * - a target whose parent escapes the worktree via a symlink throws
 */
export function copyConfiguredFiles({ repoPath, worktreePath, files = [], fsPort = defaultFsPort() } = {}) {
  const copied = []
  const warnings = []
  const worktreeReal = fsPort.realpath(worktreePath)
  for (const raw of files) {
    const rel = assertSafeRelativePath(raw)
    const source = join(repoPath, rel)
    const target = join(worktreePath, rel)
    if (!isPathInside(worktreePath, target)) {
      throw new Error(`copyFiles 目标越出 worktree：${JSON.stringify(rel)}`)
    }
    let stat
    try {
      stat = fsPort.lstat(source)
    } catch {
      warnings.push(`${rel}: 源文件不存在，已跳过`)
      continue
    }
    if (fsPort.isSymbolicLink(stat)) {
      warnings.push(`${rel}: 符号链接，已跳过（不跟随，避免越出仓库）`)
      continue
    }
    if (!fsPort.isFile(stat)) {
      warnings.push(`${rel}: 不是普通文件，已跳过`)
      continue
    }
    const parent = dirname(target)
    fsPort.mkdir(parent)
    const parentReal = fsPort.realpath(parent)
    if (!isPathInside(worktreeReal, parentReal)) {
      throw new Error(`copyFiles 目标父目录经符号链接越出 worktree：${JSON.stringify(rel)}`)
    }
    const targetReal = join(parentReal, basename(target))
    if (fsPort.exists(targetReal)) {
      warnings.push(`${rel}: worktree 里已存在同名文件，保留不覆盖`)
      continue
    }
    fsPort.copyFile(source, targetReal)
    copied.push(rel)
  }
  return { copied, warnings }
}

/**
 * Real shell port. `postCreate` is a user-authored shell command run with
 * `shell: true` — the context values are passed as ENV VARS, never interpolated
 * into the command line, so a worktree path cannot inject shell syntax.
 */
export function defaultSpawnPort({ command, cwd, env, timeoutMs } = {}) {
  const result = spawnSync(command, {
    cwd, env, shell: true, encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
  })
  return {
    status: result.status,
    error: result.error ? { code: result.error.code, message: result.error.message } : null,
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  }
}

function brief(text, limit = 800) {
  const trimmed = String(text ?? '').trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed
}

/**
 * Run the project's postCreate command inside the worktree.
 * @returns {{ ran: boolean }}
 * @throws non-zero exit, timeout, or spawn failure — the caller rolls back.
 */
export function runPostCreate({
  worktreePath, command, variables = {}, timeoutMs = DEFAULT_POST_CREATE_TIMEOUT_MS,
  processEnv = process.env, spawnPort = defaultSpawnPort,
} = {}) {
  if (typeof command !== 'string' || command.trim() === '') return { ran: false }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('postCreateTimeoutMs 必须是正数')
  }
  const env = { ...cleanGitEnv(processEnv), ...variables }
  const result = spawnPort({ command, cwd: worktreePath, env, timeoutMs })
  if (result?.error?.code === 'ETIMEDOUT' || result?.signal === 'SIGTERM') {
    throw new Error(`postCreate 超时（${timeoutMs}ms），已终止`)
  }
  if (result?.error) throw new Error(`postCreate 启动失败：${brief(result.error.message)}`)
  if (result?.status !== 0) {
    throw new Error(`postCreate 执行失败（exit ${result.status}）：${brief(result.stderr)}`)
  }
  return { ran: true }
}

/** Whether a project has any preparation configured. */
export function hasPreparation(project) {
  if (project === undefined || project === null) return false
  const files = Array.isArray(project.copyFiles) ? project.copyFiles.length > 0 : false
  const command = typeof project.postCreate === 'string' && project.postCreate.trim() !== ''
  return files || command
}

/**
 * Order: copyFiles → postCreate. Both run BEFORE the session exists, so any
 * failure leaves nothing behind but the worktree (which the caller removes).
 */
export function prepareWorktree({
  project, worktreePath, branch, baseBranch = 'main',
  fsPort, spawnPort, processEnv,
} = {}) {
  if (project === undefined || project === null) throw new Error('prepareWorktree 需要 project')
  const copy = copyConfiguredFiles({
    repoPath: project.rootPath,
    worktreePath,
    files: project.copyFiles ?? [],
    ...(fsPort === undefined ? {} : { fsPort }),
  })
  const variables = {
    worktree_path: worktreePath,
    worktree_name: basename(worktreePath),
    branch_name: branch,
    base_ref: baseBranch,
  }
  const post = runPostCreate({
    worktreePath,
    command: project.postCreate ?? null,
    variables,
    timeoutMs: project.postCreateTimeoutMs ?? DEFAULT_POST_CREATE_TIMEOUT_MS,
    ...(spawnPort === undefined ? {} : { spawnPort }),
    ...(processEnv === undefined ? {} : { processEnv }),
  })
  return { copied: copy.copied, warnings: copy.warnings, postCreateRan: post.ran }
}
