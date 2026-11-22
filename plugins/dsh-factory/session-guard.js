/**
 * dsh-factory — backend fallback for the UI rule "action buttons are disabled
 * while a session runs". A hidden button is only a hint; the write path itself
 * must refuse a direct API call, otherwise a stale page or a crafted request
 * can race a live agent or bypass an unfinished review.
 *
 * Everything here is pure over an injected `isSessionActive`, so the boundary
 * is unit-testable with no host. `sessionActiveFor` is the one ctx-backed reader
 * used by the HTTP layer; it reads the Agent's live busy status, not handle
 * existence, and degrades to "not active" when that service is unavailable.
 */

/**
 * True only while the host agent is actually running a turn.
 * DSH keeps an idle Agent in `agents` after its turn ends, so `agents.get(id) !=
 * null` means "handle still exists", NOT "busy". `Agent.status` is the
 * `idle | running` bit mirrored from `agent/status`, the same signal that
 * drives the client catalog's `sessions.list.byId[id].running` the UI reads.
 * Using anything weaker here permanently blocks every card that ever had a
 * session once that session goes idle.
 */
export function sessionActiveFor(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return false
  try {
    const agents = typeof ctx?.get === 'function' ? ctx.get('agents') : undefined
    if (agents === undefined || agents === null || typeof agents.get !== 'function') return false
    const agent = agents.get(sessionId)
    return agent?.status === 'running'
  } catch {
    return false
  }
}

/** Which of the card's two sessions are live. Absent checker means no session. */
export function activeSessionsFor(card, isSessionActive) {
  const live = (id) => typeof id === 'string' && id !== '' && typeof isSessionActive === 'function'
    && isSessionActive(id) === true
  return { builder: live(card?.sessionId), reviewer: live(card?.reviewSessionId) }
}

/**
 * Refuse a human write that would collide with a running session. Call BEFORE
 * any port/git write and before consuming a one-shot authorization, so a
 * refusal is retryable as soon as the session ends.
 */
export function assertNoActiveSession({ card, isSessionActive, action = '该操作' } = {}) {
  const { builder, reviewer } = activeSessionsFor(card, isSessionActive)
  if (builder !== true && reviewer !== true) return { builder: false, reviewer: false }
  const which = builder === true && reviewer === true ? '构建与评审' : builder === true ? '构建' : '评审'
  throw new Error(`${action}被拒绝：${which}会话仍在进行，请等会话结束后再操作`)
}
