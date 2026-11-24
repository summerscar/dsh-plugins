/**
 * dsh-factory — model-facing tools (the "operation" layer).
 *
 * Pure specs in the shape `defineTool` accepts (name / description / parameters
 * DSL / output { schema, render } / execute). `index.js` turns each into a host
 * tool with `ctx.tools.register(defineTool(spec))`. Nothing here imports a host
 * package, so every handler is unit-tested without a running Host; the DSL
 * matches @deepseek-ai/dsh-tools 0.2.2 (ParameterSchemaSpec property map +
 * ValueSchemaSpec output, whose object nodes require an explicit
 * `additionalProperties`).
 *
 * The transition tool always acts as the `agent` actor, and never offers `done`.
 * That is belt-and-braces: `state.js` already refuses an agent moving a card into
 * Done or approving a plan, so the same check that guards the UI guards the model.
 */
import { STATUSES } from './state.js'
import { WORK_MODES } from './store.js'
import { assertRepoRoot, inspectRepo } from './project-proposal.js'
import { defaultLsFilesPort, dropTrackedCopyFiles } from './worktree-setup.js'
import { precheckReceipt } from './receipt.js'
import { isFullSha, normalizeVerdict, reviewedHeadFor, VERDICT_SOURCES, VERDICT_VALUES } from './verdict.js'
import { isProtectedBranch } from './git-exec.js'

const AGENT_TARGETS = ['inbox', 'triage', 'plan', 'build', 'self-review', 'pr-review', 'canceled']
const ATTENTION_STATUSES = ['inbox', 'self-review', 'pr-review']
// V4: stage rules replace L0–L4. Work mode remains a permission boundary.
export function resolveAddProjectSettings({ workMode } = {}) {
  const mode = workMode === undefined || workMode === null || workMode === '' ? 'workspace-write' : workMode
  if (!WORK_MODES.includes(mode)) throw new Error(`未知工作模式：${mode}（可选 ${WORK_MODES.join(' / ')}）`)
  return { workMode: mode, phaseRules: undefined }
}

const stringArray = () => ({ type: 'array', items: { type: 'string' } })

// Host contract: `output.render(args, value)` must return `ContentBlock[]`. A bare
// string becomes the tool result's `content`, and the host then calls `.some()` on
// it while checking for images — every tool call fails at that point. One text
// block keeps the original display text and satisfies the contract.
const textBlock = (text) => [{ type: 'text', text }]

// A card summary is a closed object (no extra keys), so every object schema below
// sets `additionalProperties: false` — the schema compiler rejects an open default.
const CARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { id: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' } },
}
const cardsArray = () => ({ type: 'array', items: CARD_SCHEMA })
const cardsListSchema = (key) => ({ type: 'object', additionalProperties: false, properties: { [key]: cardsArray() } })

export function factoryToolSpecs({ store, inspect = inspectRepo, assertRoot = assertRepoRoot, lsFilesPort = defaultLsFilesPort(), receiptPorts = {}, readHead, buildGitPortFor, isSessionActive, closePrFor } = {}) {
  if (store === undefined || store === null) throw new Error('factoryToolSpecs needs a store')

  // Per-session, per-card, per-target counter for no-op transitions. An agent
  // stuck in a loop calling `to` == current status must be told to stop, not fed
  // an error it will retry. Keyed by agent id (session) when the host supplies
  // `exec`, with a sessionless fallback so pure unit tests still work. The Map
  // lives in this factory's closure, so each test/get of specs starts clean.
  const noopTransitions = new Map()
  const noopKey = (exec, cardId, to) => `${exec?.agent?.id ?? '__sessionless__'}:${cardId}:${to}`

  // Shared receipt definitions: the SAME schema + render object is used by the
  // tool output and by the pre-write precheck, so the two can never drift (PRD §3.2).
  const TRANSITION_OUTPUT = {
    schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, status: { type: 'string' }, notice: { type: 'string' } } },
    render: (args, value) => textBlock(value.notice ?? `Card ${value.id} is now ${value.status}.`),
  }
  const REPORT_OUTPUT = {
    schema: {
      type: 'object', additionalProperties: false,
      properties: { id: { type: 'string' }, reports: { type: 'integer' }, verdict: { type: 'string', enum: [...VERDICT_VALUES] } },
    },
    render: (args, value) => textBlock([
      `Recorded a report on ${value.id} (${value.reports} total).`,
      ...(value.verdict ? [`Verdict ${value.verdict} recorded.`] : []),
    ].join('\n')),
  }
  const PUSH_OUTPUT = {
    schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, sha: { type: 'string' }, prUrl: { type: 'string' }, notice: { type: 'string' } } },
    render: (args, value) => textBlock(value.notice),
  }
  const VERDICT_OUTPUT = {
    schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, verdict: { type: 'string' }, head: { type: 'string' }, rounds: { type: 'integer' } } },
    render: (args, value) => textBlock(`Self-review ${value.verdict} recorded on ${value.id} at ${value.head} (round ${value.rounds}).`),
  }
  const PR_OUTPUT = {
    schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, url: { type: 'string' }, head: { type: 'string' }, notice: { type: 'string' } } },
    render: (args, value) => textBlock(value.notice),
  }
  const sessionIdOf = (exec) => exec?.agent?.session?.id ?? exec?.agent?.id
  const requireBuilderSession = (card, exec, action) => {
    const fromExec = sessionIdOf(exec)
    if (typeof fromExec !== 'string' || fromExec === '' || fromExec !== card.sessionId) {
      throw new Error(`${action}只能由本卡的 builder 会话执行`)
    }
  }
  const CREATE_OUTPUT = {
    schema: {
      type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        warning: { type: 'string' },
        droppedCopyFiles: { type: 'array', items: { type: 'string' } },
      },
    },
    render: (args, value) => textBlock([
      `Created project ${value.name} (${value.id}).`,
      ...(value.warning ? [`Warning: ${value.warning}`] : []),
      ...(value.droppedCopyFiles?.length
        ? [`Dropped from copyFiles (already tracked by git, so a new worktree has them): ${value.droppedCopyFiles.join(', ')}`]
        : []),
    ].join('\n')),
  }
  const precheck = (name, output, args, value) => precheckReceipt({
    name, schema: output.schema, render: output.render, args, value, ports: receiptPorts,
  })

  return [
    {
      name: 'factory_list_work_items',
      description: 'List factory cards (work items), optionally filtered by project, board or status. Use it to see what is on the board before acting.',
      parameters: {
        projectId: { type: 'string', description: 'Restrict to one project id.' },
        boardId: { type: 'string', description: 'Restrict to one board id.' },
        status: { type: 'string', description: `Restrict to one status: ${STATUSES.join(', ')}.` },
      },
      output: {
        schema: cardsListSchema('cards'),
        render: (args, value) => textBlock(value.cards.length === 0
          ? 'No cards.'
          : value.cards.map((card) => `- ${card.id} [${card.status}] ${card.title}`).join('\n')),
      },
      execute: async (args = {}) => {
        const cards = store.listCards({ projectId: args.projectId, boardId: args.boardId, status: args.status })
        return { cards: cards.map((card) => ({ id: card.id, title: card.title, status: card.status })) }
      },
    },
    {
      name: 'factory_transition_work_item',
      description: 'Move a card between V4 stages. Builder advances triage→plan→build→self-review; the reviewer returns changes to build or advances an approved head to pr-review. Done is syncRule-only.',
      parameters: {
        cardId: { type: 'string', required: true, description: 'Card id.' },
        to: { type: 'string', required: true, enum: AGENT_TARGETS, description: 'Target status.' },
        note: { type: 'string', description: 'Short reason, recorded in the card log.' },
      },
      output: TRANSITION_OUTPUT,
      execute: async (args, exec) => {
        const card = store.getCard(args.cardId)
        const liveSessionId = exec?.agent?.session?.id ?? exec?.agent?.id
        if (card !== undefined && card !== null && typeof liveSessionId === 'string'
          && card.reviewSessionId === liveSessionId
          && !(card.status === 'self-review' && ['build', 'pr-review'].includes(args.to))) {
          throw new Error('评审会话只能在 self-review 退回 build 或从批准 head 进入 pr-review')
        }
        if (card !== undefined && card !== null && card.status === 'self-review' && args.to === 'pr-review') {
          if (typeof card.prUrl !== 'string' || card.prUrl === '') throw new Error('没有草稿 PR，不能进入 pr-review')
          const live = typeof readHead === 'function' ? readHead({ worktreePath: card.worktreePath }) : null
          if (!isFullSha(live) || live !== card.prHead) {
            if (typeof closePrFor === 'function') await closePrFor(card)
            throw new Error(`批准 head 已漂移，误开的 PR 已关闭（${card.prHead} ≠ ${live}）`)
          }
        }
        if (card !== undefined && card !== null && card.status === args.to) {
          // Idempotent no-op: never throw the "illegal transition" error that an
          // agent reads as "I did it wrong, retry". After two repeats, say so
          // plainly so the loop cannot keep burning tokens on the same call.
          const key = noopKey(exec, args.cardId, args.to)
          const seen = (noopTransitions.get(key) ?? 0) + 1
          noopTransitions.set(key, seen)
          const notice = seen > 2
            ? `Card ${args.cardId} is already ${args.to}. You have repeated this call ${seen} times — STOP calling factory_transition_work_item for this card and report your current status with factory_report instead.`
            : `Card ${args.cardId} is already ${args.to}; no transition needed. Do NOT repeat this call — do the work this stage requires instead.`
          // Precheck the exact value the host will receipt, before returning it.
          precheck('factory_transition_work_item', TRANSITION_OUTPUT, args, { id: args.cardId, status: args.to, notice })
          return { id: args.cardId, status: args.to, notice }
        }
        // A real state change resets the no-op counter for this card/target.
        // Precheck the value BEFORE the write; if the receipt would fail, throw
        // here so the store is never touched (write/receipt window closed).
        const next = { id: args.cardId, status: args.to }
        precheck('factory_transition_work_item', TRANSITION_OUTPUT, args, next)
        store.transitionCard(args.cardId, args.to, 'agent', args.note)
        noopTransitions.delete(noopKey(exec, args.cardId, args.to))
        return next
      },
    },
    {
      name: 'factory_report',
      description: 'Write a progress or result report back onto a card, so the board and the human see what the session did. Reviewers pass the structured verdict fields as well; reviewedHead is always computed from git by the backend, never from the arguments.',
      parameters: {
        cardId: { type: 'string', required: true, description: 'Card id.' },
        report: { type: 'string', required: true, description: 'The human-readable report text.' },
        source: { type: 'string', enum: [...VERDICT_SOURCES], description: 'Verdict source: review (self-review), rereview (self-review follow-up), or pr-review (independent PR review). Required together with the other verdict fields.' },
        verdict: { type: 'string', enum: [...VERDICT_VALUES], description: 'Verdict value. Required together with the other verdict fields.' },
        blocking: {
          type: 'array', description: 'Blocking findings; empty array when none. Required for a structured verdict.',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              file: { type: 'string', required: true }, line: { type: 'integer', required: true }, reason: { type: 'string', required: true },
            },
          },
        },
        followUps: {
          type: 'array', description: 'Non-blocking follow-ups; empty array when none. Required for a structured verdict.',
          items: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        },
        checks: {
          type: 'array', description: 'Checks actually run (name/result/tests). Required for a structured verdict.',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              name: { type: 'string', required: true }, result: { type: 'string', required: true }, tests: { type: 'string' },
            },
          },
        },
        reviewerSessionId: { type: 'string', description: 'Review session id; the host execution context is preferred when available.' },
      },
      output: REPORT_OUTPUT,
      execute: async (args, exec) => {
        const verdictKeys = ['source', 'verdict', 'blocking', 'followUps', 'checks', 'reviewerSessionId']
        const hasVerdict = verdictKeys.some((key) => Object.prototype.hasOwnProperty.call(args ?? {}, key))
        let canonical = null
        if (hasVerdict) {
          // The ONLY head source is git in the card's worktree. A model-supplied
          // reviewedHead is deliberately not in the parameter schema and is
          // ignored here even if an old caller passes it as an extra key.
          const card = store.getCard(args.cardId)
          if (card === undefined || card === null) throw new Error(`卡片不存在：${args.cardId}`)
          const fromExec = exec?.agent?.session?.id ?? exec?.agent?.id
          // Typed dual-field gate: a verdict is bound to the SESSION TYPE that
          // produced it. Never use `reviewSessionId || prReviewSessionId` —
          // that would let one review session impersonate the other.
          // Plain free-text reports are unaffected (no verdict keys).
          const isPrReview = args.source === 'pr-review'
          const selfId = typeof card.reviewSessionId === 'string' && card.reviewSessionId !== '' ? card.reviewSessionId : null
          const prId = typeof card.prReviewSessionId === 'string' && card.prReviewSessionId !== '' ? card.prReviewSessionId : null
          if (typeof card.sessionId === 'string' && card.sessionId !== '' && fromExec === card.sessionId) {
            throw new Error('builder 会话不能提交任何结构化 verdict')
          }
          if (isPrReview) {
            if (prId === null) throw new Error('本卡尚未派出 PR 评审会话，不能提交 PR verdict')
            if (fromExec === selfId) throw new Error('自审会话不能代交 PR 评审 verdict')
            if (fromExec !== prId) throw new Error('只有本卡 PR 评审会话可以提交 PR verdict')
          } else {
            if (selfId === null) throw new Error('本卡尚未派出自审会话，不能提交自审 verdict')
            if (fromExec === prId) throw new Error('PR 评审会话不能代交自审 verdict')
            if (fromExec !== selfId) throw new Error('只有本卡自审会话可以提交自审 verdict')
          }
          const reviewedHead = reviewedHeadFor({ worktreePath: card.worktreePath, readHead })
          canonical = normalizeVerdict({
            cardId: args.cardId,
            source: args.source,
            verdict: args.verdict,
            blocking: args.blocking,
            followUps: args.followUps,
            checks: args.checks,
            reviewerSessionId: args.reviewerSessionId,
          }, { reviewedHead, reviewerSessionId: typeof fromExec === 'string' && fromExec !== '' ? fromExec : undefined })
        }
        // Precheck a same-shape probe BEFORE the write: `reports` is an integer
        // supplied by the store at write time, so 0 stands in for it. Include
        // the verdict branch when present so the stricter shape is checked too.
        precheck('factory_report', REPORT_OUTPUT, args, {
          id: args.cardId, reports: 0, ...(canonical ? { verdict: canonical.verdict } : {}),
        })
        const result = canonical
          ? store.appendReportWithVerdict(args.cardId, args.report, canonical, 'agent')
          : store.appendReport(args.cardId, args.report, 'agent')
        return { id: args.cardId, reports: result.count, ...(canonical ? { verdict: canonical.verdict } : {}) }
      },
    },
    {
      name: 'factory_list_attention',
      description: 'List the cards that need a human right now: new/un-triaged (inbox), waiting for plan approval (plan-review), and awaiting review (review).',
      parameters: {},
      output: {
        schema: cardsListSchema('attention'),
        render: (args, value) => textBlock(value.attention.length === 0
          ? 'Nothing needs a human right now.'
          : value.attention.map((card) => `- [${card.status}] ${card.title} (${card.id})`).join('\n')),
      },
      execute: async () => {
        const wanted = new Set(ATTENTION_STATUSES)
        const attention = store.listCards({})
          .filter((card) => wanted.has(card.status))
          .map((card) => ({ id: card.id, title: card.title, status: card.status }))
        return { attention }
      },
    },
    {
      name: 'factory_inspect_repo',
      description: 'READ-ONLY. Inspect a repository and return RAW FACTS about it: the root file names, the root subdirectory names, the contents of any ignore files (.gitignore/.dockerignore/…), the packageManager field if package.json declares one, and which well-known manifests exist. This tool does NOT classify the project and returns no command to run — the list of project types is endless, so YOU decide what the project is from these files (pom.xml means Maven, Cargo.toml means Rust, go.mod means Go, and so on), and decide the setup command and which local files to copy from the target repository\'s own AGENTS.md / CONTRIBUTING, never from a hardcoded default. Show the facts and your proposal to the user, then create the project with factory_create_project once they agree.',
      parameters: {
        rootPath: { type: 'string', required: true, description: 'Absolute path to an existing git repository. A repo inside the DSH data root is accepted and registered with a warning (never a session cwd; its worktree is forced outside).' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            rootPath: { type: 'string' },
            packageManager: { type: 'string' },
            rootFiles: stringArray(),
            rootDirectories: stringArray(),
            // dsh-tools' schema compiler only accepts a boolean
            // `additionalProperties`, so a typed object map cannot be expressed
            // here — `json` keeps the raw ignore-file entries intact.
            ignoreFiles: { type: 'json' },
            manifestFiles: stringArray(),
            notes: stringArray(),
            warning: { type: 'string' },
          },
        },
        render: (args, value) => {
          const ignore = Object.entries(value.ignoreFiles ?? {})
            .map(([name, entries]) => `${name}: ${entries.join(', ') || '(empty)'}`)
          return textBlock([
            `Repository: ${value.rootPath}`,
            `packageManager: ${value.packageManager || '(none declared)'}`,
            `root files: ${value.rootFiles.join(', ') || '(none)'}`,
            `root directories: ${value.rootDirectories.join(', ') || '(none)'}`,
            `manifests worth a look: ${value.manifestFiles.join(', ') || '(none)'}`,
            ...ignore,
            ...value.notes,
            ...(value.warning ? [`Warning: ${value.warning}`] : []),
          ].join('\n'))
        },
      },
      execute: async (args = {}) => {
        const signals = inspect({ rootPath: args.rootPath })
        return {
          rootPath: signals.rootPath,
          packageManager: signals.packageManager,
          rootFiles: signals.rootFiles,
          rootDirectories: signals.rootDirectories,
          ignoreFiles: signals.ignoreFiles,
          manifestFiles: signals.manifestFiles,
          notes: signals.notes,
          // Omit the key entirely when there is no warning: the host's lossless-JSON
          // check rejects `undefined` (and `null` would fail the string schema).
          ...(signals.warning ? { warning: signals.warning } : {}),
        }
      },
    },
    {
      name: 'factory_create_project',
      description: 'Create a factory project in this session: register an absolute repository root with optional copyFiles and postCreate. workMode is the session permission boundary; stage rules default to full auto and may be narrowed in project settings. Creating a project is local and reversible.',
      parameters: {
        name: { type: 'string', required: true, description: 'Project name.' },
        rootPath: { type: 'string', required: true, description: 'Absolute repository root; must exist and be a git repository.' },
        copyFiles: { ...stringArray(), description: 'Relative local file paths to copy into each new worktree.' },
        postCreate: { type: 'string', description: 'Setup command run inside each new worktree; provided by the user, never a plugin default.' },
        workMode: { type: 'string', enum: [...WORK_MODES], description: 'Session permission boundary: workspace-write / full-access / auto-review. Defaults to workspace-write.' },
      },
      output: CREATE_OUTPUT,
      execute: async (args = {}) => {
        // Creating a project is local and reversible, but it must still point at
        // a real git repository. Without this, an agent could register /etc or a
        // path that does not exist (QA finding, 2026-11-15).
        const rootPath = assertRoot(args.rootPath)
        // Deterministic guard: whatever the agent proposed, only untracked local
        // files reach the store. The agent's copyFiles judgement varies between
        // runs; the git index does not.
        const cleaned = dropTrackedCopyFiles({
          repoPath: rootPath,
          files: Array.isArray(args.copyFiles) ? args.copyFiles : [],
          port: lsFilesPort,
        })
        const droppedPaths = cleaned.dropped.map((entry) => entry.path)
        // Precheck BEFORE the write. The exact id/warning come from the store at
        // write time, so use a same-shape probe with the fullest branch set
        // (both optional fields present): if schema+render+lossless pass for
        // this shape, the real value (a subset) passes the host receipt too.
        precheck('factory_create_project', CREATE_OUTPUT, args, {
          id: 'probe', name: args.name, warning: 'probe', droppedCopyFiles: droppedPaths.length ? droppedPaths : ['probe'],
        })
        // Resolve/interrogate BEFORE the write so a bad answer persists nothing.
        const settings = resolveAddProjectSettings(args)
        const project = store.createProject({
          name: args.name,
          rootPath,
          copyFiles: cleaned.files,
          postCreate: args.postCreate ?? '',
          workMode: settings.workMode,
        })
        return {
          id: project.id,
          name: project.name,
          ...(project.warning ? { warning: project.warning } : {}),
          ...(droppedPaths.length ? { droppedCopyFiles: droppedPaths } : {}),
        }
      },
    },
    {
      name: 'factory_push_branch',
      description: 'BUILD ONLY. Commit the frozen dirty paths and push this card branch. Never opens a PR. Only the registered builder session may call it; no write while another session is active.',
      parameters: {
        cardId: { type: 'string', required: true, description: 'Card id.' },
        message: { type: 'string', required: true, description: 'Commit message written by the build session.' },
      },
      output: PUSH_OUTPUT,
      execute: async (args = {}, exec) => {
        const card = store.getCard(args.cardId)
        if (card === undefined || card === null) throw new Error(`卡片不存在：${args.cardId}`)
        if (card.status !== 'build') throw new Error(`仅 build 阶段可提交推送（当前 ${card.status}）`)
        requireBuilderSession(card, exec, '提交推送')
        if (card.commitSha) throw new Error('该卡已提交，不能重复推送')
        if (typeof isSessionActive === 'function') {
          for (const [sessionId, label] of [
            [card.reviewSessionId, '评审'],
            [card.prReviewSessionId, 'PR 评审'],
          ]) {
            if (typeof sessionId === 'string' && sessionId !== '' && await isSessionActive(sessionId)) {
              throw new Error(`${label}会话仍在运行，禁止写入`)
            }
          }
        }
        if (isProtectedBranch(card.branch)) throw new Error(`拒绝向受保护分支「${card.branch}」推送`)
        if (card.baseBranch && String(card.branch).toLowerCase() === String(card.baseBranch).toLowerCase()) {
          throw new Error(`拒绝向 base 分支「${card.branch}」推送`)
        }
        if (typeof buildGitPortFor !== 'function') throw new Error('提交推送缺少 git 端口')
        const port = await buildGitPortFor(card)
        const cwd = card.worktreePath
        const base = card.baseBranch || 'main'
        // Legacy fail-closed gate: an unrecorded build must still sit on the
        // project base tip. A stray/fixture HEAD must never become a delivery.
        const head = typeof readHead === 'function' ? readHead({ worktreePath: cwd }) : null
        const baseHead = typeof port?.headOf === 'function' ? port.headOf(cwd, base) : null
        if (!isFullSha(head) || !isFullSha(baseHead) || head !== baseHead) {
          throw new Error(`HEAD 与基线不一致，拒绝提交推送（${head} ≠ ${baseHead}）`)
        }
        // Same bulk-deletion fence as the legacy auto-commit path.
        const deleted = typeof port?.deletedCount === 'function' ? Number(port.deletedCount(cwd, head)) : 0
        if (Number.isFinite(deleted) && deleted > 20) {
          throw new Error(`工作树相对 HEAD 删除了 ${deleted} 个已跟踪文件，疑似临时夹具或误操作，拒绝自动提交`)
        }
        // Freeze paths before the hook runs; untracked-only changes are valid.
        const paths = typeof port?.changedPaths === 'function' ? port.changedPaths(cwd) : []
        if (!Array.isArray(paths) || paths.length === 0) throw new Error('没有可交付的脏文件')
        if (typeof port?.hasDiff === 'function' && port.hasDiff(cwd, base) !== true) {
          throw new Error('没有可交付的改动（HEAD 与 base 无差异）')
        }
        const message = typeof args.message === 'string' && args.message.trim() !== '' ? args.message.trim() : `factory: implement card ${card.id.slice(0, 8)}`
        precheck('factory_push_branch', PUSH_OUTPUT, args, { id: card.id, sha: '0'.repeat(40), prUrl: '', notice: '' })
        try {
          port.add(card.worktreePath, paths)
          const sha = port.commit(card.worktreePath, message, paths)
          if (!isFullSha(sha)) throw new Error(`提交返回的 sha 不是完整 SHA：${sha}`)
          port.push(card.worktreePath, card.branch)
          const notice = `Committed ${sha} and pushed ${card.branch}; no PR was opened.`
          store.recordBuildPush(card.id, { sha, message })
          return { id: card.id, sha, prUrl: '', notice }
        } catch (error) {
          try { port.reset?.(card.worktreePath) } catch { /* best-effort unstage */ }
          throw error
        }
      },
    },
    {
      name: 'factory_self_review_verdict',
      description: 'SELF-REVIEW ONLY. Record the independent reviewer verdict with findings bound to the backend-read HEAD. approved unlocks the draft PR; changes-requested returns to build.',
      parameters: {
        cardId: { type: 'string', required: true, description: 'Card id.' },
        head: { type: 'string', required: true, description: 'Full HEAD SHA reviewed (git rev-parse HEAD).' },
        verdict: { type: 'string', required: true, enum: ['approved', 'changes-requested', 'verification-incomplete'] },
        blocking: { type: 'array', description: 'Blocking findings.', items: { type: 'object', additionalProperties: false, properties: { file: { type: 'string', required: true }, line: { type: 'integer', required: true }, reason: { type: 'string', required: true } } } },
        followUps: { type: 'array', description: 'Non-blocking follow-ups.', items: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } } },
        checks: { type: 'array', description: 'Checks actually run.', items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', required: true }, result: { type: 'string', required: true }, tests: { type: 'string' } } } },
        note: { type: 'string' },
      },
      output: VERDICT_OUTPUT,
      execute: async (args = {}, exec) => {
        const card = store.getCard(args.cardId)
        if (card === undefined || card === null) throw new Error(`卡片不存在：${args.cardId}`)
        if (card.status !== 'self-review') throw new Error(`仅 self-review 阶段可记录结论（当前 ${card.status}）`)
        const fromExec = sessionIdOf(exec)
        if (typeof card.prReviewSessionId === 'string' && card.prReviewSessionId !== '' && fromExec === card.prReviewSessionId) {
          throw new Error('PR 评审会话不能代交自审结论')
        }
        if (fromExec !== card.reviewSessionId) throw new Error('只有本卡评审会话可以提交自审结论')
        if (!isFullSha(args.head) || typeof readHead !== 'function') throw new Error('自审需要完整 HEAD SHA 与 git 读取端口')
        const live = readHead({ worktreePath: card.worktreePath })
        if (!isFullSha(live) || live.trim().toLowerCase() !== args.head.trim().toLowerCase()) {
          throw new Error(`自审 head 与当前 git HEAD 不一致（${args.head} ≠ ${live}）`)
        }
        precheck('factory_self_review_verdict', VERDICT_OUTPUT, args, { id: card.id, verdict: args.verdict, head: live, rounds: 0 })
        const result = store.recordSelfReviewVerdict(card.id, {
          head: live, verdict: args.verdict, blocking: args.blocking ?? [], followUps: args.followUps ?? [],
          checks: args.checks ?? [], note: args.note ?? '', sessionId: fromExec,
        })
        return { id: card.id, verdict: result.verdict, head: result.head, rounds: result.rounds }
      },
    },
    {
      name: 'factory_open_draft_pr',
      description: 'SELF-REVIEW ONLY, after approved verdict. Open ONE draft PR from the approved head. Backend re-reads HEAD and refuses on drift; never force, merge, close issues or update the PR.',
      parameters: {
        cardId: { type: 'string', required: true, description: 'Card id.' },
        title: { type: 'string', required: true, description: 'Draft PR title.' },
        body: { type: 'string', description: 'Draft PR body.' },
      },
      output: PR_OUTPUT,
      execute: async (args = {}, exec) => {
        const card = store.getCard(args.cardId)
        if (card === undefined || card === null) throw new Error(`卡片不存在：${args.cardId}`)
        if (card.status !== 'self-review') throw new Error(`仅 self-review 阶段可开草稿 PR（当前 ${card.status}）`)
        const fromExec = sessionIdOf(exec)
        if (fromExec !== card.reviewSessionId) throw new Error('只有本卡评审会话可以从批准 head 开 PR')
        if (card.selfReview?.verdict !== 'approved') throw new Error('没有 approved 自审结论，禁止开 PR')
        if (card.prUrl) throw new Error('该卡已有 PR，不能重复开')
        if (typeof readHead !== 'function' || typeof buildGitPortFor !== 'function') throw new Error('开 PR 缺少 git/gh 端口')
        const live = readHead({ worktreePath: card.worktreePath })
        if (!isFullSha(live) || live.trim().toLowerCase() !== card.selfReview.head.trim().toLowerCase()) {
          throw new Error(`批准 head 与当前 HEAD 不一致，禁止开 PR（${card.selfReview.head} ≠ ${live}）`)
        }
        const port = await buildGitPortFor(card)
        precheck('factory_open_draft_pr', PR_OUTPUT, args, { id: card.id, url: '', head: live, notice: '' })
        const url = port.createPr(card.worktreePath, {
          title: typeof args.title === 'string' && args.title.trim() !== '' ? args.title.trim() : card.title,
          body: typeof args.body === 'string' ? args.body : (card.body || ''),
          branch: card.branch,
          draft: true,
        })
        if (typeof url !== 'string' || url.trim() === '') throw new Error('创建草稿 PR 未返回 URL')
        const notice = `Draft PR ${url} opened from approved head ${live}.`
        store.recordDraftPr(card.id, { url, head: live, title: args.title, body: args.body })
        return { id: card.id, url, head: live, notice }
      },
    },
  ]
}
