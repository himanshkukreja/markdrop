"""Markdrop files embedded in docs pages: `::markdrop{src="https://markdrop.in/<slug>"}`.

A guide page (or a docs.markdrop.in page) keeps only the file's link. When a reader scrolls to the
block, the page asks this module what the file is *now* (:func:`resolve`), so "Replace file" on
Markdrop updates every guide at once, with no rebuild, and a file made private stops showing
everywhere at once.

Security model
--------------
* **Only what anyone with the link could already open.** :func:`resolve` answers with a title,
  bytes and addresses only for a file whose bytes are public (``publicity.is_public``: link access,
  no password, not in a sign-in-only workspace, not expired) and that an anonymous reader may read
  (``access.anonymous_can_read``), and never for an end-to-end encrypted document. Anything else is
  a bare state (``private``, ``password``, ``signin``, ``encrypted``, ``unavailable``) with no
  title, no size, no address: a published guide can't become a way to read a private file, or
  even to learn its name.
* **Bytes stay on the isolated artifact origin** (workers.dev, a separate registrable site), in the
  sandbox markdrop.in/<slug> uses. The URLs are the ones markdrop.in itself hands out
  (``publicity.byte_urls``), unsigned because the bytes are public.
* **Pinned versions** (``version=3``) are the one exception to "current bytes only": an old version
  is never public in R2, so its URL is signed (short-lived). It is served only to the guide a file
  editor pinned it for (:func:`pin`, a row in ``docs_embed_pins``): nobody can fetch an old version
  of a public file by adding ``?v=1``.
* **Inserting** (the studio, :func:`check`): the guide's editor must be able to read the file; the
  studio then shows whether the guide's readers can, and offers "anyone with the link" when the
  editor may change the file's access (:func:`make_viewable`, the same ``access.set_level`` the
  Share dialog uses).

Analytics (cookieless)
----------------------
* The file's creator: :func:`record_beacon` (``POST /api/v1/embeds/{slug}/beacon``) counts one view
  per page load, from the "Guides" channel with the guide's name as the campaign ("seen in Acme
  Docs"); the block's video / PDF engagement goes to the file's own ``/engage`` beacon.
* The guide's Insights and its Fix list: the Insights beacon (``POST /api/v1/docs/insights/{site}/
  event`` ``{k: "embed", p, e, s, a, …}``, routers/guide_insights.py → :func:`record_insight`): raw
  events in ``guide_events`` like every other Insights event (page path, device class, a daily
  visitor hash, nothing else about the reader; 90 days). :func:`stats` reads them per block.
Both are accepted only from the docs site's own live addresses (Origin).
"""

from __future__ import annotations

import json
import logging
import math
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlsplit

from bson import ObjectId
from fastapi import HTTPException
from fastapi.concurrency import run_in_threadpool
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings

log = logging.getLogger(__name__)

PINS = "docs_embed_pins"
SLUG_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MARKDROP_HOSTS = {"markdrop.in", "www.markdrop.in"}
#: Creator-analytics beacon actions (only "view" is counted; the rest are the Insights beacon's).
ACTIONS = ("view", "fullscreen", "open", "play", "watch")
#: The campaign Markdrop's own docs report as.
MARKDROP_DOCS_ID = "markdrop"
MARKDROP_DOCS_NAME = "Markdrop Docs"
#: What the file's creator sees as the source of a view from a docs page.
UTM_SOURCE = "markdrop-guides"
UTM_MEDIUM = "embed"
EXCERPT_CHARS = 240
#: Library picker filters → MIME types (the artifact renderers), or markdown documents.
TYPES = ("html", "bundle", "pdf", "sheet", "docx", "video", "image", "audio", "text", "doc")


def now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime | None) -> datetime | None:
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _iso(dt: datetime | None) -> str | None:
    dt = _aware(dt)
    return dt.isoformat().replace("+00:00", "Z") if dt else None


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[PINS].create_index([("site_id", 1), ("doc_id", 1), ("version", 1)], unique=True)
    await db[PINS].create_index([("doc_id", 1)])
    await db[TEXTS].create_index("key", unique=True)


# ── Links ─────────────────────────────────────────────────────────────────────


def slug_from_src(src: str | None) -> str | None:
    """The slug a Markdrop link (or a bare slug) names, or None.

    Accepts https://markdrop.in/<slug>, https://www.markdrop.in/<slug>, the app's own address
    (``frontend_url``, a local stack's http://localhost:3400/<slug>) and a bare slug."""
    s = (src or "").strip()
    if not s or len(s) > 2000:
        return None
    if SLUG_RE.match(s):
        return s
    try:
        u = urlsplit(s)
    except ValueError:
        return None
    host = (u.netloc or "").lower()
    app = urlsplit(get_settings().frontend_url)
    own = (app.netloc or "").lower()
    if not ((u.scheme == "https" and host in MARKDROP_HOSTS) or (own and host == own and u.scheme == app.scheme)):
        return None
    if u.username or u.password:
        return None
    segs = [p for p in (u.path or "").split("/") if p]
    if len(segs) != 1:
        return None
    from urllib.parse import unquote

    slug = unquote(segs[0])
    return slug if SLUG_RE.match(slug) else None


def canonical_link(slug: str) -> str:
    return f"https://markdrop.in/{slug}"


def app_url() -> str:
    return (get_settings().frontend_url or "https://markdrop.in").rstrip("/")


# ── Who may see it ────────────────────────────────────────────────────────────


async def blocked_reason(db: AsyncIOMotorDatabase, raw: dict | None) -> str | None:
    """Why the guide's readers (anyone, signed out) can't see this file, or None when they can.

    ``unavailable`` (missing, deleted, expired) · ``encrypted`` (end-to-end: the key is only in
    the author's link) · ``password`` · ``signin`` (workspace-only, or a workspace that requires
    sign-in) · ``private``."""
    from app.services import access, publicity

    if raw is None or publicity.is_expired(raw):
        return "unavailable"
    if raw.get("encrypted"):
        return "encrypted"
    if raw.get("read_password_hash"):
        return "password"
    level = raw.get("access_level") or "link"
    if level == "workspace":
        return "signin"
    if level != "link":
        return "private"
    if await publicity.workspace_requires_auth(db, raw.get("workspace_id")):
        return "signin"
    if not await access.anonymous_can_read(db, raw):
        return "private"
    return None


def renderer_of(raw: dict) -> str:
    from app.services import artifact as art_service

    if raw.get("kind") != "artifact":
        return "doc"
    return art_service.renderer_for(raw.get("mime") or "")


def _media(m: Any) -> dict | None:
    if not isinstance(m, dict):
        return None
    out = {"duration": m.get("duration_s"), "width": m.get("width"), "height": m.get("height")}
    return out if any(v is not None for v in out.values()) else None


_MD_STRIP = (
    (re.compile(r"```[\s\S]*?```"), " "),
    (re.compile(r"`([^`]*)`"), r"\1"),
    (re.compile(r"!\[([^\]]*)\]\([^)]*\)"), r"\1"),
    (re.compile(r"\[([^\]]*)\]\([^)]*\)"), r"\1"),
    (re.compile(r"^\s{0,3}#{1,6}\s+", re.M), ""),
    (re.compile(r"^\s{0,3}(?:[-*+]|\d+[.)])\s+", re.M), ""),
    (re.compile(r"^\s{0,3}>\s?", re.M), ""),
    (re.compile(r"[*_~]{1,3}"), ""),
    (re.compile(r"<[^>]{0,200}>"), " "),
    (re.compile(r"\s+"), " "),
)


def excerpt(markdown: str | None, n: int = EXCERPT_CHARS) -> str | None:
    """The first ``n`` characters of a Markdown document as plain text (cut at a word)."""
    text = (markdown or "")[:20_000]
    text = re.sub(r"^---\n[\s\S]*?\n---\n", "", text)
    for rx, rep in _MD_STRIP:
        text = rx.sub(rep, text)
    text = text.strip()
    if not text:
        return None
    if len(text) <= n:
        return text
    cut = text[:n]
    sp = cut.rfind(" ")
    return (cut[: sp if sp > n - 40 else n]).rstrip(" ,.;:") + "…"


# ── Resolve (public) ──────────────────────────────────────────────────────────

_ae_cache: dict[str, tuple[float, int]] = {}


async def _object_epoch(key: str, fallback: int) -> int:
    """The access epoch an R2 object carries (``ae``): a token for an old version must match it."""
    from app.services import r2

    hit = _ae_cache.get(key)
    if hit and time.monotonic() - hit[0] < 60:
        return hit[1]
    epoch = fallback
    try:
        head = await run_in_threadpool(r2.head, key)
        if head and head.get("ae") not in (None, ""):
            epoch = int(head["ae"])
    except Exception:  # pragma: no cover - best effort; the Worker decides
        log.debug("head failed for %s", key, exc_info=True)
    if len(_ae_cache) > 5000:
        _ae_cache.clear()
    _ae_cache[key] = (time.monotonic(), epoch)
    return epoch


async def _pinned_row(db: AsyncIOMotorDatabase, raw: dict, site_id: str | None, version: int | None) -> dict | None:
    """The file_versions row a guide pinned (``version`` ≠ current), or None."""
    from app.services import file_versions

    if not site_id or not version or raw.get("bundle_prefix"):
        return None
    if version == file_versions.current_version(raw):
        return None
    doc_id = str(raw["_id"])
    pin = await db[PINS].find_one({"site_id": site_id, "doc_id": doc_id, "version": int(version)})
    if pin is None:
        return None
    return await db[file_versions.VERSIONS].find_one({"doc_id": doc_id, "version": int(version)})


async def resolve(db: AsyncIOMotorDatabase, slug: str, *, site_id: str | None = None,
                  version: int | None = None) -> tuple[dict, bool]:
    """(the answer for GET /api/v1/embeds/{slug}, whether it holds signed links).

    The answer is ``{state, slug}`` for anything a signed-out reader can't open, and the file's
    title, kind, viewer and raw addresses (artifact origin), poster, media size, version and last
    update otherwise. A renamed file answers at its old link too (Q4), under its new slug."""
    from app.services import artifact as art_service
    from app.services import document as doc_service
    from app.services import file_versions, publicity

    if not SLUG_RE.match(slug or ""):
        return {"state": "unavailable", "slug": slug}, False
    raw, _moved = await doc_service.find_for_read(db, slug)
    reason = await blocked_reason(db, raw)
    if reason is not None:
        return {"state": reason, "slug": slug}, False
    assert raw is not None
    renderer = renderer_of(raw)
    cur_slug = raw["slug"]
    out: dict[str, Any] = {
        "state": "ok",
        "slug": cur_slug,
        "url": canonical_link(cur_slug),
        "app": app_url(),
        "kind": "artifact" if raw.get("kind") == "artifact" else "document",
        "renderer": renderer,
        "title": raw.get("title") or raw.get("original_filename") or None,
        "updated_at": _iso(raw.get("file_updated_at") or raw.get("updated_at") or raw.get("created_at")),
        "version": None,
        "current_version": None,
        "pinned": False,
    }
    if out["kind"] == "document":
        out["type_label"] = "Markdrop document"
        out["excerpt"] = excerpt(raw.get("content"))
        return out, False
    if renderer == "download":
        return {"state": "unsupported", "slug": cur_slug}, False
    current = file_versions.current_version(raw)
    out.update({
        "type_label": art_service.label_for(raw.get("mime") or ""),
        "filename": raw.get("original_filename"),
        "size_bytes": int(raw.get("size_bytes") or 0) or None,
        "media": _media(raw.get("media")),
        "version": current,
        "current_version": current,
    })
    row = await _pinned_row(db, raw, site_id, version)
    if row is not None and row.get("blob_key"):
        mime = row.get("mime") or raw.get("mime") or ""
        epoch = await _object_epoch(row["blob_key"], publicity.epoch_of(raw))
        ttl = publicity.ttl_for(mime)
        out.update({
            "frame_url": art_service.build_artifact_url(row["blob_key"], mime, private=True, epoch=epoch, ttl=ttl),
            "raw_url": art_service.build_download_url(row["blob_key"], private=True, epoch=epoch, ttl=ttl),
            "poster_url": None,
            "renderer": art_service.renderer_for(mime),
            "type_label": art_service.label_for(mime),
            "filename": row.get("filename") or raw.get("original_filename"),
            "size_bytes": int(row.get("size_bytes") or 0) or None,
            "media": _media(row.get("media")),
            "version": int(row["version"]),
            "pinned": True,
            "updated_at": _iso(row.get("created_at")),
        })
        if row.get("poster_key"):
            pe = await _object_epoch(row["poster_key"], epoch)
            out["poster_url"] = art_service.build_download_url(row["poster_key"], private=True, epoch=pe, ttl=ttl)
        return out, True
    urls = publicity.byte_urls(raw, public=True)
    out.update({"frame_url": urls["artifact_url"], "raw_url": urls["download_url"], "poster_url": urls["poster_url"]})
    if not out["frame_url"]:
        return {"state": "unavailable", "slug": cur_slug}, False
    return out, False


# ── The studio ────────────────────────────────────────────────────────────────


async def _readable(db: AsyncIOMotorDatabase, actor, src: str) -> dict:
    """The file at ``src`` the studio user may read, else 404 (never "exists but you can't")."""
    from app.services import access
    from app.services import document as doc_service

    slug = slug_from_src(src)
    if slug is None:
        raise HTTPException(status_code=422, detail="That isn't a Markdrop link. Paste the address of a file on markdrop.in, like https://markdrop.in/acme-pricing.")
    raw, _moved = await doc_service.find_for_read(db, slug)
    if not (await access.can(actor, raw, "read", access.Ctx(db))).allowed:
        raise HTTPException(status_code=404, detail="We couldn't find a Markdrop file at that link that you can open.")
    return raw


_REASON_TEXT = {
    "private": "It's private, so readers of this guide will see \"This file is private\" instead of the file.",
    "signin": "Only signed-in members of its workspace can open it, so readers of this guide will see a notice instead of the file.",
    "password": "It has a password, so readers of this guide will see a notice instead of the file. Remove the password on Markdrop to embed it.",
    "encrypted": "It's end-to-end encrypted, so it can't be shown in a guide: its key is only in the link you share.",
    "unavailable": "It has expired or been deleted.",
}


async def describe(db: AsyncIOMotorDatabase, actor, raw: dict) -> dict:
    """What the studio shows about a file it may embed: its kind, whether the guide's readers can
    see it (and why not), and what the caller may do about it (open its access, pin a version)."""
    from app.services import access
    from app.services import artifact as art_service
    from app.services import file_uploads, publicity

    ctx = access.Ctx(db)
    reason = await blocked_reason(db, raw)
    renderer = renderer_of(raw)
    is_art = raw.get("kind") == "artifact"
    can_share = (await access.can(actor, raw, "change_access", ctx)).allowed
    # Opening it to "anyone with the link" fixes only an access level: not a password, a
    # sign-in-only workspace's own setting, or encryption.
    level = raw.get("access_level") or "link"
    fixable = reason in ("private", "signin") and level != "link" and not raw.get("read_password_hash") and not raw.get("encrypted") \
        and not await publicity.workspace_requires_auth(db, raw.get("workspace_id"))
    can_pin = bool(is_art and not raw.get("bundle_prefix") and (await access.can(actor, raw, "list_versions", ctx)).allowed)
    versions: list[dict] = []
    if can_pin:
        try:
            versions = (await file_uploads.versions(db, raw))["versions"]
        except Exception:  # pragma: no cover - versions are a nicety here
            versions = []
    ws_name = None
    if raw.get("workspace_id"):
        try:
            w = await db["workspaces"].find_one({"_id": ObjectId(raw["workspace_id"])}, {"name": 1})
            ws_name = (w or {}).get("name")
        except Exception:
            ws_name = None
    urls = publicity.byte_urls(raw, public=True) if reason is None and is_art else {}
    return {
        "slug": raw["slug"],
        "url": canonical_link(raw["slug"]),
        "src": canonical_link(raw["slug"]),
        "title": raw.get("title") or raw.get("original_filename") or raw["slug"],
        "kind": "artifact" if is_art else "document",
        "renderer": renderer,
        "type_label": art_service.label_for(raw.get("mime") or "") if is_art else "Markdrop document",
        "filename": raw.get("original_filename"),
        "size_bytes": int(raw.get("size_bytes") or 0) or None,
        "media": _media(raw.get("media")),
        "poster_url": urls.get("poster_url"),
        "updated_at": _iso(raw.get("file_updated_at") or raw.get("updated_at")),
        "public": reason is None,
        "reason": reason,
        "reason_text": _REASON_TEXT.get(reason or ""),
        "access_level": level,
        "has_password": bool(raw.get("read_password_hash")),
        "workspace_name": ws_name,
        "can_share": bool(can_share and fixable),
        "embeddable": renderer != "download",
        "can_pin": can_pin,
        "current_version": int(raw.get("file_version") or 1) if is_art else None,
        "versions": [
            {"version": v["version"], "created_at": _iso(v.get("created_at")), "size_bytes": v.get("size_bytes"),
             "filename": v.get("filename"), "current": v.get("current", False)}
            for v in versions
        ],
    }


async def check(db: AsyncIOMotorDatabase, actor, src: str) -> dict:
    return await describe(db, actor, await _readable(db, actor, src))


async def make_viewable(db: AsyncIOMotorDatabase, actor, src: str) -> dict:
    """"Anyone with the link can view": the Share dialog's own level change (owner, session)."""
    from app.services import access

    raw = await _readable(db, actor, src)
    info = await describe(db, actor, raw)
    if info["public"]:
        return info
    if not info["can_share"]:
        raise HTTPException(status_code=403, detail="Only the file's owner can change who can open it. Ask them to share it with anyone who has the link.")
    after = await access.set_level(db, raw, "link", actor, access.Ctx(db))
    return await describe(db, actor, after or await db["documents"].find_one({"_id": raw["_id"]}))


async def pin(db: AsyncIOMotorDatabase, actor, site_id: str, src: str, version: int, user_id: str) -> dict:
    """Pin ``version`` of a file for one guide. The caller must be able to manage the file's
    versions (an editor of the file): a pin is what lets readers of this guide see an old version."""
    from app.services import access, file_versions

    raw = await _readable(db, actor, src)
    if raw.get("kind") != "artifact" or raw.get("bundle_prefix"):
        raise HTTPException(status_code=409, detail="Only a single file has versions to pin (a zipped site or a Markdrop document doesn't).")
    if not (await access.can(actor, raw, "list_versions", access.Ctx(db))).allowed:
        raise HTTPException(status_code=403, detail="Only people who can edit this file can pin one of its versions.")
    kept = {int(r["version"]) for r in await file_versions.rows_for(db, raw)}
    if int(version) not in kept:
        raise HTTPException(status_code=404, detail=f"Version {version} of this file isn't kept. Kept versions: {sorted(kept)}.")
    doc_id = str(raw["_id"])
    await db[PINS].update_one(
        {"site_id": site_id, "doc_id": doc_id, "version": int(version)},
        {"$set": {"slug": raw["slug"], "pinned_by": user_id, "pinned_at": now()}},
        upsert=True,
    )
    return {"slug": raw["slug"], "version": int(version), "current_version": file_versions.current_version(raw)}


def _type_clause(t: str | None) -> dict | None:
    from app.services import artifact as art_service

    if not t or t == "all":
        return None
    if t == "doc":
        return {"kind": {"$ne": "artifact"}}
    mimes = [m for m, at in art_service.BY_MIME.items() if at.renderer == t]
    return {"kind": "artifact", "mime": {"$in": mimes}} if mimes else {"_id": None}


async def library(db: AsyncIOMotorDatabase, actor, user_id: str, site: dict, *, scope: str, q: str | None,
                  type_: str | None, page: int, per_page: int = 24) -> dict:
    """The picker: the caller's own files (``mine``) or the guide's workspace's (``workspace``),
    newest first, each with whether the guide's readers could see it."""
    from app.services import access
    from app.services import artifact as art_service
    from app.services.library import search_filter

    ws_id = site.get("workspace_id")
    clauses = [c for c in (_type_clause(type_), search_filter(q)) if c]
    n = now()
    alive = {"$or": [{"expires_at": None}, {"expires_at": {"$gt": n}}]}
    if scope == "workspace":
        if not ws_id:
            return {"items": [], "total": 0, "page": 1, "pages": 1, "workspace": None}
        rf = await access.readable_filter(actor, ws_id, access.Ctx(db))
        query = rf.query(*clauses)
        sort = [("updated_at", -1)]
    else:
        query = {"owner_id": user_id, "$and": [alive, *clauses]}
        sort = [("updated_at", -1), ("created_at", -1)]
    total = await db["documents"].count_documents(query)
    rows = await db["documents"].find(query).sort(sort).skip((page - 1) * per_page).limit(per_page).to_list(length=per_page)
    items = []
    for raw in rows:
        reason = await blocked_reason(db, raw)
        renderer = renderer_of(raw)
        items.append({
            "slug": raw["slug"],
            "src": canonical_link(raw["slug"]),
            "title": raw.get("title") or raw.get("original_filename") or raw["slug"],
            "kind": "artifact" if raw.get("kind") == "artifact" else "document",
            "renderer": renderer,
            "type_label": art_service.label_for(raw.get("mime") or "") if raw.get("kind") == "artifact" else "Markdrop document",
            "filename": raw.get("original_filename"),
            "size_bytes": int(raw.get("size_bytes") or 0) or None,
            "updated_at": _iso(raw.get("updated_at") or raw.get("created_at")),
            "public": reason is None,
            "reason": reason,
            "embeddable": renderer != "download",
        })
    ws = None
    if ws_id:
        try:
            w = await db["workspaces"].find_one({"_id": ObjectId(ws_id)}, {"name": 1})
            ws = {"id": ws_id, "name": (w or {}).get("name") or "Workspace"}
        except Exception:
            ws = None
    return {"items": items, "total": total, "page": page, "pages": max(1, math.ceil(total / per_page)), "workspace": ws}


# ── The creator's beacon ──────────────────────────────────────────────────────


def parse_beacon(raw_body: bytes) -> dict | None:
    if not raw_body or len(raw_body) > 2048:
        return None
    try:
        body = json.loads(raw_body)
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(body, dict):
        return None
    a = body.get("a")
    site = body.get("site")
    if a not in ACTIONS or not isinstance(site, str) or not (1 <= len(site) <= 64):
        return None
    s = body.get("s")
    secs = None
    if a == "watch":
        if isinstance(s, bool) or not isinstance(s, (int, float)) or not math.isfinite(float(s)) or s <= 0:
            return None
        secs = int(min(float(s), 4 * 3600))
    v = body.get("v")
    ver = int(v) if isinstance(v, int) and not isinstance(v, bool) and 1 <= v <= 100_000 else None
    return {"a": a, "site": site, "p": body.get("p"), "s": secs, "v": ver}


async def _beacon_site(db: AsyncIOMotorDatabase, site: str, origin: str | None) -> tuple[str, str, bool] | None:
    """(site id, the name the creator sees, Insights on) when the beacon comes from that site's
    own address; None otherwise."""
    from app.middleware.docs_cors import origin_allowed
    from app.services import docs_sites, guide_insights

    if docs_sites.is_studio_id(site):
        if not await guide_insights.origin_allowed(db, site, origin):
            return None
        st = await docs_sites.studio_site(db, site)
        if st is None:
            return None
        return st.id, st.name, bool(st.insights)
    if site == MARKDROP_DOCS_ID and origin_allowed(origin):
        return MARKDROP_DOCS_ID, MARKDROP_DOCS_NAME, False
    return None


async def record_beacon(db: AsyncIOMotorDatabase, slug: str, msg: dict, *, origin: str | None,
                        ip: str | None, ua: str) -> str:
    """The creator-analytics beacon: a block showing a public file was seen on a docs page, counted
    as one view of the file from the "Guides" channel with the guide's name as the campaign.
    Returns what happened ("ok" | "ignored"), which the caller doesn't reveal beyond a 202.
    (The guide's own Insights get their events through the Insights beacon: :func:`record_insight`.)"""
    from app.services import analytics, guide_insights
    from app.services import document as doc_service

    if msg["a"] != "view" or not SLUG_RE.match(slug or "") or guide_insights.is_bot(ua):
        return "ignored"
    where = await _beacon_site(db, msg["site"], origin)
    if where is None:
        return "ignored"
    _site_id, guide_name, _insights_on = where
    raw = await db["documents"].find_one({"slug": slug})
    if await blocked_reason(db, raw) is not None:
        return "ignored"
    assert raw is not None
    result = await doc_service.register_event(db, raw, "view")
    if result is None:
        return "ignored"
    doc_id, owner_id = result
    ver = None
    if raw.get("kind") == "artifact":
        cur = int(raw.get("file_version") or 1)
        ver = msg["v"] if msg["v"] and msg["v"] <= cur else cur
    await analytics.record_event(
        db, doc_id, owner_id, "view", ip=ip, referrer=None, user_agent=ua,
        utm={"source": UTM_SOURCE, "medium": UTM_MEDIUM, "campaign": guide_name[:100]}, ver=ver,
    )
    return "ok"


# ── The guide's Insights (and its Fix list) ───────────────────────────────────

#: Insights event actions (client/embedTrack.ts). Raw events in guide_events, k = "embed":
#:   {site, k: "embed", ts, day, p: page path, e: embed id, s: file slug, a: action,
#:    qt?: quartile (25|50|75|100), t?: where the video stopped (s), w?: seconds watched,
#:    d?: video length (s), pg?: furthest PDF page, n?: PDF page count, dev, v: visitor hash}
INSIGHT_ACTIONS = ("view", "interact", "fullscreen", "open", "play", "quartile", "leave", "pages")
_EID = re.compile(r"^(?:[A-Za-z0-9_-]{1,64}|file)(?:~\d{1,3})?$")
QUARTILES = (25, 50, 75, 100)
DROP_BUCKET_S = 5


def _num(v, lo: float, hi: float) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    f = float(v)
    if not math.isfinite(f) or f < lo or f > hi:
        return None
    return f


def parse_insight(body: dict) -> dict | None:
    """An `embed` Insights event, validated (None: ignore it)."""
    e, s, a = body.get("e"), body.get("s"), body.get("a")
    if a not in INSIGHT_ACTIONS or not isinstance(e, str) or not _EID.match(e) or not isinstance(s, str) or not SLUG_RE.match(s):
        return None
    out: dict[str, Any] = {"e": e, "s": s, "a": a}
    if a == "quartile":
        q = body.get("qt")
        if q not in QUARTILES or isinstance(q, bool):
            return None
        out["qt"] = int(q)
    elif a == "leave":
        t, w, d = _num(body.get("t"), 0, 86_400), _num(body.get("w"), 0, 86_400), _num(body.get("d"), 0, 86_400)
        if t is None:
            return None
        out["t"] = round(t, 1)
        if w is not None:
            out["w"] = int(w)
        if d is not None and d > 0:
            out["d"] = round(d, 1)
    elif a == "pages":
        pg, n = _num(body.get("pg"), 1, 5000), _num(body.get("n"), 1, 5000)
        if pg is None:
            return None
        out["pg"] = int(pg)
        if n is not None:
            out["n"] = int(n)
    return out


async def record_insight(db: AsyncIOMotorDatabase, site_id: str, ev: dict, *, path: str, ua: str | None,
                         ip: str | None, out: bool) -> bool:
    """One `embed` event into the guide's raw Insights events (90 days, like every other event)."""
    from app.services import guide_insights as gi

    ts = gi.now()
    day = gi.day_key(ts)
    if not gi._within_cap(site_id, day):
        return False
    await db[gi.RAW].insert_one({
        "site": site_id, "k": "embed", "ts": ts, "day": day, "p": path, **ev,
        "dev": gi.device_of(ua), "v": await gi._visitor(db, site_id, day, ip, ua, out),
    })
    return True


def _median(xs: list[float]) -> float | None:
    if not xs:
        return None
    ys = sorted(xs)
    m = len(ys) // 2
    return ys[m] if len(ys) % 2 else (ys[m - 1] + ys[m]) / 2


def drop_off(leaves: list[dict]) -> dict | None:
    """Where viewers stop a video, from `leave` events that didn't reach the end: the 5-second
    stretch most of them stopped in, with how many did (the Fix list's "loses viewers at 0:42")."""
    stops = [ev["t"] for ev in leaves if ev.get("d") and ev["t"] < ev["d"] * 0.95]
    if not stops:
        return None
    buckets: dict[int, int] = {}
    for t in stops:
        b = int(t // DROP_BUCKET_S) * DROP_BUCKET_S
        buckets[b] = buckets.get(b, 0) + 1
    at, n = max(buckets.items(), key=lambda kv: (kv[1], -kv[0]))
    return {"at": at, "stopped": n, "of": len(leaves)}


async def stats(db: AsyncIOMotorDatabase, site_id: str, range_key: str) -> dict:
    """GET /docs-sites/{id}/insights/embeds: per embedded block (page + embed id) over the range:
    views, interaction, full screen, opens on Markdrop; for a video plays, how far viewers got
    (quartiles), the median share watched and where most of them stop; for a PDF the median
    furthest page. A file that isn't public any more is listed without its title."""
    from app.services import guide_insights as gi

    days = gi.range_days(range_key)
    rows = await db[gi.RAW].find(
        {"site": site_id, "k": "embed", "day": {"$in": days}},
        {"_id": 0, "p": 1, "e": 1, "s": 1, "a": 1, "qt": 1, "t": 1, "w": 1, "d": 1, "pg": 1, "n": 1},
    ).to_list(length=200_000)
    blocks: dict[tuple[str, str], dict] = {}
    for ev in rows:
        key = (ev.get("p") or "/", ev.get("e") or ev.get("s"))
        b = blocks.setdefault(key, {"page": key[0], "embed": key[1], "slug": ev.get("s"), "views": 0, "interactions": 0,
                                    "fullscreen": 0, "opens": 0, "plays": 0, "quartiles": {str(q): 0 for q in QUARTILES},
                                    "_leaves": [], "_pages": [], "_n": 0})
        a = ev.get("a")
        if a == "view":
            b["views"] += 1
        elif a == "interact":
            b["interactions"] += 1
        elif a == "fullscreen":
            b["fullscreen"] += 1
        elif a == "open":
            b["opens"] += 1
        elif a == "play":
            b["plays"] += 1
        elif a == "quartile" and ev.get("qt") in QUARTILES:
            b["quartiles"][str(ev["qt"])] += 1
        elif a == "leave":
            b["_leaves"].append(ev)
        elif a == "pages":
            b["_pages"].append(int(ev.get("pg") or 0))
            b["_n"] = max(b["_n"], int(ev.get("n") or 0))
    slugs = list({b["slug"] for b in blocks.values() if b["slug"]})
    docs = {d["slug"]: d for d in await db["documents"].find({"slug": {"$in": slugs}}).to_list(length=len(slugs) or 1)}
    out = []
    for b in blocks.values():
        raw = docs.get(b["slug"])
        public = raw is not None and await blocked_reason(db, raw) is None
        leaves = b.pop("_leaves")
        pages = b.pop("_pages")
        n = b.pop("_n")
        shares = [min(1.0, ev["w"] / ev["d"]) for ev in leaves if ev.get("d") and ev.get("w") is not None]
        b.update({
            "url": canonical_link(b["slug"]),
            "title": (raw.get("title") or raw.get("original_filename") or b["slug"]) if public else None,
            "renderer": renderer_of(raw) if raw else None,
            "public": public,
            "interaction_rate": round(b["interactions"] / b["views"], 3) if b["views"] else None,
            "watch_s": sum(int(ev.get("w") or 0) for ev in leaves),
            "watched_share": round(_median(shares), 3) if shares else None,
            "drop_off": drop_off(leaves),
            "pdf": {"median_page": _median([float(p) for p in pages if p]), "pages": n or None, "readers": len(pages)} if pages else None,
        })
        out.append(b)
    out.sort(key=lambda x: (-x["views"], x["page"], x["embed"]))
    totals = {k: sum(x[k] for x in out) for k in ("views", "interactions", "fullscreen", "opens", "plays", "watch_s")}
    return {"range": range_key, "embeds": out[:200], "totals": {**totals, "blocks": len(out), "files": len({x["slug"] for x in out})}}


# ── Text versions (the build's embeds.json) ───────────────────────────────────

TEXTS = "docs_embed_text"
PDF_PAGES = 60
PDF_CHARS = 40_000
PDF_TIMEOUT_S = 20
EMBEDS_PER_SITE = 200
_LEAF = re.compile(r"^\s*::markdrop(?:\[([^\]]*)\])?\{((?:[^}\"']|\"[^\"]*\"|'[^']*')*)\}\s*$", re.M)


def embedded_slugs(pages: list[dict]) -> list[str]:
    """The slugs every page's ``::markdrop`` blocks name, in order, once each."""
    from app.services.docs_index import parse_attrs

    out: list[str] = []
    seen: set[str] = set()
    for p in pages or []:
        body = next((p[k] for k in ("markdown", "body", "content") if isinstance(p.get(k), str)), "")
        for m in _LEAF.finditer(body or ""):
            slug = slug_from_src(parse_attrs(m.group(2)).get("src"))
            if slug and slug not in seen:
                seen.add(slug)
                out.append(slug)
                if len(out) >= EMBEDS_PER_SITE:
                    return out
    return out


def extract_pdf(data: bytes) -> dict:
    """A PDF's page count, outline (bookmark titles) and text (the first pages), with pypdf; {}
    when it can't be read (no pypdf, encrypted, malformed)."""
    import io

    try:
        from pypdf import PdfReader
    except ImportError:  # pragma: no cover - pypdf is in requirements.txt
        return {}
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            return {"pages": len(reader.pages)}
        outline: list[str] = []

        def walk(items) -> None:
            for it in items:
                if isinstance(it, list):
                    walk(it)
                elif len(outline) < 40:
                    t = getattr(it, "title", None)
                    if isinstance(t, str) and t.strip():
                        outline.append(re.sub(r"\s+", " ", t).strip()[:200])

        try:
            walk(reader.outline)
        except Exception:
            pass
        parts: list[str] = []
        total = 0
        for page in reader.pages[:PDF_PAGES]:
            try:
                t = page.extract_text() or ""
            except Exception:
                t = ""
            t = re.sub(r"\s+", " ", t).strip()
            if t:
                parts.append(t)
                total += len(t) + 1
            if total >= PDF_CHARS:
                break
        return {"pages": len(reader.pages), "outline": outline, "text": " ".join(parts)[:PDF_CHARS]}
    except Exception:
        log.debug("pdf text extraction failed", exc_info=True)
        return {}


async def _pdf_text(db: AsyncIOMotorDatabase, raw: dict) -> dict:
    """The current PDF's text, extracted once per blob (``docs_embed_text``, keyed by the blob)."""
    import asyncio

    from app.services import r2

    key = raw.get("blob_key")
    if not key or not r2.is_configured():
        return {}
    hit = await db[TEXTS].find_one({"key": key}, {"_id": 0, "pages": 1, "outline": 1, "text": 1})
    if hit is not None:
        return hit
    try:
        data = await run_in_threadpool(r2.get_bytes, key, get_settings().artifact_max_bytes)
        if not data:
            return {}
        out = await asyncio.wait_for(run_in_threadpool(extract_pdf, data), timeout=PDF_TIMEOUT_S)
    except Exception:
        log.info("pdf text skipped for %s", raw.get("slug"), exc_info=True)
        return {}
    await db[TEXTS].update_one({"key": key}, {"$set": {**out, "key": key, "at": now()}}, upsert=True)
    return out


async def text_infos(db: AsyncIOMotorDatabase, pages: list[dict]) -> dict[str, dict]:
    """embeds.json for a build: what the build may say about each file the pages embed. Public files
    only (anything else has no entry at all): the title, the kind, a video's length, a PDF's pages,
    outline and text (a pinned version's text isn't extracted; the current file's is)."""
    from app.services import artifact as art_service
    from app.services import document as doc_service

    out: dict[str, dict] = {}
    for slug in embedded_slugs(pages):
        raw, _moved = await doc_service.find_for_read(db, slug)
        if await blocked_reason(db, raw) is not None:
            continue
        assert raw is not None
        renderer = renderer_of(raw)
        info: dict[str, Any] = {"title": raw.get("title") or raw.get("original_filename") or slug}
        if raw.get("kind") == "artifact":
            info["type"] = {"html": "Interactive page", "bundle": "Website", "pdf": "PDF", "video": "Video"}.get(
                renderer, art_service.label_for(raw.get("mime") or ""))
            m = _media(raw.get("media"))
            if m and m.get("duration"):
                info["duration"] = round(float(m["duration"]), 1)
            if renderer == "pdf":
                t = await _pdf_text(db, raw)
                for k in ("pages", "outline", "text"):
                    if t.get(k):
                        info[k] = t[k]
        else:
            info["type"] = "Markdrop document"
            ex = excerpt(raw.get("content"), 1200)
            if ex:
                info["text"] = ex
        out[slug] = info
    return out
