---
title: Trash and restoring
nav: Trash
description: Deleted documents, pages, files and folders wait in Trash for 30 days. Restore one and it comes back where it was, with the same link and the same people.
updated: 2026-11-04
keywords: [trash, bin, recycle bin, restore, undo, undelete, deleted by mistake, recover, delete forever, permanently delete, 30 days, deleted folder, restore_document, list_trash]
---

When you delete a document, a page, a file or a folder, it goes to **Trash** for 30 days. Its link stops working at once, but nothing is lost: restore it within 30 days and it comes back exactly as it was. After 30 days it's deleted for good.

## Undo a delete

Right after a delete, Markdrop shows **Moved to Trash** with an **Undo** button. Choose **Undo** to put it straight back.

## Restore from Trash

1. Choose **Trash** in the sidebar.
2. Find the item. Each row says what it is (page, document or file) and its link, where it was, who deleted it, when, and how many days are left.
3. Choose **Restore**.

It comes back where it was: the same link, the same workspace and folder, inside the same page, with the same access, password and people it was shared with. Its views and version history are kept too.

If the place it came from is gone, it goes as close as it can, and Markdrop says so:

| What's gone | Where it comes back |
|---|---|
| The page it was inside | At the top level, with the access it had |
| Its folder | At the top of the workspace |
| Its workspace | In the owner's own files. Anything that was open to the team becomes **Only people added**: restoring never makes something more open than it was. |

A page deleted together with its sub-pages comes back with them, and restoring one of those sub-pages restores the whole group.

## Deleted folders

Deleting a folder moves the folder, every folder inside it and everything filed in them to Trash. Restoring the folder brings it all back: the same folders, the same items in them, the same addresses on your domain. If another folder took its name meanwhile, it comes back as `name-2` and Markdrop tells you the new address.

Only workspace admins and the owner delete folders, so the folder shows in their Trash. A member whose items were in it sees those items in their own Trash and can restore one on its own; it comes back at the top of the workspace.

## Who sees what

| Who | Sees in Trash | Can restore and delete forever |
|---|---|---|
| The item's owner | Their own deleted items | Yes |
| Workspace admins and the owner | Everything deleted from that workspace, folders included. An item they can't open is listed without its title. | Yes |
| Anyone else | Nothing | No |

A document published without an account can be restored with its [edit secret](/documents/edit-key), from the **Undo** right after the delete.

Trash never works on a workspace's own domain; open markdrop.in to restore something.

## The link of a deleted item

While an item is in Trash, its link shows a 404 page to everyone. If you could edit it and you're signed in, the page says **This page is in the trash** instead, with **Restore** if you're allowed to. Nobody else can tell that it exists.

Its link stays reserved while it's in Trash, so nobody can take it, and the restore always gets it back.

## Delete forever

To delete something for good before the 30 days are up, choose **Delete forever** on its row in Trash. This can't be undone: the item, its stored files and its old versions are deleted. For another 30 days nobody else can take its link.

Files in Trash still count toward your storage until they're deleted forever.

## From AI apps and the API

- AI apps delete with `delete_document`, which also moves to Trash. `restore_document` brings an item back and `list_trash` lists what can be restored. Only when you ask for it does an app pass `permanent: true` to delete forever. See [MCP tools](/ai/tools).
- The API's `DELETE /api/v1/documents/{slug}` moves to Trash too.

:::note[What isn't in Trash]
Old versions of a file you delete in **Versions** and page templates are deleted at once, as before.
:::

## Related

- [Sub-pages](/pages/sub-pages#delete-a-page-with-sub-pages)
- [Folders](/workspaces/folders)
- [Edit with your edit secret](/documents/edit-key)
