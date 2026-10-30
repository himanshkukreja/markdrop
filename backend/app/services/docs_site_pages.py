"""Docs site pages: drafts, locks, versions and the sidebar order.

Every save is a new draft ``rev`` and a version row (the newest 50 are kept per
page). A save names the rev it was based on; if someone saved since, it is a
409 carrying the current rev, never a silent overwrite.

One person edits a page at a time. A lock lasts two minutes past its holder's
last heartbeat (the editor sends one every 30 seconds, and every save renews
it); an admin can take a lock over. Saving a page someone else holds is a 423.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import timedelta

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from app.config import get_settings
from app.models.user import User
from app.services import docs_site_store as store
from app.services.docs_site_store import PAGES, SITES, SNAPSHOTS, BUILDS, VERSIONS, DocsError, aware, now

settings = get_settings()

LOCK_TTL = timedelta(minutes=2)
VERSIONS_KEPT = 50
_PATH = re.compile(r"^(?:/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?){1,6}$")
# Routes the engine serves itself on every docs site.
RESERVED_SEGMENTS = frozenset({"docs-assets", "mcp", "md", "og", "changelog", "_next", "api-reference-json"})
FRONTMATTER_RESERVED = frozenset({"title", "description", "icon", "hidden"})


# ── Paths and content ─────────────────────────────────────────────────────────


def normalize_path(path: str) -> str:
    p = (path or "").strip().lower()
    if not p.startswith("/"):
        p = "/" + p
    if len(p) > 1:
        p = p.rstrip("/")
    if p == "/":
        return p
    if len(p) > 200 or not _PATH.match(p):
        raise HTTPException(
            status_code=422,
            detail="Use an address like /getting-started/quickstart: lowercase letters, numbers and hyphens, "
                   "at most 6 levels.")
    if p.split("/")[1] in RESERVED_SEGMENTS:
        raise HTTPException(status_code=422, detail=f"/{p.split('/')[1]} is used by the docs site itself.")
    return p


def check_markdown(markdown: str) -> None:
    if len(markdown) > settings.docs_page_max_chars:
        raise HTTPException(status_code=413,
                            detail=f"A page can be at most {settings.docs_page_max_chars:,} characters.")


def check_frontmatter_extra(extra: dict | None) -> dict:
    if not extra:
        return {}
    bad = sorted(set(extra) & FRONTMATTER_RESERVED)
    if bad:
        raise HTTPException(status_code=422, detail=f"Set {', '.join(bad)} with the page fields, not frontmatter_extra.")
    try:
        encoded = json.dumps(extra)
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail="frontmatter_extra must be plain JSON.") from None
    if len(encoded) > 10_000:
        raise HTTPException(status_code=413, detail="frontmatter_extra can be at most 10 KB.")
    return extra


def content_hash(page: dict) -> str:
    """What a reader would see of this page; equal hashes = no change to publish."""
    draft = page.get("draft") or {}
    data = [page.get("path"), page.get("title"), page.get("description"), page.get("icon"),
            bool(page.get("hidden")), draft.get("markdown"), draft.get("frontmatter_extra") or {}]
    return hashlib.sha256(json.dumps(data, sort_keys=True, default=str).encode()).hexdigest()


# ── Live comparison ───────────────────────────────────────────────────────────


async def live_snapshot(db: AsyncIOMotorDatabase, site: dict, *, markdown: bool = False) -> dict | None:
    """The snapshot the live build was made from (None when nothing is live)."""
    if not site.get("live_build_id"):
        return None
    build = await db[BUILDS].find_one({"_id": site["live_build_id"]}, {"snapshot_id": 1})
    if not build or not build.get("snapshot_id"):
        return None
    proj = None if markdown else {"pages.markdown": 0}
    return await db[SNAPSHOTS].find_one({"_id": build["snapshot_id"]}, proj)


async def live_hashes(db: AsyncIOMotorDatabase, site: dict) -> dict[str, str]:
    snap = await live_snapshot(db, site)
    return {p.get("page_id"): p.get("hash") for p in (snap or {}).get("pages") or []}


# ── Views ─────────────────────────────────────────────────────────────────────


def lock_view(lock: dict | None) -> dict | None:
    if not lock or aware(lock.get("expires_at")) is None or aware(lock["expires_at"]) <= now():
        return None
    return {"user_id": lock.get("user_id"), "name": lock.get("name"), "expires_at": aware(lock["expires_at"])}


def page_summary(page: dict, live: dict[str, str]) -> dict:
    pid = str(page["_id"])
    return {
        "id": pid,
        "path": page.get("path"),
        "title": page.get("title"),
        "icon": page.get("icon"),
        "hidden": bool(page.get("hidden")),
        "has_changes": live.get(pid) != content_hash(page),
        "lock": lock_view(page.get("lock")),
        "rev": (page.get("draft") or {}).get("rev"),
        "updated_at": aware((page.get("draft") or {}).get("updated_at")),
        "updated_by": (page.get("draft") or {}).get("updated_by"),
    }


def page_view(page: dict, live: dict[str, str], names: dict[str, str] | None = None) -> dict:
    draft = page.get("draft") or {}
    out = page_summary(page, live)
    out.update({
        "site_id": str(page["site_id"]),
        "description": page.get("description") or "",
        "markdown": draft.get("markdown") or "",
        "frontmatter_extra": draft.get("frontmatter_extra") or {},
        "updated_by_name": (names or {}).get(draft.get("updated_by") or ""),
        "created_at": aware(page.get("created_at")),
    })
    return out


async def load_page(db: AsyncIOMotorDatabase, site: dict, page_id: str) -> dict:
    page = await db[PAGES].find_one({"_id": store.oid(page_id, "Page"), "site_id": site["_id"], "deleted_at": None})
    if page is None:
        raise HTTPException(status_code=404, detail="Page not found")
    return page


async def view(db: AsyncIOMotorDatabase, site: dict, page: dict) -> dict:
    live = await live_hashes(db, site)
    names = await store.user_names(db, [(page.get("draft") or {}).get("updated_by")])
    return page_view(page, live, names)


async def list_pages(db: AsyncIOMotorDatabase, site: dict) -> dict:
    rows = await db[PAGES].find(
        {"site_id": site["_id"], "deleted_at": None},
        {"draft.frontmatter_extra": 1, "draft.markdown": 1, "draft.rev": 1, "draft.updated_at": 1,
         "draft.updated_by": 1, "path": 1, "title": 1, "description": 1, "icon": 1, "hidden": 1, "lock": 1,
         "site_id": 1},
    ).sort("path", 1).to_list(length=settings.docs_pages_per_site + 50)
    live = await live_hashes(db, site)
    return {"nav": (site.get("settings") or {}).get("nav") or [], "pages": [page_summary(r, live) for r in rows]}


# ── Nav ───────────────────────────────────────────────────────────────────────


async def _edit_nav(db: AsyncIOMotorDatabase, site_id: ObjectId, change) -> list[dict]:
    """Read-modify-write the nav with a compare-and-set, retried on a race."""
    for _ in range(8):
        site = await db[SITES].find_one({"_id": site_id}, {"settings.nav": 1})
        if site is None:
            raise HTTPException(status_code=404, detail="Docs site not found")
        old = (site.get("settings") or {}).get("nav") or []
        new = change([{"group": g["group"], "pages": list(g.get("pages") or [])} for g in old])
        if new == old:
            return old
        res = await db[SITES].update_one({"_id": site_id, "settings.nav": old},
                                         {"$set": {"settings.nav": new, "updated_at": now()}})
        if res.matched_count:
            return new
    raise HTTPException(status_code=409, detail="The page order changed meanwhile. Try again.")


def _without(nav: list[dict], page_id: str) -> list[dict]:
    return [{"group": g["group"], "pages": [p for p in g["pages"] if p != page_id]} for g in nav]


def _place(nav: list[dict], page_id: str, group: str | None, after: str | None) -> list[dict]:
    nav = _without(nav, page_id)
    if after:
        for g in nav:
            if after in g["pages"]:
                g["pages"].insert(g["pages"].index(after) + 1, page_id)
                return nav
    if group:
        for g in nav:
            if g["group"] == group:
                g["pages"].append(page_id)
                return nav
        nav.append({"group": group[:80], "pages": [page_id]})
        return nav
    if nav:
        nav[-1]["pages"].append(page_id)
    else:
        nav.append({"group": "Pages", "pages": [page_id]})
    return nav


async def put_nav(db: AsyncIOMotorDatabase, site: dict, nav: list[dict]) -> list[dict]:
    """Replace the order. Every id must be a visible page of this site, listed once;
    pages left out are unlisted (still published, just not in the sidebar)."""
    rows = await db[PAGES].find({"site_id": site["_id"], "deleted_at": None}, {"hidden": 1}).to_list(
        length=settings.docs_pages_per_site + 50)
    visible = {str(r["_id"]) for r in rows if not r.get("hidden")}
    hidden = {str(r["_id"]) for r in rows if r.get("hidden")}
    seen: set[str] = set()
    out = []
    for g in nav:
        name = (g.get("group") or "").strip()
        if not name:
            raise HTTPException(status_code=422, detail="Every group needs a name.")
        for pid in g.get("pages") or []:
            if pid in hidden:
                raise HTTPException(status_code=422, detail="Hidden pages aren't listed in the sidebar.")
            if pid not in visible:
                raise HTTPException(status_code=422, detail=f"No page {pid} in this site.")
            if pid in seen:
                raise HTTPException(status_code=422, detail="A page can be listed only once.")
            seen.add(pid)
        out.append({"group": name[:80], "pages": list(g.get("pages") or [])})
    await db[SITES].update_one({"_id": site["_id"]}, {"$set": {"settings.nav": out, "updated_at": now()}})
    return out


# ── Create / save / delete ────────────────────────────────────────────────────


async def _add_version(db: AsyncIOMotorDatabase, page: dict, *, by: str, kind: str) -> None:
    await db[VERSIONS].insert_one(store.version_row(page, by=by, at=now(), kind=kind))
    cutoff = await db[VERSIONS].find({"page_id": page["_id"]}, {"rev": 1}).sort("rev", -1).skip(
        VERSIONS_KEPT - 1).limit(1).to_list(length=1)
    if cutoff:
        await db[VERSIONS].delete_many({"page_id": page["_id"], "rev": {"$lt": cutoff[0]["rev"]}})


def _lock_for(user: User) -> dict:
    return {"user_id": user.id, "name": user.name or user.email, "expires_at": now() + LOCK_TTL}


def _free_or_mine(user_id: str) -> dict:
    return {"$or": [{"lock": None}, {"lock.user_id": user_id}, {"lock.expires_at": {"$lte": now()}}]}


def _not_redirected(site: dict, path: str) -> None:
    """A page can't live at an address a redirect sends away (it would never be seen)."""
    for r in (site.get("settings") or {}).get("redirects") or []:
        if r.get("from") == path:
            raise HTTPException(status_code=409, detail=f"{path} redirects to {r.get('to')}. Remove that redirect "
                                                        "in Settings first, or choose another address.")


def _locked(page: dict) -> DocsError:
    lock = lock_view(page.get("lock"))
    name = (lock or {}).get("name") or "Someone"
    return DocsError(423, {"detail": f"{name} is editing this page.", "lock": lock})


async def create_page(db: AsyncIOMotorDatabase, site: dict, user: User, *, path: str, title: str,
                      group: str | None, after_page_id: str | None, markdown: str = "",
                      description: str = "", icon: str | None = None) -> dict:
    path = normalize_path(path)
    _not_redirected(site, path)
    check_markdown(markdown)
    if await store.page_count(db, site["_id"]) >= settings.docs_pages_per_site:
        raise HTTPException(status_code=429,
                            detail=f"The free plan has {settings.docs_pages_per_site:,} pages per site.")
    at = now()
    row = store._new_page_row(site["_id"], {"path": path, "title": title.strip() or "Untitled",
                                            "description": description, "icon": icon, "markdown": markdown},
                              user, at)
    try:
        res = await db[PAGES].insert_one(row)
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail="Another page already has that address.") from None
    row["_id"] = res.inserted_id
    await _add_version(db, row, by=user.id, kind="save")
    await _edit_nav(db, site["_id"], lambda nav: _place(nav, str(row["_id"]), group, after_page_id))
    await db[SITES].update_one({"_id": site["_id"]}, {"$set": {"updated_at": at}})
    return row


async def save_page(db: AsyncIOMotorDatabase, site: dict, page: dict, user: User, *, base_rev: int,
                    fields: dict) -> dict:
    """Save a draft based on ``base_rev``. ``fields`` holds only what was sent."""
    sets: dict = {}
    if "markdown" in fields:
        check_markdown(fields["markdown"] or "")
        sets["draft.markdown"] = fields["markdown"] or ""
    if "frontmatter_extra" in fields:
        sets["draft.frontmatter_extra"] = check_frontmatter_extra(fields["frontmatter_extra"])
    if "title" in fields:
        sets["title"] = (fields["title"] or "").strip() or "Untitled"
    if "description" in fields:
        sets["description"] = (fields["description"] or "").strip()
    if "icon" in fields:
        sets["icon"] = fields["icon"] or None
    if "hidden" in fields and fields["hidden"] is not None:
        if page.get("path") == "/" and fields["hidden"]:
            raise HTTPException(status_code=422, detail="The home page can't be hidden.")
        sets["hidden"] = bool(fields["hidden"])
    if "path" in fields and fields["path"] is not None:
        new_path = normalize_path(fields["path"])
        if new_path != page.get("path"):
            if page.get("path") == "/":
                raise HTTPException(status_code=422, detail="The home page's address can't change.")
            if new_path == "/":
                raise HTTPException(status_code=409, detail="Another page already has that address.")
            _not_redirected(site, new_path)
            sets["path"] = new_path
    at = now()
    sets.update({"draft.updated_by": user.id, "draft.updated_at": at, "lock": _lock_for(user)})
    try:
        updated = await db[PAGES].find_one_and_update(
            {"_id": page["_id"], "deleted_at": None, "draft.rev": base_rev, **_free_or_mine(user.id)},
            {"$set": sets, "$inc": {"draft.rev": 1}},
            return_document=ReturnDocument.AFTER)
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail="Another page already has that address.") from None
    if updated is None:
        current = await db[PAGES].find_one({"_id": page["_id"], "deleted_at": None})
        if current is None:
            raise HTTPException(status_code=404, detail="Page not found")
        lock = lock_view(current.get("lock"))
        if lock and lock["user_id"] != user.id:
            raise _locked(current)
        names = await store.user_names(db, [(current.get("draft") or {}).get("updated_by")])
        rev = (current.get("draft") or {}).get("rev")
        raise DocsError(409, {
            "detail": "This page changed since you opened it.",
            "rev": rev,
            "updated_by": (current.get("draft") or {}).get("updated_by"),
            "updated_by_name": names.get((current.get("draft") or {}).get("updated_by") or ""),
            "updated_at": aware((current.get("draft") or {}).get("updated_at")),
        })
    await _add_version(db, updated, by=user.id, kind="save")
    if "hidden" in sets and sets["hidden"] != bool(page.get("hidden")):
        pid = str(page["_id"])
        if sets["hidden"]:
            await _edit_nav(db, site["_id"], lambda nav: _without(nav, pid))
        else:
            await _edit_nav(db, site["_id"], lambda nav: _place(nav, pid, None, None))
    await db[SITES].update_one({"_id": site["_id"]}, {"$set": {"updated_at": at}})
    return updated


async def delete_page(db: AsyncIOMotorDatabase, site: dict, page: dict, user: User) -> None:
    if page.get("path") == "/":
        raise HTTPException(status_code=422, detail="The home page can't be deleted.")
    at = now()
    res = await db[PAGES].update_one(
        {"_id": page["_id"], "deleted_at": None, **_free_or_mine(user.id)},
        {"$set": {"deleted_at": at, "deleted_by": user.id, "deleted_path": page.get("path"), "lock": None},
         "$unset": {"path": ""}})
    if res.matched_count == 0:
        current = await db[PAGES].find_one({"_id": page["_id"], "deleted_at": None})
        if current is None:
            raise HTTPException(status_code=404, detail="Page not found")
        raise _locked(current)
    pid = str(page["_id"])
    await _edit_nav(db, site["_id"], lambda nav: _without(nav, pid))


# ── Locks ─────────────────────────────────────────────────────────────────────


async def lock(db: AsyncIOMotorDatabase, site: dict, page: dict, user: User, role: str, takeover: bool) -> dict:
    """Acquire or renew (heartbeat). An admin may take over someone else's lock."""
    held = await db[PAGES].find_one_and_update(
        {"_id": page["_id"], "deleted_at": None, **_free_or_mine(user.id)},
        {"$set": {"lock": _lock_for(user)}}, return_document=ReturnDocument.AFTER)
    if held is None and takeover:
        if not store.is_admin(role):
            raise HTTPException(status_code=403, detail="Only workspace admins can take over a page.")
        held = await db[PAGES].find_one_and_update(
            {"_id": page["_id"], "deleted_at": None}, {"$set": {"lock": _lock_for(user)}},
            return_document=ReturnDocument.AFTER)
    if held is None:
        current = await db[PAGES].find_one({"_id": page["_id"], "deleted_at": None})
        if current is None:
            raise HTTPException(status_code=404, detail="Page not found")
        raise _locked(current)
    return {"lock": lock_view(held.get("lock"))}


async def unlock(db: AsyncIOMotorDatabase, page: dict, user: User, role: str) -> None:
    q: dict = {"_id": page["_id"]}
    if not store.is_admin(role):
        q["lock.user_id"] = user.id
    await db[PAGES].update_one(q, {"$set": {"lock": None}})


# ── Versions ──────────────────────────────────────────────────────────────────


def version_view(v: dict, names: dict[str, str], *, markdown: bool = False) -> dict:
    out = {
        "rev": v.get("rev"),
        "title": v.get("title"),
        "description": v.get("description"),
        "by": v.get("by"),
        "by_name": names.get(v.get("by") or ""),
        "at": aware(v.get("at")),
        "kind": v.get("kind"),
        "chars": len(v.get("markdown") or ""),
    }
    if markdown:
        out["markdown"] = v.get("markdown") or ""
    return out


async def versions(db: AsyncIOMotorDatabase, page: dict) -> list[dict]:
    rows = await db[VERSIONS].find({"page_id": page["_id"]}).sort("rev", -1).to_list(length=VERSIONS_KEPT + 10)
    names = await store.user_names(db, [r.get("by") for r in rows])
    return [version_view(r, names) for r in rows]


async def version(db: AsyncIOMotorDatabase, page: dict, rev: int) -> dict:
    row = await db[VERSIONS].find_one({"page_id": page["_id"], "rev": rev})
    if row is None:
        raise HTTPException(status_code=404, detail="That version isn't kept any more.")
    names = await store.user_names(db, [row.get("by")])
    return version_view(row, names, markdown=True)


async def restore_version(db: AsyncIOMotorDatabase, site: dict, page: dict, user: User, rev: int) -> dict:
    """The version's content as a new draft rev (history is never rewritten)."""
    row = await db[VERSIONS].find_one({"page_id": page["_id"], "rev": rev})
    if row is None:
        raise HTTPException(status_code=404, detail="That version isn't kept any more.")
    at = now()
    updated = await db[PAGES].find_one_and_update(
        {"_id": page["_id"], "deleted_at": None, **_free_or_mine(user.id)},
        {"$set": {"draft.markdown": row.get("markdown") or "", "title": row.get("title") or page.get("title"),
                  "description": row.get("description") or "", "draft.updated_by": user.id,
                  "draft.updated_at": at, "lock": _lock_for(user)},
         "$inc": {"draft.rev": 1}},
        return_document=ReturnDocument.AFTER)
    if updated is None:
        current = await db[PAGES].find_one({"_id": page["_id"], "deleted_at": None})
        if current is None:
            raise HTTPException(status_code=404, detail="Page not found")
        raise _locked(current)
    await _add_version(db, updated, by=user.id, kind="restore")
    await db[SITES].update_one({"_id": site["_id"]}, {"$set": {"updated_at": at}})
    return updated
