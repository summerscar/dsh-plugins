/** Shared V4 test scaffolding for Dev-owned intent-level tests. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { FactoryStore } from '../store.js'
import { factoryToolSpecs } from '../tools.js'

export const HEAD = 'a'.repeat(40)
export const SHA = 'b'.repeat(40)
export const STALE = 'c'.repeat(40)
export const PR_URL = 'https://example/pr/1'

export const FLOW = ['inbox', 'triage', 'plan', 'build', 'self-review', 'pr-review']
const FLOW_ACTOR = { triage: 'human', plan: 'agent', build: 'agent', 'self-review': 'agent', 'pr-review': 'agent' }

export function makeFixture({ status = 'build', branch = 'factory/card', phaseRules, sessionId = 'builder-session' } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'dev-v4-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: '/repo', ...(phaseRules ? { phaseRules } : {}) })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  const card = store.createCard({ boardId: board.id, title: 'Ship it' })
  store.setWorktree(card.id, { worktreePath: '/worktree', branch, baseBranch: 'main', sessionId })
  for (const to of FLOW.slice(1, FLOW.indexOf(status) + 1)) store.transitionCard(card.id, to, FLOW_ACTOR[to])
  return { tmp, store, project, card: store.getCard(card.id), cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

export function makeTools(f, overrides = {}) {
  const calls = []
  const port = {
    changedPaths: (cwd) => { calls.push(['changedPaths', cwd]); return ['README.md'] },
    add: (cwd, paths) => { calls.push(['add', paths]) },
    commit: (cwd, message, paths) => { calls.push(['commit', message, paths]); return SHA },
    push: (cwd, branch) => { calls.push(['push', branch]) },
    createPr: (cwd, input) => { calls.push(['createPr', input]); return PR_URL },
    hasDiff: (cwd, base) => { calls.push(['hasDiff', base]); return true },
    deletedCount: () => 0,
    headOf: () => HEAD,
    isWorktreeClean: () => false,
    ...overrides.gitPort,
  }
  const specs = factoryToolSpecs({
    store: f.store,
    receiptPorts: { validateSchema: () => true },
    readHead: overrides.readHead ?? (() => HEAD),
    buildGitPortFor: overrides.buildGitPortFor ?? (async () => port),
    isSessionActive: overrides.isSessionActive ?? (async () => false),
    closePrFor: overrides.closePrFor ?? (async () => {}),
  })
  const find = (name) => {
    const spec = specs.find((entry) => entry.name === name)
    assert.ok(spec, `${name} is registered`)
    return spec
  }
  return {
    calls,
    port,
    specs,
    names: specs.map((spec) => spec.name),
    find,
    builder: { agent: { id: 'builder-session' } },
    reviewer: { agent: { id: 'reviewer-session' } },
    other: { agent: { id: 'other-session' } },
  }
}

export function clientSource(name = 'client.js') {
  return readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
}

export function renderCardActions(card, options = {}) {
  const source = clientSource()
  const body = source.slice(source.indexOf('function CardActions('), source.indexOf('function Column('))
  assert.ok(body.startsWith('function CardActions('), 'CardActions source found')
  const h = (tag, props, ...children) => ({ tag, props: props || {}, children })
  const calls = []
  const fn = new Function(
    'h', 'Button', 'callApi', 'T', 'NoteModal', 'Modal', 'DraftModal', 'needsAutoApproveNotice',
    'TakenOverBadge', 'NeedsInfoBadge', 'OrphanBadge', 'DeliveryStatus', 'CardExtras',
    `${body}\nreturn CardActions`,
  )(h, 'button', async (...args) => { calls.push(args); return {} }, {}, 'note', 'modal', 'draft', () => false,
    'taken', 'needs', 'orphan', 'delivery', 'extras')
  const view = fn({
    card, run: async (job) => job(), t: (key) => key, busy: options.busy ?? false,
    working: options.working ?? false, reviewWorking: options.reviewWorking ?? false,
    onToast: () => {}, onModal: () => {}, tier: options.tier ?? 'phase-rules', orphan: undefined,
  })
  const buttons = view === null ? [] : view.children.flat().filter((child) => child && child.tag === 'button')
  return { buttons, keys: buttons.map((button) => button.props.key), calls }
}

export function approveSelfReview(f, t, head = HEAD) {
  return t.find('factory_self_review_verdict').execute({
    cardId: f.card.id, head, verdict: 'approved', blocking: [], followUps: [], checks: [],
  }, t.reviewer)
}
