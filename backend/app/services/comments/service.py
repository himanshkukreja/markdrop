"""Threads and messages (CONTRACT §4). Every public function decides access itself (perms.require).

Cost: anonymous readers of an item that doesn't show its comments publicly never reach here (the read
answers ``comments.can_view = false`` and the page asks nothing). A signed-in reader's list is three
indexed queries (threads by ``doc_id``, their messages by ``thread_id``, the people in them), plus a
re-anchor pass only when the item changed since the threads were last anchored. Counts for cards and the
document read come from ``documents.comment_counts``.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from datetime import datetime, timezone
from typing import Any

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import ReturnDocument

from app.services import access
from app.services.comments import anchoring, events, perms as perms_mod
from app.services.comments.model import (
    AI_NAME,
    DELETED_NAME,
    HISTORY_MAX,
    MAX_BODY,
    MAX_MENTIONS,
    MAX_MESSAGES_PER_THREAD,
    MAX_REACTIONS,
    MAX_THREADS_PER_ITEM,
    MESSAGES,
    THREADS,
)
from app.services.comments.perms import CommentPerms

log = logging.getLogger(__name__)

EXCERPT = 200
LIST_MAX = 2000


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _oid(v: Any) -> ObjectId | None:
    if isinstance(v, ObjectId):
        return v
    try:
        return ObjectId(str(v))
    except Exception:
        return None


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat().replace("+00:00", "Z")


def _err(status: int, detail: str, code: str) -> HTTPException:
    return perms_mod._err(status, detail, code)


def _not_found(what: str = "thread") -> HTTPException:
    return _err(404, "That comment isn't there any more." if what == "message" else
                "That thread isn't there any more.", "not_found")


def excerpt(text: str | None, n: int = EXCERPT) -> str:
    t = re.sub(r"\s+", " ", text or "").strip()
    return t if len(t) <= n else t[: n - 1].rstrip() + "…"


def item_kind(raw: dict) -> str:
    return "page" if raw.get("editor") == "blocks" else "markdown"


def _clean_body(body: str | None) -> str:
    b = (body or "").replace("\r\n", "\n").replace("\x00", "").strip()
    if not b:
        raise _err(422, "Write something first.", "empty")
    if len(b) > MAX_BODY:
        raise _err(422, f"Comments can be up to {MAX_BODY} characters.", "too_long")
    return b


# ── People ────────────────────────────────────────────────────────────────────


def _display_name(row: dict | None) -> str:
    if not row:
        return DELETED_NAME
    name = (row.get("name") or "").strip()
    if not name:
        name = (row.get("email") or "").split("@", 1)[0] or "Someone"
    return name[:60]


async def people_map(db: AsyncIOMotorDatabase, ids) -> dict[str, dict]:
    """user id → Person (``{"id","name","picture"}``); no emails, ever."""
    oids = [o for o in (_oid(i) for i in set(ids) if i) if o is not None]
    if not oids:
        return {}
    out = {}
    async for u in db["users"].find({"_id": {"$in": oids}}, {"name": 1, "email": 1, "picture": 1}):
        pic = u.get("picture")
        out[str(u["_id"])] = {"id": str(u["_id"]), "name": _display_name(u),
                              "picture": pic if isinstance(pic, str) and pic.startswith("https://") else None}
    return out


def _person(pm: dict[str, dict], uid: str | None, fallback: str | None = None) -> dict | None:
    if uid is None and fallback is None:
        return None
    if uid and uid in pm:
        return pm[uid]
    return {"id": None, "name": fallback or DELETED_NAME, "picture": None}


# ── Output ────────────────────────────────────────────────────────────────────


def _message_out(m: dict, thread: dict, pm: dict, viewer: str | None, p: CommentPerms) -> dict:
    deleted = m.get("deleted_at") is not None
    reactions = []
    for emoji, who in (m.get("reactions") or {}).items():
        if not who:
            continue
        reactions.append({"emoji": emoji, "count": len(who), "mine": bool(viewer) and viewer in who,
                          "names": [(_person(pm, u) or {}).get("name") for u in who[:10]]})
    mine = bool(viewer) and m.get("author_id") == viewer
    is_comment = (m.get("kind") or "comment") == "comment"
    if m.get("ai"):
        author = {"id": None, "name": m.get("author_name") or AI_NAME, "picture": None}
    else:
        # An account that no longer exists reads as "Deleted account", whatever name was stored.
        author = _person(pm, m.get("author_id"), DELETED_NAME if m.get("author_id") else
                         (m.get("author_name") or DELETED_NAME))
    return {
        "id": str(m["_id"]), "thread_id": str(thread["_id"]),
        "author": author,
        "body": "" if deleted else (m.get("body") or ""),
        "mentions": [] if deleted else [x for x in (_person(pm, u) for u in (m.get("mentions") or [])) if x],
        "attachments": [] if deleted else [
            {k: a.get(k) for k in ("id", "name", "mime", "size", "url")} for a in (m.get("attachments") or [])],
        "reactions": [] if deleted else reactions,
        "created_at": _iso(m.get("created_at")), "edited_at": _iso(m.get("edited_at")),
        "deleted": deleted, "via_ai": m.get("via") == "mcp", "ai": bool(m.get("ai")),
        "kind": m.get("kind") or "comment",
        "can": {"edit": bool(mine and not deleted and is_comment and p.comment),
                "delete": bool(not deleted and is_comment and p.comment and (mine or p.moderate))},
    }


def _anchor_out(a: dict | None) -> dict:
    a = a or {}
    return {"type": a.get("type") or "page", "block_id": a.get("block_id"), "quote": a.get("quote"),
            "block_text": a.get("block_text"), "start": a.get("start")}


def _ids_in(thread: dict, messages: list[dict]) -> set[str]:
    ids = {thread.get("created_by"), thread.get("resolved_by"), thread.get("assignee")}
    s = thread.get("suggestion") or {}
    ids |= {s.get("by"), s.get("decided_by")}
    for h in thread.get("history") or []:
        ids |= {h.get("by"), h.get("to")}
    for m in messages:
        ids.add(m.get("author_id"))
        ids |= set(m.get("mentions") or [])
        for who in (m.get("reactions") or {}).values():
            ids |= set(who[:10])
    return {i for i in ids if i}


def _thread_out(thread: dict, messages: list[dict], pm: dict, viewer: str | None, p: CommentPerms) -> dict:
    author = thread.get("created_by") or None
    mine = bool(viewer) and author == viewer
    can_resolve = bool(p.comment and (p.resolve_any or mine or (bool(viewer) and thread.get("assignee") == viewer)))
    s = thread.get("suggestion")
    sugg = None
    if s:
        sugg = {"text": s.get("text") or "", "state": s.get("state") or "open",
                "by": _person(pm, s.get("by"), DELETED_NAME), "at": _iso(s.get("at")),
                "decided_by": _person(pm, s.get("decided_by")) if s.get("decided_by") else None,
                "decided_at": _iso(s.get("decided_at")), "version_id": s.get("version_id")}
    hist = [{"action": h.get("action"), "by": _person(pm, h.get("by")) if h.get("by") else None,
             "at": _iso(h.get("at")), "to": _person(pm, h.get("to")) if h.get("to") else None,
             "version_id": h.get("version_id")} for h in (thread.get("history") or [])]
    return {
        "id": str(thread["_id"]),
        "anchor": _anchor_out(thread.get("anchor")),
        "original": {"exact": (thread.get("original") or {}).get("exact"),
                     "block_text": (thread.get("original") or {}).get("block_text")},
        "anchor_status": thread.get("anchor_status") or "attached",
        "status": thread.get("status") or "open",
        "created_by": _person(pm, author, DELETED_NAME),
        "created_at": _iso(thread.get("created_at")), "updated_at": _iso(thread.get("updated_at")),
        "resolved_by": _person(pm, thread.get("resolved_by")) if thread.get("resolved_by") else None,
        "resolved_at": _iso(thread.get("resolved_at")),
        "assignee": _person(pm, thread.get("assignee")) if thread.get("assignee") else None,
        "assigned_at": _iso(thread.get("assigned_at")),
        "message_count": int(thread.get("message_count") or 0),
        "messages": [_message_out(m, thread, pm, viewer, p) for m in messages],
        "suggestion": sugg,
        "history": hist,
        "can": {"reply": bool(p.comment), "resolve": can_resolve and thread.get("status") == "open",
                "reopen": can_resolve and thread.get("status") == "resolved",
                "assign": bool(p.comment and (p.assign or mine)), "accept": bool(p.accept),
                "delete": bool(p.comment and (mine or p.moderate))},
    }


async def _messages_for(db, thread_ids: list[ObjectId]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    if not thread_ids:
        return out
    cur = db[MESSAGES].find({"thread_id": {"$in": thread_ids}}).sort([("created_at", 1), ("_id", 1)])
    async for m in cur:
        out.setdefault(str(m["thread_id"]), []).append(m)
    return out


def _visible_messages(ms: list[dict]) -> list[dict]:
    """Deleted replies drop out; a deleted first message stays as "deleted" while replies follow it."""
    out = []
    for i, m in enumerate(ms):
        if m.get("deleted_at") is not None and i > 0:
            continue
        out.append(m)
    return out


async def thread_out(db, actor, raw, ctx, thread: dict, perms: CommentPerms | None = None) -> dict:
    p = perms or await perms_mod.perms_for(db, actor, raw, ctx)
    ms = _visible_messages((await _messages_for(db, [thread["_id"]])).get(str(thread["_id"]), []))
    pm = await people_map(db, _ids_in(thread, ms))
    return _thread_out(thread, ms, pm, actor.user_id, p)


# ── Reading ───────────────────────────────────────────────────────────────────


async def load_thread(db, doc_id: str, thread_id: str) -> dict | None:
    oid = _oid(thread_id)
    if oid is None:
        return None
    return await db[THREADS].find_one({"_id": oid, "doc_id": str(doc_id), "deleted_at": None})


async def _thread_or_404(db, raw: dict, thread_id: str) -> dict:
    t = await load_thread(db, str(raw["_id"]), thread_id)
    if t is None:
        raise _not_found()
    return t


async def _fresh_anchors(db, raw: dict) -> None:
    """Lazy re-anchor: a write path that skipped on_content_saved (or a failure there) still ends
    with every thread resolved against the item's current text."""
    rev = int(raw.get("rev") or 1)
    stale = await db[THREADS].find_one(
        {"doc_id": str(raw["_id"]), "deleted_at": None, "anchor.type": {"$in": ["text", "block"]},
         "anchor.rev": {"$ne": rev}}, {"_id": 1})
    if stale is not None:
        await anchoring.reanchor_item(db, raw)


async def list_threads(db, actor, raw, ctx, *, status: str = "all", mine: bool = False) -> dict:
    p = await perms_mod.require(db, actor, raw, ctx, "view")
    await _fresh_anchors(db, raw)
    q: dict = {"doc_id": str(raw["_id"]), "deleted_at": None}
    if status in ("open", "resolved"):
        q["status"] = status
    if mine and actor.user_id:
        q["$or"] = [{"participants": actor.user_id}, {"assignee": actor.user_id}, {"created_by": actor.user_id}]
    threads = await db[THREADS].find(q).sort([("created_at", 1), ("_id", 1)]).to_list(length=LIST_MAX)
    msgs = await _messages_for(db, [t["_id"] for t in threads])
    ids: set[str] = set()
    vis: dict[str, list[dict]] = {}
    for t in threads:
        vis[str(t["_id"])] = _visible_messages(msgs.get(str(t["_id"]), []))
        ids |= _ids_in(t, vis[str(t["_id"])])
    pm = await people_map(db, ids)
    counts = raw.get("comment_counts") or {}
    return {
        "enabled": p.enabled, "public": p.public, "can": p.as_dict(),
        "counts": {"open": int(counts.get("open") or 0), "resolved": int(counts.get("resolved") or 0)},
        "rev": int(raw.get("comments_rev") or 0),
        "threads": [_thread_out(t, vis[str(t["_id"])], pm, actor.user_id, p) for t in threads],
    }


async def get_thread(db, actor, raw, ctx, thread_id: str) -> dict:
    p = await perms_mod.require(db, actor, raw, ctx, "view")
    t = await _thread_or_404(db, raw, thread_id)
    return await thread_out(db, actor, raw, ctx, t, p)


async def summary_for_read(db, actor, raw, ctx) -> dict | None:
    """``DocumentResponse.comments``."""
    if not perms_mod.eligible(raw):
        return None
    p = await perms_mod.perms_for(db, actor, raw, ctx)
    if not p.eligible or p.reason == "no_access":
        return None
    counts = raw.get("comment_counts") or {}
    return {"enabled": p.enabled, "public": p.public,
            "open": int(counts.get("open") or 0) if p.view else None,
            "can_view": p.view, "can_comment": p.comment, "reason": p.reason,
            "settings": p.settings}


# ── Writing helpers ───────────────────────────────────────────────────────────


async def recount(db, doc_id: str) -> dict:
    counts = {"open": 0, "resolved": 0}
    async for r in db[THREADS].aggregate([
        {"$match": {"doc_id": str(doc_id), "deleted_at": None}},
        {"$group": {"_id": "$status", "n": {"$sum": 1}}},
    ]):
        if r["_id"] in counts:
            counts[r["_id"]] = int(r["n"])
    oid = _oid(doc_id)
    if oid is not None:
        await db["documents"].update_one({"_id": oid}, {"$set": {"comment_counts": counts}})
    return counts


async def _bump(db, raw: dict) -> dict:
    """documents.comments_rev += 1; returns ``raw`` updated (rev, counts) for the live event."""
    row = await db["documents"].find_one_and_update(
        {"_id": raw["_id"]}, {"$inc": {"comments_rev": 1}},
        projection={"comments_rev": 1, "comment_counts": 1, "comments_public": 1, "slug": 1},
        return_document=ReturnDocument.AFTER)
    if row:
        raw = {**raw, "comments_rev": row.get("comments_rev"), "comment_counts": row.get("comment_counts"),
               "comments_public": row.get("comments_public"), "slug": row.get("slug") or raw.get("slug")}
    return raw


def live_event(doc: dict, thread: dict, op: str) -> None:
    from app.services import live

    if not doc or not doc.get("slug"):
        return
    tid = thread.get("_id") if thread else None
    live.notify(doc["slug"], {"type": "comments", "rev": int(doc.get("comments_rev") or 0),
                              "thread": str(tid) if tid else None, "op": op,
                              "pub": doc.get("comments_public") is True})


async def touch(db, raw: dict, thread: dict, *, op: str, actor=None, message: dict | None = None) -> None:
    """Bump the item's comments rev and tell open pages (B calls after writing ``suggestion``)."""
    raw = await _bump(db, raw)
    live_event(raw, thread, op)


async def _emit(db, kind: str, raw: dict, thread: dict, *, message: dict | None = None, actor=None,
                new_mentions=(), extra: dict | None = None) -> None:
    raw = await _bump(db, raw)
    await events.emit(db, kind, doc=raw, thread=thread, message=message, actor=actor,
                      new_mentions=list(new_mentions), extra=extra)


def _hist(action: str, by: str | None, *, to: str | None = None, version_id: str | None = None) -> dict:
    return {"action": action, "by": by, "at": _now(), "to": to, "version_id": version_id}


async def _workspace_of(db, actor, raw, ctx) -> str | None:
    try:
        return (await access.facts(actor, raw, ctx)).ws_id
    except Exception:
        return raw.get("workspace_id")


def _actor_name(actor) -> str:
    return _display_name({"name": getattr(actor.user, "name", None), "email": getattr(actor.user, "email", "")})


async def _assignee_ok(db, raw: dict, ctx, user_id: str) -> bool:
    from app.services import user as user_service

    u = await user_service.get_user_by_id(db, user_id)
    if u is None:
        return False
    p = await perms_mod.perms_for(db, access.Actor.of(u), raw, access.Ctx(db))
    return p.comment


# ── Threads ───────────────────────────────────────────────────────────────────


async def create_thread(db, actor, raw, ctx, *, anchor: dict, body: str, mentions: list[str] | None = None,
                        assignee: str | None = None, via: str | None = None,
                        attachments: list[str] | None = None, suggestion: str | None = None) -> dict:
    from app.services.comments import attachments as att_mod, people, suggestions

    p = await perms_mod.require(db, actor, raw, ctx, "comment")
    body = _clean_body(body)
    n = await db[THREADS].count_documents({"doc_id": str(raw["_id"]), "deleted_at": None})
    if n >= MAX_THREADS_PER_ITEM:
        raise _err(422, "This item has as many comment threads as it can hold. Resolve or delete some first.",
                   "too_many")
    try:
        a = anchoring.make_anchor(raw.get("content") or "", anchor, int(raw.get("rev") or 1))
    except anchoring.AnchorError as exc:
        raise _err(422, str(exc), exc.code)
    ids = await people.valid_mentions(db, raw, ctx, mentions)
    if assignee:
        # The thread's author may assign their own new thread (CONTRACT §3: editors and the author).
        if not await _assignee_ok(db, raw, ctx, assignee):
            raise _err(422, "That person can't open this item, so they can't be assigned.", "assignee")
    att = await att_mod.resolve_ids(db, raw, actor, attachments)
    now = _now()
    uid = actor.user_id
    participants = list(dict.fromkeys([uid, *ids, *([assignee] if assignee else [])]))
    thread = {
        "doc_id": str(raw["_id"]), "workspace_id": await _workspace_of(db, actor, raw, ctx),
        "item_kind": item_kind(raw), "anchor": a,
        "original": {"exact": (a.get("quote") or {}).get("exact"), "block_text": a.get("block_text")},
        "anchor_status": "attached", "status": "open", "created_by": uid, "created_at": now, "updated_at": now,
        "resolved_by": None, "resolved_at": None,
        "assignee": assignee or None, "assigned_by": uid if assignee else None, "assigned_at": now if assignee else None,
        "participants": participants, "mentions": ids, "message_count": 1, "last_message_at": now,
        "last_author_id": uid, "history": [_hist("assigned", uid, to=assignee)] if assignee else [],
        "suggestion": None, "deleted_at": None,
    }
    res = await db[THREADS].insert_one(thread)
    thread["_id"] = res.inserted_id
    msg = {"thread_id": thread["_id"], "doc_id": str(raw["_id"]), "author_id": uid, "author_name": _actor_name(actor),
           "body": body, "mentions": ids, "attachments": att, "reactions": {}, "created_at": now,
           "edited_at": None, "deleted_at": None, "via": via, "ai": False, "kind": "comment"}
    mres = await db[MESSAGES].insert_one(msg)
    msg["_id"] = mres.inserted_id
    if suggestion:
        got = await suggestions.on_create(db, raw, thread, suggestion, actor)
        if got:
            thread = got
    await recount(db, str(raw["_id"]))
    await _emit(db, "thread_created", raw, thread, message=msg, actor=actor, new_mentions=ids)
    if assignee:
        await events.emit(db, "assigned", doc=raw, thread=thread, actor=actor, extra={"assignee": assignee})
    return await thread_out(db, actor, raw, ctx, thread, p)


async def reply(db, actor, raw, ctx, thread_id: str, *, body: str, mentions: list[str] | None = None,
                via: str | None = None, attachments: list[str] | None = None, ai: bool = False,
                kind: str = "comment", suggestion: str | None = None) -> tuple[dict, dict]:
    from app.services.comments import attachments as att_mod, people, suggestions

    if ai or kind == "system":
        p = await perms_mod.require(db, actor, raw, ctx, "view")
    else:
        p = await perms_mod.require(db, actor, raw, ctx, "comment")
    body = _clean_body(body)
    t = await _thread_or_404(db, raw, thread_id)
    if int(t.get("message_count") or 0) >= MAX_MESSAGES_PER_THREAD:
        raise _err(422, "This thread is full. Start a new one.", "too_many")
    ids = await people.valid_mentions(db, raw, ctx, mentions) if not ai else []
    att = await att_mod.resolve_ids(db, raw, actor, attachments)
    now = _now()
    uid = None if ai else actor.user_id
    msg = {"thread_id": t["_id"], "doc_id": str(raw["_id"]), "author_id": uid,
           "author_name": AI_NAME if ai else _actor_name(actor), "body": body, "mentions": ids,
           "attachments": att, "reactions": {}, "created_at": now, "edited_at": None, "deleted_at": None,
           "via": via, "ai": bool(ai), "kind": kind if kind in ("comment", "system") else "comment"}
    mres = await db[MESSAGES].insert_one(msg)
    msg["_id"] = mres.inserted_id
    upd: dict = {"$set": {"updated_at": now, "last_message_at": now},
                 "$inc": {"message_count": 1}}
    if uid:
        upd["$set"]["last_author_id"] = uid
        upd["$addToSet"] = {"participants": {"$each": [uid, *ids]}, "mentions": {"$each": ids}}
    reopened = False
    if t.get("status") == "resolved" and not ai and kind == "comment":
        # Replying to a resolved thread opens it again (as in Google Docs).
        upd["$set"].update({"status": "open", "resolved_by": None, "resolved_at": None})
        upd["$push"] = {"history": {"$each": [_hist("reopened", uid)], "$slice": -HISTORY_MAX}}
        reopened = True
    t = await db[THREADS].find_one_and_update({"_id": t["_id"]}, upd, return_document=ReturnDocument.AFTER)
    if suggestion and not ai:
        got = await suggestions.on_create(db, raw, t, suggestion, actor)
        if got:
            t = got
    if reopened:
        await recount(db, str(raw["_id"]))
    await _emit(db, "replied", raw, t, message=msg, actor=actor, new_mentions=ids)
    if reopened:
        await events.emit(db, "reopened", doc=raw, thread=t, actor=actor)
    out = await thread_out(db, actor, raw, ctx, t, p)
    pm = await people_map(db, _ids_in(t, [msg]))
    return out, _message_out(msg, t, pm, actor.user_id, p)


async def _message_or_404(db, t: dict, message_id: str) -> dict:
    oid = _oid(message_id)
    m = await db[MESSAGES].find_one({"_id": oid, "thread_id": t["_id"]}) if oid else None
    if m is None or m.get("deleted_at") is not None:
        raise _not_found("message")
    return m


async def _recompute_mentions(db, t: dict) -> list[str]:
    ids: list[str] = []
    async for m in db[MESSAGES].find({"thread_id": t["_id"], "deleted_at": None}, {"mentions": 1}):
        for u in m.get("mentions") or []:
            if u not in ids:
                ids.append(u)
    return ids


async def edit_message(db, actor, raw, ctx, thread_id: str, message_id: str, *, body: str,
                       mentions: list[str] | None = None) -> dict:
    from app.services.comments import people

    p = await perms_mod.require(db, actor, raw, ctx, "comment")
    t = await _thread_or_404(db, raw, thread_id)
    m = await _message_or_404(db, t, message_id)
    if m.get("author_id") != actor.user_id or (m.get("kind") or "comment") != "comment" or m.get("ai"):
        raise _err(403, "You can only edit your own comments.", "forbidden")
    body = _clean_body(body)
    ids = await people.valid_mentions(db, raw, ctx, mentions)
    new_ids = [u for u in ids if u not in (m.get("mentions") or [])]
    now = _now()
    m = await db[MESSAGES].find_one_and_update(
        {"_id": m["_id"]}, {"$set": {"body": body, "mentions": ids, "edited_at": now}},
        return_document=ReturnDocument.AFTER)
    all_mentions = await _recompute_mentions(db, t)
    t = await db[THREADS].find_one_and_update(
        {"_id": t["_id"]},
        {"$set": {"updated_at": now, "mentions": all_mentions}, "$addToSet": {"participants": {"$each": ids}}},
        return_document=ReturnDocument.AFTER)
    await _emit(db, "message_edited", raw, t, message=m, actor=actor, new_mentions=new_ids)
    pm = await people_map(db, _ids_in(t, [m]))
    return _message_out(m, t, pm, actor.user_id, p)


async def delete_message(db, actor, raw, ctx, thread_id: str, message_id: str) -> None:
    p = await perms_mod.require(db, actor, raw, ctx, "comment")
    t = await _thread_or_404(db, raw, thread_id)
    m = await _message_or_404(db, t, message_id)
    if (m.get("kind") or "comment") != "comment":
        raise _err(403, "That note can't be deleted.", "forbidden")
    if m.get("author_id") != actor.user_id and not p.moderate:
        raise _err(403, "You can only delete your own comments.", "forbidden")
    now = _now()
    await db[MESSAGES].update_one({"_id": m["_id"]}, {"$set": {
        "deleted_at": now, "body": "", "mentions": [], "attachments": [], "reactions": {}}})
    live = await db[MESSAGES].count_documents({"thread_id": t["_id"], "deleted_at": None})
    sets: dict = {"updated_at": now, "message_count": live, "mentions": await _recompute_mentions(db, t)}
    if live == 0:
        sets["deleted_at"] = now
    t = await db[THREADS].find_one_and_update({"_id": t["_id"]}, {"$set": sets}, return_document=ReturnDocument.AFTER)
    if live == 0:
        await recount(db, str(raw["_id"]))
    await _emit(db, "message_deleted", raw, t, message=m, actor=actor, extra={"thread_deleted": live == 0})


async def resolve(db, actor, raw, ctx, thread_id: str, *, via: str | None = None) -> dict:
    t = await _thread_or_404(db, raw, thread_id)
    p = await perms_mod.require(db, actor, raw, ctx, "resolve", t)
    if t.get("status") == "resolved":
        return await thread_out(db, actor, raw, ctx, t, p)
    now = _now()
    t = await db[THREADS].find_one_and_update(
        {"_id": t["_id"], "status": "open"},
        {"$set": {"status": "resolved", "resolved_by": actor.user_id, "resolved_at": now, "updated_at": now},
         "$push": {"history": {"$each": [_hist("resolved", actor.user_id)], "$slice": -HISTORY_MAX}}},
        return_document=ReturnDocument.AFTER) or await _thread_or_404(db, raw, thread_id)
    await recount(db, str(raw["_id"]))
    await _emit(db, "resolved", raw, t, actor=actor, extra={"via": via})
    return await thread_out(db, actor, raw, ctx, t, p)


async def reopen(db, actor, raw, ctx, thread_id: str, *, via: str | None = None) -> dict:
    t = await _thread_or_404(db, raw, thread_id)
    p = await perms_mod.require(db, actor, raw, ctx, "resolve", t)
    if t.get("status") == "open":
        return await thread_out(db, actor, raw, ctx, t, p)
    now = _now()
    t = await db[THREADS].find_one_and_update(
        {"_id": t["_id"], "status": "resolved"},
        {"$set": {"status": "open", "resolved_by": None, "resolved_at": None, "updated_at": now},
         "$push": {"history": {"$each": [_hist("reopened", actor.user_id)], "$slice": -HISTORY_MAX}}},
        return_document=ReturnDocument.AFTER) or await _thread_or_404(db, raw, thread_id)
    await recount(db, str(raw["_id"]))
    await _emit(db, "reopened", raw, t, actor=actor, extra={"via": via})
    return await thread_out(db, actor, raw, ctx, t, p)


_EMOJI_BAD = re.compile(r"[A-Za-z0-9<>&\"'`\s\\/{}\[\]()]")


def clean_emoji(emoji: str | None) -> str:
    e = unicodedata.normalize("NFC", (emoji or "").strip())
    if not e or len(e) > 16 or _EMOJI_BAD.search(e) or "." in e or "$" in e:
        raise _err(422, "Pick an emoji.", "emoji")
    if not any(unicodedata.category(ch) in ("So", "Sk", "Sm") or ord(ch) >= 0x2190 for ch in e):
        raise _err(422, "Pick an emoji.", "emoji")
    return e


async def react(db, actor, raw, ctx, thread_id: str, message_id: str, emoji: str, *, on: bool | None = None) -> dict:
    p = await perms_mod.require(db, actor, raw, ctx, "comment")
    t = await _thread_or_404(db, raw, thread_id)
    m = await _message_or_404(db, t, message_id)
    e = clean_emoji(emoji)
    uid = actor.user_id
    who = (m.get("reactions") or {}).get(e) or []
    turn_on = (uid not in who) if on is None else bool(on)
    if turn_on and e not in (m.get("reactions") or {}) and len(m.get("reactions") or {}) >= MAX_REACTIONS:
        raise _err(422, "That comment has as many different reactions as it can hold.", "too_many")
    key = f"reactions.{e}"
    if turn_on:
        m = await db[MESSAGES].find_one_and_update({"_id": m["_id"]}, {"$addToSet": {key: uid}},
                                                   return_document=ReturnDocument.AFTER)
    else:
        m = await db[MESSAGES].find_one_and_update({"_id": m["_id"]}, {"$pull": {key: uid}},
                                                   return_document=ReturnDocument.AFTER)
        if not (m.get("reactions") or {}).get(e):
            m = await db[MESSAGES].find_one_and_update({"_id": m["_id"], key: {"$size": 0}}, {"$unset": {key: ""}},
                                                       return_document=ReturnDocument.AFTER) or m
    await db[THREADS].update_one({"_id": t["_id"]}, {"$set": {"updated_at": _now()}})
    await _emit(db, "reacted", raw, t, message=m, actor=actor, extra={"emoji": e, "on": turn_on})
    pm = await people_map(db, _ids_in(t, [m]))
    return _message_out(m, t, pm, uid, p)


async def assign(db, actor, raw, ctx, thread_id: str, assignee: str | None) -> dict:
    t = await _thread_or_404(db, raw, thread_id)
    p = await perms_mod.require(db, actor, raw, ctx, "assign", t)
    now = _now()
    if assignee:
        if not await _assignee_ok(db, raw, ctx, assignee):
            raise _err(422, "That person can't open this item, so they can't be assigned.", "assignee")
        if t.get("assignee") == assignee:
            return await thread_out(db, actor, raw, ctx, t, p)
        t = await db[THREADS].find_one_and_update(
            {"_id": t["_id"]},
            {"$set": {"assignee": assignee, "assigned_by": actor.user_id, "assigned_at": now, "updated_at": now},
             "$addToSet": {"participants": assignee},
             "$push": {"history": {"$each": [_hist("assigned", actor.user_id, to=assignee)], "$slice": -HISTORY_MAX}}},
            return_document=ReturnDocument.AFTER)
        await _emit(db, "assigned", raw, t, actor=actor, extra={"assignee": assignee})
    else:
        if not t.get("assignee"):
            return await thread_out(db, actor, raw, ctx, t, p)
        was = t.get("assignee")
        t = await db[THREADS].find_one_and_update(
            {"_id": t["_id"]},
            {"$set": {"assignee": None, "assigned_by": None, "assigned_at": None, "updated_at": now},
             "$push": {"history": {"$each": [_hist("unassigned", actor.user_id, to=was)], "$slice": -HISTORY_MAX}}},
            return_document=ReturnDocument.AFTER)
        await _emit(db, "unassigned", raw, t, actor=actor, extra={"assignee": was})
    return await thread_out(db, actor, raw, ctx, t, p)


async def update_settings(db, actor, raw, ctx, *, enabled: bool | None = None, public: bool | None = None) -> dict:
    p = await perms_mod.require(db, actor, raw, ctx, "settings")
    sets: dict = {}
    if enabled is not None:
        sets["comments_off"] = not enabled
    if public is not None:
        sets["comments_public"] = bool(public)
    if sets:
        await db["documents"].update_one({"_id": raw["_id"]}, {"$set": sets})
        # The server-rendered page carries the comments switches: cached renders go.
        try:
            from app.services import revalidate

            await revalidate.purge_doc(db, {**raw, **sets})
        except Exception:
            log.exception("comments: purging the page after a settings change failed")
        was_public = raw.get("comments_public") is True
        raw = {**raw, **sets}
        bumped = await _bump(db, raw)
        # Everyone on the page re-reads (the event goes to anonymous readers when the comments were or are public).
        live_event({**bumped, "comments_public": was_public or bumped.get("comments_public") is True},
                   {"_id": None}, "settings_changed")
        from app.services.comments import events as ev

        for name, (fn, ks) in list(ev._handlers.items()):
            if ks is None or "settings_changed" in ks:
                await ev._run(db, name, fn, ev.CommentEvent(kind="settings_changed", doc=bumped, thread={},
                                                            message=None, actor=actor, extra=sets))
    return {"enabled": raw.get("comments_off") is not True, "public": raw.get("comments_public") is True,
            "workspace_enabled": p.workspace_enabled}


async def open_threads(db, doc_id: str) -> list[dict]:
    return await db[THREADS].find({"doc_id": str(doc_id), "status": "open", "deleted_at": None}) \
        .sort([("created_at", 1)]).to_list(length=LIST_MAX)


async def on_item_deleted(db, doc_id: str) -> None:
    """The item was purged: its threads and messages go with it."""
    await db[THREADS].delete_many({"doc_id": str(doc_id)})
    await db[MESSAGES].delete_many({"doc_id": str(doc_id)})


async def anonymise_user(db, user_id: str) -> int:
    """Account deletion (CONTRACT §9): their words stay (the discussion still makes sense), their name goes."""
    uid = str(user_id)
    res = await db[MESSAGES].update_many({"author_id": uid},
                                         {"$set": {"author_id": None, "author_name": DELETED_NAME}})
    await db[MESSAGES].update_many({"mentions": uid}, {"$pull": {"mentions": uid}})
    # Their reactions: remove from every message that has one (keys are emoji; done per message).
    async for m in db[MESSAGES].find({"reactions": {"$exists": True, "$ne": {}}}, {"reactions": 1}):
        reacts = m.get("reactions") or {}
        if any(uid in who for who in reacts.values()):
            new = {e: [u for u in who if u != uid] for e, who in reacts.items()}
            new = {e: who for e, who in new.items() if who}
            await db[MESSAGES].update_one({"_id": m["_id"]}, {"$set": {"reactions": new}})
    await db[THREADS].update_many({"created_by": uid}, {"$set": {"created_by": ""}})
    await db[THREADS].update_many({"last_author_id": uid}, {"$set": {"last_author_id": ""}})
    await db[THREADS].update_many({"resolved_by": uid}, {"$set": {"resolved_by": None}})
    await db[THREADS].update_many({"assignee": uid}, {"$set": {"assignee": None, "assigned_at": None}})
    await db[THREADS].update_many({"assigned_by": uid}, {"$set": {"assigned_by": None}})
    await db[THREADS].update_many({"$or": [{"participants": uid}, {"mentions": uid}]},
                                  {"$pull": {"participants": uid, "mentions": uid}})
    await db[THREADS].update_many({"suggestion.by": uid}, {"$set": {"suggestion.by": None}})
    await db[THREADS].update_many({"suggestion.decided_by": uid}, {"$set": {"suggestion.decided_by": None}})
    await db[THREADS].update_many({"history.by": uid}, {"$set": {"history.$[h].by": None}},
                                  array_filters=[{"h.by": uid}])
    await db[THREADS].update_many({"history.to": uid}, {"$set": {"history.$[h].to": None}},
                                  array_filters=[{"h.to": uid}])
    return res.modified_count
