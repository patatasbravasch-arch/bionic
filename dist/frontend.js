// src/folder-preferences.ts
function folderPreferences(raw) {
  const keys = (value) => Array.isArray(value) ? [...new Set(value.filter((item) => typeof item === "string").map((item) => item.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase()).filter(Boolean))].slice(0, 500) : [];
  return { author: keys(raw?.author), tag: keys(raw?.tag) };
}

// src/character-cleaner-core.ts
var ARCHIVE_FOLDER = "Bionic — Duplicate cards";
var ARCHIVE_KEY = "bionic_character_cleaner_archive";
function characterName(value) {
  return String(value ?? "").normalize("NFKC").trim().toLowerCase().replace(/(?:\s*\(copy\))+(?:\s*)$/i, "").trim();
}
function stable(value) {
  if (Array.isArray(value))
    return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}
function characterFingerprint(card) {
  const { id, user_id, created_at, updated_at, folder, name, chatCount, ...content } = card;
  const extensions = { ...content.extensions || {} };
  delete extensions._lumiverse_source_filename;
  delete extensions[ARCHIVE_KEY];
  delete extensions.bionic_character_cleaner_ignored;
  return JSON.stringify(stable({ ...content, extensions, name: characterName(name) }));
}
function chatReferences(chats, characterId) {
  return chats.filter((chat) => chat.character_id === characterId || Array.isArray(chat.metadata?.character_ids) && chat.metadata.character_ids.includes(characterId)).length;
}
function duplicateGroups(cards, chats) {
  const groups = new Map;
  for (const card of cards) {
    if (card.folder === ARCHIVE_FOLDER || card.extensions?.[ARCHIVE_KEY] || card.extensions?.bionic_character_cleaner_ignored)
      continue;
    const name = characterName(card.name);
    if (!name)
      continue;
    const group = groups.get(name) || [];
    group.push({ ...card, chatCount: chatReferences(chats, card.id) });
    groups.set(name, group);
  }
  return [...groups.values()].filter((group) => group.length > 1).map((group) => {
    group.sort((a, b) => b.chatCount - a.chatCount || Number(a.created_at) - Number(b.created_at) || a.id.localeCompare(b.id));
    return { name: group[0].name, cards: group, keeperId: group[0].id };
  });
}
async function pagedCharacters(api, path) {
  const cards = [];
  const seen = new Set;
  for (let offset = 0;; ) {
    const page = await api(`${path}?limit=100&offset=${offset}`);
    if (!Array.isArray(page?.data) || !Number.isFinite(page.total))
      throw new Error("Incomplete library response. Nothing was changed.");
    for (const item of page.data) {
      if (!item?.id || seen.has(item.id))
        throw new Error("Library changed during scanning. Scan again.");
      seen.add(item.id);
      cards.push(item);
    }
    offset += page.data.length;
    if (offset >= page.total)
      return cards;
    if (!page.data.length)
      throw new Error("Incomplete library response. Nothing was changed.");
  }
}

// src/character-actions-core.ts
var IGNORE_KEY = "bionic_character_cleaner_ignored";
function assertDeleteCopy(candidate, keeper, chats, item) {
  if (!candidate || !keeper || candidate.id !== item.id || keeper.id !== item.keeperId || candidate.id === keeper.id)
    throw new Error("Both copies must still exist and a keeper must remain. Rescan characters.");
  if (candidate.folder === ARCHIVE_FOLDER || candidate.extensions?.[ARCHIVE_KEY] || keeper.folder === ARCHIVE_FOLDER || keeper.extensions?.[ARCHIVE_KEY])
    throw new Error("Restore archived cards before reviewing duplicates.");
  if (candidate.extensions?.[IGNORE_KEY] || keeper.extensions?.[IGNORE_KEY])
    throw new Error("This group was ignored. Rescan characters.");
  if ((candidate.folder || "") !== item.from || (keeper.folder || "") !== item.keeperFrom || candidate.name !== item.name || keeper.name !== item.keeperName)
    throw new Error("A card was renamed or moved since the comparison. Rescan before deleting.");
  if (characterName(candidate.name) !== characterName(keeper.name) || characterFingerprint(candidate) !== item.expected || characterFingerprint(keeper) !== item.keeperExpected)
    throw new Error("A card changed since the comparison. Rescan before deleting.");
  if (chatReferences(chats, candidate.id))
    throw new Error("This card is used in a primary or group chat. Deletion is blocked to protect those chats.");
}
function characterEditPatch(original, current, draft) {
  if (!current || characterFingerprint(original) !== characterFingerprint(current) || original.name !== current.name || (original.folder || "") !== (current.folder || ""))
    throw new Error("The character changed elsewhere. Reload it before saving.");
  if (!String(draft.name || "").trim())
    throw new Error("A character name is required.");
  const patch = {};
  const fields = ["name", "creator", "folder", "description", "personality", "scenario", "first_mes", "mes_example", "creator_notes", "system_prompt", "post_history_instructions", "tags", "alternate_greetings"];
  for (const key of fields) {
    if (JSON.stringify(draft[key]) !== JSON.stringify(original[key] ?? (["tags", "alternate_greetings"].includes(key) ? [] : "")))
      patch[key] = draft[key];
  }
  return patch;
}

// src/character-folders-core.ts
var text = (value) => typeof value === "string" ? value.normalize("NFKC").trim().replace(/\s+/g, " ") : "";
function characterFolderGroups(cards, mode) {
  const groups = new Map;
  for (const card of cards) {
    if (card.folder === ARCHIVE_FOLDER || card.extensions?.[ARCHIVE_KEY])
      continue;
    const values = mode === "author" ? [text(card.creator)] : Array.isArray(card.tags) ? card.tags.map(text) : [];
    for (const value of new Set(values.filter(Boolean).map((value) => value.toLowerCase()))) {
      const label = values.find((item) => item.toLowerCase() === value);
      const group = groups.get(value) || { key: value, label, folder: `${mode === "author" ? "Author" : "Tag"} · ${label}`.slice(0, 120), cards: [] };
      group.cards.push(card);
      groups.set(value, group);
    }
  }
  return [...groups.values()].filter((group) => group.cards.length >= 2).sort((a, b) => b.cards.length - a.cards.length || a.key.localeCompare(b.key));
}
function characterFolderPlan(groups, selected, onlyUnfiled) {
  const assigned = new Set, plan = [];
  for (const group of groups) {
    if (!selected.has(group.key))
      continue;
    const folder = selected.get(group.key).trim();
    if (!folder || folder.length > 120)
      throw new Error("Folder names must contain 1–120 characters.");
    if (folder === ARCHIVE_FOLDER)
      throw new Error("Choose a name other than the duplicate archive folder.");
    for (const card of group.cards) {
      if (assigned.has(card.id) || onlyUnfiled && String(card.folder || "").trim())
        continue;
      assigned.add(card.id);
      if (card.folder === folder)
        continue;
      plan.push({ id: card.id, name: card.name, from: card.folder || "", folder, fingerprint: characterFingerprint(card) });
    }
  }
  return plan;
}
function assertFolderMove(card, move) {
  if (!card || card.id !== move.id || (card.folder || "") !== move.from || characterFingerprint(card) !== move.fingerprint) {
    throw new Error("A character changed since the preview. Scan again before moving it.");
  }
  if (card.folder === ARCHIVE_FOLDER || card.extensions?.[ARCHIVE_KEY])
    throw new Error("Archived duplicates cannot be organized.");
}

// src/library-characters-frontend.ts
var escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
var path = (id) => `/api/v1/characters/${encodeURIComponent(id)}`;
var thumbnail = (card) => card.avatar_path || card.image_id ? `<img class="lb-bot-avatar" src="${path(card.id)}/avatar" alt="" loading="lazy">` : `<span class="lb-bot-avatar lb-bot-placeholder" aria-hidden="true">${escape(String(card.name || "?").slice(0, 1))}</span>`;
function installCharacterCleaner(root, options = {}) {
  const host = root.querySelector("#lb-character-cleaner");
  let cards = [], groups = [], busy = false, disposed = false, scanned = false;
  let view = "duplicates", mode = "author", onlyUnfiled = true, query = "", page = 0;
  let status = "Scan your characters to create folders or review duplicate cards.";
  let preview = null;
  let comparison = null;
  let editing = null, draft = {};
  let differencesOnly = true;
  const chosenFolders = new Map, keepers = new Map;
  let pendingDelete = null;
  let exclusions = folderPreferences(null), preferencesLoaded = false;
  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers }
    });
    if (!response.ok)
      throw new Error(`Library request failed (${response.status}).`);
    return response.json();
  }
  async function scan() {
    const [library, chats] = await Promise.all([pagedCharacters(api, "/api/v1/characters"), pagedCharacters(api, "/api/v1/chats")]);
    if (disposed)
      return;
    cards = library;
    groups = duplicateGroups(library, chats);
    scanned = true;
    comparison = null;
    pendingDelete = null;
    keepers.clear();
    chosenFolders.clear();
    preview = null;
    page = 0;
    groups.forEach((group) => keepers.set(group.cards[0].id, group.keeperId));
  }
  const matches = (value) => value.toLowerCase().includes(query.trim().toLowerCase());
  function folderGroups() {
    return characterFolderGroups(cards, mode).filter((group) => !exclusions[mode].includes(group.key));
  }
  async function loadPreferences() {
    exclusions = folderPreferences((await options.loadFolderPreferences?.())?.preferences);
    preferencesLoaded = true;
  }
  async function excludeFolder(key, excluded = true) {
    const next = { author: [...exclusions.author], tag: [...exclusions.tag] };
    next[mode] = excluded ? [...new Set([...next[mode], key])] : next[mode].filter((item) => item !== key);
    await options.saveFolderPreferences?.(next);
    exclusions = next;
    chosenFolders.delete(key);
    preview = null;
    status = excluded ? `Excluded “${key}” from future ${mode} folder suggestions.` : `“${key}” can be suggested again.`;
  }
  function foldersView() {
    if (preview)
      return `<section class="lb-bot-plan"><h3>${preview.length} bots will move</h3><div class="lb-bot-actions"><button type="button" data-cleaner="back-folders">Back to groups</button><button type="button" data-cleaner="apply-folders" ${busy || !preview.length ? "disabled" : ""}>Create folders and move ${preview.length} bots</button></div><div class="lb-bot-table-wrap"><table><thead><tr><th>Bot</th><th>Current folder</th><th>New folder</th></tr></thead><tbody>${preview.map((move) => `<tr><td>${escape(move.name)}</td><td>${escape(move.from || "No folder")}</td><td>${escape(move.folder)}</td></tr>`).join("")}</tbody></table></div></section>`;
    const suggestions = folderGroups().filter((group) => matches(group.label));
    return `<p>Choose the author or tag folders you want to create. Only selected folders are included in the preview. Exclude suggestions you never want to use.</p>
      <div class="lb-bot-actions"><label>Group by <select data-folder-mode ${busy ? "disabled" : ""}><option value="author" ${mode === "author" ? "selected" : ""}>Author</option><option value="tag" ${mode === "tag" ? "selected" : ""}>Tag</option></select></label>
      <label class="lb-bot-check"><input type="checkbox" data-unfiled ${onlyUnfiled ? "checked" : ""} ${busy ? "disabled" : ""}> Only bots without a folder</label></div>
      ${mode === "tag" ? '<p class="lumibionic-muted">For bots with several selected tags, the most common selected tag wins. Check the preview to see each bot’s folder.</p>' : ""}
      <div class="lb-bot-actions"><button type="button" data-cleaner="select-folders" ${busy || !suggestions.length ? "disabled" : ""}>Select visible groups</button><button type="button" data-cleaner="clear-folders" ${busy ? "disabled" : ""}>Clear selection</button></div>
      <div class="lb-bot-folder-grid">${suggestions.map((group) => {
      const count = group.cards.filter((card) => !onlyUnfiled || !String(card.folder || "").trim()).length;
      return `<article class="lb-bot-folder"><strong>${escape(group.label)}</strong><p>${count} eligible · ${group.cards.length} total</p><div class="lb-bot-actions"><button type="button" data-folder-pick="${escape(group.key)}" aria-pressed="${chosenFolders.has(group.key)}" ${busy || !count ? "disabled" : ""}>${chosenFolders.has(group.key) ? "Selected — remove" : "Select this folder"}</button><button type="button" data-folder-exclude="${escape(group.key)}" ${busy ? "disabled" : ""}>Don't suggest this ${mode === "tag" ? "tag" : "author"}</button></div>${count ? "" : "<small>No unfiled bots. Turn off “Only bots without a folder” to include bots already filed.</small>"}
        <input type="text" maxlength="120" data-folder-name="${escape(group.key)}" aria-label="Folder for ${escape(group.label)}" value="${escape(chosenFolders.get(group.key) ?? group.folder)}" ${busy ? "disabled" : ""}>
        <p>${group.cards.slice(0, 5).map((card) => escape(card.name)).join(" · ")}${group.cards.length > 5 ? ` · +${group.cards.length - 5} more` : ""}</p></article>`;
    }).join("")}</div>
      ${scanned && !suggestions.length ? "<p>No shared authors or tags found for this search. Cards need a saved author or tag shared by at least two bots.</p>" : ""}
      <p>${chosenFolders.size} folders selected. Unselected suggestions will not be created.</p>
      ${exclusions[mode].length ? `<details><summary>Excluded ${mode === "tag" ? "tags" : "authors"} (${exclusions[mode].length})</summary><div class="lb-bot-actions">${exclusions[mode].map((key) => `<button type="button" data-folder-restore="${escape(key)}" ${busy ? "disabled" : ""}>Use ${escape(key)} again</button>`).join("")}</div></details>` : ""}
      <button type="button" data-cleaner="preview-folders" ${busy || !chosenFolders.size ? "disabled" : ""}>Preview folder moves</button>
      `;
  }
  function duplicatesView() {
    const visible = groups.filter((group) => matches(group.name + " " + group.cards.map((card) => `${card.creator || ""} ${card.folder || ""}`).join(" ")));
    const maxPage = Math.max(0, Math.ceil(visible.length / 6) - 1);
    page = Math.min(page, maxPage);
    return `<p>Compare copies, pick the keeper, then delete unused duplicates or ignore cards you want to keep separately.</p>
      ${visible.slice(page * 6, page * 6 + 6).map((group) => {
      const keeper = group.cards.find((card) => card.id === keepers.get(group.cards[0].id));
      return `<section class="lb-bot-group"><header><h3>${escape(group.name)}</h3><div class="lb-bot-actions"><button type="button" data-compare="${escape(group.cards.find((card) => card.id !== keeper.id).id)}">Compare copies</button><button type="button" data-ignore-group="${escape(group.cards[0].id)}">Ignore group</button></div></header>
          <label>Keep <select aria-label="Keep a copy of ${escape(group.name)}" data-keeper="${escape(group.cards[0].id)}" ${busy ? "disabled" : ""}>${group.cards.map((card) => `<option value="${escape(card.id)}" ${card.id === keeper.id ? "selected" : ""}>${escape(card.name)} · ${card.chatCount} chats · ${escape(card.creator || "No author")} · ${escape(card.id.slice(0, 8))}</option>`).join("")}</select></label>
          <div class="lb-bot-copy-grid">${group.cards.map((card) => `<article class="lb-bot-copy"><div class="lb-bot-card-heading">${thumbnail(card)}<div><strong>${escape(card.name)}</strong><small>${escape(card.creator || "No author")}<br>${escape(card.folder || "No folder")} · ${card.chatCount} chats</small></div></div>
          <p>${card.id === keeper.id ? "Keeping this copy" : card.chatCount ? "Protected: used in chats" : characterFingerprint(card) === characterFingerprint(keeper) ? "Identical card content" : "Different version"}</p>
          <div class="lb-bot-actions"><button type="button" data-edit-card="${escape(card.id)}">Edit</button><button type="button" data-ignore-card="${escape(card.id)}">Ignore</button>${card.id !== keeper.id ? `<button type="button" data-compare="${escape(card.id)}">Compare</button><button type="button" data-delete-card="${escape(card.id)}" ${busy || card.chatCount ? "disabled" : ""}>Delete</button>` : ""}</div>
</article>`).join("")}</div></section>`;
    }).join("")}
      ${scanned && !visible.length ? "<p>No duplicate-name groups found for this search.</p>" : ""}
      ${visible.length > 6 ? `<div class="lb-bot-actions"><button type="button" data-cleaner="previous" ${page === 0 ? "disabled" : ""}>Previous</button><span>Page ${page + 1} of ${maxPage + 1}</span><button type="button" data-cleaner="next" ${page === maxPage ? "disabled" : ""}>Next</button></div>` : ""}`;
  }
  function ignoredView() {
    const ignored = cards.filter((card) => card.extensions?.[IGNORE_KEY] && matches(card.name));
    return `<p>These cards are excluded from duplicate scans. They keep their current folder and remain usable.</p><div class="lb-bot-copy-grid">${ignored.map((card) => `<article class="lb-bot-copy"><div class="lb-bot-card-heading">${thumbnail(card)}<strong>${escape(card.name)}</strong></div><div class="lb-bot-actions"><button type="button" data-edit-card="${escape(card.id)}">Edit</button><button type="button" data-unignore="${escape(card.id)}">Include in scans again</button></div></article>`).join("")}</div>${scanned && !ignored.length ? "<p>No ignored cards.</p>" : ""}`;
  }
  function comparisonView() {
    const group = groups.find((group) => group.cards.some((card) => card.id === comparison.left));
    const left = group.cards.find((card) => card.id === comparison.left), right = group.cards.find((card) => card.id === comparison.right);
    const keeperId = keepers.get(group.cards[0].id);
    const labels = { name: "Name", creator: "Author", description: "Description", personality: "Personality", scenario: "Scenario", first_mes: "Opening message", mes_example: "Example messages", creator_notes: "Author notes", system_prompt: "System prompt", post_history_instructions: "After-history instructions", alternate_greetings: "Other greetings", tags: "Tags", extensions: "Extra card settings" };
    const text = (value) => Array.isArray(value) ? value.join(`

`) : typeof value === "object" && value ? JSON.stringify(value, null, 2) : value || "Empty";
    const fields = Object.keys(labels).filter((key) => !differencesOnly || JSON.stringify(left[key]) !== JSON.stringify(right[key]));
    return `<div class="lb-bot-actions"><button type="button" data-cleaner="back-compare">Back to duplicates</button><h3>Compare ${escape(group.name)}</h3><span>Keeper: ${escape(group.cards.find((card) => card.id === keeperId)?.name)}</span><label class="lb-bot-check"><input type="checkbox" data-differences-only ${differencesOnly ? "checked" : ""}> Only differences</label></div>
      <div class="lb-bot-comparison">${[left, right].map((card, index) => `<section><label>${index ? "Right copy" : "Left copy"} <select data-compare-side="${index ? "right" : "left"}" aria-label="${index ? "Right" : "Left"} comparison copy">${group.cards.map((option) => `<option value="${escape(option.id)}" ${option.id === card.id ? "selected" : ""}>${escape(option.name)} · ${escape(option.id.slice(0, 8))}</option>`).join("")}</select></label><div class="lb-bot-card-heading">${thumbnail(card)}<div><strong>${escape(card.name)}</strong><p>${escape(card.creator || "No author")} · ${card.chatCount} chats</p><span>${card.id === keeperId ? "Keeper" : "Duplicate candidate"}</span></div></div><div class="lb-bot-actions"><button type="button" data-keep-card="${escape(card.id)}" ${card.id === keeperId ? "disabled" : ""}>Keep this copy</button><button type="button" data-edit-card="${escape(card.id)}">Edit</button><button type="button" data-ignore-card="${escape(card.id)}">Ignore</button><button type="button" data-delete-card="${escape(card.id)}" data-compared ${busy || card.id === keeperId || card.chatCount || left.id === right.id ? "disabled" : ""}>Delete this copy</button></div></section>`).join("")}</div>
      ${fields.map((key) => `<section class="lb-bot-comparison-field"><h4>${escape(labels[key])}</h4><div class="lb-bot-comparison"><pre>${escape(text(left[key]))}</pre><pre>${escape(text(right[key]))}</pre></div></section>`).join("")}${fields.length ? "" : "<p>No differences in these card fields.</p>"}`;
  }
  function editorView() {
    const labels = { name: "Name", creator: "Author", folder: "Folder", description: "Description", personality: "Personality", scenario: "Scenario", first_mes: "Opening message", mes_example: "Example messages", creator_notes: "Author notes", system_prompt: "System prompt", post_history_instructions: "After-history instructions" };
    return `<section class="lb-bot-editor"><div class="lb-bot-actions"><h3>Edit ${escape(editing.name)}</h3><button type="button" data-cleaner="save-edit" ${busy ? "disabled" : ""}>Save changes</button><button type="button" data-cleaner="cancel-edit" ${busy ? "disabled" : ""}>Cancel</button></div>
      ${Object.entries(labels).map(([key, label]) => `<label>${label}${["name", "creator", "folder"].includes(key) ? `<input data-edit-field="${key}" value="${escape(draft[key])}" ${busy ? "disabled" : ""}>` : `<textarea data-edit-field="${key}" rows="${["description", "first_mes"].includes(key) ? 6 : 3}" ${busy ? "disabled" : ""}>${escape(draft[key])}</textarea>`}</label>`).join("")}
      <label>Tags (one per line)<textarea data-edit-tags rows="3" ${busy ? "disabled" : ""}>${escape(draft.tags.join(`
`))}</textarea></label>
      ${draft.alternate_greetings.map((greeting, index) => `<label>Alternate greeting ${index + 1}<textarea data-edit-greeting="${index}" rows="4" ${busy ? "disabled" : ""}>${escape(greeting)}</textarea><button type="button" data-remove-greeting="${index}" ${busy ? "disabled" : ""}>Remove greeting</button></label>`).join("")}
      <button type="button" data-cleaner="add-greeting" ${busy ? "disabled" : ""}>Add alternate greeting</button></section>`;
  }
  function archivedView() {
    const archived = cards.filter((card) => card.extensions?.[ARCHIVE_KEY] && matches(card.name));
    return `<p>Archived copies remain in “${escape(ARCHIVE_FOLDER)}”. Restore returns each card to its original folder.</p><div class="lb-bot-copy-grid">${archived.map((card) => `<article class="lb-bot-copy"><div class="lb-bot-card-heading">${thumbnail(card)}<strong>${escape(card.name)}</strong></div><button type="button" data-restore="${escape(card.id)}" ${busy ? "disabled" : ""}>Restore</button></article>`).join("")}</div>${scanned && !archived.length ? "<p>No archived copies found.</p>" : ""}`;
  }
  function render() {
    if (disposed)
      return;
    const searchFocused = host.ownerDocument.activeElement?.getAttribute("data-bot-search") !== null && host.contains(host.ownerDocument.activeElement);
    const position = host.ownerDocument.activeElement?.selectionStart;
    host.innerHTML = `<style>
      .lb-bot-comparison{display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:start}.lb-bot-comparison section{min-width:0}.lb-bot-comparison pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin:0;padding:12px;border:1px solid rgba(127,127,127,.22);border-radius:8px;max-height:400px;overflow:auto}.lb-bot-comparison-field h4{margin:18px 0 8px}.lb-bot-comparison select{width:100%;margin:8px 0}.lb-bot-comparison .lb-bot-avatar{width:64px;height:80px}.lb-bot-comparison .lb-bot-card-heading p{margin:6px 0}.lb-bot-placeholder{display:grid;place-items:center;font-size:24px}.lb-bot-editor>.lb-bot-actions{position:sticky;top:0;background:var(--lumiverse-bg,#171821);z-index:2;padding:8px 0}.lb-bot-editor label{display:block;margin:14px 0}.lb-bot-editor input,.lb-bot-editor textarea{display:block;width:100%;box-sizing:border-box;margin:6px 0;font:inherit;color:inherit;background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.25);border-radius:7px;padding:10px}.lb-bot-editor textarea{resize:vertical}@media(max-width:600px){.lb-bot-comparison{gap:8px}.lb-bot-comparison .lb-bot-avatar{width:54px;height:68px}.lb-bot-comparison .lb-bot-card-heading{flex-wrap:wrap}}.lb-bot-actions,.lb-bot-check,.lb-bot-card-heading{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.lb-bot-actions{margin:12px 0}.lb-bot-check input{flex:0 0 auto}.lb-bot-avatar{width:54px;height:68px;object-fit:cover;border-radius:8px;background:#292b37}.lb-bot-card-heading{flex-wrap:nowrap}.lb-bot-card-heading small{display:block;opacity:.7}.lb-bot-copy-grid,.lb-bot-folder-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr));gap:12px}.lb-bot-folder-grid{max-height:44dvh;overflow:auto}.lb-bot-copy,.lb-bot-folder,.lb-bot-group,.lb-bot-plan{padding:14px;border:1px solid rgba(127,127,127,.24);border-radius:10px;min-width:0;margin:12px 0}.lb-bot-group header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.lb-bot-group h3{margin:0}.lb-bot-group select{max-width:100%}.lb-bot-copy details{margin:10px 0}.lb-bot-copy summary{cursor:pointer}.lb-bot-difference{display:grid;grid-template-columns:1fr 1fr;gap:8px;border-top:1px solid rgba(127,127,127,.2);margin-top:12px;padding-top:10px}.lb-bot-difference>strong{grid-column:1/-1}.lb-bot-difference p{max-height:160px;overflow:auto;white-space:pre-wrap;font-size:12px;overflow-wrap:anywhere}.lb-bot-folder input[type=text]{width:100%;margin-top:10px}.lb-bot-folder p{font-size:12px;opacity:.75}.lb-bot-table-wrap{max-height:340px;overflow:auto}.lb-bot-plan table{width:100%;border-collapse:collapse}.lb-bot-plan td,.lb-bot-plan th{text-align:left;padding:8px;border-bottom:1px solid rgba(127,127,127,.2)}#lb-character-cleaner button,#lb-character-cleaner input,#lb-character-cleaner select{font:inherit;color:inherit;background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.25);border-radius:7px;padding:8px}#lb-character-cleaner input[type=checkbox]{padding:0}#lb-character-cleaner button{cursor:pointer}#lb-character-cleaner button:disabled{opacity:.45;cursor:default}#lb-character-cleaner [aria-selected=true]{background:rgba(124,155,200,.24)}#lb-character-cleaner input[type=search]{flex:1;min-width:160px}#lb-character-cleaner{overflow-wrap:anywhere}#lb-character-cleaner select option{background:#20212b}
      </style><div class="lb-bot-actions"><div role="tablist" aria-label="Character tools">${[["duplicates", `Duplicates (${groups.length})`], ["folders", "Folders"], ["ignored", "Ignored"], ...cards.some((card) => card.extensions?.[ARCHIVE_KEY]) ? [["archived", "Previously archived"]] : []].map(([key, label]) => `<button type="button" role="tab" data-bot-view="${key}" ${editing || pendingDelete ? "disabled" : ""} aria-selected="${view === key}">${label}</button>`).join("")}</div>
      <button type="button" data-cleaner="scan" ${busy || editing || pendingDelete ? "disabled" : ""}>${scanned ? "Rescan characters" : "Scan characters"}</button><input type="search" data-bot-search aria-label="Search character groups" ${editing || comparison || pendingDelete ? "hidden" : ""} placeholder="Search ${view === "folders" ? "authors or tags" : "characters"}" value="${escape(query)}"></div>
      <p role="status" aria-live="polite">${escape(status)}</p>${pendingDelete ? deletionView() : editing ? editorView() : comparison ? comparisonView() : view === "folders" ? foldersView() : view === "duplicates" ? duplicatesView() : view === "ignored" ? ignoredView() : archivedView()}`;
    if (searchFocused) {
      const input = host.querySelector("[data-bot-search]");
      input.focus();
      if (position !== null)
        input.setSelectionRange(position, position);
    }
  }
  async function run(action) {
    if (busy)
      return;
    busy = true;
    render();
    try {
      await action();
    } catch (error) {
      status = error.message || "Library update failed.";
    } finally {
      busy = false;
      render();
    }
  }
  function prepareDelete(id) {
    const group = groups.find((group) => group.cards.some((card) => card.id === id));
    const candidate = group.cards.find((card) => card.id === id), keeper = group.cards.find((card) => card.id === keepers.get(group.cards[0].id));
    if (candidate.id === keeper.id || candidate.chatCount) {
      status = "The keeper and chat-linked cards cannot be deleted.";
      render();
      return;
    }
    pendingDelete = { id, keeperId: keeper.id, expected: characterFingerprint(candidate), keeperExpected: characterFingerprint(keeper), from: candidate.folder || "", keeperFrom: keeper.folder || "", name: candidate.name, keeperName: keeper.name };
    render();
    host.querySelector('[data-cleaner="cancel-delete"]')?.focus();
  }
  function deletionView() {
    const item = pendingDelete;
    return `<section class="lb-bot-plan" role="region" aria-label="Confirm deletion"><h3>Delete ${escape(item.name)}?</h3><p>Keep: <strong>${escape(item.keeperName)}</strong> (${escape(item.keeperId.slice(0, 8))})</p><p>Delete: <strong>${escape(item.name)}</strong> (${escape(item.id.slice(0, 8))})</p>${item.expected !== item.keeperExpected ? "<p>These versions have different content. You can return to the comparison before deciding.</p>" : ""}<p>This permanently deletes this card and may remove assets owned only by it. There is no undo. Chat-linked cards are checked again and protected.</p><div class="lb-bot-actions"><button type="button" data-cleaner="confirm-delete" ${busy ? "disabled" : ""}>Yes, delete</button><button type="button" data-cleaner="cancel-delete" ${busy ? "disabled" : ""}>No, keep it</button></div></section>`;
  }
  async function deleteCopies() {
    if (!pendingDelete)
      return;
    const plan = [pendingDelete];
    status = "Checking the card, keeper and chat links…";
    render();
    const check = async (item) => {
      const [candidate, keeper, chats] = await Promise.all([api(path(item.id)), api(path(item.keeperId)), pagedCharacters(api, "/api/v1/chats")]);
      if (disposed)
        throw new Error("Library closed. Remaining cards were not deleted.");
      assertDeleteCopy(candidate, keeper, chats, item);
    };
    let count = 0;
    try {
      for (const item of plan)
        await check(item);
      for (const item of plan) {
        await check(item);
        const result = await api(path(item.id), { method: "DELETE" });
        if (!result?.success)
          throw new Error("Deletion was not confirmed by Lumiverse.");
        count++;
      }
      status = `Deleted ${count} duplicate cards.`;
    } catch (error) {
      status = `Deleted ${count} cards; stopped: ${error.message}`;
    }
    await scan();
  }
  async function ignoreCards(ids, ignored = true) {
    let count = 0;
    try {
      for (const id of ids) {
        const card = await api(path(id)), extensions = { ...card.extensions };
        if (disposed)
          throw new Error("Library closed.");
        if (ignored)
          extensions[IGNORE_KEY] = true;
        else
          delete extensions[IGNORE_KEY];
        await api(path(id), { method: "PUT", body: JSON.stringify({ extensions }) });
        count++;
      }
      status = ignored ? `Ignored ${count} cards. They remain usable and in their current folders.` : `Included ${count} cards in duplicate scans again.`;
    } catch (error) {
      status = `Updated ${count} cards; stopped: ${error.message}`;
    }
    await scan();
  }
  async function editCard(id) {
    editing = await api(path(id));
    draft = {};
    for (const key of ["name", "creator", "folder", "description", "personality", "scenario", "first_mes", "mes_example", "creator_notes", "system_prompt", "post_history_instructions"])
      draft[key] = editing[key] || "";
    draft.tags = [...editing.tags || []];
    draft.alternate_greetings = [...editing.alternate_greetings || []];
    status = "Edit the fields you need, then save changes.";
  }
  async function saveEdit() {
    const current = await api(path(editing.id)), patch = characterEditPatch(editing, current, draft);
    if (disposed)
      throw new Error("Library closed. Changes were not saved.");
    if (Object.keys(patch).length)
      await api(path(editing.id), { method: "PUT", body: JSON.stringify(patch) });
    editing = null;
    await scan();
    status = "Character changes saved.";
  }
  async function applyFolders() {
    const plan = preview;
    if (!plan?.length)
      return;
    let count = 0;
    try {
      for (const move of plan) {
        const card = await api(path(move.id));
        assertFolderMove(card, move);
        if (disposed)
          throw new Error("Library closed. Remaining bots were not moved.");
        await api(path(move.id), { method: "PUT", body: JSON.stringify({ folder: move.folder }) });
        count++;
      }
      status = `Moved ${count} bots into folders.`;
    } catch (error) {
      status = `Moved ${count} bots; stopped: ${error.message}`;
    }
    await scan();
  }
  function click(event) {
    const button = event.target.closest("button");
    if (!button || busy)
      return;
    if (button.dataset.botView === "folders" && !preferencesLoaded) {
      view = "folders";
      comparison = null;
      query = "";
      run(loadPreferences);
      return;
    }
    if (button.dataset.botView) {
      view = button.dataset.botView;
      comparison = null;
      editing = null;
      query = "";
      page = 0;
      if (scanned)
        status = `${cards.length} characters · ${groups.length} duplicate-name groups.`;
      render();
      return;
    }
    switch (button.dataset.cleaner) {
      case "scan":
        run(async () => {
          status = "Scanning characters…";
          render();
          await scan();
          status = `${cards.length} characters · ${groups.length} duplicate-name groups.`;
        });
        break;
      case "confirm-delete":
        run(deleteCopies);
        break;
      case "cancel-delete":
        pendingDelete = null;
        render();
        break;
      case "back-compare":
        comparison = null;
        render();
        break;
      case "cancel-edit":
        editing = null;
        render();
        break;
      case "save-edit":
        run(saveEdit);
        break;
      case "add-greeting":
        draft.alternate_greetings.push("");
        render();
        break;
      case "previous":
        page--;
        render();
        break;
      case "next":
        page++;
        render();
        break;
      case "select-folders":
        folderGroups().filter((group) => matches(group.label) && group.cards.some((card) => !onlyUnfiled || !String(card.folder || "").trim())).forEach((group) => chosenFolders.set(group.key, chosenFolders.get(group.key) ?? group.folder));
        preview = null;
        render();
        break;
      case "clear-folders":
        chosenFolders.clear();
        preview = null;
        render();
        break;
      case "preview-folders":
        try {
          preview = characterFolderPlan(folderGroups(), chosenFolders, onlyUnfiled);
          status = `${preview.length} folder moves ready to review.`;
        } catch (error) {
          status = error.message;
        }
        ;
        render();
        break;
      case "back-folders":
        preview = null;
        render();
        break;
      case "apply-folders":
        run(applyFolders);
        break;
    }
    if (button.dataset.folderPick) {
      const key = button.dataset.folderPick;
      chosenFolders.has(key) ? chosenFolders.delete(key) : chosenFolders.set(key, Array.from(host.querySelectorAll("[data-folder-name]")).find((input) => input.dataset.folderName === key).value);
      preview = null;
      render();
    }
    if (button.dataset.folderExclude)
      run(() => excludeFolder(button.dataset.folderExclude));
    if (button.dataset.folderRestore)
      run(() => excludeFolder(button.dataset.folderRestore, false));
    if (button.dataset.compare) {
      const group = groups.find((group) => group.cards.some((card) => card.id === button.dataset.compare));
      comparison = { left: keepers.get(group.cards[0].id), right: button.dataset.compare };
      render();
    }
    if (button.dataset.keepCard) {
      const group = groups.find((group) => group.cards.some((card) => card.id === button.dataset.keepCard));
      keepers.set(group.cards[0].id, button.dataset.keepCard);
      render();
    }
    if (button.dataset.deleteCard)
      prepareDelete(button.dataset.deleteCard);
    if (button.dataset.ignoreCard)
      run(() => ignoreCards([button.dataset.ignoreCard]));
    if (button.dataset.ignoreGroup) {
      const group = groups.find((group) => group.cards[0].id === button.dataset.ignoreGroup);
      run(() => ignoreCards(group.cards.map((card) => card.id)));
    }
    if (button.dataset.unignore)
      run(() => ignoreCards([button.dataset.unignore], false));
    if (button.dataset.editCard)
      run(() => editCard(button.dataset.editCard));
    if (button.dataset.removeGreeting !== undefined) {
      draft.alternate_greetings.splice(Number(button.dataset.removeGreeting), 1);
      render();
    }
    if (button.dataset.restore)
      run(async () => {
        const card = await api(path(button.dataset.restore)), record = card.extensions?.[ARCHIVE_KEY];
        if (!record || card.folder !== ARCHIVE_FOLDER)
          throw new Error("This card was moved or restored elsewhere. Rescan characters.");
        const extensions = { ...card.extensions };
        delete extensions[ARCHIVE_KEY];
        await api(path(card.id), { method: "PUT", body: JSON.stringify({ folder: record.originalFolder || "", extensions }) });
        await scan();
        status = `Restored ${card.name}.`;
      });
  }
  function change(event) {
    if (busy)
      return;
    const target = event.target;
    if (target.hasAttribute("data-differences-only"))
      differencesOnly = target.checked;
    if (target.dataset.compareSide && comparison)
      comparison[target.dataset.compareSide] = target.value;
    if (target.dataset.keeper) {
      keepers.set(target.dataset.keeper, target.value);
    }
    if (target.hasAttribute("data-folder-mode")) {
      mode = target.value;
      chosenFolders.clear();
      preview = null;
      query = "";
    }
    if (target.hasAttribute("data-unfiled")) {
      onlyUnfiled = target.checked;
      preview = null;
    }
    render();
  }
  function input(event) {
    const target = event.target;
    if (target.dataset.editField)
      draft[target.dataset.editField] = target.value;
    if (target.hasAttribute("data-edit-tags"))
      draft.tags = [...new Set(target.value.split(`
`).map((tag) => tag.trim()).filter(Boolean))];
    if (target.dataset.editGreeting !== undefined)
      draft.alternate_greetings[Number(target.dataset.editGreeting)] = target.value;
    if (target.hasAttribute("data-bot-search")) {
      query = target.value;
      page = 0;
      render();
    }
    if (target.dataset.folderName) {
      if (chosenFolders.has(target.dataset.folderName))
        chosenFolders.set(target.dataset.folderName, target.value);
      preview = null;
      host.querySelector(".lb-bot-plan")?.remove();
    }
  }
  host.addEventListener("click", click);
  host.addEventListener("change", change);
  host.addEventListener("input", input);
  render();
  return () => {
    disposed = true;
    host.removeEventListener("click", click);
    host.removeEventListener("change", change);
    host.removeEventListener("input", input);
  };
}

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
var IGNORED_FOLDER = "Bionic — Ignored";
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
function duplicateNameKey(value) {
  let name = String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase().replace(/[\s_-]+/g, " ");
  let previous = "";
  while (name !== previous) {
    previous = name;
    name = name.replace(/\s+(?:\(\d+\)|copy(?:\s+\d+)?|duplicate(?:\s+\d+)?)$/i, "").trim();
  }
  return name;
}
function bookSignature(book, entries) {
  const name = duplicateNameKey(book?.name);
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
function installLorebookOrganizer(ctx, settingsRoot) {
  const pending = new Map;
  let modal = null;
  let modalRoot = null;
  let activeTab = "characters";
  let characterPanel = null;
  let characterCleanup = null;
  let books = [];
  let groups = [];
  let unlinked = [];
  let ignored = [];
  let referenceSnapshot = null;
  const selectedUnlinked = new Set;
  const selectedOverview = new Set;
  let overviewFolderPanelOpen = false;
  let overviewFolderTargetName = "";
  let showIgnored = false;
  let linkPanelOpen = false;
  let folderPanelOpen = false;
  let folderTargetName = "";
  let linkTargetKind = "character";
  let linkTargetId = "";
  let linkTargetSearch = "";
  let inlineLinkBookId = "";
  let lastScanAt = null;
  let busy = false;
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
        resultType: `${type}_result`,
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
    if (payload?.type !== request.resultType) {
      return true;
    }
    pending.delete(id);
    clearTimeout(request.timer);
    if (payload?.error) {
      request.reject(new Error(String(payload.error)));
    } else {
      request.resolve(payload);
    }
    return true;
  }
  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      headers: {
        ...options.body ? {
          "Content-Type": "application/json"
        } : {},
        ...options.headers || {}
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
    const validOverviewSelection = new Set(books.map((book) => book.id));
    for (const id of selectedOverview) {
      if (!validOverviewSelection.has(id)) {
        selectedOverview.delete(id);
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
    const characterUrl = `/api/v1/characters/${encodeURIComponent(character.id)}`;
    const freshCharacter = await api(characterUrl);
    const extensions = freshCharacter?.extensions && typeof freshCharacter.extensions === "object" && !Array.isArray(freshCharacter.extensions) ? {
      ...freshCharacter.extensions
    } : {};
    const freshIds = Array.isArray(freshCharacter?.world_book_ids) ? freshCharacter.world_book_ids.filter((id) => typeof id === "string" && Boolean(id)) : Array.isArray(extensions.world_book_ids) ? extensions.world_book_ids.filter((id) => typeof id === "string" && Boolean(id)) : typeof extensions.world_book_id === "string" && extensions.world_book_id ? [
      extensions.world_book_id
    ] : [];
    const concurrentIds = freshIds.filter((id) => !current.includes(id));
    const writeIds = Array.from(new Set([
      ...next,
      ...concurrentIds
    ]));
    delete extensions.world_book_id;
    extensions.world_book_ids = writeIds;
    await api(characterUrl, {
      method: "PUT",
      body: JSON.stringify({
        extensions
      })
    });
    const verified = await api(characterUrl);
    const ids = Array.isArray(verified?.world_book_ids) ? verified.world_book_ids : Array.isArray(verified?.extensions?.world_book_ids) ? verified.extensions.world_book_ids : [];
    if (writeIds.some((id) => !ids.includes(id))) {
      throw new Error(`Character ${character.name || character.id} did not verify after relinking.`);
    }
    character.world_book_ids = [...writeIds];
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

Lumi Toolkit will refresh all four reference sources first.`)) {
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
      busy = false;
      renderAll(`Applied ${assignments.length} folder assignment${assignments.length === 1 ? "" : "s"}.`);
      return true;
    } catch (error) {
      busy = false;
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

      /* Organizer segmented tabs */
      .lb-organizer-shell [data-organizer-tab] {
        appearance: none;
        -webkit-appearance: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 36px;
        padding: 8px 13px !important;
        margin: 0;
        border:
          1px solid
          rgba(255,255,255,.17) !important;
        border-radius: 9px !important;
        background:
          rgba(255,255,255,.045) !important;
        color: inherit !important;
        font: inherit;
        font-weight: 650;
        line-height: 1.1;
        text-decoration: none !important;
        cursor: pointer;
        transition:
          background 120ms ease,
          border-color 120ms ease,
          transform 80ms ease;
      }

      .lb-organizer-shell
      [data-organizer-tab]:hover {
        background:
          rgba(255,255,255,.10) !important;
        border-color:
          rgba(255,255,255,.30) !important;
        text-decoration: none !important;
      }

      .lb-organizer-shell
      [data-organizer-tab]:active {
        transform: translateY(1px);
      }

      .lb-organizer-shell
      [data-organizer-tab][aria-selected="true"] {
        background:
          rgba(255,255,255,.18) !important;
        border-color:
          rgba(255,255,255,.42) !important;
        box-shadow:
          inset 0 0 0 1px
          rgba(255,255,255,.06);
        text-decoration: none !important;
      }

      .lb-organizer-shell
      [data-organizer-tab]:focus-visible {
        outline:
          2px solid currentColor;
        outline-offset: 2px;
      }

      .lb-organizer-shell [hidden] { display: none !important; }
      .lb-organizer-shell {
        width: min(1050px, calc(100vw - 64px));
        max-width: 100%;
        height: min(76dvh, 800px);
        min-height: 0;
        display: flex;
        flex-direction: column;
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
        font-size: .95rem;
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

      .lb-organizer-shell input:not([type="checkbox"]),
      .lb-organizer-shell select {
        min-height: 38px;
        padding: 8px 10px;
        border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
        border-radius: 9px;
        background: var(--lumiverse-bg, #101019);
        color: inherit;
        font: inherit;
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
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding-right: 4px;
        scrollbar-width: thin;
        scrollbar-color: color-mix(in srgb, currentColor 35%, transparent) transparent;
        scrollbar-gutter: stable;
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


      .lb-organizer-field {
        display: grid;
        gap: 5px;
        min-width: 0;
        font-size: .82rem;
      }




      .lb-organizer-checks {
        display: grid;
        gap: 5px;
      }


      .lb-organizer-buttonlike,
      .lb-organizer-actions button,
      .lb-organizer-toolbar button,
      .lb-organizer-card button,
      .lb-organizer-list button {
        appearance: none;
        -webkit-appearance: none;
        border: 1px solid rgba(255, 255, 255, 0.18);
        background: rgba(255, 255, 255, 0.06);
        color: inherit;
        border-radius: 10px;
        padding: 8px 12px;
        min-height: 34px;
        line-height: 1.2;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
        transition:
          background 120ms ease,
          border-color 120ms ease,
          transform 80ms ease,
          box-shadow 120ms ease;
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.02);
      }

      .lb-organizer-buttonlike:hover,
      .lb-organizer-actions button:hover,
      .lb-organizer-toolbar button:hover,
      .lb-organizer-card button:hover,
      .lb-organizer-list button:hover {
        background: rgba(255, 255, 255, 0.11);
        border-color: rgba(255, 255, 255, 0.28);
      }

      .lb-organizer-buttonlike:active,
      .lb-organizer-actions button:active,
      .lb-organizer-toolbar button:active,
      .lb-organizer-card button:active,
      .lb-organizer-list button:active {
        transform: translateY(1px);
        background: rgba(255, 255, 255, 0.14);
      }

      .lb-organizer-buttonlike:focus-visible,
      .lb-organizer-actions button:focus-visible,
      .lb-organizer-toolbar button:focus-visible,
      .lb-organizer-card button:focus-visible,
      .lb-organizer-list button:focus-visible {
        outline: none;
        border-color: rgba(120, 170, 255, 0.75);
        box-shadow:
          0 0 0 2px rgba(120, 170, 255, 0.20),
          inset 0 0 0 1px rgba(255,255,255,0.02);
      }

      .lb-organizer-buttonlike[disabled],
      .lb-organizer-actions button[disabled],
      .lb-organizer-toolbar button[disabled],
      .lb-organizer-card button[disabled],
      .lb-organizer-list button[disabled] {
        opacity: 0.5;
        cursor: not-allowed;
        background: rgba(255, 255, 255, 0.03);
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
          width: calc(100vw - 48px);
          height: 72dvh;
        }

        .lb-organizer-hero {
          align-items: flex-start;
          flex-wrap: wrap;
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
  function referenceLocationText(book) {
    if (!book.references.length) {
      return `
        <strong>Unlinked</strong>
        — no character, chat, persona or global reference
      `;
    }
    const kindLabel = (kind) => {
      if (kind === "character") {
        return "Character";
      }
      if (kind === "chat") {
        return "Chat";
      }
      if (kind === "persona") {
        return "Persona";
      }
      if (kind === "global") {
        return "Global";
      }
      return kind;
    };
    return `
      <strong>Linked to:</strong>
      ${book.references.map((ref) => `${escapeHtml(kindLabel(ref.kind))} — ${escapeHtml(ref.name)}`).join(" · ")}
    `;
  }
  function bookCard(book, actions = "") {
    const overviewLinkable = activeTab === "overview" && isUnlinked(book);
    const overviewLinkAction = overviewLinkable ? `
          <button
            type="button"
            data-organizer-open-link-one="${escapeHtml(book.id)}"
            ${busy ? "disabled" : ""}
          >
            Link…
          </button>
        ` : "";
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

        ${actions || overviewLinkAction ? `
              <div class="lb-organizer-actions">
                ${actions}
                ${overviewLinkAction}
              </div>
            ` : ""}

        ${overviewLinkable && linkPanelOpen && inlineLinkBookId === book.id ? renderInlineLinkControls() : ""}
      </div>
    `;
  }
  function selectedOverviewBooks() {
    return books.filter((book) => selectedOverview.has(book.id));
  }
  async function moveSelectedOverviewToFolder() {
    if (busy)
      return;
    const selected = selectedOverviewBooks();
    if (!selected.length) {
      return;
    }
    const folder = overviewFolderTargetName.trim();
    if (!folder) {
      renderAll("Enter a folder name first.");
      return;
    }
    const applied = await applyAssignments(selected.map((book) => ({
      bookId: book.id,
      folder
    })));
    if (!applied) {
      return;
    }
    selectedOverview.clear();
    overviewFolderPanelOpen = false;
    overviewFolderTargetName = "";
    renderAll(`Moved ${selected.length} lorebook${selected.length === 1 ? "" : "s"} to "${folder}".`);
  }
  function renderOverview() {
    const visible = filteredBooks();
    const selected = selectedOverviewBooks();
    const folders = existingFolderNames();
    const allVisibleSelected = visible.length > 0 && visible.every((book) => selectedOverview.has(book.id));
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

      <div
        class="lb-organizer-card"
        style="margin-bottom:10px"
      >
        <div class="lb-organizer-card-head">
          <div>
            <div class="lb-organizer-card-title">
              Library selection
            </div>

            <div class="lb-organizer-meta">
              ${selected.length} selected ·
              foldering does not change character, chat,
              persona or global links
            </div>
          </div>
        </div>

        <div class="lb-organizer-actions">
          <button
            type="button"
            data-organizer-overview-select-visible
            ${visible.length ? "" : "disabled"}
          >
            ${allVisibleSelected ? "Unselect visible" : "Select visible"}
          </button>

          <button
            type="button"
            data-organizer-overview-clear
            ${selected.length ? "" : "disabled"}
          >
            Clear selection
          </button>

          <button
            type="button"
            data-organizer-overview-open-folder
            ${selected.length ? "" : "disabled"}
          >
            Move selected to folder…
          </button>
        </div>
      </div>

      ${overviewFolderPanelOpen ? `
            <div
              class="lb-organizer-card"
              style="margin-bottom:10px"
            >
              <div class="lb-organizer-card-title">
                Move ${selected.length} selected lorebook${selected.length === 1 ? "" : "s"} to folder
              </div>

              <div class="lb-organizer-meta">
                Choose an existing folder or type a new
                name to create/use it immediately.
              </div>

              <div class="lb-organizer-toolbar">
                <input
                  id="lb-organizer-overview-folder-target"
                  type="text"
                  list="lb-organizer-overview-folder-options"
                  value="${escapeHtml(overviewFolderTargetName)}"
                  placeholder="Existing or new folder name…"
                  autocomplete="off"
                  ${busy ? "disabled" : ""}
                >

                <datalist
                  id="lb-organizer-overview-folder-options"
                >
                  ${folders.map((folder) => `<option value="${escapeHtml(folder)}"></option>`).join("")}
                </datalist>

                <button
                  type="button"
                  data-organizer-overview-folder-apply
                  ${busy ? "disabled" : ""}
                >
                  Move selected
                </button>

                <button
                  type="button"
                  data-organizer-overview-folder-cancel
                >
                  Cancel
                </button>
              </div>
            </div>
          ` : ""}

      <div class="lb-organizer-list">
        ${visible.length ? visible.map((book) => bookCard(book, `
                      <label class="lb-organizer-check">
                        <input
                          type="checkbox"
                          data-organizer-select-overview="${escapeHtml(book.id)}"
                          ${selectedOverview.has(book.id) ? "checked" : ""}
                          ${busy ? "disabled" : ""}
                        >
                        <span>Select</span>
                      </label>
                    `)).join("") : `
              <div class="lb-organizer-empty">
                ${books.length ? "No lorebooks match this search." : "Scan the library to begin."}
              </div>
            `}
      </div>
    `;
  }
  function similarNameGroups() {
    const byName = new Map;
    for (const book of books) {
      const key = characterMatchKey(book.name);
      if (!key || key.length < 2) {
        continue;
      }
      const current = byName.get(key) || [];
      current.push(book);
      byName.set(key, current);
    }
    const result = [];
    for (const [key, groupedBooks] of byName.entries()) {
      if (groupedBooks.length < 2) {
        continue;
      }
      const sortedBooks = [...groupedBooks].sort((a, b) => a.name.localeCompare(b.name));
      const linkedCount = sortedBooks.filter((book) => !isUnlinked(book)).length;
      const unlinkedCount = sortedBooks.length - linkedCount;
      const representative = [...sortedBooks].sort((a, b) => {
        const lengthDifference = String(a.name || "").length - String(b.name || "").length;
        if (lengthDifference) {
          return lengthDifference;
        }
        return a.name.localeCompare(b.name);
      })[0];
      result.push({
        key,
        name: representative?.name || key,
        books: sortedBooks,
        linkedCount,
        unlinkedCount,
        mixed: linkedCount > 0 && unlinkedCount > 0
      });
    }
    result.sort((a, b) => {
      if (a.mixed !== b.mixed) {
        return a.mixed ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    return result;
  }
  async function replaceSimilarReferences(keeperId) {
    if (busy)
      return;
    let group = similarNameGroups().find((item) => item.books.some((book) => book.id === keeperId));
    if (!group) {
      renderAll("That similar-name group no longer exists. Rescan and try again.");
      return;
    }
    const keeper = group.books.find((book) => book.id === keeperId);
    if (!keeper)
      return;
    const oldBooks = group.books.filter((book) => book.id !== keeperId);
    const affectedRefs = oldBooks.flatMap((book) => book.references);
    if (!affectedRefs.length) {
      renderAll("The other similar-name lorebooks have no references to replace.");
      return;
    }
    const affectedCharacterIds = new Set(affectedRefs.filter((ref) => ref.kind === "character").map((ref) => ref.id).filter(Boolean));
    const affectedChatIds = new Set(affectedRefs.filter((ref) => ref.kind === "chat").map((ref) => ref.id).filter(Boolean));
    const affectedPersonaIds = new Set(affectedRefs.filter((ref) => ref.kind === "persona").map((ref) => ref.id).filter(Boolean));
    const affectsGlobal = affectedRefs.some((ref) => ref.kind === "global");
    const summary = [
      affectedCharacterIds.size ? `${affectedCharacterIds.size} character${affectedCharacterIds.size === 1 ? "" : "s"}` : "",
      affectedChatIds.size ? `${affectedChatIds.size} chat${affectedChatIds.size === 1 ? "" : "s"}` : "",
      affectedPersonaIds.size ? `${affectedPersonaIds.size} persona${affectedPersonaIds.size === 1 ? "" : "s"}` : "",
      affectsGlobal ? "global activation" : ""
    ].filter(Boolean).join(", ");
    if (!window.confirm(`Use "${keeper.name}" as the replacement for the other similarly named lorebooks?

References to the other copies will be moved to this one: ${summary}.

Unrelated lorebooks will be preserved. The old lorebook files will NOT be deleted automatically.`)) {
      return;
    }
    busy = true;
    renderAll(`Refreshing references before replacing with "${keeper.name}"…`);
    let resultMessage = "";
    try {
      const snapshot = await freshReferences();
      group = similarNameGroups().find((item) => item.books.some((book) => book.id === keeperId));
      if (!group) {
        throw new Error("The similar-name group changed during verification.");
      }
      const groupIds = new Set(group.books.map((book) => book.id));
      const oldIds = new Set(group.books.filter((book) => book.id !== keeperId).map((book) => book.id));
      for (const characterId of affectedCharacterIds) {
        const characterUrl = `/api/v1/characters/${encodeURIComponent(characterId)}`;
        const freshCharacter = await api(characterUrl);
        const extensions = freshCharacter?.extensions && typeof freshCharacter.extensions === "object" && !Array.isArray(freshCharacter.extensions) ? {
          ...freshCharacter.extensions
        } : {};
        const currentIds = Array.isArray(freshCharacter?.world_book_ids) ? freshCharacter.world_book_ids.filter((id) => typeof id === "string" && Boolean(id)) : Array.isArray(extensions.world_book_ids) ? extensions.world_book_ids.filter((id) => typeof id === "string" && Boolean(id)) : typeof extensions.world_book_id === "string" && extensions.world_book_id ? [
          extensions.world_book_id
        ] : [];
        const nextIds = Array.from(new Set([
          ...currentIds.filter((id) => !groupIds.has(id)),
          keeperId
        ]));
        delete extensions.world_book_id;
        extensions.world_book_ids = nextIds;
        await api(characterUrl, {
          method: "PUT",
          body: JSON.stringify({
            extensions
          })
        });
      }
      for (const chatId of affectedChatIds) {
        const freshChat = await api(`/api/v1/chats/${encodeURIComponent(chatId)}?messages=false`);
        const currentIds = Array.isArray(freshChat?.metadata?.chat_world_book_ids) ? freshChat.metadata.chat_world_book_ids.filter((id) => typeof id === "string" && Boolean(id)) : [];
        const nextIds = Array.from(new Set([
          ...currentIds.filter((id) => !groupIds.has(id)),
          keeperId
        ]));
        await api(`/api/v1/chats/${encodeURIComponent(chatId)}/metadata`, {
          method: "PATCH",
          body: JSON.stringify({
            chat_world_book_ids: nextIds
          })
        });
      }
      if (affectedPersonaIds.size) {
        await api("/api/v1/personas/bulk-update", {
          method: "POST",
          body: JSON.stringify({
            ids: Array.from(affectedPersonaIds),
            attached_world_book_id: keeperId
          })
        });
      }
      if (affectsGlobal) {
        const currentGlobalIds = Array.isArray(snapshot?.globalIds) ? snapshot.globalIds : [];
        const nextGlobalIds = Array.from(new Set([
          ...currentGlobalIds.filter((id) => !oldIds.has(id)),
          keeperId
        ]));
        await sendBackend("bionic_lore_set_global", {
          ids: nextGlobalIds
        });
      }
      await freshReferences();
      const remainingReferencedOldBooks = books.filter((book) => oldIds.has(book.id) && book.references.length > 0);
      if (remainingReferencedOldBooks.length) {
        throw new Error(`${remainingReferencedOldBooks.length} old similar-name lorebook${remainingReferencedOldBooks.length === 1 ? "" : "s"} still have references after replacement.`);
      }
      resultMessage = `Replaced references with "${keeper.name}". The old copies are now left in the library for review/deletion.`;
    } catch (error) {
      resultMessage = `Replacement stopped: ${error?.message || String(error)}`;
    } finally {
      busy = false;
      renderAll(resultMessage);
      syncSummary();
    }
  }
  async function unifySimilarCharacters(keeperId) {
    if (busy)
      return;
    let group = similarNameGroups().find((item) => item.books.some((book) => book.id === keeperId));
    if (!group) {
      renderAll("That similar-name group no longer exists. Rescan and try again.");
      return;
    }
    const keeper = group.books.find((book) => book.id === keeperId);
    if (!keeper)
      return;
    const initialCharacterIds = new Set(group.books.flatMap((book) => book.references.filter((ref) => ref.kind === "character").map((ref) => ref.id).filter(Boolean)));
    if (!initialCharacterIds.size) {
      renderAll("No character links were found in this similar-name group.");
      return;
    }
    if (!window.confirm(`Use "${keeper.name}" for all ${initialCharacterIds.size} character${initialCharacterIds.size === 1 ? "" : "s"} in this similar-name group?

Lumi Toolkit will refresh references first, remove the other lorebooks in this similar-name group from those characters, and attach this copy instead.

Chats, personas, global activation, unrelated lorebooks, and the other lorebook files themselves will not be changed.`)) {
      return;
    }
    busy = true;
    renderAll(`Refreshing references before consolidating characters onto "${keeper.name}"…`);
    let resultMessage = "";
    try {
      await freshReferences();
      group = similarNameGroups().find((item) => item.books.some((book) => book.id === keeperId));
      if (!group) {
        throw new Error("The similar-name group changed during verification.");
      }
      const refreshedKeeper = group.books.find((book) => book.id === keeperId);
      if (!refreshedKeeper) {
        throw new Error("The selected lorebook no longer exists.");
      }
      const groupIds = new Set(group.books.map((book) => book.id));
      const characterIds = Array.from(new Set(group.books.flatMap((book) => book.references.filter((ref) => ref.kind === "character").map((ref) => ref.id).filter(Boolean))));
      if (!characterIds.length) {
        throw new Error("No character references remain in this group.");
      }
      let updated = 0;
      for (const characterId of characterIds) {
        const characterUrl = `/api/v1/characters/${encodeURIComponent(characterId)}`;
        const freshCharacter = await api(characterUrl);
        const extensions = freshCharacter?.extensions && typeof freshCharacter.extensions === "object" && !Array.isArray(freshCharacter.extensions) ? {
          ...freshCharacter.extensions
        } : {};
        const currentIds = Array.isArray(freshCharacter?.world_book_ids) ? freshCharacter.world_book_ids.filter((id) => typeof id === "string" && Boolean(id)) : Array.isArray(extensions.world_book_ids) ? extensions.world_book_ids.filter((id) => typeof id === "string" && Boolean(id)) : typeof extensions.world_book_id === "string" && extensions.world_book_id ? [
          extensions.world_book_id
        ] : [];
        const nextIds = Array.from(new Set([
          ...currentIds.filter((id) => !groupIds.has(id)),
          keeperId
        ]));
        delete extensions.world_book_id;
        extensions.world_book_ids = nextIds;
        await api(characterUrl, {
          method: "PUT",
          body: JSON.stringify({
            extensions
          })
        });
        const verified = await api(characterUrl);
        const verifiedIds = Array.isArray(verified?.world_book_ids) ? verified.world_book_ids : Array.isArray(verified?.extensions?.world_book_ids) ? verified.extensions.world_book_ids : [];
        if (!verifiedIds.includes(keeperId)) {
          throw new Error(`Character link verification failed for ${characterId}.`);
        }
        const redundantIds = Array.from(groupIds).filter((id) => id !== keeperId);
        if (redundantIds.some((id) => verifiedIds.includes(id))) {
          throw new Error(`Character ${characterId} still contains another lorebook from this similar-name group.`);
        }
        updated += 1;
        renderAll(`Linked ${updated}/${characterIds.length} character${characterIds.length === 1 ? "" : "s"} to "${refreshedKeeper.name}"…`);
      }
      await freshReferences();
      resultMessage = `Linked ${characterIds.length} character${characterIds.length === 1 ? "" : "s"} to "${refreshedKeeper.name}". Other similar lorebooks were not deleted; chat, persona and global links were left unchanged.`;
    } catch (error) {
      resultMessage = `Character consolidation stopped: ${error?.message || String(error)}`;
    } finally {
      busy = false;
      renderAll(resultMessage);
      syncSummary();
    }
  }
  function renderSimilarNames() {
    const allGroups = similarNameGroups();
    const needle = searchText.trim().toLocaleLowerCase();
    const visible = allGroups.filter((group) => {
      if (!needle) {
        return true;
      }
      const haystack = [
        group.name,
        group.key,
        ...group.books.flatMap((book) => [
          book.name,
          book.id,
          book.folder || "",
          summarizeReferences(book.references)
        ])
      ].join(" ").toLocaleLowerCase();
      return haystack.includes(needle);
    });
    const mixedCount = allGroups.filter((group) => group.mixed).length;
    return `
      <div
        class="lb-organizer-card"
        style="margin-bottom:10px"
      >
        <div class="lb-organizer-card-head">
          <div>
            <div class="lb-organizer-card-title">
              Similar-name review
            </div>

            <div class="lb-organizer-meta">
              ${allGroups.length}
              group${allGroups.length === 1 ? "" : "s"} ·
              ${mixedCount}
              with both linked and unlinked copies
            </div>
          </div>

          <span class="lb-organizer-badge">
            review only
          </span>
        </div>

        <div class="lb-organizer-meta">
          This compares names independently from contents.
          Similar names do not mean exact duplicates.
          Nothing here is automatically linked, merged or deleted.
        </div>
      </div>

      ${visible.length ? `
            <div class="lb-organizer-list">
              ${visible.map((group) => `
                <div class="lb-organizer-card">
                  <div class="lb-organizer-card-head">
                    <div class="lb-organizer-card-title">
                      ${escapeHtml(group.name)}
                    </div>

                    <div class="lb-organizer-badges">
                      <span class="lb-organizer-badge">
                        ${group.books.length}
                        similar names
                      </span>

                      ${group.mixed ? `
                            <span class="lb-organizer-badge">
                              linked + unlinked
                            </span>
                          ` : ""}
                    </div>
                  </div>

                  <div class="lb-organizer-meta">
                    ${group.linkedCount} linked ·
                    ${group.unlinkedCount} unlinked
                  </div>

                  <div class="lb-organizer-books">
                    ${group.books.map((book) => {
      const unlinkedBook = isUnlinked(book);
      const folder = String(book.folder || "").trim();
      return `
                        <div class="lb-organizer-book">
                          <div class="lb-organizer-card-head">
                            <span class="lb-organizer-book-role">
                              ${unlinkedBook ? "UNLINKED" : "LINKED"}
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
                            ${folder ? `Folder: ${escapeHtml(folder)} · ` : ""}
                            ${book.entryCount} entries
                          </div>

                          <div class="lb-organizer-badges">
                            ${referenceBadges(book)}
                          </div>

                          <div class="lb-organizer-meta">
                            ${referenceLocationText(book)}
                          </div>


                          ${group.books.some((otherBook) => otherBook.id !== book.id && otherBook.references.length > 0) ? `
                                <div class="lb-organizer-actions">
                                  <button
                                    type="button"
                                    data-organizer-similar-replace-with="${escapeHtml(book.id)}"
                                    ${busy ? "disabled" : ""}
                                  >
                                    Use this as replacement
                                  </button>
                                </div>
                              ` : ""}

                          ${group.books.some((otherBook) => otherBook.id !== book.id && otherBook.references.some((ref) => ref.kind === "character")) ? `
                                <div class="lb-organizer-actions">
                                  <button
                                    type="button"
                                    data-organizer-similar-unify-characters="${escapeHtml(book.id)}"
                                    ${busy ? "disabled" : ""}
                                  >
                                    Link all ${new Set(group.books.flatMap((candidate) => candidate.references.filter((ref) => ref.kind === "character").map((ref) => ref.id).filter(Boolean))).size} characters here
                                  </button>
                                </div>
                              ` : ""}

                          ${unlinkedBook ? `
                                <div class="lb-organizer-actions">
                                  <button
                                    type="button"
                                    data-organizer-similar-link-book="${escapeHtml(book.id)}"
                                    ${busy ? "disabled" : ""}
                                  >
                                    Link this copy…
                                  </button>

                                  ${linkPanelOpen && inlineLinkBookId === book.id ? renderInlineLinkControls() : ""}

                                  <button
                                    type="button"
                                    data-organizer-similar-delete-book="${escapeHtml(book.id)}"
                                    ${busy ? "disabled" : ""}
                                  >
                                    Delete this copy
                                  </button>
                                </div>
                              ` : ""}
                        </div>
                      `;
    }).join("")}
                  </div>
                </div>
              `).join("")}
            </div>
          ` : `
            <div class="lb-organizer-empty">
              ${allGroups.length ? "No similar-name groups match this search." : books.length ? "No similar lorebook names found." : "Scan the library to begin."}
            </div>
          `}
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
  function existingFolderNames() {
    return Array.from(new Set(books.map((book) => String(book.folder || "").trim()).filter((folder) => folder && folder !== IGNORED_FOLDER))).sort((a, b) => a.localeCompare(b));
  }
  function characterMatchKey(value) {
    let name = String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().replace(/&/g, " and ").replace(/[_\-.]+/g, " ").replace(/[’']/g, "'").replace(/\s+/g, " ").replace(/\s+\((?:solo\s+)?(?:v|version)\s*\d+(?:\s+\d+)*\)$/i, "").trim();
    let previous = "";
    while (name !== previous) {
      previous = name;
      name = name.replace(/\s+(?:\(\d+\)|copy(?:\s+\d+)?|duplicate(?:\s+\d+)?)$/i, "").replace(/\s+(?:lore\s*book|lorebook|world\s*book|worldbook|world\s*info|worldinfo)$/i, "").replace(/\s+(?:silly\s*tavern|sillytavern)$/i, "").replace(/\s+(?:nsfw|sfw)$/i, "").replace(/\s+(?:v(?:ersion)?\s*)?\d+(?:[\s.]+\d+)+$/i, "").replace(/\s+v(?:ersion)?\s*\d+$/i, "").trim();
    }
    return name.replace(/['’]s$/i, "").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
  }
  function suggestedCharacter(book) {
    const key = characterMatchKey(book.name);
    if (key.length < 2) {
      return null;
    }
    const matches = (referenceSnapshot?.characters || []).filter((character) => typeof character?.id === "string" && characterMatchKey(character?.name) === key);
    if (matches.length !== 1) {
      return null;
    }
    return {
      id: matches[0].id,
      name: matches[0].name || "Unnamed character"
    };
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
  async function moveSelectedBooksToFolder() {
    const selected = selectedUnlinkedBooks();
    if (!selected.length) {
      return;
    }
    const folder = folderTargetName.trim();
    if (!folder) {
      renderAll("Enter a folder name first.");
      return;
    }
    const applied = await applyAssignments(selected.map((book) => ({
      bookId: book.id,
      folder
    })));
    if (!applied)
      return;
    selectedUnlinked.clear();
    folderPanelOpen = false;
    folderTargetName = "";
    renderAll(`Moved ${selected.length} lorebook${selected.length === 1 ? "" : "s"} to "${folder}".`);
  }
  async function deleteSelectedBooks() {
    if (busy)
      return;
    const selected = selectedUnlinkedBooks();
    if (!selected.length)
      return;
    if (!window.confirm(`Delete ${selected.length} selected unlinked lorebook${selected.length === 1 ? "" : "s"}?

Lumi Toolkit will refresh characters, chats, personas and global activation immediately before deletion.`)) {
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
      renderAll();
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
        const characterUrl = `/api/v1/characters/${encodeURIComponent(target.id)}`;
        const currentCharacter = await api(characterUrl);
        const extensions = currentCharacter?.extensions && typeof currentCharacter.extensions === "object" && !Array.isArray(currentCharacter.extensions) ? {
          ...currentCharacter.extensions
        } : {};
        const existingIds = Array.isArray(currentCharacter?.world_book_ids) ? currentCharacter.world_book_ids.filter((id) => typeof id === "string" && Boolean(id)) : Array.isArray(extensions.world_book_ids) ? extensions.world_book_ids.filter((id) => typeof id === "string" && Boolean(id)) : typeof extensions.world_book_id === "string" && extensions.world_book_id ? [
          extensions.world_book_id
        ] : [];
        const nextIds = Array.from(new Set([
          ...existingIds,
          ...selectedIds
        ]));
        delete extensions.world_book_id;
        extensions.world_book_ids = nextIds;
        await api(characterUrl, {
          method: "PUT",
          body: JSON.stringify({
            extensions
          })
        });
        const verified = await api(characterUrl);
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
      inlineLinkBookId = "";
      linkTargetSearch = "";
      renderAll(`Linked ${selected.length} lorebook${selected.length === 1 ? "" : "s"} successfully.`);
    } catch (error) {
      renderAll(`Linking stopped: ${error?.message || String(error)}`);
    } finally {
      busy = false;
      syncSummary();
    }
  }
  async function linkSuggestedCharacter(bookId, characterId) {
    if (busy)
      return;
    const book = books.find((item) => item.id === bookId && isUnlinked(item));
    const character = (referenceSnapshot?.characters || []).find((item) => item.id === characterId);
    if (!book || !character) {
      renderAll("That lorebook or character is no longer available. Rescan and try again.");
      return;
    }
    const previousSelection = new Set(selectedUnlinked);
    const previousKind = linkTargetKind;
    const previousTarget = linkTargetId;
    const previousLinkPanel = linkPanelOpen;
    const previousFolderPanel = folderPanelOpen;
    selectedUnlinked.clear();
    selectedUnlinked.add(bookId);
    linkTargetKind = "character";
    linkTargetId = characterId;
    linkPanelOpen = false;
    folderPanelOpen = false;
    await linkSelectedBooks();
    selectedUnlinked.clear();
    for (const id of previousSelection) {
      const current = books.find((item) => item.id === id);
      if (current && isUnlinked(current)) {
        selectedUnlinked.add(id);
      }
    }
    linkTargetKind = previousKind;
    linkTargetId = previousTarget;
    linkPanelOpen = previousLinkPanel;
    folderPanelOpen = previousFolderPanel;
    renderAll();
  }
  function renderInlineLinkControls() {
    const needle = linkTargetSearch.trim().toLocaleLowerCase();
    const targets = linkTargets().filter((target) => !needle || target.name.toLocaleLowerCase().includes(needle));
    return `
      <div
        class="lb-organizer-card"
        style="
          width:100%;
          margin-top:10px;
        "
      >
        <div class="lb-organizer-card-title">
          Link this lorebook
        </div>

        <div
          class="lb-organizer-toolbar"
          style="margin-top:8px"
        >
          <select
            id="lb-organizer-link-kind"
            ${busy ? "disabled" : ""}
          >
            <option
              value="character"
              ${linkTargetKind === "character" ? "selected" : ""}
            >
              Character
            </option>

            <option
              value="chat"
              ${linkTargetKind === "chat" ? "selected" : ""}
            >
              Chat
            </option>

            <option
              value="persona"
              ${linkTargetKind === "persona" ? "selected" : ""}
            >
              Persona
            </option>

            <option
              value="global"
              ${linkTargetKind === "global" ? "selected" : ""}
            >
              Global activation
            </option>
          </select>

          ${linkTargetKind !== "global" ? `
                <input
                  id="lb-organizer-link-target-search"
                  type="search"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="Type ${escapeHtml(linkTargetKind)} name…"
                  value="${escapeHtml(linkTargetSearch)}"
                  ${busy ? "disabled" : ""}
                >

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
            Link this lorebook
          </button>

          <button
            type="button"
            data-organizer-inline-link-cancel
            ${busy ? "disabled" : ""}
          >
            Cancel
          </button>
        </div>
      </div>
    `;
  }
  function renderUnlinked() {
    const visible = visibleUnlinkedBooks();
    const selected = selectedUnlinkedBooks();
    const singleBookInlineLink = linkPanelOpen && selected.length === 1;
    const allTargets = linkTargets();
    const targetNeedle = linkTargetSearch.trim().toLocaleLowerCase();
    const targets = targetNeedle ? allTargets.filter((target) => target.name.toLocaleLowerCase().includes(targetNeedle)) : allTargets;
    const folders = existingFolderNames();
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
            data-organizer-open-folder
            ${selected.length ? "" : "disabled"}
          >
            Move selected to folder…
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

      ${folderPanelOpen ? `
            <div class="lb-organizer-card" style="margin-bottom:10px">
              <div class="lb-organizer-card-title">
                Move ${selected.length} selected lorebook${selected.length === 1 ? "" : "s"} to folder
              </div>

              <div class="lb-organizer-meta">
                Pick an existing folder or type a new folder name.
              </div>

              <div class="lb-organizer-toolbar">
                <input
                  id="lb-organizer-folder-target"
                  type="text"
                  list="lb-organizer-folder-options"
                  value="${escapeHtml(folderTargetName)}"
                  placeholder="Existing or new folder name…"
                  autocomplete="off"
                  ${busy ? "disabled" : ""}
                >

                <datalist id="lb-organizer-folder-options">
                  ${folders.map((folder) => `<option value="${escapeHtml(folder)}"></option>`).join("")}
                </datalist>

                <button
                  type="button"
                  data-organizer-folder-apply
                  ${busy ? "disabled" : ""}
                >
                  Move selected
                </button>

                <button
                  type="button"
                  data-organizer-folder-cancel
                >
                  Cancel
                </button>
              </div>
            </div>
          ` : ""}

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
                      <input
                        class="lb-organizer-search"
                        id="lb-organizer-link-target-search"
                        type="search"
                        autocomplete="off"
                        spellcheck="false"
                        placeholder="Type ${escapeHtml(linkTargetKind)} name…"
                        value="${escapeHtml(linkTargetSearch)}"
                        ${busy ? "disabled" : ""}
                      >

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

                ${singleBookInlineLink ? "" : `
                      <button
                        type="button"
                        data-organizer-link-apply
                        ${busy ? "disabled" : ""}
                      >
                        Link selected
                      </button>
                    `}

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
      const suggested = suggestedCharacter(book);
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

                    ${suggested ? `
                          <button
                            type="button"
                            data-organizer-link-suggested-character="${escapeHtml(suggested.id)}"
                            data-organizer-link-book="${escapeHtml(book.id)}"
                            ${busy ? "disabled" : ""}
                          >
                            Link to ${escapeHtml(suggested.name)}
                          </button>
                        ` : ""}


                    <button
                      type="button"
                      data-organizer-open-link-one="${escapeHtml(book.id)}"
                      ${busy ? "disabled" : ""}
                    >
                      Link…
                    </button>

                    ${linkPanelOpen && inlineLinkBookId === book.id ? renderInlineLinkControls() : ""}

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
  function activeContent() {
    switch (activeTab) {
      case "duplicates":
        return renderDuplicates();
      case "similar":
        return renderSimilarNames();
      case "unlinked":
        return renderUnlinked();
      case "characters":
        return "";
      case "overview":
      default:
        return renderOverview();
    }
  }
  function renderModal() {
    if (!modalRoot)
      return;
    const lastScan = lastScanAt ? new Date(lastScanAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    }) : "Never";
    characterPanel?.remove();
    modalRoot.innerHTML = `
      <div class="lb-organizer-shell">
        <div class="lb-organizer-hero">
          <div class="lb-organizer-hero-left">
            <div>
              <div class="lb-organizer-hero-title">
                Your library
              </div>

              <div class="lb-organizer-hero-sub">
                ${activeTab === "characters" ? "Compare, edit and organize characters" : `Lorebook scan: ${escapeHtml(lastScan)}`}
              </div>
            </div>
          </div>

          <div class="lb-organizer-actions" ${activeTab === "characters" ? "hidden" : ""}>
            <button
              type="button"
              data-organizer-scan
              ${busy ? "disabled" : ""}
            >
              ${books.length ? "Rescan" : "Scan library"}
            </button>
          </div>
        </div>

          <div class="lb-organizer-tabs" role="tablist" aria-label="Library sections">
            <button type="button" class="lb-organizer-tab" data-organizer-tab="characters" role="tab" aria-selected="${activeTab === "characters"}">Characters</button>
            <button type="button" class="lb-organizer-tab" data-organizer-tab="overview" role="tab" aria-selected="${activeTab !== "characters"}">Lorebooks</button>
          </div>
        <div class="lb-organizer-toolbar" ${activeTab === "characters" ? "hidden" : ""}>
          <input
            class="lb-organizer-search"
            id="lb-organizer-search"
            type="search"
            placeholder="Search lorebooks, folders, IDs or references"
            aria-label="Search lorebooks"
            value="${escapeHtml(searchText)}"
          >

          <select
            class="lb-organizer-sort"
            id="lb-organizer-sort"
            aria-label="Sort lorebooks"
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
          ${activeTab !== "characters" ? `<div class="lb-organizer-tabs" role="tablist" aria-label="Lorebook tools">
            ${[["overview", "All books"], ["duplicates", "Duplicates"], ["similar", "Similar names"], ["unlinked", "Unlinked books"]].map(([key, label]) => `<button type="button" class="lb-organizer-tab" data-organizer-tab="${key}" role="tab" aria-selected="${activeTab === key}">${label}</button>`).join("")}
          </div>` : ""}

          <div class="lb-organizer-status" role="status" aria-live="polite" ${activeTab === "characters" ? "hidden" : ""}>
            ${escapeHtml(statusMessage)}
          </div>
        </div>

        <div class="lb-organizer-content">
          ${activeContent()}
        </div>
      </div>
    `;
    if (activeTab === "characters" && characterPanel)
      modalRoot.querySelector(".lb-organizer-content")?.append(characterPanel);
  }
  function syncSummary() {
    const summary = settingsRoot.querySelector("#lb-lore-organizer-summary");
    const scanButton = settingsRoot.querySelector("#lb-lore-organizer-rescan");
    if (summary) {
      if (!lastScanAt) {
        summary.textContent = "Character folders, duplicate review and lorebook cleanup.";
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
  function renderAllPreservingScroll(message) {
    const content = modalRoot?.querySelector(".lb-organizer-content");
    const scrollTop = content?.scrollTop || 0;
    renderAll(message);
    const next = modalRoot?.querySelector(".lb-organizer-content");
    if (next) {
      next.scrollTop = scrollTop;
    }
  }
  async function openOrganizer() {
    if (modal)
      return;
    modal = ctx.ui.showModal({
      title: "Library",
      width: 1100,
      maxHeight: 900,
      persistent: false
    });
    modalRoot = modal.root;
    characterPanel = document.createElement("div");
    characterPanel.id = "lb-character-cleaner";
    const characterWrapper = document.createElement("div");
    characterWrapper.append(characterPanel);
    characterCleanup = installCharacterCleaner(characterWrapper, {
      loadFolderPreferences: () => sendBackend("bionic_character_folder_preferences_load"),
      saveFolderPreferences: (preferences) => sendBackend("bionic_character_folder_preferences_save", { preferences })
    });
    renderAll();
    modalRoot.addEventListener("click", (event) => {
      const target = event.target;
      if (target.closest("#lb-character-cleaner"))
        return;
      if (target.closest("[data-organizer-inline-link-cancel]")) {
        linkPanelOpen = false;
        inlineLinkBookId = "";
        linkTargetId = "";
        linkTargetSearch = "";
        renderAllPreservingScroll();
        return;
      }
      const openLinkOneButton = target.closest("[data-organizer-open-link-one]");
      if (openLinkOneButton) {
        const id = openLinkOneButton.dataset.organizerOpenLinkOne || "";
        const book = books.find((item) => item.id === id);
        if (!book || !isUnlinked(book)) {
          renderAllPreservingScroll("That lorebook is no longer unlinked.");
          return;
        }
        selectedUnlinked.clear();
        selectedUnlinked.add(book.id);
        inlineLinkBookId = book.id;
        linkPanelOpen = true;
        linkTargetKind = "character";
        linkTargetId = "";
        linkTargetSearch = "";
        renderAllPreservingScroll(`Choose where to link "${book.name}".`);
        return;
      }
      const replaceSimilarButton = target.closest("[data-organizer-similar-replace-with]");
      if (replaceSimilarButton) {
        const keeperId = replaceSimilarButton.dataset.organizerSimilarReplaceWith || "";
        if (keeperId) {
          replaceSimilarReferences(keeperId);
        }
        return;
      }
      const unifyCharactersButton = target.closest("[data-organizer-similar-unify-characters]");
      if (unifyCharactersButton) {
        const keeperId = unifyCharactersButton.dataset.organizerSimilarUnifyCharacters || "";
        if (keeperId) {
          unifySimilarCharacters(keeperId);
        }
        return;
      }
      const similarLinkButton = target.closest("[data-organizer-similar-link-book]");
      if (similarLinkButton) {
        const id = similarLinkButton.dataset.organizerSimilarLinkBook || "";
        const book = books.find((item) => item.id === id);
        if (!book || !isUnlinked(book)) {
          renderAll("That lorebook is no longer unlinked. Rescan before linking.");
          return;
        }
        selectedUnlinked.clear();
        selectedUnlinked.add(book.id);
        inlineLinkBookId = book.id;
        linkTargetKind = "character";
        linkTargetId = "";
        linkTargetSearch = "";
        linkPanelOpen = true;
        renderAllPreservingScroll(`Choose where to link "${book.name}".`);
        return;
      }
      const similarDeleteButton = target.closest("[data-organizer-similar-delete-book]");
      if (similarDeleteButton) {
        const id = similarDeleteButton.dataset.organizerSimilarDeleteBook || "";
        const book = books.find((item) => item.id === id);
        if (!book || !isUnlinked(book)) {
          renderAll("Deletion stopped because that lorebook is no longer unlinked.");
          return;
        }
        selectedUnlinked.clear();
        selectedUnlinked.add(book.id);
        deleteSelectedBooks();
        return;
      }
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
      if (target.closest("[data-organizer-overview-select-visible]")) {
        const visible = filteredBooks();
        const allSelected = visible.length > 0 && visible.every((book) => selectedOverview.has(book.id));
        for (const book of visible) {
          if (allSelected) {
            selectedOverview.delete(book.id);
          } else {
            selectedOverview.add(book.id);
          }
        }
        renderAll();
        return;
      }
      if (target.closest("[data-organizer-overview-clear]")) {
        selectedOverview.clear();
        overviewFolderPanelOpen = false;
        overviewFolderTargetName = "";
        renderAll();
        return;
      }
      if (target.closest("[data-organizer-overview-open-folder]")) {
        overviewFolderPanelOpen = true;
        renderAll();
        return;
      }
      if (target.closest("[data-organizer-overview-folder-cancel]")) {
        overviewFolderPanelOpen = false;
        overviewFolderTargetName = "";
        renderAll();
        return;
      }
      if (target.closest("[data-organizer-overview-folder-apply]")) {
        const input = modalRoot?.querySelector("#lb-organizer-overview-folder-target");
        overviewFolderTargetName = input?.value || "";
        moveSelectedOverviewToFolder();
        return;
      }
      if (target.closest("[data-organizer-open-folder]")) {
        folderPanelOpen = true;
        linkPanelOpen = false;
        renderAll();
        return;
      }
      if (target.closest("[data-organizer-folder-cancel]")) {
        folderPanelOpen = false;
        folderTargetName = "";
        renderAll();
        return;
      }
      if (target.closest("[data-organizer-folder-apply]")) {
        const input = modalRoot?.querySelector("#lb-organizer-folder-target");
        folderTargetName = input?.value || "";
        moveSelectedBooksToFolder();
        return;
      }
      const suggestedLink = target.closest("[data-organizer-link-suggested-character]");
      if (suggestedLink) {
        const characterId = suggestedLink.dataset.organizerLinkSuggestedCharacter || "";
        const bookId = suggestedLink.dataset.organizerLinkBook || "";
        if (characterId && bookId) {
          linkSuggestedCharacter(bookId, characterId);
        }
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
    });
    modalRoot.addEventListener("input", (event) => {
      const target = event.target;
      if (target.closest("#lb-character-cleaner"))
        return;
      if (target.id === "lb-organizer-overview-folder-target") {
        overviewFolderTargetName = target.value;
        return;
      }
      if (target.id === "lb-organizer-folder-target") {
        folderTargetName = target.value;
        return;
      }
      if (target.id === "lb-organizer-link-target-search") {
        linkTargetSearch = target.value;
        const needle = linkTargetSearch.trim().toLocaleLowerCase();
        const filteredTargets = linkTargets().filter((item) => !needle || item.name.toLocaleLowerCase().includes(needle));
        const select = modalRoot?.querySelector("#lb-organizer-link-target");
        if (select) {
          const selectedStillVisible = filteredTargets.some((item) => item.id === linkTargetId);
          if (linkTargetId && !selectedStillVisible) {
            linkTargetId = "";
          }
          select.innerHTML = `
              <option value="">
                Choose ${escapeHtml(linkTargetKind)}…
              </option>

              ${filteredTargets.map((item) => `
                    <option
                      value="${escapeHtml(item.id)}"
                      ${item.id === linkTargetId ? "selected" : ""}
                    >
                      ${escapeHtml(item.name)}
                    </option>
                  `).join("")}
            `;
        }
        return;
      }
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
      if (target.matches("[data-organizer-select-overview]")) {
        const id = target.dataset.organizerSelectOverview || "";
        if (id) {
          if (target.checked) {
            selectedOverview.add(id);
          } else {
            selectedOverview.delete(id);
          }
        }
        renderAll();
        return;
      }
      if (target.matches("[data-organizer-select-unlinked]")) {
        const id = target.dataset.organizerSelectUnlinked || "";
        if (id) {
          if (target.checked) {
            selectedUnlinked.add(id);
          } else {
            selectedUnlinked.delete(id);
          }
        }
        renderAllPreservingScroll();
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
        linkTargetSearch = "";
        renderAllPreservingScroll();
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
    });
    modal.onDismiss(() => {
      characterCleanup?.();
      characterCleanup = null;
      characterPanel = null;
      modal = null;
      modalRoot = null;
    });
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
    characterCleanup?.();
    characterCleanup = null;
    characterPanel = null;
    modal?.dismiss?.();
    modal = null;
    modalRoot = null;
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

// src/ken-bunny-asset.ts
var kenBunnyDataUrl = "data:image/png;base64,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";

// src/ken-sleep-companion.ts
var KEN_SLEEP_DISMISSED_KEY = "lumiverse:lumi-toolkit:ken-sleep-dismissed-night";
function kenSleepNight(now) {
  const hour = now.getHours();
  if (hour >= 6 && hour < 22)
    return null;
  const night = new Date(now);
  if (hour < 6)
    night.setDate(night.getDate() - 1);
  return `${night.getFullYear()}-${String(night.getMonth() + 1).padStart(2, "0")}-${String(night.getDate()).padStart(2, "0")}`;
}
function createKenSleepGate(options) {
  let chatId = null;
  let count = 0;
  let shown = false;
  let lastShownAt = 0;
  let currentNight = null;
  return {
    onMessage(payload) {
      const active = options.activeChatId();
      if (!active || payload.chatId !== active)
        return;
      if (chatId !== active) {
        chatId = active;
        count = 0;
      }
      if (payload.isUser !== true)
        return;
      if (payload.personaName !== "Ken") {
        count = 0;
        return;
      }
      const now = options.now();
      const night = kenSleepNight(now);
      if (!night || options.dismissedNight() === night) {
        count = 0;
        return;
      }
      if (night !== currentNight) {
        currentNight = night;
        count = 0;
        shown = false;
        lastShownAt = 0;
      }
      count++;
      const threshold = shown ? 6 : 2;
      if (count < threshold || shown && now.getTime() - lastShownAt < 15 * 60000)
        return;
      count = 0;
      shown = true;
      lastShownAt = now.getTime();
      options.show();
    }
  };
}
var lines = [
  "I'm sleepy. You should go to bed too.",
  "Maybe you should take melatonin.",
  "Even bunnies need sleep, Ken.",
  "The next reply can wait until morning.",
  "Let’s get cozy and call it a night."
];
var bunnyImage = `<img class="ken-bunny" src="${kenBunnyDataUrl}" alt="Sleepy bunny lying on the chat textbox" draggable="false">`;
var pugSvg = `<svg class="ken-pug" viewBox="0 0 100 92" role="img" aria-label="Little pug being petted" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="49" cy="73" rx="38" ry="17" fill="#b89169" stroke="#664c42" stroke-width="3"/>
  <path d="M20 41q-14-21-6-29q12-7 23 11M78 41q16-22 8-29q-12-7-24 11" fill="#664c42" stroke="#664c42" stroke-width="3"/>
  <ellipse cx="49" cy="41" rx="35" ry="33" fill="#cba77c" stroke="#664c42" stroke-width="3"/>
  <ellipse cx="49" cy="55" rx="21" ry="16" fill="#66504a"/>
  <circle cx="35" cy="38" r="4" fill="#2f2527"/><circle cx="64" cy="38" r="4" fill="#2f2527"/>
  <ellipse cx="49" cy="52" rx="7" ry="5" fill="#2f2527"/><path d="M49 57q-5 6-10 4m10-4q5 6 10 4" fill="none" stroke="#2f2527" stroke-width="2" stroke-linecap="round"/>
</svg>`;
var style = `
.ken-bedtime{position:fixed;z-index:2147483000;pointer-events:none;display:flex;flex-direction:column;align-items:flex-start;max-width:min(280px,calc(100vw - 24px));filter:drop-shadow(0 6px 11px rgba(15,12,18,.17));animation:ken-arrive-left .8s cubic-bezier(.2,.9,.25,1) both}
.ken-bedtime-bubble{position:relative;max-width:245px;min-width:150px;margin-left:22px;padding:11px 29px 11px 14px;border:2px solid #373037;border-radius:16px 19px 15px 6px;background:#fffefa;color:#302a30;font:600 14px/1.35 system-ui,sans-serif;pointer-events:auto}
.ken-bedtime-bubble::after{content:"";position:absolute;left:20px;bottom:-8px;width:13px;height:13px;background:#fffefa;border-right:2px solid #373037;border-bottom:2px solid #373037;transform:rotate(45deg)}
.ken-bedtime-close{position:absolute;right:5px;top:3px;border:0;background:transparent;color:#705361;font:700 20px/1 system-ui,sans-serif;cursor:pointer;padding:2px 5px}
.ken-bedtime-close:focus-visible{outline:2px solid #705361;border-radius:4px}
.ken-bedtime-friends{display:flex;align-items:flex-end;flex:none;margin-top:2px}
.ken-bunny{width:88px;height:90px;object-fit:contain;display:block;transform-origin:50% 85%;animation:ken-breathe 2.3s ease-in-out infinite alternate}
.ken-pug{width:43px;height:40px;margin-left:-3px;margin-bottom:1px;display:none}
.ken-bedtime-with-pug .ken-pug{display:block;transform-origin:20% 85%;animation:ken-pet .8s ease-in-out 4 alternate}
@keyframes ken-arrive-left{from{transform:translateX(calc(-100vw - 300px))}to{transform:translateX(0)}}
@keyframes ken-breathe{to{transform:scaleY(.97)}}
@keyframes ken-pet{to{transform:rotate(-9deg) translateX(-2px)}}
@media(prefers-reduced-motion:reduce){.ken-bedtime,.ken-bunny,.ken-bedtime-with-pug .ken-pug{animation:none}}
`;
function createKenSleepCompanion(doc, options) {
  const random = options.random ?? Math.random;
  const css = doc.createElement("style");
  css.textContent = style;
  doc.head.append(css);
  let root = null;
  let timer = null;
  const position = () => {
    if (!root)
      return;
    const composer = doc.querySelector('[data-component="InputArea"]');
    const rect = composer?.getBoundingClientRect();
    const view = doc.defaultView;
    const width = view?.innerWidth ?? 1024, height = view?.innerHeight ?? 768;
    const desiredLeft = rect ? rect.left + 12 : 12;
    root.style.left = `${Math.max(12, Math.min(desiredLeft, width - root.offsetWidth - 12))}px`;
    root.style.bottom = `${Math.max(16, rect ? height - rect.top - 19 : 80)}px`;
  };
  const remove = () => {
    if (timer)
      clearTimeout(timer);
    timer = null;
    root?.remove();
    root = null;
    doc.defaultView?.removeEventListener("resize", position);
    doc.defaultView?.removeEventListener("scroll", position, true);
  };
  return {
    isVisible: () => Boolean(root),
    show(preview = false) {
      if (root)
        return;
      const line = lines[Math.floor(random() * lines.length) % lines.length];
      const withPug = random() < 0.3;
      root = doc.createElement("aside");
      root.className = `ken-bedtime${withPug ? " ken-bedtime-with-pug" : ""}`;
      root.setAttribute("role", "status");
      root.setAttribute("aria-live", "polite");
      root.innerHTML = `<div class="ken-bedtime-bubble"><span class="ken-bedtime-line"></span><button type="button" class="ken-bedtime-close" aria-label="Dismiss bedtime reminder">×</button></div><div class="ken-bedtime-friends">${bunnyImage}${pugSvg}</div>`;
      root.querySelector(".ken-bedtime-line").textContent = line;
      root.querySelector(".ken-bedtime-close").addEventListener("click", () => {
        if (!preview)
          options.onDismiss();
        remove();
      });
      doc.body.append(root);
      position();
      doc.defaultView?.addEventListener("resize", position);
      doc.defaultView?.addEventListener("scroll", position, true);
      timer = setTimeout(remove, 16000);
    },
    hide: remove,
    destroy() {
      remove();
      css.remove();
    }
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
    { key: "backHome", label: "Home", title: "Back to home", className: "lb-hide-toolbar-back-home" },
    { key: "latestMessageTop", label: "Latest message", title: "Top of latest message", className: "lb-hide-toolbar-latest-message-top" },
    { key: "autoRegenerate", label: "Auto regenerate", title: "Auto regenerate", className: "lb-hide-toolbar-auto-regenerate" },
    { key: "regenerate", label: "Regenerate", title: "Regenerate", className: "lb-hide-toolbar-regenerate" },
    { key: "continue", label: "Continue", title: "Continue", className: "lb-hide-toolbar-continue" },
    { key: "oneLiner", label: "Impersonate", title: "One-liner: Chat history + impersonation nudge only", titles: ["Impersonate", "One-liner"], className: "lb-hide-toolbar-one-liner" },
    { key: "persona", label: "Persona", title: "Switch persona for this chat", className: "lb-hide-toolbar-persona" },
    { key: "connection", label: "Connection", title: "Connection:", titles: ["Connection:", "Switch connection"], className: "lb-hide-toolbar-connection" },
    { key: "alternateFields", label: "Alternate fields", title: "Alternate fields", className: "lb-hide-toolbar-alternate-fields" },
    { key: "guidedGenerations", label: "Guided generations", title: "Guided generations", className: "lb-hide-toolbar-guided" },
    { key: "quickReplies", label: "Quick replies", title: "Quick replies", className: "lb-hide-toolbar-quick-replies" },
    { key: "tools", label: "Tools", title: "Tools", className: "lb-hide-toolbar-tools" },
    { key: "extras", label: "Extras", title: "Extras", className: "lb-hide-toolbar-extras" },
    { key: "customizeToolbar", label: "Customize buttons", title: "Customize toolbar", titles: ["Customize toolbar", "Customize composer"], className: "lb-hide-toolbar-customize" },
    {
      key: "attachments",
      label: "Attachments",
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
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .lumibionic-settings [hidden] {
      display: none !important;
    }

    .lb-character-row { display: flex; align-items: center; gap: 10px; padding: 10px 0; }
    .lb-character-row input { flex: 0 0 auto; }
    .lb-character-row span { min-width: 0; overflow-wrap: anywhere; }
    .lb-character-row small { display: block; opacity: .75; }
    #lb-character-cleaner select { width: 100%; }
    #lb-character-cleaner details { margin: 12px 0; padding: 10px; border: 1px solid rgba(127,127,127,.2); border-radius: 8px; }
    #lb-character-cleaner button { margin: 4px 0; }

    .lumibionic-panel-nav {
      position: sticky;
      top: 0;
      z-index: 6;
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 4px;
      padding: 4px;
      border: 1px solid var(--lumi-border, rgba(127,127,127,.22));
      border-radius: 10px;
      background: color-mix(in srgb, var(--lumiverse-bg, #171821) 96%, transparent);
    }

    .lumibionic-panel-nav button {
      padding: 8px 3px !important;
      min-height: 38px;
      border: 0 !important;
      background: transparent !important;
      font-size: 12px !important;
      font-weight: 600 !important;
    }

    .lumibionic-panel-nav button[aria-selected="true"] {
      background: color-mix(in srgb, var(--lumiverse-primary, #7c9bc8) 22%, transparent) !important;
      color: var(--lumiverse-primary, #afc9ec);
    }

    .lumibionic-settings button:focus-visible,
    .lumibionic-settings select:focus-visible,
    .lumibionic-settings input:focus-visible,
    .lumibionic-settings textarea:focus-visible {
      outline: 2px solid var(--lumiverse-primary, #7c9bc8);
      outline-offset: 2px;
    }

    .lumibionic-reset-footer {
      border-top: 1px solid var(--lumi-border, rgba(127,127,127,.22));
      padding-top: 14px;
      display: grid;
      gap: 8px;
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
      margin: 0;
    }

    .lumibionic-group > summary {
      cursor: pointer;
      user-select: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      font-weight: 650;
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
      display: grid;
      gap: 14px;
    }

    .lumibionic-category-root {
      border: 0;
      border-radius: 0;
      overflow: visible;
    }

    .lumibionic-category-root > summary {
      display: none;
    }

    .lumibionic-category-root > .lumibionic-group-body {
      padding: 0;
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
      border: 0 !important;
      background: transparent !important;
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
      border: 1px solid rgba(255,255,255,.14);
      border-radius: 10px;
      box-shadow: 0 8px 24px rgba(0,0,0,.28);
    }

    .lumibionic-preview-section.lumibionic-preview-visible {
      position: sticky;
      top: 60px;
      z-index: 5;
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

    .lumibionic-ui-actions button {
      min-height: 32px !important;
      padding: 6px 8px !important;
      font-size: 12px !important;
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
      min-height: 44px;
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

    .lumibionic-toolbar-toggle[data-hidden="false"] {
      border-color: color-mix(in srgb, var(--lumiverse-primary, #7c9bc8) 55%, transparent);
      background: color-mix(in srgb, var(--lumiverse-primary, #7c9bc8) 12%, transparent);
    }

    .lumibionic-toolbar-toggle[data-hidden="true"] {
      opacity: .65;
    }

    .lumibionic-toolbar-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    @media (max-width: 440px) {
      .lumibionic-toolbar-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
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
    .lumibionic-settings textarea,
    .lumibionic-settings button {
      width: 100%;
      box-sizing: border-box;
    }

    .lumibionic-settings select,
    .lumibionic-settings input[type="text"],
    .lumibionic-settings textarea,
    .lumibionic-settings button {
      padding: 9px 10px;
      border-radius: 8px;
      font: inherit;
      color: inherit;
      border: 1px solid var(--lumi-border, rgba(127,127,127,.22));
      background: rgba(127,127,127,.04);
      min-width: 0;
      min-height: 38px;
    }

    .lumibionic-settings button {
      cursor: pointer;
      white-space: normal;
      overflow-wrap: anywhere;
      font-size: 13px;
      font-weight: 600;
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
      max-height: min(140px, 20dvh);
      overflow-y: auto;
      overscroll-behavior: contain;
      scrollbar-gutter: stable;
    }

    @media (max-width: 720px) {
      .lumibionic-preview {
        max-height: min(110px, 16dvh);
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


    /*
     * Lumiverse Quick Toolbar customize button.
     * The native button exposes both title and aria-label.
     */
    html.lb-hide-toolbar-customize button[title="Customize toolbar"],
    html.lb-hide-toolbar-customize button[aria-label="Customize toolbar"] {
      display: none !important;
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
    title: "Lumi Toolkit",
    shortName: "Lumi Toolkit",
    headerTitle: "Lumi Toolkit",
    description: "Reading, toolbar, characters and lorebooks",
    keywords: [
      "bionic",
      "lumi",
      "toolkit",
      "characters",
      "lorebooks",
      "toolbar",
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
  function applyFontLockToRoot(root, font, messageSize) {
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
      element.style.setProperty("font-family", font, "important");
      if (messageSize) {
        element.style.setProperty("font-size", messageSize, "important");
      }
      element.setAttribute(LUMIREALM_FONT_LOCK_ATTR, "true");
    }
    root.querySelectorAll?.("*").forEach((element) => {
      if (element.shadowRoot) {
        applyFontLockToRoot(element.shadowRoot, font, messageSize);
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
    const actionKeys = {
      home: "backHome",
      regen: "regenerate",
      continue: "continue",
      oneliner: "oneLiner",
      persona: "persona",
      connections: "connection",
      altFields: "alternateFields",
      guides: "guidedGenerations",
      quickReplies: "quickReplies",
      tools: "tools",
      extras: "extras",
      "chat.customize-composer": "customizeToolbar"
    };
    const composerAction = button.closest("[data-composer-action]");
    const actionKey = actionKeys[composerAction?.getAttribute("data-composer-action")] || (button.hasAttribute(SCROLL_LATEST_BUTTON_ATTR) ? "latestMessageTop" : null) || (button.hasAttribute(AUTO_REGENERATE_BUTTON_ATTR) ? "autoRegenerate" : null) || (button.getAttribute("data-composer-pinned") === "customize" ? "customizeToolbar" : null);
    if (actionKey) {
      return TOOLBAR_BUTTONS.find((item) => item.key === actionKey) || null;
    }
    if (composerAction)
      return null;
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
    const nativeBar = getNativeComposerActionBar()?.actionBar;
    nativeBar?.querySelectorAll("button").forEach((button) => buttons.add(button));
    document.querySelectorAll((nativeBar ? "" : '[data-component="InputArea"] button, ') + '[data-spindle-mount="chat_toolbar"] button, ' + '[data-component="InputArea"] button:has(svg[class*="paperclip"]), ' + '[data-component="InputArea"] [data-spindle-mount="chat_input_tools_left"] + button, ' + '[data-component="QuickToolbar"] button[title="Customize toolbar"], ' + '[data-component="QuickToolbar"] button[aria-label="Customize toolbar"]').forEach((button) => buttons.add(button));
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
      if (!item) {
        if (button.hasAttribute("data-lumibionic-toolbar-hidden")) {
          button.style.removeProperty("display");
          button.removeAttribute("data-lumibionic-toolbar-hidden");
        }
        continue;
      }
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
        <div class="lumibionic-muted">
          Adjust reading, toolbar controls and your library.
        </div>
      </div>

      <details class="lumibionic-group" data-lumibionic-group="Settings" open>
        <summary>Preferences</summary>
        <div class="lumibionic-group-body">
          <div class="lumibionic-section">
            <div class="lumibionic-section-title">Saving</div>
            <div class="lumibionic-control">
              <label for="lb-settings-persistence">Save settings to</label>
              <select id="lb-settings-persistence">
                <option value="account">Your account</option>
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
            <option value="bionicLight">Light emphasis</option>
          </select>
          <div class="lumibionic-muted">
            Choose a starting point, then adjust. Your font stays unchanged.
          </div>
        </div>

      </div>

      <div class="lumibionic-section">

        <div class="lumibionic-section-title">
          Word emphasis
        </div>

        <div class="lumibionic-row">
          <label for="lb-bionic-enabled">
            Enable word emphasis
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
              Bold portion of each word
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
            Remove loaded font
          </button>

          <div class="lumibionic-control">
            <label>Apply font to</label>

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
        <summary>Reasoning repair</summary>
        <div class="lumibionic-group-body">
      <div class="lumibionic-section">

        <div class="lumibionic-section-title">
          FF think fix
        </div>

        <label class="lumibionic-check">
          <input id="lb-ff-think-fix" type="checkbox">
          <span>Repair reasoning automatically</span>
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
            Repair latest reply
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
        <summary>Auto regenerate</summary>
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
            <label for="lb-auto-regen-max">Retry limit per reply</label>
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

      <details class="lumibionic-group" data-lumibionic-group="Ken bedtime bunny">
        <summary>Ken bedtime bunny</summary>
        <div class="lumibionic-group-body">
          <div class="lumibionic-section">
            <div class="lumibionic-muted">
              The bunny appears after late-night messages from the persona named Ken.
              Preview it any time without changing the nightly reminder.
            </div>
            <div class="lumibionic-toolbar-actions">
              <button type="button" id="lb-ken-test">Test bunny</button>
            </div>
          </div>
        </div>
      </details>

      <details
        class="lumibionic-group"
        data-lumibionic-group="Lorebook Organizer"
      >
        <summary>Library</summary>

        <div class="lumibionic-group-body">
          <div class="lumibionic-section">
            <div class="lb-organizer-summary">
              <div class="lb-organizer-brand">
                <div class="lb-organizer-brand-copy">
                  <strong>Characters &amp; lorebooks</strong>
                  <small>
                    Create bot folders by author or tags, review character duplicates,
                    and clean up lorebooks with reference checks.
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
                  Open library
                </button>

                <button
                  type="button"
                  id="lb-lore-organizer-rescan" hidden
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
          Tap a button to hide or show it in the chat toolbar.
        </div>

        <div class="lumibionic-control">
          <div class="lumibionic-row">
            <label for="lb-toolbar-spacing">Button spacing</label>
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
          <button type="button" id="lb-toolbar-hide-all">Hide all</button>
          <button type="button" id="lb-toolbar-show-all">Show all</button>
        </div>

        <div class="lumibionic-muted" id="lb-toolbar-match-status">
          Checking Lumiverse toolbar…
        </div>

        <div class="lumibionic-muted">
          If a shown button is missing, check Lumiverse's own toolbar settings.
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

      <div class="lumibionic-reset-footer" data-lumibionic-category="tools">
        <div class="lumibionic-muted">Restore reading, font, toolbar and automation settings.</div>
      <button
        type="button"
        id="lb-reset"
      >
        Restore defaults
      </button>
      </div>

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
        activeCategory: ["reading", "toolbar", "library", "tools"].includes(saved.activeCategory) ? saved.activeCategory : ["lorebooks", "characters"].includes(saved.activeCategory) ? "library" : "reading",
        previewVisible: typeof saved.previewVisible === "boolean" ? saved.previewVisible : true,
        sections: saved.sections && typeof saved.sections === "object" ? saved.sections : {}
      };
    } catch {
      return { activeCategory: "reading", previewVisible: true, sections: {} };
    }
  }
  let uiState = loadUiState();
  try {
    const previewMigrationKey = `${UI_STATE_KEY}:preview-sticky-v0486`;
    if (localStorage.getItem(previewMigrationKey) !== "1") {
      uiState = {
        ...uiState,
        previewVisible: true
      };
      localStorage.setItem(UI_STATE_KEY, JSON.stringify(uiState));
      localStorage.setItem(previewMigrationKey, "1");
    }
  } catch {}
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
    const categories = [
      ["reading", "Reading"],
      ["toolbar", "Toolbar"],
      ["library", "Library"],
      ["tools", "Tools"]
    ];
    const groupCategories = {
      "Reading & Typography": "reading",
      "Chat Toolbar": "toolbar",
      "Lorebook Organizer": "library",
      Settings: "tools",
      "FF5 Thinking Fix": "tools",
      Automation: "tools",
      "Ken bedtime bunny": "tools"
    };
    settingsRoot.querySelectorAll(".lumibionic-group").forEach((group) => {
      const category = groupCategories[group.getAttribute("data-lumibionic-group")];
      group.dataset.lumibionicCategory = category;
      if (category !== "tools") {
        group.classList.add("lumibionic-category-root");
        group.open = true;
      }
    });
    const preferencesGroup = settingsRoot.querySelector('[data-lumibionic-group="Settings"]');
    const automationGroup = settingsRoot.querySelector('[data-lumibionic-group="Automation"]');
    if (preferencesGroup && automationGroup) {
      automationGroup.insertAdjacentElement("afterend", preferencesGroup);
    }
    const navigation = document.createElement("div");
    navigation.className = "lumibionic-panel-nav";
    navigation.setAttribute("role", "tablist");
    navigation.setAttribute("aria-label", "Lumi Toolkit settings");
    navigation.innerHTML = categories.map(([key, label]) => `
      <button type="button" role="tab" data-panel-category="${key}">${label}</button>
    `).join("");
    let syncPreviewVisibility = () => {};
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
      syncPreviewVisibility = () => {
        previewSection.hidden = uiState.activeCategory !== "reading";
        previewSection.classList.toggle("lumibionic-preview-visible", uiState.previewVisible);
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
    if (headingBlock)
      headingBlock.insertAdjacentElement("afterend", navigation);
    const uiActions = document.createElement("div");
    uiActions.className = "lumibionic-ui-actions";
    uiActions.innerHTML = `
      <button type="button" id="lb-collapse-all">Collapse sections</button>
      <button type="button" id="lb-expand-all">Expand sections</button>
    `;
    if (previewSection) {
      previewSection.insertAdjacentElement("afterend", uiActions);
    } else if (headingBlock) {
      headingBlock.insertAdjacentElement("afterend", uiActions);
    }
    const sectionControllers = [];
    const sectionNames = {
      "Word emphasis": "Word emphasis",
      "Font override": "Font",
      "Long-form reading": "Layout",
      "Message typography": "Text size & spacing"
    };
    tab.root.querySelectorAll(".lumibionic-section").forEach((section) => {
      if (section.classList.contains("lumibionic-preview-section"))
        return;
      const title = section.querySelector(":scope > .lumibionic-section-title");
      if (!title)
        return;
      if (section.closest(".lumibionic-group")?.dataset.lumibionicCategory !== "reading" || title.textContent.trim() === "Preset") {
        title.remove();
        return;
      }
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
      toggle.textContent = sectionNames[title.textContent.trim()] || title.textContent.trim();
      title.replaceWith(toggle);
      section.appendChild(body);
      const savedExpanded = uiState.sections[key];
      const initialExpanded = typeof savedExpanded === "boolean" ? savedExpanded : ["bionic-emphasis", "message-typography"].includes(key);
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
    const selectCategory = (category, persist = true) => {
      uiState = { ...uiState, activeCategory: category };
      settingsRoot.querySelectorAll("[data-lumibionic-category]").forEach((group) => {
        group.hidden = group.dataset.lumibionicCategory !== category;
      });
      navigation.querySelectorAll("[data-panel-category]").forEach((button) => {
        const active = button.dataset.panelCategory === category;
        button.setAttribute("aria-selected", String(active));
        button.tabIndex = active ? 0 : -1;
      });
      uiActions.hidden = category !== "reading";
      syncPreviewVisibility();
      if (persist) {
        saveUiState();
        let scroller = settingsRoot.parentElement;
        while (scroller && scroller !== document.body) {
          if (/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) {
            scroller.scrollTop = 0;
            break;
          }
          scroller = scroller.parentElement;
        }
      }
    };
    navigation.addEventListener("click", (event) => {
      const button = event.target.closest("[data-panel-category]");
      if (button)
        selectCategory(button.dataset.panelCategory);
    });
    navigation.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
        return;
      const buttons = Array.from(navigation.querySelectorAll("[data-panel-category]"));
      const current = buttons.indexOf(document.activeElement);
      if (current < 0)
        return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
      selectCategory(buttons[next].dataset.panelCategory);
      buttons[next].focus();
    });
    selectCategory(uiState.activeCategory, false);
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
      button.setAttribute("aria-label", `${TOOLBAR_BUTTONS.find((item) => item.key === key)?.label}: ${hidden ? "hidden; click to show" : "shown; click to hide"}`);
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
  let kenSleepModal = null;
  let kenSleepCompanion = null;
  let kenDismissedNight = null;
  function dismissKenForNight() {
    const night = kenSleepNight(new Date);
    if (!night)
      return;
    kenDismissedNight = night;
    try {
      localStorage.setItem(KEN_SLEEP_DISMISSED_KEY, night);
    } catch {}
  }
  function getKenSleepCompanion() {
    kenSleepCompanion ||= createKenSleepCompanion(document, {
      onDismiss: dismissKenForNight
    });
    return kenSleepCompanion;
  }
  function showKenSleepPopup() {
    if (kenSleepModal || kenSleepCompanion?.isVisible())
      return;
    try {
      getKenSleepCompanion().show();
      return;
    } catch (error) {
      console.warn("[Lumi Toolkit] Ken bunny could not appear:", error);
    }
    try {
      const modal = ctx.ui.showModal({ title: "Ken, bedtime?", width: 380, maxHeight: 240, persistent: false });
      const message = document.createElement("div");
      message.textContent = "I'm sleepy. You should go to bed too.";
      message.style.cssText = "padding:18px 8px;font-size:1.15rem;font-weight:700;line-height:1.45;text-align:center";
      modal.root.appendChild(message);
      kenSleepModal = modal;
      modal.onDismiss(() => {
        if (kenSleepModal === modal)
          kenSleepModal = null;
        dismissKenForNight();
      });
    } catch (error) {
      console.warn("[Lumi Toolkit] Ken sleep popup failed:", error);
    }
  }
  const kenSleepGate = createKenSleepGate({
    activeChatId: () => {
      const active = ctx.getActiveChat?.();
      return typeof active?.chatId === "string" ? active.chatId : null;
    },
    now: () => new Date,
    dismissedNight: () => {
      if (kenDismissedNight)
        return kenDismissedNight;
      try {
        return localStorage.getItem(KEN_SLEEP_DISMISSED_KEY);
      } catch {
        return null;
      }
    },
    show: showKenSleepPopup
  });
  function handleKenSleepMessage(payload) {
    kenSleepGate.onMessage(payload);
  }
  tab.root.querySelector("#lb-ken-test")?.addEventListener("click", () => {
    if (kenSleepModal)
      return;
    try {
      getKenSleepCompanion().show(true);
    } catch (error) {
      console.warn("[Lumi Toolkit] Ken bunny preview failed:", error);
    }
  });
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
  function characterLoreIds(character) {
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
      for (const bookId of characterLoreIds(character)) {
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
  function shortLoreId(id) {
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
                    >${escapeLoreHtml(shortLoreId(book.id))}</code>
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
                        >${escapeLoreHtml(shortLoreId(book.id))}</code>
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
      const current = characterLoreIds(character);
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
      "data-title",
      "data-composer-action",
      "data-composer-pinned"
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
    if (details.classList.contains("lumibionic-category-root")) {
      details.open = true;
      return;
    }
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
    kenSleepCompanion?.destroy();
    kenSleepCompanion = null;
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
