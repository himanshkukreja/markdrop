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

router = APIRouter(tags=["share"])

# In-memory signalling rooms.
# Structure: { room_id: {"host": WebSocket | None, "guest": WebSocket | None} }
_rooms: dict[str, dict] = {}


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
