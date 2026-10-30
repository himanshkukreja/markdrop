---
title: Connect an AI app to Markdrop
nav: Connect an AI app
description: Add Markdrop's hosted MCP server to Claude, ChatGPT, Claude Code, Cursor or VS Code, approve it on Markdrop, and manage or disconnect it later.
updated: 2026-10-30
prerequisites: [/get-started/accounts]
keywords: [mcp, connector, claude, chatgpt, cursor, vs code, copilot, windsurf, oauth, connected apps, remote server]
---

Markdrop's hosted MCP server lives at one address. Paste it into your AI app, sign in to Markdrop when the app sends you there, and approve. There is no API key, client ID or secret to copy.

```text title="Server URL"
https://api.markdrop.in/mcp
```

You need a Markdrop account. Connecting and using the tools is free.

::video{id="connect-claude" title="Connect Claude to Markdrop and publish a doc" duration="0:45"}

## Add it to your app

::::tabs
:::tab[Claude]
On claude.ai and in Claude Desktop:

1. Open **Settings → Connectors**.
2. Choose **Add custom connector**, name it Markdrop and paste the server URL.
3. Choose **Connect**. Markdrop opens in your browser: sign in and approve.
4. In a chat, ask Claude to publish something to Markdrop.

On Team and Enterprise plans, an owner may need to add the connector for the organisation first.
:::

:::tab[Claude Code]
In your terminal:

```bash
claude mcp add --transport http markdrop https://api.markdrop.in/mcp
```

Start Claude Code, run `/mcp`, pick markdrop and sign in. Markdrop opens in your browser to approve. Add `--scope user` to the command to make it available in every project.
:::

:::tab[ChatGPT]
On chatgpt.com, with Developer mode:

1. Open **Settings → Apps & Connectors → Advanced settings** and turn on **Developer mode**.
2. Back in **Apps & Connectors**, choose **Create**. Name it Markdrop, paste the server URL and pick **OAuth** for authentication.
3. Choose **Create**, then sign in to Markdrop and approve.

Developer mode needs a Pro, Team, Enterprise or Edu plan.
:::

:::tab[Cursor]
Add this to `~/.cursor/mcp.json`, or to `.cursor/mcp.json` in one project:

```json title="mcp.json"
{
  "mcpServers": {
    "markdrop": {
      "url": "https://api.markdrop.in/mcp"
    }
  }
}
```

Open Cursor's MCP settings and sign in to markdrop when it asks. Markdrop opens in your browser to approve.
:::

:::tab[VS Code]
For Copilot Chat in agent mode, add this to `.vscode/mcp.json` in your workspace:

```json title=".vscode/mcp.json"
{
  "servers": {
    "markdrop": {
      "type": "http",
      "url": "https://api.markdrop.in/mcp"
    }
  }
}
```

Choose **Start** above the server in that file, or run **MCP: List Servers**. VS Code opens Markdrop in your browser to sign in and approve. To use it in every workspace, run **MCP: Open User Configuration** and add the same entry.
:::

:::tab[Other apps]
Windsurf and any other MCP app that connects to remote servers:

1. Add a remote MCP server with the server URL. The transport is Streamable HTTP.
2. Choose OAuth for authentication. There is no client ID, secret or API key to paste: the app registers itself.
3. Sign in to Markdrop when the app opens it, and approve.
:::
::::

## Approve the app

When the app sends you to Markdrop, you see which app is asking, the account you're signed in as, and what it will be able to do. Choose **Approve** to connect it, or **Cancel** to send it away with nothing shared.

The approval link works once, for 10 minutes. If it has expired, start again from your AI app.

### The two permissions

| Permission | On the approval screen | Lets the app |
|---|---|---|
| `documents:read` | See your documents and files | Read titles, contents, links and view counts; list and search; check files, uploads, shares and workspaces. |
| `documents:write` | Publish and manage documents for you | Publish, update, change access to and delete documents and files; upload and replace files; file documents in workspaces. |

Each tool needs one of them; [MCP tools](/ai/tools) lists which. If an app calls a tool it wasn't given permission for, it is asked to reconnect and approve the missing permission.

## Things to ask

Say it the way you would to a colleague:

- "Turn these meeting notes into a Markdrop doc and give me the link."
- "Build an HTML dashboard of this CSV and publish it."
- "Make my Q3 report private."
- "How many people read my launch notes?"
- "Where do people stop watching the demo video?"
- "Put the onboarding guide in Acme's guides/setup folder."
- "Is this share link still working? markdrop.in/share/4f9a2c71e0"

## Manage connected apps

Every app you approve is listed in [Settings → Connected apps](https://markdrop.in/settings/connections). Choose **Disconnect** on an app to end its access: its current sign-in stops working and it can't renew it. To use it again, connect it from the app as before. More in [Connected apps](/account/connected-apps).

## Privacy

- The app gets its own token for this server, never your Markdrop sign-in.
- It can't read end-to-end encrypted documents, and it never gets past a password, private access or a workspace's sign-in.
- Markdrop logs which tool ran, when, and whether it worked, for 90 days. It doesn't log what was in the call.
- What the assistant reads from Markdrop becomes part of your conversation, so your AI provider's own data policy applies to it.

## Limits

Each account can make up to 60 calls to writing tools and 300 calls to reading tools per minute, across all its connected apps. Past that, the tool answers "Too many requests in a short time. Wait a minute before trying again."

`get_document` returns at most 200,000 characters of a document and says when it cut the text.

## For developers

Details for people building or debugging an MCP client:

| | |
|---|---|
| Endpoint | `POST https://api.markdrop.in/mcp`, Streamable HTTP. The server is stateless: `GET` and `DELETE` answer `405`. |
| Protocol versions | `2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25` and `2026-07-28` |
| Authorization | OAuth 2.1 authorization code flow with PKCE (`S256`). Clients register with dynamic client registration (`/oauth/register`) or a client ID metadata document. |
| Metadata | `https://api.markdrop.in/.well-known/oauth-protected-resource/mcp` and `https://api.markdrop.in/.well-known/oauth-authorization-server` |
| Redirect URIs | `https`, `http` to a loopback address, or an app's own scheme (for example `cursor://`) |
| Tokens | Access tokens last 1 hour and are valid only for this server. Refresh tokens last 60 days and change on every use; reusing an old one revokes the whole chain. |
| Not accepted | `mdk_` API tokens and markdrop.in session tokens. They are refused rather than downgraded. |

A request without a token gets `401` with a `WWW-Authenticate` header that points to the metadata. A token missing a permission gets `403` with `error="insufficient_scope"` and the scope it needs.

## Related

- [Add the local server](/ai/local-mcp) for files on your disk and peer-to-peer sharing
- [MCP tools](/ai/tools)
