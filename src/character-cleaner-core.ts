export const ARCHIVE_FOLDER = 'Bionic — Duplicate cards'
export const ARCHIVE_KEY = 'bionic_character_cleaner_archive'

export function characterName(value: unknown): string {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase()
    .replace(/(?:\s*\(copy\))+(?:\s*)$/i, '').trim()
}

function stable(value: any): any {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  }
  return value
}

// Compare every card field, including prompts, greetings, assets and lorebook links.
// Only identity, placement, timestamps and import bookkeeping are excluded.
export function characterFingerprint(card: any): string {
  const { id, user_id, created_at, updated_at, folder, name, chatCount, ...content } = card
  const extensions = { ...(content.extensions || {}) }
  delete extensions._lumiverse_source_filename
  delete extensions[ARCHIVE_KEY]
  delete extensions.bionic_character_cleaner_ignored
  return JSON.stringify(stable({ ...content, extensions, name: characterName(name) }))
}

export function chatReferences(chats: any[], characterId: string): number {
  return chats.filter(chat => chat.character_id === characterId ||
    (Array.isArray(chat.metadata?.character_ids) && chat.metadata.character_ids.includes(characterId))).length
}

export function duplicateGroups(cards: any[], chats: any[]) {
  const groups = new Map<string, any[]>()
  for (const card of cards) {
    if (card.folder === ARCHIVE_FOLDER || card.extensions?.[ARCHIVE_KEY] || card.extensions?.bionic_character_cleaner_ignored) continue
    const name = characterName(card.name)
    if (!name) continue
    const group = groups.get(name) || []
    group.push({ ...card, chatCount: chatReferences(chats, card.id) })
    groups.set(name, group)
  }
  return [...groups.values()].filter(group => group.length > 1).map(group => {
    group.sort((a, b) => b.chatCount - a.chatCount || Number(a.created_at) - Number(b.created_at) || a.id.localeCompare(b.id))
    return { name: group[0].name, cards: group, keeperId: group[0].id }
  })
}

export async function pagedCharacters(api: (path: string) => Promise<any>, path: string): Promise<any[]> {
  const cards: any[] = []
  const seen = new Set<string>()
  for (let offset = 0; ; ) {
    const page = await api(`${path}?limit=100&offset=${offset}`)
    if (!Array.isArray(page?.data) || !Number.isFinite(page.total)) throw new Error('Incomplete library response. Nothing was changed.')
    for (const item of page.data) {
      if (!item?.id || seen.has(item.id)) throw new Error('Library changed during scanning. Scan again.')
      seen.add(item.id)
      cards.push(item)
    }
    offset += page.data.length
    if (offset >= page.total) return cards
    if (!page.data.length) throw new Error('Incomplete library response. Nothing was changed.')
  }
}
