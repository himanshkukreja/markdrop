# Markdrop — P2P File Sharing

> **Part of the Markdrop project** · [← Back to README](README.md) · [Scaling notes](SCALING.md)

Markdrop lets you send files — one, or a whole album — directly to another device, from a single link.
**No upload, no cloud storage, no size limit imposed by us.** The files travel straight from your device to
theirs, encrypted end-to-end, using a web technology called **WebRTC**. When two networks can't reach each other
directly, an encrypted relay (TURN) carries the bytes instead — it forwards ciphertext it cannot read.

---

## Table of Contents

1. [The Simple Version — what actually happens](#1-the-simple-version--what-actually-happens)
2. [The Big Picture — all pieces at once](#2-the-big-picture--all-pieces-at-once)
3. [Phase 1 — Connecting (Signalling)](#3-phase-1--connecting-signalling)
4. [Phase 2 — Handshake (WebRTC negotiation)](#4-phase-2--handshake-webrtc-negotiation)
5. [Phase 3 — Transfer](#5-phase-3--transfer)
6. [Encryption & Privacy](#6-encryption--privacy)
7. [NAT Traversal — STUN, then TURN](#7-nat-traversal--stun-then-turn)
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
| 1 | You drop files on `/share` | Browser opens a WebSocket to the Markdrop server, says "I'm a host in room `abc123`", and is told which STUN/TURN servers to use |
| 2 | A link appears: `markdrop.in/share/abc123` | That 10-character room ID is your rendezvous point |
| 3 | Your friend opens the link | Their browser connects to the same room as a "guest" |
| 4 | Both browsers exchange small setup messages | ~5–20 KB of JSON goes through the server — just enough to agree on connection details |
| 5 | "Establishing connection…" | Both browsers try to reach each other directly (using STUN to discover public IPs) |
| 6 | File list appears | An encrypted channel is open — direct, or via the relay. Your friend picks what to download |
| 7 | Files arrive one by one | 64 KB chunks stream across; each file is saved the moment it lands and acknowledged back |

> **Markdrop's server never sees your file's bytes.** It forwards ~20 KB of connection setup JSON. (It does
> log a share's file name, size and count for usage stats — see [Encryption & Privacy](#6-encryption--privacy).)

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
| `config` | Server itself | Both, first | The STUN/TURN servers to use (TURN credentials are short-lived) |
| `no-host` | Server itself | Recipient | "Nobody is sharing on this link right now" |
| `room-busy` | Server itself | A second recipient | "Someone else is receiving — one at a time" |
| `peer-disconnected` | Server itself | The other side | "The other side's *signalling* dropped" — not proof they left; see liveness |
| `ping` | Either → server | Nobody | Keep-alive every 25 s so nginx's idle timeout never strands a waiting sender |

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

## 5. Phase 3 — Transfer

> **Analogy:** A highway opened between two cities. The city planner (server) helped build it,
> but now trucks (file chunks) drive on it directly with no toll booth. If the cities have no road between
> them, a sealed ferry (TURN) carries the trucks — it can't open them.

Code: [`frontend/src/lib/p2p/`](frontend/src/lib/p2p/) — `protocol.ts` (messages), `signal.ts` (WebSocket),
`peer.ts` (RTCPeerConnection + diagnostics), `sender.ts`, `receiver.ts`, `zip.ts` (old-CLI fallback).

### Protocol versions

The recipient advertises its version as `v` on its signalling `answer`. A peer that says nothing is v1.

| | Version 1 — single file | Version 2 — many files, one session |
|---|---|---|
| Spoken by | Go CLI (current release) | Browser |
| Host → guest | `meta {name,size,mimeType,isFolder?}` | `manifest {files:[{id,name,size,mime}]}`, re-sent when files change |
| Guest → host | `start` | `request {ids}` (queued, sent in order) |
| Bytes | raw chunks until `size` reached | `file-start {id}` · chunks · `file-end {id}` |
| Completion | byte count | guest sends `ack {id}` once the file is stored — that is what "Delivered" means |

Compatibility, all four directions:
- **Browser → browser**: v2.
- **CLI → browser**: the browser accepts v1 `meta`.
- **Browser → CLI, one file**: the browser falls back to v1 `meta`.
- **Browser → CLI, several files**: v1 can carry one file, but the CLI unpacks one marked `isFolder`. So the
  browser streams a store-only ZIP (`zip.ts`, CRC-32 computed on the fly, exact size known up front) named
  `markdrop-files.zip`; the CLI extracts it to `markdrop-files/` and deletes the archive.

```
SENDER                                                     RECIPIENT
  │── manifest {files:[f0,f1,f2]} ───────────────────────────▶│  list shown
  │◀───────────────────────────────── request {ids:[f0,f1,f2]}│  "Download all"
  │── file-start {f0} · ▓▓▓▓▓▓ · file-end {f0} ─────────────▶│  f0 saved
  │◀──────────────────────────────────────────── ack {f0} ────│
  │── file-start {f1} · ▓▓▓▓▓▓▓▓▓▓ · file-end {f1} ─────────▶│  …
```

### Chunking and backpressure

- Chunks are **65 535 bytes**, not 65 536: pion (the CLI's WebRTC stack) reads into a `MaxUint16` buffer.
- The sender reads the file ~1 MiB at a time and slices chunks from memory.
- It pauses above **8 MiB** queued in the channel and resumes below **2 MiB**. (Chrome closes a channel
  whose queue passes 16 MiB.)

Measured in headless Chromium on loopback, the raw DataChannel ceiling is ~31 MB/s regardless of chunk size
(16 KB–256 KB) — the limit is the browser's SCTP stack, not this code. Real transfers are bound by the network.

### Liveness

`peer-disconnected` only means the other side's WebSocket closed — the data channel can be perfectly healthy.
But a peer that truly vanished (tab killed, laptop shut) leaves the channel looking open until ICE consent
fails ~30 s later. So on `peer-disconnected` with an open channel, a v2 peer sends `ping` over the channel and
declares the other side gone if **nothing at all** arrives within 6 s. Chunks in flight count as an answer.

### Receiver saving

Each file becomes a `Blob` when its `file-end` arrives and is handed to the page:
- **Desktop / Android**: downloads immediately (the browser may ask once to allow multiple downloads).
- **iOS**: Safari can't put a downloaded image in Photos, so files collect in the page and one tap opens the
  share sheet ("Save N Images"). Received images show thumbnails.

---

## 6. Encryption & Privacy

```
  Browser ── TLS 1.3 ──▶ api.markdrop.in          signalling JSON (~5–20 KB)
  Browser ═══ DTLS ═══▶ Browser                    file bytes, direct path
  Browser ═══ DTLS ═══▶ TURN relay ═══▶ Browser    file bytes, relayed path (relay sees ciphertext)
```

| Property | Detail |
|----------|--------|
| **Transport encryption** | DTLS, mandatory in WebRTC, end to end between the two browsers on both paths. A TURN relay forwards packets it cannot decrypt. |
| **What Markdrop's server sees** | Room id, connect/disconnect timing, and the relayed SDP/ICE (which contain IP addresses). |
| **What it records** | One `share_events` row per share: file name, total size, file count, MIME type, and the sender's user id when signed in (folded into the offer as an opaque blob, stripped before relaying). One `share_diagnostics` row per connection attempt: candidate *types* and the winning route — never IPs; expires after 90 days. |
| **Trust in signalling** | The DTLS fingerprints travel through our signalling server, so "end-to-end" assumes it relays them honestly. |
| **Room ID entropy** | 10 hex chars = 40 bits. Not guessable by brute force, but anyone *holding* the link can open it. |
| **No persistence** | Rooms live only in process memory. |

---

## 7. NAT Traversal — STUN, then TURN

ICE gathers three kinds of candidate and tries pairs in priority order:

```
1. host   — the device's own address (same network; Chrome hides it behind an mDNS name)
2. srflx  — public address learned from STUN
3. relay  — an address on the TURN relay (only used when nothing above works)
```

Why "it fails on some Wi-Fi, works on mobile data":

| Network trait | Breaks | Common on |
|---|---|---|
| Client isolation (devices can't see each other) | host↔host | office, hotel, campus, guest Wi-Fi |
| No NAT hairpinning | srflx↔srflx behind the same router | many home routers, carrier-grade NAT |
| UDP blocked except 53/443 | STUN itself, so no srflx at all | strict corporate firewalls |

Switching one device to mobile data puts the two on different networks, which sidesteps the first two. TURN
fixes all three, because both sides dial **out** to the relay — over UDP 3478, TCP 3478/80, or TLS on 443.

**Configured servers** come from the backend (`app/services/turn.py`), sent as the first signalling message:
- STUN: `stun.cloudflare.com:3478`, `stun.l.google.com:19302`
- TURN: Cloudflare Realtime, when `MARKDROP_CF_TURN_KEY_ID` / `MARKDROP_CF_TURN_API_TOKEN` are set. One credential
  set is minted per ~3 h (half its 6 h TTL), port-53 URLs are dropped (browsers block them), and a Cloudflare
  outage degrades to STUN-only rather than failing. Pricing: $0.05/GB after 1,000 GB/month free; ~50–100 Mbps
  per allocation.

**Debugging:** append `?relay=1` to `/share` or a receive link to force the relayed path.

**Diagnosing a network:** the admin *Feature usage* tab shows, for the last 30 days, how many rooms connected,
how many needed the relay, and how failures split — *no srflx candidate* (STUN unreachable) vs *srflx present but
no pair* (isolation / hairpin; only TURN fixes these).

---

## 8. File Size Limits

The sender reads files ~1 MiB at a time, so sending is not memory-bound. The **recipient** holds each file in
memory until it is assembled, and keeps received files available for re-saving until the page closes:

| Device | Comfortable total | Why |
|---|---|---|
| Desktop Chrome/Firefox | ~2 GB | Blob storage may spill to disk |
| Desktop Safari | ~1 GB | More conservative |
| iOS Safari | ~200–500 MB | Aggressive tab killing |
| Android Chrome | ~300–700 MB | Depends on device RAM |

Streaming to disk via `showSaveFilePicker` was tried and reverted (it starved WebRTC keepalives in Chrome).

---

## 9. Limitations

| # | Limitation | Notes |
|---|-----------|-------|
| 1 | **Sender tab must stay open** | The files live on the sender's device. |
| 2 | **One recipient at a time** | A second visitor sees "someone else is receiving"; the next can come once they leave. |
| 3 | **No resume within a file** | A dropped connection restarts the interrupted file; finished files are kept. |
| 4 | **Recipient holds files in memory** | See [File Size Limits](#8-file-size-limits). |
| 5 | **No integrity hash** | SCTP is reliable and DTLS authenticates every record; a byte-count check guards each file. |
| 6 | **Rooms live in one process** | A restart drops live connections; senders and waiting recipients reconnect on their own. |
| 7 | **Room squatting** | Once a sender leaves, anyone holding the link could open it as a new sender. |

---

## 10. Project Files — where the code lives

```
backend/app/
├── routers/share.py          signalling relay, room rules, POST /api/v1/share/diagnostics
├── services/turn.py          STUN/TURN list, Cloudflare credential minting + cache
├── services/share_event.py   usage logging (opaque blob on the offer)
└── routers/admin.py          feature-usage: share_connections health summary

frontend/src/
├── lib/webrtc.ts             ws URL, room id, formatting, fallback STUN list
├── lib/p2p/                  protocol, signalling socket, peer link, sender, receiver, zip
├── app/share/page.tsx        sender UI (multi-file session)
├── app/share/[id]/DownloadView.tsx   recipient UI
└── components/share/         FileIcon + RouteBadge, explainer, CLI guide

cli/internal/peer/            Go CLI host/guest (protocol v1)
```

---

## 11. WebSocket API Reference

**Endpoint:** `wss://api.markdrop.in/ws/share/{room_id}?role={host|guest}` — `room_id` must match
`[A-Za-z0-9_-]{6,64}`.

> **nginx requirement:** the `/ws/` location needs `proxy_http_version 1.1` and the `Upgrade`/`Connection`
> headers, or FastAPI returns 404. Its `proxy_read_timeout 3600s` is why clients ping every 25 s.

### Connection rules

| Role | Behaviour |
|------|-----------|
| `host`, room empty | Room created; sent `config`. |
| `host`, host present | Closed `4000` (a reconnecting client retries — the old socket may not be reaped yet). |
| `host`, guest waiting | Sent `config`, then `guest-joined` so it renegotiates. |
| `guest`, host present | Sent `config`; host sent `guest-joined`. |
| `guest`, no host | Sent `no-host`, closed `4001`. |
| `guest`, guest present | Sent `room-busy`, closed `4003`. |

### Close codes

| Code | Meaning |
|------|---------|
| `4000` | Duplicate host |
| `4001` | No host in the room |
| `4002` | Invalid `role` |
| `4003` | Room busy — one recipient at a time |
| `4004` | Invalid room id |
| `4005` | Server at its room limit |

### Diagnostics

`POST /api/v1/share/diagnostics` (30/min) — one per connection attempt from each browser:

```jsonc
{ "room_id": "abc123def4", "role": "guest", "outcome": "connected",   // | "failed" | "timeout"
  "elapsed_ms": 1840,
  "local_candidates": { "host": 2, "srflx": 1, "relay": 3 },
  "remote_candidates": { "host": 1, "srflx": 1 },
  "route": { "local": "relay", "remote": "srflx", "protocol": "udp", "relay_protocol": "tls", "rtt_ms": 42 },
  "turn_offered": true, "states": ["310:connecting", "1840:connected"], "protocol": 2 }
```

---

*See also: [README.md](README.md) · [SCALING.md](SCALING.md)*
