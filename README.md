# Lumi Toolkit

Lumi Toolkit is an unofficial Lumiverse Spindle extension for reading, chat controls, and library cleanup. It puts its controls in one drawer tab with **Reading**, **Toolbar**, **Library**, and **Tools** sections.

## Install

1. In Lumiverse, open **Extensions** and install `https://github.com/patatasbravasch-arch/bionic`.
2. Review the permissions Lumiverse requests, then enable the extension.
3. Reload Lumiverse and open the **Lumi Toolkit** drawer tab.

If you already use the extension, update it through Lumiverse and reload. The extension keeps its existing internal identifier so your installed copy and saved settings continue to work. The GitHub repository remains at `/bionic`.

## Reading

The Reading tab keeps the **Bionic Reading** switch and setup picker at the top. Open **Text size & spacing**, **Bionic details**, **Font**, or **Layout** when you need finer controls. Choose an optional starting point or save your own named setup to reuse later. **Show preview** opens a live sample that stays near the top while you tune it. Your current settings and saved setups follow your choice of account or browser storage.

Bionic Reading changes rendered chat text. It does not rewrite stored messages, prompts, or exports. Code and links are preserved. This project is not affiliated with or endorsed by Bionic Reading®.

## Toolbar

Show or hide individual chat toolbar buttons and adjust their spacing. The controls cover the usual chat actions, including regeneration, continuation, persona, connection, attachments, and customization. Hidden buttons can be shown again from this section.

## Library

Open **Library → Open library**. The window has separate **Characters** and **Lorebooks** tabs; lorebook tools appear only on the Lorebooks tab.

### Characters

- **Duplicates:** Scan cards with matching names, compare copies side by side, choose which card to keep, and edit or ignore copies. **Delete** opens a **Yes, delete / No, keep it** prompt for one unused copy. Deletion is permanent; cards linked to primary or group chats are protected and checked again before deletion. Ignored cards can be included in scans again from the **Ignored** tab.
- **Folders:** Scan characters, group suggestions by **Author** or **Tag**, and use **Select this folder** only for the folders you want. You can rename each proposed folder. **Don’t suggest this tag/author** saves an exclusion to your account; expand **Excluded tags/authors** to restore a suggestion. **Preview folder moves** shows every planned destination before you apply it. By default, only cards without a folder are eligible.

No character folders are created by scanning or previewing. Confirmed moves change only the folder field.

### Lorebooks

Use **All books**, **Duplicates**, **Similar names**, and **Unlinked books** to inspect entries, review references, and organize lorebooks manually. Cleanup checks character, chat, persona, and global references. Review the proposed change and its confirmation before applying it.

## Tools

- **Reasoning repair:** Move text before or after a configurable boundary marker into Lumiverse's native reasoning field. You can run it on the latest reply or enable automatic repair.
- **Auto regenerate:** Regenerate completed replies containing your chosen trigger text, up to your retry limit. This is off until you enable it.
- **Bedtime reminder:** Turn on the sleepy bunny, choose your bedtime and stop time, and it will visit while a chat is open. The bunny stays until you choose **Dismiss tonight** or **Snooze**. Set the return delay in minutes on the bunny, or change its default in Tools. After snoozing, it returns when that time passes if bedtime hours are still active. It uses your device’s local clock, works with any persona, and is off until you enable it.
- **Menu Folder:** Move supported Lumiverse drawer items into one Folder entry and restore them later.

Reasoning repair and auto regenerate can change saved chat messages or trigger generation. Read their settings before enabling them.

## Build from source

```bash
bun install
bun test
bun run build
```

`spindle.json` is the extension manifest; `src/` contains the source and `dist/` contains the built frontend and backend. The extension's internal identifier remains `bionic_style_reading` for update compatibility.
