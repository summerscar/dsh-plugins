/**
 * dsh-factory — remote status reconciliation (batch 3, PRD #6).
 *
 * The remote forge is the source of truth for facts (a PR merged is a fact), so
 * sync derives the *suggested* card column from the remote PR state rather than
 * trusting local state. But a fact is NOT an approval: under you-approve every
 * suggestion is recorded for a human and NONE is auto-applied.
 *
 * This used to decide auto-apply by `canTransition(..., 'autoRule')`. That was a
 * real privilege hole: `autoRule` is legal on `plan-review->build` (reserved for
 * the machine-approve engine), and a "PR closed without merge" suggestion targets
 * `build`, so a single remote sync could push a card waiting for plan approval
 * into build — bypassing the gate, the engine and `assertDispatchable`. Sync now
 * consults its own narrow `SYNC_AUTO_EDGES` set and applies with the `syncRule`
 * actor, never `autoRule`. At you-approve that set is empty, so every suggestion
 * needs a human.
 *
 *   PR MERGED          → auto Done             (syncRule; pr-review->done idempotent)
 *   PR CLOSED unmerged → suggest Build (退回)   (Review→Build is human-only)
 *   PR OPEN            → no column change
 */
import { SYNC_RULE_ACTOR, canSyncAutoApply } from './state.js'

/** Suggested target column from a remote PR snapshot, or null. */
export function deriveRemoteTarget(remote) {
  const pr = remote?.pr
  if (pr === undefined || pr === null) return null
  const state = String(pr.state ?? '').toUpperCase()
  if (state === 'MERGED') return { target: 'done', reason: 'PR merged' }
  if (state === 'CLOSED') return { target: 'build', reason: 'PR closed without merge' }
  return null
}

/** Resolve a suggestion and whether sync's own narrow rule may apply it unaided. */
export function resolveSync(card, remote) {
  const suggestion = deriveRemoteTarget(remote)
  if (suggestion === null || suggestion.target === card.status) return { suggestion: null }
  const autoApplicable = canSyncAutoApply(card.status, suggestion.target)
  return { suggestion: { ...suggestion, autoApplicable, requiresHuman: !autoApplicable } }
}

/**
 * Apply remote reconciliation to one card. Auto-applies only edges sync's own
 * narrow rule permits (none at you-approve); otherwise it records a suggestion and reports
 * `needsHuman`. `assertTransition` re-checks the same set as a second gate, so a
 * future widening of the engine's `autoRule` can never reopen this path by itself.
 */
export function applyRemoteSync({ store, cardId, remote } = {}) {
  const card = store.getCard(cardId)
  if (card === undefined || card === null) throw new Error(`卡片不存在：${cardId}`)
  const { suggestion } = resolveSync(card, remote)
  if (suggestion === null) return { changed: false }
  if (suggestion.autoApplicable) {
    store.transitionCard(cardId, suggestion.target, SYNC_RULE_ACTOR, suggestion.reason)
    return { changed: true, target: suggestion.target }
  }
  store.recordSyncSuggestion(cardId, suggestion)
  return { changed: false, needsHuman: true, suggestion }
}
