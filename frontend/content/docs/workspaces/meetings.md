---
title: Meetings
description: Turn every team call into a page with an AI summary, decisions and action items, keep the transcript, and ask questions across all your meetings.
updated: 2026-11-05
keywords: [meetings, meeting notes, transcript, google meet, gemini, take notes for me, notes by gemini, zoom, teams, vtt, srt, sbv, docx, import, summary, decisions, action items, open questions, ask this meeting, ask across meetings, team memory, attendees, restrict, meetings ai, hindi, english]
---

Meetings turns a call into a page in your workspace. Import Google Meet's transcript, Gemini's meeting notes, or both, and Markdrop writes:

- the summary;
- the decisions;
- the action items, with the people who own them;
- the open questions and the topics.

It keeps the transcript, and it answers questions about one meeting or all of them. Every answer links to the moment something was said.

## Import a meeting

1. Open your workspace and choose **New** › **Import a meeting**. You can also open the **Meetings** folder and select **Import meeting**.
2. Bring the meeting in one of three ways:
   - **Paste** the transcript or the notes.
   - **Upload** `.txt`, `.vtt`, `.srt`, `.sbv`, `.docx` or `.md` files, up to 6 at a time and 4 MB each.
   - **Google Docs**: pick the Docs Google saved in your Drive. See [From Google Meet](#from-google-meet).
3. Check what Markdrop found: the meeting's name, its date, how many transcript lines, and who spoke. Change the **Title**, **Date** or **Type** if you need to.
4. Select **Import meeting**. The page opens straight away, and the summary fills in a few seconds later.

The first import creates a folder called **Meetings** in the workspace. Every meeting page is filed there, with these properties:

- **Date**
- **Type** (Standup, Planning, Review, 1:1, Interview, Customer or Other)
- **Attendees**
- **Organizer**
- **Duration**
- **Action items**

You can sort and filter by them, or show the folder as a board. See [Folders](/workspaces/folders). Renaming the folder is fine: it stays the Meetings folder.

Markdrop reads these formats:

- Google Meet transcripts;
- Gemini notes, including notes with the transcript in a second tab;
- Zoom and Microsoft Teams captions (`.vtt`);
- `.srt` and YouTube `.sbv` captions;
- Otter-style exports ("Name  0:41" followed by the words);
- any text with `Name: words` lines.

Plain prose works too, without speakers. A very long call is cut at about 11 hours of talk.

## From Google Meet

After a call, Google can save two Docs in your Drive:

- **the transcript**: "*Meeting name* (date) - Transcript", with a line per speaker;
- **the notes**: "Notes by Gemini", from **Take notes for me**. They have a **Summary**, **Details** and **Suggested next steps**. Newer notes also hold the transcript in a second tab.

Import either one, or both. When you pick both, Markdrop pairs them by the meeting's name and date into one meeting.

To pick them from Drive, choose **Google Docs** in the import dialog. The first time, select **Connect Google Docs** to link your Google account. This is the same Google connection as **Publish to Google Docs**; see [Connected apps](/account/connected-apps). Then select **Choose from Google Drive** and pick the Docs. Markdrop can open only the files you pick: it never sees the rest of your Drive.

When Google's notes are there, Markdrop uses them as written, marked **From Google Meet notes**. That covers the summary, the details and the suggested next steps. AI only adds what the notes leave out: the decisions, the open questions, the topics, and any action items the next steps miss. If you import only the notes, without a transcript, you still get the page, and **Ask this meeting** answers from the notes.

## What the meeting page holds

- **Summary.** Either AI's summary, or Google's notes when you imported them.
- **Decisions.**
- **Action items**, as a checklist. If the person who owns an item is a member of the workspace, they are @mentioned and notified, in Markdrop and by email unless they turned emails off. Other names stay plain text. Tick items off as they get done.
- **Open questions** and **Topics.**
- **Details**, when you imported Google's notes.
- **Sources.** The **Transcript** sub-page, with a line for each turn and the time it was said, plus links back to the Google Docs.

Links like **12:34** next to a decision or an action item open the transcript at that moment. Google Meet marks the time only every five minutes, so the times in between are estimated.

The page is an ordinary page. Edit it like any other: fix a name, add notes, tick off action items. Everything AI writes is in **English**, even when the call mixes Hindi and English or another language. The transcript stays as it was spoken.

## Ask a meeting

On a meeting page, select **Ask this meeting** at the bottom right. Ask anything, for example "What did we decide about pricing?" or "What did Priya take on?". The answer comes from that meeting's transcript and its page, including your edits. Chips like **Ada Lovelace, 12:34** open the transcript at the moment it was said. Ask follow-ups in the same thread.

**Details**, next to **Ask**, shows:

- who was there, and where the meeting came from;
- the cost of its AI summary;
- **Write it again**, to redo the summary;
- **Restrict to attendees**;
- **Delete meeting**.

## Ask across meetings

Open the workspace's Meetings page: select **Ask meetings** in the Meetings folder, or go to **All meetings** from a meeting's **Details**. Ask a question in **Ask across meetings**, for example "What's blocking the release?" or "What are my open action items?".

Markdrop finds the meetings that match with the same search as [Search](/workspaces/search), then answers from them. Answers cite each meeting and the moment in it. When meetings disagree, the later one wins and the answer says so.

## Who can see a meeting

- **The team, by default.** Everyone in the workspace can open a meeting page and its transcript, like any page set to **Workspace**. See [Privacy](/workspaces/privacy).
- **Restrict to attendees.** Switch it on when you import, or later from the meeting's **Details**. Only the attendees who are members of the workspace can then open the meeting. Only the person who imported it can switch this.
- **Answers follow your access.** Ask this meeting and Ask across meetings use only the meetings you can open. Each meeting is checked again when you ask, and every source in an answer is checked again before you see it. A meeting restricted from you never reaches the AI when you ask.
- **Delete.** The person who imported a meeting can delete it, and so can workspace **admins and owners**, for any meeting, even a restricted one. Its pages go to [Trash](/documents/trash) for 30 days, and the stored transcript the AI answers from is deleted at once. Until then, Markdrop keeps the transcript for as long as the meeting exists.

Transcripts are sent only to the AI model, Claude Haiku 5.5, and only to answer you or to write the meeting's sections. They are never used to train models.

## AI limits

Meetings uses Claude Haiku 5.5 under its own budget, **Meetings AI**: $5 a day and $50 a month across Markdrop. A summary costs about a fifth of a cent for an hour-long call, and a question costs less.

When a limit is reached, imports still work, but without the AI sections. Select **Write it again** later. Meetings AI is also off in a workspace whose AI features are turned off. In that case meetings import with their transcript and Google's notes only.

## From an AI app

With the [hosted MCP server](/ai/hosted-mcp), an AI app can import a meeting (`import_meeting`), list meetings (`list_meetings`), read one (`get_meeting`) and ask them (`ask_meetings`). See [MCP tools](/ai/tools#meetings).

## Related

- [Search](/workspaces/search)
- [Folders](/workspaces/folders)
- [Privacy](/workspaces/privacy)
- [MCP tools](/ai/tools)
