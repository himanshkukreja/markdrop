---
title: Import from Notion
description: Connect Notion and import the pages you choose, kept in sync one way, or bring in a Notion export file. Pages, sub-pages, databases, images and links come over into a team or My files.
updated: 2026-11-19
prerequisites: [/pages/overview]
keywords: [notion, import, import from notion, connect notion, keep in sync, sync from notion, sync now, edited in markdrop, disconnect notion, migrate, migration, move from notion, export, markdown & csv, zip, database, databases, csv, sub-pages, re-import, merge, import_notion, get_notion_import, notion_status, notion_sync]
---

You can move your Notion pages into Markdrop in a few minutes, two ways:

- **Connect Notion** and tick the pages to bring over. Markdrop reads them straight from Notion and can **keep them in sync**: changes you make in Notion come over about every 15 minutes.
- **Import an export file**: export pages from Notion as a `.zip` and drop it into **Import from Notion**. Nothing to connect.

Either way, Markdrop rebuilds them as [pages](/pages/overview): the page tree with its sub-pages, databases with their properties, images, attachments and the links between pages.

## Connect Notion

Connecting lets Markdrop **read** the Notion pages you choose. It never changes anything in Notion.

1. Go to **Settings** › **Integrations** › **Notion** and select **Connect Notion**. You can also open **Import from Notion** (below) and choose **From Notion**.
2. Notion asks which pages Markdrop may read. Pick them and allow access. Sub-pages and databases inside a page come with it.
3. You're back in Markdrop with **Import from Notion** open.

To share more pages later, select **Add pages or workspace** on the same settings page, or in Notion open the page and choose **•••** › **Connections** and add Markdrop. To connect another Notion workspace, select **Add pages or workspace** and pick that workspace in Notion.

### Choose what to import

In **Import from Notion**, with **From Notion** selected:

1. Tick the pages and databases to bring over. Ticking a page takes everything under it; its sub-pages show ticked.
2. Under **Import to**, pick **My files** or a team, and the folder name, as for an export file (see [Import the zip](#import-the-zip)).
3. Leave **Keep in sync with Notion** on to bring Notion's later changes over, or turn it off for a one-time copy.
4. Select **Import now**.

The dialog shows **Read from Notion**, **Create pages** and **Fill in content** with how many pages are done. You can close it: the import keeps running.

![Import from Notion with From Notion selected: the pages shared with Markdrop as a tree with checkboxes, Engineering handbook ticked (its three sub-pages and databases come with it), Import to set to the Engineering team, a new folder named Engineering handbook, and Keep in sync with Notion on.](/docs-assets/pages/import-from-notion/connect-picker.webp)

### Keep in sync

Each page or database you import with **Keep in sync** on is listed under **Imported from Notion** in **Settings** › **Integrations** › **Notion**, with where it went and when it last synced.

- About every 15 minutes Markdrop checks Notion and brings over what changed since the last time: edited pages are updated, new sub-pages and database rows are added. Pages that didn't change aren't read again.
- **Sync now** checks straight away.
- It's **one way**. Nothing you do in Markdrop is sent to Notion.
- A page you **edit in Markdrop** stops syncing, so your changes are never overwritten. It's listed under **Edited in Markdrop** on its import.
- A page deleted in Notion, or no longer shared with Markdrop, stays in Markdrop as it was.
- Turn **Keep in sync** off to stop the checks; **Stop** forgets the import. Either way, the pages stay in Markdrop.

![Settings › Integrations › Notion: one connected Notion workspace, and three imports from Notion: Engineering handbook in sync and synced 4 min ago, Product roadmap listing a page edited in Markdrop, and Meeting notes not kept in sync.](/docs-assets/pages/import-from-notion/sync-status.webp)

A sync shows **Paused** when it can't run: **reconnect Notion** if Notion stopped accepting Markdrop's access (connect again and it carries on), or **no access** if you can no longer add pages where it goes (you left the team, for example). After you get access back, select **Sync now**.

### Disconnect

In **Settings** › **Integrations** › **Notion**, select **Disconnect** next to the workspace. Markdrop asks Notion to revoke its access, forgets it, and stops syncing from it. The pages you imported stay. You can also remove Markdrop in Notion under **Settings** › **Connections**.

## Export from Notion

1. In Notion, open the page you want to bring over and choose **•••** › **Export**. To bring everything, use **Settings** › **Export all workspace content** instead.
2. Set **Export format** to **Markdown & CSV**. Turn on **Include subpages** and **Create folders for subpages**.
3. Select **Export** and download the `.zip`. Don't unzip it.

A large workspace export arrives by email as a link to a `.zip`. Download it and use it as it is, even when it holds more zips inside: Markdrop opens those too.

An **HTML** export can't be imported. If you drop one, the import stops and asks you to export again as **Markdown & CSV**.

## Import the zip

Open **Import from Notion** from any of these places:

- **Create** › **Import** › **From Notion**, at the top of every screen.
- A team's **Files & pages** › **Import**. The team is already picked.
- **My files** › **Import**. My files is already picked.

Then:

1. Drop the `.zip` on the dialog, or select **choose a .zip file**.
2. Under **Import to**, pick **My files** or a team. Teams are grouped by workspace; a workspace's **General** is the space everyone in it can see.
3. In a team, leave **Put it in a new folder** on to keep the import together in one folder. The folder is named after the export (**Notion import** when the file name says nothing useful); change the name if you like. Turn it off to add the pages straight to the team's **Files & pages**.
4. Select **Import**.

![The Import from Notion dialog: a Notion export .zip chosen, Import to set to the Engineering team, Put it in a new folder on and named Notion import, and the How to export from Notion steps folded away.](/docs-assets/pages/import-from-notion/choose.webp)

### While it runs

The dialog shows the upload first, then each step on Markdrop's side: **Read the export**, **Create pages** and **Fill in content**, with how many pages are done and the page it's working on.

Keep the tab open until the upload finishes. After that you can close the dialog: the import keeps running, and Markdrop tells you when it's done. Open **Import from Notion** again to check on it. **Cancel import** stops it; pages already created stay where they are.

![The import in progress: Upload and Read the export are done, Create pages is at 137 of 412, and a note says you can close the window while it keeps running.](/docs-assets/pages/import-from-notion/progress.webp)

### When it's done

You see how many pages, databases, rows, images and files came over, and **Open folder** (or **Open**) takes you to them. **Skipped** lists anything left out, with why; **Couldn't import** lists pages that failed, with the reason. Everything else is imported, so you can fix those few by hand.

![Import finished: 412 pages, 6 databases, 238 rows, 154 images and 21 files, a note that a re-import updated 12 pages and kept 2 edited in Markdrop, the Skipped list open with its reasons, and Open folder.](/docs-assets/pages/import-from-notion/result.webp)

## What comes over

| In Notion | In Markdrop |
| --- | --- |
| Pages and sub-pages | Pages and [sub-pages](/pages/sub-pages), in the same tree. Notion's id is taken off each title. |
| Databases | In a team: a folder with [typed properties](/pages/properties-and-views) and a table and a board view, each row a page in it with its values. Column order is kept. In **My files**, which has no folders: a page with a table of its rows, each row a sub-page listing its properties. |
| Database properties | Select and status become **Select**; multi-select, date, person, checkbox and number keep their type; URL and relation become **Link**; email, phone and text become **Text**. A person is set when they match a member of the workspace by name or email, else their name is written on the row's page. A relation links to the row it points to when that row was imported too. A date range keeps its start date; the end is written on the row's page. |
| Images and attachments | Images are uploaded to the page they're on, so only that page's readers see them. Other attachments (PDFs, Office files, videos…) become Markdrop files beside the page, shown on it as a card. |
| Callouts, toggles, to-dos | Callouts, toggles and to-do checkboxes. |
| Code, quotes, dividers, tables | The same blocks; code keeps its language. |
| Equations | Math, drawn with KaTeX. |
| Bookmarks and embeds | Link cards and embeds. |
| Links between pages | Rewritten to point to the new Markdrop pages. Links to other websites are kept as they are. |

Anything Markdrop has no block for comes over as plain text with a short note saying what it was in Notion.

## What doesn't come over

- **Page icons and covers** from an export file: Notion's Markdown export leaves them out. With **Connect Notion** they come over.
- **Comments.** They aren't in the export.
- **Synced blocks** arrive as plain copies on each page; they no longer stay in sync.
- **Columns** from an export file: Notion's export puts column contents one after another, so they arrive that way. With **Connect Notion** they come over as columns.
- **HTML exports.** Export again as **Markdown & CSV**.

## Import again

With **Connect Notion**, use **Keep in sync** or **Sync now** (see [Keep in sync](#keep-in-sync)).

For an export file, to bring over later changes, export the same pages from Notion and import the new `.zip` into the same place. Markdrop recognises the pages it imported before and merges instead of making copies:

- A page that changed in Notion is **updated**; one that didn't is left **unchanged**.
- A page someone **edited in Markdrop** since the last import is **kept** as it is in Markdrop, so nobody's work is overwritten.
- New pages in the export are added.

The summary counts each kind.

## Who can see imported pages

Imported pages get the usual access of where they go: in a team, the team's members (in **General**, everyone in the workspace), following any [folder access](/workspaces/folder-access) rules; in **My files**, only you until you share them. An import never makes anything public. To share pages after the import, see [Who can open what](/sharing/who-can-open).

You can import into a team only if you can add pages to it. A sync checks that again every time it runs, and pauses if you no longer can. Your Notion connection is yours alone: nobody else can import with it or see what you shared.

## Limits

| What | Limit |
| --- | --- |
| Export `.zip` | 2 GB |
| Pages ticked in one Connect Notion import | 50 (with everything under them) |
| Pages in one import | 5,000 |
| One image | 20 MB |
| One attachment | 50 MB |
| Sub-pages nested | 8 deep (deeper ones go under the deepest page that can hold them) |

Images and attachments count toward your [storage](/account/limits). A file over a limit is skipped and listed under **Skipped**, and the rest of the import carries on. For a bigger workspace, export it from Notion in parts (a top-level page at a time) and import each one.

## From an AI app

AI apps connected to Markdrop import with the `import_notion` tool.

With Notion connected, `notion_status` with `list_pages` lists the pages and databases shared with Markdrop, with their ids; `import_notion` with `source: "api"`, the `pages` and `keep_in_sync` imports them. `notion_status` also shows each synced import (last sync, paused, pages edited in Markdrop), and `notion_sync` runs one now or turns Keep in sync on or off.

For an export file: Call it with the `.zip`'s name and size and where it should go (a workspace and team, or My files, and the folder name): it returns an import id and a `curl` command that uploads the zip. Run that, then call `import_notion` again with the import id to start it. `get_notion_import` reports progress and, when it's done, the same counts, skipped items and errors as the dialog, with a link to the result. See [MCP tools](/ai/tools).

## Related

- [Pages and the block editor](/pages/overview)
- [Sub-pages and access inheritance](/pages/sub-pages)
- [Properties and views](/pages/properties-and-views)
- [Paste into a page](/pages/paste)
- [Export a page](/pages/export)
