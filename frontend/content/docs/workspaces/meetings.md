---
title: Meetings
description: Turn every team call into a page with an AI summary, decisions and action items, keep the transcript, and ask questions across all your meetings.
updated: 2026-11-06
keywords: [meetings, mentions in meetings, meeting notifications, no notifications, meetings page, all meetings, meeting cards, search meetings, sort meetings, meeting date, one-offs, meeting folders, subfolders, other meetings, organize meetings, organize into folders, organize progress, organise meetings, meeting notes, transcript, google meet, gemini, gemini notes, take notes for me, notes by gemini, meeting page, meeting cover, series cover, summary, decisions, action items, open questions, topics, team memory, meetings folder, auto import, import meetings automatically, series, recurring meetings, daily standup, by month, by series, delete meeting, organize_meetings, meeting memory, /meetings]
---

Meetings turns a call into a page in your workspace. Bring in Google Meet's transcript, Gemini's meeting notes, or both, and Markdrop writes:

- the summary;
- the decisions;
- the action items, with the people who own them;
- the open questions and the topics.

It keeps the transcript, and it answers questions about one meeting or all of them. Every answer links to the moment something was said.

To see how meetings feed Team, Ask and Slack, read [Meetings and Team: how it fits together](/workspaces/meetings-and-team).

:::details[Watch: Your workspace remembers (2:23)]
A two-and-a-half-minute video of one team's day: the call's notes arrive by themselves, each person gets their action items in Slack, Team shows who's on what, and anyone can ask.

::video{id="team-meetings" title="Your workspace remembers: meetings become pages, Team shows who's on what, and you can just ask" duration="2:23"}
:::

## Find your meetings

- **Your [home](/get-started/tour#your-home)** shows the latest meetings across your workspaces, and today's in **Today**. Your action items from them are in **Your action items**.
- **In the sidebar**, open a workspace and choose **Meetings** for its Meetings page: every meeting as a card, search, series and **Ask**.

## Two ways to bring meetings in

Use either, or both side by side. Markdrop recognizes a call it already has, so a meeting never shows up twice. To bring in weeks of earlier calls at once, use [Import past meetings](/workspaces/meetings-import#import-past-meetings).

::::cards
:::card[Import manually]{href="/workspaces/meetings-import" icon="upload"}
Paste a transcript, upload a file, or pick the Docs Google saved in your Drive. Works for Zoom and Teams captions too.
:::
:::card[Import automatically]{href="/workspaces/meetings-auto-import" icon="refresh"}
Connect Google Meet once. Every recorded or noted call shows up by itself, a few minutes after Google writes its notes or transcript (or right away with **Check for new meetings**).
:::
::::

## How meetings are organised

The first meeting creates a folder called **Meetings** in the workspace. Inside it, every meeting is filed in a folder of its own kind:

- **A recurring meeting** gets a folder named after it, such as **Meetings › Daily Sync Up**. A meeting is recurring once its name has come up on two or more different days. Names that differ only by numbers or dates, like "Sprint 23 review" and "Sprint 24 review", count as the same meeting. When the second one arrives, the first moves into the new folder too. Case, spaces and punctuation don't count either: "Daily Syncup", "Daily Sync Up" and "daily sync-up" are one series. Different words stay different meetings: "Daily Standup" isn't "Daily Syncup".
- **Everything else** goes to **Meetings › Other meetings**.

The **Meetings** folder itself opens on these folders. Each of them opens on **All meetings**: a table, newest first, grouped by month. **Other meetings** also has a **By series** board and a **Series table**. Every meeting page has these properties:

- **Date**: the day the meeting happened, not the day it was imported.
- **Type** (Standup, Planning, Review, 1:1, Interview, Customer or Other).
- **Series**: the recurring meeting it belongs to, such as "Daily Sync Up".
- **Attendees** (who joined the call, not everyone invited: see [Attendees and invited](/workspaces/meetings-import#attendees-and-invited)), **Organizer** (who ran the call, when Markdrop knows: see [Organizer and imported by](/workspaces/meetings-import#organizer-and-imported-by)), **Duration** and **Action items**.

Sort, filter or add views as in any folder; see [Folders](/workspaces/folders). Renaming a folder is fine: Markdrop keeps filing that series there.

To move a meeting to another series, or take it out of one, edit **Series** in the meeting's details (select **Meeting** at the bottom right of the page). The page moves to that series' folder, and Markdrop doesn't change it back. Leave **Series** empty to make it a one-off.

### Organize meetings

Meetings imported before folders, or moved by hand, can be filed again. A workspace admin selects **⋯ › Organize meetings** on the Meetings page. Before anything changes, the window shows what will happen:

- How many meetings there are, how many **series folders** they go into, and how many go to **Other meetings**, with the folders listed as they'll look inside **Meetings**.
- How many meetings move into another folder (each with its transcript), and how many join a series. The spellings of one series are put together, so "Daily Syncup" joins "Daily Sync Up".
- That each series gets its cover, on pages nobody chose a cover for, and how many transcripts are tucked under their meeting page instead of listed beside it.

![The Organize meetings window before anything changes: 4 meetings go into 1 series folder plus 2 in Other meetings, the Meetings folder as it will look (Daily Standup and Other meetings, 2 each), that every meeting is already in its folder, that each series gets its own cover, and Organize 4 meetings.](/docs-assets/workspaces/meetings/organize.webp)

Select **Organize** to start. It runs on Markdrop's servers and shows its progress, such as "Organizing 34 of 80 meetings". You can close the window: the Meetings page keeps a progress line, and the list refreshes when it's done. At the end you see how many meetings moved, how many series and folders there are, and how many covers were set. If a meeting couldn't be organized, it's named, and running **Organize meetings** again retries it.

Nothing is deleted, every link keeps working, and a series someone set by hand stays as it is. Running it again changes nothing that's already in place. If two people start it at the same time, they both follow the same run. Empty extra folders of a series, and the empty folder of a series whose meetings joined another, are removed; a folder with anything in it always stays.

AI apps can do the same with the `organize_meetings` tool. It waits up to about 50 seconds; for a big workspace it returns the progress so far, and calling it again follows the same run.

**Who can open a meeting** depends on who was there. A 1:1 or a two-person call starts restricted to its attendees. A call with three or more people is open to the workspace's team. You can change it for any meeting; see [Privacy and cost](/workspaces/meetings-privacy).

## The Meetings page

The workspace's **Meetings** page is where you import meetings, connect Google Meet and ask across them. To open it, select **Meeting** at the bottom right of any meeting page, then **All meetings**. The Meetings folder's **Import meeting**, **Import past meetings** and **Connect Google Meet** buttons open it too, with that step ready.

It lists every meeting you can open by the day it happened, newest first, under month headings that stay at the top as you scroll. One meeting is one card: its transcript isn't listed separately. Each card shows:

- the series' cover with the month and day;
- the title, with the day, time and length, and the series it belongs to;
- a line of its summary (or "Google's notes are on the page" when only Google's notes came in);
- who was there, and how many decisions, action items and open questions it has.

A meeting that came in automatically is marked **Auto**, one only its attendees can open is marked **Attendees only**, and one whose summary is still being written shows **Summarizing**. Point at a meeting (or tap **⋯** on a phone) to open its transcript or ask it. Its **⋯** menu also copies its link, and **Delete meeting** is there for the person who imported it and workspace admins.

Search by title, series or person in the box above the list. To change the order, use the sort menu next to it: **Meeting date, newest**, **Meeting date, oldest**, **Title** or **Recently imported**. The two date orders group by month; the others are one list. Markdrop remembers your choice on this device. Select a series chip to see only that series, or **One-offs** for meetings without one. Search, the chips and the order cover every meeting you can open, not only the ones on screen.

The page shows the first 30 meetings straight away and loads more as you scroll down, or when you select **Load more meetings** at the end of the list. Going back from a meeting returns you to the same place in the list.

The **Ask anything about your meetings** box above the list opens [Ask](/workspaces/ask-markdrop) on your meetings. See [Ask your meetings](/workspaces/meetings-ask).

Workspace admins also see a card for each meeting restricted to attendees they weren't part of, without its title, so they can delete it.

![The Meetings page on a phone: Import meeting and the ⋯ menu (Check for new meetings is in it), Google Meet connected with how the script's last run went, the Ask box, search, sort, series chips, and the newest meeting marked Auto.](/docs-assets/workspaces/meetings/hub-phone.webp)

![The Meetings page: search, sort and the series to filter by above the meetings, listed by month with their cover and date, summary, people and counts.](/docs-assets/workspaces/meetings-import/organised.webp)

## What the meeting page holds

Every meeting page has a cover from Markdrop's cover gallery. All the meetings of one series share a cover, so a series is easy to spot, and other series usually get different ones (there are twelve series covers). A one-off meeting gets the general meeting cover. Change or remove a cover like on any page; Markdrop doesn't put its own back. In a workspace with **Auto covers** turned off, meetings get no cover.

- **Summary.** Either AI's summary, or Google's notes when they came in.
- **Decisions.**
- **Action items**, as a checklist. If the person who owns an item is a member of the workspace, they are @mentioned, as a link to them, and the item shows under **Your action items** on their [home](/get-started/tour#your-home). Other names stay plain text. Tick items off as they get done.
- **Open questions** and **Topics.**
- **Details**, when Google's notes came in.
- **Sources.** The **Transcript** sub-page, with a line for each turn and the time it was said, plus links back to the Google Docs. The transcript belongs to its meeting: folder views, counts and search show the meeting once, not its transcript as a second item. A word that was only said in the call finds the meeting page. Open the transcript from **Sources**, from **Details**, or under the meeting page in the sidebar.

Links like **12:34** next to a decision or an action item open the transcript at that moment. Google Meet marks the time only every five minutes, so the times in between are estimated.

When Google's notes are there, Markdrop uses them as written, marked **From Google Meet notes**. That covers the summary, the details and the suggested next steps. AI only adds what the notes leave out: the decisions, the open questions, the topics, and any action items the next steps miss.

:::note[Mentions in meeting notes don't notify anyone]
Markdrop never notifies anyone about the @mentions it writes into a meeting: no bell, email, phone notification or Slack mention message, whether the meeting came in by hand, from a Drive link, from the Google Meet script, from an AI app or with Import past meetings, and not when its summary is written again later. People find their action items on their home and in the meeting page, and, when your workspace has Slack connected, in [one Slack message after the meeting](#action-items-in-slack). The meeting can still be [posted to your Slack meetings channel](/integrations/slack). If you edit a meeting page yourself and @mention someone, they're notified as on any page.
:::

The page is an ordinary page. Edit it like any other: fix a name, add notes, tick off action items. Everything AI writes is in **English**, even when the call mixes Hindi and English or another language. The transcript stays as it was spoken.

![The Meeting details panel: Ask this meeting, the date, type, series, transcript, action items, organizer, who imported it, Invited (7, on the calendar invite, joined or not), who was there (4), the sources, the Only the people who were there switch and the AI summary.](/docs-assets/workspaces/meetings/meeting-details.webp)

## Action items in Slack

When your workspace has [Slack connected](/integrations/slack), everyone in the meeting with an action item (attendees, people on the invite and the organizer) gets a direct message from Markdrop about a minute after the summary is ready: "Your action items from *the meeting*", with only their own items and their due dates. That includes people who aren't in your Markdrop workspace: they get the item text and who to ask for the notes, nothing else. Members get **Open the notes**, and a **Done** button on each item when they can edit the page. Anyone can select **Stop these**; an admin can turn it off for the workspace. See [Your action items after each meeting](/integrations/slack#your-action-items-after-each-meeting).

## From an AI app

With the [hosted MCP server](/ai/hosted-mcp), an AI app can import a meeting (`import_meeting`, from text, a file or a Google Drive link) or many past ones (`import_meetings_bulk`), list meetings (`list_meetings`, filtered by series, dates or how they came in), read one (`get_meeting`), ask them (`ask_meetings`, scoped to a series or dates), get what was decided about a topic while writing a document (`meeting_context`), file every meeting into its series folder (`organize_meetings`, workspace admins), check whether automatic import is on and what's waiting for Gemini's notes (`meetings_connection`), check for new meetings now (`check_meetings_now`), and post a meeting to the workspace's Slack channel (`post_meeting_to_slack`). See [MCP tools](/ai/tools#meetings).

## While you write

In any page of the workspace, **From meetings** (or `/meetings` in the editor) shows what your meetings decided about the page, and inserts it as a cited line. See [Meeting memory while writing](/pages/meeting-memory). New meetings can also be posted to a Slack channel; see [Slack](/integrations/slack).

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
