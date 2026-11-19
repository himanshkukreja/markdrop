---
title: Personal to-do pages
description: Your action items from the team's calls and the tasks on its pages that mention you, on one page. Create or refresh it in one click.
updated: 2026-11-19
nav: To-do pages
keywords: [to-dos, todos, to do list, my to-dos, create my to-dos, refresh to-dos, create for everyone, page tasks, task mentions, action items, personal to-do page, per person, per company, hubspot company, internal, tick, check off, sync, two-way, team leads, private, backfill, my_todos, team_todos, tick_todo, refresh_my_todos]
---

Every member of a team (not General) gets one page, **"Your Name — To-dos"**, with their action items from the team's calls and the tasks on the team's pages that mention them. Markdrop keeps it up to date after every call in the team, including imported, Zoom and Google Meet calls, whenever someone changes a call's action items, and whenever someone edits a task on one of the team's pages.

![A to-do page: a section per company from the team's calls, then the tasks from the team's pages](/docs-assets/teams/to-dos/page.webp)

## Create or refresh yours

On the team's **Overview**, click **Create my to-dos** if you don't have a page in that team yet (you joined later, say, or the team never had one). Markdrop makes it straight away from everything the team has: the action items from its calls and the tasks on its pages. Once you have a page, the same button says **Refresh to-dos**: it checks again and pulls in anything new since, such as a call whose items didn't land or a task someone just gave you on a page.

::clip{src="/docs-assets/teams/to-dos/create" theme="both" alt="On the Sales team's Overview, Alex clicks Create my to-dos. A message says Added 6 new · 6 open; he clicks Open and his to-do page shows a section per company from the team's calls (Globex, Northwind) and From the team's pages with three tasks from the Q4 renewals tracker. He clicks Northwind renewal call next to an item and the meeting page opens, with the same item under Action items."}

![The team's Overview with the Refresh to-dos button and the result](/docs-assets/teams/to-dos/refresh.webp)

When it's done, a message says what changed, for example **Added 2 new · 5 open**, or **Up to date** when nothing was missing, with a link to the page. Refreshing is safe to repeat: items you already have, and your ticks, stay as they are.

You can also do it from **You › My to-dos**: each of your pages has **Refresh to-dos**, and a team you're in without a page shows **Create my to-dos**.

Team leads get **Create for everyone** above **Everyone's to-dos** in the team's **People & memory**. It makes a page for every member who doesn't have one yet.

## What's on the page

Markdrop keeps one section of the page up to date, **From the team's calls**. It holds one collapsible heading per company, plus **Internal** for calls without one, and then **From the team's pages**:

- **The company** is the call's HubSpot company (from its deal, when the workspace has [HubSpot connected](/integrations/hubspot)). Otherwise it's the company of the people from outside your workspace, taken from their email addresses. A call with neither goes under **Internal**.
- **Each heading** shows the company, how many items are open, and the date of the last call, for example **Acme Corp · 3 open · last call Nov 18**.
- **Each item** has a checkbox, the task, its due date when one was said, and the call it came from. The call link goes to that item on the meeting page, and the time (when there is one) to that moment in the transcript.
- **From the team's pages** lists the tasks on the team's own pages that @mention you: a checkbox line where you typed `@` and picked the person, such as **Draft the launch email @Alex Chen**. Each one links to the task on its page. Only pages in the team that you can open count; meeting pages, to-do pages and what's inside the team's Deals folder don't.

Only your own items appear on your page. Something assigned to you and a colleague appears on both of your pages.

A ticked item stays on the page for two weeks, so you can untick it. A page with nothing open says *No open action items yet — they'll appear here after your next call.*

Write your own to-dos and notes above or below Markdrop's section. Markdrop never changes them. It only rewrites what's between the section's heading and its closing line.

## Tick it anywhere

An item on your to-do page and the action item on the meeting page are the same task:

- Tick it on your to-do page (in the editor, or straight from the page in view mode), and the meeting page's item is ticked too.
- Tick it on the meeting page, from **Home**, from Slack's **Done** button or by closing its [Jira issue](/integrations/jira), and your to-do page follows.

Tasks from the team's pages work the same way: tick one on your to-do page and the task on its page is ticked, or tick it on its page and your to-do page follows.

It also works while someone has either page open: their editor shows the change as it happens, without losing what they're typing. If the item's wording changes on the call, your page shows the new wording and keeps your tick. If it's deleted from the call, it leaves your page.

## Who can see it

Your to-do page is **private**. Only you, plus the **team's leads**, can open it. Leads can read every member's page in their team, but only you can edit yours. Lead access follows the team as it is now: it ends when someone stops being a lead or you leave the team.

To show your page to someone else, [share it](/sharing/share-with-people) like any page.

You only ever see items from calls you can open. On your own page that's every call you were on, including calls restricted to the people who were there. When someone else reads your page (a lead, or someone you shared it with), items from calls *they* can't open are hidden: they see "2 items from private calls" in that company's section instead, and a company that only comes up in such calls shows as **Private calls**. This is decided each time they open the page, so it follows any change in who can open the call.

## Find your to-dos

- **You › My to-dos** in the sidebar lists your to-do page in each of your teams, with the number of open items and the companies they're for.
- **People & memory** in a team shows **Your to-dos**. Leads see **Everyone's to-dos**, a card per member.

The pages live in a hidden **To-dos** folder in the team. Like the team's Deals folder, it stays out of the file tree, but search still finds your page.

Everyone in a team gets a page as soon as the team has a call with action items, including people with nothing open yet. Someone added to the team later gets theirs straight away. If you still don't have one, use **Create my to-dos** on the team's Overview.

## From an AI app

With the [hosted MCP server](/ai/hosted-mcp), an AI app can list your to-dos (`my_todos`, by team, with done items on request), show a lead every member's open items (`team_todos`), tick one or open it again (`tick_todo`, by its block id or a few of its words), and create or refresh yours in a team (`refresh_my_todos`, which says how many items are new and open). Ticking from an AI app updates the call too. See [MCP tools](/ai/tools#teams).
