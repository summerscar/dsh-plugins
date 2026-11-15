/**
 * dsh-factory — git subprocess environment isolation.
 *
 * Git exports repository-location variables (`GIT_DIR`, `GIT_WORK_TREE`,
 * `GIT_INDEX_FILE`, …) into hook and CI child processes. Those OVERRIDE `-C`:
 * a `git -C <temp repo> status` launched from a pre-commit hook still targets
 * the hook's repo, failing with `.git/index: index file open failed: Not a
 * directory`. Found for real when husky ran `pnpm check` on a commit.
 *
 * Every git/gh child of this plugin must run with these stripped, so the path
 * we pass is the repo it actually touches. Keep the list to *redirecting* vars:
 * identity/config vars (GIT_AUTHOR_*, GIT_CONFIG_*) are left alone.
 */

/** Git vars that redirect which repository / index / object store a child uses. */
export const GIT_CONTEXT_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
]

/**
 * Copy `processEnv` with git redirect vars removed. Pure — never mutates input.
 * @param {Record<string, string | undefined>} [processEnv]
 */
export function cleanGitEnv(processEnv = process.env) {
  const env = { ...processEnv }
  for (const key of GIT_CONTEXT_VARS) delete env[key]
  return env
}
