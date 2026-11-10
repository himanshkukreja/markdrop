---
title: Comment notifications
description: Where you hear about comments (the bell, email, your phone and Slack), how email is batched, the daily digest, and how to turn each one off.
updated: 2026-11-09
nav: Notifications
prerequisites: [/collaboration/comments]
keywords: [comment notifications, notifications, bell, inbox, email, comment email, mentions, replies, batching, every 15 minutes, hourly bundle, daily digest, comments digest, push notifications, slack, slack dm, reply in slack, resolve in slack, turn off, unsubscribe, email me less, get_comment_notifications, set_comment_notifications]
---

Markdrop tells you about comments under the bell first. The same news can also reach you by email, as a push notification on your phone or computer, and in Slack. Each one opens the page with that thread selected. Nobody is told about comments on a page they can't open, and people who can no longer see a page's comments are never told about them.

## The bell

You're told, under the bell, when:

- someone **mentions** you in a comment,
- someone **replies** in a thread you're in (you started it, replied, were mentioned or are assigned),
- someone **comments** on a page you own,
- your comment is **resolved**,
- a thread is **assigned** to you.

Several replies to the same thread while you haven't looked yet gather into one notification. Notifications are kept for 90 days.

![The Notifications panel: Sam Lee commented on “Checkout redesign: launch plan”, quoting “Do we need screenshots for the mobile checkout too?”; Sam Lee mentioned you in a comment on “Pricing page refresh”; Alex Chen assigned you a comment; each with when it happened and an unread dot.](/docs-assets/collaboration/notifications/bell.webp)

## Email

Settings › Account › **Email** has two settings for comments:

| Setting | What it covers | Default |
| --- | --- | --- |
| **Comment mentions and assignments** | Someone @mentions you in a comment, or assigns you a thread. | **Instant**: one email per page, a few minutes after it happens |
| **Replies and new comments** | Replies in threads you started or joined, new comments on pages you own, your thread resolved. | **Every 15 minutes**: everything that came in, gathered into one email |

Each also offers **Hourly bundle**, **Daily digest** and **Off**.

![Settings › Account › Email: Comment mentions and assignments set to Instant, Replies and new comments set to Every 15 minutes, the calm-email note, and the Daily comments digest switch, on.](/docs-assets/collaboration/notifications/email-settings.webp)

Comment email follows the same [calm rules](/pages/mentions-and-notifications#email) as other notification email:

- **The app comes first.** Nothing you already saw in Markdrop, got as a push notification or got in Slack is emailed.
- **At most three notification emails a day.** The rest wait for one email the next morning.
- **Every email has Email me less** (one step quieter) and a link to turn these emails off.
- **It checks again just before sending.** If the mention was edited out, the thread was deleted, unassigned or reopened, or you can no longer see the comments on that page, nothing is sent.

## Daily comments digest

At 8:00 your time, one email lists the threads **waiting on you** (assigned to you, mentioning you in their newest message, or answered in a thread you started) and the **open threads on your pages**, with what's new since the day before. It only comes on days with something new.

## Push notifications

With [push notifications](/pages/mentions-and-notifications#push-notifications) on, comment mentions and assignments ring your phone or computer. Choose which in the push section of Settings › Account (**Mentions in comments**, **Comments assigned to you**).

## Slack

With [Slack notifications](/integrations/slack#slack-notifications) on, comment mentions and assignments arrive as a direct message from the Markdrop app, with the comment, the words it's about and two buttons:

- **Reply** opens a box in Slack. Your reply is posted to the thread as you, with the same rules as replying in Markdrop.
- **Resolve** resolves the thread, if you can (you started it, it's assigned to you, or you can edit the page).

When a thread is resolved anywhere, the Slack messages about it say who resolved it. Choose which you get under Settings › Account › **Slack notifications**.

### In a team's Slack channel

On a [team's](/teams/overview) pages, new comments and resolved threads are also posted to the team's Slack channel, with a link to the thread. Replies stay in Markdrop. A post goes out only when everyone the channel stands for can read the page's comments: the page is open to the workspace or to anyone with the link, has no password and has comments on. A channel shared with another company gets a post only for a public page that shows its comments publicly. Team leads turn this off with **Post new and resolved comments on the team's pages** in the team's settings. Your own direct messages don't change.

## Turn each one off

| What | Where |
| --- | --- |
| Comment mention and assignment email | Settings › Account › Email › **Comment mentions and assignments** › **Off** |
| Reply and new-comment email | Settings › Account › Email › **Replies and new comments** › **Off** |
| The daily digest | Settings › Account › Email › **Daily comments digest**, or the link at the bottom of the digest |
| Push | Settings › Account, push section › **Mentions in comments**, **Comments assigned to you** |
| Slack | Settings › Account › Slack notifications › the same two switches, or turn Slack notifications off |
| Everything about one page | Its owner can [turn comments off](/collaboration/settings-and-privacy#turn-comments-off) |

The bell always keeps a record; it isn't turned off.

From an AI app, `get_comment_notifications` and `set_comment_notifications` read and change these settings (Slack notifications themselves are turned on in the app). See [For AI apps](/collaboration/for-ai-apps).
