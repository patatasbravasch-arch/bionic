// src/lorebook-organizer-core.ts
function uniqueStrings(value) {
  if (!Array.isArray(value))
    return [];
  return Array.from(new Set(value.filter((item) => typeof item === "string" && item.length > 0)));
}
function characterLoreIds(character) {
  if (Array.isArray(character?.world_book_ids)) {
    return uniqueStrings(character.world_book_ids);
  }
  const ext = character?.extensions && typeof character.extensions === "object" ? character.extensions : {};
  if (Array.isArray(ext.world_book_ids)) {
    return uniqueStrings(ext.world_book_ids);
  }
  if (typeof ext.world_book_id === "string" && ext.world_book_id) {
    return [ext.world_book_id];
  }
  return [];
}
function chatLoreIds(chat) {
  return uniqueStrings(chat?.metadata?.chat_world_book_ids);
}
function personaLoreIds(persona) {
  const id = persona?.attached_world_book_id;
  return typeof id === "string" && id ? [id] : [];
}
function replaceLoreIds(ids, duplicateIds, keepId) {
  return Array.from(new Set(ids.map((id) => duplicateIds.has(id) ? keepId : id)));
}
function buildLoreReferences({
  characters,
  chats,
  personas,
  globalIds
}) {
  const refs = new Map;
  const add = (bookId, ref) => {
    const list = refs.get(bookId) || [];
    if (!list.some((item) => item.kind === ref.kind && item.id === ref.id)) {
      list.push(ref);
      refs.set(bookId, list);
    }
  };
  for (const character of characters) {
    for (const bookId of characterLoreIds(character)) {
      add(bookId, {
        kind: "character",
        id: String(character.id || ""),
        name: character.name || "Unnamed character"
      });
    }
  }
  for (const chat of chats) {
    for (const bookId of chatLoreIds(chat)) {
      add(bookId, {
        kind: "chat",
        id: String(chat.id || ""),
        name: chat.title || chat.name || "Unnamed chat"
      });
    }
  }
  for (const persona of personas) {
    for (const bookId of personaLoreIds(persona)) {
      add(bookId, {
        kind: "persona",
        id: String(persona.id || ""),
        name: persona.name || "Unnamed persona"
      });
    }
  }
  for (const bookId of uniqueStrings(globalIds)) {
    add(bookId, {
      kind: "global",
      id: "global",
      name: "Global lorebook"
    });
  }
  return refs;
}
function referenceCounts(references) {
  const counts = {
    character: 0,
    chat: 0,
    persona: 0,
    global: 0
  };
  for (const ref of references) {
    counts[ref.kind] += 1;
  }
  return counts;
}
function totalReferenceCount(book) {
  return book.references.length;
}
function chooseKeeper(books) {
  if (!books.length)
    return null;
  return [...books].sort((a, b) => {
    const refDiff = totalReferenceCount(b) - totalReferenceCount(a);
    if (refDiff !== 0) {
      return refDiff;
    }
    return a.id.localeCompare(b.id);
  })[0];
}
function isUnlinked(book) {
  return book.references.length === 0;
}
function shortLoreId(id) {
  const text = String(id || "");
  if (text.length <= 18) {
    return text;
  }
  return `${text.slice(0, 8)}…${text.slice(-6)}`;
}
function summarizeReferences(refs) {
  const counts = referenceCounts(refs);
  const parts = [];
  if (counts.character) {
    parts.push(`${counts.character} character${counts.character === 1 ? "" : "s"}`);
  }
  if (counts.chat) {
    parts.push(`${counts.chat} chat${counts.chat === 1 ? "" : "s"}`);
  }
  if (counts.persona) {
    parts.push(`${counts.persona} persona${counts.persona === 1 ? "" : "s"}`);
  }
  if (counts.global) {
    parts.push("global");
  }
  return parts.length ? parts.join(" · ") : "no references";
}

// src/lorebook-organizer-frontend.ts
var CONNECTION_KEY = "lumiverse:bionic-style-reading:lore-organizer-connection";
var IGNORED_FOLDER = "Bionic — Ignored";
var AI_BATCH_SIZE = 70;
function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
function stableValue(value, key = "") {
  if (Array.isArray(value)) {
    const mapped = value.map((item) => stableValue(item));
    if (key === "key" || key === "keysecondary") {
      return mapped.map(String).sort();
    }
    return mapped;
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const childKey of Object.keys(value).sort()) {
      if ([
        "id",
        "uid",
        "world_book_id",
        "created_at",
        "updated_at",
        "revision"
      ].includes(childKey)) {
        continue;
      }
      result[childKey] = stableValue(value[childKey], childKey);
    }
    return result;
  }
  return value;
}
function bookSignature(book, entries) {
  const name = String(book?.name || "").normalize("NFKC").trim().toLocaleLowerCase().replace(/[\s_-]+/g, " ");
  return JSON.stringify({
    name,
    entries: entries.map((entry) => JSON.stringify(stableValue(entry))).sort()
  });
}
function representativeKeys(entries) {
  const values = [];
  for (const entry of entries) {
    const candidates = [
      ...Array.isArray(entry?.key) ? entry.key : [],
      ...Array.isArray(entry?.keysecondary) ? entry.keysecondary : [],
      entry?.comment,
      entry?.name,
      entry?.title
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        values.push(candidate.trim().slice(0, 160));
      }
    }
    if (values.length >= 12)
      break;
  }
  return Array.from(new Set(values)).slice(0, 12);
}
function installLorebookOrganizer(ctx, settingsRoot, options = {}) {
  const pending = new Map;
  let modal = null;
  let modalRoot = null;
  let activeTab = "overview";
  let books = [];
  let groups = [];
  let unlinked = [];
  let ignored = [];
  let referenceSnapshot = null;
  const selectedUnlinked = new Set;
  let showIgnored = false;
  let linkPanelOpen = false;
  let linkTargetKind = "character";
  let linkTargetId = "";
  let lastScanAt = null;
  let busy = false;
  let connections = [];
  let suggestions = [];
  let searchText = "";
  let sortMode = "name";
  function requestId(prefix) {
    return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 9)}`;
  }
  function sendBackend(type, payload = {}, timeoutMs = 60000) {
    const id = requestId(type);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${type} timed out.`));
      }, timeoutMs);
      pending.set(id, {
        resolve,
        reject,
        timer
      });
      try {
        ctx.sendToBackend({
          type,
          requestId: id,
          ...payload
        });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  function handleBackendMessage(payload) {
    const id = payload?.requestId;
    if (typeof id !== "string" || !pending.has(id)) {
      return false;
    }
    const request = pending.get(id);
    pending.delete(id);
    clearTimeout(request.timer);
    if (payload?.error) {
      request.reject(new Error(String(payload.error)));
    } else {
      request.resolve(payload);
    }
    return true;
  }
  async function api(path, options2 = {}) {
    const response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      ...options2,
      headers: {
        ...options2.body ? {
          "Content-Type": "application/json"
        } : {},
        ...options2.headers || {}
      }
    });
    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json();
        if (body?.error) {
          detail = `: ${body.error}`;
        }
      } catch {}
      throw new Error(`${response.status} ${response.statusText}${detail}`);
    }
    if (response.status === 204) {
      return null;
    }
    return response.json();
  }
  async function paged(path) {
    const all = [];
    let offset = 0;
    while (true) {
      const separator = path.includes("?") ? "&" : "?";
      const page = await api(`${path}${separator}limit=200&offset=${offset}`);
      const data = Array.isArray(page?.data) ? page.data : [];
      all.push(...data);
      const total = Number(page?.total ?? all.length);
      if (data.length === 0 || all.length >= total) {
        return all;
      }
      offset += data.length;
    }
  }
  async function loadEntries(bookId) {
    return paged(`/api/v1/world-books/${encodeURIComponent(bookId)}/entries`);
  }
  function rebuildGroups() {
    const bySignature = new Map;
    for (const book of books) {
      if (!book.entryCount || !book.signature) {
        continue;
      }
      const list = bySignature.get(book.signature) || [];
      list.push(book);
      bySignature.set(book.signature, list);
    }
    groups = [];
    let number = 0;
    for (const duplicateBooks of bySignature.values()) {
      if (duplicateBooks.length < 2) {
        continue;
      }
      const keeper = chooseKeeper(duplicateBooks);
      if (!keeper)
        continue;
      number += 1;
      groups.push({
        groupId: `exact-${number}`,
        name: keeper.name || "Unnamed lorebook",
        recommendedKeepId: keeper.id,
        books: [...duplicateBooks].sort((a, b) => a.name.localeCompare(b.name))
      });
    }
    groups.sort((a, b) => a.name.localeCompare(b.name));
    const zeroReferenceBooks = books.filter(isUnlinked);
    ignored = zeroReferenceBooks.filter((book) => String(book.folder || "").trim() === IGNORED_FOLDER).sort((a, b) => a.name.localeCompare(b.name));
    unlinked = zeroReferenceBooks.filter((book) => String(book.folder || "").trim() !== IGNORED_FOLDER).sort((a, b) => a.name.localeCompare(b.name));
    const validSelection = new Set(zeroReferenceBooks.map((book) => book.id));
    for (const id of selectedUnlinked) {
      if (!validSelection.has(id)) {
        selectedUnlinked.delete(id);
      }
    }
  }
  function applyReferenceSnapshot(snapshot) {
    referenceSnapshot = snapshot;
    const refs = buildLoreReferences({
      characters: snapshot?.characters || [],
      chats: snapshot?.chats || [],
      personas: snapshot?.personas || [],
      globalIds: snapshot?.globalIds || []
    });
    books = books.map((book) => ({
      ...book,
      references: refs.get(book.id) || []
    }));
    rebuildGroups();
  }
  async function freshReferences() {
    const result = await sendBackend("bionic_lore_reference_snapshot");
    const snapshot = result?.snapshot;
    if (!snapshot || typeof snapshot !== "object") {
      throw new Error("Reference snapshot was empty.");
    }
    applyReferenceSnapshot(snapshot);
    return snapshot;
  }
  async function scan() {
    if (busy)
      return;
    busy = true;
    renderAll("Scanning lorebook library…");
    try {
      const [
        rawBooks,
        snapshotResult
      ] = await Promise.all([
        paged("/api/v1/world-books"),
        sendBackend("bionic_lore_reference_snapshot")
      ]);
      const snapshot = snapshotResult?.snapshot;
      if (!snapshot || typeof snapshot !== "object") {
        throw new Error("Reference snapshot was empty.");
      }
      const refs = buildLoreReferences({
        characters: snapshot.characters || [],
        chats: snapshot.chats || [],
        personas: snapshot.personas || [],
        globalIds: snapshot.globalIds || []
      });
      const nextBooks = [];
      let completed = 0;
      for (const raw of rawBooks) {
        const entries = await loadEntries(raw.id);
        completed += 1;
        renderAll(`Reading lorebooks… ${completed}/${rawBooks.length}`);
        nextBooks.push({
          id: raw.id,
          name: raw.name || "Unnamed lorebook",
          folder: typeof raw.folder === "string" ? raw.folder : "",
          description: typeof raw.description === "string" ? raw.description : "",
          entryCount: entries.length,
          entries: representativeKeys(entries),
          signature: bookSignature(raw, entries),
          references: refs.get(raw.id) || []
        });
      }
      books = nextBooks;
      referenceSnapshot = snapshot;
      lastScanAt = Date.now();
      rebuildGroups();
      renderAll(`Scan complete: ${books.length} lorebooks · ${groups.length} duplicate group${groups.length === 1 ? "" : "s"} · ${unlinked.length} unlinked.`);
    } catch (error) {
      renderAll(`Organizer scan failed: ${error?.message || String(error)}`);
    } finally {
      busy = false;
      syncSummary();
    }
  }
  function updateLocalRefs(snapshot) {
    applyReferenceSnapshot(snapshot);
    renderAll();
    syncSummary();
  }
  async function relinkCharacter(character, duplicateSet, keepId) {
    const current = Array.isArray(character.world_book_ids) ? character.world_book_ids : [];
    const next = replaceLoreIds(current, duplicateSet, keepId);
    await api(`/api/v1/characters/${encodeURIComponent(character.id)}`, {
      method: "PUT",
      body: JSON.stringify({
        world_book_ids: next
      })
    });
    const verified = await api(`/api/v1/characters/${encodeURIComponent(character.id)}`);
    const ids = Array.isArray(verified?.world_book_ids) ? verified.world_book_ids : Array.isArray(verified?.extensions?.world_book_ids) ? verified.extensions.world_book_ids : [];
    if (next.some((id) => !ids.includes(id)) || ids.some((id) => duplicateSet.has(id))) {
      throw new Error(`Character ${character.name || character.id} did not verify after relinking.`);
    }
    character.world_book_ids = [...next];
  }
  async function relinkChat(chat, duplicateSet, keepId) {
    const current = Array.isArray(chat?.metadata?.chat_world_book_ids) ? chat.metadata.chat_world_book_ids : [];
    const next = replaceLoreIds(current, duplicateSet, keepId);
    const updated = await api(`/api/v1/chats/${encodeURIComponent(chat.id)}/metadata`, {
      method: "PATCH",
      body: JSON.stringify({
        chat_world_book_ids: next
      })
    });
    const verified = Array.isArray(updated?.metadata?.chat_world_book_ids) ? updated.metadata.chat_world_book_ids : [];
    if (next.some((id) => !verified.includes(id)) || verified.some((id) => duplicateSet.has(id))) {
      throw new Error(`Chat ${chat.title || chat.id} did not verify after relinking.`);
    }
    chat.metadata = {
      ...chat.metadata || {},
      chat_world_book_ids: [...next]
    };
  }
  async function cleanGroup(group) {
    if (busy)
      return;
    const keepId = group.recommendedKeepId;
    const duplicateIds = group.books.map((book) => book.id).filter((id) => id !== keepId);
    if (duplicateIds.length === 0) {
      return;
    }
    if (!window.confirm(`Keep "${group.name}", relink every current character/chat/persona/global reference, then delete ${duplicateIds.length} exact duplicate${duplicateIds.length === 1 ? "" : "s"}?`)) {
      return;
    }
    busy = true;
    renderAll("Refreshing references before cleanup…");
    try {
      const snapshot = await freshReferences();
      const duplicateSet = new Set(duplicateIds);
      for (const character of snapshot.characters || []) {
        const ids = character.world_book_ids || [];
        if (ids.some((id) => duplicateSet.has(id))) {
          renderAll(`Relinking character: ${character.name || character.id}…`);
          await relinkCharacter(character, duplicateSet, keepId);
        }
      }
      for (const chat of snapshot.chats || []) {
        const ids = chat?.metadata?.chat_world_book_ids || [];
        if (ids.some((id) => duplicateSet.has(id))) {
          renderAll(`Relinking chat: ${chat.title || chat.id}…`);
          await relinkChat(chat, duplicateSet, keepId);
        }
      }
      const personaAssignments = (snapshot.personas || []).filter((persona) => duplicateSet.has(persona.attached_world_book_id)).map((persona) => ({
        id: persona.id,
        bookId: keepId
      }));
      if (personaAssignments.length) {
        renderAll(`Relinking ${personaAssignments.length} persona reference${personaAssignments.length === 1 ? "" : "s"}…`);
        await api("/api/v1/personas/bulk-update", {
          method: "POST",
          body: JSON.stringify({
            ids: personaAssignments.map((item) => item.id),
            attached_world_book_id: keepId
          })
        });
      }
      const currentGlobal = Array.isArray(snapshot.globalIds) ? snapshot.globalIds : [];
      if (currentGlobal.some((id) => duplicateSet.has(id))) {
        renderAll("Relinking global lorebooks…");
        await sendBackend("bionic_lore_set_global", {
          ids: replaceLoreIds(currentGlobal, duplicateSet, keepId)
        });
      }
      renderAll("Verifying duplicate references before deletion…");
      const verification = await sendBackend("bionic_lore_reference_snapshot");
      if (!verification?.snapshot || typeof verification.snapshot !== "object") {
        throw new Error("Final reference verification returned no snapshot.");
      }
      applyReferenceSnapshot(verification.snapshot);
      const stillReferenced = books.filter((book) => duplicateSet.has(book.id) && book.references.length > 0);
      if (stillReferenced.length) {
        const detail = stillReferenced.map((book) => `${book.name}: ${summarizeReferences(book.references)}`).join("; ");
        throw new Error(`Duplicate deletion was stopped because references still remain: ${detail}`);
      }
      for (const id of duplicateIds) {
        renderAll(`Deleting duplicate ${shortLoreId(id)}…`);
        await api(`/api/v1/world-books/${encodeURIComponent(id)}`, {
          method: "DELETE"
        });
        books = books.filter((book) => book.id !== id);
      }
      const refreshed = await sendBackend("bionic_lore_reference_snapshot");
      updateLocalRefs(refreshed.snapshot);
      renderAll(`Cleanup complete. Kept ${group.name}; deleted ${duplicateIds.length} duplicate${duplicateIds.length === 1 ? "" : "s"}.`);
    } catch (error) {
      renderAll(`Cleanup stopped: ${error?.message || String(error)}`);
    } finally {
      busy = false;
      syncSummary();
    }
  }
  async function deleteUnlinked(book) {
    if (busy)
      return;
    if (!window.confirm(`Delete "${book.name}"?

Bionic will refresh all four reference sources first.`)) {
      return;
    }
    busy = true;
    renderAll("Verifying the lorebook is still unlinked…");
    try {
      await freshReferences();
      const current = books.find((item) => item.id === book.id);
      if (current && current.references.length > 0) {
        throw new Error(`${book.name} is now referenced by ${summarizeReferences(current.references)} and was not deleted.`);
      }
      await api(`/api/v1/world-books/${encodeURIComponent(book.id)}`, {
        method: "DELETE"
      });
      books = books.filter((item) => item.id !== book.id);
      rebuildGroups();
      renderAll(`Deleted ${book.name}.`);
    } catch (error) {
      renderAll(`Delete stopped: ${error?.message || String(error)}`);
    } finally {
      busy = false;
      syncSummary();
    }
  }
  let connectionsLoaded = false;
  function rawSelectedConnectionId() {
    const external = options.getConnectionId?.();
    if (typeof external === "string") {
      return external;
    }
    try {
      return localStorage.getItem(CONNECTION_KEY) || "";
    } catch {
      return "";
    }
  }
  function selectedConnectionId() {
    const selected = rawSelectedConnectionId();
    if (!selected || !connectionsLoaded) {
      return selected;
    }
    const available = connections.some((connection) => connection?.id === selected);
    if (available) {
      return selected;
    }
    saveConnectionId("");
    return "";
  }
  function saveConnectionId(id) {
    options.setConnectionId?.(id);
    try {
      localStorage.setItem(CONNECTION_KEY, id);
    } catch {}
  }
  async function loadConnections() {
    const result = await sendBackend("bionic_lore_connections");
    connections = Array.isArray(result?.connections) ? result.connections : [];
    connectionsLoaded = true;
    selectedConnectionId();
    renderAll();
  }
  async function analyzeFolders() {
    if (busy || books.length < 2) {
      return;
    }
    busy = true;
    suggestions = [];
    try {
      const compactBooks = books.map((book) => ({
        id: book.id,
        name: book.name,
        folder: book.folder || "",
        description: book.description || "",
        entryCount: book.entryCount,
        sampleKeys: Array.isArray(book.entries) ? book.entries : []
      }));
      const connectionId = selectedConnectionId();
      const batchCount = Math.ceil(compactBooks.length / AI_BATCH_SIZE);
      const merged = new Map;
      for (let offset = 0;offset < compactBooks.length; offset += AI_BATCH_SIZE) {
        const batch = compactBooks.slice(offset, offset + AI_BATCH_SIZE);
        const batchNumber = Math.floor(offset / AI_BATCH_SIZE) + 1;
        const first = offset + 1;
        const last = Math.min(offset + batch.length, compactBooks.length);
        renderAll(`AI is analyzing folder groups… ${first}–${last} of ${compactBooks.length} · batch ${batchNumber}/${batchCount}`);
        const result = await sendBackend("bionic_lore_ai_organize", {
          connectionId,
          books: batch
        }, 120000);
        const batchFolders = Array.isArray(result?.folders) ? result.folders : [];
        const batchIds = new Set(batch.map((book) => book.id));
        for (const folder of batchFolders) {
          const name = String(folder?.name || "").trim();
          if (!name)
            continue;
          const bookIds = Array.from(new Set(Array.isArray(folder?.bookIds) ? folder.bookIds.filter((id) => typeof id === "string" && batchIds.has(id)) : []));
          if (bookIds.length < 2) {
            continue;
          }
          const reason = String(folder?.reason || "").trim();
          const key = name.normalize("NFKC").toLocaleLowerCase();
          const existing = merged.get(key);
          if (existing) {
            existing.bookIds = Array.from(new Set([
              ...existing.bookIds,
              ...bookIds
            ]));
            if (!existing.reason && reason) {
              existing.reason = reason;
            }
            continue;
          }
          merged.set(key, {
            name,
            bookIds,
            reason
          });
        }
      }
      suggestions = Array.from(merged.values()).filter((suggestion) => suggestion.bookIds.length >= 2).sort((a, b) => a.name.localeCompare(b.name));
      renderAll(suggestions.length ? `AI suggested ${suggestions.length} folder${suggestions.length === 1 ? "" : "s"} across ${batchCount} batch${batchCount === 1 ? "" : "es"}. Nothing has been changed yet.` : "AI returned no useful multi-book folder suggestions.");
    } catch (error) {
      renderAll(`AI organize failed: ${error?.message || String(error)}`);
    } finally {
      busy = false;
    }
  }
  async function applyAssignments(assignments) {
    if (busy || assignments.length === 0) {
      return false;
    }
    busy = true;
    renderAll(`Applying ${assignments.length} folder assignment${assignments.length === 1 ? "" : "s"}…`);
    try {
      await sendBackend("bionic_lore_apply_folders", { assignments });
      const byId = new Map(assignments.map((item) => [
        item.bookId,
        item.folder
      ]));
      books = books.map((book) => ({
        ...book,
        folder: byId.get(book.id) ?? book.folder
      }));
      rebuildGroups();
      renderAll(`Applied ${assignments.length} folder assignment${assignments.length === 1 ? "" : "s"}.`);
      return true;
    } catch (error) {
      renderAll(`Folder update failed: ${error?.message || String(error)}`);
      return false;
    } finally {
      busy = false;
    }
  }
  let statusMessage = "Not scanned yet.";
  const removeOrganizerStyle = ctx.dom.addStyle(`
      .lb-organizer-summary {
        display: grid;
        gap: 12px;
      }

      .lb-organizer-brand {
        display: flex;
        align-items: center;
        gap: 12px;
      }


      .lb-organizer-brand-copy {
        min-width: 0;
      }

      .lb-organizer-brand-copy strong {
        display: block;
        font-size: 1rem;
      }

      .lb-organizer-brand-copy small {
        display: block;
        margin-top: 2px;
        opacity: .72;
        line-height: 1.35;
      }

      .lb-organizer-summary-stats {
        font-size: .88rem;
        opacity: .78;
      }

      .lb-organizer-shell {
        width: min(1050px, 88vw);
        height: min(76vh, 800px);
        min-height: 500px;
        display: grid;
        grid-template-rows: auto auto auto minmax(0, 1fr);
        gap: 12px;
      }

      .lb-organizer-hero {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
      }

      .lb-organizer-hero-left {
        display: flex;
        align-items: center;
        gap: 12px;
        min-width: 0;
      }

      .lb-organizer-hero-title {
        font-size: 1.05rem;
        font-weight: 700;
      }

      .lb-organizer-hero-sub {
        margin-top: 3px;
        font-size: .82rem;
        opacity: .7;
      }

      .lb-organizer-toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }

      .lb-organizer-toolbar input,
      .lb-organizer-toolbar select {
        min-width: 0;
      }

      .lb-organizer-search {
        flex: 1 1 240px;
      }

      .lb-organizer-sort {
        flex: 0 1 180px;
      }

      .lb-organizer-tabs {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding-bottom: 2px;
      }

      .lb-organizer-tab[aria-selected="true"] {
        font-weight: 700;
        box-shadow: inset 0 -2px currentColor;
      }

      .lb-organizer-status {
        min-height: 1.3em;
        font-size: .83rem;
        opacity: .78;
      }

      .lb-organizer-content {
        min-height: 0;
        overflow-y: auto;
        padding-right: 4px;
      }

      .lb-organizer-grid {
        display: grid;
        grid-template-columns:
          repeat(auto-fit, minmax(190px, 1fr));
        gap: 10px;
        margin-bottom: 14px;
      }

      .lb-organizer-stat,
      .lb-organizer-card {
        border: 1px solid
          color-mix(in srgb, currentColor 18%, transparent);
        border-radius: 12px;
        padding: 12px;
        background:
          color-mix(in srgb, currentColor 3%, transparent);
      }

      .lb-organizer-stat strong {
        display: block;
        font-size: 1.35rem;
      }

      .lb-organizer-stat span {
        display: block;
        margin-top: 3px;
        opacity: .72;
        font-size: .82rem;
      }

      .lb-organizer-list {
        display: grid;
        gap: 9px;
      }

      .lb-organizer-card {
        display: grid;
        gap: 8px;
      }

      .lb-organizer-card-head {
        display: flex;
        gap: 10px;
        justify-content: space-between;
        align-items: start;
      }

      .lb-organizer-card-title {
        min-width: 0;
        font-weight: 700;
        overflow-wrap: anywhere;
      }

      .lb-organizer-id {
        white-space: nowrap;
        font-size: .73rem;
        opacity: .67;
      }

      .lb-organizer-meta {
        font-size: .8rem;
        opacity: .72;
        line-height: 1.45;
      }

      .lb-organizer-badges {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
      }

      .lb-organizer-badge {
        display: inline-flex;
        padding: 3px 7px;
        border-radius: 999px;
        font-size: .72rem;
        border: 1px solid
          color-mix(in srgb, currentColor 18%, transparent);
      }

      .lb-organizer-books {
        display: grid;
        gap: 7px;
      }

      .lb-organizer-book {
        display: grid;
        gap: 4px;
        padding: 8px 10px;
        border-radius: 9px;
        border: 1px solid
          color-mix(in srgb, currentColor 14%, transparent);
      }

      .lb-organizer-book.is-keep {
        border-style: solid;
      }

      .lb-organizer-book.is-duplicate {
        border-style: dashed;
      }

      .lb-organizer-book-role {
        font-size: .67rem;
        letter-spacing: .08em;
        font-weight: 800;
        opacity: .68;
      }

      .lb-organizer-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 7px;
      }

      .lb-organizer-empty {
        padding: 22px;
        text-align: center;
        opacity: .68;
      }

      .lb-organizer-ai-controls {
        display: grid;
        grid-template-columns:
          minmax(180px, 1fr) auto;
        gap: 8px;
        margin-bottom: 12px;
      }

      .lb-organizer-suggestion {
        display: grid;
        gap: 10px;
      }

      .lb-organizer-suggestion-name {
        width: 100%;
      }

      .lb-organizer-checks {
        display: grid;
        gap: 5px;
      }

      .lb-organizer-check {
        display: flex;
        align-items: start;
        gap: 8px;
        font-size: .85rem;
      }

      .lb-organizer-check input {
        margin-top: .2em;
      }

      .lb-organizer-reason {
        font-size: .79rem;
        opacity: .7;
      }

      @media (max-width: 700px) {
        .lb-organizer-shell {
          width: 86vw;
          height: 72vh;
          min-height: 430px;
        }

        .lb-organizer-hero {
          align-items: flex-start;
          flex-direction: column;
        }

        .lb-organizer-ai-controls {
          grid-template-columns: 1fr;
        }
      }
    `);
  function filteredBooks(source = books) {
    const needle = searchText.trim().toLocaleLowerCase();
    let result = needle ? source.filter((book) => {
      const haystack = [
        book.name,
        book.id,
        book.folder || "",
        book.description || "",
        summarizeReferences(book.references)
      ].join(" ").toLocaleLowerCase();
      return haystack.includes(needle);
    }) : [...source];
    result.sort((a, b) => {
      if (sortMode === "entries") {
        return b.entryCount - a.entryCount;
      }
      if (sortMode === "refs") {
        return b.references.length - a.references.length;
      }
      if (sortMode === "folder") {
        return String(a.folder || "").localeCompare(String(b.folder || "")) || a.name.localeCompare(b.name);
      }
      return a.name.localeCompare(b.name);
    });
    return result;
  }
  function referenceBadges(book) {
    const counts = new Map;
    for (const ref of book.references) {
      counts.set(ref.kind, (counts.get(ref.kind) || 0) + 1);
    }
    const parts = [];
    const add = (kind, singular) => {
      const count = counts.get(kind) || 0;
      if (!count)
        return;
      parts.push(`
        <span class="lb-organizer-badge">
          ${count} ${singular}${count === 1 ? "" : "s"}
        </span>
      `);
    };
    add("character", "character");
    add("chat", "chat");
    add("persona", "persona");
    if ((counts.get("global") || 0) > 0) {
      parts.push(`
        <span class="lb-organizer-badge">
          global
        </span>
      `);
    }
    if (!parts.length) {
      parts.push(`
        <span class="lb-organizer-badge">
          unlinked
        </span>
      `);
    }
    return parts.join("");
  }
  function bookCard(book, actions = "") {
    const folder = book.folder ? `Folder: ${escapeHtml(book.folder)} · ` : "";
    return `
      <div class="lb-organizer-card">
        <div class="lb-organizer-card-head">
          <div class="lb-organizer-card-title">
            ${escapeHtml(book.name)}
          </div>

          <code
            class="lb-organizer-id"
            title="${escapeHtml(book.id)}"
          >${escapeHtml(shortLoreId(book.id))}</code>
        </div>

        <div class="lb-organizer-meta">
          ${folder}${book.entryCount} entries
        </div>

        <div class="lb-organizer-badges">
          ${referenceBadges(book)}
        </div>

        ${actions ? `<div class="lb-organizer-actions">${actions}</div>` : ""}
      </div>
    `;
  }
  function renderOverview() {
    const visible = filteredBooks();
    return `
      <div class="lb-organizer-grid">
        <div class="lb-organizer-stat">
          <strong>${books.length}</strong>
          <span>Lorebooks</span>
        </div>

        <div class="lb-organizer-stat">
          <strong>${groups.length}</strong>
          <span>Exact duplicate groups</span>
        </div>

        <div class="lb-organizer-stat">
          <strong>${unlinked.length}</strong>
          <span>Unlinked across all sources</span>
        </div>

        <div class="lb-organizer-stat">
          <strong>${books.filter((book) => book.folder).length}</strong>
          <span>Already in folders</span>
        </div>
      </div>

      <div class="lb-organizer-list">
        ${visible.length ? visible.map((book) => bookCard(book)).join("") : `
              <div class="lb-organizer-empty">
                ${books.length ? "No lorebooks match this search." : "Scan the library to begin."}
              </div>
            `}
      </div>
    `;
  }
  function renderDuplicates() {
    const needle = searchText.trim().toLocaleLowerCase();
    const visible = groups.filter((group) => {
      if (!needle)
        return true;
      return group.name.toLocaleLowerCase().includes(needle) || group.books.some((book) => book.name.toLocaleLowerCase().includes(needle) || book.id.toLocaleLowerCase().includes(needle));
    });
    if (!visible.length) {
      return `
        <div class="lb-organizer-empty">
          ${groups.length ? "No duplicate groups match this search." : "No exact duplicate groups found."}
        </div>
      `;
    }
    return `
      <div class="lb-organizer-list">
        ${visible.map((group) => {
      const duplicateCount = group.books.filter((book) => book.id !== group.recommendedKeepId).length;
      return `
            <div class="lb-organizer-card">
              <div class="lb-organizer-card-head">
                <div class="lb-organizer-card-title">
                  ${escapeHtml(group.name)}
                </div>

                <span class="lb-organizer-badge">
                  ${duplicateCount} duplicate${duplicateCount === 1 ? "" : "s"}
                </span>
              </div>

              <div class="lb-organizer-books">
                ${group.books.map((book) => {
        const keep = book.id === group.recommendedKeepId;
        return `
                    <div class="lb-organizer-book ${keep ? "is-keep" : "is-duplicate"}">
                      <div class="lb-organizer-card-head">
                        <span class="lb-organizer-book-role">
                          ${keep ? "KEEP" : "DUPLICATE"}
                        </span>

                        <code
                          class="lb-organizer-id"
                          title="${escapeHtml(book.id)}"
                        >${escapeHtml(shortLoreId(book.id))}</code>
                      </div>

                      <strong>
                        ${escapeHtml(book.name)}
                      </strong>

                      <div class="lb-organizer-meta">
                        ${book.entryCount} entries ·
                        ${escapeHtml(summarizeReferences(book.references))}
                      </div>
                    </div>
                  `;
      }).join("")}
              </div>

              <div class="lb-organizer-meta">
                Every current character, chat, persona and global
                reference is refreshed and relinked before deletion.
              </div>

              <div class="lb-organizer-actions">
                <button
                  type="button"
                  data-organizer-clean-group="${escapeHtml(group.groupId)}"
                  ${busy ? "disabled" : ""}
                >
                  Relink &amp; delete exact duplicates
                </button>
              </div>
            </div>
          `;
    }).join("")}
      </div>
    `;
  }
  function visibleUnlinkedBooks() {
    const source = showIgnored ? [...unlinked, ...ignored] : [...unlinked];
    return filteredBooks(source);
  }
  function selectedUnlinkedBooks() {
    return books.filter((book) => selectedUnlinked.has(book.id) && isUnlinked(book));
  }
  function linkTargets() {
    if (linkTargetKind === "character") {
      return (referenceSnapshot?.characters || []).map((item) => ({
        id: item.id,
        name: item.name || "Unnamed character"
      })).sort((a, b) => a.name.localeCompare(b.name));
    }
    if (linkTargetKind === "chat") {
      return (referenceSnapshot?.chats || []).map((item) => ({
        id: item.id,
        name: item.title || item.name || "Unnamed chat"
      })).sort((a, b) => a.name.localeCompare(b.name));
    }
    if (linkTargetKind === "persona") {
      return (referenceSnapshot?.personas || []).map((item) => ({
        id: item.id,
        name: item.name || "Unnamed persona"
      })).sort((a, b) => a.name.localeCompare(b.name));
    }
    return [];
  }
  async function ignoreSelectedBooks() {
    const selected = selectedUnlinkedBooks();
    if (!selected.length)
      return;
    const applied = await applyAssignments(selected.map((book) => ({
      bookId: book.id,
      folder: IGNORED_FOLDER
    })));
    if (!applied)
      return;
    selectedUnlinked.clear();
    renderAll(`Ignored ${selected.length} lorebook${selected.length === 1 ? "" : "s"} in "${IGNORED_FOLDER}".`);
  }
  async function restoreSelectedBooks() {
    const selected = selectedUnlinkedBooks().filter((book) => String(book.folder || "").trim() === IGNORED_FOLDER);
    if (!selected.length)
      return;
    const applied = await applyAssignments(selected.map((book) => ({
      bookId: book.id,
      folder: ""
    })));
    if (!applied)
      return;
    selectedUnlinked.clear();
    renderAll(`Restored ${selected.length} ignored lorebook${selected.length === 1 ? "" : "s"}.`);
  }
  async function deleteSelectedBooks() {
    if (busy)
      return;
    const selected = selectedUnlinkedBooks();
    if (!selected.length)
      return;
    if (!window.confirm(`Delete ${selected.length} selected unlinked lorebook${selected.length === 1 ? "" : "s"}?

Bionic will refresh characters, chats, personas and global activation immediately before deletion.`)) {
      return;
    }
    busy = true;
    renderAll("Verifying selected lorebooks are still unlinked…");
    try {
      await freshReferences();
      const selectedIds = new Set(selected.map((book) => book.id));
      const nowReferenced = books.filter((book) => selectedIds.has(book.id) && book.references.length > 0);
      if (nowReferenced.length) {
        throw new Error(`Deletion stopped because ${nowReferenced.length} selected lorebook${nowReferenced.length === 1 ? "" : "s"} gained a reference.`);
      }
      let deleted = 0;
      for (const book of selected) {
        renderAll(`Deleting ${book.name}…`);
        await api(`/api/v1/world-books/${encodeURIComponent(book.id)}`, {
          method: "DELETE"
        });
        books = books.filter((item) => item.id !== book.id);
        selectedUnlinked.delete(book.id);
        deleted += 1;
      }
      rebuildGroups();
      renderAll(`Deleted ${deleted} unlinked lorebook${deleted === 1 ? "" : "s"}.`);
    } catch (error) {
      renderAll(`Bulk delete stopped: ${error?.message || String(error)}`);
    } finally {
      busy = false;
      syncSummary();
    }
  }
  async function linkSelectedBooks() {
    if (busy)
      return;
    const selected = selectedUnlinkedBooks();
    if (!selected.length)
      return;
    if (linkTargetKind === "persona" && selected.length !== 1) {
      renderAll("A persona can attach only one lorebook. Select exactly one lorebook for a persona target.");
      return;
    }
    if (linkTargetKind !== "global" && !linkTargetId) {
      renderAll("Choose a link target first.");
      return;
    }
    busy = true;
    renderAll("Refreshing references before linking…");
    try {
      const snapshot = await freshReferences();
      const selectedIds = selected.map((book) => book.id);
      if (linkTargetKind === "character") {
        const target = (snapshot.characters || []).find((item) => item.id === linkTargetId);
        if (!target) {
          throw new Error("Character target no longer exists.");
        }
        const next = Array.from(new Set([
          ...target.world_book_ids || [],
          ...selectedIds
        ]));
        await api(`/api/v1/characters/${encodeURIComponent(target.id)}`, {
          method: "PUT",
          body: JSON.stringify({
            world_book_ids: next
          })
        });
        const verified = await api(`/api/v1/characters/${encodeURIComponent(target.id)}`);
        const verifiedIds = Array.isArray(verified?.world_book_ids) ? verified.world_book_ids : Array.isArray(verified?.extensions?.world_book_ids) ? verified.extensions.world_book_ids : [];
        for (const id of selectedIds) {
          if (!verifiedIds.includes(id)) {
            throw new Error(`Character link verification failed for ${shortLoreId(id)}.`);
          }
        }
      } else if (linkTargetKind === "chat") {
        const target = (snapshot.chats || []).find((item) => item.id === linkTargetId);
        if (!target) {
          throw new Error("Chat target no longer exists.");
        }
        const current = Array.isArray(target?.metadata?.chat_world_book_ids) ? target.metadata.chat_world_book_ids : [];
        const next = Array.from(new Set([
          ...current,
          ...selectedIds
        ]));
        const updated = await api(`/api/v1/chats/${encodeURIComponent(target.id)}/metadata`, {
          method: "PATCH",
          body: JSON.stringify({
            chat_world_book_ids: next
          })
        });
        const verified = Array.isArray(updated?.metadata?.chat_world_book_ids) ? updated.metadata.chat_world_book_ids : [];
        for (const id of selectedIds) {
          if (!verified.includes(id)) {
            throw new Error(`Chat link verification failed for ${shortLoreId(id)}.`);
          }
        }
      } else if (linkTargetKind === "persona") {
        const target = (snapshot.personas || []).find((item) => item.id === linkTargetId);
        if (!target) {
          throw new Error("Persona target no longer exists.");
        }
        const personaResult = await api("/api/v1/personas/bulk-update", {
          method: "POST",
          body: JSON.stringify({
            ids: [
              target.id
            ],
            attached_world_book_id: selectedIds[0]
          })
        });
        if (!Array.isArray(personaResult?.updated) || personaResult.updated.length !== 1) {
          throw new Error("Persona link did not verify.");
        }
      } else if (linkTargetKind === "global") {
        const current = Array.isArray(snapshot.globalIds) ? snapshot.globalIds : [];
        await sendBackend("bionic_lore_set_global", {
          ids: Array.from(new Set([
            ...current,
            ...selectedIds
          ]))
        });
      } else {
        throw new Error("Unknown link target type.");
      }
      const refreshed = await sendBackend("bionic_lore_reference_snapshot");
      updateLocalRefs(refreshed.snapshot);
      selectedUnlinked.clear();
      linkPanelOpen = false;
      renderAll(`Linked ${selected.length} lorebook${selected.length === 1 ? "" : "s"} successfully.`);
    } catch (error) {
      renderAll(`Linking stopped: ${error?.message || String(error)}`);
    } finally {
      busy = false;
      syncSummary();
    }
  }
  function renderUnlinked() {
    const visible = visibleUnlinkedBooks();
    const selected = selectedUnlinkedBooks();
    const targets = linkTargets();
    const allVisibleSelected = visible.length > 0 && visible.every((book) => selectedUnlinked.has(book.id));
    const selectedIgnored = selected.filter((book) => String(book.folder || "").trim() === IGNORED_FOLDER).length;
    return `
      <div class="lb-organizer-card" style="margin-bottom:10px">
        <div class="lb-organizer-card-head">
          <div>
            <div class="lb-organizer-card-title">
              Unlinked library
            </div>

            <div class="lb-organizer-meta">
              ${unlinked.length} active ·
              ${ignored.length} ignored ·
              ${selected.length} selected
            </div>
          </div>

          <label class="lb-organizer-check">
            <input
              type="checkbox"
              data-organizer-show-ignored
              ${showIgnored ? "checked" : ""}
            >
            <span>Show ignored</span>
          </label>
        </div>

        <div class="lb-organizer-actions">
          <button
            type="button"
            data-organizer-select-visible
            ${visible.length ? "" : "disabled"}
          >
            ${allVisibleSelected ? "Unselect visible" : "Select visible"}
          </button>

          <button
            type="button"
            data-organizer-clear-selection
            ${selected.length ? "" : "disabled"}
          >
            Clear selection
          </button>

          <button
            type="button"
            data-organizer-open-link
            ${selected.length ? "" : "disabled"}
          >
            Link selected…
          </button>

          <button
            type="button"
            data-organizer-ignore-selected
            ${selected.length ? "" : "disabled"}
          >
            Ignore selected
          </button>

          <button
            type="button"
            data-organizer-restore-selected
            ${selectedIgnored ? "" : "disabled"}
          >
            Restore ignored
          </button>

          <button
            type="button"
            data-organizer-delete-selected
            ${selected.length ? "" : "disabled"}
          >
            Delete selected
          </button>
        </div>
      </div>

      ${linkPanelOpen ? `
            <div class="lb-organizer-card" style="margin-bottom:10px">
              <div class="lb-organizer-card-title">
                Link ${selected.length} selected lorebook${selected.length === 1 ? "" : "s"}
              </div>

              <div class="lb-organizer-meta">
                Character, chat and Global can receive multiple lorebooks.
                Persona supports one lorebook attachment.
              </div>

              <div class="lb-organizer-toolbar">
                <select
                  id="lb-organizer-link-kind"
                  ${busy ? "disabled" : ""}
                >
                  <option value="character" ${linkTargetKind === "character" ? "selected" : ""}>
                    Character
                  </option>

                  <option value="chat" ${linkTargetKind === "chat" ? "selected" : ""}>
                    Chat
                  </option>

                  <option value="persona" ${linkTargetKind === "persona" ? "selected" : ""}>
                    Persona
                  </option>

                  <option value="global" ${linkTargetKind === "global" ? "selected" : ""}>
                    Global activation
                  </option>
                </select>

                ${linkTargetKind !== "global" ? `
                      <select
                        id="lb-organizer-link-target"
                        ${busy ? "disabled" : ""}
                      >
                        <option value="">
                          Choose ${escapeHtml(linkTargetKind)}…
                        </option>

                        ${targets.map((target) => `
                            <option
                              value="${escapeHtml(target.id)}"
                              ${target.id === linkTargetId ? "selected" : ""}
                            >
                              ${escapeHtml(target.name)}
                            </option>
                          `).join("")}
                      </select>
                    ` : `
                      <span class="lb-organizer-badge">
                        Global lorebooks
                      </span>
                    `}

                <button
                  type="button"
                  data-organizer-link-apply
                  ${busy ? "disabled" : ""}
                >
                  Link selected
                </button>

                <button
                  type="button"
                  data-organizer-link-cancel
                >
                  Cancel
                </button>
              </div>
            </div>
          ` : ""}

      ${visible.length ? `
            <div class="lb-organizer-list">
              ${visible.map((book) => {
      const isIgnored = String(book.folder || "").trim() === IGNORED_FOLDER;
      return bookCard(book, `
                    <label class="lb-organizer-check">
                      <input
                        type="checkbox"
                        data-organizer-select-unlinked="${escapeHtml(book.id)}"
                        ${selectedUnlinked.has(book.id) ? "checked" : ""}
                      >
                      <span>
                        ${isIgnored ? "Ignored" : "Select"}
                      </span>
                    </label>

                    <button
                      type="button"
                      data-organizer-delete-unlinked="${escapeHtml(book.id)}"
                      ${busy ? "disabled" : ""}
                    >
                      Delete
                    </button>
                  `);
    }).join("")}
            </div>
          ` : `
            <div class="lb-organizer-empty">
              ${books.length ? showIgnored ? "No unlinked or ignored lorebooks match this search." : ignored.length ? `No active unlinked lorebooks. ${ignored.length} ignored.` : "No unlinked lorebooks found." : "Scan the library to begin."}
            </div>
          `}
    `;
  }
  function connectionOptions() {
    const selected = selectedConnectionId();
    const found = !selected || connections.some((connection) => connection.id === selected);
    const optionsHtml = connections.map((connection) => {
      const details = [
        connection.provider,
        connection.model
      ].filter(Boolean).join(" · ");
      return `
            <option
              value="${escapeHtml(connection.id)}"
              ${connection.id === selected ? "selected" : ""}
            >
              ${escapeHtml(connection.name)}${details ? ` — ${escapeHtml(details)}` : ""}
            </option>
          `;
    }).join("");
    return `
      <option
        value=""
        ${!selected ? "selected" : ""}
      >
        Active / default connection
      </option>

      ${selected && !found ? `
            <option
              value="${escapeHtml(selected)}"
              selected
            >
              Saved connection unavailable
            </option>
          ` : ""}

      ${optionsHtml}
    `;
  }
  function renderAi() {
    const byId = new Map(books.map((book) => [
      book.id,
      book
    ]));
    return `
      <div class="lb-organizer-ai-controls">
        <select
          id="lb-organizer-connection"
          ${busy ? "disabled" : ""}
        >
          ${connectionOptions()}
        </select>

        <button
          type="button"
          data-organizer-ai-analyze
          ${busy || books.length < 2 ? "disabled" : ""}
        >
          Analyze library
        </button>
      </div>

      <div class="lb-organizer-meta" style="margin-bottom:12px">
        The LLM only proposes folder names and membership.
        It cannot delete, merge, rename or rewrite lorebooks.
        Nothing moves until you press Apply.
        Libraries larger than 70 books are analyzed in batches.
      </div>

      ${suggestions.length ? `
            <div class="lb-organizer-actions" style="margin-bottom:12px">
              <button
                type="button"
                data-organizer-apply-all
                ${busy ? "disabled" : ""}
              >
                Apply all selected suggestions
              </button>
            </div>

            <div class="lb-organizer-list">
              ${suggestions.map((suggestion, index) => `
                <div
                  class="lb-organizer-card lb-organizer-suggestion"
                  data-organizer-suggestion="${index}"
                >
                  <div class="lb-organizer-card-title">
                    Suggested folder
                  </div>

                  <input
                    class="lb-organizer-suggestion-name"
                    type="text"
                    value="${escapeHtml(suggestion.name)}"
                    spellcheck="false"
                    aria-label="Folder name"
                  >

                  <div class="lb-organizer-checks">
                    ${suggestion.bookIds.map((id) => {
      const book = byId.get(id);
      if (!book)
        return "";
      return `
                        <label class="lb-organizer-check">
                          <input
                            type="checkbox"
                            data-organizer-book-id="${escapeHtml(book.id)}"
                            checked
                          >
                          <span>
                            ${escapeHtml(book.name)}
                            <small>
                              · ${escapeHtml(shortLoreId(book.id))}
                            </small>
                          </span>
                        </label>
                      `;
    }).join("")}
                  </div>

                  ${suggestion.reason ? `
                        <div class="lb-organizer-reason">
                          ${escapeHtml(suggestion.reason)}
                        </div>
                      ` : ""}

                  <div class="lb-organizer-actions">
                    <button
                      type="button"
                      data-organizer-apply-suggestion="${index}"
                      ${busy ? "disabled" : ""}
                    >
                      Apply this folder
                    </button>
                  </div>
                </div>
              `).join("")}
            </div>
          ` : `
            <div class="lb-organizer-empty">
              ${books.length ? "Choose a connection and analyze the library for folder suggestions." : "Scan the library before using AI Organize."}
            </div>
          `}
    `;
  }
  function activeContent() {
    if (activeTab === "duplicates") {
      return renderDuplicates();
    }
    if (activeTab === "unlinked") {
      return renderUnlinked();
    }
    if (activeTab === "ai") {
      return renderAi();
    }
    return renderOverview();
  }
  function renderModal() {
    if (!modalRoot)
      return;
    const lastScan = lastScanAt ? new Date(lastScanAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    }) : "Never";
    modalRoot.innerHTML = `
      <div class="lb-organizer-shell">
        <div class="lb-organizer-hero">
          <div class="lb-organizer-hero-left">
            <div>
              <div class="lb-organizer-hero-title">
                Bionic Lorebook Organizer
              </div>

              <div class="lb-organizer-hero-sub">
                Last scan: ${escapeHtml(lastScan)}
              </div>
            </div>
          </div>

          <div class="lb-organizer-actions">
            <button
              type="button"
              data-organizer-scan
              ${busy ? "disabled" : ""}
            >
              ${books.length ? "Rescan" : "Scan library"}
            </button>
          </div>
        </div>

        <div class="lb-organizer-toolbar">
          <input
            class="lb-organizer-search"
            id="lb-organizer-search"
            type="search"
            placeholder="Search lorebooks, folders, IDs or references"
            value="${escapeHtml(searchText)}"
          >

          <select
            class="lb-organizer-sort"
            id="lb-organizer-sort"
          >
            <option value="name" ${sortMode === "name" ? "selected" : ""}>
              Sort: name
            </option>
            <option value="folder" ${sortMode === "folder" ? "selected" : ""}>
              Sort: folder
            </option>
            <option value="entries" ${sortMode === "entries" ? "selected" : ""}>
              Sort: entry count
            </option>
            <option value="refs" ${sortMode === "refs" ? "selected" : ""}>
              Sort: reference count
            </option>
          </select>
        </div>

        <div>
          <div class="lb-organizer-tabs">
            ${[
      ["overview", "Overview"],
      ["duplicates", "Exact Duplicates"],
      ["unlinked", "Unlinked"],
      ["ai", "AI Organize"]
    ].map(([key, label]) => `
              <button
                type="button"
                class="lb-organizer-tab"
                data-organizer-tab="${key}"
                aria-selected="${String(activeTab === key)}"
              >
                ${label}
                ${key === "duplicates" && groups.length ? ` (${groups.length})` : key === "unlinked" && unlinked.length ? ` (${unlinked.length})` : ""}
              </button>
            `).join("")}
          </div>

          <div class="lb-organizer-status">
            ${escapeHtml(statusMessage)}
          </div>
        </div>

        <div class="lb-organizer-content">
          ${activeContent()}
        </div>
      </div>
    `;
  }
  function syncSummary() {
    const summary = settingsRoot.querySelector("#lb-lore-organizer-summary");
    const scanButton = settingsRoot.querySelector("#lb-lore-organizer-rescan");
    if (summary) {
      if (!lastScanAt) {
        summary.textContent = "Not scanned yet.";
      } else {
        summary.textContent = `${books.length} lorebooks · ${groups.length} duplicate group${groups.length === 1 ? "" : "s"} · ${unlinked.length} unlinked`;
      }
    }
    if (scanButton) {
      scanButton.textContent = books.length ? "Rescan" : "Scan";
      scanButton.disabled = busy;
    }
  }
  function renderAll(message) {
    if (typeof message === "string") {
      statusMessage = message;
    }
    renderModal();
    syncSummary();
  }
  function suggestionAssignments(card) {
    const nameInput = card.querySelector(".lb-organizer-suggestion-name");
    const folder = nameInput?.value.trim() || "";
    if (!folder) {
      throw new Error("Folder name cannot be empty.");
    }
    const assignments = Array.from(card.querySelectorAll("[data-organizer-book-id]")).filter((input) => input.checked).map((input) => ({
      bookId: input.dataset.organizerBookId || "",
      folder
    })).filter((item) => item.bookId);
    return assignments;
  }
  async function openOrganizer() {
    if (modal)
      return;
    modal = ctx.ui.showModal({
      title: "Lorebook Organizer",
      width: 1100,
      maxHeight: 900,
      persistent: false
    });
    modalRoot = modal.root;
    renderAll();
    modalRoot.addEventListener("click", (event) => {
      const target = event.target;
      const tabButton = target.closest("[data-organizer-tab]");
      if (tabButton) {
        activeTab = tabButton.dataset.organizerTab || "overview";
        renderAll();
        return;
      }
      if (target.closest("[data-organizer-scan]")) {
        scan();
        return;
      }
      const cleanButton = target.closest("[data-organizer-clean-group]");
      if (cleanButton) {
        const group = groups.find((item) => item.groupId === cleanButton.dataset.organizerCleanGroup);
        if (group) {
          cleanGroup(group);
        }
        return;
      }
      const deleteButton = target.closest("[data-organizer-delete-unlinked]");
      if (deleteButton) {
        const book = books.find((item) => item.id === deleteButton.dataset.organizerDeleteUnlinked);
        if (book) {
          deleteUnlinked(book);
        }
        return;
      }
      if (target.closest("[data-organizer-select-visible]")) {
        const visible = visibleUnlinkedBooks();
        const allSelected = visible.length > 0 && visible.every((book) => selectedUnlinked.has(book.id));
        for (const book of visible) {
          if (allSelected) {
            selectedUnlinked.delete(book.id);
          } else {
            selectedUnlinked.add(book.id);
          }
        }
        renderAll();
        return;
      }
      if (target.closest("[data-organizer-clear-selection]")) {
        selectedUnlinked.clear();
        renderAll();
        return;
      }
      if (target.closest("[data-organizer-open-link]")) {
        linkPanelOpen = true;
        const targets = linkTargets();
        if (linkTargetKind !== "global" && !targets.some((item) => item.id === linkTargetId)) {
          linkTargetId = "";
        }
        renderAll();
        return;
      }
      if (target.closest("[data-organizer-link-cancel]")) {
        linkPanelOpen = false;
        renderAll();
        return;
      }
      if (target.closest("[data-organizer-link-apply]")) {
        linkSelectedBooks();
        return;
      }
      if (target.closest("[data-organizer-ignore-selected]")) {
        ignoreSelectedBooks();
        return;
      }
      if (target.closest("[data-organizer-restore-selected]")) {
        restoreSelectedBooks();
        return;
      }
      if (target.closest("[data-organizer-delete-selected]")) {
        deleteSelectedBooks();
        return;
      }
      if (target.closest("[data-organizer-ai-analyze]")) {
        analyzeFolders();
        return;
      }
      const applyOne = target.closest("[data-organizer-apply-suggestion]");
      if (applyOne) {
        const card = applyOne.closest("[data-organizer-suggestion]");
        if (!card)
          return;
        try {
          const assignments = suggestionAssignments(card);
          applyAssignments(assignments);
        } catch (error) {
          renderAll(error?.message || String(error));
        }
        return;
      }
      if (target.closest("[data-organizer-apply-all]")) {
        try {
          const assignments = Array.from(modalRoot.querySelectorAll("[data-organizer-suggestion]")).flatMap((card) => suggestionAssignments(card));
          applyAssignments(assignments);
        } catch (error) {
          renderAll(error?.message || String(error));
        }
      }
    });
    modalRoot.addEventListener("input", (event) => {
      const target = event.target;
      if (target.id === "lb-organizer-search") {
        searchText = target.value;
        const content = modalRoot?.querySelector(".lb-organizer-content");
        if (content) {
          content.innerHTML = activeContent();
        }
      }
    });
    modalRoot.addEventListener("change", (event) => {
      const target = event.target;
      if (target.matches("[data-organizer-select-unlinked]")) {
        const id = target.dataset.organizerSelectUnlinked || "";
        if (id) {
          if (target.checked) {
            selectedUnlinked.add(id);
          } else {
            selectedUnlinked.delete(id);
          }
        }
        renderAll();
        return;
      }
      if (target.matches("[data-organizer-show-ignored]")) {
        showIgnored = target.checked;
        renderAll();
        return;
      }
      if (target.id === "lb-organizer-link-kind") {
        linkTargetKind = target.value;
        linkTargetId = "";
        renderAll();
        return;
      }
      if (target.id === "lb-organizer-link-target") {
        linkTargetId = target.value;
        return;
      }
      if (target.id === "lb-organizer-sort") {
        sortMode = target.value;
        renderAll();
        return;
      }
      if (target.id === "lb-organizer-connection") {
        saveConnectionId(target.value);
      }
    });
    modal.onDismiss(() => {
      modal = null;
      modalRoot = null;
    });
    if (connections.length === 0) {
      try {
        await loadConnections();
      } catch (error) {
        renderAll(`Could not load LLM connections: ${error?.message || String(error)}`);
      }
    }
  }
  const openButton = settingsRoot.querySelector("#lb-lore-organizer-open");
  const rescanButton = settingsRoot.querySelector("#lb-lore-organizer-rescan");
  const openHandler = () => {
    openOrganizer();
  };
  const rescanHandler = () => {
    scan();
  };
  openButton?.addEventListener("click", openHandler);
  rescanButton?.addEventListener("click", rescanHandler);
  const unsubscribeBackend = ctx.onBackendMessage((payload) => {
    handleBackendMessage(payload);
  });
  syncSummary();
  return () => {
    openButton?.removeEventListener("click", openHandler);
    rescanButton?.removeEventListener("click", rescanHandler);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Lorebook Organizer unloaded."));
    }
    pending.clear();
    if (typeof unsubscribeBackend === "function") {
      unsubscribeBackend();
    }
    removeOrganizerStyle?.();
  };
}

// src/frontend.ts
var BIONIC_DRAWER_ICON_SVG = `
<svg
  xmlns="http://www.w3.org/2000/svg"
  viewBox="0 0 24 24"
  fill="none"
>
  <rect
    x="3"
    y="3"
    width="8"
    height="8"
    rx="2.2"
    fill="currentColor"
  />
  <rect
    x="13"
    y="3"
    width="8"
    height="5"
    rx="2"
    fill="currentColor"
    opacity=".55"
  />
  <rect
    x="13"
    y="10"
    width="8"
    height="11"
    rx="2.2"
    fill="currentColor"
    opacity=".88"
  />
  <rect
    x="3"
    y="13"
    width="8"
    height="8"
    rx="2.2"
    fill="currentColor"
    opacity=".4"
  />
</svg>
`;
function setup(ctx) {
  const MESSAGE_SELECTOR = '[data-component="MessageContent"]';
  const SETTINGS_KEY = "lumiverse:bionic-style-reading:settings";
  const LEGACY_SETTINGS_KEYS = [
    "lumiverse:bionic-style-reading:v0.42",
    "lumiverse:bionic-style-reading:v0.41",
    "lumiverse:bionic-style-reading:v0.40",
    "lumiverse:bionic-style-reading:v0.39",
    "lumiverse:bionic-style-reading:v0.38",
    "lumiverse:bionic-style-reading:v0.37",
    "lumiverse:bionic-style-reading:v0.36",
    "lumiverse:bionic-style-reading:v0.35",
    "lumiverse:bionic-style-reading:v0.34",
    "lumiverse:bionic-style-reading:v0.33",
    "lumiverse:bionic-style-reading:v0.32",
    "lumiverse:bionic-style-reading:v0.31",
    "lumiverse:bionic-style-reading:v0.30",
    "lumiverse:bionic-style-reading:v0.29",
    "lumiverse:bionic-style-reading:v0.28",
    "lumiverse:bionic-style-reading:v0.27",
    "lumiverse:bionic-style-reading:v0.26",
    "lumiverse:bionic-style-reading:v0.25",
    "lumiverse:bionic-style-reading:v0.24",
    "lumiverse:bionic-style-reading:v0.23",
    "lumiverse:bionic-style-reading:v0.22",
    "lumiverse:bionic-style-reading:v0.21",
    "lumiverse:bionic-style-reading:v0.20",
    "lumiverse:bionic-style-reading:v0.19",
    "lumiverse:bionic-style-reading:v0.18",
    "lumiverse:bionic-style-reading:v0.17",
    "lumiverse:bionic-style-reading:v0.16",
    "lumiverse:bionic-style-reading:v0.15",
    "lumiverse:bionic-style-reading:v0.14",
    "lumiverse:bionic-style-reading:v0.13",
    "lumiverse:bionic-style-reading:v0.12",
    "lumiverse:bionic-style-reading:v0.11",
    "lumiverse:bionic-style-reading:v0.10",
    "lumiverse:bionic-style-reading:v0.9",
    "lumiverse:bionic-style-reading:v0.8",
    "lumiverse:bionic-style-reading:v0.7"
  ];
  const UI_STATE_KEY = "lumiverse:bionic-style-ui:v0.48";
  const WORD_RE = /\p{L}[\p{L}\p{M}\p{N}'’\-]*/gu;
  const TOOLBAR_BUTTONS = [
    { key: "backHome", label: "Back to home", title: "Back to home", className: "lb-hide-toolbar-back-home" },
    { key: "latestMessageTop", label: "Top of latest message", title: "Top of latest message", className: "lb-hide-toolbar-latest-message-top" },
    { key: "autoRegenerate", label: "Auto regenerate", title: "Auto regenerate", className: "lb-hide-toolbar-auto-regenerate" },
    { key: "regenerate", label: "Regenerate", title: "Regenerate", className: "lb-hide-toolbar-regenerate" },
    { key: "continue", label: "Continue", title: "Continue", className: "lb-hide-toolbar-continue" },
    { key: "oneLiner", label: "One-liner nudge", title: "One-liner: Chat history + impersonation nudge only", className: "lb-hide-toolbar-one-liner" },
    { key: "persona", label: "Switch persona", title: "Switch persona for this chat", className: "lb-hide-toolbar-persona" },
    { key: "connection", label: "Connection", title: "Connection:", className: "lb-hide-toolbar-connection" },
    { key: "alternateFields", label: "Alternate fields", title: "Alternate fields", className: "lb-hide-toolbar-alternate-fields" },
    { key: "guidedGenerations", label: "Guided generations", title: "Guided generations", className: "lb-hide-toolbar-guided" },
    { key: "quickReplies", label: "Quick replies", title: "Quick replies", className: "lb-hide-toolbar-quick-replies" },
    { key: "tools", label: "Tools", title: "Tools", className: "lb-hide-toolbar-tools" },
    { key: "extras", label: "Extras", title: "Extras", className: "lb-hide-toolbar-extras" },
    { key: "customizeToolbar", label: "Customize toolbar", title: "Customize toolbar", className: "lb-hide-toolbar-customize" },
    {
      key: "attachments",
      label: "Attachments / paperclip",
      title: "Attach",
      titles: [
        "attach",
        "attachment",
        "attachments",
        "attach file",
        "attach files",
        "add attachment",
        "add attachments",
        "upload file",
        "upload files"
      ],
      className: "lb-hide-toolbar-attachments"
    }
  ];
  const DEFAULT_TOOLBAR_HIDDEN = Object.fromEntries(TOOLBAR_BUTTONS.map((item) => [item.key, false]));
  const DEFAULTS = {
    preset: "custom",
    bionicEnabled: true,
    density: "balanced",
    fixation: 35,
    weight: 600,
    fontEnabled: false,
    font: "inherit",
    customFont: "",
    scopeMessages: true,
    scopeBubble: false,
    scopeComposer: false,
    scopeMenus: false,
    scopeNavigation: false,
    scopeAll: false,
    justifyMessages: false,
    hyphenateMessages: false,
    readingWidth: "full",
    paragraphSpacing: 0,
    letterSpacing: 0,
    wordSpacing: 0,
    textSize: 100,
    lineHeight: 1.55,
    ffThinkFixEnabled: false,
    ffThinkBoundaryText: "[ \uD83D\uDD70️ Time",
    ffThinkReasoningSide: "before",
    ffThinkIncludeMarker: false,
    autoRegenerateEnabled: false,
    autoRegenerateTriggerText: "",
    autoRegenerateMaxAttempts: 3,
    settingsPersistenceMode: "account",
    toolbarSpacing: 4,
    toolbarHidden: { ...DEFAULT_TOOLBAR_HIDDEN }
  };
  const FONT_OPTIONS = [
    ["inherit", "Lumiverse default"],
    ["system-ui, sans-serif", "System Sans"],
    ["Arial, sans-serif", "Arial"],
    ["Verdana, sans-serif", "Verdana"],
    ["Tahoma, sans-serif", "Tahoma"],
    ['"Trebuchet MS", sans-serif', "Trebuchet MS"],
    ["Georgia, serif", "Georgia"],
    ['"Times New Roman", serif', "Times New Roman"],
    ['"Atkinson Hyperlegible", sans-serif', "Atkinson Hyperlegible"],
    ['"OpenDyslexic", sans-serif', "OpenDyslexic"],
    ["custom", "Custom font / CSS stack"]
  ];
  const WIDTH_OPTIONS = [
    ["full", "Full width"],
    ["55ch", "55 characters — narrow"],
    ["65ch", "65 characters — comfortable"],
    ["75ch", "75 characters — relaxed"],
    ["85ch", "85 characters — wide"]
  ];
  const PRESETS = {
    clean: {
      bionicEnabled: false,
      justifyMessages: false,
      hyphenateMessages: false,
      readingWidth: "full",
      paragraphSpacing: 0,
      letterSpacing: 0,
      wordSpacing: 0,
      textSize: 100,
      lineHeight: 1.55
    },
    comfortable: {
      bionicEnabled: false,
      justifyMessages: true,
      hyphenateMessages: true,
      readingWidth: "65ch",
      paragraphSpacing: 0.6,
      letterSpacing: 0.01,
      wordSpacing: 0.02,
      textSize: 105,
      lineHeight: 1.6
    },
    mobile: {
      bionicEnabled: false,
      justifyMessages: true,
      hyphenateMessages: true,
      readingWidth: "full",
      paragraphSpacing: 0.5,
      letterSpacing: 0.005,
      wordSpacing: 0.01,
      textSize: 105,
      lineHeight: 1.6
    },
    bionicLight: {
      bionicEnabled: true,
      density: "light",
      fixation: 30,
      weight: 600,
      justifyMessages: true,
      hyphenateMessages: true,
      readingWidth: "65ch",
      paragraphSpacing: 0.5,
      letterSpacing: 0.005,
      wordSpacing: 0.01,
      textSize: 100,
      lineHeight: 1.6
    }
  };
  const BIONIC_SKIP_SELECTOR = [
    "code",
    "pre",
    "kbd",
    "samp",
    "button",
    "textarea",
    "input",
    "select",
    "option",
    "script",
    "style",
    "svg",
    "math",
    "strong",
    "b",
    '[contenteditable="true"]',
    "[data-lumiverse-html-island]",
    "[data-lumibionic-word]"
  ].join(",");
  let loadedFontFace = null;
  let loadedFontUrl = null;
  let settings = loadSettings();
  let scheduled = false;
  let rebuilding = false;
  const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  function clamp(value, min, max, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }
  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY) || LEGACY_SETTINGS_KEYS.map((key) => localStorage.getItem(key)).find(Boolean) || "{}";
      const saved = JSON.parse(raw);
      return {
        ...DEFAULTS,
        preset: ["custom", "clean", "comfortable", "mobile", "bionicLight"].includes(saved.preset) ? saved.preset : "custom",
        bionicEnabled: typeof saved.bionicEnabled === "boolean" ? saved.bionicEnabled : DEFAULTS.bionicEnabled,
        density: ["light", "balanced", "full"].includes(saved.density) ? saved.density : DEFAULTS.density,
        fixation: clamp(saved.fixation, 20, 70, DEFAULTS.fixation),
        weight: clamp(saved.weight, 500, 900, DEFAULTS.weight),
        fontEnabled: typeof saved.fontEnabled === "boolean" ? saved.fontEnabled : DEFAULTS.fontEnabled,
        font: typeof saved.font === "string" ? saved.font : DEFAULTS.font,
        customFont: typeof saved.customFont === "string" ? saved.customFont : DEFAULTS.customFont,
        scopeMessages: typeof saved.scopeMessages === "boolean" ? saved.scopeMessages : DEFAULTS.scopeMessages,
        scopeBubble: typeof saved.scopeBubble === "boolean" ? saved.scopeBubble : DEFAULTS.scopeBubble,
        scopeComposer: typeof saved.scopeComposer === "boolean" ? saved.scopeComposer : DEFAULTS.scopeComposer,
        scopeMenus: typeof saved.scopeMenus === "boolean" ? saved.scopeMenus : DEFAULTS.scopeMenus,
        scopeNavigation: typeof saved.scopeNavigation === "boolean" ? saved.scopeNavigation : DEFAULTS.scopeNavigation,
        scopeAll: typeof saved.scopeAll === "boolean" ? saved.scopeAll : DEFAULTS.scopeAll,
        justifyMessages: typeof saved.justifyMessages === "boolean" ? saved.justifyMessages : DEFAULTS.justifyMessages,
        hyphenateMessages: typeof saved.hyphenateMessages === "boolean" ? saved.hyphenateMessages : DEFAULTS.hyphenateMessages,
        readingWidth: WIDTH_OPTIONS.some(([value]) => value === saved.readingWidth) ? saved.readingWidth : DEFAULTS.readingWidth,
        paragraphSpacing: clamp(saved.paragraphSpacing, 0, 1.5, DEFAULTS.paragraphSpacing),
        letterSpacing: clamp(saved.letterSpacing, -0.03, 0.12, DEFAULTS.letterSpacing),
        wordSpacing: clamp(saved.wordSpacing, -0.05, 0.3, DEFAULTS.wordSpacing),
        textSize: clamp(saved.textSize, 80, 140, DEFAULTS.textSize),
        lineHeight: clamp(saved.lineHeight, 1.1, 2.2, DEFAULTS.lineHeight),
        ffThinkFixEnabled: typeof saved.ffThinkFixEnabled === "boolean" ? saved.ffThinkFixEnabled : DEFAULTS.ffThinkFixEnabled,
        ffThinkBoundaryText: typeof saved.ffThinkBoundaryText === "string" ? saved.ffThinkBoundaryText : DEFAULTS.ffThinkBoundaryText,
        ffThinkReasoningSide: ["before", "after"].includes(saved.ffThinkReasoningSide) ? saved.ffThinkReasoningSide : DEFAULTS.ffThinkReasoningSide,
        ffThinkIncludeMarker: typeof saved.ffThinkIncludeMarker === "boolean" ? saved.ffThinkIncludeMarker : DEFAULTS.ffThinkIncludeMarker,
        autoRegenerateEnabled: typeof saved.autoRegenerateEnabled === "boolean" ? saved.autoRegenerateEnabled : DEFAULTS.autoRegenerateEnabled,
        autoRegenerateTriggerText: typeof saved.autoRegenerateTriggerText === "string" ? saved.autoRegenerateTriggerText : DEFAULTS.autoRegenerateTriggerText,
        autoRegenerateMaxAttempts: clamp(saved.autoRegenerateMaxAttempts, 1, 10, DEFAULTS.autoRegenerateMaxAttempts),
        settingsPersistenceMode: saved.settingsPersistenceMode === "browser" ? "browser" : "account",
        toolbarSpacing: clamp(saved.toolbarSpacing, 0, 16, DEFAULTS.toolbarSpacing),
        toolbarHidden: Object.fromEntries(TOOLBAR_BUTTONS.map((item) => [
          item.key,
          typeof saved.toolbarHidden?.[item.key] === "boolean" ? saved.toolbarHidden[item.key] : DEFAULT_TOOLBAR_HIDDEN[item.key]
        ]))
      };
    } catch {
      return { ...DEFAULTS };
    }
  }
  let applyingAccountSettings = false;
  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {}
    if (!applyingAccountSettings && settings.settingsPersistenceMode === "account") {
      try {
        ctx.sendToBackend({
          type: "bionic_settings_save",
          settings
        });
        if (settingsSaveStatus) {
          settingsSaveStatus.textContent = "Settings storage: saving to your Lumiverse account…";
        }
      } catch {
        if (settingsSaveStatus) {
          settingsSaveStatus.textContent = "Settings storage: account save failed; browser copy kept.";
        }
      }
    }
  }
  function requestAccountSettings() {
    try {
      ctx.sendToBackend({
        type: "bionic_settings_load"
      });
      if (settingsSaveStatus) {
        settingsSaveStatus.textContent = "Settings storage: loading account-saved settings…";
      }
    } catch {
      if (settingsSaveStatus) {
        settingsSaveStatus.textContent = "Settings storage: backend unavailable; browser copy active.";
      }
    }
  }
  function graphemes(value) {
    if (!segmenter)
      return Array.from(value);
    return Array.from(segmenter.segment(value), (part) => part.segment);
  }
  function currentFont() {
    if (loadedFontFace) {
      return '"LumibionicCustomFile", sans-serif';
    }
    if (settings.font === "custom") {
      return settings.customFont.trim() || "inherit";
    }
    return settings.font || "inherit";
  }
  function shouldEmphasize(length) {
    if (settings.density === "light")
      return length >= 6;
    if (settings.density === "balanced")
      return length >= 4;
    return length >= 2;
  }
  function fixationCut(word) {
    const chars = graphemes(word);
    const length = chars.length;
    if (!shouldEmphasize(length)) {
      return { chars, cut: 0 };
    }
    let base;
    if (length <= 5)
      base = 1;
    else if (length <= 8)
      base = 2;
    else if (length <= 11)
      base = 3;
    else
      base = 4;
    const multiplier = settings.fixation / 35;
    let cut = Math.round(base * multiplier);
    cut = Math.max(1, Math.min(cut, 4, length - 1));
    return { chars, cut };
  }
  const removeStyle = ctx.dom.addStyle(`
    /*
     * Font reach is controlled by classes placed on <html>.
     * The broad rules intentionally use !important so custom themes
     * cannot silently win the font-family cascade.
     */

    html.lb-font-messages ${MESSAGE_SELECTOR},
    html.lb-font-messages ${MESSAGE_SELECTOR} * {
      font-family: var(--lumibionic-font-family, inherit) !important;
    }

    html.lb-font-bubble .lumibionic-bubble-scope,
    html.lb-font-bubble .lumibionic-bubble-scope * {
      font-family: var(--lumibionic-font-family, inherit) !important;
    }

    html.lb-font-composer textarea,
    html.lb-font-composer input,
    html.lb-font-composer [contenteditable="true"],
    html.lb-font-composer form button,
    html.lb-font-composer form button * {
      font-family: var(--lumibionic-font-family, inherit) !important;
    }

    html.lb-font-menus [role="menu"],
    html.lb-font-menus [role="menu"] *,
    html.lb-font-menus [role="menuitem"],
    html.lb-font-menus [role="menuitem"] *,
    html.lb-font-menus [role="listbox"],
    html.lb-font-menus [role="listbox"] *,
    html.lb-font-menus [role="option"],
    html.lb-font-menus [role="option"] *,
    html.lb-font-menus [role="dialog"],
    html.lb-font-menus [role="dialog"] *,
    html.lb-font-menus [data-radix-popper-content-wrapper],
    html.lb-font-menus [data-radix-popper-content-wrapper] *,
    html.lb-font-menus [data-floating-ui-portal],
    html.lb-font-menus [data-floating-ui-portal] * {
      font-family: var(--lumibionic-font-family, inherit) !important;
    }

    html.lb-font-navigation nav,
    html.lb-font-navigation nav *,
    html.lb-font-navigation aside,
    html.lb-font-navigation aside *,
    html.lb-font-navigation header,
    html.lb-font-navigation header *,
    html.lb-font-navigation [role="navigation"],
    html.lb-font-navigation [role="navigation"] *,
    html.lb-font-navigation [role="tablist"],
    html.lb-font-navigation [role="tablist"] *,
    html.lb-font-navigation [role="tab"],
    html.lb-font-navigation [role="tab"] * {
      font-family: var(--lumibionic-font-family, inherit) !important;
    }

    html.lb-font-all body,
    html.lb-font-all body * {
      font-family: var(--lumibionic-font-family, inherit) !important;
    }

    /*
     * Preserve code readability even when "Entire interface" is enabled.
     */
    html.lb-font-messages ${MESSAGE_SELECTOR} code,
    html.lb-font-messages ${MESSAGE_SELECTOR} code *,
    html.lb-font-messages ${MESSAGE_SELECTOR} pre,
    html.lb-font-messages ${MESSAGE_SELECTOR} pre *,
    html.lb-font-bubble .lumibionic-bubble-scope code,
    html.lb-font-bubble .lumibionic-bubble-scope code *,
    html.lb-font-bubble .lumibionic-bubble-scope pre,
    html.lb-font-bubble .lumibionic-bubble-scope pre *,
    html.lb-font-all code,
    html.lb-font-all code *,
    html.lb-font-all pre,
    html.lb-font-all pre *,
    html.lb-font-all kbd,
    html.lb-font-all samp {
      font-family:
        "SF Mono",
        "Fira Code",
        "JetBrains Mono",
        "Menlo",
        "Consolas",
        monospace !important;
    }

    /*
     * Do not let font overrides interfere with SVG icon internals.
     */
    html.lb-font-all svg,
    html.lb-font-all svg * {
      font-family: initial !important;
    }

    ${MESSAGE_SELECTOR} {
      font-size: var(--lumibionic-text-size, 100%) !important;
      line-height: var(--lumibionic-line-height, 1.55) !important;
    }

    ${MESSAGE_SELECTOR}.lumibionic-justify {
      text-align: justify !important;
      text-justify: inter-word;
    }

    ${MESSAGE_SELECTOR}.lumibionic-justify p,
    ${MESSAGE_SELECTOR}.lumibionic-justify li,
    ${MESSAGE_SELECTOR}.lumibionic-justify blockquote {
      text-align: justify !important;
      text-justify: inter-word;
    }

    ${MESSAGE_SELECTOR}.lumibionic-justify pre,
    ${MESSAGE_SELECTOR}.lumibionic-justify code,
    ${MESSAGE_SELECTOR}.lumibionic-justify table,
    ${MESSAGE_SELECTOR}.lumibionic-justify th,
    ${MESSAGE_SELECTOR}.lumibionic-justify td,
    ${MESSAGE_SELECTOR}.lumibionic-justify button {
      text-align: initial !important;
    }

    ${MESSAGE_SELECTOR}.lumibionic-hyphens,
    ${MESSAGE_SELECTOR}.lumibionic-hyphens p,
    ${MESSAGE_SELECTOR}.lumibionic-hyphens li,
    ${MESSAGE_SELECTOR}.lumibionic-hyphens blockquote {
      hyphens: auto !important;
      -webkit-hyphens: auto !important;
    }

    ${MESSAGE_SELECTOR}.lumibionic-hyphens pre,
    ${MESSAGE_SELECTOR}.lumibionic-hyphens code,
    ${MESSAGE_SELECTOR}.lumibionic-hyphens table {
      hyphens: none !important;
      -webkit-hyphens: none !important;
    }

    ${MESSAGE_SELECTOR}.lumibionic-reading-width {
      max-width: var(--lumibionic-reading-width) !important;
    }

    ${MESSAGE_SELECTOR}.lumibionic-paragraph-spacing p {
      margin-block-start: 0 !important;
      margin-block-end: var(--lumibionic-paragraph-spacing) !important;
    }

    ${MESSAGE_SELECTOR}.lumibionic-paragraph-spacing p:last-child {
      margin-block-end: 0 !important;
    }

    ${MESSAGE_SELECTOR}.lumibionic-letter-spacing,
    ${MESSAGE_SELECTOR}.lumibionic-letter-spacing p,
    ${MESSAGE_SELECTOR}.lumibionic-letter-spacing li,
    ${MESSAGE_SELECTOR}.lumibionic-letter-spacing blockquote,
    ${MESSAGE_SELECTOR}.lumibionic-letter-spacing a,
    ${MESSAGE_SELECTOR}.lumibionic-letter-spacing span,
    ${MESSAGE_SELECTOR}.lumibionic-letter-spacing em,
    ${MESSAGE_SELECTOR}.lumibionic-letter-spacing strong {
      letter-spacing: var(--lumibionic-letter-spacing) !important;
    }

    ${MESSAGE_SELECTOR}.lumibionic-word-spacing,
    ${MESSAGE_SELECTOR}.lumibionic-word-spacing p,
    ${MESSAGE_SELECTOR}.lumibionic-word-spacing li,
    ${MESSAGE_SELECTOR}.lumibionic-word-spacing blockquote,
    ${MESSAGE_SELECTOR}.lumibionic-word-spacing a,
    ${MESSAGE_SELECTOR}.lumibionic-word-spacing span,
    ${MESSAGE_SELECTOR}.lumibionic-word-spacing em,
    ${MESSAGE_SELECTOR}.lumibionic-word-spacing strong {
      word-spacing: var(--lumibionic-word-spacing) !important;
    }

    ${MESSAGE_SELECTOR}.lumibionic-letter-spacing code,
    ${MESSAGE_SELECTOR}.lumibionic-letter-spacing pre {
      letter-spacing: normal !important;
    }

    ${MESSAGE_SELECTOR}.lumibionic-word-spacing code,
    ${MESSAGE_SELECTOR}.lumibionic-word-spacing pre {
      word-spacing: normal !important;
    }

    [data-lumibionic-fix] {
      font-weight: var(--lumibionic-weight, 600) !important;
    }

    /* Chat toolbar visibility — exact title matches requested by the user. */
    html.lb-hide-toolbar-back-home
    [data-component="InputArea"] [data-spindle-mount="chat_toolbar"]
    button[title*="Back to home"] {
      display: none !important;
    }

    html.lb-hide-toolbar-regenerate
    [data-component="InputArea"] [data-spindle-mount="chat_toolbar"]
    button[title*="Regenerate"] {
      display: none !important;
    }

    html.lb-hide-toolbar-continue
    [data-component="InputArea"] [data-spindle-mount="chat_toolbar"]
    button[title*="Continue"] {
      display: none !important;
    }

    html.lb-hide-toolbar-one-liner
    [data-component="InputArea"] [data-spindle-mount="chat_toolbar"]
    button[title*="One-liner: Chat history + impersonation nudge only"] {
      display: none !important;
    }

    html.lb-hide-toolbar-persona
    [data-component="InputArea"] [data-spindle-mount="chat_toolbar"]
    button[title*="Switch persona for this chat"] {
      display: none !important;
    }

    html.lb-hide-toolbar-connection
    [data-component="InputArea"] [data-spindle-mount="chat_toolbar"]
    button[title*="Connection:"] {
      display: none !important;
    }

    html.lb-hide-toolbar-alternate-fields
    [data-component="InputArea"] [data-spindle-mount="chat_toolbar"]
    button[title*="Alternate fields"] {
      display: none !important;
    }

    html.lb-hide-toolbar-guided
    [data-component="InputArea"] [data-spindle-mount="chat_toolbar"]
    button[title*="Guided generations"] {
      display: none !important;
    }

    html.lb-hide-toolbar-quick-replies
    [data-component="InputArea"] [data-spindle-mount="chat_toolbar"]
    button[title*="Quick replies"] {
      display: none !important;
    }

    html.lb-hide-toolbar-tools
    [data-component="InputArea"] [data-spindle-mount="chat_toolbar"]
    button[title*="Tools"] {
      display: none !important;
    }

    html.lb-hide-toolbar-extras
    [data-component="InputArea"] [data-spindle-mount="chat_toolbar"]
    button[title*="Extras"] {
      display: none !important;
    }

    .lumibionic-settings {
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .lumibionic-settings h2 {
      margin: 0;
      font-size: 17px;
    }

    .lumibionic-section {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding-top: 6px;
    }

    .lumibionic-section + .lumibionic-section {
      border-top: 1px solid rgba(127, 127, 127, 0.2);
      padding-top: 10px;
    }

    .lumibionic-group {
      border: 1px solid var(--lumi-border, rgba(127,127,127,.22));
      border-radius: 12px;
      overflow: clip;
      margin: 10px 0;
    }

    .lumibionic-group > summary {
      cursor: pointer;
      user-select: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      font-weight: 800;
      list-style: none;
    }

    .lumibionic-group > summary::-webkit-details-marker {
      display: none;
    }

    .lumibionic-group > summary::after {
      content: '▾';
      opacity: .7;
      transform: rotate(-90deg);
      transition: transform 120ms ease;
    }

    .lumibionic-group[open] > summary::after {
      transform: rotate(0deg);
    }

    .lumibionic-group-body {
      padding: 0 12px 12px;
    }

    .lumibionic-lorebook-list {
      display: grid;
      gap: 10px;
      margin-top: 10px;
    }

    .lumibionic-lorebook-card {
      min-width: 0;
      overflow: hidden;
      border: 1px solid var(--lumi-border, rgba(127,127,127,.24));
      border-radius: 10px;
      padding: 11px;
    }

    .lumibionic-lorebook-card-title {
      font-weight: 800;
      margin-bottom: 8px;
      overflow-wrap: anywhere;
    }

    .lumibionic-lorebook-book {
      min-width: 0;
      padding: 8px 0;
      border-top: 1px solid var(--lumi-border, rgba(127,127,127,.16));
      font-size: 12px;
    }

    .lumibionic-lorebook-book:first-of-type {
      border-top: 0;
    }

    .lumibionic-lorebook-book-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }

    .lumibionic-lorebook-role {
      display: inline-flex;
      align-items: center;
      flex: 0 0 auto;
      padding: 1px 7px;
      border: 1px solid currentColor;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: .04em;
      opacity: .86;
    }

    .lumibionic-lorebook-book.is-duplicate .lumibionic-lorebook-role {
      opacity: .62;
    }

    .lumibionic-lorebook-id {
      min-width: 0;
      max-width: 55%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 10px;
      opacity: .58;
    }

    .lumibionic-lorebook-name {
      margin-top: 4px;
      font-weight: 700;
      overflow-wrap: anywhere;
    }

    .lumibionic-lorebook-meta,
    .lumibionic-lorebook-summary {
      margin-top: 3px;
      font-size: 12px;
      line-height: 1.4;
      opacity: .7;
      overflow-wrap: anywhere;
    }

    .lumibionic-lorebook-summary {
      margin-top: 9px;
    }

    .lumibionic-lorebook-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 9px;
    }

    .lumibionic-status-pill {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 2px 9px;
      border: 1px solid currentColor;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 800;
    }

    .lumibionic-section-title {
      font-size: 14px;
      font-weight: 700;
    }


    .lumibionic-section-toggle {
      width: 100% !important;
      padding: 6px 0 !important;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      border: 0;
      background: transparent;
      text-align: left;
      font-size: 14px;
      font-weight: 700;
    }

    .lumibionic-section-toggle::after {
      content: "▾";
      opacity: 0.62;
      transition: transform 120ms ease;
    }

    .lumibionic-section-toggle[aria-expanded="false"]::after {
      transform: rotate(-90deg);
    }

    .lumibionic-section-body {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .lumibionic-section-body.lumibionic-section-collapsed {
      display: none !important;
    }

    .lumibionic-preview-section {
      position: relative;
      margin: 0 -8px;
      padding: 10px 8px 12px !important;
      border-top: 0 !important;
      border-bottom: 1px solid rgba(127, 127, 127, 0.22);
      background: color-mix(in srgb, var(--lumiverse-bg, #080812) 92%, transparent);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }

    .lumibionic-preview-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 8px;
    }

    .lumibionic-preview-toolbar strong {
      font-size: 13px;
    }

    .lumibionic-preview-toolbar button {
      width: auto !important;
      padding: 6px 9px !important;
      font-size: 12px;
    }

    .lumibionic-ui-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    .lumibionic-ff-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }

    .lumibionic-ff-grid .lumibionic-control {
      min-width: 0;
    }

    .lumibionic-ff-grid input[type="text"] {
      width: 100%;
      box-sizing: border-box;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    @media (max-width: 720px) {
      .lumibionic-ff-grid {
        grid-template-columns: 1fr;
      }
    }

    .lumibionic-toolbar-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .lumibionic-toolbar-toggle {
      min-height: 48px;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      justify-content: center;
      gap: 2px;
      text-align: left;
      border: 1px solid rgba(127, 127, 127, 0.22);
      background: rgba(127, 127, 127, 0.04);
    }

    .lumibionic-toolbar-toggle small {
      opacity: 0.64;
      font-size: 11px;
    }

    .lumibionic-toolbar-toggle[data-hidden="true"] {
      border-color: color-mix(in srgb, var(--lumiverse-primary, #7c9bc8) 58%, transparent);
      background: color-mix(in srgb, var(--lumiverse-primary, #7c9bc8) 13%, transparent);
    }

    .lumibionic-toolbar-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    @media (max-width: 440px) {
      .lumibionic-toolbar-grid {
        grid-template-columns: 1fr;
      }
    }

    .lumibionic-muted {
      opacity: 0.68;
      font-size: 12px;
      line-height: 1.45;
    }

    .lumibionic-control {
      display: flex;
      flex-direction: column;
      gap: 7px;
    }

    .lumibionic-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .lumibionic-checks {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .lumibionic-check {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 32px;
      font-size: 13px;
    }

    .lumibionic-check input {
      width: auto !important;
      flex: 0 0 auto;
    }

    .lumibionic-control label {
      font-size: 13px;
      font-weight: 600;
    }

    .lumibionic-value {
      min-width: 48px;
      text-align: right;
      opacity: 0.7;
      font-size: 12px;
    }

    .lumibionic-settings input[type="range"],
    .lumibionic-settings select,
    .lumibionic-settings input[type="text"],
    .lumibionic-settings input[type="file"],
    .lumibionic-settings button {
      width: 100%;
      box-sizing: border-box;
    }

    .lumibionic-settings select,
    .lumibionic-settings input[type="text"],
    .lumibionic-settings button {
      padding: 9px 10px;
      border-radius: 8px;
      font: inherit;
    }

    .lumibionic-settings button {
      cursor: pointer;
    }

    .lumibionic-stepper {
      display: none;
      grid-template-columns: 44px minmax(72px, 1fr) 44px 44px;
      gap: 6px;
      align-items: center;
    }

    .lumibionic-stepper button,
    .lumibionic-stepper input {
      min-height: 44px;
      box-sizing: border-box;
    }

    .lumibionic-stepper button {
      width: auto !important;
      padding: 0 8px !important;
      font-size: 18px;
      line-height: 1;
    }

    .lumibionic-stepper input {
      width: 100% !important;
      padding: 8px !important;
      text-align: center;
      font: inherit;
      font-size: 16px;
      border-radius: 8px;
    }

    .lumibionic-stepper-reset {
      font-size: 16px !important;
    }

    @media (hover: none), (pointer: coarse) {
      .lumibionic-mobile-safe-range {
        display: none !important;
      }

      .lumibionic-stepper {
        display: grid;
      }
    }

    .lumibionic-preview {
      padding: 12px;
      border-radius: 8px;
      background: rgba(127, 127, 127, 0.08);
      font-family: var(--lumibionic-preview-font, inherit) !important;
      font-size: var(--lumibionic-text-size, 100%);
      line-height: var(--lumibionic-line-height, 1.55);
      letter-spacing: var(--lumibionic-preview-letter-spacing, normal);
      word-spacing: var(--lumibionic-preview-word-spacing, normal);
      hyphens: var(--lumibionic-preview-hyphens, manual);
      -webkit-hyphens: var(--lumibionic-preview-hyphens, manual);

      /* Keep live preview useful without taking over the drawer. */
      max-height: min(170px, 24vh);
      overflow-y: auto;
      overscroll-behavior: contain;
      scrollbar-gutter: stable;
    }

    @media (max-width: 720px) {
      .lumibionic-preview {
        max-height: min(150px, 21vh);
        padding: 10px;
      }
    }

    .lumibionic-preview * {
      font-family: var(--lumibionic-preview-font, inherit) !important;
    }

    .lumibionic-preview.lb-preview-justify {
      text-align: justify;
      text-justify: inter-word;
    }

    .lumibionic-preview p {
      margin: 0 !important;
      padding: 0 !important;
    }

    .lumibionic-preview p + p {
      margin-block-start:
        var(--lumibionic-paragraph-spacing, 0em) !important;
    }

    .lumibionic-hidden {
      display: none !important;
    }

    .lumibionic-file-status {
      font-size: 12px;
      opacity: 0.75;
    }
  `);
  const tab = ctx.ui.registerDrawerTab({
    id: "bionic-reading",
    iconSvg: BIONIC_DRAWER_ICON_SVG,
    title: "Reading & Fonts",
    shortName: "Reading",
    headerTitle: "Reading & Fonts",
    description: "Bionic reading, font reach, and long-form typography",
    keywords: [
      "bionic",
      "reading",
      "font",
      "typography",
      "justify",
      "hyphenation",
      "spacing",
      "accessibility"
    ]
  });
  function processTextNode(node) {
    if (!settings.bionicEnabled)
      return;
    const parent = node.parentElement;
    if (!parent)
      return;
    if (parent.closest(BIONIC_SKIP_SELECTOR))
      return;
    const text = node.nodeValue || "";
    if (!/\p{L}/u.test(text))
      return;
    const doc = node.ownerDocument;
    const fragment = doc.createDocumentFragment();
    let lastIndex = 0;
    let changed = false;
    for (const match of text.matchAll(WORD_RE)) {
      const word = match[0];
      const index = match.index ?? 0;
      const { chars, cut } = fixationCut(word);
      if (!cut)
        continue;
      if (index > lastIndex) {
        fragment.appendChild(doc.createTextNode(text.slice(lastIndex, index)));
      }
      const wrapper = doc.createElement("span");
      wrapper.setAttribute("data-lumibionic-word", "");
      const fix = doc.createElement("span");
      fix.setAttribute("data-lumibionic-fix", "");
      fix.textContent = chars.slice(0, cut).join("");
      wrapper.appendChild(fix);
      wrapper.appendChild(doc.createTextNode(chars.slice(cut).join("")));
      fragment.appendChild(wrapper);
      lastIndex = index + word.length;
      changed = true;
    }
    if (!changed)
      return;
    if (lastIndex < text.length) {
      fragment.appendChild(doc.createTextNode(text.slice(lastIndex)));
    }
    node.parentNode?.replaceChild(fragment, node);
  }
  function findMessageShell(content) {
    let node = content.parentElement;
    let best = node;
    for (let depth = 0;node && depth < 5; depth++) {
      const count = node.querySelectorAll(MESSAGE_SELECTOR).length;
      if (count !== 1)
        break;
      best = node;
      node = node.parentElement;
    }
    return best;
  }
  function refreshBubbleScopes() {
    document.querySelectorAll(".lumibionic-bubble-scope").forEach((el) => {
      el.classList.remove("lumibionic-bubble-scope");
    });
    if (!settings.fontEnabled || !settings.scopeBubble || settings.scopeAll) {
      return;
    }
    document.querySelectorAll(MESSAGE_SELECTOR).forEach((content) => {
      const shell = findMessageShell(content);
      if (shell) {
        shell.classList.add("lumibionic-bubble-scope");
      }
    });
  }
  const LUMIREALM_FONT_LOCK_ATTR = "data-lumibionic-font-lock";
  const LUMIREALM_PROSE_SELECTOR = [
    "p",
    "li",
    "blockquote",
    "span",
    "a",
    "em",
    "strong",
    "b",
    "i",
    "u",
    "s",
    "mark",
    "small",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "dt",
    "dd",
    "figcaption"
  ].join(",");
  function shouldApplyMessageFontLock() {
    return settings.fontEnabled && (settings.scopeAll || settings.scopeMessages);
  }
  function isProtectedFontElement(element) {
    return Boolean(element.closest("pre, code, kbd, samp, svg, math, " + "button, input, textarea, select, option, " + '[contenteditable="true"]'));
  }
  function hasOwnVisibleText(element) {
    return Array.from(element.childNodes).some((node) => {
      return node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim());
    });
  }
  function applyFontLockToRoot(root, font2, messageSize) {
    if (!root)
      return;
    const targets = new Set;
    if (root instanceof Element) {
      targets.add(root);
    }
    root.querySelectorAll?.(LUMIREALM_PROSE_SELECTOR).forEach((element) => targets.add(element));
    if (typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot) {
      root.querySelectorAll?.("*").forEach((element) => {
        if (hasOwnVisibleText(element)) {
          targets.add(element);
        }
      });
    }
    for (const element of targets) {
      if (element instanceof Element && isProtectedFontElement(element)) {
        continue;
      }
      element.style.setProperty("font-family", font2, "important");
      if (messageSize) {
        element.style.setProperty("font-size", messageSize, "important");
      }
      element.setAttribute(LUMIREALM_FONT_LOCK_ATTR, "true");
    }
    root.querySelectorAll?.("*").forEach((element) => {
      if (element.shadowRoot) {
        applyFontLockToRoot(element.shadowRoot, font2, messageSize);
      }
    });
  }
  function applyLumiRealmFontLock(root) {
    if (!root || !shouldApplyMessageFontLock()) {
      return;
    }
    const messageRoot = root instanceof Element && root.matches?.(MESSAGE_SELECTOR) ? root : root instanceof Element ? root.closest?.(MESSAGE_SELECTOR) : null;
    const messageSize = messageRoot ? getComputedStyle(messageRoot).fontSize : null;
    applyFontLockToRoot(root, currentFont(), messageSize);
  }
  function clearFontLocksInRoot(root) {
    if (!root)
      return;
    root.querySelectorAll?.(`[${LUMIREALM_FONT_LOCK_ATTR}]`).forEach((element) => {
      element.style.removeProperty("font-family");
      element.style.removeProperty("font-size");
      element.removeAttribute(LUMIREALM_FONT_LOCK_ATTR);
    });
    root.querySelectorAll?.("*").forEach((element) => {
      if (element.shadowRoot) {
        clearFontLocksInRoot(element.shadowRoot);
      }
    });
  }
  function clearLumiRealmFontLock(root = document) {
    clearFontLocksInRoot(root);
  }
  function elementDescriptor(element) {
    if (!(element instanceof Element)) {
      return "(not an element)";
    }
    const parts = [
      element.tagName.toLowerCase()
    ];
    if (element.id) {
      parts.push(`#${element.id}`);
    }
    const component = element.getAttribute("data-component");
    if (component) {
      parts.push(`[data-component="${component}"]`);
    }
    const messageId = element.getAttribute("data-message-id");
    if (messageId) {
      parts.push(`[data-message-id="${messageId}"]`);
    }
    const spindleMount = element.getAttribute("data-spindle-mount");
    if (spindleMount) {
      parts.push(`[data-spindle-mount="${spindleMount}"]`);
    }
    if (element.classList?.length) {
      parts.push("." + Array.from(element.classList).slice(0, 4).join("."));
    }
    return parts.join("");
  }
  function firstVisibleTextElement(root) {
    if (!(root instanceof Element)) {
      return null;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while (node = walker.nextNode()) {
      const text = node.textContent?.trim();
      if (!text)
        continue;
      const parent = node.parentElement;
      if (!parent)
        continue;
      if (parent.closest("script, style, noscript, svg")) {
        continue;
      }
      const style = getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden") {
        continue;
      }
      return parent;
    }
    return root;
  }
  function detectSpecialRendering(element) {
    const notes = [];
    const rootNode = element?.getRootNode?.();
    if (typeof ShadowRoot !== "undefined" && rootNode instanceof ShadowRoot) {
      notes.push(`inside ${rootNode.mode} shadow root`);
    }
    const frame = element?.closest?.("iframe");
    if (frame) {
      notes.push("inside iframe element");
    }
    return notes;
  }
  function processMessage(root) {
    root.classList.toggle("lumibionic-justify", settings.justifyMessages);
    root.classList.toggle("lumibionic-hyphens", settings.hyphenateMessages);
    root.classList.toggle("lumibionic-reading-width", settings.readingWidth !== "full");
    root.classList.toggle("lumibionic-paragraph-spacing", settings.paragraphSpacing > 0.001);
    root.classList.toggle("lumibionic-letter-spacing", Math.abs(settings.letterSpacing) > 0.0001);
    root.classList.toggle("lumibionic-word-spacing", Math.abs(settings.wordSpacing) > 0.0001);
    applyLumiRealmFontLock(root);
    if (!settings.bionicEnabled)
      return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      nodes.push(walker.currentNode);
    }
    for (const node of nodes) {
      processTextNode(node);
    }
  }
  function unwrap(root = document) {
    clearLumiRealmFontLock(root);
    root.querySelectorAll("[data-lumibionic-word]").forEach((el) => {
      el.replaceWith(document.createTextNode(el.textContent || ""));
    });
    root.querySelectorAll(MESSAGE_SELECTOR).forEach((el) => {
      el.classList.remove("lumibionic-justify", "lumibionic-hyphens", "lumibionic-reading-width", "lumibionic-paragraph-spacing", "lumibionic-letter-spacing", "lumibionic-word-spacing");
      el.normalize();
    });
  }
  const SCROLL_LATEST_BUTTON_ATTR = "data-lumibionic-scroll-latest";
  const SCROLL_LATEST_WRAPPER_ATTR = "data-lumibionic-scroll-latest-wrapper";
  function latestRenderedMessageTarget() {
    const messages = Array.from(document.querySelectorAll(MESSAGE_SELECTOR));
    const content = messages[messages.length - 1];
    if (!content)
      return null;
    return content.closest("[data-message-id]") || content.closest('[data-component="BubbleMessage"], ' + '[data-component="MinimalMessage"]') || content;
  }
  function alignLatestMessageTop(behavior = "auto") {
    const target = latestRenderedMessageTarget();
    if (!target)
      return false;
    target.scrollIntoView({
      behavior,
      block: "start",
      inline: "nearest"
    });
    return true;
  }
  function scrollToLatestMessageTop() {
    const moved = alignLatestMessageTop("smooth");
    if (!moved)
      return false;
    setTimeout(() => alignLatestMessageTop("auto"), 140);
    setTimeout(() => alignLatestMessageTop("auto"), 720);
    return true;
  }
  function getNativeComposerActionBar() {
    const chatActionsMount = document.querySelector('[data-component="InputArea"] ' + '[data-spindle-mount="chat_actions"]');
    const actionBar = chatActionsMount?.parentElement;
    return actionBar && actionBar.closest('[data-component="InputArea"]') ? {
      actionBar,
      chatActionsMount
    } : null;
  }
  function ensureScrollLatestToolbarButton() {
    const target = getNativeComposerActionBar();
    if (!target) {
      return null;
    }
    const {
      actionBar,
      chatActionsMount
    } = target;
    let wrapper = actionBar.querySelector(`[${SCROLL_LATEST_WRAPPER_ATTR}]`);
    let button = wrapper?.querySelector?.(`[${SCROLL_LATEST_BUTTON_ATTR}]`) || null;
    if (!wrapper) {
      wrapper = document.createElement("span");
      wrapper.setAttribute(SCROLL_LATEST_WRAPPER_ATTR, "true");
      wrapper.style.display = "contents";
      actionBar.insertBefore(wrapper, chatActionsMount);
    }
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.setAttribute(SCROLL_LATEST_BUTTON_ATTR, "true");
      button.setAttribute("title", "Top of latest message");
      button.setAttribute("aria-label", "Top of latest message");
      button.innerHTML = `
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M5 3h14"></path>
          <path d="m18 13-6-6-6 6"></path>
          <path d="M12 7v14"></path>
        </svg>
      `;
      button.addEventListener("click", () => {
        const moved = scrollToLatestMessageTop();
        if (!moved) {
          button.setAttribute("title", "No message found");
          setTimeout(() => {
            button.setAttribute("title", "Top of latest message");
          }, 1200);
        }
      });
      wrapper.appendChild(button);
    }
    const nativeButton = Array.from(actionBar.querySelectorAll("button")).find((candidate) => candidate !== button && !candidate.hasAttribute(SCROLL_LATEST_BUTTON_ATTR));
    if (nativeButton && nativeButton.className) {
      button.className = nativeButton.className;
    }
    return button;
  }
  const AUTO_REGENERATE_BUTTON_ATTR = "data-lumibionic-auto-regenerate";
  const AUTO_REGENERATE_WRAPPER_ATTR = "data-lumibionic-auto-regenerate-wrapper";
  function autoRegenerateUiState() {
    const trigger = settings.autoRegenerateTriggerText.trim();
    if (!trigger) {
      return {
        key: "not-configured",
        label: "NOT CONFIGURED",
        enabled: false
      };
    }
    if (!settings.autoRegenerateEnabled) {
      return {
        key: "off",
        label: "OFF",
        enabled: false
      };
    }
    return {
      key: "armed",
      label: "ARMED",
      enabled: true
    };
  }
  function syncAutoRegenerateStatus() {
    const state = autoRegenerateUiState();
    if (autoRegenStatus) {
      autoRegenStatus.textContent = state.label;
      autoRegenStatus.dataset.state = state.key;
      autoRegenStatus.title = state.key === "armed" ? `Watching for: ${settings.autoRegenerateTriggerText.trim()}` : state.key === "not-configured" ? "Set trigger text before enabling Auto Regenerate." : "Auto Regenerate is disabled.";
    }
  }
  function syncAutoRegenerateToolbarButton(button) {
    if (!button)
      return;
    const state = autoRegenerateUiState();
    button.setAttribute("aria-pressed", String(state.enabled));
    button.setAttribute("title", `Auto regenerate: ${state.label}`);
    button.setAttribute("aria-label", `Auto regenerate: ${state.label}`);
    button.dataset.state = state.key;
    const label = button.querySelector("[data-lumibionic-auto-regenerate-label]");
    if (label) {
      label.textContent = state.key === "armed" ? "↻A ON" : state.key === "not-configured" ? "↻A ?" : "↻A OFF";
    }
    syncAutoRegenerateStatus();
  }
  function ensureAutoRegenerateToolbarButton() {
    const target = getNativeComposerActionBar();
    if (!target)
      return null;
    const {
      actionBar,
      chatActionsMount
    } = target;
    let wrapper = actionBar.querySelector(`[${AUTO_REGENERATE_WRAPPER_ATTR}]`);
    let button = wrapper?.querySelector?.(`[${AUTO_REGENERATE_BUTTON_ATTR}]`) || null;
    if (!wrapper) {
      wrapper = document.createElement("span");
      wrapper.setAttribute(AUTO_REGENERATE_WRAPPER_ATTR, "true");
      wrapper.style.display = "contents";
      actionBar.insertBefore(wrapper, chatActionsMount);
    }
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.setAttribute(AUTO_REGENERATE_BUTTON_ATTR, "true");
      button.innerHTML = `
        <span
          aria-hidden="true"
          data-lumibionic-auto-regenerate-label
          style="font-size:12px;font-weight:700;line-height:1"
        >↻A OFF</span>
      `;
      button.addEventListener("click", () => {
        const trigger = settings.autoRegenerateTriggerText.trim();
        settings = {
          ...settings,
          autoRegenerateEnabled: trigger ? !settings.autoRegenerateEnabled : false
        };
        saveSettings();
        syncControls();
        applyToolbarVisibility();
        syncAutoRegenerateStatus();
      });
      wrapper.appendChild(button);
    }
    const nativeButton = Array.from(actionBar.querySelectorAll("button")).find((candidate) => candidate !== button && !candidate.hasAttribute(SCROLL_LATEST_BUTTON_ATTR) && !candidate.hasAttribute(AUTO_REGENERATE_BUTTON_ATTR));
    if (nativeButton && nativeButton.className) {
      button.className = nativeButton.className;
    }
    syncAutoRegenerateToolbarButton(button);
    return button;
  }
  function toolbarButtonLabel(button) {
    return [
      button.getAttribute("title") || "",
      button.getAttribute("aria-label") || "",
      button.getAttribute("data-tooltip") || "",
      button.getAttribute("data-title") || ""
    ].filter(Boolean).join(" ").trim();
  }
  function isAttachmentButton(button) {
    if (!button?.matches?.("button"))
      return false;
    if (!button.closest('[data-component="InputArea"]'))
      return false;
    const previous = button.previousElementSibling;
    if (previous?.matches?.('[data-spindle-mount="chat_input_tools_left"]')) {
      return true;
    }
    return Boolean(button.querySelector('svg.lucide-paperclip, svg[class*="paperclip"]'));
  }
  function toolbarItemForButton(button) {
    if (isAttachmentButton(button)) {
      return TOOLBAR_BUTTONS.find((item) => item.key === "attachments") || null;
    }
    const label = toolbarButtonLabel(button).toLocaleLowerCase();
    if (!label)
      return null;
    return TOOLBAR_BUTTONS.find((item) => {
      const aliases = Array.isArray(item.titles) && item.titles.length ? item.titles : [item.title];
      return aliases.some((alias) => label.includes(String(alias).toLocaleLowerCase()));
    }) || null;
  }
  function findToolbarButtons() {
    const buttons = new Set;
    document.querySelectorAll('[data-component="InputArea"] button, ' + '[data-spindle-mount="chat_toolbar"] button').forEach((button) => buttons.add(button));
    return Array.from(buttons);
  }
  function findNativeRegenerateButton() {
    const candidates = findToolbarButtons().filter((button) => !button.hasAttribute(AUTO_REGENERATE_BUTTON_ATTR) && toolbarItemForButton(button)?.key === "regenerate");
    return candidates.find((button) => !button.disabled && button.getClientRects().length > 0) || candidates.find((button) => !button.disabled) || null;
  }
  function clickNativeRegenerate() {
    const button = findNativeRegenerateButton();
    if (!button)
      return false;
    button.click();
    return true;
  }
  function applyToolbarVisibility() {
    ensureScrollLatestToolbarButton();
    ensureAutoRegenerateToolbarButton();
    let matched = 0;
    let hidden = 0;
    const spacing = clamp(settings.toolbarSpacing, 0, 16, DEFAULTS.toolbarSpacing);
    const halfSpacing = spacing / 2;
    for (const button of findToolbarButtons()) {
      button.style.setProperty("margin-inline", `${halfSpacing}px`, "important");
      button.setAttribute("data-lumibionic-toolbar-spacing", String(spacing));
      const item = toolbarItemForButton(button);
      if (!item)
        continue;
      matched += 1;
      const shouldHide = Boolean(settings.toolbarHidden?.[item.key]);
      if (shouldHide) {
        button.setAttribute("data-lumibionic-toolbar-hidden", item.key);
        button.style.setProperty("display", "none", "important");
        hidden += 1;
      } else if (button.hasAttribute("data-lumibionic-toolbar-hidden")) {
        button.style.removeProperty("display");
        button.removeAttribute("data-lumibionic-toolbar-hidden");
      }
    }
    const status = typeof tab !== "undefined" ? tab.root?.querySelector("#lb-toolbar-match-status") : null;
    if (status) {
      status.textContent = matched > 0 ? `${matched} toolbar buttons detected · ${hidden} hidden` : "No matching toolbar buttons detected on this screen";
    }
  }
  function clearToolbarVisibility() {
    document.querySelectorAll("[data-lumibionic-toolbar-hidden], " + "[data-lumibionic-toolbar-spacing]").forEach((button) => {
      button.style.removeProperty("display");
      button.style.removeProperty("margin-inline");
      button.removeAttribute("data-lumibionic-toolbar-hidden");
      button.removeAttribute("data-lumibionic-toolbar-spacing");
    });
  }
  function applyRootClasses() {
    const root = document.documentElement;
    const enabled = settings.fontEnabled;
    root.classList.toggle("lb-font-messages", enabled && settings.scopeMessages && !settings.scopeAll);
    root.classList.toggle("lb-font-bubble", enabled && settings.scopeBubble && !settings.scopeAll);
    root.classList.toggle("lb-font-composer", enabled && settings.scopeComposer && !settings.scopeAll);
    root.classList.toggle("lb-font-menus", enabled && settings.scopeMenus && !settings.scopeAll);
    root.classList.toggle("lb-font-navigation", enabled && settings.scopeNavigation && !settings.scopeAll);
    root.classList.toggle("lb-font-all", enabled && settings.scopeAll);
    for (const item of TOOLBAR_BUTTONS) {
      root.classList.toggle(item.className, Boolean(settings.toolbarHidden?.[item.key]));
    }
  }
  function applyCssSettings() {
    const root = document.documentElement;
    const fontFamily = currentFont();
    clearLumiRealmFontLock();
    root.style.setProperty("--lumibionic-weight", String(settings.weight));
    root.style.setProperty("--lumibionic-font-family", fontFamily);
    root.style.setProperty("--lumibionic-preview-font", settings.fontEnabled ? fontFamily : "inherit");
    root.style.setProperty("--lumibionic-text-size", `${settings.textSize}%`);
    root.style.setProperty("--lumibionic-line-height", String(settings.lineHeight));
    root.style.setProperty("--lumibionic-reading-width", settings.readingWidth === "full" ? "none" : settings.readingWidth);
    root.style.setProperty("--lumibionic-paragraph-spacing", `${settings.paragraphSpacing}em`);
    root.style.setProperty("--lumibionic-letter-spacing", `${settings.letterSpacing}em`);
    root.style.setProperty("--lumibionic-word-spacing", `${settings.wordSpacing}em`);
    root.style.setProperty("--lumibionic-preview-letter-spacing", Math.abs(settings.letterSpacing) > 0.0001 ? `${settings.letterSpacing}em` : "normal");
    root.style.setProperty("--lumibionic-preview-word-spacing", Math.abs(settings.wordSpacing) > 0.0001 ? `${settings.wordSpacing}em` : "normal");
    root.style.setProperty("--lumibionic-preview-hyphens", settings.hyphenateMessages ? "auto" : "manual");
    applyRootClasses();
    refreshBubbleScopes();
    applyToolbarVisibility();
  }
  let fontCompatSettleTimer = null;
  let fontCompatLateTimer = null;
  function reapplyMessageFonts() {
    if (!shouldApplyMessageFontLock()) {
      return;
    }
    document.querySelectorAll(MESSAGE_SELECTOR).forEach(applyLumiRealmFontLock);
  }
  function scheduleFontCompatSettle() {
    if (fontCompatSettleTimer) {
      clearTimeout(fontCompatSettleTimer);
    }
    if (fontCompatLateTimer) {
      clearTimeout(fontCompatLateTimer);
    }
    fontCompatSettleTimer = setTimeout(() => {
      fontCompatSettleTimer = null;
      reapplyMessageFonts();
    }, 100);
    fontCompatLateTimer = setTimeout(() => {
      fontCompatLateTimer = null;
      reapplyMessageFonts();
    }, 650);
  }
  function processAll() {
    if (rebuilding)
      return;
    document.querySelectorAll(MESSAGE_SELECTOR).forEach(processMessage);
    refreshBubbleScopes();
    applyToolbarVisibility();
    scheduleFontCompatSettle();
  }
  function rebuildAll() {
    rebuilding = true;
    unwrap();
    rebuilding = false;
    applyCssSettings();
    processAll();
  }
  function scheduleProcess() {
    if (scheduled || rebuilding)
      return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      processAll();
    });
  }
  function updateSetting(key, value, rebuild = false, markCustom = true) {
    settings = {
      ...settings,
      [key]: value,
      ...markCustom ? { preset: "custom" } : {}
    };
    saveSettings();
    applyCssSettings();
    syncControls();
    if (rebuild) {
      rebuildAll();
    } else {
      processAll();
    }
    renderPreview();
  }
  function updateToolbarSetting(key, hidden) {
    if (!TOOLBAR_BUTTONS.some((item) => item.key === key))
      return;
    settings = {
      ...settings,
      toolbarHidden: {
        ...settings.toolbarHidden,
        [key]: Boolean(hidden)
      }
    };
    saveSettings();
    applyCssSettings();
    syncControls();
  }
  function setAllToolbarHidden(hidden) {
    settings = {
      ...settings,
      toolbarHidden: Object.fromEntries(TOOLBAR_BUTTONS.map((item) => [item.key, Boolean(hidden)]))
    };
    saveSettings();
    applyCssSettings();
    syncControls();
  }
  function applyPreset(name) {
    if (name === "custom") {
      settings = { ...settings, preset: "custom" };
      saveSettings();
      syncControls();
      return;
    }
    const values = PRESETS[name];
    if (!values)
      return;
    settings = {
      ...settings,
      ...values,
      preset: name
    };
    saveSettings();
    applyCssSettings();
    syncControls();
    rebuildAll();
    renderPreview();
  }
  tab.root.innerHTML = `
    <div class="lumibionic-settings">

      <div>
        <h2>Reading & Fonts</h2>
        <div class="lumibionic-muted">
          Use Bionic emphasis, change typography,
          and choose exactly how far the font override reaches.
        </div>
      </div>

      <details class="lumibionic-group" data-lumibionic-group="Settings" open>
        <summary>Settings</summary>
        <div class="lumibionic-group-body">
          <div class="lumibionic-section">
            <div class="lumibionic-section-title">Saving</div>
            <div class="lumibionic-control">
              <label for="lb-settings-persistence">Save mode</label>
              <select id="lb-settings-persistence">
                <option value="account">Account-saved (recommended)</option>
                <option value="browser">This browser only</option>
              </select>
              <div class="lumibionic-muted">
                Account-saved restores your setup after reloads and extension updates.
              </div>
            </div>
            <div class="lumibionic-muted" id="lb-settings-save-status">
              Settings storage: checking…
            </div>
          </div>
        </div>
      </details>

      <details class="lumibionic-group" data-lumibionic-group="Reading & Typography" open>
        <summary>Reading & Typography</summary>
        <div class="lumibionic-group-body">
      <div class="lumibionic-section">

        <div class="lumibionic-section-title">
          Preset
        </div>

        <div class="lumibionic-control">
          <label for="lb-preset">Reading preset</label>
          <select id="lb-preset">
            <option value="custom">Custom</option>
            <option value="clean">Clean — minimal changes</option>
            <option value="comfortable">Comfortable — long-form</option>
            <option value="mobile">Mobile — touch-friendly reading</option>
            <option value="bionicLight">Bionic Light</option>
          </select>
          <div class="lumibionic-muted">
            Presets change reading controls but leave your font and font reach alone.
            Any manual adjustment switches back to Custom.
          </div>
        </div>

      </div>

      <div class="lumibionic-section">

        <div class="lumibionic-section-title">
          Bionic emphasis
        </div>

        <div class="lumibionic-row">
          <label for="lb-bionic-enabled">
            Enable Bionic Reading
          </label>

          <input
            id="lb-bionic-enabled"
            type="checkbox"
          >
        </div>

        <div id="lb-bionic-options">

          <div class="lumibionic-control">
            <label for="lb-density">
              Emphasis density
            </label>

            <select id="lb-density">
              <option value="light">
                Light — longer words only
              </option>
              <option value="balanced">
                Balanced — recommended
              </option>
              <option value="full">
                Full — classic effect
              </option>
            </select>
          </div>

          <div class="lumibionic-control">
            <div class="lumibionic-row">
              <label for="lb-fixation">
                Fixation strength
              </label>
              <span
                class="lumibionic-value"
                id="lb-fixation-value"
              ></span>
            </div>

            <input
              id="lb-fixation"
              type="range"
              min="20"
              max="70"
              step="5"
            >
          </div>

          <div class="lumibionic-control">
            <div class="lumibionic-row">
              <label for="lb-weight">
                Emphasis weight
              </label>
              <span
                class="lumibionic-value"
                id="lb-weight-value"
              ></span>
            </div>

            <input
              id="lb-weight"
              type="range"
              min="500"
              max="900"
              step="100"
            >
          </div>

        </div>
      </div>

      <div class="lumibionic-section">

        <div class="lumibionic-section-title">
          Font override
        </div>

        <div class="lumibionic-row">
          <label for="lb-font-enabled">
            Enable font override
          </label>
          <input
            id="lb-font-enabled"
            type="checkbox"
          >
        </div>

        <div id="lb-font-options">

          <div class="lumibionic-control">
            <label for="lb-font">
              Font
            </label>
            <select id="lb-font"></select>
          </div>

          <div
            class="lumibionic-control"
            id="lb-custom-font-wrap"
          >
            <label for="lb-custom-font">
              Custom font name / CSS stack
            </label>

            <input
              id="lb-custom-font"
              type="text"
              spellcheck="false"
              placeholder='"Atkinson Hyperlegible", sans-serif'
            >

            <div class="lumibionic-muted">
              Use a font installed on this device,
              or enter a normal CSS font-family stack.
            </div>
          </div>

          <div class="lumibionic-control">
            <label for="lb-font-file">
              Load a local font file
            </label>

            <input
              id="lb-font-file"
              type="file"
              accept=".woff,.woff2,.ttf,.otf,font/woff,font/woff2,font/ttf,font/otf"
            >

            <div
              class="lumibionic-file-status"
              id="lb-font-file-status"
            >
              Optional. The selected file lasts until
              the Lumiverse tab is refreshed.
            </div>
          </div>

          <button
            type="button"
            id="lb-clear-font-file"
          >
            Stop using loaded font file
          </button>

          <div class="lumibionic-control">
            <label>Font reach</label>

            <div class="lumibionic-checks">

              <label class="lumibionic-check">
                <input id="lb-scope-messages" type="checkbox">
                <span>Message text</span>
              </label>

              <label class="lumibionic-check">
                <input id="lb-scope-bubble" type="checkbox">
                <span>Message bubble, names & controls</span>
              </label>

              <label class="lumibionic-check">
                <input id="lb-scope-composer" type="checkbox">
                <span>Composer & text inputs</span>
              </label>

              <label class="lumibionic-check">
                <input id="lb-scope-menus" type="checkbox">
                <span>Menus, popovers & dialogs</span>
              </label>

              <label class="lumibionic-check">
                <input id="lb-scope-navigation" type="checkbox">
                <span>Navigation, tabs & panels</span>
              </label>

              <label class="lumibionic-check">
                <input id="lb-scope-all" type="checkbox">
                <span><strong>Entire Lumiverse interface</strong></span>
              </label>

            </div>

            <div class="lumibionic-muted">
              “Entire interface” takes priority over the
              individual reach checkboxes. Code blocks remain monospace.
            </div>
          </div>

        </div>
      </div>

      <div class="lumibionic-section">

        <div class="lumibionic-section-title">
          Long-form reading
        </div>

        <label class="lumibionic-check">
          <input id="lb-justify" type="checkbox">
          <span>Justify message prose</span>
        </label>

        <label class="lumibionic-check">
          <input id="lb-hyphens" type="checkbox">
          <span>Automatic hyphenation</span>
        </label>

        <div class="lumibionic-muted">
          Hyphenation depends on browser support and the
          language information available on the page.
        </div>

        <div class="lumibionic-control">
          <label for="lb-reading-width">Reading width</label>
          <select id="lb-reading-width"></select>
          <div class="lumibionic-muted">
            Limits long lines. “ch” is roughly one character wide.
          </div>
        </div>

        <div class="lumibionic-control">
          <div class="lumibionic-row">
            <label for="lb-paragraph-spacing">Paragraph spacing</label>
            <span class="lumibionic-value" id="lb-paragraph-spacing-value"></span>
          </div>
          <input id="lb-paragraph-spacing" type="range" min="0" max="1.5" step="0.1">
          <div class="lumibionic-muted">0 uses the theme default.</div>
        </div>

        <div class="lumibionic-control">
          <div class="lumibionic-row">
            <label for="lb-letter-spacing">Letter spacing</label>
            <span class="lumibionic-value" id="lb-letter-spacing-value"></span>
          </div>
          <input id="lb-letter-spacing" type="range" min="-0.03" max="0.12" step="0.005">
          <div class="lumibionic-muted">0 uses normal theme spacing.</div>
        </div>

        <div class="lumibionic-control">
          <div class="lumibionic-row">
            <label for="lb-word-spacing">Word spacing</label>
            <span class="lumibionic-value" id="lb-word-spacing-value"></span>
          </div>
          <input id="lb-word-spacing" type="range" min="-0.05" max="0.3" step="0.01">
          <div class="lumibionic-muted">Useful when justified text feels too cramped or airy.</div>
        </div>

      </div>

      <div class="lumibionic-section">

        <div class="lumibionic-section-title">
          Message typography
        </div>

        <div class="lumibionic-control">
          <div class="lumibionic-row">
            <label for="lb-size">Message text size</label>
            <span class="lumibionic-value" id="lb-size-value"></span>
          </div>
          <input id="lb-size" type="range" min="80" max="140" step="1">
        </div>

        <div class="lumibionic-control">
          <div class="lumibionic-row">
            <label for="lb-line">Message line spacing</label>
            <span class="lumibionic-value" id="lb-line-value"></span>
          </div>
          <input id="lb-line" type="range" min="1.1" max="2.2" step="0.05">
        </div>

      </div>
        </div>
      </details>

      <details class="lumibionic-group" data-lumibionic-group="FF5 Thinking Fix">
        <summary>FF5 Thinking Fix</summary>
        <div class="lumibionic-group-body">
      <div class="lumibionic-section">

        <div class="lumibionic-section-title">
          FF think fix
        </div>

        <label class="lumibionic-check">
          <input id="lb-ff-think-fix" type="checkbox">
          <span>Move one side of the RP boundary into native reasoning</span>
        </label>

        <div class="lumibionic-muted">
          After the AI finishes, the extension edits the saved assistant
          message using Lumiverse's native reasoning field. Choose whether the
          text before or after the first boundary marker becomes the collapsible
          reasoning block.
        </div>

        <div class="lumibionic-control">
          <label for="lb-ff-boundary-text">RP boundary marker</label>
          <input
            id="lb-ff-boundary-text"
            type="text"
            spellcheck="false"
          >
        </div>

        <div class="lumibionic-control">
          <label for="lb-ff-reasoning-side">Move into native reasoning</label>
          <select id="lb-ff-reasoning-side">
            <option value="before">Text before the marker</option>
            <option value="after">Text after the marker</option>
          </select>
        </div>

        <label class="lumibionic-check">
          <input id="lb-ff-include-marker" type="checkbox">
          <span>Include the marker text in reasoning</span>
        </label>

        <div class="lumibionic-muted">
          Off: the marker stays visible in the normal message.
          On: the marker moves into the reasoning box with the selected side.
        </div>

        <div class="lumibionic-toolbar-actions">
          <button type="button" id="lb-ff-run-now">
            ▶ Run FF think fix now
          </button>
          <button type="button" id="lb-ff-reset-pattern">
            Reset boundary marker
          </button>
        </div>

        <div class="lumibionic-muted">
          Manual run ignores the automatic toggle and repairs the latest
          assistant message in the currently open chat. Default boundary:
          <code>[ \uD83D\uDD70️ Time</code>. The fix uses Lumiverse's native
          reasoning field instead of inserting
          <code>&lt;think&gt;</code> tags.
        </div>

        <div class="lumibionic-muted" id="lb-ff-backend-status">
          FF backend bundle: checking…
        </div>

        <div class="lumibionic-muted" id="lb-ff-think-status">
          Waiting for the next completed AI reply.
        </div>

      </div>
        </div>
      </details>

      <details class="lumibionic-group" data-lumibionic-group="Automation">
        <summary>Automation</summary>
        <div class="lumibionic-group-body">
      <div class="lumibionic-section">

        <div class="lumibionic-section-title">
          Auto regenerate
        </div>

        <label class="lumibionic-check">
          <input id="lb-auto-regen-enabled" type="checkbox">
          <span>Automatically regenerate matching AI replies</span>
        </label>

        <div class="lumibionic-control">
          <label for="lb-auto-regen-trigger">Trigger text</label>
          <textarea
            id="lb-auto-regen-trigger"
            rows="3"
            spellcheck="false"
            placeholder="If a completed AI reply contains this text, regenerate it"
          ></textarea>
          <div class="lumibionic-muted">
            Matching is case-insensitive and checks the completed generation text,
            including replies displayed through LumiRealm.
          </div>
        </div>

        <div class="lumibionic-control">
          <div class="lumibionic-row">
            <label for="lb-auto-regen-max">Maximum retries for the same reply</label>
            <span class="lumibionic-value" id="lb-auto-regen-max-value"></span>
          </div>
          <input id="lb-auto-regen-max" type="range" min="1" max="10" step="1">
        </div>

        <div class="lumibionic-muted">
          The ↻A chat-toolbar button turns the automation on or off.
          It uses Lumiverse's native Regenerate action and stops at the retry limit.
        </div>

        <div>
          <span class="lumibionic-status-pill" id="lb-auto-regen-status">OFF</span>
        </div>

      </div>
        </div>
      </details>

      <details
        class="lumibionic-group"
        data-lumibionic-group="Lorebook Organizer"
      >
        <summary>Lorebook Organizer</summary>

        <div class="lumibionic-group-body">
          <div class="lumibionic-section">
            <div class="lb-organizer-summary">
              <div class="lb-organizer-brand">
                <div class="lb-organizer-brand-copy">
                  <strong>Bionic Lorebook Organizer</strong>
                  <small>
                    Reference-aware cleanup and AI-assisted folder organization.
                    Characters, chats, personas and global activation are all checked.
                  </small>
                </div>
              </div>

              <div
                class="lb-organizer-summary-stats"
                id="lb-lore-organizer-summary"
              >
                Not scanned yet.
              </div>

              <div class="lumibionic-toolbar-actions">
                <button
                  type="button"
                  id="lb-lore-organizer-open"
                >
                  Open Lorebook Organizer
                </button>

                <button
                  type="button"
                  id="lb-lore-organizer-rescan"
                >
                  Scan
                </button>
              </div>
            </div>
          </div>
        </div>
      </details>

      <details class="lumibionic-group" data-lumibionic-group="Chat Toolbar">
        <summary>Chat Toolbar</summary>
        <div class="lumibionic-group-body">
      <div class="lumibionic-section">

        <div class="lumibionic-section-title">
          Chat toolbar
        </div>

        <div class="lumibionic-muted">
          Tap an item to hide or show that toolbar control.
          This includes the extension's Top of latest message button.
        </div>

        <div class="lumibionic-control">
          <div class="lumibionic-row">
            <label for="lb-toolbar-spacing">Toolbar button gap</label>
            <span class="lumibionic-value" id="lb-toolbar-spacing-value"></span>
          </div>
          <input
            id="lb-toolbar-spacing"
            type="range"
            min="0"
            max="16"
            step="1"
          >
          <div class="lumibionic-muted">
            Total space between neighboring toolbar buttons. 0px packs them together.
          </div>
        </div>

<div class="lumibionic-toolbar-grid" id="lb-toolbar-grid"></div>

        <div class="lumibionic-toolbar-actions">
          <button type="button" id="lb-toolbar-hide-all">Hide all listed</button>
          <button type="button" id="lb-toolbar-show-all">Show all listed</button>
        </div>

        <div class="lumibionic-muted" id="lb-toolbar-match-status">
          Checking Lumiverse toolbar…
        </div>

        <div class="lumibionic-muted">
          If the old custom CSS block is still active elsewhere, remove it first;
          otherwise it will keep these buttons hidden regardless of this setting.
        </div>

      </div>
        </div>
      </details>



      <div class="lumibionic-section">
        <div class="lumibionic-control">
          <label>Preview</label>
          <div
            class="lumibionic-preview"
            id="lb-preview"
          ></div>
        </div>
      </div>

      <button
        type="button"
        id="lb-reset"
      >
        Reset defaults
      </button>

    </div>
  `;
  const $ = (selector) => tab.root.querySelector(selector);
  const lorebookOrganizerCleanup = installLorebookOrganizer(ctx, tab.root);
  const preset = $("#lb-preset");
  const bionicEnabled = $("#lb-bionic-enabled");
  const bionicOptions = $("#lb-bionic-options");
  const density = $("#lb-density");
  const fixation = $("#lb-fixation");
  const fixationValue = $("#lb-fixation-value");
  const weight = $("#lb-weight");
  const weightValue = $("#lb-weight-value");
  const fontEnabled = $("#lb-font-enabled");
  const fontOptions = $("#lb-font-options");
  const font = $("#lb-font");
  const customFontWrap = $("#lb-custom-font-wrap");
  const customFont = $("#lb-custom-font");
  const fontFile = $("#lb-font-file");
  const fontFileStatus = $("#lb-font-file-status");
  const clearFontFile = $("#lb-clear-font-file");
  const scopeMessages = $("#lb-scope-messages");
  const scopeBubble = $("#lb-scope-bubble");
  const scopeComposer = $("#lb-scope-composer");
  const scopeMenus = $("#lb-scope-menus");
  const scopeNavigation = $("#lb-scope-navigation");
  const scopeAll = $("#lb-scope-all");
  const justify = $("#lb-justify");
  const hyphens = $("#lb-hyphens");
  const readingWidth = $("#lb-reading-width");
  const paragraphSpacing = $("#lb-paragraph-spacing");
  const paragraphSpacingValue = $("#lb-paragraph-spacing-value");
  const letterSpacing = $("#lb-letter-spacing");
  const letterSpacingValue = $("#lb-letter-spacing-value");
  const wordSpacing = $("#lb-word-spacing");
  const wordSpacingValue = $("#lb-word-spacing-value");
  const size = $("#lb-size");
  const sizeValue = $("#lb-size-value");
  const line = $("#lb-line");
  const lineValue = $("#lb-line-value");
  const ffThinkFix = $("#lb-ff-think-fix");
  const ffThinkBoundaryText = $("#lb-ff-boundary-text");
  const ffThinkReasoningSide = $("#lb-ff-reasoning-side");
  const ffThinkIncludeMarker = $("#lb-ff-include-marker");
  const ffThinkRunNow = $("#lb-ff-run-now");
  const ffThinkResetPattern = $("#lb-ff-reset-pattern");
  const ffThinkBackendStatus = $("#lb-ff-backend-status");
  const ffThinkStatus = $("#lb-ff-think-status");
  const autoRegenEnabled = $("#lb-auto-regen-enabled");
  const autoRegenTrigger = $("#lb-auto-regen-trigger");
  const autoRegenMax = $("#lb-auto-regen-max");
  const autoRegenMaxValue = $("#lb-auto-regen-max-value");
  const autoRegenStatus = $("#lb-auto-regen-status");
  const settingsPersistence = $("#lb-settings-persistence");
  const settingsSaveStatus = $("#lb-settings-save-status");
  const loreScan = $("#lb-lore-scan");
  const loreCleanExact = $("#lb-lore-clean-exact");
  const loreStatus = $("#lb-lore-status");
  const loreUnlinked = $("#lb-lore-unlinked");
  const loreResults = $("#lb-lore-results");
  const preview = $("#lb-preview");
  const reset = $("#lb-reset");
  const toolbarSpacing = $("#lb-toolbar-spacing");
  const toolbarSpacingValue = $("#lb-toolbar-spacing-value");
  const toolbarGrid = $("#lb-toolbar-grid");
  const toolbarHideAll = $("#lb-toolbar-hide-all");
  const toolbarShowAll = $("#lb-toolbar-show-all");
  if (toolbarGrid) {
    toolbarGrid.replaceChildren();
    for (const item of TOOLBAR_BUTTONS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "lumibionic-toolbar-toggle";
      button.dataset.toolbarKey = item.key;
      const label = document.createElement("span");
      label.textContent = item.label;
      const state = document.createElement("small");
      state.textContent = "Shown";
      button.append(label, state);
      toolbarGrid.appendChild(button);
    }
  }
  const toolbarToggleButtons = Array.from(tab.root.querySelectorAll("[data-toolbar-key]"));
  for (const [value, label] of FONT_OPTIONS) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    font.appendChild(option);
  }
  for (const [value, label] of WIDTH_OPTIONS) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    readingWidth.appendChild(option);
  }
  function loadUiState() {
    try {
      const saved = JSON.parse(localStorage.getItem(UI_STATE_KEY) || "{}");
      return {
        previewVisible: typeof saved.previewVisible === "boolean" ? saved.previewVisible : false,
        sections: saved.sections && typeof saved.sections === "object" ? saved.sections : {}
      };
    } catch {
      return { previewVisible: false, sections: {} };
    }
  }
  let uiState = loadUiState();
  function saveUiState() {
    try {
      localStorage.setItem(UI_STATE_KEY, JSON.stringify(uiState));
    } catch {}
  }
  function sectionKey(title) {
    return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }
  function setupCollapsibleUi() {
    const settingsRoot = tab.root.querySelector(".lumibionic-settings");
    if (!settingsRoot)
      return;
    const previewSection = preview.closest(".lumibionic-section");
    const headingBlock = settingsRoot.firstElementChild;
    if (previewSection && headingBlock) {
      previewSection.classList.add("lumibionic-preview-section");
      headingBlock.insertAdjacentElement("afterend", previewSection);
      const toolbar = document.createElement("div");
      toolbar.className = "lumibionic-preview-toolbar";
      toolbar.innerHTML = `
        <strong>Live preview</strong>
        <button type="button" id="lb-toggle-preview"></button>
      `;
      previewSection.insertBefore(toolbar, previewSection.firstChild);
      const previewControl = preview.closest(".lumibionic-control");
      const previewLabel = previewControl?.querySelector("label");
      if (previewLabel)
        previewLabel.remove();
      const previewToggle = toolbar.querySelector("#lb-toggle-preview");
      const syncPreviewVisibility = () => {
        if (previewControl) {
          previewControl.classList.toggle("lumibionic-hidden", !uiState.previewVisible);
        }
        if (previewToggle) {
          previewToggle.textContent = uiState.previewVisible ? "Hide preview" : "Show preview";
          previewToggle.setAttribute("aria-expanded", String(uiState.previewVisible));
        }
      };
      previewToggle?.addEventListener("click", () => {
        uiState = {
          ...uiState,
          previewVisible: !uiState.previewVisible
        };
        saveUiState();
        syncPreviewVisibility();
      });
      syncPreviewVisibility();
    }
    const uiActions = document.createElement("div");
    uiActions.className = "lumibionic-ui-actions";
    uiActions.innerHTML = `
      <button type="button" id="lb-collapse-all">Collapse settings</button>
      <button type="button" id="lb-expand-all">Expand settings</button>
    `;
    if (previewSection) {
      previewSection.insertAdjacentElement("afterend", uiActions);
    } else if (headingBlock) {
      headingBlock.insertAdjacentElement("afterend", uiActions);
    }
    const sectionControllers = [];
    tab.root.querySelectorAll(".lumibionic-section").forEach((section) => {
      if (section.classList.contains("lumibionic-preview-section"))
        return;
      const title = section.querySelector(":scope > .lumibionic-section-title");
      if (!title)
        return;
      const key = sectionKey(title.textContent || "section");
      const body = document.createElement("div");
      body.className = "lumibionic-section-body";
      const children = Array.from(section.children);
      for (const child of children) {
        if (child !== title)
          body.appendChild(child);
      }
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "lumibionic-section-toggle";
      toggle.textContent = title.textContent.trim();
      title.replaceWith(toggle);
      section.appendChild(body);
      const savedExpanded = uiState.sections[key];
      const initialExpanded = typeof savedExpanded === "boolean" ? savedExpanded : false;
      const setExpanded = (expanded, persist = true) => {
        body.classList.toggle("lumibionic-section-collapsed", !expanded);
        toggle.setAttribute("aria-expanded", String(expanded));
        if (persist) {
          uiState = {
            ...uiState,
            sections: {
              ...uiState.sections,
              [key]: expanded
            }
          };
          saveUiState();
        }
      };
      toggle.addEventListener("click", () => {
        setExpanded(toggle.getAttribute("aria-expanded") !== "true");
      });
      setExpanded(initialExpanded, false);
      sectionControllers.push(setExpanded);
    });
    uiActions.querySelector("#lb-collapse-all")?.addEventListener("click", () => {
      for (const setExpanded of sectionControllers)
        setExpanded(false);
    });
    uiActions.querySelector("#lb-expand-all")?.addEventListener("click", () => {
      for (const setExpanded of sectionControllers)
        setExpanded(true);
    });
  }
  setupCollapsibleUi();
  function formatEm(value, digits = 2) {
    if (Math.abs(value) < 0.0001)
      return "Theme";
    return `${Number(value).toFixed(digits)}em`;
  }
  function syncControls() {
    preset.value = settings.preset || "custom";
    bionicEnabled.checked = settings.bionicEnabled;
    bionicOptions.classList.toggle("lumibionic-hidden", !settings.bionicEnabled);
    density.value = settings.density;
    fixation.value = String(settings.fixation);
    fixationValue.textContent = `${settings.fixation}%`;
    weight.value = String(settings.weight);
    weightValue.textContent = String(settings.weight);
    fontEnabled.checked = settings.fontEnabled;
    fontOptions.classList.toggle("lumibionic-hidden", !settings.fontEnabled);
    font.value = settings.font;
    customFont.value = settings.customFont;
    customFontWrap.classList.toggle("lumibionic-hidden", settings.font !== "custom");
    scopeMessages.checked = settings.scopeMessages;
    scopeBubble.checked = settings.scopeBubble;
    scopeComposer.checked = settings.scopeComposer;
    scopeMenus.checked = settings.scopeMenus;
    scopeNavigation.checked = settings.scopeNavigation;
    scopeAll.checked = settings.scopeAll;
    const individualScopes = [
      scopeMessages,
      scopeBubble,
      scopeComposer,
      scopeMenus,
      scopeNavigation
    ];
    for (const input of individualScopes) {
      input.disabled = settings.scopeAll;
    }
    justify.checked = settings.justifyMessages;
    hyphens.checked = settings.hyphenateMessages;
    readingWidth.value = settings.readingWidth;
    paragraphSpacing.value = String(settings.paragraphSpacing);
    paragraphSpacingValue.textContent = formatEm(settings.paragraphSpacing, 1);
    letterSpacing.value = String(settings.letterSpacing);
    letterSpacingValue.textContent = formatEm(settings.letterSpacing, 3);
    wordSpacing.value = String(settings.wordSpacing);
    wordSpacingValue.textContent = formatEm(settings.wordSpacing, 2);
    size.value = String(settings.textSize);
    sizeValue.textContent = `${settings.textSize}%`;
    line.value = String(settings.lineHeight);
    lineValue.textContent = settings.lineHeight.toFixed(2);
    ffThinkFix.checked = settings.ffThinkFixEnabled;
    ffThinkBoundaryText.value = settings.ffThinkBoundaryText;
    ffThinkReasoningSide.value = settings.ffThinkReasoningSide;
    ffThinkIncludeMarker.checked = settings.ffThinkIncludeMarker;
    autoRegenEnabled.checked = settings.autoRegenerateEnabled;
    autoRegenTrigger.value = settings.autoRegenerateTriggerText;
    autoRegenMax.value = String(settings.autoRegenerateMaxAttempts);
    autoRegenMaxValue.textContent = String(settings.autoRegenerateMaxAttempts);
    settingsPersistence.value = settings.settingsPersistenceMode;
    syncAutoRegenerateStatus();
    toolbarSpacing.value = String(settings.toolbarSpacing);
    toolbarSpacingValue.textContent = `${settings.toolbarSpacing}px`;
    for (const button of toolbarToggleButtons) {
      const key = button.dataset.toolbarKey;
      const hidden = Boolean(settings.toolbarHidden?.[key]);
      button.dataset.hidden = String(hidden);
      button.setAttribute("aria-pressed", String(hidden));
      const state = button.querySelector("small");
      if (state)
        state.textContent = hidden ? "Hidden" : "Shown";
    }
    for (const sync of mobileStepperSyncers)
      sync();
  }
  const mobileStepperSyncers = [];
  function createMobileStepper(range, key, { rebuild = false, resetValue = DEFAULTS[key] } = {}) {
    if (!range)
      return;
    range.classList.add("lumibionic-mobile-safe-range");
    const min = Number(range.min);
    const max = Number(range.max);
    const step = Number(range.step) || 1;
    const stepText = String(range.step || "1");
    const decimals = stepText.includes(".") ? stepText.split(".")[1].length : 0;
    const wrap = document.createElement("div");
    wrap.className = "lumibionic-stepper";
    const minus = document.createElement("button");
    minus.type = "button";
    minus.textContent = "−";
    minus.setAttribute("aria-label", `Decrease ${key}`);
    const exact = document.createElement("input");
    exact.type = "number";
    exact.inputMode = "decimal";
    exact.min = String(min);
    exact.max = String(max);
    exact.step = String(step);
    exact.setAttribute("aria-label", `Exact ${key} value`);
    const plus = document.createElement("button");
    plus.type = "button";
    plus.textContent = "+";
    plus.setAttribute("aria-label", `Increase ${key}`);
    const resetOne = document.createElement("button");
    resetOne.type = "button";
    resetOne.textContent = "↶";
    resetOne.className = "lumibionic-stepper-reset";
    resetOne.setAttribute("aria-label", `Reset ${key}`);
    wrap.append(minus, exact, plus, resetOne);
    range.insertAdjacentElement("afterend", wrap);
    function normalized(raw) {
      let value = Number(raw);
      if (!Number.isFinite(value))
        value = Number(settings[key]);
      value = Math.min(max, Math.max(min, value));
      value = min + Math.round((value - min) / step) * step;
      return Number(value.toFixed(decimals));
    }
    function commit(raw) {
      const value = normalized(raw);
      exact.value = String(value);
      updateSetting(key, value, rebuild);
    }
    minus.addEventListener("click", () => commit(Number(settings[key]) - step));
    plus.addEventListener("click", () => commit(Number(settings[key]) + step));
    exact.addEventListener("change", () => commit(exact.value));
    exact.addEventListener("keydown", (event) => {
      if (event.key === "Enter")
        exact.blur();
    });
    resetOne.addEventListener("click", () => commit(resetValue));
    mobileStepperSyncers.push(() => {
      exact.value = String(settings[key]);
    });
  }
  createMobileStepper(fixation, "fixation", { rebuild: true, resetValue: DEFAULTS.fixation });
  createMobileStepper(weight, "weight", { resetValue: DEFAULTS.weight });
  createMobileStepper(paragraphSpacing, "paragraphSpacing", { resetValue: DEFAULTS.paragraphSpacing });
  createMobileStepper(letterSpacing, "letterSpacing", { resetValue: DEFAULTS.letterSpacing });
  createMobileStepper(wordSpacing, "wordSpacing", { resetValue: DEFAULTS.wordSpacing });
  createMobileStepper(size, "textSize", { resetValue: DEFAULTS.textSize });
  createMobileStepper(line, "lineHeight", { resetValue: DEFAULTS.lineHeight });
  createMobileStepper(autoRegenMax, "autoRegenerateMaxAttempts", { resetValue: DEFAULTS.autoRegenerateMaxAttempts });
  createMobileStepper(toolbarSpacing, "toolbarSpacing", { resetValue: DEFAULTS.toolbarSpacing });
  function renderPreview() {
    preview.replaceChildren();
    preview.classList.toggle("lb-preview-justify", settings.justifyMessages);
    preview.style.maxWidth = settings.readingWidth === "full" ? "" : settings.readingWidth;
    const samples = [
      "A dry chuckle escaped him as he leaned toward the doorway. This line is long enough to judge justification and word spacing.",
      "She glanced toward the rain-dark window. Adjust paragraph spacing to see this second paragraph move closer or farther away."
    ];
    for (const sampleText of samples) {
      const paragraph = document.createElement("p");
      const sample = document.createTextNode(sampleText);
      paragraph.appendChild(sample);
      preview.appendChild(paragraph);
      if (settings.bionicEnabled) {
        processTextNode(sample);
      }
    }
  }
  async function loadLocalFont(file) {
    if (!file)
      return;
    unloadLocalFont(false);
    try {
      const url = URL.createObjectURL(file);
      const face = new FontFace("LumibionicCustomFile", `url("${url}")`);
      await face.load();
      document.fonts.add(face);
      loadedFontFace = face;
      loadedFontUrl = url;
      fontFileStatus.textContent = `Using local font: ${file.name}`;
      settings.fontEnabled = true;
      saveSettings();
      applyCssSettings();
      syncControls();
      processAll();
      renderPreview();
    } catch (error) {
      fontFileStatus.textContent = "Could not load that font file.";
      console.error("[Reading & Fonts] Font load failed:", error);
    }
  }
  function unloadLocalFont(refresh = true) {
    if (loadedFontFace && document.fonts) {
      try {
        document.fonts.delete(loadedFontFace);
      } catch {}
    }
    if (loadedFontUrl) {
      URL.revokeObjectURL(loadedFontUrl);
    }
    loadedFontFace = null;
    loadedFontUrl = null;
    if (fontFile) {
      fontFile.value = "";
    }
    if (fontFileStatus) {
      fontFileStatus.textContent = "No local font file loaded.";
    }
    if (refresh) {
      applyCssSettings();
      processAll();
      renderPreview();
    }
  }
  toolbarGrid?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-toolbar-key]");
    if (!button || !toolbarGrid.contains(button))
      return;
    const key = button.dataset.toolbarKey;
    updateToolbarSetting(key, !Boolean(settings.toolbarHidden?.[key]));
  });
  toolbarHideAll?.addEventListener("click", () => setAllToolbarHidden(true));
  toolbarShowAll?.addEventListener("click", () => setAllToolbarHidden(false));
  preset.addEventListener("change", () => applyPreset(preset.value));
  bionicEnabled.addEventListener("change", () => updateSetting("bionicEnabled", bionicEnabled.checked, true));
  density.addEventListener("change", () => updateSetting("density", density.value, true));
  fixation.addEventListener("input", () => updateSetting("fixation", Number(fixation.value), true));
  weight.addEventListener("input", () => updateSetting("weight", Number(weight.value)));
  fontEnabled.addEventListener("change", () => updateSetting("fontEnabled", fontEnabled.checked));
  font.addEventListener("change", () => updateSetting("font", font.value));
  customFont.addEventListener("input", () => updateSetting("customFont", customFont.value));
  fontFile.addEventListener("change", () => loadLocalFont(fontFile.files?.[0]));
  clearFontFile.addEventListener("click", () => unloadLocalFont(true));
  const scopeBindings = [
    [scopeMessages, "scopeMessages"],
    [scopeBubble, "scopeBubble"],
    [scopeComposer, "scopeComposer"],
    [scopeMenus, "scopeMenus"],
    [scopeNavigation, "scopeNavigation"],
    [scopeAll, "scopeAll"]
  ];
  for (const [input, key] of scopeBindings) {
    input.addEventListener("change", () => updateSetting(key, input.checked));
  }
  justify.addEventListener("change", () => updateSetting("justifyMessages", justify.checked));
  hyphens.addEventListener("change", () => updateSetting("hyphenateMessages", hyphens.checked));
  readingWidth.addEventListener("change", () => updateSetting("readingWidth", readingWidth.value));
  paragraphSpacing.addEventListener("input", () => updateSetting("paragraphSpacing", Number(paragraphSpacing.value)));
  letterSpacing.addEventListener("input", () => updateSetting("letterSpacing", Number(letterSpacing.value)));
  wordSpacing.addEventListener("input", () => updateSetting("wordSpacing", Number(wordSpacing.value)));
  size.addEventListener("input", () => updateSetting("textSize", Number(size.value)));
  line.addEventListener("input", () => updateSetting("lineHeight", Number(line.value)));
  function syncFFThinkBackendConfig() {
    ctx.sendToBackend({
      type: "ff_think_fix_config",
      enabled: Boolean(settings.ffThinkFixEnabled),
      config: {
        boundaryText: settings.ffThinkBoundaryText,
        reasoningSide: settings.ffThinkReasoningSide,
        includeMarker: settings.ffThinkIncludeMarker
      }
    });
  }
  let ffManualRequestId = null;
  let ffManualTimeout = null;
  function finishFFManualRequest() {
    if (ffManualTimeout) {
      clearTimeout(ffManualTimeout);
      ffManualTimeout = null;
    }
    ffManualRequestId = null;
    if (ffThinkRunNow) {
      ffThinkRunNow.disabled = false;
    }
  }
  ffThinkFix.addEventListener("change", () => {
    updateSetting("ffThinkFixEnabled", ffThinkFix.checked, false, false);
    syncFFThinkBackendConfig();
    if (ffThinkStatus) {
      ffThinkStatus.textContent = ffThinkFix.checked ? "Enabled — backend auto-fix is armed for the next completed AI reply." : "Automatic fix disabled. Manual ▶ still works.";
    }
  });
  ffThinkReasoningSide.addEventListener("change", () => {
    settings = {
      ...settings,
      ffThinkReasoningSide: ffThinkReasoningSide.value === "after" ? "after" : "before"
    };
    saveSettings();
    syncControls();
    syncFFThinkBackendConfig();
    if (ffThinkStatus) {
      ffThinkStatus.textContent = settings.ffThinkReasoningSide === "after" ? "FF split set to move text after the marker into reasoning." : "FF split set to move text before the marker into reasoning.";
    }
  });
  ffThinkIncludeMarker.addEventListener("change", () => {
    settings = {
      ...settings,
      ffThinkIncludeMarker: ffThinkIncludeMarker.checked
    };
    saveSettings();
    syncControls();
    syncFFThinkBackendConfig();
    if (ffThinkStatus) {
      ffThinkStatus.textContent = settings.ffThinkIncludeMarker ? "FF marker will move into reasoning with the selected side." : "FF marker will remain visible in normal message content.";
    }
  });
  const ffTextBindings = [
    [ffThinkBoundaryText, "ffThinkBoundaryText"]
  ];
  for (const [input, key] of ffTextBindings) {
    input.addEventListener("input", () => {
      settings = {
        ...settings,
        [key]: input.value
      };
      saveSettings();
      syncFFThinkBackendConfig();
    });
  }
  ffThinkResetPattern.addEventListener("click", () => {
    settings = {
      ...settings,
      ffThinkBoundaryText: DEFAULTS.ffThinkBoundaryText
    };
    saveSettings();
    syncControls();
    syncFFThinkBackendConfig();
    if (ffThinkStatus) {
      ffThinkStatus.textContent = "FF think fix boundary reset to default.";
    }
  });
  ffThinkRunNow.addEventListener("click", () => {
    let chatId = null;
    let latestMessageId = null;
    try {
      const active = ctx.getActiveChat();
      chatId = typeof active?.chatId === "string" ? active.chatId : null;
      latestMessageId = ctx.messages?.getLatestMessageId?.() || null;
    } catch {
      chatId = null;
      latestMessageId = null;
    }
    if (!chatId) {
      if (ffThinkStatus) {
        ffThinkStatus.textContent = "Manual FF fix could not detect the current chat.";
      }
      return;
    }
    const requestId = `manual:${Date.now()}:${Math.random().toString(36).slice(2, 9)}`;
    ffManualRequestId = requestId;
    ffThinkRunNow.disabled = true;
    if (ffThinkStatus) {
      ffThinkStatus.textContent = latestMessageId ? `▶ Current chat found. Latest logical message: ${latestMessageId.slice(0, 8)}… Asking backend for the latest assistant.` : "▶ Current chat found. Asking backend for the latest assistant.";
    }
    try {
      ctx.sendToBackend({
        type: "ff_think_fix_manual",
        requestId,
        chatId,
        latestMessageId,
        config: {
          boundaryText: settings.ffThinkBoundaryText,
          reasoningSide: settings.ffThinkReasoningSide,
          includeMarker: settings.ffThinkIncludeMarker,
          reasoningSide: settings.ffThinkReasoningSide,
          includeMarker: settings.ffThinkIncludeMarker
        }
      });
    } catch (error) {
      finishFFManualRequest();
      if (ffThinkStatus) {
        ffThinkStatus.textContent = `Manual FF fix could not contact the backend: ${error?.message || "unknown error"}`;
      }
      return;
    }
    ffManualTimeout = setTimeout(() => {
      if (ffManualRequestId !== requestId) {
        return;
      }
      finishFFManualRequest();
      if (ffThinkStatus) {
        ffThinkStatus.textContent = "Manual FF fix timed out: the backend did not answer within 9 seconds. If the FF backend bundle line still says checking, the backend worker did not load.";
      }
    }, 9000);
  });
  const autoRegenAttempts = new Map;
  let pendingAutoRegenTimer = null;
  function autoRegenKey(payload) {
    return [
      payload?.chatId || "chat",
      payload?.messageId || "message"
    ].join(":");
  }
  function triggerMatchesAutoRegen(content) {
    const trigger = settings.autoRegenerateTriggerText.trim();
    if (!trigger)
      return false;
    return String(content || "").toLocaleLowerCase().includes(trigger.toLocaleLowerCase());
  }
  function pruneAutoRegenAttempts() {
    while (autoRegenAttempts.size > 50) {
      const firstKey = autoRegenAttempts.keys().next().value;
      if (!firstKey)
        break;
      autoRegenAttempts.delete(firstKey);
    }
  }
  function scheduleAutoRegenerate(payload) {
    if (!settings.autoRegenerateEnabled || payload?.error) {
      return;
    }
    const key = autoRegenKey(payload);
    if (!triggerMatchesAutoRegen(payload?.content)) {
      autoRegenAttempts.delete(key);
      return;
    }
    const current = Number(autoRegenAttempts.get(key) || 0);
    const maxAttempts = clamp(settings.autoRegenerateMaxAttempts, 1, 10, DEFAULTS.autoRegenerateMaxAttempts);
    if (current >= maxAttempts) {
      if (autoRegenStatus) {
        autoRegenStatus.textContent = `Auto regenerate stopped after ${maxAttempts} retries for this reply.`;
      }
      return;
    }
    autoRegenAttempts.set(key, current + 1);
    pruneAutoRegenAttempts();
    if (pendingAutoRegenTimer) {
      clearTimeout(pendingAutoRegenTimer);
    }
    if (autoRegenStatus) {
      autoRegenStatus.textContent = `Trigger matched — regeneration ${current + 1}/${maxAttempts} queued.`;
    }
    pendingAutoRegenTimer = setTimeout(() => {
      pendingAutoRegenTimer = null;
      if (!settings.autoRegenerateEnabled) {
        return;
      }
      const clicked = clickNativeRegenerate();
      if (autoRegenStatus) {
        autoRegenStatus.textContent = clicked ? `Trigger matched — regeneration ${current + 1}/${maxAttempts} started.` : "Trigger matched, but the native Regenerate button was not found.";
      }
    }, 900);
  }
  settingsPersistence.addEventListener("change", () => {
    settings = {
      ...settings,
      settingsPersistenceMode: settingsPersistence.value === "browser" ? "browser" : "account"
    };
    saveSettings();
    syncControls();
    if (settings.settingsPersistenceMode === "account") {
      requestAccountSettings();
    } else if (settingsSaveStatus) {
      settingsSaveStatus.textContent = "Settings storage: this browser only.";
    }
  });
  autoRegenEnabled.addEventListener("change", () => {
    const trigger = autoRegenTrigger.value.trim();
    updateSetting("autoRegenerateEnabled", Boolean(autoRegenEnabled.checked && trigger), false, false);
    syncAutoRegenerateStatus();
    applyToolbarVisibility();
  });
  autoRegenTrigger.addEventListener("input", () => {
    const value = autoRegenTrigger.value;
    settings = {
      ...settings,
      autoRegenerateTriggerText: value,
      ...value.trim() ? {} : {
        autoRegenerateEnabled: false
      }
    };
    saveSettings();
    syncControls();
    syncAutoRegenerateStatus();
    applyToolbarVisibility();
  });
  autoRegenMax.addEventListener("input", () => updateSetting("autoRegenerateMaxAttempts", Number(autoRegenMax.value), false, false));
  toolbarSpacing.addEventListener("input", () => updateSetting("toolbarSpacing", Number(toolbarSpacing.value)));
  reset.addEventListener("click", () => {
    unloadLocalFont(false);
    settings = {
      ...DEFAULTS,
      toolbarHidden: { ...DEFAULT_TOOLBAR_HIDDEN }
    };
    saveSettings();
    applyCssSettings();
    syncControls();
    rebuildAll();
    renderPreview();
  });
  syncFFThinkBackendConfig();
  let kenSleepMessageCount = 0;
  let kenSleepChatId = null;
  let kenSleepModal = null;
  function resetKenSleepCounter(chatId = null) {
    kenSleepMessageCount = 0;
    kenSleepChatId = chatId;
  }
  function isKenSleepWindow() {
    const hour = new Date().getHours();
    return hour >= 6 && hour < 12;
  }
  function showKenSleepPopup() {
    if (kenSleepModal)
      return;
    try {
      const modal = ctx.ui.showModal({
        title: "Ken.",
        width: 380,
        maxHeight: 240,
        persistent: false
      });
      const message = document.createElement("div");
      message.textContent = "go the fuck to sleep, Ken.";
      message.style.padding = "18px 8px";
      message.style.fontSize = "1.15rem";
      message.style.fontWeight = "700";
      message.style.lineHeight = "1.45";
      message.style.textAlign = "center";
      modal.root.appendChild(message);
      kenSleepModal = modal;
      modal.onDismiss(() => {
        if (kenSleepModal === modal) {
          kenSleepModal = null;
        }
      });
    } catch (error) {
      console.warn("[Bionic Reading] Ken sleep popup failed:", error);
    }
  }
  function handleKenSleepMessage(payload) {
    return;
    const active = ctx.getActiveChat?.();
    const activeChatId = typeof active?.chatId === "string" ? active.chatId : null;
    const eventChatId = typeof payload?.chatId === "string" ? payload.chatId : null;
    if (!activeChatId || !eventChatId || activeChatId !== eventChatId) {
      if (kenSleepChatId !== activeChatId) {
        resetKenSleepCounter(activeChatId);
      }
      return;
    }
    if (kenSleepChatId !== activeChatId) {
      resetKenSleepCounter(activeChatId);
    }
    const personaName = typeof payload?.personaName === "string" ? payload.personaName.trim() : "";
    const qualifies = isKenSleepWindow() && personaName === "Ken";
    if (!qualifies) {
      resetKenSleepCounter(activeChatId);
      return;
    }
    kenSleepMessageCount += 1;
    if (kenSleepMessageCount >= 2) {
      kenSleepMessageCount = 0;
      showKenSleepPopup();
    }
  }
  let loreCleanupGroups = [];
  let loreCleanupUnlinked = [];
  let loreCleanupCharacters = [];
  let loreCleanupBusy = false;
  function escapeLoreHtml(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }
  function setLoreCleanupBusy(busy, message) {
    loreCleanupBusy = Boolean(busy);
    if (loreScan)
      loreScan.disabled = loreCleanupBusy;
    if (loreCleanExact)
      loreCleanExact.disabled = loreCleanupBusy;
    if (loreStatus && typeof message === "string") {
      loreStatus.textContent = message;
    }
  }
  async function loreApi(path, options = {}) {
    const response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      headers: {
        ...options.body ? { "Content-Type": "application/json" } : {},
        ...options.headers || {}
      }
    });
    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json();
        detail = body?.error ? `: ${body.error}` : "";
      } catch {}
      throw new Error(`${response.status} ${response.statusText}${detail}`);
    }
    if (response.status === 204)
      return null;
    return response.json();
  }
  async function lorePaged(path) {
    const all = [];
    let offset = 0;
    while (true) {
      const separator = path.includes("?") ? "&" : "?";
      const page = await loreApi(`${path}${separator}limit=200&offset=${offset}`);
      const data = Array.isArray(page?.data) ? page.data : [];
      all.push(...data);
      const total = Number(page?.total ?? all.length);
      if (!data.length || all.length >= total)
        return all;
      offset += data.length;
    }
  }
  async function loreBookEntries(bookId) {
    return lorePaged(`/api/v1/world-books/${encodeURIComponent(bookId)}/entries`);
  }
  function characterLoreIds2(character) {
    if (Array.isArray(character?.world_book_ids)) {
      return character.world_book_ids.filter((id) => typeof id === "string");
    }
    const ext = character?.extensions || {};
    if (Array.isArray(ext.world_book_ids)) {
      return ext.world_book_ids.filter((id) => typeof id === "string");
    }
    if (typeof ext.world_book_id === "string" && ext.world_book_id) {
      return [ext.world_book_id];
    }
    return [];
  }
  function stableLoreValue(value, key = "") {
    if (Array.isArray(value)) {
      const mapped = value.map((item) => stableLoreValue(item));
      if (key === "key" || key === "keysecondary") {
        return mapped.map(String).sort();
      }
      return mapped;
    }
    if (value && typeof value === "object") {
      const result = {};
      for (const childKey of Object.keys(value).sort()) {
        if ([
          "id",
          "uid",
          "world_book_id",
          "created_at",
          "updated_at",
          "revision"
        ].includes(childKey)) {
          continue;
        }
        result[childKey] = stableLoreValue(value[childKey], childKey);
      }
      return result;
    }
    return value;
  }
  function loreEntrySignature(entry) {
    return JSON.stringify(stableLoreValue(entry));
  }
  function normalizedLoreName(name) {
    return String(name || "").normalize("NFKC").trim().toLocaleLowerCase().replace(/[\s_-]+/g, " ");
  }
  function bookExactSignature(book, entries) {
    return JSON.stringify({
      name: normalizedLoreName(book?.name),
      entries: entries.map(loreEntrySignature).sort()
    });
  }
  function cardRefsByBook(characters) {
    const refs = new Map;
    for (const character of characters) {
      for (const bookId of characterLoreIds2(character)) {
        const current = refs.get(bookId) || [];
        current.push({
          id: character.id,
          name: character.name || "Unnamed character"
        });
        refs.set(bookId, current);
      }
    }
    return refs;
  }
  function shortLoreId2(id) {
    const text = String(id || "");
    if (text.length <= 18)
      return text;
    return `${text.slice(0, 8)}…${text.slice(-6)}`;
  }
  function removeLorebookFromSnapshot(bookId) {
    loreCleanupUnlinked = loreCleanupUnlinked.filter((book) => book.id !== bookId);
    loreCleanupGroups = loreCleanupGroups.flatMap((group) => {
      const nextBooks = group.books.filter((book) => book.id !== bookId);
      if (nextBooks.length < 2) {
        return [];
      }
      const keepStillExists = nextBooks.some((book) => book.id === group.recommendedKeepId);
      let recommendedKeepId = group.recommendedKeepId;
      if (!keepStillExists) {
        recommendedKeepId = [...nextBooks].sort((a, b) => {
          if (a.cardRefs.length !== b.cardRefs.length) {
            return b.cardRefs.length - a.cardRefs.length;
          }
          return a.id.localeCompare(b.id);
        })[0].id;
      }
      return [{
        ...group,
        books: nextBooks,
        recommendedKeepId
      }];
    });
  }
  function refreshLoreSnapshotRefs() {
    const refs = cardRefsByBook(loreCleanupCharacters);
    loreCleanupGroups = loreCleanupGroups.map((group) => ({
      ...group,
      books: group.books.map((book) => ({
        ...book,
        cardRefs: refs.get(book.id) || []
      }))
    }));
    loreCleanupUnlinked = loreCleanupUnlinked.map((book) => ({
      ...book,
      cardRefs: refs.get(book.id) || []
    })).filter((book) => book.cardRefs.length === 0);
  }
  function renderLoreCleanup() {
    if (loreUnlinked) {
      loreUnlinked.innerHTML = loreCleanupUnlinked.length ? loreCleanupUnlinked.map((book) => `
              <div class="lumibionic-lorebook-card">
                <div class="lumibionic-lorebook-card-title">
                  ${escapeLoreHtml(book.name)}
                </div>

                <div class="lumibionic-lorebook-book">
                  <div class="lumibionic-lorebook-book-head">
                    <span class="lumibionic-lorebook-role">UNLINKED</span>

                    <code
                      class="lumibionic-lorebook-id"
                      title="${escapeLoreHtml(book.id)}"
                    >${escapeLoreHtml(shortLoreId2(book.id))}</code>
                  </div>

                  <div class="lumibionic-lorebook-meta">
                    ${book.entryCount} entries · no character-card links
                  </div>
                </div>

                <div class="lumibionic-lorebook-actions">
                  <button
                    type="button"
                    data-lore-delete-unlinked="${escapeLoreHtml(book.id)}"
                  >
                    Delete unlinked lorebook
                  </button>
                </div>
              </div>
            `).join("") : '<div class="lumibionic-muted">No unlinked lorebooks found.</div>';
    }
    if (!loreResults)
      return;
    loreResults.innerHTML = loreCleanupGroups.length ? loreCleanupGroups.map((group) => {
      const duplicateBooks = group.books.filter((book) => book.id !== group.recommendedKeepId);
      const affectedCards = new Map;
      for (const book of duplicateBooks) {
        for (const ref of book.cardRefs) {
          affectedCards.set(ref.id, ref);
        }
      }
      const books = group.books.map((book) => {
        const keep = book.id === group.recommendedKeepId;
        const refNames = book.cardRefs.map((ref) => ref.name);
        let refSummary = "no card links";
        if (refNames.length) {
          const shown = refNames.slice(0, 2).join(", ");
          const more = refNames.length > 2 ? ` +${refNames.length - 2} more` : "";
          refSummary = `${refNames.length} card${refNames.length === 1 ? "" : "s"} · ${shown}${more}`;
        }
        return `
                    <div class="lumibionic-lorebook-book ${keep ? "is-keep" : "is-duplicate"}">
                      <div class="lumibionic-lorebook-book-head">
                        <span class="lumibionic-lorebook-role">
                          ${keep ? "KEEP" : "DUPLICATE"}
                        </span>

                        <code
                          class="lumibionic-lorebook-id"
                          title="${escapeLoreHtml(book.id)}"
                        >${escapeLoreHtml(shortLoreId2(book.id))}</code>
                      </div>

                      <div class="lumibionic-lorebook-name">
                        ${escapeLoreHtml(book.name)}
                      </div>

                      <div class="lumibionic-lorebook-meta">
                        ${book.entryCount} entries · ${escapeLoreHtml(refSummary)}
                      </div>
                    </div>
                  `;
      }).join("");
      const affectedCount = affectedCards.size;
      const duplicateCount = duplicateBooks.length;
      return `
              <div class="lumibionic-lorebook-card">
                <div class="lumibionic-lorebook-card-title">
                  Exact duplicate · ${escapeLoreHtml(group.name)}
                </div>

                ${books}

                <div class="lumibionic-lorebook-summary">
                  ${affectedCount} card${affectedCount === 1 ? "" : "s"} will be relinked ·
                  ${duplicateCount} duplicate${duplicateCount === 1 ? "" : "s"} will be deleted
                </div>

                <div class="lumibionic-lorebook-actions">
                  <button
                    type="button"
                    data-lore-clean-group="${escapeLoreHtml(group.groupId)}"
                  >
                    Relink &amp; delete ${duplicateCount} duplicate${duplicateCount === 1 ? "" : "s"}
                  </button>
                </div>
              </div>
            `;
    }).join("") : '<div class="lumibionic-muted">No exact duplicate lorebooks found.</div>';
  }
  async function scanLorebooksDirect() {
    const [books, characters] = await Promise.all([
      lorePaged("/api/v1/world-books"),
      lorePaged("/api/v1/characters")
    ]);
    loreCleanupCharacters = characters;
    const refs = cardRefsByBook(characters);
    const enriched = [];
    let completed = 0;
    for (const book of books) {
      const entries = await loreBookEntries(book.id);
      completed += 1;
      if (loreStatus) {
        loreStatus.textContent = `Reading lorebook entries… ${completed}/${books.length}`;
      }
      enriched.push({
        id: book.id,
        name: book.name || "Unnamed lorebook",
        entryCount: entries.length,
        cardRefs: refs.get(book.id) || [],
        signature: bookExactSignature(book, entries)
      });
    }
    loreCleanupUnlinked = enriched.filter((book) => book.cardRefs.length === 0).sort((a, b) => a.name.localeCompare(b.name));
    const bySignature = new Map;
    for (const book of enriched) {
      if (book.entryCount === 0)
        continue;
      const list = bySignature.get(book.signature) || [];
      list.push(book);
      bySignature.set(book.signature, list);
    }
    loreCleanupGroups = [];
    let groupNumber = 0;
    for (const booksInGroup of bySignature.values()) {
      if (booksInGroup.length < 2)
        continue;
      groupNumber += 1;
      const sorted = [...booksInGroup].sort((a, b) => {
        if (a.cardRefs.length !== b.cardRefs.length) {
          return b.cardRefs.length - a.cardRefs.length;
        }
        return a.id.localeCompare(b.id);
      });
      loreCleanupGroups.push({
        groupId: `exact-${groupNumber}`,
        name: sorted[0].name,
        recommendedKeepId: sorted[0].id,
        books: sorted
      });
    }
    loreCleanupGroups.sort((a, b) => a.name.localeCompare(b.name));
    renderLoreCleanup();
    if (loreScan) {
      loreScan.textContent = "Rescan lorebooks";
    }
    setLoreCleanupBusy(false, `Scan complete: ${books.length} lorebooks · ${loreCleanupUnlinked.length} not linked to any card · ${loreCleanupGroups.length} exact duplicate group${loreCleanupGroups.length === 1 ? "" : "s"}.`);
  }
  async function updateCharacterLoreIds(character, nextIds) {
    await loreApi(`/api/v1/characters/${encodeURIComponent(character.id)}`, {
      method: "PUT",
      body: JSON.stringify({
        world_book_ids: nextIds
      })
    });
  }
  async function cleanExactLoreGroup(group) {
    const keepId = group.recommendedKeepId;
    const duplicateIds = group.books.map((book) => book.id).filter((id) => id !== keepId);
    const duplicateSet = new Set(duplicateIds);
    let relinkedCardCount = 0;
    let deletedCount = 0;
    for (const character of loreCleanupCharacters) {
      const current = characterLoreIds2(character);
      if (!current.some((id) => duplicateSet.has(id))) {
        continue;
      }
      const next = Array.from(new Set(current.map((id) => duplicateSet.has(id) ? keepId : id)));
      await updateCharacterLoreIds(character, next);
      character.world_book_ids = [...next];
      relinkedCardCount += 1;
    }
    refreshLoreSnapshotRefs();
    for (const id of duplicateIds) {
      await loreApi(`/api/v1/world-books/${encodeURIComponent(id)}`, {
        method: "DELETE"
      });
      removeLorebookFromSnapshot(id);
      deletedCount += 1;
    }
    return {
      keepId,
      relinkedCardCount,
      deletedCount
    };
  }
  async function requestLorebookScan() {
    if (loreCleanupBusy)
      return;
    setLoreCleanupBusy(true, "Scanning lorebooks and character-card links…");
    try {
      await scanLorebooksDirect();
    } catch (error) {
      setLoreCleanupBusy(false, `Lorebook cleanup failed: ${error?.message || String(error)}`);
    }
  }
  loreScan?.addEventListener("click", requestLorebookScan);
  loreCleanExact?.addEventListener("click", async () => {
    if (loreCleanupBusy)
      return;
    if (!loreCleanupGroups.length) {
      if (loreStatus) {
        loreStatus.textContent = "No exact duplicate groups are currently listed.";
      }
      return;
    }
    if (!window.confirm(`Relink and clean ${loreCleanupGroups.length} exact duplicate group${loreCleanupGroups.length === 1 ? "" : "s"}?

Cards are relinked before redundant lorebooks are deleted.`)) {
      return;
    }
    setLoreCleanupBusy(true, "Relinking cards and removing exact duplicates…");
    try {
      const groupsToClean = [...loreCleanupGroups];
      let relinkedCardCount = 0;
      let deletedCount = 0;
      for (const group of groupsToClean) {
        const result = await cleanExactLoreGroup(group);
        relinkedCardCount += result.relinkedCardCount;
        deletedCount += result.deletedCount;
      }
      renderLoreCleanup();
      setLoreCleanupBusy(false, `Cleanup complete: ${relinkedCardCount} card${relinkedCardCount === 1 ? "" : "s"} relinked · ${deletedCount} duplicate lorebook${deletedCount === 1 ? "" : "s"} deleted. Results updated locally; rescan only when you want to refresh the library.`);
    } catch (error) {
      setLoreCleanupBusy(false, `Lorebook cleanup failed: ${error?.message || String(error)}`);
    }
  });
  loreResults?.addEventListener("click", async (event) => {
    const button = event.target?.closest?.("[data-lore-clean-group]");
    if (!button || loreCleanupBusy)
      return;
    const groupId = button.getAttribute("data-lore-clean-group");
    const group = loreCleanupGroups.find((item) => item.groupId === groupId);
    if (!group)
      return;
    if (!window.confirm(`Keep the ★ copy of "${group.name}", relink every card using the redundant copies, then delete those copies?`)) {
      return;
    }
    setLoreCleanupBusy(true, `Cleaning ${group.name}…`);
    try {
      const result = await cleanExactLoreGroup(group);
      renderLoreCleanup();
      setLoreCleanupBusy(false, `Cleaned ${group.name}: ${result.relinkedCardCount} card${result.relinkedCardCount === 1 ? "" : "s"} relinked · ${result.deletedCount} duplicate lorebook${result.deletedCount === 1 ? "" : "s"} deleted. Results updated locally.`);
    } catch (error) {
      setLoreCleanupBusy(false, `Lorebook cleanup failed: ${error?.message || String(error)}`);
    }
  });
  loreUnlinked?.addEventListener("click", async (event) => {
    const button = event.target?.closest?.("[data-lore-delete-unlinked]");
    if (!button || loreCleanupBusy)
      return;
    const id = button.getAttribute("data-lore-delete-unlinked");
    const book = loreCleanupUnlinked.find((item) => item.id === id);
    if (!book)
      return;
    if (!window.confirm(`Delete unlinked lorebook "${book.name}"?

The current scan found no character card referencing it. This cannot be undone.`)) {
      return;
    }
    setLoreCleanupBusy(true, `Deleting ${book.name}…`);
    try {
      await loreApi(`/api/v1/world-books/${encodeURIComponent(book.id)}`, {
        method: "DELETE"
      });
      removeLorebookFromSnapshot(book.id);
      renderLoreCleanup();
      setLoreCleanupBusy(false, `Deleted ${book.name}. Results updated locally; rescan only when you want to refresh the library.`);
    } catch (error) {
      setLoreCleanupBusy(false, `Lorebook cleanup failed: ${error?.message || String(error)}`);
    }
  });
  const unsubAutoRegenerate = ctx.events?.on?.("GENERATION_ENDED", (payload) => {
    scheduleAutoRegenerate(payload);
  });
  const unsubBackendMessage = ctx.onBackendMessage((payload) => {
    if (payload?.type === "bionic_settings_loaded") {
      const saved = payload?.settings;
      if (saved && typeof saved === "object") {
        applyingAccountSettings = true;
        try {
          localStorage.setItem(SETTINGS_KEY, JSON.stringify({
            ...saved,
            settingsPersistenceMode: saved.settingsPersistenceMode === "browser" ? "browser" : "account"
          }));
          settings = loadSettings();
          applyCssSettings();
          syncControls();
          rebuildAll();
          renderPreview();
          syncFFThinkBackendConfig();
          if (settingsSaveStatus) {
            settingsSaveStatus.textContent = "Settings storage: account settings loaded.";
          }
        } finally {
          applyingAccountSettings = false;
        }
      } else {
        if (settings.settingsPersistenceMode === "account") {
          saveSettings();
        }
        if (settingsSaveStatus) {
          settingsSaveStatus.textContent = "Settings storage: account save initialized.";
        }
      }
      return;
    }
    if (payload?.type === "bionic_settings_saved") {
      if (settingsSaveStatus) {
        settingsSaveStatus.textContent = payload?.ok === false ? "Settings storage: account save failed; browser copy kept." : "Settings storage: saved to your Lumiverse account.";
      }
      return;
    }
    if (payload?.type === "ken_sleep_message_sent") {
      handleKenSleepMessage(payload);
      return;
    }
    if (payload?.type === "ff_think_fix_health") {
      if (ffThinkBackendStatus) {
        ffThinkBackendStatus.textContent = `FF backend bundle: connected v${payload.version || "?"}`;
      }
      return;
    }
    if (payload?.type === "ff_think_fix_progress") {
      if (payload.source === "manual" && ffManualRequestId && payload.requestId === ffManualRequestId) {
        if (ffThinkStatus) {
          ffThinkStatus.textContent = payload.stage === "reading" ? `▶ Backend v${payload.version || "?"} received the request — reading saved chat messages…` : `▶ Backend v${payload.version || "?"} found the assistant — applying native reasoning update…`;
        }
      }
      return;
    }
    if (payload?.type !== "ff_think_fix_result") {
      return;
    }
    if (payload.source === "manual" && ffManualRequestId && payload.requestId === ffManualRequestId) {
      finishFFManualRequest();
    }
    if (!ffThinkStatus)
      return;
    const sourceLabel = payload.source === "manual" ? "Manual" : "Automatic";
    if (payload.status === "fixed") {
      ffThinkStatus.textContent = `${sourceLabel} FF fix succeeded — moved ${payload.reasoningSide === "after" ? "post-marker" : "pre-marker"} text${payload.includeMarker ? " including the marker" : ""} into native reasoning.`;
    } else if (payload.status === "no_match") {
      ffThinkStatus.textContent = `${sourceLabel} FF fix: no matching RP boundary marker in the target reply.`;
    } else if (payload.status === "already_fixed") {
      ffThinkStatus.textContent = `${sourceLabel} FF fix: target reply is already split into native reasoning.`;
    } else if (payload.status === "no_assistant") {
      ffThinkStatus.textContent = "Manual FF fix: no assistant message was found in this chat.";
    } else if (payload.status === "not_assistant") {
      ffThinkStatus.textContent = "Automatic FF fix skipped: generated target was not an assistant reply.";
    } else if (payload.status === "busy") {
      ffThinkStatus.textContent = `${sourceLabel} FF fix: that message is already being repaired.`;
    } else if (payload.status === "error") {
      ffThinkStatus.textContent = `${sourceLabel} FF fix failed: ${payload.error || "unknown error"}`;
    }
  });
  try {
    ctx.sendToBackend({
      type: "ff_think_fix_health"
    });
  } catch {
    if (ffThinkBackendStatus) {
      ffThinkBackendStatus.textContent = "FF backend: frontend could not send a health check.";
    }
  }
  try {
    ctx.ready?.();
  } catch {}
  if (settings.settingsPersistenceMode === "account") {
    requestAccountSettings();
  } else if (settingsSaveStatus) {
    settingsSaveStatus.textContent = "Settings storage: this browser only.";
  }
  const observer = new MutationObserver(() => {
    scheduleProcess();
    scheduleFontCompatSettle();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      "title",
      "aria-label",
      "data-tooltip",
      "data-title"
    ]
  });
  const GROUP_STATE_KEY = `${UI_STATE_KEY}:groups`;
  let groupState = {};
  try {
    groupState = JSON.parse(localStorage.getItem(GROUP_STATE_KEY) || "{}");
  } catch {
    groupState = {};
  }
  document.querySelectorAll(".lumibionic-group").forEach((details) => {
    const key = details.getAttribute("data-lumibionic-group");
    if (key && typeof groupState[key] === "boolean") {
      details.open = groupState[key];
    }
    details.addEventListener("toggle", () => {
      if (!key)
        return;
      groupState[key] = details.open;
      try {
        localStorage.setItem(GROUP_STATE_KEY, JSON.stringify(groupState));
      } catch {}
    });
  });
  applyCssSettings();
  syncControls();
  renderPreview();
  processAll();
  return () => {
    observer.disconnect();
    unsubBackendMessage?.();
    unsubAutoRegenerate?.();
    if (pendingAutoRegenTimer) {
      clearTimeout(pendingAutoRegenTimer);
      pendingAutoRegenTimer = null;
    }
    if (fontCompatSettleTimer) {
      clearTimeout(fontCompatSettleTimer);
      fontCompatSettleTimer = null;
    }
    if (fontCompatLateTimer) {
      clearTimeout(fontCompatLateTimer);
      fontCompatLateTimer = null;
    }
    if (kenSleepModal) {
      try {
        kenSleepModal.dismiss();
      } catch {}
      kenSleepModal = null;
    }
    unwrap();
    unloadLocalFont(false);
    clearToolbarVisibility();
    document.querySelectorAll(`[${SCROLL_LATEST_WRAPPER_ATTR}]`).forEach((wrapper) => wrapper.remove());
    document.querySelectorAll(`[${SCROLL_LATEST_BUTTON_ATTR}]`).forEach((button) => button.remove());
    document.querySelectorAll(`[${AUTO_REGENERATE_WRAPPER_ATTR}], ` + `[${AUTO_REGENERATE_BUTTON_ATTR}]`).forEach((element) => element.remove());
    document.querySelectorAll(".lumibionic-bubble-scope").forEach((el) => {
      el.classList.remove("lumibionic-bubble-scope");
    });
    const root = document.documentElement;
    for (const className of [
      "lb-font-messages",
      "lb-font-bubble",
      "lb-font-composer",
      "lb-font-menus",
      "lb-font-navigation",
      "lb-font-all",
      ...TOOLBAR_BUTTONS.map((item) => item.className)
    ]) {
      root.classList.remove(className);
    }
    for (const property of [
      "--lumibionic-weight",
      "--lumibionic-font-family",
      "--lumibionic-preview-font",
      "--lumibionic-text-size",
      "--lumibionic-line-height",
      "--lumibionic-reading-width",
      "--lumibionic-paragraph-spacing",
      "--lumibionic-letter-spacing",
      "--lumibionic-word-spacing",
      "--lumibionic-preview-letter-spacing",
      "--lumibionic-preview-word-spacing",
      "--lumibionic-preview-hyphens"
    ]) {
      root.style.removeProperty(property);
    }
    tab.destroy();
    removeStyle();
    lorebookOrganizerCleanup?.();
    ctx.dom.cleanup();
  };
}
export {
  setup
};
