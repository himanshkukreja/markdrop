---
title: Ask your meetings
nav: Ask meetings
description: Ask one meeting or every meeting in a workspace. Answers are in English and link to the moment it was said.
updated: 2026-11-05
keywords: [ask this meeting, ask across meetings, ask meetings, meeting questions, what did we decide, action items, citations, sources, transcript moment, jump to the moment, follow-ups, new chat, stop, conversation, details, write it again, series, last month, date range, latest, keyboard]
---

Ask a question about one meeting, or about all the meetings you can open in a workspace. Answers come from the transcripts and the meeting pages, including your edits, and every answer links to where it came from.

## Ask a meeting

On a meeting page, select **Ask this meeting** in the bar under the meeting's properties (or the button at the bottom right). Pick a suggested question or ask your own, for example "What did we decide about pricing?" or "What did Priya take on?".

![The meeting bar under a meeting's properties: who was there, who can open it, Transcript and Ask this meeting.](/docs-assets/workspaces/meetings-ask/meeting-bar.webp)

The answer streams in with numbered sources, like **1** and **2**. Select a number, or **2 sources** under the answer, to see each source: the meeting, its date and series, who spoke and when (**Ben Member · 12:34**), and the line itself. **Jump to the moment** opens the transcript at that line.

Ask follow-ups in the same conversation, or pick one of the follow-up questions under the answer. The conversation is kept: reopen the meeting later, even on another day, and it's still there. **New chat** starts over.

If the meeting has only Google's notes, without a transcript, the answer comes from the notes.

**Details**, next to **Ask**, shows:

- who was there, and where the meeting came from (imported by hand, by [Connect Google Meet](/workspaces/meetings-auto-import), or by an AI app);
- the cost of its AI summary;
- **Write it again**, to redo the summary;
- **Restrict to attendees**;
- **Delete meeting**.

## Ask across meetings

Open the workspace's Meetings page: select **Ask meetings** in the Meetings folder, or go to **All meetings** from a meeting's **Details**. Select the **Ask anything about your meetings** box at the top, or one of the questions under it, for example "What's blocking the release?" or "What are my open action items?". The conversation opens beside your meetings on a computer, and full screen on a phone. Select **Expand** to read it page-wide, with the sources beside the answer.

![Ask across meetings beside the Meetings page: the question, an answer with numbered sources, and follow-up questions under it.](/docs-assets/workspaces/meetings-ask/ask-across.webp)

![The sources of an answer: the meeting, its date, who spoke and when, the line itself, and Jump to the moment.](/docs-assets/workspaces/meetings-ask/sources.webp)

Markdrop finds the meetings that match with the same search as [Search](/workspaces/search), then answers from them. Answers say when and where something was said, for example "On 28 Oct, in Daily Standup, Bo said…", and cite each meeting and the moment in it. When meetings disagree, the later one wins and the answer says so. Questions about the current state, like "What's the latest on pricing?" or "Is the release still on Friday?", look at the most recent meetings first.

### One series, or a period

In the question box, pick a series (such as **Daily Standup**) and a period (**Last 7 days**, **Last 30 days**, **This month** or **Last month**) to ask only those meetings.

You can also say it in the question: "What came up in the Daily Standups last month?" asks only that series, in that month. The answer starts with what it looked at, such as **From your question: Daily Standup · October 2026**. Names Markdrop doesn't know as a series are ignored, so the question still gets an answer from all your meetings.

Answers always use only the meetings you can open. See [Privacy and cost](/workspaces/meetings-privacy).

### Keyboard

- **Enter** sends; **Shift+Enter** starts a new line.
- **↑** in an empty box brings back your last question to edit.
- **Esc** stops an answer that is still being written, or closes the sources.

A saved conversation is yours alone. If you can no longer open a meeting an answer used, that answer is hidden when you come back to it.

To ask across meetings and everything else at once, use [Ask Markdrop](/workspaces/ask-markdrop) at the top of your home. It cites meeting moments the same way, and **My open action items** lists the action items assigned to you across meetings.

## From an AI app

`ask_meetings` asks one meeting or a whole workspace from an AI app connected to the [hosted MCP server](/ai/hosted-mcp), optionally only one `series` or dates (`since`, `until`). It counts towards the same **Meetings AI** limit. See [MCP tools](/ai/tools#meetings).

## Related

- [Ask Markdrop](/workspaces/ask-markdrop)
- [Meetings](/workspaces/meetings)
- [Search](/workspaces/search)
- [Privacy and cost](/workspaces/meetings-privacy)
