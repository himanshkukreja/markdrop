---
title: Import meetings automatically
nav: Import automatically
description: Connect Google Meet once, and every call's transcript and Gemini notes become a meeting page by themselves, with a small script in your own Google account.
updated: 2026-11-05
keywords: [auto import, automatic import, connect google meet, google meet, apps script, google apps script, gemini notes, notes by gemini, transcript, meet transcript, script.google.com, unverified app, trigger, every 15 minutes, backfill, disconnect, meetings token]
---

Connect Google Meet once, and every call that Google transcribes or takes notes for becomes a page in your workspace's **Meetings** folder by itself, about 15 minutes after it ends.

It works with a small Google Apps Script that runs in your own Google account. Markdrop writes the script for you; you paste it into Google once. You can still [import meetings manually](/workspaces/meetings-import) at the same time.

## Before you start

- You're a member of the workspace (not a viewer).
- Google Meet saves a transcript (**Transcripts** on in the call) or Gemini's notes (**Take notes for me**) to your Drive. They're saved to the Drive of the person who turned them on, usually the organizer.
- You're signed in to Google with that account.

## Connect Google Meet

1. Open the workspace's **Meetings** page (select **Ask meetings** in the Meetings folder) and select **Connect Google Meet**. It sits next to **Import meeting**.

   ![The Connect Google Meet dialog: what the script reads, that it's read-only, that it has its own token for this workspace only, that it doesn't duplicate meetings, a switch to restrict meetings to their attendees, and Make my script.](/docs-assets/workspaces/meetings-auto-import/connect-dialog.webp)

2. Optionally switch on **Only the people in each meeting can open its page**. See [Restricted meetings](/workspaces/meetings-privacy#restricted-meetings).
3. Select **Make my script**. Markdrop shows a manifest and a script, each with a **Copy** button, and the four steps below. The script holds a token that only works for importing meetings into this workspace. It's shown this once.

   ![The script is ready: the steps in Google Apps Script, with the appsscript.json manifest and the Code.gs script, each with a Copy button.](/docs-assets/workspaces/meetings-auto-import/connect-script.webp)

Then, in Google:

1. **Open Apps Script.** Go to [script.google.com](https://script.google.com/home/projects/create) and create a **New project**.
2. **Paste the manifest.** In **Project Settings** (the gear), tick **Show "appsscript.json" manifest file in editor**. Back in the **Editor**, open `appsscript.json` and replace everything in it with the manifest you copied.
3. **Paste the script.** Open `Code.gs`, replace everything in it with the script you copied, and press **Save**.
4. **Run setup once and allow.** Pick `setup` next to **Run** and press **Run**. Google asks you to allow the script. Because it's your own script, Google shows **Google hasn't verified this app**: select **Advanced**, then **Go to … (unsafe)**, then **Allow**.

`setup` imports the meetings of the last 48 hours straight away and schedules itself every 15 minutes. Back in Markdrop, the Meetings page shows **Google Meet connected**, when it last imported and how many meetings it brought in.

![The Meetings page with Google Meet connected: last import a few minutes ago, the number of meetings, New script and Disconnect; the meeting it imported is marked Auto.](/docs-assets/workspaces/meetings-auto-import/connected.webp)

## What the script can see and do

- **It reads only meeting Docs.** It looks at Google Docs in your Drive whose title looks like a Meet transcript ("*Meeting name* (date) - Transcript") or Gemini's notes ("Notes by Gemini", "… - Notes"), created in the last 48 hours. Other files are never opened.
- **Only Docs you own.** Docs a teammate shared with you are left out, so each person connects for the calls they record. Set `INCLUDE_SHARED` to `true` at the top of the script to include shared ones.
- **Read-only.** Google grants it read-only Drive access (`drive.readonly`), permission to call Markdrop (`script.external_request`) and to schedule itself (`script.scriptapp`). It never edits, moves or deletes anything in your Drive.
- **Its own token.** The token in the script can only send meetings to this workspace's inbox. It can't read your documents, act as you anywhere else, or be used with the API or MCP. It isn't listed with your [API tokens](/account/api-tokens), and the meetings it imports are yours, as if you had imported them.
- **It waits for Google to finish.** A Doc that changed in the last 10 minutes is sent on the next run, so notes Gemini is still writing aren't imported half done.

## Notes and transcript become one meeting

Google often saves the notes and the transcript of a call as two Docs, a few minutes apart. Whichever arrives first makes the meeting; the other is added to it when it arrives, by the meeting's name, date and start time. The page and its summary are updated with it.

There are no duplicates with manual import either: a Doc you already imported by hand, or a call that's already in the workspace, isn't imported again. See [No duplicates](/workspaces/meetings-import#no-duplicates).

## Disconnect

On the Meetings page, select **Disconnect** next to **Google Meet connected**. The script's token stops working at once; on its next run the script sees that and removes its own schedule. Meetings it already imported stay. You can also delete the project at [script.google.com](https://script.google.com).

Each person has one connection. **New script** (or connecting in another workspace) replaces it, and the old script stops working.

If you leave the workspace, or become a viewer in it, the script stops importing: Markdrop turns its Docs away until you connect again.

## Troubleshooting

:::details[Google says "Google hasn't verified this app"]
That's expected for a script you wrote yourself: only apps published to other people are verified. Select **Advanced**, then **Go to … (unsafe)**. The permissions it asks for are the three listed above.
:::

:::details[Nothing shows up]
- Check that the Docs are in the Drive of the Google account you ran `setup` with, and that you own them.
- Check the title: Google's own names ("… - Transcript", "Notes by Gemini") are what the script looks for. A renamed Doc is skipped; [import it manually](/workspaces/meetings-import) instead.
- In Apps Script, open **Executions** to see each run's log: what it sent and what Markdrop answered.
- A Doc without a transcript or notes in it (an empty one, or a shopping list called "… - Notes") is skipped and counted as ignored.
:::

:::details[Import older meetings]
Change `var LOOKBACK_HOURS = 48;` at the top of the script, for example to `24 * 30` for the last 30 days, pick `syncMeetings` and press **Run**. It sends up to 20 Docs a run; run it again until it sends nothing, then set it back to `48`. Meetings already in the workspace aren't imported twice.
:::

:::details[Google's quotas]
Google limits how long scripts run each day (about 90 minutes for a personal account, 6 hours for Google Workspace) and how many calls they make. A run takes a few seconds, so a busy calendar stays far below them. Markdrop takes up to 30 Docs a minute and 600 a day from one script; more wait for the next run.
:::

:::details[It stopped after I disconnected or connected again]
Each script works until its token is replaced or revoked. Make a new script with **Connect Google Meet**, paste it over the old `Code.gs`, and run `setup` again.
:::

## Related

- [Meetings](/workspaces/meetings)
- [Import a meeting manually](/workspaces/meetings-import)
- [Privacy and cost](/workspaces/meetings-privacy)
- [MCP tools](/ai/tools#meetings): `meetings_connection` tells an AI app whether automatic import is on.
