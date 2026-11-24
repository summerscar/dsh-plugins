/**
 * Dev self-check — two review-session experience fixes:
 *  1. The review session's FIRST user message (reviewMessage) must carry the
 *     same page-language directive the build session gets, promoted to the top
 *     with a high-priority marker so the reviewer actually follows it. Locale
 *     must be threaded through dispatchReview / followupReview.
 *  2. While a review session is running, the card must show the "working"
 *     state, NOT the stale "no verdict / manual action" red notice — the
 *     noVerdict branch must exclude reviewWorking.
 *
 * Node test + source-structure guards (client.js runs in a browser sandbox).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { reviewMessage } from '../dispatch.js'
import { buildSessionContext } from '../session-context.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const client = readFileSync(join(root, 'client.js'), 'utf8')
const dispatch = readFileSync(join(root, 'dispatch.js'), 'utf8')
const sessionContext = readFileSync(join(root, 'session-context.js'), 'utf8')

const CARD = { id: 'c1', title: 't', prUrl: null, worktreePath: '/w', reviewVerdict: null }
const HEAD = 'a'.repeat(40)

// ---------- problem 1: language directive in the review first message ----------

test('Dev-ReviewLang: reviewMessage carries the page-language directive at the top', () => {
  const en = reviewMessage({ card: CARD, reviewedHead: HEAD, locale: 'en' })
  const first = en.split('\n')[0]
  assert.match(first, /Reply in English \(en\)/, 'English directive is the first line')
  assert.match(first, /write every factory_report body in English/, 'report body language stated')
  assert.match(first, /proper nouns as-is/, 'proper nouns preserved')
  assert.match(first, /HIGH PRIORITY|HIGHEST PRIORITY|IMPORTANT/i, 'directive is marked high priority')
  const zh = reviewMessage({ card: CARD, reviewedHead: HEAD, locale: 'zh' })
  assert.match(zh.split('\n')[0], /Reply in Chinese \(zh\)/, 'zh locale honoured too')
})

test('Dev-ReviewLang: directive is byte-identical to the build-session languageLine', () => {
  // Both sessions must show the SAME directive text, not a divergent copy.
  const fromReview = reviewMessage({ card: CARD, reviewedHead: HEAD, locale: 'en' }).split('\n')[0]
  const m = sessionContext.match(/return `([^`]*Reply in \$\{name\}[^`]*)`/)
  assert.ok(m, 'languageDirective template found in session-context.js')
  assert.ok(fromReview.includes('Reply in English (en)'))
  // The high-priority marker must be part of the shared directive generator,
  // so build and review can never drift apart.
  assert.match(m[1], /HIGH PRIORITY|HIGHEST PRIORITY|IMPORTANT/i, 'priority marker lives in the shared generator')
})

test('Dev-ReviewLang: build session also carries the priority-marked directive', () => {
  // Follow-up: build sessions must raise the directive's priority too. Because
  // both paths share ONE generator, build can never drift from review.
  const built = buildSessionContext({
    card: { ...CARD, status: 'build' },
    project: {},
    locale: 'en',
  })
  assert.match(built.sectionText, /\[HIGH PRIORITY[^"]*\] Reply in English \(en\)/, 'build sectionText directive is priority-marked')
  assert.match(built.firstMessage, /\[HIGH PRIORITY[^"]*\] Reply in English \(en\)/, 'build firstMessage directive is priority-marked')
  // Same text as the review first message: single source of truth.
  assert.ok(built.firstMessage.includes(reviewMessage({ card: CARD, reviewedHead: HEAD, locale: 'en' }).split('\n')[0]))
})

test('Dev-ReviewLang: dispatchReview + followupReview thread locale into reviewMessage', () => {
  const reviewBlock = dispatch.slice(dispatch.indexOf('export async function dispatchReview('), dispatch.indexOf('/** Human-readable review message') === -1 ? dispatch.length : dispatch.indexOf('/** Human-readable review message'))
  const followBlock = dispatch.slice(dispatch.indexOf('export async function followupReview('), dispatch.indexOf('export function createHostPort('))
  assert.match(reviewBlock, /reviewMessage\(\{[\s\S]{0,300}locale/, 'dispatchReview passes locale to reviewMessage')
  assert.match(followBlock, /reviewMessage\(\{[\s\S]{0,300}locale/, 'followupReview passes locale to reviewMessage')
})

// ---------- problem 2: working state, not stale red notice ----------

test('Dev-ReviewLang: noVerdict red notice is suppressed while review session runs', () => {
  const block = client.slice(client.indexOf('const noVerdict ='), client.indexOf('const rereviewExhausted ='))
  assert.match(block, /!reviewWorking/, 'noVerdict branch excludes reviewWorking')
  // The working class/dot must still be driven by reviewWorking (no regression).
  assert.match(client, /reviewWorking === true \|\| prReviewWorking === true \? 'df-card df-card-working df-card-review-working'/, 'review-working visual class intact')
})
