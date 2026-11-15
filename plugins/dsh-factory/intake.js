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
export async function intakeIssues({ store, projectId, boardId, repo, ghPort } = {}) {
  if (typeof repo !== 'string' || repo.trim() === '') throw new Error('intakeIssues 需要 repo')
  if (typeof boardId !== 'string' || boardId === '') throw new Error('intakeIssues 需要 boardId')
  const existing = projectId === undefined ? store.listCards({}) : store.listCards({ projectId })
  const existingKeys = new Set(existing.map((card) => card.source).filter((value) => typeof value === 'string'))
  const raw = await ghPort.listIssues(repo)
  const issues = parseIssueList(repo, raw)
  const fresh = selectNewIssues(issues, existingKeys)
  const created = []
  for (const issue of fresh) {
    const card = store.createCard({ boardId, title: issue.title, body: issue.body, source: issue.key, repo })
    created.push(card.id)
  }
  return { created, skipped: issues.length - fresh.length }
}

/** Real gh port: one `gh issue list --json` call per repo. */
export function createGhPort() {
  return {
    listIssues(repo) {
      const result = spawnSync('gh', [
        'issue', 'list', '--repo', repo, '--state', 'open', '--limit', '100',
        '--json', 'number,title,body,url,labels',
      ], { encoding: 'utf8', env: cleanGitEnv() })
      if (result.error) throw result.error
      if (result.status !== 0) throw new Error(`gh issue list 失败：${(result.stderr || '').trim()}`)
      return result.stdout
    },
  }
}
