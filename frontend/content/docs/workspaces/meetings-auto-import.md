---
title: Import meetings automatically
nav: Import automatically
description: Connect Google Meet once, and every call's transcript and Gemini notes become a meeting page by themselves, with a small script in your own Google account.
updated: 2026-11-05
keywords: [shared meetings, meetings shared with me, organizer, nothing imported, check, script status, update script, new script, shared drives, auto import, backfill, past meetings, import old meetings, automatic import, connect google meet, google meet, apps script, google apps script, gemini notes, notes by gemini, transcript, meet transcript, script.google.com, unverified app, trigger, every 15 minutes, disconnect, meetings token, include_shared, script version 3, syncmeetings, max_per_run, backfill_days, last 30 days, drive api, script ran, also importing here, get the new script, slack, quiet import]
---

Connect Google Meet once, and every call that Google transcribes or takes notes for becomes a page in your workspace's **Meetings** folder by itself, about 15 minutes after it ends.

It works with a small Google Apps Script that runs in your own Google account. Markdrop writes the script for you; you paste it into Google once. You can still [import meetings manually](/workspaces/meetings-import) at the same time.

## Before you start

- You're a member of the workspace (not a viewer).
- Google Meet saves a transcript (**Transcripts** on in the call) or Gemini's notes (**Take notes for me**). They're saved to the Drive of the person who turned them on, usually the organizer, and shared with the people invited.
- You're signed in to Google with the account you join your calls with. You don't need to be the organizer: the script also finds the meetings shared with you.

## Connect Google Meet

1. In the workspace's **Meetings** folder, select **Connect Google Meet** in the bar at the top. It opens the [Meetings page](/workspaces/meetings#the-meetings-page) with the dialog. On the Meetings page itself, **Connect Google Meet** sits next to **Import meeting** (and in the **⋯** menu).

   ![The Connect Google Meet dialog: what the script reads, that it's read-only, that it has its own token for this workspace only, that it doesn't duplicate meetings, how far back to import past meetings, Include meetings shared with me (on), a switch to restrict meetings to their attendees, and Make my script.](/docs-assets/workspaces/meetings-auto-import/connect-dialog.webp)

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

`setup` imports the meetings of the last 48 hours straight away, starts on the past meetings you chose, and schedules itself every 15 minutes. Back in Markdrop, the Meetings page shows **Google Meet connected**, when it last imported and how many meetings it brought in (or *waiting for the script's first run* until `setup` has run), and how the script's last run went (see [See what the script found](#see-what-the-script-found)). The Meetings folder shows the same line in its bar.

When other members connected their own scripts to this workspace, the line says so: **Also importing here:** and their names.

![The Meetings page with Google Meet connected: last import just now, the number of meetings, New script and Disconnect, how the script's last run went (79 found, 60 sent, 19 more in the next run), the shared-drives hint and who else imports here; the meeting it imported is marked Auto.](/docs-assets/workspaces/meetings-auto-import/connected.webp)

## What the script can see and do

- **It reads only meeting Docs.** It looks at Google Docs whose title looks like a Meet transcript ("*Meeting name* (date) - Transcript") or Gemini's notes ("*Meeting name* - date - Notes by Gemini"), created in the last 48 hours. Google's titles in other languages count too ("Transcripción", "Notizen von Gemini" and so on), and so does any Doc in a **Meet Recordings** folder. Other files are never opened.
- **Yours and the ones shared with you.** A meeting someone else organized lives in their Drive and is shared with the attendees: the script finds those too, and Docs in shared drives (that part is optional: see [Shared-drive search is off](#troubleshooting)). Someone else's Doc must look like Meet's own (Gemini's notes, or the call's date and time in the title), so a teammate's "Plan - Notes" isn't sent. With **Include meetings shared with me** off (`INCLUDE_SHARED = false` at the top of the script), only Docs you own are sent.
- **Once per call.** When several attendees connect, a call's Doc is imported once: the second script's copy is recognized as the same Drive file (or the same call) and skipped.
- **Read-only.** Google grants it read-only Drive access (`drive.readonly`), permission to call Markdrop (`script.external_request`) and to schedule itself (`script.scriptapp`). It never edits, moves or deletes anything in your Drive.
- **Its own token.** The token in the script can only send meetings to this workspace's inbox. It can't read your documents, act as you anywhere else, or be used with the API or MCP. It isn't listed with your [API tokens](/account/api-tokens), and the meetings it imports are yours, as if you had imported them.
- **It waits for Google to finish.** A Doc that changed in the last 10 minutes is sent on the next run, so notes Gemini is still writing aren't imported half done.

## See what the script found

Each run tells Markdrop how it went, and the Meetings page shows it under **Google Meet connected**:

> Script ran 5 min ago · found 2 meeting Docs · sent 2 · 14 skipped: 12 not titled like Meet, 2 still being written

- **Found** is the meeting Docs the run could send; **sent** is how many it sent (Docs it sent before aren't counted again).
- **Skipped** says why the other Docs it looked at were left out: *not titled like Meet*, *shared with you (not included)*, *older than it looks back*, *still being written* (sent next run). Markdrop only gets these counts, never the skipped Docs or their names.
- **More in the next run**: a run sends for about 4½ minutes (Google stops a script at 6), so a big pile of Docs takes a run or two. The line then says how many wait: "sent 60 of 79 · 19 more in the next run (every 15 min) — or run syncMeetings now".
- A Doc the script couldn't read, or Markdrop turned away, shows as an error with its title.
- *Shared drives aren't searched* is a hint, not an error: see [Shared-drive search is off](#troubleshooting).

To see the list itself, open the project in Apps Script, pick `check` next to **Run** and press **Run**. It lists every Doc it would send (`WOULD SEND`) and why it skips the others, in the **Execution log**, and sends nothing. The Meetings page then shows the counts as **Checked** *5 min ago* instead of **Script ran**.

When the last run found nothing, the page says what to look at: meetings left out because they're shared with you (make a new script with **Include meetings shared with me** on), or, with nothing at all, whether transcription or **Take notes with Gemini** is on in your calls.

## Update the script

The current script is **version 3**: the top of `Code.gs` says *script version 3*. When yours is older, the Meetings page shows **New script** with **Get the new script**. Update it:

- Version 1 (before November 5, 2026) doesn't import meetings shared with you and doesn't report its runs, so the line under **Google Meet connected** stays empty.
- Version 2 sends at most 20 Docs a run and warns when the Drive API is off. Version 3 sends as many as a run has time for and says it once a day, as a hint.

To update:

1. Select **Get the new script** (or **New script**), choose your options and select **Make a new script**. The old script's token stops working.
2. Open your existing project at [script.google.com](https://script.google.com/home), replace everything in `Code.gs` with the new script and press **Save**. The manifest hasn't changed.
3. Pick `setup` next to **Run** and press **Run**.

## Past meetings

When you connect, the script can also bring in the meetings already in your Drive: the last 7, 30 or 90 days.

- **Oldest first**, as many as a run has time for (about 4½ minutes, at most 200 Docs), so a long history takes a run or two, 15 minutes apart. To send the next batch right away, pick `syncMeetings` next to **Run** and press **Run**. The script's log in Apps Script says **Backfill finished** when it's done.
- **Nobody is notified.** A past meeting's action items still name their owners, and the @mentions are links, but no one gets a notification or an email about a call that's long over, and it isn't posted to your [Slack meetings channel](/integrations/slack). Meetings from the last 48 hours notify (and post) as usual.
- **Dated by the call**, not by the import: the date in Google's title, or when Google made the Doc. The Meetings page lists them by date, and each goes into its series' folder. See [How meetings are organised](/workspaces/meetings#how-meetings-are-organised).
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
- *not titled like Meet*: Google's own names ("… - Transcript", "Notes by Gemini") are what the script looks for. A renamed Doc is skipped; [import it manually](/workspaces/meetings-import) or [paste its link](/workspaces/meetings-import#paste-a-google-drive-link) instead.
- Found 0 and nothing skipped: no Meet Docs reached your Drive in that time. Check that transcripts or **Take notes for me** are on in your calls, and that the organizer shares the notes with attendees (Google's default for people in the same organization).
- In Apps Script, run `check` to see the list, or open **Executions** to see each run's log: what it sent and what Markdrop answered.
- A Doc without a transcript or notes in it (an empty one, or a shopping list called "… - Notes") is skipped and counted as ignored.
:::

:::details[Shared-drive search is off (the Drive API message)]
The script's log may start with: *Shared-drive search is off (optional: enable the Drive API for this script's project: …). Using your Drive and files shared with you — meetings shared with you are still imported.* The Meetings page shows the same as a small hint: **Shared drives aren't searched**.

Nothing is wrong. Google leaves the Drive API off in a new script's own project, and the script only needs it to look in **shared drives** (and in **Meet Recordings** folders there). Without it, the script searches your Drive and the files shared with you, so your meetings and the ones someone else organized are still imported. The script says it once a day, not every run.

If your team keeps meeting notes in a shared drive, turn it on: open the link in the log (or **enable the Drive API** on the Meetings page), check that the project number matches the one in the log, and select **Enable**. The next run searches shared drives too, and the hint goes away.
:::

:::details[It found more than it sent]
"Sent 60 of 79 · 19 more in the next run" means the run used its time: a run sends for about 4½ minutes (at most 200 Docs; Google stops a script at 6), and the rest wait for the next run, 15 minutes later. Nothing is lost or sent twice. To send the next batch now, open the project in Apps Script, pick `syncMeetings` next to **Run** and press **Run**.

To send fewer per run, set `var MAX_PER_RUN` at the top of the script (`0`, the default, lets the time decide).
:::

:::details[Import older meetings]
Set `var BACKFILL_DAYS` at the top of the script to how many days to go back, for example `180` (up to 366), pick `backfill` and press **Run**. It continues on its own, a run's worth every 15 minutes, until **Backfill finished** shows in the log. Meetings already in the workspace aren't imported twice, and nobody is notified about past ones. See [Past meetings](#past-meetings).
:::

:::details[Google's quotas]
Google limits how long scripts run each day (about 90 minutes for a personal account, 6 hours for Google Workspace) and how many calls they make. A run takes a few seconds (up to about 4½ minutes while it catches up on a backlog), so a busy calendar stays far below them. Markdrop takes up to 30 Docs a minute and 600 a day from one script; more wait for the next run.
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
