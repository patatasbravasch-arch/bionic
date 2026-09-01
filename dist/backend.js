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

const ffThinkRuntimeByUser = new Map();

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

function sendFFThinkFixResult(userId, source, payload) {
    spindle.sendToFrontend({
        type: 'ff_think_fix_result',
        source,
        ...payload,
    }, userId);
}

async function runFFThinkFix(userId, chatId, options) {
    const source = options.source;
    try {
        const messages = await spindle.chat.getMessages(chatId);
        const message = options.messageId
            ? messages.find(item => item.id === options.messageId)
            : [...messages]
                .reverse()
                .find(item => item.role === 'assistant');
        if (!message) {
            sendFFThinkFixResult(userId, source, {
                status: options.messageId
                    ? 'error'
                    : 'no_assistant',
                error: options.messageId
                    ? 'Saved generated message was not found.'
                    : undefined,
                chatId,
                messageId: options.messageId || null,
            });
            return;
        }
        if (message.role !== 'assistant') {
            sendFFThinkFixResult(userId, source, {
                status: 'not_assistant',
                chatId,
                messageId: message.id,
            });
            return;
        }
        const key = `${userId}:${chatId}:${message.id}`;
        if (ffThinkFixInFlight.has(key)) {
            return;
        }
        ffThinkFixInFlight.add(key);
        try {
            const result = repairFFThinkBlock(message.content || '', message.extra, options.config);
            if (result.status !== 'fixed' ||
                typeof result.content !== 'string' ||
                typeof result.reasoning !== 'string') {
                sendFFThinkFixResult(userId, source, {
                    status: result.status,
                    chatId,
                    messageId: message.id,
                });
                return;
            }
            await spindle.chat.updateMessage(chatId, message.id, {
                content: result.content,
                reasoning: {
                    text: result.reasoning,
                },
            });
            sendFFThinkFixResult(userId, source, {
                status: 'fixed',
                chatId,
                messageId: message.id,
            });
            spindle.log.info(`FF think fix (${source}) moved leaked text into native reasoning for ${message.id} in chat ${chatId}`);
        }
        finally {
            ffThinkFixInFlight.delete(key);
        }
    }
    catch (error) {
        const message = error?.message ||
            String(error) ||
            'Unknown error';
        spindle.log.error(`FF think fix (${source}) failed: ${message}`);
        sendFFThinkFixResult(userId, source, {
            status: 'error',
            error: message,
            chatId,
            messageId: options.messageId || null,
        });
    }
}

spindle.onFrontendMessage(async (payload, userId) => {
    if (payload?.type === 'ff_think_fix_config') {
        ffThinkRuntimeByUser.set(userId, {
            enabled: Boolean(payload.enabled),
            config: cleanFFThinkConfig(payload.config),
        });
        return;
    }
    if (payload?.type === 'ff_think_fix_manual') {
        const chatId = typeof payload.chatId === 'string'
            ? payload.chatId
            : '';
        if (!chatId) {
            sendFFThinkFixResult(userId, 'manual', {
                status: 'error',
                error: 'No current chat ID was provided.',
            });
            return;
        }
        await runFFThinkFix(userId, chatId, {
            source: 'manual',
            config: payload.config,
        });
        return;
    }
    if (payload?.type === 'ff_think_fix_after_generation') {
        const chatId = typeof payload.chatId === 'string'
            ? payload.chatId
            : '';
        const messageId = typeof payload.messageId === 'string'
            ? payload.messageId
            : '';
        if (!chatId || !messageId)
            return;
        await runFFThinkFix(userId, chatId, {
            source: 'auto',
            messageId,
            config: payload.config,
        });
    }
});

let ffGenerationEventsRegistered = false;

function tryRegisterFFGenerationEvents() {
    if (ffGenerationEventsRegistered)
        return;
    if (!spindle.permissions.has('generation'))
        return;
    spindle.on('GENERATION_ENDED', async (payload, userId) => {
        if (typeof userId !== 'string' || !userId) {
            return;
        }
        const runtime = ffThinkRuntimeByUser.get(userId);
        if (!runtime?.enabled)
            return;
        const chatId = typeof payload?.chatId === 'string'
            ? payload.chatId
            : '';
        const messageId = typeof payload?.messageId === 'string'
            ? payload.messageId
            : '';
        if (!chatId || !messageId)
            return;
        if (payload?.error)
            return;
        await runFFThinkFix(userId, chatId, {
            source: 'auto',
            messageId,
            config: runtime.config,
        });
    });
    ffGenerationEventsRegistered = true;
    spindle.log.info('FF think fix backend GENERATION_ENDED listener registered.');
}

tryRegisterFFGenerationEvents();

spindle.permissions.onChanged(({ permission, granted }) => {
    if (permission === 'generation' && granted) {
        tryRegisterFFGenerationEvents();
    }
});

spindle.log.info('Bionic-style Reading loaded');

