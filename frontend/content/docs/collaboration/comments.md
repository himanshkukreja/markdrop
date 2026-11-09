---
title: Comments
description: Comment on selected text, a block or a whole page or document. Reply, mention people, react, and resolve threads, live for everyone reading.
updated: 2026-11-09
prerequisites: [/collaboration/overview]
keywords: [comments, comment, discussion, thread, reply, resolve, reopen, mention, at mention, reactions, emoji, edit comment, delete comment, google docs comments, highlight, margin, comments panel, bottom sheet, phone, live, real time, text was changed, lost anchor, keyboard shortcut, cmd option m, block comment, page comment, list_comments, add_comment, reply_comment]
---

Comment on selected text, a whole block, or the page as a whole. Everyone signed in who can open the page or document can see the comments and add their own. The text of the page never changes because of a comment.

::clip{src="/docs-assets/collaboration/comments/comment-flow" alt="Riya drags across “two days before the next one starts”, chooses Comment, types “Is two days enough? @Alex Chen” and posts it. Alex's reply appears in the thread without a reload, and Riya resolves the thread."}

## Comment on something

- **Text.** Select a few words, a sentence or a few paragraphs, then choose the **Comment** button that appears beside the selection, or press :kbd[⌘⌥M] (:kbd[Ctrl+Alt+M] on Windows and Linux). Write your comment and choose **Comment**, or press :kbd[⌘ Enter] (:kbd[Ctrl+Enter]).
- **A whole block.** Point at a paragraph, list item, heading or table row and choose the comment button in the right margin. While you edit a page, the block's **⋮⋮** menu has **Comment** too.
- **The page as a whole.** Open the comments panel and choose **Comment on the page**. Use it for feedback that isn't about one place.

The commented text is highlighted for everyone who can see comments. Select a highlight to open its thread. Editors see the highlights in the editor too.

## The comments panel

Choose the comment button in the top bar to open the panel. It shows **Open**, **Resolved** and **Mine** (threads you started, replied to, were mentioned in or were assigned), sorted by where they are on the page or by recent activity.

![A thread on “once QA signs off on the payment flows”: Alex asks @Riya Sharma who signs off, Riya answers that Sam owns QA sign-off and mentions @Sam Lee, with a thumbs-up reaction, and Sam confirms Monday works. The thread's tools are along the top: assign, suggest an edit, AI, Jira, link and resolve.](/docs-assets/collaboration/comments/thread.webp)

- **On a wide screen** each thread sits in the right margin beside the text it's about. The panel opens by itself when there are open comments; close it and it stays closed.
- **On a narrower screen** the panel is a list on the right.
- **On a phone** it's a sheet that slides up from the bottom of the screen. Tap the comment button in the top bar; tap a thread to jump to its text.

::::tabs
:::tab[Phone]
::clip{src="/docs-assets/collaboration/comments/phone-sheet-clip" alt="On a phone, tapping the comment button slides the comments sheet up over the page; tapping Sam's thread with a suggested edit opens it."}
:::
:::tab[Screenshot]
![The comments sheet on a phone: Open 4, Resolved and Mine, Comment on the page, Riya's page comment and Alex's thread on “once QA signs off on the payment flows”.](/docs-assets/collaboration/comments/phone-sheet.webp)
:::
::::

## Live for everyone reading

Comments update live. A new thread, a reply, a reaction or a resolved thread shows up for everyone who has the page open, without reloading. The faces in the top bar are the people reading it with you.

::clip{src="/docs-assets/collaboration/comments/live" alt="Riya has the launch plan open and Alex's face is in the top bar. Alex's comment on “three waves” appears and the comment count goes to 1. Riya opens it and replies; Alex's answer arrives a moment later."}

## Reply, mention, react

- **Reply** at the bottom of a thread. Replying to a resolved thread opens it again.
- **Mention someone** with `@` and their name. The list shows the people who can open the page; mentioning someone tells them. Type the email address of someone who can't open it yet and, if you can share the page, choose **Share with them** to give them access first.
- **React** with an emoji under any message.
- **Edit or delete** your own comments from **⋯** on the comment. The page's owner and workspace admins can delete anyone's comment. Deleting the first message of a thread keeps the replies, marked "This comment was deleted".
- **Attach images and files** with **Attach a file** in the composer, or paste a screenshot. See [Images and files](#images-and-files).
- Comments take light formatting: `**bold**`, `*italics*`, `` `code` `` and links.

## Resolve and reopen

Choose **✓ Resolve** on a thread when it's dealt with. It moves to **Resolved**, its highlight goes, and the history is kept: who resolved it and when. **Reopen** brings it back. The person who started a thread, its assignee and anyone who can edit the page can resolve it.

## When the text changes

Comments don't change the page: nothing is added to its Markdown, so exports, version history, VS Code sync and Google Docs stay exactly as written. Markdrop keeps track of where each comment points and follows the text as it moves. If someone rewrites a sentence slightly, the comment stays on it. If the text is removed, the thread stays and says **The text this was about was changed**, with the original words shown crossed out. Put the text back and the comment finds it again.

## Images and files

Add images and files to a comment with **Attach a file** in the composer, or paste a screenshot into the comment. Comments take PNG, JPEG, GIF and WebP images, PDFs, Word, Excel and PowerPoint files, zip archives and text files (txt, csv, md, json), up to 10 MB each and 10 per comment.

Files in comments follow the page's access, like the images in the page itself, with one more rule: only people who can see the comments get a link to them. Links are personal and expire, and when the page's access is narrowed the old links stop working. Deleting a comment removes its files. Files count towards the page owner's storage.

## Keyboard

| Keys | Does |
| --- | --- |
| :kbd[⌘⌥M] / :kbd[Ctrl+Alt+M] | Comment on the selected text |
| :kbd[⌘ Enter] / :kbd[Ctrl+Enter] | Post the comment or reply |
| :kbd[Esc] | Close the composer or the panel |

## Next

- [Suggested edits and AI help](/collaboration/suggested-edits): propose the words instead of describing them.
- [Assign, Home and sign-off](/collaboration/assign-and-sign-off): turn a thread into someone's task.
- [Who can see and write comments](/collaboration/settings-and-privacy).
