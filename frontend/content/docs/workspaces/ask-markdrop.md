---
title: Ask Markdrop
description: One assistant everywhere. Ask about the doc you're in, your meetings, a folder, a workspace or everything you can open, with cited sources, follow-ups and ⌘J.
updated: 2026-11-06
keywords: [ask markdrop, about me, about yourself, who am i, what did i say, my last standup, my last sync-up, my meetings, my documents, what have i been working on, my email, my workspaces, my role, never empty, cut short, slack, /markdrop ask, ask, assistant, ai, question, answer, cmd j, ctrl j, ⌘j, keyboard, shortcut, this doc, this page, meetings, this meeting, this folder, workspace, everything, scope, insert, insert into doc, view mode, edit mode, home, dashboard, catch me up, this week, action items, my tasks, to-dos, follow-up, conversation, recent questions, sources, citations, transcript, moment, ai search, meetings ai, phone, app, side panel]
---

**Ask Markdrop** is one assistant, everywhere in Markdrop. Ask a question in plain words about the doc you're reading, your meetings, a folder, a workspace or everything you can open. Each answer cites where it came from, so you can check it in one tap, and the conversation follows you from screen to screen.

## Open it

- **✦ Ask** in the top bar of any document, page, workspace or folder.
- **⌘ J** (**Ctrl J** on Windows and Linux) from anywhere in Markdrop, and again to close it. Inside a page you're editing, **⌘ J** keeps its own job, [Ask AI on your writing](/pages/ai#rewrite-a-selection): click outside the text first, or use **✦ Ask**.
- **The Ask bar on your [home](/get-started/tour#your-home)**: type a question and press **Enter**, or choose **Catch me up**, **My action items** or **Ask my meetings**. It's the same assistant and the same conversation.
- **Ask this meeting** on a meeting page, and the **Ask** box on the Meetings page.

On a computer it opens as a panel beside what you're reading, so you can keep scrolling, select text and click links while it answers. On a phone it opens as a sheet from the bottom. **Esc** closes it.

::clip{src="/docs-assets/workspaces/ask-markdrop/assistant" alt="Pressing ⌘J on a page opens Ask Markdrop beside it, a question about what's still open before the release is typed, the answer arrives with numbered sources, and Insert puts it at the end of the page."}

## What it answers from

The chips at the top of the panel say what Ask Markdrop answers from. It starts on the one that fits where you are, and you can switch at any time, even in the middle of a conversation:

| Chip | Answers from | Starts here when you're in |
| --- | --- | --- |
| **This doc** | The document or page you're in first, then what your meetings decided about it, then the rest of its workspace | A document or a page |
| **Meetings** | The workspace's meetings you can open: their transcripts and notes | The Meetings page, a meeting, a meetings folder |
| **This folder** | Only the documents, pages and files in that folder and its sub-folders | A folder |
| **Workspace** | Everything in the workspace you can open, meetings included | A workspace |
| **Everything** | Every meeting, document, page, file and [Guide](/guides/overview) you can open | Your home, and anywhere else |

Only the chips for things you can open are shown. A document in your personal space has **This doc** and **Everything**. If Markdrop can't tell where you are, for example when the connection drops, the panel says "Couldn't check this place" and answers from **Everything**.

![Ask Markdrop opened on a page: the scope chips This doc, Meetings, Workspace and Everything, and suggested questions for the doc.](/docs-assets/workspaces/ask-markdrop/assistant-scopes.webp)

### This doc

In a document or page, questions are about it first. Ask "Summarize this", "What's still open here?" or "When did we decide this?". Ask Markdrop knows which section you're in and what you selected: select a paragraph, then ask "Is this still true?" or "Who owns this?". For when, why and who questions, the answer comes from your meetings and names the meeting and its date. See [Meeting memory while writing](/pages/meeting-memory).

### Meetings

On **Meetings**, more chips appear in the question box:

- **This meeting** or **All meetings**, on a meeting page.
- A series, such as **Daily Standup**.
- A period: **This week**, **Last 7 days**, **This month**, **Last month** or **Last 90 days**.

You can also say it in the question: "What came up in the Daily Standups last month?" asks only that series, in that month, and the answer starts with what it looked at. Answers say when and where something was said ("On 28 Oct, in Daily Standup, Bo said…") and their sources open the transcript at the moment. See [Ask your meetings](/workspaces/meetings-ask).

## Ask about yourself

Ask Markdrop knows who is asking. Ask about yourself the way you'd ask a colleague, with "I", "me" and "my":

- "What did I say in my last sync-up?"
- "What did I commit to in the last sprint planning?"
- "Did I speak in today's standup?"
- "Which meetings did I attend this week?"
- "What have I been working on lately?"
- "What did I sign off recently?"
- "What are my open action items?"
- "Who am I?", "What's my email?", "Which workspaces am I in?", "What's my role?"

What it knows about you:

- **Your account**: your name and email, the workspaces you belong to and your role in each, and today's date where you are.
- **How you appear in meetings.** Transcripts name speakers the way the call did, like "Himanshu" or "priya.nair". Markdrop matches those names to your account the same way it does when it imports a meeting: by email, full name, or a first name only one member has. Your own lines are quoted as yours, and nobody else's are.
- **Your meetings**: the ones you attended, organized or spoke in, newest first. Name a series ("my last sync-up") and those come first.
- **Your recent work**: documents and pages you created, edited or signed off, and meetings you imported, from the last 30 days.

Answers say where each line came from, for example "In the Nov 5 Daily Syncup you said: …", and each line links to its moment in the transcript. If you were in a meeting but didn't speak, the answer says "You attended but didn't speak". If you weren't in the meeting you asked about, it says so and names the latest one you were in.

Questions about you follow the same rules as any other question. The only profile Ask Markdrop reads is yours. A meeting [restricted to its attendees](/workspaces/meetings-privacy#restricted-meetings) is never read for anyone else, and other people's email addresses are never part of an answer.

This works the same way in **Meetings**, **This doc**, **Workspace** and **Everything**, and through the MCP tools `ask_documents` and `ask_meetings` (the account behind the AI app is "you").

## Read the answer

The answer streams in under your question with numbered sources, like **1** and **2**. Select a number, or **3 sources** under the answer, to see each source: its title, date and place, what it says there, and **Open** (or **Jump to moment** for a meeting line).

Under an answer:

- **Copy** copies the answer with its sources.
- **Insert** puts the answer into the doc you're in (see below).
- **Ask again** asks the same question again.
- Follow-up questions to pick in one tap.

AI can be wrong, so check the sources. When nothing you can open answers the question, the answer says so. An answer is never blank: if one runs long, you get what was written with a note that it was cut short, and you can ask a narrower question for the rest.

![An answer in Ask Markdrop: the question, the scope it used, the answer with numbered sources, and under it 3 sources, Copy, Insert and Try again, then follow-up questions.](/docs-assets/workspaces/ask-markdrop/assistant-page.webp)

## Insert an answer into the doc

If you can edit the document or page you're in, **Insert** puts the answer into it, with its sources as links:

- **In a page you're editing**, the answer goes in as its own blocks after the line where your cursor is. Click where it should go first.
- **In a page you're reading** (View mode), the page switches to **Edit** with the answer at the end of the section you were reading. It saves like anything you type; choose **Done** when you're finished.
- **In a document you're editing**, it goes in at your cursor in the Markdown, as its own paragraph.
- **In a document you're reading**, the editor opens with the answer after the section you were reading. Nothing is saved until you choose **Save changes**.

Ask Markdrop never changes a doc by itself: an answer goes in only when you choose **Insert**.

## Follow-ups and one conversation

Ask a follow-up in the same box, like "and the annual discount?" or "who's doing that?". Markdrop reads the earlier questions in the conversation, so short follow-ups work, even when you switched chips in between.

The conversation follows you. Ask on your home, open a page and press **⌘ J**: the conversation is there, and the next question can be about the page. **New chat**, under the question box, starts over.

## Suggested questions

When the conversation is empty, Ask Markdrop suggests questions for where you are. On your home and on **Everything**:

- **Catch me up on this week.** What changed in the last 7 days among the items you can open, meetings first: the decisions, what moved in documents, and what most needs your attention.
- **What are my open action items?** Every unchecked task that @mentions you, in pages you can open, most urgent first. Meeting action items are tasks like these, so the ones assigned to you show up here. If you have none, you get the answer straight away, without using AI.
- **What was decided in…** your most recent meeting.

You can also type these. "What did I miss?" catches you up and "What's on my plate?" lists your tasks. **Workspace** and **This folder** catch you up on just that place.

## Recent conversations

On your home, **Recent questions** (beside the Ask bar) lists your last conversations. Select one to open it and continue asking, there or anywhere with **⌘ J**. Select **×** to forget one, or **Clear all** to forget them all.

Only you can see your conversations. Markdrop keeps them for 90 days after your last question in each, then deletes them. See [Privacy](/security/privacy#what-ask-markdrop-keeps).

## What Ask Markdrop reads

Ask Markdrop finds items with the same search as [Search](/workspaces/search), so it sees exactly what you can open:

- **Your access, checked twice.** Only items you can open now are read. Every source in an answer is checked again before you see it, and again when you reopen a conversation. If you lost access to something an earlier answer cited, that answer is hidden, and it isn't sent with later questions.
- **Meetings follow their rules.** A meeting [restricted to its attendees](/workspaces/meetings-privacy#restricted-meetings) is never read for anyone else, whichever chip you ask on. Transcript lines are read only when you can open the transcript.
- **A folder only narrows.** **This folder** never reads anything you couldn't open anyway.
- **Protected items stay protected.** [End-to-end encrypted](/sharing/end-to-end-encryption) items are never read, and **This doc** isn't offered on them. A password-protected item is read by its title only.
- **AI off means off.** Nothing is read from a workspace whose admin turned [AI features](/pages/ai#turn-ai-off-for-a-workspace) off.

:::note[What is sent to AI]
Ask Markdrop uses Claude Haiku 5.5 from Anthropic. It sends your question, earlier questions in the same conversation, the heading of the section you're in and any text you selected, your own name, email, workspaces and the names you appear under in meetings, and short excerpts of the matching items you can open. Transcripts are sent only to answer you. Nothing is used to train models. See the [privacy policy](https://markdrop.in/privacy#processors).
:::

## AI limits

Which limit a question counts towards depends on the chip:

| Chip | Limit |
| --- | --- |
| **This doc**, **This folder**, **Workspace**, **Everything** | **AI search**, shared with [Search](/workspaces/search#ask-ai): $2 a day and $20 a month across Markdrop |
| **Meetings** | **Meetings AI**, shared with meeting summaries: $5 a day and $50 a month across Markdrop |

Your own AI limits apply too. A question costs about a tenth of a cent. When a limit is reached, the panel says so and when AI will be back; you can switch chips, and your conversations still open.

## On your phone

On a phone, Ask Markdrop opens as a sheet that stays above the keyboard. The chips scroll sideways, every button is easy to tap, and opening a source closes the sheet.

## Keyboard

| Shortcut | What it does |
| --- | --- |
| **⌘ J** | Open or close Ask Markdrop |
| **Enter** | Ask; **Shift Enter** starts a new line |
| **↑** in an empty box | Bring back your last question to edit |
| **Esc** | Stop an answer that is still being written, close the sources, or close the panel |

## From Slack, an AI app or the API

- **Slack.** `/markdrop ask` answers the way **Everything** does (or **Workspace**, for the workspace Slack is connected to), and `/markdrop meetings` the way **Meetings** does. Only you see the answer. See [Slack](/integrations/slack#search-and-ask-from-slack).

- **MCP.** The hosted MCP server's `ask_documents` tool asks the same way. Pass its `thread_id` back to ask a follow-up, set `intent` to `catch_up` or `my_actions`, `page` to ask about a doc first, or `folder` (with `scope`) to ask one folder. `ask_meetings` asks meetings and `meeting_context` finds what was decided about a topic. See [MCP tools](/ai/tools#read-and-find).
- **API.** `POST /api/v1/ask` streams an answer as Server-Sent Events; its `scope` says what to answer from (`doc`, `meetings`, `folder`, `workspace` or `everything`). `GET /api/v1/ask/context` says which scopes are offered where you are, and `/api/v1/ask/threads` lists, opens and deletes your conversations. See the [API reference](/api/overview).

## Related

- [Ask your meetings](/workspaces/meetings-ask)
- [Meeting memory while writing](/pages/meeting-memory)
- [AI in pages](/pages/ai)
- [Search](/workspaces/search)
- [Slack](/integrations/slack)
