/**
 * Dev self-check — Review UI + i18n:
 *  - two silent L4 paths get mutually-exclusive, result-based card notices
 *  - a redispatch button calls the existing review-dispatch route
 *  - review session link + red "review working" state, build link renamed
 *  - six new keys byte-identical across the four dictionaries
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const client = readFileSync(join(root, 'client.js'), 'utf8')
const zh = JSON.parse(readFileSync(join(root, 'locale', 'zh.json'), 'utf8'))
const en = JSON.parse(readFileSync(join(root, 'locale', 'en.json'), 'utf8'))

function inlineDicts() {
  const zhStart = client.indexOf('const zh = {')
  const enStart = client.indexOf('const en = {')
  const zhBlock = client.slice(zhStart, enStart)
  const enBlock = client.slice(enStart, client.indexOf('function ', enStart))
  const grab = (block) => {
    const out = {}
    for (const m of block.matchAll(/^\s{6}([A-Za-z][A-Za-z0-9]*): "((?:[^"\\]|\\.)*)",?$/gm)) out[m[1]] = m[2]
    return out
  }
  return { zh: grab(zhBlock), en: grab(enBlock) }
}

const NEW_KEYS = ['reviewStalledNotice', 'actRedispatchReview', 'toastReviewRedispatched', 'autoDeliveryFailedNotice', 'openReviewSession', 'reviewWorking']

test('Dev-ReviewUI: six new keys in all four dictionaries, byte-identical', () => {
  const inline = inlineDicts()
  for (const key of NEW_KEYS) {
    assert.equal(typeof inline.zh[key], 'string', `inline zh has ${key}`)
    assert.equal(typeof inline.en[key], 'string', `inline en has ${key}`)
    assert.equal(typeof zh[key], 'string', `locale zh has ${key}`)
    assert.equal(typeof en[key], 'string', `locale en has ${key}`)
    assert.equal(inline.zh[key], zh[key], `${key} zh inline == locale`)
    assert.equal(inline.en[key], en[key], `${key} en inline == locale`)
  }
})

test('Dev-ReviewUI: openSession value renamed to build session, key unchanged', () => {
  assert.match(inlineDicts().zh.openSession, /构建会话/)
  assert.match(inlineDicts().en.openSession, /build session/i)
  assert.equal(zh.openSession, inlineDicts().zh.openSession)
  assert.equal(en.openSession, inlineDicts().en.openSession)
})

test('Dev-ReviewUI: card renders result-based notices between meta and delivery, mutually exclusive', () => {
  const cardFn = client.slice(client.indexOf('function Card({'), client.indexOf('function CardExtras'))
  assert.match(cardFn, /function Card\(\{[\s\S]{0,400}tier[, }]/, 'Card accepts tier')
  assert.match(cardFn, /autoDeliveryFailedNotice/, 'delivery-failure notice present')
  assert.match(cardFn, /reviewStalledNotice/, 'no-verdict notice present')
  const posMeta = cardFn.indexOf("key: 'meta'")
  const posNotice = cardFn.indexOf("key: 'reviewNotice'")
  const posDelivery = cardFn.indexOf("key: 'deliveryStatus'")
  assert.ok(posMeta < posNotice && posNotice < posDelivery, 'notice sits between meta and DeliveryStatus')
  // mutual exclusion: the no-verdict notice is gated on !autoDelivery.error
  assert.match(cardFn, /const noVerdict = l4Review && !reviewStale && deliveryError === ''[\s\S]{0,260}reviewVerdict == null/, 'no-verdict branch excludes stale + autoDelivery error')
  assert.match(cardFn, /card\.status === 'review'[\s\S]{0,260}auto-delivery/, 'L4-only gating')
})

test('Dev-ReviewUI: redispatch button calls existing route, disabled on reviewWorking, toast on success', () => {
  const actions = client.slice(client.indexOf('function CardActions('), client.indexOf('function OrphanModal('))
  assert.match(actions, /function CardActions\(\{[\s\S]{0,220}reviewWorking[, }]/, 'CardActions accepts reviewWorking')
  assert.match(actions, /t\('actRedispatchReview'\)/, 'redispatch button label')
  assert.match(actions, /\/cards\/\$\{card\.id\}\/review-dispatch/, 'calls existing review-dispatch route')
  assert.match(actions, /toastReviewRedispatched/, 'success toast')
  assert.match(actions, /reviewWorking === true \? \{ disabled: true/, 'button disabled while review session runs')
})

test('Dev-ReviewUI: CardExtras shows a review-session link (dangerInk) with early-return including reviewSessionId', () => {
  const extras = client.slice(client.indexOf('function CardExtras('), client.indexOf('function ReportsModal('))
  assert.match(extras, /openReviewSession/, 'review-session link label')
  assert.match(extras, /uiWorkspace\.openSession\(reviewId\)/, 'opens the review session via existing service')
  assert.match(extras, /reviewRow = reviewId && sessionRows \? sessionRows\[reviewId\]/, 'title from the review session row')
  assert.match(extras, /if \(!card\.sessionId && reviewId === '' && !canViewReports\) return null/, 'early return accounts for reviewSessionId')
  assert.match(extras, /dangerInk/, 'review link uses danger ink')
  assert.match(extras, /t\('openSession'\)/, 'build link still present')
})

test('Dev-ReviewUI: reviewWorking red state wins over build-blue, CSS uses variables', () => {
  assert.match(client, /reviewWorking[\s\S]{0,120}sessionRows\[card\.reviewSessionId\][\s\S]{0,80}running === true/, 'reviewWorking derived from review session row')
  // Card gets both flags; red class + red dot title, review priority
  const cardFn = client.slice(client.indexOf('function Card({'), client.indexOf('function CardExtras'))
  assert.match(cardFn, /reviewWorking/, 'Card reads reviewWorking')
  assert.match(cardFn, /df-card-review-working/, 'red working class on card')
  assert.match(cardFn, /t\('reviewWorking'\)/, 'red dot title uses review working key')
  // the three hardcoded blue rgba are replaced by a working-color CSS variable
  assert.match(client, /--df-working-glow[\s\S]{0,120}|--df-working-color/, 'glow color is a CSS variable')
  assert.match(client, /df-card-review-working\{--df-working-color:#b4232b/, 'review state recolours working to red')
})

test('Dev-ReviewUI: renderCard computes reviewWorking and passes tier + reviewWorking down', () => {
  assert.match(client, /const reviewWorking = Boolean\([\s\S]{0,160}reviewSessionId[\s\S]{0,120}running === true\)/, 'reviewWorking computed in renderCard')
  assert.match(client, /h\(Card,[\s\S]{0,320}reviewWorking,[\s\S]{0,160}tier: project\?\.autonomy/, 'Card gets tier + reviewWorking')
  assert.match(client, /h\(CardActions,[\s\S]{0,320}reviewWorking/, 'CardActions gets reviewWorking')
})

test('Dev-ReviewUI: review-dispatch backend route already exists (UI does not change backend)', () => {
  const index = readFileSync(join(root, 'index.js'), 'utf8')
  assert.match(index, /\/review-dispatch/, 'route present in index.js')
})

test('Dev-ReviewUI: autoDeliveryFailedNotice restored to {reason} template + render substitution', () => {
  // Four dictionaries carry the same template, no other placeholder text.
  const inlineZh = client.slice(client.indexOf('const zh = {'), client.indexOf('const en = {'))
  const inlineEn = client.slice(client.indexOf('const en = {'))
  const zhLine = inlineZh.match(/autoDeliveryFailedNotice: "([^"]*)"/)?.[1]
  const enLine = inlineEn.match(/autoDeliveryFailedNotice: "([^"]*)"/)?.[1]
  assert.equal(zhLine, zh.autoDeliveryFailedNotice, 'zh inline == locale byte-identical')
  assert.equal(enLine, en.autoDeliveryFailedNotice, 'en inline == locale byte-identical')
  assert.equal(zh.autoDeliveryFailedNotice, '自动交付失败：{reason}。需人工处理。')
  assert.equal(en.autoDeliveryFailedNotice, 'Auto-delivery failed: {reason}. Manual action is needed.')
  // Render uses the template call with a matching `reason` arg (host t() substitutes).
  assert.match(client, /t\('autoDeliveryFailedNotice', \{ reason: deliveryError \}\)/, 'render passes reason to t()')
  assert.doesNotMatch(client, /\$\{t\('autoDeliveryFailedNotice'\)\}\\n\$\{deliveryError\}/, 'old string-concat render removed')
  // Simulate host t() substitution using the real dictionary template: reason is
  // inserted and the placeholder does not leak.
  const reason = '工作树存在未提交改动'
  const rendered = zh.autoDeliveryFailedNotice.replace(/\{reason\}/g, reason)
  assert.equal(rendered, `自动交付失败：${reason}。需人工处理。`)
  assert.ok(rendered.includes(reason), 'reason really substituted')
  assert.doesNotMatch(rendered, /\{reason\}/, 'placeholder does not leak')
})
