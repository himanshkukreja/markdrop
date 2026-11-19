"""Where a page came from (provenance): the "Imported from Notion" strip at the top of an imported page.

The writer (writer.py) stamps ``source: {kind: "notion", via: "api" | "zip", notion_id, url, sync_id,
imported_at}`` on every page it writes; pages imported before that are filled in from ``notion_links`` by
scripts/backfill_notion_source.py. :func:`for_read` turns it into what a reader is shown:

* everyone who can read the page (anonymous readers of a public page too): ``{kind, url, imported_at}``
  ("Imported from Notion · Open in Notion"). Provenance only: nothing about anyone's Notion connection.
* people who can edit it, for a Connect Notion import: ``sync {state, last_synced_at}`` — state ``on``
  ("Synced 5 min ago"), ``off`` (not kept in sync, or the sync was removed), ``paused`` (the importer must
  reconnect Notion, or can't add there any more) or ``edited`` (edited in Markdrop: it stopped syncing).
* the person whose sync it is (and who can edit): also ``sync.id`` and ``keep_in_sync``, for "Sync now"
  (POST /api/v1/notion/syncs/{id}/run) and a link to their sync settings.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from motor.motor_asyncio import AsyncIOMotorDatabase


def _iso(dt: Any) -> str | None:
    if not isinstance(dt, datetime):
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).isoformat()


def stored(raw: dict) -> dict | None:
    s = raw.get("source")
    return s if isinstance(s, dict) and s.get("kind") == "notion" else None


async def for_read(db: AsyncIOMotorDatabase, raw: dict, user_id: str | None, *, can_edit: bool) -> dict | None:
    """The page's provenance for this reader (None: not imported from Notion)."""
    s = stored(raw)
    if s is None:
        return None
    url = s.get("url") if isinstance(s.get("url"), str) and s["url"].startswith("https://") else None
    out: dict[str, Any] = {"kind": "notion", "url": url, "imported_at": _iso(s.get("imported_at")), "sync": None}
    if not (can_edit and user_id) or s.get("via") != "api":
        return out
    link = await db["notion_links"].find_one({"doc_id": raw["_id"]}, {"detached": 1, "synced_at": 1})
    row = await db["notion_syncs"].find_one({"_id": s["sync_id"]}) if s.get("sync_id") else None
    if link is not None and link.get("detached"):
        state = "edited"
    elif row is None or not row.get("keep"):
        state = "off"
    elif row.get("paused"):
        state = "paused"
    else:
        state = "on"
    last = (row or {}).get("last_synced_at") if state == "on" else None
    sync: dict[str, Any] = {"state": state, "last_synced_at": _iso(last or ((link or {}).get("synced_at")
                                                                            if state == "on" else None))}
    if row is not None and row.get("user_id") == user_id:
        sync.update(id=row["_id"], keep_in_sync=bool(row.get("keep")))
    out["sync"] = sync
    return out


# ── Backfill (scripts/backfill_notion_source.py) ──────────────────────────────


def _dest_keys(row: dict) -> list[str] | None:
    """The writer's destination key(s) a sync row writes to (workspace: exact; My files: a prefix)."""
    d = row.get("dest") or {}
    if d.get("workspace_id"):
        return [f"ws:{d['workspace_id']}:{d.get('parent_folder_id') or '-'}:{d.get('team_id') or '-'}"]
    return None


async def backfill(db: AsyncIOMotorDatabase, *, apply: bool = False, examples: int = 10) -> dict:
    """``source`` for pages imported from Notion before the writer stamped it, from ``notion_links``: the
    Notion id and address, how it came (a link with ``child_ids`` came through Connect Notion), when, and
    the sync of the root it sits under (found through the links' sub-pages and database folders). Pages
    that already have one are left alone. Dry run unless ``apply``. Idempotent."""
    from app.services.notion_import.writer import LINKS

    links = [r async for r in db[LINKS].find({"doc_id": {"$ne": None}, "notion_id": {"$ne": "__root__"}})]
    by_dest: dict[str, dict[str, dict]] = {}
    for r in links:
        by_dest.setdefault(r.get("dest") or "", {})[r["notion_id"]] = r
    folder_rows: dict[tuple[str, str], list[dict]] = {}
    for r in links:
        if r.get("folder_id") and r.get("kind") != "folder":
            folder_rows.setdefault((r.get("dest") or "", str(r["folder_id"])), []).append(r)
    # Folders of database links (kind "folder" rows have no doc_id, so read them apart).
    async for r in db[LINKS].find({"kind": "folder"}):
        by_dest.setdefault(r.get("dest") or "", {})[r["notion_id"]] = r
    sync_of: dict[str, str] = {}             # link _id → sync id
    async for row in db["notion_syncs"].find({}):
        keys = _dest_keys(row)
        dests = keys if keys is not None else [k for k in by_dest if k.startswith(f"user:{row.get('user_id')}:")]
        for key in dests:
            nodes = by_dest.get(key) or {}
            start = nodes.get(row.get("root_id"))
            if start is None:
                continue
            stack, seen = [start], set()
            while stack:
                cur = stack.pop()
                if cur["_id"] in seen:
                    continue
                seen.add(cur["_id"])
                sync_of.setdefault(cur["_id"], row["_id"])
                for _k, cid in cur.get("child_ids") or []:
                    if cid in nodes:
                        stack.append(nodes[cid])
                if cur.get("kind") == "folder" and cur.get("folder_id"):
                    stack.extend(folder_rows.get((key, str(cur["folder_id"])), []))
    out = {"links": len(links), "already": 0, "missing_page": 0, "would_set": 0, "set": 0, "api": 0, "zip": 0,
           "with_sync": 0, "examples": []}
    for r in links:
        if r.get("kind") == "folder":
            continue
        raw = await db["documents"].find_one({"_id": r["doc_id"]}, {"source": 1, "title": 1, "slug": 1,
                                                                   "created_at": 1, "deleted_at": 1})
        if raw is None or raw.get("deleted_at"):
            out["missing_page"] += 1
            continue
        if stored(raw) is not None:
            out["already"] += 1
            continue
        nid = r["notion_id"]
        via = "api" if "child_ids" in r else "zip"
        src = {"kind": "notion", "via": via, "notion_id": nid,
               "url": f"https://www.notion.so/{nid}" if re.fullmatch(r"[0-9a-f]{32}", nid or "") else None,
               "sync_id": sync_of.get(r["_id"]) if via == "api" else None,
               "imported_at": r.get("created_at") or raw.get("created_at")}
        out["would_set"] += 1
        out[via] += 1
        out["with_sync"] += 1 if src["sync_id"] else 0
        if len(out["examples"]) < examples:
            out["examples"].append({"slug": raw.get("slug"), "title": raw.get("title"), "via": via,
                                    "sync_id": src["sync_id"]})
        if apply:
            res = await db["documents"].update_one({"_id": raw["_id"], "source": None}, {"$set": {"source": src}})
            out["set"] += res.modified_count
    return out
