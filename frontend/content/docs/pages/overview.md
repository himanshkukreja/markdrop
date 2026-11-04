---
title: Pages and the block editor
description: A page is a Markdrop document you write with blocks, like in Notion, with a cover, an icon, sub-pages and live embeds of your files. It stays Markdown.
updated: 2026-11-04
keywords: [page, pages, top bar, sidebar, collapse sidebar, menu, more actions, use as template, version history, request edit access, admins, unlock, block editor, beta, notion, blocks, slash menu, editor, autosave, lock, cover, icon, auto cover, automatic cover, cover image, pick for me, duplicate, copy, move, ai, ask, link, slug, change link, url, redirect, duplicate_page, copy of]
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
- **From a document you already have**: open it, choose **More actions**, then **Open in block editor**. The Markdown doesn't change and the link stays the same. End-to-end encrypted documents keep the classic editor.

Once it's a page, it stays a page: its menus don't switch it to another editor. To work on its Markdown directly, use **Edit as Markdown** (see [Edit the Markdown](#edit-the-markdown)).

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

Hover the title for **Add icon** and **Add cover**. The icon is an emoji (search by name) or an image you upload, and it shows in the browser tab. The cover is one of Markdrop's 44 built-in covers (in five groups: paper, duotone, lines, shapes and calm), an image you upload, or an image link. **Pick for me** in the cover picker chooses one for what the page is about. Hover the cover for **Change cover**, **Reposition** (drag the image up or down) and **Remove**.

### Automatic covers

A new page gets a cover by itself: one of Markdrop's own covers, picked for what the page is about. A roadmap gets a route, meeting notes get overlapping circles, a runbook gets a calm pulse line. It fades in a moment after the page opens.

- **How it's picked.** With [AI](/pages/ai) on, AI reads the page's title and its first lines (about 1,500 characters) and picks from the covers' themes. With AI off, over its limit, or when it can't answer, the cover is matched on the title's and the text's words instead. Either way, nothing about the page changes but its cover.
- **When.** Right away for a page that has a title, a template or text. A page made as **Untitled** with nothing in it gets its cover once you've named it and started writing.
- **Which pages.** Pages made in the editor, from a template, from notes or by an AI app. A duplicate keeps its original's cover (or its lack of one). Templates, end-to-end encrypted pages and pages that already have a cover never get one.
- **Change or remove it.** Hover the cover: an automatic cover says **Auto**. **Change cover** picks another, and **Remove** takes it away in one click. A cover you remove is never added back, and neither is one on a page you made without a cover.
- **Turn it off.** Workspace admins can turn **Auto covers** off on the **Advanced** tab of the workspace's settings, next to **AI features**. New pages there then start without a cover; pages that have one keep it. Pages outside a workspace always get one.

Pages made before automatic covers existed got a cover the same way, once, unless they're encrypted, templates or someone had removed their cover.

## The top bar

A page has one bar at the top, and it stays in place as you scroll. On the left are the sidebar button, the logo (your workspace's logo on its own domain) and the breadcrumbs: the workspace and folder (if you're a member), the pages above this one, each with its icon, and this page. When there are more than three, the middle ones fold into **…**; on a phone everything above this page folds into **…**. On the right are [who's viewing](/sharing/see-whos-viewing), **Saving…** or **Saved**, **Share** (or **Copy link** if you can't share the page), the **⋯** menu, **Create** and your account menu (or **Sign in**). If you're signed out, the theme is in the **⋯** menu.

The sidebar beside the page holds the page tree and the page's contents. To hide it, choose the sidebar button or press **⌘ \\** (**Ctrl \\** on Windows and Linux); your browser remembers the choice. While it's hidden, point at the left edge of the window to peek at it. On smaller screens the sidebar opens over the page from the same button.

## Page options

The **⋯** menu in the top bar has, if you can edit the page:

- The font: **Default**, **Serif** or **Mono**, then the **Small text**, **Full width** and **Readers can export** switches.
- AI: **Summarize page**, **Find action items** and **Suggest title & icon** (and **Translate…** further down). See [AI in pages](/pages/ai).
- **Lock page** (the owner and workspace admins): only the owner and the workspace's admins can edit it, and AI apps can't add to it, until one of them chooses **Unlock page**.
- **Copy link**, **Add a sub-page**, **Move to…**, **Duplicate** and **Edit as Markdown** (see [Edit the Markdown](#edit-the-markdown)).
- **Export…** (Markdown, HTML or PDF; see [Export a page](/pages/export)), **Version history** (see [Version history](/pages/history)), **Use as template** (see [Templates](/pages/templates)), **Change link…** (owners; see [Change a page's link](#change-a-pages-link)), **Translate…**, **Publish to Google Docs** (owners who have connected Google) and **Details** (published, views and who can open it). If someone shared the page with you, **Remove me** takes you off it.
- **Delete page** (owners), which moves it to [Trash](/documents/trash) for 30 days.
- The word count, and when the page was last edited.

People who can only read the page get a shorter menu: **Copy link**, **View raw**, **Export…** (unless its editors turned **Readers can export** off), **Save a copy**, **Edit** (it asks for the page's [edit secret](/documents/edit-key)), **Request edit access** (signed in; see [Request edit access](/sharing/request-access#request-edit-access)), **Report** and **Details**. On a workspace's own domain, the owner's menu also has **General access on markdrop.in**, **Change link on markdrop.in** and **Delete on markdrop.in**, which open the same page on markdrop.in. See [Edit on your domain](/workspaces/sign-in-on-your-domain#edit-on-your-domain).

A long menu never runs off the screen: if it's taller than the room it has, it scrolls.

The font, the switches and the lock are saved in the page's Markdown, so they travel with it. See [Page Markdown reference](/pages/markdown-reference).

## Edit the Markdown

**Edit as Markdown** in the **⋯** menu shows the page's Markdown source in place of its blocks, with its properties (icon, cover, layout) at the top. Your changes save as you type. A bar above the source says you're editing it; choose **Edit with blocks** there, or in the **⋯** menu, to see your changes as blocks again.

The source view is only for now: it doesn't change the page. Reloading the page, or opening another one, shows blocks again, and the page stays a page for everyone.

### A page that was switched to the classic editor

Pages used to offer **Open in the classic editor**, which turned a page back into a classic Markdown document. If a page was switched that way, its owner and editors see **This page is open in the classic editor** above it, with **Switch back to the page editor** (it's also in **More actions**, here and on your workspace's own domain). Switching back keeps the Markdown, the link, the sub-pages and the properties, so the icon and cover come back. AI apps can still choose the editor with `publish_document`'s `editor` option.

## Change a page's link

A page's link ends with its slug: `markdrop.in/q3-plan`, and in a workspace with its own domain `docs.acme.com/product-hub/q3-plan` (its folders first, then any pages it sits inside, then the slug). To change it, you need to own the page:

::::steps
### Open Change link
Choose **Change link…** from the page's **⋯** menu.

### Type the new link
Type the new slug: 3 to 50 letters, numbers, hyphens (`-`) or underscores (`_`). As you type, Markdrop checks it and shows the whole new address, with your domain and folders. A slug another document uses or used, or one deleted in the last 30 days, can't be used, and neither can the name of a folder next to the page.

### Choose Change link
The page opens at its new link.
::::

The old link keeps working. Anyone who can open the page and follows it is sent to the new link, on markdrop.in and on your workspace's domain, and the addresses of its sub-pages follow. Embeds and mentions of the page in other pages keep working without any change. Nobody else can ever take the old link.

You can also choose the link when an AI app makes the page, and change it later from the app: see `create_page` and `set_slug` in [MCP tools](/ai/tools#pages). More about links in [Choose a link for your document](/documents/addresses).

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

## AI in pages

If you can edit a page, AI can rewrite a selection, draft with `/ai` (or **⌘ J**), summarize the page, find its action items, translate it and suggest alt text for its images. Signed-in readers can ask the page questions with **✦ Ask**. Every result is a suggestion until you accept it. See [AI in pages](/pages/ai).

## Readers

People who can open the page see it as you laid it out, with the same blocks. Embeds of your files show only to readers who can open those files: everyone else sees a locked placeholder. See [Embed and mention Markdrop items](/pages/embed-and-mention).

## Related

- [Templates](/pages/templates)
- [Sub-pages and access inheritance](/pages/sub-pages)
- [Images in pages](/pages/images)
- [Paste into a page](/pages/paste)
- [AI in pages](/pages/ai)
- [Export a page](/pages/export)
- [Page Markdown reference](/pages/markdown-reference)
