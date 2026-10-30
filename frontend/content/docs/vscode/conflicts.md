---
title: Resolve sync conflicts
nav: Conflicts
description: What happens when a file changed both in VS Code and on markdrop.in, and how Keep my local version, Use the web version and Merge manually work.
updated: 2026-10-30
prerequisites: [/vscode/sync]
keywords: [conflict, merge, diff, keep my local version, use the web version, merge manually, revision, vs code]
---

A conflict happens when a linked file changed in VS Code and on markdrop.in since it last synced: for example, you edited the file locally while a teammate or an AI app edited the document on the web. The extension never overwrites either side on its own. It shows you both and asks.

::video{id="vscode-conflict" title="Resolve a conflict between VS Code and the web" duration="0:27"}

## How the extension spots a conflict

Every document on Markdrop has a revision number that goes up with each change. The extension remembers the revision your file last synced at.

- **When you save**, it sends your file along with that revision. If the document on markdrop.in has moved on, Markdrop refuses the change and sends back the current web version instead.
- **When it checks for web changes** and finds a newer revision while your file has changes it hasn't sent yet, it has the same two versions in hand.

Either way, the status bar shows **Markdrop: conflict**, a comparison opens titled "Markdrop (web) ↔ Local" with the web version on the left and your file on the right, and VS Code asks:

> This document changed both on Markdrop and locally.

![An editor comparing "Markdrop (web) ↔ Local", with the web version on the left and the local file on the right, a dialog "This document changed both on Markdrop and locally." offering Keep my local version, Use the web version and Merge manually, and Markdrop: conflict in the status bar.](/docs-assets/vscode/conflicts/vscode-conflict-diff.webp)

## Choose what to keep

| Choice | What happens |
|---|---|
| **Keep my local version** | Your file replaces the web version. The web edits are overwritten on markdrop.in. |
| **Use the web version** | The web version replaces your file on disk. Your local edits are discarded. |
| **Merge manually** | Nothing is overwritten yet. Edit your file, using the comparison to bring in what you want from the web, then save. Your saved file becomes the new web version. |

:::warning[Keep my local version and Use the web version can't be undone from the extension]
Whichever side you don't keep is replaced. If you aren't sure, choose **Merge manually** and copy what you need from the left side of the comparison before you save.
:::

If you close the question without choosing, nothing changes. The conflict comes back the next time you save or the extension checks.

### Merge manually, step by step

::::steps
### Choose Merge manually
The extension notes that you have seen the web version and says "Edit to merge using the diff, then save to push your merged version."

### Edit your file
In the comparison, the right side is your file and you can edit it there. Copy in the web changes you want from the left side.

### Save
Your merged file is sent and becomes the web version. The status bar returns to **Markdrop: synced**.
::::

If someone changes the document on the web again before you save, you get a new conflict with their latest version.

## Avoid conflicts

- Save often while you work, so changes reach Markdrop quickly.
- Before a long edit of a file others also edit on the web, run **Markdrop: Sync now (push)** so you start from the latest web version.
- If you only ever want VS Code to send changes, turn off `markdrop.autoPull`. Web edits are then not pulled in, and you see the conflict when you next save. See [Settings](/vscode/settings).

## Other messages you may see

| Message | Meaning |
|---|---|
| "This document no longer exists on Markdrop — unlinked." | The document was deleted on markdrop.in, or isn't owned by the account you're signed in with. The local file is kept and stops syncing. |
| "Markdrop sync failed" | Markdrop refused the change: for example, the file is over 25 MB, or the document is end-to-end encrypted, which can't sync from VS Code. Changes sent on save fail quietly and the status bar stays on **Markdrop: unsynced**; run **Markdrop: Sync now (push)** to see the message. |
| "Session expired — sign in again." | The API token was revoked. Run **Markdrop: Sign in**. |
