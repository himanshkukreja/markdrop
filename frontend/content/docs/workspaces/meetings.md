---
title: Meetings
description: Turn every team call into a page with an AI summary, decisions and action items, keep the transcript, and ask questions across all your meetings.
updated: 2026-11-05
keywords: [meetings, meeting folders, subfolders, other meetings, organize meetings, meeting notes, transcript, google meet, gemini, gemini notes, take notes for me, notes by gemini, meeting page, summary, decisions, action items, open questions, topics, team memory, meetings folder, auto import, import meetings automatically, series, recurring meetings, daily standup, by month, organise meetings, organize meetings]
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

The first meeting creates a folder called **Meetings** in the workspace. Inside it, every meeting is filed in a folder of its own kind:

- **A recurring meeting** gets a folder named after it, such as **Meetings › Daily Sync Up**. A meeting is recurring once its name has come up on two or more different days. Names that differ only by numbers or dates, like "Sprint 23 review" and "Sprint 24 review", count as the same meeting. When the second one arrives, the first moves into the new folder too. Case, spaces and punctuation don't count either: "Daily Syncup", "Daily Sync Up" and "daily sync-up" are one series. Different words stay different meetings: "Daily Standup" isn't "Daily Syncup".
- **Everything else** goes to **Meetings › Other meetings**.

Each of these folders opens on **All meetings**: a table, newest first, grouped by month. Every meeting page has these properties:

- **Date**: the day the meeting happened, not the day it was imported.
- **Type** (Standup, Planning, Review, 1:1, Interview, Customer or Other).
- **Series**: the recurring meeting it belongs to, such as "Daily Sync Up".
- **Attendees**, **Organizer** (who ran the call, when Markdrop knows: see [Organizer and imported by](/workspaces/meetings-import#organizer-and-imported-by)), **Duration** and **Action items**.

Sort, filter or add views as in any folder; see [Folders](/workspaces/folders). Renaming a folder is fine: Markdrop keeps filing that series there.

To move a meeting to another series, or take it out of one, edit **Series** in the meeting's **Details**. The page moves to that series' folder, and Markdrop doesn't change it back. Meetings imported before folders, or moved by hand, can be filed again: a workspace admin selects **Organize meetings** on the Meetings page. It moves each meeting, with its transcript, into its folder, puts the spellings of one series together, and says how many meetings it filed and how many series there are. Running it again changes nothing that's already in place.

**Who can open a meeting** depends on who was there. A 1:1 or a two-person call starts restricted to its attendees. A call with three or more people is open to the workspace's team. You can change it for any meeting; see [Privacy and cost](/workspaces/meetings-privacy).

The workspace's **Meetings** page lists every meeting you can open by the day it happened, newest first, under month headings. To change the order, use the sort menu next to the filter: **Meeting date, newest**, **Meeting date, oldest**, **Title** or **Recently imported**. Markdrop remembers your choice on this device. Select a series above the list to see only that series, or **One-offs**. Open the page with **Ask meetings** in the Meetings folder. A meeting that came in automatically is marked **Auto**.

![The Meetings page: series to filter by (Daily Standup, One-offs) above the meetings, listed by month with their date, type and people.](/docs-assets/workspaces/meetings-import/organised.webp)

## What the meeting page holds

Every meeting page has a cover from Markdrop's cover gallery. All the meetings of one series share a cover, so a series is easy to spot, and other series get different ones. A one-off meeting gets the general meeting cover. Change or remove a cover like on any page; Markdrop doesn't put its own back.

- **Summary.** Either AI's summary, or Google's notes when they came in.
- **Decisions.**
- **Action items**, as a checklist. If the person who owns an item is a member of the workspace, they are @mentioned and notified, in Markdrop and by email unless they turned emails off. Other names stay plain text. Tick items off as they get done.
- **Open questions** and **Topics.**
- **Details**, when Google's notes came in.
- **Sources.** The **Transcript** sub-page, with a line for each turn and the time it was said, plus links back to the Google Docs. The transcript belongs to its meeting: folder views, counts and search show the meeting once, not its transcript as a second item. A word that was only said in the call finds the meeting page. Open the transcript from **Sources**, from **Details**, or under the meeting page in the sidebar.

Links like **12:34** next to a decision or an action item open the transcript at that moment. Google Meet marks the time only every five minutes, so the times in between are estimated.

When Google's notes are there, Markdrop uses them as written, marked **From Google Meet notes**. That covers the summary, the details and the suggested next steps. AI only adds what the notes leave out: the decisions, the open questions, the topics, and any action items the next steps miss.

The page is an ordinary page. Edit it like any other: fix a name, add notes, tick off action items. Everything AI writes is in **English**, even when the call mixes Hindi and English or another language. The transcript stays as it was spoken.

## From an AI app

With the [hosted MCP server](/ai/hosted-mcp), an AI app can import a meeting (`import_meeting`) or many past ones (`import_meetings_bulk`), list meetings (`list_meetings`, filtered by series, dates or how they came in), read one (`get_meeting`), ask them (`ask_meetings`, scoped to a series or dates), get what was decided about a topic while writing a document (`meeting_context`), and check whether automatic import is on (`meetings_connection`). See [MCP tools](/ai/tools#meetings).

## Next

::::cards
:::card[Ask your meetings]{href="/workspaces/meetings-ask" icon="sparkle"}
Ask one meeting or all of them. Answers link to the moment it was said.
:::
:::card[Meeting memory while writing]{href="/pages/meeting-memory" icon="lines"}
See what was decided in meetings while you write a page, and insert it as a cited line.
:::
:::card[Privacy and cost]{href="/workspaces/meetings-privacy" icon="lock"}
Who can open a meeting, restricted meetings, how long transcripts are kept, and the AI budget.
:::
::::
