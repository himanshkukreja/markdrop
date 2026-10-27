"""In-process pub/sub for live document updates (WebSocket fan-out).

A viewer's browser opens one WebSocket per document it's reading. When the
document changes — a VS Code sync push or an in-app edit — we notify every open
socket for that slug so the page refreshes without a manual reload.

State is in-process, which is correct for the single-worker deployment (the same
assumption the file-share signalling already relies on). If the API is ever
scaled to multiple workers this must move behind Redis pub/sub; until then a
per-subscriber ``asyncio.Queue`` is the simplest correct thing.

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
from collections import defaultdict

# slug → set of live subscriber queues
_subscribers: dict[str, set[asyncio.Queue]] = defaultdict(set)


def subscribe(slug: str) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    _subscribers[slug].add(q)
    return q


def unsubscribe(slug: str, q: asyncio.Queue) -> None:
    subs = _subscribers.get(slug)
    if not subs:
        return
    subs.discard(q)
    if not subs:
        _subscribers.pop(slug, None)


def notify(slug: str | None, event: dict) -> None:
    """Send one event to every socket watching ``slug`` (non-blocking)."""
    if not slug:
        return
    for q in list(_subscribers.get(slug, ())):
        try:
            q.put_nowait(dict(event))
        except asyncio.QueueFull:  # unbounded queue — defensive only
            pass


def publish(slug: str, rev: int) -> None:
    """Notify all sockets watching ``slug`` that it changed (non-blocking)."""
    notify(slug, {"type": "changed", "rev": rev})


def access_changed(slug: str | None) -> None:
    notify(slug, {"type": "access"})


def gone(slug: str | None) -> None:
    notify(slug, {"type": "gone"})


def subscriber_count(slug: str) -> int:
    return len(_subscribers.get(slug, ()))
