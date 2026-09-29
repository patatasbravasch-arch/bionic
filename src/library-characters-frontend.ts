import { ARCHIVE_FOLDER, ARCHIVE_KEY, characterFingerprint, duplicateGroups, assertArchiveSafe, pagedCharacters } from './character-cleaner-core'
import { characterFolderGroups, characterFolderPlan, assertFolderMove, type FolderMove } from './character-folders-core'

const escape = (value: any) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))
const path = (id: string) => `/api/v1/characters/${encodeURIComponent(id)}`
const thumbnail = (card: any) => `<img class="lb-bot-avatar" src="${path(card.id)}/avatar" alt="" loading="lazy">`

export function installCharacterCleaner(root: HTMLElement) {
  const host = root.querySelector<HTMLElement>('#lb-character-cleaner')!
  let cards: any[] = [], groups: ReturnType<typeof duplicateGroups> = [], busy = false, disposed = false, scanned = false
  let view = 'folders', mode: 'author' | 'tag' = 'author', onlyUnfiled = true, query = '', page = 0
  let status = 'Scan your characters to create folders or review duplicate cards.'
  let preview: FolderMove[] | null = null
  const chosenFolders = new Map<string, string>(), keepers = new Map<string, string>()
  const selected = new Set<string>(), reviewed = new Set<string>(), expanded = new Set<string>()

  async function api(url: string, options: RequestInit = {}) {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers } })
    if (!response.ok) throw new Error(`Library request failed (${response.status}).`)
    return response.json()
  }
  async function scan() {
    const [library, chats] = await Promise.all([pagedCharacters(api, '/api/v1/characters'), pagedCharacters(api, '/api/v1/chats')])
    if (disposed) return
    cards = library; groups = duplicateGroups(library, chats); scanned = true
    selected.clear(); reviewed.clear(); keepers.clear(); chosenFolders.clear(); preview = null; page = 0
    groups.forEach(group => keepers.set(group.cards[0].id, group.keeperId))
  }
  const eligible = (card: any, keeper: any) => card.id !== keeper.id && !card.chatCount && (characterFingerprint(card) === characterFingerprint(keeper) || reviewed.has(card.id))
  const matches = (value: string) => value.toLowerCase().includes(query.trim().toLowerCase())
  function differenceView(card: any, keeper: any) {
    const fields = ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator', 'creator_notes', 'system_prompt', 'post_history_instructions', 'alternate_greetings', 'tags']
      .filter(key => JSON.stringify(card[key]) !== JSON.stringify(keeper[key]))
    const labels: Record<string, string> = { first_mes: 'Opening message', mes_example: 'Example messages', creator_notes: 'Author notes', system_prompt: 'System prompt', post_history_instructions: 'After-history instructions', alternate_greetings: 'Other greetings' }
    return `<details data-difference="${escape(card.id)}" ${expanded.has(card.id) ? 'open' : ''}><summary>Compare with the keeper</summary>
      ${fields.map(key => `<div class="lb-bot-difference"><strong>${escape(labels[key] || key)}</strong><div><span>Keeper</span><p>${escape(Array.isArray(keeper[key]) ? keeper[key].join('\n') : keeper[key] || 'Empty')}</p></div><div><span>This copy</span><p>${escape(Array.isArray(card[key]) ? card[key].join('\n') : card[key] || 'Empty')}</p></div></div>`).join('')}
      ${card.image_id !== keeper.image_id || card.avatar_path !== keeper.avatar_path ? '<p>These cards have different image records. Both images are preserved when archiving.</p>' : ''}
      ${JSON.stringify(card.extensions) !== JSON.stringify(keeper.extensions) ? '<p>Extra card settings or lorebook links also differ. Archiving preserves them.</p>' : ''}
      <label class="lb-bot-check"><input type="checkbox" data-review="${escape(card.id)}" ${reviewed.has(card.id) ? 'checked' : ''} ${busy || card.chatCount ? 'disabled' : ''}> I reviewed this variant and allow archiving it</label></details>`
  }
  function foldersView() {
    if (preview) return `<section class="lb-bot-plan"><h3>${preview.length} bots will move</h3><div class="lb-bot-actions"><button type="button" data-cleaner="back-folders">Back to groups</button><button type="button" data-cleaner="apply-folders" ${busy || !preview.length ? 'disabled' : ''}>Create folders and move ${preview.length} bots</button></div><div class="lb-bot-table-wrap"><table><thead><tr><th>Bot</th><th>Current folder</th><th>New folder</th></tr></thead><tbody>${preview.map(move => `<tr><td>${escape(move.name)}</td><td>${escape(move.from || 'No folder')}</td><td>${escape(move.folder)}</td></tr>`).join('')}</tbody></table></div></section>`
    const suggestions = characterFolderGroups(cards, mode).filter(group => matches(group.label))
    return `<p>Group bots by the author or tags saved on their cards. Preview the moves before creating folders.</p>
      <div class="lb-bot-actions"><label>Group by <select data-folder-mode ${busy ? 'disabled' : ''}><option value="author" ${mode === 'author' ? 'selected' : ''}>Author</option><option value="tag" ${mode === 'tag' ? 'selected' : ''}>Tag</option></select></label>
      <label class="lb-bot-check"><input type="checkbox" data-unfiled ${onlyUnfiled ? 'checked' : ''} ${busy ? 'disabled' : ''}> Only bots without a folder</label></div>
      ${mode === 'tag' ? '<p class="lumibionic-muted">For bots with several selected tags, the most common selected tag wins. Check the preview to see each bot’s folder.</p>' : ''}
      <div class="lb-bot-actions"><button type="button" data-cleaner="select-folders" ${busy || !suggestions.length ? 'disabled' : ''}>Select visible groups</button><button type="button" data-cleaner="clear-folders" ${busy ? 'disabled' : ''}>Clear selection</button></div>
      <div class="lb-bot-folder-grid">${suggestions.map(group => {
        const count = group.cards.filter(card => !onlyUnfiled || !String(card.folder || '').trim()).length
        return `<article class="lb-bot-folder"><label class="lb-bot-check"><input type="checkbox" data-folder-group="${escape(group.key)}" ${chosenFolders.has(group.key) ? 'checked' : ''} ${busy || !count ? 'disabled' : ''}><strong>${escape(group.label)}</strong><span>${count} eligible · ${group.cards.length} total</span></label>
        <input type="text" maxlength="120" data-folder-name="${escape(group.key)}" aria-label="Folder for ${escape(group.label)}" value="${escape(chosenFolders.get(group.key) ?? group.folder)}" ${busy ? 'disabled' : ''}>
        <p>${group.cards.slice(0, 5).map(card => escape(card.name)).join(' · ')}${group.cards.length > 5 ? ` · +${group.cards.length - 5} more` : ''}</p></article>`
      }).join('')}</div>
      ${scanned && !suggestions.length ? '<p>No shared authors or tags found for this search. Cards need a saved author or tag shared by at least two bots.</p>' : ''}
      <button type="button" data-cleaner="preview-folders" ${busy || !chosenFolders.size ? 'disabled' : ''}>Preview folder moves</button>
      `
  }
  function duplicatesView() {
    const visible = groups.filter(group => matches(group.name + ' ' + group.cards.map(card => `${card.creator || ''} ${card.folder || ''}`).join(' ')))
    const maxPage = Math.max(0, Math.ceil(visible.length / 6) - 1); page = Math.min(page, maxPage)
    return `<p>Choose a keeper, then select unused copies to archive. Chat-linked cards are protected. Compare differing versions before selecting them.</p>
      <div class="lb-bot-actions"><button type="button" data-cleaner="select" ${busy || !visible.length ? 'disabled' : ''}>Select identical unused copies</button><button type="button" data-cleaner="archive" ${busy || !selected.size ? 'disabled' : ''}>Archive selected (${selected.size})</button></div>
      ${visible.slice(page * 6, page * 6 + 6).map(group => {
        const keeper = group.cards.find(card => card.id === keepers.get(group.cards[0].id))!
        return `<section class="lb-bot-group"><header><h3>${escape(group.name)}</h3><label>Keep <select aria-label="Keep a copy of ${escape(group.name)}" data-keeper="${escape(group.cards[0].id)}" ${busy ? 'disabled' : ''}>${group.cards.map(card => `<option value="${escape(card.id)}" ${card.id === keeper.id ? 'selected' : ''}>${escape(card.name)} · ${card.chatCount} chats · ${escape(card.creator || 'No author')} · ${escape(card.id.slice(0, 8))}</option>`).join('')}</select></label></header>
          <div class="lb-bot-copy-grid">${group.cards.map(card => `<article class="lb-bot-copy"><div class="lb-bot-card-heading">${thumbnail(card)}<div><strong>${escape(card.name)}</strong><small>${escape(card.creator || 'No author')}<br>${escape(card.folder || 'No folder')} · ${card.chatCount} chats</small></div></div>
          <p>${card.id === keeper.id ? 'Keeping this copy' : card.chatCount ? 'Protected: used in chats' : characterFingerprint(card) === characterFingerprint(keeper) ? 'Identical card content' : 'Different version'}</p>
          ${card.id !== keeper.id && characterFingerprint(card) !== characterFingerprint(keeper) ? differenceView(card, keeper) : ''}
          ${card.id !== keeper.id ? `<label class="lb-bot-check"><input type="checkbox" data-card="${escape(card.id)}" ${selected.has(card.id) ? 'checked' : ''} ${busy || !eligible(card, keeper) ? 'disabled' : ''}> Archive this copy</label>` : ''}</article>`).join('')}</div></section>`
      }).join('')}
      ${scanned && !visible.length ? '<p>No duplicate-name groups found for this search.</p>' : ''}
      ${visible.length > 6 ? `<div class="lb-bot-actions"><button type="button" data-cleaner="previous" ${page === 0 ? 'disabled' : ''}>Previous</button><span>Page ${page + 1} of ${maxPage + 1}</span><button type="button" data-cleaner="next" ${page === maxPage ? 'disabled' : ''}>Next</button></div>` : ''}`
  }
  function archivedView() {
    const archived = cards.filter(card => card.extensions?.[ARCHIVE_KEY] && matches(card.name))
    return `<p>Archived copies remain in “${escape(ARCHIVE_FOLDER)}”. Restore returns each card to its original folder.</p><div class="lb-bot-copy-grid">${archived.map(card => `<article class="lb-bot-copy"><div class="lb-bot-card-heading">${thumbnail(card)}<strong>${escape(card.name)}</strong></div><button type="button" data-restore="${escape(card.id)}" ${busy ? 'disabled' : ''}>Restore</button></article>`).join('')}</div>${scanned && !archived.length ? '<p>No archived copies found.</p>' : ''}`
  }
  function render() {
    if (disposed) return
    const searchFocused = host.ownerDocument.activeElement?.getAttribute('data-bot-search') !== null && host.contains(host.ownerDocument.activeElement)
    const position = (host.ownerDocument.activeElement as HTMLInputElement)?.selectionStart
    host.innerHTML = `<style>
      .lb-bot-actions,.lb-bot-check,.lb-bot-card-heading{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.lb-bot-actions{margin:12px 0}.lb-bot-check input{flex:0 0 auto}.lb-bot-avatar{width:54px;height:68px;object-fit:cover;border-radius:8px;background:#292b37}.lb-bot-card-heading{flex-wrap:nowrap}.lb-bot-card-heading small{display:block;opacity:.7}.lb-bot-copy-grid,.lb-bot-folder-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr));gap:12px}.lb-bot-folder-grid{max-height:44dvh;overflow:auto}.lb-bot-copy,.lb-bot-folder,.lb-bot-group,.lb-bot-plan{padding:14px;border:1px solid rgba(127,127,127,.24);border-radius:10px;min-width:0;margin:12px 0}.lb-bot-group header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.lb-bot-group h3{margin:0}.lb-bot-group select{max-width:100%}.lb-bot-copy details{margin:10px 0}.lb-bot-copy summary{cursor:pointer}.lb-bot-difference{display:grid;grid-template-columns:1fr 1fr;gap:8px;border-top:1px solid rgba(127,127,127,.2);margin-top:12px;padding-top:10px}.lb-bot-difference>strong{grid-column:1/-1}.lb-bot-difference p{max-height:160px;overflow:auto;white-space:pre-wrap;font-size:12px;overflow-wrap:anywhere}.lb-bot-folder input[type=text]{width:100%;margin-top:10px}.lb-bot-folder p{font-size:12px;opacity:.75}.lb-bot-table-wrap{max-height:340px;overflow:auto}.lb-bot-plan table{width:100%;border-collapse:collapse}.lb-bot-plan td,.lb-bot-plan th{text-align:left;padding:8px;border-bottom:1px solid rgba(127,127,127,.2)}#lb-character-cleaner button,#lb-character-cleaner input,#lb-character-cleaner select{font:inherit;color:inherit;background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.25);border-radius:7px;padding:8px}#lb-character-cleaner input[type=checkbox]{padding:0}#lb-character-cleaner button{cursor:pointer}#lb-character-cleaner button:disabled{opacity:.45;cursor:default}#lb-character-cleaner [aria-selected=true]{background:rgba(124,155,200,.24)}#lb-character-cleaner input[type=search]{flex:1;min-width:160px}#lb-character-cleaner{overflow-wrap:anywhere}#lb-character-cleaner select option{background:#20212b}
      </style><div class="lb-bot-actions"><div role="tablist" aria-label="Character tools">${[['folders', 'Folders'], ['duplicates', `Duplicates (${groups.length})`], ['archived', 'Archived']].map(([key, label]) => `<button type="button" role="tab" data-bot-view="${key}" aria-selected="${view === key}">${label}</button>`).join('')}</div>
      <button type="button" data-cleaner="scan" ${busy ? 'disabled' : ''}>${scanned ? 'Rescan characters' : 'Scan characters'}</button><input type="search" data-bot-search aria-label="Search character groups" placeholder="Search ${view === 'folders' ? 'authors or tags' : 'characters'}" value="${escape(query)}"></div>
      <p role="status" aria-live="polite">${escape(status)}</p>${view === 'folders' ? foldersView() : view === 'duplicates' ? duplicatesView() : archivedView()}`
    if (searchFocused) { const input = host.querySelector<HTMLInputElement>('[data-bot-search]')!; input.focus(); if (position !== null) input.setSelectionRange(position, position) }
  }
  async function run(action: () => Promise<void>) {
    if (busy) return
    busy = true; render()
    try { await action() } catch (error: any) { status = error.message || 'Library update failed.' }
    finally { busy = false; render() }
  }
  async function archive() {
    const plan = groups.flatMap(group => {
      const keeper = group.cards.find(card => card.id === keepers.get(group.cards[0].id))!
      return group.cards.filter(card => selected.has(card.id) && eligible(card, keeper)).map(card => ({ id: card.id, keeperId: keeper.id, expected: characterFingerprint(card), keeperExpected: characterFingerprint(keeper), reviewed: reviewed.has(card.id) }))
    })
    if (!plan.length || !window.confirm(`Archive ${plan.length} selected copies? They can be restored. No cards or chats will be deleted.`)) return
    let count = 0
    try {
      for (const item of plan) {
        const [candidate, keeper, chats] = await Promise.all([api(path(item.id)), api(path(item.keeperId)), pagedCharacters(api, '/api/v1/chats')])
        assertArchiveSafe(candidate, keeper, chats, item.expected, item.keeperExpected, item.reviewed)
        if (disposed) throw new Error('Library closed. Remaining cards were not changed.')
        await api(path(item.id), { method: 'PUT', body: JSON.stringify({ folder: ARCHIVE_FOLDER, extensions: { ...candidate.extensions, [ARCHIVE_KEY]: { originalFolder: candidate.folder || '', keeperId: keeper.id, archivedAt: new Date().toISOString() } } }) }); count++
      }
      status = `Archived ${count} copies. Restore them from Archived.`
    } catch (error: any) { status = `Archived ${count} copies; stopped: ${error.message}` }
    await scan()
  }
  async function applyFolders() {
    const plan = preview
    if (!plan?.length || !window.confirm(`Create folders and move ${plan.length} bots as shown in the preview? Cards, lorebooks and chats are preserved.`)) return
    let count = 0
    try {
      for (const move of plan) {
        const card = await api(path(move.id)); assertFolderMove(card, move)
        if (disposed) throw new Error('Library closed. Remaining bots were not moved.')
        await api(path(move.id), { method: 'PUT', body: JSON.stringify({ folder: move.folder }) }); count++
      }
      status = `Moved ${count} bots into folders.`
    } catch (error: any) { status = `Moved ${count} bots; stopped: ${error.message}` }
    await scan()
  }
  function click(event: Event) {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button')
    if (!button || busy) return
    if (button.dataset.botView) { view = button.dataset.botView; query = ''; page = 0; if (scanned) status = `${cards.length} characters · ${groups.length} duplicate-name groups.`; render(); return }
    switch (button.dataset.cleaner) {
      case 'scan': void run(async () => { status = 'Scanning characters…'; render(); await scan(); status = `${cards.length} characters · ${groups.length} duplicate-name groups.` }); break
      case 'select': groups.filter(group => matches(group.name)).forEach(group => { const keeper = group.cards.find(card => card.id === keepers.get(group.cards[0].id))!; group.cards.filter(card => eligible(card, keeper) && characterFingerprint(card) === characterFingerprint(keeper)).forEach(card => selected.add(card.id)) }); render(); break
      case 'archive': void run(archive); break
      case 'previous': page--; render(); break
      case 'next': page++; render(); break
      case 'select-folders': characterFolderGroups(cards, mode).filter(group => matches(group.label) && group.cards.some(card => !onlyUnfiled || !String(card.folder || '').trim())).forEach(group => chosenFolders.set(group.key, chosenFolders.get(group.key) ?? group.folder)); preview = null; render(); break
      case 'clear-folders': chosenFolders.clear(); preview = null; render(); break
      case 'preview-folders': try { preview = characterFolderPlan(characterFolderGroups(cards, mode), chosenFolders, onlyUnfiled); status = `${preview.length} folder moves ready to review.` } catch (error: any) { status = error.message }; render(); break
      case 'back-folders': preview = null; render(); break
      case 'apply-folders': void run(applyFolders); break
    }
    if (button.dataset.restore) void run(async () => {
      const card = await api(path(button.dataset.restore!)), record = card.extensions?.[ARCHIVE_KEY]
      if (!record || card.folder !== ARCHIVE_FOLDER) throw new Error('This card was moved or restored elsewhere. Rescan characters.')
      const extensions = { ...card.extensions }; delete extensions[ARCHIVE_KEY]
      await api(path(card.id), { method: 'PUT', body: JSON.stringify({ folder: record.originalFolder || '', extensions }) })
      await scan(); status = `Restored ${card.name}.`
    })
  }
  function change(event: Event) {
    if (busy) return
    const target = event.target as HTMLInputElement
    if (target.dataset.keeper) { keepers.set(target.dataset.keeper, target.value); selected.clear(); reviewed.clear() }
    if (target.dataset.review) { target.checked ? reviewed.add(target.dataset.review) : reviewed.delete(target.dataset.review); selected.delete(target.dataset.review) }
    if (target.dataset.card) target.checked ? selected.add(target.dataset.card) : selected.delete(target.dataset.card)
    if (target.hasAttribute('data-folder-mode')) { mode = target.value as 'author' | 'tag'; chosenFolders.clear(); preview = null; query = '' }
    if (target.hasAttribute('data-unfiled')) { onlyUnfiled = target.checked; preview = null }
    if (target.dataset.folderGroup) { const group = characterFolderGroups(cards, mode).find(group => group.key === target.dataset.folderGroup)!; target.checked ? chosenFolders.set(group.key, Array.from(host.querySelectorAll<HTMLInputElement>('[data-folder-name]')).find(input => input.dataset.folderName === group.key)!.value) : chosenFolders.delete(group.key); preview = null }
    render()
  }
  function input(event: Event) {
    const target = event.target as HTMLInputElement
    if (target.hasAttribute('data-bot-search')) { query = target.value; page = 0; render() }
    if (target.dataset.folderName) { if (chosenFolders.has(target.dataset.folderName)) chosenFolders.set(target.dataset.folderName, target.value); preview = null; host.querySelector('.lb-bot-plan')?.remove() }
  }
  function toggle(event: Event) { const target = event.target as HTMLDetailsElement; if (target.dataset.difference) target.open ? expanded.add(target.dataset.difference) : expanded.delete(target.dataset.difference) }
  host.addEventListener('click', click); host.addEventListener('change', change); host.addEventListener('input', input); host.addEventListener('toggle', toggle, true); render()
  return () => { disposed = true; host.removeEventListener('click', click); host.removeEventListener('change', change); host.removeEventListener('input', input); host.removeEventListener('toggle', toggle, true) }
}
