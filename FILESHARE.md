# Markdrop — P2P File Share

Serverless, peer-to-peer file transfer built on top of WebRTC DataChannels.
The sender's file bytes **never touch the Markdrop server** — they travel directly
between the two browsers over an encrypted WebRTC connection.

---

## How to use it

1. Go to `markdrop.in/share`
2. Drop a file onto the page (or click to browse) — any file type, any size
3. A unique share link is generated instantly: `markdrop.in/share/<10-char-id>`
4. Copy and send the link to the recipient (chat, email, anywhere)
5. Recipient opens the link → sees the filename + size → clicks **Download**
6. File streams directly from your browser to theirs — no upload to a server
7. **Keep your tab open** until the download completes on the other end

---

## Architecture

```
Sender browser                   api.markdrop.in                 Recipient browser
──────────────────               ─────────────────               ─────────────────
WS /ws/share/<id>?role=host  ──→  room[id].host = ws
                                                                 ←── WS /ws/share/<id>?role=guest
                             ←── {"type":"guest-joined"} relay
createOffer                  ──→ {"type":"offer", sdp:…} relay   ──→ setRemoteDescription
                             ←── {"type":"answer",sdp:…} relay   ←── createAnswer
                             ←── {"type":"ice", …}       relay   ←── ICE candidates
ICE candidates               ──→ {"type":"ice", …}       relay   ──→

    ════════════ RTCPeerConnection + DataChannel established ════════════
                  ↓ server is completely out of the loop ↓
    sender.channel.send(chunk)  ─────── P2P ──────→  receiver.channel.onmessage
    (64 KB chunks, ordered, with backpressure control)
```

### Signalling phase (server IS involved — tiny JSON only)

The signalling server lives at `backend/app/routers/share.py`.
It maintains an in-memory dictionary:

```python
_rooms: dict[str, dict] = {
    "<room_id>": { "host": WebSocket | None, "guest": WebSocket | None }
}
```

It does nothing except forward raw JSON text from one peer's WebSocket to the
other. The complete set of messages it relays:

| Message type       | Direction    | Purpose                                          |
|--------------------|--------------|--------------------------------------------------|
| `guest-joined`     | server → host | Recipient has opened the link                   |
| `offer`            | host → guest | SDP offer (WebRTC session description)           |
| `answer`           | guest → host | SDP answer                                       |
| `ice`              | both ways    | ICE candidates (IP/port discovery packets)       |
| `no-host`          | server → guest | Sent immediately if the room has no host        |
| `peer-disconnected`| server → peer | Sent when the other WebSocket closes            |

**Total signalling data per transfer:** ~5–20 KB of JSON regardless of file size.

Room cleanup: when both WebSockets close, the room entry is deleted from memory.
No rooms persist across server restarts.

---

### WebRTC handshake (step by step)

```
1.  Sender opens /share
    → browser calls generateRoomId()  →  10-char hex (crypto.getRandomValues)
    → opens WebSocket as "host"
    → waits

2.  Recipient opens /share/<id>
    → opens WebSocket as "guest"
    → server writes {"type":"guest-joined"} to host WS

3.  Host browser receives "guest-joined"
    → new RTCPeerConnection({ iceServers: [stun:stun.l.google.com:19302, …] })
    → createDataChannel("file", { ordered: true })
    → createOffer()  →  setLocalDescription(offer)
    → sends {"type":"offer", sdp: localDescription} through relay

4.  Guest browser receives "offer"
    → new RTCPeerConnection(…)
    → setRemoteDescription(offer)
    → createAnswer()  →  setLocalDescription(answer)
    → sends {"type":"answer", sdp: localDescription} back through relay

5.  Both sides exchange ICE candidates through relay (trickle ICE)
    Each candidate is a JSON object: { candidate, sdpMid, sdpMLineIndex }

6.  ICE negotiation completes
    → DTLS handshake (automatic, provides encryption)
    → DataChannel "open" event fires on both sides

7.  DataChannel is open — signalling server is no longer needed
    (WebSockets stay open only for "peer-disconnected" notification)
```

---

### Data transfer phase (server NOT involved)

Once the DataChannel opens the protocol uses two message types:

**Control messages (JSON strings)**

```
host → guest:  { "type": "meta", "name": "video.mp4", "size": 104857600, "mimeType": "video/mp4" }
guest → host:  { "type": "start" }
```

**File chunks (binary `ArrayBuffer`)**

```
host → guest:  <64 KB ArrayBuffer>
host → guest:  <64 KB ArrayBuffer>
...
host → guest:  <final partial chunk>
```

**Backpressure control** (`frontend/src/lib/webrtc.ts → sendFileOverChannel`):

```
BUFFER_HIGH = 256 KB

while (bytes remaining):
    if channel.bufferedAmount > BUFFER_HIGH:
        await waitFor(bufferedamountlow event)   ← suspends, doesn't busy-loop
    slice = file.slice(offset, offset + 64 KB)
    channel.send(await slice.arrayBuffer())
    offset += 64 KB
    onProgress(offset)
```

This ensures the browser's internal DataChannel send buffer never exceeds 256 KB,
preventing OOM crashes on slow connections or large files.

**Receiver assembly** (`DownloadView.tsx`):

```
chunks: ArrayBuffer[]  ←  pushed on every onmessage event
received += chunk.byteLength

when received >= meta.size:
    blob = new Blob(chunks, { type: meta.mimeType })
    url  = URL.createObjectURL(blob)
    <a href=url download=meta.name>.click()     ← browser save dialog
    setTimeout(() => URL.revokeObjectURL(url), 30s)
```

---

## File size limits

There is **no limit enforced by the code**. The practical limits are set by
the recipient's browser/device RAM, because the entire file is held in memory
as an `ArrayBuffer[]` array until the last byte arrives, then assembled into
a `Blob` before the browser save dialog appears.

| Environment        | Practical safe limit | Notes                                         |
|--------------------|----------------------|-----------------------------------------------|
| Desktop (Chrome)   | ~2 GB                | V8 heap limit; larger files may crash the tab |
| Desktop (Firefox)  | ~2 GB                | Similar SpiderMonkey limit                    |
| Desktop (Safari)   | ~1 GB                | More conservative memory management           |
| Mobile (iOS Safari)| ~200–500 MB          | Limited RAM, aggressive tab killing           |
| Mobile (Chrome Android) | ~300–700 MB    | Depends on device RAM                         |

**Sender RAM usage is minimal**: the sender reads the file in 64 KB slices using
`File.slice()` → `arrayBuffer()`, so only one chunk at a time is held in JS memory
regardless of file size.

**Future improvement**: streaming the received chunks directly to the filesystem
via the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API)
(`createWritable()`) would remove the receiver RAM limit entirely — but that API
is not available on iOS Safari.

---

## Encryption & privacy

| Property | Detail |
|----------|--------|
| **Transport encryption** | All WebRTC DataChannel traffic is encrypted with DTLS 1.2/1.3 (mandatory by spec) + SRTP. Equivalent to HTTPS. |
| **Server visibility** | The FastAPI server only sees the signalling JSON (~5–20 KB total). Zero file bytes pass through it. |
| **Link security** | The room ID is 10 hex chars = 40 bits of entropy (~1 trillion IDs). Not guessable by brute force in practice. |
| **No persistence** | Rooms exist only in the server process's RAM. No database writes. Restarting the server kills all active rooms. |
| **No authentication** | Anyone with the exact link can connect as a guest. Don't share the link publicly if the file is sensitive. |

---

## NAT traversal & connectivity

WebRTC uses ICE (Interactive Connectivity Establishment) to punch through NATs:

```
Priority order:
1. host candidate     — direct LAN connection (fastest, no relay needed)
2. srflx candidate    — STUN-reflexive (public IP discovered via STUN server)
3. relay candidate    — TURN relay (fallback, not configured)
```

**Currently configured STUN servers** (`frontend/src/lib/webrtc.ts`):
- `stun:stun.l.google.com:19302`
- `stun:stun1.l.google.com:19302`

**Works in most cases:** home routers, mobile hotspots, most corporate NATs
(as long as UDP is not completely blocked).

**Will NOT work without a TURN server in these scenarios:**
- Symmetric NAT on both sides simultaneously (some enterprise/university networks)
- Strict firewall rules that block all UDP

If you encounter connectivity failures you can add a TURN server to `ICE_SERVERS`
in `frontend/src/lib/webrtc.ts`:

```ts
{ urls: "turn:your-turn-server.com:3478", username: "user", credential: "pass" }
```

---

## Limitations

| # | Limitation | Detail |
|---|-----------|--------|
| 1 | **Sender must stay online** | The file is streamed live from the sender's browser. If they close the tab or lose internet mid-transfer, the download fails. There is no resume. |
| 2 | **One recipient at a time** | The signalling room has exactly one host slot and one guest slot. A second person opening the link while a transfer is active will see "no-host" (host slot is taken). |
| 3 | **One transfer per link** | Each room ID is used once. After the transfer is done the room is cleaned up. To send the same file again, reload `/share` to get a new room ID. |
| 4 | **Receiver buffers entire file in RAM** | The recipient holds all received chunks in JS memory before saving. See [File size limits](#file-size-limits) above. |
| 5 | **No TURN server configured** | ~5–10% of connections fail due to symmetric NAT (see above). Adding a TURN server would fix this. |
| 6 | **No resume / partial download** | If the connection drops mid-transfer, the recipient must restart from byte 0. |
| 7 | **Link expires when sender closes tab** | There is no concept of a persistent upload. The room only exists while the sender's WebSocket is connected. |
| 8 | **Single file only** | Only one file can be selected per session. Directory / multi-file uploads are not supported. |
| 9 | **Server process memory** | Active room state lives in `_rooms` dict (Python process RAM). On server restart all rooms are lost. Under very high concurrent use this dict could grow, but each room entry is a few hundred bytes — negligible until tens of thousands of simultaneous rooms. |

---

## Project files

```
backend/
└── app/
    ├── main.py                        ← includes share_router
    └── routers/
        └── share.py                   ← WebSocket signalling server

frontend/src/
├── lib/
│   └── webrtc.ts                      ← ICE config, room ID gen, chunk sender
└── app/
    └── share/
        ├── page.tsx                   ← Sender / uploader UI
        └── [id]/
            ├── page.tsx               ← SSR wrapper (passes roomId as prop)
            └── DownloadView.tsx       ← Recipient / downloader UI
```

---

## WebSocket API reference

**Endpoint:** `wss://api.markdrop.in/ws/share/{room_id}?role={host|guest}`

### Connection rules

| Role | Behaviour if already occupied | Behaviour if room has no host (guest only) |
|------|-----------------------------|---------------------------------------------|
| `host` | WS closed with code `4000` | Room created, waits for guest |
| `guest` | Second guest can connect after first disconnects | `{"type":"no-host"}` sent, WS closed with `4001` |

### Message catalogue

All messages are UTF-8 JSON text frames.

```jsonc
// Server → host: recipient arrived
{ "type": "guest-joined" }

// Host → server → guest: WebRTC offer
{ "type": "offer", "sdp": { "type": "offer", "sdp": "v=0\r\no=…" } }

// Guest → server → host: WebRTC answer
{ "type": "answer", "sdp": { "type": "answer", "sdp": "v=0\r\no=…" } }

// Either → server → other: ICE candidate (trickle)
{ "type": "ice", "candidate": { "candidate": "candidate:…", "sdpMid": "0", "sdpMLineIndex": 0 } }

// Server → peer: other side disconnected
{ "type": "peer-disconnected" }

// Server → guest: no host in this room
{ "type": "no-host" }
```

### DataChannel messages (after P2P is established — not through server)

```jsonc
// Host → guest: file metadata (string frame)
{ "type": "meta", "name": "photo.jpg", "size": 2097152, "mimeType": "image/jpeg" }

// Guest → host: start transfer (string frame)
{ "type": "start" }

// Host → guest: file data (binary ArrayBuffer frames, 65536 bytes each)
<ArrayBuffer>
```
