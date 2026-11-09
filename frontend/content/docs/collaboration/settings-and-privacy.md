---
title: Comment settings and privacy
description: Who can see and write comments, showing comments to readers who aren't signed in, turning comments off for an item or a workspace, and what stays private.
updated: 2026-11-09
nav: Settings and privacy
prerequisites: [/collaboration/comments]
keywords: [comment settings, comments privacy, who can comment, who can see comments, show comments publicly, public comments, turn off comments, disable comments, workspace comments setting, sign in to comment, anonymous readers, encrypted documents, end-to-end encryption, email addresses, account deletion, set_comment_settings]
---

## Who can see and write comments

| Who | Sees comments | Comments and replies | Resolves |
|---|---|---|---|
| Not signed in | Only if the owner turned on **Show comments publicly** | No. Selecting text offers **Sign in to comment** | No |
| Signed in and can open it (including a public link) | Yes | Yes | Their own threads, and threads assigned to them |
| Can edit it | Yes | Yes | Any thread, and accepts suggested edits |
| Owner | Yes | Yes | Any thread, and can turn comments off |

Your name and picture show with what you write, to everyone who can see the comments. Email addresses are never shown.

Readers who aren't signed in see a clean page: their browser doesn't even fetch the comments. Selecting text offers **Sign in to comment**.

![A reader who isn't signed in selects “three waves: our own team first” and the button beside the selection says Sign in to comment.](/docs-assets/collaboration/settings-and-privacy/sign-in-to-comment.webp)

## Turn comments off

Comments are on for every page and Markdown document with an owner. To change that for one item, open **Share**: **Comments** turns them off. The threads are kept, hidden, and come back when you turn them on again.

![In the Share dialog: the Comments switch, on (“Signed-in people who can open it can comment on any part of it”), and Show comments publicly, off (“Readers who aren't signed in see the comments too (they still can't write)”).](/docs-assets/collaboration/settings-and-privacy/share-switches.webp)

A workspace admin can turn comments off for the whole workspace in **Workspace settings › Advanced › Comments**. While it's off, nobody in the workspace sees or writes comments, and nobody is notified about them.

## Show comments publicly

**Show comments publicly**, also in **Share**, lets readers who aren't signed in see the comments. They still can't write. It's off by default, and only the owner can turn it on.

## What stays private

- **End-to-end encrypted documents never have comments.** Markdrop can't read their text, so it can't anchor a comment to it. The same goes for documents published without an account.
- **Notifications follow access.** Nobody is told about comments on a page they can't open, and an email or Slack message about a thread is checked again just before it goes.
- **Files in comments follow the page's access**, and only people who can see the comments get links to them. See [Images and files](/collaboration/comments#images-and-files).
- **AI answers in a thread** only use what everyone in the thread can read. See [Suggested edits and AI help](/collaboration/suggested-edits#ai-in-a-thread).
- **Jira details** are only shown to signed-in people whose own Jira can open the issue. See [Who sees what](/collaboration/jira-in-pages#who-sees-what).
- **Deleting your account** keeps your comments in their threads, without your name.

From an AI app, the owner's switches are `set_comment_settings` (`enabled`, `public`).
