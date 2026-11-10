---
title: Zoom
description: Recorded Zoom meetings hosted by one team's members become meetings in that team, with a summary, decisions and action items. Import past ones too.
updated: 2026-11-11
keywords: [zoom, zoom meetings, integration, integrations tab, connect zoom, one click, markdrop app for zoom, zoom app marketplace app, add app, approve, zoom admin, reconnect, remove the app, uninstall, removing the app, deauthorize, added apps, delete imported meetings, user:read:user:admin, server-to-server oauth, s2s oauth, zoom app marketplace, build app, account id, client id, client secret, secret token, event subscriptions, recording.transcript_completed, recording.completed, endpoint url, validate, scopes, user:read:list_users:admin, cloud_recording:read:list_user_recordings:admin, cloud_recording:read:list_recording_files:admin, meeting:read:list_past_participants:admin, cloud recording, audio transcript, create audio transcript, no transcript, import past meetings, backfill, sales team, team, private team, open team, host, participants, attendees, disconnect, zoom_status, import_zoom_meetings]
---

Connect your company's Zoom account and every **recorded** Zoom meeting hosted by a member of one team becomes a Markdrop meeting in that team: the transcript, a summary, decisions and action items, the people who joined, and everything else [Meetings](/workspaces/meetings) do (the Slack post, Team briefs and memory, Jira drafts, Ask). You can also bring in past Zoom meetings.

- **One team.** Pick the team, for example **Sales**. Only meetings whose **host** is a member of that team come in. Meetings hosted by anyone else are ignored, and Markdrop doesn't keep anything about them.
- **Visible to that team.** A Zoom meeting lands in the team, so the team's members can read it, and so can workspace admins, as with all [team](/teams/overview) content. If the team is **open**, everyone in the workspace can read its meetings: the Zoom card suggests making it **private**.
- **The host's meeting.** Each meeting is imported as its host's, with the host as organizer. It isn't restricted to its attendees, so the whole team sees it.

Zoom meetings need a **cloud recording with an audio transcript**. A meeting recorded without one shows as **No transcript** with how to turn transcripts on.

## Connect with one click

The **Markdrop app for Zoom** connects your whole Zoom account in one step. You need a Markdrop **workspace admin** (or the owner) and a **Zoom account admin**, who may be the same person.

1. In Markdrop, open **Workspace settings › Integrations › Zoom**.
2. Pick the team Zoom meetings go to, for example **Sales**. You can change it later.
3. Choose **Connect Zoom**. Zoom opens and asks a Zoom account admin to approve the Markdrop app for the account. If you aren't a Zoom admin, sign in to Zoom as one, or ask your Zoom admin to do this step.
4. Zoom sends you back to the Zoom card, which now says **Connected**.
5. **Turn on transcripts.** In the Zoom web portal, open **Account Management › Account Settings › Recording**. Turn on **Cloud recording** and, in its advanced settings, **Create audio transcript**. Lock both so every host has them.

You can also start from the [Zoom App Marketplace](https://marketplace.zoom.us): find **Markdrop**, choose **Add**, and approve it. Zoom then sends you to Markdrop, which asks which of your workspaces to connect. Pick one and choose **Connect Zoom to this workspace**, then pick the team in the Zoom card.

The app asks Zoom for read-only access:

| Permission | What Markdrop uses it for |
| --- | --- |
| `user:read:user:admin` | Know which Zoom account approved the app, so its meetings reach your workspace and no other. |
| `user:read:list_users:admin` | See the account's users, to know who hosted a meeting. |
| `cloud_recording:read:list_user_recordings:admin` | List each team member's cloud recordings, for **Import past meetings**. |
| `cloud_recording:read:list_recording_files:admin` | Read a meeting's recording files and download its transcript. |
| `meeting:read:list_past_participants:admin` | Who joined each meeting, for its attendees. |

Markdrop never changes anything in Zoom, and never downloads audio or video. One Zoom account connects to one Markdrop workspace.

If the card says **Reconnect Zoom**, Zoom stopped accepting the connection (for example, the app was removed in Zoom without telling Markdrop). Choose **Reconnect Zoom** and approve the app again.

## Advanced: your own Server-to-Server app

If your company prefers to create its own app in Zoom, or one-click connect isn't available, connect a Server-to-Server OAuth app instead. Imports, the team, and privacy work the same way. In the Zoom card, choose **Advanced: use your own Server-to-Server app**.

You need two people, who may be the same person:

- a **Zoom account admin** (or someone with permission to build Server-to-Server OAuth apps in Zoom), who creates the app in Zoom;
- a Markdrop **workspace admin** or the **owner**, who pastes the app's details into Markdrop.

Zoom's Server-to-Server OAuth apps are available on paid Zoom plans; the participants list needs Pro or higher.

### Set up the Zoom app

Open **Workspace settings › Integrations › Zoom** in Markdrop and keep it open: the card shows the same steps, the scopes with copy buttons, and your workspace's own endpoint URL.

1. **Create the app.** Sign in to the [Zoom App Marketplace](https://marketplace.zoom.us) as a Zoom account admin. Choose **Develop › Build App**, pick **Server-to-Server OAuth App**, and name it "Markdrop".
2. **Copy the credentials.** On **App Credentials**, copy the **Account ID**, **Client ID** and **Client Secret**.
3. **Fill in Information.** Add a short description and a developer contact: Zoom requires them before it activates the app.
4. **Add the scopes.** On **Scopes**, choose **Add Scopes** and add these:

   | Scope | What Markdrop uses it for |
   | --- | --- |
   | `user:read:list_users:admin` | See the account's users, to know who hosted a meeting. |
   | `cloud_recording:read:list_user_recordings:admin` | List each team member's cloud recordings, for **Import past meetings**. |
   | `cloud_recording:read:list_recording_files:admin` | Read a meeting's recording files and download its transcript. |
   | `meeting:read:list_past_participants:admin` | Optional: who joined each meeting, for its attendees. Without it, Markdrop uses the people who spoke in the transcript. |

   Markdrop never asks for scopes that change anything in Zoom, and never downloads audio or video.
5. **Turn on Event Subscriptions.** On **Feature**, turn on **Event Subscriptions** and add a subscription named "Markdrop".
   - **Event notification endpoint URL**: copy it from the Zoom card in Markdrop. It looks like `https://api.markdrop.in/api/v1/zoom/webhook/<your workspace id>`.
   - **Events**: under **Recording**, add **Cloud recording transcript files have completed** (`recording.transcript_completed`) and **All recordings have completed** (`recording.completed`).
   - Copy the **Secret Token** shown on that page.
6. **Save in Markdrop, then validate in Zoom.** In the Zoom card, paste the **Account ID**, **Client ID**, **Client Secret** and **Secret Token**, pick the team, and choose **Connect and check**. Then go back to Zoom, press **Validate** next to the endpoint URL, and save the subscription.
7. **Activate the app.** On **Activation**, choose **Activate your app**.
8. **Turn on transcripts.** In the Zoom web portal, open **Account Management › Account Settings › Recording**. Turn on **Cloud recording** and, in its advanced settings, **Create audio transcript**. Lock both so every host has them.

When you choose **Connect and check**, Markdrop asks Zoom for an access token with the app's credentials and makes a test call. If Zoom refuses the credentials, the card says so and nothing is saved. If a scope is missing, the card lists it: add it in Zoom, then save again (blank secret fields keep the saved ones).

## The Zoom card

| The card shows | What it means |
| --- | --- |
| **Not set up yet** | Zoom isn't available on this Markdrop server. Nothing is wrong with your workspace. |
| **Connect Zoom**, or the setup steps and the form | This workspace isn't connected. Members who aren't admins see "A workspace admin connects Zoom here." |
| **Connected** | The team meetings go to, how many came in and when, whether Zoom has checked the endpoint, and the latest meetings from Zoom with their state. |

Each meeting from Zoom shows one state:

| State | What it means |
| --- | --- |
| **Imported** | It's a meeting in the team now. Choose it to open it. |
| **Already here** | It was imported before. Markdrop never makes the same Zoom meeting twice. |
| **No transcript** | Zoom recorded it without a transcript. Turn on **Create audio transcript** (step 8); if Zoom makes the transcript later, the meeting comes in then. |
| **Didn't import** | Something went wrong, with the reason. Zoom meetings that didn't import can be brought in with **Import past meetings**. |

Admins can change the team or **Disconnect Zoom**. With your own Server-to-Server app, they can also **Change credentials** (for example after rotating the Client Secret in Zoom).

## Import past meetings

Workspace admins and the team's leads can bring in meetings recorded before Zoom was connected. In the Zoom card, choose **Import past meetings**:

1. Pick **Last 30 days**, **Last 90 days** or **Custom** dates (up to a year).
2. Markdrop lists the recorded meetings hosted by the team's members: the topic, date and time, duration, host, and whether there's a transcript. Meetings already in Markdrop show **Open**.
3. The meetings with a transcript are selected. Change the selection, then choose **Import**.

Past meetings come in like any other Zoom meeting, into the team, but as history: nobody is notified and they aren't posted to Slack on their own. A team member Zoom doesn't know by their email address is listed under the meetings so you can check their Zoom account.

## Removing the app

You can disconnect from either side.

**In Markdrop:** in the Zoom card, choose **Disconnect Zoom…**. Markdrop deletes its access to your Zoom account and the Zoom import log, and stops bringing in meetings. With the Markdrop app for Zoom, it also removes the app from your Zoom account. To delete the meetings already imported too, tick **Also delete the meetings imported from Zoom**: they go to the workspace's Trash, where they can be restored for a while before they're gone for good.

**In Zoom:** a Zoom account admin signs in to the [Zoom App Marketplace](https://marketplace.zoom.us), opens **Manage › Added Apps** (or **Apps on Account**), finds **Markdrop** and chooses **Remove**. Zoom tells Markdrop, which right away deletes:

- Zoom's access and refresh tokens;
- the Zoom account's ID and the name and email of the admin who approved the app;
- the Zoom import log (topics, dates, hosts and states of the meetings it handled).

Meetings already imported are pages in your workspace, like any other meeting: they stay until a workspace admin or the person who owns them deletes them. To remove them all at once later, connect again and disconnect with **Also delete the meetings imported from Zoom**, or delete them one by one from **Meetings**. Deleting the workspace deletes everything in it.

After removing the app, the Zoom card says **Zoom was disconnected**. Choose **Connect Zoom** to connect again.

## Privacy

- Markdrop stores Zoom's access and refresh tokens, and a Server-to-Server app's Client Secret and Secret Token, **encrypted**. Only workspace admins see the card's setup details, and never the secrets.
- Every request from Zoom is checked with Zoom's signature. Requests that aren't signed by the Markdrop app for Zoom (or your own Zoom app) are refused, and each one reaches only the workspace connected to its Zoom account.
- Only meetings hosted by the team's members are read. For other meetings, Markdrop keeps nothing, not even the topic.
- Markdrop downloads the transcript only, never the audio or video.
- The transcript of an imported meeting is used to write its summary, decisions and action items, as for any [meeting](/workspaces/meetings). See [Removing the app](#removing-the-app) for what is deleted and when, and the [privacy policy](https://markdrop.in/privacy#zoom) for the whole picture.
- Questions or a problem? See [Get help](/help/support).

## From an AI app

With the [MCP server](/ai/tools#zoom), an assistant can check the connection (`zoom_status`, which also gives a workspace admin a one-click link to connect Zoom) and list and import past Zoom meetings (`import_zoom_meetings`). Imported meetings work with the meeting tools like any other meeting.
