/**
 * QA — transaction boundary fix (plan A: precompute receipt before write).
 * PRD .scratch/prd-transaction-boundary.md §5 TB-1..TB-7.
 *
 * Discipline: tests behaviour, not implementation. Every "receipt would fail"
 * case injects a failing port and asserts (a) the precheck throws with the ORIGINAL
 * reason, (b) the store was NOT written, and (c) onFailure observed it (TB-5).
 * No host package is imported (peer-only, not installed); where the PRD asks for
 * "host-equivalent" semantics we use this repo's default ports, which Dev's
 * production entry injects the host's public validator alongside. The host
 * validator cannot be imported here (ERR_MODULE_NOT_FOUND) — noted in the report.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FactoryStore } from '../store.js'
import { factoryToolSpecs } from '../tools.js'
import {
  defaultIsLossless,
  defaultValidateSchema,
  precheckReceipt,
} from '../receipt.js'

const NAME = 'qa-tool'
const SCHEMA = { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, n: { type: 'integer' } } }
const RENDER = (args, value) => [{ type: 'text', text: `${value.id}:${value.n}` }]
const GOOD = { id: 'x', n: 1 }

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-receipt-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: '/workspace/p' })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  const card = store.createCard({ boardId: board.id, title: 'c' })
  return { tmp, store, project, board, card, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

// ---------- precheckReceipt stage failures (TB-1/3/4/5) ----------

test('TB-2 happy path: valid value passes all four stages, render returned (no false block)', () => {
  const rendered = precheckReceipt({ name: NAME, schema: SCHEMA, render: RENDER, args: {}, value: GOOD })
  assert.deepEqual(rendered, [{ type: 'text', text: 'x:1' }])
  // Default ports agree with the schema/lossless contract.
  assert.equal(defaultIsLossless(GOOD), true)
  assert.deepEqual(defaultValidateSchema(SCHEMA, GOOD, 'value'), [])
})

test('TB-1/4 stage value-lossless: non-lossless value rejected with onFailure, original reason thrown', () => {
  const failures = []
  const cyc = {}; cyc.self = cyc
  for (const bad of [{ id: 'x', n: undefined }, { id: 'x', n: NaN }, cyc]) {
    assert.throws(
      () => precheckReceipt({
        name: NAME, schema: SCHEMA, render: RENDER, args: {}, value: bad,
        ports: { onFailure: (e) => failures.push(e) },
      }),
      /not lossless JSON/,
    )
  }
  assert.equal(failures.length, 3)
  assert.ok(failures.every((f) => f.tool === NAME && f.stage === 'value-lossless' && f.reason))
})

test('TB-4 stage value-schema: schema violation rejected with violations in message + onFailure', () => {
  const failures = []
  assert.throws(
    () => precheckReceipt({
      name: NAME, schema: SCHEMA, render: RENDER, args: {}, value: { id: 'x', n: 'not-int' },
      ports: { onFailure: (e) => failures.push(e) },
    }),
    /schema violations: "value\.n" must be an integer/,
  )
  assert.equal(failures.length, 1)
  assert.equal(failures[0].stage, 'value-schema')
})

test('TB-3 stage render: render throws the ORIGINAL error, rethrown as-is, observed', () => {
  const boom = new Error('RENDER EXPLODED <original>')
  const boomRender = () => { throw boom }
  const failures = []
  let caught
  try {
    precheckReceipt({
      name: NAME, schema: SCHEMA, render: boomRender, args: {}, value: GOOD,
      ports: { onFailure: (e) => failures.push(e) },
    })
  } catch (e) { caught = e }
  assert.equal(caught, boom, 'the exact original error object is rethrown, not wrapped')
  assert.equal(failures.length, 1)
  assert.equal(failures[0].stage, 'render')
  assert.match(failures[0].reason, /RENDER EXPLODED <original>/)
})

test('TB-1/4 stage render-lossless: render returns non-lossless blocks → rejected + observed', () => {
  const failures = []
  const badRender = () => [{ type: 'text', text: undefined }]
  assert.throws(
    () => precheckReceipt({
      name: NAME, schema: SCHEMA, render: badRender, args: {}, value: GOOD,
      ports: { onFailure: (e) => failures.push(e) },
    }),
    /render returned non-lossless JSON/,
  )
  assert.equal(failures.length, 1)
  assert.equal(failures[0].stage, 'render-lossless')
})

test('TB-5 onFailure itself throwing never masks the real precheck failure', () => {
  const boom = new Error('schema bad original')
  assert.throws(
    () => precheckReceipt({
      name: NAME, schema: SCHEMA, render: RENDER, args: {}, value: { id: 'x', n: 'bad' },
      ports: { onFailure: () => { throw new Error('observer exploded') } },
    }),
    /schema violations/,
    'the schema error wins, not the observer error',
  )
})

// ---------- tool-level: precheck blocks BEFORE store write (TB-1) ----------

test('TB-1/4 transition: injected schema failure throws and card status/history unchanged', async () => {
  const { store, card, cleanup } = setup()
  try {
    store.transitionCard(card.id, 'triage', 'human')
    const before = JSON.stringify(store.getCard(card.id))
    const failAllSchemas = () => ['injected violation: always fail']
    const specs = new Map(factoryToolSpecs({
      store,
      receiptPorts: { validateSchema: failAllSchemas },
    }).map((s) => [s.name, s]))
    await assert.rejects(
      () => specs.get('factory_transition_work_item').execute({ cardId: card.id, to: 'plan' }),
      /schema violations: injected violation: always fail/,
    )
    assert.equal(JSON.stringify(store.getCard(card.id)), before, 'card not written')
  } finally { cleanup() }
})

test('TB-1/3 report: injected schema failure throws and no report appended', async () => {
  const { store, card, cleanup } = setup()
  try {
    const before = store.getCard(card.id).history.filter((h) => h.type === 'report').length
    const specs = new Map(factoryToolSpecs({
      store,
      receiptPorts: { validateSchema: () => ['injected violation'] },
    }).map((s) => [s.name, s]))
    await assert.rejects(
      () => specs.get('factory_report').execute({ cardId: card.id, report: 'should not land' }),
      /schema violations/,
    )
    const after = store.getCard(card.id).history.filter((h) => h.type === 'report').length
    assert.equal(after, before, 'no report written')
  } finally { cleanup() }
})

test('TB-1/7 createProject: injected schema failure throws and no project created', async () => {
  const { store, cleanup } = setup()
  try {
    const before = store.state.projects.length
    const specs = new Map(factoryToolSpecs({
      store,
      assertRoot: (p) => p, // bypass real-git check; isolate the write-blocking assertion
      lsFilesPort: () => ({ files: [], dropped: [] }),
      receiptPorts: { validateSchema: () => ['injected violation'] },
    }).map((s) => [s.name, s]))
    await assert.rejects(
      () => specs.get('factory_create_project').execute({ name: 'should-not-exist', rootPath: '/workspace/p' }),
      /schema violations/,
    )
    assert.equal(store.state.projects.length, before, 'no project written')
  } finally { cleanup() }
})

test('TB-7 assertRoot still runs before precheck: a non-repo root is refused even when receipt ports pass', async () => {
  const { store, cleanup } = setup()
  try {
    // Receipt ports all pass; the real assertRepoRoot must STILL reject a path
    // that is not a git repository, before any precheck/write (PRD §3.1 / TB-7).
    const specs = new Map(factoryToolSpecs({
      store,
      receiptPorts: { validateSchema: () => [], isLossless: () => true },
    }).map((s) => [s.name, s]))
    await assert.rejects(
      () => specs.get('factory_create_project').execute({ name: 'bad-root', rootPath: '/workspace/does-not-exist-repo' }),
      /rootPath|git|不存在/,
    )
  } finally { cleanup() }
})

test('TB-2 _SUCCESS: all three write tools still succeed with default (non-failing) ports', async () => {
  const { store, card, cleanup } = setup()
  // A throwaway git repo so the real assertRepoRoot check passes on any
  // machine (CI, fresh clones) — no external /workspace/factory-e2e-hono
  // dependency.
  const repo = mkdtempSync(join(tmpdir(), 'qa-receipt-repo-'))
  mkdirSync(join(repo, '.git'), { recursive: true })
  try {
    const specs = new Map(factoryToolSpecs({ store }).map((s) => [s.name, s]))
    // transition: need human to triage first, then agent may plan
    store.transitionCard(card.id, 'triage', 'human')
    assert.equal((await specs.get('factory_transition_work_item').execute({ cardId: card.id, to: 'plan' })).status, 'plan')
    assert.equal((await specs.get('factory_report').execute({ cardId: card.id, report: 'ok' })).reports, 1)
    const created = await specs.get('factory_create_project').execute({
      name: 'real-project', rootPath: repo,
    })
    assert.equal(created.name, 'real-project')
    assert.equal(typeof created.id, 'string')
  } finally { rmSync(repo, { recursive: true, force: true }); cleanup() }
})

test('TB-1/6 read-only tools are NOT gated by receipt ports', async () => {
  const { store, cleanup } = setup()
  try {
    const specs = new Map(factoryToolSpecs({
      store,
      receiptPorts: { validateSchema: () => ['would fail if used'], isLossless: () => false },
    }).map((s) => [s.name, s]))
    // Read tools must still work — they never call precheck.
    const list = await specs.get('factory_list_work_items').execute({})
    assert.ok(Array.isArray(list.cards))
    const att = await specs.get('factory_list_attention').execute({})
    assert.ok(Array.isArray(att.attention))
  } finally { cleanup() }
})

test('TB-4 default lossless rejects JSON-hostile values (NaN, -0, cyclic, holes, non-plain)', () => {
  assert.equal(defaultIsLossless({ a: 1, b: [1, 2, 3] }), true)
  assert.equal(defaultIsLossless(null), true)
  assert.equal(defaultIsLossless(undefined), false)
  assert.equal(defaultIsLossless(NaN), false)
  assert.equal(defaultIsLossless(-0), false)
  const cyc = {}; cyc.self = cyc
  assert.equal(defaultIsLossless(cyc), false)
  assert.equal(defaultIsLossless(Object.create({ inherited: 1 })), false)
  const sparse = [1]; sparse[2] = 3
  assert.equal(defaultIsLossless(sparse), false)
})
