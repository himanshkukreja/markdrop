"""Live document updates and "who's viewing" over WebSocket.

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

Presence (services/viewers.py). A page that shows who's viewing sends, as JSON
text frames:

    {"type": "hello", "n": <tab nonce>, "pt": <presence_ticket>?, "anon": bool,
     "state": "active"|"away", "sec": <section>?}     first, and again when the
                                                       reader signs in or out
    {"type": "ping"}                                   every ~15 s
    {"type": "state", "v": "active"|"away"}            the tab was shown / hidden
    {"type": "sec", "sec": {"h": <heading id>} | {"p": <page>} | {"s": <second>} | null}
    {"type": "anon", "v": bool}                        "Show me as anonymous"

and receives ``{"type": "presence", ...}`` snapshots. A socket the read rule
didn't admit gets none of this either.

Routed under ``/ws/`` so the existing nginx WebSocket-upgrade block applies.
"""

import asyncio

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.database import get_database
from app.services import access, live, publicity, tickets, viewers
from app.utils.net import get_client_ip

router = APIRouter(tags=["live"])


_NO_BODY = {"content": 0, "search_text": 0, "versions": 0}


async def _admitted(slug: str, ticket: str | None) -> dict | None:
    """The document, when the read rule admits this socket to it."""
    db = get_database()
    # Without the body: the socket keeps this row for as long as it is open (presence re-reads the
    # headings itself), and a long document per open tab adds up.
    raw = await db["documents"].find_one({"slug": slug}, _NO_BODY)
    if raw is None or publicity.is_expired(raw):
        return None
    if tickets.valid_for(ticket, raw):
        return raw
    return raw if await access.anonymous_can_read(db, raw) else None


async def serve(websocket: WebSocket, slug: str) -> None:
    """The socket's whole life (split out of the route so tests can drive it)."""
    await websocket.accept()
    ticket = websocket.query_params.get("t")
    try:
        raw = await _admitted(slug, ticket)
    except Exception:
        raw = None
    queue = live.subscribe(slug) if raw is not None else None
    conn = viewers.connect(queue, get_client_ip(websocket)) if queue is not None else None

    async def _pump() -> None:
        try:
            while True:
                event = await queue.get()
                if not isinstance(event, dict):  # legacy publishers sent a bare rev
                    event = {"type": "changed", "rev": event}
                if event.get("type") == "comments":
                    # Comments (services/comments): signed-in viewers only (a hello with a valid presence
                    # ticket), unless the item shows its comments publicly. Never content: a re-read signal.
                    pub = event.pop("pub", False)
                    if not pub and (conn is None or not conn.user_id):
                        continue
                if event.get("type") == "_overflow":
                    # The reader stopped reading (a phone that lost signal): drop the socket rather
                    # than keep queueing for it; the page reconnects when it comes back.
                    await websocket.close(code=1013)
                    return
                await websocket.send_json(event)
                if event.get("type") in ("access", "gone"):
                    # The page re-checks through the read path and reconnects with
                    # a fresh ticket if it still may read.
                    await websocket.close(code=4001 if event["type"] == "access" else 4004)
                    return
        except asyncio.CancelledError:
            raise
        except Exception:
            # The peer went away mid-send (ConnectionClosedError "keepalive ping timeout"): the
            # receive loop below sees it too and cleans up.
            pass

    pump = asyncio.create_task(_pump()) if queue is not None else None
    try:
        while True:
            text = await websocket.receive_text()
            if conn is None:
                continue  # not admitted: say nothing, as before
            if await viewers.handle(get_database(), slug, raw, conn, text) == "close":
                await websocket.close(code=4008)
                return
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        if pump is not None:
            pump.cancel()
        if conn is not None:
            viewers.leave(slug, conn)
        if queue is not None:
            live.unsubscribe(slug, queue)


@router.websocket("/ws/docs/{slug}")
async def document_updates(websocket: WebSocket, slug: str) -> None:
    await serve(websocket, slug)
