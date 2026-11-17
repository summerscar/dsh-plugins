/**
 * QA — P4-github INCREMENT acceptance (PRD §4 PGH-19~22).
 *
 *   PGH-19  OAuth disconnect: local deleteRecord only (idempotent), honest deep
 *           link, NO remote revoke / client_secret endpoint, no false copy.
 *   PGH-20  reset = disconnect + reconnect bridge (wiring covered in the wiring
 *           suite); here the disconnect half + button-state copy are asserted.
 *   PGH-21  gh CLI state: logged-in AND logged-out both reported, read-only, no
 *           record create/delete, no login side effect.
 *   PGH-22  liveness probe: a dead token-backed tier falls through to the next
 *           tier (NO false green), login is merged from the probe, tier ORDER is
 *           unchanged, and behaviour is backward-compatible without verifyToken.
 *
 * All against the REAL modules with injected seams; no product code modified.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  decideIdentity, identityView, repoCredentialSegment, credentialKeyOf,
  IDENTITY_SOURCE, SOURCE_TYPE, OAUTH_KEY_ID, SHARED_KEY_ID, CREDENTIAL_SCOPE,
} from '../identity.js'
import {
  disconnectOAuth, oauthState, ghCliState,
} from '../github-api.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const clientSrc = readFileSync(join(packageRoot, 'client.js'), 'utf8')
const apiSrc = readFileSync(join(packageRoot, 'github-api.js'), 'utf8')

function grant(token, login, type = 'repo-credential') {
  return { kind: 'grant', payload: { token, login, type } }
}
function credStore(records = {}) {
  const map = new Map(Object.entries(records))
  const calls = { reads: [], writes: [], deletes: [] }
  return {
    calls,
    async readRecord(k) { calls.reads.push(k); return map.get(k) },
    async describeRecord(k) { return { configured: map.has(k) } },
    async modifyRecord(k, fn) { calls.writes.push(k); const n = await fn(map.get(k)); map.set(k, n); return n },
    async deleteRecord(k) { calls.deletes.push(k); map.delete(k) },
  }
}
const noProbe = () => false
const EMPTY_ENV = {}

// ---------------------------------------------------------------------------
// PGH-19 — OAuth disconnect: local only, idempotent, honest deep link.
// ---------------------------------------------------------------------------

test('PGH-19: disconnectOAuth deletes ONLY the local oauth-global record and returns the revoke deep link', async () => {
  const creds = credStore({ [credentialKeyOf(OAUTH_KEY_ID)]: grant('tok', 'u', 'oauth-device-flow') })
  const r = await disconnectOAuth({ credentials: creds, clientId: 'Iv1.abc123' })
  assert.deepEqual(creds.calls.deletes, [credentialKeyOf(OAUTH_KEY_ID)], 'only oauth-global removed')
  assert.equal(creds.calls.writes.length, 0, 'no record rewritten')
  assert.equal(r.disconnected, true)
  assert.equal(r.revokeUrl, 'https://github.com/settings/connections/applications/Iv1.abc123')
  assert.equal(JSON.stringify(r).includes('tok'), false, 'no token in the response')
})

test('PGH-19: disconnectOAuth is idempotent (missing record = no-op) and honest without client_id', async () => {
  const creds = credStore({}) // nothing stored
  const r = await disconnectOAuth({ credentials: creds, clientId: '' })
  assert.equal(r.disconnected, true, 'still reports success (local is already clean)')
  assert.equal(r.revokeUrl, 'https://github.com/settings/applications', 'falls back to generic applications page')
  assert.equal(creds.calls.deletes.length, 1, 'delete attempted once, idempotent')
})

test('PGH-19: disconnect NEVER calls a revoke endpoint and makes no false claim', () => {
  // No remote revoke URL anywhere, and no client_secret sent as a form/body field
  // (the word may appear in a WARNING comment — that is fine; we check code shapes).
  assert.equal(/login\/oauth\/revoke|applications\/[^"'`]*\/revoke/i.test(apiSrc), false,
    'no remote revoke endpoint URL in the module')
  assert.equal(/form\(\{[^}]*client_secret|client_secret:/i.test(apiSrc), false,
    'client_secret is never sent as a request field')
  const userVisible = JSON.stringify([...clientSrc.matchAll(/gh[A-Za-z]+:\s*["']([^"']+)["']/g)].map((m) => m[1]))
  assert.equal(/已帮你撤销|已撤销授权|we revoked it for you|revoked for you/i.test(userVisible), false,
    'no false "we revoked" claim in user-facing copy')
  // The only "revoked for you" phrasing is the WARNING comment in code, not copy.
  assert.match(apiSrc, /never claim/i)
})

test('PGH-19/20: disconnect fails closed when the credential service is missing', async () => {
  await assert.rejects(() => disconnectOAuth({ credentials: null, clientId: 'x' }), /凭据服务不可用/)
})

test('PGH-20: oauthState reports connected/inFlight/hasAppId without leaking the token', async () => {
  const creds = credStore({ [credentialKeyOf(OAUTH_KEY_ID)]: grant('tok', 'u', 'oauth-device-flow') })
  const authorization = { describe: () => ({ inFlight: true }) }
  const s = await oauthState({ credentials: creds, authorization, clientId: 'Iv1.abc' })
  assert.deepEqual(s, { connected: true, inFlight: true, hasAppId: true })
  assert.equal(JSON.stringify(s).includes('tok'), false)
  const empty = await oauthState({ credentials: credStore({}), clientId: '' })
  assert.deepEqual(empty, { connected: false, inFlight: false, hasAppId: false })
})

// ---------------------------------------------------------------------------
// PGH-21 — gh CLI state: both states, read-only, no record touch.
// ---------------------------------------------------------------------------

test('PGH-21: ghCliState reports logged-in with best-effort name, no record writes', () => {
  const creds = credStore()
  const ghExec = () => ({ status: 0, stdout: 'octocat\n' })
  const on = ghCliState({ env: EMPTY_ENV, probeGhLogin: () => true, ghExec })
  assert.deepEqual(on, { loggedIn: true, login: 'octocat' })
  assert.equal(creds.calls.writes.length + creds.calls.deletes.length, 0)
})

test('PGH-21: ghCliState reports logged-OUT explicitly (row still shows), name null, no crash', () => {
  const ghExec = () => { throw new Error('should not be called when logged out') }
  const off = ghCliState({ env: EMPTY_ENV, probeGhLogin: () => false, ghExec })
  assert.deepEqual(off, { loggedIn: false, login: null }, 'logged-out is a real state, not omitted')
})

test('PGH-21: a name-lookup failure keeps loggedIn=true (name failure must not flip state)', () => {
  const ghExec = () => ({ status: 1, stdout: '' })
  const s = ghCliState({ env: EMPTY_ENV, probeGhLogin: () => true, ghExec })
  assert.equal(s.loggedIn, true)
  assert.equal(s.login, null)
})

// ---------------------------------------------------------------------------
// PGH-22 — liveness probe: dead tier falls through, login merged, order kept,
// backward compatible.
// ---------------------------------------------------------------------------

test('PGH-22: a dead OAuth token falls through to the next tier (NO false green)', async () => {
  const project = { id: 'aaaa-1111', githubCredentialId: null }
  const creds = credStore({
    [credentialKeyOf(OAUTH_KEY_ID)]: grant('dead-oauth', 'cached-user', 'oauth-device-flow'),
    [credentialKeyOf(SHARED_KEY_ID)]: grant('live-shared', 'shared-user', 'shared-token-global'),
  })
  // verifyToken: only the shared token is alive; OAuth probe throws (dead).
  const verifyToken = async (tok) => {
    if (tok === 'dead-oauth') throw new Error('Bad credentials')
    return { login: 'shared-user' }
  }
  const d = await decideIdentity({
    project, clientId: 'cid', env: EMPTY_ENV, readRecord: creds.readRecord, probeGhLogin: noProbe, verifyToken,
  })
  assert.equal(d.source, IDENTITY_SOURCE.SHARED_TOKEN, 'dead OAuth skipped, shared wins — no false green')
  assert.equal(d.token, 'live-shared')
})

test('PGH-22: dead OAuth AND dead env AND dead shared → repo fallback; all dead → none', async () => {
  const project = { id: 'bbbb-2222', githubCredentialId: null }
  const seg = repoCredentialSegment(project)
  const creds = credStore({
    [credentialKeyOf(OAUTH_KEY_ID)]: grant('dead1', 'u1', 'oauth-device-flow'),
    [credentialKeyOf(SHARED_KEY_ID)]: grant('dead2', 'u2', 'shared-token-global'),
    [credentialKeyOf(seg)]: grant('live-repo', 'repo-user'),
  })
  const verifyToken = async (tok) => {
    if (tok === 'live-repo') return { login: 'repo-user' }
    throw new Error('dead')
  }
  let d = await decideIdentity({
    project, clientId: 'cid', env: { GH_TOKEN: 'dead-env' }, readRecord: creds.readRecord, probeGhLogin: noProbe, verifyToken,
  })
  assert.equal(d.source, IDENTITY_SOURCE.REPO_KEY, 'every higher tier dead → repo fallback wins')

  // All dead, including repo → not connected (no false green anywhere).
  const allDead = credStore({
    [credentialKeyOf(OAUTH_KEY_ID)]: grant('d1', 'u1', 'oauth-device-flow'),
    [credentialKeyOf(SHARED_KEY_ID)]: grant('d2', 'u2', 'shared-token-global'),
    [credentialKeyOf(seg)]: grant('d3', 'u3'),
  })
  const verifyNone = async () => { throw new Error('dead') }
  d = await decideIdentity({
    project, clientId: 'cid', env: { GH_TOKEN: 'dead-env' }, readRecord: allDead.readRecord, probeGhLogin: noProbe, verifyToken: verifyNone,
  })
  assert.equal(d.source, IDENTITY_SOURCE.NONE, 'all token tiers dead → none, no false green')
  assert.equal('token' in identityView(d), false)
})

test('PGH-22: login is MERGED from the probe (rotated token shows the real account)', async () => {
  const project = { id: 'cccc-3333', githubCredentialId: null }
  const creds = credStore({ [credentialKeyOf(SHARED_KEY_ID)]: grant('tok', 'stale-login', 'shared-token-global') })
  const verifyToken = async () => ({ login: 'real-login' })
  const d = await decideIdentity({
    project, env: EMPTY_ENV, readRecord: creds.readRecord, probeGhLogin: noProbe, verifyToken,
  })
  assert.equal(d.source, IDENTITY_SOURCE.SHARED_TOKEN)
  assert.equal(d.login, 'real-login', 'probe login overrides stale cached login')
  assert.equal(d.loginFrom, 'probe')
})

test('PGH-22: liveness probing does NOT change tier order (OAuth still first when alive)', async () => {
  const project = { id: 'dddd-4444', githubCredentialId: null }
  const creds = credStore({
    [credentialKeyOf(OAUTH_KEY_ID)]: grant('oauth-live', 'oauth-u', 'oauth-device-flow'),
    [credentialKeyOf(SHARED_KEY_ID)]: grant('shared-live', 'shared-u', 'shared-token-global'),
  })
  const seen = []
  const verifyToken = async (tok) => { seen.push(tok); return { login: 'u' } }
  const d = await decideIdentity({
    project, clientId: 'cid', env: { GH_TOKEN: 'env-tok' }, readRecord: creds.readRecord,
    probeGhLogin: () => true, verifyToken,
  })
  assert.equal(d.source, IDENTITY_SOURCE.OAUTH, 'OAuth still beats gh CLI/env/shared when alive')
  assert.deepEqual(seen, ['oauth-live'], 'ladder stops at the first live hit — only one probe')
})

test('PGH-22: backward compatible — WITHOUT verifyToken, cached login is used and behaviour is unchanged', async () => {
  const project = { id: 'eeee-5555', githubCredentialId: null }
  const creds = credStore({ [credentialKeyOf(SHARED_KEY_ID)]: grant('tok', 'cached-user', 'shared-token-global') })
  const d = await decideIdentity({ project, env: EMPTY_ENV, readRecord: creds.readRecord, probeGhLogin: noProbe })
  assert.equal(d.source, IDENTITY_SOURCE.SHARED_TOKEN)
  assert.equal(d.login, 'cached-user', 'no probe → cached login')
  assert.equal(d.loginFrom, 'record')
})
