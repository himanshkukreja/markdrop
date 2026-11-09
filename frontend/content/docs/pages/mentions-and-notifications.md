---
title: Mentions and notifications
description: Mention someone and they're told under the bell, by email, on their devices and in Slack, with a link to the exact block. Only people who can open the page.
updated: 2026-11-06
prerequisites: [/pages/overview]
keywords: [mention, mentions, remove a mention, undo mention, mistaken mention, wrong person, take a mention back, withdrawn, meeting mentions, email me less, hourly bundle, daily digest, instant, email frequency, too many emails, catch-up, edit mode, mention someone, "@", at sign, people picker, mention in table, notify, notification, notifications, bell, inbox, email, unsubscribe, turn off, sign-off, signoff, share, notify people, at mention, push, push notifications, phone, desktop notifications, lock screen, devices, slack, slack notifications, slack direct message, get these in slack, list_notifications, mark_notifications_read, share_with_people]
---

When you mention someone on a page, Markdrop tells them. They see it under the bell at the top of Markdrop, get an email and, if they've turned them on, a notification on their phone or computer and a message in Slack. Each one opens the page at the block that mentions them.

## Mention someone

While you edit a page (choose **Edit** or press **E**), type `@` or `/person` (or choose **Mention a person** from the `/` menu). A list of the people in the page's workspace opens at your cursor, each with their picture, name and email address. Keep typing to narrow it: part of a name or an email address finds them, and so do letters in order, so `@bmem` finds Ben Member. Pick someone to put a mention of them in the page. The block you mention them in gets its own link, so their notification opens the page right there.

- **Keys.** ↑ and ↓ move through the list, **Enter** or **Tab** picks the person, and **Esc** closes the list and leaves what you typed as plain text. Deleting the `@` closes it too. You can also click a name.
- **When `@` opens the list.** At the start of a line, or after a space or punctuation, such as `(@ben`. Not in the middle of a word, so typing an email address like `ana@example.com` never opens it, and never in code, inline code, Mermaid diagrams or equations. Once nobody matches and you type a space, the list closes and your text stays as it is.
- **In tables.** `@` works in a table cell, and so does the `/` menu. A cell holds one line of text, so its `/` menu offers what fits in a line: **Mention a person**, **Mention an item**, **Date** and **Emoji**.
- **Who's listed.** Everyone in the page's workspace, including you. A page that isn't in a workspace has nobody to mention; move it into a workspace first. Someone editing with an edit link but no account, or who can edit the page but isn't in its workspace, can't mention people.
- **On a workspace's own domain** the list shows names and pictures, but not email addresses.

Everyone you newly mention is notified when the page saves. That includes mentions made by an AI app through [MCP](/ai/tools#notifications) and mentions that come back when you [restore a version](/pages/history). The notification names whoever made the change. Mentioned the wrong person? [Take it back](#take-a-mention-back).

Who isn't notified:

- **People who can't open the page.** A mention never tells anyone about a page they can't read. That includes a page behind a password they haven't been given.
- **You,** when you mention yourself.
- **The same person twice.** People already mentioned in the page before your change aren't notified again. Moving a mention, or removing it and putting it back within a day, doesn't notify them again either.
- **Anyone, from a visitor who isn't signed in.** Someone editing with an edit link but no account can't notify people.
- **Anyone, from meeting notes.** The @mentions Markdrop writes into a [meeting](/workspaces/meetings#what-the-meeting-page-holds), such as an action item's owner, stay links and notify nobody, however the meeting came in. They show on that person's home under **Your action items**. Mentioning someone yourself while you edit a meeting page notifies them as usual.

Mentions in code blocks and in classic-editor documents don't notify anyone. At most 50 people are notified by one save.

## Take a mention back

A mention you remove within a minute is never sent. Delete it (or swap it for the right person) and save, and the person you mentioned by mistake gets nothing: no email, no notification on their devices and no Slack message, and the bell entry is gone.

- **The bell.** Their notification leaves the bell as soon as the page saves without the mention, as long as they haven't read it yet. One they've already read stays.
- **Email, phone and Slack** wait at least a minute before they go, and are checked again just before sending: a mention that's no longer on the page sends nothing. An email or notification that already went can't be recalled.
- **Putting it back** the same day doesn't notify them again if something already reached them. If nothing did, they're told then.
- **Sign-off requests** work the same way: remove the sign-off block, or the person on it, and their request is taken back.

![Typing @ in a page while editing: the Mention someone list shows the workspace's members with their avatars and email addresses.](/docs-assets/pages/mentions-and-notifications/mention.webp)

## The bell

The bell sits at the top of Markdrop, next to your avatar. A badge shows how many notifications you haven't read.

Choose the bell to see them, newest first. **Notification settings** at the bottom of the list opens your email and device settings. Each one shows who did it, what they did, on which page, when, and a dot while it's unread. Choose one to open the page at that block, which is briefly highlighted. **All** and **Unread** switch the list, and **Mark all read** clears the badge. On a phone the list opens as a sheet from the bottom of the screen.

You're notified when someone:

- mentions you on a page;
- asks for your sign-off on a page;
- shares a page with you with **Notify people** ticked (see [Share with specific people](/sharing/share-with-people)).

Notifications are kept for 90 days. The bell isn't shown on a workspace's own domain.

:::note[If you lose access]
A notification about a page you can no longer open stays in the list without the page's title or a link. It says "a page you can't open", and choosing it does nothing. Markdrop checks again every time you open the list and every time you choose a notification, so nothing about the page shows once your access is gone.
:::

## Email

Markdrop can also email you when someone mentions you or asks for your sign-off, with the block quoted and a link to it. Email is the fallback, not a second copy: the app and your devices come first, and you choose how often email comes.

### Choose how often

Go to **Settings › Account › Email**. **Mentions** and **Sign-off requests** each have their own choice:

| Choice | What you get |
| --- | --- |
| **Instant** | One email per page, about a minute after it happens. Mentions on the same page arrive together, at most one email per page every 10 minutes. The default for sign-off requests. |
| **Hourly bundle** | At most one email an hour, listing everything new, such as "You were mentioned in 4 pages", with each page, who and the line. The default for mentions. |
| **Daily digest** | One email a day at 8:00 your time with everything from the day before. |
| **Off** | No email. You still see everything under the bell. |

Your time zone comes from your browser when you use Markdrop. Until Markdrop knows it, the daily digest goes at 8:00 UTC.

If you'd turned off the old **Email me when someone mentions me** switch, both choices start as **Off**.

Comments have two more choices here, **Comment mentions and assignments** and **Replies and new comments**, and a **Daily comments digest**. See [Comments: notifications](/pages/comments#email-push-and-slack).

### The app comes first

Markdrop doesn't email you about something you've already seen:

- **Read it in the app,** or had Markdrop open when it arrived (the bell's badge showed it), and there's no email.
- **Got it as a [push notification](#push-notifications)** on one of your devices, or as a [Slack message](#slack), and there's no email. Only a message that really reached you counts: with Slack notifications off, the email comes as usual.
- **You've been using Markdrop in the last half hour,** and an instant email waits up to 30 minutes for you to see it there (10 minutes for a sign-off request) before it goes.

### Never a flood

- **At most 3 a day.** You get at most 3 of these emails a day, counted in your time zone. Anything after that waits for one catch-up email at 8:00 the next morning. Nothing is lost, and it never comes as more than one catch-up email.
- **Sign-off requests stay prompt.** A sign-off request can be a fourth email, once a day, because email may be the only way it reaches you.
- **Only what's still true.** Before an email goes, Markdrop checks again that you can open each page. A page you can't open any more is left out, and so is a mention that was taken out of the page.
- **Shares** send their own email straight away, with the message the sender added.

### Email me less

Every one of these emails has an **Email me less** link at the bottom. It asks first, then moves the setting for what that email was about one step down, from **Instant** to **Hourly bundle**, to **Daily digest**, to **Off**. You don't need to sign in, and choosing the same link twice doesn't lower it twice.

To stop them altogether, choose **Turn off these emails** at the bottom of any of them, or set both choices to **Off** in **Settings › Account › Email**. You still see mentions under the bell, and [push notifications](#push-notifications) keep their own setting. Other Markdrop email, such as sign-in codes, invitations and the [weekly analytics email](/analytics/weekly-email), isn't affected.

## Push notifications

Turn on notifications for your phone, tablet or computer and Markdrop rings it even when Markdrop is closed. You get one when someone:

- mentions you on a page;
- asks for your sign-off;
- shares a page with you with **Notify people** ticked;
- asks to open or edit something you own or manage (an [access request](/sharing/request-access)).

Choose a notification to open the page at that block. If Markdrop is already open, that window goes there; otherwise a new one opens. The notification is marked read under the bell too.

### Turn them on

Markdrop offers it in two places, so it takes one tap:

- **On Home**: the card **Get notified when someone mentions you or needs your sign-off**. Choose **Turn on**.
- **Under the bell**: when someone has mentioned you or asked for your sign-off, the top of the list says **Get these on this device**. Choose **Turn on**.

![The Home card: Get notified when someone mentions you or needs your sign-off, with Turn on and Not now.](/docs-assets/pages/mentions-and-notifications/push-prompt.webp)

Then allow notifications when your browser asks. Browsers ask once per device and only after you choose **Turn on**, so Markdrop can't turn them on for you. Choose **Not now** to hide the offer on that device; Home and the bell each remember it separately. Neither offer appears once the device gets notifications, or while notifications are blocked for Markdrop in the browser.

You can also turn them on in settings:

1. Go to **Settings › Account › Notifications on your devices**. **Notification settings** at the bottom of the bell's list goes there too.
2. Choose **Turn on**, then allow notifications when your browser asks.
3. Choose **Send a test** to see how they look.

Do this on each device you want notified. They work in Chrome, Edge, Firefox and Safari on computers and Android phones.

:::note[Nothing shows up on a Mac?]
macOS has its own switch for each browser. Open **System Settings › Notifications**, choose your browser (for example **Google Chrome**) and turn on **Allow notifications**. Then choose **Send a test** again.
:::

:::note[iPhone and iPad]
On an iPhone or iPad, notifications work only in the installed app (iOS 16.4 or later). [Install Markdrop](/get-started/install-app), open it from your Home Screen, then turn notifications on in **Settings › Account** inside the app. In a Safari tab, the card shows **Install app** instead.
:::

### Choose what rings

Under **Notify me when**, turn off any of **Mentions**, **Sign-off requests**, **Shared with you** and **Access requests**. The choice covers all your devices. The bell and email aren't affected.

### Your devices

**Devices** lists every phone, tablet and computer that gets your notifications, such as "Chrome on Android" or "Safari on iPhone", with when it was last notified. Choose the bin next to one to stop notifications there. Signing out of Markdrop in a browser stops them on that device too, and a device that hasn't opened Markdrop for 90 days is removed by itself.

### What a notification says

- **Only what the bell says:** who did it, the page's title and the line that mentions you (or the sign-off's label, or the note on a share).
- **Only about pages you can still open.** Markdrop checks your access when it sends. If you've lost access by then, nothing is sent at all.
- **Not twice.** If you've already read it under the bell, no notification is sent. Mentions and sign-off requests wait a minute, so several on the same page in that time arrive as one, such as "You were mentioned 3 times in “Launch plan”", and one [taken back](#take-a-mention-back) in that minute never rings. Shares and access requests go within seconds. A newer notification about a page replaces the older one on your screen.
- **Private on the way.** Each notification is encrypted for your device, so the notification service that delivers it (Google, Apple, Mozilla or Microsoft, depending on your browser) can't read it.

To stop them on a device, choose **Turn off** under **This device**, or block notifications for markdrop.in in your browser's site settings.

## Slack

When a workspace you're in is connected to [Slack](/integrations/slack), the same notifications can come as direct messages from the Markdrop app in Slack: mentions, sign-off requests (choose an option right there), shares and access requests (**Approve** or **Decline**).

They're **off** until you turn them on: **Settings › Account › Slack notifications** › **Get notifications in Slack**. Markdrop finds you in Slack by your sign-in email, so there's nothing to link, and only you can turn yours on. The bell offers it too (**Get these in Slack**), but never at the same time as the push notification offer. Each message ends with **Turn off**. See [Slack notifications](/integrations/slack#slack-notifications) for what to do when Markdrop can't find you, and for choosing which kinds.

## From an AI app

AI apps connected through [MCP](/ai/hosted-mcp) can work with notifications too:

- Pages they write notify the people they newly mention, the same as your own edits, in your name.
- `list_notifications` reads your notifications, and `mark_notifications_read` marks them read.
- `share_with_people` shares a page with people by email and, unless told not to, notifies them.

See [MCP tools](/ai/tools#notifications).
