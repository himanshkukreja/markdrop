---
title: Pages and the block editor
description: A page is a Markdrop document you write with blocks, like in Notion, with a cover, an icon, sub-pages and live embeds of your files. It stays Markdown.
updated: 2026-11-04
keywords: [page, pages, block editor, beta, notion, blocks, slash menu, editor, autosave, lock, cover, icon, duplicate, copy, move, duplicate_page, copy of]
---

A page is a Markdrop document that you write with blocks instead of plain Markdown. You type `/` to add a heading, a to-do list, a callout, a table, an image or one of your Markdrop files, and you drag blocks to reorder them. Underneath, a page is still a Markdown document, with the same link, sharing, custom domain, analytics and who's-viewing as any other.

:::note[Pages are in beta]
Pages and the block editor are new and still changing, so they carry a **Beta** label in Markdrop. A page is saved and published like any other document, and it stays plain Markdown, so nothing you write is locked in.
:::

## Make a page

You need to be signed in.

- **In a workspace or folder**: choose **New page**. Pick a [template](/pages/templates) or **Blank**, give it a title and choose **Create page**. The page is filed where you made it, and new items there start with the folder's access.
- **From anywhere**: choose **Create**, then **Page**.
- **Inside another page**: choose **Add a sub-page** at the bottom of the page or in its menu, or type `/page` in the editor. See [Sub-pages](/pages/sub-pages).
- **From a document you already have**: open it, choose **More actions**, then **Open in block editor**. The Markdown doesn't change, and you can switch back to the classic editor from the page's **⋯** menu at any time. End-to-end encrypted documents keep the classic editor.

## Write with blocks

If you can edit a page, it opens ready to edit: click anywhere and type. There's no **Edit** or **Done**, and your changes save as you go. People who can only read the page see exactly the same layout, without the editing controls.

Type `/` on any line to open the block menu. Keep typing to filter it, use the arrow keys and press **Enter**. The menu has:

| Group | Blocks |
| --- | --- |
| Text | Text, Heading 1, 2 and 3, Quote, Divider |
| Lists | To-do list, Bulleted list, Numbered list, Toggle, Toggle heading 1, 2 and 3 |
| Callouts | Callout (note), Tip, Warning, Danger, each with an optional emoji and background colour |
| Media | Image, Video, Audio, File, Embed (a Markdrop file or page), Web embed (YouTube, Vimeo, Loom, Figma, Google Maps, CodePen), Bookmark |
| Structure | Page (a sub-page), Table, 2 to 5 columns, Table of contents, Breadcrumb, Button |
| Technical | Code, Math, Diagram (Mermaid) |
| Inline | Mention (a Markdrop item), Person, Date |

You can also type Markdown as you go: `#` and a space makes a heading, `-` a bulleted list, `1.` a numbered one, `[]` a to-do, `>` or `"` a quote, ` ``` ` a code block, `---` a divider and `$$` an equation. `**bold**`, `*italic*`, `` `code` `` and `~~strike~~` format as you type, and `:` followed by a name inserts an emoji (`:rocket` gives 🚀). [Keyboard shortcuts](/pages/keyboard-shortcuts) lists the rest.

Paste from Google Docs, Notion, GitHub, Word or a web page and you get blocks, not plain text. Paste a link on its own to make it a mention, a bookmark or an embed. See [Paste into a page](/pages/paste).

Select text to format it, add a link, or turn a line into another kind of block. Hover a block to see its handle: drag it to move the block, or click it for **Move up**, **Move down**, **Duplicate**, **Copy link to block**, **Colour** and **Delete**. Press **Esc** to select the block you're in. Colours, columns, nesting and selecting several blocks are in [Colours, columns and block tools](/pages/blocks-and-layout).

## Title, icon and cover

A page's title sits above its content. Press **Enter** in the title to start writing.

Hover the title for **Add icon** and **Add cover**. The icon is an emoji (search by name) or an image you upload, and it shows in the browser tab. The cover is one of Markdrop's built-in covers (paper, duotone, lines and calm), an image you upload, or an image link. A new page has no cover until you add one. Hover the cover for **Change cover**, **Reposition** (drag the image up or down) and **Remove**.

## The top bar

The bar at the top of a page stays in place as you scroll. On the left are the page's breadcrumbs, with each page's icon; when there are more than two pages above this one, the middle ones fold into **…**. On the right are [who's viewing](/sharing/see-whos-viewing), **Saving…** or **Saved**, **Share** (or **Copy link** if you can't share the page) and the **⋯** menu.

## Page options

The **⋯** menu in the top bar has:

- The font: **Default**, **Serif** or **Mono**, then the **Small text** and **Full width** switches.
- **Lock page** (owners): only you and workspace admins can edit it, and AI apps can't add to it, until you unlock it.
- **Copy link**, **Add a sub-page**, **Move to…**, **Duplicate**, **Edit as Markdown**, **Open in the classic editor** and **Delete page**.
- **Export PDF** and **Details** (published, views and who can open it).
- The word count.

These options are saved in the page's Markdown, so they travel with it. See [Page Markdown reference](/pages/markdown-reference).

## Duplicate a page

Choose **Duplicate** from the page's **⋯** menu, or from the **⋯** next to a page in the page tree. Markdrop makes a copy beside it, in the same parent, folder and workspace, called "Title (1)" (then "(2)", and so on), and opens it in the editor.

The copy has the same blocks, icon, cover and page options, and its own copies of the page's images. Its sub-pages are copied too, and links to them point at the copies. A sub-page with its own access isn't copied, because its copy would follow the new page's access; the message names it.

If an image can't be copied, the copy keeps the rest, shows that image as missing, and the message says which one. Upload it again in the copy.

The copy starts with the access of the place it's in, like any new page. It doesn't copy the original's sharing, history, views or analytics.

### Duplicate from an AI app

An AI app connected to Markdrop duplicates a page with the `duplicate_page` tool, for example to start a new PRD from a locked template page:

- Anyone who can read a page can duplicate it. The copy is theirs, and a [locked](#page-options) page gives an unlocked copy.
- The copy is called "Copy of Title" unless the app gives a title. It goes where the app says: inside a page you can edit (`parent`), or in a workspace or folder where you can add pages (`workspace`, `folder`). Otherwise it goes next to the original: in the same parent page if you can add pages there, else in the same workspace folder if you're a member, else among your own pages, private unless the original is public to anyone with the link.
- Images are copied too, so the copy's images show to the copy's readers, not the original's.
- Sub-pages are copied only when the app asks for them (`include_subpages`), up to 50 pages in all. As with **Duplicate**, a sub-page with its own access isn't copied, and the reply names it.
- The copy has what you can read: if you can't see a person's name or an item's title on the original, the copy doesn't have it either.
- End-to-end encrypted pages can't be duplicated this way, because the server can't read them.

See [MCP tools](/ai/tools#pages).

To move a page somewhere else, see [Move a page](/pages/sub-pages#move-a-page).

## Saving

Pages save themselves about two seconds after you stop typing. The top bar shows **Saving…**, **Saved**, or **Offline, retrying** when your connection drops. Until the server confirms a change, your browser keeps a copy, so a crash or a closed tab doesn't lose what you typed: the next time you open the page, choose **Restore them**.

## One editor at a time

The first time you type or click in a page, it's held for you, and others see **Editing** next to your name in [who's viewing](/sharing/see-whos-viewing). Anyone else who opens it meanwhile sees a banner under the top bar, **Your name is editing — you'll be able to edit when they're done**. They follow your changes live, and the page becomes editable for them on its own once it's free again.

A page is let go when you leave it, or after three minutes without typing or clicking in it, so someone who only has a page open never blocks anyone. It's also released two minutes after the editor stops responding, for example when a laptop goes to sleep.

If someone saved a newer version anyway (from the classic editor, VS Code or an AI app), you see **This page changed**, with **Load the latest** or **Keep mine**. When an AI app only adds blocks to the end of a page you're editing, they appear at the end of your page without interrupting you.

## On a phone

Pages work the same on a phone. While you edit, a toolbar above the keyboard adds blocks, formats text and undoes, and menus open as sheets from the bottom of the screen. See [On a phone](/pages/blocks-and-layout#on-a-phone).

## Readers

People who can open the page see it as you laid it out, with the same blocks. Embeds of your files show only to readers who can open those files: everyone else sees a locked placeholder. See [Embed and mention Markdrop items](/pages/embed-and-mention).

## Related

- [Templates](/pages/templates)
- [Sub-pages and access inheritance](/pages/sub-pages)
- [Images in pages](/pages/images)
- [Paste into a page](/pages/paste)
- [Page Markdown reference](/pages/markdown-reference)
