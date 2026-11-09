"""Bell rows for comment events (CONTRACT §10): mentions, replies, new comments on your items, resolved, assigned."""

from __future__ import annotations


async def on_event(db, ev) -> None:
    """Called by events.emit for every event (before plugin handlers)."""
    return None
