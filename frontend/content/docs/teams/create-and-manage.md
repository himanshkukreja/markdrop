---
title: Create and manage teams
description: Admins create teams and pick leads; leads manage members. Choose open or private, and set the team's Slack channel, Jira projects and digest.
updated: 2026-11-10
nav: Create and manage
keywords: [create team, new team, open team, private team, visibility, team leads, add members, remove members, join team, leave team, browse teams, team settings, slack channel, jira projects, weekly digest, delete team, admins can see]
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

## Create a team

1. In the sidebar, choose **Browse teams**, then **New team**.
2. Give it a name, and an emoji and colour if you like.
3. Choose **Open** or **Private**.
4. Pick its leads and members, then **Create team**.

::clip{src="/docs-assets/teams/create-and-manage/create-flow" alt="Sam opens Browse teams, chooses New team, names it Customer Success, picks pink, chooses Private (a note says workspace admins can see this team's content), ticks Maya Patel and creates it. The new team's home opens."}

## Open or private

- **Open**: anyone in the workspace can browse and search it, and join it. Its content still stays in its own space: it never shows up in another team's pages, memory or answers.
- **Private**: only its members see its pages, meetings and memory. Everyone else sees its name and weekly brief.

> [!IMPORTANT]
> Workspace admins can see a private team's content. A private team's settings say this plainly, so everyone knows.

![Sales's settings: "Who can see it" with Open and Private (Private chosen) and the note "Workspace admins can see this team's content. Everyone else sees only its name and weekly brief.", then the members with their roles.](/docs-assets/teams/create-and-manage/private-settings.webp)

## Browse, join and leave

**Browse teams** lists every team: yours, open teams you can join, and private teams (name and brief only).

![Browse teams as Alex: Your teams (Sales and Engineering), Open teams (Marketing, with Join), each card with its icon, member count and Open or Private.](/docs-assets/teams/create-and-manage/browse.webp)

To leave a team, open its settings and choose **Leave team**. In a private team you lose access to its pages, unless something was shared with you directly.

## Members and leads

In a team's settings, leads choose **Add people** to add anyone in the workspace, and **Remove** to take someone out. Admins set each person's role to **Lead** or **Member**. A team always has at least one lead.

## Slack, Jira and the weekly digest

- **Slack channel**: the team's meeting posts, its weekly brief and comment notices on its pages go to this channel instead of the workspace's. The workspace needs Slack connected first. See [Slack](/integrations/slack).
- **Post new and resolved comments on the team's pages**: on by default once the team has a channel. See [Comment notifications](/collaboration/notifications#in-a-teams-slack-channel).
- **Jira projects**: the team home shows these projects, and issues created from the team's meetings go to the first one. See [Jira](/integrations/jira).
- **Send the weekly brief to members**: by email, in the team's Slack channel, or both.

## Delete a team

Admins choose **Delete team** at the bottom of its settings. Nothing inside is deleted: its pages and meetings become company-wide, or stay in their other teams.
