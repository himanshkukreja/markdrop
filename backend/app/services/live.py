"""In-process pub/sub for live document updates (WebSocket fan-out).

A viewer's browser opens one WebSocket per document it's reading. When the
document changes — a VS Code sync push or an in-app edit — we notify every open
socket for that slug so the page refreshes without a manual reload.

State is in-process, which is correct for the single-worker deployment (the same
assumption the file-share signalling already relies on). If the API is ever
scaled to multiple workers this must move behind Redis pub/sub; until then a
per-subscriber ``asyncio.Queue`` is the simplest correct thing.

Only a tiny ``{"type": "changed", "rev": N}`` signal is published — never
content — so an unauthenticated socket on a password-protected document leaks
nothing; the client refetches through the normal (authorized) read path.
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


def publish(slug: str, rev: int) -> None:
    """Notify all sockets watching ``slug`` that it changed (non-blocking)."""
    for q in list(_subscribers.get(slug, ())):
        try:
            q.put_nowait(rev)
        except asyncio.QueueFull:  # unbounded queue — defensive only
            pass
