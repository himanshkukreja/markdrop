"""Where a new meeting's page goes: ONE function every import path calls (the web import, the
Google Meet script's inbox, a pasted Drive link, MCP, the bulk backfill).

    place_meeting(db, workspace_id, meeting) -> folder_id

``meeting`` is the meeting row about to be made (``title``, ``date``, ``time``, ``attendees``,
``workspace_id``). Owner decision (2026-11-05): one-off meetings go to Meetings › Other meetings,
and a title seen on 2+ dates gets a series subfolder; feat/meetings-backfill builds that here.
Until it lands this returns the workspace's Meetings folder (made on first use).
"""

from __future__ import annotations

from motor.motor_asyncio import AsyncIOMotorDatabase


async def place_meeting(db: AsyncIOMotorDatabase, workspace_id: str, meeting: dict) -> str:
    from app.services import meetings

    folder = await meetings.ensure_folder(db, workspace_id, str(meeting.get("created_by") or ""))
    return str(folder["_id"])
