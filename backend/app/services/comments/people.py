"""Who a comment can @mention (people with access to the item), and checking mentions (CONTRACT §5 /people)."""

from __future__ import annotations


async def mentionable(db, actor, raw: dict, ctx, q: str | None = None, limit: int = 20) -> dict:
    """``{"people": [{"id","name","picture","email"?,"has_access": True}], "invite": None | {...}}``."""
    raise NotImplementedError


async def valid_mentions(db, raw: dict, ctx, ids: list[str] | None) -> list[str]:
    """The ids that name an account which can read the item now (deduped, ≤ MAX_MENTIONS)."""
    raise NotImplementedError
