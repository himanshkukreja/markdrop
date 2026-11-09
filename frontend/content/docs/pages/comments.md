---
title: Comments
description: Comment on any part of a page or document, reply, mention people, resolve threads and assign them as tasks.
updated: 2026-11-09
prerequisites: [/pages/overview]
keywords: [comments, comment, discussion, thread, reply, resolve, reopen, mention, assign, task, reactions, google docs comments, list_comments, add_comment, mcp]
---

Comment on selected text, a whole block, or the page as a whole. Everyone signed in who can open the page or
document can see the comments and add their own. The text of the page never changes because of a comment.

## Comment on something

- **Text.** Select a few words, a sentence or a few paragraphs, then choose the **Comment** button that appears beside the selection, or press **⌘⌥M** (**Ctrl+Alt+M** on Windows and Linux). Write your comment and choose **Comment**, or press **⌘ Enter** (**Ctrl+Enter**).
- **A whole block.** Point at a paragraph, list item, heading or table row and choose the comment button in the right margin.
- **The page as a whole.** Open the comments panel and choose **Comment on the page**. Use it for feedback that isn't about one place, like a page's Discussion.

The commented text is highlighted for everyone who can see comments. Select a highlight to open its thread. Editors see the highlights in the editor too.

Comments work on pages and markdown documents. Files (PDFs, slides, sheets, videos, HTML) don't take comments yet. End-to-end encrypted documents never have comments, because Markdrop can't read their text, and neither do documents published without an account.

## Who can comment

| Who | Sees comments | Comments and replies | Resolves |
|---|---|---|---|
| Not signed in | Only if the owner turned on **Show comments publicly** | No. Selecting text offers **Sign in to comment** | No |
| Signed in and can open it (including a public link) | Yes | Yes | Their own threads, and threads assigned to them |
| Can edit it | Yes | Yes | Any thread |
| Owner | Yes | Yes | Any thread, and can turn comments off |

Your name and picture show with what you write, to everyone who can see the comments. Email addresses are never shown.

## The comments panel

Choose the comment button in the top bar to open the panel. It shows **Open**, **Resolved** and **Mine** (threads you started, replied to, were mentioned in or were assigned), sorted by where they are on the page or by recent activity.

- **On a wide screen** each thread sits in the right margin beside the text it's about, like in Google Docs. The panel opens by itself when there are open comments; close it and it stays closed.
- **On a narrower screen** the panel is a list on the right.
- **On a phone** it's a sheet at the bottom of the screen.

Comments update live: a new thread, a reply or a resolved thread shows up for everyone who has the page open, without reloading.

## Reply, mention, react

- **Reply** at the bottom of a thread. Replying to a resolved thread opens it again.
- **Mention someone** with `@` and their name. The list shows the people who can open the page; mentioning someone tells them. Type the email address of someone who can't open it yet and, if you can share the page, choose **Share with them** to give them access first.
- **React** with an emoji under any message.
- **Edit or delete** your own comments from **⋯** on the comment. The page's owner and workspace admins can delete anyone's comment. Deleting the first message of a thread keeps the replies, marked "This comment was deleted".
- Comments take light formatting: `**bold**`, `*italics*`, `` `code` `` and links.

## Resolve and reopen

Choose **✓ Resolve** on a thread when it's dealt with. It moves to **Resolved**, its highlight goes, and the history is kept: who resolved it and when. **Reopen** brings it back. The person who started a thread, its assignee and anyone who can edit the page can resolve it.

## When the text changes

Comments don't change the page: nothing is added to its Markdown, so exports, version history, VS Code sync and Google Docs stay exactly as written. Markdrop keeps track of where each comment points and follows the text as it moves. If someone rewrites a sentence slightly, the comment stays on it. If the text is removed, the thread stays and says **The text this was about was changed**, with the original words shown crossed out. Put the text back and the comment finds it again.

## Assign a thread

Choose the person icon on a thread to assign it to someone who can open the page. It becomes a task:

- it shows in their home under **Your action items** (tick it to resolve the thread) and under **Today** as waiting on them,
- it shows on the **Team** page beside their name,
- and they get a notification.

Resolving the thread completes the task.

## Notifications

Markdrop tells you, under the bell, when:

- someone **mentions** you in a comment,
- someone **replies** in a thread you're in (you started it, replied, were mentioned or are assigned),
- someone **comments** on a page you own,
- your comment is **resolved**,
- a thread is **assigned** to you.

Several replies to the same thread while you haven't looked yet gather into one notification. Nobody is told about comments on a page they can't open.

## Turn comments off, or show them publicly

Comments are on for every page and markdown document with an owner. To change that, open **Share**:

- **Comments** turns them off for that item. The threads are kept, hidden, and come back when you turn them on again.
- **Show comments publicly** lets readers who aren't signed in see the comments (they still can't write). Off by default.

A workspace admin can turn comments off for the whole workspace in **Workspace settings › Advanced › Comments**.

## From an AI app

Your AI assistant can read and write comments through [MCP](/ai/tools#comments): `list_comments`, `get_thread`, `add_comment` (on quoted text, a block, or the page), `reply_comment`, `resolve_comment`, `reopen_comment`, `assign_thread`, `react_comment` and `set_comment_settings`. It acts as you, with your access.
