"""Assigned threads and "waiting on you" for Home and Team (CONTRACT §6).

Each thread is shown only while its item still lets the person see comments (perms.perms_for, per item,
once per request). Waiting on you = open threads where you are the assignee, or the newest message
mentions you, or you started it and someone else answered last.
"""

from __future__ import annotations

from bson import ObjectId

from app.services import access, md_outline, urls
from app.services.comments import perms as perms_mod
from app.services.comments.model import MESSAGES, THREADS
from app.services.comments.service import _iso, excerpt, people_map

SCAN = 300
HOME_MAX = 8


def _oid(v) -> ObjectId | None:
    try:
        return ObjectId(str(v))
    except Exception:
        return None


async def _visible(db, actor, ctx, rows: list[dict]) -> tuple[dict[str, dict], dict[str, object]]:
    """The items of ``rows`` the actor may see comments on: doc_id → doc row, and their perms."""
    ids = list({r["doc_id"] for r in rows})
    docs = {str(d["_id"]): d async for d in db["documents"].find(
        {"_id": {"$in": [o for o in (_oid(i) for i in ids) if o]}}, {"content": 0, "search_text": 0, "versions": 0})}
    ok: dict[str, dict] = {}
    perms: dict[str, object] = {}
    for i, d in docs.items():
        # The cheap part of perms.perms_for (no edit / settings checks): eligible, switched on, readable.
        if not actor.user_id or not perms_mod.eligible(d) or d.get("comments_off") is True:
            continue
        if not await access.discoverable(actor, d, ctx):
            continue
        f = await access.facts(actor, d, ctx)
        if f.ws is not None and getattr(f.ws.settings, "comments_enabled", True) is False:
            continue
        ok[i] = d
        perms[i] = True
    return ok, perms


def _reason(t: dict, uid: str, last_mentions: list[str]) -> str | None:
    if t.get("assignee") == uid:
        return "assigned"
    if t.get("last_author_id") != uid and uid in last_mentions:
        return "mentioned"
    if t.get("created_by") == uid and t.get("last_author_id") not in (uid, "", None) \
            and int(t.get("message_count") or 0) > 1:
        return "reply"
    return None


async def _rows(db, uid: str, view: str) -> list[dict]:
    if view == "assigned":
        q = {"assignee": uid, "status": "open", "deleted_at": None}
    elif view == "mentions":
        q = {"mentions": uid, "status": "open", "deleted_at": None}
    else:
        q = {"$or": [{"assignee": uid}, {"mentions": uid}, {"created_by": uid}], "status": "open", "deleted_at": None}
    return await db[THREADS].find(q).sort([("updated_at", -1)]).limit(SCAN).to_list(length=SCAN)


async def _last_messages(db, threads: list[dict]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    if not threads:
        return out
    pipeline = [
        {"$match": {"thread_id": {"$in": [t["_id"] for t in threads]}, "deleted_at": None}},
        {"$sort": {"created_at": -1}},
        {"$group": {"_id": "$thread_id", "m": {"$first": "$$ROOT"}}},
    ]
    async for r in db[MESSAGES].aggregate(pipeline):
        out[str(r["_id"])] = r["m"]
    return out


async def _items(db, actor, ctx, view: str, limit: int) -> tuple[list[dict], int]:
    uid = actor.user_id
    if not uid:
        return [], 0
    rows = await _rows(db, uid, view)
    if not rows:
        return [], 0
    docs, _perms = await _visible(db, actor, ctx, rows)
    rows = [r for r in rows if r["doc_id"] in docs]
    last = await _last_messages(db, rows)
    picked: list[tuple[dict, str]] = []
    for t in rows:
        lm = last.get(str(t["_id"])) or {}
        reason = _reason(t, uid, lm.get("mentions") or [])
        if view == "waiting" and reason is None:
            continue
        picked.append((t, reason or ("assigned" if view == "assigned" else "mentioned")))
    total = len(picked)
    picked = picked[:limit]
    ids = {t.get("assignee") for t, _ in picked} | {(last.get(str(t["_id"])) or {}).get("author_id") for t, _ in picked}
    pm = await people_map(db, {i for i in ids if i})
    out = []
    for t, reason in picked:
        d = docs[t["doc_id"]]
        lm = last.get(str(t["_id"])) or {}
        href = f"/{d['slug']}#c-{t['_id']}"
        author = pm.get(lm.get("author_id")) or {"id": None, "name": lm.get("author_name") or "Someone", "picture": None}
        out.append({
            "thread_id": str(t["_id"]), "slug": d["slug"], "title": md_outline.display_title(d), "href": href,
            "url": urls.markdrop_url(d["slug"]) + f"#c-{t['_id']}",
            "excerpt": excerpt((t.get("anchor") or {}).get("quote", {}).get("exact")
                               if (t.get("anchor") or {}).get("quote") else (t.get("anchor") or {}).get("block_text"), 120)
            or None,
            "status": t.get("status"), "assignee": pm.get(t.get("assignee")) if t.get("assignee") else None,
            "last": {"author": author, "body_excerpt": excerpt(lm.get("body"), 160), "at": _iso(lm.get("created_at"))}
            if lm else None,
            "waiting_reason": reason, "workspace_id": t.get("workspace_id"),
        })
    return out, total


async def mine(db, actor, ctx, *, view: str = "waiting", limit: int = 20) -> dict:
    items, _total = await _items(db, actor, ctx, view, max(1, min(int(limit), 50)))
    return {"items": items}


async def home_section(db, actor, ctx) -> dict:
    items, total = await _items(db, actor, ctx, "waiting", HOME_MAX)
    return {"waiting": items, "waiting_count": total}


async def action_items(db, actor, ctx) -> list[dict]:
    """Home Action items for threads assigned to the caller (``kind: "comment"``); ticking resolves."""
    items, _ = await _items(db, actor, ctx, "assigned", 30)
    out = []
    for it in items:
        lm = it.get("last") or {}
        out.append({
            "kind": "comment", "thread_id": it["thread_id"],
            "text": excerpt(lm.get("body_excerpt") or it.get("excerpt") or "Comment", 160),
            "slug": it["slug"], "block": None, "title": it["title"], "url": it["href"],
            "workspace": None, "meeting": False, "updated_at": lm.get("at"), "date": (lm.get("at") or "")[:10] or None,
            "can_tick": True, "quote": it.get("excerpt"),
        })
    return out


async def team_tasks(db, workspace_id: str, ctx) -> dict[str, list[dict]]:
    """user id → their open assigned threads on the workspace's items (Team view; ≤ 10 each). The
    caller of this (routers/team.py) has already decided the viewer may see the Team page; each item is
    still checked with the *viewer's* access in :func:`team_for_viewer`."""
    rows = await db[THREADS].find({"workspace_id": workspace_id, "status": "open", "deleted_at": None,
                                   "assignee": {"$ne": None}}).sort([("updated_at", -1)]).limit(SCAN) \
        .to_list(length=SCAN)
    out: dict[str, list[dict]] = {}
    for t in rows:
        out.setdefault(t["assignee"], []).append(t)
    return out


async def team_for_viewer(db, actor, ctx, workspace_id: str) -> dict[str, list[dict]]:
    """user id → ``[{thread_id, slug, title, href, excerpt, updated_at}]`` of open assigned threads the viewer
    can see (Team view)."""
    by_user = await team_tasks(db, workspace_id, ctx)
    rows = [t for ts in by_user.values() for t in ts]
    docs, _ = await _visible(db, actor, ctx, rows)
    out: dict[str, list[dict]] = {}
    for uid, ts in by_user.items():
        for t in ts:
            d = docs.get(t["doc_id"])
            if d is None or d.get("workspace_id") != workspace_id:
                continue  # unreadable, or moved to another workspace since
            a = t.get("anchor") or {}
            out.setdefault(uid, []).append({
                "thread_id": str(t["_id"]), "slug": d["slug"], "title": md_outline.display_title(d),
                "href": f"/{d['slug']}#c-{t['_id']}",
                "excerpt": excerpt((a.get("quote") or {}).get("exact") or a.get("block_text") or "", 120) or None,
                "updated_at": _iso(t.get("updated_at")),
            })
    return {u: v[:10] for u, v in out.items()}


async def access_ok(db, actor, raw) -> bool:
    return (await access.can(actor, raw, "read", access.Ctx(db))).allowed
