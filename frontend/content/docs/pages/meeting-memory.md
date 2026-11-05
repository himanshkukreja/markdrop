---
title: Meeting memory while writing
nav: Meeting memory
description: While you write a page, see what your team decided and discussed about it in meetings, with dates and links to the moment, insert it as a cited line, and ask the page with your meetings.
updated: 2026-11-05
prerequisites: [/pages/overview, /workspaces/meetings]
keywords: [meeting memory, from meetings, decisions, what did we decide, when did we decide, prd, spec, feature document, action items, open questions, cited line, insert decision, jump to moment, /meetings, hints, missed decision, contradicts, ask this page, + meetings, meeting_context, mcp]
---

When you write a PRD, a spec or any page in a workspace, Markdrop shows what your team already decided and discussed about it in your [meetings](/workspaces/meetings): "On Oct 28 the team decided to ship checkout on Friday", with the meeting, its date and a link to the moment it was said. You can insert it into the page as a cited line, and ask the page questions that your meetings answer.

It works in every page of a workspace that has meetings, for the workspace's members.

## From meetings

Select **From meetings** at the bottom right of the page, beside **Ask**. The number on it is how many related items it found. A panel opens beside the page (a sheet from the bottom on a phone).

The panel follows what you're writing: the page's title, the heading of the section you're in, and your selection. Move to another section and the list changes. It shows:

- **Decisions**, for example "Use Stripe's hosted checkout".
- **Action items**, with who took it on, when it's due, and whether it's **Open** or **Done** on the meeting page.
- **Open questions** the meeting left unanswered.
- **Discussed**: the topics a meeting covered.

Each item shows its date and meeting, and the series it belongs to, such as **Daily Standup**. The time button, such as **▶ 12:34**, opens the transcript at the moment it was said; without a transcript, **Open meeting** opens the meeting page. Use the chips at the top to show only decisions, action items, questions or topics, and the search box to look for anything else: a feature, a customer, a person.

## Insert a decision

Select **Insert** on an item to add it to the page as its own line, after the line your cursor is on:

> **Decided on Oct 28, 2026** (Daily Standup): Use Stripe's hosted checkout (12:34)

Action items start with **Action item from**, open questions with **Open question from** and topics with **Discussed on**. The meeting is a [mention](/pages/embed-and-mention): readers who can open it follow it to the meeting page, and the time opens the transcript at that moment. For readers who can't open the meeting, the mention shows **Restricted item**.

Type `/meetings` in the page (or **From meetings…** in the **/** menu) to open the panel with its search ready. **Insert** then puts the line where you typed the slash.

## Missed decisions

When the section you're writing leaves out a decision your team made about it, a small card above **From meetings** says so: "On Nov 3 the team decided … Include it here?". Select **Include** to insert it as a cited line, **See more** to open the panel, or **Dismiss** to stop seeing it on this page in this browser.

Markdrop only suggests clear matches: a decision about what the section's heading or the page's title is about, whose words are mostly missing from the section. Nothing in the page ever changes unless you choose **Include**.

When [AI is on](/pages/ai#who-can-use-ai) for the workspace, Claude Haiku 5.5 also reads a section of 25 words or more after you stop typing, and tells you when it seems to say something different from a decision ("The section says monthly billing; on Nov 3 the team decided annual"). This happens at most a few times per visit, once per version of the section, and counts towards the **Meetings AI** limit.

## Turn it off

At the bottom of the **From meetings** panel:

- **Show by itself** hides the **From meetings** button. `/meetings` still opens the panel.
- **Suggest missed decisions** stops the cards.

Both are on by default and are yours alone: they follow you to every page and every device, and don't change anything for anyone else.

## Ask the page with your meetings

[Ask this page](/pages/ai#ask-this-page) can answer from your meetings too. In a workspace page, **Meetings** under the question box is on by default: answers use the page itself first, then the decisions, action items and transcripts of the workspace's meetings, then its other documents.

- Ask "When did we decide to drop the free plan?", "Why are we using Stripe?" or "What was the team working on for checkout last week?". For when, why and who questions, the answer comes from the meetings and names the meeting and its date.
- Numbered citations link to the item; a citation like **1·1** opens the transcript at the moment. The items used are listed under the answer.
- Select **Meetings** to turn it off and ask the page only. Questions about when or why something was decided still use your meetings.

Asking with meetings counts towards your **AI search** limit, the same as [Ask Markdrop](/workspaces/ask-markdrop).

## Privacy

Meeting memory uses only the meetings you can open, decided each time you look:

- A meeting [restricted to its attendees](/workspaces/meetings-privacy#restricted-meetings) appears only for its attendees. One-to-one calls are restricted automatically. Nobody else ever sees its decisions in the panel, in a card, in an answer or from an AI app.
- The link to the moment appears only when you can open the transcript too; otherwise the item links to the meeting page.
- When a workspace's [AI features are off](/workspaces/privacy), the panel and the cards still work, because they're search. The AI check and asking with meetings don't run.

The panel needs no extra AI: Markdrop records each meeting's decisions, action items, open questions and topics from the summary it already wrote when the meeting was imported, and keeps them up to date when you select **Write it again**, restrict, rename or delete a meeting.

## From an AI app

`meeting_context` gives an AI app connected to the [hosted MCP server](/ai/hosted-mcp) the same memory: give it a topic and a workspace, or the page you're writing, and it returns the related decisions, action items, questions and topics with their dates, meetings, links to the moment, and a cited line ready to paste. It makes no AI call. See [MCP tools](/ai/tools#meetings).

## Related

- [Meetings](/workspaces/meetings)
- [Ask your meetings](/workspaces/meetings-ask)
- [AI in pages](/pages/ai)
- [Meetings privacy and cost](/workspaces/meetings-privacy)
