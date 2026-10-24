# markdrop CLI

A cross-platform terminal tool for **peer-to-peer file sharing** with no cloud storage.  
Files travel directly between machines over an encrypted WebRTC DataChannel.  
The signalling server only ever sees tiny handshake messages — never your file bytes.

---

## Features

- **Zero server storage** — files go straight from sender to receiver
- **Encrypted device to device** — WebRTC DTLS encryption by default
- **QR code** — scan from any phone instead of typing the URL
- **Browser compatible** — receiver can download from `markdrop.in` in a browser without installing anything
- **Cross-platform** — single statically linked binary for macOS, Linux, and Windows (amd64 + arm64)
- **Large file support** — 64 KB chunking with backpressure; no memory limits on file size
- **Auto-accept mode** — `-y` flag for scripted / unattended use
- **AI assistants** — `markdrop mcp` lets Claude Code, Claude Desktop, Cursor or VS Code share and receive files for you

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

## Use with AI assistants (MCP)

`markdrop mcp` (v0.3.0+) is a local [Model Context Protocol](https://modelcontextprotocol.io) server. It lets
an AI app on your computer — Claude Code, Claude Desktop, Cursor, VS Code — send and receive files
peer-to-peer for you: "share these three PDFs with a link", "download https://markdrop.in/share/… into
~/Projects".

It runs **on your computer** because peer-to-peer bytes come from the sender's own device: the
remote server at `https://api.markdrop.in/mcp` (which ChatGPT and claude.ai use) holds none of your
files, so it can only look up shares, not send them.

The app starts `markdrop mcp` itself over stdio; you only register it once.

**Claude Code**

```bash
claude mcp add markdrop-p2p -- markdrop mcp
```

**Claude Desktop** (`claude_desktop_config.json`), **Cursor** (`~/.cursor/mcp.json`) and other apps that use `mcpServers`:

```json
{
  "mcpServers": {
    "markdrop-p2p": {
      "command": "markdrop",
      "args": ["mcp"]
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

**Tools**

| Tool | What it does |
|------|--------------|
| `share_files` | Shares files or folders (`paths`, up to 100) and returns a `markdrop.in/share/<id>` link. One file is sent as-is; a folder or several paths go as one zip that the CLI unpacks (a browser saves the zip). The link serves recipients one at a time until `stop_share` or until the app closes. |
| `share_status` | State (`waiting`, `connecting`, `transferring`, `done`, `stopped`, `error`), progress, recipients served, saved paths and the last error of every share and download in the session (or one, by id). |
| `stop_share` | Stops a share; anyone downloading is told the sender stopped. Safe to repeat. Given a `receive_id`, cancels that download. |
| `receive_share` | Downloads a share link (`link`, optional `directory`, default `~/Downloads/Markdrop`) in the background. Never overwrites: a clashing name becomes `name (1).ext`. Shared folders are unpacked. |

**Safety**

- Anyone with a link can download what it shares, until the share stops. Your AI app asks before it
  calls `share_files`; read what it is about to share.
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
| `MARKDROP_TOKEN` | An API token (markdrop.in → Settings → API tokens). Shares you start are then listed under your account, e.g. by the remote MCP server's `list_shares`. Also honoured by `markdrop send`. Without it the CLI tells the server nothing about your files. |
| `MARKDROP_MCP_ALLOW_ANY_PATH` | `1` disables the secret-path guard. |

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

### `markdrop mcp`

Runs the local MCP server over stdio. See [Use with AI assistants (MCP)](#use-with-ai-assistants-mcp).

---

### Global flags

These flags apply to all subcommands and can be used when pointing the CLI at a self-hosted instance.

| Flag | Default | Description |
|------|---------|-------------|
| `--server` | `https://api.markdrop.in` | HTTP(S) base URL of the signalling server. The CLI derives the WebSocket URL automatically (`wss://…/ws/share/<id>`). |
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
