---
title: Teams for AI apps
description: Let Claude, ChatGPT or Cursor list teams, read a team's home and brief, put pages and meetings into teams, and ask one team's space.
updated: 2026-11-10
nav: For AI apps
prerequisites: [/ai/hosted-mcp]
keywords: [mcp, teams mcp, list_teams, get_team, create_team, update_team, add_team_members, remove_team_members, move_to_team, share_to_team, get_team_brief, edit_team_brief, list_projects, create_project, route_meeting, space, team scope, ai apps]
---

Everything on these pages works from an AI app connected to Markdrop's [hosted MCP server](/ai/hosted-mcp). The app acts as you, with your access: it sees the teams and content you can see, and can only change what you could on the website.

## Try asking

> What did the Sales team ship and decide last week?

`get_team_brief` reads Sales's latest brief.

> Move "Q4 pricing playbook" into Sales, and also share it with Marketing.

`move_to_team`, then `share_to_team`.

> Which teams does the Northwind renewal call belong to? Put it in Sales only.

`route_meeting` with `teams: ["Sales"]`.

> Ask Engineering what's blocking SSO.

`ask_documents` with `space: "team:<id>"` (from `list_teams`).

## Tools

| Tool | Read or write | What it does | Arguments |
| --- | --- | --- | --- |
| `list_teams` | read | The workspace's teams: name, open or private, size, and whether you're in it. | `workspace` |
| `get_team` | read | A team's home: its latest brief, members, recent pages, meetings and projects. A private team you're not in: its name and brief. | `workspace`, `team` (id, slug or name) |
| `get_team_brief` | read | A team's weekly brief, this week's or an earlier one. Every workspace member can read it. | `workspace`, `team`, `week` |
| `list_projects` | read | Cross-team projects you can open, or one team's. | `workspace`, `team` |
| `create_team` | write | Workspace admins: a new open or private team, with its leads and members. | `workspace`, `name`, `visibility`, `description`, `leads`, `members` |
| `update_team` | write | Leads and admins: name, description, Slack channel, comment posts to the channel (`slack_comments`), Jira projects, digest; admins also open or private. | `workspace`, `team`, … |
| `add_team_members` | write | Leads and admins add workspace members; anyone can add themselves to an open team. | `workspace`, `team`, `people` |
| `remove_team_members` | write | Leads and admins remove people; anyone can remove themselves (`"me"`). | `workspace`, `team`, `people` |
| `move_to_team` | write | Puts a document, page or file into one team, or back to company-wide (`team: "company"`). | `document`, `team` |
| `share_to_team` | write | Adds a team to an item's teams, or takes one off (`remove: true`). | `document`, `team`, `remove` |
| `edit_team_brief` | write | Leads and admins: change, hide or add a line of the brief. | `workspace`, `team`, `line_id`, `text`, `hidden`, `add` |
| `create_project` | write | A project shared by several teams. | `workspace`, `name`, `teams` |
| `route_meeting` | write | Says which teams a meeting belongs to (its page and transcript follow). | `meeting`, `teams` |

`search`, `ask_documents`, `ask_meetings`, `list_team`, `get_person_profile`, `get_project_status`, `list_workspace_items` and `list_meetings` take a `space`: `team:<id>`, `project:<id>`, `company` (company-wide only) or `all` (the default: everything you can read). See [All tools](/ai/tools#teams).
