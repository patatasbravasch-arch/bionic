import { test, expect } from 'bun:test'
import { JSDOM } from 'jsdom'
import { installCharacterCleaner } from '../src/library-characters-frontend'
import { handleLorebookOrganizerMessage } from '../src/lorebook-organizer-backend'
import { FOLDER_PREFERENCES_PATH, folderPreferences } from '../src/folder-preferences'

test('folder preferences normalize exclusions and save/load under the requesting account', async () => {
  const writes: any[] = [], reads: any[] = [], replies: any[] = []
  let stored: any
  const api = { userStorage: {
    setJson: (...args: any[]) => { writes.push(args); stored = args[1] },
    getJson: (...args: any[]) => { reads.push(args); if (stored === undefined && !("fallback" in args[1])) throw new Error("Missing preference file"); return stored ?? args[1].fallback },
  }, sendToFrontend: (...args: any[]) => replies.push(args) }
  await handleLorebookOrganizerMessage(api, { type: 'bionic_character_folder_preferences_load', requestId: 'first-load' }, 'owner')
  expect(replies[0][0].preferences).toEqual({ author: [], tag: [] })
  reads.length = 0; replies.length = 0
  expect(folderPreferences({ tag: [' AnyPOV ', 'anypov', 'musicmania'], author: [' Writer '] })).toEqual({ tag: ['anypov', 'musicmania'], author: ['writer'] })
  await handleLorebookOrganizerMessage(api, { type: 'bionic_character_folder_preferences_save', requestId: 'save', preferences: { tag: ['AnyPOV'], author: [] } }, 'owner')
  await handleLorebookOrganizerMessage(api, { type: 'bionic_character_folder_preferences_load', requestId: 'load' }, 'owner')
  expect(writes[0]).toEqual([FOLDER_PREFERENCES_PATH, { tag: ['anypov'], author: [] }, { userId: 'owner' }])
  expect(reads[0]).toEqual([FOLDER_PREFERENCES_PATH, { userId: 'owner', fallback: { author: [], tag: [] } }])
  expect(replies[1][0].preferences.tag).toEqual(['anypov'])
  expect(replies[1][1]).toBe('owner')
})

test('only picked folders appear in previews, and excluded tags stay excluded after reopening', async () => {
  const dom = new JSDOM('<div id="root"><div id="lb-character-cleaner"></div></div>')
  const previous = { window: globalThis.window, fetch: globalThis.fetch }
  globalThis.window = dom.window as any
  const cards = ['a', 'b'].map(id => ({ id, name: 'Bot ' + id, creator: 'Writer', folder: '', description: 'Card', tags: ['Fantasy', 'musicmania', 'AnyPOV'], extensions: {} }))
  globalThis.fetch = (async (url: string) => ({ ok: true, json: async () => url.includes('/chats?') ? { data: [], total: 0 } : { data: cards, total: 2 } })) as any
  let saved = folderPreferences(null)
  const options = { loadFolderPreferences: async () => ({ preferences: saved }), saveFolderPreferences: async (preferences: any) => { saved = preferences } }
  const root = dom.window.document.querySelector('#root') as HTMLElement
  let cleanup = installCharacterCleaner(root, options)
  const click = (selector: string) => (root.querySelector(selector) as HTMLButtonElement).click()
  const settle = async () => { for (let i = 0; i < 25; i++) await new Promise(resolve => setTimeout(resolve, 1)) }
  const tags = () => { const target = root.querySelector('[data-folder-mode]') as HTMLSelectElement; target.value = 'tag'; target.dispatchEvent(new dom.window.Event('change', { bubbles: true })) }
  try {
    click('[data-cleaner="scan"]'); await settle(); click('[data-bot-view="folders"]'); await settle(); tags()
    expect(root.querySelector('[data-cleaner="preview-folders"]')!.hasAttribute('disabled')).toBe(true)
    click('[data-folder-pick="fantasy"]')
    click('[data-cleaner="preview-folders"]')
    expect(root.textContent).toContain('Tag · Fantasy')
    expect(root.querySelector('.lb-bot-plan')!.textContent).not.toContain('musicmania')
    expect(root.querySelector('.lb-bot-plan')!.textContent).not.toContain('AnyPOV')
    click('[data-cleaner="back-folders"]')
    click('[data-folder-exclude="musicmania"]'); await settle()
    click('[data-folder-exclude="anypov"]'); await settle()
    expect(saved.tag).toEqual(['musicmania', 'anypov'])
    cleanup(); cleanup = installCharacterCleaner(root, options)
    click('[data-cleaner="scan"]'); await settle(); click('[data-bot-view="folders"]'); await settle(); tags()
    expect(root.querySelector('[data-folder-pick="musicmania"]')).toBeNull()
    expect(root.querySelector('[data-folder-pick="anypov"]')).toBeNull()
    click('[data-cleaner="select-folders"]'); click('[data-cleaner="preview-folders"]')
    expect(root.querySelector('.lb-bot-plan')!.textContent).toContain('Tag · Fantasy')
    expect(root.querySelector('.lb-bot-plan')!.textContent).not.toContain('musicmania')
    click('[data-cleaner="back-folders"]')
    click('[data-folder-restore="musicmania"]'); await settle()
    expect(root.querySelector('[data-folder-pick="musicmania"]')).not.toBeNull()
  } finally { cleanup(); globalThis.window = previous.window; globalThis.fetch = previous.fetch; dom.window.close() }
})
