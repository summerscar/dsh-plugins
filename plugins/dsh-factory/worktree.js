/**
 * dsh-factory — worktree isolation helpers (PRD §9.2, B2/B4).
 *
 * Per Research's verification, DSH's native worktree service only accepts a
 * *relative* `directory` and defaults to `<repo>/.agents/worktrees` — it cannot
 * give a centralised absolute root, and for repos living under the data root it
 * would land the worktree inside the data root. So we run `git worktree add`
 * ourselves, exactly like kanban's `createTaskWorktree`.
 *
 * The path/containment checks are pure and unit-tested; the create/remove
 * functions shell out to the real `git`, and `test/worktree.test.mjs` exercises
 * them against a throw-away repository so the git invocation is proven to run.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { cleanGitEnv } from './git-env.js'

/**
 * Expand a leading `~` / `~/` / `~\` against the OS home directory. Uses
 * `homedir()` rather than `process.env.HOME`: Windows does not define `HOME`
 * (it uses `USERPROFILE`), so reading the variable yields `undefined`,
 * `join('', …)` degrades to a relative path and `resolve()` then anchors it to
 * the process cwd — which in a packaged desktop profile points at a directory
 * that holds no user data.
 */
export function expandHome(value) {
  if (typeof value !== 'string') return value
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * DSH data root: a project may be registered inside it, but a worktree must
 * never be created there (PRD §7/§9.2).
 *
 * Precedence mirrors the host's own `resolveDshHome` in
 * `@deepseek-ai/dsh-home-paths` (explicit config → `$DSH_HOME` → `~/.dsh`), so
 * this plugin follows the host layout. That package is deliberately NOT imported:
 * it is a host peer, resolvable only when the loader injects it, and a path
 * helper is not worth another failure mode. A blank or whitespace-only value is
 * treated as unset so the root can never collapse onto the cwd.
 *
 * Note: with `DSH_HOME` unset the root is `~/.dsh`, the host default — not any
 * machine-specific directory this plugin used to assume.
 *
 * Resolved on every call, never captured at module load, so the answer reflects
 * the environment at the moment of the check.
 */
export function resolveDataRoot(env = process.env) {
  const raw = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return resolve(raw !== '' ? expandHome(raw) : join(homedir(), '.dsh'))
}

/**
 * Centralised worktree root, per project + card, deliberately outside the data
 * root. `DSH_FACTORY_WORKTREE_ROOT` overrides it; the neutral default is a temp
 * directory so no host-private absolute path ships with the plugin. Also resolved
 * per call rather than at module load.
 */
export function defaultWorktreeRoot(env = process.env) {
  const raw = typeof env?.DSH_FACTORY_WORKTREE_ROOT === 'string' ? env.DSH_FACTORY_WORKTREE_ROOT.trim() : ''
  return resolve(raw !== '' ? expandHome(raw) : join(tmpdir(), 'dsh-factory-worktrees'))
}

/** True when `child` is `parent` itself or lives beneath it (separator-safe). */
export function isPathInside(parent, child) {
  const base = resolve(parent)
  const target = resolve(child)
  const rel = relative(base, target)
  if (rel === '') return true
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export function isInsideDataRoot(target) {
  return isPathInside(resolveDataRoot(), target)
}

export function worktreeRootOf(project) {
  const root = project?.worktreeRoot
  return resolve(typeof root === 'string' && root.trim() !== '' ? root : defaultWorktreeRoot())
}

/** Throw unless the worktree root is an absolute path outside the data root. */
export function assertWorktreeRoot(root) {
  if (typeof root !== 'string' || root.trim() === '' || !isAbsolute(root)) {
    throw new Error('worktreeRoot 必须是绝对路径')
  }
  if (isInsideDataRoot(root)) {
    throw new Error(`worktreeRoot 不得位于数据根 ${resolveDataRoot()} 内`)
  }
  return resolve(root)
}

/**
 * A project root may legitimately sit under the data root (that is where some of
 * the user's repos live), but using it as a session cwd is not allowed, and its
 * worktree is forced outside. So this reports a *warning*, not a hard failure
 * (PRD E4: "被拒绝/告警").
 */
export function checkProjectRoot(rootPath) {
  const root = typeof rootPath === 'string' ? rootPath.trim() : rootPath
  if (typeof root !== 'string' || root === '' || !isAbsolute(root)) {
    return { ok: false, error: '项目根必须是绝对路径' }
  }
  if (isInsideDataRoot(root)) {
    return {
      ok: true,
      warning: `项目根位于数据根 ${resolveDataRoot()} 内：会话 cwd 不得使用它，worktree 强制外置（PRD E4）`,
    }
  }
  return { ok: true }
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/

/**
 * `<worktreeRoot>/<projectId>/<cardId>` — per project, per card. Refuses path
 * segments that could escape the root and refuses a result inside the data root.
 */
export function worktreePathFor(project, cardId) {
  const root = assertWorktreeRoot(worktreeRootOf(project))
  const projectId = String(project?.id ?? '')
  const card = String(cardId ?? '')
  if (!SAFE_SEGMENT.test(projectId)) throw new Error(`projectId 含非法字符：${projectId}`)
  if (!SAFE_SEGMENT.test(card)) throw new Error(`cardId 含非法字符：${card}`)
  const path = join(root, projectId, card)
  if (isInsideDataRoot(path)) throw new Error('worktree 路径落入数据根')
  return path
}

/**
 * Git environment with the repository-location variables removed. Delegates to
 * the shared helper so worktree.js, git-exec.js and intake.js all strip the same
 * set — a hook/CI parent exporting GIT_DIR or GIT_INDEX_FILE would otherwise
 * override `-C` and silently target the committing repository instead of the
 * card's worktree.
 */
export const gitEnv = cleanGitEnv

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: cleanGitEnv() })
  if (result.error) throw result.error
  return result
}

/** Porcelain status lines for a worktree (empty array = clean). */
export function worktreeStatus(dir) {
  const result = git(dir, ['status', '--porcelain'])
  if (result.status !== 0) {
    throw new Error(`git status 失败（${dir}）：${(result.stderr || '').trim()}`)
  }
  return result.stdout.split('\n').map((line) => line.trimEnd()).filter(Boolean)
}

/** True when a local branch of this name exists. */
function branchExists(repoPath, branch) {
  const result = git(repoPath, ['branch', '--list', branch])
  return result.status === 0 && result.stdout.trim() !== ''
}

/** Best-effort delete of one local branch (a no-op when it does not exist). */
function clearBranch(repoPath, branch) {
  if (!branchExists(repoPath, branch)) return
  git(repoPath, ['branch', '-D', branch])
}

/**
 * Create a per-card worktree off `baseBranch`. `fetch` is opt-in: a first run
 * with no `origin` would fail a mandatory fetch, so the caller decides.
 */
export function createWorktree({ repoPath, worktreePath, branch, baseBranch = 'main', fetch = false }) {
  if (!isAbsolute(repoPath)) throw new Error('repoPath 必须是绝对路径')
  if (!isAbsolute(worktreePath)) throw new Error('worktreePath 必须是绝对路径')
  if (isInsideDataRoot(worktreePath)) throw new Error('worktree 路径不得位于数据根内')
  if (fetch) {
    const fetched = git(repoPath, ['fetch', 'origin', baseBranch])
    if (fetched.status !== 0) throw new Error(`git fetch 失败：${(fetched.stderr || '').trim()}`)
  }
  // A previous failed dispatch can leave the `-b` branch behind after its worktree
  // was removed; `worktree add -b` would then fail with "a branch named … already
  // exists" and every retry deadlocks (bug found in live e2e). Clear it first.
  clearBranch(repoPath, branch)
  const added = git(repoPath, ['worktree', 'add', '-b', branch, worktreePath, baseBranch])
  if (added.status !== 0) {
    // A failed add can still register the branch; clear it so a retry starts clean.
    clearBranch(repoPath, branch)
    throw new Error(`git worktree add 失败：${(added.stderr || '').trim()}`)
  }
  return { worktreePath, branch }
}

/**
 * Remove a worktree. A dirty working tree is refused unless `force` is set, and
 * the refusal carries the change list so the caller can show it (B4: never
 * silently discard a user's uncommitted work).
 */
export function removeWorktree({ repoPath, worktreePath, force = false, branch }) {
  if (!isAbsolute(repoPath) || !isAbsolute(worktreePath)) throw new Error('路径必须是绝对路径')
  const changes = existsSync(worktreePath) ? worktreeStatus(worktreePath) : []
  if (changes.length > 0 && !force) {
    const error = new Error(`工作区有未提交改动，拒绝强删；请先处理：\n${changes.join('\n')}`)
    error.changes = changes
    throw error
  }
  const removed = git(repoPath, ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath])
  if (removed.status !== 0) throw new Error(`git worktree remove 失败：${(removed.stderr || '').trim()}`)
  // Remove the card's branch too (after the worktree is gone, so it is no longer
  // checked out). Without this a failed dispatch leaves an orphan branch and the
  // next attempt deadlocks on "branch already exists" (live-e2e bug).
  if (typeof branch === 'string' && branch !== '') clearBranch(repoPath, branch)
  return { removed: worktreePath }
}
