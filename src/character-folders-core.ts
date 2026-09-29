import { ARCHIVE_FOLDER, ARCHIVE_KEY, characterFingerprint } from './character-cleaner-core'

export type FolderGroup = { key: string; label: string; folder: string; cards: any[] }
export type FolderMove = { id: string; name: string; from: string; folder: string; fingerprint: string }
const text = (value: unknown) => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ') : ''

export function characterFolderGroups(cards: any[], mode: 'author' | 'tag'): FolderGroup[] {
  const groups = new Map<string, FolderGroup>()
  for (const card of cards) {
    if (card.folder === ARCHIVE_FOLDER || card.extensions?.[ARCHIVE_KEY]) continue
    const values = mode === 'author' ? [text(card.creator)] : Array.isArray(card.tags) ? card.tags.map(text) : []
    for (const value of new Set(values.filter(Boolean).map(value => value.toLowerCase()))) {
      const label = values.find(item => item.toLowerCase() === value)!
      const group = groups.get(value) || { key: value, label, folder: `${mode === 'author' ? 'Author' : 'Tag'} · ${label}`.slice(0, 120), cards: [] }
      group.cards.push(card); groups.set(value, group)
    }
  }
  return [...groups.values()].filter(group => group.cards.length >= 2)
    .sort((a, b) => b.cards.length - a.cards.length || a.key.localeCompare(b.key))
}

// A bot belongs to one folder. Overlapping selected tags use the largest group,
// with a stable alphabetical tie-break; the preview always shows the final choice.
export function characterFolderPlan(groups: FolderGroup[], selected: Map<string, string>, onlyUnfiled: boolean): FolderMove[] {
  const assigned = new Set<string>(), plan: FolderMove[] = []
  for (const group of groups) {
    if (!selected.has(group.key)) continue
    const folder = selected.get(group.key)!.trim()
    if (!folder || folder.length > 120) throw new Error('Folder names must contain 1–120 characters.')
    if (folder === ARCHIVE_FOLDER) throw new Error('Choose a name other than the duplicate archive folder.')
    for (const card of group.cards) {
      if (assigned.has(card.id) || (onlyUnfiled && String(card.folder || '').trim())) continue
      assigned.add(card.id)
      if (card.folder === folder) continue
      plan.push({ id: card.id, name: card.name, from: card.folder || '', folder, fingerprint: characterFingerprint(card) })
    }
  }
  return plan
}

export function assertFolderMove(card: any, move: FolderMove) {
  if (!card || card.id !== move.id || (card.folder || '') !== move.from || characterFingerprint(card) !== move.fingerprint) {
    throw new Error('A character changed since the preview. Scan again before moving it.')
  }
  if (card.folder === ARCHIVE_FOLDER || card.extensions?.[ARCHIVE_KEY]) throw new Error('Archived duplicates cannot be organized.')
}
