"""Pages: Markdown documents opened in the block editor, with sub-pages.

A page is an ordinary ``documents`` row (``kind`` markdown) with ``editor:
"blocks"``. Everything a document has — slug, links, custom domains, access,
presence, analytics — a page has too. What this module adds:

Sub-pages
---------
``parent_id`` is the parent document's ``_id``. A sub-page lives in its
parent's workspace and folder (``workspace_id`` / ``folder_id`` / ``folder_path``
are copies of the parent's, kept in step by :func:`cascade`), and its address on
a custom domain is ``/<folders…>/<ancestor slugs…>/<slug>`` (``page_path`` holds
the ancestors' slugs, root first).

Access inherits (``access_inherit`` None/True) until access is set on the
sub-page itself (then False). The decision is made in ``access.facts``, which
walks up to the first ancestor with access of its own (never deeper than
``access.MAX_PAGE_DEPTH``) and takes its level, password, workspace and the
grants of every page on the way. The same fields are also copied onto the
sub-page (by :func:`cascade`, through ``transitions.change`` so bytes, epochs,
caches and sockets move in the policy's order) so that listings, which filter
in MongoDB, see what the decision sees. A narrowing anywhere above bumps the
access epoch of every inheriting page below it: their read tickets and signed
image links die with it, and their live sockets get ``access``.

One editor at a time
--------------------
``documents.edit_lock`` (``{user_id, name, at, edited_at, expires_at, hidden_since, dirty}``) is
held only while someone is actually editing. The block editor takes it with its first real change
(``POST /documents/{slug}/lock?intent=edit``; opening a page, clicking or moving the caret take
nothing) and heartbeats it (``intent=heartbeat``, every 30 s, saying whether it changed anything,
whether its tab is hidden and whether it has unsaved changes). It stops holding at the first of
(:func:`_lapse`): ``page_lock_ttl_s`` after the last heartbeat (the tab went away), ``page_lock_idle_s``
after the last change (idle) or ``page_lock_hidden_s`` after the tab was hidden (settings; 2 min, 2 min,
60 s). A heartbeat never takes back a lock that lapsed; the next change does. While someone holds it,
a save from anyone else — and every MCP write except ``append_blocks`` — is a 423 ``{code: "locked",
holder: {name}, idle_s, dirty, releases_in_s, can_take_over, …}`` (:func:`locked_error`). The page's
owner and its workspace's admins can take over (``?take_over=true``; MCP write tools'
``take_over: true``): the holder's editor is told (live ``lock``) and keeps its unsaved text in the
page's version history (``POST …/lock/keep``). The holder appears as ``editing`` in the page's
presence list only while the lock holds.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta, timezone
from contextvars import ContextVar
from typing import Any

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import access, live, publicity

log = logging.getLogger(__name__)

LOCK_TTL = timedelta(minutes=2)  # the default page_lock_ttl_s (see lock_timers)
MAX_CHILDREN = 500
MAX_EMBEDS = 100
EXCERPT_CHARS = 300
SLUG_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_PLACEMENT = ("workspace_id", "folder_id", "folder_path")
_ACCESS = ("access_level", "read_password_hash")
_NO_CONTENT = {"content": 0}


class PageError(HTTPException):
    """An error whose JSON body carries more than a message (``code``, the lock
    holder, the readers before and after a move). Answered as the body itself
    plus ``detail`` (main.py registers the handler)."""

    def __init__(self, status_code: int, body: dict, headers: dict | None = None):
        super().__init__(status_code=status_code, detail=body.get("detail"), headers=headers)
        self.body = body


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def aware(dt: datetime | None) -> datetime | None:
    return publicity.aware(dt)


def iso(dt: datetime | None) -> str | None:
    dt = aware(dt)
    return dt.isoformat().replace("+00:00", "Z") if dt else None


def is_page_capable(raw: dict | None) -> bool:
    """Markdown and not end-to-end encrypted: what the block editor can open."""
    return bool(raw) and raw.get("kind", "markdown") != "artifact" and not raw.get("encrypted")


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db["documents"].create_index("parent_id", sparse=True)
    # Auto covers: picks a stopped process left pending (services/page_covers.finish_stale).
    await db["documents"].create_index("cover_pick", sparse=True)
    from app.services import bookmarks, page_assets, page_links

    await page_assets.ensure_indexes(db)
    await bookmarks.ensure_indexes(db)
    await page_links.ensure_indexes(db)
    from app.services import page_history, signoffs

    await page_history.ensure_indexes(db)
    await signoffs.ensure_indexes(db)


# ── The tree ──────────────────────────────────────────────────────────────────


async def children_rows(db: AsyncIOMotorDatabase, doc_id, *, projection: dict | None = None,
                        limit: int = MAX_CHILDREN) -> list[dict]:
    oid = access.as_oid(doc_id)
    if oid is None:
        return []
    return await db["documents"].find({"parent_id": oid}, projection).sort(
        [("created_at", 1), ("_id", 1)]).to_list(length=limit)


async def descendants(db: AsyncIOMotorDatabase, raw: dict, *, projection: dict | None = None) -> list[dict]:
    """Every page below ``raw`` (breadth first, at most MAX_PAGE_DEPTH levels)."""
    out: list[dict] = []
    level = [raw]
    seen = {str(raw["_id"])}
    for _ in range(access.MAX_PAGE_DEPTH):
        ids = [r["_id"] for r in level]
        if not ids:
            break
        rows = await db["documents"].find({"parent_id": {"$in": ids}}, projection).to_list(length=5000)
        level = [r for r in rows if str(r["_id"]) not in seen]
        for r in level:
            seen.add(str(r["_id"]))
        out.extend(level)
    return out


async def height(db: AsyncIOMotorDatabase, raw: dict) -> int:
    """Levels of sub-pages below ``raw`` (0 for a leaf)."""
    h = 0
    level = [raw["_id"]]
    for _ in range(access.MAX_PAGE_DEPTH + 1):
        rows = await db["documents"].find({"parent_id": {"$in": level}}, {"_id": 1}).to_list(length=5000)
        if not rows:
            return h
        h += 1
        level = [r["_id"] for r in rows]
    return h


async def refresh_page_paths(db: AsyncIOMotorDatabase, root: dict) -> None:
    """Recompute ``page_path`` for every page below ``root`` (after a move or a
    rename): a child's is its parent's plus the parent's slug."""
    level = [root]
    for _ in range(access.MAX_PAGE_DEPTH):
        nxt: list[dict] = []
        for parent in level:
            path = [*(parent.get("page_path") or []), parent["slug"]]
            for child in await children_rows(db, parent["_id"], projection={"slug": 1, "page_path": 1}):
                if list(child.get("page_path") or []) != path:
                    # Its address on a custom domain changed: purge the cached renders.
                    await db["documents"].update_one({"_id": child["_id"]}, {"$set": {"page_path": path}})
                    from app.services import revalidate

                    await revalidate.purge_doc(db, {**child, "page_path": path})
                child["page_path"] = path
                nxt.append(child)
        if not nxt:
            return
        level = nxt


async def cascade(db: AsyncIOMotorDatabase, before: dict, after: dict | None) -> None:
    """After a change to ``after`` (was ``before``), bring its sub-pages in
    step: their workspace and folder always follow it; an inheriting one also
    takes its level and password, and a narrowing (epoch bump) narrows it too.
    Each child goes through ``transitions.change``, which cascades further down.
    A sub-page with access of its own keeps it, except that leaving a workspace
    never widens it (``lifecycle.level_after_leaving``)."""
    if after is None or before is None:
        return
    placement = any((before.get(k) or None) != (after.get(k) or None) for k in _PLACEMENT)
    access_changed = any((before.get(k) or None) != (after.get(k) or None) for k in _ACCESS)
    bumped = publicity.epoch_of(after) != publicity.epoch_of(before)
    if not (placement or access_changed or bumped):
        return
    children = await children_rows(db, after["_id"])
    if not children:
        return
    from app.services import lifecycle, transitions

    leaving = bool(before.get("workspace_id")) and before.get("workspace_id") != after.get("workspace_id")
    ra_left = await publicity.workspace_requires_auth(db, before.get("workspace_id")) if leaving else False
    for child in children:
        sets: dict = {}
        narrows = None
        if placement:
            for k in _PLACEMENT:
                sets[k] = after.get(k) if k != "folder_path" else list(after.get(k) or [])
        if access.inherits(child):
            sets["access_level"] = after.get("access_level") or "link"
            sets["read_password_hash"] = after.get("read_password_hash")
            if bumped:
                narrows = True
        elif leaving:
            level = lifecycle.level_after_leaving(child, ra_left)
            if level != (child.get("access_level") or "link"):
                sets["access_level"] = level
                narrows = True
        if not sets and not narrows:
            continue
        if sets and not narrows and all((child.get(k) or None) == (v or None) for k, v in sets.items()):
            continue
        try:
            await transitions.change(db, child, sets=sets, narrows=narrows)
        except HTTPException:
            log.warning("cascading to sub-page %s failed; left dirty", child.get("slug"), exc_info=True)
            await db["documents"].update_one({"_id": child["_id"]}, {"$set": {"access_dirty": True}})
            if narrows:
                live.access_changed(child.get("slug"))


async def notify_access_tree(db: AsyncIOMotorDatabase, raw: dict | None) -> None:
    """``access`` to every socket on the pages below ``raw`` (a grant on it was
    removed, so fewer people may read them too)."""
    if not raw or raw.get("_id") is None:
        return
    for d in await descendants(db, raw, projection={"slug": 1, "access_inherit": 1, "parent_id": 1}):
        live.access_changed(d.get("slug"))


async def lift_children(db: AsyncIOMotorDatabase, raw: dict) -> int:
    """Before ``raw`` goes: its sub-pages move up one level (to its parent, or
    to the top). One whose access came from ``raw`` keeps exactly the access it
    had (the copied fields become its own); one that inherited through ``raw``
    keeps inheriting, now from ``raw``'s parent (the same source)."""
    children = await children_rows(db, raw["_id"])
    if not children:
        return 0
    new_parent = raw.get("parent_id")
    raw_is_source = not access.inherits(raw)
    path = list(raw.get("page_path") or [])
    for child in children:
        sets: dict = {"parent_id": new_parent, "page_path": path}
        # It stays where it was shown: in raw's workspace and folder (a sub-page's
        # placement is a copy of its parent's; a stale copy would file it elsewhere,
        # or nowhere, the moment raw stops answering for it).
        for k in _PLACEMENT:
            want = list(raw.get(k) or []) if k == "folder_path" else raw.get(k)
            if (child.get(k) or None) != (want or None):
                sets[k] = want
        if access.inherits(child) and (raw_is_source or new_parent is None):
            sets["access_inherit"] = False if new_parent is not None else None
            # Its access becomes its own: exactly what applied through raw, not a
            # copy that may be stale (a cascade that failed leaves it dirty).
            for k in _ACCESS:
                want = raw.get(k) if k != "access_level" else (raw.get(k) or "link")
                if (child.get(k) or None) != (want or None):
                    sets[k] = want
        if any(k in sets for k in (*_PLACEMENT, *_ACCESS)):
            sets["access_dirty"] = True  # the reconciler re-derives bytes and caches from the row
        await db["documents"].update_one({"_id": child["_id"]}, {"$set": sets})
        # The grants on the page that went no longer reach it.
        live.access_changed(child.get("slug"))
        await refresh_page_paths(db, {**child, **sets})
    return len(children)


# ── Readers (move confirmation) ──────────────────────────────────────────────


async def _audience(db: AsyncIOMotorDatabase, doc: dict) -> tuple[tuple, str]:
    """(a comparable key, a sentence) for who can read ``doc`` as it stands —
    or as it would stand, for a hypothetical row (a move not yet made)."""
    ctx = access.Ctx(db)
    inh = await access.inherited(ctx, doc)
    src = doc if inh is None else inh.source
    level = src.get("access_level") or "link"
    pw = src.get("read_password_hash")
    ws_id = src.get("workspace_id")
    ws = await ctx.workspace(ws_id) if ws_id else None
    require_auth = bool(ws is not None and ws.settings.require_auth_to_view)
    ids = [str(doc["_id"])] if doc.get("_id") is not None else []
    owners = {doc.get("owner_id")}
    if inh is not None:
        ids += [str(p["_id"]) for p in inh.chain]
        owners |= {p.get("owner_id") for p in inh.chain}
    grants = await db["document_grants"].find({"document_id": {"$in": ids}}, {"email": 1, "role": 1}).to_list(
        length=2000)
    people: dict[str, str] = {}
    for g in grants:
        if g.get("email"):
            people[g["email"]] = max(people.get(g["email"], ""), g.get("role") or "")
    owners.discard(None)
    key = (level, pw, ws_id if ws is not None else None, require_auth,
           tuple(sorted(people.items())), tuple(sorted(owners)))
    ws_name = getattr(ws, "name", None) or "its workspace"
    if ws is not None and require_auth and level == "link":
        text = f"members of {ws_name}"
    elif level == "link":
        text = "anyone with the link and the password" if pw else "anyone with the link"
    elif level == "workspace":
        text = f"members of {ws_name}"
    else:
        text = "only its owner"
    extra = len(people) + max(0, len(owners) - 1)
    if extra:
        text += f", plus {extra} {'person' if extra == 1 else 'people'} it's shared with"
    return key, text


# ── Locks ─────────────────────────────────────────────────────────────────────


def lock_timers() -> dict:
    """How long a lock holds (settings ``page_lock_*``), sent to the editor with every lock answer
    so its own timers follow the server's (tests shorten them)."""
    from app.config import get_settings

    st = get_settings()
    ttl, idle, hidden = float(st.page_lock_ttl_s), float(st.page_lock_idle_s), float(st.page_lock_hidden_s)
    return {"ttl_s": ttl, "idle_s": idle, "hidden_s": hidden,
            "heartbeat_s": max(1.0, min(30.0, ttl / 4))}


def _lapse(lock: dict) -> tuple[datetime | None, str]:
    """When a lock record stops holding, and why: ``expired`` (no heartbeat for the TTL), ``idle``
    (no change for the idle time) or ``hidden`` (its tab hidden that long)."""
    t = lock_timers()
    exp, why = aware(lock.get("expires_at")), "expired"
    edited = aware(lock.get("edited_at"))
    if edited is not None:
        by_idle = edited + timedelta(seconds=t["idle_s"])
        if exp is None or by_idle < exp:
            exp, why = by_idle, "idle"
    hidden = aware(lock.get("hidden_since"))
    if hidden is not None:
        by_hidden = hidden + timedelta(seconds=t["hidden_s"])
        if exp is None or by_hidden < exp:
            exp, why = by_hidden, "hidden"
    return exp, why


def lock_view(lock: dict | None) -> dict | None:
    """The lock as it stands now, or None when nobody holds the page (no record, or it lapsed:
    see :func:`_lapse`)."""
    if not isinstance(lock, dict):
        return None
    exp, why = _lapse(lock)
    if exp is None or exp <= now_utc():
        return None
    return {"user_id": lock.get("user_id"), "name": lock.get("name") or "Someone", "expires_at": exp,
            "lapse": why, "edited_at": aware(lock.get("edited_at")) or aware(lock.get("at")),
            "hidden": aware(lock.get("hidden_since")) is not None, "dirty": bool(lock.get("dirty"))}


def _ago(seconds: float) -> str:
    s = max(0, int(round(seconds)))
    if s < 60:
        return f"{s} s"
    m = int(round(s / 60))
    if m < 60:
        return f"{m} min"
    h = s // 3600
    return f"{h} h" if h < 24 else f"{h // 24} d"


def lock_facts(lock: dict) -> dict:
    """What a refusal says about a lock (``lock_view``'s shape): how long its holder has been
    idle, whether they have unsaved changes, and when it releases by itself."""
    now = now_utc()
    edited = lock.get("edited_at")
    idle_s = max(0, int((now - edited).total_seconds())) if edited else None
    releases_in = max(0, int((lock["expires_at"] - now).total_seconds() + 0.999))
    return {"idle_s": idle_s, "dirty": bool(lock.get("dirty")), "hidden": bool(lock.get("hidden")),
            "releases_in_s": releases_in, "releases_at": iso(lock["expires_at"])}


def locked_error(lock: dict, *, can_take_over: bool | None = None, mcp: bool = False,
                 taken: dict | None = None) -> PageError:
    """423 ``locked``: who holds the page, how long they've been idle, whether they have unsaved
    changes, when it releases by itself and whether the caller may take over."""
    name = lock.get("name") or "Someone"
    f = lock_facts(lock)
    bits = []
    if f["idle_s"] is not None:
        bits.append("editing right now" if f["idle_s"] < 20 else f"idle for {_ago(f['idle_s'])}")
    if f["hidden"]:
        bits.append("tab in the background")
    bits.append("unsaved changes" if f["dirty"] else "no unsaved changes")
    text = f"{name} is editing this page ({', '.join(bits)}). It releases in about {_ago(f['releases_in_s'])}"
    text += " unless they keep editing." if f["idle_s"] is not None and f["idle_s"] < 20 else "."
    if can_take_over:
        text += (" You can take over: call the tool again with take_over: true (their unsaved changes are "
                 "kept in the page's version history)." if mcp else
                 " As the page's owner or a workspace admin you can take over (Edit anyway).")
    elif can_take_over is False:
        text += " Try again then, or ask its owner or a workspace admin to take over."
    body = {"detail": text, "code": "locked", "holder": {"name": name}, "retryable": True, **f,
            "idle_text": None if f["idle_s"] is None else _ago(f["idle_s"]),
            "releases_text": _ago(f["releases_in_s"]), "can_take_over": can_take_over}
    if taken:
        body["taken_over"] = taken
    return PageError(423, body)


async def may_edit_locked(actor: access.Actor, raw: dict, ctx: access.Ctx) -> bool:
    """A page locked by its ``locked`` property (services/page_props.py) can
    still be edited by its owner (or the edit secret) and its workspace's admins."""
    from app.models.workspace import role_allows

    f = await access.facts(actor, raw, ctx)
    return bool(f.is_owner or f.secret_ok or role_allows(f.ws_role, "admin"))


def page_locked_error() -> PageError:
    return PageError(423, {"detail": "This page is locked. Its owner or a workspace admin can unlock it "
                                     "from the page's ⋯ menu.", "code": "page_locked", "retryable": False})


async def check_page_lock(raw: dict, actor: access.Actor, ctx: access.Ctx,
                          new_content: str | None = None) -> None:
    """423 ``page_locked`` for an edit to a locked page by anyone but its owner
    or a workspace admin; 403 for locking or unlocking it by anyone else."""
    from app.services import page_props

    was = page_props.is_locked(raw.get("content"))
    now = page_props.is_locked(new_content) if new_content is not None else was
    if not was and not now:
        return
    if await may_edit_locked(actor, raw, ctx):
        return
    if was:
        raise page_locked_error()
    raise PageError(403, {"detail": "Only the page's owner or a workspace admin can lock it.",
                          "code": "page_locked"})


# Set by an MCP write tool called with ``take_over: true`` (app/mcp/protocol.py): the write
# takes the page from whoever holds it when the caller may (see :func:`check_write_lock`).
TAKE_OVER: ContextVar[bool] = ContextVar("page_take_over", default=False)


async def may_take_over(actor: access.Actor, raw: dict, ctx: access.Ctx | None) -> bool:
    """The page's owner (or its edit secret) and its workspace's admins and owners."""
    if ctx is None:
        return False
    try:
        return await may_edit_locked(actor, raw, ctx)
    except HTTPException:
        return False


async def _take_from(db: AsyncIOMotorDatabase, raw: dict, held: dict, actor: access.Actor,
                     new_lock: dict | None, *, via: str) -> bool:
    """Replace ``held`` (someone else's lock) with ``new_lock`` (None: nobody, for an MCP write),
    remembering whose it was so their editor can say so and keep their unsaved text. False when
    the lock changed in between."""
    from app.services import viewers

    taken = {"from_user_id": held["user_id"], "from_name": held["name"], "by_user_id": actor.user_id,
             "by_name": viewers.display_name(actor.user) if actor.user is not None else "Someone",
             "at": now_utc(), "via": via, "dirty": bool(held.get("dirty"))}
    res = await db["documents"].update_one(
        {"_id": raw["_id"], "edit_lock.user_id": held["user_id"]},
        {"$set": {"edit_lock": new_lock, "edit_lock_taken": taken}})
    if not res.modified_count:
        return False
    if new_lock is None:
        viewers.set_editor(raw.get("slug"), None, 0)
    # No names on the socket (readers listen too): the editors ask the API what happened.
    live.notify(raw.get("slug"), {"type": "lock", "taken_over": True})
    log.info("page lock taken over (%s)", via)
    return True


def _taken_for(raw: dict, user_id: str | None) -> dict | None:
    """The take-over that took ``user_id``'s lock (in the last hour), for their editor."""
    t = raw.get("edit_lock_taken")
    if not isinstance(t, dict) or not user_id or t.get("from_user_id") != user_id:
        return None
    at = aware(t.get("at"))
    if at is None or at < now_utc() - timedelta(hours=1):
        return None
    return {"by": t.get("by_name") or "Someone", "at": iso(at), "via": t.get("via")}


async def check_write_lock(db: AsyncIOMotorDatabase, raw: dict, actor: access.Actor,
                           ctx: access.Ctx | None = None) -> None:
    """423 when someone holds the page and this write isn't theirs. An MCP
    write is refused whenever anyone holds it (its own user's open editor
    would overwrite it on the next autosave); ``append_blocks`` never asks.
    An MCP write with ``take_over`` (:data:`TAKE_OVER`) by someone who may
    (:func:`may_take_over`) clears the lock first and goes ahead."""
    lock = lock_view(raw.get("edit_lock"))
    if lock is None:
        return
    mcp = actor.cred == "mcp"
    if not mcp and actor.user_id and lock["user_id"] == actor.user_id:
        return
    allowed = await may_take_over(actor, raw, ctx) if ctx is not None else None
    if mcp and TAKE_OVER.get() and allowed:
        if await _take_from(db, raw, lock, actor, None, via="mcp"):
            raw["edit_lock"] = None
            return
        fresh = await db["documents"].find_one({"_id": raw["_id"]}, {"edit_lock": 1})
        return await check_write_lock(db, {**raw, "edit_lock": (fresh or {}).get("edit_lock")}, actor, ctx)
    if mcp and TAKE_OVER.get() and allowed is False:
        raise PageError(403, {"detail": f"{lock['name']} is editing this page, and only the page's owner or a "
                                        "workspace admin can take over. " + locked_error(lock).body["detail"],
                              "code": "take_over_forbidden", "holder": {"name": lock["name"]},
                              **lock_facts(lock), "can_take_over": False})
    raise locked_error(lock, can_take_over=allowed, mcp=mcp)


async def touch_lock(db: AsyncIOMotorDatabase, raw: dict, actor: access.Actor) -> None:
    """A save by the lock's holder: that's an edit (the idle clock restarts) and nothing is
    unsaved any more."""
    if actor.cred == "mcp" or not actor.user_id:
        return
    lock = lock_view(raw.get("edit_lock"))
    if lock is None or lock["user_id"] != actor.user_id:
        return
    now = now_utc()
    await db["documents"].update_one(
        {"_id": raw["_id"], "edit_lock.user_id": actor.user_id},
        {"$set": {"edit_lock.edited_at": now, "edit_lock.dirty": False,
                  "edit_lock.expires_at": now + timedelta(seconds=lock_timers()["ttl_s"])}})


def _free_filter(user_id: str | None, now: datetime) -> dict:
    """The lock is free for ``user_id`` (nobody's, lapsed, or theirs)."""
    t = lock_timers()
    return {"$or": [{"edit_lock": None}, {"edit_lock": {"$exists": False}},
                    {"edit_lock.expires_at": {"$lte": now}},
                    {"edit_lock.edited_at": {"$lte": now - timedelta(seconds=t["idle_s"])}},
                    {"edit_lock.hidden_since": {"$lte": now - timedelta(seconds=t["hidden_s"])}},
                    {"edit_lock.user_id": user_id}]}


def _answer(lock: dict, raw: dict, **extra) -> dict:
    exp, _why = _lapse(lock)
    return {"holder": {"name": lock.get("name") or "Someone"}, "expires_at": iso(exp), "mine": True,
            "rev": int(raw.get("rev") or 1), "timers": lock_timers(), **extra}


async def acquire_lock(db: AsyncIOMotorDatabase, raw: dict, actor: access.Actor, ctx: access.Ctx, *,
                       intent: str | None = None, edited: bool = False, hidden: bool | None = None,
                       dirty: bool | None = None, take_over: bool = False) -> dict:
    """Take, renew or take over the page's edit lock (can(edit_content), signed in).

    ``intent``:
      * ``edit`` — the editor's first real change: take it (the idle clock starts now);
      * ``heartbeat`` — renew one this editor holds. Never takes a lock it lost: the answer is
        ``{mine: false, released: true, reason}`` when nobody holds it (``idle``, ``hidden``,
        ``expired`` or ``taken_over``), a 423 when someone else does;
      * None — editors from before idle release: take or renew (a heartbeat can't revive a lock
        that lapsed while they were idle).
    ``edited``: a change since the last heartbeat. ``hidden``: its tab is hidden now. ``dirty``: it
    has changes the server doesn't. ``take_over``: the page's owner or a workspace admin takes it
    from whoever holds it (:func:`may_take_over`); their editor is told, and keeps what it had.
    """
    from app.services import viewers

    await access.require(actor, raw, "edit_content", ctx)
    if not actor.user_id:
        raise HTTPException(status_code=401, detail="Sign in to edit this page.")
    if not is_page_capable(raw):
        raise HTTPException(status_code=422, detail="Only Markdown documents open in the block editor.")
    await check_page_lock(raw, actor, ctx)
    for _ in range(4):
        fresh = await db["documents"].find_one({"_id": raw["_id"]}, {"edit_lock": 1, "edit_lock_taken": 1,
                                                                    "rev": 1, "slug": 1})
        if fresh is None:
            raise HTTPException(status_code=404, detail="Document not found")
        prev = fresh.get("edit_lock") if isinstance(fresh.get("edit_lock"), dict) else None
        held = lock_view(prev)
        mine = held is not None and held["user_id"] == actor.user_id
        now = now_utc()
        t = lock_timers()
        name = viewers.display_name(actor.user)

        if held is not None and not mine:
            if not take_over:
                raise locked_error(held, can_take_over=await may_take_over(actor, raw, ctx),
                                   taken=_taken_for(fresh, actor.user_id))
            if not await may_take_over(actor, raw, ctx):
                raise PageError(403, {"detail": f"{held['name']} is editing this page. Only the page's owner or a "
                                                "workspace admin can take over.",
                                      "code": "take_over_forbidden", "holder": {"name": held["name"]},
                                      **lock_facts(held), "can_take_over": False})
            lock = {"user_id": actor.user_id, "name": name, "at": now, "edited_at": now,
                    "expires_at": now + timedelta(seconds=t["ttl_s"]), "hidden_since": None,
                    "dirty": bool(dirty)}
            if not await _take_from(db, raw, held, actor, lock, via="app"):
                continue
            viewers.set_editor(raw.get("slug"), actor.user_id, t["idle_s"])
            return _answer(lock, fresh, took_over={"from": held["name"], "dirty": bool(held.get("dirty"))})

        if intent == "heartbeat" and not mine:
            if held is None and viewers.editor_of(raw.get("slug")) == actor.user_id:
                viewers.set_editor(raw.get("slug"), None, 0)  # lapsed: off the presence list now
            taken = _taken_for(fresh, actor.user_id)
            reason = "taken_over" if taken else (
                _lapse(prev)[1] if prev is not None and prev.get("user_id") == actor.user_id else "expired")
            return {"mine": False, "released": True, "reason": reason, "holder": None,
                    "rev": int(fresh.get("rev") or 1), "timers": t, **({"taken_over": taken} if taken else {})}

        if mine:
            edited_at = now if (edited or intent == "edit") else (aware(prev.get("edited_at")) or aware(prev.get("at")))
            if hidden is None:
                hidden_since = aware(prev.get("hidden_since"))
            else:
                hidden_since = (aware(prev.get("hidden_since")) or now) if hidden else None
            if intent == "edit":
                hidden_since = None
            lock = {**prev, "name": name, "expires_at": now + timedelta(seconds=t["ttl_s"]),
                    "edited_at": edited_at, "hidden_since": hidden_since,
                    "dirty": bool(prev.get("dirty")) if dirty is None else bool(dirty)}
            cond = {"_id": raw["_id"], "edit_lock.user_id": actor.user_id}
        else:
            # Free. A legacy editor's renewal of a lock that lapsed while it sat idle stays lapsed
            # (its idle and hidden clocks carry over): only a change takes the page again.
            edited_at, hidden_since = now, None
            if intent is None and prev is not None and prev.get("user_id") == actor.user_id \
                    and _lapse(prev)[1] in ("idle", "hidden"):
                edited_at, hidden_since = aware(prev.get("edited_at")) or now, aware(prev.get("hidden_since"))
            lock = {"user_id": actor.user_id, "name": name, "at": now, "edited_at": edited_at,
                    "expires_at": now + timedelta(seconds=t["ttl_s"]), "hidden_since": hidden_since,
                    "dirty": bool(dirty)}
            cond = {"_id": raw["_id"], **_free_filter(actor.user_id, now)}
        sets: dict = {"edit_lock": lock}
        if not mine and (fresh.get("edit_lock_taken") or {}).get("from_user_id") == actor.user_id:
            sets["edit_lock_taken"] = None  # they're back: the take-over is behind them
        res = await db["documents"].update_one(cond, {"$set": sets})
        if not res.modified_count and not res.matched_count:
            continue
        view = lock_view(lock)
        if view is None:  # a legacy renewal of a lapsed lock: nobody holds it
            viewers.set_editor(raw.get("slug"), None, 0)
            return {"mine": False, "released": True, "reason": _lapse(lock)[1], "holder": None,
                    "rev": int(fresh.get("rev") or 1), "timers": t}
        viewers.set_editor(raw.get("slug"), actor.user_id,
                           max(0.0, (view["expires_at"] - now).total_seconds()))
        return _answer(lock, fresh)
    raise PageError(409, {"detail": "The page's lock kept changing. Try again.", "code": "lock_busy",
                          "retryable": True})


async def lock_status(db: AsyncIOMotorDatabase, raw: dict, actor: access.Actor, ctx: access.Ctx) -> dict:
    """Who holds the page now (``GET …/lock``), without taking it: ``{holder: null}`` when it's
    free, else the holder and :func:`lock_facts`, ``mine`` and whether the caller may take over."""
    await access.require(actor, raw, "edit_content", ctx)
    held = lock_view(raw.get("edit_lock"))
    out: dict = {"holder": None, "mine": False, "rev": int(raw.get("rev") or 1), "timers": lock_timers()}
    if held is not None:
        out.update(holder={"name": held["name"]}, mine=held["user_id"] == actor.user_id, **lock_facts(held),
                   can_take_over=held["user_id"] != actor.user_id and await may_take_over(actor, raw, ctx))
    taken = _taken_for(raw, actor.user_id)
    if taken:
        out["taken_over"] = taken
    return out


async def keep_unsaved(db: AsyncIOMotorDatabase, raw: dict, actor: access.Actor, ctx: access.Ctx, *,
                       title: str | None, content: str, reason: str) -> dict:
    """An editor's text it couldn't save (``POST …/lock/keep``): a version in the page's history
    (services/page_history.py) saying whose it is and why, so taking over never loses anyone's
    work. The page is unchanged."""
    from app.config import get_settings
    from app.services import page_history, viewers

    await access.require(actor, raw, "edit_content", ctx)
    if not actor.user_id:
        raise HTTPException(status_code=401, detail="Sign in to edit this page.")
    if not page_history.has_history(raw):
        raise HTTPException(status_code=409, detail="This page has no version history.")
    if len(content) > get_settings().max_content_chars:
        raise HTTPException(status_code=413, detail="That text is longer than a page may be.")
    title = raw.get("title") if title is None else (title or None)
    taken = _taken_for(raw, actor.user_id)
    who = viewers.display_name(actor.user)
    text = {"taken_over": f"{who}'s unsaved changes, kept when {(taken or {}).get('by') or 'someone'} took over editing",
            "lost": f"{who}'s unsaved changes, kept when someone else started editing",
            "conflict": f"{who}'s unsaved changes, kept when the page changed under them"}.get(
        reason, f"{who}'s unsaved changes")
    kept = await page_history.keep(db, raw, actor, title=title, markdown=content, text=text, reason=reason)
    return {"kept": kept is not None, "version": int(kept["n"]) if kept else None}


async def presence_away(db: AsyncIOMotorDatabase, slug: str | None, user_id: str | None, away: bool) -> None:
    """Who's viewing says the lock holder's tabs on the page are all hidden (or one is back): the
    lock's hidden clock follows, for editors that don't say so themselves."""
    if not slug or not user_id:
        return
    try:
        if away:
            await db["documents"].update_one(
                {"slug": slug, "edit_lock.user_id": user_id, "edit_lock.hidden_since": None},
                {"$set": {"edit_lock.hidden_since": now_utc()}})
        else:
            # Back within the hidden time: still theirs. Later than that it lapsed, and stays so.
            since = now_utc() - timedelta(seconds=lock_timers()["hidden_s"])
            await db["documents"].update_one(
                {"slug": slug, "edit_lock.user_id": user_id, "edit_lock.hidden_since": {"$gt": since}},
                {"$set": {"edit_lock.hidden_since": None}})
    except Exception:  # pragma: no cover - presence never fails on the lock
        log.warning("page lock: presence update failed", exc_info=True)


async def release_lock(db: AsyncIOMotorDatabase, raw: dict, actor: access.Actor, ctx: access.Ctx) -> None:
    from app.services import viewers

    await access.require(actor, raw, "read", ctx)
    if not actor.user_id:
        return
    res = await db["documents"].update_one({"_id": raw["_id"], "edit_lock.user_id": actor.user_id},
                                           {"$set": {"edit_lock": None}})
    if res.modified_count:
        viewers.set_editor(raw.get("slug"), None, 0)
        from app.services import page_history

        await page_history.on_release(db, raw, actor)


# ── Markdown: embeds, mentions, page images, sections ─────────────────────────

_DIRECTIVE = re.compile(r"(?<![A-Za-z0-9_]):{1,2}markdrop(?:\[(?:\\.|[^\]\\\n])*\])?\{([^}\n]*)\}")
_ATTR = re.compile(r"""([A-Za-z_][\w-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'}]+))""")
_ASSET = re.compile(r"!\[[^\]\n]*\]\(\s*<?asset\\?:([A-Za-z0-9_-]{8,64})>?(?:\s+\"[^\"\n]*\")?\s*\)")
_HEADING = re.compile(r"^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$")
_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")


def _unescape(v: str) -> str:
    return v.replace("&quot;", '"').replace("&#xA;", "\n").replace("&amp;", "&")


def slug_of_src(src: str | None) -> str | None:
    """The slug an embed's ``src`` names: a bare slug, or the last segment of a
    Markdrop link (markdrop.in, the app's own address, or a workspace domain)."""
    from urllib.parse import unquote, urlsplit

    s = (src or "").strip()
    if not s or len(s) > 2000:
        return None
    if SLUG_RE.match(s):
        return s
    try:
        u = urlsplit(s if "://" in s else f"https://{s.lstrip('/')}")
    except ValueError:
        return None
    if u.username or u.password:
        return None
    segs = [p for p in (u.path or "").split("/") if p]
    if not segs:
        return None
    slug = unquote(segs[-1])
    return slug if SLUG_RE.match(slug) else None


def embed_refs(markdown: str | None) -> list[dict]:
    """Every ``::markdrop{…}`` block and ``:markdrop[…]{…}`` mention, in order:
    ``{slug, mention}``."""
    out = []
    for m in _DIRECTIVE.finditer(markdown or ""):
        attrs = {}
        for a in _ATTR.finditer(m.group(1)):
            val = a.group(3) if a.group(3) is not None else (a.group(4) if a.group(4) is not None else a.group(5))
            attrs[a.group(1)] = _unescape(val or "")
        slug = slug_of_src(attrs.get("src"))
        if slug:
            out.append({"slug": slug, "mention": not m.group(0).startswith("::")})
    return out


def asset_ids(markdown: str | None) -> list[str]:
    """Page images the Markdown references: ``![…](asset:<id>)`` and the
    front matter's icon / cover."""
    from app.services import page_props

    ids = [m.group(1) for m in _ASSET.finditer(markdown or "")]
    ids += page_props.asset_ids(page_props.parse(markdown))
    return list(dict.fromkeys(ids))


# ── Person mentions: :person[Name]{id="<user id>"} ────────────────────────────
#
# A name is shown only to people inside the page's circle: its owner (or edit
# secret) and members of its workspace. Everyone else gets the Markdown with the
# label emptied (``:person[]{id=…}``), which the page renders as "a person"; a
# save that comes back with emptied labels gets them restored from the page.

_PERSON = re.compile(r":person\[((?:\\.|[^\]\\\n])*)\]\{([^}\n]*)\}")


def _person_id(attrs: str) -> str | None:
    for a in _ATTR.finditer(attrs or ""):
        if a.group(1) == "id":
            v = a.group(3) if a.group(3) is not None else (a.group(4) if a.group(4) is not None else a.group(5))
            return v or None
    return None


def redact_people(markdown: str | None) -> str | None:
    if not markdown or ":person[" not in markdown:
        return markdown
    return _PERSON.sub(lambda m: f":person[]{{{m.group(2)}}}", markdown)


def restore_people(new: str, old: str | None) -> str:
    """Labels a reader couldn't see (emptied) come back from the stored page."""
    if ":person[]" not in (new or "") or not old:
        return new
    names: dict[str, str] = {}
    for m in _PERSON.finditer(old):
        pid = _person_id(m.group(2))
        if pid and m.group(1) and pid not in names:
            names[pid] = m.group(1)

    def fill(m: re.Match) -> str:
        if m.group(1):
            return m.group(0)
        name = names.get(_person_id(m.group(2)) or "")
        return f":person[{name}]{{{m.group(2)}}}" if name else m.group(0)

    return _PERSON.sub(fill, new)


async def sees_people(actor: access.Actor, raw: dict, ctx: access.Ctx) -> bool:
    f = await access.facts(actor, raw, ctx)
    return bool(f.is_owner or f.secret_ok or f.ws_role is not None)


async def content_for(actor: access.Actor, raw: dict, ctx: access.Ctx) -> str | None:
    """The document's Markdown as this reader may see it: person names redacted
    outside the page's circle, and the labels of Markdrop items the reader can't
    open (``redact_refs``)."""
    content = raw.get("content")
    if raw.get("encrypted") or not content:
        return content
    if ":person[" in content and not await sees_people(actor, raw, ctx):
        content = redact_people(content)
    if "markdrop" in content:
        content = await redact_refs(actor, ctx, content)
    return content


# ── Item labels: :markdrop[Title]{src=…} and ::markdrop{… title="…"} ───────────
#
# A mention is written with the item's title as its label, and an embed may carry
# a ``title``. Both name the item, so a reader who can't open it gets the label
# emptied (``:markdrop[]{src=…}``) and the title dropped, like an embed resolved
# for them (no title unless "ok"). A save that comes back that way gets them
# restored from the stored page (``restore_refs``).

_REF = re.compile(r"(?<![A-Za-z0-9_])(:{1,2})markdrop(?:\[((?:\\.|[^\]\\\n])*)\])?\{([^}\n]*)\}")
_TITLE_ATTR = re.compile(r"""(^|\s+)title\s*=\s*("[^"]*"|'[^']*'|[^\s"'}]+)""")


def _ref_slug(attrs: str) -> str | None:
    for a in _ATTR.finditer(attrs or ""):
        if a.group(1) == "src":
            v = a.group(3) if a.group(3) is not None else (a.group(4) if a.group(4) is not None else a.group(5))
            return slug_of_src(_unescape(v or ""))
    return None


def _labelled(m: re.Match) -> bool:
    return bool(m.group(2)) or bool(_TITLE_ATTR.search(m.group(3)))


def _bare_ref(m: re.Match) -> str:
    attrs = _TITLE_ATTR.sub("", m.group(3)).strip()
    return f":markdrop[]{{{attrs}}}" if m.group(1) == ":" else f"::markdrop{{{attrs}}}"


def strip_ref_labels(markdown: str | None) -> str | None:
    """Every item label and embed title removed (excerpts of another document)."""
    if not markdown or "markdrop" not in markdown:
        return markdown
    return _REF.sub(lambda m: _bare_ref(m) if _labelled(m) else m.group(0), markdown)


async def _readable(actor: access.Actor, ctx: access.Ctx, slugs: set[str]) -> set[str]:
    from app.services import document as doc_service

    out = set()
    for s in list(slugs)[:MAX_EMBEDS]:
        if not SLUG_RE.match(s):
            continue
        raw, _moved = await doc_service.find_for_read(ctx.db, s)
        if raw is not None and not raw.get("encrypted") and (await access.can(actor, raw, "read", ctx)).allowed:
            out.add(s)
    return out


async def redact_refs(actor: access.Actor, ctx: access.Ctx, markdown: str) -> str:
    refs = [m for m in _REF.finditer(markdown) if _labelled(m)]
    if not refs:
        return markdown
    slugs = {s for s in (_ref_slug(m.group(3)) for m in refs) if s}
    ok = await _readable(actor, ctx, slugs)
    return _REF.sub(lambda m: m.group(0) if not _labelled(m) or _ref_slug(m.group(3)) in ok else _bare_ref(m),
                    markdown)


async def restore_refs(actor: access.Actor, ctx: access.Ctx, new: str, old: str | None) -> str:
    """Labels and embed titles of items this writer can't open come back from
    the stored page (they were emptied in what they read)."""
    if not new or not old or "markdrop" not in new:
        return new
    labels: dict[tuple[str, str], str] = {}
    for m in _REF.finditer(old):
        s = _ref_slug(m.group(3))
        if not s:
            continue
        if m.group(1) == ":" and m.group(2):
            labels.setdefault((":", s), m.group(2))
        t = _TITLE_ATTR.search(m.group(3))
        if m.group(1) == "::" and t:
            labels.setdefault(("::", s), t.group(2))
    if not labels:
        return new
    bare = [m for m in _REF.finditer(new) if not _labelled(m) and (m.group(1), _ref_slug(m.group(3))) in labels]
    if not bare:
        return new
    # Only items this writer can't read: one who can removed a title on purpose.
    hidden = {s for s in {_ref_slug(m.group(3)) for m in bare} if s} - await _readable(
        actor, ctx, {_ref_slug(m.group(3)) for m in bare if _ref_slug(m.group(3))})

    def fill(m: re.Match) -> str:
        s = _ref_slug(m.group(3))
        key = (m.group(1), s)
        if _labelled(m) or s not in hidden or key not in labels:
            return m.group(0)
        if m.group(1) == ":":
            return f":markdrop[{labels[key]}]{{{m.group(3)}}}"
        attrs = " ".join(a for a in (m.group(3).strip(), f"title={labels[key]}") if a)
        return f"::markdrop{{{attrs}}}"

    return _REF.sub(fill, new)


def _norm_heading(text: str) -> str:
    t = re.sub(r"^\s*#{1,6}\s*", "", text or "")
    t = re.sub(r"[ \t]+#+[ \t]*$", "", t)
    return " ".join(t.split()).casefold()


def headings(markdown: str) -> list[tuple[int, int, str]]:
    """(line index, level, text) of every ATX heading outside code fences."""
    out = []
    fence = None
    for i, line in enumerate(markdown.split("\n")):
        f = _FENCE.match(line)
        if f:
            mark = f.group(1)
            if fence is None:
                fence = mark[0]
            elif mark[0] == fence:
                fence = None
            continue
        if fence is not None:
            continue
        h = _HEADING.match(line)
        if h:
            out.append((i, len(h.group(1)), (h.group(2) or "").strip()))
    return out


def find_section(markdown: str, heading: str) -> tuple[int, int, int] | None:
    """(heading line, end line exclusive, level) of the first heading whose text
    is ``heading`` (case and #s ignored): it runs to the next heading of the
    same or a higher level."""
    want = _norm_heading(heading)
    if not want:
        return None
    hs = headings(markdown)
    for n, (i, level, text) in enumerate(hs):
        if _norm_heading(text) == want:
            end = len(markdown.split("\n"))
            for j, lv, _t in hs[n + 1:]:
                if lv <= level:
                    end = j
                    break
            return i, end, level
    return None


def _join(parts: list[str]) -> str:
    chunks = [p.strip("\n") for p in parts if p is not None and p.strip("\n") != ""]
    return "\n\n".join(chunks) + "\n"


def appended(markdown: str, block: str) -> str:
    return _join([markdown or "", block])


def replace_section(markdown: str, heading: str, new: str) -> str | None:
    """The page with that section replaced, or None when there is no such
    heading. ``new`` replaces the section's body; when it starts with a heading
    itself, it replaces the heading line too."""
    sec = find_section(markdown, heading)
    if sec is None:
        return None
    start, end, _level = sec
    lines = markdown.split("\n")
    keep_heading = not _HEADING.match((new or "").lstrip("\n").split("\n", 1)[0])
    head = lines[:start + 1] if keep_heading else lines[:start]
    return _join(["\n".join(head), new, "\n".join(lines[end:])])


def insert_after_section(markdown: str, heading: str, block: str) -> str | None:
    """``block`` added at the end of that section, or None when there's no such heading."""
    sec = find_section(markdown, heading)
    if sec is None:
        return None
    _start, end, _level = sec
    lines = markdown.split("\n")
    return _join(["\n".join(lines[:end]), block, "\n".join(lines[end:])])


def _attr(v: str) -> str:
    return v.replace("&", "&amp;").replace('"', "&quot;").replace("\n", "&#xA;")


def embed_block(slug: str, mode: str) -> str:
    return f'::markdrop{{src="{_attr(slug)}" mode="{_attr(mode)}"}}'


def mention(slug: str, title: str | None) -> str:
    label = re.sub(r"[\[\]\\\n\r]", " ", title or slug).strip() or slug
    return f':markdrop[{label}]{{src="{_attr(slug)}"}}'


# ── Embeds (resolved for the viewer) ──────────────────────────────────────────


def _bare(state: str) -> dict:
    # Anything not "ok" says nothing about the item, not even its kind.
    return {"state": state, "kind": None}


async def resolve_embed(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, slug: str) -> dict:
    """What the viewer may see of the item at ``slug``: the same not-found-vs-
    denied rules as ``GET /documents/{slug}`` (a signed-in stranger and a slug
    that doesn't exist both answer "missing")."""
    from app.services import artifact as art_service
    from app.services import document as doc_service
    from app.services import urls
    from app.services.doc_ref import heading_title

    if not isinstance(slug, str) or not SLUG_RE.match(slug):
        return _bare("missing")
    raw, _moved = await doc_service.find_for_read(db, slug)
    d = await access.can(actor, raw, "read", ctx)
    if not d.allowed:
        if d.code == "signin":
            return _bare("signin")
        if d.code == "password":
            return _bare("password")
        if d.status == 404:
            return _bare("missing")
        return _bare("denied")
    if raw.get("encrypted"):
        return {"state": "encrypted", "kind": "document"}
    is_art = raw.get("kind") == "artifact"
    f = await access.facts(actor, raw, ctx)
    out: dict[str, Any] = {
        "state": "ok",
        "kind": "artifact" if is_art else "document",
        "slug": raw["slug"],
        "url": await urls.workspace_url(db, raw) or urls.markdrop_url(raw["slug"]),
    }
    updated = raw.get("file_updated_at") or raw.get("updated_at") or raw.get("created_at")
    preview: dict[str, Any] = {"updated_at": iso(updated)}
    if f.role is not None and raw.get("owner_id"):
        # The author's name, only for people with a relationship to the item.
        from app.services import user as user_service

        owner = await user_service.get_user_by_id(db, raw["owner_id"])
        if owner is not None:
            from app.services import viewers

            preview["author_name"] = viewers.display_name(owner)
    if not is_art:
        from app.services.docs_embeds import excerpt

        out.update(renderer="markdown",
                   title=raw.get("title") or heading_title((raw.get("content") or "")[:400]) or raw["slug"])
        text = raw.get("content") or ""
        if ":person[" in text and not await sees_people(actor, raw, ctx):
            text = redact_people(text)
        # Labels of other items, unchecked for this reader: left out of an excerpt.
        text = strip_ref_labels(text) or ""
        from app.services.page_people import _BARE as _BARE_PERSON

        text = _BARE_PERSON.sub(lambda m: m.group(1), _PERSON.sub(lambda m: m.group(1) or "a person", text))
        preview["excerpt"] = excerpt(text, EXCERPT_CHARS)
        out["preview"] = preview
        return out
    mime = raw.get("mime") or ""
    renderer = art_service.renderer_for(mime)
    public = await publicity.doc_is_public(db, raw)
    byte_urls = publicity.byte_urls(raw, public=public)
    out.update(
        renderer=renderer,
        title=raw.get("title") or raw.get("original_filename") or raw["slug"],
        artifact_url=byte_urls["artifact_url"],
        viewer_url=byte_urls["artifact_url"] if renderer in ("pdf", "sheet", "docx", "text") else None,
        download_url=byte_urls["download_url"],
        poster_url=byte_urls["poster_url"],
        expires_at=None if public or not byte_urls["artifact_url"]
        else iso(now_utc() + timedelta(seconds=publicity.ttl_for(mime))),
        preview=preview,
    )
    return out


async def resolve_embeds(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx,
                         slugs: list[str]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for s in list(dict.fromkeys(slugs))[:MAX_EMBEDS]:
        out[s] = await resolve_embed(db, actor, ctx, s)
    return out


# ── What a page's GET carries ─────────────────────────────────────────────────


async def icon_fields(db: AsyncIOMotorDatabase, row: dict) -> dict:
    """``{icon, icon_url}`` for a page in a list (its denormalised ``page_icon``;
    an image icon gets a link for a reader already past can(read) on that page)."""
    from app.services import page_assets

    icon = row.get("page_icon")
    url = None
    if isinstance(icon, str) and icon.startswith("asset:"):
        hit = (await page_assets.urls_for(db, row, [icon[6:]])).get(icon[6:])
        url = hit["url"] if hit else None
    return {"icon": icon, "icon_url": url}


async def page_fields(db: AsyncIOMotorDatabase, raw: dict, actor: access.Actor, ctx: access.Ctx) -> dict:
    """``editor``, ``parent`` (readable only), ``breadcrumbs`` (readable
    ancestors, root first), ``children_count`` (readable), ``access_inherit``,
    ``page_path`` and ``assets`` (the page images its content references, as
    links for this reader). The reader is already past ``can(read)``."""
    from app.services import page_assets, page_props

    props = page_props.parse(raw.get("content")) if not raw.get("encrypted") else dict(page_props.DEFAULTS)
    out: dict[str, Any] = {
        "page": props,
        "editor": raw.get("editor"),
        "parent": None,
        "breadcrumbs": [],
        "children_count": 0,
        "access_inherit": (raw.get("access_inherit") is not False) if raw.get("parent_id") is not None else None,
        "page_path": list(raw.get("page_path") or []),
        "template_id": raw.get("template_id"),
        # This page *is* a template (services/page_user_templates.py).
        "template": ({"id": str(raw["_id"]), "description": raw.get("template_description") or "",
                      "icon": raw.get("template_icon"),
                      "scope": "workspace" if raw.get("workspace_id") else "personal"}
                     if raw.get("template") and raw.get("parent_id") is None
                     else ({"part_of": True} if raw.get("template") else None)),
        "assets": {},
        # Meetings (services/meetings.py): the meeting page or its transcript; the reader mounts the
        # meeting panel (the meeting itself is decided again, GET /meetings/{id}).
        "meeting": ({"id": raw["meeting_id"], "role": raw.get("meeting_role") or "page"}
                    if raw.get("meeting_id") else None),
    }
    if raw.get("editor") == "blocks" and not raw.get("encrypted"):
        # Auto covers (services/page_covers.py): was this cover picked for the page, is one on its way.
        from app.services import page_covers

        out.update(page_covers.fields(raw))
    if raw.get("parent_id") is not None:
        crumbs = []
        cur = raw
        seen = {str(raw["_id"])}
        for _ in range(access.MAX_PAGE_DEPTH):
            oid = access.as_oid(cur.get("parent_id"))
            if oid is None:
                break
            parent = await db["documents"].find_one({"_id": oid}, _NO_CONTENT)
            if parent is None or str(parent["_id"]) in seen:
                break
            seen.add(str(parent["_id"]))
            readable = (await access.can(actor, parent, "read", ctx)).allowed
            if readable:
                crumbs.append({"slug": parent["slug"], "title": parent.get("title") or parent["slug"],
                               **await icon_fields(db, parent)})
            if cur is raw and readable:
                out["parent"] = dict(crumbs[-1])
            cur = parent
        out["breadcrumbs"] = list(reversed(crumbs))
    kids = await children_rows(db, raw["_id"], projection=_NO_CONTENT)
    n = 0
    for k in kids:
        if (await access.can(actor, k, "read", ctx)).allowed:
            n += 1
    out["children_count"] = n
    if not raw.get("encrypted"):
        out["assets"] = await page_assets.urls_for(db, raw, asset_ids(raw.get("content")))
        # The icon's and cover's own links, when they are page images.
        for key in ("icon", "cover"):
            v = props.get(key) or ""
            hit = out["assets"].get(v[6:]) if v.startswith("asset:") else None
            props[f"{key}_url"] = hit["url"] if hit else (v if v.startswith("https://") else None)
    else:
        props["icon_url"] = props["cover_url"] = None
    # Typed properties (services/page_db.py): a block page filed in a folder with a schema.
    if raw.get("editor") == "blocks" and raw.get("workspace_id"):
        from app.services import page_db

        out["page_properties"] = await page_db.panel(db, raw, actor, ctx)
    return out


async def children_listing(db: AsyncIOMotorDatabase, raw: dict, actor: access.Actor, ctx: access.Ctx) -> list[dict]:
    out = []
    rows = await children_rows(db, raw["_id"], projection=_NO_CONTENT)
    # Which of them have sub-pages: one query for the listing (it was one per child).
    parents = set(await db["documents"].distinct("parent_id", {"parent_id": {"$in": [k["_id"] for k in rows]}})) if rows else set()
    for k in rows:
        if not (await access.can(actor, k, "read", ctx)).allowed:
            continue
        has = k["_id"] in parents
        out.append({
            "slug": k["slug"],
            "title": k.get("title") or k["slug"],
            "editor": k.get("editor"),
            "updated_at": iso(k.get("updated_at")),
            "has_children": has,
            "access_inherit": k.get("access_inherit") is not False,
            **await icon_fields(db, k),
        })
    return out


# ── Creating ──────────────────────────────────────────────────────────────────


async def create_page(db: AsyncIOMotorDatabase, user, actor: access.Actor, ctx: access.Ctx, *,
                      title: str, workspace: str | None = None, folder: str | None = None,
                      parent: str | None = None, template: str | None = None,
                      content: str | None = None, slug: str | None = None,
                      access_level: str | None = None) -> tuple[dict, str, str | None]:
    """A new page: (row, edit secret, workspace error). From a template when
    one is named (``{{date}}`` / ``{{title}}`` filled in), else ``content``.
    Under ``parent`` (a slug the caller can edit): in its workspace and folder,
    inheriting its access. In ``workspace`` (member+): filed like any new
    document there. Otherwise a personal page (anyone with the link, or
    ``access_level`` when given: ``private`` for a duplicate, page_copy.py).
    ``slug``: its link, with publish's custom-slug rules (3-50 letters, digits,
    - or _; 409 when taken or reserved, never a silent rename; 409 beside a
    folder of that slug on its workspace's domain). Nothing is created then."""
    from app.config import get_settings
    from app.schemas.document import DocumentCreate
    from app.services import document as doc_service
    from app.services import page_templates

    if user is None:
        raise HTTPException(status_code=401, detail="Sign in to create a page.")
    from app.utils.slug import is_reserved_slug, is_valid_slug

    slug = (slug or "").strip() or None
    if slug is not None and not is_valid_slug(slug):
        raise HTTPException(status_code=422, detail=doc_service.SLUG_INVALID)
    if slug is not None and is_reserved_slug(slug):
        raise HTTPException(status_code=409, detail=doc_service.SLUG_RESERVED)
    title = " ".join((title or "").split())[:200]
    if not title:
        raise HTTPException(status_code=422, detail="Give the page a title.")
    from app.services import page_user_templates

    tpl = None
    if not template and content is None and workspace and folder and not parent:
        # New page in a folder with a default template starts from it ("blank" opts out).
        from app.models.workspace import role_allows
        from app.services import folder as folder_service
        from app.services import workspace as ws_service

        if role_allows(await ws_service.role_for(db, workspace, user.id), "member"):
            try:
                fid = await folder_service.resolve_ref(db, workspace, folder)
            except HTTPException:
                fid = None  # the filing below answers for a folder that isn't there
            template = await page_user_templates.folder_default(db, workspace, fid, user)
    if template:
        tpl = page_templates.get(template)
        if tpl is None:
            if page_user_templates.is_template_id(template) or await page_user_templates.find(db, template):
                # A workspace or personal template (services/page_user_templates.py), by id or slug.
                return await page_user_templates.create_from(
                    db, user, actor, ctx, template, title=title, workspace=workspace, folder=folder,
                    parent=parent, content=content)
            raise HTTPException(status_code=422, detail="Unknown template. See GET /api/v1/page-templates.")
    if content is None:
        from app.services import viewers

        content = page_templates.fill(tpl["content"], title=title).replace(
            "{{author}}", viewers.display_name(user)) if tpl else ""
    if len(content) > get_settings().max_content_chars:
        raise HTTPException(status_code=413, detail="That page is too long.")
    if not content.strip():
        content = "\n"
    extra: dict = {"editor": "blocks"}
    if tpl is not None:
        extra["template_id"] = tpl["id"]

    if parent:
        parent_raw, _moved = await doc_service.find_for_read(db, parent)
        d = await access.can(actor, parent_raw, "edit_content", ctx)
        if not d.allowed:
            if d.status == 403:
                raise HTTPException(status_code=403, detail="You can read that page but not add pages to it.")
            raise d.exception()
        if not is_page_capable(parent_raw):
            raise HTTPException(status_code=422, detail="Sub-pages go inside Markdown documents (not files "
                                                        "or end-to-end encrypted documents).")
        if parent_raw.get("template"):
            extra["template"] = True  # a page inside a template is part of it
        depth = len(parent_raw.get("page_path") or []) + 1
        if depth >= access.MAX_PAGE_DEPTH:
            raise HTTPException(status_code=422, detail=f"Pages nest at most {access.MAX_PAGE_DEPTH} deep.")
        ws_id = parent_raw.get("workspace_id")
        if (workspace and workspace != ws_id) or (folder and not ws_id):
            raise HTTPException(status_code=422, detail="A sub-page lives in its parent's workspace and folder; "
                                                        "leave workspace and folder out.")
        if ws_id:
            from app.models.workspace import role_allows
            from app.services import workspace as ws_service

            if not role_allows(await ws_service.role_for(db, ws_id, user.id), "member"):
                raise HTTPException(status_code=403, detail="Only members of its workspace can add pages "
                                                            "inside it.")
            await ws_service.assert_open(db, ws_id)
        extra.update({
            "parent_id": parent_raw["_id"],
            "access_inherit": True,
            "page_path": [*(parent_raw.get("page_path") or []), parent_raw["slug"]],
            "workspace_id": ws_id,
            "folder_id": parent_raw.get("folder_id"),
            "folder_path": list(parent_raw.get("folder_path") or []),
            "access_level": parent_raw.get("access_level") or "link",
            "read_password_hash": parent_raw.get("read_password_hash"),
        })
        if ws_id:
            extra["allow_resharing"] = False
            if slug:
                from app.services import folder as folder_service

                await folder_service.assert_doc_fits(db, ws_id, parent_raw.get("folder_id"), slug)
        data = DocumentCreate(title=title, content=content, access_level="private", custom_slug=slug)
        doc, secret = await doc_service.create_document(db, data, owner_id=user.id, extra=extra)
        raw = await db["documents"].find_one({"slug": doc.slug})
        raw = await resync_from_parent(db, raw)
        return raw, secret, None

    if workspace:
        from app.services import library as lib_service

        folder_id, level = await lib_service.prepare_new_filing(db, user, workspace, folder, custom_slug=slug)
        data = DocumentCreate(title=title, content=content, access_level="private", custom_slug=slug)
        doc, secret = await doc_service.create_document(db, data, owner_id=user.id, extra=extra)
        raw = await db["documents"].find_one({"slug": doc.slug})
        after, error = await lib_service.place_new(db, raw, user, workspace, folder_id, level)
        return after, secret, error

    if folder:
        raise HTTPException(status_code=422, detail="A folder needs a workspace.")
    data = DocumentCreate(title=title, content=content,
                          access_level="private" if access_level == "private" else "link",
                          custom_slug=slug)
    doc, secret = await doc_service.create_document(db, data, owner_id=user.id, extra=extra)
    return await db["documents"].find_one({"slug": doc.slug}), secret, None


async def resync_from_parent(db: AsyncIOMotorDatabase, raw: dict) -> dict:
    """A just-made sub-page copied its parent's fields; if the parent changed
    in between, take them again (through transitions, so a narrowing is one)."""
    from app.services import transitions

    parent = await db["documents"].find_one({"_id": raw.get("parent_id")}, _NO_CONTENT)
    if parent is None:
        return raw
    sets = {k: parent.get(k) for k in (*_PLACEMENT, *_ACCESS)}
    if all((raw.get(k) or None) == (v or None) for k, v in sets.items()):
        return raw
    narrows = access.LEVEL_RANK.get(sets["access_level"] or "link", 2) < access.LEVEL_RANK.get(
        raw.get("access_level") or "link", 2) or (sets["read_password_hash"] != raw.get("read_password_hash"))
    return await transitions.change(db, raw, sets=sets, narrows=narrows or None)


# ── Switching editor ──────────────────────────────────────────────────────────


async def set_editor(db: AsyncIOMotorDatabase, raw: dict, editor: str, actor: access.Actor,
                     ctx: access.Ctx) -> dict:
    from app.services import revalidate

    await access.require(actor, raw, "edit_content", ctx)
    if raw.get("kind") == "artifact":
        raise HTTPException(status_code=422, detail="Files don't open in the block editor.")
    if raw.get("encrypted"):
        raise HTTPException(status_code=422, detail="End-to-end encrypted documents keep the classic editor: "
                                                    "the server can't read them to show them as blocks.")
    value = "blocks" if editor == "blocks" else None
    if (raw.get("editor") or None) == value:
        return raw
    await check_page_lock(raw, actor, ctx)
    after = await db["documents"].find_one_and_update(
        {"_id": raw["_id"]}, {"$set": {"editor": value}}, return_document=True)
    if after is None:
        raise HTTPException(status_code=404, detail="Document not found")
    await revalidate.purge_doc(db, after)
    live.publish(after["slug"], int(after.get("rev") or 1))
    return after


# ── Moving ────────────────────────────────────────────────────────────────────


async def move(db: AsyncIOMotorDatabase, raw: dict, parent_slug: str | None, actor: access.Actor,
               ctx: access.Ctx, *, confirm: bool = False) -> dict:
    """Put a page under another page (or at the top, ``parent_slug`` None).

    Needs edit on the page and on the new parent. Pages move within their
    workspace (or among personal pages). When the move changes who can read
    the page (it inherits from somewhere else, or loses the grants of the pages
    it leaves), only its owner may make it, and only with
    ``confirm_access_change`` — otherwise a 409 ``{code: "access_change",
    readers_before, readers_after}``."""
    from app.services import document as doc_service
    from app.services import transitions

    await access.require(actor, raw, "edit_content", ctx)
    if not is_page_capable(raw):
        raise HTTPException(status_code=422, detail="Only Markdown documents can be pages inside other pages.")
    new_parent = None
    if parent_slug:
        new_parent, _moved = await doc_service.find_for_read(db, parent_slug)
        d = await access.can(actor, new_parent, "edit_content", ctx)
        if not d.allowed:
            if d.status == 403:
                raise HTTPException(status_code=403, detail="You can read that page but not add pages to it.")
            raise d.exception()
        if not is_page_capable(new_parent):
            raise HTTPException(status_code=422, detail="Sub-pages go inside Markdown documents.")
        if new_parent["_id"] == raw["_id"]:
            raise HTTPException(status_code=422, detail="A page can't go inside itself.")
        below = {str(r["_id"]) for r in await descendants(db, raw, projection={"_id": 1})}
        if str(new_parent["_id"]) in below:
            raise HTTPException(status_code=422, detail="A page can't go inside one of its own sub-pages.")
        if bool(new_parent.get("template")) != bool(raw.get("template")):
            raise HTTPException(status_code=422, detail="Pages move into and out of templates only by saving "
                                                        "a template or making a page from one.")
        if (new_parent.get("workspace_id") or None) != (raw.get("workspace_id") or None):
            raise HTTPException(status_code=422, detail="Pages move only within their own workspace (or among "
                                                        "personal pages).")
        depth = len(new_parent.get("page_path") or []) + 1 + await height(db, raw)
        if depth >= access.MAX_PAGE_DEPTH:
            raise HTTPException(status_code=422, detail=f"Pages nest at most {access.MAX_PAGE_DEPTH} deep.")
    current = raw.get("parent_id")
    if (new_parent["_id"] if new_parent else None) == current:
        return raw
    hypo = {**raw, "parent_id": new_parent["_id"] if new_parent else None}
    if new_parent is not None:
        hypo.update({k: new_parent.get(k) for k in _PLACEMENT})
        if raw.get("access_inherit") is False and current is None:
            hypo["access_inherit"] = True  # a top-level page that moves in starts inheriting
    before_key, before_text = await _audience(db, raw)
    after_key, after_text = await _audience(db, hypo)
    changes = before_key != after_key
    if changes:
        if not (await access.can(actor, raw, "change_access", ctx)).allowed:
            raise HTTPException(status_code=403, detail="Moving it there changes who can read it, which only "
                                                        "the page's owner can do.")
        if not confirm:
            raise PageError(409, {"detail": "Moving this page changes who can read it.",
                                  "code": "access_change",
                                  "readers_before": before_text, "readers_after": after_text})
    sets: dict = {"parent_id": hypo["parent_id"], "updated_at": now_utc(),
                  "page_path": [*(new_parent.get("page_path") or []), new_parent["slug"]] if new_parent else []}
    if new_parent is not None:
        for k in _PLACEMENT:
            sets[k] = new_parent.get(k) if k != "folder_path" else list(new_parent.get(k) or [])
        if hypo.get("access_inherit") is not False:
            sets["access_inherit"] = True
            sets["access_level"] = new_parent.get("access_level") or "link"
            sets["read_password_hash"] = new_parent.get("read_password_hash")
    elif access.inherits(raw):
        # At the top it has its own access: exactly what it inherited (as copied).
        sets["access_inherit"] = None
    after = await transitions.change(db, raw, sets=sets, narrows=True if changes else None,
                                     cas={"parent_id": current})
    ctx.forget(raw)
    await refresh_page_paths(db, after)
    return after


# ── Deleting a page that has sub-pages ───────────────────────────────────────


def deleted_item(raw: dict) -> dict:
    """``{slug, title, kind}`` of an item a delete removed or moved, for the
    caller to report (kind: ``file`` | ``page`` | ``document``)."""
    from app.services.workspace_items import display_title

    if raw.get("kind") == "artifact":
        kind = "file"
    else:
        kind = "page" if raw.get("editor") == "blocks" else "document"
    return {"slug": raw.get("slug"), "title": display_title(raw), "kind": kind}


async def delete_page(db: AsyncIOMotorDatabase, raw: dict, actor: access.Actor, ctx: access.Ctx,
                      children: str | None, *, permanent: bool = False) -> dict:
    """``DELETE /documents/{slug}``: a page with sub-pages needs
    ``children=delete`` (every page below goes too; the caller must be able to
    delete each of them) or ``children=lift`` (they move up one level).

    It goes to the trash (services/trash.py) for 30 days — with
    ``children=delete``, together with every page below it (one batch,
    restored together) — unless ``permanent``, which destroys it at once.

    Exactly ``raw`` (by ``_id``) and, with ``children=delete``, the pages
    below it go; nothing is ever matched by title. Returns ``{deleted: [...],
    lifted: [...], trashed, restore_until}`` (:func:`deleted_item` each),
    ``raw`` last in ``deleted``."""
    from app.services import lifecycle, trash

    await access.require(actor, raw, "delete", ctx)
    kids = await children_rows(db, raw["_id"], projection={"_id": 1, "slug": 1, "title": 1, "kind": 1,
                                                           "editor": 1})
    if kids and children not in ("delete", "lift"):
        raise PageError(409, {"detail": "This page has pages inside it. Choose whether to delete them too "
                                        "(children=delete) or move them up a level (children=lift).",
                              "code": "has_children", "count": len(kids)})
    below: list[dict] = []
    if kids and children == "delete":
        below = await descendants(db, raw)
        refused = 0
        for d in below:
            if not (await access.can(actor, d, "delete", ctx)).allowed:
                refused += 1
        if refused:
            raise HTTPException(status_code=403, detail=(
                f"{refused} of the pages inside it belong to someone else, so you can't delete them. "
                "Move them up a level instead (children=lift)."))
    deleted: list[dict] = []
    lifted = [deleted_item(k) for k in kids] if kids and children == "lift" else []
    if not permanent:
        if kids and children == "lift":
            # They move up now and stay there: only the page itself goes to the trash.
            await lift_children(db, raw)
        moved = await trash.move(db, [*reversed(below), raw], raw, actor)  # deepest first
        if not any(m["_id"] == raw["_id"] for m in moved):
            raise HTTPException(status_code=404, detail="Document not found")
        deleted = [deleted_item(m) for m in moved]
        until = now_utc() + timedelta(days=trash.DAYS)
        exp = aware(raw.get("expires_at"))
        return {"deleted": deleted, "lifted": lifted, "trashed": True,
                "restore_until": exp if exp is not None and exp < until else until}
    if kids and children == "delete":
        for d in reversed(below):  # deepest first
            if await lifecycle.destroy(db, d):
                deleted.append(deleted_item(d))
    if not await lifecycle.destroy(db, raw):
        raise HTTPException(status_code=404, detail="Document not found")
    deleted.append(deleted_item(raw))
    return {"deleted": deleted, "lifted": lifted, "trashed": False, "restore_until": None}
