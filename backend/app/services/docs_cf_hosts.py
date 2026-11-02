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
detached), and ``cf_host_attached`` / ``cf_host_slug`` / ``cf_host_attached_at`` (the current free
address, once attached: publishes skip the call then). Changes run as
``cf_host`` server jobs (inline in the API, like restore / unpublish / access), so a failed call is
retried by the job sweeper; the sweeper also re-queues a site whose record and wanted state differ.

What a site should have attached (``desired_hosts``): nothing once deleted; else the address its
live build serves (until a build at a new slug replaces it) and its current slug's address while it
is live or a publish of it is on its way.

Attached isn't open: Cloudflare issues the host's certificate a minute or three after the attach,
and until then browsers fail the handshake (ERR_SSL_VERSION_OR_CIPHER_MISMATCH). So the studio's
``address_state`` (:func:`check_address`) is "ready" only once a TLS handshake with the host, made
the way a reader's browser makes it (SNI, certificate verified), has succeeded: probed from here
while the address is attached but not confirmed (one probe per host every PROBE_EVERY seconds at
most, the last answer in between), then recorded on the row (``cf_host_ready`` = the host,
``cf_host_ready_at``) and never probed again until the host is attached anew. "securing" until then
(also while a live guide's attach is on its way), "pending" before any publish. Rows attached before
the attach time was recorded, and an address still unconfirmed SECURING_GIVE_UP after its attach
(this server can't reach it, say), count as ready, so the studio never says "Securing" for good.
The certificate isn't read from Cloudflare's API: a Workers Custom Domain only names a ``cert_id``,
reading the certificate needs an SSL permission the token doesn't have, and the handshake is
exactly what readers get.
"""

from __future__ import annotations

import asyncio
import logging
import re
import ssl
import time
from datetime import timedelta
from typing import Any, Awaitable, Callable, Iterable

import httpx
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.services.docs_jobs import BUILDS, JOBS, SITES, SNAPSHOTS, aware, get_jobs_settings, now, oid

log = logging.getLogger(__name__)

API = "https://api.cloudflare.com/client/v4"
TIMEOUT = httpx.Timeout(10.0, connect=5.0)
RETRY_AFTER = timedelta(minutes=10)  # the sweeper's wait after a cf_host job before queueing another
_ID = re.compile(r"[A-Za-z0-9-]{1,64}")
# Tests set this to an httpx.MockTransport (nothing here ever reaches the network then).
_TRANSPORT: httpx.AsyncBaseTransport | None = None

# The address's certificate (check_address): a probe of one host at most this often (the studio
# polls every 10 s while it says "Securing"), how long a handshake may take, how long a view waits
# for a probe it started (the probe carries on and the next view reads its answer), and when an
# address still unconfirmed after its attach counts as ready anyway.
PROBE_EVERY = 10.0
PROBE_TIMEOUT = 4.0
PROBE_WAIT = 2.0
SECURING_GIVE_UP = timedelta(minutes=30)
# Tests set this to an async fake ``(host) -> bool`` (no handshake leaves the process then).
_PROBE: Callable[[str], Awaitable[bool]] | None = None
_probes: dict[str, tuple[float, bool]] = {}  # host → (time.monotonic(), handshake ok)
_probing: dict[str, asyncio.Task] = {}  # host → its probe in flight


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
    if attached:
        # A host attached (again) gets a new certificate: it is confirmed afresh.
        await db[SITES].update_one({"_id": oid(site_id), "cf_host_ready": {"$in": attached}},
                                   {"$unset": {"cf_host_ready": "", "cf_host_ready_at": ""}})
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
        host = free_host(slug)
        # Only when it changes: ``cf_host_attached_at`` is when this address was attached.
        await db[SITES].update_one({"_id": site["_id"], "slug": slug, "cf_host_attached": {"$ne": host}},
                                   {"$set": {"cf_host_attached": host, "cf_host_slug": slug, "cf_host_attached_at": now()}})
    else:
        await db[SITES].update_one({"_id": site["_id"]}, {"$unset": {
            "cf_host_attached": "", "cf_host_slug": "", "cf_host_attached_at": "", "cf_host_ready": "", "cf_host_ready_at": ""}})


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


# ── the address's certificate ───────────────────────────────────────────────

READY, SECURING, PENDING = "ready", "securing", "pending"


def address_state(site: dict) -> str:
    """What the row alone says about the site's free address (no probe): "ready" (its certificate
    is confirmed; always where this module doesn't manage addresses: a preview host, or no token),
    "securing" (attached and the certificate not confirmed yet, or a live guide's attach on its way)
    or "pending" (not attached and the guide isn't live: before its first publish)."""
    if not enabled():
        return READY
    slug = site.get("slug")
    if not slug:
        return PENDING
    host = free_host(slug)
    if site.get("cf_host_attached") != host:
        return SECURING if site.get("status") == "live" and not site.get("deleted_at") else PENDING
    if site.get("cf_host_ready") == host:
        return READY
    at = aware(site.get("cf_host_attached_at"))
    if at is None or now() - at > SECURING_GIVE_UP:
        return READY  # attached before the time was recorded, or this server can't confirm it
    return SECURING


def address_ready(site: dict) -> bool:
    """The site's free address opens for readers (its certificate is confirmed), from the row alone."""
    return address_state(site) == READY


async def tls_handshake(host: str) -> bool:
    """A TLS handshake with ``host`` on 443 as a browser makes it (SNI, the certificate verified
    against the public roots) succeeds within PROBE_TIMEOUT. Nothing is sent after it."""
    try:
        import certifi

        ctx = ssl.create_default_context(cafile=certifi.where())
    except Exception:  # pragma: no cover - certifi comes with httpx
        ctx = ssl.create_default_context()
    writer = None
    try:
        _, writer = await asyncio.wait_for(asyncio.open_connection(
            host, 443, ssl=ctx, server_hostname=host, ssl_handshake_timeout=PROBE_TIMEOUT), PROBE_TIMEOUT)
        return True
    except (OSError, ssl.SSLError, asyncio.TimeoutError, ValueError):
        return False
    finally:
        if writer is not None:
            writer.close()
            try:
                await asyncio.wait_for(writer.wait_closed(), 1.0)
            except Exception:
                pass


async def _run_probe(host: str) -> bool:
    try:
        ok = bool(await (_PROBE or tls_handshake)(host))
    except Exception:  # pragma: no cover - a probe never fails a view
        log.debug("docs cf hosts: probe of %s failed", host, exc_info=True)
        ok = False
    _probes[host] = (time.monotonic(), ok)
    return ok


def _forget(host: str, task: asyncio.Task) -> None:
    if _probing.get(host) is task:
        _probing.pop(host, None)


async def probe(host: str) -> bool:
    """Whether ``host`` serves its certificate (:func:`tls_handshake`): at most one probe of a host
    per PROBE_EVERY seconds (the last answer in between), one at a time. Waits up to PROBE_WAIT for
    the probe: False when it takes longer (it finishes anyway, and the next call reads its answer)."""
    host = checked(host)
    hit = _probes.get(host)
    if hit and time.monotonic() - hit[0] < PROBE_EVERY:
        return hit[1]
    task = _probing.get(host)
    if task is None or task.done():
        task = asyncio.get_running_loop().create_task(_run_probe(host))
        _probing[host] = task
        task.add_done_callback(lambda t, h=host: _forget(h, t))
    try:
        return await asyncio.wait_for(asyncio.shield(task), PROBE_WAIT)
    except asyncio.TimeoutError:
        return False


async def check_address(db: AsyncIOMotorDatabase, site: dict) -> str:
    """:func:`address_state`, with the certificate probed while the address is attached but not
    confirmed. A successful probe is recorded on the row (``cf_host_ready``), so the address isn't
    probed again until it is attached anew."""
    state = address_state(site)
    host = free_host(site["slug"]) if site.get("slug") else None
    if state != SECURING or not host or site.get("cf_host_attached") != host:
        return state
    try:
        ok = await probe(host)
    except CfHostRefused:
        return state
    if not ok:
        return SECURING
    t = now()
    await db[SITES].update_one({"_id": site["_id"], "cf_host_attached": host},
                               {"$set": {"cf_host_ready": host, "cf_host_ready_at": t}})
    site["cf_host_ready"], site["cf_host_ready_at"] = host, t
    log.info("docs cf hosts: %s serves its certificate", host)
    return READY


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
