---
title: Ask
description: One assistant, named after what it answers from. Ask your workspace ("Ask Acme"), your own files ("Ask my files") or the page you're on ("Ask this page"), on its own page or beside what you're reading, with live suggestions and cited sources.
updated: 2026-11-06
keywords: [ask, ask your workspace, ask any page, ask my files, ask this page, ask page, full page, suggestions, live suggestions, suggested questions, what's happening, updated, topics, history, conversations, ask markdrop, never empty, cut short, slack, /markdrop ask, ask, assistant, ai, question, answer, cmd j, ctrl j, ⌘j, keyboard, shortcut, this doc, this page, meetings, this meeting, this folder, workspace, everything, scope, insert, insert into doc, view mode, edit mode, home, dashboard, catch me up, this week, action items, my tasks, to-dos, follow-up, conversation, recent questions, sources, citations, transcript, moment, ai search, meetings ai, phone, app, side panel]
---

**Ask** is one assistant, everywhere in Markdrop. Ask a question in plain words and it answers from what you can open, citing where each part came from, so you can check it in one tap. The conversation follows you from screen to screen.

Its name follows what it answers from:

| You see | It answers from |
| --- | --- |
| **Ask Acme** (your workspace's name) | Everything in that workspace you can open: its meetings, documents, pages and files. Your team's live suggestions are here. |
| **Ask my files** | Your own documents, pages and files outside any workspace. |
| **Ask this page** | The document, page, PDF, video, sheet or file you're on first, then what your meetings decided about it. Works on links shared with you too. |
| **Ask** | Everything you can open, in every workspace. |

## Open it

- **Ask** in the sidebar opens the [Ask page](#the-ask-page): your conversations, the scope chips and suggestions, full height. In a workspace, it opens on that workspace.
- **✦ Ask** in the top bar of any document, page, file, workspace or folder opens Ask beside it (**Ask this page** on an item).
- **⌘ J** (**Ctrl J** on Windows and Linux) from anywhere in Markdrop, and again to close it. Inside a page you're editing, **⌘ J** keeps its own job, [Ask AI on your writing](/pages/ai#rewrite-a-selection): click outside the text first, or use **✦ Ask**.
- **The Ask bar on your [home](/get-started/tour#your-home)**: type a question and press **Enter**. Its chip says what it asks (**Everything**, a workspace or **My files**), and the chips under it are your team's live questions (see [Suggested questions](#suggested-questions)). It's the same assistant and the same conversation.
- **Ask** in the **⌘ K** command palette (**Ask Acme** inside a workspace).
- **Ask this meeting** on a meeting page, and the **Ask** box on the Meetings page.

On a computer, ✦ Ask and **⌘ J** open it as a panel beside what you're reading, so you can keep scrolling, select text and click links while it answers. On a phone it opens as a sheet from the bottom. **Esc** closes it, and **Open full page** (the expand button in its header) takes the same conversation to the Ask page.

## The Ask page

**Ask** in the sidebar opens Ask as its own page:

- **Your conversations** on the left: select one to continue it, **×** to forget it, **New chat** to start over. On a phone or a tablet held upright, **History** opens them.
- **The scope chips** at the top: **Everything**, one chip per workspace you're in, and **My files**. The title follows the chip: **Ask**, **Ask Acme**, **Ask my files**. The page remembers your last chip on this device.
- **An empty conversation** shows a big question box and suggestions. Select one and it's asked at once, in that scope.

The page's address keeps where you are, so you can bookmark it: `/ask?workspace=…` opens on a workspace, and a conversation you open is in the address too.

![The Ask page: conversations on the left, the title Ask Acme with the scope chips Everything, Acme and My files, and suggested questions with their topics.](/docs-assets/workspaces/ask-markdrop/ask-page.webp)

::clip{src="/docs-assets/workspaces/ask-markdrop/assistant" alt="Pressing ⌘J on a page opens Ask beside it, a question about what's still open before the release is typed, the answer arrives with numbered sources, and Insert puts it at the end of the page."}

## What it answers from

The chips at the top of the panel say what Ask answers from. It starts on the one that fits where you are, and you can switch at any time, even in the middle of a conversation:

| Chip | Answers from | Starts here when you're in |
| --- | --- | --- |
| **This page** | The document or page you're in first, then what your meetings decided about it, then the rest of its workspace | A document or a page |
| **Meetings** | The workspace's meetings you can open: their transcripts and notes | The Meetings page, a meeting, a meetings folder |
| **This folder** | Only the documents, pages and files in that folder and its sub-folders | A folder |
| **Acme** (a chip per workspace) | Everything in that workspace you can open, meetings included | A workspace |
| **My files** | Your own documents, pages and files that aren't in any workspace | — |
| **Everything** | Every meeting, document, page, file and [Guide](/guides/overview) you can open | Your home, and anywhere else |

Only the chips for things you can open are shown. If Markdrop can't tell where you are, for example when the connection drops, the panel says "Couldn't check this place" and answers from **Everything**.

![Ask opened on a page: the scope chips This page, Meetings, the workspace, My files and Everything, and suggested questions for the doc.](/docs-assets/workspaces/ask-markdrop/assistant-scopes.webp)

### This page

In a document or page, questions are about it first. Ask "Summarize this", "What's still open here?" or "When did we decide this?". Ask knows which section you're in and what you selected: select a paragraph, then ask "Is this still true?" or "Who owns this?". For when, why and who questions, the answer comes from your meetings and names the meeting and its date. See [Meeting memory while writing](/pages/meeting-memory).

### Meetings

On **Meetings**, more chips appear in the question box:

- **This meeting** or **All meetings**, on a meeting page.
- A series, such as **Daily Standup**.
- A period: **This week**, **Last 7 days**, **This month**, **Last month** or **Last 90 days**.

You can also say it in the question: "What came up in the Daily Standups last month?" asks only that series, in that month, and the answer starts with what it looked at. Answers say when and where something was said ("On 28 Oct, in Daily Standup, Bo said…") and their sources open the transcript at the moment. See [Ask your meetings](/workspaces/meetings-ask).

## Read the answer

The answer streams in under your question with numbered sources, like **1** and **2**. Select a number, or **3 sources** under the answer, to see each source: its title, date and place, what it says there, and **Open** (or **Jump to moment** for a meeting line).

Under an answer:

- **Copy** copies the answer with its sources.
- **Insert** puts the answer into the doc you're in (see below).
- **Ask again** asks the same question again.
- Follow-up questions to pick in one tap.

AI can be wrong, so check the sources. When nothing you can open answers the question, the answer says so. An answer is never blank: if one runs long, you get what was written with a note that it was cut short, and you can ask a narrower question for the rest.

![An answer in Ask: the question, the scope it used, the answer with numbered sources, and under it 3 sources, Copy, Insert and Try again, then follow-up questions.](/docs-assets/workspaces/ask-markdrop/assistant-page.webp)

## Insert an answer into the doc

If you can edit the document or page you're in, **Insert** puts the answer into it, with its sources as links:

- **In a page you're editing**, the answer goes in as its own blocks after the line where your cursor is. Click where it should go first.
- **In a page you're reading** (View mode), the page switches to **Edit** with the answer at the end of the section you were reading. It saves like anything you type; choose **Done** when you're finished.
- **In a document you're editing**, it goes in at your cursor in the Markdown, as its own paragraph.
- **In a document you're reading**, the editor opens with the answer after the section you were reading. Nothing is saved until you choose **Save changes**.

Ask never changes a doc by itself: an answer goes in only when you choose **Insert**.

## Follow-ups and one conversation

Ask a follow-up in the same box, like "and the annual discount?" or "who's doing that?". Markdrop reads the earlier questions in the conversation, so short follow-ups work, even when you switched chips in between.

The conversation follows you. Ask on your home, open a page and press **⌘ J**: the conversation is there, and the next question can be about the page. **New chat**, under the question box, starts over.

## Suggested questions

When the conversation is empty, Ask suggests questions for where you are.

### Your team's, live

On a workspace (**Ask Acme**, on the Ask page, in the panel, and as chips under the home's Ask bar), the suggestions come from what's happening in it now. If your daily sync-ups have been about Sourcing all week, you'll see **Sourcing: What did we decide about Sourcing this week?** and **Sourcing: What's still open?**. Each has its topic above it, and **Updated 2 h ago** says when they were written. Select one and it's asked at once.

- **What they're made from.** The last 7 days of the workspace: the topics, decisions and action items of its meetings, and the titles and headings of pages that changed. Only what **every member** of the workspace can open is used: a meeting [restricted to its attendees](/workspaces/meetings-privacy#restricted-meetings), a private page, a password-protected or [encrypted](/sharing/end-to-end-encryption) item is never read. That's why everyone in the workspace sees the same list.
- **When they change.** A few minutes after meetings or pages change (once things are quiet), and at least once a day. Edits that don't touch a title or heading don't change them.
- **AI off.** In a workspace whose admin turned [AI features](/pages/ai#turn-ai-off-for-a-workspace) off, there are no team suggestions.

### Your own

Next to them, a few that are only yours, without AI: **What are my open action items?**, **Catch me up on** your latest meeting, and **What did I say in the last Daily Standup?** (your latest meeting series). Elsewhere, and on **Everything**:

- **Catch me up on this week.** What changed in the last 7 days among the items you can open, meetings first: the decisions, what moved in documents, and what most needs your attention.
- **What are my open action items?** Every unchecked task that @mentions you, in pages you can open, most urgent first. Meeting action items are tasks like these, so the ones assigned to you show up here. If you have none, you get the answer straight away, without using AI.
- **What was decided in…** your most recent meeting.

You can also type these. "What did I miss?" catches you up and "What's on my plate?" lists your tasks. A workspace chip and **This folder** catch you up on just that place.

## Recent conversations

The [Ask page](#the-ask-page) lists your conversations on the left, and **Recent questions** beside the home's Ask bar lists the latest ones. Select one to open it and continue asking, there or anywhere with **⌘ J**. Select **×** to forget one, or **Clear all** to forget them all.

Only you can see your conversations. Markdrop keeps them for 90 days after your last question in each, then deletes them. See [Privacy](/security/privacy#what-ask-keeps).

## What Ask reads

Ask finds items with the same search as [Search](/workspaces/search), so it sees exactly what you can open:

- **Your access, checked twice.** Only items you can open now are read. Every source in an answer is checked again before you see it, and again when you reopen a conversation. If you lost access to something an earlier answer cited, that answer is hidden, and it isn't sent with later questions.
- **Meetings follow their rules.** A meeting [restricted to its attendees](/workspaces/meetings-privacy#restricted-meetings) is never read for anyone else, whichever chip you ask on. Transcript lines are read only when you can open the transcript.
- **A folder only narrows.** **This folder** never reads anything you couldn't open anyway.
- **My files is only yours.** **Ask my files** reads only items you own that aren't in a workspace.
- **Protected items stay protected.** [End-to-end encrypted](/sharing/end-to-end-encryption) items are never read, and **This page** isn't offered on them. A password-protected item is read by its title only.
- **AI off means off.** Nothing is read from a workspace whose admin turned [AI features](/pages/ai#turn-ai-off-for-a-workspace) off.

:::note[What is sent to AI]
Ask uses Claude Haiku 5.5 from Anthropic. It sends your question, earlier questions in the same conversation, the heading of the section you're in and any text you selected, and short excerpts of the matching items you can open. Transcripts are sent only to answer you. For a workspace's suggestions, it sends the meeting topics, decisions and action items and the page titles and headings that every member can open. Nothing is used to train models. See the [privacy policy](https://markdrop.in/privacy#processors).
:::

## AI limits

Which limit a question counts towards depends on the chip:

| Chip | Limit |
| --- | --- |
| **This page**, **This folder**, a workspace, **My files**, **Everything** | **AI search**, shared with [Search](/workspaces/search#ask-ai): $2 a day and $20 a month across Markdrop |
| **Meetings** | **Meetings AI**, shared with meeting summaries: $5 a day and $50 a month across Markdrop |

A workspace's suggestions are written once for everyone, under their own small limit (**Ask suggestions**: $0.50 a day and $5 a month across Markdrop), and don't count towards yours. When it's reached, the last suggestions stay.

Your own AI limits apply too. A question costs about a tenth of a cent. When a limit is reached, the panel says so and when AI will be back; you can switch chips, and your conversations still open.

## On your phone

On a phone, the panel opens as a sheet that stays above the keyboard. The chips scroll sideways, every button is easy to tap, and opening a source closes the sheet. The Ask page works on phones and tablets too: your conversations are under **History**.

## Keyboard

| Shortcut | What it does |
| --- | --- |
| **⌘ J** | Open or close Ask (on the Ask page: go to the question box) |
| **Enter** | Ask; **Shift Enter** starts a new line |
| **↑** in an empty box | Bring back your last question to edit |
| **Esc** | Stop an answer that is still being written, close the sources, or close the panel |

## From Slack, an AI app or the API

- **Slack.** `/markdrop ask` asks the workspace Slack is connected to, the way **Ask Acme** does (or **Everything**, when you aren't a member of it), and `/markdrop meetings` the way **Meetings** does. Only you see the answer. See [Slack](/integrations/slack#search-and-ask-from-slack).

- **MCP.** The hosted MCP server's `ask_documents` tool asks the same way. Pass its `thread_id` back to ask a follow-up, set `intent` to `catch_up` or `my_actions`, `page` to ask about a doc first, `folder` (with `scope`) to ask one folder, or `scope` `mine` to ask your own files. `ask_suggestions` gives a workspace's live suggestions and yours. `ask_meetings` asks meetings and `meeting_context` finds what was decided about a topic. See [MCP tools](/ai/tools#read-and-find).
- **API.** `POST /api/v1/ask` streams an answer as Server-Sent Events; its `scope` says what to answer from (`doc`, `meetings`, `folder`, `workspace`, `mine` or `everything`). `GET /api/v1/ask/context` says which scopes are offered where you are, `GET /api/v1/ask/suggestions?workspace=` gives the suggestions, and `/api/v1/ask/threads` lists, opens and deletes your conversations. See the [API reference](/api/overview).

## Related

- [Ask your meetings](/workspaces/meetings-ask)
- [Meeting memory while writing](/pages/meeting-memory)
- [AI in pages](/pages/ai)
- [Search](/workspaces/search)
- [Slack](/integrations/slack)
