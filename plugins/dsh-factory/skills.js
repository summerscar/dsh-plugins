/**
 * dsh-factory — packaged skills (the factory flow knowledge, shipped in the plugin).
 *
 * The factory's most valuable asset is its process skills (plan repo-guard,
 * triage classification, review injection-defence). Instead of dropping them
 * into a global skills directory, they live in `skills/<name>/SKILL.md` inside
 * this package and are registered through the host `skills` service with
 * `ctx.skills.register(skill)` — so installing the plugin installs its flow
 * knowledge, versioned with the plugin and free of global-skill conflicts.
 *
 * The skill *bodies* are authored separately; this module only discovers,
 * parses (a minimal `key: value` frontmatter, no YAML dependency) and registers
 * them. A missing `skills/` directory simply registers nothing.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Split a SKILL.md into its `---` frontmatter map and body. Only flat
 * `key: value` lines are parsed — that is all a routing description needs, and
 * it avoids a YAML dependency in a zero-build plugin.
 */
export function parseSkillMarkdown(text) {
  const source = String(text ?? '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source)
  if (match === null) return { meta: {}, content: source.trim() }
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim())
    if (pair !== null) meta[pair[1]] = pair[2].replace(/^["']|["']$/g, '').trim()
  }
  return { meta, content: match[2].trim() }
}

/** The directory this package ships its skills in. */
export function defaultSkillsDir() {
  return join(dirname(fileURLToPath(import.meta.url)), 'skills')
}

/**
 * Where a packaged skill comes from, as the host records it. The host fills in
 * `provider` itself but never `source`, and both are validated as strings before
 * the skill becomes loadable — so every registration must carry this. One format
 * for the whole package: `<plugin name>:<skill name>`.
 */
export function skillSourceOf(name) {
  return `dsh-factory:${name}`
}

/**
 * Read `dir/<name>/SKILL.md` for every subdirectory. A skill without a
 * `description` is skipped: a routing description is what makes it discoverable.
 */
export function loadSkillDirectory(dir) {
  if (typeof dir !== 'string' || !existsSync(dir)) return []
  const skills = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(dir, entry.name, 'SKILL.md')
    if (!existsSync(file)) continue
    const { meta, content } = parseSkillMarkdown(readFileSync(file, 'utf8'))
    const name = (meta.name || entry.name).trim()
    const description = (meta.description || '').trim()
    if (name === '' || description === '') continue
    skills.push({
      name,
      description,
      whenToUse: typeof meta.whenToUse === 'string' && meta.whenToUse !== '' ? meta.whenToUse : undefined,
      content,
    })
  }
  return skills
}

/**
 * Register every packaged skill on the host `skills` service. Returns how many
 * were registered; 0 when the profile has no skills service (the plugin still
 * runs its board/HTTP/tools). Each registration is owned by a ctx.effect so it
 * is removed when the plugin unloads.
 */
export function registerFactorySkills({ ctx, skillsDir } = {}) {
  const skills = typeof ctx?.get === 'function' ? ctx.get('skills') : undefined
  if (skills === undefined || skills === null || typeof skills.register !== 'function') return 0
  const entries = loadSkillDirectory(skillsDir ?? defaultSkillsDir())
  let registered = 0
  for (const skill of entries) {
    ctx.effect(() => skills.register({
      name: skill.name,
      description: skill.description,
      // Required by the host validator; `provider` is left alone so the host's
      // own default ('runtime') applies and no candidate/provider mismatch occurs.
      source: skillSourceOf(skill.name),
      content: skill.content,
      ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
      invocation: { modelInvocable: true, userInvocable: true },
    }), `dsh-factory: skill ${skill.name}`)
    registered += 1
  }
  return registered
}
