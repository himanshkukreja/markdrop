---
title: Assign, Home and sign-off
description: Turn a comment thread into someone's task, see the threads waiting on you on Home, and sign off knowing which discussions are still open.
updated: 2026-11-09
nav: Assign, Home and sign-off
prerequisites: [/collaboration/comments]
keywords: [assign, assignee, assign thread, task, action items, home, waiting on you, today, team page, sign-off, sign off anyway, open threads, open comments, approval, list_waiting_on_me, assign_thread]
---

A comment that needs someone to act shouldn't depend on them noticing it. Assign it, and it becomes their task until the thread is resolved. Home gathers everything waiting on you, and a sign-off tells the signer what's still being discussed.

## Assign a thread

Choose the person icon on a thread to assign it to someone who can open the page. It becomes a task:

- it shows on their Home under **Your action items** (tick it to resolve the thread) and under **Today** as waiting on them,
- it shows on the [Team page](/workspaces/team) beside their name,
- and they get a [notification](/collaboration/notifications).

Resolving the thread completes the task. Editors and the person who started a thread can assign it; choose **Remove assignee** to clear it.

![Maya's thread on the Risks paragraph about the billing webhooks, “Do we have a runbook for switching the webhooks back?”, with Assigned to Alex Chen under its quote.](/docs-assets/collaboration/assign-and-sign-off/assigned.webp)

To track it in Jira instead, choose **Create Jira issue** on the thread. See [Turn a thread into an issue](/collaboration/jira-in-pages#turn-a-comment-thread-into-an-issue).

## Waiting on you, on Home

Home's **Today** lists the comment threads waiting on you, newest first:

- threads **assigned** to you,
- threads whose newest message **mentions** you,
- threads you started that someone else has **answered**.

Each row shows the last message, why it's waiting on you and the page; select it to open the thread. **Your action items** lists the threads assigned to you, with a box to tick when it's done. A thread leaves both once it's resolved, or when you can no longer open its page.

![Home: Today lists Sam Lee asking @Riya Sharma about a tax footnote (mentions you), Alex Chen's question about monthly prices (assigned to you) and Alex's “can you accept this one?” (mentions you), each with its page and time. Your action items lists “Should monthly come first for new visitors?” on Pricing page refresh.](/docs-assets/collaboration/assign-and-sign-off/home.webp)

The [daily comments digest](/collaboration/notifications#daily-comments-digest) emails the same list at 8:00 your time, on days with something new. From an AI app, `list_waiting_on_me` returns it with links.

## Sign off with open threads

When comment threads are still open on a page and you [sign off](/pages/sign-off) on it, the sign-off block says how many first and asks you to confirm: **Sign off anyway**, or **Cancel** and resolve them.

![A sign-off block, Launch go-ahead, with Approved and Not approved. After choosing Approved it says “2 comment threads are still open on this page.” with Sign off anyway: Approved and Cancel.](/docs-assets/collaboration/assign-and-sign-off/signoff-guard.webp)

Every sign-off records the discussion as it stood: how many threads were resolved and how many were still open. The block shows it, and so does the [version history](/pages/history) entry. From an AI app, `sign_off` signs and says in its answer when threads were open.

## Accepted edits in the history

Accepting a [suggested edit](/collaboration/suggested-edits) saves the page as its own version. The version history entry says who accepted it and links back to the thread, so you can always see why a sentence changed.
