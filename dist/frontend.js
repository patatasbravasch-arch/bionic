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

// src/ken-bunny-pug-asset.ts
var kenBunnyPugDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAeAAAAFPCAYAAACVnh2uAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAP+lSURBVHhe7L0HgBzFtTW8u1rWsp7IAoTIOScRTDI5SyKInDHYYDA5Gww/4PDshyPGBgwmJxNssrEx0eQsiaCAkECBnKO0tcN/z7n3Vt/umRX4e+Bn4741Z+qmqu7p6akz1d3T01ZLLbXUUksttdRSSy211FJLLbXUUksttdRSSy211FJLLbXUUksttfyfSR/BXIIlBKsJlhcsLOgvqKWWWmqppZZaPgeZU9h2nY6OjuGdHR2Hin224D7BBMHrHW1tHwjeFf01wdOCizvb27/Zp6Pju6KfL7hQ2h7d2dm5xqyzztq/bba2/+rqaltM7MESW6ezrQ31fALpppZaaqmlllr+g+WrMrsV0txWGPGXgjGCbsEnHe1tn7RLDXS0t9OW9J72tvZP2kOsDMkj2j4SPCv5T0kN4n5f9GmoBZNFB6mfK8s9SDBMiHlFsbsEtdRSSy211PKll/5CfkcKIY4W9AhIoiBa2BLvFkwXnYAegBiIGnUyPeYJUbOfTOTw0RbkGKDLe0d8j0h9usyWV5bcWmqppZZaavnSSWd7e/seUo8EERoZgjwxQ0XtxOokWyXgGCvpBubHWBUxx2CzbM6eP5Cc02eaqW0ZqfsJviKopZZaaqmlln9fwblYIdx7QHQgXnGBECO5kmBBiq1q1yOq8ZgTfREzyE9Sc2YsOs41jxaMFFwrXxr2lXpeQS211FJLLbX8W0gfmfLuKaR2ueBVI14/xNwrQIifBdU2sW1VF4BgS4DP/THu55lF58zY1vtFwSkCXIVdSy211FJLLf+a0q+tbU4hsJtIYgUyKQKSFgmyyY65FZRIE3VE9FV1h/uqOdEXc6X22TGuwj5dMLegllpqqaWWWv51pL29fVMeblbCwgVQJE7RM3lGiL83VEmZ/s/Ytimv2ibqreIBTvyAz4hfkPqbUtdSSy211FLL/70IQf0y/HQoEmgmNLFLqPpjrmOxxRZLa621Vurfv3/L+P8Gn2U9xM4kLHY3SBgQ+1qxlxPUUksttdRSy/+NdHR0fMdICeSbr1o20ioR2qdh5v790tbDhqYTvvvddP1116eXX345pe7u9PDDD6df//rX6Rv77ptWXHHFNHjwKmmXXXZOZ/76jPTjH/932mqrLdOgQfOmvn37poEDB6a1114rzTHH7C2XIetVgvtmEI+vB7X/vGmqvO49vloflq6lllpqqeWfLJ1CQj8U4OdEIKRMvoDYVSIrYZ65505LL7V0WmSRRdKQIUPSRRdemJ555pnUaDRmiA8/+ih9/PHHTf4pU6akEU8+kV544QXaY8eOSaecekpadNFFS8vtrKDVugGV9Y+vy1+bf+nAjT5+jTt6SV1LLbXUUkstX6j0EfK50ElIkGeIhkxeVaKbc4450+WXX5FemDgxvfXmW+nVV15tIlOA0tNDNHqa458Vr776avre976XVl999dSvb1cT0X4W+Lq77vBD0oDE8LovEawuqKWWWmqppZbPX4R8DhWAeHmxlbgy8UaApCL5LrnkkunGG29qIskeEG3qkdrsBnQF/BCxWKtdxB3aj/bl/TTMD3R3d6eHHnoonXvueenKK69Il112adpt991S364ZkzLWvQr3l+J6hy1gmvjPEeAPJWqppZZaaqnlc5I+bWvL82t23tcPyfKwrPh7xTlnn5PeeecdI0onTJBlQbFVYnWfPRDNBQ1ZQr70qu1yzIh4BnjowQfTeeeem6644vK0ww7bt1x3AK/PEX2VOLaDEzFuubmFxGqppZZaaqnlfy34q8C7wyFXQoimREYRgwYNSmf86tfN5AdytBmrcKUSJhSTglQL3f0uRYsiVsyCxWd1tq0F7er6GA44YP+Wr8MRX2v1NYsdtwm20ccdHW3fkbqWWmqppZZa/t+lo6NjfyOWTDSCTEoO+jo60rHHHZ9eeuklEpuSoJIcyY9EiXO9IEonT9VdSJYaxCPbnkvkYhJiahY24UV0XwePOQnfcOP16Uf//cO0xBKLlwjWX2tvutk8IoDajhJ8IvU3xK6lllpqqaWW/yfpFCJ5CIQiut/DORIP684O1VdeeeVMaN3dpMI8420F0it0L/CFuAL9KKmSyGNMikWbfNRCbpGjXwCg+7pGTJkyOW2++eaZZCOqrzvCcjIJS/2x+LeXupZaaqmlllr+YVlZSOR9P/wsOme/gBMPLriCPXCegenmW24hieHiJ5BciRgDSqSMLHmKcYX5vZRiCpKm6eyIfYUcONkPllnoVcR26PPdd99Nxx17bOrfv58Tawn+2oGqX2qSMG5SIvW74vu21LIJa6mlllpqqeWzy3FOvoCQCWfAopcIaO21186/521JaqhRqGsOyFCUXHuJ7Urw0hTzbqyIkUk59mUxh8bisppnw3/60x/TrLPOmgk2Ir5+t0M8z4Rt+93d3t6+idS11FJLLbXU8qkinNJ2R2X2m2fADpz3ffChB0lYoEHUJLRAeHnGywyyXo6Vcrxtr7Dzx/bs/oLgC5+f52UuAzFWzS3g5IufRaHGF4vf//736bDDDksDBsxZeu18/QHB79sK6LFtiP8mPlLqWmqppZZaapmh4I/qRwhpxBlwlWiIhx9+JBNvJuASWpMdi9ROjj5zVZ/FvWQ/KVXjhLqoa8T8BpTebCmiyKN5nZ2II8aMHpPOO++8NHz48KZt0AKRhPPFWYKTxK6lllpqqaWWXgUE/KQRR4mAHeLjfZgnTZpMghLe4sxRec0IlYQHl9UWy7CCBwRVcQjZonkGjaJeF6bBY21YXBfkQ97MjbGKbTPewiek68vFTUICEX/00UdpzTXXrBJuCb59go3tRxIW+8eCWmqppZZaamkpcwrGCUAYJTIBnGB+8IMfkJRUnLwMvdlVfxUsTpAgwUiMHtM4lCIXUOKMJA5RXWs/3J2/IKAEP/uREmfkjFsMNe5DjftZV7cLgG3j26fizyTc0dFxvPhqqaWWWmqppUlWELxn5y9bkQnrG2+8kYTkPztykisRl1Kc2syCbmTohMeYFj5YqRJj4rF8r83vOhH6FMhTixxdtpJ1QbqseVvMog/mINeAdUCNP4jYbdddm7ZNK2B7gYBF7+YtLDvaetrb2/cVu5ZaaqmllloK6WxrW0UI44PeCLizo4P1fvvtp6QkJAXKhIDI+JxJTSOsTVG/AtKsay3P2jb7yyB5eo7YULRWL3UT1y1CG8gE7LDcBom4jLw0+cKB1w3lggvOT1tsuUXTNoooEXAxE/5ASHgD8dVSSy211FKLSp+2trWkmt5uf7hvBEKInWv82cJ7771PMtJZsBEcyIrEViE3B/Kkljml1L3laLFO0aB1Tgu/PBW6SckPm23Vr3kW6wUqWsPGa4444ogjSqTrCNuO5Cs+J2KQ8LivtLUtIHYttdRSSy1fAvkvwQDBQOIrbfPPNFPb0qID8Mm4P2Pp06ft61Lx7/ekLhEwYTPg1VZdLX3wwUckpenTp2NiqOQWiAvkFO0MJ7xqqeZI4YO+XvoSyJPqSIZoM7hzDm0UsxEsxaT29XXxuAsyPc9zUb/55ptpo4027I18o49EbMD2vVGAe27XUksttdTyry59+/adt7OzbbAQ4TYyiB8h9SGC74l+g2CspEwRTBV9iuAlwXtiAy8JHhb7SiHXbwkxLyP2TIKSdHZ2riY5/sf7PmsriMQIeLPNtyD54O5XIGAlqDKRKUy3GOM5VoERXEs/2xckKNDKLO0+xywfDTTqfjX4UJ8Xi7svHp6GlOKCKgl/+MEHeSYc/xfZwW0XID7+Trijo+1QsWuppZZaavlXlJlmmmlxG6jvkIF7qtQfcfCuovif2hKQW4X08bbgYcE5IPOurq4F+/XrN0CWhdnyq5bjs7UmAllqqaXT22+/KwSkV0IrMQkpAZGc4GcB6SGndygtapX9oU1xhTOqsmgr8VMJBW2kQHIafJYdY56LutcvCb0ArxdfRlYZPJjbB/fJ9u2G2uHbz2xs47fkC9VqUtdSSy211PKvIjJA4z9mLxK8DkLEgA0YOWIAJ0FCF2Si9Nr1AD8HyUPMhJC29Y3Z8sSO9va7pX5N8nqQa8j9RZxxxhlKtEJgTroF8ZZrwskONW3o4fe/AISq+jRHdSzJM1qK+rU/zxTx9kgwiwUO9SsQs0cp7l8qmIcS82nba5WcRx59NC2z7DKl7YTt7Yg+1Lbtx8gXoMXErqWWWmqp5f9S+vRpW0eqm21w/gS12PhXIocToxNqJmIf2CPgM+RcAW6R6P05EXBZtrym9tEHLLboIjz/mUmXdbgq2ogKXCXPWuNJg0zLMcYNpiOIbO9Dxfwag1uhwnzmuDDXkmgixwpj0HS9oWsT9ctT1ltBnpBd2CLYBg888EDq6uzK28m3X6ttaH5s79sFTacEaqmlllpq+edIXxmMfyHgIWaxe0R3cm1JvkDIaRrgAYlFxHzvM/bb1LZq+zlO2H+97TaSjpOPkpKK0FImJtdJWUZYVcTZspN6OV919GYPy7FYXE4Jntsqbsuxnx4xI8fQRmovoud1lIIE7VdjvBpc8M7bb6flll02b6+I6Avb1O8bfZqgllpqqaWWf7IMlIGYs14bjEmK4ouEmRH9gjywo64ixg2lflw3lPrxNtEG+fY1++CDD04fffQxCRPont4dbs4hED2S1KdBea3iYw+FP0rMs5g3ELPklxoBLcygr8jRPI9XfMHOpB3gXxhwHhj63/52W+rbt2/ebhG+TSvAly3cKWt/yamlllpqqeWfIe3t7RvJ4PtEOPTbRIiAxWY4kFdzHNWcYJeIHKi2izoAAu5CjT/kF6y00srpzN/8JpOwo0RcXtw2iItgTJWmHAdEtLId46jdooOKe4jcBnXoS2e2SqIq6M8rLfRaPtIKHShI2Un4zDPP5PaJ2zNuxxbAaYC3Ozs7B0teLbXUUkstX5R0dratKNUlGHyNfEvEC4TBOdse+98g9hP77y3udRWeA2y33bbpnLPPTrfccnMmYScl0pjpEWVSI9sp3cFmK48Xfanf9VDEZro10abqV4cWZMgj+7UR9IKAPVYqFdseSM758XWjvu7669I888xT2k4z2o6ifyL7wn2i408xaqmlllpq+ZylT0dHx9FS857LFfItDdZAHKj996Wt8hwzzzxzS38rxL4dMdYqz30zwjZbb51GjRpFEsIhaf9XIRATaMsJK8N8SmrmM9AXdSs08IyY1aioWT7hBRFkUNii0Er5wbbCh9io1TQ/RTSJVc9h45aWqPHfwvvsvVevh6QjZPviSAQORdd/X1hLLbXU8nlKV1vbYkK49/RGvL2RXNU/26yzpM7OTuog3FUHD05HHnFEuvGGGzjgX3vttenQQw5Np55yajr//AvSrrvulvr168f8hRZcKC2zTPFTGb+oypcR4TlRnxFiu7nnnjs9+qj+Z7DDCUpJqtBZpCaduS+g+D2x2kQpFwabZ58srcjJQa+8FPnUUUSxtBxTXW0omheQW6jA56/XX/sPvv/9pu3l8O0m8FMBH3a0deBnaLXUUksttXwO0ldI927cMEN0DLxOvhx04bPBtzQ4R6y22mrpoosuIsnee++96e67707jxo7jP/T4QN8bRowYke64/Y70yiuvpPfefS9deOGFafCqeuOIVuhtPXpbR/fH+DJLL53uvOOO/HMlRUFKICgX0pgTGuC+WFtMnoo82CHGEmIKNinF4MhxK9YREun3daRutaaoTr9/kYA/PjNWXCH+yCMPp66++vOk3o5kiA/7wnT7cvZE2yxtM0tdSy211FLL/0ZkYP3/Otrbq+TrA29GnJEittzyy6fv/+AH6aqrr+Gfwjt5tQKGfhYjByWDgvCqeO+999JNN92UDj/88LT00kulOeecMy2wwPypo8XFQ464rr6OMebr32W3rcRMfYnF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";

// src/bedtime-reminder.ts
var DEFAULT_BEDTIME = "22:00";
var DEFAULT_WAKE_TIME = "06:00";
function validClockTime(value) {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}
function bedtimeNight(now, bedtime, wakeTime) {
  if (!validClockTime(bedtime) || !validClockTime(wakeTime) || bedtime === wakeTime)
    return null;
  const minute = now.getHours() * 60 + now.getMinutes();
  const start = Number(bedtime.slice(0, 2)) * 60 + Number(bedtime.slice(3));
  const end = Number(wakeTime.slice(0, 2)) * 60 + Number(wakeTime.slice(3));
  const overnight = start > end;
  if (overnight ? minute < start && minute >= end : minute < start || minute >= end)
    return null;
  const night = new Date(now);
  if (overnight && minute < end)
    night.setDate(night.getDate() - 1);
  return `${night.getFullYear()}-${String(night.getMonth() + 1).padStart(2, "0")}-${String(night.getDate()).padStart(2, "0")}`;
}
function createBedtimeGate(options) {
  return {
    check() {
      const { enabled, bedtime, wakeTime } = options.config();
      if (!enabled || !options.hasOpenChat())
        return;
      const now = options.now();
      const night = bedtimeNight(now, bedtime, wakeTime);
      if (!night || options.dismissedNight() === night || options.snoozedUntil() > now.getTime() || options.isVisible())
        return;
      options.show();
    }
  };
}
var soloLines = [
  "I'm sleepy. You should go to bed too.",
  "Maybe you should take melatonin.",
  "Does “one more reply” ever mean one?",
  "The story will still be here tomorrow, promise.",
  "Even bunnies need sleep.",
  "Let’s get cozy and call it a night.",
  "Your pillow misses you.",
  "Sleep is a pretty good plot twist.",
  "You can pick this up tomorrow.",
  "The moon called. It says bedtime.",
  "That last reply can be tomorrow’s first.",
  "Let’s give your eyes a little break.",
  "I’m keeping your spot warm.",
  "You’ve earned a soft landing tonight.",
  "Your blankets are waiting.",
  "I admire your dedication. Your pillow doesn’t.",
  "Your bedtime has been waiting very patiently.",
  "Perhaps the cliffhanger can wait.",
  "No need to finish the whole story tonight.",
  "One more reply sounds suspiciously familiar.",
  "Let’s save some magic for tomorrow.",
  "You can log off without losing the moment.",
  "The chat will be here when you wake up.",
  "Your sleepy bunny recommends a blanket.",
  "I’m not judging. I’m just yawning at you.",
  "I’m about to fall asleep on your keyboard.",
  "Let’s put this adventure on pause.",
  "Even heroes need to recharge.",
  "The next scene can wait until morning.",
  "Come on, let’s call it a night.",
  "Your eyes could use a happy ending tonight.",
  "Wouldn’t a little rest feel nice?",
  "I think your blanket is winning.",
  "One more minute? Famous last words.",
  "I’ll be here when the sun comes up.",
  "Sleep first. Plot twists later."
];
var pugLines = [
  "I'm sleepy. Come rest with us.",
  "The pug’s ready for bed. Are you?",
  "The pug has claimed the pillow. There’s room for you.",
  "I think “one more reply” became a whole chapter.",
  "Maybe you should take melatonin.",
  "The pug voted for sleep. I second that.",
  "Look at those sleepy eyes. We’re outnumbered.",
  "He wants a cuddle break.",
  "The pug and I saved you a cozy spot.",
  "Even your biggest fan needs bedtime.",
  "The pug says the next chapter can wait.",
  "He’s already dreaming of tomorrow’s scene.",
  "Shh. Someone’s almost asleep.",
  "We’re both waiting under the blanket.",
  "He asked for one last pat, not one last reply.",
  "Let’s give this story a soft pause.",
  "Two sleepy faces are looking at you.",
  "The pug has officially clocked out.",
  "His bedtime yawn was a hint.",
  "Come join our little sleep pile.",
  "He’s pretending he’s awake for you.",
  "The pug’s snoring is a gentle suggestion.",
  "Maybe bedtime can be our next adventure.",
  "You can make him the hero again tomorrow."
];
var bunnyImage = `<img class="ken-bunny" src="${kenBunnyDataUrl}" alt="Sleepy bunny lying on the chat textbox" draggable="false">`;
var bunnyPugImage = `<img class="ken-duo" src="${kenBunnyPugDataUrl}" alt="Bunny resting one paw on the sleepy pug's head" draggable="false">`;
var style = `
.ken-bedtime{position:fixed;z-index:2147483000;pointer-events:none;display:flex;flex-direction:column;align-items:flex-start;max-width:min(280px,calc(100vw - 24px));filter:drop-shadow(0 6px 11px rgba(15,12,18,.17));animation:ken-arrive-left .8s cubic-bezier(.2,.9,.25,1) both}
.ken-bedtime-bubble{position:relative;max-width:250px;min-width:190px;margin-left:22px;padding:11px 13px;border:2px solid #373037;border-radius:16px 19px 15px 6px;background:#fffefa;color:#302a30;font:600 14px/1.35 system-ui,sans-serif;pointer-events:auto}
.ken-bedtime-bubble::after{content:"";position:absolute;left:20px;bottom:-8px;width:13px;height:13px;background:#fffefa;border-right:2px solid #373037;border-bottom:2px solid #373037;transform:rotate(45deg)}
.ken-bedtime-actions{display:grid;gap:7px;margin-top:10px;font:500 12px/1.3 system-ui,sans-serif}
.ken-bedtime-snooze-label{display:flex;align-items:center;gap:5px;white-space:nowrap}
.ken-bedtime-minutes{width:45px;padding:3px 4px;border:1px solid #a897a2;border-radius:6px;background:#fff;color:#302a30;font:inherit;text-align:center}
.ken-bedtime-actions button{padding:5px 7px;border:1px solid #ad9aa6;border-radius:7px;background:#f7e8ee;color:#302a30;font:600 12px/1.25 system-ui,sans-serif;cursor:pointer}
.ken-bedtime-actions .ken-bedtime-dismiss{background:transparent}
.ken-bedtime-actions button:focus-visible,.ken-bedtime-minutes:focus-visible{outline:2px solid #705361;outline-offset:2px}
.ken-bedtime-friends{position:relative;display:flex;align-items:flex-end;flex:none;margin-top:2px}
.ken-bunny{width:88px;height:90px;object-fit:contain;display:block;transform-origin:50% 85%;animation:ken-breathe 2.3s ease-in-out infinite alternate}
.ken-duo{width:142px;height:99px;object-fit:contain;display:block;transform-origin:50% 85%;animation:ken-breathe 2.3s ease-in-out infinite alternate}
@keyframes ken-arrive-left{from{transform:translateX(calc(-100vw - 300px))}to{transform:translateX(0)}}
@keyframes ken-breathe{to{transform:scaleY(.97)}}
@media(prefers-reduced-motion:reduce){.ken-bedtime,.ken-bunny,.ken-duo{animation:none}}
`;
function createBedtimeCompanion(doc, options) {
  const random = options.random ?? Math.random;
  const css = doc.createElement("style");
  css.textContent = style;
  doc.head.append(css);
  let root = null;
  const bags = { solo: [], pug: [] };
  const last = { solo: -1, pug: -1 };
  const nextLine = (withPug) => {
    const kind = withPug ? "pug" : "solo";
    const lines = withPug ? pugLines : soloLines;
    if (!bags[kind].length) {
      const bag = lines.map((_, index) => index);
      for (let index = bag.length - 1;index > 0; index--) {
        const swap = Math.floor(random() * (index + 1));
        [bag[index], bag[swap]] = [bag[swap], bag[index]];
      }
      if (bag.length > 1 && bag[bag.length - 1] === last[kind]) {
        [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]];
      }
      bags[kind] = bag;
    }
    const picked = bags[kind].pop();
    last[kind] = picked;
    return lines[picked];
  };
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
      const withPug = random() < 0.3;
      const line = nextLine(withPug);
      root = doc.createElement("aside");
      root.className = `ken-bedtime${withPug ? " ken-bedtime-with-pug" : ""}`;
      root.setAttribute("role", "region");
      root.setAttribute("aria-label", "Bedtime reminder");
      root.setAttribute("aria-live", "polite");
      root.innerHTML = `<div class="ken-bedtime-bubble"><span class="ken-bedtime-line"></span><div class="ken-bedtime-actions"><label class="ken-bedtime-snooze-label">Come back in <input class="ken-bedtime-minutes" type="number" min="1" max="120" step="1" aria-label="Minutes until bunny returns"> min</label><button type="button" class="ken-bedtime-snooze">Snooze</button><button type="button" class="ken-bedtime-dismiss">Dismiss tonight</button></div></div><div class="ken-bedtime-friends">${withPug ? bunnyPugImage : bunnyImage}</div>`;
      root.querySelector(".ken-bedtime-line").textContent = line;
      const minutesInput = root.querySelector(".ken-bedtime-minutes");
      minutesInput.value = String(Math.min(120, Math.max(1, Math.round(options.snoozeMinutes()))));
      root.querySelector(".ken-bedtime-snooze").addEventListener("click", () => {
        const minutes = Math.min(120, Math.max(1, Math.round(Number(minutesInput.value) || options.snoozeMinutes())));
        if (!preview)
          options.onSnooze(minutes);
        remove();
      });
      root.querySelector(".ken-bedtime-dismiss").addEventListener("click", () => {
        if (!preview)
          options.onDismiss();
        remove();
      });
      doc.body.append(root);
      position();
      doc.defaultView?.addEventListener("resize", position);
      doc.defaultView?.addEventListener("scroll", position, true);
    },
    hide: remove,
    destroy() {
      remove();
      css.remove();
    }
  };
}

// src/reading-presets.ts
var READING_PRESET_KEYS = [
  "bionicEnabled",
  "density",
  "fixation",
  "weight",
  "fontEnabled",
  "font",
  "customFont",
  "scopeMessages",
  "scopeBubble",
  "scopeComposer",
  "scopeMenus",
  "scopeNavigation",
  "scopeAll",
  "justifyMessages",
  "hyphenateMessages",
  "readingWidth",
  "paragraphSpacing",
  "letterSpacing",
  "wordSpacing",
  "textSize",
  "lineHeight"
];
function readingPresetValues(settings) {
  return Object.fromEntries(READING_PRESET_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(settings, key)).map((key) => [key, settings[key]]));
}
function normalizeReadingPresets(raw) {
  if (!Array.isArray(raw))
    return [];
  const names = new Set;
  const ids = new Set;
  const result = [];
  for (const item of raw) {
    if (result.length >= 30)
      break;
    if (!item || typeof item !== "object")
      continue;
    const id = typeof item.id === "string" ? item.id : "";
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!/^[a-z0-9-]{1,50}$/.test(id) || !name || name.length > 40)
      continue;
    if (!item.values || typeof item.values !== "object" || Array.isArray(item.values))
      continue;
    const folded = name.toLocaleLowerCase();
    if (ids.has(id) || names.has(folded))
      continue;
    ids.add(id);
    names.add(folded);
    result.push({ id, name, values: readingPresetValues(item.values) });
  }
  return result;
}
function saveReadingPreset(presets, name, settings, newId) {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 40)
    throw new Error("Give the setup a name of 1–40 characters.");
  const existing = presets.find((preset) => preset.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase());
  if (!existing && presets.length >= 30)
    throw new Error("You can save up to 30 reading setups.");
  const id = existing?.id ?? newId();
  if (!/^[a-z0-9-]{1,50}$/.test(id) || !existing && presets.some((preset) => preset.id === id)) {
    throw new Error("Could not create a unique setup. Please try again.");
  }
  const saved = { id, name: trimmed, values: readingPresetValues(settings) };
  return {
    preset: saved,
    presets: existing ? presets.map((preset) => preset.id === existing.id ? saved : preset) : [...presets, saved]
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
    savedPresets: [],
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
    bedtimeReminderEnabled: false,
    bedtimeReminderTime: DEFAULT_BEDTIME,
    bedtimeReminderUntil: DEFAULT_WAKE_TIME,
    bedtimeSnoozeMinutes: 15,
    bedtimeSnoozedUntil: 0,
    bedtimeDismissedNight: null,
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
      const savedPresets = normalizeReadingPresets(saved.savedPresets);
      return {
        ...DEFAULTS,
        preset: ["custom", "clean", "comfortable", "mobile", "bionicLight"].includes(saved.preset) || savedPresets.some((preset) => saved.preset === `saved:${preset.id}`) ? saved.preset : "custom",
        savedPresets,
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
        bedtimeReminderEnabled: saved.bedtimeReminderEnabled === true,
        bedtimeReminderTime: validClockTime(saved.bedtimeReminderTime) ? saved.bedtimeReminderTime : DEFAULT_BEDTIME,
        bedtimeReminderUntil: validClockTime(saved.bedtimeReminderUntil) ? saved.bedtimeReminderUntil : DEFAULT_WAKE_TIME,
        bedtimeSnoozeMinutes: Math.round(clamp(saved.bedtimeSnoozeMinutes, 1, 120, 15)),
        bedtimeSnoozedUntil: typeof saved.bedtimeSnoozedUntil === "number" && Number.isFinite(saved.bedtimeSnoozedUntil) && saved.bedtimeSnoozedUntil > 0 ? saved.bedtimeSnoozedUntil : 0,
        bedtimeDismissedNight: typeof saved.bedtimeDismissedNight === "string" && /^\d{4}-\d{2}-\d{2}$/.test(saved.bedtimeDismissedNight) ? saved.bedtimeDismissedNight : null,
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
      bedtimeSettingsReady = true;
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
      margin: 0;
      padding: 8px 10px !important;
      border-top: 0 !important;
      background: color-mix(in srgb, var(--lumiverse-bg, #080812) 92%, transparent);
      border: 1px solid rgba(255,255,255,.14);
      border-radius: 10px;
    }

    .lumibionic-preview-section.lumibionic-preview-visible {
      position: sticky;
      top: 60px;
      z-index: 5;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      box-shadow: 0 8px 24px rgba(0,0,0,.28);
    }

    .lumibionic-preview-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 0;
    }

    .lumibionic-preview-visible .lumibionic-preview-toolbar { margin-bottom: 8px; }

    .lumibionic-reading-quick {
      padding: 12px;
      border: 1px solid color-mix(in srgb, var(--lumiverse-primary, #7c9bc8) 32%, transparent);
      border-radius: 10px;
      background: color-mix(in srgb, var(--lumiverse-primary, #7c9bc8) 7%, transparent);
      display: grid;
      gap: 3px;
    }

    .lumibionic-reading-quick label { font-weight: 700; }

    #lb-preset-status:empty { display: none; }

    .lumibionic-preview-toolbar strong {
      font-size: 13px;
    }

    .lumibionic-preview-toolbar button {
      width: auto !important;
      padding: 6px 9px !important;
      font-size: 12px;
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

    .lumibionic-toolbar-actions.lumibionic-single-action { grid-template-columns: 1fr; }

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
    .lumibionic-settings input[type="time"],
    .lumibionic-settings input[type="number"],
    .lumibionic-settings input[type="file"],
    .lumibionic-settings textarea,
    .lumibionic-settings button {
      width: 100%;
      box-sizing: border-box;
    }

    .lumibionic-settings select,
    .lumibionic-settings input[type="text"],
    .lumibionic-settings input[type="time"],
    .lumibionic-settings input[type="number"],
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

    #lb-bedtime-options { display: grid; gap: 12px; }

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
    const savedPreset = settings.savedPresets.find((preset) => name === `saved:${preset.id}`);
    const values = PRESETS[name] || savedPreset && readingPresetValues(savedPreset.values);
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
    presetName.value = savedPreset?.name || "";
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
      <div class="lumibionic-reading-quick">
        <div class="lumibionic-row">
          <label for="lb-bionic-enabled">Bionic Reading</label>
          <input id="lb-bionic-enabled" type="checkbox">
        </div>
        <div class="lumibionic-muted">Bold word beginnings in chat text.</div>
      </div>

      <div class="lumibionic-section">

        <div class="lumibionic-section-title">
          Reading setups
        </div>

        <div class="lumibionic-control">
          <label for="lb-preset">Choose a setup</label>
          <select id="lb-preset">
            <option value="custom">Current settings</option>
            <optgroup label="Starting points">
              <option value="clean">Clean — minimal changes</option>
              <option value="comfortable">Comfortable — long-form</option>
              <option value="mobile">Mobile — touch-friendly reading</option>
              <option value="bionicLight">Light Bionic Reading</option>
            </optgroup>
            <optgroup label="Your saved setups" id="lb-saved-presets"></optgroup>
          </select>
          <div class="lumibionic-muted">
            Built-ins are starting points; your saved setups are reusable.
          </div>
        </div>

        <div class="lumibionic-toolbar-actions">
          <button type="button" id="lb-preset-new">Save current</button>
          <button type="button" id="lb-preset-delete" disabled>Delete selected</button>
        </div>
        <div class="lumibionic-control lumibionic-hidden" id="lb-preset-save-panel">
          <label for="lb-preset-name">Setup name</label>
          <input id="lb-preset-name" type="text" maxlength="40" placeholder="For example, evening reading">
          <div class="lumibionic-toolbar-actions">
            <button type="button" id="lb-preset-save">Save setup</button>
            <button type="button" id="lb-preset-cancel">Cancel</button>
          </div>
        </div>
        <div class="lumibionic-muted" id="lb-preset-status" role="status" aria-live="polite"></div>

      </div>

      <div class="lumibionic-section">

        <div class="lumibionic-section-title">
          Bionic details
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

      <details class="lumibionic-group" data-lumibionic-group="Bedtime reminder">
        <summary>Bedtime reminder</summary>
        <div class="lumibionic-group-body">
          <div class="lumibionic-section">
            <label class="lumibionic-check">
              <input id="lb-bedtime-enabled" type="checkbox">
              <span>Let the sleepy bunny remind me to rest</span>
            </label>
            <div id="lb-bedtime-options">
              <div class="lumibionic-control">
                <label for="lb-bedtime-time">Bedtime</label>
                <input id="lb-bedtime-time" type="time">
              </div>
              <div class="lumibionic-control">
                <label for="lb-bedtime-until">End bedtime hours</label>
                <input id="lb-bedtime-until" type="time">
              </div>
              <div class="lumibionic-control">
                <label for="lb-bedtime-snooze">Default snooze (minutes)</label>
                <input id="lb-bedtime-snooze" type="number" min="1" max="120" step="1">
              </div>
            </div>
            <div class="lumibionic-muted" id="lb-bedtime-status">
              The bunny stays until you snooze or dismiss it for tonight. Uses this device’s clock.
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
  const savedPresetGroup = $("#lb-saved-presets");
  const presetNew = $("#lb-preset-new");
  const presetSavePanel = $("#lb-preset-save-panel");
  const presetName = $("#lb-preset-name");
  const presetSave = $("#lb-preset-save");
  const presetCancel = $("#lb-preset-cancel");
  const presetDelete = $("#lb-preset-delete");
  const presetStatus = $("#lb-preset-status");
  presetName.value = settings.savedPresets.find((saved) => settings.preset === `saved:${saved.id}`)?.name || "";
  function showPresetSavePanel(open) {
    presetSavePanel.classList.toggle("lumibionic-hidden", !open);
    presetNew.setAttribute("aria-expanded", String(open));
    if (open)
      presetName.focus();
  }
  const bionicEnabled = $("#lb-bionic-enabled");
  const bionicOptions = $("#lb-bionic-options");
  const bionicDetailsSection = bionicOptions.closest(".lumibionic-section");
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
  const bedtimeEnabled = $("#lb-bedtime-enabled");
  const bedtimeTime = $("#lb-bedtime-time");
  const bedtimeUntil = $("#lb-bedtime-until");
  const bedtimeSnooze = $("#lb-bedtime-snooze");
  const bedtimeOptions = $("#lb-bedtime-options");
  const bedtimeStatus = $("#lb-bedtime-status");
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
  try {
    const compactReadingKey = `${UI_STATE_KEY}:compact-reading-v04831`;
    if (localStorage.getItem(compactReadingKey) !== "1") {
      uiState = { ...uiState, previewVisible: false, sections: {} };
      localStorage.setItem(UI_STATE_KEY, JSON.stringify(uiState));
      localStorage.setItem(compactReadingKey, "1");
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
      "Bedtime reminder": "tools"
    };
    const textSection = settingsRoot.querySelector("#lb-size")?.closest(".lumibionic-section");
    const bionicSection = settingsRoot.querySelector("#lb-bionic-options")?.closest(".lumibionic-section");
    if (textSection && bionicSection)
      bionicSection.before(textSection);
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
    const sectionNames = {
      "Bionic details": "Bionic details",
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
      if (section.closest(".lumibionic-group")?.dataset.lumibionicCategory !== "reading" || title.textContent.trim() === "Reading setups") {
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
  function syncReadingSetups() {
    savedPresetGroup.replaceChildren();
    for (const saved of settings.savedPresets) {
      const option = document.createElement("option");
      option.value = `saved:${saved.id}`;
      option.textContent = saved.name;
      savedPresetGroup.append(option);
    }
    preset.value = settings.preset || "custom";
    if (preset.value !== settings.preset)
      preset.value = "custom";
    const canDelete = settings.savedPresets.some((saved) => preset.value === `saved:${saved.id}`);
    presetDelete.disabled = !canDelete;
    presetDelete.classList.toggle("lumibionic-hidden", !canDelete);
    presetNew.parentElement.classList.toggle("lumibionic-single-action", !canDelete);
    const name = presetName.value.trim().toLocaleLowerCase();
    const exists = settings.savedPresets.some((saved) => saved.name.toLocaleLowerCase() === name);
    presetSave.textContent = exists ? "Update saved setup" : "Save current setup";
  }
  function syncControls() {
    syncReadingSetups();
    bionicEnabled.checked = settings.bionicEnabled;
    bionicOptions.classList.toggle("lumibionic-hidden", !settings.bionicEnabled);
    bionicDetailsSection.classList.toggle("lumibionic-hidden", !settings.bionicEnabled);
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
    bedtimeEnabled.checked = settings.bedtimeReminderEnabled;
    bedtimeTime.value = settings.bedtimeReminderTime;
    bedtimeUntil.value = settings.bedtimeReminderUntil;
    bedtimeSnooze.value = String(settings.bedtimeSnoozeMinutes);
    bedtimeOptions.classList.toggle("lumibionic-hidden", !settings.bedtimeReminderEnabled);
    bedtimeStatus.textContent = settings.bedtimeReminderEnabled ? settings.bedtimeReminderTime === settings.bedtimeReminderUntil ? "Choose different bedtime and stop times." : "The bunny stays until you snooze or dismiss it for tonight. It returns after snooze while a chat is open and bedtime hours remain." : "Off until you enable it.";
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
  preset.addEventListener("change", () => {
    showPresetSavePanel(false);
    applyPreset(preset.value);
  });
  presetNew.addEventListener("click", () => showPresetSavePanel(true));
  presetCancel.addEventListener("click", () => showPresetSavePanel(false));
  presetName.addEventListener("keydown", (event) => {
    if (event.key === "Enter")
      presetSave.click();
    if (event.key === "Escape")
      showPresetSavePanel(false);
  });
  presetName.addEventListener("input", syncReadingSetups);
  let savedPresetNonce = 0;
  presetSave.addEventListener("click", () => {
    try {
      const result = saveReadingPreset(settings.savedPresets, presetName.value, settings, () => `${Date.now().toString(36)}-${(++savedPresetNonce).toString(36)}`);
      const updated = settings.savedPresets.some((saved) => saved.id === result.preset.id);
      settings = {
        ...settings,
        savedPresets: result.presets,
        preset: `saved:${result.preset.id}`
      };
      saveSettings();
      syncControls();
      showPresetSavePanel(false);
      presetStatus.textContent = `${updated ? "Updated" : "Saved"} “${result.preset.name}”.`;
    } catch (error) {
      presetStatus.textContent = error instanceof Error ? error.message : "Could not save this setup.";
    }
  });
  presetDelete.addEventListener("click", () => {
    const selected = settings.savedPresets.find((saved) => preset.value === `saved:${saved.id}`);
    if (!selected || !window.confirm(`Delete the saved setup “${selected.name}”?`))
      return;
    settings = {
      ...settings,
      preset: "custom",
      savedPresets: settings.savedPresets.filter((saved) => saved.id !== selected.id)
    };
    presetName.value = "";
    saveSettings();
    syncControls();
    presetStatus.textContent = `Deleted “${selected.name}”. Your current reading settings stay in place.`;
  });
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
      bedtimeSettingsReady = false;
      requestAccountSettings();
    } else if (settingsSaveStatus) {
      bedtimeSettingsReady = true;
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
      savedPresets: settings.savedPresets,
      toolbarHidden: { ...DEFAULT_TOOLBAR_HIDDEN }
    };
    presetName.value = "";
    presetStatus.textContent = "Reading controls restored. Your saved setups are still available.";
    saveSettings();
    applyCssSettings();
    syncControls();
    rebuildAll();
    renderPreview();
  });
  syncFFThinkBackendConfig();
  let bedtimeSettingsReady = settings.settingsPersistenceMode !== "account";
  let bedtimeModal = null;
  let bedtimeCompanion = null;
  function dismissBedtimeTonight() {
    const night = bedtimeNight(new Date, settings.bedtimeReminderTime, settings.bedtimeReminderUntil);
    if (!night)
      return;
    settings.bedtimeDismissedNight = night;
    settings.bedtimeSnoozedUntil = 0;
    saveSettings();
  }
  function snoozeBedtime(minutes) {
    settings.bedtimeSnoozeMinutes = minutes;
    settings.bedtimeSnoozedUntil = Date.now() + minutes * 60000;
    saveSettings();
    syncControls();
    scheduleBedtimeCheck();
  }
  function showBedtimeReminder() {
    if (bedtimeModal || bedtimeCompanion?.isVisible())
      return;
    try {
      bedtimeCompanion ||= createBedtimeCompanion(document, {
        onDismiss: dismissBedtimeTonight,
        onSnooze: snoozeBedtime,
        snoozeMinutes: () => settings.bedtimeSnoozeMinutes
      });
      bedtimeCompanion.show();
      return;
    } catch (error) {
      console.warn("[Lumi Toolkit] Bedtime bunny could not appear:", error);
    }
    try {
      const modal = ctx.ui.showModal({ title: "Bedtime reminder", width: 380, maxHeight: 280, persistent: false });
      const message = document.createElement("div");
      message.textContent = "I'm sleepy. You should go to bed too.";
      message.style.cssText = "padding:18px 8px;font-size:1.15rem;font-weight:700;line-height:1.45;text-align:center";
      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px";
      const minutes = document.createElement("input");
      minutes.type = "number";
      minutes.min = "1";
      minutes.max = "120";
      minutes.value = String(settings.bedtimeSnoozeMinutes);
      minutes.setAttribute("aria-label", "Minutes until bunny returns");
      minutes.style.width = "55px";
      const snoozeLabel = document.createElement("label");
      snoozeLabel.textContent = "Come back in ";
      snoozeLabel.append(minutes, document.createTextNode(" minutes"));
      const snooze = document.createElement("button");
      snooze.type = "button";
      snooze.textContent = "Snooze";
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.textContent = "Dismiss tonight";
      actions.append(snoozeLabel, snooze, dismiss);
      modal.root.append(message, actions);
      bedtimeModal = modal;
      let snoozing = false;
      modal.onDismiss(() => {
        if (bedtimeModal !== modal)
          return;
        bedtimeModal = null;
        if (!snoozing && settings.bedtimeReminderEnabled)
          dismissBedtimeTonight();
      });
      snooze.addEventListener("click", () => {
        const delay = Math.min(120, Math.max(1, Math.round(Number(minutes.value) || settings.bedtimeSnoozeMinutes)));
        snoozing = true;
        snoozeBedtime(delay);
        modal.dismiss();
      });
      dismiss.addEventListener("click", () => modal.dismiss());
    } catch (error) {
      console.warn("[Lumi Toolkit] Bedtime reminder failed:", error);
    }
  }
  const bedtimeGate = createBedtimeGate({
    now: () => new Date,
    config: () => ({
      enabled: bedtimeSettingsReady && settings.bedtimeReminderEnabled,
      bedtime: settings.bedtimeReminderTime,
      wakeTime: settings.bedtimeReminderUntil
    }),
    hasOpenChat: () => document.visibilityState !== "hidden" && Boolean(ctx.getActiveChat?.()?.chatId) && Boolean(document.querySelector('[data-component="InputArea"]')),
    dismissedNight: () => settings.bedtimeDismissedNight,
    snoozedUntil: () => settings.bedtimeSnoozedUntil,
    isVisible: () => Boolean(bedtimeModal || bedtimeCompanion?.isVisible()),
    show: showBedtimeReminder
  });
  let bedtimeCheckTimer = null;
  function checkBedtimeReminder() {
    bedtimeGate.check();
  }
  function scheduleBedtimeCheck() {
    if (bedtimeCheckTimer)
      clearTimeout(bedtimeCheckTimer);
    checkBedtimeReminder();
    const now = Date.now();
    const minuteDelay = 60050 - now % 60000;
    const snoozeDelay = settings.bedtimeSnoozedUntil > now ? settings.bedtimeSnoozedUntil - now + 50 : Infinity;
    bedtimeCheckTimer = setTimeout(scheduleBedtimeCheck, Math.min(minuteDelay, snoozeDelay));
  }
  bedtimeEnabled.addEventListener("change", () => {
    settings.bedtimeReminderEnabled = bedtimeEnabled.checked;
    if (!settings.bedtimeReminderEnabled) {
      bedtimeCompanion?.hide();
      bedtimeModal?.dismiss();
    }
    saveSettings();
    syncControls();
    checkBedtimeReminder();
  });
  for (const [control, key] of [
    [bedtimeTime, "bedtimeReminderTime"],
    [bedtimeUntil, "bedtimeReminderUntil"]
  ]) {
    control.addEventListener("change", () => {
      if (!validClockTime(control.value)) {
        syncControls();
        return;
      }
      settings[key] = control.value;
      saveSettings();
      syncControls();
      checkBedtimeReminder();
    });
  }
  bedtimeSnooze.addEventListener("change", () => {
    settings.bedtimeSnoozeMinutes = Math.min(120, Math.max(1, Math.round(Number(bedtimeSnooze.value) || 15)));
    saveSettings();
    syncControls();
  });
  document.addEventListener("visibilitychange", checkBedtimeReminder);
  window.addEventListener("focus", checkBedtimeReminder);
  scheduleBedtimeCheck();
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
          bedtimeSettingsReady = true;
          presetName.value = settings.savedPresets.find((saved) => settings.preset === `saved:${saved.id}`)?.name || "";
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
        checkBedtimeReminder();
      } else {
        bedtimeSettingsReady = true;
        if (settings.settingsPersistenceMode === "account") {
          saveSettings();
        }
        checkBedtimeReminder();
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
    if (bedtimeCheckTimer)
      clearTimeout(bedtimeCheckTimer);
    document.removeEventListener("visibilitychange", checkBedtimeReminder);
    window.removeEventListener("focus", checkBedtimeReminder);
    bedtimeCompanion?.destroy();
    bedtimeCompanion = null;
    if (bedtimeModal) {
      try {
        const modal = bedtimeModal;
        bedtimeModal = null;
        modal.dismiss();
      } catch {}
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
