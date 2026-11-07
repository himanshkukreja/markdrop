---
title: Meeting memory while writing
nav: Meeting memory
description: See what your team decided about a page in meetings while you read or write it, insert it as a cited line, and ask the page with your meetings.
updated: 2026-11-07
prerequisites: [/pages/overview, /workspaces/meetings]
keywords: [meeting memory, edit mode, view mode, read mode, reading, phone, bottom sheet, ask markdrop, from meetings, decisions, what did we decide, when did we decide, prd, spec, feature document, action items, open questions, cited line, insert decision, jump to moment, /meetings, hints, missed decision, contradicts, ask this page, + meetings, meeting_context, mcp]
---

When you write a PRD, a spec or any page in a workspace, Markdrop shows what your team already decided and discussed about it in your [meetings](/workspaces/meetings): "On Oct 28 the team decided to ship checkout on Friday", with the meeting, its date and a link to the moment it was said. You can insert it into the page as a cited line, and ask the page questions that your meetings answer.

It works in every page of a workspace that has meetings, for the workspace's members, both when they read a page in [View mode](/pages/overview#view-and-edit) and when they edit it.

## From meetings

- **In View mode**, select **From meetings** in the page's top bar, next to **✦ Ask** and **Edit**. On a phone it's the microphone button.
- **In Edit mode**, select **From meetings** at the bottom right of the page. On a phone, while you type, it's the microphone button in the editing toolbar above the keyboard.

The number on the button is how many related items it found. A panel opens beside the page. On a phone, it opens as a sheet from the bottom, with buttons big enough to tap.

The panel follows where you are in the page. In View mode, that's the page's title, the section you've scrolled to and any text you selected. In Edit mode, it's the section your cursor is in. Move to another section and the list changes. It shows:

- **Decisions**, for example "Use Stripe's hosted checkout".
- **Action items**, with who took it on, when it's due, and whether it's **Open** or **Done** on the meeting page.
- **Open questions** the meeting left unanswered.
- **Discussed**: the topics a meeting covered.

Each item shows its date and meeting, and the series it belongs to, such as **Daily Standup**. The time button, such as **▶ 12:34**, opens the transcript at the moment it was said; without a transcript, **Open meeting** opens the meeting page. Use the chips at the top to show only decisions, action items, questions or topics, and the search box to look for anything else: a feature, a customer, a person.

![The From meetings panel opened from the page's top bar in View mode: a search box, filters for decisions, actions, questions and topics, and the related decisions from the Weekly product sync, each with its date, the moment in the call, Ask about this and Insert.](/docs-assets/pages/meeting-memory/from-meetings.webp)

## Insert a decision

Select **Insert** on an item to add it to the page as its own line, after the line your cursor is on:

> **Decided on Oct 28, 2026** (Daily Standup): Use Stripe's hosted checkout (12:34)

In View mode, **Insert** switches the page to Edit and adds the line at the end of the section you were reading, the same way [Ask's Insert](/workspaces/ask-markdrop) does. It saves like any other change. **Insert** only appears for people who can edit the page; everyone else can still read the items, jump to the moment and ask about them.

Action items start with **Action item from**, open questions with **Open question from** and topics with **Discussed on**. The meeting is a [mention](/pages/embed-and-mention): readers who can open it follow it to the meeting page, and the time opens the transcript at that moment. For readers who can't open the meeting, the mention shows **Restricted item**.

Type `/meetings` in the page (or **From meetings…** in the **/** menu) to open the panel with its search ready. **Insert** then puts the line where you typed the slash.

## Missed decisions

These suggestions appear only in Edit mode, while you write. When the section you're writing leaves out a decision your team made about it, a small card above **From meetings** says so: "On Nov 3 the team decided … Include it here?". Select **Include** to insert it as a cited line, **See more** to open the panel, or **Dismiss** to stop seeing it on this page in this browser.

Markdrop only suggests clear matches: a decision about what the section's heading or the page's title is about, whose words are mostly missing from the section. Nothing in the page ever changes unless you choose **Include**.

When [AI is on](/pages/ai#who-can-use-ai) for the workspace, AI also reads a section of 25 words or more after you stop typing, and tells you when it seems to say something different from a decision ("The section says monthly billing; on Nov 3 the team decided annual"). This happens at most a few times per visit, once per version of the section, and counts towards your AI limits.

## Turn it off

At the bottom of the **From meetings** panel:

- **Show by itself** hides the **From meetings** button at the bottom right while you edit. `/meetings` still opens the panel. The button in the top bar in View mode stays, because it only opens when you select it.
- **Suggest missed decisions** stops the cards.

Both are on by default and are yours alone: they follow you to every page and every device, and don't change anything for anyone else.

## Ask the page with your meetings

[Ask](/workspaces/ask-markdrop) answers from your meetings too. In a workspace page, choose **✦ Ask** in the top bar (or press **⌘ J** outside the text): on **This page**, answers use the page itself first, then the decisions, action items and transcripts of the workspace's meetings, then its other documents.

- Ask "When did we decide to drop the free plan?", "Why are we using Stripe?" or "What was the team working on for checkout last week?". For when, why and who questions, the answer comes from the meetings and names the meeting and its date.
- Numbered sources open the item, and a meeting line opens the transcript at the moment.
- **Ask about this** on an item in **From meetings** asks Ask about that decision, action item or question: why it was decided and whether it changed, its status, whether it was answered.
- Switch to **Meetings** to ask only the meetings, with a series or a period.

Asking counts towards your AI limits. See [AI limits](/workspaces/ask-markdrop#ai-limits).

## Privacy

Meeting memory uses only the meetings you can open, decided each time you look:

- A meeting [restricted to its attendees](/workspaces/meetings-privacy#restricted-meetings) appears only for its attendees. One-to-one calls are restricted automatically. Nobody else ever sees its decisions in the panel, in a card, in an answer or from an AI app.
- The link to the moment appears only when you can open the transcript too; otherwise the item links to the meeting page.
- When a workspace's [AI features are off](/workspaces/privacy), the panel and the cards still work, because they're search. The AI check and asking with meetings don't run.

The panel needs no extra AI: Markdrop records each meeting's decisions, action items, open questions and topics from the summary it already wrote when the meeting was imported, and keeps them up to date when you select **Write it again**, restrict, rename or delete a meeting.

## From an AI app

`meeting_context` gives an AI app connected to the [hosted MCP server](/ai/hosted-mcp) the same memory: give it a topic and a workspace, or the page you're writing, and it returns the related decisions, action items, questions and topics with their dates, meetings, links to the moment, and a cited line ready to paste. It makes no AI call. See [MCP tools](/ai/tools#meetings).

## Related

- [Meetings and Team: how it fits together](/workspaces/meetings-and-team)
- [Meetings](/workspaces/meetings)
- [Ask your meetings](/workspaces/meetings-ask)
- [AI in pages](/pages/ai)
- [Meetings privacy and AI](/workspaces/meetings-privacy)
