---
title: Publish your first file
description: Upload an HTML page, PDF, spreadsheet, Word document, image, video or zipped site and get a link that opens it rendered.
updated: 2026-10-30
prerequisites: [/get-started/accounts]
keywords: [upload, artifact, file, pdf, html, video, quickstart]
---

Upload a file and Markdrop gives you a link that opens it, rendered, in any browser. A PDF opens as pages, a spreadsheet as a grid with tabs, a video in a player. Readers don't download anything and don't need an account.

Publishing a file needs a free Markdrop account. You can fill everything in first: signed out, the button reads **Sign in and publish**, and everything you entered is still there after you sign in.

::video{id="publish-first-file" title="Publish your first file" duration="0:50"}

## Upload it

::::steps
### Open the upload page
Go to [markdrop.in/upload](https://markdrop.in/upload), or choose **Create › Artifact**.

### Add your file
Drag a file onto the page, or choose **Choose a file**. One file per link. To publish a whole site, upload it as a `.zip`; see [Publish a zipped website](/files/websites).

Markdrop shows a **Preview** of how the file will render. It's drawn in your browser, before anything uploads.

### Check the title and link
The **Title** and **Link** fill in from the file name: `Q3 Board Deck.pdf` becomes the title `Q3 Board Deck` and the link `markdrop.in/q3-board-deck`. Change either one. The title shows in the browser tab and in link previews.

### Choose who can open it (optional)
**Who can open it** starts as **Anyone with the link**. You can choose **Only people added** instead, add a **Password**, or set an **Expires** date. Members of a workspace can also pick a **Location** to file it in a workspace folder.

### Choose Publish
The page shows upload progress. Keep the tab open until it finishes. When it's done, the file opens at its new link with a **Published** panel and **Copy link**.
::::

## What you can upload

| Kind | Opens as |
| --- | --- |
| HTML page | A live web page |
| PDF | Readable pages |
| Excel (`.xlsx`, `.xls`) or CSV | A sheet with tabs |
| Word (`.docx`) | A formatted document |
| Images, including SVG | The full-size image |
| Video and audio | A player that streams and seeks |
| JSON and text | Text with line numbers |
| Zipped site | A multi-page site, opening at its `index.html` |

Most files can be up to 25 MB. Video and audio can be up to 2 GB. See [Supported file types](/files/supported-types) and [File size and storage limits](/files/limits).

## Files render on a separate domain

Markdrop serves what you upload from a different domain than markdrop.in, inside a sandboxed frame. An HTML page's scripts run, but they can't reach Markdrop or your account. See [How files are served](/security/how-files-are-served).

## Change it later

The file is in **My files**, under **Artifacts**. Open it and choose **More artifact actions** (the `⋯` button):

- **Settings** changes the title, link, password and expiry, and lets you replace the file. The link stays the same. See [Replace a file and restore versions](/files/replace-and-versions).
- **Share** chooses who can open it and adds people by email. See [Share with specific people](/sharing/share-with-people).
- **Delete artifact** removes it and its link for everyone.

## Next steps

::::cards
:::card[Supported file types]{href="/files/supported-types" icon="doc"}
Every format Markdrop renders, and how each one looks.
:::
:::card[Upload large files]{href="/files/large-uploads" icon="upload"}
Recordings up to 2 GB, and resumable uploads from the terminal.
:::
:::card[Video and audio]{href="/files/video-and-audio" icon="film"}
The player, keyboard shortcuts, and what to do when a video won't play.
:::
::::
