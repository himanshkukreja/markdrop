---
title: Connected apps
description: See which AI apps can use your Markdrop account, what each one may do, and disconnect any of them.
updated: 2026-10-30
keywords: [connected apps, oauth, mcp, claude, chatgpt, cursor, revoke, disconnect, permissions, scopes]
---

Connected apps are AI apps you've allowed to use your Markdrop account, like Claude, ChatGPT or Cursor. Each one connected through Markdrop's MCP server, and you approved it on Markdrop.

Manage them at [Settings › Connected apps](https://markdrop.in/settings/connections). To connect a new one, see [Hosted MCP server](/ai/hosted-mcp).

## What an app can do

When an app connects, Markdrop asks you to approve what it may do. It can ask for one or both:

| Shown as | What it allows |
| --- | --- |
| **Read** | Read your documents: see your documents and files, their titles, contents, links and view counts. |
| **Publish and edit** | Publish and change documents: publish, update, change access to and delete documents and files for you. |

An app gets only what you approved, never your whole account.

## See your apps

Each row shows the app's name and web address, badges for what it may do, when you connected it, and when it was last used ("Not used yet" if it hasn't been).

![The Connected apps page listing Cursor (cursor.com) with a Read badge, connected Oct 29 and Not used yet, and Claude (claude.ai) with Read and Publish and edit badges, last used today; each row has a menu.](/docs-assets/account/connected-apps/connected-apps-list.webp)

## Disconnect an app

Open the app's menu and choose **Disconnect**, then confirm. The app loses access to your Markdrop account, and everything it was given to stay signed in is revoked. What it published stays yours, with the same links.

To use it again, connect it from the app and approve it on Markdrop again.

## How long access lasts

An app's access renews every hour on its own while you use it. If an app isn't used for 60 days, it has to connect again.

## Not listed here

- **The VS Code extension** and **the CLI** use [API tokens](/account/api-tokens). Revoke them on the API tokens page.
- **Google Docs** is connected and disconnected from your documents dashboard. Choose **Disconnect** next to "Google Docs is connected." Docs you already exported stay in your Google Drive but stop syncing.
