---
title: Ask Markdrop
description: Ask one question across your meetings, documents, pages, files and Guides from your home, with cited sources and follow-ups.
updated: 2026-11-05
keywords: [ask markdrop, ask, ai, question, answer, home, dashboard, catch me up, this week, action items, my tasks, to-dos, follow-up, conversation, recent questions, sources, citations, meetings, transcript, ai search, phone, app]
---

**Ask Markdrop** is the box at the top of your home, **My files**. Ask a question in plain words and Markdrop answers from everything you can open: meetings and their transcripts, documents, pages, files and [Guides](/guides/overview). Each answer cites where it came from, so you can check it in one tap.

## Ask a question

Type a question and press :kbd[Enter] (:kbd[Shift+Enter] starts a new line). For example:

- "When do we ship the release?"
- "What did we decide about pricing for Europe?"
- "Who owns the onboarding docs?"

The answer streams in under your question. Numbers in the answer are its sources: select one to open it. Under the answer, **Sources** lists each item once. For a meeting, chips like **Ada Lovelace, 2:49** open the transcript at the moment it was said.

AI can be wrong, so check the sources. When nothing you can open answers the question, the answer says so.

## Follow-up questions

After an answer, ask a follow-up in the same box, like "and the annual discount?" or "who's doing that?". Markdrop reads the earlier questions in the conversation, so short follow-ups work. Select **New question** to start over.

The open conversation is in the page's address, so reloading or going back keeps your place.

## Suggested questions

The chips under the box ask common questions in one tap:

- **Catch me up on this week.** What changed in the last 7 days among the items you can open, meetings first: the decisions, what moved in documents, and what most needs your attention.
- **My open action items.** Every unchecked task that @mentions you, in pages you can open, most urgent first. Meeting action items are tasks like these, so the ones assigned to you show up here. Each one links to its line on the page. If you have none, you get the answer straight away, without using AI.
- **What was decided in…** your most recent meeting.

You can also type these. "What did I miss?" catches you up and "What's on my plate?" lists your tasks.

## Recent questions

Your last conversations are listed under the box. Select one to open it and continue asking. Select **×** to forget one, or **Clear** to forget them all.

Only you can see your conversations. Markdrop keeps them for 90 days after your last question in each, then deletes them. See [Privacy](/security/privacy#what-ask-markdrop-keeps).

## What Ask Markdrop reads

Ask Markdrop finds items with the same search as [Search](/workspaces/search), so it sees exactly what you can open:

- **Your access, checked twice.** Only items you can open now are read. Every source in an answer is checked again before you see it, and again when you reopen a conversation. If you lost access to something an earlier answer cited, that answer is hidden.
- **Meetings follow their rules.** A meeting [restricted to its attendees](/workspaces/meetings#who-can-see-a-meeting) is never read for anyone else. Transcript lines are read only when you can open the transcript.
- **Protected items stay protected.** [End-to-end encrypted](/sharing/end-to-end-encryption) items are never read. A password-protected item is read by its title only.
- **AI off means off.** Nothing is read from a workspace whose admin turned [AI features](/pages/ai#turn-ai-off-for-a-workspace) off.

:::note[What is sent to AI]
Ask Markdrop uses Claude Haiku 5.5 from Anthropic. It sends your question, earlier questions in the same conversation, and short excerpts of the matching items you can open. Transcripts are sent only to answer you. Nothing is used to train models. See the [privacy policy](https://markdrop.in/privacy#processors).
:::

## AI limits

Ask Markdrop shares the **AI search** budget with [Search](/workspaces/search#ask-ai): $2 a day and $20 a month across Markdrop, and your own AI limits. A question costs about a tenth of a cent. When a limit is reached, the box says so and when AI will be back. Your recent conversations still open.

## On your phone

Ask Markdrop is built for small screens: the box is the first thing on the home, the suggestions scroll sideways, and every button is easy to tap.

## From an AI app or the API

- **MCP.** The hosted MCP server's `ask_documents` tool asks the same way. Pass its `thread_id` back to ask a follow-up, or set `intent` to `catch_up` or `my_actions`. See [MCP tools](/ai/tools#read-and-find).
- **API.** `POST /api/v1/ask` streams an answer as Server-Sent Events, and `/api/v1/ask/threads` lists, opens and deletes your conversations. See the [API reference](/api/overview).

## Related

- [Search](/workspaces/search)
- [Meetings](/workspaces/meetings)
- [AI in pages](/pages/ai)
