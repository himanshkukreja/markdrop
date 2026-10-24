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
5. A sender that connects with ``v=2`` gets a multi-guest room: up to
   MAX_GUESTS recipients at once, each given a ``gid``. Guest → host messages
   are tagged with it; host → guest messages carry it and are routed by it
   (and stripped of it). A version-1 sender (the Go CLI) keeps one guest at a
   time — a second is told ``room-busy`` rather than replacing the first,
   which used to make the sender renegotiate and kill the transfer in flight.
6. Host sends ``bye`` → every guest is told ``room-closed`` immediately.
   A guest leaving → host gets ``peer-disconnected`` (with its gid); the host
   leaving → every guest does. The room goes when it is empty.

Clients send ``{"type": "ping"}`` every ~25 s so nginx's idle timeout never
closes a sender who is still waiting for someone to open the link. Pings are
answered by nothing and relayed to no one.
"""

import json
import re
import secrets
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
# Recipients downloading at once from one sender. Each is a separate peer
# connection on the sender's device sharing its upload; past this the sender's
# browser and bandwidth, not the protocol, are the limit.
MAX_GUESTS = 10

# Close codes (4000-4999 are application-defined).
CLOSE_DUPLICATE_HOST = 4000
CLOSE_NO_HOST = 4001
CLOSE_BAD_ROLE = 4002
CLOSE_ROOM_BUSY = 4003
CLOSE_BAD_ROOM = 4004
CLOSE_SERVER_FULL = 4005
CLOSE_ROOM_FULL = 4006
# The sender reconnected (same host key) and this older socket was replaced.
CLOSE_REPLACED = 4007

# A browser sender proves it owns a room with a random key it made when the share
# started (`hk`, 32 hex). Only its hash is kept. With it, a sender whose socket
# dropped (a network blip, a phone suspending the tab) takes the room straight
# back instead of being refused as a duplicate host until the old socket times
# out, which used to leave recipients unpaired for up to ~40 s. Without the key,
# knowing the room id (it's in the share link) is not enough to become the host.
_HOST_KEY = re.compile(r"^[A-Fa-f0-9]{32,64}$")


# How long an empty room keeps its owner's key after the sender's socket goes, so a
# phone that suspended the tab can come back to the same link.
KEY_HOLD_SECONDS = 600


def _sweep() -> None:
    """Forget keyed rooms whose sender has been gone longer than KEY_HOLD_SECONDS."""
    import time

    cutoff = time.monotonic() - KEY_HOLD_SECONDS
    for rid, r in list(_rooms.items()):
        if r["host"] is None and not r["guests"] and r.get("left_at") and r["left_at"] < cutoff:
            _rooms.pop(rid, None)


def room_snapshot(room_id: str) -> dict | None:
    """What a new recipient would find in a room right now, read-only.

    ``host_online``: a sender socket is connected. ``held``: no sender, but the
    room still keeps its owner's key, so recipients may join and wait for the
    sender to come back. ``guests``: recipients connected now. ``multi``: a
    version-2 (multi-recipient) sender. None when there is no room, which is
    also what a held room past KEY_HOLD_SECONDS amounts to (the next connection
    sweeps it). Never creates or changes a room.
    """
    import time

    room = _rooms.get(room_id)
    if room is None:
        return None
    host_online = room["host"] is not None
    guests = len(room["guests"])
    held = not host_online and bool(room.get("key"))
    left_at = room.get("left_at")
    if held and not guests and left_at and left_at < time.monotonic() - KEY_HOLD_SECONDS:
        return None
    return {"host_online": host_online, "held": held, "guests": guests,
            "multi": bool(room.get("multi"))}


def _key_hash(hk: str) -> str:
    import hashlib

    return hashlib.sha256(hk.encode()).hexdigest()


async def _consume_share_metadata(
    data: str, room_id: str, host_ip_hash: str | None, *, record: bool
) -> str | None:
    """If ``data`` carries the opaque metadata blob, return the message with the
    blob removed, logging the share first when ``record`` is set. Returns None
    otherwise so the caller relays the original text untouched.
    """
    try:
        msg = json.loads(data)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(msg, dict) or share_event.BLOB_FIELD not in msg:
        return None

    blob = msg.pop(share_event.BLOB_FIELD)
    if not record:
        return json.dumps(msg)
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
    v: int = Query(1),
    hk: str | None = Query(None, max_length=64),
) -> None:
    await websocket.accept()

    if not _ROOM_ID.match(room_id):
        await websocket.close(code=CLOSE_BAD_ROOM)
        return
    if role not in ("host", "guest"):
        await websocket.close(code=CLOSE_BAD_ROLE)
        return
    _sweep()
    if room_id not in _rooms and len(_rooms) >= MAX_ROOMS:
        await websocket.close(code=CLOSE_SERVER_FULL)
        return

    room = _rooms.setdefault(room_id, {"host": None, "multi": False, "guests": {}, "key": None})
    guests: dict[str, WebSocket] = room["guests"]

    # Hash the sharer's IP once (server-side only; never echoed to any client).
    host_ip_hash = _hash_ip(get_client_ip(websocket)) if role == "host" else None
    logged = False  # record at most one share-event per host connection
    gid = ""

    if role == "host":
        key = _key_hash(hk) if hk and _HOST_KEY.match(hk) else None
        owner = room.get("key")
        if owner is not None and key != owner:
            # The room belongs to a sender that holds a key; nobody else may host it,
            # even while that sender is away.
            await websocket.close(code=CLOSE_DUPLICATE_HOST)
            return
        if room["host"] is not None:
            if owner is None or key != owner:
                await websocket.close(code=CLOSE_DUPLICATE_HOST)
                return
            # The same sender is back on a new socket while the old one has not been
            # reaped yet: the old one is dead or about to be. Hand the room over.
            stale = room["host"]
            room["host"] = None
            try:
                await stale.close(code=CLOSE_REPLACED)
            except Exception:
                pass
        if owner is None and key is not None:
            room["key"] = key
        room["host"] = websocket
        room.pop("left_at", None)
        room["multi"] = v >= 2
        await _send(websocket, {"type": "config", "iceServers": await turn.get_ice_servers()})
        # Guests that survived the host's signalling reconnect are still
        # waiting; tell the returning host so it can renegotiate with each.
        for g in list(guests):
            await _send(websocket, _addressed({"type": "guest-joined"}, g, room))

    else:  # guest
        if room["host"] is None and not room.get("key"):
            await _send(websocket, {"type": "no-host"})
            await websocket.close(code=CLOSE_NO_HOST)
            if not guests:
                _rooms.pop(room_id, None)
            return
        if guests and not room["multi"]:
            # A version-1 sender (the Go CLI) talks to one peer and can't tell
            # two apart.
            await _send(websocket, {"type": "room-busy"})
            await websocket.close(code=CLOSE_ROOM_BUSY)
            return
        if len(guests) >= MAX_GUESTS:
            await _send(websocket, {"type": "room-full"})
            await websocket.close(code=CLOSE_ROOM_FULL)
            return
        gid = secrets.token_hex(4)
        guests[gid] = websocket
        # Config strictly before guest-joined: the host answers guest-joined
        # with an offer, and the guest needs its ICE servers to answer that.
        await _send(websocket, {"type": "config", "iceServers": await turn.get_ice_servers()})
        if room["host"] is None:
            # A held room: the sender's socket dropped (often a phone suspending the
            # tab while the link is being shared). Wait here; the sender is told
            # about every waiting guest the moment it reconnects.
            await _send(websocket, {"type": "peer-disconnected"})
        else:
            await _send(room["host"], _addressed({"type": "guest-joined"}, gid, room))

    try:
        while True:
            data = await websocket.receive_text()
            if _is_ping(data):
                continue

            if role == "guest":
                host = room["host"]
                if host is not None:
                    if room["multi"]:
                        data = _with_gid(data, gid)
                    try:
                        await host.send_text(data)
                    except Exception:
                        pass
                continue

            # ── host ──
            # The sharer folds share metadata into the offer as one opaque blob.
            # Decode + log it server-side, then strip it so the relayed message
            # the recipient receives is a plain offer — the attribution never
            # leaves this hop. Every host message is stripped; only the first
            # blob is logged.
            cleaned = await _consume_share_metadata(
                data, room_id, host_ip_hash, record=not logged
            )
            if cleaned is not None:
                logged = True
                data = cleaned

            target, data, bye = _route_from_host(data, room)
            if bye:
                # The sender ended the share. Everyone still waiting or
                # downloading hears it now, not when a timeout runs out. A
                # stopped sender never comes back, so drop its key too: the room
                # goes when the sender's socket does, instead of being held for
                # KEY_HOLD_SECONDS with late recipients waiting on nobody.
                room["key"] = None
                for g in list(guests.values()):
                    await _send(g, {"type": "room-closed"})
                continue
            peer = guests.get(target) if target else None
            if peer is not None:
                try:
                    await peer.send_text(data)
                except Exception:
                    pass
    except WebSocketDisconnect:
        pass
    finally:
        # Only vacate a slot if it is still ours. A socket that was refused or
        # replaced must not evict whoever holds the slot now.
        if role == "host":
            if room["host"] is websocket:
                room["host"] = None
                for g in list(guests.values()):
                    await _send(g, {"type": "peer-disconnected"})
        elif guests.get(gid) is websocket:
            del guests[gid]
            await _send(room["host"], _addressed({"type": "peer-disconnected"}, gid, room))
        if room["host"] is None and not guests:
            if room.get("key"):
                # Hold the room (and its owner's key) for a while: the sender may be back.
                import time

                room["left_at"] = time.monotonic()
            else:
                _rooms.pop(room_id, None)


def _addressed(msg: dict, gid: str, room: dict) -> dict:
    """Tag a message for the host with the guest it concerns — only in a
    multi-guest room; a version-1 host has no use for (or idea of) the tag."""
    return {**msg, "gid": gid} if room["multi"] else msg


def _with_gid(data: str, gid: str) -> str:
    try:
        msg = json.loads(data)
    except ValueError:
        return data
    if not isinstance(msg, dict):
        return data
    msg["gid"] = gid
    return json.dumps(msg)


def _route_from_host(data: str, room: dict) -> tuple[str | None, str, bool]:
    """Which guest a host message is for, the message as that guest should get
    it, and whether it was the host's goodbye."""
    try:
        msg = json.loads(data)
    except ValueError:
        msg = None
    if isinstance(msg, dict) and msg.get("type") == "bye":
        return None, data, True
    if not room["multi"]:
        # Version 1: there is at most one guest; everything goes to it.
        return next(iter(room["guests"]), None), data, False
    if not isinstance(msg, dict):
        return None, data, False
    target = msg.pop("gid", None)
    return (target if isinstance(target, str) else None), json.dumps(msg), False


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


# ── Transfer speed ────────────────────────────────────────────────────────────
# Reported by the recipient once a batch of files has landed: how many bytes,
# how long, and whether the bytes went direct or through the TURN relay. It is
# the number that says whether "relayed" is fast enough, and what relaying
# costs (Cloudflare bills relayed bytes).

class ShareTransfer(BaseModel):
    room_id: str = Field(..., pattern=_ROOM_ID.pattern)
    bytes: int = Field(..., ge=0, le=10**13)
    ms: int = Field(..., ge=1, le=24 * 3600 * 1000)
    files: int = Field(..., ge=1, le=100_000)
    route: Literal["direct", "relay"] | None = None
    protocol: int = Field(1, ge=1, le=99)


@router.post("/api/v1/share/transfer", status_code=204)
@limiter.limit("60/minute")
async def report_transfer(request: Request, body: ShareTransfer) -> None:
    try:
        await get_database()["share_transfers"].insert_one(
            {**body.model_dump(), "ts": datetime.now(timezone.utc)}
        )
    except Exception:
        pass
