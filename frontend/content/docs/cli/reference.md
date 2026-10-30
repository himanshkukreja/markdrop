---
title: CLI reference
nav: Command reference
description: Every markdrop command, flag, default, environment variable and exit code in CLI 0.5.1.
updated: 2026-10-30
since: CLI 0.5.0
keywords: [reference, flags, commands, options, environment variables, exit codes, help, completion]
---

This page covers the markdrop CLI 0.5.1. Run `markdrop <command> --help` for the same details in your terminal, and `markdrop --version` to see which version you have.

## Commands

| Command | What it does | Token |
|---|---|---|
| [`send <file\|folder>`](#send) | Share a file or folder peer to peer and wait for one recipient | Optional |
| [`get <room-id\|url>`](#get) | Download a peer-to-peer share | No |
| [`upload <path>`](#upload) | Publish a file and print its link | Yes |
| [`replace <slug-or-url> <path>`](#replace) | Swap the file behind a link, keeping the link | Yes |
| [`versions <slug-or-url>`](#versions) | List a file's versions | Yes |
| [`restore <slug-or-url> <version>`](#restore) | Make an earlier version current again | Yes |
| [`info <slug-or-url>`](#info) | Show a published file's details | Yes |
| [`workspaces [workspace]`](#workspaces) | List your workspaces, or one workspace's folders | Yes |
| [`login`](#login) | Save an API token on this computer | No |
| [`logout`](#logout) | Delete the saved API token | No |
| [`mcp`](#mcp) | Run the local MCP server for AI apps (stdio) | For file and workspace tools |
| `completion <shell>` | Print a shell completion script (bash, zsh, fish, powershell) | No |
| `help [command]` | Show help | No |

"Token" means an API token from `--token`, `MARKDROP_TOKEN` or `markdrop login`. See [Sign in with an API token](/cli/login-and-tokens).

## Global flags

These work with every command.

| Flag | Default | What it does |
|---|---|---|
| `--server` | `https://api.markdrop.in` | The Markdrop API the CLI talks to, for both signalling and file uploads. |
| `--origin` | `https://www.markdrop.in` | The `Origin` header sent when opening the signalling connection. |
| `--web` | `https://markdrop.in` for the default server | The web address used to build share links. |
| `-h`, `--help` | | Show help for the command. |
| `-v`, `--version` | | Print the version (root command only). |

You only need `--server`, `--origin` and `--web` when you run your own Markdrop server.

## Peer-to-peer commands

### send

```text
markdrop send <file|folder> [--token T]
```

Prints a share link, room id and QR code, waits for a recipient, sends the file and exits. A folder is zipped before sending. With a token (`--token`, `MARKDROP_TOKEN`, or the one saved by `markdrop login`), the share is listed under your account; without one it is anonymous. :kbd[Ctrl+C] stops it. Guide: [Send and receive files](/cli/send-and-receive).

### get

```text
markdrop get <room-id|url> [-o path] [-y]
```

| Flag | Default | What it does |
|---|---|---|
| `-o`, `--output` | Current folder | A folder to save into, or a file path when it has an extension. |
| `-y`, `--yes` | Off | Download without asking for confirmation. |

Accepts `https://markdrop.in/share/<id>` or the bare id (6 to 64 letters, digits, `-` or `_`). Waits up to 10 minutes for a sender who dropped off. Replaces an existing file with the same name.

## File commands

All file commands take these two flags:

| Flag | What it does |
|---|---|
| `--token` | Use this API token instead of `MARKDROP_TOKEN` or the saved one. |
| `--json` | Print the API's result as one compact JSON object on standard output, and nothing else. |

A `<slug-or-url>` can be a slug (`demo`), a markdrop.in link, or a link on a workspace's own domain. The CLI uses the last part of the path. A peer-to-peer share link is refused.

### upload

```text
markdrop upload <path> [flags]
```

| Flag | Default | What it does |
|---|---|---|
| `--title` | The file name | Title shown on the page. |
| `--access` | `link`; `workspace` with `--workspace`; `password` with `--password` | `link`, `private`, `password` or `workspace`. |
| `--password` | | Password for `--access password`. |
| `--slug` | From the file name | Custom address: 3 to 50 letters, digits, `-` or `_`. Fails if taken. |
| `--workspace` | | A workspace id, name or custom domain to file it in. |
| `--folder` | | An existing folder of that workspace: a path (`guides/setup`) or an id. Needs `--workspace`. |

Prints the link on standard output. Resumes an interrupted upload when run again with the same file and options. Guide: [Upload and replace files](/cli/upload-and-replace).

### replace

```text
markdrop replace <slug-or-url> <path> [--title T]
```

Replaces the file behind the link and prints the link and `version N`. `--title` also changes the title; without it the title is kept.

### versions

```text
markdrop versions <slug-or-url>
```

Lists versions newest first, with `*` on the one the link serves. Up to five are kept.

### restore

```text
markdrop restore <slug-or-url> <version>
```

`<version>` is a number from `versions` (`2` or `v2`). The restored file becomes a new version.

### info

```text
markdrop info <slug-or-url>
```

Prints the link, slug, type, size, version, SHA-256, dates and, for video and audio, resolution, length, codecs and poster.

### workspaces

```text
markdrop workspaces [workspace]
```

Without an argument: your workspaces with id, name, your role and live custom domains. With a workspace id, name or domain: its folders with path, name, item count and id. Guide: [Workspaces and folders](/cli/workspaces).

## Account commands

### login

```text
markdrop login [--token T]
```

Prompts for a token without echoing it, or reads one line from standard input when it isn't a terminal, or takes `--token`. Checks the token with the API, then saves it with mode `0600`.

### logout

```text
markdrop logout
```

Deletes the saved token. It doesn't revoke it on markdrop.in.

## mcp

```text
markdrop mcp
```

Runs Markdrop's local MCP server over standard input and output. AI apps start it themselves; you don't run it by hand. Standard output carries only the protocol and logs go to standard error. Guide: [Use Markdrop from an AI app on your computer](/ai/local-mcp).

## Environment variables

| Variable | Used by | Effect |
|---|---|---|
| `MARKDROP_TOKEN` | File commands, `send`, `mcp` | API token. Beats the saved token; `--token` beats it. |
| `MARKDROP_CONFIG_DIR` | `login`, `logout`, file commands, `send`, `mcp` | Folder for the saved token (`<dir>/token`). Default: your user config folder plus `markdrop`. |
| `MARKDROP_CACHE_DIR` | `upload`, `replace`, `mcp` | Folder for unfinished uploads (`<dir>/uploads`). Default: your user cache folder plus `markdrop`. |
| `MARKDROP_MCP_ALLOW_ANY_PATH` | `mcp` | `1` turns off the guard that refuses to share or publish secret locations such as `~/.ssh`. |
| `MARKDROP_DEBUG` | `send`, `get`, `mcp` shares | Any value prints connection state changes and the chosen route on standard error. |
| `MARKDROP_ICE_EXCLUDE_IFACES` | `send`, `get`, `mcp` shares | Comma-separated network interface name prefixes to leave out, for example `utun`. |

## Output and exit codes

- Results go to standard output. Progress, notices and errors go to standard error, so `url=$(markdrop upload x.mp4)` captures only the link.
- Progress bars for uploads are drawn only when standard error is a terminal.
- The exit code is `0` on success and `1` on any error. An interrupted `upload` or `replace` exits with `1` and the message "interrupted; run the same command again to resume the upload". Stopping `send` or `get` with :kbd[Ctrl+C] exits with `0`.
