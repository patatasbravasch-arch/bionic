import { describe, test, expect } from 'bun:test'
import { ARCHIVE_FOLDER, ARCHIVE_KEY, characterFingerprint, duplicateGroups, chatReferences, assertArchiveSafe, pagedCharacters } from '../src/character-cleaner-core'

const card = (id: string, name = 'Alice', extra = {}) => ({ id, name, description: 'A character', folder: 'Friends', created_at: 1, extensions: {}, ...extra })

describe('Duplicate character cleaner', () => {
  test('recognizes copies while preserving all substantive content', () => {
    const first = card('a'), copy = card('b', 'Alice (Copy)', { created_at: 2, folder: 'Imports' })
    expect(characterFingerprint(first)).toBe(characterFingerprint(copy))
    for (const change of [{ description: 'Different' }, { first_mes: 'Hi' }, { alternate_greetings: ['Hello'] }, { image_id: 'different-image' }, { extensions: { world_book_ids: ['book'] } }]) {
      expect(characterFingerprint(card('b', 'Alice', change))).not.toBe(characterFingerprint(first))
    }
    expect(characterFingerprint(card('b', 'Bob'))).not.toBe(characterFingerprint(first))
  })
  test('ignores object key order and import filenames, but preserves array order', () => {
    expect(characterFingerprint(card('a', 'Alice', { extensions: { a: 1, b: 2, _lumiverse_source_filename: 'a.png' } })))
      .toBe(characterFingerprint(card('b', 'Alice', { extensions: { b: 2, a: 1, _lumiverse_source_filename: 'b.png' } })))
    expect(characterFingerprint(card('a', 'Alice', { alternate_greetings: ['a', 'b'] }))).not.toBe(characterFingerprint(card('b', 'Alice', { alternate_greetings: ['b', 'a'] })))
  })
  test('includes group chat references and recommends the used copy', () => {
    const chats = [{ character_id: 'other', metadata: { character_ids: ['b', 'other'] } }]
    expect(chatReferences(chats, 'b')).toBe(1)
    const groups = duplicateGroups([card('a'), card('b'), card('c', 'Alice', { folder: ARCHIVE_FOLDER }), card('d', 'Alice', { extensions: { [ARCHIVE_KEY]: {} } })], chats)
    expect(groups).toHaveLength(1)
    expect(groups[0].cards).toHaveLength(2)
    expect(groups[0].keeperId).toBe('b')
  })
  test('rechecks changes, missing keepers, archive status and all chats', () => {
    const a = card('a'), b = card('b'), expected = characterFingerprint(a)
    expect(() => assertArchiveSafe(a, b, [], expected)).not.toThrow()
    for (const [candidate, keeper, chats] of [[a, null, []], [a, a, []], [card('a', 'Alice', { description: 'Edited' }), b, []], [a, card('b', 'Alice', { folder: ARCHIVE_FOLDER }), []], [a, b, [{ character_id: 'a' }]], [a, b, [{ metadata: { character_ids: ['a'] } }]]]) {
      expect(() => assertArchiveSafe(candidate, keeper, chats, expected)).toThrow()
    }
  })
  test('loads every page and rejects incomplete or overlapping snapshots', async () => {
    const calls: string[] = []
    expect(await pagedCharacters(async path => { calls.push(path); return { data: calls.length === 1 ? [card('a')] : [card('b')], total: 2 } }, '/characters')).toHaveLength(2)
    expect(calls[1]).toContain('offset=1')
    await expect(pagedCharacters(async () => ({ data: [], total: 1 }), '/characters')).rejects.toThrow()
    await expect(pagedCharacters(async () => ({ data: [card('a')], total: 2 }), '/characters')).rejects.toThrow()
  })
  test('variants require explicit review and retain independent change checks', () => {
    const a = card('a', 'Alice', { description: 'Variant' }), b = card('b')
    const expected = characterFingerprint(a), keeperExpected = characterFingerprint(b)
    expect(() => assertArchiveSafe(a, b, [], expected, keeperExpected)).toThrow()
    expect(() => assertArchiveSafe(a, b, [], expected, keeperExpected, true)).not.toThrow()
    expect(() => assertArchiveSafe(a, card('b', 'Alice', { first_mes: 'Edited' }), [], expected, keeperExpected, true)).toThrow()
  })
})
