"""Hosted docs sites: the collections, roles, limits, sites and events.

A docs site lives in a workspace (or, personal, belongs to one person). Who may
do what is the caller's Guides role on the site (services/docs_studio_roles.py:
admin, reviewer, editor, viewer, or none), resolved in one place, :func:`site_role`:
the workspace owner and admins are always admins; everyone else has the role a
studio admin gave them in the workspace, or a per-site override; a personal site
is its owner's alone (as admin).

Anyone with no role gets a 404, so the API never confirms a site exists to someone
who can't see it. Pages, publishing and reviews are in docs_site_pages.py and
docs_site_publish.py; this module holds what they share.

Collections (ids are ObjectIds; ``site_id``/``page_id``/``build_id``/
``snapshot_id``/``review_id`` references are ObjectIds too, while user and
workspace ids are strings, as everywhere else in Markdrop):
docs_sites, docs_pages, docs_page_versions, docs_builds, docs_snapshots,
docs_reviews, docs_jobs, plus docs_assets (uploaded files, for the storage
quota) and docs_events (usage events for the admin dashboard).
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Any

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError

from app.config import get_settings
from app.models.user import User
from app.services import docs_site_access
from app.services import docs_site_redirects as site_redirects
from app.services import docs_site_settings as site_settings
from app.services import docs_site_templates as templates
from app.services import docs_studio_roles as studio_roles
from app.services import workspace as ws_service
from app.services.docs_site_jobs import enqueue_job

log = logging.getLogger("markdrop.docs_site_store")
settings = get_settings()

SITES = "docs_sites"
PAGES = "docs_pages"
VERSIONS = "docs_page_versions"
BUILDS = "docs_builds"
SNAPSHOTS = "docs_snapshots"
REVIEWS = "docs_reviews"
JOBS = "docs_jobs"
ASSETS = "docs_assets"
EVENTS = "docs_events"

ROLE_RANK = studio_roles.ROLE_RANK

SLUG_MIN, SLUG_MAX = 3, 40
_SLUG = re.compile(r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$")
RESERVED_SLUGS = frozenset({
    "www", "api", "docs", "admin", "app", "mail", "status", "cdn", "assets", "static",
    "markdrop", "help", "support", "blog", "dashboard", "login", "signin", "signup", "auth",
    "account", "accounts", "billing", "settings", "sites", "site", "edge", "preview", "previews",
    "smtp", "imap", "pop", "ftp", "ns1", "ns2", "mx", "email", "webmail", "dev", "staging", "test",
    "internal", "security", "abuse", "postmaster", "hostmaster", "root", "official", "new",
    # cname.guides.markdrop.in: the record customers' own domains point at (docs_custom_domains).
    "cname", "origin", "fallback",
})


class DocsError(HTTPException):
    """An error whose JSON body is ``body`` exactly (the router returns it as is),
    for answers that carry more than a message: the current rev, the lock."""

    def __init__(self, status_code: int, body: dict):
        super().__init__(status_code=status_code, detail=body.get("detail"))
        self.body = body


def now() -> datetime:
    return datetime.now(timezone.utc)


def aware(dt: datetime | None) -> datetime | None:
    """Motor hands back naive UTC datetimes; make them comparable and serialise with an offset."""
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def oid(value: Any, what: str = "Guide") -> ObjectId:
    try:
        return ObjectId(str(value))
    except Exception:
        raise HTTPException(status_code=404, detail=f"{what} not found") from None


def site_url(slug: str | None) -> str | None:
    return f"https://{slug}.{settings.docs_sites_domain}" if slug else None


def utc_midnight() -> datetime:
    n = now()
    return n.replace(hour=0, minute=0, second=0, microsecond=0)


def month_start() -> datetime:
    return utc_midnight().replace(day=1)


# ── Indexes ───────────────────────────────────────────────────────────────────


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    """Every docs-site collection's indexes (the build worker reads and writes
    these collections but creates none). Soft-deleted sites and pages give up
    their slug/path (moved to deleted_slug/deleted_path), so the unique indexes
    are partial on the field being a string."""
    await db[SITES].create_index(
        "slug", unique=True, name="slug_unique", partialFilterExpression={"slug": {"$type": "string"}})
    await db[SITES].create_index([("workspace_id", 1), ("deleted_at", 1)])
    await db[SITES].create_index([("owner_id", 1), ("workspace_id", 1)])
    # A guide's own domain belongs to one guide (services/docs_custom_domains.py). Partial: sites
    # without domains aren't in the index.
    await db[SITES].create_index(
        "domains.host", unique=True, name="domain_host_unique",
        partialFilterExpression={"domains.host": {"$type": "string"}})

    await db[PAGES].create_index(
        [("site_id", 1), ("path", 1)], unique=True, name="site_path_unique",
        partialFilterExpression={"path": {"$type": "string"}})
    await db[PAGES].create_index([("site_id", 1), ("deleted_at", 1)])

    await db[VERSIONS].create_index([("page_id", 1), ("rev", -1)], unique=True)
    await db[VERSIONS].create_index([("site_id", 1), ("at", -1)])

    await db[BUILDS].create_index([("site_id", 1), ("number", -1)], unique=True)
    await db[BUILDS].create_index([("site_id", 1), ("created_at", -1)])
    await db[BUILDS].create_index([("status", 1), ("created_at", 1)])

    await db[SNAPSHOTS].create_index([("site_id", 1), ("created_at", -1)])

    await db[REVIEWS].create_index([("site_id", 1), ("status", 1), ("created_at", -1)])
    # One open review per site: a review is "publish the current drafts".
    await db[REVIEWS].create_index(
        "site_id", unique=True, name="one_open_review",
        partialFilterExpression={"status": "open"})

    # The queue: claim the oldest queued job, or a running one whose lease lapsed.
    await db[JOBS].create_index([("status", 1), ("created_at", 1)])
    await db[JOBS].create_index([("status", 1), ("locked_until", 1)])
    await db[JOBS].create_index([("site_id", 1), ("kind", 1), ("status", 1)])
    await db[JOBS].create_index([("site_id", 1), ("created_at", -1)])

    await db[ASSETS].create_index([("site_id", 1), ("sha256", 1)], unique=True)

    from app.services import docs_api_spec

    await docs_api_spec.ensure_indexes(db)

    await db[EVENTS].create_index([("kind", 1), ("ts", -1)])
    await db[EVENTS].create_index([("site_id", 1), ("ts", -1)])
    await db[EVENTS].create_index([("user_id", 1), ("ts", -1)])
    await db[EVENTS].create_index([("workspace_id", 1), ("kind", 1), ("ts", -1)])

    await studio_roles.ensure_indexes(db)


# ── Events (admin feature usage) ──────────────────────────────────────────────


async def log_event(db: AsyncIOMotorDatabase, kind: str, site: dict | None, user_id: str | None,
                    **meta: Any) -> None:
    """One row per docs_site_created / docs_published / docs_review_submitted /
    docs_review_approved / docs_imported (and, from the job runner, docs_build_live /
    docs_build_failed / docs_import_finished / docs_import_failed / docs_restored /
    docs_unpublished). The admin's Guides usage (routers/admin.py feature-usage) reads them.
    Meta is ids, counts and enums: never page text, a source URL or CSS. Never fails the request."""
    try:
        await db[EVENTS].insert_one({
            "kind": kind,
            "site_id": site.get("_id") if site else None,
            "workspace_id": site.get("workspace_id") if site else None,
            "user_id": user_id,
            "ts": now(),
            **({"meta": meta} if meta else {}),
        })
    except Exception:  # pragma: no cover - tracking must not fail a request
        log.warning("docs_events write failed", exc_info=True)


# ── Roles ─────────────────────────────────────────────────────────────────────


def role_at_least(role: str | None, need: str) -> bool:
    return studio_roles.role_at_least(role, need)


def is_admin(role: str | None) -> bool:
    return role_at_least(role, "admin")


def can_review(role: str | None) -> bool:
    return role_at_least(role, "reviewer")


async def site_role(db: AsyncIOMotorDatabase, site: dict, user_id: str | None) -> str | None:
    """The caller's effective Guides role on the site (None: no access)."""
    return (await studio_roles.resolve(db, site, user_id)).role


_NEED_MESSAGE = {
    "editor": "You need edit access to this guide to do that.",
    "reviewer": "Only this guide's reviewers and admins can do that.",
    "admin": "Only Guides admins can do that.",
    "owner": "Only the owner can do that.",
}


async def site_access(db: AsyncIOMotorDatabase, site_id: str, user: User,
                      need: str = "viewer") -> tuple[dict, studio_roles.Resolved]:
    """(site row, caller's role and where it comes from), or 404 for no access / 403 for too little."""
    site = await db[SITES].find_one({"_id": oid(site_id), "deleted_at": None})
    if site is None:
        raise HTTPException(status_code=404, detail="Guide not found")
    access = await studio_roles.resolve(db, site, user.id)
    if access.role is None:
        raise HTTPException(status_code=404, detail="Guide not found")
    if not role_at_least(access.role, need):
        raise HTTPException(status_code=403, detail=_NEED_MESSAGE.get(need, "Not allowed."))
    return site, access


async def load_site(db: AsyncIOMotorDatabase, site_id: str, user: User, need: str = "viewer") -> tuple[dict, str]:
    """(site row, caller's role), or 404 for no access / 403 for too little."""
    site, access = await site_access(db, site_id, user, need)
    return site, access.role


async def user_names(db: AsyncIOMotorDatabase, ids) -> dict[str, str]:
    """Display names for user ids (name, else email)."""
    oids = []
    for i in {i for i in ids if i}:
        try:
            oids.append(ObjectId(i))
        except Exception:
            continue
    if not oids:
        return {}
    rows = await db["users"].find({"_id": {"$in": oids}}, {"name": 1, "email": 1}).to_list(length=len(oids))
    return {str(r["_id"]): (r.get("name") or r.get("email") or "Someone") for r in rows}


# ── Slugs ─────────────────────────────────────────────────────────────────────


def slug_problem(slug: str) -> tuple[str, str] | None:
    """(reason, message) when ``slug`` can't be an address, else None."""
    if not isinstance(slug, str) or not (SLUG_MIN <= len(slug) <= SLUG_MAX):
        return "invalid", f"Use {SLUG_MIN}–{SLUG_MAX} characters."
    if not _SLUG.match(slug):
        return "invalid", "Use lowercase letters, numbers and hyphens, starting and ending with a letter or number."
    if slug in RESERVED_SLUGS:
        return "reserved", "That address is reserved."
    return None


async def slug_status(db: AsyncIOMotorDatabase, slug: str, exclude: ObjectId | None = None) -> dict:
    slug = (slug or "").strip().lower()
    problem = slug_problem(slug)
    if problem:
        return {"slug": slug, "available": False, "reason": problem[0], "message": problem[1]}
    q: dict = {"slug": slug}
    if exclude is not None:
        q["_id"] = {"$ne": exclude}
    if await db[SITES].find_one(q, {"_id": 1}):
        return {"slug": slug, "available": False, "reason": "taken", "message": "That address is taken."}
    return {"slug": slug, "available": True, "reason": None, "message": None,
            "url": site_url(slug)}


def _slug_or_raise(problem: tuple[str, str] | None) -> None:
    if problem:
        raise HTTPException(status_code=422, detail=problem[1])


# ── Limits and usage ──────────────────────────────────────────────────────────


def _scope_query(workspace_id: str | None, owner_id: str) -> dict:
    if workspace_id:
        return {"workspace_id": workspace_id, "deleted_at": None}
    return {"workspace_id": None, "owner_id": owner_id, "deleted_at": None}


async def ai_answers(db: AsyncIOMotorDatabase, site_ids: list[str]) -> dict[str, int]:
    """Ask AI answers this UTC month per site (the ledger's ``site`` is the site id)."""
    if not site_ids:
        return {}
    out: dict[str, int] = {}
    async for row in db["ai_requests"].aggregate([
        {"$match": {"feature": "docs_ask", "site": {"$in": site_ids}, "ts": {"$gte": month_start()},
                    "outcome": {"$nin": ["limit", "error"]}}},
        {"$group": {"_id": "$site", "n": {"$sum": 1}}},
    ]):
        out[row["_id"]] = row["n"]
    return out


async def storage_bytes(db: AsyncIOMotorDatabase, site_id: ObjectId) -> int:
    async for row in db[ASSETS].aggregate([
        {"$match": {"site_id": site_id}}, {"$group": {"_id": None, "b": {"$sum": "$size"}}}]):
        return int(row["b"])
    return 0


async def builds_today(db: AsyncIOMotorDatabase, site_id: ObjectId) -> int:
    return await db[BUILDS].count_documents({"site_id": site_id, "created_at": {"$gte": utc_midnight()}})


def _over_today(what: str, limit: int, whose: str) -> HTTPException:
    return HTTPException(status_code=429, detail=f"The free plan has {limit} {what} per {whose} per day. "
                                                 "Try again tomorrow (UTC).")


async def check_new_site_quota(db: AsyncIOMotorDatabase, user_id: str, workspace_id: str | None, kind: str) -> None:
    """Today's site creations (and imports, for a GitBook site), per person and per workspace.
    Counted from the site rows, deleted ones included: a site is never removed, only marked."""
    since = {"$gte": utc_midnight()}
    checks = [({"owner_id": user_id}, settings.docs_site_creations_per_user_per_day, "new guides", "person")]
    if workspace_id:
        checks.append(({"workspace_id": workspace_id}, settings.docs_site_creations_per_workspace_per_day,
                       "new guides", "workspace"))
    if kind == "gitbook":
        checks.append(({"owner_id": user_id, "source.kind": "gitbook"}, settings.docs_imports_per_user_per_day,
                       "GitBook imports", "person"))
        if workspace_id:
            checks.append(({"workspace_id": workspace_id, "source.kind": "gitbook"},
                           settings.docs_imports_per_workspace_per_day, "GitBook imports", "workspace"))
    for q, limit, what, whose in checks:
        if await db[SITES].count_documents({**q, "created_at": since}) >= limit:
            raise _over_today(what, limit, whose)


async def check_build_quota(db: AsyncIOMotorDatabase, site: dict, user_id: str) -> None:
    """Today's publishes across every site: by this person, and in the site's workspace."""
    since = {"$gte": utc_midnight()}
    limit = settings.docs_builds_per_user_per_day
    if await db[BUILDS].count_documents({"requested_by": user_id, "created_at": since}) >= limit:
        raise _over_today("publishes", limit, "person")
    if site.get("workspace_id"):
        ids = await db[SITES].distinct("_id", {"workspace_id": site["workspace_id"]})
        limit = settings.docs_builds_per_workspace_per_day
        if await db[BUILDS].count_documents({"site_id": {"$in": ids}, "created_at": since}) >= limit:
            raise _over_today("publishes", limit, "workspace")


def limits() -> dict:
    return {
        "sites": settings.docs_sites_per_workspace,
        "pages": settings.docs_pages_per_site,
        "builds_per_day": settings.docs_builds_per_day,
        "asset_bytes": settings.docs_asset_max_bytes,
        "storage_bytes": settings.docs_site_storage_bytes,
        "ai_answers_per_month": settings.docs_ai_answers_per_month,
    }


# ── Views ─────────────────────────────────────────────────────────────────────


# What a build or job failure says to anyone but a studio admin: the runner's own error text
# (an R2 or Next message, a path) is for the people who can act on it.
GENERIC_ERROR = "Something went wrong on our side. A guide admin can see the details."


def _error_for(err: Any, details: bool) -> str | None:
    if not err:
        return None
    return str(err) if details else GENERIC_ERROR


def build_view(b: dict | None, names: dict[str, str] | None = None, *, details: bool = False) -> dict | None:
    """``details``: the caller is a studio admin (the raw error text); anyone else gets a generic one."""
    if b is None:
        return None
    names = names or {}
    return {
        "id": str(b["_id"]),
        "site_id": str(b["site_id"]),
        "number": b.get("number"),
        "status": b.get("status"),
        "requested_by": b.get("requested_by"),
        "requested_by_name": names.get(b.get("requested_by") or ""),
        "review_id": str(b["review_id"]) if b.get("review_id") else None,
        "note": b.get("note"),
        "snapshot_id": str(b["snapshot_id"]) if b.get("snapshot_id") else None,
        "job_id": str(b["job_id"]) if b.get("job_id") else None,
        "manifest_hash": b.get("manifest_hash"),
        "stats": b.get("stats"),
        "error": _error_for(b.get("error"), details),
        # Things that went ahead differently than asked (an API reference that couldn't be re-fetched).
        "warnings": b.get("warnings") or [],
        "created_at": aware(b.get("created_at")),
        "started_at": aware(b.get("started_at")),
        "finished_at": aware(b.get("finished_at")),
    }


def job_view(j: dict | None, *, details: bool = False) -> dict | None:
    if j is None:
        return None
    result = j.get("result")
    if isinstance(result, dict) and result.get("error") and not details:
        result = {**result, "error": GENERIC_ERROR}
    return {
        "id": str(j["_id"]),
        "kind": j.get("kind"),
        "site_id": str(j["site_id"]),
        "status": j.get("status"),
        "attempts": j.get("attempts", 0),
        "payload": {k: v for k, v in (j.get("payload") or {}).items() if "token" not in k},
        "progress": j.get("progress"),
        "result": result,
        "error": _error_for(j.get("error"), details),
        "created_at": aware(j.get("created_at")),
        "updated_at": aware(j.get("updated_at")),
    }


async def page_count(db: AsyncIOMotorDatabase, site_id: ObjectId) -> int:
    return await db[PAGES].count_documents({"site_id": site_id, "deleted_at": None})


def _role_fields(role: str | studio_roles.Resolved) -> tuple[str | None, str | None]:
    if isinstance(role, studio_roles.Resolved):
        return role.role, role.source
    return role, None


def sees_details(role: str | studio_roles.Resolved | None) -> bool:
    """Studio admins see the raw error text of builds and jobs."""
    return is_admin(_role_fields(role)[0] if role is not None else None)


async def site_summary(db: AsyncIOMotorDatabase, site: dict, role: str | studio_roles.Resolved, *, pages: int,
                       ai_used: int, open_review: dict | None, names: dict[str, str]) -> dict:
    """``role``: the caller's effective role (with its source when it's a Resolved)."""
    your_role, source = _role_fields(role)
    return {
        "id": str(site["_id"]),
        "workspace_id": site.get("workspace_id"),
        "name": site.get("name"),
        "slug": site.get("slug"),
        "url": site_url(site.get("slug")),
        "status": site.get("status"),
        "in_review": open_review is not None,
        "review_requested_by_name": names.get((open_review or {}).get("requested_by") or ""),
        "preset": ((site.get("settings") or {}).get("theme") or {}).get("preset", "clean"),
        "source_kind": (site.get("source") or {}).get("kind"),
        "page_count": pages,
        "ai_used": ai_used,
        "last_published_at": aware(site.get("last_published_at")),
        "last_published_by": site.get("last_published_by"),
        "last_published_by_name": names.get(site.get("last_published_by") or ""),
        "updated_at": aware(site.get("updated_at")),
        "created_at": aware(site.get("created_at")),
        "your_role": your_role,
        # Where the role comes from: workspace_owner / workspace_admin (always admin), workspace
        # (their studio role there), site (this site's override), personal (a personal site's owner).
        "your_role_source": source,
    }


async def site_view(db: AsyncIOMotorDatabase, site: dict, role: str | studio_roles.Resolved, *,
                    job: dict | None = None) -> dict:
    from app.services import docs_cf_hosts, docs_custom_domains

    sid = site["_id"]
    live = await db[BUILDS].find_one({"_id": site["live_build_id"]}) if site.get("live_build_id") else None
    latest = await db[BUILDS].find_one({"site_id": sid}, sort=[("number", -1)])
    open_review = await db[REVIEWS].find_one({"site_id": sid, "status": "open"})
    names = await user_names(db, [site.get("last_published_by"), (live or {}).get("requested_by"),
                                  (latest or {}).get("requested_by"), (open_review or {}).get("requested_by")])
    details = sees_details(role)
    pages = await page_count(db, sid)
    ai = await ai_answers(db, [str(sid)])
    out = await site_summary(db, site, role, pages=pages, ai_used=ai.get(str(sid), 0),
                             open_review=open_review, names=names)
    out.update({
        "owner_id": site.get("owner_id"),
        "source": site.get("source"),
        "settings": site_settings.public_view(site.get("settings") or {}),
        # Its own domains (services/docs_custom_domains.py; the DNS records for admins only) and
        # whether this server offers them.
        "domains": docs_custom_domains.view(site, details=details),
        "own_domains": docs_custom_domains.available(),
        "live_build_id": str(site["live_build_id"]) if site.get("live_build_id") else None,
        "last_import_job_id": str(site["last_import_job_id"]) if site.get("last_import_job_id") else None,
        "live_build": build_view(live, names, details=details),
        "latest_build": build_view(latest, names, details=details),
        "open_review_id": str(open_review["_id"]) if open_review else None,
        "counts": {
            "pages": pages,
            "hidden_pages": await db[PAGES].count_documents({"site_id": sid, "deleted_at": None, "hidden": True}),
            "open_reviews": 1 if open_review else 0,
            "builds_today": await builds_today(db, sid),
            "storage_bytes": await storage_bytes(db, sid),
            "ai_answers_this_month": ai.get(str(sid), 0),
        },
        "limits": limits(),
        # False while the edge doesn't hold the site's access policy yet (the access job is
        # retried until it does): the dashboard says "Not enforced yet".
        "access_enforced": docs_site_access.enforced(site),
        # False while the free address isn't attached on Cloudflare yet (services/docs_cf_hosts.py:
        # its certificate is on its way); always True where addresses aren't managed there.
        "address_ready": docs_cf_hosts.address_ready(site),
    })
    if job is not None:
        out["job"] = job_view(job, details=details)
    return out


# ── Listing ───────────────────────────────────────────────────────────────────


async def _summaries(db: AsyncIOMotorDatabase, rows: list[dict], role_of) -> tuple[list[dict], dict[str, int]]:
    """SiteSummary for each row (``role_of(row)`` → the caller's role), plus Ask AI use per site id."""
    ids = [r["_id"] for r in rows]
    counts: dict = {}
    async for c in db[PAGES].aggregate([
        {"$match": {"site_id": {"$in": ids}, "deleted_at": None}},
        {"$group": {"_id": "$site_id", "n": {"$sum": 1}}},
    ]):
        counts[c["_id"]] = c["n"]
    reviews = {r["site_id"]: r for r in await db[REVIEWS].find(
        {"site_id": {"$in": ids}, "status": "open"}).to_list(length=len(ids) or 1)}
    ai = await ai_answers(db, [str(i) for i in ids])
    names = await user_names(db, [r.get("last_published_by") for r in rows]
                             + [r.get("requested_by") for r in reviews.values()])
    sites = [await site_summary(db, r, role_of(r), pages=counts.get(r["_id"], 0), ai_used=ai.get(str(r["_id"]), 0),
                                open_review=reviews.get(r["_id"]), names=names) for r in rows]
    return sites, ai


async def list_sites(db: AsyncIOMotorDatabase, user: User, workspace_id: str | None) -> dict:
    """A workspace's sites the caller can open (any member; sites they have no role on are left
    out), or with no workspace their personal ones. ``your_role``: their studio role across the
    workspace ("none" when they have none, though a site's override may still show them a site)."""
    if workspace_id:
        ws_role = await ws_service.role_for(db, workspace_id, user.id)
        if ws_role is None:
            raise HTTPException(status_code=404, detail="Workspace not found")
        ws_access = await studio_roles.workspace_role(db, workspace_id, user.id, ws_role)
        ws_roles = {workspace_id: ws_role}
    else:
        ws_access = studio_roles.Resolved("admin", studio_roles.SRC_PERSONAL)
        ws_roles = {}
    rows = await db[SITES].find(_scope_query(workspace_id, user.id)).sort("created_at", 1).to_list(length=100)
    access = await studio_roles.resolve_many(db, user.id, rows, ws_roles)
    visible = [r for r in rows if access[r["_id"]].role]
    sites, ai = await _summaries(db, visible, lambda r: access[r["_id"]])
    return {
        "sites": sites,
        "your_role": ws_access.role or "none",
        "your_role_source": ws_access.source,
        "usage": {
            "sites": len(rows) if is_admin(ws_access.role) else len(visible),
            "limit": settings.docs_sites_per_workspace,
            "ai_used": sum(ai.values()),
            "ai_limit": settings.docs_ai_answers_per_month,
        },
    }


def _workspace_brand(ws) -> dict:
    """What Markdrop Guides shows of a workspace beside its sites: its accent and logo, if set."""
    b = ws.branding
    return {"accent": b.accent_color or None, "logo_url": b.logo_url or None}


async def list_all_sites(db: AsyncIOMotorDatabase, user: User) -> dict:
    """Markdrop Guides' home (``GET /docs-sites?scope=all``): every site the caller can open, across
    all their workspaces plus their personal ones, each carrying its workspace (for grouping);
    every workspace with the caller's studio role there ("none" until an admin gives one), its
    usage and whether they may create a site (studio admin, and not being deleted) or manage its
    people; and the personal scope's usage. Sites they have no role on are left out."""
    memberships = await ws_service.list_for_user(db, user.id)
    roles = {ws.id: ws_role for ws, ws_role in memberships}
    by_id = {ws.id: ws for ws, _ in memberships}
    rows = await db[SITES].find({
        "deleted_at": None,
        "$or": [{"workspace_id": {"$in": list(roles)}}, {"workspace_id": None, "owner_id": user.id}],
    }).sort("created_at", 1).to_list(length=500)
    access = await studio_roles.resolve_many(db, user.id, rows, roles)
    visible = [r for r in rows if access[r["_id"]].role]
    ws_access = await studio_roles.workspace_roles_for(db, user.id, roles)

    sites, ai = await _summaries(db, visible, lambda r: access[r["_id"]])
    per_scope: dict[str | None, int] = {}
    seen: dict[str | None, int] = {}
    for r in rows:
        per_scope[r.get("workspace_id")] = per_scope.get(r.get("workspace_id"), 0) + 1
    for r in visible:
        seen[r.get("workspace_id")] = seen.get(r.get("workspace_id"), 0) + 1
    for s in sites:
        ws = by_id.get(s["workspace_id"]) if s["workspace_id"] else None
        s["workspace"] = {"id": ws.id, "name": ws.name, **_workspace_brand(ws)} if ws else None
    limit = settings.docs_sites_per_workspace
    workspaces = []
    for ws, ws_role in memberships:
        a = ws_access[ws.id]
        admin = is_admin(a.role)
        workspaces.append({
            "id": ws.id,
            "name": ws.name,
            **_workspace_brand(ws),
            "workspace_role": ws_role,
            "your_role": a.role or "none",
            "your_role_source": a.source,
            "can_create": admin and not ws.deleting,
            "can_manage_people": admin,
            "usage": {"sites": (per_scope if admin else seen).get(ws.id, 0), "limit": limit},
        })
    return {
        "sites": sites,
        "workspaces": workspaces,
        "personal": {"your_role": "admin", "your_role_source": studio_roles.SRC_PERSONAL, "can_create": True,
                     "usage": {"sites": per_scope.get(None, 0), "limit": limit}},
        "usage": {
            "sites": len(visible),
            "limit": limit,
            "ai_used": sum(ai.values()),
            "ai_limit": settings.docs_ai_answers_per_month,
        },
    }


# ── Create ────────────────────────────────────────────────────────────────────


def _new_page_row(site_id: ObjectId, page: dict, user: User, at: datetime) -> dict:
    return {
        "site_id": site_id,
        "path": page["path"],
        "title": page.get("title") or "Untitled",
        "description": page.get("description") or "",
        "icon": page.get("icon"),
        "hidden": bool(page.get("hidden")),
        "draft": {
            "markdown": page.get("markdown") or "",
            "frontmatter_extra": page.get("frontmatter_extra") or {},
            "rev": 1,
            "updated_by": user.id,
            "updated_at": at,
        },
        "published": None,
        "lock": None,
        "created_at": at,
        "deleted_at": None,
    }


def version_row(page: dict, *, by: str, at: datetime, kind: str) -> dict:
    return {
        "page_id": page["_id"],
        "site_id": page["site_id"],
        "rev": page["draft"]["rev"],
        "markdown": page["draft"]["markdown"],
        "title": page.get("title"),
        "description": page.get("description"),
        "by": by,
        "at": at,
        "kind": kind,
    }


async def seed_pages(db: AsyncIOMotorDatabase, site_id: ObjectId, user: User, template: str | None,
                     kind: str = "save") -> list[dict]:
    """Insert the starting pages and return the nav for them."""
    home, groups = templates.pages_for(template)
    at = now()
    home_row = _new_page_row(site_id, home, user, at)
    rows = [home_row]
    nav: list[dict] = []
    for name, pages in groups:
        group_rows = [_new_page_row(site_id, p, user, at) for p in pages]
        rows.extend(group_rows)
        nav.append({"group": name, "rows": group_rows})
    res = await db[PAGES].insert_many(rows)
    for row, _id in zip(rows, res.inserted_ids):
        row["_id"] = _id
    await db[VERSIONS].insert_many([version_row(r, by=user.id, at=at, kind=kind) for r in rows])
    out = [{"group": g["group"], "pages": [str(r["_id"]) for r in g["rows"]]} for g in nav]
    # The home page leads the first group, as the editor's page tree shows it.
    if out:
        out[0]["pages"].insert(0, str(home_row["_id"]))
    else:
        out = [{"group": "Getting started", "pages": [str(home_row["_id"])]}]
    return out


async def create_site(db: AsyncIOMotorDatabase, user: User, *, workspace_id: str | None, name: str, slug: str,
                      source: dict) -> tuple[dict, studio_roles.Resolved, dict | None]:
    """(site, caller's role, job or None)."""
    name = (name or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="Give the guide a name.")
    slug = (slug or "").strip().lower()
    _slug_or_raise(slug_problem(slug))

    if workspace_id:
        await ws_service.assert_open(db, workspace_id)
        ws_role = await ws_service.role_for(db, workspace_id, user.id)
        if ws_role is None:
            raise HTTPException(status_code=404, detail="Workspace not found")
        role = await studio_roles.workspace_role(db, workspace_id, user.id, ws_role)
        if not is_admin(role.role):
            raise HTTPException(status_code=403, detail="Only Guides admins of this workspace can create guides.")
    else:
        role = studio_roles.Resolved("admin", studio_roles.SRC_PERSONAL)

    existing = await db[SITES].count_documents(_scope_query(workspace_id, user.id))
    if existing >= settings.docs_sites_per_workspace:
        where = "this workspace" if workspace_id else "your account"
        raise HTTPException(
            status_code=429,
            detail=f"The free plan has {settings.docs_sites_per_workspace} guides per workspace, "
                   f"and {where} has them all. Delete one to make another.")
    await check_new_site_quota(db, user.id, workspace_id, source.get("kind"))

    kind = source.get("kind")
    stored_source: dict = {"kind": kind}
    st = site_settings.default_settings()
    if kind == "template":
        stored_source["template"] = source["template"]
        st["theme"]["preset"] = templates.PRESET_FOR[source["template"]]
    elif kind == "gitbook":
        stored_source["url"] = source["url"]
    elif kind == "github":
        stored_source["repo"] = source["repo"]
        # No GitHub App yet: the connection waits until it exists.
        stored_source["status"] = "pending"

    at = now()
    row = {
        "workspace_id": workspace_id or None,
        "owner_id": user.id,
        "name": name[:80],
        "slug": slug,
        "status": "draft",
        "source": stored_source,
        "settings": st,
        "domains": [],
        "live_build_id": None,
        "last_published_at": None,
        "last_published_by": None,
        "build_seq": 0,
        "created_at": at,
        "updated_at": at,
        "deleted_at": None,
    }
    try:
        res = await db[SITES].insert_one(row)
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail="That address is taken.") from None
    row["_id"] = res.inserted_id

    job = None
    if kind in ("blank", "template"):
        nav = await seed_pages(db, row["_id"], user, source.get("template") if kind == "template" else None)
        await db[SITES].update_one({"_id": row["_id"]}, {"$set": {"settings.nav": nav}})
        row["settings"]["nav"] = nav
        if kind == "template" and source.get("template") == "api":
            # The template's reference starts from a sample description (Northwind) to replace.
            from app.services import docs_api_spec

            await docs_api_spec.seed_sample(db, row, user.id)
    elif kind == "gitbook":
        job = await enqueue_job(db, "import", row["_id"], {"source": "gitbook", "url": source["url"]})
        # The import screen can be reopened from the site (Settings, the editor) after it's closed.
        await db[SITES].update_one({"_id": row["_id"]}, {"$set": {"last_import_job_id": job["_id"]}})
        row["last_import_job_id"] = job["_id"]
        # Usage counts only: the source's address stays on the site row, not in the event log.
        await log_event(db, "docs_imported", row, user.id, source="gitbook", job_id=str(job["_id"]))
    await log_event(db, "docs_site_created", row, user.id, source=kind,
                    **({"template": source["template"]} if kind == "template" else {}))
    return row, role, job


# ── Update / delete / unpublish ───────────────────────────────────────────────


async def update_site(db: AsyncIOMotorDatabase, site: dict, *, name: str | None, slug: str | None,
                      settings_patch: dict | None) -> dict:
    updates: dict = {}
    if name is not None:
        n = name.strip()
        if not n:
            raise HTTPException(status_code=422, detail="Give the guide a name.")
        updates["name"] = n[:80]
    if slug is not None:
        s = slug.strip().lower()
        if s != site.get("slug"):
            _slug_or_raise(slug_problem(s))
            updates["slug"] = s
    if settings_patch:
        patch = dict(settings_patch)
        if "nav" in patch:
            raise HTTPException(status_code=422, detail="Change the page order with PUT /nav.")
        if isinstance(patch.get("api"), dict) and "spec_id" in patch["api"]:
            raise HTTPException(status_code=422, detail="Upload, fetch or restore an OpenAPI file with the API reference endpoints.")
        access = patch.get("access")
        if isinstance(access, dict):
            access = dict(access)
            patch["access"] = access
            if "password_hash" in access:
                raise HTTPException(status_code=422, detail="Send access.password, not a hash.")
            if "password" in access:
                pw = access.pop("password")
                if pw is None or pw == "":
                    access["password_hash"] = None
                elif not isinstance(pw, str) or not (8 <= len(pw) <= 200):
                    raise HTTPException(status_code=422, detail="Use a password of 8 to 200 characters.")
                else:
                    import bcrypt

                    access["password_hash"] = bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()
        merged = site_settings.deep_merge(site.get("settings") or site_settings.default_settings(), patch)
        try:
            validated = site_settings.validate(merged)
        except site_settings.SettingsError as exc:
            raise HTTPException(status_code=422, detail=exc.errors) from None
        if validated["access"]["level"] == "password" and not validated["access"].get("password_hash"):
            raise HTTPException(status_code=422, detail="Set a password for password-protected access.")
        # nav is managed by PUT /nav; keep exactly what is stored.
        validated["nav"] = (site.get("settings") or {}).get("nav") or []
        if "redirects" in patch and validated.get("redirects"):
            paths = {r["path"] for r in await db[PAGES].find(
                {"site_id": site["_id"], "deleted_at": None}, {"path": 1}).to_list(length=settings.docs_pages_per_site + 50)}
            problems = site_redirects.problems_against(validated["redirects"], paths)
            if problems:
                raise HTTPException(status_code=422, detail=[
                    {"loc": ["settings", "redirects"], "msg": m, "type": "value_error"} for m in problems])
        updates["settings"] = validated
    if not updates:
        return site
    updates["updated_at"] = now()
    # A new level or password signs every reader out at the edge (services/docs_site_access.py).
    access_changed = "settings" in updates and docs_site_access.access_changed(
        (site.get("settings") or {}).get("access"), updates["settings"].get("access"))
    change = {"$set": updates, **({"$inc": {"access_version": 1}} if access_changed else {})}
    try:
        res = await db[SITES].find_one_and_update(
            {"_id": site["_id"], "deleted_at": None}, change, return_document=True)
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail="That address is taken.") from None
    if res is None:
        raise HTTPException(status_code=404, detail="Guide not found")
    if access_changed:
        await docs_site_access.queue_sync(db, res["_id"], "settings")
    if "slug" in updates:
        from app.services import docs_cf_hosts

        await docs_cf_hosts.queue_for_slug(db, res["_id"], site.get("slug"))
    return res


async def _take_down(db: AsyncIOMotorDatabase, site: dict, reason: str, extra: dict) -> dict | None:
    """Mark the site unpublished (live build superseded) and queue taking it off its address.

    The unpublish job is queued whenever anything could be at the address: the site was ever live,
    or a build of it is queued or running (a runner may already be uploading it; it asks the API
    before it flips the pointer, and a build that still lands is taken down by finish_build). The
    job is idempotent. Returns the job, or None when nothing was ever live or on its way."""
    t = now()
    was_live = bool(site.get("live_build_id")) or site.get("status") == "live" or bool(site.get("last_published_at"))
    sets = {"status": "unpublished", "live_build_id": None, "updated_at": t, "taken_down_at": t, **extra}
    await db[SITES].update_one({"_id": site["_id"]}, {"$set": sets, **({"$unset": {"slug": ""}}
                                                                      if "deleted_slug" in extra else {})})
    if site.get("live_build_id"):
        await db[BUILDS].update_one({"_id": site["live_build_id"], "status": "live"},
                                    {"$set": {"status": "superseded"}})
    building = await db[JOBS].find_one({"site_id": site["_id"], "kind": "build", "status": {"$in": ["queued", "running"]}},
                                       {"_id": 1})
    # What was waiting to put it (back) live never runs: those builds were asked for before this.
    why = "Site deleted." if reason == "delete" else "Site unpublished."
    await db[JOBS].update_many({"site_id": site["_id"], "kind": {"$in": ["build", "restore"]}, "status": "queued"},
                               {"$set": {"status": "failed", "error": why, "updated_at": t}})
    await db[BUILDS].update_many({"site_id": site["_id"], "status": "queued"},
                                 {"$set": {"status": "failed", "error": why, "finished_at": t}})
    # Its free address on Cloudflare comes off too (whenever one may have been attached).
    if site.get("slug") or site.get("cf_hosts"):
        from app.services import docs_cf_hosts

        await docs_cf_hosts.queue(db, site["_id"], reason,
                                  [docs_cf_hosts.free_host(site["slug"])] if site.get("slug") else [])
    if "deleted_at" in extra and site.get("domains"):
        # A deleted guide's own domains come off Cloudflare, and their names are free again.
        from app.services import docs_custom_domains

        await docs_custom_domains.take_down(db, site)
    if not was_live and building is None:
        return None
    return await enqueue_job(db, "unpublish", site["_id"], {"reason": reason, "slug": site.get("slug")})


async def unpublish_site(db: AsyncIOMotorDatabase, site: dict) -> dict:
    if site.get("status") != "live" and not site.get("live_build_id"):
        raise HTTPException(status_code=409, detail="This guide isn't published.")
    return await _take_down(db, site, "unpublish", {})


async def delete_site(db: AsyncIOMotorDatabase, site: dict, user: User | str | None,
                      reason: str = "delete") -> dict | None:
    """Soft-delete the site and take it off its addresses. ``user``: who did it (a User, a user id,
    or None for the system, e.g. its workspace being deleted)."""
    at = now()
    by = user.id if isinstance(user, User) else user
    job = await _take_down(db, site, reason, {"deleted_at": at, "deleted_by": by,
                                              "deleted_slug": site.get("slug")})
    await db[REVIEWS].update_many({"site_id": site["_id"], "status": "open"},
                                  {"$set": {"status": "withdrawn", "decided_by": by, "decided_at": at,
                                            "comment": "Site deleted."}})
    await db[PAGES].update_many({"site_id": site["_id"]}, {"$set": {"lock": None}})
    # Queued builds and restores were failed by _take_down; a queued import would fill a deleted site.
    await db[JOBS].update_many({"site_id": site["_id"], "kind": "import", "status": "queued"},
                               {"$set": {"status": "failed", "error": "Site deleted.", "updated_at": at}})
    # Its readers' insights go with it (services/guide_insights.py).
    from app.services import guide_insights

    try:
        await guide_insights.clear(db, str(site["_id"]))
    except Exception:
        log.warning("deleting insights of guide %s failed", site["_id"], exc_info=True)
    return job


async def delete_workspace_sites(db: AsyncIOMotorDatabase, workspace_id: str, actor_id: str | None) -> int:
    """A workspace is being deleted: every docs site in it is deleted the same way (soft-deleted,
    its builds stopped, its addresses taken down by the unpublish job). Returns how many."""
    n = 0
    async for site in db[SITES].find({"workspace_id": workspace_id, "deleted_at": None}):
        await delete_site(db, site, actor_id, reason="workspace_deleted")
        n += 1
    return n
