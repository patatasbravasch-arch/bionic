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


const FF_THINK_FIX_VERSION = '0.24.0';
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
    if (!boundary)
        return { status: 'no_match' };
    const boundaryIndex = content.indexOf(boundary);
    if (boundaryIndex < 0)
        return { status: 'no_match' };
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
    if (!reasoning.trim())
        return { status: 'no_match' };
    return {
        status: 'fixed',
        content: visibleContent,
        reasoning,
    };
}
async function withBackendTimeout(promise, ms, label) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
function sendFFThinkFixResult(userId, source, payload) {
    spindle.sendToFrontend({
        type: 'ff_think_fix_result',
        source,
        version: FF_THINK_FIX_VERSION,
        ...payload,
    }, userId);
}
function sendFFThinkFixProgress(userId, source, requestId) {
    spindle.sendToFrontend({
        type: 'ff_think_fix_progress',
        source,
        requestId: requestId || null,
        version: FF_THINK_FIX_VERSION,
    }, userId);
}
async function applyFFThinkFixSnapshot(userId, chatId, snapshot, options) {
    const source = options.source;
    const key = `${userId}:${chatId}:${snapshot.id}`;
    if (ffThinkFixInFlight.has(key)) {
        sendFFThinkFixResult(userId, source, {
            status: 'busy',
            requestId: options.requestId || null,
            chatId,
            messageId: snapshot.id,
        });
        return;
    }
    ffThinkFixInFlight.add(key);
    sendFFThinkFixProgress(userId, source, options.requestId);
    try {
        const result = repairFFThinkBlock(snapshot.content || '', snapshot.extra, options.config);
        if (result.status !== 'fixed' ||
            typeof result.content !== 'string' ||
            typeof result.reasoning !== 'string') {
            sendFFThinkFixResult(userId, source, {
                status: result.status,
                requestId: options.requestId || null,
                chatId,
                messageId: snapshot.id,
            });
            return;
        }
        await withBackendTimeout(spindle.chat.updateMessage(chatId, snapshot.id, {
            content: result.content,
            reasoning: {
                text: result.reasoning,
            },
        }), 7000, 'Updating the message');
        sendFFThinkFixResult(userId, source, {
            status: 'fixed',
            requestId: options.requestId || null,
            chatId,
            messageId: snapshot.id,
        });
        spindle.log.info(`FF think fix (${source}) moved leaked text into native reasoning for ${snapshot.id} in chat ${chatId}`);
    }
    catch (error) {
        const message = error?.message ||
            String(error) ||
            'Unknown error';
        spindle.log.error(`FF think fix (${source}) failed: ${message}`);
        sendFFThinkFixResult(userId, source, {
            status: 'error',
            requestId: options.requestId || null,
            error: message,
            chatId,
            messageId: snapshot.id,
        });
    }
    finally {
        ffThinkFixInFlight.delete(key);
    }
}
async function getSavedMessageSnapshot(chatId, messageId) {
    const messages = await withBackendTimeout(spindle.chat.getMessages(chatId), 2500, 'Reading the saved message');
    const message = messages.find(item => item.id === messageId);
    if (!message)
        return null;
    if (message.role !== 'assistant')
        return null;
    return {
        id: message.id,
        content: message.content || '',
        extra: message.extra || {},
    };
}
spindle.onFrontendMessage(async (payload, userId) => {
    if (payload?.type === 'ff_think_fix_health') {
        let permissions = [];
        try {
            permissions = await withBackendTimeout(spindle.permissions.getGranted(), 2500, 'Reading permissions');
        }
        catch {
            permissions = [];
        }
        spindle.sendToFrontend({
            type: 'ff_think_fix_health',
            version: FF_THINK_FIX_VERSION,
            permissions,
        }, userId);
        return;
    }
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
        const rawMessage = payload?.message &&
            typeof payload.message === 'object'
            ? payload.message
            : null;
        const messageId = typeof rawMessage?.id === 'string'
            ? rawMessage.id
            : '';
        const content = typeof rawMessage?.content === 'string'
            ? rawMessage.content
            : '';
        const extra = rawMessage?.extra &&
            typeof rawMessage.extra === 'object'
            ? rawMessage.extra
            : {};
        if (!chatId || !messageId) {
            sendFFThinkFixResult(userId, 'manual', {
                status: 'error',
                requestId: typeof payload.requestId === 'string'
                    ? payload.requestId
                    : null,
                error: 'The frontend did not provide a current chat and exact message snapshot.',
            });
            return;
        }
        await applyFFThinkFixSnapshot(userId, chatId, {
            id: messageId,
            content,
            extra,
        }, {
            source: 'manual',
            requestId: typeof payload.requestId === 'string'
                ? payload.requestId
                : undefined,
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
        try {
            const snapshot = await getSavedMessageSnapshot(chatId, messageId);
            if (!snapshot) {
                sendFFThinkFixResult(userId, 'auto', {
                    status: 'error',
                    error: 'Saved generated assistant message was not found.',
                    chatId,
                    messageId,
                });
                return;
            }
            await applyFFThinkFixSnapshot(userId, chatId, snapshot, {
                source: 'auto',
                config: payload.config,
            });
        }
        catch (error) {
            sendFFThinkFixResult(userId, 'auto', {
                status: 'error',
                error: error?.message ||
                    String(error) ||
                    'Unknown error',
                chatId,
                messageId,
            });
        }
    }
});
let ffGenerationEventsRegistered = false;
function tryRegisterFFGenerationEvents() {
    if (ffGenerationEventsRegistered)
        return;
    if (!spindle.permissions.has('generation'))
        return;
    spindle.on('GENERATION_ENDED', async (payload, userId) => {
        if (typeof userId !== 'string' || !userId)
            return;
        const runtime = ffThinkRuntimeByUser.get(userId);
        if (!runtime?.enabled)
            return;
        if (payload?.error)
            return;
        const chatId = typeof payload?.chatId === 'string'
            ? payload.chatId
            : '';
        const messageId = typeof payload?.messageId === 'string'
            ? payload.messageId
            : '';
        if (!chatId || !messageId)
            return;
        let snapshot = null;
        try {
            snapshot = await getSavedMessageSnapshot(chatId, messageId);
        }
        catch (error) {
            spindle.log.warn(`FF think fix auto read fallback: ${error instanceof Error
                ? error.message
                : String(error)}`);
        }
        if (!snapshot) {
            const content = typeof payload?.content === 'string'
                ? payload.content
                : '';
            if (!content) {
                sendFFThinkFixResult(userId, 'auto', {
                    status: 'error',
                    error: 'Generation ended but neither the saved message nor final content could be read.',
                    chatId,
                    messageId,
                });
                return;
            }
            snapshot = {
                id: messageId,
                content,
                extra: {},
            };
        }
        await applyFFThinkFixSnapshot(userId, chatId, snapshot, {
            source: 'auto',
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

