declare const spindle: import('lumiverse-spindle-types').SpindleAPI

const FF_THINK_FIX_VERSION = '0.47.0'

type FFThinkFixConfig = {
  boundaryText: string
  reasoningSide: 'before' | 'after'
  includeMarker: boolean
}

type FFThinkRuntimeConfig = {
  enabled: boolean
  config: FFThinkFixConfig
}

type FFThinkFixSource = 'manual' | 'auto'

const DEFAULT_FF_THINK_CONFIG: FFThinkFixConfig = {
  boundaryText: '[ 🕰️ Time',
  reasoningSide: 'before',
  includeMarker: false,
}

const runtimeByUser =
  new Map<string, FFThinkRuntimeConfig>()

const SETTINGS_STORAGE_PATH =
  'settings/bionic-reading-settings.json'

const inFlight =
  new Set<string>()

function cleanConfig(raw: any): FFThinkFixConfig {
  return {
    boundaryText:
      typeof raw?.boundaryText === 'string'
        ? raw.boundaryText.slice(0, 1000)
        : DEFAULT_FF_THINK_CONFIG.boundaryText,
    reasoningSide:
      raw?.reasoningSide === 'after'
        ? 'after'
        : 'before',
    includeMarker:
      raw?.includeMarker === true,
  }
}

function existingReasoning(message: any): string {
  return typeof message?.extra?.reasoning === 'string'
    ? message.extra.reasoning.trim()
    : ''
}

function splitMessage(
  message: any,
  rawConfig?: any,
): {
  status: 'fixed' | 'no_match' | 'already_fixed'
  content?: string
  reasoning?: string
  reasoningSide?: 'before' | 'after'
  includeMarker?: boolean
} {
  const config = cleanConfig(rawConfig)

  if (!config.boundaryText) {
    return { status: 'no_match' }
  }

  const content =
    typeof message?.content === 'string'
      ? message.content
      : ''

  const boundaryIndex =
    content.indexOf(config.boundaryText)

  if (boundaryIndex < 0) {
    return { status: 'no_match' }
  }

  const boundaryEnd =
    boundaryIndex +
    config.boundaryText.length

  const before =
    content.slice(0, boundaryIndex)

  const marker =
    content.slice(boundaryIndex, boundaryEnd)

  const after =
    content.slice(boundaryEnd)

  const leakedRaw =
    config.reasoningSide === 'after'
      ? (
          config.includeMarker
            ? `${marker}${after}`
            : after
        )
      : (
          config.includeMarker
            ? `${before}${marker}`
            : before
        )

  const leaked =
    leakedRaw.trim()

  if (!leaked) {
    return existingReasoning(message)
      ? { status: 'already_fixed' }
      : { status: 'no_match' }
  }

  const prior =
    existingReasoning(message)

  const reasoning =
    !prior
      ? leaked
      : prior.includes(leaked)
        ? prior
        : `${prior}\n\n${leaked}`

  const visibleContent =
    config.reasoningSide === 'after'
      ? (
          config.includeMarker
            ? before
            : content.slice(0, boundaryEnd)
        )
      : (
          config.includeMarker
            ? after
            : content.slice(boundaryIndex)
        )

  return {
    status: 'fixed',
    content: visibleContent,
    reasoning,
    reasoningSide:
      config.reasoningSide,
    includeMarker:
      config.includeMarker,
  }
}

function sendResult(
  userId: string,
  source: FFThinkFixSource,
  payload: Record<string, unknown>,
): void {
  spindle.sendToFrontend(
    {
      type: 'ff_think_fix_result',
      source,
      version: FF_THINK_FIX_VERSION,
      ...payload,
    },
    userId,
  )
}

function sendProgress(
  userId: string,
  source: FFThinkFixSource,
  stage: 'reading' | 'updating',
  requestId?: string,
): void {
  spindle.sendToFrontend(
    {
      type: 'ff_think_fix_progress',
      source,
      stage,
      requestId: requestId || null,
      version: FF_THINK_FIX_VERSION,
    },
    userId,
  )
}

async function timeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(
            new Error(
              `${label} timed out after ${Math.round(ms / 1000)}s`,
            ),
          ),
          ms,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function latestAssistant(
  chatId: string,
  hintedMessageId?: string,
): Promise<any | null> {
  const messages =
    await timeout(
      spindle.chat.getMessages(chatId),
      4000,
      'Reading chat messages',
    )

  if (hintedMessageId) {
    const hinted =
      messages.find(
        message => message.id === hintedMessageId
      )

    if (hinted?.role === 'assistant') {
      return hinted
    }
  }

  for (
    let i = messages.length - 1;
    i >= 0;
    i--
  ) {
    if (messages[i]?.role === 'assistant') {
      return messages[i]
    }
  }

  return null
}

async function repairMessage(
  userId: string,
  chatId: string,
  message: any,
  source: FFThinkFixSource,
  config: any,
  requestId?: string,
): Promise<void> {
  const messageId =
    typeof message?.id === 'string'
      ? message.id
      : ''

  if (!messageId) {
    sendResult(
      userId,
      source,
      {
        status: 'error',
        requestId: requestId || null,
        error: 'Assistant message has no id.',
        chatId,
      },
    )
    return
  }

  const key =
    `${userId}:${chatId}:${messageId}`

  if (inFlight.has(key)) {
    sendResult(
      userId,
      source,
      {
        status: 'busy',
        requestId: requestId || null,
        chatId,
        messageId,
      },
    )
    return
  }

  inFlight.add(key)

  try {
    const split =
      splitMessage(message, config)

    if (split.status !== 'fixed') {
      sendResult(
        userId,
        source,
        {
          status: split.status,
          requestId: requestId || null,
          chatId,
          messageId,
        },
      )
      return
    }

    sendProgress(
      userId,
      source,
      'updating',
      requestId,
    )

    /*
      This is Lumiverse's documented Chat Mutation reasoning patch:
      reasoning.text writes host-owned extra.reasoning independently
      from normal message content.
    */
    await timeout(
      spindle.chat.updateMessage(
        chatId,
        messageId,
        {
          content: split.content,
          reasoning: {
            text: split.reasoning,
          },
        },
      ),
      7000,
      'Updating message reasoning',
    )

    sendResult(
      userId,
      source,
      {
        status: 'fixed',
        requestId: requestId || null,
        chatId,
        messageId,
        reasoningSide:
          split.reasoningSide,
        includeMarker:
          split.includeMarker,
      },
    )

    spindle.log.info(
      `FF think fix (${source}) repaired ${messageId}`,
    )
  } catch (error: any) {
    const messageText =
      error?.message ||
      String(error) ||
      'Unknown error'

    spindle.log.error(
      `FF think fix (${source}) failed: ${messageText}`,
    )

    sendResult(
      userId,
      source,
      {
        status: 'error',
        requestId: requestId || null,
        error: messageText,
        chatId,
        messageId,
      },
    )
  } finally {
    inFlight.delete(key)
  }
}

type LoreBookSummary = { id: string; name: string; entryCount: number; characterRefs: number; globalRef: boolean; signatures: string[] }

function normalizeLoreName(value: unknown): string {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase().replace(/[\s_-]+/g, ' ')
}
function stableLoreValue(value: any): any {
  if (Array.isArray(value)) return value.map(stableLoreValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableLoreValue(value[key])]))
  return value
}
function loreEntrySignature(entry: any): string {
  const copy: Record<string, any> = {}
  for (const [key, value] of Object.entries(entry || {})) {
    if (['id','uid','world_book_id','created_at','updated_at'].includes(key)) continue
    copy[key] = stableLoreValue(value)
  }
  return JSON.stringify(stableLoreValue(copy))
}
async function listAllLoreBooks(userId?: string) {
  const all: any[] = []; let offset = 0
  while (true) { const page = await spindle.world_books.list({ limit: 200, offset }, userId); all.push(...page.data); if (all.length >= page.total || !page.data.length) return all; offset += page.data.length }
}
async function listAllLoreEntries(worldBookId: string, userId?: string) {
  const all: any[] = []; let offset = 0
  while (true) { const page = await spindle.world_books.entries.list(worldBookId,{limit:200,offset},userId); all.push(...page.data); if (all.length >= page.total || !page.data.length) return all; offset += page.data.length }
}
async function listAllCharacters(userId?: string) {
  const all: any[] = []; let offset = 0
  while (true) { const page = await spindle.characters.list({limit:200,offset},userId); all.push(...page.data); if (all.length >= page.total || !page.data.length) return all; offset += page.data.length }
}
function loreSimilarity(a: string[], b: string[]): number {
  const left = new Set(a), right = new Set(b), union = new Set([...left,...right]); if (!union.size) return 1
  let common = 0; for (const value of left) if (right.has(value)) common += 1
  return common / union.size
}
function recommendedLoreKeeper(books: LoreBookSummary[]): string {
  return [...books].sort((a,b) => { const ra=a.characterRefs+(a.globalRef?1:0), rb=b.characterRefs+(b.globalRef?1:0); if (ra!==rb) return rb-ra; if (a.entryCount!==b.entryCount) return b.entryCount-a.entryCount; return a.id.localeCompare(b.id) })[0].id
}
async function scanLorebookDuplicates(userId?: string) {
  const [books,characters,globalIds]=await Promise.all([listAllLoreBooks(userId),listAllCharacters(userId),spindle.world_books.getGlobal(userId)])
  const charRefs=new Map<string,number>(); for (const character of characters) for (const id of character.world_book_ids||[]) charRefs.set(id,(charRefs.get(id)||0)+1)
  const globalSet=new Set(globalIds); const summaries: LoreBookSummary[]=[]
  for (const book of books) { const entries=await listAllLoreEntries(book.id,userId); summaries.push({id:book.id,name:book.name,entryCount:entries.length,characterRefs:charRefs.get(book.id)||0,globalRef:globalSet.has(book.id),signatures:entries.map(loreEntrySignature).sort()}) }
  const groups=new Map<string,LoreBookSummary[]>(); for (const summary of summaries) { const key=normalizeLoreName(summary.name); if (!key) continue; const arr=groups.get(key)||[]; arr.push(summary); groups.set(key,arr) }
  const results:any[]=[]
  for (const [normalized,items] of groups) { if (items.length<2) continue; let min=1; for(let i=0;i<items.length;i++) for(let j=i+1;j<items.length;j++) min=Math.min(min,loreSimilarity(items[i].signatures,items[j].signatures)); const exact=min===1&&items.every(x=>x.signatures.length===items[0].signatures.length); const classification=exact?'exact':min>=.75?'near':'conflicting'; const keep=recommendedLoreKeeper(items); results.push({groupId:encodeURIComponent(normalized),name:items[0].name,classification,similarity:min,recommendedKeepId:keep,books:items.map(x=>({id:x.id,name:x.name,entryCount:x.entryCount,characterRefs:x.characterRefs,globalRef:x.globalRef}))}) }
  return results.sort((a,b)=>a.name.localeCompare(b.name))
}
async function rewireLorebookReferences(keepId:string, duplicateIds:string[], userId?:string) {
  const dup=new Set(duplicateIds), characters=await listAllCharacters(userId); let updated=0
  for (const character of characters) { const current=Array.isArray(character.world_book_ids)?character.world_book_ids:[]; if(!current.some((id:string)=>dup.has(id))) continue; const next=Array.from(new Set(current.map((id:string)=>dup.has(id)?keepId:id))); await spindle.characters.update(character.id,{world_book_ids:next},userId); updated += 1 }
  const globals=await spindle.world_books.getGlobal(userId); if(globals.some((id:string)=>dup.has(id))) await spindle.world_books.setGlobal(Array.from(new Set(globals.map((id:string)=>dup.has(id)?keepId:id))),userId)
  return updated
}
async function mergeLorebookEntries(keepId:string, duplicateIds:string[], userId?:string) {
  const signatures=new Set((await listAllLoreEntries(keepId,userId)).map(loreEntrySignature)); let created=0
  for (const duplicateId of duplicateIds) for (const entry of await listAllLoreEntries(duplicateId,userId)) { const sig=loreEntrySignature(entry); if(signatures.has(sig)) continue; const input:any={...entry}; for(const k of ['id','uid','world_book_id','created_at','updated_at']) delete input[k]; await spindle.world_books.entries.create(keepId,input,userId); signatures.add(sig); created += 1 }
  return created
}
async function applyLorebookCleanupGroup(group:any, merge:boolean, userId?:string) {
  const keepId=typeof group?.recommendedKeepId==='string'?group.recommendedKeepId:''; const duplicateIds=Array.isArray(group?.books)?group.books.map((book:any)=>String(book?.id||'')).filter((id:string)=>id&&id!==keepId):[]
  if(!keepId||!duplicateIds.length) throw new Error('Invalid cleanup group.')
  const mergedEntries=merge?await mergeLorebookEntries(keepId,duplicateIds,userId):0; const updatedCharacters=await rewireLorebookReferences(keepId,duplicateIds,userId); let deletedBooks=0
  for(const id of duplicateIds) if(await spindle.world_books.delete(id,userId)) deletedBooks += 1
  return {mergedEntries,updatedCharacters,deletedBooks}
}

/*
  Register frontend RPC first. This means the health ping is available
  even if generation-event registration is rejected for permissions.
*/
spindle.onFrontendMessage(
  async (payload: any, userId: string) => {
    if (
      payload?.type ===
      'bionic_settings_load'
    ) {
      try {
        const saved =
          await spindle.userStorage.getJson(
            SETTINGS_STORAGE_PATH,
            { userId },
          )

        spindle.sendToFrontend(
          {
            type: 'bionic_settings_loaded',
            settings:
              saved && typeof saved === 'object'
                ? saved
                : null,
          },
          userId,
        )
      } catch {
        spindle.sendToFrontend(
          {
            type: 'bionic_settings_loaded',
            settings: null,
          },
          userId,
        )
      }
      return
    }

    if (
      payload?.type ===
      'bionic_settings_save'
    ) {
      try {
        const incoming = payload?.settings

        if (!incoming || typeof incoming !== 'object') {
          throw new Error('Invalid settings payload')
        }

        await spindle.userStorage.setJson(
          SETTINGS_STORAGE_PATH,
          incoming,
          { userId },
        )

        spindle.sendToFrontend(
          {
            type: 'bionic_settings_saved',
            ok: true,
          },
          userId,
        )
      } catch (error: any) {
        spindle.log.warn(
          `Bionic settings save failed: ${
            error?.message || String(error)
          }`,
        )
        spindle.sendToFrontend(
          {
            type: 'bionic_settings_saved',
            ok: false,
          },
          userId,
        )
      }
      return
    }

    if (payload?.type === 'lorebook_cleanup_scan') {
      try { spindle.sendToFrontend({ type: 'lorebook_cleanup_scan_result', groups: await scanLorebookDuplicates(userId) }, userId) }
      catch (error: any) { spindle.sendToFrontend({ type: 'lorebook_cleanup_action_result', ok: false, error: error?.message || String(error) }, userId) }
      return
    }
    if (payload?.type === 'lorebook_cleanup_clean_exact' || payload?.type === 'lorebook_cleanup_merge') {
      try { const group=payload?.group; if(payload.type==='lorebook_cleanup_clean_exact'&&group?.classification!=='exact') throw new Error('Safe clean only accepts exact duplicate groups.'); const result=await applyLorebookCleanupGroup(group,payload.type==='lorebook_cleanup_merge',userId); spindle.sendToFrontend({type:'lorebook_cleanup_action_result',ok:true,summary:`${result.deletedBooks} duplicate book(s) deleted, ${result.updatedCharacters} character attachment(s) rewired, ${result.mergedEntries} unique entry/entries merged`},userId) }
      catch(error:any){ spindle.sendToFrontend({type:'lorebook_cleanup_action_result',ok:false,error:error?.message||String(error)},userId) }
      return
    }
    if (payload?.type === 'lorebook_cleanup_clean_all_exact') {
      try { const groups=Array.isArray(payload?.groups)?payload.groups.filter((g:any)=>g?.classification==='exact'):[]; let deletedBooks=0,updatedCharacters=0; for(const group of groups){const r=await applyLorebookCleanupGroup(group,false,userId);deletedBooks+=r.deletedBooks;updatedCharacters+=r.updatedCharacters} spindle.sendToFrontend({type:'lorebook_cleanup_action_result',ok:true,summary:`${deletedBooks} duplicate book(s) deleted across ${groups.length} exact group(s); ${updatedCharacters} character attachment(s) rewired`},userId) }
      catch(error:any){spindle.sendToFrontend({type:'lorebook_cleanup_action_result',ok:false,error:error?.message||String(error)},userId)}
      return
    }

    if (
      payload?.type ===
      'ff_think_fix_health'
    ) {
      spindle.sendToFrontend(
        {
          type: 'ff_think_fix_health',
          version: FF_THINK_FIX_VERSION,
        },
        userId,
      )
      return
    }

    if (
      payload?.type ===
      'ff_think_fix_config'
    ) {
      runtimeByUser.set(
        userId,
        {
          enabled: Boolean(payload.enabled),
          config: cleanConfig(payload.config),
        },
      )
      return
    }

    if (
      payload?.type !==
      'ff_think_fix_manual'
    ) {
      return
    }

    const chatId =
      typeof payload.chatId === 'string'
        ? payload.chatId
        : ''

    const requestId =
      typeof payload.requestId === 'string'
        ? payload.requestId
        : undefined

    if (!chatId) {
      sendResult(
        userId,
        'manual',
        {
          status: 'error',
          requestId: requestId || null,
          error: 'No current chat id was provided.',
        },
      )
      return
    }

    sendProgress(
      userId,
      'manual',
      'reading',
      requestId,
    )

    try {
      const assistant =
        await latestAssistant(
          chatId,
          typeof payload.latestMessageId === 'string'
            ? payload.latestMessageId
            : undefined,
        )

      if (!assistant) {
        sendResult(
          userId,
          'manual',
          {
            status: 'no_assistant',
            requestId: requestId || null,
            chatId,
          },
        )
        return
      }

      await repairMessage(
        userId,
        chatId,
        assistant,
        'manual',
        payload.config,
        requestId,
      )
    } catch (error: any) {
      sendResult(
        userId,
        'manual',
        {
          status: 'error',
          requestId: requestId || null,
          error:
            error?.message ||
            String(error) ||
            'Unknown error',
          chatId,
        },
      )
    }
  },
)

/*
  Automatic mode is optional. A rejected generation subscription must
  never prevent the backend's manual RPC/health path from loading.
*/
try {
  spindle.on(
    'GENERATION_ENDED',
    async (
      payload: any,
      userId?: string,
    ) => {
      if (
        typeof userId !== 'string' ||
        !userId
      ) {
        return
      }

      const runtime =
        runtimeByUser.get(userId)

      if (!runtime?.enabled) return
      if (payload?.error) return

      const chatId =
        typeof payload?.chatId === 'string'
          ? payload.chatId
          : ''

      if (!chatId) return

      try {
        const assistant =
          await latestAssistant(
            chatId,
            typeof payload?.messageId === 'string'
              ? payload.messageId
              : undefined,
          )

        if (!assistant) {
          sendResult(
            userId,
            'auto',
            {
              status: 'no_assistant',
              chatId,
              messageId:
                payload?.messageId || null,
            },
          )
          return
        }

        await repairMessage(
          userId,
          chatId,
          assistant,
          'auto',
          runtime.config,
        )
      } catch (error: any) {
        sendResult(
          userId,
          'auto',
          {
            status: 'error',
            error:
              error?.message ||
              String(error) ||
              'Unknown error',
            chatId,
            messageId:
              payload?.messageId || null,
          },
        )
      }
    },
  )
} catch (error: any) {
  spindle.log.warn(
    `FF automatic listener not registered: ${
      error?.message || String(error)
    }`,
  )
}


/*
  Ken sleep reminder bridge
  -------------------------
  MESSAGE_SENT is the host lifecycle event for newly-created chat rows.
  Resolve the currently active persona so the frontend can compare the
  actual {{user}} identity, while the frontend itself performs the
  device-local time check.
*/
// Ken sleep alert temporarily disabled in v0.28.
if (false) spindle.on(
  'MESSAGE_SENT',
  async (
    payload: any,
    userId?: string,
  ) => {
    const chatId =
      typeof payload?.chatId === 'string'
        ? payload.chatId
        : (
            typeof payload?.message?.chat_id === 'string'
              ? payload.message.chat_id
              : ''
          )

    if (!chatId) return

    let personaName = ''

    try {
      const persona =
        await spindle.personas.getActive(
          userId,
        )

      /*
        getActive() is the persona currently selected by the frontend.
        If the host reports no active persona, fall back to the default
        persona because that is the identity Lumiverse uses when no
        explicit active override is selected.
      */
      if (persona?.name) {
        personaName = persona.name
      } else {
        const defaultPersona =
          await spindle.personas.getDefault(
            userId,
          )

        personaName =
          defaultPersona?.name || ''
      }
    } catch (error: any) {
      spindle.log.warn(
        `Ken sleep reminder could not resolve active persona: ${
          error?.message || String(error)
        }`,
      )
      return
    }

    spindle.sendToFrontend(
      {
        type: 'ken_sleep_message_sent',
        chatId,
        personaName,
        messageId:
          typeof payload?.message?.id === 'string'
            ? payload.message.id
            : null,
      },
      userId,
    )
  },
)

spindle.log.info(
  `Bionic Reading & Fonts FF backend v${FF_THINK_FIX_VERSION} loaded`,
)
