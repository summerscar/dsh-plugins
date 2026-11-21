/**
 * dsh-factory — three-layer store: Project → Board → Card (PRD §7).
 *
 * SQLite persistence: the in-memory `state` object (projects/boards/cards/
 * events/settings, schemaVersion stamped) is the single source of truth for
 * every public method; `_load` reads one row at construction and `_commit`
 * upserts that row in one transaction on every change. A crash mid-write cannot
 * leave a half state row (SQLite statement atomicity). The whole-state-in-one-
 * row shape keeps ~30 public methods and the `store.state.*` direct reads in
 * api.js/audit.js untouched — this is a persistence swap, not a schema rewrite.
 *
 * The store owns *state* and the two safety invariants that do not belong in a
 * route handler:
 *   - every status change goes through `state.js` (so an agent cannot reach Done);
 *   - PR creation and the two approval buttons are only recorded from Review
 *     (AG-2 / §9.4) and leave an audit record (actor + time + status snapshot, D4).
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import { assertTransition, PR_SUCCESS_STAYS, STATUS, isStatus, isTerminal } from './state.js'
import { assertWorktreeRoot, checkProjectRoot, defaultWorktreeRoot, expandHome } from './worktree.js'
import { DEFAULT_POST_CREATE_TIMEOUT_MS, normalizeCopyFiles } from './worktree-setup.js'
import { detectGithubRepo, normalizeGithubRepo } from './git-exec.js'
import { normalizeVerdict } from './verdict.js'

export const SCHEMA_VERSION = 2

/**
 * Credential-key segment grammar, mirrored from the host's dsh-credentials seam
 * (`/^[a-z][a-z0-9-]*$/`). Kept local so a custom project credential id is
 * rejected BEFORE we ever ask the host to build a key — a bad id (uppercase,
 * underscore, a path with `/`) must surface its own error, never a host TypeError
 * deep inside the credential service. Pure and dependency-free for offline tests.
 */
export const CREDENTIAL_KEY_SEGMENT = /^[a-z][a-z0-9-]*$/

export function isCredentialKeySegment(value) {
  return typeof value === 'string' && CREDENTIAL_KEY_SEGMENT.test(value)
}

export const DEFAULT_PERMISSION = 'workspace-write'
export const DEFAULT_AUTONOMY = 'manual'
export const AUTO_DELIVERY_TIER = 'auto-delivery'
export const WORK_MODES = Object.freeze(['workspace-write', 'full-access', 'auto-review'])
export const DEFAULT_WORK_MODE = 'workspace-write'

/** Work mode is orthogonal to the autonomy tier; unknown values are refused. */
export function normalizeWorkMode(value, fallback = DEFAULT_WORK_MODE) {
  if (value === undefined || value === null || value === '') return fallback
  if (!WORK_MODES.includes(value)) throw new Error(`未知工作模式：${value}（可选 ${WORK_MODES.join(' / ')}）`)
  return value
}

/** Consecutive failed dispatches before a card stops being re-dispatched. */
export const DEFAULT_DISPATCH_FAILURE_LIMIT = 3
export const DEFAULT_COLUMNS = ['planning', 'awaiting-approval', 'building', 'review', 'done']
// One project owns one active board. Board names are no longer surfaced in the
// UI; this label only identifies the auto-created board in persisted state/API.
export const DEFAULT_BOARD_NAME = 'Default'

function clone(value) {
  return value == null ? value : structuredClone(value)
}

function reqString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`缺少必填字段：${field}`)
  return value.trim()
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function normalizeRepos(repos) {
  if (repos === undefined || repos === null) return []
  if (!Array.isArray(repos)) throw new Error('repos 必须是数组')
  return repos.map((repo) => {
    if (typeof repo === 'string') {
      if (!repo.startsWith('/')) throw new Error(`仓库路径必须是绝对路径：${repo}`)
      return { name: repo.split('/').filter(Boolean).pop() || repo, path: repo }
    }
    if (repo !== null && typeof repo === 'object' && typeof repo.path === 'string') {
      if (!repo.path.startsWith('/')) throw new Error(`仓库路径必须是绝对路径：${repo.path}`)
      return { name: optionalString(repo.name) || repo.path.split('/').filter(Boolean).pop() || repo.path, path: repo.path }
    }
    throw new Error('repo 必须是字符串路径或 { name, path }')
  })
}

function normalizeUsage(usage) {
  const tokens = usage && Number.isFinite(usage.tokens) ? usage.tokens : 0
  return { tokens }
}

/**
 * Pick only the string audit fields actually supplied, so history entries never
 * carry `undefined` members (the host's lossless-JSON check rejects those).
 */
function auditFields(meta) {
  const out = {}
  if (!meta || typeof meta !== 'object') return out
  for (const key of ['actor', 'tier', 'rule', 'channel']) {
    if (typeof meta[key] === 'string' && meta[key] !== '') out[key] = meta[key]
  }
  return out
}

/**
 * Project-level worktree preparation config. Paths are validated at creation
 * time (an invalid config is a bad project, not a failed dispatch); old state
 * files without these fields fall back to the no-op defaults.
 */
function normalizePreparation(input) {
  const copyFiles = normalizeCopyFiles(input.copyFiles)
  const postCreate = optionalString(input.postCreate)
  const rawTimeout = input.postCreateTimeoutMs
  const postCreateTimeoutMs = rawTimeout === undefined || rawTimeout === null
    ? DEFAULT_POST_CREATE_TIMEOUT_MS
    : rawTimeout
  if (!Number.isFinite(postCreateTimeoutMs) || postCreateTimeoutMs <= 0) {
    throw new Error('postCreateTimeoutMs 必须是正数')
  }
  return { copyFiles, postCreate, postCreateTimeoutMs }
}

/**
 * Project-level autonomy config. The semantic level is the only truth source;
 * `autoDispatch` is a switch ONLY for you-approve. The old switches are never
 * stored again.
 */
export const AUTONOMY_LEVELS = new Set(['manual', 'you-approve', 'machine-approve', 'auto-delivery'])
const LEGACY_AUTONOMY_LEVELS = new Set(['L0', 'L1', 'L2'])

/** Map a stored v1 triple to the v2 level + single switch, by REAL behavior. */
function migrateLegacyAutonomy(level, autoStart, autoApprove) {
  if (level === 'L0') return { autonomy: 'manual', autoDispatch: false }
  if (level === 'L1') return { autonomy: 'you-approve', autoDispatch: autoStart === true }
  if (level === 'L2') {
    if (autoStart === true && autoApprove === true) return { autonomy: 'machine-approve', autoDispatch: false }
    if (autoStart === true) return { autonomy: 'you-approve', autoDispatch: true }
    return { autonomy: 'you-approve', autoDispatch: false }
  }
  return { autonomy: 'manual', autoDispatch: false }
}

function normalizeAutonomy(input, current = {}) {
  const raw = input.autonomy === undefined ? current.autonomy : input.autonomy
  if (raw !== undefined && LEGACY_AUTONOMY_LEVELS.has(raw)) {
    return migrateLegacyAutonomy(raw, input.autoStart ?? current.autoStart, input.autoApprove ?? current.autoApprove)
  }
  if (raw !== undefined && !AUTONOMY_LEVELS.has(raw)) {
    throw new Error(`autonomy 只能是 manual / you-approve / machine-approve / auto-delivery：${String(raw)}`)
  }
  const autonomy = raw === undefined ? DEFAULT_AUTONOMY : raw
  // Only you-approve reads autoDispatch. auto-delivery inherits machine-approve
  // behavior and explicitly ignores the switch.
  const autoDispatch = autonomy === 'you-approve'
    ? (input.autoDispatch === undefined ? current.autoDispatch === true : input.autoDispatch === true)
    : false
  return { autonomy, autoDispatch }
}

/** Load-time normalization never rejects an old or corrupt archive. */
function normalizeStoredAutonomy(project) {
  try {
    return normalizeAutonomy({
      autonomy: project.autonomy,
      autoDispatch: project.autoDispatch,
      autoStart: project.autoStart,
      autoApprove: project.autoApprove,
    }, {})
  } catch {
    return { autonomy: DEFAULT_AUTONOMY, autoDispatch: false }
  }
}

/**
 * Project-level, explicitly opted-in intake config (PRD §10 / G1+G3). The engine
 * must NOT guess a GitHub repo from the local path, read `git remote`, or create a
 * board: a missing field means "skip this project, visibly". `maxActiveSessions`
 * is the per-project concurrency cap; null means "use the plugin default".
 */
function normalizeIntake(input, current = {}) {
  const pick = (key) => {
    if (!(key in input)) return current[key] ?? null
    const value = input[key]
    if (value === null || value === undefined || value === '') return null
    return typeof value === 'string' ? value.trim() : value
  }
  const repo = pick('issueRepo')
  const normalizedRepo = repo === null ? null : normalizeGithubRepo(repo)
  if (repo !== null && normalizedRepo === null) throw new Error('issueRepo 必须是 owner/repo 格式')
  const boardId = pick('intakeBoardId')
  if (boardId !== null && (typeof boardId !== 'string' || boardId === '')) throw new Error('intakeBoardId 必须是字符串')
  const maxActive = pick('maxActiveSessions')
  if (maxActive !== null && (!Number.isInteger(maxActive) || maxActive < 1)) {
    throw new Error('maxActiveSessions 必须是正整数或 null')
  }
  // Per-poll issue cap. null means "use the port default (100)". A small value
  // stops a busy upstream from flooding the board in one tick.
  const intakeLimit = pick('intakeLimit')
  if (intakeLimit !== null && (!Number.isInteger(intakeLimit) || intakeLimit < 1)) {
    throw new Error('intakeLimit 必须是正整数或 null')
  }
  // Optional per-project credential-key segment. When set, it is the id half of
  // `credentialKey('dsh-factory', githubCredentialId)` — a repo-scoped fallback
  // token. Validated against the host seam's segment grammar HERE, before any key
  // is built, so a bad id (uppercase / underscore / slash) fails with this exact
  // message. null means "use the project id as the segment". Not a token value.
  const credentialId = pick('githubCredentialId')
  if (credentialId !== null && !isCredentialKeySegment(credentialId)) {
    throw new Error(`githubCredentialId 必须是小写字母/数字/连字符且以字母开头：${String(credentialId)}`)
  }
  return { issueRepo: normalizedRepo, intakeBoardId: boardId, maxActiveSessions: maxActive, intakeLimit, githubCredentialId: credentialId, bindingReason: current.bindingReason ?? null,
    // A permission result belongs to one exact repo + identity check. Any
    // binding edit invalidates it until the full suite is run again.
    permissionStatus: 'issueRepo' in input ? null : (current.permissionStatus ?? null),
    permissionCheckedAt: 'issueRepo' in input ? null : (current.permissionCheckedAt ?? null),
    permissionReason: 'issueRepo' in input ? null : (current.permissionReason ?? null),
    permissionChecks: 'issueRepo' in input ? [] : (current.permissionChecks ?? []),
    permissionRepo: 'issueRepo' in input ? null : (current.permissionRepo ?? null),
  }
}

export function emptyState() {
  // `settings.worktreeRoot` is the global "worktrees root" (empty = use default).
  // It is read once at project creation and frozen onto the project; changing it
  // never moves an existing project's or card's worktree.
  // `settings.globalMaxActive` is the HTTP-writable global concurrency cap
  // (null = fall back to launch config, then built-in default). It lives in the
  // SAME settings row so a reload restores it, but is validated and written by
  // its own method so it can never overwrite worktreeRoot, or vice versa (P4 §3.3).
  return { schemaVersion: SCHEMA_VERSION, projects: [], boards: [], cards: [], events: [], settings: { worktreeRoot: '', globalMaxActive: null, githubClientId: '' } }
}

export class FactoryStore {
  /**
   * @param file - SQLite database file path (this is the store's own file).
   *   Each distinct path is an independent, fresh database — tests use a temp
   *   path per case for isolation. A new path starts as an empty store.
   */
  constructor({ file } = {}) {
    if (typeof file !== 'string' || file.trim() === '') throw new Error('FactoryStore 需要一个数据文件路径')
    this.file = file
    mkdirSync(dirname(this.file), { recursive: true })
    this.db = new DatabaseSync(this.file)
    this.db.exec('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL)')
    this._upsert = this.db.prepare('INSERT INTO state (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
    this._select = this.db.prepare('SELECT data FROM state WHERE id = 1')
    try {
      this.state = this._load()
      // v1 → v2 migrations are rewritten once on load so no old switch name or
      // level id survives in the stored state (or in a later read-back).
      if (this._needsMigration === true) {
        this._commit()
        this._needsMigration = false
      }
      // Idempotent, in-place convergence of legacy multi-board projects. Runs
      // BEFORE anything can read boards, and never bumps schemaVersion.
      this._convergeBoards()
    } catch (error) {
      // Do not leak an open handle on a failed construction — a retry must be
      // able to reopen the database immediately.
      try { this.db.close() } catch { /* best effort */ }
      throw error
    }
  }

  /** Read the single state row; a fresh database yields emptyState. */
  _load() {
    const row = this._select.get()
    if (row === undefined || typeof row.data !== 'string') return emptyState()
    return this._parseState(row.data)
  }

  /** Validate + normalise one serialised state (schemaVersion + nested settings). */
  _parseState(raw) {
    const parsed = JSON.parse(raw)
    if (parsed.schemaVersion !== 1 && parsed.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(`不支持的 schemaVersion：${parsed.schemaVersion}（期望 ${SCHEMA_VERSION}）`)
    }
    // A partial state lacks `settings` or `worktreeRoot`; keep the defaults.
    const base = emptyState()
    const state = { ...base, ...parsed, settings: { ...base.settings, ...(parsed.settings ?? {}) } }
    // Persist the new version even for an empty/already-conformant v1 archive;
    // otherwise every load would repeat normalization on an on-disk v1 state.
    if (parsed.schemaVersion !== SCHEMA_VERSION) this._needsMigration = true
    state.schemaVersion = SCHEMA_VERSION
    state.projects = (Array.isArray(state.projects) ? state.projects : []).map((p) => {
      const { autoStart, autoApprove, ...rest } = p
      const normalized = normalizeStoredAutonomy(p)
      if ('autoStart' in p || 'autoApprove' in p || p.autonomy !== normalized.autonomy || p.autoDispatch !== normalized.autoDispatch) {
        this._needsMigration = true
      }
      return { ...rest, ...normalized }
    })
    return state
  }

  /** Persist the whole state in one atomic upsert. */
  _commit() {
    this._upsert.run(JSON.stringify(this.state))
    return this.state
  }

  _project(id) {
    const project = this.state.projects.find((entry) => entry.id === id)
    if (project === undefined) throw new Error(`项目不存在：${id}`)
    return project
  }

  _activeBoards() {
    return (Array.isArray(this.state.boards) ? this.state.boards : []).filter((board) => board.archived !== true)
  }

  _board(id) {
    const board = this._activeBoards().find((entry) => entry.id === id)
    if (board === undefined) throw new Error(`看板不存在：${id}`)
    return board
  }

  _defaultBoard(project) {
    return {
      id: randomUUID(),
      projectId: project.id,
      name: DEFAULT_BOARD_NAME,
      kind: 'dev',
      columns: [...DEFAULT_COLUMNS],
      createdAt: new Date().toISOString(),
    }
  }

  /**
   * Legacy convergence: keep the first active board of every project, move all
   * cards from later boards into it, repoint intakeBoardId, and mark the extra
   * boards `archived` (retained in state, hidden from the store/API surface).
   * Projects without any board get a default one. No card or board is deleted,
   * and a second run is a no-op.
   */
  _convergeBoards() {
    if (!Array.isArray(this.state.projects) || !Array.isArray(this.state.boards)) return
    let changed = false
    for (const project of this.state.projects) {
      const owned = this.state.boards.filter((board) => board.projectId === project.id)
      // Prefer an existing active board; a previously archived first entry must
      // never become the survivor just because of its array position.
      const keep = owned.find((board) => board.archived !== true) ?? owned[0]
      if (keep === undefined) {
        this.state.boards.push(this._defaultBoard(project))
        changed = true
        continue
      }
      if (keep.archived === true) { keep.archived = false; changed = true }
      for (const extra of owned) {
        if (extra === keep || extra.archived === true) continue
        for (const card of this.state.cards ?? []) {
          if (card.boardId === extra.id) card.boardId = keep.id
        }
        if (project.intakeBoardId === extra.id) project.intakeBoardId = keep.id
        extra.archived = true
        changed = true
      }
      // Also heal an intake target that ALREADY points at an archived board
      // (e.g. a state written by an older build). A converged state has one
      // active board, so a second load finds nothing to change and skips _commit.
      if (project.intakeBoardId !== null && project.intakeBoardId !== keep.id
        && owned.some((board) => board.archived === true && board.id === project.intakeBoardId)) {
        project.intakeBoardId = keep.id
        changed = true
      }
    }
    if (changed) this._commit()
  }

  _card(id) {
    const card = this.state.cards.find((entry) => entry.id === id)
    if (card === undefined) throw new Error(`卡片不存在：${id}`)
    return card
  }

  // ---- global settings ----------------------------------------------------

  /** Raw saved worktrees-root string ('' = use default), plus its resolved form. */
  getWorktreeSettings() {
    const raw = typeof this.state.settings?.worktreeRoot === 'string' ? this.state.settings.worktreeRoot.trim() : ''
    return { worktreeRoot: raw, resolved: raw === '' ? defaultWorktreeRoot() : resolve(expandHome(raw)) }
  }

  /**
   * Set the global "worktrees root" used as the default for NEW projects.
   * Validated through the same hard gate as a per-project root (Plan B): an
   * empty string clears it (back to the default); a non-empty value must expand
   * to an allowed absolute path. Does not touch any existing project or card.
   */
  updateWorktreeRoot(value) {
    const raw = typeof value === 'string' ? value.trim() : ''
    if (raw !== '') assertWorktreeRoot(resolve(expandHome(raw)))
    this.state.settings = { ...(this.state.settings ?? {}), worktreeRoot: raw }
    this._commit()
    return this.getWorktreeSettings()
  }

  /** Effective default for a brand-new project: saved global root, or built-in. */
  defaultProjectWorktreeRoot() {
    return this.getWorktreeSettings().resolved
  }

  /**
   * Raw saved global concurrency cap. `null` means "not set": the engine then
   * falls back to launch config, then its built-in default. The effective value
   * and its source are resolved by autonomy.js (the single source of truth), so
   * the store only exposes what is persisted — never a derived number.
   */
  getGlobalMaxActiveSetting() {
    const raw = this.state.settings?.globalMaxActive
    return Number.isInteger(raw) && raw > 0 ? raw : null
  }

  /**
   * Set the global concurrency cap. Accepts a positive integer or null / ''
   * (clear → fall back to launch config). Written into `settings` alongside
   * worktreeRoot via a spread, so neither field can clobber the other. Validation
   * errors are thrown verbatim for the API to surface unchanged (P4 §3.3).
   */
  updateGlobalMaxActive(value) {
    const raw = value === null || value === undefined || value === '' ? null : value
    if (raw !== null && (!Number.isInteger(raw) || raw < 1)) {
      throw new Error('globalMaxActive 必须是正整数或 null')
    }
    this.state.settings = { ...(this.state.settings ?? {}), globalMaxActive: raw }
    this._commit()
    return { globalMaxActive: raw }
  }

  /**
   * The GitHub OAuth App client_id (P4-github). NON-secret by device-flow design —
   * it goes into settings so it is HTTP-writable and persisted like globalMaxActive,
   * NOT into a credential record. Empty string disables the global OAuth tier
   * without affecting any other tier. Never a token: stored verbatim, no masking.
   */
  getGithubClientIdSetting() {
    const raw = this.state.settings?.githubClientId
    return typeof raw === 'string' ? raw.trim() : ''
  }

  updateGithubClientId(value) {
    const raw = value === null || value === undefined ? '' : value
    if (typeof raw !== 'string') throw new Error('githubClientId 必须是字符串')
    const trimmed = raw.trim()
    this.state.settings = { ...(this.state.settings ?? {}), githubClientId: trimmed }
    this._commit()
    return { githubClientId: trimmed }
  }

  /** Browser-resolved display language mirrored by the Client, or '' when unset. */
  getUiLocaleSetting() {
    const raw = this.state.settings?.uiLocale
    return typeof raw === 'string' && raw !== '' ? raw : ''
  }

  /** Accept any BCP 47-style id (language packs may add new ones); '' clears it. */
  updateUiLocale(value) {
    const raw = typeof value === 'string' ? value.trim() : ''
    if (raw !== '' && !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(raw)) {
      throw new Error('uiLocale 必须是 BCP 47 风格的语言标识或空字符串')
    }
    this.state.settings = { ...(this.state.settings ?? {}), uiLocale: raw }
    this._commit()
    return { uiLocale: raw }
  }

  // ---- projects -----------------------------------------------------------

  listProjects() {
    return clone(this.state.projects)
  }

  getProject(id) {
    const project = this.state.projects.find((entry) => entry.id === id)
    return clone(project)
  }

  createProject(input = {}) {
    const name = reqString(input.name, 'name')
    const rootPath = reqString(input.rootPath, 'rootPath')
    const rootCheck = checkProjectRoot(rootPath)
    if (!rootCheck.ok) throw new Error(rootCheck.error)
    const worktreeRoot = input.worktreeRoot
      ? reqString(input.worktreeRoot, 'worktreeRoot')
      : this.defaultProjectWorktreeRoot()
    assertWorktreeRoot(worktreeRoot)
    const id = optionalString(input.id) || randomUUID()
    const board = this._defaultBoard({ id })
    // One-shot detection at creation time only: never re-read a remote later.
    // An explicitly supplied issueRepo wins and skips detection entirely.
    const intake = normalizeIntake(input)
    if (intake.issueRepo === null) {
      const detected = detectGithubRepo(rootPath)
      intake.issueRepo = detected.issueRepo
      intake.bindingReason = detected.reason
    } else {
      intake.bindingReason = null
    }
    // A bound project must also have a target board, or discovery still skips it.
    intake.intakeBoardId = board.id
    const project = {
      id,
      name,
      rootPath,
      repos: normalizeRepos(input.repos),
      defaultModel: optionalString(input.defaultModel),
      defaultPermission: optionalString(input.defaultPermission) || DEFAULT_PERMISSION,
      // P2a: work mode is a separate, persisted project setting. It does NOT
      // read or write `autonomy` / `autoDispatch` (L0–L4 remain orthogonal).
      workMode: normalizeWorkMode(input.workMode),
      worktreeRoot,
      ...normalizePreparation(input),
      // New projects always start manual; autonomy is an explicit later edit.
      ...normalizeAutonomy({}, {}),
      ...intake,
      // GitHub permission verification is opt-in until the full check runs.
      permissionStatus: intake.permissionStatus ?? null,
      permissionCheckedAt: intake.permissionCheckedAt ?? null,
      permissionReason: intake.permissionReason ?? null,
      permissionChecks: Array.isArray(intake.permissionChecks) ? intake.permissionChecks : [],
      permissionRepo: intake.permissionRepo ?? null,
      // Project-level pause gate. Persisted so a reload keeps the gate closed;
      // the engine checks it every tick rather than dropping the timer (PRD §8).
      paused: false,
      warning: rootCheck.warning ?? null,
      createdAt: new Date().toISOString(),
    }
    // Project and its default board are written in ONE transaction: a project
    // can never exist without its board, even if the process dies at commit.
    this.state.projects.push(project)
    this.state.boards.push(board)
    this._commit()
    return clone(project)
  }

  /**
   * Update a project's work mode. A separate write from autonomy/preparation:
   * these settings are orthogonal, so a form change can never move a tier.
   * `allowAutoReview=false` is what the HTTP layer passes while the
   * experimental plugin is unavailable (PRD §5.12 / AC33).
   */
  updateWorkMode(id, input = {}, { allowAutoReview = true } = {}) {
    const project = this._project(id)
    const next = normalizeWorkMode(input.workMode ?? input, project.workMode ?? DEFAULT_WORK_MODE)
    if (next === 'auto-review' && allowAutoReview !== true) {
      throw new Error('自动审查不可选：实验性插件未开启或不可用；本插件不代为开启')
    }
    if (next === project.workMode) return clone(project)
    const previous = project.workMode ?? DEFAULT_WORK_MODE
    project.workMode = next
    this.recordEvent({
      type: 'work-mode', scope: 'project', targetId: id, actor: 'human',
      decision: next, note: `workMode ${previous} → ${next}`,
    })
    this._commit()
    return clone(project)
  }

  /**
   * Record the reviewer's session WITHOUT touching `sessionId` — the builder
   * session must survive a review and remain the target of review→build.
   * `mode` is 'created' / 'reused' / 'recreated' and is kept in history.
   */
  setReviewSession(id, sessionId, mode = 'created') {
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('评审会话 ID 不能为空')
    const card = this._card(id)
    const previous = card.reviewSessionId ?? null
    card.reviewSessionId = sessionId
    card.history.push({
      type: 'review-session', from: previous, sessionId, mode,
      actor: 'autoRule', at: new Date().toISOString(),
    })
    // A freshly dispatched reviewer owns the current head; any earlier stale
    // mark is resolved by THIS session. Clear it on every dispatch path.
    this.clearReviewStale(id, `review-session ${mode}`)
    return clone(card)
  }

  /**
   * L4: flag that the current HEAD moved past the last structured verdict
   * (e.g. the engine auto-committed a dirty tree on entry to Review). Stores
   * WHICH head the verdict was on and WHICH head superseded it, so a later
   * verdict on the new head can clear the flag exactly. No error-string match.
   */
  markReviewStale(id, { previousReviewedHead = null, head = null } = {}) {
    const card = this._card(id)
    const at = new Date().toISOString()
    card.reviewStale = true
    card.reviewStaleInfo = {
      previousReviewedHead: optionalString(previousReviewedHead) || null,
      head: optionalString(head) || null, at,
    }
    card.history.push({ type: 'review-stale', ...card.reviewStaleInfo, at })
    this._commit()
    return clone(card)
  }

  /** Clear the stale verdict mark (audit the reason; idempotent). */
  clearReviewStale(id, reason = '') {
    const card = this._card(id)
    if (card.reviewStale !== true && card.reviewStaleInfo == null) return clone(card)
    const at = new Date().toISOString()
    card.history.push({
      type: 'review-stale-cleared', reason: optionalString(reason),
      previousReviewedHead: card.reviewStaleInfo?.previousReviewedHead ?? null, at,
    })
    card.reviewStale = false
    card.reviewStaleInfo = null
    this._commit()
    return clone(card)
  }

  /**
   * Update a project's worktree preparation config. Only these three fields are
   * mutable here: identity / paths / autonomy are intentionally left alone so a
   * settings form cannot silently retarget a project's repository.
   */
  updatePreparation(id, input = {}) {
    const project = this._project(id)
    const patch = normalizePreparation({
      copyFiles: input.copyFiles === undefined ? project.copyFiles : input.copyFiles,
      postCreate: input.postCreate === undefined ? project.postCreate : input.postCreate,
      postCreateTimeoutMs: input.postCreateTimeoutMs === undefined ? project.postCreateTimeoutMs : input.postCreateTimeoutMs,
    })
    Object.assign(project, patch)
    this._commit()
    return clone(project)
  }

  /**
   * Update a project's autonomy config. Identity and paths stay immutable here
   * for the same reason as `updatePreparation`: a settings write must never
   * retarget a project's repository. Values are validated, not silently
   * rewritten — see `normalizeAutonomy`.
   */
  updateAutonomy(id, input = {}) {
    const project = this._project(id)
    const patch = normalizeAutonomy(input, project)
    Object.assign(project, patch)
    this._commit()
    return clone(project)
  }

  /**
   * Update the opt-in intake config. A THIRD disjoint write, kept separate from
   * preparation and autonomy (api.js splits the PATCH shapes accordingly). Only
   * these three fields are mutable; identity / paths stay immutable.
   */
  updateIntake(id, input = {}) {
    const project = this._project(id)
    const patch = normalizeIntake(input, project)
    // A manual edit/clear resolves the old detection notice either way.
    if ('issueRepo' in input) patch.bindingReason = null
    Object.assign(project, patch)
    this._commit()
    return clone(project)
  }

  /**
   * Persist the result of a full, read-only GitHub capability check. Only the
   * check summary is stored — never a token. A repo change clears it via
   * updateIntake, so the badge cannot show a stale verification.
   */
  recordPermissionCheck(id, result, repo) {
    const project = this._project(id)
    const status = ['ok', 'insufficient', 'not-connected'].includes(result?.status) ? result.status : 'insufficient'
    const checks = Array.isArray(result?.checks)
      ? result.checks.map((c) => ({
          key: typeof c?.key === 'string' ? c.key : 'unknown',
          ok: c?.ok === true,
          reason: typeof c?.reason === 'string' ? c.reason : null,
        }))
      : []
    project.permissionStatus = status
    project.permissionReason = typeof result?.reason === 'string' && result.reason !== '' ? result.reason : null
    project.permissionCheckedAt = new Date().toISOString()
    project.permissionChecks = checks
    project.permissionRepo = typeof repo === 'string' && repo !== '' ? repo.trim() : null
    this._commit()
    return clone(project)
  }

  /** Set/unset the project pause gate. Returns the project; logs a governance event. */
  setProjectPaused(id, paused, actor = 'human') {
    const project = this._project(id)
    project.paused = paused === true
    // recordEvent persists the whole state (including project.paused) in one write.
    this.recordEvent({ type: 'engine-pause', scope: 'project', targetId: id, actor, decision: paused ? 'paused' : 'resumed' })
    return clone(project)
  }

  /**
   * Take a single card out of the engine's control (PRD §8 接管). Persisted on the
   * card (`takenOver`) so a reload cannot put it back on auto-dispatch. This is
   * deliberately per-card, never a project-wide pause.
   */
  takeOverCard(id, actor = 'human') {
    const card = this._card(id)
    card.takenOver = true
    card.history.push({ type: 'takeover', actor, at: new Date().toISOString() })
    // recordEvent persists both the card flag/history and the event in one write.
    this.recordEvent({ type: 'engine-takeover', scope: 'card', targetId: id, actor, decision: 'taken-over' })
    return clone(card)
  }

  /**
   * Give a taken-over card back to the engine. ONLY `takenOver` changes: an
   * active session / dispatch lock / worktree belongs to the running session and
   * is never touched (the autonomy gate already skips such cards).
   */
  releaseOverCard(id, actor = 'human') {
    const card = this._card(id)
    if (card.takenOver !== true) return clone(card)
    card.takenOver = false
    card.history.push({ type: 'returned-to-engine', actor, at: new Date().toISOString() })
    this.recordEvent({ type: 'engine-takeover', scope: 'card', targetId: id, actor, decision: 'returned-to-engine' })
    return clone(card)
  }

  /** Record a governance event on the state-wide stream (see collectAudit). */
  recordEvent({ type, scope, targetId = null, actor = 'autoRule', decision = type, rule = null, channel = null, tier = null, note = null } = {}) {
    const entry = { type, scope, targetId, actor, decision, rule, channel, tier, note, at: new Date().toISOString() }
    if (!Array.isArray(this.state.events)) this.state.events = []
    this.state.events.push(entry)
    this._commit()
    return clone(entry)
  }

  /** Delete a project and everything under it, leaving other projects untouched. */
  /**
   * Permanently delete a TERMINAL card (canceled / done). Deletion is
   * irreversible, so only terminal cards are eligible: a live card still has
   * a worktree / session / authorization trail and must go through cancel first.
   * The card body IS the board reference (cards are keyed by boardId), so
   * removing it from state.cards removes it from the board list with no separate
   * reference to clean. pendingAuthorization lives on the card and is cleared
   * before removal. Audit history is intentionally KEPT (targetId remains a
   * readable trace) — deleting audit events would erase evidence.
   */
  deleteCard(id, { actor = 'human' } = {}) {
    const card = this._card(id)
    if (!isTerminal(card.status)) {
      throw new Error(`仅终态卡可删除，当前 ${card.status}`)
    }
    this.recordEvent({
      type: 'card-deleted', scope: 'card', targetId: id, actor,
      decision: 'deleted', note: `deleted terminal card (${card.status})`,
    })
    card.pendingAuthorization = null
    this.state.cards = this.state.cards.filter((entry) => entry.id !== id)
    this._commit()
    return { deleted: true, id, status: card.status }
  }

  deleteProject(id) {
    this._project(id)
    const boardIds = new Set(this.state.boards.filter((b) => b.projectId === id).map((b) => b.id))
    this.state.projects = this.state.projects.filter((p) => p.id !== id)
    this.state.boards = this.state.boards.filter((b) => b.projectId !== id)
    this.state.cards = this.state.cards.filter((c) => c.projectId !== id && !boardIds.has(c.boardId))
    this._commit()
    return { id }
  }

  // ---- boards -------------------------------------------------------------

  listBoards(projectId) {
    const boards = projectId === undefined
      ? this._activeBoards()
      : this._activeBoards().filter((board) => board.projectId === projectId)
    return clone(boards)
  }

  getBoard(id) {
    const board = this._activeBoards().find((entry) => entry.id === id)
    return clone(board)
  }

  /**
   * Idempotent by design: every project already owns a board from creation, so
   * a repeated POST /boards (or a stale caller) returns the existing board
   * instead of creating a second one. `name` is required for API compatibility
   * but is ignored when the board already exists.
   */
  createBoard(input = {}) {
    const projectId = reqString(input.projectId, 'projectId')
    this._project(projectId)
    const existing = this._activeBoards().find((board) => board.projectId === projectId)
    if (existing !== undefined) return clone(existing)
    const board = {
      id: optionalString(input.id) || randomUUID(),
      projectId,
      name: reqString(input.name, 'name'),
      kind: optionalString(input.kind) || 'dev',
      columns: Array.isArray(input.columns) && input.columns.length > 0 ? [...input.columns] : [...DEFAULT_COLUMNS],
      createdAt: new Date().toISOString(),
    }
    this.state.boards.push(board)
    this._commit()
    return clone(board)
  }

  // ---- cards --------------------------------------------------------------

  listCards({ projectId, boardId, status } = {}) {
    const cards = this.state.cards.filter((card) => {
      if (projectId !== undefined && card.projectId !== projectId) return false
      if (boardId !== undefined && card.boardId !== boardId) return false
      if (status !== undefined && card.status !== status) return false
      return true
    })
    return clone(cards)
  }

  getCard(id) {
    const card = this.state.cards.find((entry) => entry.id === id)
    return clone(card)
  }

  createCard(input = {}) {
    const boardId = reqString(input.boardId, 'boardId')
    const board = this._board(boardId)
    const card = {
      id: optionalString(input.id) || randomUUID(),
      boardId,
      projectId: board.projectId,
      repo: optionalString(input.repo),
      // LOCAL filesystem path of the repository. Distinct from `repo`: `repo` is
      // the remote identifier (e.g. "owner/name", written by issue intake), while
      // `repoPath` is where the repo lives on disk. session-context reads
      // `repoPath`, never `repo` (ROADMAP §5 — they mean different things).
      repoPath: optionalString(input.repoPath),
      title: reqString(input.title, 'title'),
      body: typeof input.body === 'string' ? input.body : '',
      source: optionalString(input.source) || 'manual',
      status: STATUS.INBOX,
      sessionId: null,
      // P2b: set when a triage card is sent back because only a human can
      // supply missing information. The engine MUST skip such cards.
      needsHumanInfo: false,
      // P2a: the reviewer's session, distinct from the builder's sessionId.
      reviewSessionId: null,
      sessionTurn: 0,
      worktreePath: null,
      branch: null,
      baseBranch: null,
      prUrl: null,
      commitSha: null,
      commitMessage: null,
      // Latest structured review verdict (P1). null until a reviewer records
      // one; history keeps every verdict for audit / re-review.
      reviewVerdict: null,
      // L4: set true when the engine commits a new HEAD on a Review card whose
      // verdict is for an older HEAD. Drives the stale-notice + redispatch button
      // and the incremental re-review scope; cleared when the new head is
      // reviewed or the card leaves Review. Explicit boolean, never an error-string match.
      reviewStale: false,
      reviewStaleInfo: null,
      // P3: per-head auto-delivery state, arm→delivered/failed. Never a
      // standing permission; the code gate re-evaluates on every tick.
      autoDelivery: null,
      // Single-slot gate: set by a Review-time human authorization, consumed by
      // the matching git action. Its presence is what makes a git write legal.
      pendingAuthorization: null,
      // Set when a person takes this card out of the engine's control. Persisted
      // so a plugin reload cannot silently put it back on auto-dispatch (PRD §8).
      takenOver: false,
      // Concurrency lock token while a dispatch is in flight (see claimForDispatch).
      pendingDispatch: null,
      // Consecutive dispatch failures. Reset on a successful dispatch; a card
      // that reaches the limit is not re-dispatched automatically any more.
      dispatchFailures: 0,
      // Commit-stage failures at the L4 review entry, tracked SEPARATELY from
      // dispatchFailures so an inbox failure streak cannot stall the commit
      // stage (and vice versa). Own stalled flag; assertDispatchable only reads
      // the dispatch-stage `stalled`.
      commitFailures: 0,
      commitStalled: false,
      // L4: engine-initiated re-reviews used so far (lifetime cap AUTO_REREVIEW_LIMIT).
      // Manual redispatch never increments this.
      autoRereviewCount: 0,
      // Set when the automatic engine has stopped re-dispatching this card, so
      // the board can show why instead of silently doing nothing.
      stalled: false,
      usage: normalizeUsage(input.usage),
      // `origin` marks an auto-discovered card (issue intake) so the audit stream
      // can tell it from a card a person created. Human creates pass no origin.
      history: [{ type: 'created', to: STATUS.INBOX, ...auditFields(input.origin), at: new Date().toISOString() }],
      createdAt: new Date().toISOString(),
    }
    this.state.cards.push(card)
    this._commit()
    return clone(card)
  }

  /** Move a card along a legal edge, recording who did it (C3/C4 + audit). */
  transitionCard(id, to, actor, note = undefined, meta = undefined) {
    const card = this._card(id)
    if (!isStatus(to)) throw new Error(`未知状态：${to}`)
    assertTransition(card.status, to, actor)
    const from = card.status

    // P2b AC25-26: triage→inbox is a HARD boundary, not a UI convention.
    // Both the human button and the agent route go through this method, so a
    // reason is mandatory and all live traces are archived + cleared here.
    // Without this a returned card stays "already-dispatched" forever and the
    // engine would re-dispatch it with the stale session/worktree.
    if (from === STATUS.TRIAGE && to === STATUS.INBOX) {
      const reason = typeof note === 'string' ? note.trim() : ''
      if (reason === '') throw new Error('退回 Inbox 必须填写原因；请说明缺少什么信息')
      const at = new Date().toISOString()
      card.history.push({
        type: 'session-archived', sessionId: card.sessionId, worktreePath: card.worktreePath,
        branch: card.branch, baseBranch: card.baseBranch, reason, at,
      })
      card.sessionId = null
      card.worktreePath = null
      card.branch = null
      card.baseBranch = null
      card.pendingDispatch = null
      card.dispatchFailures = 0
      card.stalled = false
      card.needsHumanInfo = true
      card.history.push({ type: 'triage-return', actor, reason, at })
    }

    if (from === STATUS.REVIEW && to === STATUS.BUILD && actor === 'human' && note !== undefined) {
      // P2b bug fix: a human review→build WITH feedback is a structured return,
      // not just a status change. An explicitly empty note is refused here so
      // the generic transition route cannot bypass the mandatory opinion. A
      // missing note is the legacy bare approval used by existing callers.
      const text = typeof note === 'string' ? note.trim() : ''
      if (text === '') throw new Error('退回构建必须填写修改意见；builder 需要据此修改')
      card.history.push({
        type: 'human-review', actor: 'human', decision: 'return-to-build', text,
        head: card.reviewVerdict?.reviewedHead ?? null, prUrl: card.prUrl ?? null,
        at: new Date().toISOString(),
      })
    }
    if (from === STATUS.PLAN_REVIEW && to === STATUS.PLAN && actor === 'human') {
      // Same hard rule for plan returns. The synthetic rollback edge is
      // plan→plan-review with actor 'agent', so it is deliberately unaffected.
      const text = typeof note === 'string' ? note.trim() : ''
      if (text === '') throw new Error('退回修改计划必须填写修改意见；builder 需要据此重做')
      card.history.push({
        type: 'plan-feedback', actor: 'human', decision: 'return-to-plan', text, at: new Date().toISOString(),
      })
    }

    // A stale verdict only means something while the card sits in Review.
    if (from === STATUS.REVIEW) this.clearReviewStale(id, `left review to ${to}`)
    card.status = to
    card.history.push({ type: 'transition', from, to, actor, note: optionalString(note), ...auditFields(meta), at: new Date().toISOString() })
    this._commit()
    return clone(card)
  }

  /**
   * P2b AC28-30: clear the human-info gate AFTER a successful fresh dispatch.
   * The caller dispatches first with the resupply text in the first message; a
   * failure therefore leaves `needsHumanInfo` true and the card in Inbox.
   */
  resupplyInbox(id, { text } = {}) {
    const card = this._card(id)
    // The standard dispatch advances Inbox→Triage before this is called, so
    // both statuses are legal here; the flag itself proves it is a return.
    if (!(card.status === STATUS.INBOX || card.status === STATUS.TRIAGE)) {
      throw new Error(`补充信息仅用于退回后的卡片（当前 ${card.status}）`)
    }
    if (card.needsHumanInfo !== true) throw new Error('该卡不处于待补充信息状态')
    const body = reqString(text, '补充信息')
    const lastReturn = [...card.history].reverse().find((entry) => entry && entry.type === 'triage-return')
    const at = new Date().toISOString()
    card.history.push({
      type: 'inbox-resupply', actor: 'human', text: body,
      previousReason: typeof lastReturn?.reason === 'string' ? lastReturn.reason : null, at,
    })
    card.needsHumanInfo = false
    this._commit()
    return clone(card)
  }

  /** P3: record the machine's per-head delivery state + audit history. */
  setAutoDelivery(id, { head, state, error, actor = AUTO_DELIVERY_TIER } = {}) {
    const card = this._card(id)
    if (typeof head !== 'string' || head === '') throw new Error('自动交付状态缺少 head')
    const entry = { head, state, actor, at: new Date().toISOString() }
    if (typeof error === 'string' && error !== '') entry.error = error
    card.autoDelivery = entry
    card.history.push({ type: 'auto-delivery', ...entry, tier: AUTO_DELIVERY_TIER })
    this._commit()
    return clone(card)
  }

  /**
   * Record a human authorization event (§9.4). The two delivery buttons and the
   * escalation are only meaningful from Review — except escalation, which has no
   * status gate but still leaves an audit record. Returns the audit entry.
   */
  authorize(id, action) {
    const allowed = { 'confirm-commit': true, 'create-pr': true, 'push-existing': true, escalate: false }
    if (!Object.prototype.hasOwnProperty.call(allowed, action)) throw new Error(`未知授权动作：${action}`)
    const card = this._card(id)
    if (allowed[action] && card.status !== STATUS.REVIEW) {
      throw new Error(`「${action}」仅 Review 状态可执行（当前 ${card.status}）`)
    }
    const entry = {
      type: 'authorize',
      action,
      actor: 'human',
      at: new Date().toISOString(),
      statusSnapshot: card.status,
    }
    // Arm the gate for the matching git action. Consumed when that action runs,
    // so a click authorizes exactly one commit / one PR, never a standing licence.
    card.pendingAuthorization = { action, actor: 'human', at: entry.at, statusSnapshot: card.status }
    card.history.push(entry)
    this._commit()
    return clone(entry)
  }

  /** Whether a matching, still-unconsumed human authorization is armed on the card. */
  hasPendingAuthorization(id, action) {
    const card = this._card(id)
    return card.status === STATUS.REVIEW
      && card.pendingAuthorization !== null
      && card.pendingAuthorization.action === action
  }

  /**
   * Record a commit that an authorized `confirm-commit` performed. Stores the sha
   * + message, clears the pending authorization, and logs the audit entry.
   */
  recordCommit(id, { sha, message, actor = 'human' } = {}) {
    const card = this._card(id)
    card.commitSha = reqString(sha, 'sha')
    card.commitMessage = typeof message === 'string' ? message : ''
    card.pendingAuthorization = null
    card.history.push({ type: 'commit', sha: card.commitSha, message: card.commitMessage, actor, at: new Date().toISOString() })
    this._commit()
    return clone(card)
  }

  /**
   * Record that a PR was created. Only valid from Review, and the card *stays*
   * in Review (D6): Done remains a separate human decision.
   */
  setPrUrl(id, prUrl, actor = 'human') {
    const card = this._card(id)
    if (card.status !== STATUS.REVIEW) throw new Error(`仅 Review 状态可写回 PR（当前 ${card.status}）`)
    card.prUrl = reqString(prUrl, 'prUrl')
    card.pendingAuthorization = null
    card.history.push({ type: 'pr-created', prUrl: card.prUrl, staysAt: PR_SUCCESS_STAYS, actor, at: new Date().toISOString() })
    this._commit()
    return clone(card)
  }

  /** P2b AC18: the mandatory human reason for a review→build return. */
  recordHumanReview(id, { decision, text, actor = 'human' } = {}) {
    const card = this._card(id)
    if (card.status !== STATUS.REVIEW) throw new Error(`人工评审记录仅 Review 可写（当前 ${card.status}）`)
    const body = reqString(text, '修改意见')
    const entry = {
      type: 'human-review', actor, decision: reqString(decision, 'decision'), text: body,
      head: card.reviewVerdict?.reviewedHead ?? null, prUrl: card.prUrl ?? null, at: new Date().toISOString(),
    }
    card.history.push(entry)
    this._commit()
    return clone(entry)
  }

  /** P2b AC22: the mandatory human reason for a plan-review→plan return. */
  recordPlanFeedback(id, { text, actor = 'human' } = {}) {
    const card = this._card(id)
    if (card.status !== STATUS.PLAN_REVIEW) throw new Error(`计划修改意见仅 Plan-review 可写（当前 ${card.status}）`)
    const entry = {
      type: 'plan-feedback', actor, decision: 'return-to-plan', text: reqString(text, '修改意见'), at: new Date().toISOString(),
    }
    card.history.push(entry)
    this._commit()
    return clone(entry)
  }

  /**
   * Record a non-force push that UPDATED an existing draft PR. Deliberately
   * separate from setPrUrl: it never creates a PR and never rewrites prUrl.
   */
  recordPushUpdate(id, { prUrl, sha, actor = 'human' } = {}) {
    const card = this._card(id)
    if (card.status !== STATUS.REVIEW) throw new Error(`仅 Review 状态可记录 PR 更新（当前 ${card.status}）`)
    if (typeof card.prUrl !== 'string' || card.prUrl === '') throw new Error('该卡没有已有 PR，不能记录 push-existing')
    card.pendingAuthorization = null
    card.history.push({
      type: 'push-existing', actor, prUrl: card.prUrl,
      sha: typeof sha === 'string' ? sha : card.commitSha,
      at: new Date().toISOString(),
    })
    this._commit()
    return clone(card)
  }

  /**
   * Append a free-text report to a card's history — the write-back path an agent
   * session (or a human) uses to say what it did. Returns the running report count.
   */
  appendReport(id, report, actor = 'agent') {
    const card = this._card(id)
    const body = reqString(report, 'report')
    card.history.push({ type: 'report', actor, body, at: new Date().toISOString() })
    const count = card.history.filter((entry) => entry.type === 'report').length
    this._commit()
    return { count }
  }

  /**
   * P1: write a free-text report AND the structured verdict in one commit.
   *
   * Idempotency is keyed by (reviewedHead, reviewerSessionId): the SAME reviewer
   * re-submitting the SAME head adds no second verdict, but a DIFFERENT session
   * (e.g. the independent reviewer following a builder that wrote early) is a
   * genuine new conclusion and must land — otherwise the builder's self-review
   * would silently win by arrival order. Every verdict stays in history; the
   * mirror holds the latest accepted one.
   *
   * A dirty worktree does not change reviewedHead: it names the committed tree
   * that was reviewed, so unsaved edits cannot be laundered into an approval.
   */
  appendReportWithVerdict(id, report, verdict, actor = 'agent') {
    const card = this._card(id)
    const body = reqString(report, 'report')
    const canonical = normalizeVerdict(verdict, { reviewedHead: verdict?.reviewedHead })
    const at = new Date().toISOString()
    const previous = card.reviewVerdict ?? null
    const idempotent = previous !== null
      && previous.reviewedHead === canonical.reviewedHead
      && previous.reviewerSessionId === canonical.reviewerSessionId

    card.history.push({ type: 'report', actor, body, at })
    if (!idempotent) {
      card.history.push({ type: 'verdict', actor, ...canonical, at })
      card.reviewVerdict = { ...canonical, recordedBy: actor, recordedAt: at }
    }
    // A verdict recorded on the head that had gone stale resolves the mark.
    // A verdict still on the old head does not.
    if (card.reviewStale === true && card.reviewStaleInfo?.head === canonical.reviewedHead) {
      this.clearReviewStale(id, 'verdict on new head')
    }
    const count = card.history.filter((entry) => entry.type === 'report').length
    this._commit()
    return { count, idempotent, verdict: card.reviewVerdict }
  }

  /**
   * Record the worktree and branch a dispatch created for a card, plus (when
   * known) the session id, so the card and its session stay linked across reload.
   */
  setWorktree(id, { worktreePath, branch, baseBranch, sessionId } = {}) {
    const card = this._card(id)
    if (worktreePath !== undefined) card.worktreePath = worktreePath
    if (branch !== undefined) card.branch = branch
    if (baseBranch !== undefined) card.baseBranch = baseBranch
    if (sessionId !== undefined) { card.sessionId = sessionId; card.sessionTurn = (card.sessionTurn ?? 0) + 1 }
    // A completed dispatch clears the concurrency claim in the same sync write.
    card.pendingDispatch = null
    card.history.push({ type: 'dispatch', worktreePath: card.worktreePath, branch: card.branch, sessionId: card.sessionId, at: new Date().toISOString() })
    this._commit()
    return clone(card)
  }

  /**
   * Atomically reserve a card for dispatch — the concurrency lock (#9).
   *
   * Two distinct guards, deliberately kept separate:
   *
   *  - `pendingDispatch` is the CONCURRENCY lock. Dispatch is async (it awaits
   *    session creation), so a plain "check then create" has a race window: two
   *    callers both see null and both spawn a session. Every store mutation here
   *    is synchronous (in-memory + atomic file rename) and this runs before the
   *    first await, so the claim is atomic within this process — the first caller
   *    arms `pendingDispatch`, the second is refused as `busy`. (One plugin
   *    process owns the store; cross-process locking is out of scope.)
   *
   *  - A non-empty `sessionId` is NOT a refusal any more. It used to be, which
   *    made a card dispatchable exactly once in its lifetime and deadlocked every
   *    later stage (a session ends when its turn ends; the next stage then had no
   *    way in). It now only records "who did the last turn".
   *
   * Whether a live session still occupies the card is a runtime fact only the
   * host knows, and it is NOT a claim-level refusal: a live session is exactly
   * what a continuation wants to reuse. `continueCard` therefore decides with
   * `port.isSessionActive()` whether to reuse it (and never to open a second one
   * while it lives) — see that function for the rule.
   */
  claimForDispatch(id) {
    const card = this._card(id)
    if (card.pendingDispatch !== null && card.pendingDispatch !== undefined) {
      return { claimed: false, reason: 'busy' }
    }
    const token = randomUUID()
    card.pendingDispatch = token
    this._commit()
    return { claimed: true, token }
  }

  /**
   * Record one dispatch attempt that failed. Consecutive failures arm the
   * circuit breaker so a card that keeps breaking is not re-dispatched forever.
   * `sessionTurn` is deliberately untouched here: it counts successful turns.
   */
  recordDispatchFailure(id, { reason = '', limit = DEFAULT_DISPATCH_FAILURE_LIMIT } = {}) {
    const card = this._card(id)
    card.dispatchFailures = (card.dispatchFailures ?? 0) + 1
    const tripped = card.dispatchFailures >= limit
    if (tripped) card.stalled = true
    card.history.push({
      type: 'dispatch-failed',
      attempt: card.dispatchFailures,
      reason: optionalString(reason),
      tripped,
      at: new Date().toISOString(),
    })
    this._commit()
    return { failures: card.dispatchFailures, tripped }
  }

  /**
   * Record that a continuation obtained a session, and how. `mode` is the level
   * of the fallback chain that answered: 'followup' | 'resumed' | 'created'.
   */
  recordContinuation(id, { sessionId, mode } = {}) {
    const card = this._card(id)
    card.history.push({
      type: 'continuation',
      sessionId: optionalString(sessionId),
      mode: optionalString(mode) || 'unknown',
      at: new Date().toISOString(),
    })
    this._commit()
    return clone(card)
  }

  /**
   * Record that a continuation could not rebuild the previous session and fell
   * back to a fresh one. This is a hard requirement, not diagnostics: without it
   * "the agent suddenly does not know the context" becomes an unexplainable bug.
   */
  recordContinuationFallback(id, { from, reason = '' } = {}) {
    const card = this._card(id)
    card.history.push({
      type: 'continuation-fallback',
      fromSessionId: optionalString(from),
      reason: optionalString(reason),
      at: new Date().toISOString(),
    })
    this._commit()
    return clone(card)
  }

  /** Record one L4 review-entry commit failure with its own bounded budget. */
  recordCommitFailure(id, { reason = '', limit = DEFAULT_DISPATCH_FAILURE_LIMIT } = {}) {
    const card = this._card(id)
    card.commitFailures = (card.commitFailures ?? 0) + 1
    const tripped = card.commitFailures >= limit
    if (tripped) card.commitStalled = true
    card.history.push({
      type: 'commit-failed',
      attempt: card.commitFailures,
      reason: optionalString(reason),
      tripped,
      at: new Date().toISOString(),
    })
    this._commit()
    return { failures: card.commitFailures, tripped }
  }

  /** Clear only the commit-stage failure streak (dispatch streak untouched). */
  clearCommitFailures(id) {
    const card = this._card(id)
    card.commitFailures = 0
    card.commitStalled = false
    this._commit()
    return clone(card)
  }

  /** Count ONE engine-initiated re-review attempt (audit + cap enforcement). */
  recordAutoRereview(id) {
    const card = this._card(id)
    const at = new Date().toISOString()
    card.autoRereviewCount = (card.autoRereviewCount ?? 0) + 1
    card.history.push({ type: 'auto-rereview', count: card.autoRereviewCount, actor: 'autoRule', at })
    this._commit()
    return clone(card)
  }

  /** Clear the failure streak after a dispatch succeeded. */
  clearDispatchFailures(id) {
    const card = this._card(id)
    card.dispatchFailures = 0
    card.stalled = false
    this._commit()
    return clone(card)
  }

  /** Release a dispatch claim after a failure so the card can be retried. */
  releaseClaim(id, token) {
    const card = this._card(id)
    if (card.pendingDispatch === token) {
      card.pendingDispatch = null
      this._commit()
    }
    return { id, released: card.pendingDispatch === null || card.pendingDispatch === undefined }
  }

  /** Record a remote-driven status suggestion that needs a human to apply. */
  recordSyncSuggestion(id, suggestion = {}) {
    const card = this._card(id)
    card.history.push({
      type: 'sync-suggestion',
      target: suggestion.target ?? null,
      reason: suggestion.reason ?? null,
      requiresHuman: suggestion.requiresHuman === true,
      at: new Date().toISOString(),
    })
    this._commit()
    return clone(card)
  }

  /** The card a session is currently working on, if any. */
  findCardBySession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    const card = this.state.cards.find((entry) => entry.sessionId === sessionId)
    return clone(card)
  }
}
