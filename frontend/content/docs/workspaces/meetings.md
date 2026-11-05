---
title: Meetings
description: Turn every team call into a page with an AI summary, decisions and action items, keep the transcript, and ask questions across all your meetings.
updated: 2026-11-05
keywords: [meetings, meeting notes, transcript, google meet, gemini, gemini notes, take notes for me, notes by gemini, meeting page, summary, decisions, action items, open questions, topics, team memory, meetings folder, auto import, import meetings automatically, series, recurring meetings, daily standup, by month, organise meetings, organize meetings]
---

Meetings turns a call into a page in your workspace. Bring in Google Meet's transcript, Gemini's meeting notes, or both, and Markdrop writes:

- the summary;
- the decisions;
- the action items, with the people who own them;
- the open questions and the topics.

It keeps the transcript, and it answers questions about one meeting or all of them. Every answer links to the moment something was said.

## Two ways to bring meetings in

Use either, or both side by side. Markdrop recognizes a call it already has, so a meeting never shows up twice. To bring in weeks of earlier calls at once, use [Import past meetings](/workspaces/meetings-import#import-past-meetings).

::::cards
:::card[Import manually]{href="/workspaces/meetings-import" icon="upload"}
Paste a transcript, upload a file, or pick the Docs Google saved in your Drive. Works for Zoom and Teams captions too.
:::
:::card[Import automatically]{href="/workspaces/meetings-auto-import" icon="refresh"}
Connect Google Meet once. Every recorded or noted call shows up by itself, about 15 minutes after it ends.
:::
::::

## How meetings are organised

The first meeting creates a folder called **Meetings** in the workspace. Every meeting page is filed there, with these properties:

- **Date**: the day the meeting happened, not the day it was imported.
- **Type** (Standup, Planning, Review, 1:1, Interview, Customer or Other).
- **Series**: the recurring meeting it belongs to, such as "Daily Standup" or "Sprint review".
- **Attendees**, **Organizer**, **Duration** and **Action items**.

Markdrop sets the **Series** by itself. Meetings whose names differ only by numbers or dates, like "Sprint 23 review" and "Sprint 24 review", belong to the same series. A meeting joins a series once a second meeting of that name arrives. To change a meeting's series, or take it out of one, edit **Series** in the meeting's **Details**. Markdrop doesn't change it back.

The Meetings folder opens on **All meetings**: a table, newest first, grouped by month. **By series** shows a board with a column for each series, and **Series table** groups the table by series. Sort, filter or add views as in any folder; see [Folders](/workspaces/folders). Renaming the folder is fine: it stays the Meetings folder.

The workspace's **Meetings** page lists every meeting you can open by month, newest first. Select a series above the list to see only that series, or **One-offs**. Open the page with **Ask meetings** in the Meetings folder. A meeting that came in automatically is marked **Auto**.

![The Meetings page: series to filter by (Daily Standup, One-offs) above the meetings, listed by month with their date, series, type and people.](/docs-assets/workspaces/meetings-import/organised.webp)

## What the meeting page holds

- **Summary.** Either AI's summary, or Google's notes when they came in.
- **Decisions.**
- **Action items**, as a checklist. If the person who owns an item is a member of the workspace, they are @mentioned and notified, in Markdrop and by email unless they turned emails off. Other names stay plain text. Tick items off as they get done.
- **Open questions** and **Topics.**
- **Details**, when Google's notes came in.
- **Sources.** The **Transcript** sub-page, with a line for each turn and the time it was said, plus links back to the Google Docs.

Links like **12:34** next to a decision or an action item open the transcript at that moment. Google Meet marks the time only every five minutes, so the times in between are estimated.

When Google's notes are there, Markdrop uses them as written, marked **From Google Meet notes**. That covers the summary, the details and the suggested next steps. AI only adds what the notes leave out: the decisions, the open questions, the topics, and any action items the next steps miss.

The page is an ordinary page. Edit it like any other: fix a name, add notes, tick off action items. Everything AI writes is in **English**, even when the call mixes Hindi and English or another language. The transcript stays as it was spoken.

## From an AI app

With the [hosted MCP server](/ai/hosted-mcp), an AI app can import a meeting (`import_meeting`) or many past ones (`import_meetings_bulk`), list meetings (`list_meetings`, filtered by series, dates or how they came in), read one (`get_meeting`), ask them (`ask_meetings`, scoped to a series or dates), and check whether automatic import is on (`meetings_connection`). See [MCP tools](/ai/tools#meetings).

## Next

::::cards
:::card[Ask your meetings]{href="/workspaces/meetings-ask" icon="sparkle"}
Ask one meeting or all of them. Answers link to the moment it was said.
:::
:::card[Privacy and cost]{href="/workspaces/meetings-privacy" icon="lock"}
Who can open a meeting, restricted meetings, how long transcripts are kept, and the AI budget.
:::
::::
