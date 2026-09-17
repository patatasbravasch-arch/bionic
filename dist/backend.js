const FF_THINK_FIX_VERSION = '0.48.0';
const DEFAULT_FF_THINK_CONFIG = {
    boundaryText: '[ 🕰️ Time',
    reasoningSide: 'before',
    includeMarker: false,
};
const runtimeByUser = new Map();
const SETTINGS_STORAGE_PATH = 'settings/bionic-reading-settings.json';
const inFlight = new Set();

function cleanConfig(raw) {
    return {
        boundaryText: typeof raw?.boundaryText === 'string'
            ? raw.boundaryText.slice(0, 1000)
            : DEFAULT_FF_THINK_CONFIG.boundaryText,
        reasoningSide: raw?.reasoningSide === 'after'
            ? 'after'
            : 'before',
        includeMarker: raw?.includeMarker === true,
    };
}
function existingReasoning(message) {
    return typeof message?.extra?.reasoning === 'string'
        ? message.extra.reasoning.trim()
        : '';
}
function splitMessage(message, rawConfig) {
    const config = cleanConfig(rawConfig);
    if (!config.boundaryText)
        return { status: 'no_match' };
    const content = typeof message?.content === 'string'
        ? message.content
        : '';
    const boundaryIndex = content.indexOf(config.boundaryText);
    if (boundaryIndex < 0)
        return { status: 'no_match' };
    const boundaryEnd = boundaryIndex + config.boundaryText.length;
    const before = content.slice(0, boundaryIndex);
    const marker = content.slice(boundaryIndex, boundaryEnd);
    const after = content.slice(boundaryEnd);
    const leakedRaw = config.reasoningSide === 'after'
        ? (config.includeMarker ? `${marker}${after}` : after)
        : (config.includeMarker ? `${before}${marker}` : before);
    const leaked = leakedRaw.trim();
    if (!leaked) {
        return existingReasoning(message)
            ? { status: 'already_fixed' }
            : { status: 'no_match' };
    }
    const prior = existingReasoning(message);
    const reasoning = !prior
        ? leaked
        : prior.includes(leaked)
            ? prior
            : `${prior}\n\n${leaked}`;
    const visibleContent = config.reasoningSide === 'after'
        ? (config.includeMarker ? before : content.slice(0, boundaryEnd))
        : (config.includeMarker ? after : content.slice(boundaryIndex));
    return {
        status: 'fixed',
        content: visibleContent,
        reasoning,
        reasoningSide: config.reasoningSide,
        includeMarker: config.includeMarker,
    };
}
function sendResult(userId, source, payload) {
    spindle.sendToFrontend({
        type: 'ff_think_fix_result',
        source,
        version: FF_THINK_FIX_VERSION,
        ...payload,
    }, userId);
}
function sendProgress(userId, source, stage, requestId) {
    spindle.sendToFrontend({
        type: 'ff_think_fix_progress',
        source,
        stage,
        requestId: requestId || null,
        version: FF_THINK_FIX_VERSION,
    }, userId);
}
async function timeout(promise, ms, label) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(
                    () => reject(
                        new Error(
                            `${label} timed out after ${Math.round(ms / 1000)}s`
                        )
                    ),
                    ms
                );
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
async function latestAssistant(chatId, hintedMessageId) {
    const messages = await timeout(
        spindle.chat.getMessages(chatId),
        4000,
        'Reading chat messages'
    );
    if (hintedMessageId) {
        const hinted = messages.find(
            message => message.id === hintedMessageId
        );
        if (hinted?.role === 'assistant')
            return hinted;
    }
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'assistant')
            return messages[i];
    }
    return null;
}
async function repairMessage(
    userId,
    chatId,
    message,
    source,
    config,
    requestId
) {
    const messageId = typeof message?.id === 'string'
        ? message.id
        : '';
    if (!messageId) {
        sendResult(userId, source, {
            status: 'error',
            requestId: requestId || null,
            error: 'Assistant message has no id.',
            chatId,
        });
        return;
    }
    const key = `${userId}:${chatId}:${messageId}`;
    if (inFlight.has(key)) {
        sendResult(userId, source, {
            status: 'busy',
            requestId: requestId || null,
            chatId,
            messageId,
        });
        return;
    }
    inFlight.add(key);
    try {
        const split = splitMessage(message, config);
        if (split.status !== 'fixed') {
            sendResult(userId, source, {
                status: split.status,
                requestId: requestId || null,
                chatId,
                messageId,
            });
            return;
        }
        sendProgress(userId, source, 'updating', requestId);
        await timeout(
            spindle.chat.updateMessage(chatId, messageId, {
                content: split.content,
                reasoning: {
                    text: split.reasoning,
                },
            }),
            7000,
            'Updating message reasoning'
        );
        sendResult(userId, source, {
            status: 'fixed',
            requestId: requestId || null,
            chatId,
            messageId,
            reasoningSide: split.reasoningSide,
            includeMarker: split.includeMarker,
        });
        spindle.log.info(
            `FF think fix (${source}) repaired ${messageId}`
        );
    }
    catch (error) {
        const messageText =
            error?.message || String(error) || 'Unknown error';
        spindle.log.error(
            `FF think fix (${source}) failed: ${messageText}`
        );
        sendResult(userId, source, {
            status: 'error',
            requestId: requestId || null,
            error: messageText,
            chatId,
            messageId,
        });
    }
    finally {
        inFlight.delete(key);
    }
}

spindle.onFrontendMessage(async (payload, userId) => {
    if (payload?.type === 'bionic_settings_load') {
        try {
            const saved = await spindle.userStorage.getJson(SETTINGS_STORAGE_PATH, { userId });
            spindle.sendToFrontend({
                type: 'bionic_settings_loaded',
                settings: saved && typeof saved === 'object' ? saved : null,
            }, userId);
        }
        catch {
            spindle.sendToFrontend({
                type: 'bionic_settings_loaded',
                settings: null,
            }, userId);
        }
        return;
    }
    if (payload?.type === 'bionic_settings_save') {
        try {
            const incoming = payload?.settings;
            if (!incoming || typeof incoming !== 'object') {
                throw new Error('Invalid settings payload');
            }
            await spindle.userStorage.setJson(SETTINGS_STORAGE_PATH, incoming, { userId });
            spindle.sendToFrontend({
                type: 'bionic_settings_saved',
                ok: true,
            }, userId);
        }
        catch (error) {
            spindle.log.warn(`Bionic settings save failed: ${error?.message || String(error)}`);
            spindle.sendToFrontend({
                type: 'bionic_settings_saved',
                ok: false,
            }, userId);
        }
        return;
    }
    if (payload?.type === 'ff_think_fix_health') {
        spindle.sendToFrontend({
            type: 'ff_think_fix_health',
            version: FF_THINK_FIX_VERSION,
        }, userId);
        return;
    }
    if (payload?.type === 'ff_think_fix_config') {
        runtimeByUser.set(userId, {
            enabled: Boolean(payload.enabled),
            config: cleanConfig(payload.config),
        });
        return;
    }
    if (payload?.type !== 'ff_think_fix_manual')
        return;

    const chatId = typeof payload.chatId === 'string'
        ? payload.chatId
        : '';
    const requestId = typeof payload.requestId === 'string'
        ? payload.requestId
        : undefined;

    if (!chatId) {
        sendResult(userId, 'manual', {
            status: 'error',
            requestId: requestId || null,
            error: 'No current chat id was provided.',
        });
        return;
    }

    sendProgress(userId, 'manual', 'reading', requestId);

    try {
        const assistant = await latestAssistant(
            chatId,
            typeof payload.latestMessageId === 'string'
                ? payload.latestMessageId
                : undefined
        );
        if (!assistant) {
            sendResult(userId, 'manual', {
                status: 'no_assistant',
                requestId: requestId || null,
                chatId,
            });
            return;
        }
        await repairMessage(
            userId,
            chatId,
            assistant,
            'manual',
            payload.config,
            requestId
        );
    }
    catch (error) {
        sendResult(userId, 'manual', {
            status: 'error',
            requestId: requestId || null,
            error: error?.message || String(error) || 'Unknown error',
            chatId,
        });
    }
});

try {
    spindle.on('GENERATION_ENDED', async (payload, userId) => {
        if (typeof userId !== 'string' || !userId)
            return;
        const runtime = runtimeByUser.get(userId);
        if (!runtime?.enabled)
            return;
        if (payload?.error)
            return;
        const chatId = typeof payload?.chatId === 'string'
            ? payload.chatId
            : '';
        if (!chatId)
            return;
        try {
            const assistant = await latestAssistant(
                chatId,
                typeof payload?.messageId === 'string'
                    ? payload.messageId
                    : undefined
            );
            if (!assistant) {
                sendResult(userId, 'auto', {
                    status: 'no_assistant',
                    chatId,
                    messageId: payload?.messageId || null,
                });
                return;
            }
            await repairMessage(
                userId,
                chatId,
                assistant,
                'auto',
                runtime.config
            );
        }
        catch (error) {
            sendResult(userId, 'auto', {
                status: 'error',
                error: error?.message || String(error) || 'Unknown error',
                chatId,
                messageId: payload?.messageId || null,
            });
        }
    });
}
catch (error) {
    spindle.log.warn(
        `FF automatic listener not registered: ${
            error?.message || String(error)
        }`
    );
}


// Ken sleep alert temporarily disabled in v0.28.
if (false) spindle.on('MESSAGE_SENT', async (payload, userId) => {
    const chatId = typeof payload?.chatId === 'string'
        ? payload.chatId
        : (typeof payload?.message?.chat_id === 'string'
            ? payload.message.chat_id
            : '');
    if (!chatId)
        return;

    let personaName = '';

    try {
        const persona = await spindle.personas.getActive(userId);

        if (persona?.name) {
            personaName = persona.name;
        }
        else {
            const defaultPersona =
                await spindle.personas.getDefault(userId);
            personaName = defaultPersona?.name || '';
        }
    }
    catch (error) {
        spindle.log.warn(
            `Ken sleep reminder could not resolve active persona: ${
                error?.message || String(error)
            }`
        );
        return;
    }

    spindle.sendToFrontend({
        type: 'ken_sleep_message_sent',
        chatId,
        personaName,
        messageId: typeof payload?.message?.id === 'string'
            ? payload.message.id
            : null,
    }, userId);
});

spindle.log.info(
    `Bionic Reading & Fonts FF backend v${FF_THINK_FIX_VERSION} loaded`
);
