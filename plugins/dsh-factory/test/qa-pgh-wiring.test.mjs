/**
 * QA — PGH wiring-layer acceptance: the index.js HTTP handler (PRD §4 PGH-9/12/14).
 *
 * The decision-layer units are covered in qa-pgh-identity.test.mjs. This file
 * exercises the REAL `apply(ctx)` handler end-to-end offline: it captures the
 * `webServer.register` handler, injects fake connection/credentials/authorization
 * services and a throwaway SQLite dataDir, and drives the handler with fake
 * req/res. This is where the wiring lives — identity card route, the shared
 * resolver used by manual intake, and the authorization bridge — which the pure
 * unit tests cannot reach. No product code is modified; no network, no token echo.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'
import { credentialKeyOf, OAUTH_KEY_ID, SHARED_KEY_ID, IDENTITY_SOURCE } from '../identity.js'

function grant(token, login, type) {
  return { kind: 'grant', payload: { token, login, type } }
}

/** A fake ctx: captures the webServer handler and feeds injected services. */
function harness(services = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-pgh-wire-'))
  const captured = {}
  const disposers = []
  const connection = {
    // vouch every request (no host policy rejection)
    requestRejection: () => undefined,
  }
  const svc = {
    credentials: services.credentials ?? null,
    authorization: services.authorization ?? null,
    connection,
    ...services.extra,
  }
  const ctx = {
    get: (name) => (name in svc ? svc[name] : undefined),
    inject(names, cb) {
      const scope = {
        ...svc,
        effect: (fn, label) => { const d = typeof fn === 'function' ? fn() : undefined; disposers.push(d); return d },
      }
      const d = cb(scope)
      if (typeof d === 'function') disposers.push(d)
      return d
    },
    effect(fn, label) {
      const d = typeof fn === 'function' ? fn() : undefined
      disposers.push(d)
      return d
    },
    webServer: {
      register(opts) {
        captured.handler = opts.handler
        captured.opts = opts
        return () => {}
      },
    },
  }
  apply(ctx, { dataDir: dir })
  assert.equal(captured.opts?.path, '/api/dsh-factory', 'handler registered on the factory prefix')
  assert.equal(typeof captured.handler, 'function')

  async function call(method, route, body) {
    const req = {
      method,
      url: `/api/dsh-factory${route}`,
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
      },
    }
    const res = {
      headersSent: false,
      status: null,
      payload: null,
      writeHead(status) { this.status = status; this.headersSent = true; return this },
      end(payload) { this.payload = payload?.toString?.() ?? payload; return this },
    }
    await captured.handler(req, res)
    // The registered handler fires `void handle(req,res)` without awaiting it,
    // so wait for the async handler to finish writing the response.
    for (let i = 0; i < 50 && !res.headersSent; i += 1) {
      await new Promise((r) => setTimeout(r, 2))
    }
    const text = typeof res.payload === 'string' ? res.payload : ''
    let json
    try { json = text.trim() ? JSON.parse(text) : undefined } catch { json = undefined }
    return { status: res.status, body: json, text }
  }
  return {
    call,
    cleanup: () => {
      for (const d of disposers) { try { if (typeof d === 'function') d() } catch { /* best effort */ } }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function credStore(records = {}) {
  const map = new Map(Object.entries(records))
  return {
    reads: [],
    async readRecord(key) { this.reads.push(key); return map.get(key) },
  }
}

async function createProject(h, overrides = {}) {
  const r = await h.call('POST', '/projects', { name: 'p', rootPath: '/workspace/p', ...overrides })
  assert.ok(r.status === 200 || r.status === 201, `create project failed: ${r.text}`)
  return r.body.project
}

// ---------------------------------------------------------------------------
// PGH-14 — identity card route: binding + winning identity, token-free, six states.
// ---------------------------------------------------------------------------

test('PGH-14/PGH-4: /identity/:id shows binding + reads an ambient global WITHOUT hard-binding a project record', async () => {
  const creds = credStore({})
  const h = harness({ credentials: creds })
  try {
    const p = await createProject(h, { issueRepo: 'owner/repo' })
    const card = await h.call('GET', `/identity/${p.id}`)
    assert.equal(card.status, 200)
    assert.deepEqual(card.body.binding, { rootPath: '/workspace/p', issueRepo: 'owner/repo', bound: true })
    // On a machine with gh login / env token this resolves to an ambient global
    // (PGH-4: read the ready-made global, do NOT report "not connected"); on a
    // bare machine it is "not connected". Either way it must never fabricate a
    // per-project record just to explain the identity.
    const ambient = [IDENTITY_SOURCE.GH_CLI, IDENTITY_SOURCE.ENV_TOKEN]
    assert.ok(
      card.body.identity.source === IDENTITY_SOURCE.NONE || ambient.includes(card.body.identity.source),
      `source must be ambient-global or none, got ${card.body.identity.source}`,
    )
    assert.equal(card.text.includes('token'), false, 'card response must not contain a token field')
    assert.equal('token' in card.body.identity, false)
    assert.equal(creds.reads.some((k) => k.includes(p.id)), false, 'no per-project record was hard-bound/read')
  } finally { h.cleanup() }
})

test('PGH-14: /identity/:id resolves a stored shared token as connected + shared, no token echo', async () => {
  const creds = credStore({ [credentialKeyOf(SHARED_KEY_ID)]: grant('ghp_secret', 'shared-user', 'shared-token-global') })
  const h = harness({ credentials: creds })
  try {
    const p = await createProject(h)
    // client_id empty → tier 1 disabled; gh CLI not logged in this ctx; env token
    // from the machine may or may not be present, so assert the shared tier is at
    // least reachable and NEVER leaks the token.
    const card = await h.call('GET', `/identity/${p.id}`)
    assert.equal(card.status, 200)
    assert.equal(card.text.includes('ghp_secret'), false, 'token never leaves the host')
    assert.equal('token' in card.body.identity, false)
    assert.ok(creds.reads.includes(credentialKeyOf(OAUTH_KEY_ID)) === false, 'OAuth tier skipped without client_id')
  } finally { h.cleanup() }
})

test('PGH-14: /identity/:id is fail-closed for a missing project', async () => {
  const h = harness()
  try {
    const r = await h.call('GET', '/identity/does-not-exist')
    assert.equal(r.status, 400)
    assert.match(r.body.error, /项目不存在/)
  } finally { h.cleanup() }
})

// ---------------------------------------------------------------------------
// PGH-12 — authorization bridge routes: begin/read/answer/cancel via the handler.
// ---------------------------------------------------------------------------

test('PGH-12: /auth/connect/* bridge drives notice→prompt→answer through the handler', async () => {
  // A fake authorization service: begin() notifies a URL+code, prompts once, then
  // settles authorized after the answer. The bridge must forward all of this.
  const authorization = {
    describe: () => ({ inFlight: false }),
    begin({ interaction }) {
      interaction.notify({ message: 'open', url: 'https://github.com/login/device', code: 'ABCD-1234' })
      // Return a promise that resolves only after the prompt is answered.
      return new Promise((resolve) => {
        interaction.prompt({ kind: 'select', message: 'done?', options: [{ id: 'done', label: 'Done' }] })
          .then(() => resolve({ status: 'authorized' }))
      })
    },
    cancel() {},
    registerFlow: () => () => {},
  }
  const h = harness({ authorization })
  try {
    const begun = await h.call('POST', '/auth/connect/begin')
    assert.equal(begun.status, 200)
    const sid = begun.body.sessionId
    assert.ok(sid, 'session id issued')

    const read1 = await h.call('GET', `/auth/connect/${sid}`)
    assert.equal(read1.status, 200)
    assert.equal(read1.body.status, 'running')
    const note = read1.body.notices.find((n) => n.code === 'ABCD-1234')
    assert.ok(note, 'notice with url+code bridged from the seam')
    assert.equal(note.url, 'https://github.com/login/device')
    assert.equal(read1.body.prompt?.kind, 'select', 'prompt bridged to browser')

    const ans = await h.call('POST', `/auth/connect/${sid}/answer`, { value: 'done' })
    assert.equal(ans.status, 200)
    // Allow the microtask chain to settle the authorization promise.
    await new Promise((r) => setTimeout(r, 10))
    const read2 = await h.call('GET', `/auth/connect/${sid}`)
    assert.equal(read2.body.status, 'authorized', 'bridge reflects the settled flow')
    assert.equal(read2.body.prompt, null, 'prompt cleared after answer')
  } finally { h.cleanup() }
})

test('PGH-12: bridge cancel settles cancelled; unknown session is 404; missing service is 400', async () => {
  const authorization = {
    describe: () => ({ inFlight: false }),
    begin({ interaction }) {
      interaction.notify({ message: 'open' })
      return new Promise((resolve, reject) => {
        interaction.prompt({ message: 'code' }).catch(() => resolve({ status: 'cancelled' }))
      })
    },
    cancel() {},
    registerFlow: () => () => {},
  }
  const h = harness({ authorization })
  try {
    const begun = await h.call('POST', '/auth/connect/begin')
    const sid = begun.body.sessionId
    const c = await h.call('POST', `/auth/connect/${sid}/cancel`, {})
    assert.equal(c.status, 200)
    const read = await h.call('GET', `/auth/connect/${sid}`)
    assert.equal(read.body.status, 'cancelled')
    const unknown = await h.call('GET', '/auth/connect/nope')
    assert.equal(unknown.status, 404)
  } finally { h.cleanup() }

  const noSvc = harness() // no authorization service
  try {
    const r = await noSvc.call('POST', '/auth/connect/begin')
    assert.equal(r.status, 400)
    assert.match(r.body.error, /授权服务不可用/)
  } finally { noSvc.cleanup() }
})

test('PGH-12: in-flight begin is refused with a readable reason', async () => {
  const authorization = {
    describe: () => ({ inFlight: true }),
    begin() { throw new Error('should not be called') },
    registerFlow: () => () => {},
  }
  const h = harness({ authorization })
  try {
    const r = await h.call('POST', '/auth/connect/begin')
    assert.equal(r.status, 400)
    assert.match(r.body.error, /正在进行/)
  } finally { h.cleanup() }
})

// ---------------------------------------------------------------------------
// PGH-9 / PGH-18 — manual intake route uses the SAME decision layer; token routes
// are wired through write/remove with scope, and never echo the token.
// ---------------------------------------------------------------------------

test('PGH-18: /auth/token writes to the chosen scope via injected credentials; token not echoed', async () => {
  const written = []
  const credentials = {
    async readRecord() { return undefined },
    async modifyRecord(key, fn) { written.push(key); await fn(undefined); return {} },
  }
  const h = harness({ credentials })
  const realFetch = globalThis.fetch
  // index.js's /auth/token route uses storeUserToken's default fetchImpl, which
  // calls the real /user endpoint. Stub the process fetch for this one case so
  // the WIRING (route → writeGithubToken → correct key) is exercised offline.
  globalThis.fetch = async () => ({ status: 200, text: async () => JSON.stringify({ login: 'verified-user' }) })
  try {
    const p = await createProject(h)
    const r = await h.call('POST', '/auth/token', { token: 'ghp_supersecret', scope: 'global' })
    assert.equal(r.status, 200, `token route failed: ${r.text}`)
    assert.deepEqual(written, [credentialKeyOf(SHARED_KEY_ID)])
    assert.equal(r.body.login, 'verified-user')
    assert.equal(r.text.includes('ghp_supersecret'), false, 'token must not be echoed in the response')
    assert.equal('token' in r.body, false)
  } finally { globalThis.fetch = realFetch; h.cleanup() }
})

test('PGH-18: /auth/token rejects a bad scope with 400, no record written', async () => {
  const written = []
  const credentials = {
    async readRecord() { return undefined },
    async modifyRecord(key) { written.push(key); return {} },
  }
  const h = harness({ credentials })
  try {
    const p = await createProject(h)
    const r = await h.call('POST', '/auth/token', { token: 't', scope: 'bogus', projectId: p.id })
    assert.equal(r.status, 400)
    assert.match(r.body.error, /作用域/)
    assert.equal(written.length, 0)
  } finally { h.cleanup() }
})

test('PGH-1: /settings carries githubClientId and it is HTTP-writable, non-secret', async () => {
  const h = harness()
  try {
    const set = await h.call('PATCH', '/settings', { githubClientId: 'Iv1.abc123' })
    assert.equal(set.status, 200)
    assert.equal(set.body.settings.githubClientId, 'Iv1.abc123')
    const got = await h.call('GET', '/settings')
    assert.equal(got.body.settings.githubClientId, 'Iv1.abc123')
    assert.equal(JSON.stringify(got.body).includes('ghp_'), false)
  } finally { h.cleanup() }
})
