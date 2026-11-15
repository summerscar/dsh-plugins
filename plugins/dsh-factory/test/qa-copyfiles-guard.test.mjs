/**
 * QA — deterministic `copyFiles` guard (2026-11-15, round 5).
 *
 * Why this file exists: the same target repository produced `copyFiles: []` in
 * one real-machine run and three TRACKED entries in the next, with the same
 * skill text. That is model judgement variance, which no wording fixes. The
 * guard in `dropTrackedCopyFiles` makes the outcome deterministic: the git index
 * decides, not the model.
 *
 * The safety property that matters most is the soft failure: if reading the git
 * index fails, the input must come back untouched. A redundant copy is
 * acceptable; a failed project creation is not.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { dropTrackedCopyFiles, defaultLsFilesPort } from '../worktree-setup.js'
import { FactoryStore } from '../store.js'
import { factoryToolSpecs } from '../tools.js'

const fakePort = (tracked) => ({ lsFiles: () => tracked })
const throwingPort = () => ({ lsFiles: () => { throw new Error('git ls-files 失败（exit 128）') } })

test('guard: tracked entries are dropped, untracked ones kept', () => {
  const result = dropTrackedCopyFiles({
    repoPath: '/repo',
    files: ['.npmrc', '.env.local', 'pnpm-lock.yaml', 'config/local.json'],
    port: fakePort(['.npmrc', 'pnpm-lock.yaml', 'AGENTS.md']),
  })
  assert.deepEqual(result.files, ['.env.local', 'config/local.json'], 'only untracked entries survive')
  assert.deepEqual(result.dropped.map((d) => d.path), ['.npmrc', 'pnpm-lock.yaml'])
  for (const entry of result.dropped) {
    assert.match(entry.reason, /已被 git 跟踪/, 'each dropped entry says why')
  }
})

test('guard: an empty or all-untracked request keeps everything', () => {
  assert.deepEqual(dropTrackedCopyFiles({ repoPath: '/r', files: [], port: fakePort(['a']) }),
    { files: [], dropped: [] })
  const all = dropTrackedCopyFiles({ repoPath: '/r', files: ['.env', '.env.local'], port: fakePort(['a']) })
  assert.deepEqual(all.files, ['.env', '.env.local'])
  assert.deepEqual(all.dropped, [])
})

test('guard: reading the git index fails => input is returned unchanged (never blocks creation)', () => {
  const files = ['.npmrc', 'pnpm-lock.yaml']
  const result = dropTrackedCopyFiles({ repoPath: '/repo', files, port: throwingPort() })
  assert.deepEqual(result.files, files, 'a redundant entry beats a failed creation')
  assert.deepEqual(result.dropped, [], 'nothing is claimed to be dropped when the index is unreadable')
})

test('guard: a non-array lsFiles result is also treated as unreadable', () => {
  const files = ['.env']
  const result = dropTrackedCopyFiles({ repoPath: '/r', files, port: { lsFiles: () => null } })
  assert.deepEqual(result.files, files)
  assert.deepEqual(result.dropped, [])
})

test('guard: windows-style separators are matched against the git index', () => {
  const result = dropTrackedCopyFiles({
    repoPath: '/r', files: ['.husky\\pre-commit'], port: fakePort(['.husky/pre-commit']),
  })
  assert.deepEqual(result.files, [], 'a backslash entry still matches its tracked slash form')
  assert.deepEqual(result.dropped.map((d) => d.path), ['.husky/pre-commit'])
})

test('guard: the input array is not mutated', () => {
  const files = ['.npmrc', '.env.local']
  dropTrackedCopyFiles({ repoPath: '/r', files, port: fakePort(['.npmrc']) })
  assert.deepEqual(files, ['.npmrc', '.env.local'], 'the caller\'s array stays as it was')
})

test('create tool: the value written to the store is already clean, not just the receipt', async () => {
  // The point of the guard is that the REGISTERED config is clean. Asserting
  // only on the returned receipt would let a future refactor clean the reply
  // while still persisting the redundant entries.
  const tmp = mkdtempSync(join(tmpdir(), 'qa-guard-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const specs = new Map(factoryToolSpecs({
    store,
    assertRoot: (p) => p,
    inspect: () => ({ rootPath: '/repo', packageManager: '', rootFiles: [], rootDirectories: [], ignoreFiles: {}, manifestFiles: [], notes: [] }),
    lsFilesPort: fakePort(['.npmrc', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']),
  }).map((s) => [s.name, s]))
  try {
    const created = await specs.get('factory_create_project').execute({
      name: 'guarded', rootPath: '/repo',
      copyFiles: ['.npmrc', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.env.local'],
      postCreate: '',
    })
    const saved = store.getProject(created.id)
    assert.deepEqual(saved.copyFiles, ['.env.local'], 'the store holds only untracked entries')
    // The receipt carries the dropped PATHS (strings), not the internal
    // { path, reason } records — the reason lives in the guard's own result.
    assert.deepEqual(created.droppedCopyFiles, ['.npmrc', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'])
    // The receipt must stay lossless: no undefined members, and the dropped
    // key is absent entirely when nothing was dropped.
    assert.equal('warning' in created, false)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('create tool: droppedCopyFiles is absent when nothing was dropped', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-guard2-'))
  const store = new FactoryStore({ file: join(tmp, 'factory.json') })
  const specs = new Map(factoryToolSpecs({
    store,
    assertRoot: (p) => p,
    lsFilesPort: fakePort([]),
  }).map((s) => [s.name, s]))
  try {
    const created = await specs.get('factory_create_project').execute({
      name: 'clean', rootPath: '/repo', copyFiles: ['.env.local'], postCreate: '',
    })
    assert.equal('droppedCopyFiles' in created, false, 'absent, not undefined — the host rejects undefined')
    const rendered = specs.get('factory_create_project').output.render({}, created)
    assert.equal(Array.isArray(rendered), true)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('guard against the real index: a tracked file in this repo is dropped, a fake one kept', () => {
  // The fake ports above prove the branching; this one proves the real git
  // invocation is wired correctly (argv, -z splitting) against an actual repo.
  const repoPath = new URL('..', import.meta.url).pathname
  const result = dropTrackedCopyFiles({
    repoPath,
    files: ['package.json', '.env.qa-not-a-real-file'],
    port: defaultLsFilesPort(),
  })
  assert.deepEqual(result.files, ['.env.qa-not-a-real-file'], 'package.json is tracked, so it is redundant')
  assert.deepEqual(result.dropped.map((d) => d.path), ['package.json'])
})
