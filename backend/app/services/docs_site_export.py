"""A guide → a self-hostable content folder, as a zip.

Settings › Export & self-host: a guide admin downloads the folder the open-source engine builds
(docs-platform/builder/cli.mjs, docs-platform/server/server.mjs, the Docker image): the same files
a publish hands the runner (services/docs_snapshot.py content_files), plus what the runner fetches
from the docs bucket itself (the files the pages use, the OpenAPI description) and the media.json it
measures. From the live publish (``source=published``) or the drafts as they are now (``drafts``).

What changes for a copy that runs on someone else's server (the engine's features that need
Markdrop's API are switched off in its site.json, so nothing calls home or half-works):

* Ask AI is off: the engine asks Markdrop's API, which answers only a guide's own Markdrop
  addresses (middleware/docs_cors.py).
* Insights is off ("Did this page help?", search and reading signals, page views): they post to
  Markdrop's API for this guide, keyed by its id.
* Private pages and sections: the edge unlocks them with a reader sign-in that only Markdrop
  runs, so they are left out (``private=omit``, the default: pages gone from the folder and the
  sidebar, sections cut) or exported as ordinary public content (``private=public``). Never as
  locked pages nobody could open.
* A password or members-only guide: the folder has no access policy, so a self-hosted copy is
  public (the studio says so before the download).
* ``::markdrop`` blocks keep working: they read a public file from Markdrop's public API.

The download is a link, not an XHR: POST /export (admins) checks the size and returns a signed
URL valid for :data:`TOKEN_TTL` seconds; GET /export/download?token=… streams the zip (the
browser saves it as it arrives; nothing is held in memory but the file being written). The token
names the site, the user and the choices, and the user must still be an admin when it's used.
"""

from __future__ import annotations

import io
import json
import re
import time
import zipfile
from datetime import datetime, timezone
from typing import Iterator

from bson import ObjectId
from fastapi import HTTPException
from fastapi.concurrency import run_in_threadpool
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.services import docs_page_access
from app.services import docs_site_access
from app.services import docs_site_assets as assets
from app.services import docs_snapshot
from app.services.docs_site_store import BUILDS, SITES, SNAPSHOTS, is_admin, log_event, site_role

SOURCES = ("published", "drafts")
PRIVATE = ("omit", "public")
TOKEN_PURPOSE = "markdrop-guide-export-v1"
TOKEN_TTL = 300
# The most a download may be (pages + files). A guide's own storage quota is far below this; it
# only stops a runaway (an import with thousands of large files).
MAX_BYTES = 2 * 1024 ** 3
FOLDER_FORMAT = "markdrop-guides-content/1"

_IMAGE = re.compile(r"\.(webp|png|jpe?g|gif)$", re.I)
_VIDEO = re.compile(r"\.(mp4|webm)$", re.I)
_PRIVATE_OPEN = re.compile(r"^[ \t>]*(?:[-*+]\s+)?:{3,}private\b", re.M)
# Bytes that are already compressed: stored in the zip as they are.
_STORED = re.compile(r"\.(png|jpe?g|gif|webp|avif|mp4|webm|zip|pdf|ico)$", re.I)


class _Everything:
    """split_private's ``reveal`` for "every rule": exporting private content as public."""

    def __contains__(self, _rule: object) -> bool:
        return True

    def __bool__(self) -> bool:
        return True


# ── Which content ─────────────────────────────────────────────────────────────


async def _published(db: AsyncIOMotorDatabase, site: dict) -> dict | None:
    """The live publish's snapshot (or, for an unpublished guide, its last successful one)."""
    build = await db[BUILDS].find_one({"_id": site["live_build_id"]}) if site.get("live_build_id") else None
    if build is None:
        build = await db[BUILDS].find_one({"site_id": site["_id"], "status": {"$in": ["live", "superseded"]}},
                                          sort=[("number", -1)])
    if build is None or not build.get("snapshot_id"):
        return None
    snap = await db[SNAPSHOTS].find_one({"_id": build["snapshot_id"]})
    if snap is not None:
        snap["_build_number"] = build.get("number")
    return snap


async def _snapshot(db: AsyncIOMotorDatabase, site: dict, source: str, user_id: str) -> dict:
    if source == "published":
        snap = await _published(db, site)
        if snap is None:
            raise HTTPException(status_code=409, detail="This guide hasn't been published yet. Export the drafts instead.")
        return snap
    from app.services.docs_site_publish import draft_snapshot

    snap = await draft_snapshot(db, site, user_id)
    if snap is None:
        raise HTTPException(status_code=409, detail="This guide has no pages to export yet.")
    try:
        from app.services import docs_embeds

        snap["embeds"] = await docs_embeds.text_infos(db, snap.get("pages") or [])
    except Exception:  # pragma: no cover - a text version never fails an export
        pass
    return snap


def _group_of(settings: dict, pages: list[dict], extra: dict) -> dict[str, str]:
    """Page path → the sidebar group it's in (the group's private-pages rule applies to it)."""
    out: dict[str, str] = {}
    for g in docs_snapshot.build_nav(settings, pages, extra):
        for p in g.get("pages") or []:
            out.setdefault(p, g.get("group") or "")
    return out


def apply_private(snapshot: dict, site: dict, mode: str) -> tuple[list[dict], dict]:
    """The snapshot's pages with private content handled for a public copy (see the module
    docstring), and counts: {pages: left out, sections: cut or opened}."""
    settings = snapshot.get("settings") or site.get("settings") or {}
    extra = site.get("engine_extra") or {}
    pages = [dict(p) for p in snapshot.get("pages") or []]
    groups = snapshot["page_access_groups"] if "page_access_groups" in snapshot else docs_page_access.groups(site)
    group_of = _group_of(settings, pages, extra)
    out: list[dict] = []
    counts = {"pages": 0, "sections": 0}
    for p in pages:
        fx = dict(p.get("frontmatter_extra") or {})
        rule = docs_page_access.page_rule(fx.get("access"), (groups or {}).get(group_of.get(p.get("path"), "")))
        if rule and mode == "omit":
            counts["pages"] += 1
            continue
        fx.pop("access", None)
        p["frontmatter_extra"] = fx
        body = str(p.get("markdown") or "")
        if docs_page_access.has_private(body):
            counts["sections"] += len(_PRIVATE_OPEN.findall(body))
            if mode == "omit":
                body, _rules = docs_page_access.split_private(body, None, placeholder=False)
            else:
                body, _rules = docs_page_access.split_private(body, _Everything(), unwrap=True)  # type: ignore[arg-type]
            p["markdown"] = body
        out.append(p)
    return out, counts


def self_hosted_site_json(sj: dict) -> dict:
    """site.json for a copy on someone else's server: no Ask AI, no Insights, no access rules."""
    sj["ai"] = {"enabled": False}
    for k in ("feedback", "insights", "signals", "access"):
        sj.pop(k, None)
    for g in sj.get("nav") or []:
        if isinstance(g, dict):
            g.pop("access", None)
    return sj


# ── The files the pages use ──────────────────────────────────────────────────


def _light_of(u: str) -> str:
    return re.sub(r"\.dark(\.[a-z0-9]+)?$", r"\1", u, flags=re.I)


def _base_of(u: str) -> str:
    return re.sub(r"\.[a-z0-9]+$", "", u, flags=re.I)


def referenced(objects: list[dict], site_id: str, text: str) -> list[dict]:
    """The runner's referencedAssets (docs-platform/runner/lib.mjs): an object is kept when its
    address, or the light file or clip base it belongs to, appears in the text. → [{key, rel, size}]."""
    prefix = f"sites/{site_id}/assets/"
    out = []
    for o in objects:
        key = o.get("key") or ""
        if not key.startswith(prefix):
            continue
        rel = assets.rel_of("/docs-assets/" + key[len(prefix):])
        if not rel:
            continue
        url = "/docs-assets/" + rel
        light = _light_of(url)
        if any(c in text for c in (url, light, _base_of(url), _base_of(light))):
            out.append({"key": key, "rel": rel, "size": int(o.get("size") or 0)})
    return sorted(out, key=lambda o: o["rel"])


def media_entry(rel: str, data: bytes, videos: set[str]) -> dict | None:
    """media.json's entry for /docs-assets/<rel> (builder/media.mjs): image size, bytes, kind."""
    url = "/docs-assets/" + rel
    if _IMAGE.search(rel):
        entry: dict = {}
        try:
            from PIL import Image

            with Image.open(io.BytesIO(data)) as im:
                entry["w"], entry["h"] = im.size
        except Exception:
            pass
        entry["bytes"] = len(data)
        entry["kind"] = "poster" if _IMAGE.sub("", url) in videos else "image"
        return entry
    if _VIDEO.search(rel):
        return {"bytes": len(data), "kind": "clip"}
    return None


# ── The plan and the zip ─────────────────────────────────────────────────────


def _readme(name: str, folder: str, source: str, notes: list[str]) -> str:
    lines = [
        f"{name}: a Markdrop Guides content folder ({source}, exported {datetime.now(timezone.utc):%Y-%m-%d}).",
        "",
        "Serve it on your own machine with the open-source engine:",
        "",
        f"  docker run --rm -p 8080:8080 -v \"$PWD/{folder}:/site:ro\" -v markdrop-guides-data:/data \\",
        "    ghcr.io/himanshkukreja/markdrop-guides",
        "",
        "then open http://localhost:8080. Set \"url\" in site.json to the address readers will use.",
        "Steps, the Node option and the folder format: https://docs.markdrop.in/guides/self-hosting",
    ]
    if notes:
        lines += ["", "What's different from the guide on Markdrop:", *[f"- {n}" for n in notes]]
    return "\n".join(lines) + "\n"


async def plan(db: AsyncIOMotorDatabase, site: dict, *, source: str, private: str, user_id: str) -> dict:
    """Everything a download writes: {files: {rel: text}, assets: [{key, rel, size}], openapi,
    bytes, pages, notes, folder}. Raises 409 (nothing to export) or 413 (too large)."""
    snap = await _snapshot(db, site, source, user_id)
    pages, private_counts = apply_private(snap, site, private)
    if not pages:
        raise HTTPException(status_code=409, detail="Every page of this guide is private. Choose to export private content as public, or make a page public first.")
    snap = {**snap, "pages": pages}
    from app.services import docs_api_spec
    from app.services.docs_jobs import get_jobs_settings

    ai_api = get_jobs_settings().docs_ai_api or get_settings().api_base_url
    spec_row = await docs_api_spec.build_ref(db, site, snap.get("settings") or {})
    files, warnings = docs_snapshot.content_files(site, snap, url=docs_snapshot.site_url(site), ai_api=ai_api,
                                                  api_spec=spec_row)
    sj = self_hosted_site_json(json.loads(files["site.json"]))
    files["site.json"] = json.dumps(sj, indent=2, ensure_ascii=False) + "\n"

    site_id = str(site["_id"])
    text = "\n".join(files.values())
    found: list[dict] = []
    if assets.is_configured():
        listed = await run_in_threadpool(assets.list_objects, f"sites/{site_id}/assets/")
        found = referenced(listed, site_id, text)

    notes: list[str] = []
    s = site.get("settings") or {}
    if (s.get("ai") or {}).get("enabled"):
        notes.append("Ask AI is off: it runs on Markdrop's API, which answers only the guide's Markdrop addresses.")
    notes.append("Insights, the Fix list and \"Did this page help?\" are off: they report to Markdrop.")
    if private_counts["pages"] or private_counts["sections"]:
        what = []
        if private_counts["pages"]:
            what.append(f"{private_counts['pages']} private page{'s' if private_counts['pages'] != 1 else ''}")
        if private_counts["sections"]:
            what.append(f"{private_counts['sections']} private section{'s' if private_counts['sections'] != 1 else ''}")
        notes.append(" and ".join(what) + (" left out." if private == "omit" else " exported as public content."))
    if not docs_site_access.is_public(site):
        notes.append("This guide is password-protected or members-only on Markdrop. The copy has no sign-in: put it behind your own if it must stay private.")
    notes += [f"Skipped: {w}" for w in warnings]

    folder = re.sub(r"[^a-z0-9-]+", "-", str(site.get("slug") or "guide").lower()).strip("-") or "guide"
    files["README.txt"] = _readme(site.get("name") or "Guide", folder,
                                  "the live publish" if source == "published" else "the drafts", notes)
    openapi = None
    if spec_row:
        openapi = {"key": spec_row["key"], "sha256": spec_row.get("sha256"), "size": int(spec_row.get("size") or 0)}
    total = sum(len(t.encode()) for t in files.values()) + sum(a["size"] for a in found) + (openapi["size"] if openapi else 0)
    if total > MAX_BYTES:
        raise HTTPException(status_code=413, detail=f"This guide's files add up to {total / 1024 ** 3:.1f} GB; "
                                                    f"an export can be at most {MAX_BYTES // 1024 ** 3} GB.")
    return {
        "files": files,
        "assets": found,
        "openapi": openapi,
        "bytes": total,
        "pages": len(pages),
        "notes": notes,
        "folder": folder,
        "source": source,
        "private": private,
        "build_number": snap.get("_build_number"),
    }


class _Sink:
    """A write-only stream zipfile writes to (not seekable: entries get data descriptors);
    :meth:`take` hands over what's been written since the last call."""

    def __init__(self) -> None:
        self._buf = bytearray()
        self._pos = 0

    def write(self, b) -> int:
        self._buf += b
        self._pos += len(b)
        return len(b)

    def tell(self) -> int:
        return self._pos

    def flush(self) -> None:
        pass

    def take(self) -> bytes:
        out = bytes(self._buf)
        self._buf.clear()
        return out


def _entry(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=time.gmtime()[:6])
    info.compress_type = zipfile.ZIP_STORED if _STORED.search(name) else zipfile.ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    return info


def zip_stream(p: dict, *, get_bytes=None) -> Iterator[bytes]:
    """The zip, as it's written (a sync generator: StreamingResponse runs it in a thread, which is
    where the bucket reads belong). ``<folder>/…``: the text files, then each file the pages use
    (read one at a time), then media.json measured from them."""
    get = get_bytes or assets.get_bytes
    root = p["folder"]
    sink = _Sink()
    with zipfile.ZipFile(sink, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
        for rel in sorted(p["files"]):
            zf.writestr(_entry(f"{root}/{rel}"), p["files"][rel].encode())
            yield sink.take()
        if p.get("openapi"):
            body = get(p["openapi"]["key"])
            if body:
                zf.writestr(_entry(f"{root}/{docs_snapshot.API_SPEC_FILE}"), body)
                yield sink.take()
        videos = {_VIDEO.sub("", "/docs-assets/" + a["rel"]) for a in p["assets"] if _VIDEO.search(a["rel"])}
        media: dict[str, dict] = {}
        for a in p["assets"]:
            body = get(a["key"])
            if body is None:
                continue  # removed from the bucket since the plan: the page shows a missing image
            zf.writestr(_entry(f"{root}/public/docs-assets/{a['rel']}"), body)
            entry = media_entry(a["rel"], body, videos)
            if entry:
                media["/docs-assets/" + a["rel"]] = entry
            yield sink.take()
        if media and "media.json" not in p["files"]:
            zf.writestr(_entry(f"{root}/media.json"), (json.dumps(dict(sorted(media.items())), indent=2) + "\n").encode())
    yield sink.take()


# ── The signed link ──────────────────────────────────────────────────────────


def _key() -> str:
    return "guide-export|" + get_settings().auth_secret


def sign(site_id: str, user_id: str, source: str, private: str) -> tuple[str, int]:
    exp = int(time.time()) + TOKEN_TTL
    return docs_site_access.sign(TOKEN_PURPOSE, {"s": site_id, "u": user_id, "src": source, "pv": private, "exp": exp},
                                 _key()), exp


async def redeem(db: AsyncIOMotorDatabase, site_id: str, token: str) -> tuple[dict, str, dict]:
    """(site, user id, {source, private}) for a valid, unexpired link whose user is still an admin
    of the site; 404 otherwise (the same answer for a bad link and a gone guide)."""
    data = docs_site_access.read(TOKEN_PURPOSE, token or "", _key())
    gone = HTTPException(status_code=404, detail="This download link has expired. Start the export again.")
    if not data or data.get("s") != site_id or data.get("src") not in SOURCES or data.get("pv") not in PRIVATE \
            or not ObjectId.is_valid(site_id):
        raise gone
    site = await db[SITES].find_one({"_id": ObjectId(site_id), "deleted_at": None})
    if site is None or not is_admin(await site_role(db, site, str(data.get("u") or ""))):
        raise gone
    return site, str(data["u"]), {"source": data["src"], "private": data["pv"]}


def summary(p: dict) -> dict:
    return {"pages": p["pages"], "files": len(p["assets"]), "bytes": p["bytes"], "notes": p["notes"],
            "folder": p["folder"], "source": p["source"], "private": p["private"], "build_number": p.get("build_number"),
            "format": FOLDER_FORMAT}


async def record(db: AsyncIOMotorDatabase, site: dict, user_id: str, p: dict) -> None:
    await log_event(db, "docs_exported", site, user_id, source=p["source"], private=p["private"], pages=p["pages"],
                    files=len(p["assets"]), bytes=p["bytes"])
