---
title: Replace a file and restore versions
description: Swap the file behind a link without changing the link. Markdrop keeps the last 5 versions so you can restore an earlier one.
updated: 2026-10-30
prerequisites: [/get-started/first-file]
keywords: [replace, update file, versions, restore, rollback, same link, history]
---

You shared `markdrop.in/q3-deck` and then found a typo on slide 4. Replace the file and the link stays the same: everyone who has it sees the new version, and people with the page open get it without reloading. The earlier file is kept, so you can put it back.

::video{id="replace-a-file" title="Replace a file, keep the link" duration="0:32"}

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

![The Artifact settings drawer after choosing a new file: under File, Q3 Board Deck v2.pdf with ‘446.4 KB · Replaces the current file when you save’, a Keep the current file link, and the Title field below.](/docs-assets/files/replace-and-versions/settings-file-tile.webp)

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

People who can edit the file can change its title too: in the **Replace file** drawer, with `--title` in the CLI, or through the API. Only the owner changes the link, password and expiry, deletes old versions, or deletes the file. A replacement counts against the owner's storage.

## Versions

Markdrop keeps the last **5 versions** of each file, the current one included. Each replace adds a version; when there are more than 5, the oldest goes.

::clip{src="/docs-assets/files/replace-and-versions/replace-keeps-link" alt="Animation: the link markdrop.in/q3-deck stays fixed while versions stack under it; restoring version 2 adds a copy as version 4 on top, and when a sixth version arrives the oldest drops off, keeping 5." theme="light"}

Old versions count against the owner's 20 GB of storage. If the owner's replacement wouldn't fit, Markdrop drops that file's oldest versions first. If someone else's replacement wouldn't fit, it's refused and the owner's versions stay. See [File size and storage limits](/files/limits).

Old versions are never public. Only the current file is served at the link.

### See and restore versions in the browser

::::steps
### Open the file's settings
Open the file, press :kbd[Esc] or choose **Show details**, then choose **More artifact actions › Settings**. If you can edit the file but don't own it, choose **Replace file**.

### Find Versions
The **Versions** section lists each kept version, newest first, with its size and when it was added. The live one is marked **Current**.

### Restore one
Choose **Restore** next to an earlier version, then **Restore** again to confirm. It goes live at the same link straight away.
::::

### Delete an old version

To free space, the owner can delete an earlier version: in **Versions**, choose the bin button next to it, then **Delete version**. It's gone for good, and its space comes back to your storage. You can't delete the current version; restore another one first, or delete the file.

### See and restore versions from the terminal

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

Seeing and restoring versions is for the owner and people who can edit the file. With MCP, the tools are `list_file_versions` and `restore_file_version`. See [MCP tools](/ai/tools). Deleting a version is in the browser, or [through the API](/api/files/delete-a-file-version).

## Zipped websites

A [zipped website](/files/websites) has no versions. Only its owner can replace it, in the browser, and replacing it removes the old site.

## Related

- [Upload large files](/files/large-uploads)
- [Share with specific people](/sharing/share-with-people)
- [Video and audio](/files/video-and-audio)
