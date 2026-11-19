/**
 * QA — configurable intake pull cap (`intakeLimit`).
 *
 * Product gap this covers: `intake.js` used to hard-code `gh issue list --limit 100`,
 * so pointing the engine at a busy upstream flooded the board with up to 100 cards
 * in a single tick — every one of them a real agent session. `intakeLimit` makes
 * the per-poll cap a project setting.
 *
 * These cases assert BEHAVIOUR, not implementation:
 *   - the real `gh` argv carries the right `--limit` (via a fake `gh` on PATH);
 *   - `intakeIssues` forwards the limit to the injected gh port;
 *   - the engine's real `runTick` threads `project.intakeLimit` into intake;
 *   - end to end: intakeLimit=3 over a 100-issue upstream yields exactly 3 cards,
 *     and unset keeps the 100 default.
 *
 * Test data lives in a fresh temp dir; the real data root is never touched.
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FactoryStore } from '../store.js'
import { createGhPort, intakeIssues } from '../intake.js'
import { createEngineStatus, runTick } from '../autonomy.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-intake-limit-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const project = store.createProject({ name: 'p', rootPath: '/workspace/example-repo' })
  const board = store.createBoard({ projectId: project.id, name: 'b' })
  return { tmp, store, project, board, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

function manyIssues(count) {
  return Array.from({ length: count }, (_, i) => ({
    number: i + 1, title: `issue ${i + 1}`, body: '', url: `https://github.com/o/r/issues/${i + 1}`, labels: [],
  }))
}

// A `gh` stand-in on PATH that records its argv and prints an empty issue list.
// Lets us assert the REAL createGhPort argv without a network call.
function makeGhShim(tmp) {
  const binDir = join(tmp, 'bin')
  mkdirSync(binDir, { recursive: true })
  const capturePath = join(binDir, 'argv.txt')
  const ghPath = join(binDir, 'gh')
  writeFileSync(ghPath, `#!/bin/sh\nprintf '%s\\n' \"$*\" > '${capturePath}'\nprintf '[]'\n`)
  chmodSync(ghPath, 0o755)
  return { binDir, capturePath }
}

function withPath(binDir, fn) {
  const prev = process.env.PATH
  process.env.PATH = `${binDir}:${prev ?? ''}`
  try {
    return fn()
  } finally {
    process.env.PATH = prev
  }
}

// ---------------------------------------------------------------------------
// store: intakeLimit is a validated, persisted project setting
// ---------------------------------------------------------------------------

test('intakeLimit: defaults to null, persists a positive integer, rejects bad values', () => {
  const { store, project, board, cleanup } = setup()
  try {
    // Not set at creation -> null (meaning "use the port default of 100").
    assert.equal(store.getProject(project.id).intakeLimit, null)

    const updated = store.updateIntake(project.id, {
      issueRepo: 'owner/repo', intakeBoardId: board.id, intakeLimit: 3,
    })
    assert.equal(updated.intakeLimit, 3)
    assert.equal(store.getProject(project.id).intakeLimit, 3)

    // A value survives an unrelated intake patch.
    const again = store.updateIntake(project.id, { issueRepo: 'owner/repo' })
    assert.equal(again.intakeLimit, 3)

    // null clears it back to the default.
    assert.equal(store.updateIntake(project.id, { intakeLimit: null }).intakeLimit, null)

    for (const bad of [0, -1, 1.5, '3']) {
      assert.throws(() => store.updateIntake(project.id, { intakeLimit: bad }), /intakeLimit 必须是正整数或 null/)
    }
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// intakeIssues: forwards the limit to the injected gh port
// ---------------------------------------------------------------------------

test('intakeIssues forwards `limit` to ghPort.listIssues', async () => {
  const { store, project, board, cleanup } = setup()
  try {
    const seen = []
    const ghPort = {
      listIssues(repo, opts) {
        seen.push({ repo, opts })
        return JSON.stringify([{ number: 1, title: 'only' }])
      },
    }
    const result = await intakeIssues({ store, projectId: project.id, boardId: board.id, repo: 'o/r', ghPort, limit: 3 })
    assert.equal(seen.length, 1)
    assert.equal(seen[0].opts.limit, 3)
    assert.equal(result.created.length, 1)

    // No limit supplied -> the port is told nothing (undefined), so its own
    // default applies.
    await intakeIssues({ store, projectId: project.id, boardId: board.id, repo: 'o/r', ghPort })
    assert.equal(seen[1].opts.limit, undefined)
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// createGhPort: the REAL gh argv carries the right --limit
// ---------------------------------------------------------------------------

test('createGhPort default pulls with --limit 100', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-ghshim-'))
  try {
    const { binDir, capturePath } = makeGhShim(tmp)
    withPath(binDir, () => {
      const port = createGhPort()
      assert.equal(port.listIssues('o/r'), '[]')
    })
    assert.match(readFileSync(capturePath, 'utf8'), /--limit 100( |$)/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('createGhPort honours an explicit limit (construction and per-call)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-ghshim-'))
  try {
    const { binDir, capturePath } = makeGhShim(tmp)

    // Construction-time default.
    withPath(binDir, () => createGhPort({ limit: 5 }).listIssues('o/r'))
    assert.match(readFileSync(capturePath, 'utf8'), /--limit 5( |$)/)

    // Per-call override — the path intakeIssues actually uses.
    withPath(binDir, () => createGhPort().listIssues('o/r', { limit: 7 }))
    assert.match(readFileSync(capturePath, 'utf8'), /--limit 7( |$)/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The cap is "at most N", never "exactly N" (PM's criterion, chalk/chalk=1 issue)
// ---------------------------------------------------------------------------

test('intakeLimit is an upper bound: fewer upstream issues yield fewer cards', async () => {
  const { store, board, cleanup } = setup()
  try {
    const oneIssue = [{ number: 1, title: 'only real issue', url: 'https://github.com/o/r/issues/1', body: '', labels: [] }]
    let lastLimit
    const port = {
      listIssues(_repo, opts = {}) {
        lastLimit = opts.limit
        const cap = opts.limit == null ? 100 : opts.limit
        return JSON.stringify(oneIssue.slice(0, cap))
      },
    }
    const { projectId } = intakeProject(store, 2)
    await runTick({
      store, status: createEngineStatus(), config: {},
      deps: { ghPort: port, intake: intakeIssues, dispatch: async () => ({ mode: 'noop' }), isSessionActive: async () => false },
    })
    assert.equal(lastLimit, 2)
    const cards = store.listCards({ projectId })
    assert.equal(cards.length, 1, 'upstream has 1 issue, intakeLimit=2 must create 1, not pad to 2')
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// runTick: the engine reads project.intakeLimit and passes it to intake
// ---------------------------------------------------------------------------

function engineDeps({ intake }) {
  return {
    ghPort: {},
    intake,
    dispatch: async () => ({ mode: 'noop' }),
    isSessionActive: async () => false,
  }
}

function intakeProject(store, intakeLimit) {
  const project = store.createProject({ name: 'eng', rootPath: '/workspace/any' })
  // The card's projectId is taken from the board it is created on, so the
  // intake board MUST belong to this project (not the seeded manual project).
  const board = store.createBoard({ projectId: project.id, name: 'intake' })
  store.updateAutonomy(project.id, { autonomy: 'you-approve', autoDispatch: false })
  store.updateIntake(project.id, {
    issueRepo: 'owner/repo', intakeBoardId: board.id,
    ...(intakeLimit === undefined ? {} : { intakeLimit }),
  })
  return { projectId: project.id, boardId: board.id }
}

test('runTick threads project.intakeLimit into deps.intake', async () => {
  const { store, project, board, cleanup } = setup()
  try {
    const { projectId } = intakeProject(store, 3)
    const calls = []
    const deps = engineDeps({
      intake: async (args) => { calls.push(args); return { created: [] } },
    })
    // The seeded project from setup() is manual; only the you-approve project runs intake.
    void project
    await runTick({ store, status: createEngineStatus(), deps, config: {} })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].limit, 3)
    assert.equal(calls[0].projectId, projectId)

    // Unset -> the engine passes null/undefined so the port default applies.
    const { projectId: noLimitId } = intakeProject(store, undefined)
    const calls2 = []
    const deps2 = engineDeps({ intake: async (args) => { calls2.push(args); return { created: [] } } })
    await runTick({ store, status: createEngineStatus(), deps: deps2, config: {} })
    const forNoLimit = calls2.find((c) => c.projectId === noLimitId)
    assert.ok(forNoLimit, 'intake should run for the second you-approve project')
    assert.ok(forNoLimit.limit === undefined || forNoLimit.limit === null)
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// End to end: intakeLimit caps a busy upstream to that many cards in one tick
// ---------------------------------------------------------------------------

test('end to end: intakeLimit=3 over a 100-issue upstream creates exactly 3 cards; unset creates up to 100', async () => {
  const { store, board, cleanup } = setup()
  try {
    // A gh port that HONOURS the limit it is handed, exactly like real `gh`
    // (default 100 when no limit). Upstream always "has" 100 open issues.
    const upstream = manyIssues(100)
    let lastLimit
    const honoringPort = {
      listIssues(_repo, opts = {}) {
        lastLimit = opts.limit
        const cap = opts.limit == null ? 100 : opts.limit
        return JSON.stringify(upstream.slice(0, cap))
      },
    }

    // intakeLimit = 3
    const { projectId: cappedId } = intakeProject(store, 3)
    await runTick({
      store, status: createEngineStatus(), config: {},
      deps: { ghPort: honoringPort, intake: intakeIssues, dispatch: async () => ({ mode: 'noop' }), isSessionActive: async () => false },
    })
    const cappedCards = store.listCards({ projectId: cappedId })
    assert.equal(lastLimit, 3)
    assert.equal(cappedCards.length, 3, 'a tick must not create more than intakeLimit cards')

    // Unset -> 100 default
    const { projectId: freeId } = intakeProject(store, undefined)
    await runTick({
      store, status: createEngineStatus(), config: {},
      deps: { ghPort: honoringPort, intake: intakeIssues, dispatch: async () => ({ mode: 'noop' }), isSessionActive: async () => false },
    })
    const freeCards = store.listCards({ projectId: freeId })
    assert.ok(lastLimit === undefined || lastLimit === null)
    assert.equal(freeCards.length, 100, 'without intakeLimit the default pull cap of 100 applies')
  } finally {
    cleanup()
  }
})
