---
title: Comments
description: Comment on any part of a page or document, reply, mention people, resolve threads and assign them as tasks.
updated: 2026-11-09
prerequisites: [/pages/overview]
keywords: [comment email, comment notifications, comments digest, daily digest, slack reply, resolve in slack, comment insights, time to first reply, most discussed, export with comments, word, docx, footnotes, margin comments, comment_insights, comments, comment, discussion, thread, reply, resolve, reopen, mention, assign, task, reactions, google docs comments, list_comments, add_comment, mcp]
---

Comment on selected text, a whole block, or the page as a whole. Everyone signed in who can open the page or
document can see the comments and add their own. The text of the page never changes because of a comment.

<!-- A:core -->
(Track A writes this part.)
<!-- /A:core -->

<!-- B:suggestions -->
<!-- /B:suggestions -->

<!-- B:ai -->
<!-- /B:ai -->

<!-- B:attachments -->
<!-- /B:attachments -->

<!-- C:notifications -->
## Notifications

When someone mentions you in a comment, assigns a thread to you, replies in a thread you're part of, comments on a page you own or resolves your comment, it shows under the bell. Each notification opens the page with that thread selected. The same updates can also reach you by email, on your devices and in Slack, and the people who can't see a page's comments any more are never told about them.

### Email

Settings › Account › **Email** has two settings for comments:

| Setting | What it covers | Default |
| --- | --- | --- |
| **Comment mentions and assignments** | Someone @mentions you in a comment, or assigns you a thread. | **Instant**: one email per page, about a minute after it happens |
| **Replies and new comments** | Replies in threads you started or joined, new comments on pages you own, your thread resolved. | **Every 15 minutes**: everything that came in, gathered into one email |

Each also offers **Hourly bundle**, **Daily digest** and **Off**. They follow the same [calm rules](/pages/mentions-and-notifications#email) as other notification email: nothing you already saw in Markdrop, got as a push notification or in Slack is emailed; at most three notification emails a day, with the rest in one email the next morning; and every email has **Email me less** and a link to turn these emails off.

Just before an email goes, Markdrop checks again. If the mention was edited out, the thread was deleted, unassigned or reopened, or you can no longer see the comments on that page, nothing is sent.

### Daily comments digest

At 8:00 your time, one email lists the threads **waiting on you** (assigned to you, mentioning you in their newest message, or answered in a thread you started) and the **open threads on your pages**, with what's new since the day before. It only comes on days with something new. Turn it off under Settings › Account › **Email**, or with the link at the bottom of the digest.

### Push and Slack

With [push notifications](/pages/mentions-and-notifications#push-notifications) on, comment mentions and assignments ring your phone or computer. With [Slack notifications](/integrations/slack#slack-notifications) on, they arrive as a direct message from the Markdrop app with two buttons:

- **Reply** opens a box in Slack. Your reply is posted to the thread as you, with the same rules as replying in Markdrop.
- **Resolve** resolves the thread, if you can (you started it, or you can edit the page).

When a thread is resolved anywhere, the Slack messages about it say who resolved it. Choose which of these you get under Settings › Account, in the push and Slack sections (**Mentions in comments**, **Comments assigned to you**).
<!-- /C:notifications -->

<!-- C:analytics -->
## Insights

See how the discussion on a page is going: choose **Comment insights** from the **⋯** menu of the comments panel, or open the page's [analytics](/analytics/documents-and-pdfs) and its **Comments** tab.

- **Open threads**, how many are resolved and how many messages there are.
- **First reply**: the typical time from a new thread to the first answer from someone else (answers from Markdrop AI don't count), and how many open threads are still waiting for one.
- **Time to resolve**: the typical time from a thread's start to its resolve.
- **Most discussed**: the sections with the most threads. A thread belongs to the heading above the text it's on; a comment on the whole page counts as **Whole page**, and one whose text has since changed as **Text that changed**.
- **Activity** per day and the people who comment most (on the analytics page).

Everyone who can see a page's comments can see its insights. An AI app can read them with [`comment_insights`](/ai/tools#analytics), and `get_document_analytics` includes the counts.
<!-- /C:analytics -->

<!-- C:exports -->
## Export with comments

When you [export a page](/pages/export), turn on **Include comments** to take its threads with it. You can also choose **Export with comments…** in the comments panel's **⋯** menu.

| Format | Where the comments go |
| --- | --- |
| **Markdown** | A **Comments** section at the end: each thread numbered in page order, the words it's about, whether it's resolved, and every message with its author and date. |
| **Word** | **Margin comments**: real Word comments next to the words they're about (the title for a comment on the whole page). Or **Footnotes** after those words. |
| **PDF** | **Margin notes**: numbered notes beside the text. Or **Notes at the end**: a numbered list after the page. |

Turn on **Open threads only** to leave resolved ones out. A thread whose text changed since it was written is listed at the end, with the words it was first about. HTML exports never include comments.

Only people who can see a page's comments can export them: a reader who can't see them gets the page without comments. Deleted messages and threads never leave. An AI app can do the same with [`export_page`](/ai/tools#pages) (`comments`: `footnotes` or `margin`; `format`: `word` for a `.docx`).
<!-- /C:exports -->
