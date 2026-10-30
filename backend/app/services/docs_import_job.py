"""Markdrop Docs imports: a GitBook site → the site's pages (drafts), nav, brand, report.

The importer itself (frontend/scripts/docs-import/gitbook.mjs) runs in the job
runner (docs-platform/runner/lib.mjs runImport), which uploads the site's files
to the docs bucket and returns the imported folder as data. This module stores
that data: each page as a draft (and a page version of kind "import"), the nav
by page id, the brand and home settings, redirects, and the importer's report
on the job (the "needs a look" list the import screen shows). Nothing is
published: the site owner reviews, then publishes.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import docs_jobs
from app.services.docs_jobs import PAGES, SITES, VERSIONS, now, oid
from app.services.docs_snapshot import valid_page_path

MAX_PAGES = 1000
MAX_PAGE_CHARS = 500_000
REPORT_ITEMS = 200  # per list, on the job (the full lists can be long)


async def enqueue_import(db: AsyncIOMotorDatabase, site_id: Any, url: str, requested_by: Any, *, kind: str = "gitbook") -> dict:
    """The job for POST /docs-sites (source.kind "gitbook"). The dispatcher routes it."""
    u = urlsplit(url.strip())
    if u.scheme not in ("http", "https") or not u.hostname:
        raise ValueError("the import URL must be an http(s) address")
    return await docs_jobs.insert_job(db, "import", site_id, {"source": {"kind": kind, "url": url.strip()}, "requested_by": str(requested_by) if requested_by else None})


def import_spec(job: dict, *, keep_gifs: bool = False) -> dict:
    src = (job.get("payload") or {}).get("source") or {}
    return {
        "job": {"id": str(job["_id"]), "kind": "import", "site_id": str(job["site_id"]), "attempt": int(job.get("attempts") or 1)},
        "import": {"kind": src.get("kind") or "gitbook", "url": src.get("url"), "site_id": str(job["site_id"]), "keep_gifs": bool(keep_gifs)},
    }


def _s(v: Any, n: int) -> str:
    return str(v or "").strip()[:n]


def _brand_settings(brand: dict | None) -> dict | None:
    """The importer's site.json brand → settings.theme.brand."""
    if not isinstance(brand, dict):
        return None
    logo = brand.get("logo") if isinstance(brand.get("logo"), dict) else {}
    out: dict = {"enabled": True}
    if logo.get("light"):
        out["logo_url"] = logo["light"]
    if logo.get("dark"):
        out["logo_dark_url"] = logo["dark"]
    if logo.get("alt"):
        out["logo_alt"] = logo["alt"]
    if logo.get("wordmark"):
        out["logo_wordmark"] = True
    if logo.get("tile"):
        out["logo_tile"] = True
    if brand.get("favicon"):
        out["favicon_url"] = brand["favicon"]
    if brand.get("accent"):
        out["accent"] = brand["accent"]
        out["colors"] = [brand["accent"]]
    if brand.get("accentDark"):
        out["accent_dark"] = brand["accentDark"]
    if isinstance(brand.get("og"), dict):
        out["og"] = brand["og"]
    return out


def summarize_report(report: dict | None) -> dict:
    """The importer's _import-report.json → the job's "needs a look" summary (lists capped)."""
    if not isinstance(report, dict):
        return {"counts": {}, "items": {}}
    counts = report.get("counts") if isinstance(report.get("counts"), dict) else {}
    items = report.get("items") if isinstance(report.get("items"), dict) else {}
    keep = ("altGenerated", "hidden", "brokenLinks", "missing", "unmatchedIcons", "notes", "external")
    out_items = {k: list(items.get(k) or [])[:REPORT_ITEMS] for k in keep}
    return {
        "source": report.get("source"),
        "counts": {k: v for k, v in counts.items() if isinstance(v, (int, float, bool))},
        "items": out_items,
        "truncated": {k: len(items.get(k) or []) for k in keep if len(items.get(k) or []) > REPORT_ITEMS},
    }


async def apply_import(db: AsyncIOMotorDatabase, job: dict, worker: str | None, data: dict) -> dict:
    """Store an import (the runner's result). Pages are upserted by path: a page already there
    gets the imported content as a new draft revision. Returns the job's stored result."""
    site_id = job["site_id"]
    site = await db[SITES].find_one({"_id": site_id})
    if site is None:
        await docs_jobs.fail(db, job["_id"], worker, "the site no longer exists")
        return {"ok": False}
    by = (job.get("payload") or {}).get("requested_by") or site.get("owner_id")
    pages_in = [p for p in (data.get("pages") or []) if isinstance(p, dict)]
    skipped: list[str] = []
    if len(pages_in) > MAX_PAGES:
        skipped.append(f"{len(pages_in) - MAX_PAGES} pages over the {MAX_PAGES}-page limit were left out")
        pages_in = pages_in[:MAX_PAGES]
    if job.get("locked_by"):
        await docs_jobs.set_progress(db, job["_id"], job["locked_by"], {"step": "save", "done": 0, "total": len(pages_in), "message": "Saving pages"})
    t = now()
    ids_by_path: dict[str, Any] = {}
    created = updated = 0
    for i, p in enumerate(pages_in):
        path = p.get("path")
        if not valid_page_path(path):
            skipped.append(f"{str(path)[:80]}: not a usable page path")
            continue
        markdown = str(p.get("markdown") or "")
        if len(markdown) > MAX_PAGE_CHARS:
            skipped.append(f"{path}: longer than {MAX_PAGE_CHARS} characters, cut")
            markdown = markdown[:MAX_PAGE_CHARS]
        title = _s(p.get("title"), 300) or path
        description = _s(p.get("description"), 500)
        icon = _s(p.get("icon"), 60) or None
        extra = p.get("frontmatter_extra") if isinstance(p.get("frontmatter_extra"), dict) else {}
        hidden = bool(p.get("hidden"))
        cur = await db[PAGES].find_one({"site_id": site_id, "path": path, "deleted_at": None})
        rev = int(((cur or {}).get("draft") or {}).get("rev") or 0) + 1
        draft = {"markdown": markdown, "frontmatter_extra": extra or None, "rev": rev, "updated_by": str(by) if by else None, "updated_at": t}
        if cur:
            await db[PAGES].update_one({"_id": cur["_id"]}, {"$set": {
                "title": title, "description": description, "icon": icon, "hidden": hidden, "draft": draft,
            }})
            pid = cur["_id"]
            updated += 1
        else:
            pid = (await db[PAGES].insert_one({
                "site_id": site_id, "path": path, "title": title, "description": description, "icon": icon,
                "hidden": hidden, "draft": draft, "published": None, "lock": None, "created_at": t, "deleted_at": None,
            })).inserted_id
            created += 1
        ids_by_path[path] = pid
        await db[VERSIONS].insert_one({
            "page_id": pid, "site_id": site_id, "rev": rev, "markdown": markdown, "title": title,
            "description": description, "by": str(by) if by else None, "at": t, "kind": "import",
        })
        if job.get("locked_by") and (i + 1) % 25 == 0:
            await docs_jobs.set_progress(db, job["_id"], job["locked_by"], {"step": "save", "done": i + 1, "total": len(pages_in), "message": "Saving pages"})

    nav = []
    for g in data.get("nav") or []:
        ids = [str(ids_by_path[p]) for p in (g.get("pages") or []) if p in ids_by_path]
        if not ids:
            continue
        group: dict = {"group": _s(g.get("group"), 120) or "Pages", "pages": ids}
        for k in ("icon", "tab"):
            if g.get(k):
                group[k] = _s(g[k], 60)
        nav.append(group)

    imported = data.get("site") or {}
    upd: dict = {"settings.nav": nav, "updated_at": t}
    brand = _brand_settings(imported.get("brand"))
    if brand:
        upd["settings.theme.brand"] = brand
    for key in ("description", "eyebrow", "headline"):
        if imported.get(key):
            upd[f"settings.{key}"] = _s(imported[key], 500)
    for key in ("home", "pages", "footer"):
        if isinstance(imported.get(key), (dict, list)) and imported[key]:
            upd[f"settings.{key}"] = imported[key]
    if imported.get("tabs"):
        upd["settings.tabs"] = imported["tabs"]
    if imported.get("embed_hosts"):
        upd["settings.embed_hosts"] = imported["embed_hosts"]
    if isinstance(data.get("redirects"), dict) and data["redirects"]:
        upd["settings.redirects"] = {str(k)[:300]: str(v)[:500] for k, v in list(data["redirects"].items())[:2000]}
    if isinstance(data.get("videos"), dict) and data["videos"]:
        upd["settings.videos"] = data["videos"]
    await db[SITES].update_one({"_id": site_id}, {"$set": upd})

    report = summarize_report(data.get("report"))
    assets = data.get("assets") if isinstance(data.get("assets"), dict) else {}
    result = {
        "ok": True,
        "pages": {"created": created, "updated": updated, "total": len(ids_by_path),
                  "hidden": sum(1 for p in pages_in if p.get("hidden"))},
        "nav_groups": len(nav),
        "assets": {k: int(v) for k, v in assets.items() if isinstance(v, (int, float))},
        "report": report,
        "skipped": skipped[:100],
    }
    await docs_jobs.complete(db, job["_id"], worker, result)
    await docs_jobs.emit(db, "docs_site_imported", site_id, by, source=(job.get("payload") or {}).get("source", {}).get("url"),
                         pages=len(ids_by_path))
    return result
