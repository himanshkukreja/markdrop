---
title: AI and your data
nav: AI and your data
description: Which AI powers Markdrop's AI features, what is sent to it and what isn't, what Markdrop keeps, and the fair-use limits.
updated: 2026-11-07
keywords: [ai, anthropic, claude, privacy, training, what is sent to ai, data, encrypted, password, ai off, fair use, limits, ask, search, meetings, team, analytics, pages, jira, guides]
---

Markdrop's AI features (AI in pages, [Ask](/workspaces/ask-markdrop), [AI search](/workspaces/search#ask-ai), [meeting summaries](/workspaces/meetings), [Team](/workspaces/team), [AI in analytics](/analytics/ai-insights), [Jira drafts](/integrations/jira) and [Markdrop Guides](/guides/ask-ai)) are powered by Anthropic's Claude models. This page is the one place that explains what goes to the AI and what doesn't.

## What is sent

Only what a request needs, and only when someone uses an AI feature (or, for meetings and Team, when a meeting or page is added or changes):

- **AI in pages**: the text you selected, or the page's text (for a long page, only the sections nearest what you're doing), and your prompt or question; the text of Markdrop items the page embeds that you can open; for alt text, the image; for a cover, the page's title and first lines.
- **Ask and AI search**: your question, earlier questions in the same conversation, the heading of the section you're in and any text you selected, your name, email, workspaces and the names you appear under in meetings, and short excerpts of the matching items you can open. A workspace's suggestions use the meeting topics, decisions and action items and the page titles and headings that every member can open.
- **Meetings**: the transcript and Google's notes, only to write the meeting's sections or to answer your questions.
- **Team**: the meetings and pages the Team board reads, to keep each person's lines up to date.
- **Analytics**: totals and changes for your own links, their titles, and your own content where it helps. Never who visited: no IP address, visitor or session id, or email.
- **Jira drafts**: the item you're turning into an issue.

## What is never sent

- [End-to-end encrypted](/sharing/end-to-end-encryption) items. Nothing from them goes anywhere.
- The content of a password-protected item. Only its title is used.
- Anything you can't open yourself. Every item is checked against your access first.
- Anything from a workspace whose admin [turned AI features off](/pages/ai#turn-ai-off-for-a-workspace).

## Training

Nothing sent to the AI is used to train models. Anthropic doesn't use data sent through its commercial API to train its models; see [Anthropic's commercial terms](https://www.anthropic.com/legal/commercial-terms).

## What Markdrop keeps

A usage record for each request: who, which feature and how much it used. Never the text sent, your prompt, the question or the answer. The one exception is your own [Ask conversations](/security/privacy#what-ask-keeps), kept for you to return to.

AI treats the content it reads as content to work on, never as instructions, so a page can't tell AI to do something else.

## Fair-use limits

AI features have fair-use limits. If a limit is reached, the feature keeps working without the AI part, and the AI part resumes later:

- Meetings still import, with their transcript and Google's notes. Select **Write it again** later to add the AI sections.
- Search still finds results, and Ask's conversations still open.
- Team stops updating for a while; nothing is lost.
- Jira drafts are the item as written, and creating the issue still works.

The feature says when AI is back.

## Related

- [Privacy at Markdrop](/security/privacy)
- [AI in pages](/pages/ai)
- [Limits](/account/limits#ai)
- [Privacy policy](https://markdrop.in/privacy#processors)
