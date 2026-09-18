export type LoreRefKind =
  | 'character'
  | 'chat'
  | 'persona'
  | 'global'

export type LoreReference = {
  kind: LoreRefKind
  id: string
  name: string
}

export type LoreBookSnapshot = {
  id: string
  name: string
  folder?: string
  description?: string
  entryCount: number
  entries?: any[]
  signature?: string
  references: LoreReference[]
}

export function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  return Array.from(
    new Set(
      value.filter(
        (item): item is string =>
          typeof item === 'string' &&
          item.length > 0
      )
    )
  )
}

export function characterLoreIds(character: any): string[] {
  if (Array.isArray(character?.world_book_ids)) {
    return uniqueStrings(character.world_book_ids)
  }

  const ext =
    character?.extensions &&
    typeof character.extensions === 'object'
      ? character.extensions
      : {}

  if (Array.isArray(ext.world_book_ids)) {
    return uniqueStrings(ext.world_book_ids)
  }

  if (
    typeof ext.world_book_id === 'string' &&
    ext.world_book_id
  ) {
    return [ext.world_book_id]
  }

  return []
}

export function chatLoreIds(chat: any): string[] {
  return uniqueStrings(
    chat?.metadata?.chat_world_book_ids
  )
}

export function personaLoreIds(persona: any): string[] {
  const id =
    persona?.attached_world_book_id

  return typeof id === 'string' && id
    ? [id]
    : []
}

export function replaceLoreIds(
  ids: string[],
  duplicateIds: Set<string>,
  keepId: string
): string[] {
  return Array.from(
    new Set(
      ids.map(id =>
        duplicateIds.has(id)
          ? keepId
          : id
      )
    )
  )
}

export function buildLoreReferences({
  characters,
  chats,
  personas,
  globalIds,
}: {
  characters: any[]
  chats: any[]
  personas: any[]
  globalIds: string[]
}): Map<string, LoreReference[]> {
  const refs =
    new Map<string, LoreReference[]>()

  const add = (
    bookId: string,
    ref: LoreReference
  ) => {
    const list =
      refs.get(bookId) || []

    if (
      !list.some(
        item =>
          item.kind === ref.kind &&
          item.id === ref.id
      )
    ) {
      list.push(ref)
      refs.set(bookId, list)
    }
  }

  for (const character of characters) {
    for (const bookId of characterLoreIds(character)) {
      add(bookId, {
        kind: 'character',
        id: String(character.id || ''),
        name:
          character.name ||
          'Unnamed character',
      })
    }
  }

  for (const chat of chats) {
    for (const bookId of chatLoreIds(chat)) {
      add(bookId, {
        kind: 'chat',
        id: String(chat.id || ''),
        name:
          chat.title ||
          chat.name ||
          'Unnamed chat',
      })
    }
  }

  for (const persona of personas) {
    for (const bookId of personaLoreIds(persona)) {
      add(bookId, {
        kind: 'persona',
        id: String(persona.id || ''),
        name:
          persona.name ||
          'Unnamed persona',
      })
    }
  }

  for (const bookId of uniqueStrings(globalIds)) {
    add(bookId, {
      kind: 'global',
      id: 'global',
      name: 'Global lorebook',
    })
  }

  return refs
}

export function referenceCounts(
  references: LoreReference[]
): Record<LoreRefKind, number> {
  const counts: Record<LoreRefKind, number> = {
    character: 0,
    chat: 0,
    persona: 0,
    global: 0,
  }

  for (const ref of references) {
    counts[ref.kind] += 1
  }

  return counts
}

export function totalReferenceCount(
  book: LoreBookSnapshot
): number {
  return book.references.length
}

export function chooseKeeper(
  books: LoreBookSnapshot[]
): LoreBookSnapshot | null {
  if (!books.length) return null

  return [...books].sort((a, b) => {
    const refDiff =
      totalReferenceCount(b) -
      totalReferenceCount(a)

    if (refDiff !== 0) {
      return refDiff
    }

    return a.id.localeCompare(b.id)
  })[0]
}

export function isUnlinked(
  book: LoreBookSnapshot
): boolean {
  return book.references.length === 0
}

export function shortLoreId(id: string): string {
  const text = String(id || '')

  if (text.length <= 18) {
    return text
  }

  return `${text.slice(0, 8)}…${text.slice(-6)}`
}

export function summarizeReferences(
  refs: LoreReference[]
): string {
  const counts =
    referenceCounts(refs)

  const parts: string[] = []

  if (counts.character) {
    parts.push(
      `${counts.character} character${
        counts.character === 1 ? '' : 's'
      }`
    )
  }

  if (counts.chat) {
    parts.push(
      `${counts.chat} chat${
        counts.chat === 1 ? '' : 's'
      }`
    )
  }

  if (counts.persona) {
    parts.push(
      `${counts.persona} persona${
        counts.persona === 1 ? '' : 's'
      }`
    )
  }

  if (counts.global) {
    parts.push('global')
  }

  return parts.length
    ? parts.join(' · ')
    : 'no references'
}
