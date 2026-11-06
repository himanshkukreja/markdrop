---
title: Slack
description: Post meeting notes with Done buttons to a channel, search and ask Markdrop from Slack, preview links, and turn on Slack notifications for mentions and requests.
updated: 2026-11-06
keywords: [slack, slack app, integration, integrations tab, add to slack, not set up yet, connected, meetings channel, channel picker, don't post meetings, post new meetings automatically, post to slack, private channel, /invite @markdrop, /markdrop, slash command, /markdrop link, /markdrop unlink, /markdrop help, search, ask, ai answers, meeting notes, action items, done button, unfurl, link preview, direct messages, notifications, slack notifications, get notifications in slack, turn on, turn off, off by default, opt in, found by email, users:read.email, update permissions, update markdrop for slack, look again, mentions, sign-off, access requests, approve, decline, slack connect, disconnect slack, slack_status, post_meeting_to_slack]
---

Markdrop for Slack connects one Slack workspace to one Markdrop workspace. It does four things:

- **Meeting notes in a channel.** When a meeting's summary is ready, its decisions and action items are posted to the channel you choose. Each action item has a **Done** button that ticks it on the Markdrop page.
- **`/markdrop search` and `/markdrop ask`.** Find documents, pages and files, or get an answer with sources. Only you see the reply, and it uses only what you can open in Markdrop.
- **Link previews.** Markdrop links show a preview when everyone in the channel may open them.
- **Slack notifications**: direct messages for mentions, sign-off requests, shares and access requests, for people who turn them on. You can approve or decline an access request, or sign off, right in Slack.

## Connect a Slack workspace

Slack is set up from the Markdrop workspace's settings: open **Workspace settings** and choose the **Integrations** tab. The **Slack** card there shows one of three states:

| The card shows | What it means |
| --- | --- |
| **Not set up yet**, and "Markdrop for Slack isn't switched on for this server yet." | Slack isn't available on this Markdrop server, so there's nothing to connect. Nothing is wrong with your workspace. |
| **Add to Slack** | Slack is available, and this workspace isn't connected. |
| **Connected** | The Slack workspace, who connected it and when, how many people linked their Slack account, and the **Meetings channel**. |

Only workspace **admins** and the **owner** connect Slack, choose the channel and disconnect it. Everyone else in the workspace sees the same card, read-only: its buttons and the channel picker show "Admins only". In Slack, you also need to be allowed to add apps to the Slack workspace.

To connect:

1. On the **Integrations** tab, select **Add to Slack**.
2. Pick the Slack workspace in Slack, and select **Allow**. You come back to the **Integrations** tab, and the card says **Connected**.
3. Choose the **Meetings channel** (see the next section).

Your own Slack account is linked as part of this. Everyone else links theirs once (see [Link your Slack account](#link-your-slack-account)).

A Slack workspace can be connected to only one Markdrop workspace at a time. To move it, **Disconnect Slack…** in the first workspace, then add it in the other.

![The Slack card in Workspace settings › Integrations before Markdrop for Slack is switched on for the server: Not set up yet.](/docs-assets/integrations/slack/card-not-set-up.webp)

### Choose the meetings channel

The **Meetings channel** list has the Slack workspace's public channels, marked `#`, and the private channels Markdrop was invited to, marked with a lock. A channel shared with another organization (Slack Connect) says **(shared with another organization)**. For a private channel, first type `/invite @Markdrop` in it, then reload the settings.

- Pick a channel and Markdrop says "Meeting notes go to that channel now."
- **Don't post meetings** stops posting meeting notes. Search, link previews and direct messages keep working.
- **Post new meetings automatically** appears once a channel is chosen, and is on. Turn it off to post meetings only by hand, with **Post to Slack** (see [Meeting notes and Done](#meeting-notes-and-done)).

If the card says **Slack's connection broke** (someone removed the app's access in Slack, for example), select **Disconnect Slack…**, then **Add to Slack** again.

If the card says **Update Markdrop for Slack**, the workspace was connected before Markdrop could find people in Slack by their email, which needs two more Slack permissions. An admin selects **Update permissions**, and Slack asks to allow them. Nothing else changes: the channel, the links and the settings stay. Until then, people [link their Slack account](#link-your-slack-account) to get [Slack notifications](#slack-notifications). Updating also finds everyone who had already turned them on.

![The Slack card when connected: the Slack workspace, who connected it and when, how many people linked their account, the Meetings channel picker set to #meetings, Post new meetings automatically, and Disconnect Slack.](/docs-assets/integrations/slack/card-connected.webp)

## Link your Slack account

Markdrop answers you in Slack as your Markdrop account, so it needs to know who you are there. Link once, either way:

- In Markdrop: **Workspace settings** › **Integrations** › **Your Slack account** › **Link my Slack account**. This card appears once the workspace is connected to Slack.
- In Slack: type `/markdrop link` and select **Link my Markdrop account**. A **Link your Slack account** page opens on markdrop.in; select **Continue with Slack**.

Slack then asks you to confirm who you are (Sign in with Slack). Markdrop keeps no Slack password or token for you. Once linked, the card says **Linked as** your Slack name. To undo it, select **Unlink** in the same place, or type `/markdrop unlink`.

Until you link, `/markdrop` answers with a **Link my Markdrop account** button instead of results, and so do **Done**, **Approve** and sign-off buttons.

You don't need to link for [Slack notifications](#slack-notifications): turning them on finds you by your email. Being linked doesn't turn them on either.

## Meeting notes and Done

When a meeting is imported and its AI summary is ready, Markdrop posts it to the meetings channel. The post has:

- the meeting's name, linked to its page, and its date and time;
- **Summary**;
- **Decisions**;
- **Action items**, each with a **Done** button;
- **Open the meeting**.

An action item's owner is @mentioned when they've linked their Slack account. Otherwise their name is shown.

**Done** ticks the item on the meeting's page, as the person who clicked, and the post then shows it crossed out with "Done by" and their name. It works for anyone who can edit that page in Markdrop. If you haven't linked your account yet, Slack shows you a link button instead. If someone is editing the page right then, try again in a minute. An item ticked in Markdrop before the post went out shows as done already.

Which meetings are posted:

- Only meetings everyone in the channel may open. A meeting [restricted to its attendees](/workspaces/meetings-privacy#restricted-meetings) is never posted.
- In a channel shared with another organization (Slack Connect), only meetings anyone with the link can open.
- Each meeting is posted on its own once. Writing its summary again doesn't post it again.
- Past meetings brought in quietly aren't posted on their own, so a backlog doesn't flood the channel. That's [Import past meetings](/workspaces/meetings-import#import-past-meetings) with **Don't post to Slack** on (the default), the past days that [Connect Google Meet](/workspaces/meetings-auto-import#past-meetings) brings in, and any meeting held more than a day before it was imported.

![Illustration of a meeting post in the #meetings channel: the meeting's title and date, its summary and decisions, the action items with the people mentioned and a Done button each, one already done by Sam Lee, and Open the meeting.](/docs-assets/integrations/slack/illustration-meeting-post.webp)

### Post a meeting by hand

To post a meeting again, a past one, or any meeting when **Post new meetings automatically** is off: open the meeting's page, select **Meeting** at the bottom right, then **Post to Slack**. Markdrop says "Posted to #channel in Slack." The button shows for people who can edit the meeting's page, once the workspace has a meetings channel, and not on a restricted meeting.

If it can't post, it says why: for example, "Invite @Markdrop to the meetings channel first (/invite @Markdrop)." when the app isn't in a private channel, or that the channel is archived or gone.

## Search and ask from Slack

| Type | What you get |
| --- | --- |
| `/markdrop search onboarding` | Up to 8 documents, pages, files and folders you can open that match, each with a line of its text, and **See all in Markdrop** |
| `/markdrop ask how do contractors get a laptop?` | An answer with numbered sources |
| `/markdrop meetings what did we decide about pricing?` | An answer from your workspace's meetings |
| `/markdrop link`, `/markdrop unlink` | Link or unlink your Slack account |
| `/markdrop help`, or `/markdrop` on its own | What it can do, and whether you're linked |

Every reply is visible **only to you**, even in a busy channel. Answers use only what your Markdrop account can open, the same as [search](/workspaces/search) in the app. Words without a command search, and a question asks.

When you're a member of the Markdrop workspace this Slack is connected to, search and answers look in that workspace. Otherwise they look in everything you can open. `/markdrop meetings` needs you to be a member of that workspace.

An answer quotes your question, then the answer with its **Sources** as links, and "Only you can see this answer. Markdrop AI can make mistakes; check the sources." Answers are written by Markdrop AI and count towards the same limits as [AI search](/workspaces/search#ask-ai) and [Meetings AI](/workspaces/meetings-privacy). An answer is never blank: when nothing you can open answers the question, it says so. A workspace with AI features off gets search but no answers.

If Slack isn't connected to a Markdrop workspace, `/markdrop` says so and that a workspace admin can connect it in **Workspace settings › Integrations › Slack**.

![Illustration of the reply to /markdrop search onboarding, only visible to you: three results with their kind, workspace and a line of text, and See all in Markdrop.](/docs-assets/integrations/slack/illustration-search.webp)

![Illustration of the reply to /markdrop ask: the question, the answer with numbered markers, the sources as links, and a note that only you can see it.](/docs-assets/integrations/slack/illustration-ask.webp)

![Illustration of the reply to /markdrop meetings: when the onboarding checklist ships, answered from the Weekly product sync with a link to the moment.](/docs-assets/integrations/slack/illustration-meetings-ask.webp)

## Link previews

Paste a markdrop.in link into Slack and Markdrop adds a preview with its title, a few lines, its kind, its workspace and when it was last updated. Links to a [shared folder](/workspaces/share-a-folder) get a preview with the folder's name. Links on a workspace's [own domain](/workspaces/custom-domain), like docs.acme.com, don't get a preview from Markdrop. The whole channel sees a preview, so Markdrop shows one only when everyone there may open the item:

- anything anyone with the link can open (no password, and the workspace doesn't require sign-in); or
- your workspace's own items, in a channel that isn't shared with another organization.

For anything else, the preview just says **Markdrop link — sign in to view**, without the title, and "Only people who can open it in Markdrop see what's behind this link." Password-protected and private items always get that. While you're still typing a message, before it's sent, Markdrop treats the channel as shared, so the preview there is the strict one.

![Illustration of link previews under a message: a markdrop.in page shows its title, a line of text, its kind, workspace and last update; a link the channel may not open shows only Markdrop link — sign in to view.](/docs-assets/integrations/slack/illustration-unfurl.webp)

## Slack notifications

Markdrop can send you a direct message in Slack, from the Markdrop app, when:

- someone **mentions** you on a page (**Mentions**), with the line you were mentioned in and **Open in Markdrop**. Mentions in [meeting notes](/workspaces/meetings#what-the-meeting-page-holds) don't send one;
- someone asks for your **sign-off** (**Sign-off requests**). Choose an option from the message;
- someone **shares** something with you (**Shared with you**), with what you can do with it and their note;
- someone asks to **open or edit** something you own (**Access requests**). Select **Approve** or **Decline**, or **Review in Markdrop**. When the item's owner can't approve it, the workspace's admins get the message, marked "You're getting this as a workspace admin".

After you choose, the message changes to say what you did, like "Approved by you: they can edit it now." If someone else answered first, Slack tells you.

### Turn them on

Slack notifications are **off** until you turn them on, even if your Slack account is linked. Only you can turn on your own.

1. Open **Settings** › **Account**. The **Slack notifications** card appears once a workspace you're in is connected to Slack.
2. Turn on **Get notifications in Slack**.

Markdrop looks you up in each Slack workspace connected to one of your Markdrop workspaces, by your Markdrop sign-in email. It looks up only your own email. Each Slack workspace then shows **Found**, with your Slack name, or **Not found**:

| It says | What to do |
| --- | --- |
| "No one in *Slack workspace* uses *your email*." | Your Slack account uses another email. Select **Link my Slack account** to sign in with Slack instead. |
| "Markdrop for Slack in *Slack workspace* needs an update…" | Ask a workspace admin to select **Update permissions** on the workspace's **Integrations** tab, or link your Slack account. |
| "Your Slack account in *Slack workspace* is linked to another Markdrop account." | Link it here with **Link my Slack account**, or type `/markdrop unlink` in Slack first. |

![The Slack notifications card in Settings › Account: Get notifications in Slack is on, Acme Slack shows Found as Ben in Slack (by your email), and Message me when lists Mentions, Sign-off requests, Shared with you and Access requests, all on.](/docs-assets/integrations/slack/notifications-card.webp)

**Look again** searches once more, for example after you change your email in Slack. The bell also offers them: when a mention or a sign-off request is in the list, a **Get these in Slack** row with **Turn on** may show at the top (not while the [push notification](/pages/mentions-and-notifications#push-notifications) row is showing). **Not now** hides it on that device.

If you linked your Slack account before Slack notifications were opt-in (November 2026), yours stay on until you turn them off.

### Choose which ones, or turn them off

Once they're on, turn each kind on or off under **Message me when** on the same card. All four start on. To stop them all, turn off **Get notifications in Slack**, or select **Turn off** at the bottom of any message (it opens that card). Your Slack account stays linked for `/markdrop`.

The bell doesn't change. A Slack message counts like a push notification for [email](/pages/mentions-and-notifications#the-app-comes-first): what reached you in Slack isn't emailed. Mentions and sign-off requests wait a minute before they go, so a mention [removed within a minute](/pages/mentions-and-notifications#take-a-mention-back) never reaches you. If you lose access to something, or the mention is taken out, before the message goes out, it isn't sent, and [end-to-end encrypted](/sharing/end-to-end-encryption) items never get one.

![Illustration of a direct message: Alex Chen mentioned you in Release notes 2.4, with the line and Open in Markdrop.](/docs-assets/integrations/slack/illustration-dm-mention.webp)

![Illustration of an access request direct message: Jordan Park asked to edit Q3 plan, with their message and Approve, Decline and Review in Markdrop; after Approve, the same message says Approved by you: they can edit it now.](/docs-assets/integrations/slack/illustration-dm-access-request.webp)

## Disconnect

An admin selects **Disconnect Slack…** on the **Integrations** tab. You can also remove the app in Slack. Either way, Markdrop forgets that Slack workspace and everyone's link to it. Messages already posted stay in Slack.

## What Markdrop keeps

- The Slack workspace's name and its app token. The token is encrypted.
- Who linked which Slack account, and how (found by email, or Sign in with Slack).
- The meetings channel.
- Each person's Slack notification choices: on or off, and which kinds.

It doesn't read your channels. It only sees messages that contain a markdrop.in link, and only the link itself.

## From an AI app

With the [hosted MCP server](/ai/hosted-mcp), an AI app can check a workspace's Slack connection with `slack_status` (connected or not, the meetings channel, whether new meetings are posted, whether your own account is linked, and whether your Slack notifications are on) and post a meeting with `post_meeting_to_slack`, with the same rules as **Post to Slack**. Connecting Slack, choosing the channel, linking your account and turning on Slack notifications stay on the website, because they go through Slack's own screens. See [MCP tools](/ai/tools).

## Related

- [Meetings](/workspaces/meetings)
- [Ask](/workspaces/ask-markdrop)
- [Members and roles](/workspaces/members-and-roles)
