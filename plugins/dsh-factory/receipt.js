/**
 * dsh-factory — write-before-receipt precheck (transaction boundary fix, plan A).
 *
 * The host tool pipeline runs `tool.execute` FIRST (which is where factory's
 * write tools persist to the store), and only AFTERWARDS builds the receipt:
 * it snapshots the returned value, validates it against `output.schema`, calls
 * `output.render`, and snapshots the rendered blocks. If any of those steps
 * fails, the host turns the call into an error result — but the write has
 * already landed and is NOT rolled back. That is the write/receipt window.
 *
 * Factory tools cannot observe a host-side receipt failure (no callback), so
 * the window is closed here instead: before a write tool touches the store it
 * constructs the value it is about to return and runs the SAME checks the host
 * will run. Inputs are the spec's own `output.schema` and `output.render`, so
 * when the precheck passes, the host's later pass cannot fail (same pure
 * functions, same value shape). The write then happens with a known-good
 * receipt.
 *
 * No host package is imported: this repo declares the host tools peer but does
 * not install it (autoInstallPeers:false), so tools stay runnable offline and
 * unit-testable. `validateSchema` and `isLossless` are injectable ports: the
 * production entry (index.js) injects the host's PUBLIC `validateJsonSchemaValue`
 * to guarantee exact schema semantics; tests may inject the real host checker
 * too. The built-in defaults implement the same contract (see below) so the
 * module is self-contained. Follow the host dsh-tools `output` contract — do
 * not pin any private host module path here.
 */

/** Plain-object / plain-array prototype checks mirroring the host's lossless rules. */
function isPlainObjectProto(value) {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
function isPlainArray(value) {
  if (!Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Array.prototype
}

/**
 * Minimal lossless-JSON predicate with the same accept/reject rules as the host
 * `snapshotJsonValue`: null / boolean / string / finite non-(-0) number / plain
 * arrays with no holes or extra keys / plain objects with only enumerable string
 * keys and no cyclic references. Getters that throw are treated as a failure.
 * Returns true iff the value would survive the host snapshot unchanged.
 */
export function defaultIsLossless(value) {
  const ancestors = new Set()
  const walk = (node) => {
    if (node === null) return true
    const type = typeof node
    if (type === 'boolean' || type === 'string') return true
    if (type === 'number') return Number.isFinite(node) && !Object.is(node, -0)
    if (type !== 'object') return false
    if (ancestors.has(node)) return false
    if (isPlainArray(node)) {
      const keys = Reflect.ownKeys(node)
      if (keys.length !== node.length + 1) return false
      ancestors.add(node)
      for (let index = 0; index < node.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(node, index) || !walk(node[index])) {
          ancestors.delete(node)
          return false
        }
      }
      ancestors.delete(node)
      return true
    }
    if (!isPlainObjectProto(node)) return false
    ancestors.add(node)
    for (const key of Object.keys(node)) {
      let child
      try { child = node[key] } catch { ancestors.delete(node); return false }
      if (!walk(child)) { ancestors.delete(node); return false }
    }
    ancestors.delete(node)
    return true
  }
  return walk(value)
}

/**
 * Minimal validator for the ValueSchemaSpec shapes used by factory tool
 * outputs: object (with properties + additionalProperties:false), array
 * (items), string, integer, number, boolean, null, and the raw `json` node.
 * Returns an array of violation strings (empty = valid), same contract as the
 * host `validateJsonSchemaValue`. The production entry injects the host's own
 * validator for exact parity; this default keeps the repo self-contained.
 */
export function defaultValidateSchema(schema, value, path = 'value') {
  const violations = []
  const walk = (node, val, at) => {
    if (node === undefined || node === null || typeof node !== 'object') return
    const type = node.type
    if (type === 'json' || type === undefined) return
    const ok = (cond, msg) => { if (!cond) violations.push(`"${at}" ${msg}`) }
    if (Array.isArray(node.enum)) {
      ok(node.enum.includes(val), `must be one of ${node.enum.join(', ')}`)
      return
    }
    if (type === 'object') {
      ok(val !== null && typeof val === 'object' && !Array.isArray(val), 'must be an object')
      if (val === null || typeof val !== 'object' || Array.isArray(val)) return
      const props = node.properties ?? {}
      for (const [key, child] of Object.entries(props)) {
        if (Object.prototype.hasOwnProperty.call(val, key)) walk(child, val[key], `${at}.${key}`)
        else if (Array.isArray(child.type) ? child.type.includes('null') : child.type === 'null') ok(false, `must have required property "${key}"`)
      }
      if (node.additionalProperties === false) {
        for (const key of Object.keys(val)) if (!(key in props)) ok(false, `has unexpected property "${key}"`)
      }
      return
    }
    if (type === 'array') {
      ok(Array.isArray(val), 'must be an array')
      if (!Array.isArray(val)) return
      if (node.items) val.forEach((entry, index) => walk(node.items, entry, `${at}[${index}]`))
      return
    }
    if (type === 'string') ok(typeof val === 'string', 'must be a string')
    else if (type === 'integer') ok(Number.isInteger(val), 'must be an integer')
    else if (type === 'number') ok(typeof val === 'number' && Number.isFinite(val), 'must be a number')
    else if (type === 'boolean') ok(typeof val === 'boolean', 'must be a boolean')
    else if (type === 'null') ok(val === null, 'must be null')
  }
  walk(schema, value, path)
  return violations
}

/**
 * Run the host-equivalent receipt checks on (args, value) BEFORE a write.
 *
 * @param spec - the tool spec; `output.schema` and `output.render` are used verbatim.
 * @param args - the tool arguments passed to render.
 * @param value - the value the execute is about to return.
 * @param ports - optional { isLossless, validateSchema, onFailure }.
 *   - onFailure({ tool, stage, reason }) is called once on any failure so a
 *     "blocked before write" is observable, never silent.
 * @throws the ORIGINAL error from a failed stage (render errors are rethrown as-is);
 *   validation failures throw an Error whose message carries the violations.
 */
export function precheckReceipt({ name, schema, render, args, value, ports = {} } = {}) {
  const tool = name ?? 'unknown-tool'
  const isLossless = typeof ports.isLossless === 'function' ? ports.isLossless : defaultIsLossless
  const validateSchema = typeof ports.validateSchema === 'function' ? ports.validateSchema : defaultValidateSchema
  const onFailure = typeof ports.onFailure === 'function' ? ports.onFailure : () => {}
  const fail = (stage, error) => {
    try { onFailure({ tool, stage, reason: error instanceof Error ? error.message : String(error) }) } catch { /* observation must never mask the real failure */ }
    throw error
  }

  // Stage 1: value must be lossless JSON (host snapshotToolValue).
  if (isLossless(value) !== true) {
    fail('value-lossless', new Error(`${tool}: value is not lossless JSON`))
  }
  // Stage 2: value must satisfy the tool's own output schema (host schema check).
  const violations = validateSchema(schema, value, 'value')
  if (Array.isArray(violations) && violations.length > 0) {
    fail('value-schema', new Error(`${tool}: output schema violations: ${violations.join('; ')}`))
  }
  // Stage 3: render must not throw (host output.render step). Rethrow as-is.
  let rendered
  try {
    rendered = render(args, value)
  } catch (error) {
    fail('render', error)
  }
  // Stage 4: rendered blocks must be lossless JSON (host snapshotProjection).
  if (isLossless(rendered) !== true) {
    fail('render-lossless', new Error(`${tool}: output.render returned non-lossless JSON`))
  }
  return rendered
}
