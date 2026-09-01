import { transformMarkdownForBionic } from './transform';
const CACHE_LIMIT = 512;
const renderCache = new Map();
function fnv1a(value) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16);
}
function getCacheKey(ctx) {
    return [
        ctx.userId,
        ctx.chatId,
        ctx.messageId ?? 'no-message-id',
        ctx.content.length,
        fnv1a(ctx.content),
    ].join(':');
}
function putCache(key, value) {
    if (renderCache.has(key))
        renderCache.delete(key);
    renderCache.set(key, value);
    if (renderCache.size > CACHE_LIMIT) {
        const oldest = renderCache.keys().next().value;
        if (oldest !== undefined)
            renderCache.delete(oldest);
    }
}
spindle.registerMessageContentProcessor(async (ctx) => {
    // Critical: render-only means stored history, prompts, memories, and exports stay untouched.
    if (ctx.origin !== 'render' || !ctx.content)
        return;
    const key = getCacheKey(ctx);
    const cached = renderCache.get(key);
    if (cached !== undefined)
        return { content: cached };
    const content = transformMarkdownForBionic(ctx.content);
    putCache(key, content);
    return { content };
}, 100);
// Lumiverse invokes render processing twice per visible message. Clear our small
// dedupe cache when message state changes so stale transforms cannot linger.
spindle.on('CHAT_CHANGED', () => renderCache.clear());
spindle.on('MESSAGE_EDITED', () => renderCache.clear());
spindle.on('MESSAGE_SWIPED', () => renderCache.clear());
spindle.on('MESSAGE_DELETED', () => renderCache.clear());


const ffThinkFixInFlight = new Set();

const DEFAULT_FF_THINK_CONFIG = {
    boundaryText: '[ 🕰️ Time',
};

function cleanFFThinkConfig(raw) {
    return {
        boundaryText: typeof raw?.boundaryText === 'string'
            ? raw.boundaryText.slice(0, 1000)
            : DEFAULT_FF_THINK_CONFIG.boundaryText,
    };
}

function normalizeExistingReasoning(extra) {
    const value = extra?.reasoning;
    return typeof value === 'string'
        ? value.trim()
        : '';
}

function mergeReasoning(existing, leakedPrefix) {
    const prefix = leakedPrefix.trim();
    if (!existing)
        return prefix;
    if (!prefix)
        return existing;
    if (existing.includes(prefix))
        return existing;
    return `${existing}\n\n${prefix}`;
}

function repairFFThinkBlock(content, extra, rawConfig) {
    const config = cleanFFThinkConfig(rawConfig);
    const boundary = config.boundaryText;
    if (!boundary) {
        return { status: 'no_match' };
    }
    const boundaryIndex = content.indexOf(boundary);
    if (boundaryIndex < 0) {
        return { status: 'no_match' };
    }
    const leakedPrefix = content.slice(0, boundaryIndex);
    if (!leakedPrefix.trim()) {
        const existingReasoning = normalizeExistingReasoning(extra);
        return existingReasoning
            ? { status: 'already_fixed' }
            : { status: 'no_match' };
    }
    const visibleContent = content.slice(boundaryIndex);
    const existingReasoning = normalizeExistingReasoning(extra);
    const reasoning = mergeReasoning(existingReasoning, leakedPrefix);
    if (!reasoning.trim()) {
        return { status: 'no_match' };
    }
    return {
        status: 'fixed',
        content: visibleContent,
        reasoning,
    };
}

function sendFFThinkFixResult(userId, payload) {
    spindle.sendToFrontend({
        type: 'ff_think_fix_result',
        ...payload,
    }, userId);
}

spindle.onFrontendMessage(async (payload, userId) => {
    if (payload?.type !== 'ff_think_fix_after_generation') {
        return;
    }
    const chatId = typeof payload.chatId === 'string'
        ? payload.chatId
        : '';
    const messageId = typeof payload.messageId === 'string'
        ? payload.messageId
        : '';
    if (!chatId || !messageId)
        return;
    const key = `${userId}:${chatId}:${messageId}`;
    if (ffThinkFixInFlight.has(key))
        return;
    ffThinkFixInFlight.add(key);
    try {
        const messages = await spindle.chat.getMessages(chatId);
        const message = messages.find(item => item.id === messageId);
        if (!message) {
            sendFFThinkFixResult(userId, {
                status: 'error',
                error: 'Saved message was not found.',
                chatId,
                messageId,
            });
            return;
        }
        if (message.role !== 'assistant') {
            sendFFThinkFixResult(userId, {
                status: 'not_assistant',
                chatId,
                messageId,
            });
            return;
        }
        const result = repairFFThinkBlock(
            message.content || '',
            message.extra,
            payload.config
        );
        if (result.status !== 'fixed' ||
            typeof result.content !== 'string' ||
            typeof result.reasoning !== 'string') {
            sendFFThinkFixResult(userId, {
                status: result.status,
                chatId,
                messageId,
            });
            return;
        }
        await spindle.chat.updateMessage(chatId, messageId, {
            content: result.content,
            reasoning: {
                text: result.reasoning,
            },
        });
        sendFFThinkFixResult(userId, {
            status: 'fixed',
            chatId,
            messageId,
        });
        spindle.log.info(`FF think fix moved leaked text into native reasoning for ${messageId} in chat ${chatId}`);
    }
    catch (error) {
        const message = error?.message ||
            String(error) ||
            'Unknown error';
        spindle.log.error(`FF think fix failed: ${message}`);
        sendFFThinkFixResult(userId, {
            status: 'error',
            error: message,
            chatId,
            messageId,
        });
    }
    finally {
        ffThinkFixInFlight.delete(key);
    }
});

spindle.log.info('Bionic-style Reading loaded');

