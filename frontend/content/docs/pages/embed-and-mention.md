---
title: Embed and mention Markdrop items
description: Put your PDFs, videos, images, HTML pages and documents inside a page, or link to them with a chip. Each reader sees an item only if they can open it.
updated: 2026-11-03
prerequisites: [/pages/overview]
keywords: [embed, mention, markdrop file, pdf, video, image, html, artifact, locked, placeholder, access, restricted item]
---

A page can show your other Markdrop items inside it: a PDF you can scroll, a video that plays, an interactive HTML page, an image, or a card for a document. It can also mention an item in a sentence, as a chip that links to it.

## Embed an item

Type `/embed` and press **Enter**. Search your own files, or switch to your workspace's tab to search what you can open there. Choose how it shows, then pick the item:

| Show as | What readers see |
| --- | --- |
| **Live** (default) | The item itself: an image, a video or audio player, Markdrop's viewer for a PDF, spreadsheet, Word or text file, or the HTML page running in a sandbox. A Markdrop document shows as a card with its first lines. |
| **Preview** | A cover with the item's name. The item loads when the reader chooses **Show**. |
| **Card** | A link card with the title, type and **Open**. |

Hover an embed in the editor to change how it shows, **Replace** it or remove it.

An embed points at the item's link, not at a copy. When you [replace the file](/files/replace-and-versions), every page that embeds it shows the new version.

## Mention an item

Type `/mention`, pick an item, and Markdrop puts a chip in the sentence: an icon and the item's title, linking to it.

## Who sees what

An embed or mention never changes who can open the item. For each reader, Markdrop checks the item's own access:

- A reader who can open the item sees it.
- A reader who can't sees a locked placeholder **without the item's title**:

| Placeholder | When |
| --- | --- |
| **Sign in to see this** | The item is shared with a workspace or with people by email, and the reader isn't signed in. |
| **Password-protected — open it** | The item has a password. The reader can open it on its own page and type it there. |
| **Encrypted document** | The item is end-to-end encrypted, so its key is only in the link its author shares. |
| **Not available** | The item was deleted, or the reader is signed in and can't open it. Markdrop doesn't say which, so a page never reveals that a private item exists. |

A mention the reader can't open shows **Restricted item**.

Share the items too if every reader of the page should see them. For example, a page shared with **Anyone with the link** that embeds a file shared only with your workspace shows that file to members and a placeholder to everyone else.

The title you see in a mention is written into the page's Markdown when you insert it (`:markdrop[Q3 plan]{src=q3-plan}`). Only people who can open the item get that label: everyone else's copy of the Markdown (**View raw**, an AI app, a copy of the page) has `:markdrop[]{src=q3-plan}`, and an embed's `title` is left out the same way. If they edit the page, the labels they couldn't see are kept.

## Other kinds of embed

- **Web embed** (`/youtube`, or **Web embed** in the menu): YouTube, Vimeo, Loom, Figma, Google Maps and CodePen links play inside the page. Other sites aren't embedded.
- **Bookmark** (`/bookmark`): paste any link to make a card with its title, description and image, which Markdrop fetches once when you add it.

## Related

- [Who can open what](/sharing/who-can-open)
- [Page Markdown reference](/pages/markdown-reference)
