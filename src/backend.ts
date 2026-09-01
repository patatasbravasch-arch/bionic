import { transformMarkdownForBionic } from './transform'

declare const spindle: import('lumiverse-spindle-types').SpindleAPI

const CACHE_LIMIT = 512
const renderCache = new Map<string, string>()

function fnv1a(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

function getCacheKey(ctx: {
  userId: string
  chatId: string
  messageId?: string
  content: string
}): string {
  return [
    ctx.userId,
    ctx.chatId,
    ctx.messageId ?? 'no-message-id',
    ctx.content.length,
    fnv1a(ctx.content),
  ].join(':')
}

function putCache(key: string, value: string): void {
  if (renderCache.has(key)) renderCache.delete(key)
  renderCache.set(key, value)

  if (renderCache.size > CACHE_LIMIT) {
    const oldest = renderCache.keys().next().value
    if (oldest !== undefined) renderCache.delete(oldest)
  }
}

spindle.registerMessageContentProcessor(async (ctx) => {
  // Critical: render-only means stored history, prompts, memories, and exports stay untouched.
  if (ctx.origin !== 'render' || !ctx.content) return

  const key = getCacheKey(ctx)
  const cached = renderCache.get(key)
  if (cached !== undefined) return { content: cached }

  const content = transformMarkdownForBionic(ctx.content)
  putCache(key, content)
  return { content }
}, 100)

// Lumiverse invokes render processing twice per visible message. Clear our small
// dedupe cache when message state changes so stale transforms cannot linger.
spindle.on('CHAT_CHANGED', () => renderCache.clear())
spindle.on('MESSAGE_EDITED', () => renderCache.clear())
spindle.on('MESSAGE_SWIPED', () => renderCache.clear())
spindle.on('MESSAGE_DELETED', () => renderCache.clear())



const FF_THINK_FIX_VERSION = '0.25.0'

const ffThinkFixInFlight = new Set<string>()

type FFThinkFixStatus =
  | 'fixed'
  | 'no_match'
  | 'already_fixed'
  | 'no_assistant'
  | 'busy'
  | 'error'

type FFThinkFixSource =
  | 'manual'
  | 'auto'

type FFThinkFixConfig = {
  boundaryText: string
}

type FFThinkRuntimeConfig = {
  enabled: boolean
  config: FFThinkFixConfig
}

const DEFAULT_FF_THINK_CONFIG: FFThinkFixConfig = {
  boundaryText: '[ 🕰️ Time',
}

const ffThinkRuntimeByUser =
  new Map<string, FFThinkRuntimeConfig>()

function cleanFFThinkConfig(
  raw: any,
): FFThinkFixConfig {
  return {
    boundaryText:
      typeof raw?.boundaryText === 'string'
        ? raw.boundaryText.slice(0, 1000)
        : DEFAULT_FF_THINK_CONFIG.boundaryText,
  }
}

function normalizeExistingReasoning(
  extra: Record<string, unknown> | undefined,
): string {
  const value = extra?.reasoning

  return typeof value === 'string'
    ? value.trim()
    : ''
}

function mergeReasoning(
  existing: string,
  leakedPrefix: string,
): string {
  const prefix = leakedPrefix.trim()

  if (!existing) return prefix
  if (!prefix) return existing
  if (existing.includes(prefix)) return existing

  return `${existing}\n\n${prefix}`
}

function repairFFThinkBlock(
  content: string,
  extra: Record<string, unknown> | undefined,
  rawConfig?: any,
): {
  status: Exclude<
    FFThinkFixStatus,
    'no_assistant' | 'busy' | 'error'
  >
  content?: string
  reasoning?: string
} {
  const config =
    cleanFFThinkConfig(rawConfig)

  const boundary =
    config.boundaryText

  if (!boundary) {
    return { status: 'no_match' }
  }

  const boundaryIndex =
    content.indexOf(boundary)

  if (boundaryIndex < 0) {
    return { status: 'no_match' }
  }

  const leakedPrefix =
    content.slice(0, boundaryIndex)

  if (!leakedPrefix.trim()) {
    const existingReasoning =
      normalizeExistingReasoning(extra)

    return existingReasoning
      ? { status: 'already_fixed' }
      : { status: 'no_match' }
  }

  const visibleContent =
    content.slice(boundaryIndex)

  const existingReasoning =
    normalizeExistingReasoning(extra)

  const reasoning =
    mergeReasoning(
      existingReasoning,
      leakedPrefix,
    )

  if (!reasoning.trim()) {
    return { status: 'no_match' }
  }

  return {
    status: 'fixed',
    content: visibleContent,
    reasoning,
  }
}

async function withBackendTimeout<T>(
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

function sendFFThinkFixResult(
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

function sendFFThinkFixProgress(
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

async function applyFFThinkFixMessage(
  userId: string,
  chatId: string,
  message: any,
  options: {
    config?: any
    source: FFThinkFixSource
    requestId?: string
  },
): Promise<void> {
  const source = options.source
  const messageId =
    typeof message?.id === 'string'
      ? message.id
      : ''

  if (!messageId) {
    sendFFThinkFixResult(
      userId,
      source,
      {
        status: 'error',
        requestId: options.requestId || null,
        error: 'Assistant message had no stable id.',
        chatId,
      },
    )
    return
  }

  const key =
    `${userId}:${chatId}:${messageId}`

  if (ffThinkFixInFlight.has(key)) {
    sendFFThinkFixResult(
      userId,
      source,
      {
        status: 'busy',
        requestId: options.requestId || null,
        chatId,
        messageId,
      },
    )
    return
  }

  ffThinkFixInFlight.add(key)

  try {
    const result =
      repairFFThinkBlock(
        message.content || '',
        message.extra || {},
        options.config,
      )

    if (
      result.status !== 'fixed' ||
      typeof result.content !== 'string' ||
      typeof result.reasoning !== 'string'
    ) {
      sendFFThinkFixResult(
        userId,
        source,
        {
          status: result.status,
          requestId: options.requestId || null,
          chatId,
          messageId,
        },
      )
      return
    }

    sendFFThinkFixProgress(
      userId,
      source,
      'updating',
      options.requestId,
    )

    await withBackendTimeout(
      spindle.chat.updateMessage(
        chatId,
        messageId,
        {
          content: result.content,
          reasoning: {
            text: result.reasoning,
          },
        },
      ),
      6000,
      'Updating the assistant message',
    )

    sendFFThinkFixResult(
      userId,
      source,
      {
        status: 'fixed',
        requestId: options.requestId || null,
        chatId,
        messageId,
      },
    )

    spindle.log.info(
      `FF think fix (${source}) moved leaked text into native reasoning for ${messageId} in chat ${chatId}`,
    )
  } catch (error: any) {
    const messageText =
      error?.message ||
      String(error) ||
      'Unknown error'

    spindle.log.error(
      `FF think fix (${source}) failed: ${messageText}`,
    )

    sendFFThinkFixResult(
      userId,
      source,
      {
        status: 'error',
        requestId: options.requestId || null,
        error: messageText,
        chatId,
        messageId,
      },
    )
  } finally {
    ffThinkFixInFlight.delete(key)
  }
}

async function findLatestAssistant(
  chatId: string,
  hintedLatestId?: string,
): Promise<any | null> {
  const messages =
    await withBackendTimeout(
      spindle.chat.getMessages(chatId),
      3500,
      'Reading saved chat messages',
    )

  /*
    If the frontend's stable latest-id hint points to an assistant,
    use it. Otherwise walk the authoritative normalized-role list
    backwards and take the newest assistant.
  */
  if (hintedLatestId) {
    const hinted =
      messages.find(
        item => item.id === hintedLatestId
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

spindle.onFrontendMessage(
  async (payload: any, userId: string) => {
    if (
      payload?.type ===
      'ff_think_fix_health'
    ) {
      /*
        Deliberately no RPCs here. If this response does not arrive,
        the backend bundle itself is not running.
      */
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
      ffThinkRuntimeByUser.set(
        userId,
        {
          enabled:
            Boolean(payload.enabled),
          config:
            cleanFFThinkConfig(
              payload.config,
            ),
        },
      )
      return
    }

    if (
      payload?.type ===
      'ff_think_fix_manual'
    ) {
      const chatId =
        typeof payload.chatId === 'string'
          ? payload.chatId
          : ''

      const requestId =
        typeof payload.requestId === 'string'
          ? payload.requestId
          : undefined

      if (!chatId) {
        sendFFThinkFixResult(
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

      sendFFThinkFixProgress(
        userId,
        'manual',
        'reading',
        requestId,
      )

      try {
        const assistant =
          await findLatestAssistant(
            chatId,
            typeof payload.latestMessageId === 'string'
              ? payload.latestMessageId
              : undefined,
          )

        if (!assistant) {
          sendFFThinkFixResult(
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

        await applyFFThinkFixMessage(
          userId,
          chatId,
          assistant,
          {
            source: 'manual',
            requestId,
            config: payload.config,
          },
        )
      } catch (error: any) {
        sendFFThinkFixResult(
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
      return
    }
  },
)

/*
  Register the generation event directly. The manifest already declares
  `generation`; avoiding backend permission-introspection calls makes this
  compatible with hosts whose runtime API lags the newest type package.
*/
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
      ffThinkRuntimeByUser.get(userId)

    if (!runtime?.enabled) return
    if (payload?.error) return

    const chatId =
      typeof payload?.chatId === 'string'
        ? payload.chatId
        : ''

    const messageId =
      typeof payload?.messageId === 'string'
        ? payload.messageId
        : ''

    if (!chatId) return

    try {
      const assistant =
        await findLatestAssistant(
          chatId,
          messageId || undefined,
        )

      if (!assistant) {
        sendFFThinkFixResult(
          userId,
          'auto',
          {
            status: 'no_assistant',
            chatId,
            messageId: messageId || null,
          },
        )
        return
      }

      await applyFFThinkFixMessage(
        userId,
        chatId,
        assistant,
        {
          source: 'auto',
          config: runtime.config,
        },
      )
    } catch (error: any) {
      sendFFThinkFixResult(
        userId,
        'auto',
        {
          status: 'error',
          error:
            error?.message ||
            String(error) ||
            'Unknown error',
          chatId,
          messageId: messageId || null,
        },
      )
    }
  },
)

spindle.log.info('Bionic-style Reading loaded')

