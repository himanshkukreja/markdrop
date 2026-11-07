---
title: Jira
description: Jira issues from meetings, Team and pages (AI drafts, you review), each person's tickets on Team, to-dos and issues in step both ways, and Ask.
updated: 2026-11-07
keywords: [jira, jira cloud, atlassian, integration, integrations tab, connect jira site, connect my atlassian account, not set up yet, connected, default project, default issue type, projects on team, pick projects for team, create jira issue, jira issues, draft issues for action items, ai draft, review, summary, description, issue type, priority, assignee, due date, labels, chip, live chip, key, status, to do, in progress, done, two-way sync, tick, transition, webhook, via jira, retry, team board, overdue, blocked, done lately, counts only, ask, tickets, pasted jira link, restricted meeting, privacy, jira_ai, cost, jira_status, create_jira_issue, link_jira_issue, list_jira_issues, transition_jira_issue, developer console, oauth 2.0 3lo, client id, client secret, callback url]
---

Markdrop works with **Jira Cloud** in four ways:

- **Create issues from what your team says and writes.** A meeting's action item, decision or open question, a Team blocker or target, or any text in a page becomes a Jira issue. Markdrop AI drafts it; you check every field, then it's created as you.
- **Tickets on Team.** Each person's open Jira issues, what's overdue and blocked, and the team's issues by project, next to what they said in meetings.
- **To-dos and issues stay in step.** Tick a to-do that has an issue and the issue moves to Done in Jira. Move the issue to Done in Jira and the to-do ticks in Markdrop. Reopening works both ways.
- **Ask and links.** Ask "what's Ben working on in Jira?" or "status of PAY-123", and a Jira link pasted in a page shows the issue's live status.

Everything Markdrop does in Jira, it does **as the person doing it**, through their own Atlassian account. Jira's own permissions apply, and you are the reporter of the issues you create.

## Connect your Jira site

A workspace **admin** or the **owner** connects the workspace to one Jira site. Open **Workspace settings** and choose the **Integrations** tab. The **Jira** card shows one of three states:

| The card shows | What it means |
| --- | --- |
| **Not set up yet**, and "Jira isn't switched on for this server yet." | Jira isn't available on this Markdrop server. Nothing is wrong with your workspace. |
| **Connect Jira site** | Jira is available, and this workspace isn't connected yet. Members who aren't admins see "A workspace admin connects the Jira site here." |
| **Connected** | The Jira site, the default project and issue type for new issues, the projects on Team, who connected it and how many people connected their account. |

To connect:

1. On the **Integrations** tab, select **Connect Jira site**.
2. Atlassian asks you to allow Markdrop to use your Jira. Pick the site and select **Accept**. You come back to the **Integrations** tab.
3. Choose:
   - **Jira site**, when your Atlassian account reaches more than one.
   - **Default project for new issues** and **Default issue type**. People can pick another project when they create an issue.
   - **Projects on Team**: which projects' issues show on [Team](#tickets-on-team). Pick as many as you like.
4. Select **Save**. The card says **Connected**.

Your own Atlassian account is connected as part of this. Everyone else connects theirs once (see [Connect your Atlassian account](#connect-your-atlassian-account)).

![The Jira card when connected: the Jira site, New issues PAY · Task, On Team PAY and WEB, connected by Ada Owner with three people connected, Change projects and Disconnect Jira; under it, Your Atlassian account, connected.](/docs-assets/integrations/jira/card-connected.webp)

### Choose the projects on Team

Until an admin picks at least one project, **Team shows nothing from Jira**. The card says **Pick projects for Team**, and Team tells admins where to choose them. To change them later, select **Change projects**, tick or untick projects, and **Save**.

![Change projects: the default project and issue type for new issues, and the projects on Team, Payments and Website ticked.](/docs-assets/integrations/jira/projects.webp)

If the card says **The admin connection stopped working**, the Atlassian account that connected the site lost access (it was removed from Jira, or the access was revoked). Status updates from Jira pause until an admin selects **Reconnect**. **Disconnect Jira…** removes the connection. Issues stay in Jira and links stay on pages, but Team, status sync and chips stop until the site is connected again.

## Connect your Atlassian account

Markdrop creates and moves issues as you, so each person connects their own Atlassian account once:

- **Settings** › **Account** › **Jira** › **Connect my Atlassian account**, or
- **Workspace settings** › **Integrations** › **Your Atlassian account**, or
- the first time you create an issue: the dialog asks you to connect first.

Atlassian asks you to allow access. You come back to where you started, connected. **Disconnect** in Settings › Account removes your connection. Issues you made stay in Jira.

![Settings › Account › Jira: connected as Ben Member, with Disconnect.](/docs-assets/integrations/jira/account.webp)

Markdrop finds who each workspace member is in Jira: by their own connection, otherwise by their Markdrop email address, when Jira shows emails. That's how a meeting's "Ben will…" becomes an issue assigned to Ben, and how Team knows whose tickets are whose.

## Create an issue

You can create an issue from:

- **A meeting's decisions, action items and open questions.** Point at the item and select **+ Jira** next to it (on a phone it's always there). You need to be able to edit the meeting page.
- **Any text in a page.** In Edit mode, select text and choose **Create Jira issue** (the ticket button) in the toolbar, or open a block's **⋮⋮** menu and choose **Create Jira issue**.
- **A line on Team.** A blocker, target, action item or "working on" line: open its **⋯** menu and choose **Create Jira issue…**.

Markdrop AI drafts the issue from the item: a short **Summary**, a **Description**, the **Issue type**, a **Priority** when the item sounds urgent, the **Assignee** when the item names its owner, a **Due date** when it gives one ("by Friday"), and a few **Labels**. Check and change every field, pick another **Project** if you need to, then select **Create issue**.

![Create Jira issue: the action item quoted, the line Markdrop adds linking back to the meeting, and the drafted Summary, Description, Project, Issue type, Priority, Assignee Ben Member, Due date and Labels.](/docs-assets/integrations/jira/create-dialog.webp)

The issue's description gets your text, the item quoted, and a link back: "From *Checkout launch sync* · Nov 6, 2026 at 12:34", which opens the meeting at that moment of the transcript (or the page at that block). The item then shows a **chip**: the issue's key, status and assignee.

When AI can't run (it's off for the workspace, or AI is paused for now under its fair-use limit), the draft is the item as written, and the dialog says why. Creating the issue never depends on AI.

### All of a meeting's action items at once

On a meeting page, select **Jira issues** in the meeting bar. Markdrop drafts an issue for every open action item that doesn't have one yet. Untick the ones you don't want, edit the summaries, choose the project, and select **Create 2 issues** (the number you kept).

![Draft Jira issues for action items: two drafted issues with their summaries and assignees, the project, and Create 2 issues.](/docs-assets/integrations/jira/bulk.webp)

### Restricted meetings

For a meeting [restricted to its attendees](/workspaces/meetings-privacy#restricted-meetings), the dialog warns you: the link back only opens for people who can open the meeting in Markdrop, but **the text you put in the issue is visible to everyone who can see the issue in Jira**. Edit the summary and description before you create it.

## Chips on pages

A to-do or item with an issue shows a chip after it: the key (**PAY-4**), the status (**To do**, **In progress**, **Done**) and the assignee. Select it to open the issue in Jira.

![A meeting's action items: the first ticked, with PAY-4 Done Ben Member; the second with PAY-5 To do Wes Admin.](/docs-assets/integrations/jira/chips.webp)

What you see depends on **your own** Jira access. If your Atlassian account can open the issue, you see its status and assignee. If it can't, or you haven't connected, you see the key only. Markdrop never shows you an issue you couldn't open in Jira.

A Jira link pasted in a page (`https://your-site.atlassian.net/browse/PAY-123`) gets the same live chip, for people whose Jira can open it.

## To-dos and issues stay in step

For a to-do with an issue:

| You do | Markdrop does |
| --- | --- |
| Tick the to-do in Markdrop (in Edit mode, with the quick tick in View mode, from Home, with Slack's **Done**, or from an AI app) | Moves the issue to your project's Done status, as you. |
| Untick it | Moves the issue back to To do (or In progress), as you. |
| Move the issue to Done in Jira | Ticks the to-do on the page. Version history says "*name* via Jira". |
| Reopen the issue in Jira | Unticks the to-do. |

From Jira, the to-do is changed as the Markdrop member who changed the issue, or else as the person who linked it, when they can edit the page. If someone is editing the page at that moment, it's changed when they're done.

If Markdrop can't move the issue (you haven't connected your Atlassian account, or Jira doesn't let you make that change), nothing moves, and the chip shows a warning. Point at it to see why, and select **Retry** once it's fixed.

## Tickets on Team

With [Team](/workspaces/team) on and at least one [project on Team](#choose-the-projects-on-team), the board shows each person's Jira issues: assigned to them, in those projects, updated in the last 30 days.

- **Each card**: how many are in progress, to do and overdue, and their top three open issues.
- **Jira** under Team at a glance: the team's counts, the overdue and blocked issues, and open, overdue and recently done issues per project. Picking a group narrows it to the group.
- **A person's page**: their issues grouped as Overdue, Blocked, In progress, To do and Done lately.

An issue is **overdue** when its due date has passed and it isn't done, and **blocked** when its status name says "Blocked", it has a "blocked" label, or it's flagged.

![Team's Jira: 2 in progress, 3 to do, 1 overdue, 1 blocked, 2 done lately; the overdue and blocked issues; issues per project.](/docs-assets/integrations/jira/team.webp)

![Ben Member's Team card: 1 in progress, 1 to do, 1 overdue, and his top issues.](/docs-assets/integrations/jira/team-card.webp)

### Counts only until you connect

Details on Team come through **your own** Atlassian account, so you only ever see issues your Jira lets you open. Until you connect, Team shows **counts only** (how many to do, in progress, overdue, blocked and done lately per person, in the chosen projects), never a key, summary or link, with **Connect** to see the tickets.

![Team's Jira for someone who hasn't connected: counts only, with Connect.](/docs-assets/integrations/jira/team-counts.webp)

Team refreshes from Jira every few minutes when you open it; status changes in Jira show up sooner.

## Ask about tickets

[Ask Markdrop](/workspaces/ask-markdrop) reads Jira when your question is about tickets: "what's Ben working on in Jira?", "which tickets are blocked?", "status of PAY-123". It uses your own Atlassian connection, so it only sees what you can open in Jira, and it cites the issues with links. If you haven't connected, Ask answers from Markdrop only.

## From an AI app

With the [hosted MCP server](/ai/hosted-mcp), an AI app can check the connection (`jira_status`), draft and create issues from an item on a page or meeting (`create_jira_issue`: `draft: true` returns the AI draft and creates nothing), link an existing issue to an item (`link_jira_issue`), list the team's issues by person, project or status (`list_jira_issues`), and move an issue to done, to do or in progress (`transition_jira_issue`). The same rules apply: issue details only through your own Atlassian connection. Connecting is done on the website. See [MCP tools](/ai/tools#jira).

## Privacy

- Markdrop stores each person's Atlassian tokens encrypted, and uses them only for what that person does or sees.
- Only what you can read is sent to AI or to Jira: the item, its section and the meeting's or page's title and date.
- A chip, Team details and Ask answers show an issue only to people whose own Jira can open it.
- Markdrop keeps a short-lived copy of the issues it shows (key, summary, status, assignee, due date) to keep pages fast.
- Disconnecting your account deletes your tokens. Disconnecting the site stops Team, chips and status sync for the workspace.

## AI

Drafts use Markdrop's AI; see [AI and your data](/security/ai-and-your-data). Each draft is one short request; "Jira issues" for a whole meeting is one request. Jira drafts have fair-use limits: when one is reached, drafts are the item as written for now, and creating the issue still works. AI follows your workspace's AI setting: with AI off for the workspace, drafts are the item as written.

## Set up the Atlassian app (server owners)

This is for whoever runs the Markdrop server, once. Workspaces can't connect Jira until it's done.

1. Go to the [Atlassian developer console](https://developer.atlassian.com/console/myapps/) and select **Create** › **OAuth 2.0 integration**. Name it "Markdrop" and agree to the terms.
2. **Permissions** › **Jira API** › **Add**, then **Configure**. Under classic scopes, add `read:jira-work`, `write:jira-work` and `read:jira-user`. Add `manage:jira-webhook` too. Markdrop asks for `offline_access` itself.
3. **Authorization** › **OAuth 2.0 (3LO)** › **Add**. Set the **Callback URL** to `https://markdrop.in/integrations/jira/callback` (your server's address, followed by `/integrations/jira/callback`).
4. **Distribution**: set **Distribution status** to **Sharing**, fill in the vendor and privacy details, and save, so people outside your own Atlassian organization can connect.
5. **Settings**: copy the **Client ID** and **Secret** into the server's environment as `MARKDROP_ATLASSIAN_CLIENT_ID` and `MARKDROP_ATLASSIAN_CLIENT_SECRET`, and restart it. `MARKDROP_TOKEN_ENCRYPTION_KEY` must be set too.

Jira's status updates reach Markdrop through webhooks that Markdrop registers on the site when an admin connects it, and renews before they expire. Nothing else is needed in Jira.
