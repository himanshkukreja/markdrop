---
title: Add the local MCP server
nav: Local MCP server
description: Run markdrop mcp so an AI app on your computer can publish and replace files from disk and send or receive files peer to peer.
updated: 2026-10-30
prerequisites: [/cli/install, /cli/login-and-tokens]
since: CLI 0.3.0
keywords: [markdrop mcp, local server, stdio, claude desktop, claude code, cursor, vs code, upload_file, share_files, p2p]
---

The markdrop CLI includes a local MCP server, `markdrop mcp`. An AI app on your computer starts it and talks to it over standard input and output. Because it runs next to your files, your assistant can publish a 2 GB video or send a folder without passing the file through the conversation.

Use it alongside the [hosted server](/ai/hosted-mcp): the hosted one works with documents in your account, the local one with files on your disk. Apps in the cloud, such as claude.ai and ChatGPT, can't use the local server.

::video{id="local-mcp-publish" title="Ask an AI app to publish and replace a video" duration="0:44"}

## Set it up

:::::steps
### Install the CLI
Install markdrop 0.5.0 or later and check with `markdrop --version`. See [Install the markdrop CLI](/cli/install).

Earlier versions have fewer tools: 0.3.0 added the peer-to-peer tools, 0.4.0 the file tools and 0.5.0 the workspace tools.

### Create an API token
Publishing and replacing files need an API token. Create one at [markdrop.in/settings/tokens](https://markdrop.in/settings/tokens). Sharing peer to peer works without it, but with a token your shares are listed under your account, where the hosted server's `list_shares` can see them.

You can give the token to the server in its configuration, as below, or run `markdrop login` once: the server also uses the token that command saves.

### Add the server to your app
Register it once, as `markdrop-p2p`. The app starts and stops it.

::::tabs
:::tab[Claude Code]
```bash
claude mcp add markdrop-p2p -e MARKDROP_TOKEN=mdk_•••• -- markdrop mcp
```

Start Claude Code and run `/mcp`: markdrop-p2p shows as connected. There's nothing to sign in to. Add `--scope user` to make it available in every project.
:::

:::tab[Claude Desktop]
Open **Settings → Developer → Edit Config** and add this to `claude_desktop_config.json`:

```json title="claude_desktop_config.json"
{
  "mcpServers": {
    "markdrop-p2p": {
      "command": "markdrop",
      "args": ["mcp"],
      "env": { "MARKDROP_TOKEN": "mdk_••••" }
    }
  }
}
```

Quit and reopen Claude Desktop. The Markdrop tools appear under the tools menu in a chat.
:::

:::tab[Cursor]
Add this to `~/.cursor/mcp.json`, or to `.cursor/mcp.json` in one project:

```json title="mcp.json"
{
  "mcpServers": {
    "markdrop-p2p": {
      "command": "markdrop",
      "args": ["mcp"],
      "env": { "MARKDROP_TOKEN": "mdk_••••" }
    }
  }
}
```

Open Cursor's MCP settings and check markdrop-p2p is turned on.
:::

:::tab[VS Code]
For Copilot Chat in agent mode, add this to `.vscode/mcp.json` in your workspace:

```json title=".vscode/mcp.json"
{
  "servers": {
    "markdrop-p2p": {
      "type": "stdio",
      "command": "markdrop",
      "args": ["mcp"],
      "env": { "MARKDROP_TOKEN": "mdk_••••" }
    }
  }
}
```

Choose **Start** above the server in that file, or run **MCP: List Servers**. To use it in every workspace, run **MCP: Open User Configuration** and add the same entry.
:::
::::
:::::

:::tip[“command not found” or the server won't start]
Desktop apps often start with a shorter `PATH` than your terminal. Put the full path from `which markdrop` (on Windows, `where markdrop`) in `command`, for example `/opt/homebrew/bin/markdrop`.
:::

Don't commit a configuration file that contains your token. In a shared project, keep the token in your user configuration or use `markdrop login` instead.

## What it can do

| Tool | What it does | Token |
|---|---|---|
| `upload_file` | Publish a file from disk (up to 2 GB for video and audio) and return its link | Yes |
| `replace_file` | Swap the file behind a link, keeping the link; the old version is kept | Yes |
| `list_file_versions` | A file's versions, newest first | Yes |
| `restore_file_version` | Make an earlier version current again | Yes |
| `get_file_info` | Size, SHA-256, version, and video or audio details | Yes |
| `list_workspaces` | Your workspaces, roles and custom domains | Yes |
| `list_folders` | A workspace's folders, as paths `upload_file` takes | Yes |
| `share_files` | Share files or folders peer to peer and return a markdrop.in/share link | No |
| `share_status` | Progress of every share and download in this session | No |
| `stop_share` | Stop a share, or cancel a download | No |
| `receive_share` | Download a share link into a folder on this computer | No |

Inputs and results for each tool are in [MCP tools](/ai/tools#local-server-tools).

### Publishing files

`upload_file` and `replace_file` work like [`markdrop upload` and `markdrop replace`](/cli/upload-and-replace): the file is hashed, sent in parts and checked by Markdrop before it goes live, and nothing changes if the check fails. If the app cancels a long upload, calling the tool again with the same arguments resumes it. Apps that show progress get progress updates with the bytes sent.

New uploads are open to anyone with the link unless the assistant sets `access` to `private`, `password` or `workspace`. With `workspace` and `folder`, the file goes into one of your workspaces, and the link returned is on the workspace's custom domain when it has a live one.

### Sharing peer to peer

- `share_files` takes up to 100 paths. One file is sent as it is; several paths or a folder go as one zip, which `markdrop get` and `receive_share` unpack and a browser saves as a zip.
- The link keeps working, for one recipient at a time, until the assistant calls `stop_share` or you close the AI app. Closing the app ends every share it started.
- `receive_share` downloads into `~/Downloads/Markdrop` unless you name another folder, and runs in the background; ask for `share_status` to follow it. It never overwrites a file: a clashing name becomes `name (1).ext`.

## Safety

An AI app can be talked into calling a tool by text it reads: a web page, an issue, a file. The local server refuses well-known secret locations so a request like "share ~/.ssh" doesn't turn into a link to your keys:

- Folders: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.azure`, `~/.password-store`, `~/.config/gcloud`, `~/.config/gh`, macOS Keychains and the desktop keyring
- Files: `.env` files, `.netrc`, `.npmrc`, `.pypirc`, `.git-credentials`, `.pgpass`, `~/.docker/config.json`, SSH private keys such as `id_rsa` and `id_ed25519`, and `.pem`, `.p12`, `.pfx` and keychain files
- Folders that contain any of these, and paths that reach them through a symbolic link

This applies to `share_files`, `upload_file` and `replace_file`. `receive_share` also won't save into those locations or into folders that start programs at login, and it removes leading dots from received names so a sender can't plant a dotfile.

The guard is a safety net, not a sandbox. Read what your assistant is about to publish or share before you approve the call. To turn the guard off, set `MARKDROP_MCP_ALLOW_ANY_PATH=1` in the server's `env`.

## Troubleshooting

- **Logs.** The server writes its log to standard error, which your AI app collects in its MCP log. Standard output carries only the protocol.
- **"no Markdrop API token".** The file tools found no token. Add `MARKDROP_TOKEN` to the server's `env`, or run `markdrop login`, then restart the server from your app.
- **A share link stopped working.** Shares end when the AI app closes. Ask the assistant to share again.
- **Slow transfers.** See [Send and receive files](/cli/send-and-receive#when-the-connection-is-slow-or-fails); the same environment variables work in the server's `env`.
