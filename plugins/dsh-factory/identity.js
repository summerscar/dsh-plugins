/**
 * dsh-factory — project-level GitHub identity decision layer.
 *
 * This is the SINGLE裁决点 for "which GitHub identity does this project use".
 * It is pure and injectable: credentials, gh-login probing and the process env
 * all arrive as arguments, so the whole five-tier ladder is testable offline with
 * no host, no gh binary and no network.
 *
 * The hard rules it exists to enforce (PRD §3.2, pitfalls ⑤⑥):
 *   - JUDGE BEFORE INJECT. Deciding only READS state; it never writes tokens into
 *     env. `probeGhLogin` internally strips GH_TOKEN/GITHUB_TOKEN to test a real
 *     `gh` login, so any explicit token injected beforehand would be erased and
 *     misread as "gh is logged in". Keeping decisions side-effect-free is what
 *     stops the probe and the injection from fighting.
 *   - ONE winner, ONE mapping. The ladder stops at the first hit and produces a
 *     single `git` argument group for the UNCHANGED `buildGitEnv`. Never two
 *     tokens at once (pitfall ⑤: an explicit token is the HIGHEST branch there,
 *     the opposite of "repo fallback last" — so the ladder must pick before
 *     buildGitEnv sees anything).
 *
 * Five tiers, high → low (order locked):
 *   1. global OAuth        (oauth-global record)           → credentialToken
 *   2. gh CLI login        (probeGhLogin)                  → ghLoggedIn=true
 *   3. explicit shared token (token-global record)         → credentialToken
 *   4. deployment env token (GH_TOKEN / GITHUB_TOKEN)       → no args (inherit)
 *   5. per-repo key        (<project segment> record)      → credentialToken
 *   —  none                → no args, "not connected"
 *
 * Tier 3 is the manually configured global Token; it deliberately outranks
 * tier 4 so a saved token OVERRIDES the env-token default. Tier 4 is the same
 * global-token tier's default value when no manual token is live. Only the
 * record tiers (1/3/5) read records; tiers 2/4 are read from the machine.
 */
import { probeGhLogin as realProbeGhLogin } from './git-exec.js'

/** Credential record scope — the owning plugin's registered name. */
export const CREDENTIAL_SCOPE = 'dsh-factory'
/** Fixed global record ids. */
export const OAUTH_KEY_ID = 'oauth-global'
export const SHARED_KEY_ID = 'token-global'

/** Stable machine-readable source ids (UI copy is Design's, humanised, i18n). */
export const IDENTITY_SOURCE = {
  OAUTH: 'oauth-global',
  GH_CLI: 'gh-cli',
  ENV_TOKEN: 'env-token',
  SHARED_TOKEN: 'shared-token',
  REPO_KEY: 'repo-key',
  NONE: 'none',
}

/** The three top-level credential sources, for the identity card's grouping. */
export const SOURCE_TYPE = {
  OAUTH_APP: 'oauth-app',   // GitHub OAuth App — necessarily global
  GH_CLI: 'gh-cli',         // gh CLI login — necessarily global
  GH_TOKEN: 'gh-token',     // user-supplied token — scope chosen by the user
}

/**
 * Credential-key segment grammar, mirrored verbatim from the host seam. Kept
 * local so this module has ZERO runtime dependency on the optional peer (offline
 * tests and the zero-build client must not need to resolve dsh-credentials).
 */
const KEY_SEGMENT = /^[a-z][a-z0-9-]*$/
export function isKeySegment(value) {
  return typeof value === 'string' && KEY_SEGMENT.test(value)
}

/** Build `dsh-factory/<id>` — byte-identical to the host's credentialKey(). */
export function credentialKeyOf(id) {
  if (!isKeySegment(id)) throw new TypeError(`credential key segment "${String(id)}" must match ${String(KEY_SEGMENT)}`)
  return `${CREDENTIAL_SCOPE}/${id}`
}

/**
 * The per-repo key id: explicit githubCredentialId when valid, else a legal
 * segment derived from the project id.
 *
 * The host grammar is `/^[a-z][a-z0-9-]*$/` — a segment MUST start with a
 * lowercase letter. A default `randomUUID()` often starts with a digit
 * (~10/16), which the host rejects. (The PRD claimed UUIDs are always legal; the
 * host source in dsh-credentials/src/index.ts disproves it — code wins.) So when
 * the raw project id is not a legal segment we prefix `p-`, a deterministic,
 * collision-free derivation. Writer (writeGithubToken) and reader (decideIdentity)
 * BOTH use this function, so the derived key matches on every operation.
 * An explicitly-set githubCredentialId is validated at write time by the store;
 * here an invalid one is simply ignored in favour of the project id.
 */
export function repoCredentialSegment(project) {
  const custom = project?.githubCredentialId
  if (custom !== null && custom !== undefined && custom !== '') {
    if (isKeySegment(custom)) return custom
  }
  const fallback = project?.id
  if (isKeySegment(fallback)) return fallback
  if (typeof fallback === 'string' && fallback !== '') {
    const derived = `p-${fallback.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`
    if (isKeySegment(derived)) return derived
  }
  return null
}

/** Extract a usable token from a grant record; no token ⇒ tier unavailable. */
function grantToken(record) {
  if (record === undefined || record === null || record.kind !== 'grant') return undefined
  const payload = record.payload
  if (payload === null || typeof payload !== 'object') return undefined
  const token = payload.token
  if (typeof token !== 'string' || token === '') return undefined
  return { token, login: typeof payload.login === 'string' && payload.login !== '' ? payload.login : null }
}

function nonEmpty(value) {
  return typeof value === 'string' && value !== '' ? value : null
}

/** Read a record without letting a missing/unavailable credential service abort the ladder. */
async function safeRead(readRecord, key) {
  try {
    return await readRecord(key)
  } catch {
    return undefined
  }
}

function baseDecision(overrides) {
  return {
    source: IDENTITY_SOURCE.NONE,
    sourceType: null,
    globalShared: false,
    keyId: null,
    login: null,
    loginFrom: null,
    // The exact argument group for the UNCHANGED buildGitEnv.
    git: {},
    ...overrides,
  }
}

/**
 * Map a decided source to buildGitEnv arguments. Kept separate and exported so
 * pitfall ⑤ (one winner, one mapping) can be asserted in isolation.
 *
 *   OAuth / shared / repo → credentialToken, ghLoggedIn=false  (branch ①)
 *   gh CLI                → ghLoggedIn=true                     (branch ②)
 *   env token             → {} — keep the inherited token       (branch ③)
 *   none                  → {} — inherited token as last resort
 */
export function mapDecisionToGitEnv(decision) {
  if (!decision || decision.source === IDENTITY_SOURCE.NONE) return {}
  if (decision.source === IDENTITY_SOURCE.GH_CLI) return { ghLoggedIn: true }
  if (decision.source === IDENTITY_SOURCE.ENV_TOKEN) return {}
  if (typeof decision.token === 'string' && decision.token !== '') {
    return { credentialToken: decision.token, ghLoggedIn: false }
  }
  return {}
}

/**
 * Confirm a token-backed tier is actually usable and get its REAL login in the
 * same call (pitfall ⑦ login check + pitfall ⑨ liveness probe merged into one).
 * Returns { login } on success, or null when the token is dead / verification
 * is unavailable. When no `verifyToken` is injected (offline tests, old callers)
 * it falls back to the login stored in the record: no network, no behaviour break.
 *
 * A failed probe means "this tier cannot serve the repo right now" — the ladder
 * must fall through to the next tier, NOT light a false green (PGH-22).
 */
async function verifyTokenTier(hit, verifyToken) {
  if (typeof verifyToken !== 'function') {
    return { login: hit.login, token: hit.token }
  }
  try {
    const result = await verifyToken(hit.token)
    // A valid probe returns the account behind the token; prefer it over any
    // cached payload.login so a rotated token cannot show a stale account.
    const login = typeof result?.login === 'string' && result.login !== ''
      ? result.login
      : hit.login
    return { login, token: hit.token }
  } catch {
    return null
  }
}

/**
 * Decide the winning identity for one project. ASYNC because record reads and
 * the optional liveness probe are.
 *
 * @param {object}      opts
 * @param {object}      opts.project          project record (id, githubCredentialId)
 * @param {string}      [opts.clientId]       settings.githubClientId; empty disables tier 1
 * @param {object}      [opts.env]            process env (injectable for tests)
 * @param {Function}    [opts.readRecord]     async (key) => record|undefined
 * @param {Function}    [opts.probeGhLogin]   () => boolean
 * @param {Function}    [opts.verifyToken]    async (token) => { login } — liveness
 *   probe + login check for token-backed tiers (PGH-22). Injected by the host with
 *   a plain GET /user. On failure that tier is skipped; no record is written and
 *   the tier order is unchanged. Omit only in offline tests.
 * @returns {Promise<object>} decision — includes a transient `token` for the winner
 *   (NEVER serialise a decision to the API/UI; strip `token` first — see identityView).
 */
export async function decideIdentity({
  project,
  clientId = '',
  env,
  readRecord,
  probeGhLogin = realProbeGhLogin,
  verifyToken,
} = {}) {
  const processEnv = env ?? process.env
  const read = typeof readRecord === 'function' ? readRecord : () => undefined
  const cid = typeof clientId === 'string' ? clientId.trim() : ''

  // Tier 1 — global OAuth. Explicit and global, so it must be judged BEFORE the
  // gh CLI probe (pitfall ⑥) and win over it when present. Token-backed: a live
  // probe decides whether the stored token still works (pitfall ⑨).
  if (cid !== '') {
    const hit = grantToken(await safeRead(read, credentialKeyOf(OAUTH_KEY_ID)))
    const live = hit ? await verifyTokenTier(hit, verifyToken) : null
    if (live) {
      const d = baseDecision({
        source: IDENTITY_SOURCE.OAUTH,
        sourceType: SOURCE_TYPE.OAUTH_APP,
        globalShared: true,
        keyId: OAUTH_KEY_ID,
        login: live.login,
        loginFrom: live.login === null ? null : (typeof verifyToken === 'function' ? 'probe' : 'record'),
        token: live.token,
      })
      d.git = mapDecisionToGitEnv(d)
      return d
    }
  }

  // Tier 2 — gh CLI login. probeGhLogin() reads a REAL login (strips env tokens).
  let ghOk = false
  try { ghOk = probeGhLogin() === true } catch { ghOk = false }
  if (ghOk) {
    const d = baseDecision({
      source: IDENTITY_SOURCE.GH_CLI,
      sourceType: SOURCE_TYPE.GH_CLI,
      globalShared: true,
      // login is resolved by the API layer via `gh api user` (kept out of the
      // pure decision — no subprocess/network here).
      loginFrom: 'probe',
    })
    d.git = mapDecisionToGitEnv(d)
    return d
  }

  // Tier 3 — explicit shared token (token-global). This is the MANUAL global
  // Token and outranks the env default: saving one stores a SEPARATE token
  // that is preferred in use, without touching GH_TOKEN / GITHUB_TOKEN
  // themselves (pitfall ⑤ — judge before the ambient token is inherited).
  const shared = grantToken(await safeRead(read, credentialKeyOf(SHARED_KEY_ID)))
  const sharedLive = shared ? await verifyTokenTier(shared, verifyToken) : null
  if (sharedLive) {
    const d = baseDecision({
      source: IDENTITY_SOURCE.SHARED_TOKEN,
      sourceType: SOURCE_TYPE.GH_TOKEN,
      globalShared: true,
      keyId: SHARED_KEY_ID,
      login: sharedLive.login,
      loginFrom: sharedLive.login === null ? null : (typeof verifyToken === 'function' ? 'probe' : 'record'),
      token: sharedLive.token,
    })
    d.git = mapDecisionToGitEnv(d)
    return d
  }

  // Tier 4 — deployment env token, i.e. the DEFAULT value of the global Token
  // tier. buildGitEnv keeps the inherited token as-is, so no explicit argument
  // is mapped. A dead default must not show a false green (PGH-22) — fall
  // through to the repo fallback if liveness probing fails.
  const envToken = nonEmpty(processEnv.GH_TOKEN) ?? nonEmpty(processEnv.GITHUB_TOKEN)
  if (envToken !== null) {
    const envLive = typeof verifyToken === 'function' ? await verifyTokenTier({ token: envToken, login: null }, verifyToken) : { login: null, token: envToken }
    if (envLive) {
      const d = baseDecision({
        source: IDENTITY_SOURCE.ENV_TOKEN,
        sourceType: SOURCE_TYPE.GH_TOKEN,
        globalShared: true,
        login: envLive.login,
        loginFrom: envLive.login === null ? null : 'probe',
      })
      d.git = mapDecisionToGitEnv(d)
      return d
    }
  }

  // Tier 5 — per-repo key. Segment from githubCredentialId or project id.
  const segment = repoCredentialSegment(project)
  if (segment !== null) {
    const hit = grantToken(await safeRead(read, credentialKeyOf(segment)))
    const live = hit ? await verifyTokenTier(hit, verifyToken) : null
    if (live) {
      const d = baseDecision({
        source: IDENTITY_SOURCE.REPO_KEY,
        sourceType: SOURCE_TYPE.GH_TOKEN,
        globalShared: false,
        keyId: segment,
        login: live.login,
        loginFrom: live.login === null ? null : (typeof verifyToken === 'function' ? 'probe' : 'record'),
        token: live.token,
      })
      d.git = mapDecisionToGitEnv(d)
      return d
    }
  }

  // Nothing connected.
  return baseDecision()
}

/**
 * Token-free view of a decision for HTTP/UI. The token is a one-way input to
 * buildGitEnv and must NEVER leave the Host — this is the ONLY shape serialised.
 */
export function identityView(decision) {
  if (!decision) return {
    source: IDENTITY_SOURCE.NONE, sourceType: null, globalShared: false,
    keyId: null, login: null, connected: false,
  }
  return {
    source: decision.source,
    sourceType: decision.sourceType,
    globalShared: decision.globalShared === true,
    keyId: decision.keyId,
    login: decision.login,
    connected: decision.source !== IDENTITY_SOURCE.NONE,
  }
}
