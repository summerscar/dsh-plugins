/**
 * dsh-factory — global audit query (batch 3, PRD #10 / QA H6).
 *
 * Flattens every card's per-card history into one read-only event stream and
 * filters it. Each event carries the governance fields QA H6 asks for:
 * `{ at, cardId, actor, decision, tier, rule, channel, type }`, so "who did what,
 * when, under which autonomy tier / rule" is answerable across the whole board.
 */
export function collectAudit(store, { actor, decision, cardId, since } = {}) {
  const events = []
  for (const card of store.state.cards) {
    for (const entry of card.history ?? []) {
      events.push({
        at: entry.at ?? null,
        cardId: card.id,
        actor: entry.actor ?? (entry.type === 'created' ? 'system' : null),
        decision: entry.type === 'authorize' ? `authorize:${entry.action}` : entry.type,
        type: entry.type,
        action: entry.action ?? null,
        tier: entry.tier ?? null,
        rule: entry.rule ?? null,
        channel: entry.channel ?? null,
      })
    }
  }
  // Governance events have no single card (global/project pause, take-over,
  // config skips). Merge them into the same stream so `actor=autoRule` and the
  // scope of every automatic action stay answerable (PRD §7/§8).
  for (const entry of store.state.events ?? []) {
    events.push({
      at: entry.at ?? null,
      cardId: entry.scope === 'card' ? entry.targetId : null,
      scope: entry.scope ?? null,
      targetId: entry.targetId ?? null,
      actor: entry.actor ?? 'autoRule',
      decision: entry.decision ?? entry.type,
      type: entry.type,
      action: null,
      tier: entry.tier ?? null,
      rule: entry.rule ?? null,
      channel: entry.channel ?? null,
    })
  }
  let result = events
  if (actor !== undefined) result = result.filter((event) => event.actor === actor)
  if (decision !== undefined) result = result.filter((event) => event.decision === decision || event.type === decision)
  if (cardId !== undefined) result = result.filter((event) => event.cardId === cardId)
  if (since !== undefined) result = result.filter((event) => typeof event.at === 'string' && event.at >= since)
  return result.sort((left, right) => (String(left.at) < String(right.at) ? 1 : -1))
}
