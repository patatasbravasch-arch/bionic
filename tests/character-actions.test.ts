import { test, expect } from 'bun:test'
import { JSDOM } from 'jsdom'
import { assertDeleteCopy, characterEditPatch, IGNORE_KEY } from '../src/character-actions-core'
import { characterFingerprint, duplicateGroups } from '../src/character-cleaner-core'
import { installCharacterCleaner } from '../src/library-characters-frontend'
import { installLorebookOrganizer } from '../src/lorebook-organizer-frontend'

const card = (id: string, extra = {}) => ({ id, name: 'Alice', creator: 'Author', folder: '', description: 'Card text', tags: ['Fantasy'], alternate_greetings: [], extensions: {}, created_at: 1, ...extra })
const plan = (a: any, b: any) => ({ id: a.id, keeperId: b.id, expected: characterFingerprint(a), keeperExpected: characterFingerprint(b), from: a.folder || '', keeperFrom: b.folder || '', name: a.name, keeperName: b.name })

test('deletion validates both snapshots, retains a keeper and protects primary/group chats', () => {
  const a = card('a'), b = card('b'), item = plan(a, b)
  expect(() => assertDeleteCopy(a, b, [], item)).not.toThrow()
  for (const [candidate, keeper, chats] of [[a, a, []], [a, null, []], [a, card('b', { description: 'Edited keeper' }), []], [card('a', { description: 'Edited' }), b, []], [a, b, [{ character_id: 'a' }]], [a, b, [{ metadata: { character_ids: ['a'] } }]], [card('a', { extensions: { [IGNORE_KEY]: true } }), b, []]]) {
    expect(() => assertDeleteCopy(candidate, keeper, chats, item)).toThrow()
  }
})

test('ignored cards leave duplicate scans and edits preserve unrelated fields', () => {
  const original = card('a', { extensions: { world_book_ids: ['book'], custom: 3 }, image_id: 'image' })
  expect(duplicateGroups([original, card('b', { extensions: { [IGNORE_KEY]: true } })], [])).toHaveLength(0)
  const draft = { name: original.name, creator: original.creator, folder: original.folder, description: 'Edited text', personality: '', scenario: '', first_mes: '', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', tags: original.tags, alternate_greetings: [] }
  expect(characterEditPatch(original, original, draft)).toEqual({ description: 'Edited text' })
  expect(() => characterEditPatch(original, { ...original, folder: 'Moved' }, draft)).toThrow()
  expect(() => characterEditPatch(original, original, { ...draft, name: '' })).toThrow()
})

async function harness(action: (h: any) => Promise<void>) {
  const dom = new JSDOM('<div id="root"><div id="lb-character-cleaner"></div></div>')
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch }
  globalThis.window = dom.window as any; globalThis.document = dom.window.document as any
  const library = [card('keeper'), card('copy', { description: 'A different version', created_at: 2 })], writes: any[] = [], chats: any[] = []
  dom.window.confirm = () => true
  globalThis.fetch = (async (url: string, options: any) => {
    const id = url.split('/').pop()
    if (options.method === 'DELETE') { writes.push({ id, method: 'DELETE' }); library.splice(library.findIndex(card => card.id === id), 1); return { ok: true, json: async () => ({ success: true }) } }
    if (options.method === 'PUT') { const body = JSON.parse(options.body); writes.push({ id, method: 'PUT', body }); Object.assign(library.find(card => card.id === id)!, body); return { ok: true, json: async () => library.find(card => card.id === id) } }
    return { ok: true, json: async () => url.includes('?') ? { data: url.includes('/chats?') ? chats : library, total: url.includes('/chats?') ? chats.length : library.length } : library.find(card => card.id === id) }
  }) as any
  const root = dom.window.document.querySelector('#root') as HTMLElement, cleanup = installCharacterCleaner(root)
  const click = (selector: string) => (root.querySelector(selector) as HTMLButtonElement).click()
  const settle = async () => { for (let i = 0; i < 25; i++) await new Promise(resolve => setTimeout(resolve, 1)) }
  const input = (selector: string, value: string) => { const target = root.querySelector(selector) as HTMLInputElement; target.value = value; target.dispatchEvent(new dom.window.Event('input', { bubbles: true })) }
  try { click('[data-cleaner="scan"]'); await settle(); await action({ root, click, input, settle, library, writes, chats, window: dom.window }) }
  finally { cleanup(); globalThis.window = previous.window; globalThis.document = previous.document; globalThis.fetch = previous.fetch; dom.window.close() }
}

test('comparison supports confirmed deletion of a variant while preserving the keeper', async () => harness(async ({ root, click, settle, library, writes, window }) => {
  click('[data-compare="copy"]')
  expect(root.querySelector('.lb-bot-comparison')).not.toBeNull()
  expect(root.textContent).toContain('A different version')
  window.confirm = () => false
  click('[data-delete-card="copy"]'); await settle(); expect(writes).toHaveLength(0)
  window.confirm = () => true
  click('[data-delete-card="copy"]'); await settle()
  expect(writes).toEqual([{ id: 'copy', method: 'DELETE' }]); expect(library.map(card => card.id)).toEqual(['keeper'])
}))

test('new chat links block deletion after comparison and cause no writes', async () => harness(async ({ root, click, settle, writes, chats }) => {
  click('[data-compare="copy"]')
  chats.push({ id: 'new-chat', character_id: 'other', metadata: { character_ids: ['copy'] } })
  click('[data-delete-card="copy"]'); await settle()
  expect(writes).toHaveLength(0); expect(root.textContent).toContain('Deletion is blocked')
}))

test('ignore and unignore persist without moving the card or deleting it', async () => harness(async ({ root, click, settle, library, writes }) => {
  click('[data-ignore-card="copy"]'); await settle()
  expect(library[1].extensions[IGNORE_KEY]).toBe(true); expect(library[1].folder).toBe('')
  expect(root.querySelectorAll('.lb-bot-group')).toHaveLength(0)
  click('[data-bot-view="ignored"]'); click('[data-unignore="copy"]'); await settle()
  expect(library[1].extensions[IGNORE_KEY]).toBeUndefined()
  expect(writes.every(write => write.method === 'PUT' && !('folder' in write.body))).toBe(true)
}))

test('editing a duplicate saves only changed fields and returns to refreshed results', async () => harness(async ({ root, click, input, settle, library, writes }) => {
  click('[data-edit-card="copy"]'); await settle()
  input('[data-edit-field="description"]', 'Updated description')
  click('[data-cleaner="save-edit"]'); await settle()
  expect(writes).toEqual([{ id: 'copy', method: 'PUT', body: { description: 'Updated description' } }])
  expect(library[1].description).toBe('Updated description'); expect(root.querySelector('.lb-bot-editor')).toBeNull()
}))

test('lorebook tools exist only within the Lorebooks section and character state survives switching', async () => {
  const dom = new JSDOM('<button id="lb-lore-organizer-open">Open</button><div id="lb-lore-organizer-summary"></div>')
  const previous = { window: globalThis.window, document: globalThis.document }
  globalThis.window = dom.window as any; globalThis.document = dom.window.document as any
  let modal: HTMLElement, dismissed = () => {}
  const cleanup = installLorebookOrganizer({ dom: { addStyle: () => () => {} }, onBackendMessage: () => () => {}, ui: { showModal: () => { modal = dom.window.document.createElement('div'); dom.window.document.body.append(modal); return { root: modal, onDismiss: (fn: () => void) => { dismissed = fn }, dismiss: () => dismissed() } } } }, dom.window.document.body)
  try {
    (dom.window.document.querySelector('button') as HTMLButtonElement).click()
    expect(modal!.querySelector('[aria-label="Lorebook tools"]')).toBeNull()
    expect(modal!.querySelectorAll('[aria-label="Library sections"] button')).toHaveLength(2)
    const characterRoot = modal!.querySelector('#lb-character-cleaner')
    ;(modal!.querySelector('[aria-label="Library sections"] [data-organizer-tab="overview"]') as HTMLButtonElement).click()
    expect(modal!.querySelector('[aria-label="Lorebook tools"]')).not.toBeNull()
    ;(modal!.querySelector('[data-organizer-tab="characters"]') as HTMLButtonElement).click()
    expect(modal!.querySelector('[aria-label="Lorebook tools"]')).toBeNull()
    expect(modal!.querySelector('#lb-character-cleaner')).toBe(characterRoot)
  } finally { cleanup(); globalThis.window = previous.window; globalThis.document = previous.document; dom.window.close() }
})
