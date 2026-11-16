/**
 * dsh-factory — session context (the "which card am I doing" injection, PRD §17-B).
 *
 * When a card is dispatched, its session must know four things immediately: the
 * card id, its title, the current phase, and the worktree it may touch. DSH has
 * no factory-style "signal processor"; the native route is the `systemPrompt`
 * service — `section()` for the text and `variable()` for the fields, both
 * registered on the *session's own* `agent.ctx` so one card's context never leaks
 * into another session (dsh-system-prompt: "registering through agent.ctx affects
 * that agent alone"). Every provider is a closure over the store, so when a card
 * moves a later assembly sees the new phase with no manual refresh.
 *
 * `buildSessionContext` is pure and unit-tested; `attachSessionContext` performs
 * the registration and is tested against a fake `agent.ctx`.
 */
import { nextStatuses } from './state.js'

const APPROVED_PHASES = new Set(['build', 'review', 'done'])

/**
 * Stage → packaged skill that drives it. The dispatched session must be TOLD
 * which skill to load: without this it receives only "advance the card" and
 * has no idea that `factory-triage` / `factory-plan` exist or what each stage
 * is supposed to produce, so it stalls (the AE-2 "stuck at triage" finding).
 * plan-review / done / canceled are deliberately absent — those wait for a
 * human or are terminal, so there is no agent skill to load.
 */
const PHASE_SKILL = Object.freeze({
  inbox: 'factory-triage',
  triage: 'factory-triage',
  plan: 'factory-plan',
  build: 'factory-build',
  review: 'factory-review',
})

/** The skill a session should load for its current phase, or null. */
export function skillForPhase(status) {
  return PHASE_SKILL[status] ?? null
}

/** Statuses whose plan is considered approved / submitted / not yet. */
function planStatusOf(status) {
  if (APPROVED_PHASES.has(status)) return 'approved'
  if (status === 'plan') return 'submitted'
  return 'none'
}

function repoOf(card, project) {
  // `card.repo` is the REMOTE identifier (e.g. "owner/name") — never a path. The
  // session works on disk, so prefer the explicit local `repoPath`, then the
  // project's own repos/rootPath. Falls back cleanly for old cards that predate
  // `repoPath` (they simply have none, so this skips to the project).
  if (typeof card.repoPath === 'string' && card.repoPath !== '') return card.repoPath
  const first = Array.isArray(project?.repos) ? project.repos[0] : undefined
  return first?.path ?? project?.rootPath ?? null
}

/**
 * The field set both the system-prompt section and the first message share
 * (cardId / title / phase / nextPhases / repo / branch / worktreePath /
 * planStatus / prUrl), plus the rendered `sectionText` and `firstMessage`.
 */
export function buildSessionContext({ card, project } = {}) {
  if (card === undefined || card === null) throw new Error('buildSessionContext needs a card')
  const fields = {
    cardId: card.id,
    title: card.title,
    phase: card.status,
    nextPhases: nextStatuses(card.status),
    repo: repoOf(card, project),
    // Remote identifier (e.g. "owner/name") and provenance, kept separate from
    // the local path in `repo`. Rendered only for reference; never used as a path.
    repoRemote: typeof card.repo === 'string' && card.repo !== '' ? card.repo : null,
    source: typeof card.source === 'string' && card.source !== '' ? card.source : null,
    branch: card.branch ?? null,
    worktreePath: card.worktreePath ?? null,
    planStatus: planStatusOf(card.status),
    prUrl: card.prUrl ?? null,
    // Which packaged skill drives THIS stage. The session is told to load it
    // before doing anything (see sectionText / firstMessage). null at the
    // human-gated / terminal phases.
    skill: skillForPhase(card.status),
  }

  const show = (value) => {
    if (value === null || value === undefined) return '—'
    return Array.isArray(value) ? (value.length === 0 ? '—' : value.join(', ')) : String(value)
  }
  const sectionText = [
    'You are working on exactly ONE factory card. Do not touch any other card.',
    `- cardId: ${fields.cardId}`,
    `- title: ${fields.title}`,
    `- phase: ${fields.phase}`,
    `- nextPhases: ${show(fields.nextPhases)}`,
    `- repo: ${show(fields.repo)} (local repository path — work here; the remote identifier, if any, is in source)`,
    ...(fields.repoRemote === null ? [] : [`- repoRemote: ${fields.repoRemote}`]),
    ...(fields.source === null ? [] : [`- source: ${fields.source}`]),
    `- branch: ${show(fields.branch)}`,
    `- worktreePath: ${show(fields.worktreePath)}`,
    `- planStatus: ${fields.planStatus}`,
    `- prUrl: ${show(fields.prUrl)}`,
    ...(fields.skill === null
      ? ['This phase is waiting for a human or is terminal — do NOT advance it yourself.']
      : [
          `Load the \`${fields.skill}\` skill FIRST and follow it for this phase — load the skill before doing anything else.`,
          `The \`${fields.skill}\` skill defines what this stage must produce. Advance the card with factory_transition_work_item and report with factory_report. Never commit, push or open a PR yourself — a human does that.`,
        ]),
  ].join('\n')

  const firstMessage = [
    `Factory task ${fields.cardId}: ${fields.title}`,
    `phase: ${fields.phase}`,
    `worktree: ${show(fields.worktreePath)}`,
    `repo: ${show(fields.repo)}${fields.branch ? ` (branch ${fields.branch})` : ''}`,
    '',
    ...(fields.skill === null
      ? ['This phase waits for a human or is terminal — do not advance it yourself.']
      : [
          `Load the \`${fields.skill}\` skill FIRST, before doing anything else, and follow it for this phase.`,
          `Work inside ${show(fields.worktreePath)}. The \`${fields.skill}\` skill defines what this stage must produce; use factory_transition_work_item to advance and factory_report to report. Do not commit/push/open a PR.`,
        ]),
  ].join('\n')

  return { ...fields, sectionText, firstMessage }
}

const VARIABLE_FIELDS = {
  factory_card_id: (built) => built.cardId,
  factory_title: (built) => built.title,
  factory_phase: (built) => built.phase,
  factory_next_phases: (built) => built.nextPhases.join(', '),
  factory_repo: (built) => built.repo ?? '',
  factory_branch: (built) => built.branch ?? '',
  factory_worktree: (built) => built.worktreePath ?? '',
  factory_pr_url: (built) => built.prUrl ?? '',
}

/** Section order fallback if the host cannot allocate one; distinct name avoids clash. */
const DEFAULT_ORDER = 60

/**
 * Register the work-item context on a *scoped* agent context (the one created for
 * the dispatched session). Providers read the store live, so a phase change shows
 * up on the next assembly. Returns one disposer that removes every registration.
 *
 * @param {{ agentCtx: object, store: import('./store.js').FactoryStore, cardId: string }} args
 */
export function attachSessionContext({ agentCtx, store, cardId } = {}) {
  const systemPrompt = agentCtx?.systemPrompt
  if (systemPrompt === undefined || systemPrompt === null) {
    throw new Error('attachSessionContext needs an agent context exposing systemPrompt')
  }

  const current = () => {
    const card = store.getCard(cardId)
    if (card === undefined || card === null) return null
    return buildSessionContext({ card, project: store.getProject(card.projectId) })
  }

  const disposers = []

  if (typeof systemPrompt.variable === 'function') {
    for (const [name, pick] of Object.entries(VARIABLE_FIELDS)) {
      disposers.push(systemPrompt.variable(name, () => {
        const built = current()
        if (built === null) return ''
        const value = pick(built)
        return value === null || value === undefined ? '' : String(value)
      }))
    }
  }

  if (typeof systemPrompt.section === 'function') {
    let order = DEFAULT_ORDER
    try {
      if (typeof systemPrompt.getSectionOrder === 'function') {
        const allocated = systemPrompt.getSectionOrder('FACTORY_WORK_ITEM')
        if (Number.isFinite(allocated)) order = allocated
      }
    } catch {
      // Unknown placement name: keep the fixed fallback order.
    }
    disposers.push(systemPrompt.section({
      name: 'factory:work-item',
      order,
      text: () => {
        const built = current()
        return built === null ? '' : built.sectionText
      },
    }))
  }

  return () => {
    for (const dispose of disposers) if (typeof dispose === 'function') dispose()
  }
}
