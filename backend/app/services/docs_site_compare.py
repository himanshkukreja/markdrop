"""What changed between two versions of a guide, and how a publish is getting on.

A version is a publish (its ``docs_snapshots`` row: every page and the settings at publish time),
the live publish, or the drafts as they are now. Comparing two gives the pages added, edited and
removed (with +/- line counts), whether the design, the redirects, the API reference or other
published settings changed, and, for one page, a line diff of its Markdown (Python's difflib).

The publish history shows each publish against the last one before it that went live
(``history_summaries``: page ids and hashes only, no Markdown read). A running publish gets a
``progress`` view from its job's progress (``progress_view``): the runner reports
prepare → assets → build (static pages x of y) → index (search, Ask AI, link previews) → publish
→ done (docs-platform/runner/lib.mjs runBuild).
"""

from __future__ import annotations

import difflib
import hashlib
import json
import statistics
from datetime import datetime
from typing import Any

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.services import docs_api_spec as api_spec
from app.services import docs_site_pages as pages
from app.services import docs_site_store as store
from app.services.docs_site_store import BUILDS, JOBS, PAGES, SNAPSHOTS, aware, now

settings = get_settings()

DRAFTS = "drafts"
LIVE = "live"
NONE = "none"
RUNNING = ("queued", "building", "publishing")
# One page's diff: at most this many rows (a whole-page rewrite of a huge page is cut).
DIFF_MAX_ROWS = 4000
CONTEXT = 3
# Settings that change what readers see (as docs_site_publish._COMPARED_SETTINGS); "theme" is the
# design, "api" the API reference.
SETTING_KEYS = ("theme", "nav", "redirects", "ai", "seo")
PAGE_FIELDS = ("path", "title", "description", "icon", "hidden")
# A typical publish when the guide has none to go by yet.
TYPICAL_MS = 60_000


# ── Versions ──────────────────────────────────────────────────────────────────


def _page_hash(p: dict) -> str | None:
    if p.get("hash"):
        return p["hash"]
    if "markdown" not in p:
        return None
    data = [p.get("path"), p.get("title"), p.get("description"), p.get("icon"), bool(p.get("hidden")),
            p.get("markdown"), p.get("frontmatter_extra") or {}]
    return hashlib.sha256(json.dumps(data, sort_keys=True, default=str).encode()).hexdigest()


def _draft_page(r: dict) -> dict:
    draft = r.get("draft") or {}
    return {
        "page_id": str(r["_id"]), "path": r.get("path"), "title": r.get("title"),
        "description": r.get("description") or "", "icon": r.get("icon"), "hidden": bool(r.get("hidden")),
        "markdown": draft.get("markdown") or "", "frontmatter_extra": draft.get("frontmatter_extra") or {},
        "hash": pages.content_hash(r),
    }


async def _drafts(db: AsyncIOMotorDatabase, site: dict) -> dict:
    rows = await db[PAGES].find({"site_id": site["_id"], "deleted_at": None}).sort("path", 1).to_list(
        length=settings.docs_pages_per_site + 50)
    return {"pages": [_draft_page(r) for r in rows], "settings": site.get("settings") or {},
            "site": {"name": site.get("name"), "slug": site.get("slug")}}


def _build_meta(b: dict, site: dict, names: dict[str, str]) -> dict:
    return {
        "ref": str(b["_id"]), "kind": "publish", "number": b.get("number"), "status": b.get("status"),
        "live": site.get("live_build_id") == b["_id"], "note": b.get("note"),
        "requested_by_name": names.get(b.get("requested_by") or ""),
        "at": aware(b.get("finished_at") or b.get("created_at")),
    }


async def _version(db: AsyncIOMotorDatabase, site: dict, ref: str) -> tuple[dict, dict | None]:
    """(what it is, its snapshot-like content). ``live`` with nothing live: (kind none, None)."""
    if ref == DRAFTS:
        return {"ref": DRAFTS, "kind": "drafts"}, await _drafts(db, site)
    if ref == NONE:
        # Before the first publish: everything in the other version is new.
        return {"ref": NONE, "kind": "none"}, None
    if ref == LIVE:
        if not site.get("live_build_id"):
            return {"ref": LIVE, "kind": "none"}, None
        ref = str(site["live_build_id"])
    b = await db[BUILDS].find_one({"_id": store.oid(ref, "Publish"), "site_id": site["_id"]})
    if b is None:
        raise HTTPException(status_code=404, detail="Publish not found")
    snap = await db[SNAPSHOTS].find_one({"_id": b["snapshot_id"]}) if b.get("snapshot_id") else None
    if snap is None:
        raise HTTPException(status_code=404, detail="That publish's pages aren't kept any more.")
    names = await store.user_names(db, [b.get("requested_by")])
    return _build_meta(b, site, names), snap


# ── Comparing ─────────────────────────────────────────────────────────────────


def _lines(text: str) -> list[str]:
    return (text or "").splitlines()


def line_counts(old: str, new: str) -> tuple[int, int]:
    """(+lines, −lines) between two texts."""
    a, b = _lines(old), _lines(new)
    plus = minus = 0
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if tag in ("replace", "delete"):
            minus += i2 - i1
        if tag in ("replace", "insert"):
            plus += j2 - j1
    return plus, minus


def page_diff(old: str, new: str, context: int = CONTEXT) -> dict:
    """Rows ``{"op": "same"|"add"|"del"|"gap", "text", "a", "b"}`` (a/b: the line number in the
    old/new text) with ``context`` unchanged lines around each change and a gap row (its text: how
    many lines are skipped) between hunks."""
    a, b = _lines(old), _lines(new)
    rows: list[dict] = []
    truncated = False
    groups = list(difflib.SequenceMatcher(None, a, b, autojunk=False).get_grouped_opcodes(context))
    if not a and not b:
        groups = []
    elif not a:
        groups = [[("insert", 0, 0, 0, len(b))]]
    elif not b:
        groups = [[("delete", 0, len(a), 0, 0)]]
    last_a = 0
    for g in groups:
        first = g[0]
        if first[1] > last_a:
            rows.append({"op": "gap", "text": str(first[1] - last_a), "a": None, "b": None})
        for tag, i1, i2, j1, j2 in g:
            if tag == "equal":
                rows.extend({"op": "same", "text": a[i], "a": i + 1, "b": j1 + (i - i1) + 1} for i in range(i1, i2))
                continue
            if tag in ("replace", "delete"):
                rows.extend({"op": "del", "text": a[i], "a": i + 1, "b": None} for i in range(i1, i2))
            if tag in ("replace", "insert"):
                rows.extend({"op": "add", "text": b[j], "a": None, "b": j + 1} for j in range(j1, j2))
        last_a = g[-1][2]
        if len(rows) > DIFF_MAX_ROWS:
            truncated = True
            rows = rows[:DIFF_MAX_ROWS]
            break
    if not truncated and groups and last_a < len(a):
        rows.append({"op": "gap", "text": str(len(a) - last_a), "a": None, "b": None})
    return {"rows": rows, "truncated": truncated}


def _settings_changed(old: dict | None, new: dict | None) -> list[str]:
    """The published settings that differ ("theme", "nav", "redirects", "ai", "seo", "api", "name",
    "address"). Against nothing (a first publish) nothing counts as changed."""
    if old is None or new is None:
        return []
    o, n = old.get("settings") or {}, new.get("settings") or {}
    out = [k for k in SETTING_KEYS if o.get(k) != n.get(k)]
    try:
        if api_spec.api_settings({"settings": o}) != api_spec.api_settings({"settings": n}):
            out.append("api")
    except Exception:  # noqa: BLE001  (an old snapshot's odd shape: compare it raw)
        if o.get("api") != n.get("api"):
            out.append("api")
    os_, ns = old.get("site") or {}, new.get("site") or {}
    if os_ and ns and os_.get("name") != ns.get("name"):
        out.append("name")
    if os_ and ns and os_.get("slug") != ns.get("slug"):
        out.append("address")
    return out


def compare(old: dict | None, new: dict | None, *, lines: bool = True) -> dict:
    """Page-level changes from ``old`` to ``new`` (snapshot-like dicts; None = nothing) and the
    summary. ``lines``: count +/- lines (needs both versions' Markdown)."""
    before = {p.get("page_id"): p for p in (old or {}).get("pages") or []}
    after = {p.get("page_id"): p for p in (new or {}).get("pages") or []}
    out: list[dict] = []
    for pid, p in after.items():
        o = before.get(pid)
        item: dict[str, Any] = {"id": pid, "path": p.get("path"), "title": p.get("title")}
        if o is None:
            item["change"] = "added"
            if lines:
                item.update(added_lines=len(_lines(p.get("markdown") or "")), removed_lines=0)
        elif _page_hash(o) != _page_hash(p):
            item["change"] = "edited"
            item["fields"] = [f for f in PAGE_FIELDS if (o.get(f) or None) != (p.get(f) or None)]
            if o.get("path") != p.get("path"):
                item["moved_from"] = o.get("path")
            if lines:
                plus, minus = line_counts(o.get("markdown") or "", p.get("markdown") or "")
                item.update(added_lines=plus, removed_lines=minus)
        else:
            continue
        out.append(item)
    for pid, o in before.items():
        if pid not in after:
            item = {"id": pid, "path": o.get("path"), "title": o.get("title"), "change": "removed"}
            if lines:
                item.update(added_lines=0, removed_lines=len(_lines(o.get("markdown") or "")))
            out.append(item)
    order = {"added": 0, "edited": 1, "removed": 2}
    out.sort(key=lambda x: (order[x["change"]], x.get("path") or ""))
    changed = _settings_changed(old, new)
    summary = {
        "added": sum(1 for x in out if x["change"] == "added"),
        "edited": sum(1 for x in out if x["change"] == "edited"),
        "removed": sum(1 for x in out if x["change"] == "removed"),
        "design": "theme" in changed,
        "redirects": "redirects" in changed,
        "api": "api" in changed,
        "settings": changed,
    }
    return {"pages": out, "summary": summary}


async def compare_versions(db: AsyncIOMotorDatabase, site: dict, ref_from: str, ref_to: str,
                           page_id: str | None = None) -> dict:
    """GET /docs-sites/<site>/compare: ``from`` and ``to`` are a publish id, ``live``, ``none``
    (nothing: before the first publish) or ``drafts`` (``to`` only). One page's line diff:
    ``page`` (else the first changed page)."""
    if ref_from == DRAFTS:
        raise HTTPException(status_code=422, detail="Compare the drafts against a publish: put them in `to`.")
    meta_from, old = await _version(db, site, ref_from)
    meta_to, new = await _version(db, site, ref_to)
    res = compare(old, new)
    chosen = next((p for p in res["pages"] if p["id"] == page_id), None) if page_id else None
    # By default the first edited page (the diff says most there), else the first change.
    chosen = chosen or next((p for p in res["pages"] if p["change"] == "edited"), None) \
        or (res["pages"][0] if res["pages"] else None)
    page = None
    if chosen is not None:
        o = next((p for p in (old or {}).get("pages") or [] if p.get("page_id") == chosen["id"]), None)
        n = next((p for p in (new or {}).get("pages") or [] if p.get("page_id") == chosen["id"]), None)
        page = {**chosen, **page_diff((o or {}).get("markdown") or "", (n or {}).get("markdown") or "")}
    return {"from": meta_from, "to": meta_to, **res, "page": page}


# ── History: each publish against the one before it ──────────────────────────


_LIGHT = {"pages.page_id": 1, "pages.hash": 1, "pages.path": 1, "pages.title": 1, "settings": 1, "site": 1}


async def history_summaries(db: AsyncIOMotorDatabase, site: dict, rows: list[dict]) -> dict[Any, dict]:
    """Build id → its change summary against the newest earlier build that went live (a
    ``manifest_hash``); the first publish: every page added."""
    if not rows:
        return {}
    ordered = sorted(rows, key=lambda r: r.get("number") or 0)
    lowest = ordered[0].get("number") or 0
    before = await db[BUILDS].find_one(
        {"site_id": site["_id"], "number": {"$lt": lowest}, "manifest_hash": {"$nin": [None, ""]}},
        {"snapshot_id": 1, "number": 1}, sort=[("number", -1)])
    snap_ids = {r["snapshot_id"] for r in ordered if r.get("snapshot_id")}
    if before and before.get("snapshot_id"):
        snap_ids.add(before["snapshot_id"])
    snaps = {s["_id"]: s async for s in db[SNAPSHOTS].find({"_id": {"$in": list(snap_ids)}}, _LIGHT)}
    prev = snaps.get(before["snapshot_id"]) if before and before.get("snapshot_id") else None
    out: dict[Any, dict] = {}
    for r in ordered:
        snap = snaps.get(r.get("snapshot_id"))
        if snap is None:
            continue
        out[r["_id"]] = compare(prev, snap, lines=False)["summary"]
        if r.get("manifest_hash"):
            prev = snap
    return out


# ── A running publish ─────────────────────────────────────────────────────────


def _frac(done: Any, total: Any) -> float:
    try:
        d, t = float(done or 0), float(total or 0)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(1.0, d / t)) if t > 0 else 0.0


def progress_view(build: dict, job: dict | None, *, pages_total: int, typical_ms: int | None,
                  at: datetime | None = None) -> dict:
    """Where a running publish is, for the studio's progress card:

    stage    waiting (queued) | pages (writing, fetching files, compiling, rendering) | extras (search,
             Ask AI, link previews) | live (uploading, switching readers over)
    percent  0–99 (100 once it's live: the build's status says that)
    pages_done / pages_total   rendering, scaled to the snapshot's pages
    eta_seconds                from the guide's recent publishes (else about a minute)

    The runner's steps (docs-platform/runner/lib.mjs runBuild): prepare, assets (files fetched),
    compile (Next compiling: milestones 0 compiling, 1 compiled, 2 collecting page data, of 3),
    build (static pages rendered, done of total), index (the crawl), publish, done.
    """
    at = at or now()
    p = (job or {}).get("progress") or {}
    step = p.get("step") if isinstance(p, dict) else None
    frac = _frac(p.get("done"), p.get("total")) if isinstance(p, dict) else 0.0
    status = build.get("status")
    started = aware(build.get("started_at")) or aware(build.get("created_at"))
    elapsed = max(0.0, (at - started).total_seconds()) if started else 0.0
    typical = (typical_ms or TYPICAL_MS) / 1000
    pages_done = 0
    if status == "publishing" or step == "done":
        stage, pct, pages_done = "live", 97, pages_total
    elif step == "publish":
        stage, pct, pages_done = "live", 88 + round(8 * frac), pages_total
    elif step == "index":
        stage, pct, pages_done = "extras", 72 + round(16 * frac), pages_total
    elif step == "build":
        stage, pct = "pages", 48 + round(24 * frac)
        pages_done = round(frac * pages_total)
    elif step == "compile":
        # Compiling is most of a small guide's build and Next reports no counts for it: between
        # its milestones, the bar creeps with the time spent (against half the usual publish),
        # never past the next milestone.
        timed = min(elapsed / max(typical * 0.5, 1.0), 1.0)
        step_cap = min(1.0, frac + 1 / 3) - 0.04
        stage, pct = "pages", 18 + round(30 * max(frac, min(timed, step_cap)))
    elif step == "assets":
        stage, pct = "pages", 8 + round(10 * frac)
    elif step == "prepare" or status == "building":
        stage, pct = "pages", 5
    else:
        stage, pct = "waiting", 2
    eta = max(typical - elapsed, 0.0)
    if pct >= 20 and elapsed > 0:
        # Past the start, how fast this one goes says more than the average.
        eta = (eta + elapsed * (100 - pct) / pct) / 2
    if stage == "waiting":
        eta = typical
    return {
        "stage": stage, "percent": max(1, min(99, pct)), "step": step or None,
        "pages_done": min(pages_done, pages_total), "pages_total": pages_total,
        "eta_seconds": max(3, round(eta)), "elapsed_seconds": round(elapsed),
    }


async def typical_build_ms(db: AsyncIOMotorDatabase, site_id: ObjectId) -> int | None:
    rows = await db[BUILDS].find({"site_id": site_id, "stats.ms": {"$gt": 0}}, {"stats.ms": 1}).sort(
        "number", -1).to_list(length=5)
    times = [int(r["stats"]["ms"]) for r in rows if isinstance(r.get("stats"), dict) and r["stats"].get("ms")]
    return int(statistics.median(times)) if times else None


async def attach_progress(db: AsyncIOMotorDatabase, site: dict, views: list[dict], rows: list[dict]) -> None:
    """``progress`` on each running build's view (in place)."""
    running = [r for r in rows if r.get("status") in RUNNING]
    if not running:
        return
    typical = await typical_build_ms(db, site["_id"])
    by_id = {v["id"]: v for v in views}
    for r in running:
        job = await db[JOBS].find_one({"_id": r["job_id"]}, {"progress": 1, "status": 1}) if r.get("job_id") else None
        total = 0
        if r.get("snapshot_id"):
            snap = await db[SNAPSHOTS].find_one({"_id": r["snapshot_id"]}, {"pages.page_id": 1})
            total = len((snap or {}).get("pages") or [])
        v = by_id.get(str(r["_id"]))
        if v is not None:
            v["progress"] = progress_view(r, job, pages_total=total, typical_ms=typical)


# ── The site bar's state, the setup checklist ────────────────────────────────


async def publish_status(db: AsyncIOMotorDatabase, site: dict, *, details: bool = False) -> dict:
    """GET /docs-sites/<site>/publish-status (polled by every studio screen's site bar): how many
    changes wait for a publish, the running publish with its progress, and the live one."""
    from app.services import docs_site_publish as publishing

    ch = await publishing.changes(db, site, lines=False)
    changed = ch["pages"]
    rows = await db[BUILDS].find({"site_id": site["_id"]}).sort("number", -1).to_list(length=5)
    live = await db[BUILDS].find_one({"_id": site["live_build_id"]}) if site.get("live_build_id") else None
    running = [r for r in rows if r.get("status") in RUNNING]
    names = await store.user_names(db, [r.get("requested_by") for r in rows] + [(live or {}).get("requested_by")])
    views = [store.build_view(r, names, details=details) for r in running]
    await attach_progress(db, site, views, running)
    latest = rows[0] if rows else None
    return {
        "count": ch["count"],
        "ever_published": ch["ever_published"],
        "summary": {
            "added": sum(1 for p in changed if p["change"] == "added"),
            "edited": sum(1 for p in changed if p["change"] == "modified"),
            "removed": sum(1 for p in changed if p["change"] == "deleted"),
            "design": "theme" in ch["settings_changed"],
            "redirects": "redirects" in ch["settings_changed"],
            "api": "api" in ch["settings_changed"],
            "settings": ch["settings_changed"],
        },
        "status": site.get("status"),
        # The oldest running one: the one the progress card follows.
        "running": views[-1] if views else None,
        "running_count": len(views),
        "live": {**store.build_view(live, names, details=details), "live": True} if live else None,
        "latest": store.build_view(latest, names, details=details) if latest else None,
    }


async def setup_status(db: AsyncIOMotorDatabase, site: dict) -> dict:
    """GET /docs-sites/<site>/setup: the Publish screen's "Finish setting up" list, from what's
    really there. ``team``: people with a Guides role on the guide (None: a personal guide, which
    has only its owner)."""
    from app.services import docs_studio_roles as roles
    from app.services import guide_insights as insights

    sid = site["_id"]
    page_total = await db[PAGES].count_documents({"site_id": sid, "deleted_at": None})
    theme = (site.get("settings") or {}).get("theme") or {}
    # Saved on the Design screen once, or matched to the brand (an import does that); a
    # template's preset alone isn't a choice.
    look = bool(site.get("design_saved_at")) or bool((theme.get("brand") or {}).get("enabled"))
    went_live = site.get("status") == "live" or bool(site.get("live_build_id")) or bool(
        await db[BUILDS].find_one({"site_id": sid, "manifest_hash": {"$nin": [None, ""]}}, {"_id": 1}))
    domains = [d for d in site.get("domains") or [] if isinstance(d, dict) and d.get("host")]
    team = None
    if site.get("workspace_id"):
        members = await roles.site_members(db, site)
        team = sum(1 for m in members if m.get("effective_role") in roles.ROLES)
    seen = await insights.first_seen(db, str(sid))
    return {
        "pages": page_total,
        "look_chosen": look,
        "published": went_live,
        "live_since": aware(site.get("last_published_at")),
        "own_domain": bool(domains),
        "own_domain_live": any(d.get("status") in ("live", "verified") for d in domains),
        "team": team,
        "insights_data": seen is not None,
    }
