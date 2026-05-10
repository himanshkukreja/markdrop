# markdrop CLI

A cross-platform terminal tool for **peer-to-peer file sharing** with no cloud storage.  
Files travel directly between machines over an encrypted WebRTC DataChannel.  
The signalling server only ever sees tiny handshake messages — never your file bytes.

---

## Features

- **Zero server storage** — files go straight from sender to receiver
- **End-to-end encrypted** — WebRTC DTLS encryption by default
- **QR code** — scan from any phone instead of typing the URL
- **Browser compatible** — receiver can download from `markdrop.in` in a browser without installing anything
- **Cross-platform** — single statically linked binary for macOS, Linux, and Windows (amd64 + arm64)
- **Large file support** — 64 KB chunking with backpressure; no memory limits on file size
- **Auto-accept mode** — `-y` flag for scripted / unattended use

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
- Writes to a `.tmp` file during transfer and renames atomically on completion
- If `-o` points to a path with a file extension it is used as the output filename; otherwise it is treated as a directory

---

### Global flags

These flags apply to all subcommands and can be used when pointing the CLI at a self-hosted instance.

| Flag | Default | Description |
|------|---------|-------------|
| `--server` | `https://api.markdrop.in` | HTTP(S) base URL of the signalling server. The CLI derives the WebSocket URL automatically (`wss://…/ws/share/<id>`). |
| `--origin` | `https://www.markdrop.in` | Value of the `Origin` header sent during the WebSocket upgrade. Must match an entry in the server's CORS allow-list. |

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

Requires Go 1.22+.

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
│   └── get.go                      `markdrop get` — file receiver
└── internal/
    ├── signaling/
    │   └── client.go               Thread-safe WebSocket signalling client
    ├── peer/
    │   ├── host.go                 WebRTC host: creates offer, streams file chunks
    │   └── guest.go                WebRTC guest: answers offer, assembles chunks
    └── ui/
        └── display.go              Terminal output: box, QR code, spinner, progress bar
```

---

## Security notes

- **Room IDs are random**, not sequential — generated with `crypto/rand`, making brute-force enumeration impractical.
- **Transfer is encrypted** by WebRTC's mandatory DTLS layer; the signalling server cannot read file content.
- **No auth on the signalling server** — anyone with the room ID can join as a guest. Treat the share URL like a temporary secret link; share it only with the intended recipient.
- **One sender per room** — a second host connection is rejected (HTTP 4000) by the server.

---

## License

[MIT](../LICENSE)
