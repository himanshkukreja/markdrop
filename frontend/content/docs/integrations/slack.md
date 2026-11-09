---
title: Slack
description: Meeting notes with Done buttons in a channel, each person's own action items after a meeting, search and ask from Slack, link previews, and Slack notifications.
updated: 2026-11-07
keywords: [slack, slack app, integration, integrations tab, add to slack, not set up yet, connected, meetings channel, channel picker, don't post meetings, post new meetings automatically, post to slack, private channel, /invite @markdrop, /markdrop, slash command, /markdrop link, /markdrop unlink, /markdrop help, search, ask, ai answers, meeting notes, action items, done button, unfurl, link preview, direct messages, notifications, slack notifications, get notifications in slack, turn on, turn off, off by default, opt in, found by email, users:read.email, update permissions, update markdrop for slack, look again, mentions, sign-off, access requests, approve, decline, slack connect, disconnect slack, slack_status, post_meeting_to_slack, action items after meetings, your action items, direct message, stop these, turn back on, send each person their action items, daily syncup, not in markdrop, ask for access]
---

Markdrop for Slack connects one Slack workspace to one Markdrop workspace. It does five things:

- **Meeting notes in a channel.** When a meeting's summary is ready, its decisions and action items are posted to the channel you choose. Each action item has a **Done** button that ticks it on the Markdrop page.
- **Your action items, to you.** After each meeting, everyone in it with an action item (attendees, people on the invite and the organizer) gets a direct message with only their own, whether or not they're in Markdrop.
- **Team's weekly summary.** When your workspace uses [Team](/workspaces/team), last week's highlights and this week's due items are posted to the meetings channel every Monday at 9 am.
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

- the meeting's name, then one line with its date and time, how long it took, who was there ("6 people: Maya, Alex, Sam +3") and **Open notes**;
- **Summary**: its first few sentences, with **Read the full notes** when there's more;
- **Decisions** (up to five, then "+2 more in the notes") and **Open questions**;
- **Action items**: how many are open and done, then one row per item with its owner, the task and its due date ("due Tue, Nov 11"), and a **Done** button. Someone with three or more items gets them under their name. Up to eight rows, then "+3 more in the notes";
- **Open notes**, and a line saying that meetings restricted to their attendees are never posted.

An action item's owner is @mentioned when they've linked their Slack account. Otherwise their name is shown in bold. The message's notification reads like "Daily Syncup · Nov 7: 3 decisions, 6 action items".

**Done** ticks the item on the meeting's page, as the person who clicked, and the post then shows it crossed out with "done by" and their name. It works for anyone who can edit that page in Markdrop. If you haven't linked your account yet, Slack shows you a link button instead. If someone is editing the page right then, try again in a minute. An item ticked in Markdrop before the post went out shows as done already.

Which meetings are posted:

- Only meetings everyone in the channel may open. A meeting [restricted to its attendees](/workspaces/meetings-privacy#restricted-meetings) is never posted.
- In a channel shared with another organization (Slack Connect), only meetings anyone with the link can open.
- Each meeting is posted on its own once. Writing its summary again doesn't post it again.
- Past meetings brought in quietly aren't posted on their own, so a backlog doesn't flood the channel. That's [Import past meetings](/workspaces/meetings-import#import-past-meetings) with **Don't post to Slack** on (the default), the past days that [Connect Google Meet](/workspaces/meetings-auto-import#past-meetings) brings in, and any meeting held more than a day before it was imported.

![Illustration of a meeting post in the #meetings channel: the meeting's name, a line with its date, length, people and Open notes, a short summary, decisions and an open question, then the action items with their owner, task, due date and a Done button each, one already done by Sam Lee, and Open notes.](/docs-assets/integrations/slack/illustration-meeting-post.webp)

### Team's weekly summary

When the workspace has [Team memory](/workspaces/team) on, Team's weekly summary is posted to the same meetings channel every Monday at 9 am in the workspace's timezone, as "Week of Nov 9 in Acme": a line with the day and its counts; **Last week (Nov 2 – 8)** with last week's highlights (one person's together, each with a link to its meeting or page), its decisions and meetings; then **Due this week (Nov 9 – 15)** with the day, **Overdue** with how late, and **Blocked right now** with whom they wait on. It only uses meetings and pages everyone in the workspace can open, so a restricted meeting never shows. A week with nothing in it isn't posted. Admins can send it right away with **Send now** on Team's **This week** card. See [The weekly summary](/workspaces/team#the-weekly-summary).

![Illustration of Team's weekly summary in the #meetings channel: Week of Nov 9 in Acme with the day and its counts, Last week (Nov 2 – 8) with each person's highlight and a link to the meeting, Meetings last week, then Due this week (Nov 9 – 15) with the day, Overdue with how late, Blocked right now with who they wait on, and Open Team.](/docs-assets/integrations/slack/illustration-team-weekly.webp)

### Post a meeting by hand

To post a meeting again, a past one, or any meeting when **Post new meetings automatically** is off: open the meeting's page, select **Meeting** at the bottom right, then **Post to Slack**. Markdrop says "Posted to #channel in Slack." The button shows for people who can edit the meeting's page, once the workspace has a meetings channel, and not on a restricted meeting.

If it can't post, it says why: for example, "Invite @Markdrop to the meetings channel first (/invite @Markdrop)." when the app isn't in a private channel, or that the channel is archived or gone.

## Your action items after each meeting

When a meeting's summary is ready, everyone in the meeting with an open action item (its attendees, the people on the invite and the organizer) gets one direct message from the Markdrop app: "Your action items from **Daily Syncup** · Nov 6", then their items as a checklist, each with its due date when the meeting gave one ("by Friday" is shown as the date it means). It goes to people who aren't members of your Markdrop workspace too, so a team where only a few people use Markdrop still gets everyone's to-dos to them. It's on for everyone who was in the meeting; nobody has to turn it on.

What each person sees depends on whether Markdrop knows their Markdrop account and what it can open:

| They are | Their message has |
| --- | --- |
| A member who can edit the meeting's page | Their items, a **Done** button on each, and **Open the notes** |
| A member who can only view it | Their items and **Open the notes** |
| Anyone else | Their items and "Notes are in Markdrop (ask *the organizer* for access)": no link and nothing else from the meeting |

**Done** ticks the item on the meeting's page as that person, the same as **Done** in the meetings channel (which then shows it done too). Only the person the message was sent to can use its buttons, and they don't need to link their Slack account first.

![Illustration of two action-items messages: a member's, with two items due next Wednesday and Thursday, a Done button on each, Open the notes, and Sent after each meeting with Stop these; and the message someone outside Markdrop gets, with their one item and Notes are in Markdrop (ask Riya Sharma for access).](/docs-assets/integrations/slack/illustration-dm-action-items.webp)

### Who gets one

An action item belongs to the person it starts with: someone @mentioned at its start, or a name the notes start it with, like "Ravi Kumar will email the release notes". That person has to have been in the meeting: one of its attendees, someone on the invite in Google's notes (an item assigned to them means they were there), or its organizer. Items with no person, or with someone who wasn't in the meeting, aren't sent to anyone.

Markdrop finds each person in Slack:

1. by the Slack account they linked to Markdrop;
2. by email: their Markdrop sign-in email, or the address Google's meeting notes gave for them. This needs the app's newer permissions; until an admin selects **Update permissions** on the **Integrations** tab, only people who linked their Slack account get one;
3. as a last resort, by their exact name, when exactly one person in the Slack workspace has it. Someone found only by name always gets the plain version (their items, no link), and never for a meeting [restricted to its attendees](/workspaces/meetings-privacy#restricted-meetings).

Each person gets at most one message per meeting, about a minute after the summary is ready. An item ticked off in that minute is left out, and someone with nothing left gets no message. Meetings whose summaries are ready in that same minute share one message ("Your action items from 2 meetings"); a meeting after that gets a message of its own, so you notice it. Writing a meeting's summary again doesn't send it again. Past meetings brought in quietly and meetings held more than a day ago don't send any.

### Stop them

Every message ends with "Sent after each meeting" and **Stop these**. **Stop these** stops them for that Slack account, whether or not the person uses Markdrop, and offers **Turn back on**. Members can also turn off **Action items after meetings** in **Settings › Account › Slack notifications**. It's separate from the other Slack notifications: it's on even while those are off, and **Stop these** in Slack turns that switch off too.

An admin can turn them off for the whole workspace: **Workspace settings › Integrations › Slack › Send each person their action items after meetings**. Under the switch, admins see a preview built from the newest meeting they can open: what the fullest message would read, everyone who'd get one, and how Markdrop would find them in Slack. Nothing is sent from the preview. After each meeting the card also says how many people were messaged and how many Markdrop couldn't find in Slack.

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

An answer quotes your question, then the answer with its **Sources** as links, and "Only you can see this answer. Markdrop AI can make mistakes; check the sources." Answers are written by Markdrop AI and count towards the same [AI limits](/workspaces/ask-markdrop#ai-limits) as Ask on the website. An answer is never blank: when nothing you can open answers the question, it says so. A workspace with AI features off gets search but no answers.

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
- someone **mentions you in a comment** (**Mentions in comments**) or **assigns you a comment thread** (**Comments assigned to you**). Select **Reply** to answer in a box right in Slack (posted as you), or **Resolve** to resolve the thread if you started it, it's assigned to you, or you can edit the page. See [Comments](/collaboration/notifications#slack);
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

Once they're on, turn each kind on or off under **Message me when** on the same card. All of them start on. To stop them all, turn off **Get notifications in Slack**, or select **Turn off** at the bottom of any message (it opens that card). Your Slack account stays linked for `/markdrop`.

The bell doesn't change. A Slack message counts like a push notification for [email](/pages/mentions-and-notifications#the-app-comes-first): what reached you in Slack isn't emailed. Mentions and sign-off requests wait a minute before they go, so a mention [removed within a minute](/pages/mentions-and-notifications#take-a-mention-back) never reaches you. If you lose access to something, or the mention is taken out, before the message goes out, it isn't sent, and [end-to-end encrypted](/sharing/end-to-end-encryption) items never get one.

![Illustration of a direct message: Alex Chen mentioned you in Release notes 2.4, with the line and Open in Markdrop.](/docs-assets/integrations/slack/illustration-dm-mention.webp)

![Illustration of an access request direct message: Jordan Park asked to edit Q3 plan, with their message and Approve, Decline and Review in Markdrop; after Approve, the same message says Approved by you: they can edit it now.](/docs-assets/integrations/slack/illustration-dm-access-request.webp)

## Disconnect

An admin selects **Disconnect Slack…** on the **Integrations** tab. You can also remove the app in Slack. Either way, Markdrop forgets that Slack workspace and everyone's link to it. Messages already posted stay in Slack.

## What Markdrop keeps

- The Slack workspace's name and its app token. The token is encrypted.
- Who linked which Slack account, and how (found by email, or Sign in with Slack).
- The meetings channel.
- Each person's Slack notification choices: on or off, and which kinds, and whether they get their action items after meetings.
- Who selected **Stop these**, by Slack account. Disconnecting keeps it, so reconnecting doesn't message them again.
- The email addresses Google's meeting notes gave for attendees, on the meeting, to find them in Slack. They're never shown in Markdrop.

It doesn't read your channels. It only sees messages that contain a markdrop.in link, and only the link itself.

## From an AI app

With the [hosted MCP server](/ai/hosted-mcp), an AI app can check a workspace's Slack connection with `slack_status` (connected or not, the meetings channel, whether new meetings are posted, whether your own account is linked, whether your Slack notifications are on, and whether each person gets their action items after meetings) and post a meeting with `post_meeting_to_slack`, with the same rules as **Post to Slack**. Connecting Slack, choosing the channel, linking your account and turning on Slack notifications stay on the website, because they go through Slack's own screens. See [MCP tools](/ai/tools).

## Related

- [Meetings](/workspaces/meetings)
- [Ask](/workspaces/ask-markdrop)
- [Members and roles](/workspaces/members-and-roles)
