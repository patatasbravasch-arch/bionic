import { characterFingerprint, characterName, chatReferences, ARCHIVE_FOLDER, ARCHIVE_KEY } from './character-cleaner-core'

export const IGNORE_KEY = 'bionic_character_cleaner_ignored'
export type DeleteCopy = { id: string; keeperId: string; expected: string; keeperExpected: string; from: string; keeperFrom: string; name: string; keeperName: string }

export function assertDeleteCopy(candidate: any, keeper: any, chats: any[], item: DeleteCopy) {
  if (!candidate || !keeper || candidate.id !== item.id || keeper.id !== item.keeperId || candidate.id === keeper.id) throw new Error('Both copies must still exist and a keeper must remain. Rescan characters.')
  if (candidate.folder === ARCHIVE_FOLDER || candidate.extensions?.[ARCHIVE_KEY] || keeper.folder === ARCHIVE_FOLDER || keeper.extensions?.[ARCHIVE_KEY]) throw new Error('Restore archived cards before reviewing duplicates.')
  if (candidate.extensions?.[IGNORE_KEY] || keeper.extensions?.[IGNORE_KEY]) throw new Error('This group was ignored. Rescan characters.')
  if ((candidate.folder || '') !== item.from || (keeper.folder || '') !== item.keeperFrom || candidate.name !== item.name || keeper.name !== item.keeperName) throw new Error('A card was renamed or moved since the comparison. Rescan before deleting.')
  if (characterName(candidate.name) !== characterName(keeper.name) || characterFingerprint(candidate) !== item.expected || characterFingerprint(keeper) !== item.keeperExpected) throw new Error('A card changed since the comparison. Rescan before deleting.')
  if (chatReferences(chats, candidate.id)) throw new Error('This card is used in a primary or group chat. Deletion is blocked to protect those chats.')
}

export function characterEditPatch(original: any, current: any, draft: Record<string, any>) {
  if (!current || characterFingerprint(original) !== characterFingerprint(current) || original.name !== current.name || (original.folder || '') !== (current.folder || '')) throw new Error('The character changed elsewhere. Reload it before saving.')
  if (!String(draft.name || '').trim()) throw new Error('A character name is required.')
  const patch: Record<string, any> = {}
  const fields = ['name', 'creator', 'folder', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions', 'tags', 'alternate_greetings']
  for (const key of fields) {
    if (JSON.stringify(draft[key]) !== JSON.stringify(original[key] ?? (['tags', 'alternate_greetings'].includes(key) ? [] : ''))) patch[key] = draft[key]
  }
  return patch
}
