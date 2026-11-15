/**
 * dsh-factory — status machine (PRD §8).
 *
 * The legal-transition table lives here as data rather than being scattered
 * through the route handlers: the whole safety story of a factory is "a card
 * must never jump to the wrong column, and an agent must never move itself to
 * Done". Encoding each edge together with the actors allowed to take it means
 * an agent tool call and a human button go through the *same* check.
 *
 * Actor vocabulary:
 *   - human     a person pressing a control in the UI
 *   - agent     a dispatched session acting inside its own worktree
 *   - autoRule  the autonomy engine (L1/L2) acting on an opt-in project
 *   - syncRule  remote reconciliation; see SYNC_AUTO_EDGES below
 */

export const STATUS = Object.freeze({
  INBOX: 'inbox',
  TRIAGE: 'triage',
  PLAN: 'plan',
  PLAN_REVIEW: 'plan-review',
  BUILD: 'build',
  REVIEW: 'review',
  DONE: 'done',
  CANCELED: 'canceled',
})

export const STATUSES = Object.freeze(Object.values(STATUS))
export const TERMINAL = Object.freeze([STATUS.DONE, STATUS.CANCELED])

/**
 * A PR created successfully does *not* advance the card: it stays in Review and
 * shows the link. Done is only reachable by a human pressing "标记完成" (D6/§9.3).
 */
export const PR_SUCCESS_STAYS = STATUS.REVIEW

/**
 * Every legal edge → the actors that may take it. Mirror of the §8 transfer
 * table. An edge that is absent is illegal; an actor absent from its list is
 * refused even when the edge itself is legal.
 */
export const EDGE_ACTORS = Object.freeze({
  'inbox->triage': ['human', 'autoRule'],
  'inbox->canceled': ['human', 'autoRule', 'agent'],
  'triage->plan': ['agent'],
  'triage->inbox': ['agent', 'human'],
  'triage->canceled': ['agent', 'human'],
  'plan->plan-review': ['agent'],
  'plan->canceled': ['agent', 'human'],
  'plan-review->build': ['human', 'autoRule'],
  'plan-review->plan': ['human'],
  'plan-review->canceled': ['human'],
  'build->review': ['agent'],
  'build->canceled': ['agent', 'human'],
  'review->done': ['human'],
  'review->build': ['human'],
  'review->canceled': ['human'],
})

/**
 * Remote reconciliation uses its OWN actor, deliberately separate from the
 * engine's `autoRule`. `autoRule` means "the L1/L2 engine may take this edge for
 * an opted-in project"; a remote PR fact is a different thing entirely and must
 * never be read as a plan approval. Sync may auto-apply ONLY the edges listed
 * here — and at L1 this set is empty, so every remote suggestion is recorded as
 * `needsHuman` (PRD L1 §4.1 / AE-2b). This closes the hole where a "PR closed
 * without merge" suggestion, combined with `autoRule` being legal on
 * `plan-review->build`, silently pushed a card past the approval gate.
 *
 * To widen sync for L2, add the exact edge(s) here and nowhere else; both the
 * read side (`canSyncAutoApply`) and the write side (`assertTransition`) consult
 * this one set, so they can never drift apart.
 */
export const SYNC_RULE_ACTOR = 'syncRule'
export const SYNC_AUTO_EDGES = Object.freeze([])

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

/**
 * Whether *any* agent-triggered edge can land on `to`. Used to assert the hard
 * rule "agent tools may never move a card into Done" without hard-coding Done.
 */
export function agentCanReach(to) {
  return STATUSES.some((from) => canTransition(from, to, 'agent'))
}

/** The statuses a card can legally move to next from `from` (any actor). */
export function nextStatuses(from) {
  return STATUSES.filter((to) => Object.prototype.hasOwnProperty.call(EDGE_ACTORS, `${from}->${to}`))
}
