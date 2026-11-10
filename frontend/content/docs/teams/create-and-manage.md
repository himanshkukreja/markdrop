---
title: Create and manage teams
description: Admins create teams and pick leads; leads manage members. Choose open or private, and set the team's Slack channel, Jira projects and digest.
updated: 2026-11-10
nav: Create and manage
keywords: [create team, general, default team, rename general, team icon, emoji,  new team, open team, private team, visibility, team leads, add members, remove members, join team, leave team, browse teams, team settings, slack channel, jira projects, weekly digest, delete team, admins can see]
---

## Who does what

| | Workspace admins | Team leads | Team members | Everyone else in the workspace |
| --- | --- | --- | --- | --- |
| Create or delete a team | Yes | | | |
| Choose open or private | Yes | | | |
| Pick the leads | Yes | | | |
| Add or remove members | Yes | Yes | | |
| Name, icon, colour, description, Slack, Jira, digest | Yes | Yes | | |
| Edit the weekly brief | Yes | Yes | | |
| Join an open team | Yes | | | Yes |
| Leave a team | Yes | Yes | Yes | |

General, the team everyone is in, works a little differently: admins can rename it and change its icon, colour, description and leads, but it's always open, it can't be deleted, and people join and leave it by joining and leaving the workspace.

## Create a team

1. In the sidebar, choose **+** next to **Teams** (or **Browse teams**, then **New team**).
2. Give it a name. Choose the icon beside the name to pick an emoji or an icon and a colour; **Remove icon** goes back to the name's first letter.
3. Add a description if you like: it shows in Browse teams.
4. Choose **Open** or **Private**.
5. Add people by name or email. Each person is a **Member**; choose the label to make them a **Lead**.
6. Choose **Create team**, or press ⌘↵ (Ctrl+Enter). Esc closes without creating.

Connecting the team's Slack channel and Jira projects is optional; you can do it later in its settings. On a phone the dialog opens from the bottom of the screen.

::clip{src="/docs-assets/teams/create-and-manage/create-flow" alt="Sam opens Browse teams, chooses New team, names it Customer Success, picks the handshake emoji and pink, chooses Private (a note says workspace admins can see every team's content), adds Maya Patel and creates it. The new team's home opens."}

## Open or private

- **Open**: anyone in the workspace can browse and search it, and join it. Its content still stays in its own space: it never shows up in another team's pages, memory or answers.
- **Private**: only its members see its pages, meetings and memory. Everyone else sees its name and weekly brief.

> [!IMPORTANT]
> Workspace admins can see a private team's content. A team's settings say this plainly, so everyone knows.

![Sales's settings: the icon and name, the description, "Who can see it" with Open and Private (Private chosen) and the note "Workspace admins can see every team's content, including private teams.", then the leads and members.](/docs-assets/teams/create-and-manage/private-settings.webp)

## Browse, join and leave

**Browse teams** lists every team: yours, open teams you can join, and private teams (name and brief only).

![Browse teams as Alex: Your teams (Sales and Engineering), Open teams (Marketing, with Join), each card with its icon, member count and Open or Private.](/docs-assets/teams/create-and-manage/browse.webp)

To leave a team, choose **Leave** on its home. In a private team you lose access to its pages, unless something was shared with you directly.

## Members and leads

Open a team's settings with the gear on its home (or **⋯ › Team settings** in the sidebar). Leads add anyone in the workspace by name or email and take people out with **×**. Admins switch each person between **Lead** and **Member**. A team always has at least one lead.

## Slack, Jira and the weekly digest

These are under **Connect Slack and Jira** in the team's settings.

- **Slack channel**: the team's meeting posts, its weekly brief and comment notices on its pages go to this channel instead of the workspace's. The workspace needs Slack connected first. See [Slack](/integrations/slack).
- **Post new and resolved comments on the team's pages**: on by default once the team has a channel. See [Comment notifications](/collaboration/notifications#in-a-teams-slack-channel).
- **Jira projects**: the team home shows these projects, and issues created from the team's meetings go to the first one. See [Jira](/integrations/jira).
- **Send the weekly brief to members**: by email, in the team's Slack channel, or both.

## Delete a team

Admins choose **Delete** at the bottom of its settings. Nothing inside is deleted: its pages, files and meetings move to General, or stay in their other teams. General itself can't be deleted.
