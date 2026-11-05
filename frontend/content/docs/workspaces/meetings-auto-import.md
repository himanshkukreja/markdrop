---
title: Import meetings automatically
nav: Import automatically
description: Connect Google Meet once, and every call's transcript and Gemini notes become a meeting page by themselves, with a small script in your own Google account.
updated: 2026-11-05
keywords: [shared meetings, meetings shared with me, organizer, nothing imported, check, script status, update script, new script, shared drives, auto import, backfill, past meetings, import old meetings, automatic import, connect google meet, google meet, apps script, google apps script, gemini notes, notes by gemini, transcript, meet transcript, script.google.com, unverified app, trigger, every 15 minutes, backfill, disconnect, meetings token]
---

Connect Google Meet once, and every call that Google transcribes or takes notes for becomes a page in your workspace's **Meetings** folder by itself, about 15 minutes after it ends.

It works with a small Google Apps Script that runs in your own Google account. Markdrop writes the script for you; you paste it into Google once. You can still [import meetings manually](/workspaces/meetings-import) at the same time.

## Before you start

- You're a member of the workspace (not a viewer).
- Google Meet saves a transcript (**Transcripts** on in the call) or Gemini's notes (**Take notes for me**). They're saved to the Drive of the person who turned them on, usually the organizer, and shared with the people invited.
- You're signed in to Google with the account you join your calls with. You don't need to be the organizer: the script also finds the meetings shared with you.

## Connect Google Meet

1. Open the workspace's **Meetings** page (select **Ask meetings** in the Meetings folder) and select **Connect Google Meet**. It sits next to **Import meeting**.

   ![The Connect Google Meet dialog: what the script reads, that it's read-only, that it has its own token for this workspace only, that it doesn't duplicate meetings, how far back to import past meetings, a switch to restrict meetings to their attendees, and Make my script.](/docs-assets/workspaces/meetings-auto-import/connect-dialog.webp)

2. Under **Also import past meetings from your Drive**, choose how far back to go: **No, only new meetings**, or the **Last 7**, **30** (the default) or **90 days**. See [Past meetings](#past-meetings).
3. Leave **Include meetings shared with me** on to import every meeting you attended, including the ones someone else organized. Switch it off to import only the Docs in your own Drive.
4. Optionally switch on **Only the people in each meeting can open its page**. See [Restricted meetings](/workspaces/meetings-privacy#restricted-meetings).
5. Select **Make my script**. Markdrop shows a manifest and a script, each with a **Copy** button, and the four steps below. The script holds a token that only works for importing meetings into this workspace. It's shown this once.

   ![The script is ready: the steps in Google Apps Script, with the appsscript.json manifest and the Code.gs script, each with a Copy button.](/docs-assets/workspaces/meetings-auto-import/connect-script.webp)

Then, in Google:

1. **Open Apps Script.** Go to [script.google.com](https://script.google.com/home/projects/create) and create a **New project**.
2. **Paste the manifest.** In **Project Settings** (the gear), tick **Show "appsscript.json" manifest file in editor**. Back in the **Editor**, open `appsscript.json` and replace everything in it with the manifest you copied.
3. **Paste the script.** Open `Code.gs`, replace everything in it with the script you copied, and press **Save**.
4. **Run setup once and allow.** Pick `setup` next to **Run** and press **Run**. Google asks you to allow the script. Because it's your own script, Google shows **Google hasn't verified this app**: select **Advanced**, then **Go to … (unsafe)**, then **Allow**.

`setup` imports the meetings of the last 48 hours straight away, starts on the past meetings you chose, and schedules itself every 15 minutes. Back in Markdrop, the Meetings page shows **Google Meet connected**, when it last imported and how many meetings it brought in, and how the script's last run went (see [See what the script found](#see-what-the-script-found)).

![The Meetings page with Google Meet connected: last import a few minutes ago, the number of meetings, New script and Disconnect; the meeting it imported is marked Auto.](/docs-assets/workspaces/meetings-auto-import/connected.webp)

## What the script can see and do

- **It reads only meeting Docs.** It looks at Google Docs whose title looks like a Meet transcript ("*Meeting name* (date) - Transcript") or Gemini's notes ("*Meeting name* - date - Notes by Gemini"), created in the last 48 hours. Google's titles in other languages count too ("Transcripción", "Notizen von Gemini" and so on), and so does any Doc in a **Meet Recordings** folder. Other files are never opened.
- **Yours and the ones shared with you.** A meeting someone else organized lives in their Drive and is shared with the attendees: the script finds those too, and Docs in shared drives. Someone else's Doc must look like Meet's own (Gemini's notes, or the call's date and time in the title), so a teammate's "Plan - Notes" isn't sent. With **Include meetings shared with me** off (`INCLUDE_SHARED = false` at the top of the script), only Docs you own are sent.
- **Once per call.** When several attendees connect, a call's Doc is imported once: the second script's copy is recognized as the same Drive file (or the same call) and skipped.
- **Read-only.** Google grants it read-only Drive access (`drive.readonly`), permission to call Markdrop (`script.external_request`) and to schedule itself (`script.scriptapp`). It never edits, moves or deletes anything in your Drive.
- **Its own token.** The token in the script can only send meetings to this workspace's inbox. It can't read your documents, act as you anywhere else, or be used with the API or MCP. It isn't listed with your [API tokens](/account/api-tokens), and the meetings it imports are yours, as if you had imported them.
- **It waits for Google to finish.** A Doc that changed in the last 10 minutes is sent on the next run, so notes Gemini is still writing aren't imported half done.

## See what the script found

Each run tells Markdrop how it went, and the Meetings page shows it under **Google Meet connected**:

> Script ran 5 min ago · found 2 meeting Docs · sent 2 · 14 skipped: 12 not titled like Meet, 2 still being written

- **Found** is the meeting Docs the run could send; **sent** is how many it sent (Docs it sent before aren't counted again).
- **Skipped** says why the other Docs it looked at were left out: *not titled like Meet*, *shared with you (not included)*, *older than it looks back*, *still being written* (sent next run). Markdrop only gets these counts, never the skipped Docs or their names.
- A Doc the script couldn't read, or Markdrop turned away, shows as an error with its title.

To see the list itself, open the project in Apps Script, pick `check` next to **Run** and press **Run**. It lists every Doc it would send and why it skips the others, in the **Execution log**, and sends nothing.

## Update the script

When Markdrop has a newer script than the one you installed, the Meetings page shows **New script** with **Get the new script**. Scripts installed before November 5, 2026 don't import meetings shared with you and don't report their runs, so update them:

1. Select **Get the new script** (or **New script**), choose your options and select **Make a new script**. The old script's token stops working.
2. Open your existing project at [script.google.com](https://script.google.com/home), replace everything in `Code.gs` with the new script and press **Save**. The manifest hasn't changed.
3. Pick `setup` next to **Run** and press **Run**.

## Past meetings

When you connect, the script can also bring in the meetings already in your Drive: the last 7, 30 or 90 days.

- **Oldest first**, 20 Docs a run, so a long history takes a few runs (15 minutes apart). The script's log in Apps Script says **Backfill finished** when it's done.
- **Nobody is notified.** A past meeting's action items still name their owners, and the @mentions are links, but no one gets a notification or an email about a call that's long over. Meetings from the last 48 hours notify as usual.
- **Dated by the call**, not by the import: the date in Google's title, or when Google made the Doc. The Meetings page lists them by date.
- **No duplicates.** Meetings already in the workspace, imported by hand or by an earlier run, are skipped.

To go further back later, open the script, pick `backfill` next to **Run** and press **Run**. It goes back `BACKFILL_DAYS` days (set at the top of the script; 30 when it's `0`). To choose another number, change `BACKFILL_DAYS` first.

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
- Look at the line under **Google Meet connected**: it says what the last run found and why it skipped Docs. No line at all means the script hasn't run yet, or it's an older script: [update it](#update-the-script).
- *shared with you (not included)*: the meetings were organized by someone else. Make a new script with **Include meetings shared with me** on.
- *not titled like Meet*: Google's own names ("… - Transcript", "Notes by Gemini") are what the script looks for. A renamed Doc is skipped; [import it manually](/workspaces/meetings-import) instead.
- Found 0 and nothing skipped: no Meet Docs reached your Drive in that time. Check that transcripts or **Take notes for me** are on in your calls, and that the organizer shares the notes with attendees (Google's default for people in the same organization).
- In Apps Script, run `check` to see the list, or open **Executions** to see each run's log: what it sent and what Markdrop answered.
- A Doc without a transcript or notes in it (an empty one, or a shopping list called "… - Notes") is skipped and counted as ignored.
:::

:::details[Import older meetings]
Set `var BACKFILL_DAYS` at the top of the script to how many days to go back, for example `180` (up to 366), pick `backfill` and press **Run**. It continues on its own, 20 Docs every 15 minutes, until **Backfill finished** shows in the log. Meetings already in the workspace aren't imported twice, and nobody is notified about past ones. See [Past meetings](#past-meetings).
:::

:::details[Google's quotas]
Google limits how long scripts run each day (about 90 minutes for a personal account, 6 hours for Google Workspace) and how many calls they make. A run takes a few seconds, so a busy calendar stays far below them. Markdrop takes up to 30 Docs a minute and 600 a day from one script; more wait for the next run.
:::

:::details[My teammate and I both connected]
That's fine: each call is imported once. The first script to send it creates the meeting; the other script's copy is recognized (the same Drive file, or the same call by name, date and start time) and skipped, or fills in the half that was missing (Google's notes after the transcript).
:::

:::details[It stopped after I disconnected or connected again]
Each script works until its token is replaced or revoked. Make a new script with **Connect Google Meet**, paste it over the old `Code.gs`, and run `setup` again.
:::

## Related

- [Meetings](/workspaces/meetings)
- [Import a meeting manually](/workspaces/meetings-import)
- [Privacy and cost](/workspaces/meetings-privacy)
- [MCP tools](/ai/tools#meetings): `meetings_connection` tells an AI app whether automatic import is on.
