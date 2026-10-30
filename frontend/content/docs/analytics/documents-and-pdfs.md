---
title: Document and PDF analytics
description: See how far people read a document, which sections hold them, what they copy and click, and which PDF pages they reach.
updated: 2026-10-30
prerequisites: [/analytics/overview, /analytics/what-gets-counted]
keywords: [read depth, read to the end, sections, scroll, pdf pages, copies, links, reading time]
---

For documents and PDFs, analytics answers one question above all: did people read it? Open the link's analytics page from [Analytics](https://markdrop.in/dashboard/analytics) to see the numbers on this page.

## Documents

### Document overview

| Number | What it means |
| --- | --- |
| **Views** | Times the document was opened. |
| **People** | Distinct visitors. |
| **Read to the end** | Share of reading sessions that got through the last 10% or so of the document. |
| **Median read time** | Active reading time of the typical reader. |
| **Copies & link clicks** | Code blocks copied and links clicked. |

How far someone read is measured by scrolling: the furthest point of the document that reached the bottom of their screen.

### Content tab

The **Content** tab breaks the document down by its headings.

- **How far people read, section by section** shows, for each section, how many readers reached it and how long they spent there. Flags point out the section that's **Most copied**, where people spend **Most time**, and where **Readers leave here**.
- **Most copied** lists the code blocks people copy most. Markdrop counts which of your blocks get copied; what readers copy is never stored.
- **Links people click** lists the links readers follow from the document.
- If people print the document, you see how many times.

The tiles at the top are **Readers** (reading sessions), **Read it all** (reached the last section), **Time spent reading** (typical reader, active time only) and **Copies and clicks**.

![The Content tab for Getting started with Acme: tiles for Readers, Read it all, Time spent reading and Copies and clicks; How far people read, section by section, with a bar and time per heading and flags for Most copied, Most time and Readers leave here; Most copied and Links people click on the right.](/docs-assets/analytics/documents-and-pdfs/content-tab.webp)

A section counts as reached when its heading passes about a third of the way down the reader's screen. Time in a section is active time while that heading is the current one.

:::tip
Long sections that most people never finish are a good place to split or trim. The section where **Readers leave here** shows up is usually the one to rewrite first.
:::

## PDFs

### PDF overview

| Number | What it means |
| --- | --- |
| **Views** and **People** | As for documents. |
| **Reached the last page** | Share of reading sessions that got to the last page. |
| **Median read time** | Active reading time of the typical reader. |
| **Pages read** | The furthest page the typical reader reached, out of the total. |

### Pages tab

- **Viewers who reached each page** shows how many readers got to each page. Markdrop tells you where the biggest drop is, like "The biggest drop is after page 3".
- **Time spent on each page** shows where readers slow down.
- **Every page** lists each page with **Reached**, **Typical time** and **Came back to it** (readers who returned to that page).

![The Pages tab for a 12-page PDF: Viewers who reached each page, with page 4 marked −30% and the note "The biggest drop is after page 3", and Time spent on each page, where page 4 holds attention longest.](/docs-assets/analytics/documents-and-pdfs/pages-tab.webp)

A page counts as current when it's about a third of the way down the reader's screen.

:::note[Long PDFs]
Markdrop's PDF viewer shows the first 50 pages and offers the rest as a download. Page analytics cover the pages the viewer shows, so a longer PDF reads "50+ pages", and reaching page 50 counts as reaching the end.
:::

## Other files

For files that aren't documents, PDFs, video or audio, like a spreadsheet or a web page, the overview shows **Median time** and **Returning** (people who came back on another day).

## Encrypted documents

For an [end-to-end encrypted](/sharing/end-to-end-encryption) document, Markdrop records only time and how far people scrolled. Sections, copies and links aren't recorded, because Markdrop can't read the document.
