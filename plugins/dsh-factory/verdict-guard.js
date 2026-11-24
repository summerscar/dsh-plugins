/**
 * dsh-factory — V4 write gates for the legacy human HTTP routes.
 *
 * Stage tools own git writes by default. The old human commit/PR HTTP routes
 * are still reachable, so they may only be used on a card the human has taken
 * over; otherwise they could race the engine. Stage tools keep their own,
 * stricter gates (see tools.js) and do not call these helpers.
 *
 * Pure over the card, so the boundary is unit-testable without a host.
 */

export function assertManualWritesAllowed({ card, action = '人工 git 写入' } = {}) {
  if (card?.takenOver !== true) {
    throw new Error(`${action}被拒绝：V4 默认由阶段工具写入；请先「我来接手」再人工写入`)
  }
  return true
}

/**
 * Require an approved, unblocked verdict on the card. Only the legacy human
 * HTTP write routes opt in; stage tools enforce their own verdict/head gates.
 */

export function assertApprovedVerdict({ card, action = '该操作', deny = '禁止写入 git' } = {}) {
  const verdict = card?.reviewVerdict
  if (verdict?.verdict !== 'approved') {
    throw new Error(`${action}被拒绝：没有 approved 评审结论，${deny}`)
  }
  if (Array.isArray(verdict.blocking) && verdict.blocking.length > 0) {
    throw new Error(`${action}被拒绝：评审仍有 ${verdict.blocking.length} 条阻断项，禁止写入 git`)
  }
  return verdict
}
