---
title: Zoom
description: Recorded Zoom meetings hosted by one team's members become meetings in that team, with a summary, decisions and action items. Import past ones too.
updated: 2026-11-10
keywords: [zoom, zoom meetings, integration, integrations tab, server-to-server oauth, s2s oauth, zoom app marketplace, build app, account id, client id, client secret, secret token, event subscriptions, recording.transcript_completed, recording.completed, endpoint url, validate, scopes, user:read:list_users:admin, cloud_recording:read:list_user_recordings:admin, cloud_recording:read:list_recording_files:admin, meeting:read:list_past_participants:admin, cloud recording, audio transcript, create audio transcript, no transcript, import past meetings, backfill, sales team, team, private team, open team, host, participants, attendees, disconnect, zoom_status, import_zoom_meetings]
---

Connect your company's Zoom account and every **recorded** Zoom meeting hosted by a member of one team becomes a Markdrop meeting in that team: the transcript, a summary, decisions and action items, the people who joined, and everything else [Meetings](/workspaces/meetings) do (the Slack post, Team briefs and memory, Jira drafts, Ask). You can also bring in past Zoom meetings.

- **One team.** Pick the team, for example **Sales**. Only meetings whose **host** is a member of that team come in. Meetings hosted by anyone else are ignored, and Markdrop doesn't keep anything about them.
- **Visible to that team.** A Zoom meeting lands in the team, so the team's members can read it, and so can workspace admins, as with all [team](/teams/overview) content. If the team is **open**, everyone in the workspace can read its meetings: the Zoom card suggests making it **private**.
- **The host's meeting.** Each meeting is imported as its host's, with the host as organizer. It isn't restricted to its attendees, so the whole team sees it.

Zoom meetings need a **cloud recording with an audio transcript**. A meeting recorded without one shows as **No transcript** with how to turn transcripts on.

## Before you start

You need two people, who may be the same person:

- a **Zoom account admin** (or someone with permission to build Server-to-Server OAuth apps in Zoom), who creates the app in Zoom;
- a Markdrop **workspace admin** or the **owner**, who pastes the app's details into Markdrop.

Zoom meetings come in for one Zoom account per Markdrop workspace. Zoom's Server-to-Server OAuth apps are available on paid Zoom plans; the participants list needs Pro or higher.

## Set up the Zoom app

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
| The setup steps and the form | This workspace isn't connected. Members who aren't admins see "A workspace admin connects Zoom here." |
| **Connected** | The team meetings go to, how many came in and when, whether Zoom has checked the endpoint, and the latest meetings from Zoom with their state. |

Each meeting from Zoom shows one state:

| State | What it means |
| --- | --- |
| **Imported** | It's a meeting in the team now. Choose it to open it. |
| **Already here** | It was imported before. Markdrop never makes the same Zoom meeting twice. |
| **No transcript** | Zoom recorded it without a transcript. Turn on **Create audio transcript** (step 8); if Zoom makes the transcript later, the meeting comes in then. |
| **Didn't import** | Something went wrong, with the reason. Zoom meetings that didn't import can be brought in with **Import past meetings**. |

Admins can change the team, **Change credentials** (for example after rotating the Client Secret in Zoom), or **Disconnect Zoom**.

## Import past meetings

Workspace admins and the team's leads can bring in meetings recorded before Zoom was connected. In the Zoom card, choose **Import past meetings**:

1. Pick **Last 30 days**, **Last 90 days** or **Custom** dates (up to a year).
2. Markdrop lists the recorded meetings hosted by the team's members: the topic, date and time, duration, host, and whether there's a transcript. Meetings already in Markdrop show **Open**.
3. The meetings with a transcript are selected. Change the selection, then choose **Import**.

Past meetings come in like any other Zoom meeting, into the team, but as history: nobody is notified and they aren't posted to Slack on their own. A team member Zoom doesn't know by their email address is listed under the meetings so you can check their Zoom account.

## Privacy

- Markdrop stores the app's Client Secret, the Secret Token and Zoom's access tokens **encrypted**. Only workspace admins see the card's setup details, and never the secrets.
- Every request from Zoom is checked with your Secret Token. Requests that aren't signed by your Zoom app are refused.
- Only meetings hosted by the team's members are read. For other meetings, Markdrop keeps nothing, not even the topic.
- Markdrop downloads the transcript only, never the audio or video.
- **Disconnect Zoom** deletes the credentials and the import log. Meetings already imported stay, and you can delete them like any meeting. You can also delete the app in the Zoom App Marketplace; if Zoom tells Markdrop the app was removed, Markdrop deletes its credentials too.

## From an AI app

With the [MCP server](/ai/tools#zoom), an assistant can check the connection (`zoom_status`) and list and import past Zoom meetings (`import_zoom_meetings`). Imported meetings work with the meeting tools like any other meeting.
