---
title: Replace a file and restore versions
description: Swap the file behind a link without changing the link. Markdrop keeps the last 5 versions so you can restore an earlier one.
updated: 2026-10-30
prerequisites: [/get-started/first-file]
keywords: [replace, update file, versions, restore, rollback, same link, history]
---

You shared `markdrop.in/q3-deck` and then found a typo on slide 4. Replace the file and the link stays the same: everyone who has it sees the new version, and people with the page open get it without reloading. The earlier file is kept, so you can put it back.

::video{id="replace-a-file" title="Replace a file, keep the link" duration="0:45"}

## What stays and what changes

When you replace a file, these stay the same:

- the link, including any address on your own domain;
- who can open it, the password and the expiry;
- the title (unless you change it);
- views and analytics. Analytics can compare versions.

The new file can be a different size, and even a different type: a PDF can replace an HTML page.

## Replace it in the browser

::::steps
### Open the file
Go to its link while signed in. It opens full screen: press :kbd[Esc] or choose **Show details** to bring back the bar above it.

### Open Settings
Choose **More artifact actions › Settings**. If you can edit the file but don't own it, choose **Replace file** instead.

### Choose the new file
Under **File**, choose the current file and pick the new one. It says "Replaces the current file when you save". Choose **Keep the current file** to change your mind.

### Save
Choose **Save changes** (or **Replace file**). The upload progress shows in the drawer, then the new version goes live.
::::

## Replace it from the terminal

```bash
markdrop replace q3-deck q3-deck-v2.pdf
```

You can pass the link or the full URL. The CLI uploads in parts and resumes if interrupted, like `markdrop upload`. Add `--title "Q3 deck (v2)"` to change the title too. See [Upload and replace from the CLI](/cli/upload-and-replace).

## Who can replace a file

- The owner.
- People you added with **Can edit**.
- Members of the file's workspace who can edit, unless the file is set to **Only people added**.

Only the owner changes the title, link, password and expiry, or deletes the file. A replacement counts against the owner's storage.

## Versions

Markdrop keeps the last **5 versions** of each file, the current one included. Each replace adds a version; when there are more than 5, the oldest goes.

Old versions count against the owner's 20 GB of storage. If a replacement wouldn't fit, Markdrop drops that file's oldest versions first. See [File size and storage limits](/files/limits).

Old versions are never public. Only the current file is served at the link.

### See and restore versions

The web app doesn't list versions. Use the CLI, or ask an AI assistant connected through MCP.

```bash
markdrop versions q3-deck
```

```text
  VERSION  SIZE    TYPE             SHA256        CREATED
* 3        2.1 MB  application/pdf  9f2c4e1a7b3d  2026-10-29 14:02 UTC
  2        2.0 MB  application/pdf  41be07c2d9aa  2026-10-28 09:15 UTC
  1        1.9 MB  application/pdf  c03f5a88e612  2026-10-27 18:40 UTC
```

The `*` marks the version that's live. To bring back version 2:

```bash
markdrop restore q3-deck 2
```

A restore doesn't delete anything: it adds a new version that's a copy of version 2. So version 2 becomes version 4, and you can undo the restore by restoring version 3.

Seeing and restoring versions is for the owner and people who can edit the file. With MCP, the tools are `list_file_versions` and `restore_file_version`. See [MCP tools](/ai/tools).

## Zipped websites

A [zipped website](/files/websites) has no versions. Only its owner can replace it, in the browser, and replacing it removes the old site.

## Related

- [Upload large files](/files/large-uploads)
- [Share with specific people](/sharing/share-with-people)
- [Video and audio](/files/video-and-audio)
