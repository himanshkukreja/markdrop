---
title: Folders
description: File a workspace's documents into folders. On your own domain, a folder becomes part of each link, like docs.acme.com/guides/setup.
updated: 2026-10-30
prerequisites: [/workspaces/create]
keywords: [folder, subfolder, move, rename, organize, path, address]
---

Folders keep a workspace tidy, and on your own domain they shape the address. A document filed under **Guides › Setup** is served at `docs.acme.com/guides/setup/<document>`.

Folders decide where something appears and what its address is. They never decide who can open it: that stays with each item's own setting and the workspace's [privacy](/workspaces/privacy).

## Make a folder

Open the workspace (or the folder you want it inside), choose **New**, then **New folder**. Members with **Can edit**, admins and the owner can make folders.

![The Guides folder of the Acme workspace: the sidebar tree shows Guides open with Setup inside, then Releases and Sales; the page shows the folder's address docs.acme.com/guides, the Setup folder and three items.](/docs-assets/workspaces/folders/folders-overview.webp)

| Limit | Value |
| --- | --- |
| Folders per workspace | 500 |
| How deep folders can nest | 8 levels |
| Folder name | Up to 80 characters |

Two folders in the same place can't share a name that gives the same address. A few words are reserved for the top level because the app uses them, such as `settings`, `dashboard` and `api`.

## File things into folders

- **Add new things straight into a folder**: open the folder and choose **New**, then **New document**, **Upload** or **Add existing…**.
- **Move something you already filed**: open the item's menu and choose **Move to…**. Can view members can't move items.

## Rename, move or delete a folder

Admins and the owner manage folders. Open the folder and choose **More folder actions**:

- **Rename folder…** shows the new address as you type. Links that use the old name redirect to the new address.
- **Move folder to…** moves it with everything inside. The move is refused if it would nest anything deeper than 8 levels.
- **New items start as…** sets who can open new items filed into the folder. See [Workspace privacy](/workspaces/privacy).
- **Delete folder…** removes only the folder. What's inside stays in the workspace, and nobody loses access. If the folder is inside another one, you choose whether everything moves up one level or the items move to the top of the workspace.

::clip{src="/docs-assets/workspaces/folders/folder-rename" alt="Opening More folder actions on the Releases folder, choosing Rename folder…, and typing Release notes while the address below changes to docs.acme.com/release-notes/; then Cancel."}

The same menu has **Workspace settings** and, when the workspace has its own domain, an item like **Copy docs.acme.com address** that copies the folder's address there. At the top level of the workspace it's called **More workspace actions**, and the folder actions aren't there.

markdrop.in links never change when you rename, move or delete a folder. Only addresses on your own domain include folders.

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
