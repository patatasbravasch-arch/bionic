import { describe, test, expect } from 'bun:test'
import { ARCHIVE_FOLDER, ARCHIVE_KEY, characterFingerprint, duplicateGroups, chatReferences, assertArchiveSafe, pagedCharacters } from '../src/character-cleaner-core'
import { installCharacterCleaner } from '../src/library-characters-frontend'
import { JSDOM } from 'jsdom'

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
  test('real UI archives only selected matching copies and restores the original folder', async () => {
    const dom = new JSDOM('<div id="root"><div id="lb-character-cleaner"></div></div>')
    const old = { window: globalThis.window, fetch: globalThis.fetch }
    globalThis.window = dom.window as any
    dom.window.confirm = () => true
    const library = [card('a'), card('b', 'Alice (Copy)'), card('c', 'Alice', { description: 'Different' }), card('d', '<img src=x onerror=alert(1)>')]
    const writes: any[] = []
    globalThis.fetch = (async (path: string, options: any) => {
      const id = path.split('/').pop()
      if (options.method) {
        expect(options.method).toBe('PUT')
        const body = JSON.parse(options.body); writes.push({ id, body })
        Object.assign(library.find(card => card.id === id)!, body)
        return { ok: true, json: async () => library.find(card => card.id === id) }
      }
      return { ok: true, json: async () => path.includes('?') ? { data: path.includes('/chats?') ? [] : library, total: path.includes('/chats?') ? 0 : library.length } : library.find(card => card.id === id) }
    }) as any
    const root = dom.window.document.querySelector('#root') as HTMLElement
    const cleanup = installCharacterCleaner(root)
    const click = (selector: string) => (root.querySelector(selector) as HTMLButtonElement).click()
    const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 1)) }
    try {
      click('[data-cleaner="scan"]'); await settle()
      click('[data-bot-view="duplicates"]')
      expect(root.textContent).toContain('Different version')
      click('[data-cleaner="select"]')
      expect(root.querySelectorAll('input:checked')).toHaveLength(1)
      click('[data-cleaner="archive"]'); await settle()
      expect(writes).toHaveLength(1)
      expect(writes[0].id).toBe('b')
      expect(writes[0].body.folder).toBe(ARCHIVE_FOLDER)
      expect(library[1].extensions[ARCHIVE_KEY].originalFolder).toBe('Friends')
      click('[data-bot-view="archived"]')
      click('[data-restore="b"]'); await settle()
      expect(writes).toHaveLength(2)
      expect(library[1].folder).toBe('Friends')
      expect(library[1].extensions[ARCHIVE_KEY]).toBeUndefined()
    } finally { cleanup(); globalThis.window = old.window; globalThis.fetch = old.fetch; dom.window.close() }
  })
})
