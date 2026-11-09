"""Suggested edits on a thread (propose replacement text; an editor accepts in one click). Track B. Also: on_create(db, raw, thread, text, actor) called by service.create_thread/reply when a draft carries a suggestion.

STUB from the contract commit (CONTRACT §7): Track B owns this file and replaces it. Register handlers at import
time with `app.services.comments.events.on(handler, kinds=[...], name="...")`.
"""

from __future__ import annotations


async def on_create(db, raw: dict, thread: dict, text: str | None, actor) -> dict | None:
    """A new thread or reply carried ``suggestion`` text. Track B stores it on ``thread.suggestion``; returns
    the updated thread row (or None when nothing was stored)."""
    return None
