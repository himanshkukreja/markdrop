---
title: Personal to-do pages
description: Each team member gets a to-do page with their action items from the team's calls, grouped by company. Tick an item there or on the call, and the other follows.
updated: 2026-11-19
nav: To-do pages
keywords: [to-dos, todos, to do list, my to-dos, action items, personal to-do page, per person, per company, hubspot company, internal, tick, check off, sync, two-way, team leads, private, backfill, my_todos, team_todos, tick_todo]
---

Every member of a team (not General) gets one page, **"<Name> — To-dos"**, with their action items from the team's calls. Markdrop keeps it up to date after every call in the team, including imported, Zoom and Google Meet calls, and whenever someone changes a call's action items.

## What's on the page

Markdrop keeps one section of the page up to date, **From the team's calls**. It holds one collapsible heading per company, plus **Internal** for calls without one:

- **The company** is the call's HubSpot company (from its deal, when the workspace has [HubSpot connected](/integrations/hubspot)). Otherwise it's the company of the people from outside your workspace, taken from their email addresses. A call with neither goes under **Internal**.
- **Each heading** shows the company, how many items are open, and the date of the last call, for example **Acme Corp · 3 open · last call Nov 18**.
- **Each item** has a checkbox, the task, its due date when one was said, and the call it came from. The call link goes to that item on the meeting page, and the time (when there is one) to that moment in the transcript.

Only your own items appear on your page. Something assigned to you and a colleague appears on both of your pages.

A ticked item stays on the page for two weeks, so you can untick it. A page with nothing open says *No open action items yet — they'll appear here after your next call.*

Write your own to-dos and notes above or below Markdrop's section. Markdrop never changes them. It only rewrites what's between the section's heading and its closing line.

## Tick it anywhere

An item on your to-do page and the action item on the meeting page are the same task:

- Tick it on your to-do page (in the editor, or straight from the page in view mode), and the meeting page's item is ticked too.
- Tick it on the meeting page, from **Home**, from Slack's **Done** button or by closing its [Jira issue](/integrations/jira), and your to-do page follows.

It also works while someone has either page open: their editor shows the change as it happens, without losing what they're typing. If the item's wording changes on the call, your page shows the new wording and keeps your tick. If it's deleted from the call, it leaves your page.

## Who can see it

Your to-do page is **private**. Only you, plus the **team's leads**, can open it. Leads can read every member's page in their team, but only you can edit yours. Lead access follows the team as it is now: it ends when someone stops being a lead or you leave the team.

To show your page to someone else, [share it](/sharing/share-with-people) like any page.

You only ever see items from calls you can open. A call restricted to the people who were there shows on your page only if you were one of them.

## Find your to-dos

- **You › My to-dos** in the sidebar lists your to-do page in each of your teams, with the number of open items and the companies they're for.
- **People & memory** in a team shows **Your to-dos**. Leads see **Everyone's to-dos**, a card per member.

The pages live in a hidden **To-dos** folder in the team. Like the team's Deals folder, it stays out of the file tree, but search still finds your page.

Everyone in a team gets a page as soon as the team has a call with action items, including people with nothing open yet. Someone added to the team later gets theirs straight away.

## From an AI app

With the [hosted MCP server](/ai/hosted-mcp), an AI app can list your to-dos (`my_todos`, by team, with done items on request), show a lead every member's open items (`team_todos`), and tick one or open it again (`tick_todo`, by its block id or a few of its words). Ticking from an AI app updates the call too. See [MCP tools](/ai/tools#teams).
