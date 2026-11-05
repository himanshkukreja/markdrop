---
title: Import a meeting manually
nav: Import manually
description: Paste a transcript, upload a caption or Word file, paste a Google Drive link, or pick Google Meet's transcript and Gemini notes from your Drive.
updated: 2026-11-05
keywords: [drive link, google docs link, paste a link, shared doc, anyone with the link, organizer, imported by, import meeting, paste transcript, upload transcript, vtt, srt, sbv, docx, zoom, microsoft teams, otter, google meet, gemini notes, notes by gemini, transcript, google drive, google picker, connect google docs, duplicates]
---

Import a call when it's over. It works for any call: Google Meet, Zoom, Microsoft Teams, or a transcript from anywhere else. To have Google Meet calls show up by themselves, see [Import meetings automatically](/workspaces/meetings-auto-import). You can use both.

## Import a meeting

1. Open your workspace and choose **New** › **Import a meeting**. You can also open the **Meetings** folder and select **Import meeting**.
2. Bring the meeting in one of four ways:
   - **Paste** the transcript or the notes.
   - **Upload** `.txt`, `.vtt`, `.srt`, `.sbv`, `.docx` or `.md` files, up to 6 at a time and 4 MB each.
   - **Drive link**: paste links to the Google Docs. See [Paste a Google Drive link](#paste-a-google-drive-link).
   - **Google Docs**: pick the Docs Google saved in your Drive. See [From Google Drive](#from-google-drive).
3. Check what Markdrop found: the meeting's name, its date, how many transcript lines, and who spoke. Change the **Title**, **Date** or **Type** if you need to.
4. Optionally switch on **Restrict to attendees**. A 1:1 or a two-person call is restricted by itself. See [Privacy and cost](/workspaces/meetings-privacy).
5. Select **Import meeting**. The page opens straight away, and the summary fills in a few seconds later.

## Formats Markdrop reads

- Google Meet transcripts;
- Gemini notes, including notes with the transcript in a second tab;
- Zoom and Microsoft Teams captions (`.vtt`);
- `.srt` and YouTube `.sbv` captions;
- Otter-style exports ("Name  0:41" followed by the words);
- any text with `Name: words` lines.

Plain prose works too, without speakers. A very long call is cut at about 11 hours of talk.

## From Google Drive

After a call, Google can save two Docs in your Drive:

- **the transcript**: "*Meeting name* (date) - Transcript", with a line per speaker;
- **the notes**: "Notes by Gemini", from **Take notes for me**. They have a **Summary**, **Details** and **Suggested next steps**. Newer notes also hold the transcript in a second tab.

Import either one, or both. When you pick both, Markdrop pairs them by the meeting's name and date into one meeting.

To pick them, choose **Google Docs** in the import dialog. The first time, select **Connect Google Docs** to link your Google account. This is the same Google connection as **Publish to Google Docs**; see [Connected apps](/account/connected-apps). Then select **Choose from Google Drive** and pick the Docs. Markdrop can open only the files you pick: it never sees the rest of your Drive.

If you import only the notes, without a transcript, you still get the page, and **Ask this meeting** answers from the notes.

## Paste a Google Drive link

Someone shared the call's transcript or Gemini notes with you, or sent you the link? Choose **Drive link** in the import dialog and paste it. Several links, one per line, make several meetings (up to 20 at once).

Markdrop takes links to Google Docs (`docs.google.com/document/d/…`) and Drive files (`drive.google.com/file/d/…`, `drive.google.com/open?id=…`), such as a `.vtt` or `.txt` transcript. Then:

- **Shared with "anyone with the link"**: Markdrop reads it right away and imports it.
- **Not shared that way, and your [Google Meet script](/workspaces/meetings-auto-import) is connected to this workspace**: you see **Queued**. The script fetches it with your own Google access on its next run, within 15 minutes (or run `syncMeetings` in Apps Script to do it now). People are notified as for any import, unless the call is more than a day old.
- **Otherwise**: Markdrop says it can't open the Doc. Connect Google Meet, ask the owner to share it with "anyone with the link", or download it and upload the file.

Markdrop only fetches from Google's own addresses (`docs.google.com`, `drive.google.com`), and only the file the link names.

## Organizer and imported by

A meeting's **Organizer** is the person who ran the call, not the person who imported it:

- For a Google Doc (from [Connect Google Meet](/workspaces/meetings-auto-import), the Google picker or a [Drive link](#paste-a-google-drive-link) your script fetched), it's the Doc's owner in Drive: Google saves a call's Docs in the organizer's Drive.
- For pasted text and uploads, it's who the text names (an "Organizer:" or "Hosted by" line). When the text doesn't say, Organizer stays empty.

When the organizer is a member of the workspace, the page's **Organizer** property shows them, and you can change it there. **Details** shows the organizer and who imported the meeting (**Imported by**).

## No duplicates

A Google Doc that's already in the workspace isn't imported again: picking it opens the meeting that's already there, and you see **Already imported**. A Doc that [Connect Google Meet](/workspaces/meetings-auto-import) imported counts too.

It works the other way round as well. When the script finds a Doc you already imported by hand, or a call that's already here (the same name, date and start time), it doesn't make a second meeting. If it brings the other half of that call, such as the transcript for notes you imported, it's added to the meeting you have, and the page and summary are updated with it.

## Related

- [Meetings](/workspaces/meetings)
- [Import meetings automatically](/workspaces/meetings-auto-import)
- [Ask your meetings](/workspaces/meetings-ask)
