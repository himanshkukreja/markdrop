"""In-process pub/sub for live document updates (WebSocket fan-out).

A viewer's browser opens one WebSocket per document it's reading. When the
document changes — a VS Code sync push or an in-app edit — we notify every open
socket for that slug so the page refreshes without a manual reload.

Sockets and their queues are in-process. When the API runs as several processes
(``MARKDROP_ROLE`` web / worker, app/worker.py) every event is also published on
Redis (``markdrop:live``) and each process delivers what the others published to
its own sockets: a page a background loop rewrote still refreshes in the reader's
tab. One process (``all``, the default) uses no bus.

Events (access policy §5.1) — never content:

    {"type": "changed", "rev": N}   content or settings changed; refetch
    {"type": "access"}              who may read it narrowed; re-check. The
                                    server closes the socket after sending it.
    {"type": "gone"}                deleted, expired or renamed away

Only a subscriber the document's read rule admits (anonymous-readable, or
holding a valid read ticket) is ever subscribed (routers/live.py), so even these
signals reach readers only.
"""

import asyncio
import json
import logging
import secrets
from collections import defaultdict

log = logging.getLogger(__name__)

# slug → set of live subscriber queues
_subscribers: dict[str, set[asyncio.Queue]] = defaultdict(set)
# Events waiting for one socket. A reader keeps up easily (a change, an access event, a presence
# snapshot at most every ~0.75 s); a socket whose peer stopped reading is told to close instead of
# queueing without end until its keepalive gives up.
QUEUE_MAX = 64


def subscribe(slug: str) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAX)
    _subscribers[slug].add(q)
    return q


def offer(q: asyncio.Queue, event) -> None:
    """Put ``event`` on one socket's queue without blocking; when it is full, the socket is told to
    close (its pump sees ``_overflow``) and the queue is emptied."""
    try:
        q.put_nowait(event)
    except asyncio.QueueFull:
        while not q.empty():
            q.get_nowait()
        q.put_nowait({"type": "_overflow"})


def stats() -> dict:
    """For /admin/health/memory."""
    return {"slugs": len(_subscribers), "sockets": sum(len(v) for v in _subscribers.values()),
            "queued": sum(q.qsize() for v in _subscribers.values() for q in v)}


def unsubscribe(slug: str, q: asyncio.Queue) -> None:
    subs = _subscribers.get(slug)
    if not subs:
        return
    subs.discard(q)
    if not subs:
        _subscribers.pop(slug, None)


def notify(slug: str | None, event: dict) -> None:
    """Send one event to every socket watching ``slug`` (non-blocking), in every process."""
    if not slug:
        return
    _deliver(slug, event)
    _publish({"s": slug, "e": event})


def _deliver(slug: str, event: dict) -> None:
    # Who's viewing (services/viewers.py): a narrowing or a removal closes every
    # socket on the document, so nobody stays listed; new content means new
    # heading names.
    from app.services import viewers

    if event.get("type") in ("access", "gone"):
        viewers.drop(slug)
    elif event.get("type") == "changed":
        viewers.content_changed(slug)
    for q in list(_subscribers.get(slug, ())):
        offer(q, dict(event))


def publish(slug: str, rev: int) -> None:
    """Notify all sockets watching ``slug`` that it changed (non-blocking)."""
    notify(slug, {"type": "changed", "rev": rev})


def access_changed(slug: str | None) -> None:
    notify(slug, {"type": "access"})


def gone(slug: str | None) -> None:
    notify(slug, {"type": "gone"})


def subscriber_count(slug: str) -> int:
    return len(_subscribers.get(slug, ()))


# ── The bus: several processes (MARKDROP_ROLE=web / worker) ──────────────────

CHANNEL = "markdrop:live"
ORIGIN = secrets.token_hex(6)
_bus_task: asyncio.Task | None = None
_pub: dict = {}            # the publishing client, per event loop
_sends: set[asyncio.Task] = set()


def _bus_on() -> bool:
    from app.config import get_settings

    return get_settings().role != "all"


def _client():
    import redis.asyncio as aioredis

    from app.config import get_settings

    loop = asyncio.get_running_loop()
    c = _pub.get("c")
    if c is None or _pub.get("loop") is not loop:
        c = aioredis.from_url(get_settings().redis_url, socket_timeout=2, socket_connect_timeout=2)
        _pub.update(c=c, loop=loop)
    return c


def _publish(msg: dict) -> None:
    if not _bus_on():
        return
    try:
        data = json.dumps({"o": ORIGIN, **msg}, separators=(",", ":"))
        t = asyncio.get_running_loop().create_task(_send(data))
        _sends.add(t)
        t.add_done_callback(_sends.discard)
    except Exception:
        log.debug("live bus: not published", exc_info=True)


async def _send(data: str) -> None:
    try:
        await _client().publish(CHANNEL, data)
    except Exception as exc:
        log.warning("live bus: publish failed: %s", type(exc).__name__)


def user_access_changed(user_id: str) -> None:
    """viewers.access_changed_for in the other processes."""
    _publish({"u": user_id})


def _received(raw: bytes | str) -> None:
    try:
        msg = json.loads(raw)
    except ValueError:
        return
    if not isinstance(msg, dict) or msg.get("o") == ORIGIN:
        return
    if isinstance(msg.get("s"), str) and isinstance(msg.get("e"), dict):
        _deliver(msg["s"], msg["e"])
    elif isinstance(msg.get("u"), str):
        from app.services import viewers

        viewers.access_changed_for(msg["u"], local=True)


async def _listen() -> None:
    import redis.asyncio as aioredis

    from app.config import get_settings

    wait = 1.0
    while True:
        client = None
        try:
            client = aioredis.from_url(get_settings().redis_url, socket_connect_timeout=5)
            ps = client.pubsub(ignore_subscribe_messages=True)
            await ps.subscribe(CHANNEL)
            wait = 1.0
            log.info("live bus: listening on %s", CHANNEL)
            async for m in ps.listen():
                if m.get("type") == "message":
                    _received(m.get("data"))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning("live bus: %s; retrying in %.0fs", type(exc).__name__, wait)
        finally:
            if client is not None:
                try:
                    await client.aclose()
                except Exception:
                    pass
        await asyncio.sleep(wait)
        wait = min(30.0, wait * 2)


def start_bus() -> None:
    global _bus_task
    if not _bus_on() or (_bus_task is not None and not _bus_task.done()):
        return
    _bus_task = asyncio.get_running_loop().create_task(_listen())


async def stop_bus() -> None:
    global _bus_task
    if _bus_task is not None:
        _bus_task.cancel()
        try:
            await _bus_task
        except (asyncio.CancelledError, Exception):
            pass
    _bus_task = None
    c = _pub.pop("c", None)
    _pub.pop("loop", None)
    if c is not None:
        try:
            await c.aclose()
        except Exception:
            pass
