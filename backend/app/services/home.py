"""The signed-in home (/dashboard, the installed app's start screen): what needs you, in one request.

    GET  /api/v1/home                    {attention, actions, meetings, workspaces, meet}
    POST /api/v1/home/actions/tick       {slug, block} → {done: true}
    POST /api/v1/me/previews             {slugs} → {previews}   (routers/home.py; services/card_preview.py)

No AI anywhere here (the Ask bar opens the assistant, services/assistant.py). Everything is decided for
the caller now, per item, with the same rules every other list uses:

* **attention** — unread notifications (mentions, sign-off requests, shares: notifications.listing,
  which shows a page's title only when the reader can open it now) and access requests waiting on the
  caller (access_requests.list_for_owner).
* **actions** — the open to-dos that @mention the caller (``- [ ] … :person[…]{id="<me>"}``) in block
  pages they can read (search's wall-1 filter, then ``access.can(read)`` per page; never encrypted or
  password-protected pages, never the trash). The same lines Ask Markdrop's "My open action items"
  reads (ask_markdrop.task_lines), without the model. ``can_tick``: the caller may edit that page.
* **meetings** — the latest meetings across the caller's workspaces (meetings.list_meetings: each one
  decided on its page; restricted meetings stay invisible to everyone they weren't shared with).
* **workspaces** — the caller's workspaces with role, people (the first few members), how many items
  the caller can see in each (search's readable filter, trash excluded) and the meetings count.

``tick`` flips one ``- [ ]`` to ``- [x]`` (found by its block id) through the website's save path, as
the caller, only when the line mentions them and they may edit the page (Slack's Done button does the
same, services/slack_notify.mark_done).
"""

from __future__ import annotations

import asyncio
import dataclasses
import re
from datetime import timedelta
from typing import Any

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import access, search, search_index

ACTIONS_MAX = 30
ACTIONS_SCAN = 300
TODO_PAGES_MAX = 20_000  # pages with an open to-do for one person the index lookup reads (ids only)
ATTENTION_MAX = 8
MEETINGS_MAX = 8
MEETINGS_DAYS = 21
PEOPLE_SHOWN = 4


_TODO = re.compile(r"^(?P<lead>[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]+)\[(?P<mark>[ xX])\](?P<rest>[ \t].*?)[ \t]*"
                   r"\{#(?P<block>b-[0-9A-Za-z_-]+)[^}]*\}[ \t]*$", re.M)


def _oid(v: Any) -> ObjectId | None:
    try:
        return ObjectId(str(v))
    except Exception:
        return None


# ── Action items ──────────────────────────────────────────────────────────────


async def actions(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, w: search.World) -> dict:
    from app.services import md_outline, todos

    uid = actor.user_id
    filt = await search.doc_filter(db, actor, ctx, w.member_ws, search.Query(q=""))
    if filt is None or not uid:
        return {"items": [], "more": False, "hidden": 0}
    filt["$and"].append({"kind": {"$ne": "artifact"}, "editor": "blocks", "encrypted": {"$ne": True}, "deleted_at": None})
    lines: dict | None = None
    if await search_index.todos_ready(db):
        # The pages with an open to-do for the caller and those to-dos, from the search index (``td`` is
        # indexed; ``tdl`` holds the lines): no regex over every readable page, and no page bodies over
        # the wire — only each page's own fields, for the access decision (search_index.todo_fields).
        ids = [r["_id"] for r in await db[search_index.COLL].find({"td": uid}, {"_id": 1})
               .to_list(length=TODO_PAGES_MAX)]
        if not ids:
            return {"items": [], "more": False, "hidden": 0}
        filt["$and"].append({"_id": {"$in": ids}})
        # The newest ACTIONS_SCAN of those pages the caller can read (the same window as before, now of
        # pages that do have a to-do for them), then only those pages' lines.
        rows = await db["documents"].find(filt, {"content": 0}).sort("updated_at", -1).limit(ACTIONS_SCAN) \
            .to_list(length=ACTIONS_SCAN)
        lines = {r["_id"]: ((r.get("tdl") or {}).get(uid) or []) for r in await db[search_index.COLL].find(
            {"_id": {"$in": [r["_id"] for r in rows]}}, {f"tdl.{uid}": 1}).to_list(length=len(rows))} if rows else {}
    else:
        filt["$and"].append({"content": {"$regex": re.escape(f'id="{uid}"')}})
        rows = await db["documents"].find(filt).sort("updated_at", -1).limit(ACTIONS_SCAN).to_list(length=ACTIONS_SCAN)
    # Newest first by when the to-do was set: a meeting's own date for meeting notes (a bulk import touches
    # every page at once, so updated_at would shuffle them), else the page's last change.
    mids = {_oid(r.get("meeting_id")) for r in rows if r.get("meeting_id")} - {None}
    mdate = {str(m["_id"]): m.get("date") for m in await db["meetings"].find(
        {"_id": {"$in": list(mids)}}, {"date": 1}).to_list(length=len(mids))} if mids else {}
    if lines is not None:
        all_tasks = [[(t, a) for t, a in lines.get(r["_id"], [])] for r in rows]
    else:
        # The text work for up to 300 pages, off the event loop (it held every other request meanwhile).
        all_tasks = await asyncio.to_thread(
            lambda: [[] if search_index.title_only(r) else todos.for_person(r.get("content") or "", uid) for r in rows])
    out: list[dict] = []
    for raw, tasks in zip(rows, all_tasks):
        if not tasks or search_index.title_only(raw):
            continue
        if not (await access.can(actor, raw, "read", ctx)).allowed:
            continue
        can_tick = (await access.can(actor, raw, "edit_content", ctx)).allowed
        if lines is not None and not (raw.get("title") or "").strip():
            # The title falls back to the first heading: only then is the body needed.
            raw = {**raw, **(await db["documents"].find_one({"_id": raw["_id"]}, {"content": 1}) or {})}
        title = md_outline.display_title(raw)
        ws_id = raw.get("workspace_id")
        upd = raw.get("updated_at")
        when = mdate.get(str(raw.get("meeting_id"))) or (upd.date().isoformat() if hasattr(upd, "date") else None)
        for i, (text, anchor) in enumerate(tasks):
            out.append({
                "text": text, "slug": raw["slug"], "block": anchor, "title": title,
                "url": f"/{raw['slug']}" + (f"#{anchor}" if anchor else ""),
                "workspace": {"id": ws_id, "name": w.ws_names.get(ws_id)} if ws_id in w.ws_names else None,
                "meeting": bool(raw.get("meeting_id")),
                "updated_at": upd,
                "date": when,
                "can_tick": bool(can_tick and anchor),
                "_k": (when or "", upd.isoformat() if hasattr(upd, "isoformat") else "", -i),
            })
    out.sort(key=lambda a: a.pop("_k"), reverse=True)
    return {"items": out[:ACTIONS_MAX], "more": len(out) > ACTIONS_MAX, "hidden": max(0, len(out) - ACTIONS_MAX)}


async def tick(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, slug: str, block: str,
               done: bool = True) -> dict:
    """Mark one of the caller's to-dos done (``done=False``: open again, the home's Undo). 404: no such
    page (or unreadable) / no such to-do; 403: can't edit the page or the to-do isn't theirs; 409: already
    that way; 423: someone is editing."""
    from app.services import meetings, pages

    uid = actor.user_id
    raw = await db["documents"].find_one({"slug": slug, "deleted_at": None})
    if raw is None or raw.get("encrypted") or not (await access.can(actor, raw, "read", ctx)).allowed:
        raise HTTPException(status_code=404, detail="That page isn't there any more.")
    if not (await access.can(actor, raw, "edit_content", ctx)).allowed:
        raise HTTPException(status_code=403, detail="You can't edit that page, so you can't tick its to-dos.")
    for _attempt in range(3):
        content = raw.get("content") or ""
        hit = next((m for m in _TODO.finditer(content) if m.group("block") == block), None)
        if hit is None:
            raise HTTPException(status_code=404, detail="That to-do was changed or removed on the page.")
        if f'id="{uid}"' not in hit.group(0):
            raise HTTPException(status_code=403, detail="That to-do isn't assigned to you.")
        if (hit.group("mark") in "xX") == done:
            raise HTTPException(status_code=409, detail="That one is already done." if done else "That one is already open.")
        new = content[: hit.start("mark")] + ("x" if done else " ") + content[hit.end("mark"):]
        try:
            await pages.check_page_lock(raw, actor, ctx, new)
            await meetings._save(db, raw, new, actor, ctx, base_rev=int(raw.get("rev") or 1))
        except HTTPException as exc:
            if exc.status_code == 409:
                raw = await db["documents"].find_one({"_id": raw["_id"]}) or raw
                continue
            raise
        return {"done": done}
    raise HTTPException(status_code=409, detail="That page keeps changing. Try again in a moment.")


# ── Meetings ──────────────────────────────────────────────────────────────────


async def meetings_across(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, w: search.World) -> dict:
    from app.services import meetings

    since = (ctx.now - timedelta(days=MEETINGS_DAYS)).date().isoformat()
    async def one(ws) -> list[dict]:
        try:
            res = await meetings.list_meetings(db, ws.id, actor, ctx, limit=MEETINGS_MAX, since=since,
                                               overview=False, attendees_max=6)
        except HTTPException:
            return []
        for m in res["meetings"]:
            m["workspace_name"] = ws.name
        return res["meetings"]

    # Every workspace at once rather than one after another.
    found: list[dict] = [m for ms in await asyncio.gather(*(one(ws) for ws, _role in w.memberships)) for m in ms]
    found.sort(key=lambda m: (m.get("date") or "", m.get("time") or "", m.get("created_at") or ""), reverse=True)
    keep = ("id", "workspace_id", "workspace_name", "title", "page_title", "slug", "date", "time", "duration_s",
            "type", "series", "attendees", "action_items", "summary", "decisions", "open_questions", "cover",
            "restricted", "ai")
    items = [{k: m.get(k) for k in keep} for m in found[:MEETINGS_MAX]]
    for it, m in zip(items, found):
        it["attendees"] = [{"name": a.get("name")} for a in (it.get("attendees") or [])][:6]
        it["attendee_count"] = m.get("attendee_count", len(it["attendees"]))
        it["ai"] = {"state": (it.get("ai") or {}).get("state")}
    return {"items": items, "today": ctx.now.date().isoformat()}


# ── Workspaces ────────────────────────────────────────────────────────────────


async def workspaces(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, w: search.World) -> list[dict]:
    from app.models.workspace import role_allows

    if not w.memberships:
        return []
    ids = [ws.id for ws, _ in w.memberships]

    async def item_counts() -> dict[str, int]:
        # How many items the caller can see in each (search's readable filter, trash excluded).
        filt = await search.doc_filter(db, actor, ctx, w.member_ws, search.Query(q=""))
        if filt is None:
            return {}
        filt["$and"].append({"workspace_id": {"$in": ids}, "deleted_at": None})
        return {r["_id"]: int(r["n"]) for r in await db["documents"].aggregate([
            {"$match": filt}, {"$group": {"_id": "$workspace_id", "n": {"$sum": 1}}},
        ]).to_list(length=200)}
    async def grouped(coll: str) -> dict[str, int]:
        return {r["_id"]: int(r["n"]) for r in await db[coll].aggregate([
            {"$match": {"workspace_id": {"$in": ids}}}, {"$group": {"_id": "$workspace_id", "n": {"$sum": 1}}},
        ]).to_list(length=200)}

    async def first_people() -> dict[str, list[str]]:
        # The first few people of each (owner first, then by joining): one query for every workspace.
        groups = await db["memberships"].aggregate([
            {"$match": {"workspace_id": {"$in": ids}}}, {"$sort": {"created_at": 1, "_id": 1}},
            {"$group": {"_id": "$workspace_id", "rows": {"$push": {"u": "$user_id", "r": "$role"}}}},
            {"$project": {"rows": {"$slice": ["$rows", PEOPLE_SHOWN * 3]}}},
        ]).to_list(length=len(ids))
        out: dict[str, list[str]] = {}
        for g in groups:
            rows = sorted(g["rows"], key=lambda r: (r.get("r") != "owner",))
            out[g["_id"]] = [r["u"] for r in rows[:PEOPLE_SHOWN]]
        return out

    # Independent reads, at once.
    counts, members, meet_counts, firsts = await asyncio.gather(
        item_counts(), grouped("memberships"), grouped("meetings"), first_people())
    uids = {u for us in firsts.values() for u in us}
    users = {str(u["_id"]): u async for u in db["users"].find(
        {"_id": {"$in": [o for o in (_oid(u) for u in uids) if o]}}, {"name": 1, "email": 1, "picture": 1})}
    out = []
    for ws, role in w.memberships:
        people = []
        for u in firsts.get(ws.id, []):
            row = users.get(u)
            if not row:
                continue
            pic = row.get("picture")
            people.append({"name": row.get("name") or (row.get("email") or "").split("@")[0] or None,
                           "picture": pic if isinstance(pic, str) and pic.startswith("https://") else None,
                           "is_you": u == actor.user_id})
        branding = dataclasses.asdict(ws.branding) if dataclasses.is_dataclass(ws.branding) else dict(ws.branding or {})
        out.append({
            "id": ws.id, "name": ws.name, "role": role,
            "branding": {k: branding.get(k) for k in ("logo_url", "site_name", "accent_color", "logo_well")},
            "member_count": members.get(ws.id, 0), "item_count": counts.get(ws.id, 0),
            "meetings": meet_counts.get(ws.id, 0), "can_import": role_allows(role, "member"),
            "people": people,
        })
    return out


# ── Attention ─────────────────────────────────────────────────────────────────


async def attention(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx) -> dict:
    from app.services import access_requests, notifications

    notes = await notifications.listing(db, actor.user_id, unread_only=True, limit=ATTENTION_MAX)
    reqs = await access_requests.list_for_owner(db, actor, ctx, "pending", limit=5)
    return {
        "notifications": [n for n in notes["items"] if n.get("available")],
        "unread": notes["unread_count"],
        "requests": [{"id": r["id"], "requester": r["requester"], "role_requested": r.get("role_requested"),
                      "created_at": r["created_at"],
                      "document": {"slug": r["document"]["slug"], "title": r["document"]["title"]}}
                     for r in reqs["requests"]],
        "requests_count": reqs["pending_count"],
    }


# ── The whole home ────────────────────────────────────────────────────────────


async def home(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx) -> dict:
    from app.services import meetings_inbox

    w = await search.world_of(db, actor, ctx)

    async def meet() -> dict:
        row = await meetings_inbox.mine(db, actor.user_id)
        return {"connected": row is not None, "workspace_id": (row or {}).get("workspace_id")}

    att, act, mts, wss, conn = await asyncio.gather(
        attention(db, actor, ctx), actions(db, actor, ctx, w), meetings_across(db, actor, ctx, w),
        workspaces(db, actor, ctx, w), meet())
    return {"attention": att, "actions": act, "meetings": mts, "workspaces": wss, "meet": conn}
