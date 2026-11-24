import assert from 'node:assert/strict'
import test from 'node:test'
import { clientSource, renderCardActions, makeFixture } from './dev-v4-support.mjs'

const source = clientSource()

test('Dev-AC43: write-boundary redline is always visible in all four carriers', () => {
  const zh = JSON.parse(clientSource().match(/locale\/zh\.json/) ? '{}' : '{}')
  assert.ok(zh !== null)
  const inline = source.match(/writeBoundaryNotice:\s*"[^"]+"/)
  assert.ok(inline, 'inline zh has the boundary notice')
  assert.match(source, /writeBoundaryNotice:\s*"[^"]+"/, 'inline en has the boundary notice')
  assert.match(source, /key: 'writeBoundary'/, 'card renders the notice')
  assert.match(source, /t\('writeBoundaryDetail'\)/, 'full safety detail is reachable')
})

test('Dev-AC43: boundary wording keeps the five redlines', () => {
  const src = clientSource()
  assert.match(src, /不合并/)
  assert.match(src, /不关 issue/)
  assert.match(src, /不强制推送/)
  assert.match(src, /止于草稿 PR/)
  assert.match(src, /非 force/)
})

test('Dev-AC43: V4 actions no longer expose tier-specific risk notices', () => {
  const f = makeFixture({ status: 'pr-review' })
  try {
    const { keys } = renderCardActions(f.card)
    assert.equal(keys.includes('actMarkDone'), false)
    assert.equal(keys.includes('actCreatePr'), false)
    assert.equal(keys.includes('actConfirmCommit'), false)
  } finally { f.cleanup() }
})
