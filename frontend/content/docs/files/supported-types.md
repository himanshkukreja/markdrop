---
title: Supported file types
description: Every file type Markdrop renders, from HTML pages and PDFs to spreadsheets, Word documents, images, video, audio and zipped sites.
updated: 2026-10-30
prerequisites: [/get-started/first-file]
keywords: [file types, formats, pdf, xlsx, csv, docx, html, svg, mp4, mov, zip, artifacts]
---

Each file you upload opens in a viewer made for its type, so readers see the content rather than a download prompt. This page lists what Markdrop accepts and what readers get for each.

## The full list

| File | Extensions | Readers see | Size limit |
| --- | --- | --- | --- |
| HTML page | `.html`, `.htm` | The page itself, running live | 25 MB |
| PDF | `.pdf` | Pages with zoom and page count | 25 MB |
| Spreadsheet | `.xlsx`, `.xls`, `.csv` | A grid with row numbers, column letters and a tab per sheet | 25 MB |
| Word document | `.docx` | The document's text, headings, lists and tables | 25 MB |
| Image | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg` | The full-size image | 25 MB |
| Text | `.txt`, `.json` | Text with line numbers and a **Wrap lines** toggle | 25 MB |
| Website | `.zip` | A multi-page site, opening at its `index.html` | 25 MB zipped |
| Video | `.mp4`, `.mov`, `.webm`, `.ogv` | A player with speed control and keyboard shortcuts | 2 GB |
| Audio | `.mp3`, `.m4a`, `.wav`, `.ogg` | The browser's audio player | 2 GB |

Markdrop checks the type when you upload. A file that isn't on this list is refused, with the list of accepted extensions.

Readers can always choose **Download** to get the original file, byte for byte.

## How each type renders

### HTML pages

An HTML file is served as the page, so its scripts, styles and fonts work. It runs inside a sandboxed frame on a separate domain, so it can't read anything from Markdrop or the reader's account. To publish HTML you have as text rather than a file, see [Publish an HTML page](/files/html-pages).

### PDFs

PDFs open in a built-in reader with page-by-page scrolling and zoom. It shows the first 50 pages; for a longer PDF it says "Showing the first 50 of N pages. Download to see the rest."

![A PDF opened on Markdrop in the built-in reader, with the toolbar showing Page 1 of 12, zoom out and zoom in around 86%, Fit width and Download.](/docs-assets/files/supported-types/viewer-pdf.webp)

### Spreadsheets

Excel workbooks open with a tab for each sheet; use the arrow keys to move between tabs. CSV files open as a single sheet. Markdrop shows the values in each cell; charts and pictures in a workbook aren't drawn.

![An Excel workbook opened on Markdrop as a grid with row numbers and column letters, tabs for its Summary, By region and Assumptions sheets, and ‘5 rows · 4 columns’.](/docs-assets/files/supported-types/viewer-sheet.webp)

### Word documents

A `.docx` is converted to clean web text: headings, paragraphs, lists, tables, links and images. The structure comes through; exact page layout, fonts and spacing don't. If the layout matters, export a PDF and upload that instead.

![A Word document opened on Markdrop as clean web text: its headings, paragraphs and bullet points, without Word's page layout.](/docs-assets/files/supported-types/viewer-docx.webp)

### Images

Images open at full size. An SVG can contain scripts, so it gets the same sandbox on a separate domain as an HTML page.

### Text and JSON

Text opens with line numbers. Very large files are cut at 2,000,000 characters or 100,000 lines, and the viewer says so; **Download** still gives the whole file.

![A JSON file opened on Markdrop with line numbers, ‘18 lines’ and a Wrap lines button in the toolbar.](/docs-assets/files/supported-types/viewer-text.webp)

### Video and audio

Video plays in Markdrop's player, which streams and seeks without downloading the whole file first. Audio uses the browser's own player. See [Video and audio](/files/video-and-audio).

### Zipped websites

A `.zip` of a built site is unpacked and served as a site, so links between its pages work. See [Publish a zipped website](/files/websites).

## Not supported

PowerPoint (`.pptx`) and other formats not in the table aren't accepted. Files can't be end-to-end encrypted; only documents can.

Markdown isn't uploaded as a file. Paste it into [a document](/get-started/first-document) instead, where it renders with headings, diagrams and math. In a workspace, a `.md` file you drop onto a folder becomes a document there.

## More about files

::::cards
:::card[Size and storage limits]{href="/files/limits" icon="info"}
25 MB per file, 2 GB for video and audio, 20 GB per account.
:::
:::card[Upload large files]{href="/files/large-uploads" icon="upload"}
Resumable, verified uploads from the terminal.
:::
:::card[Publish an HTML page]{href="/files/html-pages" icon="code"}
Turn HTML from an AI assistant into a live link.
:::
:::card[Publish a zipped website]{href="/files/websites" icon="archive"}
Serve a whole static site at one link.
:::
:::card[Replace a file]{href="/files/replace-and-versions" icon="clock"}
Swap the file behind a link and restore earlier versions.
:::
:::card[Video and audio]{href="/files/video-and-audio" icon="film"}
The player, shortcuts, and what to do when a video won't play.
:::
::::
