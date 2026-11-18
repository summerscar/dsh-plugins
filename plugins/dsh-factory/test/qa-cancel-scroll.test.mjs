/**
 * QA — "已取消展开后页面没法滚动" fix acceptance (fast lane).
 *
 * The change is one CSS rule: the root scroll container that was previously only
 * in the <=760px media query is now the BASE rule (all widths). No real-device
 * deployment is authorized this round, so "can scroll" is verified by asserting
 * the exact CSS declarations that create the scroll container, split by whether
 * they live outside (wide) or inside (narrow) the @media (max-width:760px) block,
 * plus that real fold content exists to scroll to. Regression cases reuse the
 * existing cancel suites. Self-contained: source guards, no git show HEAD.
 *
 * No business code changed; no commit.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const clientSrc = readFileSync(join(packageRoot, 'client.js'), 'utf8')

// Split the stylesheet into the base part (applies at ALL widths, incl. wide)
// and the <=760px media part (narrow). The base root rule must be BEFORE the
// media query; the narrow override must be INSIDE it.
const mediaStart = clientSrc.indexOf('@media (max-width:760px)')
const mediaEnd = clientSrc.indexOf('@media (max-width:520px)', mediaStart)
assert.ok(mediaStart > 0 && mediaEnd > mediaStart, 'narrow media block located')
const baseCss = clientSrc.slice(0, mediaStart)
const narrowCss = clientSrc.slice(mediaStart, mediaEnd)

const SCROLL_DECLS = [
  'height:100%',
  'min-height:0',
  'box-sizing:border-box',
  'overflow-y:auto',
  'overscroll-behavior:contain',
  '-webkit-overflow-scrolling:touch',
]

function rootRule(css) {
  // Every '[data-dsh-factory-p4]{...}' rule; the scroll one carries overflow-y:auto.
  const rules = [...css.matchAll(/\[data-dsh-factory-p4\]\{([^}]*)\}/g)].map((m) => m[1])
  return rules.find((body) => body.includes('overflow-y:auto'))
}

// ==============================================================================
// Wide (>760px): base root rule is the scroll container
// ==============================================================================
test('WIDE: base root rule (outside media query) has all internal-scroll declarations', () => {
  const rule = rootRule(baseCss)
  assert.ok(rule, 'base stylesheet has a root rule with overflow-y:auto (applies >760px too)')
  for (const decl of SCROLL_DECLS) {
    assert.ok(rule.includes(decl), `base root rule includes ${decl}`)
  }
  // It must NOT be padding:8px — that is the narrow override only.
  assert.ok(!rule.includes('padding:8px'), 'wide base root is not the narrow padding override')
  assert.ok(rule.includes('padding:0'), 'wide base root keeps padding:0')
})

test('WIDE: expanded canceled list produces real content below the board to scroll to', () => {
  // Scrolling only helps if expansion actually adds tall content.
  assert.match(clientSrc, /h\('details', \{ key: 'canceled'/, 'fold bar is a <details>')
  assert.match(clientSrc, /key: 'list',[\s\S]{0,160}canceledCards\.map\(renderCard\)/, 'expanded content renders canceled cards')
  assert.match(clientSrc, /const canceledCards = boardCards\.filter\(\(entry\) => entry\.status === 'canceled'\)/, 'content derives from canceled cards')
  // Board itself is tall on wide (>=440px) so expansion pushes past a fixed-height slot.
  assert.match(baseCss, /\[data-dsh-factory-p4\] \.df-board\{[^}]*min-height:440px/, 'wide board has real height')
})

// ==============================================================================
// Narrow (<=760px): root still scrolls internally, padding:8px + 5-col h-scroll intact
// ==============================================================================
test('NARROW: root rule inside media query keeps scroll declarations and padding:8px', () => {
  const rule = rootRule(narrowCss)
  assert.ok(rule, 'narrow media block has a root scroll rule')
  for (const decl of SCROLL_DECLS) {
    assert.ok(rule.includes(decl), `narrow root rule includes ${decl}`)
  }
  assert.ok(rule.includes('padding:8px'), 'narrow override still applies padding:8px (unchanged)')
})

test('NARROW: five-column horizontal scroll and fold-bar style have no regression', () => {
  assert.match(narrowCss, /\[data-dsh-factory-p4\] \.df-board\{[^}]*display:flex[^}]*overflow-y:auto[^}]*scroll-snap-type:x mandatory/, 'narrow board stays a horizontal scroller')
  assert.match(narrowCss, /\[data-dsh-factory-p4\] \.df-col\{flex:0 0 84vw;min-width:0;scroll-snap-align:start\}/, 'narrow columns keep 84vw snap')
  assert.match(narrowCss, /\[data-dsh-factory-p4\] \.df-card-actions button\{min-height:44px!important\}/, 'narrow 44px tap targets intact')
  // Fold bar itself is unchanged by this fix (same details/summary render path).
  assert.match(clientSrc, /key: 'ch',[\s\S]{0,140}\$\{t\('canceled'\)\} · \$\{canceledCards\.length\}/, 'fold summary 已取消 · N intact')
})

// ==============================================================================
// Regression invariants still present in the shipped source
// ==============================================================================
test('REGRESSION: canceled cards render read-only (CardActions fully gated)', () => {
  const actions = clientSrc.slice(clientSrc.indexOf('function CardActions'), clientSrc.indexOf('function Column'))
  assert.match(actions, /if \(card\.status !== 'done' && card\.status !== 'canceled'\)/, 'takeover/cancel gated off at canceled')
  assert.match(actions, /if \(buttons\.length === 0\) return null/, 'no buttons bar at terminal')
})

test('REGRESSION: task-card stats still exclude canceled and keep done', () => {
  // stat expression
  const statExpr = clientSrc.match(/stat\('sc', ([^,]+), t\('statCards'\)\)/)?.[1]
  assert.equal(statExpr, 'boardCards.length - canceledCards.length', 'stat excludes canceled')
  // cardCounts loop
  const loop = clientSrc.match(/const cardCounts = \{\}([\s\S]*?)\n\s*\/\/ 'auto' resolves/)?.[1]
  assert.ok(loop && loop.includes("card.status === 'canceled'") && loop.includes('continue'), 'rail/tab count skips canceled')
  assert.doesNotMatch(loop, /status === 'done'/, 'done is NOT skipped (still counted)')
})

test('REGRESSION: fold read-only + stats + no-revive cases are present to re-run', () => {
  // The caller runs the existing focused suites with node --test; here we just
  // assert the three regression points are covered there (no reimplementation).
  const view = readFileSync(join(packageRoot, 'test', 'qa-cancel-view-count.test.mjs'), 'utf8')
  const cancel = readFileSync(join(packageRoot, 'test', 'qa-card-cancel.test.mjs'), 'utf8')
  assert.match(view, /V2 every CardActions button is gated off at canceled \(read-only\)/, 'read-only regression case present')
  assert.match(view, /V3 shipped stat expression drops by N on cancel/, 'stats regression case present')
  assert.match(cancel, /C2 canceled auto card keeps its source/, 'no-revive regression case present')
})
