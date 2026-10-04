"""Lightweight WebSocket signalling server for peer-to-peer file transfers.

The server never sees any file data — it only relays small JSON messages
(SDP offer/answer, ICE candidates, and a handful of control signals)
between two peers so they can establish a direct WebRTC DataChannel.

Room lifecycle
--------------
1. Sender (host) opens the share page → connects as "host".
2. Every socket is sent ``{"type": "config", "iceServers": [...]}`` first, so
   it knows its STUN/TURN servers before it needs them.
3. Recipient opens the share URL → connects as "guest"; the host is sent
   ``{"type": "guest-joined"}``.
4. Offer, answer and ICE candidates are relayed verbatim until a DataChannel
   opens; from then on every file byte flows peer-to-peer (or through the TURN
   relay when no direct path exists — still DTLS-encrypted end to end).
5. A room holds one guest at a time. A second guest is told ``room-busy``
   rather than replacing the first — replacing it used to make the sender
   renegotiate with the newcomer and kill the transfer already in flight.
6. Either peer disconnects → the other receives ``peer-disconnected``; the
   room is deleted when both slots are empty.

Clients send ``{"type": "ping"}`` every ~25 s so nginx's idle timeout never
closes a sender who is still waiting for someone to open the link. Pings are
answered by nothing and relayed to no one.
"""

import json
import re
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Query, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.services import share_event, turn
from app.services.analytics import _hash_ip
from app.utils.net import get_client_ip

router = APIRouter(tags=["share"])

# In-memory signalling rooms. Single uvicorn worker by design (see CONTEXT.md):
# both slots of a room must live in the same process.
# Structure: { room_id: {"host": WebSocket | None, "guest": WebSocket | None} }
_rooms: dict[str, dict] = {}

# Browser and CLI both generate 10 hex chars; allow a little latitude for
# future formats, but nothing that could be used to stuff memory or logs.
_ROOM_ID = re.compile(r"^[A-Za-z0-9_-]{6,64}$")
# One process holds every room; bound it so a loop of fresh room ids cannot.
MAX_ROOMS = 5000

# Close codes (4000-4999 are application-defined).
CLOSE_DUPLICATE_HOST = 4000
CLOSE_NO_HOST = 4001
CLOSE_BAD_ROLE = 4002
CLOSE_ROOM_BUSY = 4003
CLOSE_BAD_ROOM = 4004
CLOSE_SERVER_FULL = 4005


async def _consume_share_metadata(
    data: str, room_id: str, host_ip_hash: str | None
) -> str | None:
    """If ``data`` is an offer carrying the opaque metadata blob, log the share
    and return the message with the blob removed. Returns None otherwise so the
    caller relays the original text untouched.
    """
    try:
        msg = json.loads(data)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(msg, dict) or share_event.BLOB_FIELD not in msg:
        return None

    blob = msg.pop(share_event.BLOB_FIELD)
    meta = share_event.decode_blob(blob) or {}
    try:
        db = get_database()
        user_id = await share_event.resolve_user_id(db, meta.get("t"))
        await share_event.record_share(
            db,
            room_id=room_id,
            user_id=user_id,
            file_name=meta.get("n"),
            file_size=meta.get("s"),
            mime_type=meta.get("m"),
            file_count=meta.get("c"),
            ip_hash=host_ip_hash,
        )
    except Exception:
        # Logging must never break the transfer — swallow and relay anyway.
        pass
    return json.dumps(msg)


def _is_ping(data: str) -> bool:
    # Cheap prefilter before parsing: pings are tiny and arrive every 25 s.
    if len(data) > 32 or "ping" not in data:
        return False
    try:
        return json.loads(data).get("type") == "ping"
    except (ValueError, AttributeError):
        return False


async def _send(ws: WebSocket | None, payload: dict) -> None:
    if ws is None:
        return
    try:
        await ws.send_text(json.dumps(payload))
    except Exception:
        pass


@router.websocket("/ws/share/{room_id}")
async def signaling_ws(
    websocket: WebSocket,
    room_id: str,
    role: str = Query("host"),
) -> None:
    await websocket.accept()

    if not _ROOM_ID.match(room_id):
        await websocket.close(code=CLOSE_BAD_ROOM)
        return
    if role not in ("host", "guest"):
        await websocket.close(code=CLOSE_BAD_ROLE)
        return
    if room_id not in _rooms and len(_rooms) >= MAX_ROOMS:
        await websocket.close(code=CLOSE_SERVER_FULL)
        return

    room = _rooms.setdefault(room_id, {"host": None, "guest": None})

    # Hash the sharer's IP once (server-side only; never echoed to any client).
    host_ip_hash = _hash_ip(get_client_ip(websocket)) if role == "host" else None
    logged = False  # record at most one share-event per host connection

    if role == "host":
        if room["host"] is not None:
            await websocket.close(code=CLOSE_DUPLICATE_HOST)
            return
        room["host"] = websocket
        await _send(websocket, {"type": "config", "iceServers": await turn.get_ice_servers()})
        # A guest that survived the host's signalling reconnect is still
        # waiting; tell the returning host so it can renegotiate.
        if room["guest"] is not None:
            await _send(websocket, {"type": "guest-joined"})

    else:  # guest
        if room["host"] is None:
            await _send(websocket, {"type": "no-host"})
            await websocket.close(code=CLOSE_NO_HOST)
            if room["guest"] is None:
                _rooms.pop(room_id, None)
            return
        if room["guest"] is not None:
            await _send(websocket, {"type": "room-busy"})
            await websocket.close(code=CLOSE_ROOM_BUSY)
            return
        room["guest"] = websocket
        # Config strictly before guest-joined: the host answers guest-joined
        # with an offer, and the guest needs its ICE servers to answer that.
        await _send(websocket, {"type": "config", "iceServers": await turn.get_ice_servers()})
        await _send(room["host"], {"type": "guest-joined"})

    peer_key = "guest" if role == "host" else "host"

    try:
        while True:
            data = await websocket.receive_text()
            if _is_ping(data):
                continue

            # The sharer folds share metadata into the offer as one opaque blob.
            # Decode + log it server-side, then strip it so the relayed message
            # the recipient receives is a plain offer — the attribution never
            # leaves this hop.
            if role == "host" and not logged:
                cleaned = await _consume_share_metadata(data, room_id, host_ip_hash)
                if cleaned is not None:
                    logged = True
                    data = cleaned

            peer = room.get(peer_key)
            if peer is not None:
                try:
                    await peer.send_text(data)
                except Exception:
                    pass
    except WebSocketDisconnect:
        pass
    finally:
        # Only vacate the slot if it is still ours. A socket that was refused
        # or replaced must not evict whoever holds the slot now.
        if room.get(role) is websocket:
            room[role] = None
            await _send(room.get(peer_key), {"type": "peer-disconnected"})
        if not room["host"] and not room["guest"]:
            _rooms.pop(room_id, None)


# ── Connection diagnostics ────────────────────────────────────────────────────
# "It doesn't work on some Wi-Fi" is unactionable without knowing which leg of
# ICE failed. Each browser reports, once per connection attempt, what kinds of
# candidates it gathered and which pair (if any) won. Types only — never an IP
# address — so this records the shape of a network, not who was on it.

CandidateType = Literal["host", "srflx", "prflx", "relay"]


class ShareRoute(BaseModel):
    local: CandidateType | None = None
    remote: CandidateType | None = None
    protocol: Literal["udp", "tcp"] | None = None
    relay_protocol: Literal["udp", "tcp", "tls"] | None = None
    rtt_ms: float | None = Field(None, ge=0, le=60_000)


class ShareDiagnostic(BaseModel):
    room_id: str = Field(..., pattern=_ROOM_ID.pattern)
    role: Literal["host", "guest"]
    outcome: Literal["connected", "failed", "timeout"]
    elapsed_ms: int = Field(..., ge=0, le=10 * 60_000)
    local_candidates: dict[CandidateType, int] = Field(default_factory=dict)
    remote_candidates: dict[CandidateType, int] = Field(default_factory=dict)
    route: ShareRoute | None = None
    turn_offered: bool = False
    states: list[str] = Field(default_factory=list, max_length=40)
    protocol: int = Field(1, ge=1, le=99)


@router.post("/api/v1/share/diagnostics", status_code=204)
@limiter.limit("30/minute")
async def report_diagnostic(request: Request, body: ShareDiagnostic) -> None:
    try:
        await get_database()["share_diagnostics"].insert_one(
            {
                **body.model_dump(),
                "states": [s[:24] for s in body.states],
                "user_agent": (request.headers.get("user-agent") or "")[:200],
                "ts": datetime.now(timezone.utc),
            }
        )
    except Exception:
        pass  # telemetry must never surface as an error to the person sharing
