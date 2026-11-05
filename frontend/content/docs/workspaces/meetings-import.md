---
title: Import a meeting manually
nav: Import manually
description: Paste a transcript, upload a caption or Word file, or pick Google Meet's transcript and Gemini notes from your Drive.
updated: 2026-11-05
keywords: [import meeting, paste transcript, upload transcript, vtt, srt, sbv, docx, zoom, microsoft teams, otter, google meet, gemini notes, notes by gemini, transcript, google drive, google picker, connect google docs, duplicates]
---

Import a call when it's over. It works for any call: Google Meet, Zoom, Microsoft Teams, or a transcript from anywhere else. To have Google Meet calls show up by themselves, see [Import meetings automatically](/workspaces/meetings-auto-import). You can use both.

## Import a meeting

1. Open your workspace and choose **New** › **Import a meeting**. You can also open the **Meetings** folder and select **Import meeting**.
2. Bring the meeting in one of three ways:
   - **Paste** the transcript or the notes.
   - **Upload** `.txt`, `.vtt`, `.srt`, `.sbv`, `.docx` or `.md` files, up to 6 at a time and 4 MB each.
   - **Google Docs**: pick the Docs Google saved in your Drive. See [From Google Drive](#from-google-drive).
3. Check what Markdrop found: the meeting's name, its date, how many transcript lines, and who spoke. Change the **Title**, **Date** or **Type** if you need to.
4. Optionally switch on **Restrict to attendees**. See [Privacy and cost](/workspaces/meetings-privacy).
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

## No duplicates

A Google Doc that's already in the workspace isn't imported again: picking it opens the meeting that's already there, and you see **Already imported**. A Doc that [Connect Google Meet](/workspaces/meetings-auto-import) imported counts too.

It works the other way round as well. When the script finds a Doc you already imported by hand, or a call that's already here (the same name, date and start time), it doesn't make a second meeting. If it brings the other half of that call, such as the transcript for notes you imported, it's added to the meeting you have, and the page and summary are updated with it.

## Related

- [Meetings](/workspaces/meetings)
- [Import meetings automatically](/workspaces/meetings-auto-import)
- [Ask your meetings](/workspaces/meetings-ask)
