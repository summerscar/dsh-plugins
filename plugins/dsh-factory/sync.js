/**
 * dsh-factory — remote status reconciliation (batch 3, PRD #6).
 *
 * The remote forge is the source of truth for facts (a PR merged is a fact), so
 * sync derives the *suggested* card column from the remote PR state rather than
 * trusting local state. But some columns are human-only (Done, and Review→Build),
 * so sync never force-moves those: it records a suggestion and leaves the move to
 * a person. Only edges that are legal for the `autoRule` actor are auto-applied.
 *
 *   PR MERGED          → suggest Done          (human confirms; Done is human-only)
 *   PR CLOSED unmerged → suggest Build (退回)   (Review→Build is human-only)
 *   PR OPEN            → no column change
 */
import { canTransition } from './state.js'

/** Suggested target column from a remote PR snapshot, or null. */
export function deriveRemoteTarget(remote) {
  const pr = remote?.pr
  if (pr === undefined || pr === null) return null
  const state = String(pr.state ?? '').toUpperCase()
  if (state === 'MERGED') return { target: 'done', reason: 'PR merged' }
  if (state === 'CLOSED') return { target: 'build', reason: 'PR closed without merge' }
  return null
}

/** Resolve a suggestion and whether the auto-rule actor may apply it unaided. */
export function resolveSync(card, remote) {
  const suggestion = deriveRemoteTarget(remote)
  if (suggestion === null || suggestion.target === card.status) return { suggestion: null }
  const autoApplicable = canTransition(card.status, suggestion.target, 'autoRule')
  return { suggestion: { ...suggestion, autoApplicable, requiresHuman: !autoApplicable } }
}

/**
 * Apply remote reconciliation to one card. Auto-applies only edges the auto-rule
 * actor may take; otherwise it records a suggestion and reports `needsHuman`.
 */
export function applyRemoteSync({ store, cardId, remote } = {}) {
  const card = store.getCard(cardId)
  if (card === undefined || card === null) throw new Error(`卡片不存在：${cardId}`)
  const { suggestion } = resolveSync(card, remote)
  if (suggestion === null) return { changed: false }
  if (suggestion.autoApplicable) {
    store.transitionCard(cardId, suggestion.target, 'autoRule', suggestion.reason)
    return { changed: true, target: suggestion.target }
  }
  store.recordSyncSuggestion(cardId, suggestion)
  return { changed: false, needsHuman: true, suggestion }
}
