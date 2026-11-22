/**
 * dsh-factory — authorized git execution (batch 2).
 *
 * AG-1 is structural here: **no git write happens without a human authorization
 * for that exact action.** `commitCard` requires the card to be in Review and a
 * pending `confirm-commit`; `createPrForCard` requires Review, a pending
 * `create-pr`, and an existing commit. Both throw *before* touching the git port
 * when the gate is not armed, so "unauthorized ⇒ 0 writes" is not a convention a
 * handler can forget — the only path to `port.add/commit/push/createPr` is past
 * the gate. That is what lets the orchestration be unit-tested with a fake port.
 *
 * The real port shells out to `git`/`gh`; it is a thin, separately verifiable
 * seam. Commits carry a generic identity so the plugin assumes nothing about the
 * target repository's git config.
 */
import { spawnSync } from 'node:child_process'

import { cleanGitEnv } from './git-env.js'
import { assertNoActiveSession } from './session-guard.js'

export async function commitCard({ store, cardId, port, message = 'factory: implement card', isSessionActive } = {}) {
  const card = store.getCard(cardId)
  if (card === undefined || card === null) throw new Error(`卡片不存在：${cardId}`)
  if (card.status !== 'review') throw new Error(`「确认提交」仅 Review 可执行（当前 ${card.status}）`)
  if (card.commitSha) throw new Error('该卡已提交，不能重复提交')
  assertNoActiveSession({ card, isSessionActive, action: '「确认提交」' })
  if (!store.hasPendingAuthorization(cardId, 'confirm-commit')) {
    throw new Error('缺少「确认提交」授权，拒绝执行 git 提交')
  }
  try {
    port.add(card.worktreePath)
    const sha = port.commit(card.worktreePath, message)
    store.recordCommit(cardId, { sha, message })
    return { sha }
  } catch (error) {
    try { port.reset(card.worktreePath) } catch { /* best effort unstage */ }
    throw error
  }
}

/**
 * P2b AC9: a SECOND commit for a card that already has a draft PR.
 * `commitCard` deliberately refuses an existing commitSha — do not loosen it.
 * This separate action keeps the same Review + human authorization gate but
 * records a new head on the same card/PR.
 */
export async function commitForExistingPr({ store, cardId, port, message = 'factory: address review feedback', isSessionActive } = {}) {
  const card = store.getCard(cardId)
  if (card === undefined || card === null) throw new Error(`卡片不存在：${cardId}`)
  if (card.status !== 'review') throw new Error(`回炉提交仅 Review 可执行（当前 ${card.status}）`)
  assertNoActiveSession({ card, isSessionActive, action: '回炉提交' })
  if (typeof card.prUrl !== 'string' || card.prUrl === '') throw new Error('该卡尚无 PR；请使用「确认提交」')
  if (!store.hasPendingAuthorization(cardId, 'confirm-commit')) {
    throw new Error('缺少「确认提交」授权，拒绝执行 git 提交')
  }
  try {
    port.add(card.worktreePath)
    const sha = port.commit(card.worktreePath, message)
    store.recordCommit(cardId, { sha, message })
    return { sha }
  } catch (error) {
    try { port.reset(card.worktreePath) } catch { /* best effort unstage */ }
    throw error
  }
}

/** Branches a PR job must never push to directly. */
export const DEFAULT_PROTECTED_BRANCHES = ['main', 'master', 'trunk', 'develop']

/** Whether a branch is a protected/default branch (case-insensitive). */
export function isProtectedBranch(branch, protectedBranches = DEFAULT_PROTECTED_BRANCHES) {
  const name = String(branch ?? '').toLowerCase()
  return protectedBranches.some((entry) => String(entry).toLowerCase() === name)
}

/**
 * Push the task branch and open a PR. Factory PRs are draft by default at every
 * autonomy level: the PR is the last human review gate before merge, so opening
 * it ready-for-review would skip that gate. Callers may still opt out explicitly.
 */
export async function createPrForCard({ store, cardId, port, title, body, protectedBranches = DEFAULT_PROTECTED_BRANCHES, draft = true, isSessionActive } = {}) {
  const card = store.getCard(cardId)
  if (card === undefined || card === null) throw new Error(`卡片不存在：${cardId}`)
  if (card.status !== 'review') throw new Error(`「推送分支并创建 PR」仅 Review 可执行（当前 ${card.status}）`)
  assertNoActiveSession({ card, isSessionActive, action: '「推送分支并创建 PR」' })
  if (!card.commitSha) throw new Error('请先「确认提交」再创建 PR')
  if (card.prUrl) throw new Error('该卡已有 PR')
  if (!store.hasPendingAuthorization(cardId, 'create-pr')) {
    throw new Error('缺少「推送分支并创建 PR」授权，拒绝 push / 开 PR')
  }
  // Pre-flight guards. Both run BEFORE any git write, so a misconfigured card can
  // never reach the remote: a card branched onto main/master is refused outright,
  // and an empty change (HEAD identical to base) is refused instead of opening a
  // garbage PR. The authorization stays armed so a fixed card can retry.
  if (isProtectedBranch(card.branch, protectedBranches)) {
    throw new Error(`拒绝向受保护分支「${card.branch}」推送；PR 只能来自特性分支，禁止直推 main/master/trunk/develop`)
  }
  if (card.baseBranch && String(card.branch).toLowerCase() === String(card.baseBranch).toLowerCase()) {
    throw new Error(`拒绝向 base 分支「${card.branch}」推送，请使用独立任务分支`)
  }
  if (typeof port.hasDiff === 'function') {
    const base = card.baseBranch || 'main'
    if (port.hasDiff(card.worktreePath, base) !== true) {
      throw new Error(`没有可交付的改动（HEAD 与 ${base} 无差异），拒绝创建 PR`)
    }
  }
  // No force push, ever. A push/PR failure leaves the card in Review with its
  // worktree intact so a human can inspect and retry.
  port.push(card.worktreePath, card.branch)
  const url = port.createPr(card.worktreePath, {
    title: title || card.title,
    body: body || card.body || '',
    branch: card.branch,
    draft: draft === true,
  })
  store.setPrUrl(cardId, url)
  return { url }
}

/**
 * P2b AC9: push a reworked head to the EXISTING draft PR. Never creates a PR,
 * never merges, never force-pushes, and never rewrites `prUrl`. The human
 * authorization is per-action (`push-existing`) and single-use.
 */
export async function pushExistingCard({ store, cardId, port, protectedBranches = DEFAULT_PROTECTED_BRANCHES, isSessionActive } = {}) {
  const card = store.getCard(cardId)
  if (card === undefined || card === null) throw new Error(`卡片不存在：${cardId}`)
  if (card.status !== 'review') throw new Error(`「推送更新草稿 PR」仅 Review 可执行（当前 ${card.status}）`)
  assertNoActiveSession({ card, isSessionActive, action: '「推送更新草稿 PR」' })
  if (typeof card.prUrl !== 'string' || card.prUrl === '') throw new Error('该卡尚无 PR，不能更新已有 PR')
  if (!card.commitSha) throw new Error('请先提交回炉改动再推送更新')
  if (!store.hasPendingAuthorization(cardId, 'push-existing')) {
    throw new Error('缺少「推送更新草稿 PR」授权，拒绝 push')
  }
  if (isProtectedBranch(card.branch, protectedBranches)) {
    throw new Error(`拒绝向受保护分支「${card.branch}」推送；PR 只能来自特性分支`)
  }
  if (card.baseBranch && String(card.branch).toLowerCase() === String(card.baseBranch).toLowerCase()) {
    throw new Error(`拒绝向 base 分支「${card.branch}」推送，请使用独立任务分支`)
  }
  if (typeof port.hasDiff === 'function') {
    const base = card.baseBranch || 'main'
    if (port.hasDiff(card.worktreePath, base) !== true) {
      throw new Error(`没有可推送的改动（HEAD 与 ${base} 无差异），拒绝 push`)
    }
  }
  // No force push, ever. A failure leaves Review + worktree intact for retry.
  port.push(card.worktreePath, card.branch)
  store.recordPushUpdate(cardId, { prUrl: card.prUrl, sha: card.commitSha })
  return { url: card.prUrl, sha: card.commitSha }
}

/**
 * Decide the child environment for git/gh. Pure, so the branching is unit-tested;
 * the caller supplies whether `gh` has a live login (probed separately).
 *
 * Why this exists: the host may export a `GITHUB_TOKEN` (often a fine-grained PAT)
 * that shadows `gh`'s own OAuth login — git's credential helper (`!gh auth
 * git-credential`) reads the logged-in token, but an inherited `GITHUB_TOKEN`
 * (and `GH_TOKEN`, which outranks it) wins, so a low-scope PAT makes push fail
 * with 403 even though `gh auth` is fine (live-e2e bug). But blindly deleting the
 * token breaks CI, where `GITHUB_TOKEN` is the ONLY credential and there is no
 * `gh` login. So the decision is explicit, in priority order:
 *
 *   1. explicit DSH credential token  → `GH_TOKEN = token`, drop inherited GITHUB_TOKEN
 *   2. `gh` is logged in (no explicit)→ drop GITHUB_TOKEN and GH_TOKEN, let gh use its login
 *   3. neither                        → keep any inherited token as the only fallback
 *
 * `processEnv` is never mutated.
 *
 * @param {Record<string,string|undefined>} [processEnv]
 * @param {{ credentialToken?: string, ghLoggedIn?: boolean }} [options]
 */
export function buildGitEnv(processEnv = process.env, { credentialToken, ghLoggedIn = false } = {}) {
  // A hook/CI parent may export GIT_DIR / GIT_INDEX_FILE etc.; those override
  // `-C` and would redirect every child git call to the committing repository.
  const env = cleanGitEnv(processEnv)
  if (typeof credentialToken === 'string' && credentialToken !== '') {
    delete env.GITHUB_TOKEN
    env.GH_TOKEN = credentialToken
    return env
  }
  if (ghLoggedIn) {
    delete env.GITHUB_TOKEN
    delete env.GH_TOKEN
    return env
  }
  // Neither an explicit token nor a gh login: the inherited token is all we have.
  return env
}

/**
 * Probe whether `gh` has a REAL login (`hosts.yml`), not just an env token.
 *
 * `gh auth status` validates an env `GH_TOKEN`/`GITHUB_TOKEN` and exits 0 for a
 * *valid* token even with no hosts.yml — so a pure-CI box (only GITHUB_TOKEN, no
 * `gh` login) would look "logged in". We must strip those tokens from the probe
 * env so the result reflects only a genuine `gh` login; otherwise the caller
 * would take the "gh is logged in" branch and delete the CI's only credential.
 * Exposes `processEnv` so the decision is unit-testable.
 */
export function probeEnv(processEnv = process.env) {
  const probeEnvOut = cleanGitEnv(processEnv)
  delete probeEnvOut.GH_TOKEN
  delete probeEnvOut.GITHUB_TOKEN
  return probeEnvOut
}

export function probeGhLogin(processEnv = process.env) {
  const probeEnvOut = probeEnv(processEnv)
  try {
    return spawnSync('gh', ['auth', 'status'], { encoding: 'utf8', env: probeEnvOut }).status === 0
  } catch {
    return false
  }
}

/**
 * One-shot, read-only GitHub binding detected when a project is CREATED.
 * The engine never guesses a repo at runtime; after creation only an explicit
 * user PATCH may change it. No network, no identity change, no permission probe.
 */
export const BIND_REASON = {
  NO_ORIGIN: 'no-origin',
  NOT_GITHUB: 'not-github',
  NOT_GIT: 'not-git-repo',
  AMBIGUOUS: 'ambiguous-origin',
  INVALID_URL: 'invalid-origin-url',
}

/** Accept only GitHub's `owner/repo` shape (the form stored in issueRepo). */
export function normalizeGithubRepo(value) {
  if (typeof value !== 'string') return null
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value.trim())
  if (match === null) return null
  const [, owner, repo] = match
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null
  return `${owner}/${repo}`
}

function parseGithubRemoteUrl(raw) {
  const url = String(raw || '').trim()
  // HTTPS (with an optional user@) and SSH/scp-like forms, github.com only.
  const match = /^(?:https?:\/\/)(?:[^/@\s]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url)
    || /^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url)
  return match === null ? null : normalizeGithubRepo(`${match[1]}/${match[2]}`)
}

/**
 * @returns {{issueRepo: string|null, reason: string|null}} reason is a BIND_REASON
 *   code when nothing was detected; it is null on success. Never throws.
 */
export function detectGithubRepo(rootPath, exec = spawnSync) {
  const root = typeof rootPath === 'string' ? rootPath.trim() : ''
  const failed = (reason) => ({ issueRepo: null, reason })
  if (root === '') return failed(BIND_REASON.NOT_GIT)
  const run = (args) => exec('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 })
  let inside
  try { inside = run(['rev-parse', '--is-inside-work-tree']) } catch { return failed(BIND_REASON.NOT_GIT) }
  if (!inside || inside.status !== 0 || String(inside.stdout || '').trim() !== 'true') return failed(BIND_REASON.NOT_GIT)

  let remote
  try { remote = run(['remote', 'get-url', '--all', 'origin']) } catch { return failed(BIND_REASON.NO_ORIGIN) }
  if (!remote || remote.status !== 0) return failed(BIND_REASON.NO_ORIGIN)
  const urls = String(remote.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (urls.length !== 1) return failed(BIND_REASON.AMBIGUOUS)
  const repo = parseGithubRemoteUrl(urls[0])
  if (repo !== null) return { issueRepo: repo, reason: null }
  return failed(/github\.com/i.test(urls[0]) ? BIND_REASON.INVALID_URL : BIND_REASON.NOT_GITHUB)
}

/** Real git/gh port. Commits use a neutral identity; nothing assumes the repo. */
export function createGitPort({ credentialToken, ghLoggedIn } = {}) {
  const loggedIn = typeof ghLoggedIn === 'boolean' ? ghLoggedIn : probeGhLogin()
  const env = buildGitEnv(process.env, { credentialToken, ghLoggedIn: loggedIn })
  const run = (command, args, cwd) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', env })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 失败：${(result.stderr || '').trim()}`)
    return (result.stdout || '').trim()
  }
  return {
    add(cwd) { run('git', ['add', '-A'], cwd) },
    commit(cwd, message) {
      run('git', ['-c', 'user.email=factory@localhost', '-c', 'user.name=dsh-factory', 'commit', '-m', message], cwd)
      return run('git', ['rev-parse', 'HEAD'], cwd)
    },
    reset(cwd) { run('git', ['reset'], cwd) },
    /** True when the worktree HEAD has commits beyond `base` (a real change). */
    hasDiff(cwd, base) {
      const count = Number.parseInt(run('git', ['rev-list', '--count', `${base}..HEAD`], cwd), 10)
      return Number.isFinite(count) && count > 0
    },
    /**
     * True only when the worktree has NO uncommitted changes. hasDiff() above
     * counts commits vs a base ref; it is NOT a dirty-tree check. Auto-delivery
     * uses this to refuse unpublished (unreviewed) edits.
     */
    isWorktreeClean(cwd) {
      return run('git', ['status', '--porcelain'], cwd) === ''
    },
    /**
     * True only when cwd exists AND is a git work tree. Auto-delivery checks
     * this BEFORE readHead / isWorktreeClean shell out: a cleaned-up worktree
     * otherwise surfaces as a meaningless `spawnSync git ENOENT` instead of a
     * readable "worktree 已失效，需重新派发" message.
     */
    worktreeExists(cwd) {
      if (typeof cwd !== 'string' || cwd.trim() === '') return false
      try {
        return run('git', ['rev-parse', '--is-inside-work-tree'], cwd) === 'true'
      } catch { return false }
    },
    // git itself has no gh credential helper unless the profile configured one;
    // pass it explicitly so buildGitEnv's gh-login path actually authenticates.
    push(cwd, branch) {
      run('git', ['-c', 'credential.helper=!gh auth git-credential', 'push', '-u', 'origin', branch], cwd)
    },
    createPr(cwd, { title, body, branch, draft = true }) {
      return run('gh', ['pr', 'create', '--title', title, '--body', body, '--head', branch, ...(draft ? ['--draft'] : [])], cwd)
    },
  }
}
