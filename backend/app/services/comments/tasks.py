"""Assigned threads and "waiting on you" for Home and Team (CONTRACT §6)."""

from __future__ import annotations


async def mine(db, actor, ctx, *, view: str = "waiting", limit: int = 20) -> dict:
    """``{"items": [MyThread]}`` for view = assigned | waiting | mentions."""
    raise NotImplementedError


async def home_section(db, actor, ctx) -> dict:
    """``{"waiting": [MyThread] (≤ 8), "waiting_count": int}``."""
    raise NotImplementedError


async def action_items(db, actor, ctx) -> list[dict]:
    """Home Action items rows for threads assigned to the caller (``kind: "comment"``)."""
    raise NotImplementedError


async def team_tasks(db, workspace_id: str, ctx) -> dict[str, list[dict]]:
    """user id → their open assigned threads on the workspace's items (Team view)."""
    raise NotImplementedError
