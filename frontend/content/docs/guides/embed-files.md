---
title: Embed files that render
nav: Embed files
description: Put an interactive HTML demo, a zipped site, a PDF or a video from Markdrop in a guide page as a live, sandboxed block with a text version.
updated: 2026-11-02
prerequisites: [/guides/editor]
keywords: [embed, markdrop file, interactive, html, demo, prototype, calculator, zipped site, website, pdf, video, captions, chapters, sandbox, security, text version, llms.txt, replace file, version, pin, insights, fix list, ::markdrop]
---

A guide page can show a Markdrop file right in the text, working: an interactive HTML page (a prototype, a calculator, a chart) or a zipped static site, a PDF with page controls and zoom, or a video in the docs player. Readers use it without leaving the page.

This calculator is a Markdrop file embedded in this page. Try it:

::markdrop{src="https://markdrop.in/acme-pricing-calculator" title="Acme pricing calculator" height=600 summary="Pick a plan (Starter 9, Team 19 or Scale 39 dollars per seat a month), set the number of seats and choose monthly or yearly billing; the monthly and yearly totals update as you go. Fictional prices."}

## What renders

| File on Markdrop | In the guide |
| --- | --- |
| HTML page, or a zipped website | Runs in the page, in a sandbox, with **Full screen** and **Open on Markdrop** |
| PDF | Markdrop's PDF viewer: page by page, zoom, fit width, download |
| Video | The docs video player, with captions and chapters when you add them |
| Spreadsheet, Word document, image, Markdrop document | A card that opens it on Markdrop |

Each block has a bar with the file's title, its type and size (or length), **Full screen** and **Open on Markdrop**. Drag the bar under a page or PDF to make it taller; on a phone it fills the width.

![A PDF embedded in a guide page in the dark theme: the Acme price list 2026, page 1 of 3, with zoom, Fit width and Download, and Text version under it.](/docs-assets/guides/embed-files/pdf.webp)

## Add a file

::::steps
### Insert the block
In the [editor](/guides/editor), type `/markdrop` (or choose **Markdrop file** from the **+** menu), or choose **Embed a Markdrop file** in the status bar under the page.

### Pick the file
**Your files** lists what you've published on Markdrop, newest first, and the guide's workspace has its own tab. Search by name, or narrow to **Interactive**, **Websites**, **PDFs**, **Videos** or **Documents**. You can also **Paste a link** to any file you can open, or **Upload** one: it's published on Markdrop, viewable by anyone with the link, and embedded straight away.

### Check what readers see
The block shows the file as readers will see it. Under it: **Readers can see it** when anyone with the link can view the file, the title, how it **Shows** (**Live**, **On click** or **Card**), its **Size** and its **Text version**.
::::

![Embed a Markdrop file: Your files with search and the kind filters, then the files with their type, size and age; Acme roadmap (internal) is marked Private.](/docs-assets/guides/embed-files/picker.webp)

## Who can see it

A guide shows a file only to readers who could open its link anyway. If the file is private, password-protected, only for its workspace's members, or [end-to-end encrypted](/sharing/end-to-end-encryption), readers see a short notice instead, with nothing about the file, not even its name.

When you pick a file like that, the studio says so first. If it's yours, **Make viewable and embed** changes it to **Anyone with the link can view**, the same setting as in the file's Share dialog. You can change it back on Markdrop at any time, and the guide follows at once.

![Readers can't see this file yet: Acme roadmap (internal) is private, so readers of this guide will see a notice instead. Make viewable and embed, Embed anyway, Back.](/docs-assets/guides/embed-files/sharing-gate.webp)

## Replace the file, every guide updates

The page keeps only the file's link. When a reader scrolls to the block, the guide asks Markdrop what the file is now, so:

- **Replace the file** on Markdrop (a new version of the prototype, an updated price list) and every guide that embeds it shows the new one. No republish.
- **Make it private or delete it**, and it stops showing in every guide at once.
- **Rename its link**, and the old link still works.

To keep a guide on one version while you keep working on the file, choose it under **Version** (people who can edit the file can pin any kept version). Readers then see that version until you choose **Latest** again.

## The text version

Search, Ask AI, AI agents (the page's Markdown and llms.txt) and people using screen readers can't watch a video or click through a prototype. Every block has a text version they get instead:

- **Your summary**, under **Text version** in the block: say what the file shows and what to try. It's shown under the block and to readers without JavaScript.
- **A PDF's text and contents**, read from the file when you publish.
- **A video's chapters and transcript**, from WebVTT files you add with **Add captions** and **Add chapters** in the block.

This is what the calculator above looks like to an agent reading this page as Markdown:

```md wrap
[Interactive page: Acme pricing calculator](https://markdrop.in/acme-pricing-calculator)

Pick a plan (Starter 9, Team 19 or Scale 39 dollars per seat a month), set the number of seats and choose monthly or yearly billing; the monthly and yearly totals update as you go. Fictional prices.
```

:::note[A PDF's text updates when you publish]
The file in the block is always the current one. Its extracted text (for search and AI) is refreshed each time you publish the guide.
:::

## Security

Embedded HTML is someone's code running inside your docs, so it never runs on your guide's address:

- **A separate site.** Files render on Markdrop's file domain (a separate registrable domain), never on your guide's address or markdrop.in.
- **A locked sandbox.** HTML runs with no access to cookies, storage, your guide's page or any other customer's file, and it can't send readers to another page. It can still run scripts, use forms and open dialogs, so demos work.
- **Twice over.** The frame's sandbox is repeated by the file server as a security header, so it holds even if the page is opened on its own.
- **Your pages frame nothing else.** Published guide pages may only frame Markdrop's file domain and the embed hosts you allowed.

![A test page embedded in a guide reports what it can reach: localStorage, cookies, the guide page, its address, IndexedDB, a service worker and navigating the guide away are all blocked, and its own origin is opaque.](/docs-assets/guides/embed-files/sandbox-probe.webp)

## See how readers use them

With [Insights](/guides/insights) on, **Embedded files** shows each block with its page: views, how many readers used it, full-screen opens and opens on Markdrop. For a video: plays, how far viewers got and where most of them stop. For a PDF: the page readers typically reach. Each file's own analytics on Markdrop counts these views too, under the **Guides** channel, with your guide's name.

![Embedded files: the pricing calculator (64 views, 66% used it), the product tour (41 views, 30 plays, the 25%, 50%, 75% and end bars, 13 of 30 viewers stop around 0:15) and the price list (page 1 of 3 reached).](/docs-assets/guides/embed-files/insights.webp)

Nothing about a reader is kept beyond what Insights already keeps: no cookie, no account, nothing for Do Not Track.

## In Markdown

The block is one line. Everything but `src` is optional:

```md
::markdrop{src="https://markdrop.in/acme-pricing-calculator" title="Pricing calculator" height=600 summary="What it does."}
```

| Attribute | What it does |
| --- | --- |
| `src` | The file's Markdrop link |
| `title` | The block's title (else the file's own) |
| `summary` | The text version |
| `height` | The frame's height in pixels, 160 to 2000 (pages and PDFs) |
| `aspect` | A shape instead of a height, like `16:9`, or `9:16` for a phone prototype |
| `mode` | `live` (default), `preview` (loads on click) or `card` |
| `version` | Pin a kept version |
| `captions`, `chapters` | WebVTT files of the guide, for a video |
