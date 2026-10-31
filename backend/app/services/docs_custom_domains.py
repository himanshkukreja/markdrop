"""A guide on the customer's own domain: Cloudflare for SaaS custom hostnames.

The customer adds one record, ``help.acme.com CNAME <docs_custom_domain_target>`` (default
``cname.guides.markdrop.in``, the fallback origin record the owner creates once). Here the API
registers ``help.acme.com`` as a **custom hostname** on the markdrop.in zone (Cloudflare for SaaS,
free for the first 100). Once the CNAME is in place Cloudflare validates the hostname by it (real-time
validation) and issues a certificate by HTTP DCV, which it answers itself at the edge, so the
customer adds nothing else. Requests then reach the docs edge Worker through its ``*/*`` route on the
zone (Markdrop's own names are excluded by a Worker-less ``*markdrop.in/*`` route), and the Worker
maps the host to the site through R2 (``hosts/<host>.json``) like every other address. Owner setup and
the docs links: docs-platform/README.md, "Own domains (Cloudflare for SaaS)".

Cloudflare API (developers.cloudflare.com/api/resources/custom_hostnames/):
  find    GET    /zones/{zone}/custom_hostnames?hostname=<host>
  read    GET    /zones/{zone}/custom_hostnames/{id}
  create  POST   /zones/{zone}/custom_hostnames      {hostname, ssl: {method: "http", type: "dv"}}
  nudge   PATCH  /zones/{zone}/custom_hostnames/{id} {ssl: …}  (the same settings: resets Cloudflare's
          validation backoff, what "Re-check" does)
  delete  DELETE /zones/{zone}/custom_hostnames/{id}
A hostname serves once ``status`` and ``ssl.status`` are both ``active``.

The site row keeps ``domains``: at most MAX_PER_SITE entries, a host unique across every guide (the
``domain_host_unique`` index), each

    {host, status: pending | live | failed | removing, stage: dns | certificate (pending),
     message (Cloudflare's words, or ours), records [{type, name, value, purpose, optional}],
     cf_id, added_at, added_by, pending_since, checks, checked_at, next_check_at, live_at, removed_by,
     was_live}

- **pending**: the ``domain`` server job creates the hostname (idempotent: an existing one for the
  host is adopted) and reads its state; the sweeper (services/docs_dispatch.run_once →
  :func:`requeue_due`) checks again on a backoff (1, 2, 5, 10, 15, 30 minutes, then hourly). After
  GIVE_UP_AFTER without going live it is **failed**: the hostname is deleted on Cloudflare (it would
  count against the free 100) and the message says what to fix. "Re-check" on a failed one starts
  over.
- **live**: the host is mapped to the site in R2 when the site is live (never over another site's
  mapping), and it is one of the site's hosts from then on (docs_snapshot.site_hosts: the build
  spec's hosts, the canonical URL, sitemap, llms.txt and OG cards, sign-in grants, CORS). The live
  version is published again (same snapshot) so its links switch to the domain now rather than at
  the next publish.
- **removing**: the job deletes the hostname and the site's R2 mapping, then drops the entry (and
  publishes the live version again, so the canonical falls back to the free address). A deleted
  guide's domains all go this way.

Safety, like docs_cf_hosts: :func:`host_problem` refuses Markdrop's own names (anything ending in
``markdrop.in``, the zone, the docs domain, the target, the app's hosts), IP addresses, single
labels, root domains, reserved and platform suffixes, before any call; every Cloudflare result is
checked to be the host asked about before it is changed or deleted; the token is never logged. Off
(a clear "not available" in the API, nothing queued) while MARKDROP_DOCS_CF_API_TOKEN or
MARKDROP_DOCS_CF_ZONE_ID is blank.
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import re
from datetime import timedelta
from typing import Any, Iterable
from urllib.parse import urlparse

import httpx
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.services.docs_jobs import BUILDS, JOBS, SITES, SNAPSHOTS, aware, get_jobs_settings, now, oid

log = logging.getLogger(__name__)

API = "https://api.cloudflare.com/client/v4"
TIMEOUT = httpx.Timeout(10.0, connect=5.0)
MAX_PER_SITE = 2
GIVE_UP_AFTER = timedelta(hours=72)
# The sweeper's waits between checks of a pending domain (then the last one, until GIVE_UP_AFTER).
CHECK_STEPS = (timedelta(minutes=1), timedelta(minutes=2), timedelta(minutes=5), timedelta(minutes=10),
               timedelta(minutes=15), timedelta(minutes=30), timedelta(hours=1))
RETRY_AFTER = timedelta(minutes=10)  # a removal whose job failed: queued again after this long
SSL = {"method": "http", "type": "dv", "settings": {"min_tls_version": "1.2"}}

PENDING, LIVE, FAILED, REMOVING = "pending", "live", "failed", "removing"
_ID = re.compile(r"[A-Za-z0-9-]{1,64}")
_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
_TLD = re.compile(r"(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})")
# Never a guide's domain: Markdrop's own (any name ending in markdrop.in, which the Worker-less
# exclusion route `*markdrop.in/*` also matches), special-use names, and platform suffixes whose
# subdomains belong to other people.
MARKDROP_SUFFIX = "markdrop.in"
BLOCKED_SUFFIXES = (
    "localhost", "local", "internal", "intranet", "lan", "home", "corp", "test", "example", "invalid", "onion",
    "arpa", "example.com", "example.net", "example.org", "workers.dev", "pages.dev", "r2.dev",
    "cloudflare.com", "cloudflare.net", "cloudflare-dns.com", "cloudflareaccess.com", "vercel.app",
    "vercel.com", "netlify.app", "github.io", "gitbook.io", "herokuapp.com", "fly.dev", "onrender.com",
    "azurewebsites.net", "amazonaws.com", "cloudfront.net", "appspot.com", "web.app", "firebaseapp.com",
    "googleusercontent.com", "ngrok.io", "ngrok-free.app", "trycloudflare.com",
)
# Second-level labels under which a name of three labels is still a root domain (acme.co.uk).
_SLD = frozenset({"co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "gv", "ltd", "plc", "me", "nic"})

# Tests set this to an httpx.MockTransport (nothing here ever reaches the network then).
_TRANSPORT: httpx.AsyncBaseTransport | None = None


class DomainError(Exception):
    """A passing failure (network, a 5xx, a refused token): checked again later."""


class DomainRefused(ValueError):
    """A hostname this module must never send to Cloudflare."""


# ── settings ────────────────────────────────────────────────────────────────


def configured() -> bool:
    s = get_jobs_settings()
    return bool(s.docs_cf_api_token and _ID.fullmatch(s.docs_cf_zone_id or "") and target())


def target() -> str:
    """The CNAME target customers point at (the fallback origin record)."""
    return (get_jobs_settings().docs_custom_domain_target or "").strip().lower().rstrip(".")


# ── hostnames ───────────────────────────────────────────────────────────────


def clean(raw: Any) -> str:
    """What was typed → a bare lowercase hostname (scheme, path, port and trailing dot dropped).
    Never raises; :func:`host_problem` says whether the result may be used."""
    v = str(raw or "").strip().lower()
    if "://" in v:
        v = urlparse(v).hostname or ""
    v = v.split("/")[0].split("?")[0].split("#")[0]
    if v.startswith("["):
        return v  # an IPv6 literal: refused by host_problem
    return v.split(":")[0].rstrip(".")


def _ends_with(host: str, suffix: str) -> bool:
    return bool(suffix) and (host == suffix or host.endswith("." + suffix))


def is_root(host: str) -> bool:
    """A registrable (root) domain, as far as a short list can tell: acme.com, acme.co.uk."""
    labels = host.split(".")
    return len(labels) == 2 or (len(labels) == 3 and labels[1] in _SLD and len(labels[2]) == 2)


def host_problem(host: Any) -> str | None:
    """Why ``host`` can't be a guide's domain, in words for the person who typed it (None: it can)."""
    if not isinstance(host, str) or not host:
        return "Enter a domain, like help.yourcompany.com."
    if len(host) > 253:
        return "That domain is too long."
    try:
        ipaddress.ip_address(host.strip("[]"))
        return "Use a domain name, not an IP address."
    except ValueError:
        pass
    labels = host.split(".")
    if len(labels) < 2:
        return "Enter a full domain, like help.yourcompany.com."
    if not all(_LABEL.fullmatch(lbl) for lbl in labels):
        return ("That doesn't look like a domain. Use letters, numbers, dots and hyphens "
                "(an international name in its xn-- form).")
    if not _TLD.fullmatch(labels[-1]):
        return "That domain doesn't end in a real top-level domain."
    s = get_jobs_settings()
    ours = [MARKDROP_SUFFIX, (s.docs_cf_zone_name or "").strip().lower(), target(),
            (get_settings().docs_sites_domain or "").strip().lower()]
    for url in (get_settings().frontend_url, get_settings().api_base_url, getattr(get_settings(), "artifact_origin", "")):
        ours.append((urlparse(url).hostname or "").lower() if url else "")
    if host.endswith(MARKDROP_SUFFIX) or any(_ends_with(host, o) for o in ours if o):
        return "Markdrop's own addresses can't be added. Use a domain your company owns."
    if any(_ends_with(host, b) for b in BLOCKED_SUFFIXES):
        return "That domain can't be used for a guide. Use a domain your company owns."
    if is_root(host):
        return (f"Use a subdomain, like help.{host}. A root domain can't point a CNAME record at "
                "Markdrop yet.")
    return None


def checked(host: Any) -> str:
    """``host`` when it may be sent to Cloudflare; DomainRefused otherwise (logged)."""
    problem = host_problem(host)
    if problem:
        log.warning("docs custom domains: refused %r: %s", host, problem)
        raise DomainRefused(problem)
    return host


# ── Cloudflare API ──────────────────────────────────────────────────────────


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=API, timeout=TIMEOUT, transport=_TRANSPORT, headers={
        "authorization": f"Bearer {get_jobs_settings().docs_cf_api_token}", "user-agent": "markdrop-docs-domains"})


def _zone() -> str:
    z = get_jobs_settings().docs_cf_zone_id
    if not _ID.fullmatch(z or ""):
        raise DomainRefused("MARKDROP_DOCS_CF_ZONE_ID doesn't look like a zone id")
    return z


def _errors(body: Any) -> str:
    errs = body.get("errors") if isinstance(body, dict) else None
    if not isinstance(errs, list) or not errs:
        return "no details"
    return "; ".join(f"{(e or {}).get('code')}: {str((e or {}).get('message'))[:160]}" for e in errs[:3]
                     if isinstance(e, dict)) or "no details"


async def _call(c: httpx.AsyncClient, method: str, path: str, *, ok_404: bool = False, **kw) -> Any:
    try:
        r = await c.request(method, path, **kw)
    except httpx.HTTPError as e:
        raise DomainError(f"Cloudflare unreachable ({type(e).__name__})") from None
    if ok_404 and r.status_code == 404:
        return None
    try:
        body = r.json()
    except ValueError:
        body = None
    if r.status_code >= 400 or not isinstance(body, dict) or body.get("success") is False:
        raise DomainError(f"Cloudflare {method} {r.status_code}: {_errors(body)}"[:400])
    return body.get("result")


def _mine(r: Any, host: str) -> dict | None:
    """``r`` when it is a custom hostname record for exactly ``host`` with a usable id."""
    if isinstance(r, dict) and str(r.get("hostname") or "").lower() == host and _ID.fullmatch(str(r.get("id") or "")):
        return r
    return None


async def cf_find(c: httpx.AsyncClient, host: str) -> dict | None:
    host = checked(host)
    res = await _call(c, "GET", f"/zones/{_zone()}/custom_hostnames", params={"hostname": host})
    for r in res if isinstance(res, list) else []:
        if _mine(r, host):
            return r
    return None


async def cf_get(c: httpx.AsyncClient, host: str, cf_id: Any) -> dict | None:
    """The record ``cf_id`` if it is still ``host``'s, else the one Cloudflare has for ``host``."""
    host = checked(host)
    if isinstance(cf_id, str) and _ID.fullmatch(cf_id):
        r = _mine(await _call(c, "GET", f"/zones/{_zone()}/custom_hostnames/{cf_id}", ok_404=True), host)
        if r:
            return r
    return await cf_find(c, host)


async def cf_create(c: httpx.AsyncClient, host: str) -> dict:
    """Create ``host``'s custom hostname, or adopt the one Cloudflare already has (a retry, a race)."""
    host = checked(host)
    found = await cf_find(c, host)
    if found:
        return found
    try:
        res = await _call(c, "POST", f"/zones/{_zone()}/custom_hostnames", json={"hostname": host, "ssl": SSL})
    except DomainError:
        found = await cf_find(c, host)  # created meanwhile ("Duplicate custom hostname found")
        if found:
            return found
        raise
    r = _mine(res, host)
    if r is None:
        raise DomainError("Cloudflare answered the create with another hostname")
    log.info("docs custom domains: created %s", host)
    return r


async def cf_nudge(c: httpx.AsyncClient, host: str, r: dict) -> dict:
    """The same settings again: Cloudflare restarts validation now (its backoff resets)."""
    host = checked(host)
    if not _mine(r, host):
        return r
    res = await _call(c, "PATCH", f"/zones/{_zone()}/custom_hostnames/{r['id']}", json={"ssl": SSL})
    return _mine(res, host) or r


async def cf_delete(c: httpx.AsyncClient, host: str, cf_id: Any = None) -> bool:
    """Delete ``host``'s custom hostname (only a record that is ``host``'s). Idempotent."""
    host = checked(host)
    r = await cf_get(c, host, cf_id)
    if r is None:
        return False
    await _call(c, "DELETE", f"/zones/{_zone()}/custom_hostnames/{r['id']}", ok_404=True)
    log.info("docs custom domains: deleted %s", host)
    return True


# ── Cloudflare's state → ours ──────────────────────────────────────────────


def _record(type_: str, name: Any, value: Any, purpose: str, optional: bool) -> dict | None:
    if not isinstance(name, str) or not isinstance(value, str) or not name or not value:
        return None
    return {"type": type_, "name": name.lower().rstrip("."), "value": value[:300], "purpose": purpose,
            "optional": optional}


def records(host: str, r: dict | None = None) -> list[dict]:
    """What the customer adds: the CNAME, plus the TXT records Cloudflare can validate by instead
    (only needed when it can't see the CNAME, e.g. behind another proxy), when it gave them."""
    out = [{"type": "CNAME", "name": host, "value": target(), "purpose": "route", "optional": False}]
    if not isinstance(r, dict):
        return out
    ov = r.get("ownership_verification") or {}
    if isinstance(ov, dict) and str(ov.get("type") or "txt").lower() == "txt":
        rec = _record("TXT", ov.get("name"), ov.get("value"), "ownership", True)
        if rec:
            out.append(rec)
    for v in ((r.get("ssl") or {}).get("validation_records") or [])[:2]:
        if isinstance(v, dict):
            rec = _record("TXT", v.get("txt_name"), v.get("txt_value"), "certificate", True)
            if rec:
                out.append(rec)
    return out


_BLOCKED = ("blocked", "pending_blocked", "test_blocked")


def interpret(host: str, r: dict) -> dict:
    """{live, stage, message, blocked} for a custom hostname record."""
    status = str(r.get("status") or "")
    ssl = r.get("ssl") if isinstance(r.get("ssl"), dict) else {}
    ssl_status = str(ssl.get("status") or "")
    msgs = [str(m) for m in (r.get("verification_errors") or []) if m]
    msgs += [str((e or {}).get("message")) for e in (ssl.get("validation_errors") or [])
             if isinstance(e, dict) and (e or {}).get("message")]
    if status in _BLOCKED:
        return {"live": False, "blocked": True, "stage": "dns",
                "message": f"Cloudflare blocked {host} ({status}). Contact Markdrop support."}
    if status == "active" and ssl_status == "active":
        return {"live": True, "blocked": False, "stage": None, "message": None}
    stage = "certificate" if status == "active" else "dns"
    message = msgs[0][:300] if msgs else None
    if ssl_status.endswith("timed_out"):
        message = message or ("The certificate couldn't be issued. Check that the CNAME record is in place and "
                              "that no CAA record blocks Let's Encrypt or Google Trust Services.")
    return {"live": False, "blocked": False, "stage": stage, "message": message}


def next_wait(checks: int) -> timedelta:
    return CHECK_STEPS[min(max(checks, 0), len(CHECK_STEPS) - 1)]


# ── the site's entries ──────────────────────────────────────────────────────


def view(site: dict, *, details: bool) -> list[dict]:
    """The dashboard's view of the site's domains. The records (with Cloudflare's tokens) are for
    Guides admins only (``details``)."""
    out = []
    for d in site.get("domains") or []:
        if not isinstance(d, dict) or not d.get("host"):
            continue
        row = {"host": d["host"], "status": d.get("status") or PENDING, "stage": d.get("stage"),
               "message": d.get("message"), "added_at": aware(d.get("added_at")), "live_at": aware(d.get("live_at")),
               "checked_at": aware(d.get("checked_at")), "next_check_at": aware(d.get("next_check_at"))}
        if details:
            row["records"] = d.get("records") or records(d["host"])
        out.append(row)
    return out


def available() -> dict:
    """What the dashboard needs before a domain exists."""
    return {"available": configured(), "target": target(), "max": MAX_PER_SITE}


async def _set(db: AsyncIOMotorDatabase, site_id: Any, host: str, fields: dict, unset: Iterable[str] = ()) -> None:
    change: dict = {"$set": {f"domains.$.{k}": v for k, v in fields.items()}}
    if unset:
        change["$unset"] = {f"domains.$.{k}": "" for k in unset}
    await db[SITES].update_one({"_id": oid(site_id), "domains.host": host}, change)


async def _entry(db: AsyncIOMotorDatabase, site_id: Any, host: str) -> dict | None:
    site = await db[SITES].find_one({"_id": oid(site_id)}, {"domains": 1})
    return next((d for d in (site or {}).get("domains") or [] if d.get("host") == host), None)


async def add(db: AsyncIOMotorDatabase, site: dict, raw_host: Any, user_id: str | None) -> str:
    """A new pending domain on ``site`` and its job. Raises ValueError (a message for the person) or
    LookupError (the host is taken). Returns the host."""
    from pymongo.errors import DuplicateKeyError

    if not configured():
        raise PermissionError("Own domains aren't switched on for this Markdrop server yet.")
    host = clean(raw_host)
    problem = host_problem(host)
    if problem:
        raise ValueError(problem)
    mine = [d for d in site.get("domains") or [] if isinstance(d, dict)]
    if any(d.get("host") == host for d in mine):
        raise ValueError(f"{host} is already on this guide.")
    if len(mine) >= MAX_PER_SITE:
        raise ValueError(f"A guide can have {MAX_PER_SITE} domains. Remove one to add another.")
    if await db["domains"].find_one({"host": host}, {"_id": 1}):
        raise LookupError("A Markdrop workspace already uses that domain. Remove it there first.")
    t = now()
    entry = {"host": host, "status": PENDING, "stage": "dns", "message": None, "records": records(host),
             "cf_id": None, "added_at": t, "added_by": user_id, "pending_since": t, "checks": 0,
             "checked_at": None, "next_check_at": t, "live_at": None}
    try:
        res = await db[SITES].update_one(
            {"_id": site["_id"], "deleted_at": None, "domains.host": {"$ne": host},
             f"domains.{MAX_PER_SITE - 1}": {"$exists": False}},
            {"$push": {"domains": entry}, "$set": {"updated_at": t}})
    except DuplicateKeyError:
        raise LookupError("Another guide already uses that domain.") from None
    if not res.modified_count:
        raise ValueError("That domain couldn't be added. Reload and try again.")
    await queue(db, site["_id"], "add")
    return host


async def remove(db: AsyncIOMotorDatabase, site: dict, raw_host: Any, user_id: str | None) -> bool:
    """Mark the domain for removal and queue the job (without Cloudflare: removed here at once)."""
    host = clean(raw_host)
    d = next((d for d in site.get("domains") or [] if isinstance(d, dict) and d.get("host") == host), None)
    if d is None:
        return False
    if d.get("status") != REMOVING:
        await _set(db, site["_id"], host, {"status": REMOVING, "was_live": d.get("status") == LIVE,
                                           "removed_by": user_id, "next_check_at": now()})
    if configured():
        await queue(db, site["_id"], "remove")
    else:
        await _remove(db, site["_id"], host, cloudflare=False)
    return True


async def take_down(db: AsyncIOMotorDatabase, site: dict) -> None:
    """The guide was deleted: every domain goes (the names are free for another guide afterwards)."""
    hosts = [d["host"] for d in site.get("domains") or [] if isinstance(d, dict) and d.get("host")]
    if not hosts:
        return
    for h in hosts:
        await _set(db, site["_id"], h, {"status": REMOVING, "next_check_at": now()})
    if configured():
        await queue(db, site["_id"], "delete")
    else:
        for h in hosts:
            await _remove(db, site["_id"], h, cloudflare=False)


# ── the job ─────────────────────────────────────────────────────────────────


async def reconcile(db: AsyncIOMotorDatabase, site_id: Any, force: Iterable[str] = ()) -> dict:
    """The ``domain`` job: remove what is being removed, create / check what is pending and due
    (``force``: hosts to check now, a failed one started over). DomainError after the pass when a
    removal failed (the job is retried); a failed check is just checked again later."""
    if not configured():
        return {"skipped": "own domains are off"}
    site = await db[SITES].find_one({"_id": oid(site_id)})
    if site is None:
        return {"skipped": "no such site"}
    force = {clean(h) for h in force or [] if isinstance(h, str)}
    t = now()
    out: dict = {"live": [], "removed": [], "checked": [], "failed": []}
    errors: list[str] = []
    for d in list(site.get("domains") or []):
        host = d.get("host") if isinstance(d, dict) else None
        if not host:
            continue
        try:
            if site.get("deleted_at") or d.get("status") == REMOVING:
                await _remove(db, site["_id"], host)
                out["removed"].append(host)
                continue
            due = aware(d.get("next_check_at")) or t
            if host in force or (d.get("status") == PENDING and due <= t):
                state = await _check(db, site, d, force=host in force)
                out[{"live": "live", "failed": "failed"}.get(state, "checked")].append(host)
        except DomainRefused as e:
            # Can't happen for an entry add() let in, unless the rules changed since: it stays put
            # (never sent anywhere) and says why.
            await _set(db, site["_id"], host, {"status": FAILED, "stage": None, "message": str(e), "checked_at": t})
            out["failed"].append(host)
        except DomainError as e:
            errors.append(f"{host}: {e}")
            if d.get("status") != REMOVING and not site.get("deleted_at"):
                checks = int(d.get("checks") or 0) + 1
                await _set(db, site["_id"], host, {"checks": checks, "checked_at": t, "next_check_at": t + next_wait(checks)})
    removing = await db[SITES].find_one({"_id": site["_id"], "domains.status": REMOVING}, {"_id": 1})
    if errors and removing:
        raise DomainError("; ".join(errors)[:1500])
    if errors:
        out["errors"] = errors
    return out


async def _check(db: AsyncIOMotorDatabase, site: dict, d: dict, *, force: bool) -> str:
    """Create or read ``d``'s custom hostname and record what Cloudflare says. → its status."""
    host, t = d["host"], now()
    if d.get("status") == LIVE and not force:
        return LIVE
    restart = force and d.get("status") == FAILED
    async with _client() as c:
        r = await cf_get(c, host, d.get("cf_id"))
        if r is None and (d.get("status") != FAILED or restart):
            r = await cf_create(c, host)
        elif r is not None and force and d.get("status") != LIVE:
            r = await cf_nudge(c, host, r)
    if r is None:  # a failed one, not restarted
        return FAILED
    info = interpret(host, r)
    base = {"cf_id": r["id"], "records": records(host, r), "checked_at": t}
    if info["live"] and d.get("status") == LIVE:
        # Re-checked while live and still fine: make sure the guide answers on it.
        await _set(db, site["_id"], host, {**base, "message": await _map(db, site["_id"], host)})
        return LIVE
    if info["live"]:
        await _go_live(db, site, d, base)
        return LIVE
    if d.get("status") == LIVE:
        # Re-checked while live and Cloudflare no longer serves it (the CNAME moved): say so, keep it.
        await _set(db, site["_id"], host, {**base, "message": info["message"] or
                                           "Cloudflare no longer sees the CNAME record. Put it back to keep the domain working."})
        return LIVE
    since = aware(d.get("pending_since")) or aware(d.get("added_at")) or t
    if restart:
        since = t
    checks = 0 if restart else int(d.get("checks") or 0) + 1
    if info["blocked"] or t - since > GIVE_UP_AFTER:
        message = info["message"] if info["blocked"] else (
            f"Not live after {int(GIVE_UP_AFTER.total_seconds() // 3600)} hours: "
            + (info["message"] or f"the CNAME record for {host} isn't visible").rstrip(".") + ". Fix the record, then choose Re-check.")
        await _set(db, site["_id"], host, {**base, "status": FAILED, "stage": None, "message": message[:400],
                                           "next_check_at": None, "failed_at": t})
        if not info["blocked"]:
            # A hostname that never validated would count against the free 100: delete it.
            async with _client() as c:
                await cf_delete(c, host, r["id"])
            await _set(db, site["_id"], host, {"cf_id": None})
        from app.services import docs_jobs

        await docs_jobs.log_event(db, "docs_domain_failed", site["_id"], None, blocked=bool(info["blocked"]))
        return FAILED
    await _set(db, site["_id"], host, {**base, "status": PENDING, "stage": info["stage"], "message": info["message"],
                                       "pending_since": since, "checks": checks,
                                       "next_check_at": t + next_wait(checks)}, unset=("failed_at",))
    return PENDING


async def _go_live(db: AsyncIOMotorDatabase, site: dict, d: dict, base: dict) -> None:
    host, t = d["host"], now()
    await _set(db, site["_id"], host, {**base, "status": LIVE, "stage": None, "message": None, "live_at": t,
                                       "next_check_at": None}, unset=("failed_at",))
    note = await _map(db, site["_id"], host)
    if note:
        await _set(db, site["_id"], host, {"message": note})
    from app.services import docs_jobs

    await docs_jobs.log_event(db, "docs_domain_live", site["_id"], d.get("added_by"))
    await republish(db, site["_id"], d.get("added_by"), "domain_live")


async def _map(db: AsyncIOMotorDatabase, site_id: Any, host: str) -> str | None:
    """Map ``host`` to the site in R2 when the site is live (a stale mapping of a site that no longer
    holds the host goes first; another site's is never overwritten). A note when it couldn't."""
    from app.services import docs_build

    site = await db[SITES].find_one({"_id": oid(site_id)}, {"status": 1, "deleted_at": 1})
    if not site or site.get("deleted_at") or site.get("status") != "live" or not docs_build.store_available():
        return None  # the next publish maps it (the build spec's hosts include it)
    sid = str(oid(site_id))
    await docs_build.free_stale_hosts(db, sid, [host])

    def work():
        store = docs_build.default_store()
        docs_build.ensure_hosts(store, sid, [host])
        return docs_build.host_owner(store, host)

    try:
        owner = await asyncio.to_thread(work)
    except Exception:
        log.warning("docs site %s: couldn't map its domain", sid, exc_info=True)
        return "Live on Cloudflare; the guide reaches it at the next publish."
    if owner != sid:
        log.warning("docs site %s: %s is mapped to another site (%s)", sid, host, owner)
        return "This domain still points at another guide. Contact Markdrop support."
    return None


async def _remove(db: AsyncIOMotorDatabase, site_id: Any, host: str, *, cloudflare: bool = True) -> None:
    """Delete the hostname on Cloudflare and the site's R2 mapping, then drop the entry."""
    from app.services import docs_build

    entry = await _entry(db, site_id, host)
    if entry is None:
        return
    if cloudflare and host_problem(host) is None:
        async with _client() as c:
            await cf_delete(c, host, entry.get("cf_id"))
    if docs_build.store_available():
        sid = str(oid(site_id))
        await asyncio.to_thread(lambda: docs_build.drop_hosts(docs_build.default_store(), sid, [host]))
    await db[SITES].update_one({"_id": oid(site_id)}, {"$pull": {"domains": {"host": host}}})
    log.info("docs site %s: removed its domain", site_id)
    from app.services import docs_jobs

    await docs_jobs.log_event(db, "docs_domain_removed", site_id, entry.get("removed_by"))
    if entry.get("was_live") or entry.get("status") == LIVE:
        await republish(db, site_id, entry.get("removed_by") or entry.get("added_by"), "domain_removed")


# ── publishing the live version again ───────────────────────────────────────

REPUBLISH_NOTE = "Published again for your own domain: links, sitemap and search use the new address."


async def republish(db: AsyncIOMotorDatabase, site_id: Any, by: Any, reason: str) -> dict | None:
    """Build the live version again (its own snapshot, so readers see the same pages), so canonical
    URLs, the sitemap, llms.txt and OG cards use the site's address now. Nothing when the guide
    isn't live, a publish is already waiting (it picks the address up), or the live version was
    published at another slug (the next publish moves it)."""
    from app.services.docs_site_jobs import enqueue_job

    site = await db[SITES].find_one({"_id": oid(site_id)}, {"status": 1, "deleted_at": 1, "live_build_id": 1, "slug": 1,
                                                             "owner_id": 1})
    if not site or site.get("deleted_at") or site.get("status") != "live" or not site.get("live_build_id"):
        return None
    if await db[JOBS].find_one({"site_id": site["_id"], "kind": "build", "status": "queued"}, {"_id": 1}):
        return None
    live = await db[BUILDS].find_one({"_id": site["live_build_id"]}, {"snapshot_id": 1})
    snap = await db[SNAPSHOTS].find_one({"_id": (live or {}).get("snapshot_id")}, {"site.slug": 1}) if live else None
    if not snap or (snap.get("site") or {}).get("slug") != site.get("slug"):
        return None
    from pymongo import ReturnDocument

    seq = await db[SITES].find_one_and_update({"_id": site["_id"]}, {"$inc": {"build_seq": 1}}, {"build_seq": 1},
                                              return_document=ReturnDocument.AFTER)
    number = int((seq or {}).get("build_seq") or 1)
    top = await db[BUILDS].find_one({"site_id": site["_id"]}, {"number": 1}, sort=[("number", -1)])
    if top and top["number"] >= number:
        number = top["number"] + 1
        await db[SITES].update_one({"_id": site["_id"]}, {"$max": {"build_seq": number}})
    t = now()
    build = {"site_id": site["_id"], "number": number, "status": "queued",
             "requested_by": str(by) if by else site.get("owner_id"), "review_id": None, "note": REPUBLISH_NOTE,
             "snapshot_id": snap["_id"], "manifest_hash": None, "stats": None, "error": None, "created_at": t,
             "started_at": None, "finished_at": None, "republish": reason}
    try:
        build["_id"] = (await db[BUILDS].insert_one(build)).inserted_id
    except Exception:  # a publish took the number at the same moment: it carries the address too
        log.info("docs site %s: republish skipped (a publish raced it)", site_id)
        return None
    job = await enqueue_job(db, "build", site["_id"], {"build_id": str(build["_id"]), "snapshot_id": str(snap["_id"]),
                                                       "number": number})
    await db[BUILDS].update_one({"_id": build["_id"]}, {"$set": {"job_id": job["_id"]}})
    return build


# ── queue + sweeper ─────────────────────────────────────────────────────────


async def queue(db: AsyncIOMotorDatabase, site_id: Any, reason: str, hosts: Iterable[str] = ()) -> dict | None:
    """Queue the site's ``domain`` job (``hosts``: check these now). Nothing when the feature is off.
    Never fails the caller."""
    if not configured():
        return None
    from app.services.docs_site_jobs import enqueue_job

    try:
        return await enqueue_job(db, "domain", site_id, {"reason": reason, "hosts": [h for h in hosts if isinstance(h, str)]})
    except Exception:  # pragma: no cover - a queue hiccup must not fail the request
        log.warning("docs site %s: couldn't queue the domain job", site_id, exc_info=True)
        return None


async def check_now(db: AsyncIOMotorDatabase, site: dict, raw_host: Any) -> bool:
    """"Re-check": the domain's state from Cloudflare now (validation nudged; a failed one starts
    over). False when the guide has no such domain. DomainError when Cloudflare can't be reached."""
    host = clean(raw_host)
    if not any(isinstance(d, dict) and d.get("host") == host for d in site.get("domains") or []):
        return False
    if not configured():
        raise PermissionError("Own domains aren't switched on for this Markdrop server yet.")
    res = await reconcile(db, site["_id"], [host])
    if res.get("errors"):
        raise DomainError(res["errors"][0])
    return True


async def requeue_due(db: AsyncIOMotorDatabase) -> int:
    """The sweeper's pass: a site with a pending domain due for a check, or a removal still to do,
    gets its ``domain`` job."""
    if not configured():
        return 0
    t = now()
    queued = 0
    rows = db[SITES].find({"$or": [
        {"domains": {"$elemMatch": {"status": PENDING, "next_check_at": {"$lte": t}}}},
        {"domains.status": REMOVING},
        {"deleted_at": {"$ne": None}, "domains.0": {"$exists": True}},
    ]}, {"_id": 1, "domains": 1, "deleted_at": 1}).limit(200)
    async for site in rows:
        # A job waiting or running covers it; one that failed waits RETRY_AFTER before another.
        q = {"kind": "domain", "site_id": site["_id"], "$or": [
            {"status": {"$in": ["queued", "running"]}}, {"status": "failed", "updated_at": {"$gt": t - RETRY_AFTER}}]}
        if await db[JOBS].find_one(q, {"_id": 1}) is None and await queue(db, site["_id"], "sweep") is not None:
            queued += 1
    return queued
