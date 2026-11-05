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
ATTENTION_MAX = 8
MEETINGS_MAX = 8
MEETINGS_DAYS = 21
PEOPLE_SHOWN = 4

# A meeting note's citation of a transcript line ("[00:04](…#b-t3)", "[#3](…#b-t3)"): not part of the to-do.
_CITE = re.compile(r"\s*\[(?:#?\d{1,4}|\d{1,2}:\d{2}(?::\d{2})?)\]\([^)\s]*#b-t\d+\)")

_TODO = re.compile(r"^(?P<lead>[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]+)\[(?P<mark>[ xX])\](?P<rest>[ \t].*?)[ \t]*"
                   r"\{#(?P<block>b-[0-9A-Za-z_-]+)[^}]*\}[ \t]*$", re.M)


def _oid(v: Any) -> ObjectId | None:
    try:
        return ObjectId(str(v))
    except Exception:
        return None


# ── Action items ──────────────────────────────────────────────────────────────


async def actions(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, w: search.World) -> dict:
    from app.services import md_outline
    from app.services.ask_markdrop import task_lines

    uid = actor.user_id
    filt = await search.doc_filter(db, actor, ctx, w.member_ws, search.Query(q=""))
    if filt is None or not uid:
        return {"items": [], "more": False}
    filt["$and"].append({"content": {"$regex": re.escape(f'id="{uid}"')}})
    filt["$and"].append({"kind": {"$ne": "artifact"}, "editor": "blocks", "encrypted": {"$ne": True}, "deleted_at": None})
    rows = await db["documents"].find(filt).sort("updated_at", -1).limit(ACTIONS_SCAN).to_list(length=ACTIONS_SCAN)
    out: list[dict] = []
    more = False
    for raw in rows:
        if search_index.title_only(raw):
            continue
        tasks = task_lines(_CITE.sub("", raw.get("content") or ""), uid)
        if not tasks:
            continue
        if not (await access.can(actor, raw, "read", ctx)).allowed:
            continue
        can_tick = (await access.can(actor, raw, "edit_content", ctx)).allowed
        title = md_outline.display_title(raw)
        ws_id = raw.get("workspace_id")
        # "@Bo Order the banners" → "Order the banners": on your own list, your own mention is noise.
        me = {f"@{n}" for n in re.findall(r':person\[([^\]\n]*)\]\{id="' + re.escape(uid) + '"', raw.get("content") or "")}
        for full, anchor in tasks:
            text = full
            for m in me:
                text = text.replace(m, " ")
            text = re.sub(r"\s+", " ", text).strip(" ,;:-") or full
            text = text[:1].upper() + text[1:]
            if len(out) >= ACTIONS_MAX:
                more = True
                break
            out.append({
                "text": text, "slug": raw["slug"], "block": anchor, "title": title,
                "url": f"/{raw['slug']}" + (f"#{anchor}" if anchor else ""),
                "workspace": {"id": ws_id, "name": w.ws_names.get(ws_id)} if ws_id in w.ws_names else None,
                "meeting": bool(raw.get("meeting_id")),
                "updated_at": raw.get("updated_at"),
                "can_tick": bool(can_tick and anchor),
            })
        if more:
            break
    return {"items": out, "more": more}


async def tick(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, slug: str, block: str) -> dict:
    """Mark one of the caller's to-dos done. 404: no such page (or unreadable) / no such to-do;
    403: can't edit the page or the to-do isn't theirs; 409: already done; 423: someone is editing."""
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
        if hit.group("mark") in "xX":
            raise HTTPException(status_code=409, detail="That one is already done.")
        new = content[: hit.start("mark")] + "x" + content[hit.end("mark"):]
        try:
            await pages.check_page_lock(raw, actor, ctx, new)
            await meetings._save(db, raw, new, actor, ctx, base_rev=int(raw.get("rev") or 1))
        except HTTPException as exc:
            if exc.status_code == 409:
                raw = await db["documents"].find_one({"_id": raw["_id"]}) or raw
                continue
            raise
        return {"done": True}
    raise HTTPException(status_code=409, detail="That page keeps changing. Try again in a moment.")


# ── Meetings ──────────────────────────────────────────────────────────────────


async def meetings_across(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, w: search.World) -> dict:
    from app.services import meetings

    since = (ctx.now - timedelta(days=MEETINGS_DAYS)).date().isoformat()
    found: list[dict] = []
    for ws, _role in w.memberships:
        try:
            res = await meetings.list_meetings(db, ws.id, actor, ctx, limit=MEETINGS_MAX, since=since)
        except HTTPException:
            continue
        for m in res["meetings"]:
            m["workspace_name"] = ws.name
            found.append(m)
    found.sort(key=lambda m: (m.get("date") or "", m.get("time") or "", m.get("created_at") or ""), reverse=True)
    keep = ("id", "workspace_id", "workspace_name", "title", "page_title", "slug", "date", "time", "duration_s",
            "type", "series", "attendees", "action_items", "summary", "decisions", "open_questions", "cover",
            "restricted", "ai")
    items = [{k: m.get(k) for k in keep} for m in found[:MEETINGS_MAX]]
    for it in items:
        it["attendees"] = [{"name": a.get("name")} for a in (it.get("attendees") or [])][:6]
        it["attendee_count"] = len([a for a in (it.get("attendees") or [])])
        it["ai"] = {"state": (it.get("ai") or {}).get("state")}
    return {"items": items, "today": ctx.now.date().isoformat()}


# ── Workspaces ────────────────────────────────────────────────────────────────


async def workspaces(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, w: search.World) -> list[dict]:
    from app.models.workspace import role_allows

    if not w.memberships:
        return []
    ids = [ws.id for ws, _ in w.memberships]
    filt = await search.doc_filter(db, actor, ctx, w.member_ws, search.Query(q=""))
    counts: dict[str, int] = {}
    if filt is not None:
        filt["$and"].append({"workspace_id": {"$in": ids}, "deleted_at": None})
        for r in await db["documents"].aggregate([
            {"$match": filt}, {"$group": {"_id": "$workspace_id", "n": {"$sum": 1}}},
        ]).to_list(length=200):
            counts[r["_id"]] = int(r["n"])
    members: dict[str, int] = {}
    for r in await db["memberships"].aggregate([
        {"$match": {"workspace_id": {"$in": ids}}}, {"$group": {"_id": "$workspace_id", "n": {"$sum": 1}}},
    ]).to_list(length=200):
        members[r["_id"]] = int(r["n"])
    meet_counts: dict[str, int] = {}
    for r in await db["meetings"].aggregate([
        {"$match": {"workspace_id": {"$in": ids}}}, {"$group": {"_id": "$workspace_id", "n": {"$sum": 1}}},
    ]).to_list(length=200):
        meet_counts[r["_id"]] = int(r["n"])
    # The first few people of each (owner first, then by joining), with their names and photos.
    firsts: dict[str, list[str]] = {}
    for ws_id in ids:
        rows = await db["memberships"].find({"workspace_id": ws_id}, {"user_id": 1, "role": 1, "created_at": 1}) \
            .sort([("created_at", 1)]).limit(PEOPLE_SHOWN * 3).to_list(length=PEOPLE_SHOWN * 3)
        rows.sort(key=lambda r: (r.get("role") != "owner",))
        firsts[ws_id] = [r["user_id"] for r in rows[:PEOPLE_SHOWN]]
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
