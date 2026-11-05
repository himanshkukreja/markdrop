---
title: Slack
description: Post meeting notes with Done buttons to a channel, search and ask Markdrop from Slack, preview links, and get mentions and requests as direct messages.
updated: 2026-11-05
keywords: [slack, slack app, integration, /markdrop, slash command, search, ask, ai answers, meeting notes, action items, done button, unfurl, link preview, direct messages, notifications, mentions, sign-off, access requests, approve, decline, slack connect]
---

Markdrop for Slack connects one Slack workspace to one Markdrop workspace. It does four things:

- **Meeting notes in a channel.** When a meeting's summary is ready, its decisions and action items are posted to the channel you choose. Each action item has a **Done** button that ticks it on the Markdrop page.
- **`/markdrop search` and `/markdrop ask`.** Find documents, pages and files, or get an answer with sources. Only you see the reply, and it uses only what you can open in Markdrop.
- **Link previews.** Markdrop links show a preview when everyone in the channel may open them.
- **Direct messages** for mentions, sign-off requests, shares and access requests. You can approve or decline an access request, or sign off, right in Slack.

## Connect a Slack workspace

You need to be an admin or the owner of the Markdrop workspace, and allowed to add apps in Slack.

1. Open **Workspace settings** and choose the **Integrations** tab.
2. Select **Add to Slack**, pick the Slack workspace, and select **Allow**.
3. Back in Markdrop, choose a **Meetings channel**. Public channels work straight away. For a private channel, first type `/invite @Markdrop` in it.

Your own Slack account is linked as part of this. Everyone else links theirs once (see the next section).

A Slack workspace can be connected to only one Markdrop workspace at a time. To move it, **Disconnect Slack…** in the first workspace, then add it in the other.

## Link your Slack account

Markdrop answers you in Slack as your Markdrop account, so it needs to know who you are there. Link once, either way:

- In Markdrop: **Workspace settings** › **Integrations** › **Link my Slack account**.
- In Slack: type `/markdrop link` and select **Link my Markdrop account**.

Slack then asks you to confirm who you are (Sign in with Slack). Markdrop keeps no Slack password or token for you. To undo it, select **Unlink** in the same place, or type `/markdrop unlink`.

## Meeting notes and Done

When you import a meeting and its summary is ready, Markdrop posts it to the meetings channel. The post has:

- the meeting's name and date;
- the summary;
- the decisions;
- each action item, with a **Done** button.

An action item's owner is @mentioned when they've linked their Slack account.

**Done** ticks the item on the meeting's page, as the person who clicked. It works for anyone who can edit that page in Markdrop. If you haven't linked your account yet, Slack shows you a link button instead. If someone is editing the page right then, try again in a minute.

Only meetings everyone in the channel may open are posted. A meeting [restricted to its attendees](/workspaces/meetings) is never posted. In a channel shared with another organization (Slack Connect), only meetings anyone with the link can open are posted. Meetings brought in with [Import past meetings](/workspaces/meetings-import) aren't posted on their own either, so a backlog doesn't flood the channel.

To post a meeting again, or by hand when **Post new meetings automatically** is off, open the meeting's panel (**Ask this meeting**, bottom right) and select **Post to Slack**.

## Search and ask from Slack

| Type | What you get |
| --- | --- |
| `/markdrop search onboarding` | The documents, pages, files and folders you can open that match |
| `/markdrop ask how do contractors get a laptop?` | An answer with numbered sources |
| `/markdrop meetings what did we decide about pricing?` | An answer from your workspace's meetings |
| `/markdrop help` | What it can do, and whether you're linked |

Every reply is visible **only to you**, even in a busy channel. Answers use only what your Markdrop account can open, the same as [search](/workspaces/search) in the app. Words without a command search, and a question asks.

Answers are written by Markdrop AI and count towards the same limits as AI search and Meetings AI. A workspace with AI features off gets search but no answers.

## Link previews

Paste a markdrop.in link into Slack and Markdrop adds a preview with its title, a few lines, and where it lives. The whole channel sees a preview, so Markdrop shows one only when everyone there may open the item:

- anything anyone with the link can open (no password, and the workspace doesn't require sign-in); or
- your workspace's own items, in a channel that isn't shared with another organization.

For anything else, the preview just says **Markdrop link — sign in to view**, without the title. Password-protected and private items always get that.

## Direct messages

Once your account is linked, Markdrop sends you a direct message when:

- someone **mentions** you on a page;
- someone asks for your **sign-off**. Choose an option from the message;
- someone **shares** something with you;
- someone asks to **open or edit** something you own. Select **Approve** or **Decline**.

Turn each kind on or off in **Workspace settings** › **Integrations** › **Direct messages from Markdrop**. The bell and email notifications don't change. If you lose access to something before the message goes out, it isn't sent.

## Disconnect

An admin selects **Disconnect Slack…** on the **Integrations** tab. You can also remove the app in Slack. Either way, Markdrop forgets that Slack workspace and everyone's link to it. Messages already posted stay in Slack.

## What Markdrop keeps

- The Slack workspace's name and its app token. The token is encrypted.
- Who linked which Slack account.
- The meetings channel.
- Each person's direct-message choices.

It doesn't read your channels. It only sees messages that contain a markdrop.in link, and only the link itself.
