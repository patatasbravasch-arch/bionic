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

spindle.log.info('Bionic-style Reading loaded')
