/**
 * dsh-factory — GitHub issue intake (batch 3, PRD §9 intake chain start).
 *
 * Pulls open issues for a repository through the `gh` CLI (so it reuses the
 * user's existing `gh auth`, or a token injected as GH_TOKEN), normalises them,
 * and turns each not-yet-seen issue into an Inbox card. Deduplication is by a
 * stable source key (`issue:<repo>#<number>`), so polling never creates a
 * duplicate card for the same issue.
 *
 * The whole thing is transport-agnostic: the `gh` call is an injectable port, so
 * the parse / dedupe / create orchestration is unit-tested with no host and no
 * network. No OAuth, no webhook — polling only, by design (PRD §17-F).
 */
import { spawnSync } from 'node:child_process'

import { cleanGitEnv } from './git-env.js'
import { buildGitEnv } from './git-exec.js'

/** Stable identity for an issue, used both as the card source and the dedupe key. */
export function issueSourceKey(repo, issue) {
  return `issue:${repo}#${Number(issue?.number)}`
}

/** Normalise one `gh issue list --json` entry into an intake record. */
export function normalizeIssue(repo, issue) {
  const number = Number(issue?.number)
  if (!Number.isInteger(number) || number <= 0) return null
  return {
    key: issueSourceKey(repo, { number }),
    number,
    repo,
    title: String(issue?.title ?? '').trim(),
    body: String(issue?.body ?? ''),
    url: typeof issue?.url === 'string' ? issue.url : null,
    labels: Array.isArray(issue?.labels) ? issue.labels.map((label) => (typeof label === 'string' ? label : label?.name)).filter(Boolean) : [],
  }
}

/** Parse `gh issue list --json ...` output (array, or its JSON string) into records. */
export function parseIssueList(repo, output) {
  let list = output
  if (typeof output === 'string') {
    const text = output.trim()
    if (text === '') return []
    list = JSON.parse(text)
  }
  if (!Array.isArray(list)) throw new Error('gh issue list 输出不是数组')
  return list.map((issue) => normalizeIssue(repo, issue)).filter((entry) => entry !== null)
}

/** The issues whose source key is not already present among existing cards. */
export function selectNewIssues(issues, existingSourceKeys) {
  const seen = existingSourceKeys instanceof Set ? existingSourceKeys : new Set(existingSourceKeys)
  return issues.filter((issue) => !seen.has(issue.key))
}

/**
 * Poll one repo and turn new issues into Inbox cards.
 * @returns {{ created: string[], skipped: number }}
 */
export async function intakeIssues({ store, projectId, boardId, repo, ghPort, origin, limit } = {}) {
  if (typeof repo !== 'string' || repo.trim() === '') throw new Error('intakeIssues 需要 repo')
  if (typeof boardId !== 'string' || boardId === '') throw new Error('intakeIssues 需要 boardId')
  const existing = projectId === undefined ? store.listCards({}) : store.listCards({ projectId })
  const existingKeys = new Set(existing.map((card) => card.source).filter((value) => typeof value === 'string'))
  // The card records TWO separate things: `repo` is the remote GitHub identifier
  // (used for display / provenance), `repoPath` is the local filesystem path the
  // session actually works in. Keep them distinct (ROADMAP §5). A global intake
  // (no projectId) has no local root here, so repoPath stays empty and
  // session-context falls back to the project -- never a fabricated path.
  const project = projectId === undefined ? undefined : store.getProject(projectId)
  const repoPath = typeof project?.rootPath === 'string' && project.rootPath !== '' ? project.rootPath : undefined
  // `limit` bounds how many issues one poll asks for (the port default stays 100).
  // Without it, pointing at a busy upstream floods the board with up to 100 cards
  // in one tick, each of which the engine then dispatches as a real session.
  const raw = await ghPort.listIssues(repo, limit === undefined ? {} : { limit })
  const issues = parseIssueList(repo, raw)
  const fresh = selectNewIssues(issues, existingKeys)
  const created = []
  for (const issue of fresh) {
    // `origin` is supplied by the engine so auto-discovered cards are auditable;
    // a person calling the HTTP intake route passes none (defaults to `system`).
    const card = store.createCard({ boardId, title: issue.title, body: issue.body, source: issue.key, repo, ...(repoPath === undefined ? {} : { repoPath }), origin })
    created.push(card.id)
  }
  return { created, skipped: issues.length - fresh.length }
}

/**
 * Real gh port: one `gh issue list --json` call per repo. `limit` defaults to 100.
 *
 * The child env now goes through the SAME `buildGitEnv` the push port uses, fed by
 * the decision layer's winner (`credentialToken` / `ghLoggedIn`). That closes the
 * old split where intake used bare `cleanGitEnv()` while push used `buildGitEnv`
 * (PRD pitfall ① / PGH-9: one decision, one env construction, both chains).
 * With no arguments it is behaviourally identical to bare cleanGitEnv — the
 * inherited env is preserved — so existing callers and tests stay green.
 */
export function createGhPort({ limit = 100, credentialToken, ghLoggedIn } = {}) {
  // buildGitEnv(process.env, {}) === cleanGitEnv(process.env) with no winner,
  // so the default path is unchanged for callers that pass no identity.
  const env = buildGitEnv(process.env, { credentialToken, ghLoggedIn })
  return {
    listIssues(repo, options = {}) {
      const effective = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : limit
      const result = spawnSync('gh', [
        'issue', 'list', '--repo', repo, '--state', 'open', '--limit', String(effective),
        '--json', 'number,title,body,url,labels',
      ], { encoding: 'utf8', env })
      if (result.error) throw result.error
      if (result.status !== 0) throw new Error(`gh issue list 失败：${(result.stderr || '').trim()}`)
      return result.stdout
    },
    /** V4 merge→done poll: state of the card's ACTIVE PR only. */
    prState({ prUrl } = {}) {
      if (typeof prUrl !== 'string' || prUrl.trim() === '') throw new Error('缺少 PR URL，无法读取远端状态')
      const result = spawnSync('gh', ['pr', 'view', prUrl.trim(), '--json', 'state'], { encoding: 'utf8', env })
      if (result.error) throw result.error
      if (result.status !== 0) throw new Error(`gh pr view 失败：${(result.stderr || '').trim()}`)
      const parsed = JSON.parse(result.stdout || '{}')
      const state = typeof parsed.state === 'string' ? parsed.state.toUpperCase() : ''
      if (!['OPEN', 'CLOSED', 'MERGED'].includes(state)) throw new Error(`无法识别 PR 状态：${parsed.state}`)
      return state
    },
    /** Close a PR that was opened then invalidated by HEAD drift. */
    closePr({ prUrl, reason } = {}) {
      if (typeof prUrl !== 'string' || prUrl.trim() === '') throw new Error('缺少 PR URL，无法关闭误开 PR')
      spawnSync('gh', ['pr', 'close', prUrl.trim(), '--comment', typeof reason === 'string' ? reason : 'closed by dsh-factory: approved head drifted'], { encoding: 'utf8', env })
      return true
    },
  }
}
