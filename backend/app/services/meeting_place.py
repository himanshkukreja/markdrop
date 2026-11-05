"""Where a meeting's page goes: ONE function every import path calls (the web import, the Google
Meet script's inbox, a pasted Drive link, MCP, Import past meetings) and every series change.

    place_meeting(db, workspace_id, meeting) -> folder_id

Owner decision (2026-11-05): every meeting page lives in a subfolder of the workspace's Meetings
folder: ``Meetings/<Series>`` for a recurring call (a name seen on two or more dates, see
services/meeting_series.py), else ``Meetings/Other meetings``. Subfolders are made on demand with
the Meetings folder's properties and views (meeting_series.target_folder).

``meeting`` is a meeting row: ``workspace_id``, ``created_by``, ``series`` (a name or None), and,
once it exists, ``_id``/``doc_id``/``folder_id``.

* Before the row is inserted (no ``_id``): returns the folder the new page should be made in.
* An existing meeting: also moves its page there and updates the row's ``folder_id``.

Either way the series becomes an option of that folder's Series property.
"""

from __future__ import annotations

from motor.motor_asyncio import AsyncIOMotorDatabase

COLL = "meetings"


async def place_meeting(db: AsyncIOMotorDatabase, workspace_id: str, meeting: dict) -> str:
    from app.services import folder as folder_service
    from app.services import meeting_series, meetings

    by = str(meeting.get("created_by") or "") or None
    root = await meetings.ensure_folder(db, workspace_id, by)
    series = meeting.get("series") or None
    target = await meeting_series.target_folder(db, root, series, by)
    if series:
        target = await meeting_series.ensure_option(db, target, series, by) or target
    fid = str(target["_id"])
    if meeting.get("_id") is None:
        return fid
    raw = await db["documents"].find_one({"_id": meetings.oid(meeting.get("doc_id"))}) if meeting.get("doc_id") else None
    if raw is not None and (raw.get("folder_id") or None) != fid and raw.get("parent_id") is None \
            and raw.get("workspace_id") == workspace_id and not raw.get("deleted_at"):
        await folder_service.file_document(db, raw, workspace_id, fid)
    if meeting.get("folder_id") != fid:
        await db[COLL].update_one({"_id": meeting["_id"]}, {"$set": {"folder_id": fid}})
    return fid
