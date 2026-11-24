/**
 * dsh-factory — status machine (V4, upstream order).
 *
 *   inbox → triage → plan → build → self-review → pr-review → done
 *
 * `done` is reached ONLY from a remote PR MERGED fact through `syncRule` and the
 * narrow SYNC_AUTO_EDGES set. It is deliberately not an ordinary agent/human
 * edge: that separation is what kept the remote-sync privilege hole closed.
 *
 * Actor vocabulary:
 *   - human     a person pressing a control in the UI
 *   - agent     a dispatched session acting inside its own worktree
 *   - autoRule  the stage-rule engine, always defaulting to full auto
 *   - syncRule  remote reconciliation; see SYNC_AUTO_EDGES below
 */

export const STATUS = Object.freeze({
  INBOX: 'inbox',
  TRIAGE: 'triage',
  PLAN: 'plan',
  BUILD: 'build',
  SELF_REVIEW: 'self-review',
  PR_REVIEW: 'pr-review',
  DONE: 'done',
  CANCELED: 'canceled',
  // Compatibility aliases for internal callers; NOT statuses in their own right.
  PLAN_REVIEW: 'plan',
  REVIEW: 'pr-review',
})

export const STATUSES = Object.freeze([
  STATUS.INBOX, STATUS.TRIAGE, STATUS.PLAN, STATUS.BUILD,
  STATUS.SELF_REVIEW, STATUS.PR_REVIEW, STATUS.DONE, STATUS.CANCELED,
])
export const TERMINAL = Object.freeze([STATUS.DONE, STATUS.CANCELED])

/** Opening a draft PR does not leave PR review; it enters it. */
export const PR_SUCCESS_STAYS = STATUS.PR_REVIEW

/**
 * Every legal edge → the actors that may take it. `pr-review->done` is absent
 * on purpose: only `syncRule` may finish a card, via SYNC_AUTO_EDGES.
 */
export const EDGE_ACTORS = Object.freeze({
  'inbox->triage': ['human', 'autoRule'],
  'inbox->canceled': ['human', 'autoRule', 'agent'],
  'triage->plan': ['agent'],
  'triage->inbox': ['agent', 'human'],
  'triage->canceled': ['agent', 'human'],
  'plan->build': ['agent', 'autoRule'],
  'plan->canceled': ['agent', 'human'],
  // A failed continuation after auto-approval rolls back to plan by the agent.
  'build->plan': ['agent'],
  'build->self-review': ['agent'],
  'build->canceled': ['agent', 'human'],
  'self-review->build': ['agent', 'autoRule'],
  'self-review->pr-review': ['agent'],
  'self-review->canceled': ['agent', 'human'],
  'pr-review->build': ['human'],
  'pr-review->canceled': ['human'],
})

/**
 * Remote reconciliation uses its OWN actor, deliberately separate from the
 * engine's `autoRule`. A merged PR is a remote fact, never a plan approval.
 * V4 intentionally widens ONLY this set so the removed human "mark done" button
 * is replaced by an idempotent merge event. EDGE_ACTORS is untouched.
 */
export const SYNC_RULE_ACTOR = 'syncRule'
export const SYNC_AUTO_EDGES = Object.freeze(['pr-review->done'])

export function canSyncAutoApply(from, to) {
  return SYNC_AUTO_EDGES.includes(`${from}->${to}`)
}

export function isStatus(value) {
  return STATUSES.includes(value)
}

export function isTerminal(status) {
  return TERMINAL.includes(status)
}

export function canTransition(from, to, actor) {
  if (!isStatus(from) || !isStatus(to)) return false
  if (isTerminal(from)) return false
  if (actor === SYNC_RULE_ACTOR) return canSyncAutoApply(from, to)
  const actors = EDGE_ACTORS[`${from}->${to}`]
  return Array.isArray(actors) && actors.includes(actor)
}

export function assertTransition(from, to, actor) {
  if (isTerminal(from)) throw new Error(`终态 ${from} 不可再转移`)
  if (actor === SYNC_RULE_ACTOR) {
    if (!canSyncAutoApply(from, to)) throw new Error(`远程同步不允许自动转移：${from} → ${to}`)
    return true
  }
  const key = `${from}->${to}`
  const actors = EDGE_ACTORS[key]
  if (actors === undefined) throw new Error(`非法转移：${from} → ${to}`)
  if (!actors.includes(actor)) {
    throw new Error(`转移 ${from} → ${to} 不允许由 ${actor} 触发（仅：${actors.join('/')}）`)
  }
  return true
}

/** Agent tools may never move a card into Done. */
export function agentCanReach(to) {
  return STATUSES.some((from) => canTransition(from, to, 'agent'))
}

export function nextStatuses(from) {
  return STATUSES.filter((to) => Object.prototype.hasOwnProperty.call(EDGE_ACTORS, `${from}->${to}`))
}
