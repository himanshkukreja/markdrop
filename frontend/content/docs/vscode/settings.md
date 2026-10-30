---
title: VS Code settings and commands
nav: Settings and commands
description: "Every Markdrop Sync command and setting, with defaults: push on save, automatic pull, how often it checks, and the server addresses."
updated: 2026-10-30
prerequisites: [/vscode/sync]
keywords: [settings, pushOnSave, autoPull, pollSeconds, apiUrl, webUrl, commands, command palette, vs code]
---

Markdrop Sync works without any setup beyond signing in. Use these settings to change when it sends and fetches changes.

## Settings

Open **Settings** (:kbd[⌘,] on macOS, :kbd[Ctrl+,] elsewhere) and search for "Markdrop", or add them to `settings.json`.

| Setting | Default | What it does |
|---|---|---|
| `markdrop.pushOnSave` | `true` | Send a linked file to Markdrop when you save it. Turn it off to send only when you run **Markdrop: Sync now (push)**. |
| `markdrop.autoPull` | `true` | Bring changes made on markdrop.in into the local file. Turn it off and web edits stay on the web until you resolve them as a [conflict](/vscode/conflicts) on your next save. |
| `markdrop.pollSeconds` | `10` | How often, in seconds, to check the file in the active editor for web changes. The minimum is `5`. |
| `markdrop.apiUrl` | `https://api.markdrop.in` | The Markdrop API. Change it only for your own Markdrop server. |
| `markdrop.webUrl` | `https://markdrop.in` | The Markdrop website, used for sign-in and to open documents. |

```json title="settings.json"
{
  "markdrop.pushOnSave": true,
  "markdrop.autoPull": true,
  "markdrop.pollSeconds": 30
}
```

:::note
A new `markdrop.pollSeconds` value takes effect after you reload the window (**Developer: Reload Window**). The other settings apply straight away.
:::

The extension only checks for web changes while VS Code is the focused window, and only for the file in the active editor. A longer interval means fewer requests; switching to a file or back to VS Code always checks at once.

## Commands

Run these from the Command Palette (:kbd[⌘⇧P] on macOS, :kbd[Ctrl+Shift+P] elsewhere).

| Command | What it does |
|---|---|
| Markdrop: Sign in | Sign in through your browser. |
| Markdrop: Sign in with API token | Paste an API token from [markdrop.in/settings/tokens](https://markdrop.in/settings/tokens) instead. |
| Markdrop: Sign out | Forget the token on this computer. To end it everywhere, revoke it on the API tokens page. |
| Markdrop: Publish / link current file | Publish the current file and link it. |
| Markdrop: Sync now (push) | Send what's in the editor now, including unsaved changes, then check for web changes (when `markdrop.autoPull` is on). |
| Markdrop: Open current document in browser | Open the linked document on markdrop.in. |
| Markdrop: Unlink current file | Stop syncing this file. The web document stays as it is. |

## Status bar

The Markdrop item on the right of the status bar appears for files the extension can publish. It shows whether you're signed in, whether the file is linked, and whether it is synced. The full list is in [Publish and sync from VS Code](/vscode/sync#the-status-bar).

## Sign-in and tokens

The extension keeps its API token in VS Code's Secret Storage, not in your settings or in `.markdrop.json`. Signing out removes it from this computer only. Revoke it on [markdrop.in/settings/tokens](https://markdrop.in/settings/tokens) when you stop using a computer: every VS Code window using that token stops syncing at once.

If Markdrop answers that the token is no longer valid, the extension forgets it and asks you to sign in again.
