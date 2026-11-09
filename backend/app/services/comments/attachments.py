"""Images/files in comments, following the item's access like page assets. Track B. resolve_ids(db, raw, actor, ids) -> list[dict] is called by service.create_thread/reply.

STUB from the contract commit (CONTRACT §7): Track B owns this file and replaces it. Register handlers at import
time with `app.services.comments.events.on(handler, kinds=[...], name="...")`.
"""

from __future__ import annotations

from fastapi import HTTPException


async def resolve_ids(db, raw: dict, actor, ids: list[str] | None) -> list[dict]:
    """Attachment ids a comment draft names → the rows stored on the message
    (``{"id", "name", "mime", "size", "key"}``). Track B validates ownership and the item's access."""
    if ids:
        raise HTTPException(status_code=422, detail="Attachments aren't available yet.")
    return []
