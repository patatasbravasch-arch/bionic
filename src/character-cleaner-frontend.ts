import { ARCHIVE_FOLDER, ARCHIVE_KEY, characterFingerprint, duplicateGroups, assertArchiveSafe, pagedCharacters } from './character-cleaner-core'

const escape = (value: any) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))

export function installCharacterCleaner(root: HTMLElement) {
  const host = root.querySelector<HTMLElement>('#lb-character-cleaner')!
  let cards: any[] = [], groups: ReturnType<typeof duplicateGroups> = [], busy = false, disposed = false
  const keepers = new Map<string, string>()
  const selected = new Set<string>()
  const reviewed = new Set<string>()
  let status = 'Scan your library to find duplicate cards.'

  async function api(path: string, options: RequestInit = {}) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers } })
    if (!response.ok) throw new Error(`Library request failed (${response.status}).`)
    return response.json()
  }
  const characterPath = (id: string) => `/api/v1/characters/${encodeURIComponent(id)}`
  async function scan() {
    const [library, chats] = await Promise.all([
      pagedCharacters(api, '/api/v1/characters'), pagedCharacters(api, '/api/v1/chats')])
    if (disposed) return
    cards = library
    groups = duplicateGroups(library, chats)
    selected.clear()
    reviewed.clear()
    keepers.clear()
    groups.forEach(group => keepers.set(group.cards[0].id, group.keeperId))
  }
  function eligible(card: any, keeper: any) {
    return card.id !== keeper.id && !card.chatCount && (characterFingerprint(card) === characterFingerprint(keeper) || reviewed.has(card.id))
  }
  function differences(card: any, keeper: any) {
    const fields = Object.keys(card).filter(key => !['id', 'user_id', 'name', 'folder', 'created_at', 'updated_at', 'chatCount'].includes(key) && JSON.stringify(card[key]) !== JSON.stringify(keeper[key]))
    return `<details><summary>Review differences (${escape(fields.join(', ') || 'name only')})</summary>
      ${fields.map(key => `<p><strong>${escape(key)}</strong><br>Keeping: ${escape(String(JSON.stringify(keeper[key]) ?? '').slice(0, 700))}<br>This copy: ${escape(String(JSON.stringify(card[key]) ?? '').slice(0, 700))}</p>`).join('')}
      <label><input type="checkbox" data-review="${escape(card.id)}" ${reviewed.has(card.id) ? 'checked' : ''} ${busy || card.chatCount ? 'disabled' : ''}> I reviewed this variant and allow archiving it</label></details>`
  }
  function render() {
    if (disposed) return
    host.innerHTML = `<div class="lumibionic-muted">Copies can be archived into “${escape(ARCHIVE_FOLDER)}” and restored here. Cards used in chats are protected. Review differences before archiving a variant.</div>
      <div class="lumibionic-toolbar-actions"><button type="button" data-cleaner="scan" ${busy ? 'disabled' : ''}>Scan duplicates</button>
      <button type="button" data-cleaner="select" ${busy || !groups.length ? 'disabled' : ''}>Select matching copies</button></div>
      <p role="status" aria-live="polite">${escape(status)}</p>
      ${groups.map(group => {
        const keeper = group.cards.find(card => card.id === keepers.get(group.cards[0].id))!
        return `<details class="lumibionic-subsection" open><summary>${escape(group.name)} · ${group.cards.length} cards</summary>
          <div class="lumibionic-muted">Keep one copy:</div>
          <select aria-label="Keep a copy of ${escape(group.name)}" data-keeper="${escape(group.cards[0].id)}" ${busy ? 'disabled' : ''}>
            ${group.cards.map(card => `<option value="${escape(card.id)}" ${card.id === keeper.id ? 'selected' : ''}>${escape(card.name)} · ${card.chatCount} chats · ${escape(card.id.slice(0, 8))}</option>`).join('')}</select>
          ${group.cards.map(card => `<label class="lb-character-row"><input type="checkbox" data-card="${escape(card.id)}" ${selected.has(card.id) ? 'checked' : ''} ${busy || !eligible(card, keeper) ? 'disabled' : ''}>
            <span><strong>${escape(card.name)}</strong><small>${escape(card.folder || 'No folder')} · ${escape(card.id.slice(0, 8))}<br>${card.id === keeper.id ? 'Keeping this copy' : card.chatCount ? `Protected · ${card.chatCount} chats` : characterFingerprint(card) === characterFingerprint(keeper) ? 'Matching content · can archive' : reviewed.has(card.id) ? 'Reviewed variant · can archive' : 'Different content · review below'}</small></span></label>${card.id !== keeper.id && characterFingerprint(card) !== characterFingerprint(keeper) ? differences(card, keeper) : ''}`).join('')}
          </details>`
      }).join('')}
      <button type="button" data-cleaner="archive" ${busy || !selected.size ? 'disabled' : ''}>Archive selected copies (${selected.size})</button>
      ${cards.filter(card => card.extensions?.[ARCHIVE_KEY]).length ? `<details class="lumibionic-subsection"><summary>Archived by Bionic (${cards.filter(card => card.extensions?.[ARCHIVE_KEY]).length})</summary>
        ${cards.filter(card => card.extensions?.[ARCHIVE_KEY]).map(card => `<div class="lb-character-row"><span>${escape(card.name)}</span><button type="button" data-restore="${escape(card.id)}" ${busy ? 'disabled' : ''}>Restore</button></div>`).join('')}</details>` : ''}`
  }
  async function run(action: () => Promise<void>) {
    if (busy) return
    busy = true; render()
    try { await action() } catch (error: any) { status = error.message || 'Cleaner failed.' }
    finally { busy = false; render() }
  }
  async function archive() {
    const plan = groups.flatMap(group => {
      const keeper = group.cards.find(card => card.id === keepers.get(group.cards[0].id))!
      return group.cards.filter(card => selected.has(card.id) && eligible(card, keeper))
        .map(card => ({ id: card.id, keeperId: keeper.id, expected: characterFingerprint(card), keeperExpected: characterFingerprint(keeper), reviewed: reviewed.has(card.id) }))
    })
    if (!plan.length || !window.confirm(`Archive ${plan.length} duplicate card(s), including any explicitly reviewed variants?\n\nThey will move to “${ARCHIVE_FOLDER}”. No cards or chats will be deleted. You can restore them here.`)) return
    let count = 0
    try {
      for (const item of plan) {
        // Recheck content, keeper and every primary/group chat immediately before each update.
        const [candidate, keeper, chats] = await Promise.all([
          api(characterPath(item.id)), api(characterPath(item.keeperId)), pagedCharacters(api, '/api/v1/chats')])
        assertArchiveSafe(candidate, keeper, chats, item.expected, item.keeperExpected, item.reviewed)
        await api(characterPath(item.id), { method: 'PUT', body: JSON.stringify({ folder: ARCHIVE_FOLDER,
          extensions: { ...candidate.extensions, [ARCHIVE_KEY]: { originalFolder: candidate.folder || '', keeperId: keeper.id, archivedAt: new Date().toISOString() } } }) })
        count++
      }
      status = `Archived ${count} duplicate card(s). Choose the archive folder in Characters to see them.`
    } catch (error: any) { status = `Archived ${count} card(s); stopped: ${error.message}` }
    await scan()
  }
  const click = (event: Event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button')
    if (!button || busy) return
    if (button.dataset.cleaner === 'scan') void run(async () => { status = 'Scanning…'; render(); await scan(); status = `${cards.length} cards scanned · ${groups.length} duplicate-name groups.` })
    if (button.dataset.cleaner === 'select') {
      groups.forEach(group => { const keeper = group.cards.find(card => card.id === keepers.get(group.cards[0].id))!; group.cards.filter(card => eligible(card, keeper) && characterFingerprint(card) === characterFingerprint(keeper)).forEach(card => selected.add(card.id)) }); render()
    }
    if (button.dataset.cleaner === 'archive') void run(archive)
    if (button.dataset.restore) void run(async () => {
      const card = await api(characterPath(button.dataset.restore!))
      const record = card.extensions?.[ARCHIVE_KEY]
      if (!record) throw new Error('This card is no longer archived. Scan again.')
      if (card.folder !== ARCHIVE_FOLDER) throw new Error('This card was moved elsewhere. Restore its folder manually.')
      const extensions = { ...card.extensions }; delete extensions[ARCHIVE_KEY]
      await api(characterPath(card.id), { method: 'PUT', body: JSON.stringify({ folder: record.originalFolder || '', extensions }) })
      await scan(); status = `Restored ${card.name}.`
    })
  }
  const change = (event: Event) => {
    if (busy) return
    const target = event.target as HTMLInputElement
    if (target.dataset.keeper) { keepers.set(target.dataset.keeper, target.value); selected.clear(); reviewed.clear(); render() }
    if (target.dataset.review) { target.checked ? reviewed.add(target.dataset.review) : reviewed.delete(target.dataset.review); selected.delete(target.dataset.review); render() }
    if (target.dataset.card) { target.checked ? selected.add(target.dataset.card) : selected.delete(target.dataset.card); render() }
  }
  host.addEventListener('click', click); host.addEventListener('change', change); render()
  return () => { disposed = true; host.removeEventListener('click', click); host.removeEventListener('change', change) }
}
