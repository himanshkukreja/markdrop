---
title: Team backlog
description: One shared page per team with every action item and customer ask from its calls, sorted into categories after every call. Filter, edit and comment.
updated: 2026-11-20
nav: Backlog
keywords: [backlog, team backlog, product backlog, action items, customer asks, feature requests, bugs, improvements, follow-ups, questions, categories, auto categorized, triage, sales calls, customer calls, dedupe, mentioned in calls, filter, filter bar, hide done, export csv, copy list, in progress, won't do, refresh backlog, team settings, private calls, team_backlog, update_backlog_item, refresh_team_backlog]
---

Every team (not General) gets one page, **"Team — Backlog"**, that everyone in the team shares. After every call filed to the team, Markdrop adds what came up on it: each action item, plus the customer asks said on the call that nobody turned into an action item, such as a feature someone wants, a bug they hit or an integration they need. Each one is sorted into a category, and the same ask from several calls becomes one item.

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

Each item is a checkbox line with:

- **The item**, then its status when it isn't open (**In progress**).
- **The company** it's for, the same way [to-do pages](/teams/to-dos) work it out: the call's HubSpot company, or the company of the people from outside your workspace.
- **The owner**, when someone was named on the action item.
- **Where it came from**: a link to the action item on the meeting page, or to the moment in the transcript for a customer ask. When it came up on more than one call, the line says how many, for example **3 calls**, and links the latest.
- **First seen**: the date of the first call it came up on.

Items you tick stay for 30 days, so you can untick them.

Write your own notes above or below Markdrop's part. Markdrop never changes them.

## Filter it

The bar above the page filters what you see, in view and while editing:

- **Category chips** with counts. Click one to show only that category; click it again to show everything.
- **Status**, **Company** and **Owner** menus.
- **Search** across the items, companies, owners and call names.
- **Hide done**.

The bar shows how many items match. The filter is in the page's address, so copy the link to share exactly what you're looking at, such as every open bug for one customer. **Copy** puts the shown items on the clipboard as a list, and **Export CSV** downloads them.

Filtering only changes what's on your screen. It never changes the page.

## Change it on the page

Edit the backlog like any page. Markdrop reads your changes and keeps them:

- **Tick an item** to mark it done. If it's an action item, it's ticked on the meeting page too.
- **Move a line under another heading** to change its category.
- **Edit the wording** to change the item's text.
- Type **· In progress** or **· Won't do** at the end of a line to set its status.
- **Change the @person** on a line to change its owner.
- **Delete a line** to mark the item **Won't do**. It leaves the page and doesn't come back from later calls.
- **Type a new checkbox line** under a heading to add an item of your own.

Your change always wins. Markdrop's automatic sorting never changes a category, wording or owner someone set by hand.

### Comments

Select an item's text and comment, as on any page. Comments stay attached to the item when the list updates after a new call, when you move it to another category, and when its status changes.

## Stays in step with the calls

To keep a team's backlog in view, add the **Team backlog** widget to your [Home](/workspaces/customize-home), filtered to a category or status, for example the Sales team's open follow-ups.

An item from an action item and the action item on the meeting page are kept in step:

- Tick it on the meeting page (or from **Home**, Slack or Jira) and it's done in the backlog.
- Tick it in the backlog and it's ticked on the meeting page.
- If someone sets a different status in the backlog after that, their status stays.

When a call moves to another team, its items move with it. When it's deleted, its items leave the backlog, except ones someone edited by hand.

## Who sees it

Everyone in the team can open and edit the page, like the team's other pages.

Calls restricted to the people who were there stay private. Items that only came up on such calls are **not** on the page. Team leads see a count instead, such as **2 items from private calls aren't on this page**, with no titles. People who were on those calls still find the items from an AI app (below).

## Turn it off

A team lead turns the backlog off in **Team settings** with **Team backlog**. The page stays as it is, stops filling and leaves the sidebar. Turn it back on and Markdrop reads the team's calls again.

## From an AI app

With the [hosted MCP server](/ai/hosted-mcp), an AI app can:

- list a team's backlog by category, status and company (`team_backlog`), with only the items from calls you can open;
- change an item's category, status, owner or text (`update_backlog_item`), which wins like an edit on the page, and ticks the call's action item when you mark it done;
- re-read every call in the team now (`refresh_team_backlog`, team leads).

See [MCP tools](/ai/tools#teams).
