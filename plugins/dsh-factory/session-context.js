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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { defaultSkillsDir, parseSkillMarkdown } from './skills.js'
import { nextStatuses } from './state.js'
import { isFullSha, reviewedHeadFor } from './verdict.js'
// The session prompt must use the SAME copy as the UI; read the packaged
// dictionaries instead of keeping a second, drifting literal copy here.
import zhLocale from './locale/zh.json' with { type: 'json' }
import enLocale from './locale/en.json' with { type: 'json' }

/** Max characters of a card body injected into sectionText (Dev recommendation). */
export const BODY_CHAR_LIMIT = 3000

/** ICU language names: any BCP 47 id gets a name without a maintained table. */
const LANGUAGE_NAMES = (() => {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }) } catch { return null }
})()

/** BCP 47-style base language id, lowercased; '' for unsafe prompt input. */
function normalizeLocale(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase().replace(/_/g, '-') : ''
  return /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/.test(raw) ? raw.split('-')[0] : ''
}

/**
 * Read the user's display language. The Client mirrors its resolved active
 * language into the factory store (the Host cannot see the browser-resolved
 * value); an explicit Host `locale.preference` and older service shapes stay
 * as fallbacks. Unknown/missing sources default to zh as before.
 */
export function localeFromContext(ctx, store) {
  const read = (value) => {
    if (typeof value === 'function') {
      try { return read(value()) } catch { return '' }
    }
    return typeof value === 'string' ? value : ''
  }
  const candidates = [
    () => read(store?.getUiLocaleSetting?.()),
    () => read(ctx?.locale?.current),
    () => read(ctx?.locale?.language),
    () => read(ctx?.locale?.locale),
    () => read(ctx?.i18n?.locale),
    () => read(ctx?.i18n?.language),
    () => read(ctx?.config?.locale),
    () => (typeof ctx?.config?.get === 'function' ? read(ctx.config.get('locale')) : ''),
    () => {
      const service = typeof ctx?.get === 'function' ? ctx.get('locale') : undefined
      return read(service?.current ?? service?.language ?? service?.locale ?? service)
    },
    // DSH stores the user's display language in the Host user-settings
    // document as `locale.preference` (a volatile field, projected as a plain
    // string by settings.describe()). This is the authoritative Host-side
    // source; the earlier shapes stay as fallbacks for older profiles.
    () => {
      const settings = typeof ctx?.get === 'function' ? ctx.get('settings') : undefined
      if (settings === undefined || settings === null || typeof settings.describe !== 'function') return ''
      const rows = settings.describe()
      const row = Array.isArray(rows) ? rows.find((entry) => entry && entry.ns === 'locale') : undefined
      return read(row?.value?.preference)
    },
  ]
  for (const candidate of candidates) {
    let value = ''
    try { value = candidate() } catch { value = '' }
    const id = normalizeLocale(value)
    if (id !== '') return id
  }
  return 'zh'
}

/** One dynamic directive for every language — no per-language dictionary copy. */
function languageDirective(locale) {
  const id = normalizeLocale(locale) || 'en'
  let name = id
  try {
    const resolved = LANGUAGE_NAMES?.of(id)
    if (typeof resolved === 'string' && resolved !== '') name = resolved
  } catch { name = id }
  return `Reply in ${name} (${id}) and write every factory_report body in ${name}; keep code, commands, file paths and proper nouns as-is.`
}

/** Plain text only: never render a card body as Markdown or HTML in a prompt. */
function plainBodyText(value) {
  if (typeof value !== 'string' || value === '') return ''
  return value
    .replace(/```[\s\S]*?```/g, (fence) => fence.replace(/^```[^\n]*\n?/, '').replace(/```\s*$/, ''))
    .replace(/<\/?(?:a|abbr|b|blockquote|br|code|dd|details|div|dl|dt|em|h[1-6]|hr|i|img|li|ol|p|pre|s|span|strong|sub|summary|sup|table|tbody|td|th|thead|tr|u|ul)\b[^>]*>/gi, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/(\*\*|__)([^*_]*?)\1/g, '$2')
    .replace(/(^|\s)[*_](?=\S)([^*_\n]*?\S)[*_]/g, '$1$2')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function bodyNotice(locale, key) {
  const dict = locale === 'en' ? enLocale : zhLocale
  return typeof dict[key] === 'string' ? dict[key] : ''
}

/**
 * Independent block injected ahead of the skill instructions: untrusted-data
 * notice, snapshot notice for auto cards only, plain body, truncation hint.
 */
function bodyBlock(card, locale) {
  const full = plainBodyText(card.body)
  if (full === '') return []
  const hasSource = typeof card.source === 'string' && card.source !== '' && card.source !== 'manual'
  // A manual card has no issue to re-read: its description is the ONLY task
  // content, so only source-backed cards are truncated and get the re-read hint.
  const truncated = hasSource && Array.from(full).length > BODY_CHAR_LIMIT
  const lines = [bodyNotice(locale, 'bodyUntrustedNotice')]
  if (hasSource) lines.push(bodyNotice(locale, 'bodySnapshotNotice'))
  lines.push(truncated ? Array.from(full).slice(0, BODY_CHAR_LIMIT).join('') : full)
  if (truncated) lines.push(bodyNotice(locale, 'bodyTruncatedHint'))
  return lines
}

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

/**
 * Read one packaged skill's BODY (frontmatter stripped) from `skills/<name>/SKILL.md`.
 * Returns the body string, or null when the file is missing/unreadable — a read
 * failure must NEVER break dispatch, so callers soft-fall back to the plain
 * section text. The filesystem access is an injectable port so this stays
 * offline-testable without touching the real disk.
 *
 * @param {string} skillName
 * @param {{ skillsDir?: string, readFileSync?: (path: string, enc: string) => string }} [port]
 * @returns {string|null}
 */
export function readSkillBody(skillName, port = {}) {
  if (typeof skillName !== 'string' || skillName === '') return null
  const dir = typeof port.skillsDir === 'string' && port.skillsDir !== '' ? port.skillsDir : defaultSkillsDir()
  const read = typeof port.readFileSync === 'function' ? port.readFileSync : readFileSync
  try {
    const raw = read(join(dir, skillName, 'SKILL.md'), 'utf8')
    const { content } = parseSkillMarkdown(raw)
    return typeof content === 'string' && content.trim() !== '' ? content : null
  } catch {
    return null
  }
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
export function buildSessionContext({ card, project, locale = 'zh', reviewMode = false, review = {}, builderMode = false } = {}) {
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
  const bodyLines = bodyBlock(card, locale)
  const languageLine = languageDirective(locale)

  // P2a bug fix: a BUILDER session stays a builder for its whole life. When
  // the card enters Review its context must NOT become a reviewer's — that
  // directly caused builder self-verdicts. It is told to wait for the human and
  // will become a builder again if the card is sent back to build (AC8).
  if (builderMode === true && card.status === 'review' && reviewMode !== true) {
    fields.skill = null
    fields.nextPhases = []
    const waitingText = [
      ...bodyLines,
      ...(bodyLines.length === 0 ? [] : ['']),
      ...(languageLine === '' ? [] : [languageLine, '']),
      'You are the BUILDER session for this card. The card has entered Review. Do NOT review it, do NOT submit a structured verdict, and do NOT move the card. Wait for the human decision; if the card is returned to Build, continue building in this same session.',
      `- cardId: ${fields.cardId}`,
      `- phase: ${fields.phase}`,
      `- repo: ${show(fields.repo)}`,
      `- branch: ${show(fields.branch)}`,
      `- worktreePath: ${show(fields.worktreePath)}`,
      `- prUrl: ${show(fields.prUrl)}`,
    ].join('\n')
    const waitingFirst = [
      `Factory card ${fields.cardId} is now in Review.`,
      'Builder session standing by: do not review, do not write a verdict, do not move the card. Wait for the human.',
    ].join('\n')
    return { ...fields, sectionText: waitingText, firstMessage: waitingFirst }
  }

  // PRD §5.2: a REVIEW session is a different role. It receives the review
  // fields and NEVER the phase-advance / move-card instructions that drive a
  // builder session — those directly contradict factory-review's "You cannot
  // move the card". reviewMode is explicit so P2 can wire it to its dedicated
  // review dispatch; the builder path stays byte-for-byte unchanged.
  if (reviewMode === true) {
    if (card.status !== 'review') {
      throw new Error(`评审会话上下文要求卡片处于 review 阶段，当前为 ${card.status ?? '未知'}；拒绝降级为普通会话`)
    }
    const head = review.reviewedHead ?? reviewedHeadFor({
      worktreePath: card.worktreePath,
      readHead: review.readHead,
    })
    if (!isFullSha(head)) {
      throw new Error('评审会话上下文缺少完整的 reviewedHead（需要 git rev-parse HEAD 的 40/64 位 SHA）；拒绝在无 head 的会话中评审')
    }
    const sandboxMode = typeof review.readSandboxMode === 'function' ? review.readSandboxMode() : review.sandboxMode
    if (sandboxMode !== 'read-only') {
      throw new Error(`评审会话上下文要求只读沙箱，当前为 ${sandboxMode ?? '未知'}；拒绝以可写权限评审`)
    }
    fields.reviewedHead = head
    fields.previousVerdict = card.reviewVerdict ?? null
    fields.commitSha = card.commitSha ?? null
    fields.nextPhases = []
    // AC5: a card with a review→build return gets the rereview skill instead.
    fields.skill = review.rereview === true ? 'factory-rereview' : skillForPhase('review')
    const previous = fields.previousVerdict === null ? '—' : JSON.stringify(fields.previousVerdict)
    const skillLine = `Read the \`${fields.skill}\` skill below first. Report with \`factory_report\` using its structured verdict fields (source, verdict, blocking, followUps, checks, reviewerSessionId); reviewedHead is computed by the factory from git and must NOT be supplied by you.`
    const sectionText = [
      ...bodyLines,
      ...(bodyLines.length === 0 ? [] : ['']),
      ...(languageLine === '' ? [] : [languageLine, '']),
      'You are an INDEPENDENT REVIEW session on exactly ONE factory card. You are read-only: never move the card, authorize git actions, commit, push or open a PR. The human decides after reading your verdict.',
      `- cardId: ${fields.cardId}`,
      `- title: ${fields.title}`,
      `- phase: ${fields.phase}`,
      `- repo: ${show(fields.repo)} (local repository path)`,
      `- branch: ${show(fields.branch)}`,
      `- worktreePath: ${show(fields.worktreePath)}`,
      `- prUrl: ${show(fields.prUrl)}`,
      `- reviewedHead: ${fields.reviewedHead}`,
      `- previousVerdict: ${previous}`,
      `- commitSha: ${show(fields.commitSha)}`,
      skillLine,
    ].join('\n')
    const firstMessage = [
      `Factory review ${fields.cardId}: ${fields.title}`,
      `phase: ${fields.phase}`,
      `worktree: ${show(fields.worktreePath)}`,
      `repo: ${show(fields.repo)}${fields.branch ? ` (branch ${fields.branch})` : ''}`,
      ...(languageLine === '' ? [] : [languageLine]),
      `reviewedHead: ${fields.reviewedHead}`,
      `previousVerdict: ${previous}`,
      `commitSha: ${show(fields.commitSha)}`,
      `This is a read-only review: do NOT advance or move the card, authorize, commit, push or open a PR. Follow the ${fields.skill} skill and record a structured verdict with factory_report.`,
    ].join('\n')
    return { ...fields, sectionText, firstMessage }
  }

  const sectionText = [
    ...bodyLines,
    ...(bodyLines.length === 0 ? [] : ['']),
    ...(languageLine === '' ? [] : [languageLine, '']),
    'You are working on exactly ONE factory card. Do not touch any other card.',
    'Advance through the agent-owned stages (\`triage\`, \`plan\`, \`build\`, \`review\`) continuously within this single session — finish the current stage and move the card yourself; do not end your turn expecting another session to take over. Only \`plan-review\`, \`done\` and \`canceled\` are stop-and-wait states where a human acts.',
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
          `Read the \`${fields.skill}\` skill below first — its full instructions are included for this phase.`,
          `The \`${fields.skill}\` skill defines what this stage must produce. Advance the card with factory_transition_work_item and report with factory_report. Never commit, push or open a PR yourself — a human does that.`,
        ]),
  ].join('\n')

  const firstMessage = [
    `Factory task ${fields.cardId}: ${fields.title}`,
    `phase: ${fields.phase}`,
    `worktree: ${show(fields.worktreePath)}`,
    `repo: ${show(fields.repo)}${fields.branch ? ` (branch ${fields.branch})` : ''}`,
    ...(languageLine === '' ? [] : [languageLine]),
    'Stages triage / plan / build / review continue in this same session — finish the current one and advance the card yourself; only plan-review / done / canceled wait for a human.',
    '',
    ...(fields.skill === null
      ? ['This phase waits for a human or is terminal — do not advance it yourself.']
      : [
          `Read and follow the \`${fields.skill}\` skill for this phase first — its instructions are in your system context (skill: ${fields.skill}).`,
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
  factory_reviewed_head: (built) => built.reviewedHead ?? '',
  factory_previous_verdict: (built) => built.previousVerdict === null || built.previousVerdict === undefined ? '' : JSON.stringify(built.previousVerdict),
  factory_commit_sha: (built) => built.commitSha ?? '',
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
export function attachSessionContext({ agentCtx, store, cardId, skillsDir, readSkill, locale = 'zh', reviewMode = false, review = {}, builderMode = false } = {}) {
  const systemPrompt = agentCtx?.systemPrompt
  if (systemPrompt === undefined || systemPrompt === null) {
    throw new Error('attachSessionContext needs an agent context exposing systemPrompt')
  }

  // Resolve the skill body for the CURRENT phase, lazily, via an injectable port.
  // The factory builds top-level agents through agents.create(), which does NOT
  // mount a preset — so the dispatched session has no `skill` tool. The skill
  // body therefore has to be delivered through THIS systemPrompt section (the
  // same channel factory_repo/cardId use), not by asking the agent to load it.
  const readBody = typeof readSkill === 'function'
    ? readSkill
    : (name) => readSkillBody(name, { skillsDir })

  const current = () => {
    const card = store.getCard(cardId)
    if (card === undefined || card === null) return null
    return buildSessionContext({ card, project: store.getProject(card.projectId), locale, reviewMode, review, builderMode })
  }

  // Review mode fails CLOSED at attach time: a missing head or a writable
  // sandbox must abort the dispatch here, not degrade into a builder-style
  // session that can move the card. The host setup awaits this call.
  if (reviewMode === true) current()

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
        if (built === null) return ''
        if (built.skill === null) return built.sectionText
        // Only the CURRENT phase's skill, never all seven. Wrapped in the same
        // <skill_content> shape the host uses, so the model sees one canonical
        // block. A failed read degrades to "body unavailable" — dispatch must
        // not break because a packaged file is missing.
        let body = null
        try { body = readBody(built.skill) } catch { body = null }
        if (typeof body !== 'string' || body.trim() === '') {
          return `${built.sectionText}\n\n(技能正文不可用：读取 \`${built.skill}\` 失败，按上面的阶段说明执行。)`
        }
        return `${built.sectionText}\n\n<skill_content name="${built.skill}">\n${body}\n</skill_content>`
      },
    }))
  }

  return () => {
    for (const dispose of disposers) if (typeof dispose === 'function') dispose()
  }
}
