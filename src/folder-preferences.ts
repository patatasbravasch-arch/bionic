export type FolderPreferences = { author: string[]; tag: string[] }
export const FOLDER_PREFERENCES_PATH = 'settings/character-folder-preferences.json'

export function folderPreferences(raw: any): FolderPreferences {
  const keys = (value: any) => Array.isArray(value) ? [...new Set(value.filter(item => typeof item === 'string')
    .map(item => item.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()).filter(Boolean))].slice(0, 500) : []
  return { author: keys(raw?.author), tag: keys(raw?.tag) }
}
