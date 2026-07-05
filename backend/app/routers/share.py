"""Lightweight WebSocket signalling server for peer-to-peer file transfers.

The server never sees any file data — it only relays small JSON messages
(SDP offer/answer, ICE candidates, and a handful of control signals)
between two browser peers so they can establish a direct WebRTC DataChannel.

Room lifecycle
--------------
1. Uploader (host) opens the share page → browser connects as "host".
2. Recipient opens the share URL → browser connects as "guest".
3. Server sends {"type": "guest-joined"} to host.
4. Host creates RTCPeerConnection + DataChannel, generates offer, sends it
   through the relay → server forwards it to guest.
5. Guest creates answer, sends it back → server forwards to host.
6. Both sides exchange ICE candidates through the relay.
7. Direct P2P DataChannel is established; from this point the server is
   completely out of the picture — all file bytes flow peer-to-peer.
8. Either peer disconnects → the other receives {"type": "peer-disconnected"};
   the room is deleted when both slots are empty.
"""

import json

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from app.database import get_database
from app.services import share_event
from app.services.analytics import _hash_ip
from app.utils.net import get_client_ip

router = APIRouter(tags=["share"])

# In-memory signalling rooms.
# Structure: { room_id: {"host": WebSocket | None, "guest": WebSocket | None} }
_rooms: dict[str, dict] = {}


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
            ip_hash=host_ip_hash,
        )
    except Exception:
        # Logging must never break the transfer — swallow and relay anyway.
        pass
    return json.dumps(msg)


@router.websocket("/ws/share/{room_id}")
async def signaling_ws(
    websocket: WebSocket,
    room_id: str,
    role: str = Query("host"),
) -> None:
    await websocket.accept()

    if room_id not in _rooms:
        _rooms[room_id] = {"host": None, "guest": None}

    room = _rooms[room_id]

    # Hash the sharer's IP once (server-side only; never echoed to any client).
    host_ip_hash = _hash_ip(get_client_ip(websocket)) if role == "host" else None
    logged = False  # record at most one share-event per host connection

    if role == "host":
        if room["host"] is not None:
            # Duplicate host — reject
            await websocket.close(code=4000)
            return
        room["host"] = websocket

    elif role == "guest":
        if room["host"] is None:
            # No host present — tell the client immediately and close
            await websocket.send_text(json.dumps({"type": "no-host"}))
            await websocket.close(code=4001)
            return
        room["guest"] = websocket
        # Notify the host that a recipient has arrived
        try:
            await room["host"].send_text(json.dumps({"type": "guest-joined"}))
        except Exception:
            pass

    else:
        await websocket.close(code=4002)
        return

    peer_key = "guest" if role == "host" else "host"

    try:
        while True:
            data = await websocket.receive_text()

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
        room[role] = None
        # Notify the other side that this peer has gone
        peer = room.get(peer_key)
        if peer is not None:
            try:
                await peer.send_text(json.dumps({"type": "peer-disconnected"}))
            except Exception:
                pass
        # Clean up empty room
        if not room["host"] and not room["guest"]:
            _rooms.pop(room_id, None)
