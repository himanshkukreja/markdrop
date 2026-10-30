---
title: Send and receive files from the terminal
nav: Send and receive
description: Send a file or folder straight to another computer with markdrop send, and download a share link with markdrop get. Nothing is uploaded to a server.
updated: 2026-10-30
prerequisites: [/cli/install]
keywords: [send, get, p2p, peer to peer, webrtc, share link, room id, folder, transfer]
---

`markdrop send` shares a file or folder directly from your computer. The recipient opens the link in a browser or runs `markdrop get`, and the bytes travel from your machine to theirs over an encrypted WebRTC connection. Markdrop's server only passes the small handshake messages that connect the two of you; it never receives the file.

::video{id="cli-send-receive" title="Send a folder from one terminal to another" duration="0:25"}

## Send a file

```bash
markdrop send report.pdf
```

The CLI prints a share link, a room id and a QR code, then waits:

```text
  ╭──────────────────────────────────────────────────╮
  │  markdrop · P2P File Share                       │
  │                                                  │
  │  File    : report.pdf (2.3 MB)                   │
  │  Room    : a3f7c12e91                            │
  │  URL     : https://markdrop.in/share/a3f7c12e91  │
  ╰──────────────────────────────────────────────────╯

  ⠋ Waiting for recipient to open the link…
```

Send the link (or scan the QR code) to the person who should get the file. When they open it, the transfer starts and a progress bar shows how far it has got. `markdrop send` serves one recipient: when the transfer finishes, it exits. Press :kbd[Ctrl+C] to stop sharing at any time.

:::warning[Anyone with the link can download it]
A share link isn't tied to a person. Send it only to the people you mean to, and stop the share when you're done.
:::

### Send a folder

```bash
markdrop send ./screenshots
```

A folder is compressed into one zip before it is sent. `markdrop get` unpacks it into the original folder structure; a browser saves the zip.

### Link the share to your account

Shares from the CLI are anonymous unless `MARKDROP_TOKEN` is set. With a token, the share is listed under your account, where an AI app connected to Markdrop can see it with `list_shares`. Without one, the CLI tells Markdrop nothing about the file.

```bash
MARKDROP_TOKEN=mdk_•••• markdrop send report.pdf
```

## Receive a file

Pass the full link or the room id:

```bash
markdrop get https://markdrop.in/share/a3f7c12e91
markdrop get a3f7c12e91
```

```text
  ✓ P2P connection established
  File : report.pdf
  Size : 2.3 MB

  Accept download of "report.pdf" (2.3 MB)? [Y/n]: y
  Receiving  [████████████████████████████████] 100%

  ✓ Saved to report.pdf
```

The CLI shows the file's name and size and asks before it downloads. While the file arrives, it is written to a hidden `.markdrop-*.part` file next to the destination and renamed when it is complete.

| Option | What it does |
|---|---|
| `-o`, `--output` | Where to save. A path with a file extension (`~/Downloads/q3.pdf`) is the file name; anything else is a folder, created if missing. Default: the current folder. |
| `-y`, `--yes` | Download without asking. Use it in scripts. |

:::warning[Existing files are replaced]
If a file with the same name is already in the destination, `markdrop get` replaces it. Save into an empty folder with `-o` when that matters. (The `receive_share` tool of the local MCP server never overwrites; it picks a new name.)
:::

`markdrop get` works with links made by `markdrop send` and links made in the browser at [markdrop.in/share](https://markdrop.in/share).

## When the connection is slow or fails

Most transfers connect directly between the two computers. When the networks in between don't allow that, the CLI falls back to a relay server. The relay passes the encrypted connection along but can't read it. Relayed transfers are usually slower than direct ones.

- **The sender drops off.** If the sender's connection to Markdrop goes away before the transfer starts, `markdrop get` says "The sender is away — waiting for them to reconnect…" and waits up to 10 minutes.
- **A transfer stops moving.** A transfer that makes no progress for 30 seconds ends with an error instead of hanging. Run the command again.
- **"someone else is receiving from this sender right now".** The sender is serving another person. Try again when they are done.
- **"no sender found".** The link is wrong, or the sender has stopped sharing.

### Debugging slow transfers

Two environment variables help when a transfer is slow on your network:

| Variable | Effect |
|---|---|
| `MARKDROP_DEBUG=1` | Print each connection state change on standard error, and the pair of network addresses the connection settled on. |
| `MARKDROP_ICE_EXCLUDE_IFACES=utun,tun` | Leave out network interfaces whose names start with these prefixes (comma-separated). VPN tunnels can carry the handshake but slow the transfer to a crawl. |

More help: [Troubleshoot transfers](/share/troubleshooting).

## Related

- [Send files from the browser](/share/send-files)
- [Share files from an AI app on your computer](/ai/local-mcp)
- [All CLI flags](/cli/reference)
