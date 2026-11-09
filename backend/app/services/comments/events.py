"""The one hook every part of comments extends (CONTRACT §7).

``emit(db, kind, doc=…, thread=…, message=…, actor=…)`` runs, in order:

1. the live fan-out (``{"type": "comments", …}`` on the item's socket; signed-in viewers only unless the item
   shows its comments publicly — routers/live.py filters),
2. the bell (services/comments/notify_app.py),
3. every handler registered with :func:`on` (Track B: suggestions / AI; Track C: email, Slack, digest,
   analytics), each isolated: an exception is logged and never reaches the caller, and each has 5 s.

Plugin modules register at import time; :func:`load_plugins` imports the fixed list once (main.py lifespan,
and lazily on the first emit so tests and scripts get them too).
"""

from __future__ import annotations

import asyncio
import importlib
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Iterable

from motor.motor_asyncio import AsyncIOMotorDatabase

log = logging.getLogger(__name__)

KINDS = (
    "thread_created", "replied", "message_edited", "message_deleted", "resolved", "reopened", "reacted",
    "assigned", "unassigned", "suggestion_created", "suggestion_accepted", "suggestion_rejected",
    "anchor_changed", "settings_changed",
)

PLUGINS = (
    # Track B
    "app.services.comments.suggestions",
    "app.services.comments.ai",
    "app.services.comments.attachments",
    # Track C
    "app.services.comments.notify_email",
    "app.services.comments.slack",
    "app.services.comments.digest",
    "app.services.comments.analytics",
    "app.services.comments.export",
)
HANDLER_TIMEOUT_S = 5.0


@dataclass
class CommentEvent:
    kind: str
    doc: dict
    thread: dict
    message: dict | None
    actor: Any
    new_mentions: list[str] = field(default_factory=list)
    extra: dict = field(default_factory=dict)
    at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


Handler = Callable[[AsyncIOMotorDatabase, CommentEvent], Awaitable[None]]

_handlers: dict[str, tuple[Handler, frozenset[str] | None]] = {}
_loaded = False


def on(handler: Handler, *, kinds: Iterable[str] | None = None, name: str) -> None:
    """Register ``handler`` for ``kinds`` (all when None). Idempotent per ``name``."""
    ks = frozenset(kinds) if kinds is not None else None
    if ks is not None:
        unknown = ks - set(KINDS)
        if unknown:
            raise ValueError(f"unknown comment event kinds: {sorted(unknown)}")
    _handlers[name] = (handler, ks)


def off(name: str) -> None:
    """Drop a handler (tests)."""
    _handlers.pop(name, None)


def handlers() -> list[str]:
    return sorted(_handlers)


def load_plugins() -> None:
    global _loaded
    if _loaded:
        return
    _loaded = True
    for mod in PLUGINS:
        try:
            importlib.import_module(mod)
        except ModuleNotFoundError as exc:
            if exc.name != mod:
                log.warning("comments plugin %s failed to import: %s", mod, exc)
        except Exception:
            log.exception("comments plugin %s failed to import", mod)


async def _run(db: AsyncIOMotorDatabase, name: str, fn: Handler, ev: CommentEvent) -> None:
    try:
        await asyncio.wait_for(fn(db, ev), timeout=HANDLER_TIMEOUT_S)
    except Exception:
        log.exception("comments handler %s failed on %s", name, ev.kind)


async def emit(db: AsyncIOMotorDatabase, kind: str, *, doc: dict, thread: dict, message: dict | None = None,
               actor: Any = None, new_mentions: Iterable[str] = (), extra: dict | None = None) -> CommentEvent:
    if kind not in KINDS:
        raise ValueError(f"unknown comment event kind {kind!r}")
    load_plugins()
    ev = CommentEvent(kind=kind, doc=doc, thread=thread, message=message, actor=actor,
                      new_mentions=list(new_mentions), extra=dict(extra or {}))
    # 1. live (never raises)
    try:
        from app.services.comments import service

        service.live_event(doc, thread, kind)
    except Exception:
        log.exception("comments live fan-out failed")
    # 2. the bell
    try:
        from app.services.comments import notify_app

        await notify_app.on_event(db, ev)
    except Exception:
        log.exception("comments bell failed on %s", kind)
    # 3. plugins
    for name, (fn, ks) in list(_handlers.items()):
        if ks is None or kind in ks:
            await _run(db, name, fn, ev)
    return ev
