export const READING_PRESET_KEYS = [
  'bionicEnabled', 'density', 'fixation', 'weight',
  'fontEnabled', 'font', 'customFont',
  'scopeMessages', 'scopeBubble', 'scopeComposer',
  'scopeMenus', 'scopeNavigation', 'scopeAll',
  'justifyMessages', 'hyphenateMessages', 'readingWidth',
  'paragraphSpacing', 'letterSpacing', 'wordSpacing',
  'textSize', 'lineHeight',
] as const

export function readingPresetValues(settings: Record<string, unknown>) {
  return Object.fromEntries(
    READING_PRESET_KEYS.filter(key => Object.prototype.hasOwnProperty.call(settings, key))
      .map(key => [key, settings[key]])
  )
}

export type SavedReadingPreset = {
  id: string
  name: string
  values: Record<string, unknown>
}

export function normalizeReadingPresets(raw: unknown): SavedReadingPreset[] {
  if (!Array.isArray(raw)) return []
  const names = new Set<string>()
  const ids = new Set<string>()
  const result: SavedReadingPreset[] = []
  for (const item of raw) {
    if (result.length >= 30) break
    if (!item || typeof item !== 'object') continue
    const id = typeof item.id === 'string' ? item.id : ''
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    if (!/^[a-z0-9-]{1,50}$/.test(id) || !name || name.length > 40) continue
    if (!item.values || typeof item.values !== 'object' || Array.isArray(item.values)) continue
    const folded = name.toLocaleLowerCase()
    if (ids.has(id) || names.has(folded)) continue
    ids.add(id)
    names.add(folded)
    result.push({ id, name, values: readingPresetValues(item.values) })
  }
  return result
}

export function saveReadingPreset(
  presets: SavedReadingPreset[],
  name: string,
  settings: Record<string, unknown>,
  newId: () => string,
) {
  const trimmed = name.trim()
  if (!trimmed || trimmed.length > 40) throw new Error('Give the setup a name of 1–40 characters.')
  const existing = presets.find(preset => preset.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase())
  if (!existing && presets.length >= 30) throw new Error('You can save up to 30 reading setups.')
  const id = existing?.id ?? newId()
  if (!/^[a-z0-9-]{1,50}$/.test(id) || (!existing && presets.some(preset => preset.id === id))) {
    throw new Error('Could not create a unique setup. Please try again.')
  }
  const saved = { id, name: trimmed, values: readingPresetValues(settings) }
  return {
    preset: saved,
    presets: existing
      ? presets.map(preset => preset.id === existing.id ? saved : preset)
      : [...presets, saved],
  }
}
