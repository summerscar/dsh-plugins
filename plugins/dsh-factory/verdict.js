/**
 * dsh-factory — structured review verdict (PRD §5.2/§5.3, P1).
 *
 * A verdict is EVIDENCE, not a state-machine gate. This module owns the three
 * facts the model must not decide for itself:
 *
 *  - `reviewedHead` is read from git on the backend. The agent never supplies
 *    it: a self-reported SHA would make the verdict say "approved" about a
 *    different checkout than the one actually reviewed.
 *  - the eight verdict fields are one closed shape; a partial verdict is
 *    refused rather than half-written.
 *  - idempotency is keyed by that backend-computed head (see store.js).
 *
 * No host package is imported. The git read is an injectable port so offline
 * tests can exercise the whole chain without a real worktree.
 */
import { execFileSync } from 'node:child_process'

export const VERDICT_SOURCES = Object.freeze(['review', 'rereview', 'pr-review'])
export const VERDICT_VALUES = Object.freeze(['approved', 'changes-requested', 'verification-incomplete'])

/** Full git SHA (sha1 = 40 hex, sha256 = 64 hex). Short ids are never accepted. */
export const FULL_SHA_RE = /^[0-9a-f]{40,64}$/i

export function isFullSha(value) {
  return typeof value === 'string' && FULL_SHA_RE.test(value.trim())
}

/**
 * Default git port: `git -C <worktreePath> rev-parse HEAD` in the review
 * worktree. HEAD is the COMMITTED tree only. A dirty worktree (uncommitted
 * edits) keeps the same reviewedHead — the verdict describes the last commit,
 * not an unsaved state. A reviewer that inspects uncommitted differences must
 * say so in `checks` / `blocking`; it must not smuggle them into the head.
 * Missing worktree / unreadable git / non-full SHA all fail closed.
 */
export function readHeadFromGit({ worktreePath } = {}) {
  if (typeof worktreePath !== 'string' || worktreePath.trim() === '') {
    throw new Error('无法计算 reviewedHead：卡片没有 worktreePath')
  }
  let raw
  try {
    raw = execFileSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`无法计算 reviewedHead：git -C ${worktreePath} rev-parse HEAD 失败（${detail}）`)
  }
  const sha = typeof raw === 'string' ? raw.trim() : ''
  if (!isFullSha(sha)) {
    throw new Error(`无法计算 reviewedHead：git 返回的不是完整 SHA（${sha || '空值'}）`)
  }
  return sha
}

/** Resolve the reviewed head through the injected port, never from model text. */
export function reviewedHeadFor({ worktreePath, readHead = readHeadFromGit } = {}) {
  if (typeof readHead !== 'function') throw new Error('无法计算 reviewedHead：未提供 git 读取端口')
  const sha = readHead({ worktreePath })
  if (!isFullSha(sha)) throw new Error('无法计算 reviewedHead：git 端口返回的不是完整 SHA')
  return sha.trim()
}

const requireString = (value, name) => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`结构化 verdict 缺少 ${name}`)
  return value
}
const requireArray = (value, name) => {
  if (!Array.isArray(value)) throw new Error(`结构化 verdict 的 ${name} 必须是数组`)
  return value
}

/**
 * Build the canonical, closed verdict object that is stored BOTH in history
 * and on the card mirror. Any supplied `reviewedHead` is ignored on purpose:
 * only the backend git read is authoritative (PRD §5.3).
 */
export function normalizeVerdict({
  cardId, source, verdict, blocking, followUps, checks, reviewerSessionId,
} = {}, { reviewedHead, reviewerSessionId: sessionId } = {}) {
  if (!isFullSha(reviewedHead)) throw new Error('结构化 verdict 缺少后端计算的完整 reviewedHead')
  if (!VERDICT_SOURCES.includes(source)) {
    throw new Error(`结构化 verdict 的 source 必须是 ${VERDICT_SOURCES.join(' / ')}`)
  }
  if (!VERDICT_VALUES.includes(verdict)) {
    throw new Error(`结构化 verdict 的 verdict 必须是 ${VERDICT_VALUES.join(' / ')}`)
  }
  const who = requireString(sessionId ?? reviewerSessionId, 'reviewerSessionId')
  const normalizedBlocking = requireArray(blocking, 'blocking').map((entry) => ({
    file: requireString(entry?.file, 'blocking.file'),
    line: Number.isInteger(entry?.line) ? entry.line : (() => { throw new Error('结构化 verdict 的 blocking.line 必须是整数') })(),
    reason: requireString(entry?.reason, 'blocking.reason'),
  }))
  const normalizedFollowUps = requireArray(followUps, 'followUps').map((entry) => ({
    text: requireString(entry?.text, 'followUps.text'),
  }))
  const normalizedChecks = requireArray(checks, 'checks').map((entry) => ({
    name: requireString(entry?.name, 'checks.name'),
    result: requireString(entry?.result, 'checks.result'),
    tests: typeof entry?.tests === 'string' ? entry.tests : '',
  }))
  return {
    cardId: requireString(cardId, 'cardId'),
    source,
    verdict,
    reviewedHead,
    blocking: normalizedBlocking,
    followUps: normalizedFollowUps,
    checks: normalizedChecks,
    reviewerSessionId: who,
  }
}
