---
title: Insights and exports
description: See how the discussion on a page is going (first reply, time to resolve, most-discussed sections) and export pages with their comments to Word, PDF or Markdown.
updated: 2026-11-09
prerequisites: [/collaboration/comments]
keywords: [comment insights, comment analytics, discussion analytics, first reply, time to first reply, time to resolve, most discussed, people commenting, comments tab, export with comments, include comments, open threads only, word comments, margin comments, footnotes, pdf margin notes, notes at the end, markdown comments section, comment_insights, export_page, get_document_analytics]
---

## Insights

See how the discussion on a page is going: choose **Comment insights** from the **⋯** menu of the comments panel, or open the page's [analytics](/analytics/documents-and-pdfs) and its **Comments** tab.

![Comment insights for the launch plan, last 30 days: 5 threads (4 open, 1 resolved, 9 messages), a typical first reply of 5.7 h with 2 open threads still waiting, time to resolve 6.1 h, 4 people commenting, and Most discussed: Top of the page, Support, Rollout, Risks and Whole page.](/docs-assets/collaboration/insights-and-exports/insights.webp)

- **Open threads**, how many are resolved and how many messages there are.
- **First reply**: the typical time from a new thread to the first answer from someone else (answers from Markdrop AI don't count), and how many open threads are still waiting for one.
- **Time to resolve**: the typical time from a thread's start to its resolve.
- **Most discussed**: the sections with the most threads. A thread belongs to the heading above the text it's on; a comment on the whole page counts as **Whole page**, and one whose text has since changed as **Text that changed**.
- **Activity** per day and the people who comment most (on the analytics page).

Choose **7 days**, **30 days**, **90 days** or **All** for the period. Everyone who can see a page's comments can see its insights. An AI app can read them with `comment_insights`, and `get_document_analytics` includes the counts.

## Export with comments

When you [export a page](/pages/export), turn on **Include comments** to take its threads with it. You can also choose **Export with comments…** in the comments panel's **⋯** menu, which opens the Export dialog with it already on.

![The Export page dialog for the launch plan: Markdown, Word, HTML and PDF, with Markdown chosen; Include comments on (4 threads) and Open threads only off; a note that the comments go in a Comments section at the end; Download .md.](/docs-assets/collaboration/insights-and-exports/export.webp)

| Format | Where the comments go |
| --- | --- |
| **Markdown** | A **Comments** section at the end: each thread numbered in page order, the words it's about, whether it's resolved, and every message with its author and date. |
| **Word** | **Margin comments**: real Word comments next to the words they're about (the title for a comment on the whole page). Or **Footnotes** after those words. |
| **PDF** | **Margin notes**: numbered notes beside the text. Or **Notes at the end**: a numbered list after the page. |

Turn on **Open threads only** to leave resolved ones out. A thread whose text changed since it was written is listed at the end, with the words it was first about. HTML exports never include comments.

Only people who can see a page's comments can export them: a reader who can't see them gets the page without comments. Deleted messages and threads never leave. An AI app can do the same with `export_page` (`comments`: `footnotes` or `margin`; `format`: `word` for a `.docx`).

Jira chips, cards and lists leave exports as plain links: see [Jira in pages](/collaboration/jira-in-pages#in-exports-and-ai-apps).
