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

// src/ken-pug-asset.ts
var kenPugDataUrl = "data:image/png;base64,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";

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
var soloLines = [
  "I'm sleepy. You should go to bed too.",
  "Maybe you should take melatonin.",
  "Ken, does “one more reply” ever mean one?",
  "The story will still be here tomorrow, promise.",
  "Even bunnies need sleep, Ken.",
  "Let’s get cozy and call it a night."
];
var pugLines = [
  "I'm sleepy. Come rest with us.",
  "The pug’s ready for bed. Are you, Ken?",
  "The pug has claimed the pillow. There’s room for you.",
  "I think “one more reply” became a whole chapter.",
  "Maybe you should take melatonin."
];
var bunnyImage = `<img class="ken-bunny" src="${kenBunnyDataUrl}" alt="Sleepy bunny lying on the chat textbox" draggable="false">`;
var pugImage = `<img class="ken-pug" src="${kenPugDataUrl}" alt="Sleepy pug being petted by the bunny" draggable="false">`;
var pettingPaw = `<svg class="ken-petting-paw" viewBox="0 0 43 30" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M2 22Q9 18 15 16Q20 8 26 10Q30 11 30 15Q37 13 40 17Q43 23 35 25Q26 25 22 27Q11 31 2 26Z" fill="#fff" stroke="#151111" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
var style = `
.ken-bedtime{position:fixed;z-index:2147483000;pointer-events:none;display:flex;flex-direction:column;align-items:flex-start;max-width:min(280px,calc(100vw - 24px));filter:drop-shadow(0 6px 11px rgba(15,12,18,.17));animation:ken-arrive-left .8s cubic-bezier(.2,.9,.25,1) both}
.ken-bedtime-bubble{position:relative;max-width:245px;min-width:150px;margin-left:22px;padding:11px 29px 11px 14px;border:2px solid #373037;border-radius:16px 19px 15px 6px;background:#fffefa;color:#302a30;font:600 14px/1.35 system-ui,sans-serif;pointer-events:auto}
.ken-bedtime-bubble::after{content:"";position:absolute;left:20px;bottom:-8px;width:13px;height:13px;background:#fffefa;border-right:2px solid #373037;border-bottom:2px solid #373037;transform:rotate(45deg)}
.ken-bedtime-close{position:absolute;right:5px;top:3px;border:0;background:transparent;color:#705361;font:700 20px/1 system-ui,sans-serif;cursor:pointer;padding:2px 5px}
.ken-bedtime-close:focus-visible{outline:2px solid #705361;border-radius:4px}
.ken-bedtime-friends{position:relative;display:flex;align-items:flex-end;flex:none;margin-top:2px}
.ken-bunny{width:88px;height:90px;object-fit:contain;display:block;transform-origin:50% 85%;animation:ken-breathe 2.3s ease-in-out infinite alternate}
.ken-pug{width:58px;height:59px;margin-left:-7px;margin-bottom:1px;object-fit:contain;display:none;transform-origin:30% 85%}
.ken-petting-paw{position:absolute;left:74px;bottom:45px;width:32px;height:23px;display:none;transform-origin:3px 18px}
.ken-bedtime-with-pug .ken-pug,.ken-bedtime-with-pug .ken-petting-paw{display:block}
.ken-bedtime-with-pug .ken-pug{animation:ken-pug-nuzzle 1.2s ease-in-out 4 alternate}
.ken-bedtime-with-pug .ken-petting-paw{animation:ken-pet 1.2s ease-in-out 4 alternate}
@keyframes ken-arrive-left{from{transform:translateX(calc(-100vw - 300px))}to{transform:translateX(0)}}
@keyframes ken-breathe{to{transform:scaleY(.97)}}
@keyframes ken-pet{to{transform:rotate(-8deg) translateY(-3px)}}
@keyframes ken-pug-nuzzle{to{transform:rotate(-4deg) translateX(-3px)}}
@media(prefers-reduced-motion:reduce){.ken-bedtime,.ken-bunny,.ken-bedtime-with-pug .ken-pug,.ken-bedtime-with-pug .ken-petting-paw{animation:none}}
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
      const phrase = random();
      const withPug = random() < 0.3;
      const lines = withPug ? pugLines : soloLines;
      const line = lines[Math.floor(phrase * lines.length) % lines.length];
      root = doc.createElement("aside");
      root.className = `ken-bedtime${withPug ? " ken-bedtime-with-pug" : ""}`;
      root.setAttribute("role", "status");
      root.setAttribute("aria-live", "polite");
      root.innerHTML = `<div class="ken-bedtime-bubble"><span class="ken-bedtime-line"></span><button type="button" class="ken-bedtime-close" aria-label="Dismiss bedtime reminder">×</button></div><div class="ken-bedtime-friends">${bunnyImage}${pugImage}${pettingPaw}</div>`;
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
