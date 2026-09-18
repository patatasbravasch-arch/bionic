import {
  buildLoreReferences,
  chooseKeeper,
  isUnlinked,
  replaceLoreIds,
  shortLoreId,
  summarizeReferences,
  type LoreBookSnapshot,
} from './lorebook-organizer-core'

type BackendRequest = {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type OrganizerGroup = {
  groupId: string
  name: string
  recommendedKeepId: string
  books: LoreBookSnapshot[]
}

type FolderSuggestion = {
  name: string
  bookIds: string[]
  reason: string
}

type OrganizerOptions = {
  getConnectionId?: () => string
  setConnectionId?: (id: string) => void
}

const CONNECTION_KEY =
  'lumiverse:bionic-style-reading:lore-organizer-connection'

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function stableValue(
  value: any,
  key = ''
): any {
  if (Array.isArray(value)) {
    const mapped =
      value.map(item =>
        stableValue(item)
      )

    if (
      key === 'key' ||
      key === 'keysecondary'
    ) {
      return mapped
        .map(String)
        .sort()
    }

    return mapped
  }

  if (
    value &&
    typeof value === 'object'
  ) {
    const result: Record<string, any> = {}

    for (
      const childKey of
        Object.keys(value).sort()
    ) {
      if (
        [
          'id',
          'uid',
          'world_book_id',
          'created_at',
          'updated_at',
          'revision',
        ].includes(childKey)
      ) {
        continue
      }

      result[childKey] =
        stableValue(
          value[childKey],
          childKey
        )
    }

    return result
  }

  return value
}

function bookSignature(
  book: any,
  entries: any[]
): string {
  const name =
    String(book?.name || '')
      .normalize('NFKC')
      .trim()
      .toLocaleLowerCase()
      .replace(/[\s_-]+/g, ' ')

  return JSON.stringify({
    name,
    entries:
      entries
        .map(entry =>
          JSON.stringify(
            stableValue(entry)
          )
        )
        .sort(),
  })
}

function representativeKeys(
  entries: any[]
): string[] {
  const values: string[] = []

  for (const entry of entries) {
    const candidates = [
      ...(Array.isArray(entry?.key)
        ? entry.key
        : []),
      ...(Array.isArray(
        entry?.keysecondary
      )
        ? entry.keysecondary
        : []),
      entry?.comment,
      entry?.name,
      entry?.title,
    ]

    for (const candidate of candidates) {
      if (
        typeof candidate === 'string' &&
        candidate.trim()
      ) {
        values.push(
          candidate
            .trim()
            .slice(0, 160)
        )
      }
    }

    if (values.length >= 12) break
  }

  return Array.from(
    new Set(values)
  ).slice(0, 12)
}

export function installLorebookOrganizer(
  ctx: any,
  settingsRoot: HTMLElement,
  options: OrganizerOptions = {}
) {
  const pending =
    new Map<string, BackendRequest>()

  let modal: any = null
  let modalRoot: HTMLElement | null = null
  let activeTab =
    'overview'

  let books: LoreBookSnapshot[] = []
  let groups: OrganizerGroup[] = []
  let unlinked: LoreBookSnapshot[] = []
  let referenceSnapshot: any = null
  let lastScanAt: number | null = null
  let busy = false

  let connections: any[] = []
  let suggestions: FolderSuggestion[] = []

  let searchText = ''
  let sortMode = 'name'

  function requestId(prefix: string) {
    return `${prefix}:${Date.now()}:${Math.random()
      .toString(36)
      .slice(2, 9)}`
  }

  function sendBackend(
    type: string,
    payload: Record<string, any> = {},
    timeoutMs = 60000
  ): Promise<any> {
    const id =
      requestId(type)

    return new Promise(
      (resolve, reject) => {
        const timer =
          setTimeout(() => {
            pending.delete(id)
            reject(
              new Error(
                `${type} timed out.`
              )
            )
          }, timeoutMs)

        pending.set(id, {
          resolve,
          reject,
          timer,
        })

        try {
          ctx.sendToBackend({
            type,
            requestId: id,
            ...payload,
          })
        } catch (error: any) {
          clearTimeout(timer)
          pending.delete(id)
          reject(
            error instanceof Error
              ? error
              : new Error(String(error))
          )
        }
      }
    )
  }

  function handleBackendMessage(
    payload: any
  ): boolean {
    const id =
      payload?.requestId

    if (
      typeof id !== 'string' ||
      !pending.has(id)
    ) {
      return false
    }

    const request =
      pending.get(id)!

    pending.delete(id)
    clearTimeout(request.timer)

    if (payload?.error) {
      request.reject(
        new Error(
          String(payload.error)
        )
      )
    } else {
      request.resolve(payload)
    }

    return true
  }

  async function api(
    path: string,
    options: RequestInit = {}
  ): Promise<any> {
    const response =
      await fetch(path, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...options,
        headers: {
          ...(options.body
            ? {
                'Content-Type':
                  'application/json',
              }
            : {}),
          ...(options.headers || {}),
        },
      })

    if (!response.ok) {
      let detail = ''

      try {
        const body =
          await response.json()

        if (body?.error) {
          detail =
            `: ${body.error}`
        }
      } catch {}

      throw new Error(
        `${response.status} ${response.statusText}${detail}`
      )
    }

    if (
      response.status === 204
    ) {
      return null
    }

    return response.json()
  }

  async function paged(
    path: string
  ): Promise<any[]> {
    const all: any[] = []
    let offset = 0

    while (true) {
      const separator =
        path.includes('?')
          ? '&'
          : '?'

      const page =
        await api(
          `${path}${separator}limit=200&offset=${offset}`
        )

      const data =
        Array.isArray(page?.data)
          ? page.data
          : []

      all.push(...data)

      const total =
        Number(
          page?.total ??
          all.length
        )

      if (
        data.length === 0 ||
        all.length >= total
      ) {
        return all
      }

      offset += data.length
    }
  }

  async function loadEntries(
    bookId: string
  ) {
    return paged(
      `/api/v1/world-books/${encodeURIComponent(bookId)}/entries`
    )
  }

  function rebuildGroups() {
    const bySignature =
      new Map<string, LoreBookSnapshot[]>()

    for (const book of books) {
      if (
        !book.entryCount ||
        !book.signature
      ) {
        continue
      }

      const list =
        bySignature.get(
          book.signature
        ) || []

      list.push(book)

      bySignature.set(
        book.signature,
        list
      )
    }

    groups = []

    let number = 0

    for (
      const duplicateBooks of
        bySignature.values()
    ) {
      if (
        duplicateBooks.length < 2
      ) {
        continue
      }

      const keeper =
        chooseKeeper(
          duplicateBooks
        )

      if (!keeper) continue

      number += 1

      groups.push({
        groupId:
          `exact-${number}`,
        name:
          keeper.name ||
          'Unnamed lorebook',
        recommendedKeepId:
          keeper.id,
        books:
          [...duplicateBooks]
            .sort((a, b) =>
              a.name.localeCompare(
                b.name
              )
            ),
      })
    }

    groups.sort((a, b) =>
      a.name.localeCompare(b.name)
    )

    unlinked =
      books
        .filter(isUnlinked)
        .sort((a, b) =>
          a.name.localeCompare(
            b.name
          )
        )
  }

  function applyReferenceSnapshot(
    snapshot: any
  ) {
    referenceSnapshot =
      snapshot

    const refs =
      buildLoreReferences({
        characters:
          snapshot?.characters || [],
        chats:
          snapshot?.chats || [],
        personas:
          snapshot?.personas || [],
        globalIds:
          snapshot?.globalIds || [],
      })

    books =
      books.map(book => ({
        ...book,
        references:
          refs.get(book.id) || [],
      }))

    rebuildGroups()
  }

  async function freshReferences() {
    const result =
      await sendBackend(
        'bionic_lore_reference_snapshot'
      )

    const snapshot =
      result?.snapshot

    if (
      !snapshot ||
      typeof snapshot !== 'object'
    ) {
      throw new Error(
        'Reference snapshot was empty.'
      )
    }

    applyReferenceSnapshot(
      snapshot
    )

    return snapshot
  }

  async function scan() {
    if (busy) return

    busy = true
    renderAll(
      'Scanning lorebook library…'
    )

    try {
      const [
        rawBooks,
        snapshotResult,
      ] =
        await Promise.all([
          paged(
            '/api/v1/world-books'
          ),
          sendBackend(
            'bionic_lore_reference_snapshot'
          ),
        ])

      const snapshot =
        snapshotResult?.snapshot

      if (
        !snapshot ||
        typeof snapshot !== 'object'
      ) {
        throw new Error(
          'Reference snapshot was empty.'
        )
      }

      const refs =
        buildLoreReferences({
          characters:
            snapshot.characters || [],
          chats:
            snapshot.chats || [],
          personas:
            snapshot.personas || [],
          globalIds:
            snapshot.globalIds || [],
        })

      const nextBooks: LoreBookSnapshot[] =
        []

      let completed = 0

      for (const raw of rawBooks) {
        const entries =
          await loadEntries(raw.id)

        completed += 1

        renderAll(
          `Reading lorebooks… ${completed}/${rawBooks.length}`
        )

        nextBooks.push({
          id: raw.id,
          name:
            raw.name ||
            'Unnamed lorebook',
          folder:
            typeof raw.folder ===
              'string'
              ? raw.folder
              : '',
          description:
            typeof raw.description ===
              'string'
              ? raw.description
              : '',
          entryCount:
            entries.length,
          entries:
            representativeKeys(
              entries
            ),
          signature:
            bookSignature(
              raw,
              entries
            ),
          references:
            refs.get(raw.id) || [],
        })
      }

      books = nextBooks
      referenceSnapshot =
        snapshot
      lastScanAt =
        Date.now()

      rebuildGroups()

      renderAll(
        `Scan complete: ${books.length} lorebooks · ${groups.length} duplicate group${groups.length === 1 ? '' : 's'} · ${unlinked.length} unlinked.`
      )
    } catch (error: any) {
      renderAll(
        `Organizer scan failed: ${
          error?.message ||
          String(error)
        }`
      )
    } finally {
      busy = false
      syncSummary()
    }
  }

  function updateLocalRefs(
    snapshot: any
  ) {
    applyReferenceSnapshot(
      snapshot
    )
    renderAll()
    syncSummary()
  }

  async function relinkCharacter(
    character: any,
    duplicateSet: Set<string>,
    keepId: string
  ) {
    const current =
      Array.isArray(
        character.world_book_ids
      )
        ? character.world_book_ids
        : []

    const next =
      replaceLoreIds(
        current,
        duplicateSet,
        keepId
      )

    await api(
      `/api/v1/characters/${encodeURIComponent(character.id)}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          world_book_ids: next,
        }),
      }
    )

    const verified =
      await api(
        `/api/v1/characters/${encodeURIComponent(character.id)}`
      )

    const ids =
      Array.isArray(
        verified?.world_book_ids
      )
        ? verified.world_book_ids
        : Array.isArray(
            verified?.extensions
              ?.world_book_ids
          )
          ? verified.extensions
              .world_book_ids
          : []

    if (
      next.some(
        id => !ids.includes(id)
      ) ||
      ids.some(
        (id: string) =>
          duplicateSet.has(id)
      )
    ) {
      throw new Error(
        `Character ${character.name || character.id} did not verify after relinking.`
      )
    }

    character.world_book_ids =
      [...next]
  }

  async function relinkChat(
    chat: any,
    duplicateSet: Set<string>,
    keepId: string
  ) {
    const current =
      Array.isArray(
        chat?.metadata
          ?.chat_world_book_ids
      )
        ? chat.metadata
            .chat_world_book_ids
        : []

    const next =
      replaceLoreIds(
        current,
        duplicateSet,
        keepId
      )

    const updated =
      await api(
        `/api/v1/chats/${encodeURIComponent(chat.id)}/metadata`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            chat_world_book_ids:
              next,
          }),
        }
      )

    const verified =
      Array.isArray(
        updated?.metadata
          ?.chat_world_book_ids
      )
        ? updated.metadata
            .chat_world_book_ids
        : []

    if (
      next.some(
        id =>
          !verified.includes(id)
      ) ||
      verified.some(
        (id: string) =>
          duplicateSet.has(id)
      )
    ) {
      throw new Error(
        `Chat ${chat.title || chat.id} did not verify after relinking.`
      )
    }

    chat.metadata = {
      ...(chat.metadata || {}),
      chat_world_book_ids:
        [...next],
    }
  }

  async function cleanGroup(
    group: OrganizerGroup
  ) {
    if (busy) return

    const keepId =
      group.recommendedKeepId

    const duplicateIds =
      group.books
        .map(book => book.id)
        .filter(
          id => id !== keepId
        )

    if (
      duplicateIds.length === 0
    ) {
      return
    }

    if (
      !window.confirm(
        `Keep "${group.name}", relink every current character/chat/persona/global reference, then delete ${duplicateIds.length} exact duplicate${duplicateIds.length === 1 ? '' : 's'}?`
      )
    ) {
      return
    }

    busy = true
    renderAll(
      'Refreshing references before cleanup…'
    )

    try {
      const snapshot =
        await freshReferences()

      const duplicateSet =
        new Set(
          duplicateIds
        )

      for (
        const character of
          snapshot.characters || []
      ) {
        const ids =
          character
            .world_book_ids || []

        if (
          ids.some(
            (id: string) =>
              duplicateSet.has(id)
          )
        ) {
          renderAll(
            `Relinking character: ${character.name || character.id}…`
          )

          await relinkCharacter(
            character,
            duplicateSet,
            keepId
          )
        }
      }

      for (
        const chat of
          snapshot.chats || []
      ) {
        const ids =
          chat?.metadata
            ?.chat_world_book_ids ||
          []

        if (
          ids.some(
            (id: string) =>
              duplicateSet.has(id)
          )
        ) {
          renderAll(
            `Relinking chat: ${chat.title || chat.id}…`
          )

          await relinkChat(
            chat,
            duplicateSet,
            keepId
          )
        }
      }

      const personaAssignments =
        (snapshot.personas || [])
          .filter(
            (persona: any) =>
              duplicateSet.has(
                persona
                  .attached_world_book_id
              )
          )
          .map(
            (persona: any) => ({
              id: persona.id,
              bookId: keepId,
            })
          )

      if (
        personaAssignments.length
      ) {
        renderAll(
          `Relinking ${personaAssignments.length} persona reference${personaAssignments.length === 1 ? '' : 's'}…`
        )

        await sendBackend(
          'bionic_lore_relink_personas',
          {
            assignments:
              personaAssignments,
          }
        )
      }

      const currentGlobal =
        Array.isArray(
          snapshot.globalIds
        )
          ? snapshot.globalIds
          : []

      if (
        currentGlobal.some(
          (id: string) =>
            duplicateSet.has(id)
        )
      ) {
        renderAll(
          'Relinking global lorebooks…'
        )

        await sendBackend(
          'bionic_lore_set_global',
          {
            ids:
              replaceLoreIds(
                currentGlobal,
                duplicateSet,
                keepId
              ),
          }
        )
      }

      /*
        Nothing is deleted until every affected source above
        has successfully relinked and verified.
      */
      for (const id of duplicateIds) {
        renderAll(
          `Deleting duplicate ${shortLoreId(id)}…`
        )

        await api(
          `/api/v1/world-books/${encodeURIComponent(id)}`,
          {
            method: 'DELETE',
          }
        )

        books =
          books.filter(
            book =>
              book.id !== id
          )
      }

      const refreshed =
        await sendBackend(
          'bionic_lore_reference_snapshot'
        )

      updateLocalRefs(
        refreshed.snapshot
      )

      renderAll(
        `Cleanup complete. Kept ${group.name}; deleted ${duplicateIds.length} duplicate${duplicateIds.length === 1 ? '' : 's'}.`
      )
    } catch (error: any) {
      renderAll(
        `Cleanup stopped: ${
          error?.message ||
          String(error)
        }`
      )
    } finally {
      busy = false
      syncSummary()
    }
  }

  async function deleteUnlinked(
    book: LoreBookSnapshot
  ) {
    if (busy) return

    if (
      !window.confirm(
        `Delete "${book.name}"?\n\nBionic will refresh all four reference sources first.`
      )
    ) {
      return
    }

    busy = true
    renderAll(
      'Verifying the lorebook is still unlinked…'
    )

    try {
      await freshReferences()

      const current =
        books.find(
          item =>
            item.id === book.id
        )

      if (
        current &&
        current.references.length > 0
      ) {
        throw new Error(
          `${book.name} is now referenced by ${summarizeReferences(current.references)} and was not deleted.`
        )
      }

      await api(
        `/api/v1/world-books/${encodeURIComponent(book.id)}`,
        {
          method: 'DELETE',
        }
      )

      books =
        books.filter(
          item =>
            item.id !== book.id
        )

      rebuildGroups()
      renderAll(
        `Deleted ${book.name}.`
      )
    } catch (error: any) {
      renderAll(
        `Delete stopped: ${
          error?.message ||
          String(error)
        }`
      )
    } finally {
      busy = false
      syncSummary()
    }
  }

  function selectedConnectionId() {
    const external =
      options.getConnectionId?.()

    if (
      typeof external === 'string'
    ) {
      return external
    }

    try {
      return (
        localStorage.getItem(
          CONNECTION_KEY
        ) || ''
      )
    } catch {
      return ''
    }
  }

  function saveConnectionId(
    id: string
  ) {
    options.setConnectionId?.(id)

    try {
      localStorage.setItem(
        CONNECTION_KEY,
        id
      )
    } catch {}
  }

  async function loadConnections() {
    const result =
      await sendBackend(
        'bionic_lore_connections'
      )

    connections =
      Array.isArray(
        result?.connections
      )
        ? result.connections
        : []

    renderAll()
  }

  async function analyzeFolders() {
    if (
      busy ||
      books.length < 2
    ) {
      return
    }

    busy = true
    suggestions = []

    renderAll(
      'AI is analyzing folder groups…'
    )

    try {
      const result =
        await sendBackend(
          'bionic_lore_ai_organize',
          {
            connectionId:
              selectedConnectionId(),
            books:
              books.map(book => ({
                id: book.id,
                name: book.name,
                folder:
                  book.folder || '',
                description:
                  book.description ||
                  '',
                entryCount:
                  book.entryCount,
                sampleKeys:
                  Array.isArray(
                    book.entries
                  )
                    ? book.entries
                    : [],
              })),
          },
          120000
        )

      suggestions =
        Array.isArray(
          result?.folders
        )
          ? result.folders
          : []

      renderAll(
        suggestions.length
          ? `AI suggested ${suggestions.length} folder${suggestions.length === 1 ? '' : 's'}. Nothing has been changed yet.`
          : 'AI returned no useful multi-book folder suggestions.'
      )
    } catch (error: any) {
      renderAll(
        `AI organize failed: ${
          error?.message ||
          String(error)
        }`
      )
    } finally {
      busy = false
    }
  }

  async function applyAssignments(
    assignments: {
      bookId: string
      folder: string
    }[]
  ) {
    if (
      busy ||
      assignments.length === 0
    ) {
      return
    }

    busy = true
    renderAll(
      `Applying ${assignments.length} folder assignment${assignments.length === 1 ? '' : 's'}…`
    )

    try {
      await sendBackend(
        'bionic_lore_apply_folders',
        { assignments }
      )

      const byId =
        new Map(
          assignments.map(item => [
            item.bookId,
            item.folder,
          ])
        )

      books =
        books.map(book => ({
          ...book,
          folder:
            byId.get(book.id) ??
            book.folder,
        }))

      renderAll(
        `Applied ${assignments.length} folder assignment${assignments.length === 1 ? '' : 's'}.`
      )
    } catch (error: any) {
      renderAll(
        `Folder update failed: ${
          error?.message ||
          String(error)
        }`
      )
    } finally {
      busy = false
    }
  }

  /*
    UI/rendering is appended in the next block.
  */

  let statusMessage =
    'Not scanned yet.'

  const removeOrganizerStyle =
    ctx.dom.addStyle(`
      .lb-organizer-summary {
        display: grid;
        gap: 12px;
      }

      .lb-organizer-brand {
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .lb-organizer-logo {
        width: 46px;
        height: 46px;
        flex: 0 0 46px;
        border-radius: 12px;
        overflow: hidden;
      }

      .lb-organizer-brand-copy {
        min-width: 0;
      }

      .lb-organizer-brand-copy strong {
        display: block;
        font-size: 1rem;
      }

      .lb-organizer-brand-copy small {
        display: block;
        margin-top: 2px;
        opacity: .72;
        line-height: 1.35;
      }

      .lb-organizer-summary-stats {
        font-size: .88rem;
        opacity: .78;
      }

      .lb-organizer-shell {
        width: min(1050px, 88vw);
        height: min(76vh, 800px);
        min-height: 500px;
        display: grid;
        grid-template-rows: auto auto auto minmax(0, 1fr);
        gap: 12px;
      }

      .lb-organizer-hero {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
      }

      .lb-organizer-hero-left {
        display: flex;
        align-items: center;
        gap: 12px;
        min-width: 0;
      }

      .lb-organizer-hero-title {
        font-size: 1.05rem;
        font-weight: 700;
      }

      .lb-organizer-hero-sub {
        margin-top: 3px;
        font-size: .82rem;
        opacity: .7;
      }

      .lb-organizer-toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }

      .lb-organizer-toolbar input,
      .lb-organizer-toolbar select {
        min-width: 0;
      }

      .lb-organizer-search {
        flex: 1 1 240px;
      }

      .lb-organizer-sort {
        flex: 0 1 180px;
      }

      .lb-organizer-tabs {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding-bottom: 2px;
      }

      .lb-organizer-tab[aria-selected="true"] {
        font-weight: 700;
        box-shadow: inset 0 -2px currentColor;
      }

      .lb-organizer-status {
        min-height: 1.3em;
        font-size: .83rem;
        opacity: .78;
      }

      .lb-organizer-content {
        min-height: 0;
        overflow-y: auto;
        padding-right: 4px;
      }

      .lb-organizer-grid {
        display: grid;
        grid-template-columns:
          repeat(auto-fit, minmax(190px, 1fr));
        gap: 10px;
        margin-bottom: 14px;
      }

      .lb-organizer-stat,
      .lb-organizer-card {
        border: 1px solid
          color-mix(in srgb, currentColor 18%, transparent);
        border-radius: 12px;
        padding: 12px;
        background:
          color-mix(in srgb, currentColor 3%, transparent);
      }

      .lb-organizer-stat strong {
        display: block;
        font-size: 1.35rem;
      }

      .lb-organizer-stat span {
        display: block;
        margin-top: 3px;
        opacity: .72;
        font-size: .82rem;
      }

      .lb-organizer-list {
        display: grid;
        gap: 9px;
      }

      .lb-organizer-card {
        display: grid;
        gap: 8px;
      }

      .lb-organizer-card-head {
        display: flex;
        gap: 10px;
        justify-content: space-between;
        align-items: start;
      }

      .lb-organizer-card-title {
        min-width: 0;
        font-weight: 700;
        overflow-wrap: anywhere;
      }

      .lb-organizer-id {
        white-space: nowrap;
        font-size: .73rem;
        opacity: .67;
      }

      .lb-organizer-meta {
        font-size: .8rem;
        opacity: .72;
        line-height: 1.45;
      }

      .lb-organizer-badges {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
      }

      .lb-organizer-badge {
        display: inline-flex;
        padding: 3px 7px;
        border-radius: 999px;
        font-size: .72rem;
        border: 1px solid
          color-mix(in srgb, currentColor 18%, transparent);
      }

      .lb-organizer-books {
        display: grid;
        gap: 7px;
      }

      .lb-organizer-book {
        display: grid;
        gap: 4px;
        padding: 8px 10px;
        border-radius: 9px;
        border: 1px solid
          color-mix(in srgb, currentColor 14%, transparent);
      }

      .lb-organizer-book.is-keep {
        border-style: solid;
      }

      .lb-organizer-book.is-duplicate {
        border-style: dashed;
      }

      .lb-organizer-book-role {
        font-size: .67rem;
        letter-spacing: .08em;
        font-weight: 800;
        opacity: .68;
      }

      .lb-organizer-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 7px;
      }

      .lb-organizer-empty {
        padding: 22px;
        text-align: center;
        opacity: .68;
      }

      .lb-organizer-ai-controls {
        display: grid;
        grid-template-columns:
          minmax(180px, 1fr) auto;
        gap: 8px;
        margin-bottom: 12px;
      }

      .lb-organizer-suggestion {
        display: grid;
        gap: 10px;
      }

      .lb-organizer-suggestion-name {
        width: 100%;
      }

      .lb-organizer-checks {
        display: grid;
        gap: 5px;
      }

      .lb-organizer-check {
        display: flex;
        align-items: start;
        gap: 8px;
        font-size: .85rem;
      }

      .lb-organizer-check input {
        margin-top: .2em;
      }

      .lb-organizer-reason {
        font-size: .79rem;
        opacity: .7;
      }

      @media (max-width: 700px) {
        .lb-organizer-shell {
          width: 86vw;
          height: 72vh;
          min-height: 430px;
        }

        .lb-organizer-hero {
          align-items: flex-start;
          flex-direction: column;
        }

        .lb-organizer-ai-controls {
          grid-template-columns: 1fr;
        }
      }
    `)

  function bentoLogo() {
    return `
      <svg
        viewBox="0 0 64 64"
        width="100%"
        height="100%"
        aria-hidden="true"
      >
        <rect
          x="2"
          y="2"
          width="60"
          height="60"
          rx="14"
          fill="currentColor"
          opacity=".12"
        />
        <rect
          x="8"
          y="8"
          width="23"
          height="23"
          rx="7"
          fill="currentColor"
          opacity=".92"
        />
        <rect
          x="34"
          y="8"
          width="22"
          height="14"
          rx="6"
          fill="currentColor"
          opacity=".52"
        />
        <rect
          x="34"
          y="25"
          width="22"
          height="31"
          rx="7"
          fill="currentColor"
          opacity=".82"
        />
        <rect
          x="8"
          y="34"
          width="23"
          height="22"
          rx="7"
          fill="currentColor"
          opacity=".38"
        />
        <path
          d="M15 15h6.8c4.3 0 6.8 2 6.8 5.1 0 2-1.1 3.5-3 4.3 2.4.7 3.7 2.3 3.7 4.7 0 3.5-2.8 5.6-7.4 5.6H15V15Zm6.4 7.5c1.7 0 2.6-.7 2.6-2 0-1.2-.9-1.9-2.6-1.9h-2.1v3.9h2.1Zm.4 8.5c2 0 3-.8 3-2.3 0-1.4-1-2.2-3-2.2h-2.5V31h2.5Z"
          fill="white"
          transform="scale(.72) translate(1 1)"
        />
      </svg>
    `
  }

  function filteredBooks(
    source = books
  ) {
    const needle =
      searchText
        .trim()
        .toLocaleLowerCase()

    let result =
      needle
        ? source.filter(book => {
            const haystack = [
              book.name,
              book.id,
              book.folder || '',
              book.description || '',
              summarizeReferences(
                book.references
              ),
            ]
              .join(' ')
              .toLocaleLowerCase()

            return haystack.includes(
              needle
            )
          })
        : [...source]

    result.sort((a, b) => {
      if (sortMode === 'entries') {
        return (
          b.entryCount -
          a.entryCount
        )
      }

      if (sortMode === 'refs') {
        return (
          b.references.length -
          a.references.length
        )
      }

      if (sortMode === 'folder') {
        return (
          String(
            a.folder || ''
          ).localeCompare(
            String(
              b.folder || ''
            )
          ) ||
          a.name.localeCompare(
            b.name
          )
        )
      }

      return a.name.localeCompare(
        b.name
      )
    })

    return result
  }

  function referenceBadges(
    book: LoreBookSnapshot
  ) {
    const counts =
      new Map<string, number>()

    for (
      const ref of
        book.references
    ) {
      counts.set(
        ref.kind,
        (counts.get(ref.kind) || 0) +
          1
      )
    }

    const parts: string[] = []

    const add = (
      kind: string,
      singular: string
    ) => {
      const count =
        counts.get(kind) || 0

      if (!count) return

      parts.push(`
        <span class="lb-organizer-badge">
          ${count} ${singular}${count === 1 ? '' : 's'}
        </span>
      `)
    }

    add('character', 'character')
    add('chat', 'chat')
    add('persona', 'persona')

    if (
      (counts.get('global') || 0) >
      0
    ) {
      parts.push(`
        <span class="lb-organizer-badge">
          global
        </span>
      `)
    }

    if (!parts.length) {
      parts.push(`
        <span class="lb-organizer-badge">
          unlinked
        </span>
      `)
    }

    return parts.join('')
  }

  function bookCard(
    book: LoreBookSnapshot,
    actions = ''
  ) {
    const folder =
      book.folder
        ? `Folder: ${escapeHtml(book.folder)} · `
        : ''

    return `
      <div class="lb-organizer-card">
        <div class="lb-organizer-card-head">
          <div class="lb-organizer-card-title">
            ${escapeHtml(book.name)}
          </div>

          <code
            class="lb-organizer-id"
            title="${escapeHtml(book.id)}"
          >${escapeHtml(shortLoreId(book.id))}</code>
        </div>

        <div class="lb-organizer-meta">
          ${folder}${book.entryCount} entries
        </div>

        <div class="lb-organizer-badges">
          ${referenceBadges(book)}
        </div>

        ${
          actions
            ? `<div class="lb-organizer-actions">${actions}</div>`
            : ''
        }
      </div>
    `
  }

  function renderOverview() {
    const visible =
      filteredBooks()

    return `
      <div class="lb-organizer-grid">
        <div class="lb-organizer-stat">
          <strong>${books.length}</strong>
          <span>Lorebooks</span>
        </div>

        <div class="lb-organizer-stat">
          <strong>${groups.length}</strong>
          <span>Exact duplicate groups</span>
        </div>

        <div class="lb-organizer-stat">
          <strong>${unlinked.length}</strong>
          <span>Unlinked across all sources</span>
        </div>

        <div class="lb-organizer-stat">
          <strong>${
            books.filter(
              book => book.folder
            ).length
          }</strong>
          <span>Already in folders</span>
        </div>
      </div>

      <div class="lb-organizer-list">
        ${
          visible.length
            ? visible
                .map(book =>
                  bookCard(book)
                )
                .join('')
            : `
              <div class="lb-organizer-empty">
                ${
                  books.length
                    ? 'No lorebooks match this search.'
                    : 'Scan the library to begin.'
                }
              </div>
            `
        }
      </div>
    `
  }

  function renderDuplicates() {
    const needle =
      searchText
        .trim()
        .toLocaleLowerCase()

    const visible =
      groups.filter(group => {
        if (!needle) return true

        return (
          group.name
            .toLocaleLowerCase()
            .includes(needle) ||
          group.books.some(
            book =>
              book.name
                .toLocaleLowerCase()
                .includes(needle) ||
              book.id
                .toLocaleLowerCase()
                .includes(needle)
          )
        )
      })

    if (!visible.length) {
      return `
        <div class="lb-organizer-empty">
          ${
            groups.length
              ? 'No duplicate groups match this search.'
              : 'No exact duplicate groups found.'
          }
        </div>
      `
    }

    return `
      <div class="lb-organizer-list">
        ${visible.map(group => {
          const duplicateCount =
            group.books.filter(
              book =>
                book.id !==
                group.recommendedKeepId
            ).length

          return `
            <div class="lb-organizer-card">
              <div class="lb-organizer-card-head">
                <div class="lb-organizer-card-title">
                  ${escapeHtml(group.name)}
                </div>

                <span class="lb-organizer-badge">
                  ${duplicateCount} duplicate${duplicateCount === 1 ? '' : 's'}
                </span>
              </div>

              <div class="lb-organizer-books">
                ${group.books.map(book => {
                  const keep =
                    book.id ===
                    group.recommendedKeepId

                  return `
                    <div class="lb-organizer-book ${keep ? 'is-keep' : 'is-duplicate'}">
                      <div class="lb-organizer-card-head">
                        <span class="lb-organizer-book-role">
                          ${keep ? 'KEEP' : 'DUPLICATE'}
                        </span>

                        <code
                          class="lb-organizer-id"
                          title="${escapeHtml(book.id)}"
                        >${escapeHtml(shortLoreId(book.id))}</code>
                      </div>

                      <strong>
                        ${escapeHtml(book.name)}
                      </strong>

                      <div class="lb-organizer-meta">
                        ${book.entryCount} entries ·
                        ${escapeHtml(
                          summarizeReferences(
                            book.references
                          )
                        )}
                      </div>
                    </div>
                  `
                }).join('')}
              </div>

              <div class="lb-organizer-meta">
                Every current character, chat, persona and global
                reference is refreshed and relinked before deletion.
              </div>

              <div class="lb-organizer-actions">
                <button
                  type="button"
                  data-organizer-clean-group="${escapeHtml(group.groupId)}"
                  ${busy ? 'disabled' : ''}
                >
                  Relink &amp; delete exact duplicates
                </button>
              </div>
            </div>
          `
        }).join('')}
      </div>
    `
  }

  function renderUnlinked() {
    const visible =
      filteredBooks(unlinked)

    if (!visible.length) {
      return `
        <div class="lb-organizer-empty">
          ${
            unlinked.length
              ? 'No unlinked lorebooks match this search.'
              : books.length
                ? 'No unlinked lorebooks found.'
                : 'Scan the library to begin.'
          }
        </div>
      `
    }

    return `
      <div class="lb-organizer-list">
        ${visible.map(book =>
          bookCard(
            book,
            `
              <button
                type="button"
                data-organizer-delete-unlinked="${escapeHtml(book.id)}"
                ${busy ? 'disabled' : ''}
              >
                Delete unlinked lorebook
              </button>
            `
          )
        ).join('')}
      </div>
    `
  }

  function connectionOptions() {
    const selected =
      selectedConnectionId()

    const found =
      !selected ||
      connections.some(
        connection =>
          connection.id === selected
      )

    const optionsHtml =
      connections
        .map(connection => {
          const details = [
            connection.provider,
            connection.model,
          ]
            .filter(Boolean)
            .join(' · ')

          return `
            <option
              value="${escapeHtml(connection.id)}"
              ${connection.id === selected ? 'selected' : ''}
            >
              ${escapeHtml(connection.name)}${details ? ` — ${escapeHtml(details)}` : ''}
            </option>
          `
        })
        .join('')

    return `
      <option
        value=""
        ${!selected ? 'selected' : ''}
      >
        Active / default connection
      </option>

      ${
        selected && !found
          ? `
            <option
              value="${escapeHtml(selected)}"
              selected
            >
              Saved connection unavailable
            </option>
          `
          : ''
      }

      ${optionsHtml}
    `
  }

  function renderAi() {
    const byId =
      new Map(
        books.map(book => [
          book.id,
          book,
        ])
      )

    return `
      <div class="lb-organizer-ai-controls">
        <select
          id="lb-organizer-connection"
          ${busy ? 'disabled' : ''}
        >
          ${connectionOptions()}
        </select>

        <button
          type="button"
          data-organizer-ai-analyze
          ${busy || books.length < 2 ? 'disabled' : ''}
        >
          Analyze library
        </button>
      </div>

      <div class="lb-organizer-meta" style="margin-bottom:12px">
        The LLM only proposes folder names and membership.
        It cannot delete, merge, rename or rewrite lorebooks.
        Nothing moves until you press Apply.
      </div>

      ${
        suggestions.length
          ? `
            <div class="lb-organizer-actions" style="margin-bottom:12px">
              <button
                type="button"
                data-organizer-apply-all
                ${busy ? 'disabled' : ''}
              >
                Apply all selected suggestions
              </button>
            </div>

            <div class="lb-organizer-list">
              ${suggestions.map((suggestion, index) => `
                <div
                  class="lb-organizer-card lb-organizer-suggestion"
                  data-organizer-suggestion="${index}"
                >
                  <div class="lb-organizer-card-title">
                    Suggested folder
                  </div>

                  <input
                    class="lb-organizer-suggestion-name"
                    type="text"
                    value="${escapeHtml(suggestion.name)}"
                    spellcheck="false"
                    aria-label="Folder name"
                  >

                  <div class="lb-organizer-checks">
                    ${suggestion.bookIds.map(id => {
                      const book =
                        byId.get(id)

                      if (!book) return ''

                      return `
                        <label class="lb-organizer-check">
                          <input
                            type="checkbox"
                            data-organizer-book-id="${escapeHtml(book.id)}"
                            checked
                          >
                          <span>
                            ${escapeHtml(book.name)}
                            <small>
                              · ${escapeHtml(shortLoreId(book.id))}
                            </small>
                          </span>
                        </label>
                      `
                    }).join('')}
                  </div>

                  ${
                    suggestion.reason
                      ? `
                        <div class="lb-organizer-reason">
                          ${escapeHtml(suggestion.reason)}
                        </div>
                      `
                      : ''
                  }

                  <div class="lb-organizer-actions">
                    <button
                      type="button"
                      data-organizer-apply-suggestion="${index}"
                      ${busy ? 'disabled' : ''}
                    >
                      Apply this folder
                    </button>
                  </div>
                </div>
              `).join('')}
            </div>
          `
          : `
            <div class="lb-organizer-empty">
              ${
                books.length
                  ? 'Choose a connection and analyze the library for folder suggestions.'
                  : 'Scan the library before using AI Organize.'
              }
            </div>
          `
      }
    `
  }

  function activeContent() {
    if (
      activeTab ===
      'duplicates'
    ) {
      return renderDuplicates()
    }

    if (
      activeTab ===
      'unlinked'
    ) {
      return renderUnlinked()
    }

    if (
      activeTab ===
      'ai'
    ) {
      return renderAi()
    }

    return renderOverview()
  }

  function renderModal() {
    if (!modalRoot) return

    const lastScan =
      lastScanAt
        ? new Date(
            lastScanAt
          ).toLocaleTimeString(
            [],
            {
              hour: '2-digit',
              minute: '2-digit',
            }
          )
        : 'Never'

    modalRoot.innerHTML = `
      <div class="lb-organizer-shell">
        <div class="lb-organizer-hero">
          <div class="lb-organizer-hero-left">
            <div class="lb-organizer-logo">
              ${bentoLogo()}
            </div>

            <div>
              <div class="lb-organizer-hero-title">
                Bionic Lorebook Organizer
              </div>

              <div class="lb-organizer-hero-sub">
                Last scan: ${escapeHtml(lastScan)}
              </div>
            </div>
          </div>

          <div class="lb-organizer-actions">
            <button
              type="button"
              data-organizer-scan
              ${busy ? 'disabled' : ''}
            >
              ${books.length ? 'Rescan' : 'Scan library'}
            </button>
          </div>
        </div>

        <div class="lb-organizer-toolbar">
          <input
            class="lb-organizer-search"
            id="lb-organizer-search"
            type="search"
            placeholder="Search lorebooks, folders, IDs or references"
            value="${escapeHtml(searchText)}"
          >

          <select
            class="lb-organizer-sort"
            id="lb-organizer-sort"
          >
            <option value="name" ${sortMode === 'name' ? 'selected' : ''}>
              Sort: name
            </option>
            <option value="folder" ${sortMode === 'folder' ? 'selected' : ''}>
              Sort: folder
            </option>
            <option value="entries" ${sortMode === 'entries' ? 'selected' : ''}>
              Sort: entry count
            </option>
            <option value="refs" ${sortMode === 'refs' ? 'selected' : ''}>
              Sort: reference count
            </option>
          </select>
        </div>

        <div>
          <div class="lb-organizer-tabs">
            ${[
              ['overview', 'Overview'],
              ['duplicates', 'Exact Duplicates'],
              ['unlinked', 'Unlinked'],
              ['ai', 'AI Organize'],
            ].map(([key, label]) => `
              <button
                type="button"
                class="lb-organizer-tab"
                data-organizer-tab="${key}"
                aria-selected="${String(activeTab === key)}"
              >
                ${label}
                ${
                  key === 'duplicates' && groups.length
                    ? ` (${groups.length})`
                    : key === 'unlinked' && unlinked.length
                      ? ` (${unlinked.length})`
                      : ''
                }
              </button>
            `).join('')}
          </div>

          <div class="lb-organizer-status">
            ${escapeHtml(statusMessage)}
          </div>
        </div>

        <div class="lb-organizer-content">
          ${activeContent()}
        </div>
      </div>
    `
  }

  function syncSummary() {
    const summary =
      settingsRoot.querySelector(
        '#lb-lore-organizer-summary'
      )

    const scanButton =
      settingsRoot.querySelector(
        '#lb-lore-organizer-rescan'
      ) as HTMLButtonElement | null

    if (summary) {
      if (!lastScanAt) {
        summary.textContent =
          'Not scanned yet.'
      } else {
        summary.textContent =
          `${books.length} lorebooks · ${groups.length} duplicate group${groups.length === 1 ? '' : 's'} · ${unlinked.length} unlinked`
      }
    }

    if (scanButton) {
      scanButton.textContent =
        books.length
          ? 'Rescan'
          : 'Scan'
      scanButton.disabled =
        busy
    }
  }

  function renderAll(
    message?: string
  ) {
    if (
      typeof message === 'string'
    ) {
      statusMessage = message
    }

    renderModal()
    syncSummary()
  }

  function suggestionAssignments(
    card: HTMLElement
  ) {
    const nameInput =
      card.querySelector(
        '.lb-organizer-suggestion-name'
      ) as HTMLInputElement | null

    const folder =
      nameInput?.value.trim() || ''

    if (!folder) {
      throw new Error(
        'Folder name cannot be empty.'
      )
    }

    const assignments =
      Array.from(
        card.querySelectorAll(
          '[data-organizer-book-id]'
        )
      )
        .filter(
          input =>
            (
              input as HTMLInputElement
            ).checked
        )
        .map(input => ({
          bookId:
            (
              input as HTMLInputElement
            ).dataset
              .organizerBookId || '',
          folder,
        }))
        .filter(
          item => item.bookId
        )

    return assignments
  }

  async function openOrganizer() {
    if (modal) return

    modal =
      ctx.ui.showModal({
        title:
          'Lorebook Organizer',
        width: 1100,
        maxHeight: 900,
        persistent: false,
      })

    modalRoot =
      modal.root

    renderAll()

    modalRoot.addEventListener(
      'click',
      event => {
        const target =
          event.target as HTMLElement

        const tabButton =
          target.closest(
            '[data-organizer-tab]'
          ) as HTMLElement | null

        if (tabButton) {
          activeTab =
            tabButton.dataset
              .organizerTab ||
            'overview'

          renderAll()
          return
        }

        if (
          target.closest(
            '[data-organizer-scan]'
          )
        ) {
          void scan()
          return
        }

        const cleanButton =
          target.closest(
            '[data-organizer-clean-group]'
          ) as HTMLElement | null

        if (cleanButton) {
          const group =
            groups.find(
              item =>
                item.groupId ===
                cleanButton.dataset
                  .organizerCleanGroup
            )

          if (group) {
            void cleanGroup(group)
          }

          return
        }

        const deleteButton =
          target.closest(
            '[data-organizer-delete-unlinked]'
          ) as HTMLElement | null

        if (deleteButton) {
          const book =
            books.find(
              item =>
                item.id ===
                deleteButton.dataset
                  .organizerDeleteUnlinked
            )

          if (book) {
            void deleteUnlinked(
              book
            )
          }

          return
        }

        if (
          target.closest(
            '[data-organizer-ai-analyze]'
          )
        ) {
          void analyzeFolders()
          return
        }

        const applyOne =
          target.closest(
            '[data-organizer-apply-suggestion]'
          ) as HTMLElement | null

        if (applyOne) {
          const card =
            applyOne.closest(
              '[data-organizer-suggestion]'
            ) as HTMLElement | null

          if (!card) return

          try {
            const assignments =
              suggestionAssignments(
                card
              )

            void applyAssignments(
              assignments
            )
          } catch (error: any) {
            renderAll(
              error?.message ||
              String(error)
            )
          }

          return
        }

        if (
          target.closest(
            '[data-organizer-apply-all]'
          )
        ) {
          try {
            const assignments =
              Array.from(
                modalRoot!.querySelectorAll(
                  '[data-organizer-suggestion]'
                )
              )
                .flatMap(card =>
                  suggestionAssignments(
                    card as HTMLElement
                  )
                )

            void applyAssignments(
              assignments
            )
          } catch (error: any) {
            renderAll(
              error?.message ||
              String(error)
            )
          }
        }
      }
    )

    modalRoot.addEventListener(
      'input',
      event => {
        const target =
          event.target as HTMLInputElement

        if (
          target.id ===
          'lb-organizer-search'
        ) {
          searchText =
            target.value

          /*
            Avoid replacing the focused search box on each keystroke.
            Only rerender the scrollable content.
          */
          const content =
            modalRoot?.querySelector(
              '.lb-organizer-content'
            )

          if (content) {
            content.innerHTML =
              activeContent()
          }
        }
      }
    )

    modalRoot.addEventListener(
      'change',
      event => {
        const target =
          event.target as HTMLSelectElement

        if (
          target.id ===
          'lb-organizer-sort'
        ) {
          sortMode =
            target.value

          renderAll()
          return
        }

        if (
          target.id ===
          'lb-organizer-connection'
        ) {
          saveConnectionId(
            target.value
          )
        }
      }
    )

    modal.onDismiss(() => {
      modal = null
      modalRoot = null
    })

    if (
      connections.length === 0
    ) {
      try {
        await loadConnections()
      } catch (error: any) {
        renderAll(
          `Could not load LLM connections: ${
            error?.message ||
            String(error)
          }`
        )
      }
    }
  }

  const openButton =
    settingsRoot.querySelector(
      '#lb-lore-organizer-open'
    )

  const rescanButton =
    settingsRoot.querySelector(
      '#lb-lore-organizer-rescan'
    )

  const openHandler = () => {
    void openOrganizer()
  }

  const rescanHandler = () => {
    void scan()
  }

  openButton?.addEventListener(
    'click',
    openHandler
  )

  rescanButton?.addEventListener(
    'click',
    rescanHandler
  )

  const unsubscribeBackend =
    ctx.onBackendMessage(
      (payload: any) => {
        handleBackendMessage(
          payload
        )
      }
    )

  syncSummary()

  return () => {
    openButton?.removeEventListener(
      'click',
      openHandler
    )

    rescanButton?.removeEventListener(
      'click',
      rescanHandler
    )

    for (
      const request of
        pending.values()
    ) {
      clearTimeout(
        request.timer
      )
      request.reject(
        new Error(
          'Lorebook Organizer unloaded.'
        )
      )
    }

    pending.clear()

    if (
      typeof unsubscribeBackend ===
      'function'
    ) {
      unsubscribeBackend()
    }

    removeOrganizerStyle?.()
  }
}
