/**
 * Dev self-check: factory selects a NAMED permission preset on live sessions so
 * DSH's Access-mode control shows the configured tier instead of "Custom".
 * A preset bundles sandbox/mode + approval/policy; factory only seeds sandbox.
 */
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { createHostPort } from '../dispatch.js'

const here = dirname(fileURLToPath(import.meta.url))
const dispatchSrc = (await import('node:fs')).readFileSync(join(here, '..', 'dispatch.js'), 'utf8')
assert.match(dispatchSrc, /permissionPresets\.set\(handle\.agent\?\.session, 'auto'\)/, 'auto preset path stays intact')

function makeCtx() {
  const seen = { create: null, resume: null, followup: null, message: null, appends: [] }
  const state = { sandbox: null }
  const session = {
    id: 'live-session',
    append(type, data) {
      seen.appends.push({ type, data })
      if (type === 'sandbox/mode') state.sandbox = data.mode
    },
  }
  const agent = { session, followup: (message) => { seen.message = message } }
  const selected = new Map()
  const presets = {
    calls: [],
    set(s, name) { presets.calls.push(name); selected.set(s, name) },
    current(s) { return selected.get(s) ?? 'custom' },
  }
  const ctx = {
    get: (name) => {
      if (name === 'agents') return {
        create: async (options) => { seen.create = options; for (const event of options.seed ?? []) session.append(event.type, event.data); return { agent, dispose: () => {} } },
        resume: async (options) => { seen.resume = options; return { agent, dispose: () => {} } },
        get: (id) => { seen.followup = id; return agent },
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: state.sandbox }) }
      if (name === 'permissionPresets') return presets
      return undefined
    },
  }
  return { ctx, seen, state, session, presets }
}

const portFor = (ctx) => createHostPort({ ctx, createUserMessage: ({ content, source }) => ({ role: 'user', content, source }) })

const CASES = [
  ['workspace-write', 'workspace-write', 'workspace-write'],
  ['full-access', 'danger-full-access', 'danger-full-access'],
  ['auto-review', 'auto', 'danger-full-access'],
]

test('Dev-Preset: createSession selects the named preset matching workMode', async () => {
  for (const [workMode, expectedPreset, expectedSandbox] of CASES) {
    const f = makeCtx()
    const port = portFor(f.ctx)
    await port.createSession({
      cwd: '/tmp/wt', workMode, setup: async () => {}, firstMessage: 'go',
      permissionPreset: workMode === 'auto-review' ? 'auto' : undefined,
    })
    assert.deepEqual(f.presets.calls, [expectedPreset], `${workMode}: one set to the named preset`)
    assert.equal(f.presets.current(f.session), expectedPreset, `${workMode}: current() is not custom`)
    assert.equal(f.state.sandbox, expectedSandbox, `${workMode}: sandbox boundary unchanged by set`)
    assert.equal(f.seen.message.role, 'user', `${workMode}: first message still delivered`)
  }
})

test('Dev-Preset: resumeSession selects the named preset too', async () => {
  const f = makeCtx()
  f.session.append('sandbox/mode', { mode: 'danger-full-access' })
  const port = portFor(f.ctx)
  await port.resumeSession({ resumeSessionId: 'old', cwd: '/tmp/wt', workMode: 'full-access', setup: async () => {}, firstMessage: 'go' })
  assert.deepEqual(f.presets.calls, ['danger-full-access'])
  assert.equal(f.presets.current(f.session), 'danger-full-access')
  assert.equal(f.state.sandbox, 'danger-full-access')
})

test('Dev-Preset: followupSession does not re-select on a live session', async () => {
  const f = makeCtx()
  f.session.append('sandbox/mode', { mode: 'danger-full-access' })
  const port = portFor(f.ctx)
  await port.followupSession({ sessionId: 'old', message: 'go', workMode: 'full-access' })
  assert.deepEqual(f.presets.calls, [], 'preset was fixed at creation; no mid-run switch notice')
  assert.equal(f.seen.followup, 'old')
})
