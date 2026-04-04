# Markdrop — P2P File Sharing

> **Part of the Markdrop project** · [← Back to README](README.md) · [Scaling notes](SCALING.md)

Markdrop lets you send any file directly to another browser — **no upload, no cloud storage, no size limit imposed by us**.
The file travels straight from your browser to theirs, encrypted end-to-end, using a web technology called **WebRTC**.

---

## Table of Contents

1. [The Simple Version — what actually happens](#1-the-simple-version--what-actually-happens)
2. [The Big Picture — all pieces at once](#2-the-big-picture--all-pieces-at-once)
3. [Phase 1 — Connecting (Signalling)](#3-phase-1--connecting-signalling)
4. [Phase 2 — Handshake (WebRTC negotiation)](#4-phase-2--handshake-webrtc-negotiation)
5. [Phase 3 — Transfer (pure P2P)](#5-phase-3--transfer-pure-p2p)
6. [Encryption & Privacy](#6-encryption--privacy)
7. [NAT Traversal — punching through firewalls](#7-nat-traversal--punching-through-firewalls)
8. [File Size Limits](#8-file-size-limits)
9. [Limitations](#9-limitations)
10. [Project Files — where the code lives](#10-project-files--where-the-code-lives)
11. [WebSocket API Reference](#11-websocket-api-reference)

---

## 1. The Simple Version — what actually happens

Imagine you want to pass a physical USB drive to a friend across the room.  
But there is a security guard between you — the guard doesn't touch the USB drive,
they just help you two **find each other** and agree on a common language.  
Once you're connected, the guard steps away and you throw the drive directly.

That's exactly what this feature does:

```
  YOU ──── "where are you?" ────▶  MARKDROP SERVER  ◀──── "I'm here!" ──── THEM
            (WebSocket)              (guard / relay)           (WebSocket)

  Once you find each other the server steps away completely:

  YOU ═══════════════════ file bytes (encrypted) ══════════════════▶ THEM
                         (direct, peer-to-peer)
```

**Step by step in plain English:**

| Step | What you see | What's actually happening |
|------|--------------|--------------------------|
| 1 | You drop a file on `/share` | Browser opens a WebSocket to the Markdrop server and says "I'm a host in room `abc123`" |
| 2 | A link appears: `markdrop.in/share/abc123` | That 10-character room ID is your rendezvous point |
| 3 | Your friend opens the link | Their browser connects to the same room as a "guest" |
| 4 | Both browsers exchange small setup messages | ~5–20 KB of JSON goes through the server — just enough to agree on connection details |
| 5 | "Establishing connection…" | Both browsers try to reach each other directly (using STUN to discover public IPs) |
| 6 | Transfer bar appears | A direct encrypted tunnel is open. The server is completely out of the picture |
| 7 | Bar fills up, file saved | 64 KB chunks fly peer-to-peer; recipient's browser assembles and saves the file |

> **The server never sees your file.** Not one byte. It only sees ~20 KB of connection setup JSON.

---

## 2. The Big Picture — all pieces at once

```
╔═════════════════════════════════════════════════════════════════════════════════╗
║               MARKDROP P2P FILE SHARE — FULL ARCHITECTURE                       ║
╠═════════════════════════════════════════════════════════════════════════════════╣
║                                                                                 ║
║  ┌────────────────────┐      ┌──────────────────────┐      ┌──────────────────┐ ║
║  │   SENDER BROWSER   │      │   api.markdrop.in    │      │RECIPIENT BROWSER │ ║
║  │   /share           │      │  (FastAPI + nginx)   │      │/share/abc123     │ ║
║  │                    │      │                      │      │                  │ ║
║  │  share/page.tsx    │      │  routers/share.py    │      │DownloadView.tsx  │ ║
║  │  webrtc.ts         │      │  _rooms dict         │      │webrtc.ts         │ ║
║  └─────────┬──────────┘      └──────────┬───────────┘      └────────┬─────────┘ ║
║            │                            │                           │           ║
║            │ 1 WS connect (role=host)   │                           │           ║
║            ├───────────────────────────▶│                           │           ║
║            │                            │ 2 WS connect (role=guest) │           ║
║            │                            │◀──────────────────────────┤           ║
║            │ 3 {"type":"guest-joined"}  │                           │           ║
║            │◀───────────────────────────│                           │           ║
║            │                            │                           │           ║
║            │ 4 SDP offer  ─────────────▶│──────────────────────────▶│           ║
║            │ 5 SDP answer ◀─────────────│◀──────────────────────────│           ║
║            │ 6 ICE cands  ◀────────────▶│◀─────────────────────────▶│           ║
║            │                            │                           │           ║
║            │        DTLS encryption handshake (automatic)           │           ║
║            │                            │                           │           ║
║   ╔════════╧════════════════════════════╧═══════════════════════════╧════╗      ║
║   ║       RTCDataChannel OPEN — server completely out of the loop        ║      ║
║   ╚══════════════════════════════════════════════════════════════════════╝      ║
║            │                                                           │        ║
║            │  7 {"type":"meta", name:"…", size:…}                      │        ║
║            ├──────────────────────────────────────────────────────────▶│        ║
║            │  8 {"type":"start"}                                       │        ║
║            │◀──────────────────────────────────────────────────────────┤        ║
║            │                                                           │        ║
║            │  9    chunk 1  [████████████████████]  64 KB              │        ║
║            ├──────────────────────────────────────────────────────────▶│        ║
║            │  10   chunk 2  [████████████████████]  64 KB              │        ║
║            ├──────────────────────────────────────────────────────────▶│        ║
║            │       · · · (backpressure pauses if buffer fills)         │        ║
║            │  11   chunk N  [████████░░░░░░░░░░░░]  last partial chunk │        ║
║            ├──────────────────────────────────────────────────────────▶│        ║
║            │                                                           │        ║
║            │                          12 Blob assembled → browser save │        ║
╚═════════════════════════════════════════════════════════════════════════════════╝
```

**Legend:**
- `①–⑥` = **Signalling phase** — tiny JSON through the server (see [Phase 1](#3-phase-1--connecting-signalling) + [Phase 2](#4-phase-2--handshake-webrtc-negotiation))
- `⑦–⑪` = **Transfer phase** — direct peer-to-peer, server not involved (see [Phase 3](#5-phase-3--transfer-pure-p2p))
- `⑫` = Recipient's browser assembles chunks into a `Blob` and triggers a native save dialog

---

## 3. Phase 1 — Connecting (Signalling)

> **Analogy:** Two people exchanging phone numbers through a mutual friend,
> so they can later call each other directly.

Before two browsers can talk directly, they need to **discover each other's addresses**
and agree on a shared communication format. They can't do this alone because
they don't know each other's IPs yet. That's the *only* job of the Markdrop server here.

### What the server stores

```python
# backend/app/routers/share.py
_rooms: dict[str, dict] = {
    "abc123def4": {
        "host":  <WebSocket of sender>,
        "guest": <WebSocket of recipient>   # None until recipient joins
    }
}
```

Just a Python dictionary in memory. No database. No file storage. Clears on restart.

### Message flow through the relay

```
SENDER                        SERVER                       RECIPIENT
  │                              │                              │
  │── WS /ws/share/abc123 ──────▶│                              │
  │         role=host            │   room created               │
  │                              │                              │
  │                              │◀─── WS /ws/share/abc123 ─────│
  │                              │              role=guest      │
  │◀── {"type":"guest-joined"} ──│                              │
  │                              │                              │
  │    (now both sides know      │                              │
  │     the other is present)    │                              │
```

The server is a **pure relay** — it reads a JSON text frame from one WebSocket and
writes the exact same bytes to the other. It never parses the SDP or ICE content.

### Complete set of messages the server relays

| Message | Who sends it | Who receives it | What it means |
|---------|-------------|-----------------|---------------|
| `guest-joined` | Server itself | Sender | "Your recipient opened the link — start the handshake" |
| `offer` | Sender → relay | Recipient | Sender's WebRTC session description (contains codec info, ports, etc.) |
| `answer` | Recipient → relay | Sender | Recipient's matching session description |
| `ice` | Either → relay | The other | A network address candidate (IP/port/protocol) to try |
| `no-host` | Server itself | Recipient | "Nobody is in this room — the link is expired" |
| `peer-disconnected` | Server itself | The other side | "The other person closed their tab" |

---

## 4. Phase 2 — Handshake (WebRTC negotiation)

> **Analogy:** Two people using a translator to agree "let's speak English, at this phone
> number, on this frequency." Once agreed, they hang up with the translator and call each other directly.

This is the **WebRTC JSEP (JavaScript Session Establishment Protocol)** handshake.
It's fully automatic — the browsers handle it, you just wire up the callbacks.

### Sequence diagram

```
SENDER BROWSER                   RELAY SERVER              RECIPIENT BROWSER
       │                               │                            │
       │  new RTCPeerConnection()      │                            │
       │  createDataChannel("file")    │                            │
       │  createOffer()                │                            │
       │  setLocalDescription(offer)   │                            │
       │                               │                            │
       ├──── {type:"offer", sdp} ─────▶│──── {type:"offer"} ───────▶│
       │                               │                            │
       │                               │    new RTCPeerConnection() │
       │                               │    setRemoteDescription()  │
       │                               │    createAnswer()          │
       │                               │    setLocalDescription()   │
       │                               │                            │
       │◀─── {type:"answer", sdp} ─────│◀─── {type:"answer"} ───────│
       │                               │                            │
       │  setRemoteDescription(answer) │                            │
       │                               │                            │
       │  ┌────────────── trickle ICE (both directions) ──────────┐ │
       ├──┤── {type:"ice", cand:…} ───▶│──── {type:"ice"} ───────▶├─┤
       │  │◀─ {type:"ice", cand:…} ────│◀─── {type:"ice"} ────────│ │
       │  │      (repeats for each candidate pair discovered)     │ │
       │  └────────────────────────────────────────────────────── ┘ │
       │                               │                            │
       │  ══════════ DTLS 1.2 handshake (encryption keys) ═════════ │
       │                               │                            │
       │  ondatachannel event fires ◀─────────────────────────────  │
       │  channel.onopen fires         │      channel.onopen fires  │
       │                               │                            │
       │   DataChannel OPEN            │         DataChannel OPEN   │
       │  (server no longer needed)    │                            │
```

### What SDP and ICE actually are

**SDP (Session Description Protocol)** — a text block that says:
- "I support these codecs and data formats"
- "I expect to receive data on these ports"
- "Here's my fingerprint for the encryption certificate"

**ICE candidates** — a list of network addresses to try, in order of preference:
```
candidate:1 udp 2122260223 192.168.1.5  54321  ← your LAN IP (fastest, same network)
candidate:2 udp 1686052607 203.0.113.42 54321  ← your public IP (via STUN)
candidate:3 tcp 1518280447 203.0.113.42 443    ← TCP fallback
```

The two browsers try all candidate pairs and pick the best one that actually works.

---

## 5. Phase 3 — Transfer (pure P2P)

> **Analogy:** A highway opened between two cities. The city planner (server) helped build it,
> but now trucks (file chunks) drive on it directly with no toll booth.

Once the DataChannel is open the Markdrop server is completely out of the loop.
Everything below is **browser ↔ browser**, encrypted.

### Protocol

```
SENDER                                                    RECIPIENT
  │                                                            │
  │── { "type":"meta", name:"cat.mp4", size:52428800 }  ──────▶│
  │                       (file metadata, JSON string)         │
  │                                                            │
  │◀─ { "type":"start" } ────────────────────────────────────  │
  │                       (recipient clicked "Download")       │
  │                                                            │
  │── ArrayBuffer [64 KB] ───────────────────────────────────▶ │  offset: 0
  │── ArrayBuffer [64 KB] ───────────────────────────────────▶ │  offset: 65536
  │── ArrayBuffer [64 KB] ───────────────────────────────────▶ │  ...
  │       ↑                                                    │
  │   backpressure check:                                      │
  │   if (channel.bufferedAmount > 256 KB) → PAUSE             │
  │   wait for "bufferedamountlow" event  → RESUME             │
  │                                                            │
  │── ArrayBuffer [last partial chunk] ─────────────────────▶  │  offset: 52428800
  │                                                            │
  │                               received === meta.size ──────┤
  │                               new Blob(chunks) ────────────┤
  │                               URL.createObjectURL() ───────┤
  │                               <a>.click() ─────────────────┤ ← browser save dialog
```

### Chunking and backpressure (visualised)

```
FILE  [████████████████████████████████████████████████████]  50 MB
        ↓ split into 64 KB slices
      [▓▓][▓▓][▓▓][▓▓][▓▓][▓▓][▓▓]...  ×  800 chunks

SENDER SEND BUFFER (inside the browser):
  ┌────────────────────────────────────────────┐ 256 KB HIGH-WATER MARK
  │  [▓▓][▓▓][▓▓]                              │  ← buffer low, keep sending
  └────────────────────────────────────────────┘

  If buffer exceeds high-water mark:
  ┌─────────────────────────────────────────────────────────────┐
  │  [▓▓][▓▓][▓▓][▓▓][▓▓][▓▓][▓▓][▓▓][▓▓][▓▓]   FULL ⚠️         │
  └─────────────────────────────────────────────────────────────┘
         ↓  sender PAUSES (awaits "bufferedamountlow" event)
         ↓  browser drains buffer to recipient
  ┌──────────────────────────────┐
  │  [▓▓]  buffer drained ✅     │
  └──────────────────────────────┘
         ↓  sender RESUMES

Why this matters: without backpressure the sender would queue gigabytes
into the browser's internal buffer → tab crash / OOM on slow connections.
```

### Receiver assembly

```
RECIPIENT MEMORY DURING DOWNLOAD:
  chunks: [ ArrayBuffer, ArrayBuffer, ArrayBuffer, ... ]
  received counter: 0 → 65536 → 131072 → ... → 52428800

  When received >= meta.size:
  ┌──────────────────────────────────────────────────────────┐
  │  blob = new Blob(chunks, { type: "video/mp4" })          │
  │  url  = URL.createObjectURL(blob)                        │
  │  <a href=url download="cat.mp4">.click()                 │  ← OS save dialog
  │  setTimeout(() => URL.revokeObjectURL(url), 30000)       │  ← free memory
  └──────────────────────────────────────────────────────────┘
```

> ⚠️ **The entire file is held in RAM** on the recipient's side until the last byte arrives.
> This is the main practical size limit. See [File Size Limits](#8-file-size-limits).

---

## 6. Encryption & Privacy

Every byte of file data is encrypted **automatically and mandatorily** by the WebRTC spec.
You don't opt in — it's impossible to turn it off.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  WHAT IS ENCRYPTED AND HOW                                               │
│                                                                          │
│  Browser ────── TLS 1.3 ──────── api.markdrop.in  (HTTPS / WSS)          │
│  (signalling JSON: ~5–20 KB total, not the actual file)                  │
│                                                                          │
│  Browser ────── DTLS 1.2 ─────── Browser  (P2P file bytes)               │
│  (mandatory WebRTC transport encryption — equivalent to HTTPS)           │
│                                                                          │
│  ✅  File bytes:        encrypted (DTLS)                                 │
│  ✅  File metadata:     encrypted (DTLS, sent over DataChannel)          │
│  ✅  Signalling JSON:   encrypted (TLS)                                  │
│  🔍  Server CAN see:    room ID, IP addresses, timing                    │
│  🔒  Server CANNOT see: filename, file size, file contents               │
└──────────────────────────────────────────────────────────────────────────┘
```

| Property | Detail |
|----------|--------|
| **Transport encryption** | DTLS 1.2 mandatory by WebRTC spec — equivalent to HTTPS for all P2P traffic |
| **Server visibility** | Server only sees WebSocket connect/disconnect and relayed JSON (~20 KB). Zero file bytes. |
| **Room ID entropy** | 10 hex chars = 40 bits ≈ 1 trillion possible IDs. Not guessable by brute force. |
| **No persistence** | Rooms live only in Python process RAM. No database. Server restart kills all rooms. |
| **No authentication** | Anyone with the exact link can connect as guest — don't share publicly for sensitive files |

---

## 7. NAT Traversal — punching through firewalls

Most devices sit behind a **NAT** (Network Address Translation) — a router that hides
your real IP. WebRTC uses **ICE + STUN** to discover public IPs and establish
a direct path.

```
╔═══════════════════════════════════════════════════════════════════════════╗
║                        HOW ICE FINDS A PATH                               ║
╠═══════════════════════════════════════════════════════════════════════════╣
║                                                                           ║
║  Sender (192.168.1.5)                           Recipient                 ║
║  behind home router                             behind mobile hotspot     ║
║       │                                                 │                 ║
║       │── "what's my public IP?" ─▶ STUN SERVER ◀── same ──│              ║
║       │                         stun.l.google.com:19302    │              ║
║       │◀── "you are 203.0.113.1:54321"                     │              ║
║       │                                  "you are 198.51.100.5:8765" ─────│
║       │                                                 │                 ║
║       │  ICE tries these candidates (in priority order):│                 ║
║       │                                                 │                 ║
║       │  1. host:   192.168.1.5:54321  ──▶  ✗  (different networks)       ║
║       │  2. srflx:  203.0.113.1:54321  ──▶  ✓  (public IP, NAT punched!)  ║
║       │                                                 │                 ║
║       ╔═══════════════════════════════════════════════╗                   ║
║       ║      DIRECT CONNECTION ESTABLISHED  🎉        ║                   ║
║       ╚═══════════════════════════════════════════════╝                   ║
╚═══════════════════════════════════════════════════════════════════════════╝

  What about symmetric NAT (strict corporate / university networks)?

  Both sides are behind symmetric NAT → neither can reach the other directly.
  A TURN relay server is needed as a fallback — not currently configured.
  Connection will fail in this scenario (~5–10% of real-world cases).
```

**ICE candidate priority:**
```
1. host candidate   — direct LAN  (fastest, no relay)
2. srflx candidate  — STUN-reflexive public IP
3. relay candidate  — TURN relay  (fallback, not configured)
```

**Currently configured STUN servers** (`frontend/src/lib/webrtc.ts`):
- `stun:stun.l.google.com:19302`
- `stun:stun1.l.google.com:19302`

To add TURN fallback (fixes symmetric NAT):
```ts
// frontend/src/lib/webrtc.ts
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  // Add a TURN server:
  { urls: "turn:your-turn.example.com:3478", username: "user", credential: "pass" },
];
```

---

## 8. File Size Limits

The code imposes **no limit**. Practical limits come from the recipient's browser RAM:

```
SENDER memory usage:    tiny  ──  one 64 KB chunk at a time  (File.slice())
RECIPIENT memory usage:  BIG  ──  entire file in RAM until last byte arrives

┌────────────────────────────────────────────────────────────────────────┐
│  Device                  │  Safe limit    │  Why                       │
├────────────────────────────────────────────────────────────────────────┤
│  Desktop Chrome/Firefox  │  ~2 GB         │  V8/SpiderMonkey heap      │
│  Desktop Safari          │  ~1 GB         │  More conservative GC      │
│  iOS Safari              │  ~200–500 MB   │  Aggressive tab killing    │
│  Android Chrome          │  ~300–700 MB   │  Depends on device RAM     │
└────────────────────────────────────────────────────────────────────────┘
```

**Future improvement:** The [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API)
(`showSaveFilePicker()` + `createWritable()`) would stream chunks directly to disk,
removing the RAM limit entirely — but that API is unavailable on iOS Safari.

---

## 9. Limitations

| # | Limitation | Impact | Workaround |
|---|-----------|--------|-----------|
| 1 | **Sender tab must stay open** | Transfer dies if sender closes tab | Keep the tab open until bar completes |
| 2 | **One recipient at a time** | Second opener gets "link expired" | Reload `/share` to generate a new room for the next person |
| 3 | **No resume** | Connection drop = restart from byte 0 | Rare on stable connections |
| 4 | **Recipient buffers file in RAM** | Max file size ≈ device RAM | See [File Size Limits](#8-file-size-limits) |
| 5 | **No TURN server** | Symmetric NAT (~5–10% of networks) fails | Add TURN to `ICE_SERVERS` in `webrtc.ts` |
| 6 | **One file per session** | No folder / multi-file support | Share files one at a time |
| 7 | **Link is single-use** | Room cleaned up after transfer | Reload `/share` for a new link |
| 8 | **Rooms lost on server restart** | Active transfers interrupted | EC2 systemd restarts are infrequent |

---

## 10. Project Files — where the code lives

```
markdrop/
│
├── backend/
│   └── app/
│       ├── main.py                     ← registers share_router at startup
│       └── routers/
│           └── share.py                ← WebSocket signalling relay
│                                          _rooms dict, relay logic, cleanup
│
└── frontend/src/
    ├── lib/
    │   └── webrtc.ts                   ← shared utilities
    │                                      ICE_SERVERS config
    │                                      generateRoomId()  (crypto.getRandomValues)
    │                                      formatBytes()
    │                                      getWsUrl()        (wss in prod, ws in dev)
    │                                      sendFileOverChannel()  (chunker + backpressure)
    │
    └── app/
        ├── layout.tsx                  ← "Share file" button in nav header
        └── share/
            ├── page.tsx                ← Sender UI
            │                              phases: idle → waiting → connecting →
            │                                      awaiting-start → transferring → done → error
            │                              opens WS as host
            │                              creates RTCPeerConnection on "guest-joined"
            │                              calls sendFileOverChannel() on "start"
            └── [id]/
                ├── page.tsx            ← SSR wrapper, passes roomId as prop
                └── DownloadView.tsx    ← Recipient UI
                                           phases: connecting → ready → downloading →
                                                   done → no-host → error
                                           opens WS as guest
                                           ondatachannel → receives chunks
                                           assembles Blob → browser save dialog
```

---

## 11. WebSocket API Reference

**Endpoint:** `wss://api.markdrop.in/ws/share/{room_id}?role={host|guest}`

> **nginx requirement:** The `/ws/` location block must include `proxy_http_version 1.1`
> and `proxy_set_header Upgrade $http_upgrade` — without these, nginx defaults to HTTP/1.0,
> strips the upgrade header, and FastAPI returns 404. Full nginx config in
> [README.md → Deployment](README.md#deployment).

### Connection rules

| Role | Behaviour |
|------|-----------|
| `host` (first to connect) | Room created. WS stays open waiting for a guest. |
| `host` (room already has a host) | WS closed immediately with code `4000`. |
| `guest` (host present) | `{"type":"guest-joined"}` sent to host. Relay mode begins. |
| `guest` (no host in room) | `{"type":"no-host"}` sent to guest, WS closed with code `4001`. |

### All message types

```jsonc
// ── Sent by the SERVER itself ─────────────────────────────────────────────

// → host: a recipient has arrived
{ "type": "guest-joined" }

// → guest: room has no host (link expired / sender closed tab)
{ "type": "no-host" }

// → either peer: the other side disconnected
{ "type": "peer-disconnected" }


// ── Relayed through the server (sender ↔ recipient) ───────────────────────

// host → guest: WebRTC session description (offer)
{ "type": "offer",  "sdp": { "type": "offer",  "sdp": "v=0\r\n…" } }

// guest → host: WebRTC session description (answer)
{ "type": "answer", "sdp": { "type": "answer", "sdp": "v=0\r\n…" } }

// either → other: ICE network address candidate (trickle ICE)
{ "type": "ice", "candidate": { "candidate": "candidate:…", "sdpMid": "0", "sdpMLineIndex": 0 } }


// ── Sent over the DataChannel (P2P — server never sees these) ─────────────

// host → guest: file metadata (JSON string)
{ "type": "meta", "name": "video.mp4", "size": 104857600, "mimeType": "video/mp4" }

// guest → host: recipient clicked "Download"
{ "type": "start" }

// host → guest: file content (binary ArrayBuffer frames)
// <ArrayBuffer: 65536 bytes>  ← chunk 1
// <ArrayBuffer: 65536 bytes>  ← chunk 2
// …
// <ArrayBuffer: N bytes>      ← last partial chunk  (N = size % 65536)
```

### WebSocket close codes

| Code | Meaning |
|------|---------|
| `4000` | Duplicate host tried to connect |
| `4001` | Guest connected but no host was present |
| `4002` | Invalid `role` query parameter |

---

*See also: [README.md](README.md) · [SCALING.md](SCALING.md)*

