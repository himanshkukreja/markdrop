"""Live document updates over WebSocket.

``/ws/docs/{slug}`` — a viewer's browser connects and receives a
``{"type": "changed", "rev": N}`` message whenever the document is updated
(VS Code sync push or an in-app edit). Public and read-only: it carries no
document content, so it's safe for password-protected docs — the client
refetches through the normal authorized read path on notification.

Routed under ``/ws/`` so the existing nginx WebSocket-upgrade block applies.
"""

import asyncio

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.services import live

router = APIRouter(tags=["live"])


@router.websocket("/ws/docs/{slug}")
async def document_updates(websocket: WebSocket, slug: str) -> None:
    await websocket.accept()
    queue = live.subscribe(slug)

    async def _pump() -> None:
        # Forward every published change to this client.
        while True:
            rev = await queue.get()
            await websocket.send_json({"type": "changed", "rev": rev})

    pump = asyncio.create_task(_pump())
    try:
        # We don't expect inbound messages; receiving is only how we notice the
        # client disconnecting (raises WebSocketDisconnect).
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        pump.cancel()
        live.unsubscribe(slug, queue)
