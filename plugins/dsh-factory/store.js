/**
 * dsh-factory — three-layer store: Project → Board → Card (PRD §7).
 *
 * Zero-dependency JSON persistence: one file, `schemaVersion` stamped, writes
 * are atomic (temp file + rename) so a crash mid-write cannot leave a half file
 * that fails to parse. This is deliberately a plain file, not SQLite — the PRD
 * defers that switch to a data-size threshold.
 *
 * The store owns *state* and the two safety invariants that do not belong in a
 * route handler:
 *   - every status change goes through `state.js` (so an agent cannot reach Done);
 *   - PR creation and the two approval buttons are only recorded from Review
 *     (AG-2 / §9.4) and leave an audit record (actor + time + status snapshot, D4).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

import { assertTransition, PR_SUCCESS_STAYS, STATUS, isStatus } from './state.js'
import { DEFAULT_WORKTREE_ROOT, assertWorktreeRoot, checkProjectRoot } from './worktree.js'

export const SCHEMA_VERSION = 1

export const DEFAULT_PERMISSION = 'workspace-write'
export const DEFAULT_AUTONOMY = 'L0'
export const DEFAULT_COLUMNS = ['planning', 'awaiting-approval', 'building', 'review', 'done']

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

export function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, projects: [], boards: [], cards: [] }
}

export class FactoryStore {
  constructor({ file }) {
    if (typeof file !== 'string' || file.trim() === '') throw new Error('FactoryStore 需要一个数据文件路径')
    this.file = file
    this.state = this._load()
  }

  _load() {
    if (!existsSync(this.file)) return emptyState()
    const raw = readFileSync(this.file, 'utf8').trim()
    if (raw === '') return emptyState()
    const parsed = JSON.parse(raw)
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(`不支持的 schemaVersion：${parsed.schemaVersion}（期望 ${SCHEMA_VERSION}）`)
    }
    return { ...emptyState(), ...parsed }
  }

  _commit() {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
    renameSync(tmp, this.file)
    return this.state
  }

  _project(id) {
    const project = this.state.projects.find((entry) => entry.id === id)
    if (project === undefined) throw new Error(`项目不存在：${id}`)
    return project
  }

  _board(id) {
    const board = this.state.boards.find((entry) => entry.id === id)
    if (board === undefined) throw new Error(`看板不存在：${id}`)
    return board
  }

  _card(id) {
    const card = this.state.cards.find((entry) => entry.id === id)
    if (card === undefined) throw new Error(`卡片不存在：${id}`)
    return card
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
    const worktreeRoot = input.worktreeRoot ? reqString(input.worktreeRoot, 'worktreeRoot') : DEFAULT_WORKTREE_ROOT
    assertWorktreeRoot(worktreeRoot)
    const project = {
      id: optionalString(input.id) || randomUUID(),
      name,
      rootPath,
      repos: normalizeRepos(input.repos),
      defaultModel: optionalString(input.defaultModel),
      defaultPermission: optionalString(input.defaultPermission) || DEFAULT_PERMISSION,
      worktreeRoot,
      autonomy: input.autonomy === 'L1' || input.autonomy === 'L2' ? input.autonomy : DEFAULT_AUTONOMY,
      autoStart: input.autoStart === true,
      autoApprove: input.autoApprove === true,
      warning: rootCheck.warning ?? null,
      createdAt: new Date().toISOString(),
    }
    this.state.projects.push(project)
    this._commit()
    return clone(project)
  }

  /** Delete a project and everything under it, leaving other projects untouched. */
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
      ? this.state.boards
      : this.state.boards.filter((board) => board.projectId === projectId)
    return clone(boards)
  }

  getBoard(id) {
    const board = this.state.boards.find((entry) => entry.id === id)
    return clone(board)
  }

  createBoard(input = {}) {
    const projectId = reqString(input.projectId, 'projectId')
    this._project(projectId)
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
      title: reqString(input.title, 'title'),
      body: typeof input.body === 'string' ? input.body : '',
      source: optionalString(input.source) || 'manual',
      status: STATUS.INBOX,
      sessionId: null,
      sessionTurn: 0,
      worktreePath: null,
      branch: null,
      baseBranch: null,
      prUrl: null,
      commitSha: null,
      commitMessage: null,
      // Single-slot gate: set by a Review-time human authorization, consumed by
      // the matching git action. Its presence is what makes a git write legal.
      pendingAuthorization: null,
      // Concurrency lock token while a dispatch is in flight (see claimForDispatch).
      pendingDispatch: null,
      usage: normalizeUsage(input.usage),
      history: [{ type: 'created', to: STATUS.INBOX, at: new Date().toISOString() }],
      createdAt: new Date().toISOString(),
    }
    this.state.cards.push(card)
    this._commit()
    return clone(card)
  }

  /** Move a card along a legal edge, recording who did it (C3/C4 + audit). */
  transitionCard(id, to, actor, note = undefined) {
    const card = this._card(id)
    if (!isStatus(to)) throw new Error(`未知状态：${to}`)
    assertTransition(card.status, to, actor)
    const from = card.status
    card.status = to
    card.history.push({ type: 'transition', from, to, actor, note: optionalString(note), at: new Date().toISOString() })
    this._commit()
    return clone(card)
  }

  /**
   * Record a human authorization event (§9.4). The two delivery buttons and the
   * escalation are only meaningful from Review — except escalation, which has no
   * status gate but still leaves an audit record. Returns the audit entry.
   */
  authorize(id, action) {
    const allowed = { 'confirm-commit': true, 'create-pr': true, escalate: false }
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
  recordCommit(id, { sha, message } = {}) {
    const card = this._card(id)
    card.commitSha = reqString(sha, 'sha')
    card.commitMessage = typeof message === 'string' ? message : ''
    card.pendingAuthorization = null
    card.history.push({ type: 'commit', sha: card.commitSha, message: card.commitMessage, actor: 'human', at: new Date().toISOString() })
    this._commit()
    return clone(card)
  }

  /**
   * Record that a PR was created. Only valid from Review, and the card *stays*
   * in Review (D6): Done remains a separate human decision.
   */
  setPrUrl(id, prUrl) {
    const card = this._card(id)
    if (card.status !== STATUS.REVIEW) throw new Error(`仅 Review 状态可写回 PR（当前 ${card.status}）`)
    card.prUrl = reqString(prUrl, 'prUrl')
    card.pendingAuthorization = null
    card.history.push({ type: 'pr-created', prUrl: card.prUrl, staysAt: PR_SUCCESS_STAYS, at: new Date().toISOString() })
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
   * Dispatch is async (it awaits session creation), so a plain "check sessionId
   * then create" has a race window: two callers both see null and both spawn a
   * session. Every store mutation here is synchronous (in-memory + atomic file
   * rename) and this runs before the first await, so the claim is atomic within
   * this process — the first caller arms `pendingDispatch`, the second is refused
   * as busy. (One plugin process owns the store; cross-process locking is out of
   * scope.)
   */
  claimForDispatch(id) {
    const card = this._card(id)
    if (typeof card.sessionId === 'string' && card.sessionId !== '') {
      return { claimed: false, reason: 'already-dispatched', sessionId: card.sessionId }
    }
    if (card.pendingDispatch !== null && card.pendingDispatch !== undefined) {
      return { claimed: false, reason: 'busy' }
    }
    const token = randomUUID()
    card.pendingDispatch = token
    this._commit()
    return { claimed: true, token }
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
