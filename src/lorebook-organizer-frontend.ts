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

const IGNORED_FOLDER =
  'Bionic — Ignored'

const AI_BATCH_SIZE = 70

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

function duplicateNameKey(
  value: unknown
): string {
  let name =
    String(value ?? '')
      .normalize('NFKC')
      .trim()
      .toLocaleLowerCase()
      .replace(/[\s_-]+/g, ' ')

  let previous = ''

  while (name !== previous) {
    previous = name

    name = name
      .replace(
        /\s+(?:\(\d+\)|copy(?:\s+\d+)?|duplicate(?:\s+\d+)?)$/i,
        ''
      )
      .trim()
  }

  return name
}

function bookSignature(
  book: any,
  entries: any[]
): string {
  const name =
    duplicateNameKey(
      book?.name
    )

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
  let ignored: LoreBookSnapshot[] = []
  let referenceSnapshot: any = null

  const selectedUnlinked =
    new Set<string>()

  /*
    Overview selection is deliberately independent from the
    Unlinked selection.

    Overview may contain referenced lorebooks, whereas
    selectedUnlinked is safety-pruned to zero-reference books.
  */
  const selectedOverview =
    new Set<string>()

  let overviewFolderPanelOpen =
    false

  let overviewFolderTargetName =
    ''


  let showIgnored = false
  let linkPanelOpen = false
  let folderPanelOpen = false
  let folderTargetName = ''
  let linkTargetKind =
    'character'
  let linkTargetId = ''
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

    const zeroReferenceBooks =
      books.filter(isUnlinked)

    ignored =
      zeroReferenceBooks
        .filter(
          book =>
            String(
              book.folder || ''
            ).trim() ===
            IGNORED_FOLDER
        )
        .sort((a, b) =>
          a.name.localeCompare(
            b.name
          )
        )

    unlinked =
      zeroReferenceBooks
        .filter(
          book =>
            String(
              book.folder || ''
            ).trim() !==
            IGNORED_FOLDER
        )
        .sort((a, b) =>
          a.name.localeCompare(
            b.name
          )
        )

    const validSelection =
      new Set(
        zeroReferenceBooks.map(
          book => book.id
        )
      )

    for (
      const id of
        selectedUnlinked
    ) {
      if (
        !validSelection.has(id)
      ) {
        selectedUnlinked.delete(id)
      }
    }


    const validOverviewSelection =
      new Set(
        books.map(
          book => book.id
        )
      )

    for (
      const id of
        selectedOverview
    ) {
      if (
        !validOverviewSelection.has(
          id
        )
      ) {
        selectedOverview.delete(
          id
        )
      }
    }
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

        await api(
          '/api/v1/personas/bulk-update',
          {
            method: 'POST',
            body: JSON.stringify({
              ids:
                personaAssignments.map(
                  item => item.id
                ),
              attached_world_book_id:
                keepId,
            }),
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
        Re-read every reference source after relinking and immediately
        before deletion. Fail closed if any duplicate is still referenced.
      */
      renderAll(
        'Verifying duplicate references before deletion…'
      )

      const verification =
        await sendBackend(
          'bionic_lore_reference_snapshot'
        )

      if (
        !verification?.snapshot ||
        typeof verification.snapshot !== 'object'
      ) {
        throw new Error(
          'Final reference verification returned no snapshot.'
        )
      }

      applyReferenceSnapshot(
        verification.snapshot
      )

      const stillReferenced =
        books.filter(
          book =>
            duplicateSet.has(book.id) &&
            book.references.length > 0
        )

      if (stillReferenced.length) {
        const detail =
          stillReferenced
            .map(
              book =>
                `${book.name}: ${summarizeReferences(book.references)}`
            )
            .join('; ')

        throw new Error(
          `Duplicate deletion was stopped because references still remain: ${detail}`
        )
      }

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

  let connectionsLoaded = false

  function rawSelectedConnectionId() {
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

  function selectedConnectionId() {
    const selected =
      rawSelectedConnectionId()

    if (
      !selected ||
      !connectionsLoaded
    ) {
      return selected
    }

    const available =
      connections.some(
        connection =>
          connection?.id === selected
      )

    if (available) {
      return selected
    }

    /*
      Saved connection disappeared.
      Fall back to Lumiverse's active/default connection.
    */
    saveConnectionId('')

    return ''
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

    connectionsLoaded = true

    /*
      Normalize a persisted connection that no longer exists.
    */
    selectedConnectionId()

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

    try {
      const compactBooks =
        books.map(book => ({
          id: book.id,
          name: book.name,
          folder:
            book.folder || '',
          description:
            book.description || '',
          entryCount:
            book.entryCount,
          sampleKeys:
            Array.isArray(
              book.entries
            )
              ? book.entries
              : [],
        }))

      const connectionId =
        selectedConnectionId()

      const batchCount =
        Math.ceil(
          compactBooks.length /
          AI_BATCH_SIZE
        )

      const merged =
        new Map<
          string,
          FolderSuggestion
        >()

      for (
        let offset = 0;
        offset < compactBooks.length;
        offset += AI_BATCH_SIZE
      ) {
        const batch =
          compactBooks.slice(
            offset,
            offset +
              AI_BATCH_SIZE
          )

        const batchNumber =
          Math.floor(
            offset /
              AI_BATCH_SIZE
          ) + 1

        const first =
          offset + 1

        const last =
          Math.min(
            offset +
              batch.length,
            compactBooks.length
          )

        renderAll(
          `AI is analyzing folder groups… ${first}–${last} of ${compactBooks.length} · batch ${batchNumber}/${batchCount}`
        )

        const result =
          await sendBackend(
            'bionic_lore_ai_organize',
            {
              connectionId,
              books: batch,
            },
            120000
          )

        const batchFolders =
          Array.isArray(
            result?.folders
          )
            ? result.folders
            : []

        const batchIds =
          new Set(
            batch.map(
              book => book.id
            )
          )

        for (
          const folder of
            batchFolders
        ) {
          const name =
            String(
              folder?.name || ''
            ).trim()

          if (!name) continue

          const bookIds =
            Array.from(
              new Set(
                Array.isArray(
                  folder?.bookIds
                )
                  ? folder.bookIds
                      .filter(
                        (id: unknown):
                          id is string =>
                            typeof id ===
                              'string' &&
                            batchIds.has(id)
                      )
                  : []
              )
            )

          if (
            bookIds.length < 2
          ) {
            continue
          }

          const reason =
            String(
              folder?.reason || ''
            ).trim()

          const key =
            name
              .normalize('NFKC')
              .toLocaleLowerCase()

          const existing =
            merged.get(key)

          if (existing) {
            existing.bookIds =
              Array.from(
                new Set([
                  ...existing.bookIds,
                  ...bookIds,
                ])
              )

            if (
              !existing.reason &&
              reason
            ) {
              existing.reason =
                reason
            }

            continue
          }

          merged.set(
            key,
            {
              name,
              bookIds,
              reason,
            }
          )
        }
      }

      suggestions =
        Array.from(
          merged.values()
        )
          .filter(
            suggestion =>
              suggestion.bookIds.length >= 2
          )
          .sort(
            (a, b) =>
              a.name.localeCompare(
                b.name
              )
          )

      renderAll(
        suggestions.length
          ? `AI suggested ${suggestions.length} folder${suggestions.length === 1 ? '' : 's'} across ${batchCount} batch${batchCount === 1 ? '' : 'es'}. Nothing has been changed yet.`
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
  ): Promise<boolean> {
    if (
      busy ||
      assignments.length === 0
    ) {
      return false
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

      rebuildGroups()

      renderAll(
        `Applied ${assignments.length} folder assignment${assignments.length === 1 ? '' : 's'}.`
      )

      return true
    } catch (error: any) {
      renderAll(
        `Folder update failed: ${
          error?.message ||
          String(error)
        }`
      )

      return false
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


      .lb-organizer-buttonlike,
      .lb-organizer-actions button,
      .lb-organizer-toolbar button,
      .lb-organizer-card button,
      .lb-organizer-list button {
        appearance: none;
        -webkit-appearance: none;
        border: 1px solid rgba(255, 255, 255, 0.18);
        background: rgba(255, 255, 255, 0.06);
        color: inherit;
        border-radius: 10px;
        padding: 8px 12px;
        min-height: 34px;
        line-height: 1.2;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
        transition:
          background 120ms ease,
          border-color 120ms ease,
          transform 80ms ease,
          box-shadow 120ms ease;
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.02);
      }

      .lb-organizer-buttonlike:hover,
      .lb-organizer-actions button:hover,
      .lb-organizer-toolbar button:hover,
      .lb-organizer-card button:hover,
      .lb-organizer-list button:hover {
        background: rgba(255, 255, 255, 0.11);
        border-color: rgba(255, 255, 255, 0.28);
      }

      .lb-organizer-buttonlike:active,
      .lb-organizer-actions button:active,
      .lb-organizer-toolbar button:active,
      .lb-organizer-card button:active,
      .lb-organizer-list button:active {
        transform: translateY(1px);
        background: rgba(255, 255, 255, 0.14);
      }

      .lb-organizer-buttonlike:focus-visible,
      .lb-organizer-actions button:focus-visible,
      .lb-organizer-toolbar button:focus-visible,
      .lb-organizer-card button:focus-visible,
      .lb-organizer-list button:focus-visible {
        outline: none;
        border-color: rgba(120, 170, 255, 0.75);
        box-shadow:
          0 0 0 2px rgba(120, 170, 255, 0.20),
          inset 0 0 0 1px rgba(255,255,255,0.02);
      }

      .lb-organizer-buttonlike[disabled],
      .lb-organizer-actions button[disabled],
      .lb-organizer-toolbar button[disabled],
      .lb-organizer-card button[disabled],
      .lb-organizer-list button[disabled] {
        opacity: 0.5;
        cursor: not-allowed;
        background: rgba(255, 255, 255, 0.03);
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

  function selectedOverviewBooks() {
    return books.filter(
      book =>
        selectedOverview.has(
          book.id
        )
    )
  }

  async function moveSelectedOverviewToFolder() {
    if (busy) return

    const selected =
      selectedOverviewBooks()

    if (!selected.length) {
      return
    }

    const folder =
      overviewFolderTargetName.trim()

    if (!folder) {
      renderAll(
        'Enter a folder name first.'
      )
      return
    }

    const applied =
      await applyAssignments(
        selected.map(book => ({
          bookId: book.id,
          folder,
        }))
      )

    if (!applied) {
      return
    }

    selectedOverview.clear()

    overviewFolderPanelOpen =
      false

    overviewFolderTargetName =
      ''

    renderAll(
      `Moved ${selected.length} lorebook${selected.length === 1 ? '' : 's'} to "${folder}".`
    )
  }

  function renderOverview() {
    const visible =
      filteredBooks()

    const selected =
      selectedOverviewBooks()

    const folders =
      existingFolderNames()

    const allVisibleSelected =
      visible.length > 0 &&
      visible.every(
        book =>
          selectedOverview.has(
            book.id
          )
      )

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

      <div
        class="lb-organizer-card"
        style="margin-bottom:10px"
      >
        <div class="lb-organizer-card-head">
          <div>
            <div class="lb-organizer-card-title">
              Library selection
            </div>

            <div class="lb-organizer-meta">
              ${selected.length} selected ·
              foldering does not change character, chat,
              persona or global links
            </div>
          </div>
        </div>

        <div class="lb-organizer-actions">
          <button
            type="button"
            data-organizer-overview-select-visible
            ${visible.length ? '' : 'disabled'}
          >
            ${
              allVisibleSelected
                ? 'Unselect visible'
                : 'Select visible'
            }
          </button>

          <button
            type="button"
            data-organizer-overview-clear
            ${selected.length ? '' : 'disabled'}
          >
            Clear selection
          </button>

          <button
            type="button"
            data-organizer-overview-open-folder
            ${selected.length ? '' : 'disabled'}
          >
            Move selected to folder…
          </button>
        </div>
      </div>

      ${
        overviewFolderPanelOpen
          ? `
            <div
              class="lb-organizer-card"
              style="margin-bottom:10px"
            >
              <div class="lb-organizer-card-title">
                Move ${selected.length} selected lorebook${selected.length === 1 ? '' : 's'} to folder
              </div>

              <div class="lb-organizer-meta">
                Choose an existing folder or type a new
                name to create/use it immediately.
              </div>

              <div class="lb-organizer-toolbar">
                <input
                  id="lb-organizer-overview-folder-target"
                  type="text"
                  list="lb-organizer-overview-folder-options"
                  value="${escapeHtml(overviewFolderTargetName)}"
                  placeholder="Existing or new folder name…"
                  autocomplete="off"
                  ${busy ? 'disabled' : ''}
                >

                <datalist
                  id="lb-organizer-overview-folder-options"
                >
                  ${folders.map(
                    folder =>
                      `<option value="${escapeHtml(folder)}"></option>`
                  ).join('')}
                </datalist>

                <button
                  type="button"
                  data-organizer-overview-folder-apply
                  ${busy ? 'disabled' : ''}
                >
                  Move selected
                </button>

                <button
                  type="button"
                  data-organizer-overview-folder-cancel
                >
                  Cancel
                </button>
              </div>
            </div>
          `
          : ''
      }

      <div class="lb-organizer-list">
        ${
          visible.length
            ? visible
                .map(book =>
                  bookCard(
                    book,
                    `
                      <label class="lb-organizer-check">
                        <input
                          type="checkbox"
                          data-organizer-select-overview="${escapeHtml(book.id)}"
                          ${selectedOverview.has(book.id) ? 'checked' : ''}
                          ${busy ? 'disabled' : ''}
                        >
                        <span>Select</span>
                      </label>
                    `
                  )
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

  function visibleUnlinkedBooks() {
    const source =
      showIgnored
        ? [...unlinked, ...ignored]
        : [...unlinked]

    return filteredBooks(source)
  }

  function selectedUnlinkedBooks() {
    return books.filter(
      book =>
        selectedUnlinked.has(
          book.id
        ) &&
        isUnlinked(book)
    )
  }

  function existingFolderNames() {
    return Array.from(
      new Set(
        books
          .map(book =>
            String(
              book.folder || ''
            ).trim()
          )
          .filter(
            folder =>
              folder &&
              folder !==
                IGNORED_FOLDER
          )
      )
    ).sort(
      (a, b) =>
        a.localeCompare(b)
    )
  }

  function characterMatchKey(
    value: unknown
  ): string {
    let name =
      String(value ?? '')
        .normalize('NFKD')
        .replace(
          /[\u0300-\u036f]/g,
          ''
        )
        .toLocaleLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[_\-.]+/g, ' ')
        .replace(/[’']/g, "'")
        .replace(/\s+/g, ' ')
        .trim()

    let previous = ''

    while (name !== previous) {
      previous = name

      name = name
        .replace(
          /\s+(?:\(\d+\)|copy(?:\s+\d+)?|duplicate(?:\s+\d+)?)$/i,
          ''
        )
        .replace(
          /\s+(?:lore\s*book|lorebook|world\s*book|worldbook|world\s*info|worldinfo)$/i,
          ''
        )
        .replace(
          /\s+(?:silly\s*tavern|sillytavern)$/i,
          ''
        )
        .replace(
          /\s+(?:nsfw|sfw)$/i,
          ''
        )
        .replace(
          /\s+v\d+(?:\.\d+)*$/i,
          ''
        )
        .trim()
    }

    return name
      .replace(
        /['’]s$/i,
        ''
      )
      .replace(
        /[^\p{L}\p{N}]+/gu,
        ' '
      )
      .replace(/\s+/g, ' ')
      .trim()
  }

  function suggestedCharacter(
    book: LoreBookSnapshot
  ) {
    const key =
      characterMatchKey(
        book.name
      )

    if (key.length < 2) {
      return null
    }

    const matches =
      (
        referenceSnapshot
          ?.characters || []
      )
        .filter(
          (character: any) =>
            typeof character?.id ===
              'string' &&
            characterMatchKey(
              character?.name
            ) === key
        )

    if (matches.length !== 1) {
      return null
    }

    return {
      id: matches[0].id,
      name:
        matches[0].name ||
        'Unnamed character',
    }
  }

  function linkTargets() {
    if (
      linkTargetKind ===
      'character'
    ) {
      return (
        referenceSnapshot
          ?.characters || []
      )
        .map((item: any) => ({
          id: item.id,
          name:
            item.name ||
            'Unnamed character',
        }))
        .sort(
          (a: any, b: any) =>
            a.name.localeCompare(
              b.name
            )
        )
    }

    if (
      linkTargetKind ===
      'chat'
    ) {
      return (
        referenceSnapshot
          ?.chats || []
      )
        .map((item: any) => ({
          id: item.id,
          name:
            item.title ||
            item.name ||
            'Unnamed chat',
        }))
        .sort(
          (a: any, b: any) =>
            a.name.localeCompare(
              b.name
            )
        )
    }

    if (
      linkTargetKind ===
      'persona'
    ) {
      return (
        referenceSnapshot
          ?.personas || []
      )
        .map((item: any) => ({
          id: item.id,
          name:
            item.name ||
            'Unnamed persona',
        }))
        .sort(
          (a: any, b: any) =>
            a.name.localeCompare(
              b.name
            )
        )
    }

    return []
  }

  async function ignoreSelectedBooks() {
    const selected =
      selectedUnlinkedBooks()

    if (!selected.length) return

    const applied =
      await applyAssignments(
        selected.map(book => ({
          bookId: book.id,
          folder: IGNORED_FOLDER,
        }))
      )

    if (!applied) return

    selectedUnlinked.clear()

    renderAll(
      `Ignored ${selected.length} lorebook${selected.length === 1 ? '' : 's'} in "${IGNORED_FOLDER}".`
    )
  }

  async function restoreSelectedBooks() {
    const selected =
      selectedUnlinkedBooks()
        .filter(
          book =>
            String(
              book.folder || ''
            ).trim() ===
            IGNORED_FOLDER
        )

    if (!selected.length) return

    const applied =
      await applyAssignments(
        selected.map(book => ({
          bookId: book.id,
          folder: '',
        }))
      )

    if (!applied) return

    selectedUnlinked.clear()

    renderAll(
      `Restored ${selected.length} ignored lorebook${selected.length === 1 ? '' : 's'}.`
    )
  }

  async function moveSelectedBooksToFolder() {
    const selected =
      selectedUnlinkedBooks()

    if (!selected.length) {
      return
    }

    const folder =
      folderTargetName.trim()

    if (!folder) {
      renderAll(
        'Enter a folder name first.'
      )
      return
    }

    const applied =
      await applyAssignments(
        selected.map(book => ({
          bookId: book.id,
          folder,
        }))
      )

    if (!applied) return

    selectedUnlinked.clear()
    folderPanelOpen = false
    folderTargetName = ''

    renderAll(
      `Moved ${selected.length} lorebook${selected.length === 1 ? '' : 's'} to "${folder}".`
    )
  }

  async function deleteSelectedBooks() {
    if (busy) return

    const selected =
      selectedUnlinkedBooks()

    if (!selected.length) return

    if (
      !window.confirm(
        `Delete ${selected.length} selected unlinked lorebook${selected.length === 1 ? '' : 's'}?\n\nBionic will refresh characters, chats, personas and global activation immediately before deletion.`
      )
    ) {
      return
    }

    busy = true

    renderAll(
      'Verifying selected lorebooks are still unlinked…'
    )

    try {
      await freshReferences()

      const selectedIds =
        new Set(
          selected.map(
            book => book.id
          )
        )

      const nowReferenced =
        books.filter(
          book =>
            selectedIds.has(
              book.id
            ) &&
            book.references.length > 0
        )

      if (nowReferenced.length) {
        throw new Error(
          `Deletion stopped because ${nowReferenced.length} selected lorebook${nowReferenced.length === 1 ? '' : 's'} gained a reference.`
        )
      }

      let deleted = 0

      for (const book of selected) {
        renderAll(
          `Deleting ${book.name}…`
        )

        await api(
          `/api/v1/world-books/${encodeURIComponent(book.id)}`,
          {
            method: 'DELETE',
          }
        )

        books =
          books.filter(
            item =>
              item.id !==
              book.id
          )

        selectedUnlinked.delete(
          book.id
        )

        deleted += 1
      }

      rebuildGroups()

      renderAll(
        `Deleted ${deleted} unlinked lorebook${deleted === 1 ? '' : 's'}.`
      )
    } catch (error: any) {
      renderAll(
        `Bulk delete stopped: ${
          error?.message ||
          String(error)
        }`
      )
    } finally {
      busy = false
      syncSummary()
    }
  }

  async function linkSelectedBooks() {
    if (busy) return

    const selected =
      selectedUnlinkedBooks()

    if (!selected.length) return

    if (
      linkTargetKind ===
        'persona' &&
      selected.length !== 1
    ) {
      renderAll(
        'A persona can attach only one lorebook. Select exactly one lorebook for a persona target.'
      )
      return
    }

    if (
      linkTargetKind !==
        'global' &&
      !linkTargetId
    ) {
      renderAll(
        'Choose a link target first.'
      )
      return
    }

    busy = true

    renderAll(
      'Refreshing references before linking…'
    )

    try {
      const snapshot =
        await freshReferences()

      const selectedIds =
        selected.map(
          book => book.id
        )

      if (
        linkTargetKind ===
        'character'
      ) {
        const target =
          (snapshot.characters || [])
            .find(
              (item: any) =>
                item.id ===
                linkTargetId
            )

        if (!target) {
          throw new Error(
            'Character target no longer exists.'
          )
        }

        const next =
          Array.from(
            new Set([
              ...(target
                .world_book_ids ||
                []),
              ...selectedIds,
            ])
          )

        await api(
          `/api/v1/characters/${encodeURIComponent(target.id)}`,
          {
            method: 'PUT',
            body: JSON.stringify({
              world_book_ids:
                next,
            }),
          }
        )

        const verified =
          await api(
            `/api/v1/characters/${encodeURIComponent(target.id)}`
          )

        const verifiedIds =
          Array.isArray(
            verified
              ?.world_book_ids
          )
            ? verified
                .world_book_ids
            : Array.isArray(
                verified
                  ?.extensions
                  ?.world_book_ids
              )
              ? verified
                  .extensions
                  .world_book_ids
              : []

        for (
          const id of
            selectedIds
        ) {
          if (
            !verifiedIds.includes(
              id
            )
          ) {
            throw new Error(
              `Character link verification failed for ${shortLoreId(id)}.`
            )
          }
        }
      } else if (
        linkTargetKind ===
        'chat'
      ) {
        const target =
          (snapshot.chats || [])
            .find(
              (item: any) =>
                item.id ===
                linkTargetId
            )

        if (!target) {
          throw new Error(
            'Chat target no longer exists.'
          )
        }

        const current =
          Array.isArray(
            target?.metadata
              ?.chat_world_book_ids
          )
            ? target.metadata
                .chat_world_book_ids
            : []

        const next =
          Array.from(
            new Set([
              ...current,
              ...selectedIds,
            ])
          )

        const updated =
          await api(
            `/api/v1/chats/${encodeURIComponent(target.id)}/metadata`,
            {
              method: 'PATCH',
              body:
                JSON.stringify({
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

        for (
          const id of
            selectedIds
        ) {
          if (
            !verified.includes(id)
          ) {
            throw new Error(
              `Chat link verification failed for ${shortLoreId(id)}.`
            )
          }
        }
      } else if (
        linkTargetKind ===
        'persona'
      ) {
        const target =
          (snapshot.personas || [])
            .find(
              (item: any) =>
                item.id ===
                linkTargetId
            )

        if (!target) {
          throw new Error(
            'Persona target no longer exists.'
          )
        }

        const personaResult =
          await api(
            '/api/v1/personas/bulk-update',
            {
              method: 'POST',
              body:
                JSON.stringify({
                  ids: [
                    target.id,
                  ],
                  attached_world_book_id:
                    selectedIds[0],
                }),
            }
          )

        if (
          !Array.isArray(
            personaResult?.updated
          ) ||
          personaResult.updated.length !==
            1
        ) {
          throw new Error(
            'Persona link did not verify.'
          )
        }
      } else if (
        linkTargetKind ===
        'global'
      ) {
        const current =
          Array.isArray(
            snapshot.globalIds
          )
            ? snapshot.globalIds
            : []

        await sendBackend(
          'bionic_lore_set_global',
          {
            ids:
              Array.from(
                new Set([
                  ...current,
                  ...selectedIds,
                ])
              ),
          }
        )
      } else {
        throw new Error(
          'Unknown link target type.'
        )
      }

      const refreshed =
        await sendBackend(
          'bionic_lore_reference_snapshot'
        )

      updateLocalRefs(
        refreshed.snapshot
      )

      selectedUnlinked.clear()
      linkPanelOpen = false

      renderAll(
        `Linked ${selected.length} lorebook${selected.length === 1 ? '' : 's'} successfully.`
      )
    } catch (error: any) {
      renderAll(
        `Linking stopped: ${
          error?.message ||
          String(error)
        }`
      )
    } finally {
      busy = false
      syncSummary()
    }
  }

  async function linkSuggestedCharacter(
    bookId: string,
    characterId: string
  ) {
    if (busy) return

    const book =
      books.find(
        item =>
          item.id === bookId &&
          isUnlinked(item)
      )

    const character =
      (
        referenceSnapshot
          ?.characters || []
      ).find(
        (item: any) =>
          item.id === characterId
      )

    if (
      !book ||
      !character
    ) {
      renderAll(
        'That lorebook or character is no longer available. Rescan and try again.'
      )
      return
    }

    const previousSelection =
      new Set(
        selectedUnlinked
      )

    const previousKind =
      linkTargetKind

    const previousTarget =
      linkTargetId

    const previousLinkPanel =
      linkPanelOpen

    const previousFolderPanel =
      folderPanelOpen

    selectedUnlinked.clear()
    selectedUnlinked.add(
      bookId
    )

    linkTargetKind =
      'character'

    linkTargetId =
      characterId

    linkPanelOpen = false
    folderPanelOpen = false

    await linkSelectedBooks()

    selectedUnlinked.clear()

    for (
      const id of
        previousSelection
    ) {
      const current =
        books.find(
          item =>
            item.id === id
        )

      if (
        current &&
        isUnlinked(current)
      ) {
        selectedUnlinked.add(id)
      }
    }

    linkTargetKind =
      previousKind

    linkTargetId =
      previousTarget

    linkPanelOpen =
      previousLinkPanel

    folderPanelOpen =
      previousFolderPanel

    renderAll()
  }

  function renderUnlinked() {
    const visible =
      visibleUnlinkedBooks()

    const selected =
      selectedUnlinkedBooks()

    const targets =
      linkTargets()

    const folders =
      existingFolderNames()

    const allVisibleSelected =
      visible.length > 0 &&
      visible.every(
        book =>
          selectedUnlinked.has(
            book.id
          )
      )

    const selectedIgnored =
      selected.filter(
        book =>
          String(
            book.folder || ''
          ).trim() ===
          IGNORED_FOLDER
      ).length

    return `
      <div class="lb-organizer-card" style="margin-bottom:10px">
        <div class="lb-organizer-card-head">
          <div>
            <div class="lb-organizer-card-title">
              Unlinked library
            </div>

            <div class="lb-organizer-meta">
              ${unlinked.length} active ·
              ${ignored.length} ignored ·
              ${selected.length} selected
            </div>
          </div>

          <label class="lb-organizer-check">
            <input
              type="checkbox"
              data-organizer-show-ignored
              ${showIgnored ? 'checked' : ''}
            >
            <span>Show ignored</span>
          </label>
        </div>

        <div class="lb-organizer-actions">
          <button
            type="button"
            data-organizer-select-visible
            ${visible.length ? '' : 'disabled'}
          >
            ${allVisibleSelected ? 'Unselect visible' : 'Select visible'}
          </button>

          <button
            type="button"
            data-organizer-clear-selection
            ${selected.length ? '' : 'disabled'}
          >
            Clear selection
          </button>

          <button
            type="button"
            data-organizer-open-link
            ${selected.length ? '' : 'disabled'}
          >
            Link selected…
          </button>

          <button
            type="button"
            data-organizer-open-folder
            ${selected.length ? '' : 'disabled'}
          >
            Move selected to folder…
          </button>

          <button
            type="button"
            data-organizer-ignore-selected
            ${selected.length ? '' : 'disabled'}
          >
            Ignore selected
          </button>

          <button
            type="button"
            data-organizer-restore-selected
            ${selectedIgnored ? '' : 'disabled'}
          >
            Restore ignored
          </button>

          <button
            type="button"
            data-organizer-delete-selected
            ${selected.length ? '' : 'disabled'}
          >
            Delete selected
          </button>
        </div>
      </div>

      ${
        folderPanelOpen
          ? `
            <div class="lb-organizer-card" style="margin-bottom:10px">
              <div class="lb-organizer-card-title">
                Move ${selected.length} selected lorebook${selected.length === 1 ? '' : 's'} to folder
              </div>

              <div class="lb-organizer-meta">
                Pick an existing folder or type a new folder name.
              </div>

              <div class="lb-organizer-toolbar">
                <input
                  id="lb-organizer-folder-target"
                  type="text"
                  list="lb-organizer-folder-options"
                  value="${escapeHtml(folderTargetName)}"
                  placeholder="Existing or new folder name…"
                  autocomplete="off"
                  ${busy ? 'disabled' : ''}
                >

                <datalist id="lb-organizer-folder-options">
                  ${folders.map(
                    folder =>
                      `<option value="${escapeHtml(folder)}"></option>`
                  ).join('')}
                </datalist>

                <button
                  type="button"
                  data-organizer-folder-apply
                  ${busy ? 'disabled' : ''}
                >
                  Move selected
                </button>

                <button
                  type="button"
                  data-organizer-folder-cancel
                >
                  Cancel
                </button>
              </div>
            </div>
          `
          : ''
      }

      ${
        linkPanelOpen
          ? `
            <div class="lb-organizer-card" style="margin-bottom:10px">
              <div class="lb-organizer-card-title">
                Link ${selected.length} selected lorebook${selected.length === 1 ? '' : 's'}
              </div>

              <div class="lb-organizer-meta">
                Character, chat and Global can receive multiple lorebooks.
                Persona supports one lorebook attachment.
              </div>

              <div class="lb-organizer-toolbar">
                <select
                  id="lb-organizer-link-kind"
                  ${busy ? 'disabled' : ''}
                >
                  <option value="character" ${linkTargetKind === 'character' ? 'selected' : ''}>
                    Character
                  </option>

                  <option value="chat" ${linkTargetKind === 'chat' ? 'selected' : ''}>
                    Chat
                  </option>

                  <option value="persona" ${linkTargetKind === 'persona' ? 'selected' : ''}>
                    Persona
                  </option>

                  <option value="global" ${linkTargetKind === 'global' ? 'selected' : ''}>
                    Global activation
                  </option>
                </select>

                ${
                  linkTargetKind !== 'global'
                    ? `
                      <select
                        id="lb-organizer-link-target"
                        ${busy ? 'disabled' : ''}
                      >
                        <option value="">
                          Choose ${escapeHtml(linkTargetKind)}…
                        </option>

                        ${targets.map(
                          target => `
                            <option
                              value="${escapeHtml(target.id)}"
                              ${target.id === linkTargetId ? 'selected' : ''}
                            >
                              ${escapeHtml(target.name)}
                            </option>
                          `
                        ).join('')}
                      </select>
                    `
                    : `
                      <span class="lb-organizer-badge">
                        Global lorebooks
                      </span>
                    `
                }

                <button
                  type="button"
                  data-organizer-link-apply
                  ${busy ? 'disabled' : ''}
                >
                  Link selected
                </button>

                <button
                  type="button"
                  data-organizer-link-cancel
                >
                  Cancel
                </button>
              </div>
            </div>
          `
          : ''
      }

      ${
        visible.length
          ? `
            <div class="lb-organizer-list">
              ${visible.map(book => {
                const isIgnored =
                  String(
                    book.folder || ''
                  ).trim() ===
                  IGNORED_FOLDER

                const suggested =
                  suggestedCharacter(
                    book
                  )

                return bookCard(
                  book,
                  `
                    <label class="lb-organizer-check">
                      <input
                        type="checkbox"
                        data-organizer-select-unlinked="${escapeHtml(book.id)}"
                        ${selectedUnlinked.has(book.id) ? 'checked' : ''}
                      >
                      <span>
                        ${isIgnored ? 'Ignored' : 'Select'}
                      </span>
                    </label>

                    ${
                      suggested
                        ? `
                          <button
                            type="button"
                            data-organizer-link-suggested-character="${escapeHtml(suggested.id)}"
                            data-organizer-link-book="${escapeHtml(book.id)}"
                            ${busy ? 'disabled' : ''}
                          >
                            Link to ${escapeHtml(suggested.name)}
                          </button>
                        `
                        : ''
                    }

                    <button
                      type="button"
                      data-organizer-delete-unlinked="${escapeHtml(book.id)}"
                      ${busy ? 'disabled' : ''}
                    >
                      Delete
                    </button>
                  `
                )
              }).join('')}
            </div>
          `
          : `
            <div class="lb-organizer-empty">
              ${
                books.length
                  ? (
                      showIgnored
                        ? 'No unlinked or ignored lorebooks match this search.'
                        : ignored.length
                          ? `No active unlinked lorebooks. ${ignored.length} ignored.`
                          : 'No unlinked lorebooks found.'
                    )
                  : 'Scan the library to begin.'
              }
            </div>
          `
      }
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
        Libraries larger than 70 books are analyzed in batches.
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
            '[data-organizer-select-visible]'
          )
        ) {
          const visible =
            visibleUnlinkedBooks()

          const allSelected =
            visible.length > 0 &&
            visible.every(
              book =>
                selectedUnlinked.has(
                  book.id
                )
            )

          for (const book of visible) {
            if (allSelected) {
              selectedUnlinked.delete(
                book.id
              )
            } else {
              selectedUnlinked.add(
                book.id
              )
            }
          }

          renderAll()
          return
        }

        if (
          target.closest(
            '[data-organizer-clear-selection]'
          )
        ) {
          selectedUnlinked.clear()
          renderAll()
          return
        }

        if (
          target.closest(
            '[data-organizer-open-link]'
          )
        ) {
          linkPanelOpen = true

          const targets =
            linkTargets()

          if (
            linkTargetKind !==
              'global' &&
            !targets.some(
              item =>
                item.id ===
                linkTargetId
            )
          ) {
            linkTargetId = ''
          }

          renderAll()
          return
        }

        if (
          target.closest(
            '[data-organizer-link-cancel]'
          )
        ) {
          linkPanelOpen = false
          renderAll()
          return
        }

        if (
          target.closest(
            '[data-organizer-link-apply]'
          )
        ) {
          void linkSelectedBooks()
          return
        }

        if (
          target.closest(
            '[data-organizer-overview-select-visible]'
          )
        ) {
          const visible =
            filteredBooks()

          const allSelected =
            visible.length > 0 &&
            visible.every(
              book =>
                selectedOverview.has(
                  book.id
                )
            )

          for (
            const book of visible
          ) {
            if (allSelected) {
              selectedOverview.delete(
                book.id
              )
            } else {
              selectedOverview.add(
                book.id
              )
            }
          }

          renderAll()
          return
        }

        if (
          target.closest(
            '[data-organizer-overview-clear]'
          )
        ) {
          selectedOverview.clear()
          overviewFolderPanelOpen =
            false
          overviewFolderTargetName =
            ''
          renderAll()
          return
        }

        if (
          target.closest(
            '[data-organizer-overview-open-folder]'
          )
        ) {
          overviewFolderPanelOpen =
            true

          renderAll()
          return
        }

        if (
          target.closest(
            '[data-organizer-overview-folder-cancel]'
          )
        ) {
          overviewFolderPanelOpen =
            false

          overviewFolderTargetName =
            ''

          renderAll()
          return
        }

        if (
          target.closest(
            '[data-organizer-overview-folder-apply]'
          )
        ) {
          const input =
            modalRoot?.querySelector(
              '#lb-organizer-overview-folder-target'
            ) as HTMLInputElement | null

          overviewFolderTargetName =
            input?.value || ''

          void moveSelectedOverviewToFolder()
          return
        }

        if (
          target.closest(
            '[data-organizer-open-folder]'
          )
        ) {
          folderPanelOpen = true
          linkPanelOpen = false
          renderAll()
          return
        }

        if (
          target.closest(
            '[data-organizer-folder-cancel]'
          )
        ) {
          folderPanelOpen = false
          folderTargetName = ''
          renderAll()
          return
        }

        if (
          target.closest(
            '[data-organizer-folder-apply]'
          )
        ) {
          const input =
            modalRoot?.querySelector(
              '#lb-organizer-folder-target'
            ) as HTMLInputElement | null

          folderTargetName =
            input?.value || ''

          void moveSelectedBooksToFolder()
          return
        }

        const suggestedLink =
          target.closest(
            '[data-organizer-link-suggested-character]'
          ) as HTMLElement | null

        if (suggestedLink) {
          const characterId =
            suggestedLink.dataset
              .organizerLinkSuggestedCharacter ||
            ''

          const bookId =
            suggestedLink.dataset
              .organizerLinkBook ||
            ''

          if (
            characterId &&
            bookId
          ) {
            void linkSuggestedCharacter(
              bookId,
              characterId
            )
          }

          return
        }

        if (
          target.closest(
            '[data-organizer-ignore-selected]'
          )
        ) {
          void ignoreSelectedBooks()
          return
        }

        if (
          target.closest(
            '[data-organizer-restore-selected]'
          )
        ) {
          void restoreSelectedBooks()
          return
        }

        if (
          target.closest(
            '[data-organizer-delete-selected]'
          )
        ) {
          void deleteSelectedBooks()
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
          'lb-organizer-overview-folder-target'
        ) {
          overviewFolderTargetName =
            target.value
          return
        }

        if (
          target.id ===
          'lb-organizer-folder-target'
        ) {
          folderTargetName =
            target.value
          return
        }

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
          target.matches(
            '[data-organizer-select-overview]'
          )
        ) {
          const id =
            target.dataset
              .organizerSelectOverview ||
            ''

          if (id) {
            if (
              (
                target as HTMLInputElement
              ).checked
            ) {
              selectedOverview.add(
                id
              )
            } else {
              selectedOverview.delete(
                id
              )
            }
          }

          renderAll()
          return
        }

        if (
          target.matches(
            '[data-organizer-select-unlinked]'
          )
        ) {
          const id =
            target.dataset
              .organizerSelectUnlinked ||
            ''

          if (id) {
            if (
              (
                target as HTMLInputElement
              ).checked
            ) {
              selectedUnlinked.add(id)
            } else {
              selectedUnlinked.delete(id)
            }
          }

          renderAll()
          return
        }

        if (
          target.matches(
            '[data-organizer-show-ignored]'
          )
        ) {
          showIgnored =
            (
              target as HTMLInputElement
            ).checked

          renderAll()
          return
        }

        if (
          target.id ===
          'lb-organizer-link-kind'
        ) {
          linkTargetKind =
            target.value

          linkTargetId = ''

          renderAll()
          return
        }

        if (
          target.id ===
          'lb-organizer-link-target'
        ) {
          linkTargetId =
            target.value

          return
        }

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
