---
title: Suggested edits and AI help
description: Suggest the exact words a passage should say, accept them in one click, and let AI draft an edit, summarize a discussion, answer in a thread or check your tone.
updated: 2026-11-09
prerequisites: [/collaboration/comments]
keywords: [suggested edits, suggestion, suggest, accept, reject, withdraw, out of date, apply with ai, ai draft, summarize discussion, summary, decided, still open, waiting on, ask markdrop ai, at ai, @ai, tone check, before you post, rewrite, version history, suggest_edit, accept_suggestion, reject_suggestion, withdraw_suggestion, summarize_discussion]
---

A comment says what's wrong; a suggested edit says what the text should be. Anyone who can comment can suggest the words, and anyone who can edit the page accepts them in one click. AI can draft the edit from the discussion, sum up a long discussion, answer a question in a thread and help you keep comments kind.

## Suggest an edit

On a comment about selected text, choose **Suggest an edit** (the pencil on the thread, or in the composer when you start the comment), write the replacement and choose **Suggest**. The thread shows the quoted text struck through and your words beside it. The page itself doesn't change yet.

![A suggested edit on Sam's thread: “three waves: our own team first, then 10% of customers, then everyone” struck through, “two waves: our own team first, then everyone” beside it, Suggested by Sam Lee, with Accept and Reject. Alex has replied asking Riya to accept it.](/docs-assets/collaboration/suggested-edits/suggestion.webp)

Each thread holds one open suggestion at a time: you can **Edit** or **Withdraw** your own, and an open suggestion by someone else stays until it's decided.

## Accept or reject

People who can edit the page decide:

- **Accept** puts the suggested words into the page in place of the quoted text, saves it as its own version in the page's [version history](/pages/history) (the entry says who accepted it and links back to the thread), and resolves the thread.
- **Reject** keeps the page as it is. The suggestion stays in the thread, marked as not used.

::clip{src="/docs-assets/collaboration/suggested-edits/suggest-accept" alt="Riya points at Sam's suggested edit in the comments panel and chooses Accept. The page now reads “Rollout happens in two waves: our own team first, then everyone”, the thread is resolved and a toast says Applied to the page."}

Pages are edited by one person at a time. If someone else is editing the page when you accept, the suggestion waits for them: their comments panel shows it with **Apply**, and applying it updates the page they have open. If they're typing at that moment, their unsaved text is merged with it, as with any newer version.

A suggestion can't be accepted when the text it replaces has changed since (it's marked **Out of date**: suggest it again on the current text), or when it crosses formatting that a one-click edit would break, such as half of a bold phrase or a link. In that case choose **Copy** and edit the page by hand.

## AI help

AI helps with a discussion in four ways. Each one is optional and works within fair-use limits; when a limit is reached, everything else about comments keeps working. AI isn't available to people who aren't signed in, and workspace admins can turn AI off for a workspace.

### Apply with AI

On a thread about selected text, **Apply with AI** drafts the replacement the discussion asks for. You see the draft in the suggestion editor, change it if you want, and choose **Suggest**. Nothing reaches the page until an editor accepts it. **Draft again** asks for another version.

::clip{src="/docs-assets/collaboration/suggested-edits/apply-ai" alt="Alex's thread asks to make “two days before the next one starts” say “three days, so support can catch up”. Riya chooses Apply with AI; the suggestion editor fills with “three days, so support can catch up”, she chooses Suggest, and the thread now shows the suggested edit marked AI draft."}

### Summarize discussion

**Summarize discussion**, in the comments panel's **⋯** menu, lists what was decided, what's still open and who the discussion is waiting on, across the open threads and those resolved in the last 30 days. Each line links to its thread. The summary is kept until the discussion changes, so opening it again is instant; **Summarize again** asks for a fresh one.

![The Discussion summary: 4 open, 0 resolved in the last 30 days. Decided: launch moves to Tuesday after QA signs off; Apple Pay ships in the second wave. Still open: whether EU customers wait for the cookie banner. Waiting on: Riya Sharma, to accept Alex's wording for the rollout plan. Each line has an open thread link.](/docs-assets/collaboration/suggested-edits/summary.webp)

::clip{src="/docs-assets/collaboration/suggested-edits/summarize" alt="Riya opens the comments panel's More menu, chooses Summarize discussion, and the summary appears with Decided, Still open and Waiting on."}

### @AI in a thread

Write `@AI` and a question in a comment, or choose **Ask Markdrop AI** on a thread, and Markdrop AI answers in the thread for everyone in it to see. It reads the page, the thread and, when they are open to everyone who can see the thread, other pages of the same workspace, and it links what it used.

Because an @AI answer is shared with everyone in the thread, it only uses what all of them can read: never your private pages, other people's pages that aren't shared as widely as this one, or anything about you.

### Tone check

If a comment you're about to post reads as harsh (all capitals, "!!!", insulting words), you're offered a clearer, kinder rewrite before it's posted. You can post the rewrite, post what you wrote, or keep editing. Choose the sparkle in the composer to check any comment on purpose.

![Before you post: “This might read as: harsh wording.” A suggested rewrite you can edit, “Could we take another look at this part?”, what you wrote, “NO. This was agreed weeks ago!!!”, and Keep editing, Post as written and Post the rewrite.](/docs-assets/collaboration/suggested-edits/tone-check.webp)

See [AI and your data](/security/ai-and-your-data) for how AI handles what you send.

## From an AI app

`suggest_edit` suggests an edit (on an existing thread, or a new one on the exact text to replace), `accept_suggestion` accepts one, `reject_suggestion` turns one down and `withdraw_suggestion` takes back your own, under the same rules as the website. `summarize_discussion` returns the summary. See [For AI apps](/collaboration/for-ai-apps).
