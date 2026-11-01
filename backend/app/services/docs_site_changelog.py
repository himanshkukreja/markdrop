"""A guide's changelog: entries, its settings, what a publish writes, and turning a page into entries.

The engine already draws a changelog from a content folder's ``changelog.json`` (the /changelog hub,
an entry page per release, RSS/JSON/Markdown feeds, link previews, search and Ask AI; see
frontend/src/docs/content.ts and changelog.tsx). This module is the studio's side of it.

Storage, like pages: one ``docs_changelog_entries`` row per entry (drafts: what the studio edits),
and the changelog's own settings on the site row under ``changelog`` (the hub's title and
description, the products entries can name, and the "Coming next" list). Nothing reaches readers
until the next Publish: the snapshot (services/docs_site_publish.py) copies the entries and settings
(:func:`snapshot_part`) and the content writer (services/docs_snapshot.py) turns them into
``changelog.json`` (:func:`changelog_json`), plus a Changelog header tab and the videos the entries
show. "Published / Not published yet" in the studio is the entry's hash against the live snapshot's.

An entry row::

    {_id, site_id, slug, date "YYYY-MM-DD", title, kind new|improved|fixed, area, products [id],
     versions {product id: "2.4"}, summary, body (Markdown), highlights [str],
     media {image?, video?, alt?} (the guide's own /docs-assets/ files), try {label, href}?,
     docs [page id], rev, created_by, created_at, updated_by, updated_at}

Who may do what follows pages: everyone on the guide reads, editors and up write.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import date as _date
from typing import Any

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from app.config import get_settings
from app.models.user import User
from app.services import docs_site_assets as assets
from app.services import docs_site_store as store
from app.services.docs_site_store import ASSETS, PAGES, SITES, DocsError, aware, now

settings = get_settings()

ENTRIES = "docs_changelog_entries"

KINDS = ("new", "improved", "fixed")
MAX_ENTRIES = 500
MAX_BODY = 50_000
MAX_TITLE = 120
MAX_SUMMARY = 280
MAX_AREA = 40
MAX_HIGHLIGHTS = 8
MAX_HIGHLIGHT = 200
MAX_DOCS = 10
MAX_PRODUCTS = 12
MAX_NEXT = 12
MAX_ALT = 200
SLUG_MAX = 80
DEFAULT_AREA = "General"
DEFAULT_TITLE = "Changelog"

_SLUG = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$")
_PRODUCT_ID = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$")
_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,29}$")
_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")
IMAGE_EXTS = ("png", "jpg", "jpeg", "gif", "webp", "avif", "svg")
VIDEO_EXTS = ("mp4", "webm")


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[ENTRIES].create_index([("site_id", 1), ("slug", 1)], unique=True, name="site_slug_unique")
    await db[ENTRIES].create_index([("site_id", 1), ("date", -1)])


# ── Values ────────────────────────────────────────────────────────────────────


def _bad(detail: str, status: int = 422) -> HTTPException:
    return HTTPException(status_code=status, detail=detail)


def _line(v: Any, what: str, limit: int, *, required: bool = False) -> str:
    """One line of text: whitespace (newlines too) collapsed, at most ``limit`` characters."""
    s = re.sub(r"\s+", " ", v).strip() if isinstance(v, str) else ""
    if v is not None and not isinstance(v, str):
        raise _bad(f"{what} must be text.")
    if required and not s:
        raise _bad(f"Add {what.lower()}.")
    if len(s) > limit:
        raise _bad(f"{what} can be at most {limit} characters.")
    return s


def slugify(text: str, limit: int = 60) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    s = s[:limit].strip("-")
    return s or "release"


def check_slug(v: Any) -> str:
    s = (v or "").strip().lower() if isinstance(v, str) else ""
    if not _SLUG.match(s):
        raise _bad("Use an address like dark-mode: lowercase letters, numbers and hyphens (at most 80).")
    return s


def check_date(v: Any) -> str:
    if not isinstance(v, str) or not _ISO.match(v.strip()):
        raise _bad("Use a date like 2026-11-01.")
    try:
        d = _date.fromisoformat(v.strip())
    except ValueError:
        raise _bad("That date doesn't exist.") from None
    if not 2000 <= d.year <= 2100:
        raise _bad("Use a date between 2000 and 2100.")
    return d.isoformat()


def today() -> str:
    return now().date().isoformat()


def _asset_ext(url: str) -> str:
    name = url.rsplit("/", 1)[-1]
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


async def _own_asset(db: AsyncIOMotorDatabase, site: dict, url: Any, exts: tuple[str, ...], what: str) -> str:
    """``url`` is one of this guide's files (``/docs-assets/<rel>``: an upload, or a file an import
    brought in) with one of ``exts``."""
    if not isinstance(url, str) or not url.strip():
        raise _bad(f"Pick the {what} from this guide's files.")
    url = url.strip()
    rel = assets.rel_of(url)
    if not rel or _asset_ext(url) not in exts:
        raise _bad(f"Pick the {what} from this guide's files ({', '.join(e.upper() for e in exts)}).")
    row = await db[ASSETS].find_one({"site_id": site["_id"], "name": rel}, {"_id": 1})
    if row is None:
        from app.services.docs_import_job import import_asset_type

        # An imported file whose bytes another path already had shares that path's row.
        if not import_asset_type(rel):
            raise _bad(f"That {what} isn't one of this guide's files. Upload it first.")
    return url


def _try_link(v: Any) -> dict | None:
    if v in (None, {}, ""):
        return None
    if not isinstance(v, dict):
        raise _bad("The Try it link needs a label and an address.")
    href = (v.get("href") or "").strip() if isinstance(v.get("href"), str) else ""
    if not href:
        return None
    label = _line(v.get("label"), "The Try it label", 40) or "Try it"
    ok = (href.startswith("/") and not href.startswith("//")) or href.startswith("https://")
    if not ok or len(href) > 500 or re.search(r"[\s<>\"'`\\]", href):
        raise _bad("The Try it link must be an https:// address or a page of the guide (/quickstart).")
    if href.startswith("https://"):
        from app.schemas.docs_site import public_https_url

        if not public_https_url(href.split("#")[0]):
            raise _bad("The Try it link must be a public https:// address.")
    return {"label": label, "href": href}


def _highlights(v: Any) -> list[str]:
    if v is None:
        return []
    if not isinstance(v, list):
        raise _bad("Highlights must be a list.")
    out = [_line(x, "A highlight", MAX_HIGHLIGHT) for x in v]
    out = [x for x in out if x]
    if len(out) > MAX_HIGHLIGHTS:
        raise _bad(f"An entry can have at most {MAX_HIGHLIGHTS} highlights.")
    return out


def _meta(site: dict) -> dict:
    m = site.get("changelog") if isinstance(site.get("changelog"), dict) else {}
    return {
        "title": m.get("title") or "",
        "description": m.get("description") or "",
        "products": [p for p in (m.get("products") or []) if isinstance(p, dict) and p.get("id")],
        "next": [n for n in (m.get("next") or []) if isinstance(n, dict) and n.get("title")],
    }


async def _page_ids(db: AsyncIOMotorDatabase, site: dict, v: Any) -> list[str]:
    if v is None:
        return []
    if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
        raise _bad("Related pages must be a list of page ids.")
    ids = list(dict.fromkeys(v))
    if len(ids) > MAX_DOCS:
        raise _bad(f"Link at most {MAX_DOCS} pages.")
    oids = []
    for x in ids:
        try:
            oids.append(ObjectId(x))
        except Exception:
            raise _bad("One of the related pages isn't in this guide.") from None
    found = {str(r["_id"]) async for r in db[PAGES].find(
        {"_id": {"$in": oids}, "site_id": site["_id"], "deleted_at": None}, {"_id": 1})}
    if len(found) != len(ids):
        raise _bad("One of the related pages isn't in this guide.")
    return ids


async def clean_entry(db: AsyncIOMotorDatabase, site: dict, data: dict, *, base: dict | None = None) -> dict:
    """The stored fields of an entry from a request body (``base``: the entry it changes, for a
    partial update). Raises 422 with a message for the first problem."""
    src = {**(base or {}), **{k: v for k, v in data.items() if k in FIELDS}}
    meta = _meta(site)
    known = {p["id"] for p in meta["products"]}
    out: dict[str, Any] = {}
    out["title"] = _line(src.get("title"), "A title", MAX_TITLE, required=True)
    out["date"] = check_date(src.get("date") or today())
    kind = src.get("kind") or "new"
    if kind not in KINDS:
        raise _bad("Kind must be new, improved or fixed.")
    out["kind"] = kind
    out["area"] = _line(src.get("area"), "The area", MAX_AREA) or DEFAULT_AREA
    out["summary"] = _line(src.get("summary"), "A one-line summary", MAX_SUMMARY, required=True)
    body = src.get("body") or ""
    if not isinstance(body, str):
        raise _bad("The body must be Markdown text.")
    if len(body) > MAX_BODY:
        raise _bad(f"An entry's details can be at most {MAX_BODY:,} characters.", 413)
    out["body"] = body.rstrip()
    out["highlights"] = _highlights(src.get("highlights"))
    products = src.get("products") or []
    if not isinstance(products, list) or not all(isinstance(p, str) for p in products):
        raise _bad("Products must be a list of product ids.")
    versions = src.get("versions") or {}
    if not isinstance(versions, dict):
        raise _bad("Versions must map a product to a version.")
    clean_versions: dict[str, str] = {}
    for pid, ver in versions.items():
        ver = ver.strip() if isinstance(ver, str) else ver
        if ver in (None, ""):
            continue
        if pid not in known:
            raise _bad("Add the product in the changelog's settings before giving it a version.")
        if not isinstance(ver, str) or not _VERSION.match(ver):
            raise _bad("Use a version like 2.4 or v3.1.0-beta (letters, numbers, . _ + -).")
        clean_versions[pid] = ver
    products = list(dict.fromkeys([*products, *clean_versions]))
    unknown = [p for p in products if p not in known]
    if unknown:
        raise _bad("Add the product in the changelog's settings first.")
    out["products"] = products
    out["versions"] = clean_versions
    media_in = src.get("media") or {}
    if not isinstance(media_in, dict):
        raise _bad("Media must be an image or a video.")
    media: dict[str, str] = {}
    if media_in.get("image"):
        media["image"] = await _own_asset(db, site, media_in["image"], IMAGE_EXTS, "image")
    if media_in.get("video"):
        media["video"] = await _own_asset(db, site, media_in["video"], VIDEO_EXTS, "video")
    alt = _line(media_in.get("alt"), "The description", MAX_ALT)
    if media and alt:
        media["alt"] = alt
    out["media"] = media
    out["try"] = _try_link(src.get("try"))
    out["docs"] = await _page_ids(db, site, src.get("docs"))
    return out


FIELDS = ("title", "date", "kind", "area", "summary", "body", "highlights", "products", "versions", "media",
          "try", "docs")


def content_hash(e: dict) -> str:
    """What readers would see of an entry; equal hashes = nothing to publish."""
    data = [e.get("slug")] + [e.get(f) for f in FIELDS]
    return hashlib.sha256(json.dumps(data, sort_keys=True, default=str).encode()).hexdigest()


def meta_hash(meta: dict) -> str:
    data = [meta.get(k) for k in ("title", "description", "products", "next")]
    return hashlib.sha256(json.dumps(data, sort_keys=True, default=str).encode()).hexdigest()


# ── Live comparison ───────────────────────────────────────────────────────────


def live_part(snap: dict | None) -> dict:
    """A snapshot's changelog ({entries: [...], meta_hash}); a snapshot from before the changelog
    (or nothing live): no entries, and the settings' defaults."""
    part = (snap or {}).get("changelog") if isinstance((snap or {}).get("changelog"), dict) else {}
    return {"entries": [e for e in part.get("entries") or [] if isinstance(e, dict)],
            "meta_hash": part.get("meta_hash") or meta_hash(_meta({"changelog": part.get("meta") or {}}))}


def status_of(row: dict, live: dict[str, str]) -> str:
    """published (the live guide shows it as it is), changed (live, edited since), new (never published)."""
    h = live.get(str(row["_id"]))
    if h is None:
        return "new"
    return "published" if h == content_hash(row) else "changed"


async def _live_map(db: AsyncIOMotorDatabase, site: dict) -> tuple[dict[str, str], dict, bool]:
    from app.services import docs_site_pages as pages

    snap = await pages.live_snapshot(db, site)
    part = live_part(snap)
    return {e.get("entry_id"): e.get("hash") for e in part["entries"]}, part, snap is not None


def entry_view(row: dict, live: dict[str, str], names: dict[str, str] | None = None, *, body: bool = True) -> dict:
    out = {
        "id": str(row["_id"]),
        "slug": row.get("slug"),
        "date": row.get("date"),
        "title": row.get("title"),
        "kind": row.get("kind"),
        "area": row.get("area") or DEFAULT_AREA,
        "products": row.get("products") or [],
        "versions": row.get("versions") or {},
        "summary": row.get("summary") or "",
        "highlights": row.get("highlights") or [],
        "media": row.get("media") or {},
        "try": row.get("try"),
        "docs": row.get("docs") or [],
        "has_body": bool((row.get("body") or "").strip()),
        "status": status_of(row, live),
        "rev": row.get("rev") or 1,
        "updated_at": aware(row.get("updated_at")),
        "updated_by": row.get("updated_by"),
        "updated_by_name": (names or {}).get(row.get("updated_by") or ""),
        "created_at": aware(row.get("created_at")),
    }
    if body:
        out["body"] = row.get("body") or ""
    return out


def _sorted(rows: list[dict]) -> list[dict]:
    return sorted(rows, key=lambda r: (r.get("date") or "", aware(r.get("created_at")) or now()), reverse=True)


async def overview(db: AsyncIOMotorDatabase, site: dict) -> dict:
    """GET …/changelog: the settings, every entry (newest first, without bodies) with its status,
    and the published entries that were deleted since (they leave at the next publish)."""
    rows = await db[ENTRIES].find({"site_id": site["_id"]}).to_list(length=MAX_ENTRIES + 10)
    live, part, ever = await _live_map(db, site)
    names = await store.user_names(db, [r.get("updated_by") for r in rows])
    out = [entry_view(r, live, names, body=False) for r in _sorted(rows)]
    ids = {str(r["_id"]) for r in rows}
    removed = [{"id": e.get("entry_id"), "slug": e.get("slug"), "title": e.get("title"), "date": e.get("date")}
               for e in part["entries"] if e.get("entry_id") not in ids]
    meta = _meta(site)
    return {
        "settings": meta,
        "settings_published": not ever or part["meta_hash"] == meta_hash(meta),
        "entries": out,
        "removed": removed,
        "limits": {"entries": MAX_ENTRIES, "body_chars": MAX_BODY, "products": MAX_PRODUCTS, "next": MAX_NEXT,
                   "highlights": MAX_HIGHLIGHTS},
        "ever_published": ever,
    }


async def load(db: AsyncIOMotorDatabase, site: dict, entry_id: str) -> dict:
    row = await db[ENTRIES].find_one({"_id": store.oid(entry_id, "Entry"), "site_id": site["_id"]})
    if row is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    return row


async def view(db: AsyncIOMotorDatabase, site: dict, row: dict) -> dict:
    live, _part, _ever = await _live_map(db, site)
    names = await store.user_names(db, [row.get("updated_by")])
    return entry_view(row, live, names)


# ── Create / save / delete ────────────────────────────────────────────────────


async def _free_slug(db: AsyncIOMotorDatabase, site_id: ObjectId, base: str, exclude: ObjectId | None = None) -> str:
    base = base[:SLUG_MAX - 4].strip("-") or "release"
    taken = {r["slug"] async for r in db[ENTRIES].find(
        {"site_id": site_id, "slug": {"$regex": f"^{re.escape(base)}(-[0-9]+)?$"},
         **({"_id": {"$ne": exclude}} if exclude else {})}, {"slug": 1})}
    if base not in taken:
        return base
    n = 2
    while f"{base}-{n}" in taken:
        n += 1
    return f"{base}-{n}"


async def _check_room(db: AsyncIOMotorDatabase, site: dict, adding: int = 1) -> None:
    n = await db[ENTRIES].count_documents({"site_id": site["_id"]})
    if n + adding > MAX_ENTRIES:
        raise HTTPException(status_code=409, detail=f"A guide's changelog can have at most {MAX_ENTRIES} entries. "
                                                    "Delete old ones to add more.")


async def create(db: AsyncIOMotorDatabase, site: dict, user: User, data: dict) -> dict:
    await _check_room(db, site)
    fields = await clean_entry(db, site, data)
    slug = check_slug(data["slug"]) if data.get("slug") else await _free_slug(db, site["_id"], slugify(fields["title"]))
    at = now()
    row = {"site_id": site["_id"], "slug": slug, **fields, "rev": 1, "created_by": user.id, "created_at": at,
           "updated_by": user.id, "updated_at": at}
    try:
        res = await db[ENTRIES].insert_one(row)
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail=f"Another entry already uses the address /changelog/{slug}.") \
            from None
    row["_id"] = res.inserted_id
    await store.log_event(db, "docs_changelog_entry_created", site, user.id, entry_kind=fields["kind"])
    return row


async def save(db: AsyncIOMotorDatabase, site: dict, row: dict, user: User, data: dict, base_rev: int | None) -> dict:
    """A partial update. ``base_rev``: the rev the change was made on; someone saved since → 409
    with the current rev and who saved it (never a silent overwrite)."""
    current = row.get("rev") or 1
    if base_rev is not None and base_rev != current:
        names = await store.user_names(db, [row.get("updated_by")])
        raise DocsError(409, {"detail": "Someone saved this entry meanwhile.", "rev": current,
                              "updated_by": row.get("updated_by"),
                              "updated_by_name": names.get(row.get("updated_by") or ""),
                              "updated_at": aware(row.get("updated_at"))})
    fields = await clean_entry(db, site, data, base={f: row.get(f) for f in FIELDS})
    if "slug" in data and data["slug"] != row.get("slug"):
        fields["slug"] = check_slug(data["slug"])
    try:
        saved = await db[ENTRIES].find_one_and_update(
            {"_id": row["_id"], "rev": current},
            {"$set": {**fields, "rev": current + 1, "updated_by": user.id, "updated_at": now()}},
            return_document=ReturnDocument.AFTER)
    except DuplicateKeyError:
        raise HTTPException(status_code=409,
                            detail=f"Another entry already uses the address /changelog/{fields.get('slug')}.") from None
    if saved is None:
        fresh = await db[ENTRIES].find_one({"_id": row["_id"]}) or row
        raise DocsError(409, {"detail": "Someone saved this entry meanwhile.", "rev": fresh.get("rev"),
                              "updated_by": fresh.get("updated_by"), "updated_at": aware(fresh.get("updated_at"))})
    return saved


async def delete(db: AsyncIOMotorDatabase, site: dict, row: dict, user: User) -> None:
    await db[ENTRIES].delete_one({"_id": row["_id"], "site_id": site["_id"]})
    await store.log_event(db, "docs_changelog_entry_deleted", site, user.id)


async def duplicate(db: AsyncIOMotorDatabase, site: dict, row: dict, user: User) -> dict:
    await _check_room(db, site)
    at = now()
    copy = {f: row.get(f) for f in FIELDS}
    title = f"{row.get('title') or 'Untitled'} (copy)"
    copy["title"] = title[:MAX_TITLE]
    copy["date"] = today()
    new = {"site_id": site["_id"], "slug": await _free_slug(db, site["_id"], f"{row.get('slug') or 'release'}-copy"),
           **copy, "rev": 1, "created_by": user.id, "created_at": at, "updated_by": user.id, "updated_at": at}
    res = await db[ENTRIES].insert_one(new)
    new["_id"] = res.inserted_id
    return new


# ── Settings: title, description, products, Coming next ─────────────────────


async def save_settings(db: AsyncIOMotorDatabase, site: dict, user: User, data: dict) -> dict:
    """Replace the changelog's settings. A product taken off the list leaves every entry that
    named it (and its versions there): returns how many entries changed."""
    title = _line(data.get("title"), "The title", 60)
    description = _line(data.get("description"), "The description", 300)
    products_in = data.get("products") or []
    if not isinstance(products_in, list):
        raise _bad("Products must be a list.")
    if len(products_in) > MAX_PRODUCTS:
        raise _bad(f"A changelog can name at most {MAX_PRODUCTS} products.")
    products: list[dict] = []
    seen: set[str] = set()
    for p in products_in:
        if not isinstance(p, dict):
            raise _bad("Each product needs a name.")
        label = _line(p.get("label"), "A product name", 40, required=True)
        pid = (p.get("id") or "").strip() if isinstance(p.get("id"), str) else ""
        pid = pid or slugify(label, 24)
        if not _PRODUCT_ID.match(pid):
            raise _bad("A product id is lowercase letters, numbers and hyphens (at most 24).")
        if pid in seen:
            raise _bad(f"Two products share the id {pid}.")
        seen.add(pid)
        products.append({"id": pid, "label": label})
    next_in = data.get("next") or []
    if not isinstance(next_in, list):
        raise _bad("Coming next must be a list.")
    if len(next_in) > MAX_NEXT:
        raise _bad(f"Coming next can list at most {MAX_NEXT} items.")
    nxt: list[dict] = []
    for n in next_in:
        if not isinstance(n, dict):
            raise _bad("Each Coming next item needs a title.")
        item = {"title": _line(n.get("title"), "A Coming next title", MAX_TITLE, required=True)}
        body = _line(n.get("body"), "A Coming next note", 400)
        area = _line(n.get("area"), "A Coming next area", MAX_AREA)
        if body:
            item["body"] = body
        if area:
            item["area"] = area
        nxt.append(item)
    meta = {"title": title, "description": description, "products": products, "next": nxt,
            "updated_by": user.id, "updated_at": now()}
    await db[SITES].update_one({"_id": site["_id"]}, {"$set": {"changelog": meta, "updated_at": now()}})
    site["changelog"] = meta
    # Entries that name a product no longer on the list drop it (and its version).
    keep = {p["id"] for p in products}
    changed = 0
    async for r in db[ENTRIES].find({"site_id": site["_id"], "products.0": {"$exists": True}},
                                    {"products": 1, "versions": 1}):
        prods = [p for p in r.get("products") or [] if p in keep]
        if len(prods) == len(r.get("products") or []):
            continue
        vers = {k: v for k, v in (r.get("versions") or {}).items() if k in keep}
        await db[ENTRIES].update_one({"_id": r["_id"]}, {"$set": {"products": prods, "versions": vers,
                                                                   "updated_at": now()}, "$inc": {"rev": 1}})
        changed += 1
    return {"settings": _meta(site), "entries_changed": changed}


# ── Media: the guide's images and videos ─────────────────────────────────────


async def media(db: AsyncIOMotorDatabase, site: dict, kind: str | None = None, limit: int = 120) -> list[dict]:
    """The guide's images and videos, newest first (the entry editor's media picker). Dark
    versions are left out (they go with their image)."""
    exts = IMAGE_EXTS if kind == "image" else VIDEO_EXTS if kind == "video" else IMAGE_EXTS + VIDEO_EXTS
    rows = await db[ASSETS].find(
        {"site_id": site["_id"], "ext": {"$in": list(exts)}, "variant": {"$ne": "dark"}},
        {"name": 1, "url": 1, "size": 1, "content_type": 1, "original_name": 1, "created_at": 1, "ext": 1},
    ).sort("created_at", -1).to_list(length=max(1, min(limit, 300)))
    return [{"url": r.get("url") or assets.url_for(r["name"]), "name": r.get("original_name") or r["name"].rsplit("/", 1)[-1],
             "size": r.get("size"), "kind": "video" if r.get("ext") in VIDEO_EXTS else "image",
             "created_at": aware(r.get("created_at"))} for r in rows]


# ── Publish: the snapshot's part and changelog.json ──────────────────────────


async def snapshot_part(db: AsyncIOMotorDatabase, site: dict) -> dict:
    """What a publish freezes: the settings and every entry with its hash."""
    rows = _sorted(await db[ENTRIES].find({"site_id": site["_id"]}).to_list(length=MAX_ENTRIES + 10))
    meta = _meta(site)
    return {
        "meta": meta,
        "meta_hash": meta_hash(meta),
        "entries": [{"entry_id": str(r["_id"]), "slug": r.get("slug"), **{f: r.get(f) for f in FIELDS},
                     "hash": content_hash(r)} for r in rows],
    }


def video_id(slug: str) -> str:
    return f"changelog-{slug}"


def changelog_json(part: dict | None, pages: list[dict]) -> tuple[dict | None, dict]:
    """The engine's ``changelog.json`` for a snapshot's changelog part (None: no entries, so the
    guide has no /changelog) and the videos its entries show ({id: {src, title, poster?}}, merged
    into videos.json). ``pages``: the snapshot's pages, to turn related page ids into paths (a page
    that isn't in the publish is left out)."""
    part = part if isinstance(part, dict) else {}
    entries_in = [e for e in part.get("entries") or [] if isinstance(e, dict) and e.get("slug") and e.get("title")]
    if not entries_in:
        return None, {}
    meta = part.get("meta") or {}
    path_of = {str(p.get("page_id")): p.get("path") for p in pages if p.get("page_id")}
    products = [{"id": p["id"], "label": p.get("label") or p["id"]} for p in meta.get("products") or []
                if isinstance(p, dict) and p.get("id")]
    entries: list[dict] = []
    videos: dict[str, dict] = {}
    for e in sorted(entries_in, key=lambda x: x.get("date") or "", reverse=True):
        out: dict[str, Any] = {
            "id": e["slug"],
            "date": e.get("date"),
            "title": e["title"],
            "kind": e.get("kind") if e.get("kind") in KINDS else "improved",
            "area": e.get("area") or DEFAULT_AREA,
            "products": list(e.get("products") or []),
            "summary": e.get("summary") or "",
        }
        if e.get("versions"):
            out["versions"] = dict(e["versions"])
        if (e.get("body") or "").strip():
            out["body"] = e["body"]
        m = e.get("media") or {}
        media_out: dict[str, str] = {}
        if m.get("video"):
            vid = video_id(e["slug"])
            videos[vid] = {"src": m["video"], "title": e["title"], **({"poster": m["image"]} if m.get("image") else {})}
            media_out["video"] = vid
        if m.get("image"):
            media_out["image"] = m["image"]
        if media_out and m.get("alt"):
            media_out["alt"] = m["alt"]
        if media_out:
            out["media"] = media_out
        if isinstance(e.get("try"), dict) and e["try"].get("href"):
            out["try"] = {"label": e["try"].get("label") or "Try it", "href": e["try"]["href"]}
        docs = [path_of[d] for d in e.get("docs") or [] if path_of.get(d)]
        if docs:
            out["docs"] = docs
        if e.get("highlights"):
            out["highlights"] = list(e["highlights"])
        entries.append(out)
    return {"products": products, "next": list(meta.get("next") or []), "entries": entries}, videos


def tab_label(part: dict | None) -> str:
    title = ((part or {}).get("meta") or {}).get("title") or ""
    return title if title and len(title) <= 24 else DEFAULT_TITLE


def add_to_site(out: dict, part: dict | None) -> None:
    """site.json for a guide with changelog entries: a header tab to /changelog (after the guide's
    own tabs; a guide with none gets a "Docs" tab first, as the API reference does) and the hub's
    title and description."""
    meta = (part or {}).get("meta") or {}
    tabs = list(out.get("tabs") or [])
    if not any((t or {}).get("href") == "/changelog" for t in tabs):
        if not tabs:
            tabs = [{"id": "docs", "label": "Docs", "href": "/"}]
        ids = {t.get("id") for t in tabs}
        tid = "changelog" if "changelog" not in ids else "changelog-tab"
        tabs.append({"id": tid, "label": tab_label(part), "href": "/changelog"})
    out["tabs"] = tabs
    hub: dict[str, str] = {}
    if meta.get("title"):
        hub["title"] = meta["title"]
    if meta.get("description"):
        hub["description"] = meta["description"]
    if hub:
        out["changelog"] = hub


# ── Changes since the live build ─────────────────────────────────────────────


async def changes(db: AsyncIOMotorDatabase, site: dict, snap: dict | None) -> tuple[list[dict], bool]:
    """(entries added, edited or removed since ``snap`` (the live snapshot), whether the changelog's
    settings changed). Nothing live: every entry is new."""
    part = live_part(snap)
    live = {e.get("entry_id"): e for e in part["entries"]}
    rows = await db[ENTRIES].find({"site_id": site["_id"]}).to_list(length=MAX_ENTRIES + 10)
    names = await store.user_names(db, [r.get("updated_by") for r in rows])
    out: list[dict] = []
    seen = set()
    for r in _sorted(rows):
        rid = str(r["_id"])
        seen.add(rid)
        old = live.get(rid)
        if old is not None and old.get("hash") == content_hash(r):
            continue
        out.append({"id": rid, "slug": r.get("slug"), "title": r.get("title"), "date": r.get("date"),
                    "change": "added" if old is None else "modified",
                    "updated_by": r.get("updated_by"), "updated_by_name": names.get(r.get("updated_by") or ""),
                    "updated_at": aware(r.get("updated_at"))})
    for rid, old in live.items():
        if rid not in seen:
            out.append({"id": rid, "slug": old.get("slug"), "title": old.get("title"), "date": old.get("date"),
                        "change": "deleted"})
    settings_changed = snap is not None and part["meta_hash"] != meta_hash(_meta(site)) and (
        bool(rows) or bool(part["entries"]))
    return out, settings_changed


def compare_parts(old: dict | None, new: dict | None) -> tuple[list[dict], bool]:
    """Entries added, edited and removed between two snapshot-like versions, and whether the
    changelog's settings differ (only when both sides have a changelog)."""
    o, n = live_part(old), live_part(new)
    before = {e.get("entry_id"): e for e in o["entries"]}
    after = {e.get("entry_id"): e for e in n["entries"]}
    out = []
    for eid, e in after.items():
        b = before.get(eid)
        if b is None:
            out.append({"id": eid, "slug": e.get("slug"), "title": e.get("title"), "date": e.get("date"),
                        "change": "added"})
        elif b.get("hash") != e.get("hash"):
            out.append({"id": eid, "slug": e.get("slug"), "title": e.get("title"), "date": e.get("date"),
                        "change": "edited"})
    for eid, b in before.items():
        if eid not in after:
            out.append({"id": eid, "slug": b.get("slug"), "title": b.get("title"), "date": b.get("date"),
                        "change": "removed"})
    meta = old is not None and new is not None and (o["entries"] or n["entries"]) and o["meta_hash"] != n["meta_hash"]
    return out, bool(meta)


def draft_part(rows: list[dict], site: dict) -> dict:
    """The drafts as a snapshot-like changelog part (Compare against drafts)."""
    meta = _meta(site)
    return {"meta": meta, "meta_hash": meta_hash(meta),
            "entries": [{"entry_id": str(r["_id"]), "slug": r.get("slug"), "title": r.get("title"),
                         "date": r.get("date"), "hash": content_hash(r)} for r in _sorted(rows)]}


async def drafts(db: AsyncIOMotorDatabase, site: dict) -> dict:
    rows = await db[ENTRIES].find({"site_id": site["_id"]}).to_list(length=MAX_ENTRIES + 10)
    return draft_part(rows, site)


async def entry_count(db: AsyncIOMotorDatabase, site_id: ObjectId) -> int:
    return await db[ENTRIES].count_documents({"site_id": site_id})


# ── A page of release notes → entries ────────────────────────────────────────
#
# A guide often has a page of release notes already (a GitBook import brings one across as a
# page): "## March 4, 2026", "## v2.4.0 (2026-03-04)", "### 2026-03-04 · Dark mode". When most
# headings at one level carry a date (in the heading, or on the line under it), each such section
# becomes an entry: its title is the heading without the date, its details the section, its
# summary the first sentence. A section with no date is left out (a date can't be guessed), and a
# page where fewer than two sections have one isn't offered at all.

_MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
                "november", "december"]
_MONTHS = {m: i + 1 for i, m in enumerate(_MONTH_NAMES)}
_MONTHS.update({m[:3]: i + 1 for i, m in enumerate(_MONTH_NAMES)})
_MONTHS["sept"] = 9
_MON = (r"(january|february|march|april|may|june|july|august|september|october|november|december|"
        r"jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\.?")
_DATE_PATTERNS = [
    # 2026-03-04, 2026/03/04, 2026.03.04
    (re.compile(r"\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b"), ("y", "m", "d")),
    # March 4, 2026 · Mar 4th 2026
    (re.compile(rf"\b{_MON}\s+(\d{{1,2}})(?:st|nd|rd|th)?,?\s+(20\d{{2}})\b", re.I), ("mon", "d", "y")),
    # 4 March 2026 · 4th of March, 2026
    (re.compile(rf"\b(\d{{1,2}})(?:st|nd|rd|th)?\s+(?:of\s+)?{_MON},?\s+(20\d{{2}})\b", re.I), ("d", "mon", "y")),
    # March 2026 (a monthly roundup: the 1st)
    (re.compile(rf"\b{_MON},?\s+(20\d{{2}})\b", re.I), ("mon", "y")),
]
_VERSION_IN = re.compile(r"(?<![\w.])v?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?)(?![\w.])")
_CANDIDATE = re.compile(r"^(change ?log|changes|release ?notes?|releases|what'?s new|whats new|product updates|updates|"
                        r"news|version history|release history)$")
_FENCE = re.compile(r"^\s*(```|~~~)")
_HEADING = re.compile(r"^(#{1,4})\s+(.+?)\s*#*\s*$")


def find_date(text: str) -> tuple[str, tuple[int, int]] | None:
    """The first full date in ``text`` as ISO, with where it was; else a month and year (its 1st)."""
    for rx, order in _DATE_PATTERNS:
        for m in rx.finditer(text or ""):
            parts = dict(zip(order, m.groups()))
            try:
                month = _MONTHS[parts["mon"].lower().rstrip(".")] if "mon" in parts else int(parts["m"])
                d = _date(int(parts["y"]), month, int(parts.get("d") or 1))
            except (KeyError, ValueError):
                continue
            return d.isoformat(), m.span()
    return None


def _plain(md: str) -> str:
    s = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", md)
    s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = re.sub(r"[*_`~]+", "", s)
    s = re.sub(r"\{[^}]*\}", "", s)
    return re.sub(r"\s+", " ", s).strip()


def _summary(lines: list[str], title: str) -> str:
    first_item = ""
    for ln in lines:
        t = ln.strip()
        if not t or t.startswith(("#", "|", ":::", "::", "!", ">", "<", "```", "---")):
            continue
        item = re.match(r"^(?:[-*+]|\d+[.)])\s+(.*)$", t)
        if item:
            first_item = first_item or _plain(item.group(1))
            continue
        text = _plain(t)
        if len(text) < 3:
            continue
        sentence = re.split(r"(?<=[.!?])\s", text, maxsplit=1)[0]
        return sentence[:MAX_SUMMARY].rstrip()
    return (first_item or title)[:MAX_SUMMARY].rstrip()


_FIXED = re.compile(r"\b(fix|fixes|fixed|bug|bugs|resolved|patch|hotfix|crash)\b", re.I)
_NEW = re.compile(r"\b(new|introduc\w*|launch\w*|added|adds|now available|announc\w*|meet|beta)\b", re.I)


def _kind(title: str, body: str) -> str:
    for text in (title, body[:600]):
        new, fixed = bool(_NEW.search(text)), bool(_FIXED.search(text))
        if new and not fixed:
            return "new"
        if fixed and not new:
            return "fixed"
    return "improved"


def _title(heading: str, span: tuple[int, int] | None, iso: str) -> str:
    t = heading
    if span:
        t = t[:span[0]] + t[span[1]:]
    t = _plain(t)
    t = re.sub(r"\(\s*\)|\[\s*\]", "", t)
    t = re.sub(r"^[\s\-–—:|·•,/()]+|[\s\-–—:|·•,/(]+$", "", t)
    t = re.sub(r"\s{2,}", " ", t).strip()
    v = _VERSION_IN.fullmatch(t)
    if v:
        return f"Version {v.group(1)}"
    if not t or re.fullmatch(r"(released?|updates?|release notes?)", t, re.I):
        d = _date.fromisoformat(iso)
        return f"Release notes for {d.strftime('%B')} {d.day}, {d.year}"
    return t[:MAX_TITLE]


def parse_release_notes(markdown: str) -> dict:
    """{entries: [{slug, date, title, kind, area, summary, body}], sections, skipped, level} from a
    page's Markdown. ``entries`` is empty when the page doesn't read as dated release notes."""
    from app.services.docs_snapshot import _strip_frontmatter

    body, _fm = _strip_frontmatter(markdown or "")
    lines = body.splitlines()
    heads: list[tuple[int, int, str]] = []  # (line, level, text)
    fence = False
    for i, ln in enumerate(lines):
        if _FENCE.match(ln):
            fence = not fence
            continue
        if fence:
            continue
        m = _HEADING.match(ln)
        if m:
            heads.append((i, len(m.group(1)), _plain(m.group(2))))

    def section(k: int, level: int) -> list[str]:
        start = heads[k][0] + 1
        end = next((h[0] for h in heads[k + 1:] if h[1] <= level), len(lines))
        return lines[start:end]

    def dated(k: int, level: int) -> tuple[str, tuple[int, int] | None, int | None] | None:
        hit = find_date(heads[k][2])
        if hit:
            return hit[0], hit[1], None
        for j, ln in enumerate(section(k, level)[:3]):
            t = ln.strip()
            if not t:
                continue
            hit = find_date(_plain(t))
            if hit and len(_plain(t)) <= 80:
                return hit[0], None, j
            break
        return None

    best: tuple[int, int, int] | None = None  # (dated, total, level)
    for level in (1, 2, 3, 4):
        idx = [k for k, h in enumerate(heads) if h[1] == level]
        if not idx:
            continue
        n = sum(1 for k in idx if dated(k, level))
        if n >= 2 and n >= 0.6 * len(idx) and (best is None or n > best[0]):
            best = (n, len(idx), level)
    if best is None:
        return {"entries": [], "sections": len(heads), "skipped": 0, "level": None}
    level = best[2]
    entries: list[dict] = []
    skipped = 0
    slugs: set[str] = set()
    for k, h in enumerate(heads):
        if h[1] != level:
            continue
        d = dated(k, level)
        if not d:
            skipped += 1
            continue
        iso, span, date_line = d
        sec = section(k, level)
        if date_line is not None:
            sec = sec[:date_line] + sec[date_line + 1:]
        text = "\n".join(sec).strip("\n")
        title = _title(h[2], span, iso)
        slug = slugify(title)
        if slug in slugs or slug == "release":
            slug = slugify(f"{title} {iso}")
        base, n = slug, 2
        while slug in slugs:
            slug, n = f"{base}-{n}", n + 1
        slugs.add(slug)
        entries.append({
            "slug": slug, "date": iso, "title": title, "kind": _kind(title, text), "area": DEFAULT_AREA,
            "summary": _summary(sec, title), "body": text[:MAX_BODY],
        })
    return {"entries": entries, "sections": best[1], "skipped": skipped, "level": level}


def looks_like_changelog(title: str, path: str) -> bool:
    def norm(s: str) -> str:
        return re.sub(r"[\s_-]+", " ", (s or "").strip().lower()).replace("’", "'")

    return bool(_CANDIDATE.match(norm(title))) or bool(_CANDIDATE.match(norm((path or "").rsplit("/", 1)[-1])))


async def candidates(db: AsyncIOMotorDatabase, site: dict) -> list[dict]:
    """Pages that read as dated release notes (a title like Changelog, Release notes or What's new,
    and at least two dated sections): the studio offers to turn them into entries."""
    out = []
    async for p in db[PAGES].find({"site_id": site["_id"], "deleted_at": None},
                                  {"path": 1, "title": 1, "draft.markdown": 1}):
        if not looks_like_changelog(p.get("title") or "", p.get("path") or ""):
            continue
        parsed = parse_release_notes((p.get("draft") or {}).get("markdown") or "")
        es = parsed["entries"]
        if len(es) < 2:
            continue
        out.append({"page_id": str(p["_id"]), "path": p.get("path"), "title": p.get("title"),
                    "entries": len(es), "skipped": parsed["skipped"],
                    "newest": max(e["date"] for e in es), "oldest": min(e["date"] for e in es),
                    "preview": [{"title": e["title"], "date": e["date"], "kind": e["kind"]} for e in es[:5]]})
        if len(out) >= 5:
            break
    return out


async def import_page(db: AsyncIOMotorDatabase, site: dict, user: User, page_id: str) -> dict:
    """Turn a page of release notes into entries (drafts; the page itself stays as it is)."""
    from app.services import docs_site_pages as pages

    page = await pages.load_page(db, site, page_id)
    parsed = parse_release_notes((page.get("draft") or {}).get("markdown") or "")
    es = parsed["entries"]
    if len(es) < 2:
        raise _bad("This page doesn't read as dated release notes: give each release a heading with its date "
                   "(“## March 4, 2026”), then try again.")
    await _check_room(db, site, len(es))
    at = now()
    rows = []
    for e in es:
        slug = await _free_slug(db, site["_id"], e["slug"])
        row = {"site_id": site["_id"], "slug": slug, "date": e["date"], "title": e["title"], "kind": e["kind"],
               "area": e["area"], "products": [], "versions": {}, "summary": e["summary"] or e["title"],
               "body": e["body"], "highlights": [], "media": {}, "try": None, "docs": [], "rev": 1,
               "created_by": user.id, "created_at": at, "updated_by": user.id, "updated_at": at,
               "source": {"page_id": str(page["_id"])}}
        try:
            res = await db[ENTRIES].insert_one(row)
        except DuplicateKeyError:
            continue
        row["_id"] = res.inserted_id
        rows.append(row)
    await store.log_event(db, "docs_changelog_imported", site, user.id, entries=len(rows))
    live, _part, _ever = await _live_map(db, site)
    return {"created": len(rows), "skipped": parsed["skipped"],
            "page": {"id": str(page["_id"]), "path": page.get("path"), "title": page.get("title")},
            "entries": [entry_view(r, live, body=False) for r in _sorted(rows)]}
