---
title: Ask your meetings
nav: Ask meetings
description: Ask one meeting or every meeting in a workspace with Ask Markdrop. Answers are in English and link to the moment it was said.
updated: 2026-11-05
keywords: [ask markdrop, cmd j, ask meetings button, meetings chat, meeting chat, meeting bar, organized by, meeting details, post to slack, all meetings, this meeting, any series, any time, ask this meeting, ask across meetings, ask meetings, meeting questions, what did we decide, action items, citations, sources, transcript moment, jump to the moment, follow-ups, new chat, stop, conversation, details, write it again, series, last month, date range, latest, keyboard]
---

Ask a question about one meeting, or about all the meetings you can open in a workspace. Answers come from the transcripts and the meeting pages, including your edits, and every answer links to where it came from.

You ask with [Ask Markdrop](/workspaces/ask-markdrop), the one assistant in Markdrop, on its **Meetings** chip. **⌘ J** opens it from anywhere; on a meeting page, on the Meetings page and in the Meetings folders it starts on **Meetings**. (Ask Markdrop replaced the separate meetings chat.)

## Ask a meeting

On a meeting page, select **Ask this meeting** in the bar under the meeting's properties, or **✦ Ask** in the top bar. Ask Markdrop opens on **Meetings** with **This meeting** picked. Pick a suggested question or ask your own, for example "What did we decide about pricing?" or "What did Priya take on?". Switch to **All meetings**, a series or a period in the question box to widen the question, or to **This doc** to ask about the page itself.

The meeting bar shows who was there, who organized the call (**Organized by**, when Markdrop knows), and who can open the page: **Everyone in the workspace** or **Only the people who were there**. On the transcript page, the bar has **The meeting** to go back instead of **Transcript**.

![The meeting bar under a meeting's properties: who was there, who can open it, Transcript and Ask this meeting.](/docs-assets/workspaces/meetings-ask/meeting-bar.webp)

The answer streams in with numbered sources, like **1** and **2**. Select a number, or **2 sources** under the answer, to see each source: the meeting, its date and series, who spoke and when (**Ben Member · 12:34**), and the line itself. **Jump to the moment** opens the transcript at that line.

Ask follow-ups in the same conversation, or pick one of the follow-up questions under the answer. The conversation is kept: reopen the meeting later, even on another day, and it's still there. **New chat** starts over.

If the meeting has only Google's notes, without a transcript, the answer comes from the notes.

**Meeting**, at the bottom right of a meeting page (and its transcript), opens its details, with **Ask this meeting** at the top:

- the date, time and length, the **Type** and the **Series** (change either here; see [How meetings are organised](/workspaces/meetings#how-meetings-are-organised)), how many transcript lines and action items it has;
- the **Organizer** and who imported it (**Imported by**);
- who was there (members of the workspace are marked), and the sources: the Google Docs or files it came from, and whether it came in by [Connect Google Meet](/workspaces/meetings-auto-import) or an AI app;
- **Only the people who were there**, to restrict it to its attendees (the person who imported it can switch it);
- the cost of its AI summary, and **Write it again** to redo the summary;
- **All meetings**, which opens the [Meetings page](/workspaces/meetings#the-meetings-page);
- **Post to Slack**, when the workspace has a [Slack meetings channel](/integrations/slack) and the meeting isn't restricted;
- **Delete meeting**, for the person who imported it and workspace admins.

## Ask across meetings

In the workspace's **Meetings** folder (or one of its series folders), select **Ask meetings** in the bar at the top. Or, on the [Meetings page](/workspaces/meetings#the-meetings-page), select the **Ask anything about your meetings** box at the top, or one of the questions under it, for example "What did we decide this week?", "What's the latest on the release?" or "Which questions are still open?". Ask Markdrop opens on **Meetings**, beside your meetings on a computer and as a sheet on a phone.

![Ask across meetings beside the Meetings page: the question, an answer with numbered sources, and follow-up questions under it.](/docs-assets/workspaces/meetings-ask/ask-across.webp)

![The sources of an answer: the meeting, its date, who spoke and when, the line itself, and Jump to the moment.](/docs-assets/workspaces/meetings-ask/sources.webp)

Markdrop finds the meetings that match with the same search as [Search](/workspaces/search), then answers from them. Answers say when and where something was said, for example "On 28 Oct, in Daily Standup, Bo said…", and cite each meeting and the moment in it. When meetings disagree, the later one wins and the answer says so. Questions about the current state, like "What's the latest on pricing?" or "Is the release still on Friday?", look at the most recent meetings first.

### One series, or a period

In the question box, pick a series (such as **Daily Standup**) and a period (**This week**, **Last 7 days**, **This month**, **Last month** or **Last 90 days**) to ask only those meetings.

You can also say it in the question: "What came up in the Daily Standups last month?" asks only that series, in that month. The answer starts with what it looked at, such as **From your question: Daily Standup · October 2026**. Names Markdrop doesn't know as a series are ignored, so the question still gets an answer from all your meetings.

Answers always use only the meetings you can open. See [Privacy and cost](/workspaces/meetings-privacy).

### Keyboard

- **Enter** sends; **Shift+Enter** starts a new line.
- **↑** in an empty box brings back your last question to edit.
- **Esc** stops an answer that is still being written, closes the sources, or closes Ask Markdrop.
- **⌘ J** opens or closes Ask Markdrop.

The conversation is one with the rest of Ask Markdrop: it's kept, it follows you to other pages, and a saved conversation is yours alone. If you can no longer open a meeting an answer used, that answer is hidden when you come back to it.

To ask across meetings and everything else at once, pick **Everything**, or use the box at the top of your home. It cites meeting moments the same way, and **What are my open action items?** lists the action items assigned to you across meetings.

Meeting questions count towards the **Meetings AI** limit; see [AI limits](/workspaces/ask-markdrop#ai-limits).

## From an AI app

`ask_meetings` asks one meeting or a whole workspace from an AI app connected to the [hosted MCP server](/ai/hosted-mcp), optionally only one `series` or dates (`since`, `until`). It counts towards the same **Meetings AI** limit. See [MCP tools](/ai/tools#meetings).

While you write a page, [Meeting memory](/pages/meeting-memory) shows what was decided about it, and Ask Markdrop's **This doc** answers from your meetings too.

## Related

- [Meeting memory while writing](/pages/meeting-memory)
- [Ask Markdrop](/workspaces/ask-markdrop)
- [Meetings](/workspaces/meetings)
- [Search](/workspaces/search)
- [Privacy and cost](/workspaces/meetings-privacy)
