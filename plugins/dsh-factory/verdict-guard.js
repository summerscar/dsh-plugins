/**
 * dsh-factory — API-side verdict gate for human git writes.
 *
 * Review is a real gate, not a decoration: a card reaching Review without an
 * approved verdict must not be able to commit, open a PR, update one or mark a
 * rework through the HTTP API. The engine's L4 delivery path has its own,
 * stricter gate in delivery.js and never calls these helpers.
 *
 * Pure over the card, so the boundary is unit-testable without a host.
 */

/**
 * Require an approved, unblocked verdict on the card.
 * Unlike the session guard this is not a per-call injection: every API write
 * route opts in with `requireApprovedVerdict: true`, while internal/offline
 * callers (and delivery.js) keep their existing behaviour.
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
