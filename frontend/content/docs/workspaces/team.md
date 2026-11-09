---
title: "Team: your workspace memory"
nav: Team
description: Who is doing what in your workspace, from its meetings and pages. Status, focus, targets, blockers and projects, each line linked to its source.
updated: 2026-11-07
keywords: [team, jira, jira tickets, create jira issue, team memory, set_my_status, set_focus_note, hide_team_line, correct_team_line, mark_team_item_done, list_team_groups, save_team_group, delete_team_group, send_weekly_summary_now, timezone, weekly summary timezone, send now, mark done, groups, weekly summary, this week, monday summary, workspace memory, who is doing what, status, what is someone working on, standup, sync-up, targets, due dates, commitments, blockers, waiting on, quiet lately, on track, focus, set status, on leave, projects, swimlanes, hide a line, this is wrong, correct, privacy, restricted meetings, ai, turn on, turn off, list_team, get_person_profile, get_project_status, mcp]
---

**Team** answers "what is Abhishek working on?" and "where are we on the sourcing beta?" without anyone writing a status report. Markdrop reads your workspace's meetings and pages in the background and keeps short, dated lines about each person: what they're working on, what they finished, what they committed to and by when, and what's blocking them. Every line links to the meeting or page it came from.

Team is off until a workspace admin turns it on. To see how it fits with meetings, Ask and Slack, read [Meetings and Team: how it fits together](/workspaces/meetings-and-team).

:::details[Watch: Your workspace remembers (2½ min)]
A two-and-a-half-minute video of one team's day: Team's board, one person's page with dated targets, a correction, and asking the workspace what someone is working on.

::video{id="team-meetings" title="Your workspace remembers: meetings become pages, Team shows who's on what, and you can just ask" duration="2:23"}
:::

## Turn it on

Open **Team** in the workspace's sidebar (under **Meetings**) and choose **Turn on Team memory**, or switch on **Team memory** in the workspace's **Settings › Advanced**. Only admins and owners can. Members and viewers see that an admin can turn it on.

Turning it on also sets the workspace's **Weekly summary timezone** to the timezone of the admin's browser, when none was set. Admins can change it under the switch in **Settings › Advanced**.

When you turn it on, Markdrop reads the last 30 days of meetings and pages first, oldest first. Cards fill in over the next minutes; you can leave the page. After that it keeps up by itself:

- **Meetings** are read once their summary is written.
- **Pages and documents** are read 10 minutes after the last save, so a page being edited isn't read over and over. A page that didn't change isn't read again.

Turning Team memory off hides Team for everyone and **deletes everything it gathered**. People's own statuses, focus notes and corrections are kept, so they're there if you turn it on again. Turning it back on reads the last 30 days again.

## The Team board

Everyone in the workspace can open Team, whatever their role. People who only have a link to a document, or a page shared with them, never see it.

![The Team board: buttons to set your status and focus and manage groups, five numbers (on track, blocked or waiting, due this week, overdue, open items), the This week card with highlights, what's due and blockers, the filters, and the first member cards with their status, focus or now line, a target chip and a strip of their updates.](/docs-assets/workspaces/team/board.webp)

The board has a card for each member:

- **Status.** **On track** when something came up in the last week, **Blocked** or **Waiting on someone** when their latest word is a blocker (with what, and who they're waiting on), and **Quiet lately** when nothing came up for a week. Quiet lately is neutral: no colors, no day count. A status someone [sets themselves](#your-status-and-focus) wins over all of these.
- **Now.** Their focus note, or the newest thing they said they're working on.
- **Targets.** Commitments with a due date, like "ship the filters by Thursday". Dates said in a meeting are worked out from the meeting's day: "by Thursday" said on Tuesday is that Thursday. Gemini's suggested next steps count too: "Sam will update the pricing page by Friday", "by EOD", "early next week", "end of the month", or Hinglish like "kal tak" and "Monday tak". When the same item is noted with and without a date, Team keeps the dated one. Each target says **Due today**, **Due Fri** or **Overdue**.
- **Open items**, a strip of their updates over the last one or two weeks, and when they last came up, with a link to where.

Above the cards, five numbers: on track, blocked or waiting, due this week, overdue, open items. Below them, **Team at a glance**:

- **Open items per person**, split into overdue, due this week, and later or no date.
- **Updates per day** for each person over the period you picked. Darker means more updates that day.
- **Blockers**: who is blocked, on what, waiting on whom, and since when.

![Team at a glance: open items per person as bars split into overdue, due this week and later; updates per day for each person as a row of cells, darker for more; and the blockers list naming who is waiting on whom.](/docs-assets/workspaces/team/glance.webp)

Filter by person, status, [group](#groups) or project, and pick **This week** or **2 weeks**. The five numbers follow the filters, so picking a group sums up that group. The **Projects** tab shows each recurring project with the people on it and what each of them last said about it.

::clip{src="/docs-assets/workspaces/team/filters" alt="Filtering the Team board: Blocked or waiting leaves Priya, waiting on Raj for the API keys, with the blockers list below; then back to everyone, and a group."}

On a phone, the numbers sit two by two above the This week card, and the cards stack.

![The Team board on a phone: Set my status, My focus and Groups, the numbers two by two, and the This week card.](/docs-assets/workspaces/team/board-phone.webp)

## Groups

Admins can make simple groups, like "Sourcing team", with **Groups** on the board: a name and its members. Everyone can then filter the board by group. Markdrop suggests groups from your recurring meetings: the people at half or more of a series' meetings in the last 60 days. Pick **Use** to start from a suggestion.

![The Groups window: a group with its members, a suggested group from a recurring meeting series with Use, and New group.](/docs-assets/workspaces/team/groups.webp)

## The weekly summary

Every Monday at 9 am in the workspace's timezone, Team sends a summary titled "Week of Nov 9: last week's highlights and what's due". Each part says which week it's about:

- **Last week (Nov 2 – 8)**: the highlights of the week that just ended, Monday to Sunday: what shipped, decisions, changes of plan. At most two per person, spread across the team, without repeats. Below them, last week's other **decisions** (ones the highlights don't already say) and the **meetings** held last week.
- **Due this week (Nov 9 – 15)**: open action items and targets due this Monday to Sunday, each with its day.
- **Overdue**: open ones that were due in the last two weeks, with how late they are. Older ones count as stale: they stay on the person's page, where they can **Mark done** or dismiss them, but leave the summary.
- **Blocked right now**: who's blocked or waiting, and on whom.

Done items never show: ones ticked off (- [x]) on their meeting or page, marked done by their person, or reported done later.

- It's emailed to the workspace's admins and owner, headed "Weekly summary · Monday Nov 9": the counts at the top, then each person's highlights beside their initials, and every due and overdue item with its date. When a part is empty the subject says only what's there, like "Week of Nov 9: what's due".
- It's posted to the workspace's [Slack meetings channel](/integrations/slack), when Slack is connected, with the same parts and labels.
- The **This week so far** card at the top of Team is about the current week ("This week so far · Nov 9–15"): its highlights are this week's so far, its due items this week's, and overdue as above. Before anything has happened this week, as on a Monday morning, it shows last week's highlights instead, titled "Last week · Nov 2–8". Three columns on a computer, two and one on a tablet, stacked on a phone. Someone with three or more lines in a column shows as one row ("Gautam · 4 items") that opens. Tap a line to read it in full.

![The This week card: Highlights with each person's line and where it came from, Due this week with Mei's four items folded into one row, and Overdue with how many days late, plus Send now.](/docs-assets/workspaces/team/this-week.webp)

The summary only uses lines from meetings and pages **everyone in the workspace can open**: never a restricted meeting or a private page. The timezone is the workspace's **Weekly summary timezone** (Settings › Advanced): at first, the one of the admin who turned Team memory on. Admins can send it right away with **Send now** on the card (it still covers last week and this week's due items, whatever the day); nothing is sent when there's nothing in it.

## A person's page

Select a card to open someone's page: their status and focus, **Working on now**, **Targets**, a **Timeline** of updates by day, **Open action items**, **Decisions they own**, and their recent meetings and documents. Each line has its source: the meeting (and, with the play button, the moment in the transcript) or the page.

![A person's page: their status and what they're on, a strip of the last 30 days, Working on now and Targets with due dates, each line with the meeting or page it came from, a Timeline by day, Open action items and Recent meetings.](/docs-assets/workspaces/team/person.webp)

A project's page shows its latest status, who is on it, what's being worked on, decisions, open items and blockers.

## Where the lines come from

- **Meetings**: the meeting's summary, its action items and its transcript. An action item with an owner who is a member becomes theirs.
- **Pages and documents** in the workspace: what the text says people are doing, and open to-dos that @mention someone.
- A project is any product, feature or initiative that comes up in at least two meetings or pages. Folder names count too.

Lines are short and in English. "Working on" lines fade after two weeks unless they come up again. Markdrop never reads encrypted or password-protected documents, files, or templates.

## Jira tickets on Team

When your workspace has [Jira connected](/integrations/jira) and an admin picked the projects for Team, each card also shows the person's open Jira issues (in progress, to do, overdue), Team at a glance gets a **Jira** section with overdue and blocked issues and issues per project, and a person's page lists their issues. Details come through your own Atlassian account; until you connect it, you see counts only. A blocker, target or action item line can become a Jira issue: open its **⋯** menu and choose **Create Jira issue…**. See [Tickets on Team](/integrations/jira#tickets-on-team).

## Who sees what

Team is put together for each person when they open it. A line shows only while you can open the meeting or page it came from.

- A meeting [restricted to its attendees](/workspaces/meetings-privacy#restricted-meetings) only feeds the Team pages of the people who were there. A 1:1 never shows to anyone else.
- A line from a private page shows only to people who can open that page. When a page goes to the Trash, its lines disappear for everyone.
- A line that used a meeting's transcript needs the transcript too.
- [Ask](/workspaces/ask-markdrop) and AI apps follow the same rules.

## Your status and focus

On Team, or your own page:

- **Set my status**: a few words and an emoji, like "On leave till Monday" or "Heads down on sourcing", and when it clears. It replaces the status Team works out, for everyone, until it clears. While your status says you're away, you're never shown as quiet.
- **My focus**: what you're focused on, in your own words. It tops your card and your page for two weeks.

![Your status: presets (On leave, Out sick, Heads down, Blocked, Travelling), the status text, when it clears, and Clear, Cancel and Save.](/docs-assets/workspaces/team/status.webp)

## Fix what it says about you

Each line about you has a menu on your own page:

- **Mark done** (action items and targets): it leaves your open items, the board and This week, and stays done when the meeting or page is read again. Ticking it off on the page works too.
- **Hide this line** (**Dismiss** on action items and targets): nobody sees it. It stays hidden even when the meeting or page is read again. Undo it under **Hidden by you**.
- **This is wrong…**: write what's right, and people see that instead, marked *corrected*. Leave it empty to take the line down. Markdrop is told about it the next time it reads that meeting or page, so it doesn't say it again.

![The menu on one of your targets: Mark done, Dismiss (hide this line) and This is wrong.](/docs-assets/workspaces/team/line-menu.webp)

::clip{src="/docs-assets/workspaces/team/mark-done" alt="On your own Team page, the menu on a target, Mark done: Marked done, and the target leaves your page."}

Only the person a line is about can mark it done, hide it or correct it. A project's own lines (not about a person) can be hidden or corrected by workspace admins.

## Ask about your team

[Ask](/workspaces/ask-markdrop) (**Ask Acme** in a workspace called Acme) uses Team memory for questions like "What is Priya working on?", "What's my status?", "Who is working on the billing export?" and "What's the status of the sourcing project?". Answers cite the meetings and pages the lines came from.

AI apps connected to Markdrop can read Team with `list_team`, `get_person_profile`, `get_project_status` and `list_team_groups`. With write access they can also set your status (`set_my_status`) and focus (`set_focus_note`), and mark done, hide or correct lines about you (`mark_team_item_done`, `hide_team_line`, `correct_team_line`), with the same rule as on the website: only your own lines. Admins' apps can make groups (`save_team_group`, `delete_team_group`) and send the weekly summary now (`send_weekly_summary_now`). See [MCP tools](/ai/tools#team).

## AI

Team memory reads changed meetings and pages with AI in the background, and the weekly summary's highlights are written with AI too. What's sent is never used to train models; see [AI and your data](/security/ai-and-your-data).

Team memory has fair-use limits. If a limit is reached, updates pause for now and admins see a note on Team; Team picks up again by itself, and nothing is lost.

## Related

- [Meetings and Team: how it fits together](/workspaces/meetings-and-team)
- [Meetings](/workspaces/meetings)
- [Ask Markdrop](/workspaces/ask-markdrop)
- [Slack](/integrations/slack#teams-weekly-summary)
- [MCP tools](/ai/tools#team)
