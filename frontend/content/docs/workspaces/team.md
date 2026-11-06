---
title: "Team: your workspace memory"
nav: Team
description: Who is doing what in your workspace, from its meetings and pages. Status, focus, targets, blockers and projects, each line linked to its source.
updated: 2026-11-06
keywords: [team, team memory, groups, weekly summary, this week, monday summary, workspace memory, who is doing what, status, what is someone working on, standup, sync-up, targets, due dates, commitments, blockers, waiting on, quiet lately, on track, focus, set status, on leave, projects, swimlanes, hide a line, this is wrong, correct, privacy, restricted meetings, ai, claude haiku, cost, turn on, turn off, list_team, get_person_profile, get_project_status, mcp]
---

**Team** answers "what is Abhishek working on?" and "where are we on the sourcing beta?" without anyone writing a status report. Markdrop reads your workspace's meetings and pages in the background and keeps short, dated lines about each person: what they're working on, what they finished, what they committed to and by when, and what's blocking them. Every line links to the meeting or page it came from.

Team is off until a workspace admin turns it on.

## Turn it on

Open **Team** in the workspace's sidebar (under **Meetings**) and choose **Turn on Team memory**, or switch on **Team memory** in the workspace's **Settings › Advanced**. Only admins and owners can.

When you turn it on, Markdrop reads the last 30 days of meetings and pages first, oldest first. Cards fill in over the next minutes; you can leave the page. After that it keeps up by itself:

- **Meetings** are read once their summary is written.
- **Pages and documents** are read 10 minutes after the last save, so a page being edited isn't read over and over. A page that didn't change isn't read again.

Turning Team memory off hides Team for everyone and **deletes everything it gathered**. People's own statuses, focus notes and corrections are kept, so they're there if you turn it on again. Turning it back on reads the last 30 days again.

## The Team board

Everyone in the workspace can open Team, whatever their role. People who only have a link to a document, or a page shared with them, never see it.

The board has a card for each member:

- **Status.** **On track** when something came up in the last week, **Blocked** or **Waiting on someone** when their latest word is a blocker (with what, and who they're waiting on), and **Quiet lately** when nothing came up for a week. Quiet lately is neutral: no colors, no day count. A status someone [sets themselves](#your-status-and-focus) wins over all of these.
- **Now.** Their focus note, or the newest thing they said they're working on.
- **Targets.** Commitments with a due date, like "ship the filters by Thursday". Dates said in a meeting are worked out from the meeting's day: "by Thursday" said on Tuesday is that Thursday. Each target says **Due today**, **Due Fri** or **Overdue**.
- **Open items**, a strip of their updates over the last one or two weeks, and when they last came up, with a link to where.

Above the cards, five numbers: on track, blocked or waiting, due this week, overdue, open items. Below them, **Team at a glance**:

- **Open items per person**, split into overdue, due this week, and later or no date.
- **Updates per day** for each person over the period you picked. Darker means more updates that day.
- **Blockers**: who is blocked, on what, waiting on whom, and since when.

Filter by person, status, [group](#groups) or project, and pick **This week** or **2 weeks**. The five numbers follow the filters, so picking a group sums up that group. The **Projects** tab shows each recurring project with the people on it and what each of them last said about it.

## Groups

Admins can make simple groups, like "Sourcing team", with **Groups** on the board: a name and its members. Everyone can then filter the board by group. Markdrop suggests groups from your recurring meetings: the people at half or more of a series' meetings in the last 60 days. Pick **Use** to start from a suggestion.

## The weekly summary

Every Monday at 9 am in the workspace's timezone, Team puts together the week: **highlights** (what shipped, decisions, changes of plan), current **blockers**, and the **commitments due this week** and overdue.

- It's emailed to the workspace's admins and owner.
- It's posted to the workspace's [Slack meetings channel](/integrations/slack), when Slack is connected.
- It's the **This week** card at the top of Team. Before the first Monday, the card shows the week so far.

The summary only uses lines from meetings and pages **everyone in the workspace can open**: never a restricted meeting or a private page. The timezone is the one of the admin who turned Team memory on. Admins can send it right away with **Send now** on the card.

## A person's page

Select a card to open someone's page: their status and focus, **Working on now**, **Targets**, a **Timeline** of updates by day, **Open action items**, **Decisions they own**, and their recent meetings and documents. Each line has its source: the meeting (and, with the play button, the moment in the transcript) or the page.

A project's page shows its latest status, who is on it, what's being worked on, decisions, open items and blockers.

## Where the lines come from

- **Meetings**: the meeting's summary, its action items and its transcript. An action item with an owner who is a member becomes theirs.
- **Pages and documents** in the workspace: what the text says people are doing, and open to-dos that @mention someone.
- A project is any product, feature or initiative that comes up in at least two meetings or pages. Folder names count too.

Lines are short and in English. "Working on" lines fade after two weeks unless they come up again. Markdrop never reads encrypted or password-protected documents, files, or templates.

## Who sees what

Team is put together for each person when they open it. A line shows only while you can open the meeting or page it came from.

- A meeting [restricted to its attendees](/workspaces/meetings-privacy#restricted-meetings) only feeds the Team pages of the people who were there. A 1:1 never shows to anyone else.
- A line from a private page shows only to people who can open that page. When a page goes to the Trash, its lines disappear for everyone.
- A line that used a meeting's transcript needs the transcript too.
- [Ask Markdrop](/workspaces/ask-markdrop) and AI apps follow the same rules.

## Your status and focus

On Team, or your own page:

- **Set my status**: a few words and an emoji, like "On leave till Monday" or "Heads down on sourcing", and when it clears. It replaces the status Team works out, for everyone, until it clears. While your status says you're away, you're never shown as quiet.
- **My focus**: what you're focused on, in your own words. It tops your card and your page for two weeks.

## Fix what it says about you

Each line about you has a menu on your own page:

- **Hide this line**: nobody sees it. It stays hidden even when the meeting or page is read again. Undo it under **Hidden by you**.
- **This is wrong…**: write what's right, and people see that instead, marked *corrected*. Leave it empty to take the line down. Markdrop is told about it the next time it reads that meeting or page, so it doesn't say it again.

Only the person a line is about can hide or correct it.

## Ask about your team

[Ask Markdrop](/workspaces/ask-markdrop) uses Team memory for questions like "What is Priya working on?", "What's my status?", "Who is working on the billing export?" and "What's the status of the sourcing project?". Answers cite the meetings and pages the lines came from.

AI apps connected to Markdrop can use three tools: `list_team`, `get_person_profile` and `get_project_status`. See [MCP tools](/ai/tools#team).

## AI and cost

Team memory uses Claude Haiku 5.5, in the background, once per changed meeting or page. A meeting costs about a fifth of a cent and a page less. The weekly summary's highlights are one more call per workspace a week. It has its own budget, **Team memory**, of $3 a day and $30 a month across Markdrop, which the Markdrop admin can change. When it runs out, updates pause until the next day and admins see a note on Team; nothing is lost. What's sent is never used to train models.
