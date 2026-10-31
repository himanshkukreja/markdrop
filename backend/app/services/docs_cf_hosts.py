"""Free docs addresses on Cloudflare: ``<slug>.<docs_sites_domain>`` as Workers Custom Domains.

Cloudflare's free Universal SSL covers ``markdrop.in`` and ``*.markdrop.in`` only, not two-level
names like ``acme.docs.markdrop.in``. So each site's free address is attached to the docs edge
Worker (MARKDROP_DOCS_CF_WORKER, "markdrop-docs-edge") as a Workers Custom Domain, which creates
the DNS record and a per-host certificate. The edge still maps the host to a site through R2
(``hosts/<host>.json``, written at publish); the custom domain only gets the request there.

Cloudflare API (developers.cloudflare.com/api/resources/workers/subresources/domains/):
  list    GET    /accounts/{account}/workers/domains?hostname=<host>
  attach  PUT    /accounts/{account}/workers/domains  {hostname, service, zone_name}
  detach  DELETE /accounts/{account}/workers/domains/{domain_id}
(The body's ``environment`` field is deprecated in the current reference, so it isn't sent.)

On only when MARKDROP_DOCS_CF_API_TOKEN and MARKDROP_DOCS_CF_ACCOUNT_ID are set and
MARKDROP_DOCS_SITE_HOST_TEMPLATE is blank (production addresses; a preview template means nothing
is attached). Never touches anything but a single label under docs_sites_domain that a site could
own: ``markdrop.in``, ``www``, ``api``, ``docs.markdrop.in`` itself, reserved labels, deeper names
and foreign names are refused before any call.

The site row records what was attached here: ``cf_hosts`` (every host attached and not yet
detached), and ``cf_host_attached`` / ``cf_host_slug`` (the current free address, once attached:
publishes skip the call then, and the dashboard's ``address_ready`` reads it). Changes run as
``cf_host`` server jobs (inline in the API, like restore / unpublish / access), so a failed call is
retried by the job sweeper; the sweeper also re-queues a site whose record and wanted state differ.

What a site should have attached (``desired_hosts``): nothing once deleted; else the address its
live build serves (until a build at a new slug replaces it) and its current slug's address while it
is live or a publish of it is on its way.
"""

from __future__ import annotations

import logging
import re
from datetime import timedelta
from typing import Any, Iterable

import httpx
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.services.docs_jobs import BUILDS, JOBS, SITES, SNAPSHOTS, get_jobs_settings, now, oid

log = logging.getLogger(__name__)

API = "https://api.cloudflare.com/client/v4"
TIMEOUT = httpx.Timeout(10.0, connect=5.0)
RETRY_AFTER = timedelta(minutes=10)  # the sweeper's wait after a cf_host job before queueing another
_ID = re.compile(r"[A-Za-z0-9-]{1,64}")
# Tests set this to an httpx.MockTransport (nothing here ever reaches the network then).
_TRANSPORT: httpx.AsyncBaseTransport | None = None


class CfHostError(Exception):
    """A passing failure (network, a 5xx, a refused token): the job is retried."""


class CfHostRefused(ValueError):
    """A hostname this module must never touch, or one attached to another Worker: never retried."""


# ── settings ────────────────────────────────────────────────────────────────


def configured() -> bool:
    s = get_jobs_settings()
    return bool(s.docs_cf_api_token and s.docs_cf_account_id)


def enabled() -> bool:
    """Attach and detach free addresses: configured, and production addresses (no host template)."""
    return configured() and not get_jobs_settings().docs_site_host_template


def free_host(slug: str) -> str:
    return f"{slug}.{get_settings().docs_sites_domain}".lower()


def host_problem(host: Any) -> str | None:
    """Why ``host`` may not be attached or detached here (None: it may)."""
    from app.services.docs_site_store import RESERVED_SLUGS

    if not isinstance(host, str) or not host:
        return "not a hostname"
    domain = (get_settings().docs_sites_domain or "").strip().lower()
    zone = (get_jobs_settings().docs_cf_zone_name or "").strip().lower()
    if not domain or not zone or not domain.endswith("." + zone):
        return "docs_sites_domain isn't a subdomain of the Cloudflare zone"
    m = re.fullmatch(r"([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\." + re.escape(domain), host)
    if not m:
        return f"not a single label under {domain}"
    if m.group(1) in RESERVED_SLUGS:
        return "a reserved name"
    return None


def checked(host: Any) -> str:
    """``host`` (lowercased) when it may be touched; CfHostRefused otherwise (logged)."""
    h = host.lower() if isinstance(host, str) else host
    problem = host_problem(h)
    if problem:
        log.warning("docs cf hosts: refused %r: %s", host, problem)
        raise CfHostRefused(f"refused {host!r}: {problem}")
    return h


# ── Cloudflare API ──────────────────────────────────────────────────────────


def _client() -> httpx.AsyncClient:
    s = get_jobs_settings()
    return httpx.AsyncClient(base_url=API, timeout=TIMEOUT, transport=_TRANSPORT, headers={
        "authorization": f"Bearer {s.docs_cf_api_token}", "user-agent": "markdrop-docs-hosts"})


def _account() -> str:
    acct = get_jobs_settings().docs_cf_account_id
    if not _ID.fullmatch(acct or ""):
        raise CfHostRefused("MARKDROP_DOCS_CF_ACCOUNT_ID doesn't look like an account id")
    return acct


def _errors(body: Any) -> str:
    errs = body.get("errors") if isinstance(body, dict) else None
    if not isinstance(errs, list) or not errs:
        return "no details"
    return "; ".join(f"{(e or {}).get('code')}: {str((e or {}).get('message'))[:120]}" for e in errs[:3]
                     if isinstance(e, dict)) or "no details"


async def _call(c: httpx.AsyncClient, method: str, path: str, *, ok_404: bool = False, **kw) -> Any:
    try:
        r = await c.request(method, path, **kw)
    except httpx.HTTPError as e:
        raise CfHostError(f"Cloudflare unreachable ({type(e).__name__})") from None
    if ok_404 and r.status_code == 404:
        return None
    try:
        body = r.json()
    except ValueError:
        body = None
    if r.status_code >= 400 or not isinstance(body, dict) or body.get("success") is False:
        raise CfHostError(f"Cloudflare {method} {r.status_code}: {_errors(body)}"[:400])
    return body.get("result")


async def _find(c: httpx.AsyncClient, host: str) -> list[dict]:
    """The custom domains for exactly ``host`` (the filter is checked again here)."""
    res = await _call(c, "GET", f"/accounts/{_account()}/workers/domains", params={"hostname": host})
    return [d for d in (res if isinstance(res, list) else [])
            if isinstance(d, dict) and str(d.get("hostname") or "").lower() == host]


async def ensure_host(host: str) -> dict:
    """Attach ``host`` to the docs edge Worker unless it already is. Idempotent. A host attached to
    another Worker is left alone (CfHostRefused). No-op without a token or account."""
    host = checked(host)
    if not configured():
        log.debug("docs cf hosts: not configured, %s not attached", host)
        return {"host": host, "skipped": "not configured"}
    s = get_jobs_settings()
    async with _client() as c:
        found = await _find(c, host)
        mine = [d for d in found if d.get("service") == s.docs_cf_worker]
        if mine:
            return {"host": host, "attached": False, "id": mine[0].get("id")}
        if found:
            raise CfHostRefused(f"{host} is attached to another Worker ({found[0].get('service')})")
        res = await _call(c, "PUT", f"/accounts/{_account()}/workers/domains", json={
            "hostname": host, "service": s.docs_cf_worker, "zone_name": s.docs_cf_zone_name})
    log.info("docs cf hosts: attached %s to %s", host, s.docs_cf_worker)
    return {"host": host, "attached": True, "id": (res or {}).get("id") if isinstance(res, dict) else None}


async def drop_host(host: str) -> dict:
    """Detach ``host`` from the docs edge Worker if it is attached there (never another Worker's).
    Idempotent. No-op without a token or account."""
    host = checked(host)
    if not configured():
        log.debug("docs cf hosts: not configured, %s not detached", host)
        return {"host": host, "skipped": "not configured"}
    s = get_jobs_settings()
    n = 0
    async with _client() as c:
        for d in await _find(c, host):
            did = str(d.get("id") or "")
            if d.get("service") != s.docs_cf_worker or not _ID.fullmatch(did):
                continue
            await _call(c, "DELETE", f"/accounts/{_account()}/workers/domains/{did}", ok_404=True)
            n += 1
    if n:
        log.info("docs cf hosts: detached %s", host)
    return {"host": host, "detached": n}


# ── sites ───────────────────────────────────────────────────────────────────


async def _live_slug(db: AsyncIOMotorDatabase, site: dict) -> str | None:
    """The slug the site's live build was published at."""
    bid = site.get("live_build_id")
    build = await db[BUILDS].find_one({"_id": bid}, {"snapshot_id": 1}) if bid else None
    if not build or not build.get("snapshot_id"):
        return None
    snap = await db[SNAPSHOTS].find_one({"_id": build["snapshot_id"]}, {"site.slug": 1})
    return ((snap or {}).get("site") or {}).get("slug")


async def _publish_pending(db: AsyncIOMotorDatabase, site: dict) -> bool:
    """A build of the site is queued or running, asked for after its last take-down."""
    q: dict = {"site_id": site["_id"], "kind": "build", "status": {"$in": ["queued", "running"]}}
    if site.get("taken_down_at"):
        q["created_at"] = {"$gt": site["taken_down_at"]}
    return await db[JOBS].find_one(q, {"_id": 1}) is not None


async def desired_hosts(db: AsyncIOMotorDatabase, site: dict | None) -> set[str]:
    if not site or site.get("deleted_at") or not site.get("slug"):
        return set()
    out: set[str] = set()
    live = site.get("status") == "live"
    if live or await _publish_pending(db, site):
        out.add(free_host(site["slug"]))
    if live:
        old = await _live_slug(db, site)
        if old:
            out.add(free_host(old))
    return {h for h in out if host_problem(h) is None}


async def reconcile(db: AsyncIOMotorDatabase, site_id: Any, hosts: Iterable[str] = ()) -> dict:
    """The ``cf_host`` job: attach what the site should have, detach the rest of what it recorded
    (and ``hosts``, addresses it may have had). CfHostError after the pass when any call failed."""
    if not enabled():
        return {"skipped": "free addresses on Cloudflare are off"}
    site = await db[SITES].find_one({"_id": oid(site_id)}, {
        "slug": 1, "status": 1, "deleted_at": 1, "live_build_id": 1, "taken_down_at": 1, "cf_hosts": 1})
    want = await desired_hosts(db, site)
    recorded = {h for h in (site or {}).get("cf_hosts") or [] if isinstance(h, str)}
    extra = {h.lower() for h in hosts or [] if isinstance(h, str)}
    attached, detached, refused, failed = [], [], [], []
    for h in sorted(recorded | extra | want):
        if host_problem(h):
            refused.append(h)
            if h in recorded:
                await db[SITES].update_one({"_id": oid(site_id)}, {"$pull": {"cf_hosts": h}})
            continue
        try:
            if h in want:
                if h not in recorded:
                    await ensure_host(h)
                    await db[SITES].update_one({"_id": oid(site_id)}, {"$addToSet": {"cf_hosts": h}})
                    attached.append(h)
            else:
                res = await drop_host(h)
                await db[SITES].update_one({"_id": oid(site_id)}, {"$pull": {"cf_hosts": h}})
                if res.get("detached"):
                    detached.append(h)
        except CfHostRefused as e:
            refused.append(h)
            log.warning("docs site %s: %s", site_id, e)
        except CfHostError as e:
            failed.append(f"{h}: {e}")
    await _record_current(db, site_id)
    if failed:
        raise CfHostError("; ".join(failed)[:1500])
    return {"attached": attached, "detached": detached, "refused": refused}


async def _record_current(db: AsyncIOMotorDatabase, site_id: Any) -> None:
    """``cf_host_attached`` / ``cf_host_slug``: the current slug's address when it is attached."""
    site = await db[SITES].find_one({"_id": oid(site_id)}, {"slug": 1, "deleted_at": 1, "cf_hosts": 1})
    if site is None:
        return
    slug = site.get("slug")
    if slug and not site.get("deleted_at") and free_host(slug) in (site.get("cf_hosts") or []):
        await db[SITES].update_one({"_id": site["_id"], "slug": slug},
                                   {"$set": {"cf_host_attached": free_host(slug), "cf_host_slug": slug}})
    else:
        await db[SITES].update_one({"_id": site["_id"]}, {"$unset": {"cf_host_attached": "", "cf_host_slug": ""}})


async def queue(db: AsyncIOMotorDatabase, site_id: Any, reason: str, hosts: Iterable[str | None] = ()) -> dict | None:
    """Queue the site's ``cf_host`` job (``hosts``: addresses it may have had, to detach unless still
    wanted). Nothing when the feature is off. Never fails the caller."""
    if not enabled():
        return None
    from app.services.docs_site_jobs import enqueue_job

    try:
        return await enqueue_job(db, "cf_host", site_id, {
            "reason": reason, "hosts": [h.lower() for h in hosts if isinstance(h, str) and h]})
    except Exception:  # pragma: no cover - a queue hiccup must not fail a publish or a delete
        log.warning("docs site %s: couldn't queue the address job", site_id, exc_info=True)
        return None


async def queue_for_publish(db: AsyncIOMotorDatabase, site: dict) -> dict | None:
    """A publish was queued: attach the site's address now unless it already is, so its certificate
    is ready by the time the build goes live."""
    slug = site.get("slug")
    if not enabled() or not slug or site.get("cf_host_attached") == free_host(slug):
        return None
    return await queue(db, site["_id"], "publish")


async def queue_for_slug(db: AsyncIOMotorDatabase, site_id: Any, old_slug: str | None) -> dict | None:
    """The site moved to a new slug: the old address is detached unless its live build still serves
    there (then when a build at the new slug goes live), the new one attached if the site is live."""
    return await queue(db, site_id, "slug", [free_host(old_slug)] if old_slug else [])


def address_ready(site: dict) -> bool:
    """Whether the site's free address is attached on Cloudflare (always True when this module
    doesn't manage addresses: a preview host, or no token)."""
    if not enabled():
        return True
    slug = site.get("slug")
    return bool(slug) and site.get("cf_host_attached") == free_host(slug)


async def requeue_pending(db: AsyncIOMotorDatabase) -> int:
    """The sweeper's pass (services/docs_dispatch.run_once): a site whose recorded addresses differ
    from what it should have gets its ``cf_host`` job again, unless one is waiting or running, or one
    ran less than RETRY_AFTER ago."""
    if not enabled():
        return 0
    t = now()
    queued = 0
    rows = db[SITES].find({"$or": [
        # Recorded addresses on a site that may not want them all any more.
        {"cf_hosts.0": {"$exists": True}, "$or": [
            {"deleted_at": {"$ne": None}}, {"status": {"$ne": "live"}}, {"cf_hosts.1": {"$exists": True}}]},
        # A live site whose current address isn't attached.
        {"status": "live", "deleted_at": None, "slug": {"$type": "string"},
         "$expr": {"$ne": [{"$ifNull": ["$cf_host_slug", None]}, "$slug"]}},
    ]}, {"slug": 1, "status": 1, "deleted_at": 1, "live_build_id": 1, "taken_down_at": 1, "cf_hosts": 1}).limit(200)
    async for site in rows:
        if await desired_hosts(db, site) == set(site.get("cf_hosts") or []):
            continue
        recent = await db[JOBS].find_one({"kind": "cf_host", "site_id": site["_id"], "$or": [
            {"status": {"$in": ["queued", "running"]}}, {"updated_at": {"$gt": t - RETRY_AFTER}}]}, {"_id": 1})
        if recent is None and await queue(db, site["_id"], "retry") is not None:
            queued += 1
    return queued
