---
title: Publish and sync from VS Code
nav: Publish and sync
description: Install Markdrop Sync, publish a Markdown or HTML file from VS Code, and keep it in two-way sync with its markdrop.in link.
updated: 2026-10-30
prerequisites: [/get-started/accounts]
keywords: [vs code, vscode, extension, markdrop sync, publish, push on save, two-way sync, markdown, html, .markdrop.json]
---

The Markdrop Sync extension publishes the file you're editing in VS Code and keeps it in step with its link. Save the file and the link updates; edit it on markdrop.in and the change comes back into your file.

::video{id="vscode-sync" title="Publish from VS Code and watch an edit come back" duration="0:40"}

## Install the extension

Install **Markdrop Sync** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=HimanshuKukreja.markdrop), or search for "Markdrop Sync" in the Extensions view. From a terminal:

```bash
code --install-extension HimanshuKukreja.markdrop
```

It needs VS Code 1.85 or later.

## Sign in

::::steps
### Start the sign-in
Open the Command Palette (:kbd[⌘⇧P] on macOS, :kbd[Ctrl+Shift+P] elsewhere) and run **Markdrop: Sign in**.

### Approve in your browser
Markdrop opens a **Connect VS Code** page that shows the account the extension will publish as. Choose **Authorize VS Code**.

![The Connect VS Code page showing the signed-in account and an Authorize VS Code button.](/docs-assets/vscode/sync/vscode-authorize.webp)

### Return to VS Code
Your browser hands you back to VS Code, which shows "Signed in to Markdrop as …".
::::

Signing in creates an API token named "VS Code" on your account, and the extension keeps it in VS Code's Secret Storage. You can see and revoke it on [markdrop.in/settings/tokens](https://markdrop.in/settings/tokens).

If the browser hand-off doesn't come back to VS Code (for example in a remote or web-based VS Code), create a token on that page and run **Markdrop: Sign in with API token** to paste it.

## Publish a file

Open the file and run **Markdrop: Publish / link current file**. You can also choose **Publish to Markdrop** in the status bar, or the publish button in the editor title bar of a Markdown file.

When it's done, VS Code shows the link with **Open in browser** and **Copy link**.

- **The address** is based on the file name. If that address is taken, Markdrop picks a free one close to it.
- **The title** is the file's first `# Heading`. For HTML it is the `<title>`, then the first `<h1>`. Otherwise it is the file name.
- **Who can open it.** Anyone with the link. Change that on markdrop.in: see [Who can open a link](/sharing/who-can-open).

The document belongs to your account. Only you can sync it from VS Code.

### What you can publish

| Files | Publish as |
|---|---|
| `.md`, `.markdown`, `.mdx` | A Markdown document, rendered with diagrams and math. Up to 500,000 characters. |
| `.html` | A live web page at its own link. Up to 25 MB. |
| `.txt`, `.csv`, `.json`, `.svg` | A file that opens rendered for its type: CSV as a table, SVG as an image. Up to 25 MB. |

Use the `.html` extension for web pages: a `.htm` file is published as a Markdown document.

PDFs, Word documents, spreadsheets and zipped sites can't be edited as text, so they don't sync from VS Code. Upload them at [markdrop.in/upload](https://markdrop.in/upload) or with [`markdrop upload`](/cli/upload-and-replace).

## How syncing works

**From VS Code to Markdrop.** When you save a linked file, the extension sends it a moment later (0.8 seconds, so quick saves are sent once). Nothing is sent when the content hasn't changed. Line endings and trailing blank lines don't count as changes.

**From Markdrop to VS Code.** While VS Code is the focused window, the extension checks the file in the active editor for changes on markdrop.in every 10 seconds, and again when you switch to that file or back to VS Code. When the web version is newer:

- If you haven't changed the file since it last synced, the extension writes the web version into it.
- If you have, both sides changed. The extension opens a comparison and asks you what to keep. See [Resolve sync conflicts](/vscode/conflicts).

Files in other tabs, or in a VS Code window that isn't focused, are checked when you come back to them.

**Sync now.** **Markdrop: Sync now (push)** sends what's in the editor now, including changes you haven't saved, and then checks for web changes straight away (when `markdrop.autoPull` is on).

### The status bar

| Status bar | Meaning | Click to |
|---|---|---|
| Markdrop: sign in | You aren't signed in. | Sign in |
| Publish to Markdrop | This file isn't linked yet. | Publish it |
| Markdrop: synced | The file matches its link. | Open it in the browser |
| Markdrop: unsynced | You have changes that haven't been sent. | Open it in the browser |
| Markdrop: conflict | Both sides changed; a choice is waiting. | |

The tooltip on a linked file shows its address and revision.

## Stop syncing a file

Run **Markdrop: Unlink current file**. The file stops syncing; the document on markdrop.in stays as it is. Publish again to make a new link.

If the document is deleted on markdrop.in, the extension unlinks the file the next time it checks for web changes or sends a change, and shows "This document no longer exists on Markdrop — unlinked." The local file is kept.

## Where links are kept

Links are stored in `.markdrop.json` at the root of the workspace folder. It maps each file's path to its document id, address and last synced revision. Commit it to share the links with your team, or add it to `.gitignore`.

A file opened outside any workspace folder keeps its link in VS Code's own storage on that computer instead.

Sync follows the document's id, not its address, so [renaming its address](/documents/addresses) on markdrop.in doesn't break the link.

:::warning[Sign in with the account that published]
Only the owner can sync a document. If you sign in to the extension as someone else, files linked under the other account can't be found and are unlinked when they are next checked. Their documents on markdrop.in aren't affected.
:::

## Related

- [Resolve sync conflicts](/vscode/conflicts)
- [Extension settings and commands](/vscode/settings)
- [API tokens](/account/api-tokens)
