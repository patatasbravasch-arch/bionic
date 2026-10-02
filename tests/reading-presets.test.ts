import { test, expect } from 'bun:test'
import { normalizeReadingPresets, readingPresetValues, saveReadingPreset } from '../src/reading-presets'

const settings = {
  bionicEnabled: true,
  density: 'balanced',
  fixation: 35,
  weight: 600,
  fontEnabled: true,
  font: 'Georgia, serif',
  customFont: '',
  scopeMessages: true,
  scopeBubble: false,
  scopeComposer: false,
  scopeMenus: false,
  scopeNavigation: false,
  scopeAll: false,
  justifyMessages: true,
  hyphenateMessages: true,
  readingWidth: '65ch',
  paragraphSpacing: 0.5,
  letterSpacing: 0.01,
  wordSpacing: 0.02,
  textSize: 105,
  lineHeight: 1.6,
  autoRegenerateEnabled: true,
  toolbarSpacing: 12,
}

test('saved reading setups contain reading choices only and survive storage', () => {
  const result = saveReadingPreset([], ' Evening reading ', settings, () => 'profile-1')
  expect(result.preset.name).toBe('Evening reading')
  expect(result.preset.values).toEqual(readingPresetValues(settings))
  expect(result.preset.values).not.toHaveProperty('autoRegenerateEnabled')
  expect(result.preset.values).not.toHaveProperty('toolbarSpacing')
  expect(normalizeReadingPresets(JSON.parse(JSON.stringify(result.presets)))).toEqual(result.presets)
})

test('saving the same name updates the existing setup without changing its identity', () => {
  const first = saveReadingPreset([], 'Evening', settings, () => 'profile-1')
  const second = saveReadingPreset(first.presets, 'evening', { ...settings, fixation: 55 }, () => 'unused')
  expect(second.presets).toHaveLength(1)
  expect(second.preset.id).toBe('profile-1')
  expect(second.preset.values.fixation).toBe(55)
})

test('invalid and duplicate saved setups are ignored on load', () => {
  const raw = [
    { id: 'good-1', name: 'Comfort', values: { fixation: 40, toolbarSpacing: 8 } },
    { id: 'good-2', name: 'comfort', values: { fixation: 30 } },
    { id: 'bad id', name: 'Other', values: { fixation: 30 } },
    { id: 'good-3', name: '', values: {} },
  ]
  expect(normalizeReadingPresets(raw)).toEqual([
    { id: 'good-1', name: 'Comfort', values: { fixation: 40 } },
  ])
  expect(() => saveReadingPreset([], ' ', settings, () => 'profile-1')).toThrow()
})
