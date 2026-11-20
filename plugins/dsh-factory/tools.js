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
import { AUTONOMY_LEVELS, WORK_MODES } from './store.js'
import { assertRepoRoot, inspectRepo } from './project-proposal.js'
import { defaultLsFilesPort, dropTrackedCopyFiles } from './worktree-setup.js'
import { precheckReceipt } from './receipt.js'
import { normalizeVerdict, reviewedHeadFor, VERDICT_SOURCES, VERDICT_VALUES } from './verdict.js'

const AGENT_TARGETS = ['inbox', 'triage', 'plan', 'plan-review', 'build', 'review', 'canceled']
const ATTENTION_STATUSES = ['inbox', 'plan-review', 'review']
// The two per-project settings the add-project skill asks about. L0–L4 is the
// human-facing wording; L1/L2 share `you-approve` and differ only in the
// autoDispatch switch, exactly as the UI slider maps them.
const AUTONOMY_LEVEL_CODES = ['L0', 'L1', 'L2', 'L3', 'L4']
const LEVEL_TO_AUTONOMY = {
  L0: { autonomy: 'manual', autoDispatch: false },
  L1: { autonomy: 'you-approve', autoDispatch: false },
  L2: { autonomy: 'you-approve', autoDispatch: true },
  L3: { autonomy: 'machine-approve', autoDispatch: false },
  L4: { autonomy: 'auto-delivery', autoDispatch: false },
}

/**
 * Resolve the answers from ask_user_question into persisted project settings.
 * Only the five exact L-codes are accepted; a bad answer fails closed before
 * any project is written. Store createProject still starts every project manual
 * — the autonomy answer is applied as a separate, explicit follow-up write.
 */
export function resolveAddProjectSettings({ workMode, autonomy, autoDispatch } = {}) {
  const mode = workMode === undefined || workMode === null || workMode === '' ? 'workspace-write' : workMode
  if (!WORK_MODES.includes(mode)) throw new Error(`未知工作模式：${mode}（可选 ${WORK_MODES.join(' / ')}）`)
  if (autonomy === undefined || autonomy === null || autonomy === '' || autonomy === 'L0') {
    return { workMode: mode, autonomy: null, autoDispatch: autoDispatch === true }
  }
  if (!AUTONOMY_LEVEL_CODES.includes(autonomy)) {
    throw new Error(`未知自动化程度：${autonomy}（可选 ${AUTONOMY_LEVEL_CODES.join(' / ')}）`)
  }
  const level = LEVEL_TO_AUTONOMY[autonomy]
  // A semantic level from the model/API is accepted too, but L1 vs L2 then
  // needs the explicit switch; bare `you-approve` stays L1 (no auto dispatch).
  const stored = AUTONOMY_LEVELS.has(autonomy)
    ? { autonomy, autoDispatch: autoDispatch === true }
    : level
  return { workMode: mode, ...stored }
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

export function factoryToolSpecs({ store, inspect = inspectRepo, assertRoot = assertRepoRoot, lsFilesPort = defaultLsFilesPort(), receiptPorts = {}, readHead } = {}) {
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
      description: 'Move a card to another stage. As the agent you may advance triage→plan→plan-review and build→review, and send a card back to inbox, but you may NOT approve a plan, move a card to done, or open a PR — those are human-only and will be refused.',
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
          && card.reviewSessionId === liveSessionId) {
          throw new Error('评审会话不能移卡：review 阶段的放行与退回只能由人操作')
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
        source: { type: 'string', enum: [...VERDICT_SOURCES], description: 'Verdict source: review for the first pass, rereview for a later pass. Required together with the other verdict fields.' },
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
          // P2a bug fix + hole-A closure: a verdict is the REVIEWER's
          // conclusion, NEVER a builder self-certification. This is a
          // STAGE-INDEPENDENT rule: only the session recorded on
          // card.reviewSessionId may write structured fields, in any phase.
          // Without a reviewer session there is no review conclusion at all.
          // Plain free-text reports are unaffected (no verdict keys).
          const reviewerId = typeof card.reviewSessionId === 'string' && card.reviewSessionId !== '' ? card.reviewSessionId : null
          if (reviewerId === null) {
            throw new Error('本卡尚未派出评审会话，不能提交结构化 verdict；请先发起评审')
          }
          if (typeof card.sessionId === 'string' && card.sessionId !== '' && fromExec === card.sessionId) {
            throw new Error('只有评审会话可以提交结构化 verdict；builder 会话在任何阶段都不能自评')
          }
          if (typeof fromExec !== 'string' || fromExec === '' || fromExec !== reviewerId) {
            throw new Error('只有评审会话可以提交结构化 verdict；当前会话不是本卡的评审会话')
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
      description: 'Create a factory project directly in this session: register an absolute repository root with optional copyFiles (relative local file paths) and postCreate (a setup command you author). workMode and autonomy are the answers from the add-project skill\'s ask_user_question step; pass them to persist the session mode and autonomy level at creation. Creating a project is local and reversible — it does not commit, push, or open a PR; those still require the human approval gates. Validate rootPath is an absolute path to an existing git repository before calling. Show the name, rootPath, copyFiles, postCreate, workMode and autonomy to the user before creating.',
      parameters: {
        name: { type: 'string', required: true, description: 'Project name.' },
        rootPath: { type: 'string', required: true, description: 'Absolute repository root; must exist and be a git repository.' },
        copyFiles: { ...stringArray(), description: 'Relative local file paths to copy into each new worktree.' },
        postCreate: { type: 'string', description: 'Setup command run inside each new worktree; provided by the user, never a plugin default.' },
        workMode: { type: 'string', enum: [...WORK_MODES], description: 'Session mode answer: workspace-write / full-access / auto-review. Defaults to workspace-write.' },
        autonomy: { type: 'string', enum: [...AUTONOMY_LEVEL_CODES, ...AUTONOMY_LEVELS], description: 'Autonomy answer from the question: L0–L4 (L1/L2 differ by autoDispatch). Defaults to L0 manual.' },
        autoDispatch: { type: 'boolean', description: 'Only used with you-approve; true is L2, false is L1.' },
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
        // createProject always starts manual; apply the asked level as a
        // separate explicit write instead of changing the store's default.
        if (settings.autonomy !== null && settings.autonomy !== 'manual') {
          store.updateAutonomy(project.id, {
            autonomy: settings.autonomy,
            autoDispatch: settings.autoDispatch,
          })
        }
        return {
          id: project.id,
          name: project.name,
          ...(project.warning ? { warning: project.warning } : {}),
          ...(droppedPaths.length ? { droppedCopyFiles: droppedPaths } : {}),
        }
      },
    },
  ]
}
