---
title: Integrations
description: Every app Markdrop connects to, as a grid of cards. Open one to see what it does, set it up step by step, and change its settings.
updated: 2026-11-19
keywords: [integrations, integrations page, connect, connected, not connected, needs attention, admin only, details, settings integrations, workspace integrations, zoom, google meet, slack, jira, hubspot, crm, claude, chatgpt, cursor, mcp, google docs, notion, keep in sync, github, vs code, cli, disconnect]
---

Markdrop has two Integrations pages. Each shows its integrations as cards, and each card opens that integration's own page.

- **Settings › Integrations** ([markdrop.in/settings/integrations](https://markdrop.in/settings/integrations)) has your own connections: AI apps like Claude, ChatGPT and Cursor, Slack notifications, your Atlassian account for Jira, Google Docs, GitHub, VS Code and the CLI.
- **Workspace settings › Integrations** has what a workspace sets up once for everyone: Zoom, Google Meet, Slack, the Jira site and HubSpot. Open it from the workspace's menu in the sidebar, then the **Integrations** tab.

![Workspace settings › Integrations: Zoom, Google Meet, Slack and Jira cards, each with its status and Details.](/docs-assets/integrations/overview/workspace-grid.webp)

## The cards

Each card shows the app's logo and name, one line about what it does, and its status:

| Status | Meaning |
| --- | --- |
| **Connected** | It's set up and working. For Slack notifications, **On**. |
| **Not connected** | Nothing is set up yet. |
| **Needs attention** | It was set up, but something stopped working, like an expired permission. Open it to see what to fix. |
| **Admin only** | A workspace admin sets this one up. You can still open it and read the steps. |

![Settings › Integrations: cards for Slack, Jira, Claude, ChatGPT, Cursor, Other AI apps, Google Docs, GitHub, VS Code and the Markdrop CLI, each with its logo, group, a line about it, its status and Set up, Connect or Manage beside Details.](/docs-assets/integrations/overview/account-grid.webp)

Below that, one button: **Manage** when it's connected, **Connect** when one click does it, or **Set up** when it takes a few steps. **Details** always opens the integration's page.

## An integration's page

Each integration's page has:

1. **What it does**, in a few lines.
2. **Settings**: connect and disconnect, and its options. For Slack, Jira and Zoom these are the same settings as before.
3. **Set up**: the steps, numbered.
4. **Troubleshooting**: the common problems and what to do.
5. A link to its full guide here, like [Slack](/integrations/slack), [Jira](/integrations/jira), [Zoom](/integrations/zoom) or [HubSpot](/integrations/hubspot).

![Claude's page: Connected, What it does, the four setup steps, Settings with the server URL and the approved Claude app with Disconnect, Troubleshooting, and Read the guide.](/docs-assets/integrations/overview/detail.webp)

Choose **Integrations** at the top to go back to the grid.

Older links still work: a link to the Slack or Jira part of **Settings › Account**, or to a workspace's Slack or Jira settings, opens that integration's page.

## HubSpot

Connect the company's HubSpot account in **Workspace settings › Integrations › HubSpot** with a HubSpot service key, and pick a team such as Sales. Each of that team's calls is matched to its HubSpot meeting and deal, and **Log to HubSpot** writes the summary, next steps and decisions into the meeting's internal notes. Action items become HubSpot tasks when someone approves them. See [HubSpot](/integrations/hubspot).

## Google Docs

Connect Google Docs once, then publish any of your documents to Google Docs and sync it when the document changes.

1. Open **Settings › Integrations › Google Docs** and choose **Connect Google Docs**. Approve Markdrop in Google.
2. Open one of your documents and, in its details, choose **Publish to Google Docs**.
3. When the document changes, choose **Sync to Google Docs**.

Markdrop only sees the Google Docs it created. To stop, choose **Disconnect** on the Google Docs page: Markdrop's access is revoked at Google, and Docs it made stay in your Drive.

## Notion

Connect Notion in **Settings › Integrations › Notion** and choose, in Notion, the pages Markdrop may read. Then tick the pages to import (untick anything inside them to leave it out), pick a team or My files, and leave **Keep in sync** on to bring Notion's changes over about every 15 minutes, one way. Markdrop never writes to Notion, and a page you edit in Markdrop stops syncing instead of being overwritten. Each imported page says **Imported from Notion** at the top, with a link back to it in Notion. **Disconnect** revokes Markdrop's access; the imported pages stay. See [Import from Notion](/pages/import-from-notion#connect-notion).

## Related

- [Hosted MCP server](/ai/hosted-mcp): connect Claude, ChatGPT, Cursor and other AI apps.
- [Connected apps](/account/connected-apps): every AI app you've approved.
- [VS Code](/vscode/sync) and [the CLI](/cli/install).
- [Google Meet](/workspaces/meetings-auto-import): bring in meetings automatically.
