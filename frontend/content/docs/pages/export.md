---
title: Export a page
description: Download a page as Markdown, a Word document, a single HTML file or a PDF, with its images, its comments and the sub-pages you can open.
updated: 2026-11-09
prerequisites: [/pages/overview]
keywords: [export, download, markdown, md, word, docx, microsoft word, google docs, comments, export comments, html, pdf, print, zip, sub-pages, images, portable, backup, export_page, allow_export, readers can export]
---

You can take a page out of Markdrop as a file: portable Markdown, a Word document, one HTML file, or a PDF. Open the page's **⋯** menu and choose **Export…**, pick a format, and select **Download** or **Print to PDF…**. The file downloads where you are; if Markdrop can't make it (for example, the page's editors have just turned off exports for readers), the dialog says why.

## Formats

| Format | What you get | Good for |
| --- | --- | --- |
| **Markdown** | A `.md` file. With images, a `.zip` holding `page.md` and an `images` folder it links to. | GitHub, Obsidian, VS Code, another wiki, a backup |
| **Word** | A `.docx` file: headings, lists, tables, links and code, with the page's comments as Word comments if you like. | Word, Pages or Google Docs; reviews with people outside Markdrop |
| **HTML** | One `.html` file in the page's look, with its images inside it. It opens in any browser, even offline. | Sending a page to someone without a Markdrop account |
| **PDF** | Your browser's print dialog, with the page laid out for paper. Choose **Save as PDF**. | Printing, attaching to an email, signing off a spec |

### Markdown

The export is Markdown that any app reads, so Markdrop's own blocks are written the way Markdown can show them:

- **Callouts** become quotes that start with their label, such as **💡 Tip: Before you start**.
- **Toggles** become `<details>` blocks, which GitHub and most editors can open and close. A toggle heading becomes a normal heading.
- **Columns** become their contents one after another, left to right.
- **People and dates** become text: `@Ada Lovelace`, `Nov 10, 2026`.
- **Markdrop items** you embed or mention become links to them, with their titles. An item you can't open is written as **Locked item**, never with its title.
- **Sub-page links, bookmarks and web embeds** become links. **Contents** becomes a list of links to the page's headings.
- **Colours, block links and image sizes** are left out. **Buttons** are left out, as readers don't see them either.
- The page's **title** is the first heading, with its emoji icon.

Images uploaded to the page go in the `.zip`. If you download a single `.md` instead, a page anyone with the link can read keeps its images as links, and other pages show each image's alt text where it was.

### Word

The Word document has the page's title, then its text: headings, lists (with checkboxes for to-dos), quotes, code, tables and links, written the same way as the Markdown export (callouts as labelled quotes, columns one after another, people and dates as text, locked items as **Locked item**). Images show as their descriptions. Word exports one page at a time, without its sub-pages.

### HTML

The HTML file looks like the page: the cover across the top, the icon over the cover's bottom edge and the title below them, then callouts, toggles (open), columns, coloured text and backgrounds, tables and code. Embedded Markdrop items become cards that link to them, and locked ones say **Locked item**. Images are inside the file, up to 25 MB of them; larger ones are left out.

Math and Mermaid diagrams are drawn when the file is opened with an internet connection. Offline, you see their source. Nothing else in the file runs: any HTML or script written in the page shows as text.

### PDF

**Print to PDF…** lays the page out for paper in the light theme, without Markdrop's menus or sidebar, in this tab: no other page opens. The cover sits at the top of the first sheet, with the icon on its edge and the title below, each top-level heading starts a new sheet, and blocks such as callouts, code, tables and images aren't split across two sheets. Toggles print open. Videos and other web embeds can't be printed, so they're left out of the PDF.

In the print dialog, choose **Save as PDF** as the destination. To keep the cover and background colours, turn on **Background graphics** in the dialog's options.

## Include sub-pages

When a page has pages inside it, turn on **Include sub-pages**:

- **Markdown** and **HTML** download a `.zip` with a folder for the page and a folder inside it for each sub-page. Links between the pages point to each other's files, and each page lists the pages inside it at the end.
- **PDF** prints the sub-pages after the page, each from a new sheet.

Only sub-pages you can open are included, with the pages inside them. A sub-page you can't open is left out with everything below it, and its title never appears in the export.

## Include comments

When the page has comments you can see, turn on **Include comments**. Markdown puts them in a **Comments** section at the end; Word as comments in the margin or as footnotes; PDF as notes in the margin or at the end. **Open threads only** leaves resolved ones out. See [Export with comments](/collaboration/insights-and-exports#export-with-comments).

## Who can export

- Anyone who can **edit** the page can export it.
- **Readers** can export it too, unless its editors turn that off: in the page's **⋯** menu, switch off **Readers can export**. Readers then don't see **Export…**, and Markdrop refuses their exports.
- The setting is part of the page, so it also applies to its sub-pages when you export a page with them.

Turning off exports doesn't stop readers from reading, copying text or taking screenshots. To limit who can read the page, change [who can open it](/sharing/who-can-open).

An [end-to-end encrypted](/sharing/end-to-end-encryption) document can't be exported by Markdrop, because its servers can't read it. Open it in your browser and choose **Download Markdown** in its **⋯** menu: your browser saves the decrypted Markdown.

## From an AI app

AI apps connected to Markdrop export with the `export_page` tool. It returns the Markdown or HTML as text (`format: word` gives a link to a `.docx`; `comments: footnotes` or `margin` includes the comments), or, with `include_subpages` (or `zip` for Markdown with images), a link to the `.zip` that works for 10 minutes. Opening the link downloads the file; once it has expired, it opens a short page saying so: ask the AI app to export the page again. It follows the same rules as the website: locked items stay locked, and readers can export only when the page allows it. See [MCP tools](/ai/tools).

The setting is the page property `allow_export: false` in its front matter, which `set_page_properties` sets. See the [Page Markdown reference](/pages/markdown-reference).

## Related

- [Page Markdown reference](/pages/markdown-reference)
- [Sub-pages](/pages/sub-pages)
- [Images in pages](/pages/images)
