---
title: Who viewed it
nav: Viewers
description: See every view of a document or file, who it was, where they opened it from and on what, and a timeline of what they did in it.
updated: 2026-11-07
prerequisites: [/analytics/overview]
keywords: [viewers, who viewed, view history, per view, timeline, activity, signed in, anonymous, visitor, location, city, device, browser, os, source, csv, get_document_viewers, get_view_timeline]
---

The **Viewers** tab lists every view of a link: who opened it, when, for how long, how far they got, where they were and on what. Choose a view to see a timeline of what they did, like "Read Intro · 1m 20s, jumped to Pricing, watched 0:00–3:10, downloaded it as PDF, asked: what's the price?".

It works for documents, pages, PDFs, videos, audio, slide decks, spreadsheets, HTML pages and other files.

## Open it

Open [Analytics](https://markdrop.in/dashboard/analytics), choose a link, then choose the **Viewers** tab. The date range at the top applies.

For an item in a workspace that you don't own, open the item's menu in the workspace and choose **Viewers**.

## Who's who

- **Signed in.** Someone signed in to Markdrop shows with their name and email address.
- **Anonymous.** Everyone else is a **Visitor** with a short code, like **Visitor 3F2A**. The code comes from a random id in their browser, so their next visit from the same browser shows as a return visit with the same code. It is never their name, email or IP address, and the same browser gets a different code on another owner's links.
- **You.** Your own views are kept apart and hidden. Turn off **Hide my own views** to see them, marked **You**. They never count in the other tabs' numbers.
- **Workspace members** are marked **Member**. For an item in a workspace, turn off **Include Acme members** to leave them out.

## What each view shows

| | What you see |
| --- | --- |
| **When** | When it was opened, and how long it was actively read or watched. A second counts only while the tab is visible and the reader is doing something, or media is playing. |
| **How far** | How far down a document or page they read, the last PDF page or slide they reached, the spreadsheet tabs they opened, or how much of a video or audio file they played. |
| **Where from** | City, region and country, worked out from the IP address when the view comes in (the address itself is never stored), and their timezone. |
| **On what** | Phone, tablet or computer; the operating system and browser with their versions, like **Chrome 131 on Windows 11**; the app it was opened in, like Slack or LinkedIn; screen size and language; and whether it was the installed Markdrop app or a page that embeds it. |
| **Source** | Where they came from: Slack, email, LinkedIn, Google, a Markdrop workspace page, a guide that embeds it, or **Direct or bookmarked**. |
| **Visit** | Which visit this was for them, like **3rd visit**. |

## A view's timeline

Choose a view. A panel opens with where it came from and on what, and **What they did**, in order:

- **Opened**, and where from.
- **Sections and pages read**, with the time in each. A section that isn't next to the one before is a **jump**, like "Jumped to Pricing" or "Went back to Setup".
- **Slides** viewed and **spreadsheet tabs** opened, with the time on each.
- **Video and audio**: what was watched ("Watched 0:00–3:10"), pauses, skips ahead or back, speed changes, and watching to the end.
- **Scrolled to 25%, 50%, 75%**, and **Reached the end**.
- **Links opened** (the address without its query), **code copied** (which section, never the text), **downloads**, **prints** and **full screen**.
- **Questions asked** with Ask AI about it, and **sign-offs** on a page.
- **Left after** the active time.

Below the timeline, **Their other views** lists the same person's or visitor's other views of the link.

## Filter, compare and export

- **Everyone, Signed in or Anonymous**, and **completion**: under 25%, 25–75%, 75% or more, or finished.
- **Breakdowns** under the list show views by country, city, device, operating system, browser and source. Choose a row to show only those views; choose **×** on the filter to remove it.
- **By person** groups the views per person or visitor: how many views, their total time, the furthest they got and when they were last there. Choose one to open their latest view.
- **CSV** downloads every view in the range with these filters, one row each, with all the details above.

## Who can see viewers

- **The owner** of the link.
- For an item in a **workspace**: its owner and admins, and anyone who can edit the item.
- Someone who can only **view** a workspace item sees how many views there were and how many were signed in, not who.

Nobody else, and never the people who viewed it.

## How long it's kept

Each view's detail (who, where from, on what, and the timeline) is kept for **180 days**, then deleted. The numbers on the other tabs are kept as before; see [What gets counted](/analytics/what-gets-counted#how-long-its-kept). Views are recorded from the day this feature launched; older views have no detail.

If someone deletes their account, or takes their name off their views in **Settings → Account → Your views of other people's items**, their views stay as anonymous ones. Deleting a link deletes its views.

## Not recorded

- Browsers that send [Global Privacy Control](https://globalprivacycontrol.org/): their view still counts, with nothing else.
- Text people type or copy, and the query strings of links they click.
- In an [end-to-end encrypted](/sharing/end-to-end-encryption) document: section names, copies and links. Time, depth and pages are still recorded.

## With your AI assistant

The Markdrop MCP tools `get_document_viewers` and `get_view_timeline` give your assistant the same list and timelines, with the same rules for who can see them. Try "who opened the Q3 deck this week, and how far did they get?". See [AI tools](/ai/tools).

## Related

::::cards
:::card[What gets counted]{href="/analytics/what-gets-counted" icon="eye"}
What a view is, whose views are left out, and what is never stored.
:::
:::card[Live now]{href="/analytics/live" icon="zap"}
Who's on your links right now.
:::
::::
