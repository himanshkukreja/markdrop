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

import mimetypes
from typing import Any

from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError

from app.config import get_settings
from app.services import docs_jobs
from app.services.docs_jobs import ASSETS, PAGES, SITES, VERSIONS, now
from app.services.docs_snapshot import valid_page_path

REPORT_ITEMS = 200  # per list, on the job (the full lists can be long)


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
    if brand.get("favicon"):
        x["favicon_url"] = brand["favicon"]
    if isinstance(brand.get("og"), dict):
        x["og"] = brand["og"]
    return b, x


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


async def _asset_rows(db: AsyncIOMotorDatabase, site_id: Any, by: str | None, assets: dict) -> int:
    """A docs_assets row per uploaded file (the quota counts them). Identical bytes at two paths
    are one row (the index is unique on site + sha256)."""
    n = 0
    for it in (assets.get("items") or [])[:20000]:
        rel, sha, size = it.get("rel"), it.get("sha256"), it.get("size")
        if not isinstance(rel, str) or not isinstance(sha, str) or len(sha) != 64 or not isinstance(size, int):
            continue
        try:
            await db[ASSETS].insert_one({
                "site_id": site_id, "sha256": sha, "ext": rel.rsplit(".", 1)[-1].lower() if "." in rel else "",
                "name": rel, "key": f"sites/{site_id}/assets/{rel}", "url": f"/docs-assets/{rel}", "size": size,
                "content_type": it.get("content_type") or mimetypes.guess_type(rel)[0] or "application/octet-stream",
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
    for g in data.get("nav") or []:
        ids = [str(ids_by_path[p]) for p in (g.get("pages") or []) if p in ids_by_path][:1000]
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

    imported = data.get("site") or {}
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
    extra: dict = {"source": "gitbook"}
    for key in ("description", "eyebrow", "headline"):
        if imported.get(key):
            extra[key] = _s(imported[key], 500)
    for key in ("home", "pages", "footer", "tabs", "embed_hosts"):
        if imported.get(key):
            extra[key] = imported[key]
    if brand_extra:
        extra["brand"] = brand_extra
    if nav_meta:
        extra["nav"] = nav_meta
    if isinstance(data.get("redirects"), dict) and data["redirects"]:
        extra["redirects"] = {str(k)[:300]: str(v)[:500] for k, v in list(data["redirects"].items())[:2000]}
    if isinstance(data.get("videos"), dict) and data["videos"]:
        extra["videos"] = data["videos"]
    await db[SITES].update_one({"_id": site_id}, {"$set": {"settings": settings, "engine_extra": extra, "updated_at": t}})

    assets = data.get("assets") if isinstance(data.get("assets"), dict) else {}
    asset_rows = await _asset_rows(db, site_id, by, assets)
    report = summarize_report(data.get("report"))
    result = {
        "ok": True,
        "pages": {"created": created, "updated": updated, "total": len(ids_by_path),
                  "hidden": sum(1 for p in pages_in if p.get("hidden") and p.get("path") in ids_by_path)},
        "nav_groups": len(nav),
        "assets": {**{k: int(v) for k, v in assets.items() if isinstance(v, (int, float)) and not isinstance(v, bool)}, "rows": asset_rows},
        "report": report,
        "skipped": skipped[:100],
    }
    await docs_jobs.complete(db, job["_id"], worker, result)
    await docs_jobs.log_event(db, "docs_import_finished", site_id, by, source=source_of(job).get("url"),
                              pages=len(ids_by_path), assets=assets.get("files"))
    return result
