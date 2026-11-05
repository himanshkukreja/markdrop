---
title: Version history
description: Every page keeps its earlier versions. See what changed, and bring any version back. A restore can be undone.
updated: 2026-11-05
prerequisites: [/pages/overview]
keywords: [version history, done, edit anyway, unsaved changes, kept, take over, versions, history, restore, undo, revert, roll back, changes, diff, compare, earlier version, ai edits, mcp]
---

Markdrop keeps earlier versions of every page as it's edited. Open them from the page's **⋯** menu › **Version history**.

## When a version is saved

- **While you edit:** one version per 10 minutes of editing, and one when you choose **Done**, leave the page or close it.
- **Before and after an AI edit:** every change an AI app makes through [MCP](/ai/tools#pages) is its own version, labelled with the app's name, and the page as it was just before is kept too.
- **When you restore a version** (below).
- **When someone takes over editing from you:** what you hadn't saved yet is kept as its own version, labelled **Your name's unsaved changes, kept when … took over editing**. The page itself doesn't change: open the version to copy from it or restore it. See [Editing together](/pages/editing-together#edit-anyway).

You don't need to save anything yourself. A page that was last changed outside the editor (from [VS Code](/vscode/sync), say) gets that state saved as **Earlier version** the next time it changes.

## See an earlier version

**Version history** opens over the page. On the left are the versions, newest first and grouped by day, with when each was saved and who saved it: a person, an AI app (**Claude via MCP**, for example), or a restore (**Riya restored Nov 2, 3:12 PM**). The one that matches the page now is marked **Current**.

Choose a version to see it on the right as the page looked then. Use **↑** and **↓** to step through them.

**Show changes** compares the version with the page as it is now:

- **Green**: in this version, but not in the page now.
- **Red, struck through**: in the page now, but not in this version.

On a phone, tap a version to open it, and **Back** to return to the list.

## Restore a version

Choose the version and **Restore this version**, then confirm. The page goes back to how it was, and the restore is saved as a new version. The page as it was just before is kept in the history, so you can undo a restore by restoring that one.

You can't restore while someone else is [editing the page](/pages/editing-together) (having it open doesn't count, only changing it): Markdrop says who, and you can try again when they're done. The page's owner and workspace admins can take it over with **Edit anyway** first. A page that's [locked](/pages/overview) can be restored only by its owner or a workspace admin.

## How long versions are kept

| Age | What's kept |
|---|---|
| Up to 30 days | Every version |
| 30 days to a year | The last version of each day |
| Over a year | Nothing; the page itself is never affected |

A page keeps at most 500 versions; past that, the oldest go first. Deleting a page deletes its history.

## Who can see the history

People who can **edit** the page can see its versions and restore them. People who can only read it never see the history, and nor does anyone else.

[End-to-end encrypted](/sharing/end-to-end-encryption) documents have no version history: Markdrop can't read them, so it can't keep earlier versions of them.

Images in a page stay while the page or any version it keeps shows them. An image nothing shows any more is deleted 30 days later. See [Images in pages](/pages/images).

## From an AI app

AI apps connected over [MCP](/ai/hosted-mcp) can do the same: `list_page_versions` lists them, `get_page_version` reads one, and `restore_page_version` restores one (with the `documents:write` permission). See [MCP tools](/ai/tools#pages).

## Related

- [Pages overview](/pages/overview)
- [Images in pages](/pages/images)
- [MCP tools](/ai/tools)
