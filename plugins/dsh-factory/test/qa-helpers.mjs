/**
 * QA test helpers shared by the data-root cases.
 *
 * The data root follows `DSH_HOME` and falls back to the host default `~/.dsh`.
 * Two consequences for tests:
 *
 * 1. A test may not assume the root is `/data/dsh`, exists, or is writable.
 * 2. A test that needs a data-root fixture must NOT write into the real root —
 *    on a developer machine that is a live harness home, and on CI it may not
 *    exist at all.
 *
 * `resolveDataRoot()` is a lazy function that reads the environment on every
 * call, so the clean answer is to inject a throwaway root for the duration of one
 * test and restore the previous value afterwards. That keeps the cases running
 * (rather than skipping them) without touching any real directory.
 */
import { accessSync, constants, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * True only when `dir` already exists, is a directory, and is writable.
 *
 * Deliberately NOT "create it if missing": a test that creates the real data root
 * would be writing into a user's harness home.
 */
export function isWritableDir(dir) {
  try {
    if (typeof dir !== 'string' || dir === '' || !existsSync(dir)) return false
    if (!statSync(dir).isDirectory()) return false
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Point `DSH_HOME` at a fresh temporary directory for the duration of `fn`, then
 * restore whatever was there before.
 *
 * The previous value is restored EXACTLY (including "was unset"), because the
 * plugin treats "unset" and "/some/path" as different roots: deleting the
 * variable when it was set would silently move every later case to `~/.dsh`.
 *
 * Each caller gets its own root, so cases cannot leak into each other.
 *
 * @returns whatever `fn` returns (await-safe)
 */
export async function withTempDataRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'qa-data-root-'))
  const hadPrevious = Object.prototype.hasOwnProperty.call(process.env, 'DSH_HOME')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    return await fn(root)
  } finally {
    if (hadPrevious) process.env.DSH_HOME = previous
    else delete process.env.DSH_HOME
    rmSync(root, { recursive: true, force: true })
  }
}
