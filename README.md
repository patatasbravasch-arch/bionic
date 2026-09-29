# Lumiverse Bionic-style Reading

An unofficial Spindle extension for Lumiverse that adds a Bionic-style fixation effect to rendered chat prose.

Example:

- `Lumiverse makes reading easier.`
- becomes visually similar to **Lumiv**erse **mak**es **read**ing **eas**ier.

The extension only changes the rendered version of a message. Stored chat content, generation prompts, memories, embeddings, and exports remain unchanged.

> This project is not affiliated with or endorsed by Bionic Reading®.

## Why this implementation

Lumiverse staging exposes a `registerMessageContentProcessor` hook with `origin === "render"`. That is a better fit than rewriting mounted DOM nodes because it follows Lumiverse's own message render lifecycle and survives virtualized message mounting/unmounting automatically.

The transform is deliberately conservative. It rewrites normal prose while preserving:

- fenced code blocks
- inline code
- Markdown image syntax
- Markdown link destinations and raw URLs
- raw HTML elements / Lumiverse HTML islands
- HTML entities
- Markdown escapes

Markdown link *labels* are transformed because they are visible prose.

## Files

```text
spindle.json
src/
  backend.ts
  frontend.ts
  transform.ts
dist/
  backend.js
  frontend.js
  transform.js
package.json
tsconfig.json
```

## Before publishing

Edit `spindle.json` and replace:

- `YOUR_NAME`
- `YOUR_USERNAME`

with your actual author name and GitHub username/repository URL.

## Build

Lumiverse can auto-build from `src/`, but for a normal local build:

```bash
bun install
bun run build
```

The official Spindle TypeScript package is included as a dev dependency for editor/type support.

## Install in Lumiverse

1. Push the extension to a GitHub repository.
2. In Lumiverse staging, open the Extensions panel.
3. Install the repository URL.
4. Approve the `chat_mutation` permission.
5. Enable the extension and open/re-open a chat.

## Tuning the fixation amount

The current rule bolds roughly the first 50% of each word (single-letter words are left alone).

To change it, edit `fixationLength()` in `src/transform.ts`:

```ts
return Math.max(1, Math.ceil(length * 0.5))
```

For a lighter effect, try `0.4`; for a stronger effect, try `0.6`.

The visual weight is controlled in `src/frontend.ts`:

```css
.lumibionic-fix {
  font-weight: 700;
}
```

Try `600` for a subtler contrast.

## Notes

- The backend keeps a small render cache because Lumiverse currently invokes render processing twice per visible message.
- The cache is cleared on chat/message edit, swipe, and delete lifecycle events.
- The extension does not make network requests and does not need any permissions besides the one required by Lumiverse's message-content-processor API.

## Library tools

Open **Bionic → Library → Open library** to manage characters and lorebooks in one window.

### Character folders

Choose **Characters → Folders → Scan characters**, then group by **Author** or **Tag**. Groups use the author and tags saved on each card; empty metadata and archived duplicates are excluded. Each group needs at least two bots. Select groups, rename the proposed folders if needed, and choose **Preview folder moves**. The preview lists every bot and its current and destination folder. Apply the preview to create the folders and move the bots.

**Only bots without a folder** is enabled by default. Disable it explicitly to reorganize bots already in folders. A bot with several selected tags goes into the most common selected tag's folder, with an alphabetical tie-break. Both the preview and the updates use that same plan. Cards changed or moved since the preview stop the remaining updates. Only the folder field is changed.

### Character duplicates

Choose **Characters → Duplicates → Scan characters**. Duplicate groups show thumbnails and a keeper selector. **Compare copies** opens a full-width side-by-side view with selectors for the left and right cards and an **Only differences** toggle. Choose which copy to keep, edit either card, ignore cards or delete unused copies.

**Edit** provides name, author, folder, tags, description, personality, scenario, opening messages, alternate greetings, example messages, author notes and prompt fields. Saving updates only changed fields and rejects stale edits.

**Ignore** leaves cards usable and in their current folder, while excluding them from future duplicate scans. **Ignore group** excludes the whole group. Use **Ignored → Include in scans again** to reverse that decision.

**Delete** permanently removes the selected copies after confirmation. The keeper is retained. Cards used in primary or group chats are protected because Lumiverse's character deletion also removes linked chats. Both card snapshots, names, folders and all chat references are checked before any deletion, and again before each copy is removed. Only identical unused copies can be bulk-selected automatically; reviewed versions can be selected from the comparison view. Character-owned assets may be removed by Lumiverse when deleting a card.

Cards archived by earlier versions remain restorable under **Previously archived**, which is shown only when such cards exist.

### Lorebooks

Select the main **Lorebooks** tab, then use **All books**, **Duplicates**, **Similar names** and **Unlinked books** to inspect books, check references and assign folders manually. These controls appear only in the Lorebooks section. Character, chat, persona and global lorebook references are checked during cleanup.

Run `bun install` followed by `bun test` for regression tests.
