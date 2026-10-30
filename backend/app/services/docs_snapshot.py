"""A docs snapshot → the engine's content folder, as data.

A snapshot (``docs_snapshots``) is the exact content one build uses: every
page's draft at publish time plus the site settings. The engine reads a
content folder (frontend/content/docs is site #1): ``site.json``, one Markdown
file per page with frontmatter, ``index.md`` for the home, ``redirects.json``.
This module writes that folder as a map of relative path → text, the
``bundle`` a runner writes to disk (docs-platform/runner/lib.mjs writeContent)
before it builds. One implementation for every runner: the Python worker and
GitHub Actions get the same bundle.

A site's own files (images, clips, downloads) are not in the bundle: they live
in the docs R2 bucket under ``sites/<site>/assets/<rel>`` and pages refer to
them as ``/docs-assets/<site>/<rel>``; the runner fetches the ones referred to.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.services.docs_jobs import PAGES, SITES, SNAPSHOTS, get_jobs_settings, oid

# A page path: "/" or "/seg/seg" with lowercase letters, digits, - and _ (no
# leading _ or . — the engine skips those), at most 8 levels.
PATH_RE = re.compile(r"^/(?:[a-z0-9][a-z0-9_-]{0,79})(?:/[a-z0-9][a-z0-9_-]{0,79}){0,7}$")
# First segments the engine or the edge already answers.
RESERVED_FIRST = {"public", "docs-assets", "_next", "og", "md", "mcp", "changelog", "api-reference", "node_modules", "video-scenes"}
# Frontmatter keys the snapshot fields own (frontmatter_extra can't override them).
OWN_KEYS = {"title", "description", "icon", "updated"}


def valid_page_path(p: Any) -> bool:
    if p == "/":
        return True
    return isinstance(p, str) and bool(PATH_RE.match(p)) and p.split("/")[1] not in RESERVED_FIRST


def page_file(p: str) -> str:
    return "index.md" if p == "/" else p[1:] + ".md"


def _yaml(v: Any) -> str:
    """JSON is YAML: strings, numbers, lists and maps written this way always parse back."""
    return json.dumps(v, ensure_ascii=False)


def _strip_frontmatter(md: str) -> tuple[str, dict]:
    """A body that still starts with a --- block (pasted in): drop it, keep simple key: value pairs."""
    m = re.match(r"^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)", md)
    if not m:
        return md, {}
    extra: dict = {}
    for line in m.group(1).splitlines():
        kv = re.match(r"^([A-Za-z_][\w-]*):\s*(.+)$", line)
        if kv:
            extra[kv.group(1)] = kv.group(2).strip().strip('"').strip("'")
    return md[m.end():].lstrip("\n"), extra


def page_text(page: dict, updated: str) -> str:
    body, pasted = _strip_frontmatter(str(page.get("markdown") or ""))
    title = str(page.get("title") or "").strip() or "Untitled"
    description = str(page.get("description") or "").strip() or title
    lines = ["---", f"title: {_yaml(title)}", f"description: {_yaml(description[:300])}", f"updated: {updated}"]
    if page.get("icon"):
        lines.append(f"icon: {_yaml(str(page['icon']))}")
    extra = {**{k: v for k, v in pasted.items() if k in ("nav", "keywords", "since")},
             **(page.get("frontmatter_extra") or {})}
    for k, v in extra.items():
        if k in OWN_KEYS or not re.match(r"^[A-Za-z_][\w-]*$", str(k)) or v is None:
            continue
        lines.append(f"{k}: {_yaml(v)}")
    lines += ["---", ""]
    return "\n".join(lines) + body.rstrip() + "\n"


def site_host(site: dict) -> str:
    return get_jobs_settings().docs_site_host_template.format(slug=site.get("slug") or str(site["_id"]), id=str(site["_id"]))


def site_hosts(site: dict) -> list[str]:
    """The free address plus every verified own domain."""
    hosts = [site_host(site)]
    for d in site.get("domains") or []:
        host = str((d or {}).get("host") or "").strip().lower()
        if host and (d or {}).get("status") in ("active", "verified", "live") and host not in hosts:
            hosts.append(host)
    return hosts


def site_url(site: dict) -> str:
    hosts = site_hosts(site)
    return "https://" + (hosts[1] if len(hosts) > 1 else hosts[0])


def _brand(site: dict, settings: dict) -> dict:
    theme = settings.get("theme") or {}
    b = theme.get("brand") or {}
    out: dict = {"name": site.get("name") or "Docs", "label": "Docs"}
    has_any = any(b.get(k) for k in ("logo_url", "accent", "colors", "favicon_url"))
    if b.get("enabled") is False or (b.get("enabled") is None and not has_any):
        return out
    if b.get("logo_url"):
        logo: dict = {"light": b["logo_url"], "alt": b.get("logo_alt") or out["name"]}
        if b.get("logo_dark_url"):
            logo["dark"] = b["logo_dark_url"]
        if b.get("logo_wordmark"):
            logo["wordmark"] = True
        if b.get("logo_tile"):
            logo["tile"] = True
        out["logo"] = logo
    if b.get("favicon_url") or b.get("logo_url"):
        out["favicon"] = b.get("favicon_url") or b["logo_url"]
    colors = [c for c in (b.get("colors") or []) if isinstance(c, str)]
    accent = b.get("accent") or (colors[0] if colors else None)
    if accent:
        out["accent"] = accent
    if b.get("accent_dark"):
        out["accentDark"] = b["accent_dark"]
    if colors:
        out["colors"] = colors
    if isinstance(b.get("og"), dict):
        out["og"] = b["og"]
    return out


def _theme(settings: dict) -> dict:
    t = settings.get("theme") or {}
    out: dict = {"preset": t.get("preset") or "clean"}
    for k in ("fonts", "mode", "corners"):
        if t.get(k):
            out[k] = t[k]
    if t.get("custom_css"):
        out["customCss"] = t["custom_css"]
    return out


def site_json(site: dict, settings: dict, nav: list[dict], *, url: str, ai_api: str) -> dict:
    sid = str(site["_id"])
    name = site.get("name") or "Docs"
    home = dict(settings.get("home") or {})
    ai = settings.get("ai") or {}
    suggestions = [s for s in (ai.get("suggestions") or []) if isinstance(s, str) and s.strip()][:5]
    if suggestions and not home.get("chips"):
        home["chips"] = suggestions
    out: dict = {
        "id": sid,
        "name": name,
        "description": settings.get("description") or f"Documentation for {name}.",
        "url": url,
    }
    for k in ("eyebrow", "headline"):
        if settings.get(k):
            out[k] = settings[k]
    out["tabs"] = settings.get("tabs") or []
    if home:
        out["home"] = home
    out["nav"] = nav
    out["pages"] = settings.get("pages") or {}
    out["footer"] = settings.get("footer") or [{"label": "llms.txt", "href": "/llms.txt"}]
    if settings.get("embed_hosts"):
        out["embedHosts"] = settings["embed_hosts"]
    out["brand"] = _brand(site, settings)
    out["theme"] = _theme(settings)
    out["ai"] = (
        {"enabled": True, "api": ai_api, "site": sid, "assistantName": ai.get("name") or "Ask AI"}
        if ai.get("enabled") else {"enabled": False}
    )
    out["seo"] = {"index": bool((settings.get("seo") or {}).get("index", True))}
    out["integrations"] = {"markdropApp": False}
    return out


def build_nav(settings: dict, pages: list[dict]) -> list[dict]:
    """settings.nav ({group, pages: [page id | path]}) → the engine's nav by path. Hidden and
    unknown pages are left out; visible pages no group lists go into a last "More" group."""
    by_id = {str(p["id"]): p for p in pages if p.get("id")}
    by_path = {p["path"]: p for p in pages}
    listed: set[str] = set()
    out: list[dict] = []
    for g in settings.get("nav") or []:
        paths: list[str] = []
        for ref in g.get("pages") or []:
            p = by_path.get(ref) if isinstance(ref, str) and ref.startswith("/") else by_id.get(str(ref))
            if not p or p.get("hidden") or p["path"] == "/" or p["path"] in listed:
                continue
            listed.add(p["path"])
            paths.append(p["path"])
        if not paths:
            continue
        group: dict = {"group": str(g.get("group") or "Pages")}
        for k in ("icon", "tab"):
            if g.get(k):
                group[k] = g[k]
        if g.get("new"):
            group["new"] = True
        group["pages"] = paths
        out.append(group)
    rest = [p["path"] for p in pages if p["path"] != "/" and not p.get("hidden") and p["path"] not in listed]
    if rest:
        out.append({"group": "More", "pages": rest})
    return out


def _date(v: Any) -> str | None:
    if isinstance(v, datetime):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, str) and re.match(r"^\d{4}-\d{2}-\d{2}", v):
        return v[:10]
    return None


def content_files(site: dict, snapshot: dict, *, url: str, ai_api: str) -> tuple[dict[str, str], list[str]]:
    """The content folder for ``snapshot`` as {relative path: text}, plus warnings (pages skipped)."""
    settings = snapshot.get("settings") or site.get("settings") or {}
    default_updated = _date(snapshot.get("created_at")) or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    warnings: list[str] = []
    pages: list[dict] = []
    seen: set[str] = set()
    for p in snapshot.get("pages") or []:
        path = p.get("path")
        if not valid_page_path(path):
            warnings.append(f"skipped a page with an unusable path {str(path)[:80]!r}")
            continue
        if path in seen:
            warnings.append(f"skipped a second page at {path}")
            continue
        seen.add(path)
        pages.append(p)
    files: dict[str, str] = {}
    for p in pages:
        updated = _date(p.get("updated")) or _date(p.get("updated_at")) or default_updated
        files[page_file(p["path"])] = page_text(p, updated)
    nav = build_nav(settings, pages)
    files["site.json"] = json.dumps(site_json(site, settings, nav, url=url, ai_api=ai_api), indent=2, ensure_ascii=False) + "\n"
    redirects = settings.get("redirects")
    if isinstance(redirects, list):
        redirects = {r.get("from"): r.get("to") for r in redirects if isinstance(r, dict) and r.get("from") and r.get("to")}
    if isinstance(redirects, dict) and redirects:
        files["redirects.json"] = json.dumps(redirects, indent=2, ensure_ascii=False) + "\n"
    if isinstance(settings.get("videos"), dict) and settings["videos"]:
        files["videos.json"] = json.dumps(settings["videos"], indent=2, ensure_ascii=False) + "\n"
    return files, warnings


async def _page_ids(db: AsyncIOMotorDatabase, snapshot: dict) -> None:
    """Snapshots written without page ids: fill them from docs_pages by path, so settings.nav
    (page ids) still resolves."""
    pages = snapshot.get("pages") or []
    if not pages or all(p.get("id") for p in pages):
        return
    rows = db[PAGES].find({"site_id": snapshot["site_id"], "deleted_at": None}, {"path": 1})
    by_path = {r["path"]: str(r["_id"]) async for r in rows}
    for p in pages:
        if not p.get("id") and p.get("path") in by_path:
            p["id"] = by_path[p["path"]]


async def bundle(db: AsyncIOMotorDatabase, build: dict) -> dict:
    """The runner's view of a build: {site_id, files, warnings} + where it publishes."""
    snapshot = await db[SNAPSHOTS].find_one({"_id": oid(build["snapshot_id"])})
    if snapshot is None:
        raise LookupError(f"snapshot {build.get('snapshot_id')} not found")
    site = await db[SITES].find_one({"_id": oid(build["site_id"])})
    if site is None:
        raise LookupError(f"site {build.get('site_id')} not found")
    await _page_ids(db, snapshot)
    s = get_jobs_settings()
    ai_api = s.docs_ai_api or get_settings().api_base_url
    files, warnings = content_files(site, snapshot, url=site_url(site), ai_api=ai_api)
    return {
        "bundle": {"site_id": str(site["_id"]), "files": files, "warnings": warnings},
        "publish": {"site": str(site["_id"]), "hosts": site_hosts(site)},
    }
