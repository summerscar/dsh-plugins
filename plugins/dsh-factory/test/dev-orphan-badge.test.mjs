/**
 * Dev self-check for the orphan-card UI:
 *  - an orphan badge renders on the shared card (board + inbox) when the card id
 *    is in engine.orphans, and opens an in-page explanation modal
 *  - the modal surfaces what actually happened (worktree/session trace but no
 *    live session; auto-delivery failure detail when present)
 *  - new copy keys exist in all four dictionaries
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

test('Dev-Orphan: card renders an orphan badge that opens an explanation modal', () => {
  // Orphan lookup by card id is derived from engine.orphans in renderCard.
  assert.match(client, /orphanByCard[\s\S]{0,160}engine\?\.orphans/, 'orphan index built from engine.orphans')
  assert.match(client, /h\(Card,[\s\S]{0,320}orphan: orphanByCard\.get\(card\.id\)/, 'renderCard passes the orphan to Card')
  const cardFn = client.slice(client.indexOf('function Card({'), client.indexOf('function CardExtras'))
  assert.match(cardFn, /function Card\(\{[\s\S]{0,300}orphan[, }]/, 'Card accepts orphan prop')
  assert.match(cardFn, /orphan \? h\(OrphanBadge/, 'flagged card renders OrphanBadge in the shared header')
  assert.match(cardFn, /onOpenOrphan/, 'badge has an open handler wired')
  // The modal is mounted through the page-level onModal, like ReportsModal.
  assert.match(client, /h\(OrphanModal,/, 'OrphanModal mounted via page modal')
})

test('Dev-Orphan: explanation modal surfaces session/status/tier and delivery error', () => {
  const modal = client.slice(client.indexOf('function OrphanModal('), client.indexOf('function AutonomySection('))
  assert.ok(modal.length > 0, 'OrphanModal found')
  assert.match(modal, /t\('orphanBadge'\)/, 'title uses badge copy')
  assert.match(modal, /t\('orphanWhy'\)/, 'explains what happened')
  assert.match(modal, /orphan\?\.sessionId/, 'shows session id')
  assert.match(modal, /orphan\?\.status/, 'shows card status at detection')
  assert.match(modal, /t\('orphanSessionLabel'\)/, 'session label')
  assert.match(modal, /t\('orphanStatusLabel'\)/, 'status label')
  // Delivery failure detail when the card carries one.
  assert.match(modal, /card\??\.autoDelivery\??\.error/, 'shows delivery failure detail when present')
  assert.match(modal, /t\('orphanDeliveryLabel'\)/, 'delivery label')
})

test('Dev-Orphan: new copy keys exist in all four dictionaries', () => {
  const keys = ['orphanBadge', 'orphanWhy', 'orphanSessionLabel', 'orphanStatusLabel', 'orphanDeliveryLabel']
  for (const key of keys) {
    assert.ok(typeof zh[key] === 'string' && zh[key].length > 0, `zh.${key} present`)
    assert.ok(typeof en[key] === 'string' && en[key].length > 0, `en.${key} present`)
    assert.ok(client.includes(`${key}: ${JSON.stringify(zh[key])}`), `inline zh mirrors locale for ${key}`)
    assert.ok(client.includes(`${key}: ${JSON.stringify(en[key])}`), `inline en mirrors locale for ${key}`)
  }
})
