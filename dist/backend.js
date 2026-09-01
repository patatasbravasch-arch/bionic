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

function repairFFThinkBlock(content) {
    const marker = '**Task 0:**';
    const taskIndex = content.indexOf(marker);
    if (taskIndex < 0) {
        return { status: 'no_match' };
    }
    const lower = content.toLowerCase();
    const beforeTask = lower.slice(0, taskIndex);
    const lastOpen = beforeTask.lastIndexOf('<think>');
    const lastClose = beforeTask.lastIndexOf('</think>');
    if (lastOpen > lastClose) {
        return { status: 'already_fixed' };
    }
    if (lower
        .slice(Math.max(0, taskIndex - 32), taskIndex)
        .match(/<think>\s*$/)) {
        return { status: 'already_fixed' };
    }
    const afterMarkerStart = taskIndex + marker.length;
    const afterMarker = content.slice(afterMarkerStart);
    const divider = /^[ \t]*---[ \t]*\r?$/m.exec(afterMarker);
    if (!divider || divider.index == null) {
        return { status: 'no_match' };
    }
    const dividerStart = afterMarkerStart + divider.index;
    const between = lower.slice(taskIndex, dividerStart);
    if (between.includes('</think>')) {
        return { status: 'already_fixed' };
    }
    const dividerEnd = dividerStart + divider[0].length;
    const repaired = content.slice(0, taskIndex) +
        '<think>' +
        content.slice(taskIndex, dividerStart) +
        '</think>' +
        content.slice(dividerEnd);
    if (repaired === content) {
        return { status: 'already_fixed' };
    }
    return { status: 'fixed', content: repaired };
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
        const result = repairFFThinkBlock(message.content || '');
        if (result.status !== 'fixed' ||
            typeof result.content !== 'string') {
            sendFFThinkFixResult(userId, {
                status: result.status,
                chatId,
                messageId,
            });
            return;
        }
        await spindle.chat.updateMessage(chatId, messageId, {
            content: result.content,
        });
        sendFFThinkFixResult(userId, {
            status: 'fixed',
            chatId,
            messageId,
        });
        spindle.log.info(`FF think fix repaired assistant message ${messageId} in chat ${chatId}`);
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

