import { test, expect } from 'bun:test'
import { JSDOM } from 'jsdom'
import { characterFolderGroups, characterFolderPlan, assertFolderMove } from '../src/character-folders-core'
import { ARCHIVE_FOLDER, ARCHIVE_KEY } from '../src/character-cleaner-core'
import { installCharacterCleaner } from '../src/library-characters-frontend'
import { handleLorebookOrganizerMessage } from '../src/lorebook-organizer-backend'

const card = (id: string, extra = {}) => ({ id, name: `Bot ${id}`, creator: 'Writer', tags: ['Fantasy'], folder: '', description: 'Card text', extensions: {}, ...extra })

test('author and tag groups normalize whitespace/case and exclude archives or missing metadata', () => {
  const cards = [card('a'), card('b', { creator: '  writer ', tags: ['FANTASY', 'Fantasy'] }), card('c', { creator: '', tags: [] }), card('d', { folder: ARCHIVE_FOLDER }), card('e', { extensions: { [ARCHIVE_KEY]: {} } })]
  const authors = characterFolderGroups(cards, 'author'), tags = characterFolderGroups(cards, 'tag')
  expect(authors).toHaveLength(1); expect(authors[0].cards.map(card => card.id)).toEqual(['a', 'b'])
  expect(tags).toHaveLength(1); expect(tags[0].cards.map(card => card.id)).toEqual(['a', 'b'])
  expect(authors[0].folder).toBe('Author · Writer')
})

test('selected overlapping tags produce one deterministic folder per bot and protect existing folders', () => {
  const cards = [card('a', { tags: ['Fantasy', 'Adventure'] }), card('b', { tags: ['Adventure'] }), card('c', { tags: ['Fantasy'], folder: 'Favorites' }), card('d', { tags: ['Adventure'] })]
  const groups = characterFolderGroups(cards, 'tag')
  const selected = new Map(groups.map(group => [group.key, group.folder]))
  const plan = characterFolderPlan(groups, selected, true)
  expect(plan).toHaveLength(3); expect(new Set(plan.map(move => move.id)).size).toBe(3)
  expect(plan.find(move => move.id === 'a')!.folder).toBe('Tag · Adventure')
  expect(plan.some(move => move.id === 'c')).toBe(false)
  expect(characterFolderPlan(groups, selected, false)).toHaveLength(4)
})

test('folder previews validate names and reject edited or moved cards before updates', () => {
  const cards = [card('a'), card('b')], groups = characterFolderGroups(cards, 'author')
  const selected = new Map([['writer', 'My author folder']])
  const plan = characterFolderPlan(groups, selected, true)
  expect(() => assertFolderMove(cards[0], plan[0])).not.toThrow()
  expect(() => assertFolderMove(card('a', { folder: 'Changed' }), plan[0])).toThrow()
  expect(() => assertFolderMove(card('a', { creator: 'Another author' }), plan[0])).toThrow()
  expect(() => characterFolderPlan(groups, new Map([['writer', ' ']]), true)).toThrow()
  expect(() => characterFolderPlan(groups, new Map([['writer', ARCHIVE_FOLDER]]), true)).toThrow()
})

test('removed lorebook AI messages do not start generation', async () => {
  const api = { generate: { quiet() { throw new Error('AI must not run') } } }
  expect(await handleLorebookOrganizerMessage(api, { type: 'bionic_lore_ai_organize', requestId: 'test' }, 'owner')).toBe(false)
  expect(await handleLorebookOrganizerMessage(api, { type: 'bionic_lore_connections', requestId: 'test' }, 'owner')).toBe(false)
})

test('manual lorebook folder updates still work and are scoped to the requesting user', async () => {
  const updates: any[] = [], replies: any[] = []
  const api = { worldBooks: { update: (...args: any[]) => { updates.push(args); return {} } }, sendToFrontend: (...args: any[]) => replies.push(args) }
  // The host namespace is world_books in this runtime.
  api['world_books'] = api.worldBooks
  expect(await handleLorebookOrganizerMessage(api, { type: 'bionic_lore_apply_folders', requestId: 'manual', assignments: [{ bookId: 'book', folder: 'My books' }] }, 'owner')).toBe(true)
  expect(updates).toEqual([['book', { folder: 'My books' }, 'owner']])
  expect(replies[0][0].type).toBe('bionic_lore_apply_folders_result')
  expect(replies[0][0].error).toBeUndefined()
})

test('folder UI previews before writing, protects existing folders and sends only folder changes', async () => {
  const dom = new JSDOM('<div id="root"><div id="lb-character-cleaner"></div></div>')
  const old = { window: globalThis.window, fetch: globalThis.fetch }
  globalThis.window = dom.window as any; dom.window.confirm = () => true
  const cards = [card('a'), card('b'), card('c', { folder: 'Favorites' })], writes: any[] = []
  globalThis.fetch = (async (url: string, options: any) => {
    const id = url.split('/').pop()
    if (options.method) { const body = JSON.parse(options.body); writes.push({ id, body }); Object.assign(cards.find(card => card.id === id)!, body); return { ok: true, json: async () => cards.find(card => card.id === id) } }
    return { ok: true, json: async () => url.includes('?') ? { data: url.includes('/chats?') ? [] : cards, total: url.includes('/chats?') ? 0 : cards.length } : cards.find(card => card.id === id) }
  }) as any
  const root = dom.window.document.querySelector('#root') as HTMLElement
  const cleanup = installCharacterCleaner(root)
  const click = (selector: string) => (root.querySelector(selector) as HTMLButtonElement).click()
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 1)) }
  try {
    click('[data-cleaner="scan"]'); await settle()
    click('[data-cleaner="select-folders"]')
    click('[data-cleaner="preview-folders"]')
    expect(root.textContent).toContain('2 bots will move'); expect(writes).toHaveLength(0)
    click('[data-cleaner="apply-folders"]'); await settle()
    expect(writes).toEqual([{ id: 'a', body: { folder: 'Author · Writer' } }, { id: 'b', body: { folder: 'Author · Writer' } }])
    expect(cards[2].folder).toBe('Favorites')
  } finally { cleanup(); globalThis.window = old.window; globalThis.fetch = old.fetch; dom.window.close() }
})
