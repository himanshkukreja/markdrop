---
title: Upload and replace files from the terminal
nav: Upload and replace
description: Publish a video, PDF or HTML page with markdrop upload, swap the file behind the same link with markdrop replace, and restore earlier versions.
updated: 2026-10-30
prerequisites: [/cli/install, /cli/login-and-tokens]
since: CLI 0.4.0
keywords: [upload, replace, versions, restore, info, video, pdf, resume, sha256, json, same link]
---

`markdrop upload` publishes a file from your computer and prints its link. `markdrop replace` puts a new file behind a link you already shared: the link, its access setting, title and view count stay the same, and the previous file is kept as a version you can bring back.

::video{id="cli-upload-replace" title="Publish a video, then replace it on the same link" duration="0:50"}

## Publish a file

```bash
markdrop upload demo.mp4
```

```text
  ✓ Published demo (212.4 MB)
https://markdrop.in/demo
```

Standard output carries only the link, so you can capture it:

```bash
url=$(markdrop upload demo.mp4)
```

By default the address comes from the file name, the title is the file name, and anyone with the link can open it. Change any of that with flags:

```bash
markdrop upload demo.mp4 --slug q3-demo                    # https://markdrop.in/q3-demo
markdrop upload report.pdf --title "Q3 report" --access private
markdrop upload deck.html --password ••••••••              # --access password is implied
markdrop upload spec.pdf --workspace Acme --folder guides/setup
```

| Flag | What it does |
|---|---|
| `--title` | Title shown on the page. Default: the file name. |
| `--access` | Who can open it: `link` (anyone with the link, the default), `private` (only you), `password`, or `workspace` (members of the workspace; the default with `--workspace`). |
| `--password` | The password for `--access password`. Giving a password without `--access` sets `password` for you. |
| `--slug` | A custom address, `markdrop.in/<slug>`: 3 to 50 letters, digits, `-` or `_`. If it is taken, the command fails before any data is sent. It is never renamed silently. |
| `--workspace`, `--folder` | File it in one of your workspaces and an existing folder there. See [Workspaces and folders](/cli/workspaces). |
| `--json` | Print the result as one JSON object. |
| `--token` | Use this API token for this command only. |

To learn what each access level means for the people you send the link to, see [Who can open a link](/sharing/who-can-open).

## What you can upload

The CLI uploads the file types Markdrop renders: PDF, HTML, images, spreadsheets, Word documents, text and JSON, video and audio. The full list is in [Supported file types](/files/supported-types).

| Limit | Value |
|---|---|
| Video and audio files | Up to 2 GB each |
| Every other type | Up to 25 MB each |
| Storage per account | 20 GB, earlier versions included |
| Versions kept per file | 5, including the current one |

Zipped websites can't be uploaded from the CLI. Upload them at [markdrop.in/upload](https://markdrop.in/upload). More in [File limits](/files/limits).

## How an upload runs

1. **Hashing.** The CLI computes the file's SHA-256 on your computer.
2. **Uploading.** It sends the file straight to storage in parts, four at a time, and retries a part that fails. Upload addresses that expire during a long upload are renewed on their own.
3. **Verifying.** Markdrop joins the parts and checks the size and SHA-256 against what the CLI computed. The link goes live only if they match. If they don't, the command fails and nothing changes on Markdrop.

When standard error is a terminal, a progress line shows each phase, the bytes sent and the speed. In scripts and CI, only the result is printed.

### Resume an interrupted upload

If an upload stops part way (you press :kbd[Ctrl+C], the network drops, the laptop sleeps), run the same command again:

```bash
markdrop upload demo.mp4
```

```text
  Resuming the upload: 4 of 7 parts already on the server.
```

Only the parts Markdrop doesn't have yet are sent. "The same command" means the same file, unchanged, with the same options. An upload can be resumed for 24 hours after it started; after that the CLI says the session has expired and starts over.

The CLI remembers unfinished uploads in your user cache folder. It stores no secrets there.

| System | Folder |
|---|---|
| macOS | `~/Library/Caches/markdrop/uploads` |
| Linux | `~/.cache/markdrop/uploads` |
| Windows | `%LocalAppData%\markdrop\uploads` |

Set `MARKDROP_CACHE_DIR` to use another folder (the CLI adds `uploads` to it).

## Replace the file behind a link

```bash
markdrop replace https://markdrop.in/demo demo-v2.mp4
```

```text
  ✓ Replaced demo — version 2, 220.1 MB. The previous version is kept (markdrop versions demo).
https://markdrop.in/demo
version 2
```

Everyone who has the link now gets the new file. You can name the file by its link (on markdrop.in or on a workspace's own domain) or by its slug alone: `markdrop replace demo demo-v2.mp4`. Add `--title` to change the title at the same time.

Replacing works like uploading: hashed, sent in parts, verified, and resumable by running the same command again. If the check fails, the link keeps serving the old file.

You can replace a file you own, a file shared with you as an editor, or a file in your workspace that isn't private. The new version counts against the owner's storage. When that storage is full you get an error, and the owner's earlier versions are left alone.

:::note[Markdown documents and zipped sites]
`replace` is for files. A Markdown document is changed by editing it on markdrop.in, from [VS Code](/vscode/sync), or with an AI app's `update_document` tool. A zipped website has no versions: replace it from the Markdrop website.
:::

## See and restore versions

```bash
markdrop versions demo
```

```text
  VERSION  SIZE      TYPE       SHA256        CREATED
* 2        220.1 MB  video/mp4  4be1a0c9d2f3  2026-10-29 14:02 UTC
  1        212.4 MB  video/mp4  9f2c1e7a55b0  2026-10-27 09:15 UTC
```

The `*` marks the version the link serves now. Markdrop keeps up to five versions of a file; when a sixth arrives, the oldest is dropped.

To go back:

```bash
markdrop restore demo 1
```

```text
  ✓ Restored version 1 of demo as version 3.
https://markdrop.in/demo
version 3
```

A restore never deletes anything: the old file comes back as a new version, so you can undo a restore the same way. `v1` works as well as `1`.

## Check a published file

```bash
markdrop info demo
```

```text
https://markdrop.in/demo
  slug      demo
  type      video/mp4
  size      220.1 MB
  version   3
  sha256    9f2c1e7a55b0…
  updated   2026-10-29 14:20 UTC
  created   2026-10-27 09:15 UTC
  media     3840×2160 · 42.5s · h264/aac
```

For video and audio, `media` shows the resolution, length and codecs when Markdrop could read them, and `poster` the address of the still frame shown before playback.

## Use it in scripts

With `--json`, `upload`, `replace`, `versions`, `restore` and `info` print exactly one JSON object on standard output and nothing else. Errors go to standard error, and the exit code is `1`.

```bash
markdrop upload demo.mp4 --json
```

```json
{"url":"https://markdrop.in/demo","markdrop_url":"https://markdrop.in/demo","workspace_url":null,"workspace_error":null,"slug":"demo","version":1,"size_bytes":222717952,"content_type":"video/mp4","sha256":"9f2c…"}
```

`url` is the address to share: the workspace's custom domain when the file is in a workspace with a live one, otherwise markdrop.in. `markdrop_url` is always the markdrop.in address.

```bash
slug=$(markdrop upload build/report.pdf --json | jq -r .slug)
markdrop info "$slug" --json | jq .sha256
```

## Related

- [Replace a file and keep its link](/files/replace-and-versions) on the web
- [Upload large files](/files/large-uploads)
- [Publish files from an AI app on your computer](/ai/local-mcp)
- [All CLI flags](/cli/reference)
