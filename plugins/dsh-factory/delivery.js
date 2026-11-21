/**
 * dsh-factory — L4 auto-delivery arm + execution (PRD §5.11, AC37-41).
 *
 * The ONLY authority to write git here is: project tier === auto-delivery AND
 * the code gate below passes. Skills, reports, tool arguments and HTTP callers
 * cannot arm delivery — this module is not exposed as a tool or a route; only
 * the autonomy engine calls it with a previously armed token.
 *
 * Authorization boundary (user-approved 2026-11-20): commit / push / open a
 * DRAFT PR by head, nothing else. No merge, no mark-done, no other tier, no
 * other work mode. Every decision is audited with tier='auto-delivery'.
 */
import { reviewedHeadFor, isFullSha } from './verdict.js'
import { AUTO_DELIVERY_TIER, RULE_DELIVER } from './autonomy.js'
import { DEFAULT_PROTECTED_BRANCHES, isProtectedBranch } from './git-exec.js'
import { STATUS } from './state.js'

export { AUTO_DELIVERY_TIER, RULE_DELIVER }

const audit = (store, cardId, decision, note, extra = {}) => {
  try {
    store.recordEvent({
      type: 'auto-delivery', scope: 'card', targetId: cardId,
      actor: AUTO_DELIVERY_TIER, tier: AUTO_DELIVERY_TIER,
      rule: RULE_DELIVER, channel: 'poll', decision, note, ...extra,
    })
  } catch { /* audit must never abort delivery */ }
}

/**
 * The seven hard conditions, evaluated in one place. Returns { ok, reason, head }
 * or a readable refusal. `readHead` and `resolveIdentity` are injected so the
 * whole chain is offline-testable without git/gh/remote access.
 */
export async function evaluateAutoDelivery({ store, cardId, readHead, resolveIdentity, protectedBranches = DEFAULT_PROTECTED_BRANCHES } = {}) {
  const card = store.getCard(cardId)
  if (card === undefined || card === null) return { ok: false, reason: `卡片不存在：${cardId}` }
  const project = store.getProject(card.projectId)
  if (project === undefined || project === null) return { ok: false, reason: `项目不存在：${card.projectId}` }
  // Condition: tier, pause/takeover, phase.
  if (project.autonomy !== AUTO_DELIVERY_TIER) {
    return { ok: false, reason: `档位不是 auto-delivery（当前 ${project.autonomy}）；禁止自动交付` }
  }
  if (project.paused === true) return { ok: false, reason: '项目已暂停，禁止新的自动交付' }
  if (card.takenOver === true) return { ok: false, reason: '卡片已被人接管，禁止自动交付' }
  if (card.needsHumanInfo === true) return { ok: false, reason: '卡片待补充信息，禁止自动交付' }
  if (card.status !== STATUS.REVIEW) {
    return { ok: false, reason: `自动交付仅用于 Review 卡片（当前 ${card.status}）` }
  }
  // Condition: approved verdict from the REGISTERED reviewer, correct head.
  const verdict = card.reviewVerdict
  if (verdict === undefined || verdict === null) return { ok: false, reason: '没有评审结论，禁止自动交付' }
  if (verdict.verdict !== 'approved') {
    return { ok: false, reason: `评审结论不是 approved（${verdict.verdict}），禁止写入 git` }
  }
  if (Array.isArray(verdict.blocking) && verdict.blocking.length > 0) {
    return { ok: false, reason: '存在阻断项，禁止写入 git' }
  }
  // P2a already forbids a non-reviewer from writing a verdict in the tool; this
  // is the SECOND line of defence if the mirror was corrupted internally.
  if (typeof card.reviewSessionId !== 'string' || card.reviewSessionId === ''
    || verdict.reviewerSessionId !== card.reviewSessionId) {
    return { ok: false, reason: 'verdict 不是本卡登记的评审会话产出，禁止自动交付' }
  }
  let head
  try {
    head = reviewedHeadFor({ worktreePath: card.worktreePath, readHead })
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  if (head !== verdict.reviewedHead) {
    return { ok: false, reason: `评审 head 与当前 worktree HEAD 不一致（${verdict.reviewedHead} ≠ ${head}），禁止交付` }
  }
  // Per-head idempotency: success is final for that head; a FAILED head may be
  // retried (PRD: failure is readable and retryable).
  if (card.autoDelivery?.head === head && card.autoDelivery?.state === 'delivered') {
    return { ok: false, reason: `head ${head} 已交付，重复 tick 不重复写入`, head, alreadyDelivered: true }
  }
  // Condition: branch safety.
  if (isProtectedBranch(card.branch, protectedBranches)) {
    return { ok: false, reason: `拒绝向受保护分支「${card.branch}」自动交付`, head }
  }
  if (card.baseBranch && String(card.branch).toLowerCase() === String(card.baseBranch).toLowerCase()) {
    return { ok: false, reason: `拒绝向 base 分支「${card.branch}」自动交付`, head }
  }
  // Condition: credentials / binding. resolveIdentity failing means fail closed.
  try {
    if (typeof resolveIdentity !== 'function') throw new Error('未提供仓库身份解析器')
    const identity = await resolveIdentity(project)
    if (identity === undefined || identity === null || identity.git === undefined || identity.git === null) {
      throw new Error('仓库凭证或绑定不可用')
    }
  } catch (error) {
    return { ok: false, reason: `凭证检查失败：${error instanceof Error ? error.message : String(error)}`, head }
  }
  return { ok: true, head, cardId }
}

/**
 * Arm a SINGLE delivery for one head. The returned token carries no standing
 * permission: executeAutoDelivery re-checks it against the live card/head.
 */
export async function armAutoDelivery({ store, cardId, readHead, resolveIdentity } = {}) {
  const result = await evaluateAutoDelivery({ store, cardId, readHead, resolveIdentity })
  if (result.ok !== true) {
    audit(store, cardId, 'refused', result.reason)
    return result
  }
  const token = { cardId, head: result.head, actor: AUTO_DELIVERY_TIER, rule: RULE_DELIVER }
  store.setAutoDelivery(cardId, { head: result.head, state: 'armed', actor: AUTO_DELIVERY_TIER })
  audit(store, cardId, 'armed', `head ${result.head}`, { head: result.head })
  return { ...result, token }
}

/**
 * Execute an armed delivery. Deliberately takes only the arm token plus ports;
 * there is no public route to supply either. Failure leaves the card in Review
 * with state='failed' and ZERO git writes unless a step already succeeded.
 */
export async function executeAutoDelivery({ store, token, port, readHead, resolveIdentity } = {}) {
  if (token === undefined || token === null || token.actor !== AUTO_DELIVERY_TIER || typeof token.head !== 'string') {
    throw new Error('自动交付缺少专用 arm 令牌；拒绝执行')
  }
  const cardId = token.cardId
  const recheck = await evaluateAutoDelivery({ store, cardId, readHead, resolveIdentity })
  if (recheck.ok !== true || recheck.head !== token.head) {
    throw new Error(`arm 失效，拒绝交付：${recheck.reason ?? 'head 不一致'}`)
  }
  const card = store.getCard(cardId)
  // P3 head fix: the tree the reviewer approved is the tree we may deliver.
  // 1) A matching commitSha means it was committed and reviewed — skip commit.
  // 2) A clean worktree at the same HEAD means the reviewed tree IS HEAD —
  //    skip commit too; pushing that branch delivers exactly the reviewed tree.
  // 3) Uncommitted changes were never reviewed — refuse with zero git writes.
  // Only injected legacy ports (offline fakes without isWorktreeClean) keep the
  // old commit path with the sha drift check, so existing fixture tests remain
  // meaningful; the REAL git port always provides the clean check.
  if (card.commitSha !== token.head) {
    if (typeof port.isWorktreeClean === 'function') {
      if (port.isWorktreeClean(card.worktreePath) !== true) {
        throw new Error('工作树存在未提交改动；这些改动未经评审，拒绝自动交付')
      }
      audit(store, cardId, 'commit-skipped', `reviewed tree ${token.head} is already HEAD`, { head: token.head })
    } else {
      port.add(card.worktreePath)
      const sha = port.commit(card.worktreePath, 'factory: auto-delivery')
      if (sha !== token.head) throw new Error(`提交后的 head 与 arm 不一致（${sha} ≠ ${token.head}）`)
      store.recordCommit(cardId, { sha, message: 'factory: auto-delivery', actor: AUTO_DELIVERY_TIER })
      audit(store, cardId, 'committed', `head ${sha}`, { head: sha })
    }
  }
  // Push / PR:止于 draft PR。已有 PR 只 push 更新，不新建、不 merge。
  if (card.prUrl) {
    port.push(card.worktreePath, card.branch)
    store.recordPushUpdate(cardId, { prUrl: card.prUrl, sha: token.head, actor: AUTO_DELIVERY_TIER })
    audit(store, cardId, 'pushed', `${card.prUrl} @ ${token.head}`, { head: token.head, url: card.prUrl })
  } else {
    // gh pr create --head <branch> resolves the branch on the REMOTE; it does
    // not publish a local-only branch. Push first (manual createPrForCard does
    // the same), then open the draft PR. No force, no merge.
    // Legacy offline ports (no real git) keep their historical fixture shape.
    if (typeof port.isWorktreeClean === 'function') {
      port.push(card.worktreePath, card.branch)
      audit(store, cardId, 'pushed', `branch ${card.branch} @ ${token.head}`, { head: token.head })
    }
    const url = port.createPr(card.worktreePath, {
      title: card.title, body: card.body || '', branch: card.branch, draft: true,
    })
    store.setPrUrl(cardId, url, AUTO_DELIVERY_TIER)
    store.recordPushUpdate(cardId, { prUrl: url, sha: token.head, actor: AUTO_DELIVERY_TIER })
    audit(store, cardId, 'draft-pr', `${url} @ ${token.head}`, { head: token.head, url })
  }
  store.setAutoDelivery(cardId, { head: token.head, state: 'delivered', actor: AUTO_DELIVERY_TIER })
  audit(store, cardId, 'delivered', `head ${token.head}`, { head: token.head })
  return { head: token.head, url: store.getCard(cardId).prUrl, state: 'delivered' }
}

/**
 * After a staging write moves HEAD, a verdict from the previous HEAD is stale:
 * the delivery gate will refuse it and the card would sit in Review with no
 * visible reason. Flag it explicitly so the UI can show reviewStaleNotice and
 * offer the redispatch action. Only marks when a verdict exists AND its head
 * differs from the new HEAD — the very condition the delivery gate checks.
 */
function markStaleIfVerdictOld(store, cardId, card, newHead) {
  const prev = card.reviewVerdict?.reviewedHead
  if (typeof prev === 'string' && prev !== '' && prev !== newHead) {
    try { store.markReviewStale(cardId, { previousReviewedHead: prev, head: newHead }) } catch { /* audit is primary */ }
  }
}

/**
 * L4 auto-commit at the Review entry. build deliberately leaves a dirty
 * worktree for humans to inspect, but the delivery gate requires a clean tree
 * whose HEAD is the reviewed head. Committing HERE (before review dispatch)
 * reconciles the two: the reviewer sees the new head, and delivery pushes that
 * same head. This is the user-pre-authorized L4 write boundary — identical to
 * executeAutoDelivery's git writes — NOT a human confirm-commit. No
 * pendingAuthorization is forged: that record means "a human confirmed" and
 * fabricating it would break AG-1. AG-1's commitCard gate is untouched.
 *
 * Returns a RESULT, never throws: { ok, committed?, skipped?, synced?, sha?,
 * head?, reason?, stalled? }. The tick gates review dispatch and delivery on
 * ok === true, so a failed commit never produces an unreviewed verdict.
 */
export async function ensureCommittedForAutoDelivery({
  store, cardId, port, readHead,
  protectedBranches = DEFAULT_PROTECTED_BRANCHES,
} = {}) {
  const card = store.getCard(cardId)
  if (card === undefined || card === null) return { ok: false, reason: `卡片不存在：${cardId}` }
  const project = store.getProject(card.projectId)
  if (project === undefined || project === null) return { ok: false, reason: `项目不存在：${card.projectId}` }
  if (project.autonomy !== AUTO_DELIVERY_TIER) return { ok: false, reason: '非 L4 档位，不自动提交' }
  if (card.status !== STATUS.REVIEW) return { ok: false, reason: `仅 Review 卡片自动提交（当前 ${card.status}）` }
  if (card.takenOver === true) return { ok: false, reason: '卡片已被人接管，不自动提交' }
  if (card.needsHumanInfo === true) return { ok: false, reason: '卡片待补充信息，不自动提交' }
  // Branch safety is the SAME gate as delivery — never bypass it here.
  if (isProtectedBranch(card.branch, protectedBranches)) {
    const reason = `拒绝向受保护分支「${card.branch}」自动提交`
    audit(store, cardId, 'commit-refused', reason)
    return { ok: false, reason }
  }
  if (card.baseBranch && String(card.branch).toLowerCase() === String(card.baseBranch).toLowerCase()) {
    const reason = `拒绝向 base 分支「${card.branch}」自动提交`
    audit(store, cardId, 'commit-refused', reason)
    return { ok: false, reason }
  }
  if (typeof card.worktreePath !== 'string' || card.worktreePath.trim() === '') {
    return { ok: false, reason: '卡片没有 worktreePath，无法自动提交' }
  }
  if (typeof port?.isWorktreeClean !== 'function') {
    return { ok: false, reason: 'git 端口未提供 isWorktreeClean，无法安全判断脏树' }
  }
  // Bounded retry on the COMMIT stage only. Separate from the dispatch-stage
  // stalled flag that assertDispatchable reads, so failures in one stage never
  // block the other.
  if (card.commitStalled === true) return { ok: false, reason: '自动提交已停滞，需人工处理', stalled: true }

  let head
  try {
    head = reviewedHeadFor({ worktreePath: card.worktreePath, readHead })
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  const clean = port.isWorktreeClean(card.worktreePath) === true
  // Idempotency is a DOUBLE condition: clean tree AND commitSha === HEAD.
  // A stale commitSha (review→build rebuild) or a dirty tree (legacy card)
  // must NOT be mistaken for "already committed".
  if (clean && card.commitSha === head) {
    return { ok: true, skipped: true, head }
  }
  if (clean && card.commitSha !== head) {
    // Tree is already clean but the recorded sha drifted — align it without a
    // (no-op) commit. The delivery gate still re-checks verdict head on this.
    store.recordCommit(cardId, { sha: head, message: 'factory: auto-delivery (head sync)', actor: AUTO_DELIVERY_TIER })
    store.clearCommitFailures(cardId)
    audit(store, cardId, 'head-synced', `reviewed tree ${head} is already HEAD`, { head })
    markStaleIfVerdictOld(store, cardId, card, head)
    return { ok: true, synced: true, head }
  }
  // Dirty tree: add + commit to the card branch. sha is the POST-commit HEAD;
  // it differs from the pre-commit head by design — never compare the two.
  const shortId = String(cardId).slice(0, 8)
  const message = `factory: auto-delivery ${shortId}`
  try {
    port.add(card.worktreePath)
    const sha = port.commit(card.worktreePath, message)
    if (!isFullSha(sha)) throw new Error(`提交返回的 sha 不是完整 SHA：${sha}`)
    store.recordCommit(cardId, { sha, message, actor: AUTO_DELIVERY_TIER })
    store.clearCommitFailures(cardId)
    audit(store, cardId, 'committed', `head ${sha}`, { head: sha })
    markStaleIfVerdictOld(store, cardId, card, sha)
    return { ok: true, committed: true, sha, head: sha }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    try { store.setAutoDelivery(cardId, { head, state: 'failed', error: reason, actor: AUTO_DELIVERY_TIER }) } catch { /* audit is primary */ }
    store.recordCommitFailure(cardId, { reason })
    audit(store, cardId, 'commit-failed', reason, { head })
    return { ok: false, reason, retryable: true }
  }
}

/** Engine entry point: arm + execute with a readable failure fallback. */
export async function runAutoDelivery({ store, cardId, readHead, resolveIdentity, port } = {}) {
  const arm = await armAutoDelivery({ store, cardId, readHead, resolveIdentity })
  if (arm.ok !== true) return { delivered: false, reason: arm.reason, alreadyDelivered: arm.alreadyDelivered === true }
  try {
    const result = await executeAutoDelivery({ store, token: arm.token, port, readHead, resolveIdentity })
    return { delivered: true, ...result }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    store.setAutoDelivery(cardId, { head: arm.head, state: 'failed', error: message, actor: AUTO_DELIVERY_TIER })
    audit(store, cardId, 'failed', message, { head: arm.head })
    // Failure falls back to the manual path: card stays in Review, no done/merge.
    return { delivered: false, reason: message, retryable: true }
  }
}
