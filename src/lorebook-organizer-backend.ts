type OrganizerBookInput = {
  id: string
  name: string
  folder?: string
  description?: string
  entryCount?: number
  sampleKeys?: string[]
}

type FolderSuggestion = {
  name: string
  bookIds: string[]
  reason: string
}

function organizerSend(
  spindleApi: any,
  userId: string,
  payload: Record<string, unknown>
) {
  spindleApi.sendToFrontend(
    payload,
    userId
  )
}

function generationText(
  result: any
): string {
  if (typeof result === 'string') {
    return result
  }

  const direct = [
    result?.text,
    result?.content,
    result?.response,
    result?.output_text,
    result?.message?.content,
    result?.assistant_message?.content,
  ]

  for (const value of direct) {
    if (
      typeof value === 'string' &&
      value.trim()
    ) {
      return value
    }
  }

  const choice =
    result?.choices?.[0]

  if (
    typeof choice?.message?.content === 'string'
  ) {
    return choice.message.content
  }

  if (
    typeof choice?.text === 'string'
  ) {
    return choice.text
  }

  return ''
}

function parseJsonResult(
  raw: string
): any {
  let text =
    String(raw || '').trim()

  text = text
    .replace(
      /^```(?:json)?\s*/i,
      ''
    )
    .replace(
      /\s*```$/,
      ''
    )
    .trim()

  try {
    return JSON.parse(text)
  } catch {}

  const objectStart =
    text.indexOf('{')

  const objectEnd =
    text.lastIndexOf('}')

  if (
    objectStart >= 0 &&
    objectEnd > objectStart
  ) {
    return JSON.parse(
      text.slice(
        objectStart,
        objectEnd + 1
      )
    )
  }

  throw new Error(
    'The LLM did not return valid JSON.'
  )
}

function sanitizeOrganizerBooks(
  value: unknown
): OrganizerBookInput[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .filter(
      item =>
        item &&
        typeof item === 'object' &&
        typeof item.id === 'string' &&
        typeof item.name === 'string'
    )
    .slice(0, 1000)
    .map((item: any) => ({
      id: item.id,
      name: item.name.slice(0, 300),
      folder:
        typeof item.folder === 'string'
          ? item.folder.slice(0, 300)
          : '',
      description:
        typeof item.description === 'string'
          ? item.description.slice(0, 1200)
          : '',
      entryCount:
        Number.isFinite(
          Number(item.entryCount)
        )
          ? Number(item.entryCount)
          : 0,
      sampleKeys:
        Array.isArray(item.sampleKeys)
          ? item.sampleKeys
              .filter(
                (key: unknown) =>
                  typeof key === 'string'
              )
              .slice(0, 12)
              .map(
                (key: string) =>
                  key.slice(0, 160)
              )
          : [],
    }))
}

function sanitizeSuggestions(
  parsed: any,
  books: OrganizerBookInput[]
): FolderSuggestion[] {
  const knownIds =
    new Set(
      books.map(book => book.id)
    )

  const folders =
    Array.isArray(parsed?.folders)
      ? parsed.folders
      : []

  const usedIds =
    new Set<string>()

  const clean: FolderSuggestion[] = []

  for (const folder of folders) {
    if (
      !folder ||
      typeof folder !== 'object'
    ) {
      continue
    }

    const name =
      typeof folder.name === 'string'
        ? folder.name.trim()
        : ''

    if (!name) continue

    const ids =
      Array.from(
        new Set(
          (
            Array.isArray(folder.book_ids)
              ? folder.book_ids
              : Array.isArray(folder.bookIds)
                ? folder.bookIds
                : []
          ).filter(
            (id: unknown): id is string =>
              typeof id === 'string' &&
              knownIds.has(id) &&
              !usedIds.has(id)
          )
        )
      )

    /*
      Folder organization is for gathering related
      books. Singleton "folders" add noise, so keep
      only suggestions containing at least two books.
    */
    if (ids.length < 2) {
      continue
    }

    for (const id of ids) {
      usedIds.add(id)
    }

    clean.push({
      name: name.slice(0, 120),
      bookIds: ids,
      reason:
        typeof folder.reason === 'string'
          ? folder.reason
              .trim()
              .slice(0, 500)
          : '',
    })
  }

  return clean
}

function organizerPrompt(
  books: OrganizerBookInput[]
): string {
  const compact =
    books.map(book => ({
      id: book.id,
      name: book.name,
      current_folder:
        book.folder || '',
      description:
        book.description || '',
      entry_count:
        book.entryCount || 0,
      representative_keys:
        book.sampleKeys || [],
    }))

  return `
You are organizing a Lumiverse lorebook library.

Your ONLY task is to propose folders that gather related
lorebooks together.

Do not delete books.
Do not merge books.
Do not rename books.
Do not rewrite lorebook contents.
Do not invent book IDs.
Do not put a book into more than one suggested folder.

Prefer useful thematic folders containing at least 2 books.
Leave unrelated books ungrouped rather than forcing them
into bad categories.

Return ONLY valid JSON in this exact shape:

{
  "folders": [
    {
      "name": "Folder name",
      "book_ids": ["exact-id-1", "exact-id-2"],
      "reason": "Short explanation"
    }
  ]
}

LOREBOOK LIBRARY:
${JSON.stringify(compact)}
`.trim()
}


async function organizerListAll(
  api: any,
  userId: string,
  label: string
): Promise<any[]> {
  if (!api || typeof api.list !== 'function') {
    throw new Error(
      `${label} list API is unavailable. Cleanup was stopped safely.`
    )
  }

  const all: any[] = []
  let offset = 0

  for (let pageNo = 0; pageNo < 1000; pageNo += 1) {
    let page: any

    try {
      page = await api.list({
        limit: 200,
        offset,
        userId,
      })
    } catch (error) {
      /*
        Some older Spindle content APIs returned an array directly
        instead of a paged object. Try that shape once, but never
        silently continue with an incomplete paged scan.
      */
      if (offset !== 0) throw error

      page = await api.list(userId)
    }

    if (Array.isArray(page)) {
      return page
    }

    const data =
      Array.isArray(page?.data)
        ? page.data
        : []

    all.push(...data)

    const total =
      Number(page?.total ?? all.length)

    if (
      data.length === 0 ||
      all.length >= total
    ) {
      return all
    }

    offset += data.length
  }

  throw new Error(
    `${label} scan exceeded the pagination safety limit.`
  )
}

function organizerStrings(
  value: unknown
): string[] {
  if (!Array.isArray(value)) return []

  return Array.from(
    new Set(
      value.filter(
        (item): item is string =>
          typeof item === 'string' &&
          item.length > 0
      )
    )
  )
}

function organizerCharacterBookIds(
  character: any
): string[] {
  if (
    Array.isArray(
      character?.world_book_ids
    )
  ) {
    return organizerStrings(
      character.world_book_ids
    )
  }

  const ext =
    character?.extensions &&
    typeof character.extensions === 'object'
      ? character.extensions
      : {}

  if (
    Array.isArray(
      ext.world_book_ids
    )
  ) {
    return organizerStrings(
      ext.world_book_ids
    )
  }

  if (
    typeof ext.world_book_id === 'string' &&
    ext.world_book_id
  ) {
    return [ext.world_book_id]
  }

  return []
}

async function organizerHydrateItems(
  api: any,
  items: any[],
  userId: string,
  label: string,
  complete: (item: any) => boolean
): Promise<any[]> {
  const result: any[] = []

  for (const item of items) {
    if (complete(item)) {
      result.push(item)
      continue
    }

    if (
      typeof item?.id !== 'string' ||
      !item.id
    ) {
      throw new Error(
        `${label} list returned an incomplete record without an id. Cleanup was stopped safely.`
      )
    }

    if (
      !api ||
      typeof api.get !== 'function'
    ) {
      throw new Error(
        `${label} ${item.id} is missing reference data and the detail API is unavailable. Cleanup was stopped safely.`
      )
    }

    const detailed =
      await api.get(
        item.id,
        userId
      )

    if (
      !detailed ||
      !complete(detailed)
    ) {
      throw new Error(
        `${label} ${item.id} still has incomplete reference data after hydration. Cleanup was stopped safely.`
      )
    }

    result.push(detailed)
  }

  return result
}

async function organizerReferenceSnapshot(
  spindleApi: any,
  userId: string
) {
  const chatsApi =
    spindleApi.chats ||
    spindleApi.chat

  const [
    listedCharacters,
    listedChats,
    listedPersonas,
    globalIds,
  ] = await Promise.all([
    organizerListAll(
      spindleApi.characters,
      userId,
      'Character'
    ),
    organizerListAll(
      chatsApi,
      userId,
      'Chat'
    ),
    organizerListAll(
      spindleApi.personas,
      userId,
      'Persona'
    ),
    spindleApi.world_books
      .getGlobal(userId),
  ])

  /*
    Lists are allowed to return compact summary DTOs.
    Never interpret a missing attachment field as "no attachment";
    hydrate the full record first or fail closed.
  */
  const characters =
    await organizerHydrateItems(
      spindleApi.characters,
      listedCharacters,
      userId,
      'Character',
      item =>
        Array.isArray(
          item?.world_book_ids
        ) ||
        (
          item?.extensions &&
          typeof item.extensions ===
            'object'
        )
    )

  const chats =
    await organizerHydrateItems(
      chatsApi,
      listedChats,
      userId,
      'Chat',
      item =>
        item?.metadata &&
        typeof item.metadata ===
          'object'
    )

  const personas =
    await organizerHydrateItems(
      spindleApi.personas,
      listedPersonas,
      userId,
      'Persona',
      item =>
        Object.prototype
          .hasOwnProperty.call(
            item || {},
            'attached_world_book_id'
          )
    )

  return {
    characters:
      characters
        .filter(
          item =>
            item &&
            typeof item.id === 'string'
        )
        .map(item => ({
          id: item.id,
          name:
            item.name ||
            'Unnamed character',
          world_book_ids:
            organizerCharacterBookIds(
              item
            ),
        })),

    chats:
      chats
        .filter(
          item =>
            item &&
            typeof item.id === 'string'
        )
        .map(item => ({
          id: item.id,
          title:
            item.title ||
            item.name ||
            'Unnamed chat',
          metadata: {
            chat_world_book_ids:
              organizerStrings(
                item.metadata
                  .chat_world_book_ids
              ),
          },
        })),

    personas:
      personas
        .filter(
          item =>
            item &&
            typeof item.id === 'string'
        )
        .map(item => ({
          id: item.id,
          name:
            item.name ||
            'Unnamed persona',
          attached_world_book_id:
            typeof item
              .attached_world_book_id ===
              'string'
              ? item
                  .attached_world_book_id
              : null,
        })),

    globalIds:
      organizerStrings(globalIds),
  }
}

export async function handleLorebookOrganizerMessage(
  spindleApi: any,
  payload: any,
  userId: string
): Promise<boolean> {
  const type =
    payload?.type

  if (
    type ===
    'bionic_lore_reference_snapshot'
  ) {
    const requestId =
      payload?.requestId || null

    try {
      const snapshot =
        await organizerReferenceSnapshot(
          spindleApi,
          userId
        )

      organizerSend(
        spindleApi,
        userId,
        {
          type:
            'bionic_lore_reference_snapshot_result',
          requestId,
          snapshot,
        }
      )
    } catch (error: any) {
      organizerSend(
        spindleApi,
        userId,
        {
          type:
            'bionic_lore_reference_snapshot_result',
          requestId,
          error:
            error?.message ||
            String(error),
        }
      )
    }

    return true
  }

  if (
    type ===
    'bionic_lore_relink_personas'
  ) {
    const requestId =
      payload?.requestId || null

    try {
      const assignments =
        Array.isArray(
          payload?.assignments
        )
          ? payload.assignments
              .filter(
                (item: any) =>
                  item &&
                  typeof item.id ===
                    'string' &&
                  typeof item.bookId ===
                    'string'
              )
              .slice(0, 1000)
          : []

      if (!assignments.length) {
        organizerSend(
          spindleApi,
          userId,
          {
            type:
              'bionic_lore_relink_personas_result',
            requestId,
            personas: [],
          }
        )

        return true
      }

      const personasApi =
        spindleApi.personas

      if (
        !personasApi ||
        typeof personasApi.update !==
          'function'
      ) {
        throw new Error(
          'Persona update API is unavailable. Duplicate deletion was stopped safely.'
        )
      }

      const updated: any[] = []

      for (
        const assignment of assignments
      ) {
        const persona =
          await personasApi.update(
            assignment.id,
            {
              attached_world_book_id:
                assignment.bookId,
            },
            userId
          )

        if (
          persona
            ?.attached_world_book_id !==
          assignment.bookId
        ) {
          throw new Error(
            `Persona ${assignment.id} did not verify after relinking.`
          )
        }

        updated.push({
          id: persona.id,
          name:
            persona.name ||
            'Unnamed persona',
          attached_world_book_id:
            persona
              .attached_world_book_id,
        })
      }

      organizerSend(
        spindleApi,
        userId,
        {
          type:
            'bionic_lore_relink_personas_result',
          requestId,
          personas: updated,
        }
      )
    } catch (error: any) {
      organizerSend(
        spindleApi,
        userId,
        {
          type:
            'bionic_lore_relink_personas_result',
          requestId,
          error:
            error?.message ||
            String(error),
        }
      )
    }

    return true
  }

  if (
    type ===
    'bionic_lore_set_global'
  ) {
    const requestId =
      payload?.requestId || null

    try {
      const ids =
        organizerStrings(
          payload?.ids
        )

      const result =
        await spindleApi.world_books
          .setGlobal(
            ids,
            userId
          )

      const verified =
        organizerStrings(result)

      if (
        JSON.stringify(verified) !==
        JSON.stringify(ids)
      ) {
        throw new Error(
          'Global lorebook references did not verify after relinking.'
        )
      }

      organizerSend(
        spindleApi,
        userId,
        {
          type:
            'bionic_lore_set_global_result',
          requestId,
          ids: verified,
        }
      )
    } catch (error: any) {
      organizerSend(
        spindleApi,
        userId,
        {
          type:
            'bionic_lore_set_global_result',
          requestId,
          error:
            error?.message ||
            String(error),
        }
      )
    }

    return true
  }

  if (
    type ===
    'bionic_lore_global_ids'
  ) {
    try {
      const ids =
        await spindleApi.world_books
          .getGlobal(userId)

      organizerSend(
        spindleApi,
        userId,
        {
          type:
            'bionic_lore_global_ids_result',
          requestId:
            payload?.requestId || null,
          ids:
            Array.isArray(ids)
              ? ids
              : [],
        }
      )
    } catch (error: any) {
      organizerSend(
        spindleApi,
        userId,
        {
          type:
            'bionic_lore_global_ids_result',
          requestId:
            payload?.requestId || null,
          error:
            error?.message ||
            String(error),
        }
      )
    }

    return true
  }

  if (
    type ===
    'bionic_lore_connections'
  ) {
    try {
      const raw =
        await spindleApi.connections
          .list(userId)

      const connections =
        (Array.isArray(raw) ? raw : [])
          .map((connection: any) => ({
            id:
              String(
                connection?.id || ''
              ),
            name:
              connection?.name ||
              connection?.display_name ||
              connection?.provider ||
              'Unnamed connection',
            provider:
              connection?.provider || '',
            model:
              connection?.model ||
              connection?.model_id ||
              '',
          }))
          .filter(
            (connection: any) =>
              connection.id
          )

      organizerSend(
        spindleApi,
        userId,
        {
          type:
            'bionic_lore_connections_result',
          requestId:
            payload?.requestId || null,
          connections,
        }
      )
    } catch (error: any) {
      organizerSend(
        spindleApi,
        userId,
        {
          type:
            'bionic_lore_connections_result',
          requestId:
            payload?.requestId || null,
          error:
            error?.message ||
            String(error),
        }
      )
    }

    return true
  }

  if (
    type ===
    'bionic_lore_ai_organize'
  ) {
    const requestId =
      payload?.requestId || null

    try {
      const books =
        sanitizeOrganizerBooks(
          payload?.books
        )

      if (books.length < 2) {
        throw new Error(
          'Scan at least two lorebooks before AI organization.'
        )
      }

      const connectionId =
        typeof payload?.connectionId ===
          'string'
          ? payload.connectionId.trim()
          : ''

      organizerSend(
        spindleApi,
        userId,
        {
          type:
            'bionic_lore_ai_progress',
          requestId,
          stage: 'analyzing',
        }
      )

      const prompt =
        organizerPrompt(books)

      /*
        Current Spindle exposes generate.quiet().
        Keep both connection naming forms in the
        untyped request for compatibility with the
        generation transport while staging evolves.
      */
      const result =
        await (
          spindleApi.generate
            .quiet as any
        )({
          prompt,
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
          connectionId:
            connectionId || undefined,
          connection_id:
            connectionId || undefined,
          parameters: {
            temperature: 0.2,
          },
        })

      const text =
        generationText(result)

      if (!text.trim()) {
        throw new Error(
          'The selected LLM returned no text.'
        )
      }

      const parsed =
        parseJsonResult(text)

      const folders =
        sanitizeSuggestions(
          parsed,
          books
        )

      organizerSend(
        spindleApi,
        userId,
        {
          type:
            'bionic_lore_ai_result',
          requestId,
          folders,
        }
      )
    } catch (error: any) {
      organizerSend(
        spindleApi,
        userId,
        {
          type:
            'bionic_lore_ai_result',
          requestId,
          error:
            error?.message ||
            String(error),
        }
      )
    }

    return true
  }

  if (
    type ===
    'bionic_lore_apply_folders'
  ) {
    const requestId =
      payload?.requestId || null

    try {
      const raw =
        Array.isArray(
          payload?.assignments
        )
          ? payload.assignments
          : []

      const assignments =
        raw
          .filter(
            (item: any) =>
              item &&
              typeof item.bookId ===
                'string' &&
              typeof item.folder ===
                'string' &&
              item.folder.trim()
          )
          .slice(0, 1000)

      if (!assignments.length) {
        throw new Error(
          'No folder assignments were selected.'
        )
      }

      let updated = 0

      for (const assignment of assignments) {
        await spindleApi.world_books
          .update(
            assignment.bookId,
            {
              folder:
                assignment.folder
                  .trim()
                  .slice(0, 120),
            },
            userId
          )

        updated += 1
      }

      organizerSend(
        spindleApi,
        userId,
        {
          type:
            'bionic_lore_apply_folders_result',
          requestId,
          updated,
        }
      )
    } catch (error: any) {
      organizerSend(
        spindleApi,
        userId,
        {
          type:
            'bionic_lore_apply_folders_result',
          requestId,
          error:
            error?.message ||
            String(error),
        }
      )
    }

    return true
  }

  return false
}
