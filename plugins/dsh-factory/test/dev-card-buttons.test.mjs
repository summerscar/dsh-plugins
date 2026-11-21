/**
 * Dev self-check for the four card-action button holes found in the lifecycle
 * audit:
 *  A. terminal (done/canceled) cards must not show 交还引擎
 *  B. Review 确认 commit must not appear when a commitSha already exists
 *  C. orphan cards expose only 取消卡片; CardExtras hides 打开会话, keeps 查看报告
 *  D. Inbox 派发给 AI is disabled on pendingDispatch / stalled with a reason
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const client = readFileSync(join(root, 'client.js'), 'utf8')
const actions = client.slice(client.indexOf('function CardActions'), client.indexOf('function Column'))
const extras = client.slice(client.indexOf('function CardExtras'), client.indexOf('function ReportsModal'))

test('Dev-Buttons A: terminal cards do not render the return-to-engine button', () => {
  // Outer condition (locked by QA) stays; a terminal guard lives inside.
  const ret = actions.match(/if \(card\.takenOver === true\) \{[\s\S]*?\n      \}/)?.[0]
  assert.ok(ret, 'return branch found')
  assert.match(ret, /\['done', 'canceled'\]\.includes\(card\.status\)/, 'terminal cards skip the return button')
})

test('Dev-Buttons B: confirm-commit button only when no commitSha exists', () => {
  assert.match(actions, /if \(!card\.commitSha\) add\(t\('actConfirmCommit'\)/, 'confirm-commit gated by absence of commitSha')
  assert.doesNotMatch(actions, /!card\.commitSha \|\| !card\.prUrl/, 'old always-failing condition removed')
})

test('Dev-Buttons C: orphan cards expose only cancel; extras hide session, keep reports', () => {
  assert.match(actions, /function CardActions\(\{[^}]*\borphan\b[^}]*\}/, 'CardActions accepts orphan')
  assert.match(actions, /if \(orphan\) \{[\s\S]{0,200}buttons\.push\(makeCancelButton\(\)\)/, 'orphan branch pushes the shared cancel button')
  // In the orphan branch no other action keys are added before the early return.
  const orphanBlock = actions.match(/if \(orphan\) \{[\s\S]*?\n      \}/)?.[0]
  assert.ok(orphanBlock, 'orphan branch found')
  for (const key of ['actDispatch', 'takeover', 'returnToEngine', 'actConfirmCommit', 'actMarkDone']) {
    assert.doesNotMatch(orphanBlock, new RegExp(`t\\('${key}'\\)`), `orphan branch does not add ${key}`)
  }
  assert.match(extras, /function CardExtras\(\{[^}]*\borphan\b[^}]*\}/, 'CardExtras accepts orphan')
  assert.match(extras, /orphan \|\| !card\.sessionId \? null : \(canOpen/, 'orphan hides the open-session link')
  assert.match(extras, /canViewReports/, 'reports link still available on orphan cards')
  // renderCard passes orphan to both components.
  const render = client.slice(client.indexOf('const renderCard ='), client.indexOf('const children = []'))
  assert.equal((render.match(/orphan: orphanByCard\.get\(card\.id\)/g) || []).length, 2, 'orphan passed to Card and CardActions/CardExtras')
})

test('Dev-Buttons D: dispatch button disabled on pendingDispatch or stalled', () => {
  const di = actions.indexOf("add(t('actDispatch')")
  const dispatch = actions.slice(di, di + 700)
  assert.ok(di > 0, 'dispatch action found')
  assert.match(dispatch, /disabled/, 'dispatch button has a disabled guard')
  const guards = actions.slice(Math.max(0, di - 300), di + 400)
  assert.match(guards, /pendingDispatch/, 'disabled when a dispatch is pending')
  assert.match(guards, /stalled/, 'disabled when the card is stalled')
  assert.match(dispatch, /title:/, 'disabled button explains why')
})
