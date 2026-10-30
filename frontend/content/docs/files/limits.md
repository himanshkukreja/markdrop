---
title: File size and storage limits
description: Files can be up to 25 MB, video and audio up to 2 GB, and each account stores up to 20 GB, old versions included.
updated: 2026-10-30
keywords: [limits, size, quota, storage, 25 mb, 2 gb, 20 gb, max file size]
---

Markdrop limits how big one file can be and how much each account stores in total. The upload page shows both: the per-file limits above the drop area, and a **Storage** meter with how much you've used.

## Per file

| What | Limit |
| --- | --- |
| Most files: HTML, PDF, spreadsheets, Word, images, text | 25 MB |
| Video and audio | 2 GB |
| A zipped website | 25 MB zipped; see below |
| HTML published by an AI assistant (MCP `publish_page`) | 25 MB |
| HTML sent as text to the API | 10 MB |

Markdrop checks a file's size before uploading, and again once it has arrived. If it's too big, you see "That file is 31.2 MB — the limit is 25 MB." and nothing is stored.

### Zipped websites

A website in a `.zip` has extra limits, checked when Markdrop unpacks it:

| What | Limit |
| --- | --- |
| The `.zip` itself | 25 MB |
| Files inside | 500 |
| Any one file inside | 25 MB |
| Everything inside, unpacked | 100 MB |

See [Publish a zipped website](/files/websites).

## Per account

Each account can store **20 GB** of files. That counts every file you own, plus the earlier versions Markdrop keeps when you replace one. Documents don't count against it.

When an upload would go over:

- If you're replacing a file, Markdrop first drops that file's oldest kept versions to make room.
- If that's not enough, or it's a new upload, the upload is refused with "Storage quota exceeded" and how much you're using.

To free space, delete files you no longer need from **My files**. Replacing a file with a smaller one doesn't free space while older versions are kept. See [Replace a file and restore versions](/files/replace-and-versions).

When someone you've given edit access replaces one of your files, the new file counts against your storage, not theirs. If it would only fit by dropping your old versions, their upload is refused instead.

## What viewers show

Some viewers show part of a very large file, and readers can choose **Download** for the rest:

| Viewer | Shows |
| --- | --- |
| PDF | The first 50 pages |
| Text and JSON | Up to 2,000,000 characters or 100,000 lines |

## Uploading in a hurry

If you upload a lot in a short time, Markdrop stops accepting new uploads for a little while, and publishing fails with an error. Wait a minute and publish again; your file and settings stay on the page.

## Related

- [Upload large files](/files/large-uploads)
- [Supported file types](/files/supported-types)
- [Account limits](/account/limits)
