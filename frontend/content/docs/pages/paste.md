---
title: Paste into a page
description: Paste from Google Docs, Notion, GitHub, Word, VS Code or any web page and get real blocks. Paste a link on its own to make it a mention, a bookmark or an embed.
updated: 2026-11-03
prerequisites: [/pages/overview]
keywords: [paste, copy, clipboard, google docs, notion, github, word, vs code, markdown, link, url, bookmark, embed, mention, import]
---

Whatever you paste into a page becomes blocks: headings, lists, to-dos, tables, code and images, with their formatting. You don't need to clean anything up first.

## Paste a link

Paste a link on its own and it goes in as a link right away. A small **Paste as** menu opens next to it:

| Choose | You get |
| --- | --- |
| **Link** | The link, as pasted. This is what happens when you press **Esc**, keep typing or click somewhere else. |
| **Mention** | For a Markdrop document, file or page: a chip with its title. See [Embed and mention Markdrop items](/pages/embed-and-mention). |
| **Bookmark** | A card with the page's title, description and image. |
| **Embed** | For YouTube, Vimeo, Loom, Figma, Google Maps and CodePen: the video or design, playable in the page. For a Markdrop item: the item itself. |

Use **↑** and **↓** to move through the menu and **Enter** to choose, or click an option. The cursor stays in the page the whole time, so you can ignore the menu and keep writing.

A bookmark or an embed takes the link's line when the link is all that's on it. Otherwise it goes on the line below, and the link is taken out of your text. In a table cell, there's no room for a block, so the menu offers **Link**, and **Mention** for a Markdrop item.

To link some text instead, select the text first and then paste the link.

## Paste from other apps

| From | What you get |
| --- | --- |
| **Google Docs** | Headings, bold, italic, strikethrough and links (Google's redirect links become the real address). You also get bulleted, numbered and nested lists, checklists with their ticks, tables and images. |
| **Notion** | Headings, to-dos with their ticks, toggles and toggle headings, callouts with their icon and colour, code with its language, quotes, dividers, tables and images. |
| **GitHub** (a README or comment) | Headings, badges on one line, code blocks with their language, task lists, alerts such as `[!WARNING]` as callouts, tables and images. |
| **Word** | Headings, formatting, bulleted and numbered lists, and tables. |
| **VS Code** | A Markdown file's text becomes blocks. Code from any other kind of file becomes a code block in that language. |
| **Web pages** | Headings, paragraphs, lists, tables, code, quotes and images. Scripts, styles, buttons, colours and fonts are left out. |

A few things change on the way in, because a page is Markdown underneath:

- A table cell holds one line, so several paragraphs in a cell are joined into one. The first row becomes the header row, and merged cells are split.
- Headings 4 to 6 become heading 3.
- Empty lines, text colours, highlights and underlines aren't kept.
- Notion's columns are pasted one after the other.

## Paste Markdown

Paste Markdown as plain text, from a `.md` file, an AI chat or a terminal, and it becomes blocks. That covers headings, lists, to-dos, tables, code, callouts (`:::note`) and toggles (`:::details{summary="…"}`), and everything in the [Page Markdown reference](/pages/markdown-reference). Some Markdown from other tools is converted too:

- Notion's callouts (`<aside>💡 …</aside>`) become callouts with that icon.
- GitHub's alerts (`> [!TIP]`) become callouts.
- `<details><summary>…</summary> … </details>` becomes a toggle.

To paste text exactly as it is, without any formatting, press **⌘ ⇧ V** (**Ctrl Shift V** on Windows and Linux).

## Images

Images in what you paste are copied into the page, as if you had uploaded them. While that happens, an image shows **Uploading…**, and you can keep writing. Afterwards it's a [page image](/pages/images): it's stored with the page, it's shown only to people who can read the page, and it stays even if the original is taken down.

If the website hosting an image doesn't allow it to be copied, the image keeps its web address and loads from that site. Badges and small icons next to text stay as they are. Images only count toward your [storage](/account/limits) once they're copied.

A pasted image file (a screenshot, or **Copy image** in a browser) is always uploaded.

## Related

- [Pages and the block editor](/pages/overview)
- [Images in pages](/pages/images)
- [Keyboard shortcuts](/pages/keyboard-shortcuts)
