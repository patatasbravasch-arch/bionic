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
