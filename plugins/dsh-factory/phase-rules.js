/**
 * V4 stage rules. Default is full auto; advanced rules may only NARROW a
 * stage (make it stop for a human). There is deliberately no field that can
 * widen writes beyond the built-in boundary: draft PR only, no merge/close.
 */

export const PHASES = Object.freeze(['inbox', 'triage', 'plan', 'build', 'self-review', 'pr-review'])
export const RULE_ACTIONS = Object.freeze(['autoStart', 'autoApprove'])

const defaultsFor = (phase) => ({ autoStart: true, autoApprove: true })
export const DEFAULT_PHASE_RULES = Object.freeze(Object.fromEntries(PHASES.map((phase) => [phase, Object.freeze(defaultsFor(phase))])))

export function normalizePhaseRules(input = {}, current = DEFAULT_PHASE_RULES) {
  const out = {}
  for (const phase of PHASES) {
    const base = current?.[phase] ?? defaultsFor(phase)
    const patch = input?.[phase] ?? {}
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw new Error(`阶段规则 ${phase} 必须是对象`)
    }
    for (const key of Object.keys(patch)) {
      if (!RULE_ACTIONS.includes(key)) throw new Error(`阶段规则 ${phase}.${key} 不存在；高级设置只能收窄 autoStart / autoApprove`)
      if (typeof patch[key] !== 'boolean') throw new Error(`阶段规则 ${phase}.${key} 必须是布尔值`)
    }
    out[phase] = { autoStart: patch.autoStart ?? base.autoStart, autoApprove: patch.autoApprove ?? base.autoApprove }
  }
  return out
}

/** Old L0–L4 projects migrate to rules; new projects start full auto. */
export function migrateLegacyAutonomyToPhaseRules(project = {}) {
  const legacy = project.autonomy
  if (legacy === undefined || legacy === null) {
    return project.phaseRules === undefined ? normalizePhaseRules({}) : normalizePhaseRules(project.phaseRules)
  }
  if (legacy === 'manual' || legacy === 'L0') {
    return normalizePhaseRules(Object.fromEntries(PHASES.map((phase) => [phase, { autoStart: false, autoApprove: false }])))
  }
  if (legacy === 'you-approve' || legacy === 'L1' || legacy === 'L2') {
    return normalizePhaseRules({ plan: { autoApprove: false }, 'self-review': { autoStart: project.autoDispatch === true } })
  }
  return normalizePhaseRules({})
}

export function phaseAllows(rules, phase, action) {
  return (rules?.[phase]?.[action] ?? true) === true
}
