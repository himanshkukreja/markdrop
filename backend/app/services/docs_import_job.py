"""Markdrop Docs imports: a GitBook site → the site's pages (drafts), nav, brand, report.

The API queues the job when a site is created from GitBook
(docs_site_store.create_site: payload ``{source: "gitbook", url}``). The
importer itself (frontend/scripts/docs-import/gitbook.mjs) runs in the job
runner (docs-platform/runner/lib.mjs runImport), which uploads the site's files
to the docs bucket and returns the imported folder as data. This module stores
it: each page as a draft (rev 1, a page version of kind "import"; a page that is
already there gets a new revision), the nav by page id, the brand, a
``docs_assets`` row per uploaded file (the 2 GB quota counts them), and the
importer's report on the job (the "needs a look" list the import screen shows).

``settings`` gets only what the API's settings model knows (nav groups, theme
brand); the rest of what the importer read (description, hero, home cards, page
options, footer, tabs, redirects, extra brand fields, group icons) goes to the
site's ``engine_extra``, which the snapshot writer reads (services/docs_snapshot.py).
Nothing is published: the owner reviews, then publishes.
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlsplit

from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError

from app.config import get_settings
from app.services import docs_jobs
from app.services.docs_jobs import ASSETS, PAGES, SITES, VERSIONS, now
from app.services.docs_site_assets import rel_of
from app.services.docs_snapshot import valid_page_path

REPORT_ITEMS = 200  # per list, on the job (the full lists can be long)

# What an import may leave in the site's /docs-assets/: images, PDFs and video, by extension (the
# docs host serves a file with its extension's type). Never a type a browser renders as a page or
# runs (HTML, XHTML, XML, SVG, JavaScript): the docs host is the site's own origin. SVG is left
# out because an import's files never pass the upload path's SVG check (docs_site_assets.sniff).
# The runner applies the same list before uploading (docs-platform/runner/lib.mjs), and the
# importer before downloading (frontend/scripts/docs-import/lib/guard.mjs).
IMPORT_ASSET_TYPES = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
    "avif": "image/avif",
    "ico": "image/x-icon",
    "pdf": "application/pdf",
    "mp4": "video/mp4",
    "webm": "video/webm",
}
IMPORT_ASSET_DIR = "import"  # the runner's IMPORT_ASSET_ID: every imported file is under /docs-assets/import/
MAX_ASSET_BYTES = 2 * 1024 ** 3

# Hosts an imported ::embed may frame (site.json embedHosts; any other embed shows as a link card).
EMBED_HOSTS = frozenset({
    "www.youtube.com", "youtube.com", "www.youtube-nocookie.com", "player.vimeo.com", "www.loom.com", "loom.com",
    "www.figma.com", "figma.com", "embed.figma.com", "codepen.io", "codesandbox.io", "stackblitz.com",
    "app.arcade.software", "demo.arcade.software", "docs.google.com", "miro.com", "fast.wistia.net",
    "share.descript.com", "www.tella.tv", "app.supademo.com", "capture.navattic.com", "jsfiddle.net",
})


def import_asset_type(rel: Any) -> str | None:
    """The content type an imported file at ``/docs-assets/<rel>`` is served with, or None when an
    import may not leave it there (not under import/, an unsafe path, or a type off the list)."""
    if not isinstance(rel, str) or rel_of("/docs-assets/" + rel) != rel or not rel.startswith(IMPORT_ASSET_DIR + "/"):
        return None
    ext = rel.rsplit(".", 1)[-1].lower() if "." in rel.rsplit("/", 1)[-1] else ""
    return IMPORT_ASSET_TYPES.get(ext)


def source_of(job: dict) -> dict:
    """{kind, url} from either payload shape: {source: "gitbook", url} or {source: {kind, url}}."""
    p = job.get("payload") or {}
    src = p.get("source")
    if isinstance(src, dict):
        return {"kind": src.get("kind") or "gitbook", "url": src.get("url") or p.get("url")}
    return {"kind": src or "gitbook", "url": p.get("url")}


def import_spec(job: dict, *, keep_gifs: bool = False) -> dict:
    src = source_of(job)
    return {
        "job": {"id": str(job["_id"]), "kind": "import", "site_id": str(job["site_id"]), "attempt": int(job.get("attempts") or 1)},
        "import": {"kind": src["kind"], "url": src["url"], "site_id": str(job["site_id"]), "keep_gifs": bool(keep_gifs)},
    }


def _s(v: Any, n: int) -> str:
    return str(v or "").strip()[:n]


def _brand(brand: dict | None) -> tuple[dict | None, dict]:
    """The importer's site.json brand → (settings.theme.brand, engine_extra.brand)."""
    if not isinstance(brand, dict):
        return None, {}
    logo = brand.get("logo") if isinstance(brand.get("logo"), dict) else {}
    b: dict = {"enabled": True}
    x: dict = {}
    if logo.get("light"):
        b["logo_url"] = logo["light"]
    if logo.get("dark"):
        b["logo_dark_url"] = logo["dark"]
    if brand.get("accent"):
        b["accent"] = brand["accent"]
        b["colors"] = [brand["accent"]]
    if brand.get("accentDark"):
        b["accent_dark"] = brand["accentDark"]
    if logo.get("alt"):
        x["logo_alt"] = _s(logo["alt"], 120)
    if logo.get("wordmark"):
        x["logo_wordmark"] = True
    if logo.get("tile"):
        x["logo_tile"] = True
    if _asset_or_https(brand.get("favicon")):
        x["favicon_url"] = brand["favicon"]
    og = _og(brand.get("og"))
    if og:
        x["og"] = og
    return b, x


# ── What an import puts in engine_extra (the importer's site.json, read from a third-party site) ──
# Every value is checked against the shape the engine reads (frontend/src/docs/types.ts) and
# bounded; anything else is dropped.

_CTRL = re.compile(r"[\x00-\x1f\x7f]")
_HEX = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
_ICON = re.compile(r"^[a-z0-9][a-z0-9-]{0,59}$")
_KEY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$")


def _text(v: Any, n: int) -> str | None:
    """A one-line string of at most ``n`` characters (no control characters), else None."""
    return v.strip() if isinstance(v, str) and v.strip() and len(v) <= n and not _CTRL.search(v) else None


def site_path(v: Any, n: int = 500) -> bool:
    """A path on the docs site: "/x", never "//host", a backslash, whitespace or a control character."""
    return isinstance(v, str) and 0 < len(v) <= n and v.startswith("/") and not v.startswith("//") \
        and "\\" not in v and not re.search(r"[\s\x00-\x1f\x7f]", v)


def https_url(v: Any, n: int = 2048) -> bool:
    """An https:// address with a host (no credentials, backslash, whitespace or control characters)."""
    if not isinstance(v, str) or len(v) > n or not v.lower().startswith("https://") \
            or "\\" in v or re.search(r"[\s\x00-\x1f\x7f]", v):
        return False
    try:
        parts = urlsplit(v)
        parts.port  # noqa: B018 (raises on a bad port)
    except ValueError:
        return False
    return bool(parts.hostname) and "@" not in parts.netloc


def _link(v: Any) -> bool:
    return site_path(v) or https_url(v)


def _asset_or_https(v: Any) -> bool:
    """An imported file (/docs-assets/<safe rel>) or an https:// address."""
    return (isinstance(v, str) and rel_of(v) is not None) or https_url(v)


def _og(v: Any) -> dict:
    if not isinstance(v, dict):
        return {}
    out: dict = {k: v[k] for k in ("background", "accent") if isinstance(v.get(k), str) and _HEX.match(v[k])}
    if v.get("mark") in ("markdrop", "none"):
        out["mark"] = v["mark"]
    return out


def _links(v: Any, n: int) -> list[dict]:
    out = []
    for it in (v if isinstance(v, list) else [])[:n]:
        if isinstance(it, dict) and _text(it.get("label"), 80) and _link(it.get("href")):
            out.append({"label": _text(it["label"], 80), "href": it["href"]})
    return out


def _tabs(v: Any) -> list[dict]:
    out = []
    for it in (v if isinstance(v, list) else [])[:20]:
        if isinstance(it, dict) and isinstance(it.get("id"), str) and _ICON.match(it["id"]) \
                and _text(it.get("label"), 80) and _link(it.get("href")):
            out.append({"id": it["id"], "label": _text(it["label"], 80), "href": it["href"]})
    return out


def _home(v: Any) -> dict:
    if not isinstance(v, dict):
        return {}
    out: dict = {}
    start = []
    for it in (v.get("start") if isinstance(v.get("start"), list) else [])[:24]:
        if not isinstance(it, dict) or not site_path(it.get("page"), 300):
            continue
        card: dict = {"page": it["page"]}
        if isinstance(it.get("icon"), str) and _ICON.match(it["icon"]):
            card["icon"] = it["icon"]
        for k, n in (("title", 200), ("description", 500), ("time", 20)):
            if _text(it.get(k), n):
                card[k] = _text(it[k], n)
        start.append(card)
    if start:
        out["start"] = start
    if _text(v.get("askPlaceholder"), 200):
        out["askPlaceholder"] = _text(v["askPlaceholder"], 200)
    for k, n, size in (("chips", 5, 200), ("areas", 12, 80)):
        items = [_text(s, size) for s in (v.get(k) if isinstance(v.get(k), list) else [])[:n]]
        if any(items):
            out[k] = [s for s in items if s]
    return out


def _pages_options(v: Any) -> dict:
    if not isinstance(v, dict):
        return {}
    return {k: v[k] for k in ("showDescription", "icons") if isinstance(v.get(k), bool)}


def _embed_hosts(v: Any) -> list[str]:
    hosts = [h.lower() for h in (v if isinstance(v, list) else [])[:200] if isinstance(h, str)]
    return sorted({h for h in hosts if h in EMBED_HOSTS})


def _videos(v: Any) -> dict:
    out: dict = {}
    for key, ref in (list(v.items()) if isinstance(v, dict) else [])[:500]:
        if not isinstance(key, str) or not _KEY.match(key) or not isinstance(ref, dict):
            continue
        r: dict = {}
        for k in ("url", "markdrop"):
            if https_url(ref.get(k)):
                r[k] = ref[k]
        for k in ("src", "poster", "chapters", "captions"):
            if isinstance(ref.get(k), str) and rel_of(ref[k]) is not None:
                r[k] = ref[k]
        for k, n in (("title", 200), ("duration", 20)):
            if _text(ref.get(k), n):
                r[k] = _text(ref[k], n)
        if r.get("url") or r.get("markdrop") or r.get("src"):
            out[key] = r
    return out


def _redirects(v: Any) -> dict:
    """{from: to}: ``from`` a plain site path; ``to`` a site path (an optional #anchor) or an https URL."""
    out: dict = {}
    for frm, to in (list(v.items()) if isinstance(v, dict) else [])[:2000]:
        if site_path(frm, 300) and not re.search(r"[?#]", frm) and (site_path(to) or https_url(to, 500)):
            out[frm] = to
    return out


def engine_extra_from(imported: dict, data: dict) -> dict:
    """The parts of an import's site.json (and redirects.json, videos.json) the engine reads,
    each checked and bounded (above). ``brand`` and ``nav`` are added by the caller."""
    extra: dict = {"source": "gitbook"}
    for key in ("description", "eyebrow", "headline"):
        if imported.get(key):
            extra[key] = _s(imported[key], 500)
    for key, value in (("home", _home(imported.get("home"))), ("pages", _pages_options(imported.get("pages"))),
                       ("footer", _links(imported.get("footer"), 20)), ("tabs", _tabs(imported.get("tabs"))),
                       ("embed_hosts", _embed_hosts(imported.get("embed_hosts"))),
                       ("redirects", _redirects(data.get("redirects"))), ("videos", _videos(data.get("videos")))):
        if value:
            extra[key] = value
    return extra


def summarize_report(report: dict | None) -> dict:
    """The importer's _import-report.json → the job's "needs a look" summary (lists capped)."""
    if not isinstance(report, dict):
        return {"counts": {}, "items": {}}
    counts = report.get("counts") if isinstance(report.get("counts"), dict) else {}
    items = report.get("items") if isinstance(report.get("items"), dict) else {}
    keep = ("altGenerated", "hidden", "brokenLinks", "missing", "unmatchedIcons", "notes", "external")
    return {
        "source": report.get("source"),
        "counts": {k: v for k, v in counts.items() if isinstance(v, (int, float, bool))},
        "items": {k: list(items.get(k) or [])[:REPORT_ITEMS] for k in keep},
        "truncated": {k: len(items.get(k) or []) for k in keep if len(items.get(k) or []) > REPORT_ITEMS},
    }


_SHA256 = re.compile(r"^[0-9a-f]{64}$")


async def _asset_rows(db: AsyncIOMotorDatabase, site_id: Any, by: str | None, assets: dict) -> int:
    """A docs_assets row per uploaded file (the quota counts them). Identical bytes at two paths
    are one row (the index is unique on site + sha256). A row only for a file an import may leave
    (:func:`import_asset_type`), with its size; the content type is the extension's, never the
    runner's word for it."""
    n = 0
    items = assets.get("items") if isinstance(assets.get("items"), list) else []
    for it in items[:20000]:
        if not isinstance(it, dict):
            continue
        rel, sha, size = it.get("rel"), it.get("sha256"), it.get("size")
        ctype = import_asset_type(rel)
        if ctype is None or not isinstance(sha, str) or not _SHA256.match(sha) \
                or not isinstance(size, int) or isinstance(size, bool) or not 0 <= size <= MAX_ASSET_BYTES:
            continue
        try:
            await db[ASSETS].insert_one({
                "site_id": site_id, "sha256": sha, "ext": rel.rsplit(".", 1)[-1].lower(),
                "name": rel, "key": f"sites/{site_id}/assets/{rel}", "url": f"/docs-assets/{rel}", "size": size,
                "content_type": ctype,
                "original_name": None, "by": by, "source": "import", "created_at": now(),
            })
            n += 1
        except DuplicateKeyError:
            pass
    return n


async def apply_import(db: AsyncIOMotorDatabase, job: dict, worker: str | None, data: dict) -> dict:
    """Store an import (the runner's result). Returns the job's stored result."""
    from app.services import docs_site_settings as site_settings
    from app.services import docs_site_store as store

    cfg = get_settings()
    site_id = job["site_id"]
    site = await db[SITES].find_one({"_id": site_id, "deleted_at": None})
    if site is None:
        await docs_jobs.fail(db, job["_id"], worker, "the site no longer exists")
        return {"ok": False}
    by = (job.get("payload") or {}).get("requested_by") or site.get("owner_id")
    pages_in = [p for p in (data.get("pages") or []) if isinstance(p, dict)]
    skipped: list[str] = []
    room = cfg.docs_pages_per_site - await db[PAGES].count_documents({"site_id": site_id, "deleted_at": None})
    if worker:
        await docs_jobs.set_progress(db, job["_id"], worker, {"step": "save", "done": 0, "total": len(pages_in), "message": "Saving pages"})
    t = now()
    ids_by_path: dict[str, Any] = {}
    created = updated = 0
    for i, p in enumerate(pages_in):
        path = p.get("path")
        if not valid_page_path(path):
            skipped.append(f"{str(path)[:80]}: not a usable page path")
            continue
        markdown = str(p.get("markdown") or "")
        if len(markdown) > cfg.docs_page_max_chars:
            skipped.append(f"{path}: longer than {cfg.docs_page_max_chars} characters, cut")
            markdown = markdown[:cfg.docs_page_max_chars]
        fields = {
            "title": _s(p.get("title"), 200) or path,
            "description": _s(p.get("description"), 500),
            "icon": _s(p.get("icon"), 60) or None,
            "hidden": bool(p.get("hidden")),
        }
        extra = p.get("frontmatter_extra") if isinstance(p.get("frontmatter_extra"), dict) else {}
        cur = await db[PAGES].find_one({"site_id": site_id, "path": path, "deleted_at": None})
        if cur:
            rev = int((cur.get("draft") or {}).get("rev") or 0) + 1
            draft = {"markdown": markdown, "frontmatter_extra": extra, "rev": rev, "updated_by": by, "updated_at": t}
            await db[PAGES].update_one({"_id": cur["_id"]}, {"$set": {**fields, "draft": draft}})
            row = {**cur, **fields, "draft": draft}
            updated += 1
        else:
            if room <= 0:
                skipped.append(f"{path}: over the {cfg.docs_pages_per_site}-page limit")
                continue
            row = {"site_id": site_id, "path": path, **fields,
                   "draft": {"markdown": markdown, "frontmatter_extra": extra, "rev": 1, "updated_by": by, "updated_at": t},
                   "published": None, "lock": None, "created_at": t, "deleted_at": None}
            try:
                row["_id"] = (await db[PAGES].insert_one(row)).inserted_id
            except DuplicateKeyError:
                skipped.append(f"{path}: a page with this path appeared meanwhile")
                continue
            room -= 1
            created += 1
        ids_by_path[path] = row["_id"]
        try:
            await db[VERSIONS].insert_one(store.version_row(row, by=by, at=t, kind="import"))
        except DuplicateKeyError:
            pass
        if worker and (i + 1) % 25 == 0:
            await docs_jobs.set_progress(db, job["_id"], worker, {"step": "save", "done": i + 1, "total": len(pages_in), "message": "Saving pages"})

    # The nav (page ids). The home leads the first group, as the editor's page tree shows it.
    nav: list[dict] = []
    nav_meta: dict = {}
    for g in data.get("nav") if isinstance(data.get("nav"), list) else []:
        if not isinstance(g, dict) or not isinstance(g.get("pages"), list):
            continue
        ids = [str(ids_by_path[p]) for p in g["pages"] if isinstance(p, str) and p in ids_by_path][:1000]
        if not ids or len(nav) >= 100:
            continue
        name = _s(g.get("group"), 80) or "Pages"
        nav.append({"group": name, "pages": ids})
        meta = {k: _s(g[k], 60) for k in ("icon", "tab") if g.get(k)}
        if meta:
            nav_meta[name] = meta
    if "/" in ids_by_path:
        if nav:
            nav[0]["pages"].insert(0, str(ids_by_path["/"]))
        else:
            nav = [{"group": "Getting started", "pages": [str(ids_by_path["/"])]}]

    imported = data.get("site") if isinstance(data.get("site"), dict) else {}
    brand, brand_extra = _brand(imported.get("brand"))
    settings = dict(site.get("settings") or site_settings.default_settings())
    settings["nav"] = nav
    if brand:
        theme = dict(settings.get("theme") or {})
        theme["brand"] = {**(theme.get("brand") or {}), **brand}
        settings["theme"] = theme
    try:
        settings = site_settings.validate(settings)
    except site_settings.SettingsError:
        # An imported colour or logo the model refuses: keep the pages and nav, drop the brand.
        settings["theme"] = (site.get("settings") or {}).get("theme") or site_settings.default_settings()["theme"]
        settings = site_settings.validate(settings)
        brand_extra = {}
        skipped.append("the imported brand (logo or colour) couldn't be used")
    extra = engine_extra_from(imported, data)
    if brand_extra:
        extra["brand"] = brand_extra
    if nav_meta:
        extra["nav"] = nav_meta
    await db[SITES].update_one({"_id": site_id}, {"$set": {"settings": settings, "engine_extra": extra, "updated_at": t}})

    assets = data.get("assets") if isinstance(data.get("assets"), dict) else {}
    asset_rows = await _asset_rows(db, site_id, by, assets)
    report = summarize_report(data.get("report"))
    result = {
        "ok": True,
        "pages": {"created": created, "updated": updated, "total": len(ids_by_path),
                  "hidden": sum(1 for p in pages_in if p.get("hidden") and isinstance(p.get("path"), str) and p["path"] in ids_by_path)},
        "nav_groups": len(nav),
        "assets": {**{k: v for k, v in assets.items() if isinstance(k, str) and isinstance(v, int) and not isinstance(v, bool)}, "rows": asset_rows},
        "report": report,
        "skipped": skipped[:100],
    }
    await docs_jobs.complete(db, job["_id"], worker, result)
    # Usage counts only: the kind of source, never its address (the site row keeps that).
    await docs_jobs.log_event(db, "docs_import_finished", site_id, by, source=source_of(job).get("kind"),
                              pages=len(ids_by_path), assets=assets.get("files"),
                              took=docs_jobs.duration_bucket(job.get("created_at"), t))
    return result
