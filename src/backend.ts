declare const spindle: import('lumiverse-spindle-types').SpindleAPI

const FF_THINK_FIX_VERSION = '0.27.0'

type FFThinkFixConfig = {
  boundaryText: string
}

type FFThinkRuntimeConfig = {
  enabled: boolean
  config: FFThinkFixConfig
}

type FFThinkFixSource = 'manual' | 'auto'

const DEFAULT_FF_THINK_CONFIG: FFThinkFixConfig = {
  boundaryText: '[ 🕰️ Time',
}

const runtimeByUser =
  new Map<string, FFThinkRuntimeConfig>()

const inFlight =
  new Set<string>()

function cleanConfig(raw: any): FFThinkFixConfig {
  return {
    boundaryText:
      typeof raw?.boundaryText === 'string'
        ? raw.boundaryText.slice(0, 1000)
        : DEFAULT_FF_THINK_CONFIG.boundaryText,
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

  const prefix =
    content.slice(0, boundaryIndex)

  if (!prefix.trim()) {
    return existingReasoning(message)
      ? { status: 'already_fixed' }
      : { status: 'no_match' }
  }

  const prior =
    existingReasoning(message)

  const leaked =
    prefix.trim()

  const reasoning =
    !prior
      ? leaked
      : prior.includes(leaked)
        ? prior
        : `${prior}\n\n${leaked}`

  return {
    status: 'fixed',
    content: content.slice(boundaryIndex),
    reasoning,
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

/*
  Register frontend RPC first. This means the health ping is available
  even if generation-event registration is rejected for permissions.
*/
spindle.onFrontendMessage(
  async (payload: any, userId: string) => {
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
spindle.on(
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

