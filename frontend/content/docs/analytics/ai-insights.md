---
title: AI insights for one link
description: Ask AI why readers stop, where viewers drop or skip, which PDF pages lose people and which file version works better.
updated: 2026-11-05
prerequisites: [/analytics/overview]
keywords: [ai insights, analytics ai, why did they stop, drop-off, rewrite, video coach, chapters, pdf, versions, verdict, confidence, analyze_document_engagement]
---

Numbers say *where* people stop. **✦ Insights** says *why*, and what to change. It sits at the top of a link's **Content**, **Pages**, **Video** or **Listening** and **Versions** tabs, and it reads that tab's numbers (and, where it helps, your own content) with AI.

Choose **Analyse**. In a few seconds you get a one-line summary and three to five findings, the most important first. Each finding says what the numbers show, why it matters, and what to try, and points at the exact section, moment, page or version.

## What each tab gets

| Tab | What AI looks at | What you get |
| --- | --- | --- |
| **Content** (documents and pages) | How far readers get, section by section, the time spent in each, what's copied and clicked, and the text of the sections where readers leave | Why readers stop, and a **suggested rewrite** of a section when rewriting it is the fix |
| **Video** and **Listening** | Who's still watching second by second, and up to six key moments where people drop, skip or rewatch, with a small frame of the video at each | Cuts, reorders and pacing changes at exact timestamps, and **suggested chapters** |
| **Pages** (PDFs) | Reach, time and returns per page, and the text of the pages where readers stop or linger | What to cut, move, split or summarise, page by page |
| **Versions** (files you replaced) | Each version's sessions and its main number, like **Avg watched** | A **verdict**: which version works better, with a confidence |

## Use a finding

- **A suggested rewrite.** Choose **Show a suggested rewrite**, then **Copy rewrite**. On a page you can edit, choose **Apply in page**: the page opens with the rewrite offered over that section. Nothing changes until you choose **Accept**; **Discard** leaves the page as it was.
- **A timestamp.** Choose the time on a finding to mark that moment on the **Who's still watching** chart. Choose it again to clear the mark.
- **Chapters.** Choose **Copy chapters** to paste them into a description, one `0:00 Title` line each.
- **The verdict.** The confidence (**High**, **Medium** or **Low**) is worked out by Markdrop from the number of sessions and the size of the difference, not by AI. A **Low** verdict means the difference could still be chance: wait for more sessions.

## When it's available

- **Enough data.** AI needs at least **20 sessions** with data in the period, so it has something real to say. Below that, the panel shows how many sessions there are so far, and nothing is sent. Versions are compared once two of them have at least 20 sessions each.
- **Saved and shared.** An analysis is saved for each period and version, so opening the tab again shows it without asking again. Your AI assistant sees the same analysis (see [AI tools](/ai/tools)).
- **Re-analyse.** If you edit the document or upload a new version, the panel says the analysis is out of date. Choose **Re-analyse** for a fresh one. Analyses are kept for 90 days, and deleted with the link.

## What is sent to AI

Only the tab's totals and percentages, and your own content: section text, PDF page text, video frames and the link's title. **Nothing about individual readers is ever sent**: no IP addresses or visitor hashes, no countries, devices or referrers of anyone, no account or session ids.

End-to-end encrypted links never send content. For an encrypted document there is no **Content** analysis (its sections aren't tracked); an encrypted PDF, video or audio file is analysed from the numbers only.

The text you get back is AI-written: check it before you use it. See [AI and your data](/security/ai-and-your-data).

## Limits

Each analysis counts towards your AI limits. If a workspace admin turned **AI features** off (the **Advanced** tab of the workspace's settings), its links can't be analysed. When a limit is reached, the panel says which one and when it resets; saved analyses still show.

## Ask your AI assistant

With Markdrop connected to your AI assistant, ask "Why do readers stop reading my getting-started guide?" or "Which version of the demo video works better?". It uses the `analyze_document_engagement` tool. See [AI tools](/ai/tools).

## Next

::::cards
:::card[Documents and PDFs]{href="/analytics/documents-and-pdfs" icon="doc"}
Section reach, copied code, clicked links and page-by-page reading.
:::
:::card[Video and audio]{href="/analytics/video-and-audio" icon="film"}
Who's still watching, key moments and playback quality.
:::
::::
