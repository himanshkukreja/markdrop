# markdrop CLI

A cross-platform terminal tool that does two things with files:

- **Share peer-to-peer** (`send` / `get`) with no cloud storage. Files travel directly between machines
  over an encrypted WebRTC DataChannel; the signalling server only ever sees tiny handshake messages.
- **Publish behind a lasting link** (`upload` / `replace`): a video, PDF, HTML page… gets a
  `markdrop.in/<slug>` link, and you can swap the file behind that same link later, keeping earlier
  versions. See [Upload and replace files](#upload-and-replace-files).

---

## Features

- **Publish and replace** — `markdrop upload demo.mp4` prints a link; `markdrop replace <link> demo-v2.mp4`
  changes the file without changing the link (videos up to 2 GB, resumable, sha256-verified)

- **Zero server storage** — files go straight from sender to receiver
- **Encrypted device to device** — WebRTC DTLS encryption by default
- **QR code** — scan from any phone instead of typing the URL
- **Browser compatible** — receiver can download from `markdrop.in` in a browser without installing anything
- **Cross-platform** — single statically linked binary for macOS, Linux, and Windows (amd64 + arm64)
- **Large file support** — 64 KB chunking with backpressure; no memory limits on file size
- **Auto-accept mode** — `-y` flag for scripted / unattended use
- **AI assistants** — `markdrop mcp` lets Claude Code, Claude Desktop, Cursor or VS Code publish, replace, share and receive files for you

---

## Installation

No Go installation required.

### macOS

```bash
brew install markdrop/tap/markdrop
```

> **How it works:** Homebrew taps are just GitHub repos.
> `brew install himanshkukreja/tap/markdrop` tells Homebrew to look at
> `github.com/himanshkukreja/homebrew-tap` for a formula file, then install the
> binary from there. It also manages upgrades (`brew upgrade markdrop`).

---

### Linux — Ubuntu / Debian (apt)

```bash
# 1. Add the markdrop apt repository (one-time setup)
curl -fsSL https://markdrop.fury.io/apt-key.gpg \
  | sudo gpg --dearmor -o /usr/share/keyrings/markdrop.gpg

echo "deb [signed-by=/usr/share/keyrings/markdrop.gpg] \
https://markdrop.fury.io/apt/ any main" \
  | sudo tee /etc/apt/sources.list.d/markdrop.list

sudo apt update

# 2. Install (and future upgrades)
sudo apt install markdrop
```

### Linux — Fedora / RHEL / CentOS (dnf / yum)

```bash
# 1. Add the markdrop RPM repository (one-time setup)
sudo tee /etc/yum.repos.d/markdrop.repo <<'EOF'
[markdrop]
name=markdrop
baseurl=https://markdrop.fury.io/rpm/
enabled=1
gpgcheck=0
EOF

# 2. Install
sudo dnf install markdrop
```

### Linux — quick install (no repo setup)

If you don't want to add a repo, use the one-liner instead:

```bash
curl -fsSL https://markdrop.in/install.sh | sh
```

Installs to `/usr/local/bin`. Falls back to `~/bin` if no write access — no root required.

---

### Windows (PowerShell)

```powershell
irm https://markdrop.in/install.ps1 | iex
```

Installs to `%LOCALAPPDATA%\markdrop` and adds it to your user `PATH` automatically. No admin rights required.

Or with [Scoop](https://scoop.sh):

```powershell
scoop bucket add markdrop https://github.com/himanshkukreja/scoop-bucket
scoop install markdrop
```

---

### Verify the install

```bash
markdrop --version
```

---

<details>
<summary>Manual binary download</summary>

Go to the [Releases](https://github.com/himanshkukreja/markdrop/releases) page and download the archive for your platform.

| Platform            | File                                          |
|---------------------|-----------------------------------------------|
| macOS Intel         | `markdrop_<version>_darwin_amd64.tar.gz`      |
| macOS Apple Silicon | `markdrop_<version>_darwin_arm64.tar.gz`      |
| Linux x64           | `markdrop_<version>_linux_amd64.tar.gz`       |
| Linux ARM64         | `markdrop_<version>_linux_arm64.tar.gz`       |
| Windows x64         | `markdrop_<version>_windows_amd64.zip`        |

```bash
# Extract and install manually
sudo tar -xzf markdrop_*_linux_amd64.tar.gz -C /usr/local/bin markdrop
```

</details>

---

## Quick start

### Sending a file

```
$ markdrop send report.pdf

  ╭──────────────────────────────────────────────────╮
  │  markdrop · P2P File Share                       │
  │                                                  │
  │  File    : report.pdf (2.3 MB)                   │
  │  Room    : a3f7c12e91                            │
  │  URL     : https://markdrop.in/share/a3f7c12e91  │
  │                                                  │
  ╰──────────────────────────────────────────────────╯

  [QR code]

  ⠋ Waiting for recipient to open the link…

  ✓ Recipient connected — establishing P2P link…

  Sending  [████████████░░░░░░░░░░░░░░░░░░] 72%  1.6 MB / 2.3 MB

  ✓ Transfer complete! report.pdf sent to recipient.
```

The process stays alive until the recipient downloads the file, then exits automatically.  
Press `Ctrl+C` at any time to cancel.

---

### Receiving a file — CLI

```bash
# Pass the full URL
markdrop get https://markdrop.in/share/a3f7c12e91

# Or just the room ID
markdrop get a3f7c12e91

# Save to a specific directory
markdrop get a3f7c12e91 -o ~/Downloads

# Save with a specific filename
markdrop get a3f7c12e91 -o ~/Downloads/my-report.pdf

# Skip the confirmation prompt (scripting / CI)
markdrop get a3f7c12e91 -y
```

```
  ⠋ Connecting to sender…
  ✓ P2P connection established

  File : report.pdf
  Size : 2.3 MB

  Download? [Y/n]: y

  Receiving  [████████████████████████████████] 100%  2.3 MB / 2.3 MB

  ✓ Saved to ./report.pdf
```

---

### Receiving a file — Browser

The receiver doesn't need the CLI. Share the URL and they can download from any browser at **markdrop.in**.

---

## Upload and replace files

`markdrop upload` publishes a file from your computer on markdrop.in and prints its link.
`markdrop replace` swaps the file behind an existing link: the **link, access setting, title and
view count stay the same**, and the previous file is kept as a version you can restore. Good for a
demo video you re-record, a PDF you revise, an HTML report you regenerate.

These commands need an API token (v0.4.0+). Create one at
[markdrop.in/settings/tokens](https://markdrop.in/settings/tokens), then either:

```bash
export MARKDROP_TOKEN=mdk_…        # per shell / CI secret
markdrop login                     # or save it once (paste it; stored 0600 in your config dir)
```

`--token` on a command beats `MARKDROP_TOKEN`, which beats the saved token. The token is only ever sent
as an `Authorization: Bearer` header to the API.

```bash
markdrop upload demo.mp4                                   # → https://markdrop.in/demo
markdrop upload report.pdf --title "Q3 report" --access private
markdrop upload deck.html --password hunter2               # --access password is implied

markdrop replace https://markdrop.in/demo demo-v2.mp4      # same link, now version 2
markdrop versions demo                                     # * marks the version the link serves
markdrop restore demo 1                                    # bring v1 back (as version 3)
markdrop info demo                                         # size, sha256, version, video size/duration
```

```
$ markdrop replace demo demo-v2.mp4
  Uploading [████████████░░░░░░░░░░░░]  52%  110.2 MB / 212.4 MB  38.1 MB/s
  ✓ Replaced demo — version 2, 212.4 MB. The previous version is kept (markdrop versions demo).
https://markdrop.in/demo
version 2
```

**How it behaves**

- The file is hashed locally (sha256, streamed), sent straight to storage in parts (the server picks the
  part size, 32 MiB by default) with **4 parts in flight**, and each part is retried with backoff.
  Upload URLs that expire during a long upload are refreshed automatically.
- The server assembles the parts and checks the sha256 before anything goes live. If it doesn't match,
  the command fails (exit code 1) and **nothing changes** on Markdrop.
- **Resumable:** if an upload is interrupted (Ctrl+C, a dropped connection, a closed laptop), run the
  **same command again** — only the parts the server doesn't have yet are sent. Sessions are remembered
  in your user cache folder (`~/Library/Caches/markdrop/uploads` on macOS, `~/.cache/markdrop/uploads`
  on Linux, `%LocalAppData%\markdrop\uploads` on Windows) and expire on the server after about two days,
  after which the upload simply starts over.
- A progress bar is drawn on stderr **only when stderr is a terminal**; in scripts and CI nothing but the
  result is printed.
- Links are accepted as `https://markdrop.in/<slug>`, `https://www.markdrop.in/<slug>`,
  `http://localhost:3000/<slug>` or just the slug.
- Limits: up to 2 GB for video (other types keep their usual limits), 20 GB per account; Markdrop keeps up
  to 5 versions of a file and old versions count toward the quota.

**Scripting with `--json`**

With `--json` each command prints exactly **one JSON object on stdout** — the API's result — and nothing
else (errors go to stderr with exit code 1):

```bash
$ markdrop upload demo.mp4 --json
{"url":"https://markdrop.in/demo","slug":"demo","version":1,"size_bytes":222717952,"content_type":"video/mp4","sha256":"9f2c…"}

$ markdrop versions demo --json
{"versions":[{"version":2,"size_bytes":222717952,"sha256":"9f2c…","content_type":"video/mp4","created_at":"…","current":true},{"version":1,…,"current":false}]}

$ markdrop info demo --json        # restore --json prints the same shape
{"slug":"demo","url":"https://markdrop.in/demo","content_type":"video/mp4","size_bytes":222717952,"sha256":"9f2c…","version":2,"updated_at":"…","created_at":"…","media":{"duration_s":42.5,"width":3840,"height":2160,"video_codec":"h264","audio_codec":"aac"},"poster_url":"https://…"}
```

Without `--json`, `upload` prints just the link on stdout (`url=$(markdrop upload x.mp4)` works), and
`replace` / `restore` print the link and `version N`.

---

## Use with AI assistants (MCP)

`markdrop mcp` is a local [Model Context Protocol](https://modelcontextprotocol.io) server. It lets
an AI app on your computer — Claude Code, Claude Desktop, Cursor, VS Code — work with your files:
"publish ~/Movies/demo.mp4 and give me the link", "replace the video at markdrop.in/demo with the new
render", "share these three PDFs peer-to-peer", "download https://markdrop.in/share/… into ~/Projects".
(Peer-to-peer tools since v0.3.0; file publishing tools since v0.4.0.)

It runs **on your computer** because the bytes come from your own disk: an AI app never has to pass a
file's contents through the conversation. The remote server at `https://api.markdrop.in/mcp` (which
ChatGPT and claude.ai use) can't read your disk; it writes markdown documents and can hand out upload
URLs for agents that have a shell, but for files on this machine `markdrop mcp` is the simple path.

The app starts `markdrop mcp` itself over stdio; you only register it once. The file tools need an API
token (`MARKDROP_TOKEN` in the server's environment, or run `markdrop login` once).

**Claude Code**

```bash
claude mcp add markdrop-p2p -e MARKDROP_TOKEN=mdk_… -- markdrop mcp
```

**Claude Desktop** (`claude_desktop_config.json`), **Cursor** (`~/.cursor/mcp.json`) and other apps that use `mcpServers`:

```json
{
  "mcpServers": {
    "markdrop-p2p": {
      "command": "markdrop",
      "args": ["mcp"],
      "env": { "MARKDROP_TOKEN": "mdk_…" }
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "markdrop-p2p": {
      "type": "stdio",
      "command": "markdrop",
      "args": ["mcp"]
    }
  }
}
```

If the app can't find `markdrop` (desktop apps often start with a short `PATH`), use the full path
from `which markdrop`, e.g. `/opt/homebrew/bin/markdrop`.

**Tools — publish files** (need a token)

| Tool | What it does |
|------|--------------|
| `upload_file` | Publishes a local file (`path`, optional `title`, `access` = `link`/`private`/`password`/`workspace`, `password`, `workspace`) and returns `{url, slug, version, size_bytes, sha256}`. |
| `replace_file` | Replaces the file behind an existing link (`document` = link or slug, `path`, optional `title`). The link, access, title and views stay the same; the previous version is kept and can be restored. Returns `{url, slug, version, size_bytes, sha256}`. |
| `list_file_versions` | `{slug, versions:[{version, size_bytes, sha256, content_type, created_at, current, media?}]}`, newest first (up to 5 kept). |
| `restore_file_version` | Makes `version` current again as a new version (nothing is deleted); returns the file info. |
| `get_file_info` | `{slug, url, content_type, size_bytes, sha256, version, updated_at, created_at, media, poster_url}`; `media` has duration, width, height and codecs for audio/video. |

Uploads are hashed, sent in parts and verified exactly like `markdrop upload`. When the app asks for
progress (an MCP progress token), the server sends `notifications/progress` with bytes sent and the file
size. A long upload never holds up other tool calls and has no time limit of its own; if the app cancels
the call, calling the tool again with the same arguments resumes where it stopped.

**Tools — peer-to-peer**

| Tool | What it does |
|------|--------------|
| `share_files` | Shares files or folders (`paths`, up to 100) and returns a `markdrop.in/share/<id>` link. One file is sent as-is; a folder or several paths go as one zip that the CLI unpacks (a browser saves the zip). The link serves recipients one at a time until `stop_share` or until the app closes. |
| `share_status` | State (`waiting`, `connecting`, `transferring`, `done`, `stopped`, `error`), progress, recipients served, saved paths and the last error of every share and download in the session (or one, by id). |
| `stop_share` | Stops a share; anyone downloading is told the sender stopped. Safe to repeat. Given a `receive_id`, cancels that download. |
| `receive_share` | Downloads a share link (`link`, optional `directory`, default `~/Downloads/Markdrop`) in the background. Never overwrites: a clashing name becomes `name (1).ext`. Shared folders are unpacked. |

**Agent recipes**

- *"Publish ~/Movies/launch.mp4 privately"* → `upload_file {path: "~/Movies/launch.mp4", access: "private"}`.
- *"I re-rendered the demo, put it on the same link"* → `replace_file {document: "https://markdrop.in/launch", path: "~/Movies/launch-v2.mp4"}`;
  the link you already sent people now plays the new video.
- *"Oops, go back to the old cut"* → `list_file_versions {document: "launch"}`, then
  `restore_file_version {document: "launch", version: 1}`.
- *"How long is the video I published, and is it 4K?"* → `get_file_info {document: "launch"}`.
- From a shell instead of MCP (CI, scripts, an agent with a terminal): `markdrop upload … --json`,
  `markdrop replace <slug> <file> --json`.

**Safety**

- Anyone with a link can open what it points to (unless you published with `access: "private"` or a
  password). Your AI app asks before it calls `upload_file`, `replace_file` or `share_files`; read what it
  is about to publish or share.
- `upload_file` and `replace_file` refuse the same secret locations as `share_files` (below).
- Anyone with a share link can download what it shares, until the share stops.
- Shares live only as long as the app that started them: closing the app ends every link.
- `share_files` refuses well-known secret locations — `~/.ssh`, `~/.aws`, `~/.gnupg`,
  `~/.config/gcloud`, `~/.kube`, `~/.docker/config.json`, `.netrc`, `.npmrc`, `.pypirc`, macOS
  Keychains, `.env*` files, `*.pem`, SSH private keys (`id_rsa`, `id_ed25519`, …) — including through
  symlinks, and refuses folders that contain them. This guards against a prompt injection talking
  the assistant into sharing your keys. Set `MARKDROP_MCP_ALLOW_ANY_PATH=1` in the server's
  environment to turn the guard off.
- `receive_share` won't save into those locations or into autostart folders, and strips leading dots
  from received names so a sender can't plant a dotfile.

**Environment**

| Variable | Effect |
|----------|--------|
| `MARKDROP_TOKEN` | An API token (markdrop.in → Settings → API tokens). Required by the file tools (unless you ran `markdrop login`, whose saved token they also use). Peer-to-peer shares you start are then listed under your account, e.g. by the remote MCP server's `list_shares` (also honoured by `markdrop send`); without it the peer-to-peer tools tell the server nothing about your files. |
| `MARKDROP_MCP_ALLOW_ANY_PATH` | `1` disables the secret-path guard. |
| `MARKDROP_CACHE_DIR` | Where resumable uploads are remembered (default: your user cache folder). |
| `MARKDROP_CONFIG_DIR` | Where `markdrop login` keeps the token (default: your user config folder). |

```json
{
  "mcpServers": {
    "markdrop-p2p": {
      "command": "markdrop",
      "args": ["mcp"],
      "env": { "MARKDROP_TOKEN": "mdk_…" }
    }
  }
}
```

Logs go to stderr (your app's MCP log); stdout carries only the protocol.

---

## Command reference

### `markdrop send <file>`

Share a file by generating a unique room ID and waiting for a recipient.

```
Usage:
  markdrop send <file> [flags]

Flags:
  -h, --help   help for send

Global Flags:
      --origin string   Origin header for the WebSocket handshake (default "https://www.markdrop.in")
      --server string   API base URL of the markdrop signalling server (default "https://api.markdrop.in")
```

**Behaviour:**
- Generates a cryptographically random 10-character room ID via `crypto/rand`
- Prints the share URL and a QR code
- Blocks until a recipient connects and the full file is transferred
- Exits with code `0` on success, non-zero on error

---

### `markdrop get <room-id|url>`

Download a file from a sender.

```
Usage:
  markdrop get <room-id|url> [flags]

Flags:
  -h, --help            help for get
  -o, --output string   Output directory or file path (default: current directory)
  -y, --yes             Auto-accept the download without prompting

Global Flags:
      --origin string   Origin header for the WebSocket handshake (default "https://www.markdrop.in")
      --server string   API base URL of the markdrop signalling server (default "https://api.markdrop.in")
```

**Behaviour:**
- Accepts either a full `https://markdrop.in/share/<id>` URL or a bare room ID
- Shows file name and size before downloading; prompts for confirmation (skip with `-y`)
- Writes to a hidden `.markdrop-*.part` file during transfer and renames it on completion
- If `-o` points to a path with a file extension it is used as the output filename; otherwise it is treated as a directory
- If the sender's connection to the server drops before the transfer starts, waits up to 10 minutes for it to come back

---

### `markdrop upload <path>`

Publish a file and print its link. See [Upload and replace files](#upload-and-replace-files).

| Flag | Description |
|------|-------------|
| `--title T` | Title shown on the page (default: the file name) |
| `--access A` | `link` (default: anyone with the link), `private`, `password` or `workspace` |
| `--password P` | Password for `--access password` (implies it) |
| `--workspace W` | Workspace for `--access workspace` (implies it) |
| `--json` | Print the API result as one JSON object on stdout, nothing else |
| `--token T` | API token (default: `$MARKDROP_TOKEN`, then the token saved by `markdrop login`) |

### `markdrop replace <slug-or-url> <path>`

Replace the file behind an existing link; prints the link and the new version. Flags: `--title T` (also
change the title), `--json`, `--token`.

### `markdrop versions <slug-or-url>` · `markdrop restore <slug-or-url> <version>` · `markdrop info <slug-or-url>`

List versions (newest first, `*` = current), make an earlier version current again (as a new version),
or show a file's details. Each takes `--json` and `--token`.

### `markdrop login` / `markdrop logout`

Save an API token (prompted without echo, or `--token T`, or piped on stdin) after checking it against the
server; it is stored readable only by you (`0600`) in your user config folder. `logout` deletes it.

**Exit codes:** `0` on success, `1` on any failure (with the reason on stderr).

---

### `markdrop mcp`

Runs the local MCP server over stdio. See [Use with AI assistants (MCP)](#use-with-ai-assistants-mcp).

---

### Global flags

These flags apply to all subcommands and can be used when pointing the CLI at a self-hosted instance.

| Flag | Default | Description |
|------|---------|-------------|
| `--server` | `https://api.markdrop.in` | HTTP(S) base URL of the Markdrop API (signalling and file uploads). The CLI derives the WebSocket URL automatically (`wss://…/ws/share/<id>`). |
| `--origin` | `https://www.markdrop.in` | Value of the `Origin` header sent during the WebSocket upgrade. Must match an entry in the server's CORS allow-list. |
| `--web` | `https://markdrop.in` for the production server | Base URL of the web app used in printed share links (for a self-hosted or local frontend). |

**Troubleshooting:** `MARKDROP_DEBUG=1` prints the ICE connection state and the chosen network path
to stderr. `MARKDROP_ICE_EXCLUDE_IFACES=utun,tun` leaves those network interfaces (by name prefix) out
of the connection — useful when a VPN tunnel carries the handshake but crawls on bulk data.

**Self-hosted example:**

```bash
# Terminal A (sender)
markdrop send big-dataset.zip \
  --server http://localhost:8080 \
  --origin http://localhost:3000

# Terminal B (receiver)
markdrop get a3f7c12e91 \
  --server http://localhost:8080 \
  --origin http://localhost:3000
```

---

## How it works

```
Sender (host)                  Signalling server             Receiver (guest)
─────────────────────────────────────────────────────────────────────────────
markdrop send file.pdf
  generates roomId
  WS → /ws/share/<id>?role=host
                                 room["host"] = ws

  prints URL + QR code
  waits for guest…

                                                       markdrop get <id>
                                                         WS → ?role=guest
                                 room["guest"] = ws
                                 → {"type":"guest-joined"} → host

  RTCPeerConnection created
  DataChannel "file" created
  SDP offer → WS →
                                 relay offer → guest
                                                       RTCPeerConnection created
                                                       SDP answer ← WS ←
                                 relay answer → host
  ICE candidates ←────────────── relay ──────────────→ ICE candidates
       ★ P2P DataChannel established — server is now out of the picture ★

  sends {"type":"meta", name, size, mimeType}
                                                       shows file info
                                                       user presses Y
                                                       sends {"type":"start"}
  begins streaming 64 KB chunks ────────────────────────────────────────────▶
                                                       writes chunks to .tmp
                                                       renames to final file
  ✓ done                                               ✓ saved
```

1. The signalling server relays only JSON handshake messages (SDP, ICE, control signals).
2. From the moment the DataChannel opens, **no data passes through the server at all**.
3. WebRTC DTLS provides encryption in transit.
4. Room IDs are ephemeral — the server deletes them once both peers disconnect.

---

## Building from source

> **Only needed if you want to contribute or self-host.  
> Regular users should use the one-line installers above.**

Requires Go 1.25+.

```bash
git clone https://github.com/himanshkukreja/markdrop
cd cli
make build          # ./markdrop for the current platform
make install        # installs to $GOPATH/bin / ~/go/bin
make build-all      # cross-compile for all 6 platform/arch combos
```

---

## Project structure

```
cli/
├── main.go                         Entry point
├── go.mod / go.sum                 Module definition and locked dependencies
├── Makefile                        Build, install, and cross-compile targets
├── .goreleaser.yaml                GitHub release automation
├── cmd/
│   ├── root.go                     Cobra root command; global flags
│   ├── send.go                     `markdrop send` — file sender
│   ├── get.go                      `markdrop get` — file receiver
│   └── mcp.go                      `markdrop mcp` — local MCP server (stdio)
└── internal/
    ├── signaling/
    │   ├── client.go               WebSocket signalling client: ICE config, pings, host-key reconnect
    │   └── sigtest/                In-process stand-in for the signalling server (tests)
    ├── peer/
    │   ├── host.go                 WebRTC host: creates offer, streams file chunks
    │   ├── guest.go                WebRTC guest: answers offer, assembles chunks
    │   ├── source.go               What a host serves: a file, or a zip of a folder / several paths
    │   └── blob.go                 Share-metadata blob (attribution via MARKDROP_TOKEN)
    ├── mcpserver/                  MCP tools, share/receive manager, secret-path guard
    └── ui/
        └── display.go              Terminal output: box, QR code, spinner, progress bar
```

---

## Security notes

- **Room IDs are random**, not sequential — generated with `crypto/rand`, making brute-force enumeration impractical.
- **Transfer is encrypted** by WebRTC's mandatory DTLS layer; the signalling server cannot read file content.
- **No auth on the signalling server** — anyone with the room ID can join as a guest. Treat the share URL like a temporary secret link; share it only with the intended recipient.
- **One sender per room** — a second host connection is rejected (close code 4000) by the server.
- **Relay when needed** — the server's first message lists its STUN and short-lived TURN servers; when
  no direct path exists the bytes go through the TURN relay, still DTLS-encrypted end to end. With an
  older server the CLI falls back to public STUN after 3 seconds.

---

## License

[MIT](../LICENSE)
