"""Live document updates over WebSocket.

``/ws/docs/{slug}?t=<read ticket>`` — a viewer's browser connects and receives
``{"type": "changed", "rev": N}`` when the document changes, ``{"type":
"access"}`` when who may read it narrowed (the server then closes the socket;
the page re-checks through the read path) and ``{"type": "gone"}`` when it was
deleted, expired or renamed away.

Subscribing follows the read rule (access policy §2.7): an anonymous-readable
document needs no ticket; anything else needs the ``read_ticket`` from a
successful GET, and a ticket minted before a narrowing no longer counts. A
caller without one is accepted but never receives anything — the same as a
socket on a slug that doesn't exist, so the socket is no existence oracle.

Routed under ``/ws/`` so the existing nginx WebSocket-upgrade block applies.
"""

import asyncio

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.database import get_database
from app.services import access, live, publicity, tickets

router = APIRouter(tags=["live"])


async def _admitted(slug: str, ticket: str | None) -> bool:
    db = get_database()
    raw = await db["documents"].find_one({"slug": slug})
    if raw is None or publicity.is_expired(raw):
        return False
    if tickets.valid_for(ticket, raw):
        return True
    return await access.anonymous_can_read(db, raw)


@router.websocket("/ws/docs/{slug}")
async def document_updates(websocket: WebSocket, slug: str) -> None:
    await websocket.accept()
    ticket = websocket.query_params.get("t")
    try:
        admitted = await _admitted(slug, ticket)
    except Exception:
        admitted = False
    queue = live.subscribe(slug) if admitted else None

    async def _pump() -> None:
        while True:
            event = await queue.get()
            if not isinstance(event, dict):  # legacy publishers sent a bare rev
                event = {"type": "changed", "rev": event}
            await websocket.send_json(event)
            if event.get("type") in ("access", "gone"):
                # The page re-checks through the read path and reconnects with
                # a fresh ticket if it still may read.
                await websocket.close(code=4001 if event["type"] == "access" else 4004)
                return

    pump = asyncio.create_task(_pump()) if queue is not None else None
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        if pump is not None:
            pump.cancel()
        if queue is not None:
            live.unsubscribe(slug, queue)
