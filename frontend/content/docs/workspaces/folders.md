---
title: Folders
description: File a workspace's documents into folders. On your own domain, a folder becomes part of each link, like docs.acme.com/guides/setup.
updated: 2026-11-05
prerequisites: [/workspaces/create]
keywords: [folder, subfolder, move, rename, delete folder, organize, redirect, on_conflict, path, address, list view, grid view, cards, owner]
---

Folders keep a workspace tidy, and on your own domain they shape the address. A document filed under **Guides › Setup** is served at `docs.acme.com/guides/setup/<document>`.

Folders decide where something appears and what its address is. They never decide who can open it: that stays with each item's own setting and the workspace's [privacy](/workspaces/privacy).

## Browse a workspace

Open a workspace from the sidebar to see its folders first, then the items filed at the top. Open a folder to see what's inside it. Folders open straight away, even on a slow connection: the folder's name and subfolders show at once, and its items follow.

The list stays current while it's open. A page you rename in another tab shows its new name here straight away, and what other people rename, add or move shows within half a minute, or as soon as you come back to the tab. You don't need to reload.

Choose how the list looks with the switch above it. Markdrop remembers your choice on this device, for every workspace and folder.

| View | What you see |
| --- | --- |
| **List** | One row each: the name, its kind, its owner, when it last changed, who can open it, and a **⋯** menu. Folders show how many items you can open in them. |
| **Grid** | Tiles with the name, and the owner and date (or, for a folder, how many items). |
| **Cards** (the default) | Larger cards with a preview of each item, its name, its owner, when it changed and who can open it. |

### Previews in Cards

In **Cards**, the top of each card shows what's inside:

| Item | Its card shows |
| --- | --- |
| Page | Its cover, icon, title and first blocks |
| Markdown document | The start of the document |
| HTML file | Its opening text. Point at the card for a moment to see the real page, live and scaled down. |
| PDF | The first page |
| Image | The image |
| Video | Its poster frame and length |
| Spreadsheet or CSV | The first cells |
| Text or JSON file | The first lines |
| Word document | The first paragraphs |

Audio, zip files and older Excel files keep their icon.

Previews load only for the cards on your screen, after the folder has opened, so folders still open straight away. A new PDF, image or video can take a moment to show its picture the first time anyone in the workspace looks at it.

**Previews follow access.** A card shows a preview only when you could open the item yourself. An end-to-end encrypted document shows a lock: Markdrop can't read it, so there is nothing to preview. Mentions of other items in a preview don't show their titles.

A live HTML preview runs the file the same way its own page does: on Markdrop's separate files address, sandboxed, never on markdrop.in. Live previews work with a mouse, a few at a time. They're off on phones and when your browser asks to save data.

**Who owns what.** Every item shows its owner's photo (or first initial) and name, and **You** for your own. A folder shows the people whose items are inside it. The item's menu on a phone shows its owner too. Only members of the workspace see the workspace's list, so only they see who owns what. Someone who opens an item from a public link never sees names.

On a phone, the list shows the name with the owner and date under it. Tap **⋯** for the item's actions.

## Make a folder

Open the workspace (or the folder you want it inside), choose **New**, then **New folder**. Members with **Can edit**, admins and the owner can make folders.

![The Guides folder of the Acme workspace: the sidebar tree shows Guides open with Setup inside, then Releases and Sales; the page shows the folder's address docs.acme.com/guides, the Setup folder and three items.](/docs-assets/workspaces/folders/folders-overview.webp)

| Limit | Value |
| --- | --- |
| Folders per workspace | 500 |
| How deep folders can nest | 8 levels |
| Folder name | Up to 80 characters |

A folder's address has to be free where it goes. If a folder, page, document or file in the same place already has that address, Markdrop says what holds it and doesn't create the folder. Pick another name, or rename the other one first. An item you can't open isn't named, but its address is still taken. A few words are reserved for the top level because the app uses them, such as `settings`, `dashboard` and `api`.

## File things into folders

- **Add new things straight into a folder**: open the folder and choose **New page** (a [page](/pages/overview) from a template), or **New**, then **New document**, **Upload** or **Add existing…**.
- **Pages in the sidebar**: open a folder in the sidebar to see its pages, and open a page there to see its [sub-pages](/pages/sub-pages). A sub-page always lives in its parent's folder.
- **Move something you already filed**: open the item's menu and choose **Move to…**. Can view members can't move items.

## Rename, move or delete a folder

Admins and the owner manage folders. Open the folder and choose **More folder actions**, or open the **⋯** menu on the folder's row in the list:

- **Rename folder…** shows the new address as you type. The folder's old address, and links to everything inside it that use the old name, redirect to the new addresses. If the new address is already taken in that place, the rename is refused and says what holds it.
- **Move folder to…** moves it with everything inside. Old addresses redirect here too. The move is refused if it would nest anything deeper than 8 levels, or if something at the destination already has the folder's address.
- **New items start as…** sets who can open new items filed into the folder. See [Workspace privacy](/workspaces/privacy).
- **Delete folder…** moves the folder, the folders inside it and everything filed in them to [Trash](/documents/trash) for 30 days. The dialog says how much goes with it. Restoring the folder from Trash brings it all back, in place.

::clip{src="/docs-assets/workspaces/folders/folder-rename" alt="Opening More folder actions on the Releases folder, choosing Rename folder…, and typing Release notes while the address below changes to docs.acme.com/release-notes/; then Cancel."}

The same menu has **Workspace settings** and, when the workspace has its own domain, an item like **Copy docs.acme.com address** that copies the folder's address there. At the top level of the workspace it's called **More workspace actions**, and the folder actions aren't there.

markdrop.in links never change when you rename or move a folder. Only addresses on your own domain include folders.

### With an AI app

An AI app connected over [MCP](/ai/overview) can do the same: `create_folder`, `rename_folder`, `move_folder` and `delete_folder`, with the same permissions. `delete_folder` deletes an empty folder. For a folder with anything in it, the app has to choose what happens to what's inside. It can move everything up one level, or move the folder with everything in it to Trash. Until it chooses, the folder stays, and the app is told what's inside. See [MCP tools](/ai/tools#workspaces-and-folders).

For the [API](/api/overview), `POST /api/v1/workspaces/{id}/folders` and the folder rename and move requests return `409` when the address is taken. Send `"on_conflict": "suffix"` to get the next free address (`reports-2`) instead.

## Take something out of the workspace

Open the item's menu and choose **Remove from workspace**. The item goes back to its owner's files. Nothing is deleted. The item's owner, admins and the workspace owner can do this.

## Next

::::cards
:::card[Share a folder]{href="/workspaces/share-a-folder" icon="link"}
Send one link that lists a folder's contents.
:::
:::card[Use your own domain]{href="/workspaces/custom-domain" icon="globe"}
Turn folders into addresses on docs.acme.com.
:::
::::
