---
title: Upload large files
description: Upload video and audio up to 2 GB from the browser, or use the CLI for resumable, verified uploads that survive a dropped connection.
updated: 2026-10-30
prerequisites: [/get-started/first-file]
keywords: [large file, upload, resume, multipart, 2 gb, video, cli, sha256]
---

Screen recordings and long audio are big. Markdrop accepts video and audio up to 2 GB, and there are two ways to get them up: the browser, for a one-off, and the `markdrop` CLI, for anything you'd hate to start over.

## From the browser

Upload at [markdrop.in/upload](https://markdrop.in/upload) as with any file. The file goes straight from your browser to storage, with a progress bar that says how much has gone, for example "412 MB of 1.6 GB. Keep this tab open until it finishes."

A browser upload is one continuous transfer. If the connection drops or you close the tab, it stops and you start again. For a large file on a shaky connection, use the CLI.

## From the terminal

The CLI uploads in parts, several at a time, and picks up where it stopped if anything goes wrong.

::::steps
### Install the CLI and sign in
See [Install the CLI](/cli/install). Then save an API token, which you create at [markdrop.in/settings/tokens](https://markdrop.in/settings/tokens):

```bash
markdrop login
```

### Upload the file
```bash
markdrop upload demo.mp4
```
The CLI prints the link when it's done. It shows progress on the way.

### If it stops, run it again
If your laptop sleeps or the network drops, run the same command. The upload resumes from the parts that already arrived.
::::

### What happens during a CLI upload

1. The CLI hashes the file with SHA-256.
2. It sends the file in parts, 4 at a time, retrying any part that fails.
3. Markdrop puts the parts together and checks the size and the SHA-256 against what the CLI declared. If they don't match, nothing is published.
4. The file goes live at its link.

Checking a 2 GB file takes a little while after the last part lands. The CLI waits for it.

An interrupted upload can be resumed for 24 hours. After that it expires and the parts are discarded; run the command again to start fresh.

### Useful options

```bash
markdrop upload demo.mp4 --slug q3-demo            # markdrop.in/q3-demo
markdrop upload demo.mp4 --title "Q3 demo" --access private
markdrop upload demo.mp4 --workspace Acme --folder guides/setup
url=$(markdrop upload demo.mp4)                    # stdout is only the link
```

See [Upload and replace from the CLI](/cli/upload-and-replace) for every flag.

## From an AI assistant

An assistant connected through MCP can upload large files for you. The local server (`markdrop mcp`) uploads straight from your disk, and the hosted server can hand an assistant that has a shell the same part-by-part upload the CLI uses. See [AI and MCP](/ai/overview).

## Zipped websites go through the browser

The CLI and the upload API don't take `.zip` sites: upload those at [markdrop.in/upload](https://markdrop.in/upload). See [Publish a zipped website](/files/websites).

## Related

- [File size and storage limits](/files/limits)
- [Replace a file and restore versions](/files/replace-and-versions)
- [Video and audio](/files/video-and-audio)
