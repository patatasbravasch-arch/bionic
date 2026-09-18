// @bun
// src/lorebook-organizer-backend.ts
function organizerSend(spindleApi, userId, payload) {
  spindleApi.sendToFrontend(payload, userId);
}
function generationText(result) {
  if (typeof result === "string") {
    return result;
  }
  const direct = [
    result?.text,
    result?.content,
    result?.response,
    result?.output_text,
    result?.message?.content,
    result?.assistant_message?.content
  ];
  for (const value of direct) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  const choice = result?.choices?.[0];
  if (typeof choice?.message?.content === "string") {
    return choice.message.content;
  }
  if (typeof choice?.text === "string") {
    return choice.text;
  }
  return "";
}
function parseJsonResult(raw) {
  let text = String(raw || "").trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    return JSON.parse(text);
  } catch {}
  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    return JSON.parse(text.slice(objectStart, objectEnd + 1));
  }
  throw new Error("The LLM did not return valid JSON.");
}
function sanitizeOrganizerBooks(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => item && typeof item === "object" && typeof item.id === "string" && typeof item.name === "string").slice(0, 1000).map((item) => ({
    id: item.id,
    name: item.name.slice(0, 300),
    folder: typeof item.folder === "string" ? item.folder.slice(0, 300) : "",
    description: typeof item.description === "string" ? item.description.slice(0, 1200) : "",
    entryCount: Number.isFinite(Number(item.entryCount)) ? Number(item.entryCount) : 0,
    sampleKeys: Array.isArray(item.sampleKeys) ? item.sampleKeys.filter((key) => typeof key === "string").slice(0, 12).map((key) => key.slice(0, 160)) : []
  }));
}
function sanitizeSuggestions(parsed, books) {
  const knownIds = new Set(books.map((book) => book.id));
  const folders = Array.isArray(parsed?.folders) ? parsed.folders : [];
  const usedIds = new Set;
  const clean = [];
  for (const folder of folders) {
    if (!folder || typeof folder !== "object") {
      continue;
    }
    const name = typeof folder.name === "string" ? folder.name.trim() : "";
    if (!name)
      continue;
    const ids = Array.from(new Set((Array.isArray(folder.book_ids) ? folder.book_ids : Array.isArray(folder.bookIds) ? folder.bookIds : []).filter((id) => typeof id === "string" && knownIds.has(id) && !usedIds.has(id))));
    if (ids.length < 2) {
      continue;
    }
    for (const id of ids) {
      usedIds.add(id);
    }
    clean.push({
      name: name.slice(0, 120),
      bookIds: ids,
      reason: typeof folder.reason === "string" ? folder.reason.trim().slice(0, 500) : ""
    });
  }
  return clean;
}
function organizerPrompt(books) {
  const compact = books.map((book) => ({
    id: book.id,
    name: book.name,
    current_folder: book.folder || "",
    description: book.description || "",
    entry_count: book.entryCount || 0,
    representative_keys: book.sampleKeys || []
  }));
  return `
You are organizing a Lumiverse lorebook library.

Your ONLY task is to propose folders that gather related
lorebooks together.

Do not delete books.
Do not merge books.
Do not rename books.
Do not rewrite lorebook contents.
Do not invent book IDs.
Do not put a book into more than one suggested folder.

Prefer useful thematic folders containing at least 2 books.
Leave unrelated books ungrouped rather than forcing them
into bad categories.

Return ONLY valid JSON in this exact shape:

{
  "folders": [
    {
      "name": "Folder name",
      "book_ids": ["exact-id-1", "exact-id-2"],
      "reason": "Short explanation"
    }
  ]
}

LOREBOOK LIBRARY:
${JSON.stringify(compact)}
`.trim();
}
async function organizerListAll(api, userId, label) {
  if (!api || typeof api.list !== "function") {
    throw new Error(`${label} list API is unavailable. Cleanup was stopped safely.`);
  }
  const all = [];
  let offset = 0;
  for (let pageNo = 0;pageNo < 1000; pageNo += 1) {
    let page;
    try {
      page = await api.list({
        limit: 200,
        offset,
        userId
      });
    } catch (error) {
      if (offset !== 0)
        throw error;
      page = await api.list(userId);
    }
    if (Array.isArray(page)) {
      return page;
    }
    const data = Array.isArray(page?.data) ? page.data : [];
    all.push(...data);
    const total = Number(page?.total ?? all.length);
    if (data.length === 0 || all.length >= total) {
      return all;
    }
    offset += data.length;
  }
  throw new Error(`${label} scan exceeded the pagination safety limit.`);
}
function organizerStrings(value) {
  if (!Array.isArray(value))
    return [];
  return Array.from(new Set(value.filter((item) => typeof item === "string" && item.length > 0)));
}
function organizerCharacterBookIds(character) {
  if (Array.isArray(character?.world_book_ids)) {
    return organizerStrings(character.world_book_ids);
  }
  const ext = character?.extensions && typeof character.extensions === "object" ? character.extensions : {};
  if (Array.isArray(ext.world_book_ids)) {
    return organizerStrings(ext.world_book_ids);
  }
  if (typeof ext.world_book_id === "string" && ext.world_book_id) {
    return [ext.world_book_id];
  }
  return [];
}
async function organizerHydrateItems(api, items, userId, label, complete) {
  const result = [];
  for (const item of items) {
    if (complete(item)) {
      result.push(item);
      continue;
    }
    if (typeof item?.id !== "string" || !item.id) {
      throw new Error(`${label} list returned an incomplete record without an id. Cleanup was stopped safely.`);
    }
    if (!api || typeof api.get !== "function") {
      throw new Error(`${label} ${item.id} is missing reference data and the detail API is unavailable. Cleanup was stopped safely.`);
    }
    const detailed = await api.get(item.id, userId);
    if (!detailed || !complete(detailed)) {
      throw new Error(`${label} ${item.id} still has incomplete reference data after hydration. Cleanup was stopped safely.`);
    }
    result.push(detailed);
  }
  return result;
}
async function organizerReferenceSnapshot(spindleApi, userId) {
  const chatsApi = spindleApi.chats || spindleApi.chat;
  const [
    listedCharacters,
    listedChats,
    listedPersonas,
    globalIds
  ] = await Promise.all([
    organizerListAll(spindleApi.characters, userId, "Character"),
    organizerListAll(chatsApi, userId, "Chat"),
    organizerListAll(spindleApi.personas, userId, "Persona"),
    spindleApi.world_books.getGlobal(userId)
  ]);
  const characters = await organizerHydrateItems(spindleApi.characters, listedCharacters, userId, "Character", (item) => Array.isArray(item?.world_book_ids) || item?.extensions && typeof item.extensions === "object");
  const chats = await organizerHydrateItems(chatsApi, listedChats, userId, "Chat", (item) => item?.metadata && typeof item.metadata === "object");
  const personas = await organizerHydrateItems(spindleApi.personas, listedPersonas, userId, "Persona", (item) => Object.prototype.hasOwnProperty.call(item || {}, "attached_world_book_id"));
  return {
    characters: characters.filter((item) => item && typeof item.id === "string").map((item) => ({
      id: item.id,
      name: item.name || "Unnamed character",
      world_book_ids: organizerCharacterBookIds(item)
    })),
    chats: chats.filter((item) => item && typeof item.id === "string").map((item) => ({
      id: item.id,
      title: item.title || item.name || "Unnamed chat",
      metadata: {
        chat_world_book_ids: organizerStrings(item.metadata.chat_world_book_ids)
      }
    })),
    personas: personas.filter((item) => item && typeof item.id === "string").map((item) => ({
      id: item.id,
      name: item.name || "Unnamed persona",
      attached_world_book_id: typeof item.attached_world_book_id === "string" ? item.attached_world_book_id : null
    })),
    globalIds: organizerStrings(globalIds)
  };
}
async function handleLorebookOrganizerMessage(spindleApi, payload, userId) {
  const type = payload?.type;
  if (type === "bionic_lore_reference_snapshot") {
    const requestId = payload?.requestId || null;
    try {
      const snapshot = await organizerReferenceSnapshot(spindleApi, userId);
      organizerSend(spindleApi, userId, {
        type: "bionic_lore_reference_snapshot_result",
        requestId,
        snapshot
      });
    } catch (error) {
      organizerSend(spindleApi, userId, {
        type: "bionic_lore_reference_snapshot_result",
        requestId,
        error: error?.message || String(error)
      });
    }
    return true;
  }
  if (type === "bionic_lore_relink_personas") {
    const requestId = payload?.requestId || null;
    try {
      const assignments = Array.isArray(payload?.assignments) ? payload.assignments.filter((item) => item && typeof item.id === "string" && typeof item.bookId === "string").slice(0, 1000) : [];
      if (!assignments.length) {
        organizerSend(spindleApi, userId, {
          type: "bionic_lore_relink_personas_result",
          requestId,
          personas: []
        });
        return true;
      }
      const personasApi = spindleApi.personas;
      if (!personasApi || typeof personasApi.update !== "function") {
        throw new Error("Persona update API is unavailable. Duplicate deletion was stopped safely.");
      }
      const updated = [];
      for (const assignment of assignments) {
        const persona = await personasApi.update(assignment.id, {
          attached_world_book_id: assignment.bookId
        }, userId);
        if (persona?.attached_world_book_id !== assignment.bookId) {
          throw new Error(`Persona ${assignment.id} did not verify after relinking.`);
        }
        updated.push({
          id: persona.id,
          name: persona.name || "Unnamed persona",
          attached_world_book_id: persona.attached_world_book_id
        });
      }
      organizerSend(spindleApi, userId, {
        type: "bionic_lore_relink_personas_result",
        requestId,
        personas: updated
      });
    } catch (error) {
      organizerSend(spindleApi, userId, {
        type: "bionic_lore_relink_personas_result",
        requestId,
        error: error?.message || String(error)
      });
    }
    return true;
  }
  if (type === "bionic_lore_set_global") {
    const requestId = payload?.requestId || null;
    try {
      const ids = organizerStrings(payload?.ids);
      const result = await spindleApi.world_books.setGlobal(ids, userId);
      const verified = organizerStrings(result);
      if (JSON.stringify(verified) !== JSON.stringify(ids)) {
        throw new Error("Global lorebook references did not verify after relinking.");
      }
      organizerSend(spindleApi, userId, {
        type: "bionic_lore_set_global_result",
        requestId,
        ids: verified
      });
    } catch (error) {
      organizerSend(spindleApi, userId, {
        type: "bionic_lore_set_global_result",
        requestId,
        error: error?.message || String(error)
      });
    }
    return true;
  }
  if (type === "bionic_lore_global_ids") {
    try {
      const ids = await spindleApi.world_books.getGlobal(userId);
      organizerSend(spindleApi, userId, {
        type: "bionic_lore_global_ids_result",
        requestId: payload?.requestId || null,
        ids: Array.isArray(ids) ? ids : []
      });
    } catch (error) {
      organizerSend(spindleApi, userId, {
        type: "bionic_lore_global_ids_result",
        requestId: payload?.requestId || null,
        error: error?.message || String(error)
      });
    }
    return true;
  }
  if (type === "bionic_lore_connections") {
    try {
      const raw = await spindleApi.connections.list(userId);
      const connections = (Array.isArray(raw) ? raw : []).map((connection) => ({
        id: String(connection?.id || ""),
        name: connection?.name || connection?.display_name || connection?.provider || "Unnamed connection",
        provider: connection?.provider || "",
        model: connection?.model || connection?.model_id || ""
      })).filter((connection) => connection.id);
      organizerSend(spindleApi, userId, {
        type: "bionic_lore_connections_result",
        requestId: payload?.requestId || null,
        connections
      });
    } catch (error) {
      organizerSend(spindleApi, userId, {
        type: "bionic_lore_connections_result",
        requestId: payload?.requestId || null,
        error: error?.message || String(error)
      });
    }
    return true;
  }
  if (type === "bionic_lore_ai_organize") {
    const requestId = payload?.requestId || null;
    try {
      const books = sanitizeOrganizerBooks(payload?.books);
      if (books.length < 2) {
        throw new Error("Scan at least two lorebooks before AI organization.");
      }
      const connectionId = typeof payload?.connectionId === "string" ? payload.connectionId.trim() : "";
      organizerSend(spindleApi, userId, {
        type: "bionic_lore_ai_progress",
        requestId,
        stage: "analyzing"
      });
      const prompt = organizerPrompt(books);
      const result = await spindleApi.generate.quiet({
        prompt,
        messages: [
          {
            role: "user",
            content: prompt
          }
        ],
        connectionId: connectionId || undefined,
        connection_id: connectionId || undefined,
        parameters: {
          temperature: 0.2
        }
      });
      const text = generationText(result);
      if (!text.trim()) {
        throw new Error("The selected LLM returned no text.");
      }
      const parsed = parseJsonResult(text);
      const folders = sanitizeSuggestions(parsed, books);
      organizerSend(spindleApi, userId, {
        type: "bionic_lore_ai_result",
        requestId,
        folders
      });
    } catch (error) {
      organizerSend(spindleApi, userId, {
        type: "bionic_lore_ai_result",
        requestId,
        error: error?.message || String(error)
      });
    }
    return true;
  }
  if (type === "bionic_lore_apply_folders") {
    const requestId = payload?.requestId || null;
    try {
      const raw = Array.isArray(payload?.assignments) ? payload.assignments : [];
      const assignments = raw.filter((item) => item && typeof item.bookId === "string" && typeof item.folder === "string" && item.folder.trim()).slice(0, 1000);
      if (!assignments.length) {
        throw new Error("No folder assignments were selected.");
      }
      let updated = 0;
      for (const assignment of assignments) {
        await spindleApi.world_books.update(assignment.bookId, {
          folder: assignment.folder.trim().slice(0, 120)
        }, userId);
        updated += 1;
      }
      organizerSend(spindleApi, userId, {
        type: "bionic_lore_apply_folders_result",
        requestId,
        updated
      });
    } catch (error) {
      organizerSend(spindleApi, userId, {
        type: "bionic_lore_apply_folders_result",
        requestId,
        error: error?.message || String(error)
      });
    }
    return true;
  }
  return false;
}

// src/backend.ts
var FF_THINK_FIX_VERSION = "0.48.0";
var DEFAULT_FF_THINK_CONFIG = {
  boundaryText: "[ \uD83D\uDD70\uFE0F Time",
  reasoningSide: "before",
  includeMarker: false
};
var runtimeByUser = new Map;
var SETTINGS_STORAGE_PATH = "settings/bionic-reading-settings.json";
var inFlight = new Set;
function cleanConfig(raw) {
  return {
    boundaryText: typeof raw?.boundaryText === "string" ? raw.boundaryText.slice(0, 1000) : DEFAULT_FF_THINK_CONFIG.boundaryText,
    reasoningSide: raw?.reasoningSide === "after" ? "after" : "before",
    includeMarker: raw?.includeMarker === true
  };
}
function existingReasoning(message) {
  return typeof message?.extra?.reasoning === "string" ? message.extra.reasoning.trim() : "";
}
function splitMessage(message, rawConfig) {
  const config = cleanConfig(rawConfig);
  if (!config.boundaryText) {
    return { status: "no_match" };
  }
  const content = typeof message?.content === "string" ? message.content : "";
  const boundaryIndex = content.indexOf(config.boundaryText);
  if (boundaryIndex < 0) {
    return { status: "no_match" };
  }
  const boundaryEnd = boundaryIndex + config.boundaryText.length;
  const before = content.slice(0, boundaryIndex);
  const marker = content.slice(boundaryIndex, boundaryEnd);
  const after = content.slice(boundaryEnd);
  const leakedRaw = config.reasoningSide === "after" ? config.includeMarker ? `${marker}${after}` : after : config.includeMarker ? `${before}${marker}` : before;
  const leaked = leakedRaw.trim();
  if (!leaked) {
    return existingReasoning(message) ? { status: "already_fixed" } : { status: "no_match" };
  }
  const prior = existingReasoning(message);
  const reasoning = !prior ? leaked : prior.includes(leaked) ? prior : `${prior}

${leaked}`;
  const visibleContent = config.reasoningSide === "after" ? config.includeMarker ? before : content.slice(0, boundaryEnd) : config.includeMarker ? after : content.slice(boundaryIndex);
  return {
    status: "fixed",
    content: visibleContent,
    reasoning,
    reasoningSide: config.reasoningSide,
    includeMarker: config.includeMarker
  };
}
function sendResult(userId, source, payload) {
  spindle.sendToFrontend({
    type: "ff_think_fix_result",
    source,
    version: FF_THINK_FIX_VERSION,
    ...payload
  }, userId);
}
function sendProgress(userId, source, stage, requestId) {
  spindle.sendToFrontend({
    type: "ff_think_fix_progress",
    source,
    stage,
    requestId: requestId || null,
    version: FF_THINK_FIX_VERSION
  }, userId);
}
async function timeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
      })
    ]);
  } finally {
    if (timer)
      clearTimeout(timer);
  }
}
async function latestAssistant(chatId, hintedMessageId) {
  const messages = await timeout(spindle.chat.getMessages(chatId), 4000, "Reading chat messages");
  if (hintedMessageId) {
    const hinted = messages.find((message) => message.id === hintedMessageId);
    if (hinted?.role === "assistant") {
      return hinted;
    }
  }
  for (let i = messages.length - 1;i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      return messages[i];
    }
  }
  return null;
}
async function repairMessage(userId, chatId, message, source, config, requestId) {
  const messageId = typeof message?.id === "string" ? message.id : "";
  if (!messageId) {
    sendResult(userId, source, {
      status: "error",
      requestId: requestId || null,
      error: "Assistant message has no id.",
      chatId
    });
    return;
  }
  const key = `${userId}:${chatId}:${messageId}`;
  if (inFlight.has(key)) {
    sendResult(userId, source, {
      status: "busy",
      requestId: requestId || null,
      chatId,
      messageId
    });
    return;
  }
  inFlight.add(key);
  try {
    const split = splitMessage(message, config);
    if (split.status !== "fixed") {
      sendResult(userId, source, {
        status: split.status,
        requestId: requestId || null,
        chatId,
        messageId
      });
      return;
    }
    sendProgress(userId, source, "updating", requestId);
    await timeout(spindle.chat.updateMessage(chatId, messageId, {
      content: split.content,
      reasoning: {
        text: split.reasoning
      }
    }), 7000, "Updating message reasoning");
    sendResult(userId, source, {
      status: "fixed",
      requestId: requestId || null,
      chatId,
      messageId,
      reasoningSide: split.reasoningSide,
      includeMarker: split.includeMarker
    });
    spindle.log.info(`FF think fix (${source}) repaired ${messageId}`);
  } catch (error) {
    const messageText = error?.message || String(error) || "Unknown error";
    spindle.log.error(`FF think fix (${source}) failed: ${messageText}`);
    sendResult(userId, source, {
      status: "error",
      requestId: requestId || null,
      error: messageText,
      chatId,
      messageId
    });
  } finally {
    inFlight.delete(key);
  }
}
spindle.onFrontendMessage(async (payload, userId) => {
  if (await handleLorebookOrganizerMessage(spindle, payload, userId)) {
    return;
  }
  if (payload?.type === "bionic_settings_load") {
    try {
      const saved = await spindle.userStorage.getJson(SETTINGS_STORAGE_PATH, { userId });
      spindle.sendToFrontend({
        type: "bionic_settings_loaded",
        settings: saved && typeof saved === "object" ? saved : null
      }, userId);
    } catch {
      spindle.sendToFrontend({
        type: "bionic_settings_loaded",
        settings: null
      }, userId);
    }
    return;
  }
  if (payload?.type === "bionic_settings_save") {
    try {
      const incoming = payload?.settings;
      if (!incoming || typeof incoming !== "object") {
        throw new Error("Invalid settings payload");
      }
      await spindle.userStorage.setJson(SETTINGS_STORAGE_PATH, incoming, { userId });
      spindle.sendToFrontend({
        type: "bionic_settings_saved",
        ok: true
      }, userId);
    } catch (error) {
      spindle.log.warn(`Bionic settings save failed: ${error?.message || String(error)}`);
      spindle.sendToFrontend({
        type: "bionic_settings_saved",
        ok: false
      }, userId);
    }
    return;
  }
  if (payload?.type === "ff_think_fix_health") {
    spindle.sendToFrontend({
      type: "ff_think_fix_health",
      version: FF_THINK_FIX_VERSION
    }, userId);
    return;
  }
  if (payload?.type === "ff_think_fix_config") {
    runtimeByUser.set(userId, {
      enabled: Boolean(payload.enabled),
      config: cleanConfig(payload.config)
    });
    return;
  }
  if (payload?.type !== "ff_think_fix_manual") {
    return;
  }
  const chatId = typeof payload.chatId === "string" ? payload.chatId : "";
  const requestId = typeof payload.requestId === "string" ? payload.requestId : undefined;
  if (!chatId) {
    sendResult(userId, "manual", {
      status: "error",
      requestId: requestId || null,
      error: "No current chat id was provided."
    });
    return;
  }
  sendProgress(userId, "manual", "reading", requestId);
  try {
    const assistant = await latestAssistant(chatId, typeof payload.latestMessageId === "string" ? payload.latestMessageId : undefined);
    if (!assistant) {
      sendResult(userId, "manual", {
        status: "no_assistant",
        requestId: requestId || null,
        chatId
      });
      return;
    }
    await repairMessage(userId, chatId, assistant, "manual", payload.config, requestId);
  } catch (error) {
    sendResult(userId, "manual", {
      status: "error",
      requestId: requestId || null,
      error: error?.message || String(error) || "Unknown error",
      chatId
    });
  }
});
try {
  spindle.on("GENERATION_ENDED", async (payload, userId) => {
    if (typeof userId !== "string" || !userId) {
      return;
    }
    const runtime = runtimeByUser.get(userId);
    if (!runtime?.enabled)
      return;
    if (payload?.error)
      return;
    const chatId = typeof payload?.chatId === "string" ? payload.chatId : "";
    if (!chatId)
      return;
    try {
      const assistant = await latestAssistant(chatId, typeof payload?.messageId === "string" ? payload.messageId : undefined);
      if (!assistant) {
        sendResult(userId, "auto", {
          status: "no_assistant",
          chatId,
          messageId: payload?.messageId || null
        });
        return;
      }
      await repairMessage(userId, chatId, assistant, "auto", runtime.config);
    } catch (error) {
      sendResult(userId, "auto", {
        status: "error",
        error: error?.message || String(error) || "Unknown error",
        chatId,
        messageId: payload?.messageId || null
      });
    }
  });
} catch (error) {
  spindle.log.warn(`FF automatic listener not registered: ${error?.message || String(error)}`);
}
if (false)
  ;
spindle.log.info(`Bionic Reading & Fonts FF backend v${FF_THINK_FIX_VERSION} loaded`);
