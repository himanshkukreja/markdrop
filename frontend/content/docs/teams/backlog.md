---
title: Team backlog
description: One shared page per team with every action item and customer ask from its calls, sorted into categories and prioritized after every call. Priorities said in a call update it, and Slack says what changed. Filter by priority and date, group, edit and comment.
updated: 2026-11-26
nav: Backlog
keywords: [likely done, looks done, backlog, team backlog, product backlog, action items, customer asks, feature requests, bugs, improvements, follow-ups, questions, categories, auto categorized, triage, sales calls, customer calls, dedupe, mentioned in calls, filter, filter bar, hide done, export csv, copy list, in progress, won't do, refresh backlog, team settings, private calls, priority, priorities, urgent, high, medium, low, prioritization call, weekly prioritization, p0, p1, date filter, last 7 days, last 30 days, custom range, first seen, last mentioned, group by, group by priority, group by month, group by company, group by owner, slack, couldn't match, team_backlog, update_backlog_item, set_backlog_priorities, refresh_team_backlog]
---

Every team (not General) gets one page, **"Team — Backlog"**, that everyone in the team shares. After every call filed to the team, Markdrop adds what came up on it: each action item, plus the customer asks said on the call that nobody turned into an action item, such as a feature someone wants, a bug they hit or an integration they need. Each one is sorted into a category and given a [priority](#priorities), and the same ask from several calls becomes one item.

It's a real page. You can edit it, comment on an item, share it and see its versions, like any other page.

![A team's backlog page: the filter bar, then a collapsible heading per category with its items](/docs-assets/teams/backlog/page.webp)

::clip{src="/docs-assets/teams/backlog/fill" theme="both" alt="On the Sales backlog page, Riya clicks the Bug chip and only the Safari login bug shows; she clicks Feature request and types csv, and one item is left: Export usage reports to CSV, mentioned in 2 calls. She clears the filters, ticks Send the renewal pricing deck under Follow-up and opens its call from the line: on the Northwind renewal call's page the same action item is now ticked."}

## Find it

Open the team in the sidebar and click **Backlog**, next to **Meetings**. The number beside it is how many items are open. The page also sits in the team's **Files & pages**, and search finds it.

The page appears with the team's first call. If your team had calls before the backlog existed, a team lead can click **Refresh backlog** on the page to read them all.

## What's on it

Markdrop keeps one part of the page up to date, under **The team's backlog**. It has a collapsible heading for each category, with how many items are open:

| Category | What goes there |
| --- | --- |
| **Feature request** | Something new someone asked for, such as an export, SSO or an integration |
| **Bug** | Something broken or not working as it should |
| **Improvement** | A small change or addition to something that exists |
| **Task** | Internal work for the team |
| **Follow-up** | Something the team owes a customer: send the proposal, share pricing, book a demo |
| **Question** | A question that still needs an answer |

Inside each category, open items go most urgent first, then newest first. Done items move into a closed **Done** heading at the end of their category.

Each item is a checkbox line with:

- **The item**, then its status when it isn't open (**In progress**), and its priority when it isn't Medium (**Urgent**, **High** or **Low**, shown as a colored chip).
- **The company** it's for, the same way [to-do pages](/teams/to-dos) work it out: the call's HubSpot company, or the company of the people from outside your workspace.
- **The owner**, when someone was named on the action item.
- **Where it came from**: a link to the action item on the meeting page, or to the moment in the transcript for a customer ask. When it came up on more than one call, the line says how many, for example **3 calls**, and links the latest.
- **First seen**: the date of the first call it came up on.
- **Likely done**, when a later call or page shows an open item was done, with that evidence and its date. Markdrop never ticks it: tick its checkbox if it's done. The note appears only when everyone in the team can open where the evidence came from.

Items you tick stay for 30 days, so you can untick them.

Write your own notes above or below Markdrop's part. Markdrop never changes them.

## Priorities

Every item has a priority: **Urgent**, **High**, **Medium** or **Low**.

- **Set from the call.** When an item is added, Markdrop gives it a priority with a one-line reason, from what was said: urgency ("it's a blocker", "we need it this week"), a deadline, a deal, pilot or renewal waiting on it, an escalation, and how often it came up. For a call filed to a HubSpot deal, the deal counts too. Most items are Medium. If an item comes up again more urgently, its priority goes up.
- **Set in a call.** When someone in any team call decides a priority, such as "make SSO our top priority", "dark mode can wait", "push the CSV export to next quarter" or "P1 for the Okta fix", Markdrop finds the open item it's about and changes it. "Drop it" or "we won't do it" marks the item **Won't do**. Markdrop only changes an item when it's sure which one was meant. What it couldn't match is listed instead, so a weekly prioritization call keeps the backlog in order on its own.
- **Set by you.** Type **· Urgent**, **· High** or **· Low** on a line (take it out for Medium), or pick it from the chip in a grouped view (below).

The newest decision by a person wins. A decision said in a call and a change you make on the page are both people's decisions, so whichever came later stands. Markdrop's own suggestion never overrides either.

### What happens after a call changes priorities

- **Slack.** If the team has a Slack channel, Markdrop posts one message per call, for example: "Priorities updated from Weekly prioritization (Nov 24): SSO via Okta → **Urgent** (was Medium) — Riya". It also lists what it **couldn't match**, and links to the backlog showing only the changed items. It follows the same rules as meeting posts: never for a call restricted to the people who were there, and never for a past call brought in later.
- **The meeting page.** The call's page gets a **Backlog priorities from this call** list: what changed and what couldn't be matched.
- **The owners.** Each changed item's owner gets a notification.

![A Slack message from Markdrop in the team's channel: priorities updated from the weekly prioritization call, four changes, one that couldn't be matched, and an Open the changed items button](/docs-assets/teams/backlog/slack.webp)

## Filter and group it

The bar above the page filters what you see, in view and while editing:

- **Category chips** with counts. Click one to show only that category; click it again to show everything.
- **Priority chips** with counts. Pick one or more, such as Urgent and High.
- **Date**: Any time, Last 7 days, Last 30 days, Last 90 days, This month, or a custom range. Choose whether it uses the date an item was **first seen** or **last mentioned** in a call, so "last 7 days" can mean new this week or still coming up this week.
- **Status**, **Company** and **Owner** menus.
- **Search** across the items, companies, owners and call names.
- **Hide done**.
- **Group by**: Category (the page as it is), **Priority**, **Month**, **Company** or **Owner**. Grouping draws the same items under the bar in those groups, with each item's priority chip, status, company, owner, the call and its date. Click a priority chip to change it. Grouping works while you view the page.

![The Sales backlog filtered to Urgent and High items from the last 30 days, grouped by priority](/docs-assets/teams/backlog/filters.webp)

The bar shows how many items match. The filter and grouping are in the page's address, so copy the link to share exactly what you're looking at, such as every urgent item for one customer this month. **Copy** puts the shown items on the clipboard as a list, and **Export CSV** downloads them with their priority, first seen and last mentioned dates.

Filtering and grouping only change what's on your screen. They never change the page, so comments and links to items keep working.

## Change it on the page

Edit the backlog like any page. Markdrop reads your changes and keeps them:

- **Tick an item** to mark it done. If it's an action item, it's ticked on the meeting page too.
- **Move a line under another heading** to change its category.
- **Edit the wording** to change the item's text.
- Type **· In progress** or **· Won't do** at the end of a line to set its status.
- Type **· Urgent**, **· High** or **· Low** to set its priority, or take it out for **Medium**.
- **Change the @person** on a line to change its owner.
- **Delete a line** to mark the item **Won't do**. It leaves the page and doesn't come back from later calls.
- **Type a new checkbox line** under a heading to add an item of your own.

Your change always wins. Markdrop's automatic sorting never changes a category, wording, owner or priority someone set by hand. Only a later call that decides an item's priority again changes it.

### Comments

Select an item's text and comment, as on any page. Comments stay attached to the item when the list updates after a new call, when you move it to another category, and when its status changes.

## Stays in step with the calls

To keep a team's backlog in view, add the **Team backlog** widget to your [Home](/workspaces/customize-home), filtered to a category, status, priority or date range, for example the Sales team's urgent items from the last 7 days. It lists the most urgent first.

An item from an action item and the action item on the meeting page are kept in step:

- Tick it on the meeting page (or from **Home**, Slack or Jira) and it's done in the backlog.
- Tick it in the backlog and it's ticked on the meeting page.
- If someone sets a different status in the backlog after that, their status stays.

When a call moves to another team, its items move with it. When it's deleted, its items leave the backlog, except ones someone edited by hand.

## Who sees it

Everyone in the team can open and edit the page, like the team's other pages.

Calls restricted to the people who were there stay private. Items that only came up on such calls are **not** on the page, and a priority decided on such a call shows its reason and quote only to people who can open that call. Team leads see a count instead, such as **2 items from private calls aren't on this page**, with no titles. People who were on those calls still find the items from an AI app (below).

## Turn it off

A team lead turns the backlog off in **Team settings** with **Team backlog**. The page stays as it is, stops filling and leaves the sidebar. Turn it back on and Markdrop reads the team's calls again.

## From an AI app

With the [hosted MCP server](/ai/hosted-mcp), an AI app can:

- list a team's backlog by category, status, company, priority and date, sorted by priority or date (`team_backlog`), with only the items from calls you can open, and each item's priority with who set it and why;
- change an item's category, status, owner, text or priority (`update_backlog_item`), which wins like an edit on the page, and ticks the call's action item when you mark it done;
- set several priorities at once, for example after a planning session (`set_backlog_priorities`);
- re-read every call in the team now (`refresh_team_backlog`, team leads);
- list the open items that look done, with their evidence (`likely_done`), or say one isn't (`dismiss_likely_done`).

See [MCP tools](/ai/tools#teams).
