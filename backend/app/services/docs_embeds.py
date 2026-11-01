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
:func:`record_beacon` takes the block's beacons (``POST /api/v1/embeds/{slug}/beacon``): a view
counts once per page load in the file's own creator analytics, from the "Guides" channel with the
guide's name as the campaign ("seen in Acme Docs"), and, for a Markdrop Guides site with Insights
on, as daily counts per file and page in ``guide_embed_daily`` (views, full screen, opened on
Markdrop, plays, seconds watched). Nothing is kept per reader: no hash, no address, no id. A beacon
is accepted only from the guide's own live addresses (Origin), only for a file that is public now.
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
DAILY = "guide_embed_daily"
DAILY_TTL_DAYS = 400
ROWS_PER_SITE_DAY = 2000
SLUG_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MARKDROP_HOSTS = {"markdrop.in", "www.markdrop.in"}
ACTIONS = {"view": "views", "fullscreen": "fullscreen", "open": "opens", "play": "plays", "watch": "watch_s"}
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
    await db[DAILY].create_index([("site", 1), ("day", 1), ("slug", 1), ("path", 1)], unique=True)
    await db[DAILY].create_index("expires_at", expireAfterSeconds=0)


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


# ── Beacons ───────────────────────────────────────────────────────────────────

_rows_seen: dict[tuple[str, str], int] = {}


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
    """One beacon. Returns what happened ("ok" | "ignored"), which the caller doesn't reveal
    beyond a 202."""
    from app.services import analytics, guide_insights
    from app.services import document as doc_service

    if not SLUG_RE.match(slug or "") or guide_insights.is_bot(ua):
        return "ignored"
    where = await _beacon_site(db, msg["site"], origin)
    if where is None:
        return "ignored"
    site_id, guide_name, insights_on = where
    raw = await db["documents"].find_one({"slug": slug})
    if await blocked_reason(db, raw) is not None:
        return "ignored"
    assert raw is not None
    if msg["a"] == "view":
        result = await doc_service.register_event(db, raw, "view")
        if result is not None:
            doc_id, owner_id = result
            ver = None
            if raw.get("kind") == "artifact":
                cur = int(raw.get("file_version") or 1)
                ver = msg["v"] if msg["v"] and msg["v"] <= cur else cur
            await analytics.record_event(
                db, doc_id, owner_id, "view", ip=ip, referrer=None, user_agent=ua,
                utm={"source": UTM_SOURCE, "medium": UTM_MEDIUM, "campaign": guide_name[:100]}, ver=ver,
            )
    if not insights_on:
        return "ok"
    path = guide_insights.clean_path(msg.get("p"))
    if path is None:
        return "ok"
    day = guide_insights.day_key(now())
    key = {"site": site_id, "day": day, "slug": slug, "path": path}
    inc = {ACTIONS[msg["a"]]: msg["s"] if msg["a"] == "watch" else 1}
    res = await db[DAILY].update_one(key, {"$inc": inc}, upsert=False)
    if res.matched_count == 0:
        # A new (file, page) row today: bounded per guide per day, so forged paths can't grow it.
        seen_key = (site_id, day)
        n = _rows_seen.get(seen_key)
        if n is None:
            n = await db[DAILY].count_documents({"site": site_id, "day": day})
        if n >= ROWS_PER_SITE_DAY:
            return "ignored"
        if len(_rows_seen) > 20_000:
            _rows_seen.clear()
        _rows_seen[seen_key] = n + 1
        expires = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc) + timedelta(days=DAILY_TTL_DAYS)
        await db[DAILY].update_one(
            key, {"$inc": inc, "$setOnInsert": {"doc_id": str(raw["_id"]), "expires_at": expires}}, upsert=True)
    return "ok"


# ── The Insights tab ──────────────────────────────────────────────────────────


async def stats(db: AsyncIOMotorDatabase, site_id: str, range_key: str) -> dict:
    """GET /docs-sites/{id}/insights/embeds: per embedded file, over the range: views, full-screen
    opens, opens on Markdrop, plays and minutes watched, and the pages it was seen on. A file
    that isn't public any more is listed without its title."""
    from app.services import guide_insights

    days = guide_insights.range_days(range_key)
    rows = await db[DAILY].aggregate([
        {"$match": {"site": site_id, "day": {"$in": days}}},
        {"$group": {
            "_id": {"slug": "$slug", "path": "$path"},
            "doc_id": {"$last": "$doc_id"},
            **{f: {"$sum": f"${f}"} for f in ACTIONS.values()},
        }},
    ]).to_list(length=20_000)
    by: dict[str, dict] = {}
    for r in rows:
        slug = r["_id"]["slug"]
        e = by.setdefault(slug, {"slug": slug, "doc_id": r.get("doc_id"), "pages": [], **{f: 0 for f in ACTIONS.values()}})
        for f in ACTIONS.values():
            e[f] += int(r.get(f) or 0)
        e["pages"].append({"path": r["_id"]["path"], "views": int(r.get("views") or 0)})
    slugs = list(by)
    docs = {d["slug"]: d for d in await db["documents"].find(
        {"slug": {"$in": slugs}}, {"slug": 1, "title": 1, "original_filename": 1, "kind": 1, "mime": 1, "access_level": 1,
                                   "read_password_hash": 1, "expires_at": 1, "workspace_id": 1, "encrypted": 1, "owner_id": 1}).to_list(length=len(slugs) or 1)}
    out = []
    for slug, e in by.items():
        raw = docs.get(slug)
        public = raw is not None and await blocked_reason(db, raw) is None
        e.pop("doc_id", None)
        e["pages"] = sorted(e["pages"], key=lambda p: -p["views"])[:10]
        out.append({
            **e,
            "url": canonical_link(slug),
            "title": (raw.get("title") or raw.get("original_filename") or slug) if public else None,
            "renderer": renderer_of(raw) if raw else None,
            "public": public,
        })
    out.sort(key=lambda e: (-e["views"], e["slug"]))
    totals = {f: sum(e[f] for e in out) for f in ACTIONS.values()}
    return {"range": range_key, "embeds": out[:100], "totals": {**totals, "files": len(out)}}


async def clear(db: AsyncIOMotorDatabase, site_id: str) -> int:
    return (await db[DAILY].delete_many({"site": site_id})).deleted_count
