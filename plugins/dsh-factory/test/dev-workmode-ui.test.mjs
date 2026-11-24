import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { clientSource } from './dev-v4-support.mjs'

const source = clientSource()

test('Dev-UI: no raw auto-panel keys or tier wording remain in any dictionary carrier', () => {
  const zh = JSON.parse(readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))
  const en = JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))
  assert.doesNotMatch(source, /autoPanelTitle|autoPanelPurpose/)
  assert.match(source, /block\('autonomy', '02', 'stageConfigTitle', 'stageConfigPurpose'/)
  for (const dict of [source, JSON.stringify(zh), JSON.stringify(en)]) {
    assert.doesNotMatch(dict, /自治档位|自动化档位|autoPanelTitle|autoPanelPurpose/)
    assert.doesNotMatch(dict, /autonomy level|autonomy tier/)
  }
})

test('Dev-UI: project badges show full-auto stage rules, not L0–L4', () => {
  assert.match(source, /t\('stageDefaultBadge'\)/)
  assert.doesNotMatch(source, /LEVEL_META|lvL0|badgeManual|badgeMachineApprove/)
})

test('Dev-UI: work mode remains a separate permission boundary', () => {
  assert.match(source, /workModeTitle/)
  assert.match(source, /workModePurpose/)
  assert.doesNotMatch(source, /与自动化档位无关/)
})

test('Dev-UI: stage rules panel is the automation control', () => {
  assert.match(source, /stageConfigTitle/)
  assert.match(source, /autoStartLabel/)
  assert.match(source, /autoApproveLabel/)
  assert.match(source, /whenAdvancedTitle/)
})

test('Dev-UI: no legacy axisTitle or slider remains', () => {
  assert.doesNotMatch(source, /axisTitle|axisHint|autoEndLabel|currentLevel/)
})
