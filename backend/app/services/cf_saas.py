"""Workspace custom domains on Cloudflare for SaaS (the `cloudflare_saas` domain provider).

A workspace host (content.acme.com, which CNAMEs to the edge target, edge.markdrop.in) becomes a
**custom hostname** on the markdrop.in zone, plus a Worker route for that host alone,
``content.acme.com/*`` → the Markdrop web Worker (``cf_saas_worker``, markdrop-web), which renders it like
Vercel does today (the middleware rewrites a non-Markdrop Host to the tenant renderer). One route per host,
like the Guides' own domains (services/docs_custom_domains.py): the zone refuses a wildcard ``*/*`` route
(error 100327), and a route per host never catches anything else. The zone's fallback origin (the Guides'
originless ``cname.guides.markdrop.in``) is never reached: the route answers first.

**Zero downtime.** A host keeps being served by Vercel until edge.markdrop.in itself moves. Before that,
its custom hostname is created with TXT pre-validation (``ssl.method = txt``): the customer adds the
certificate's ``_acme-challenge`` TXT record, and Cloudflare's hostname ownership check is answered over
HTTP by the app itself (``/.well-known/cf-custom-hostname-challenge/<id>``, served on the host while Vercel
still serves it: routers/domains.hostname_challenge), with the ``_cf-custom-hostname`` TXT record as the
fallback. When both statuses are ``active`` the certificate exists before any traffic moves, and moving
edge.markdrop.in changes nothing a reader can see. scripts/cf_saas_migrate.py does this for every live
domain; the workspace Domains card shows the records still needed.

Cloudflare API (developers.cloudflare.com/api/resources/custom_hostnames/):
  find    GET    /zones/{zone}/custom_hostnames?hostname=<host>
  read    GET    /zones/{zone}/custom_hostnames/{id}
  create  POST   /zones/{zone}/custom_hostnames   {hostname, ssl: {method, type: dv, settings}}
  nudge   PATCH  /zones/{zone}/custom_hostnames/{id} {ssl}   (re-check now: resets Cloudflare's backoff)
  delete  DELETE /zones/{zone}/custom_hostnames/{id}
  routes  GET/POST /zones/{zone}/workers/routes, DELETE /zones/{zone}/workers/routes/{id}

Safety: a host a guide uses is never touched (the Guides own those hostnames and their routes); every
record Cloudflare returns is checked to be the host asked about before it is changed or deleted; a route
for the host naming another Worker is left alone; the token is never logged. Inert (``configured()`` is
false) while MARKDROP_CF_ZONE_ID or MARKDROP_CF_SAAS_TOKEN is blank.
"""

from __future__ import annotations

import ipaddress
import logging
import re
from datetime import datetime, timezone
from typing import Any

import httpx

from app.config import get_settings
from app.utils.http import shared_ssl

log = logging.getLogger(__name__)

API = "https://api.cloudflare.com/client/v4"
TIMEOUT = httpx.Timeout(10.0, connect=5.0)
_ID = re.compile(r"[A-Za-z0-9-]{1,64}")
_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
_BLOCKED = ("blocked", "pending_blocked", "test_blocked")
OWN_SUFFIX = "markdrop.in"

# Tests set this to an httpx.MockTransport (nothing here ever reaches the network then).
_TRANSPORT: httpx.AsyncBaseTransport | None = None


class CfSaasError(Exception):
    """A passing failure (network, a 5xx, a refused token): try again later."""


class CfSaasRefused(ValueError):
    """A hostname this module must never send to Cloudflare, or one another product owns."""


# ── settings ────────────────────────────────────────────────────────────────


def configured() -> bool:
    s = get_settings()
    return bool(s.cf_saas_token and _ID.fullmatch(s.cf_zone_id or "") and s.cf_saas_worker)


def is_provider() -> bool:
    """Workspace domains are served by Cloudflare for SaaS (MARKDROP_DOMAIN_PROVIDER=cloudflare_saas)."""
    return get_settings().domain_provider == "cloudflare_saas"


def _ssl() -> dict:
    return {"method": get_settings().cf_saas_ssl_method, "type": "dv", "settings": {"min_tls_version": "1.2"}}


def _zone() -> str:
    z = get_settings().cf_zone_id
    if not _ID.fullmatch(z or ""):
        raise CfSaasRefused("MARKDROP_CF_ZONE_ID doesn't look like a zone id")
    return z


def checked(host: Any) -> str:
    """``host`` when it may be sent to Cloudflare (a workspace host, already normalised by
    domain.normalize_host); CfSaasRefused otherwise."""
    if not isinstance(host, str) or not host or len(host) > 253:
        raise CfSaasRefused(f"not a hostname: {host!r}")
    try:
        ipaddress.ip_address(host.strip("[]"))
        raise CfSaasRefused("an IP address")
    except ValueError:
        pass
    labels = host.split(".")
    if len(labels) < 2 or not all(_LABEL.fullmatch(lbl) for lbl in labels):
        raise CfSaasRefused(f"not a hostname: {host!r}")
    if host == OWN_SUFFIX or host.endswith("." + OWN_SUFFIX):
        raise CfSaasRefused("Markdrop's own name")
    return host


async def _guides_host(db, host: str) -> bool:
    """A guide's own domain (docs_custom_domains): its custom hostname and route are the Guides'."""
    if db is None:
        return False
    from app.services.docs_jobs import SITES

    return bool(await db[SITES].find_one({"domains.host": host}, {"_id": 1}))


# ── Cloudflare API ──────────────────────────────────────────────────────────


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(verify=shared_ssl(), base_url=API, timeout=TIMEOUT, transport=_TRANSPORT, headers={
        "authorization": f"Bearer {get_settings().cf_saas_token}", "user-agent": "markdrop-workspace-domains"})


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
        raise CfSaasError(f"Cloudflare unreachable ({type(e).__name__})") from None
    if ok_404 and r.status_code == 404:
        return None
    try:
        body = r.json()
    except ValueError:
        body = None
    if r.status_code >= 400 or not isinstance(body, dict) or body.get("success") is False:
        raise CfSaasError(f"Cloudflare {method} {r.status_code}: {_errors(body)}"[:400])
    return body.get("result")


def _mine(r: Any, host: str) -> dict | None:
    if isinstance(r, dict) and str(r.get("hostname") or "").lower() == host and _ID.fullmatch(str(r.get("id") or "")):
        return r
    return None


async def _find(c: httpx.AsyncClient, host: str) -> dict | None:
    res = await _call(c, "GET", f"/zones/{_zone()}/custom_hostnames", params={"hostname": host})
    for r in res if isinstance(res, list) else []:
        if _mine(r, host):
            return r
    return None


async def _get(c: httpx.AsyncClient, host: str, cf_id: Any) -> dict | None:
    if isinstance(cf_id, str) and _ID.fullmatch(cf_id):
        r = _mine(await _call(c, "GET", f"/zones/{_zone()}/custom_hostnames/{cf_id}", ok_404=True), host)
        if r:
            return r
    return await _find(c, host)


async def _create(c: httpx.AsyncClient, host: str) -> dict:
    found = await _find(c, host)
    if found:
        return found
    try:
        res = await _call(c, "POST", f"/zones/{_zone()}/custom_hostnames", json={"hostname": host, "ssl": _ssl()})
    except CfSaasError:
        found = await _find(c, host)  # created meanwhile ("Duplicate custom hostname found")
        if found:
            return found
        raise
    r = _mine(res, host)
    if r is None:
        raise CfSaasError("Cloudflare answered the create with another hostname")
    log.info("workspace domains: created custom hostname %s", host)
    return r


def _pattern(host: str) -> str:
    return f"{host}/*"


async def _routes(c: httpx.AsyncClient) -> list[dict]:
    res = await _call(c, "GET", f"/zones/{_zone()}/workers/routes")
    return [r for r in res if isinstance(r, dict)] if isinstance(res, list) else []


async def _route_ensure(c: httpx.AsyncClient, host: str) -> bool:
    """A Worker route for exactly ``host`` → the web Worker (idempotent). True when it exists now."""
    pattern, worker = _pattern(host), get_settings().cf_saas_worker
    for r in await _routes(c):
        if r.get("pattern") == pattern:
            if r.get("script") == worker:
                return True
            raise CfSaasRefused(f"{pattern} is routed to another Worker ({r.get('script') or 'none'})")
    await _call(c, "POST", f"/zones/{_zone()}/workers/routes", json={"pattern": pattern, "script": worker})
    log.info("workspace domains: routed %s", host)
    return True


async def _route_delete(c: httpx.AsyncClient, host: str) -> None:
    pattern, worker = _pattern(host), get_settings().cf_saas_worker
    for r in await _routes(c):
        if r.get("pattern") == pattern and r.get("script") == worker and _ID.fullmatch(str(r.get("id") or "")):
            await _call(c, "DELETE", f"/zones/{_zone()}/workers/routes/{r['id']}", ok_404=True)
            log.info("workspace domains: unrouted %s", host)


# ── Cloudflare's state → ours ──────────────────────────────────────────────


def _rec(name: Any, value: Any, purpose: str, needed: bool) -> dict | None:
    if not isinstance(name, str) or not isinstance(value, str) or not name or not value:
        return None
    return {"type": "TXT", "name": name.lower().rstrip("."), "value": value[:300], "purpose": purpose, "needed": needed}


def state(host: str, r: dict, *, routed: bool | None = None) -> dict:
    """What a domain row keeps of its custom hostname (``domains.cf_saas``):

    {id, status, ssl_status, ready, blocked, message, records [{type, name, value, purpose, needed}],
     http_url, http_body, routed, checked_at}

    ``ready`` = the hostname and its certificate are both active: traffic may move. ``records`` are the
    TXT records Cloudflare validates by; ``needed`` is false once what it proves is done.
    """
    status = str(r.get("status") or "")
    ssl = r.get("ssl") if isinstance(r.get("ssl"), dict) else {}
    ssl_status = str(ssl.get("status") or "")
    owned = status == "active"
    certified = ssl_status == "active"
    records: list[dict] = []
    for v in (ssl.get("validation_records") or [])[:2]:
        if isinstance(v, dict):
            rec = _rec(v.get("txt_name"), v.get("txt_value"), "certificate", not certified)
            if rec:
                records.append(rec)
    ov = r.get("ownership_verification") or {}
    if isinstance(ov, dict) and str(ov.get("type") or "txt").lower() == "txt":
        rec = _rec(ov.get("name"), ov.get("value"), "ownership", not owned)
        if rec:
            records.append(rec)
    http = r.get("ownership_verification_http") if isinstance(r.get("ownership_verification_http"), dict) else {}
    msgs = [str(m) for m in (r.get("verification_errors") or []) if m]
    msgs += [str((e or {}).get("message")) for e in (ssl.get("validation_errors") or [])
             if isinstance(e, dict) and (e or {}).get("message")]
    blocked = status in _BLOCKED
    message = None
    if blocked:
        message = f"Cloudflare blocked {host} ({status})."
    elif not (owned and certified):
        message = msgs[0][:300] if msgs else None
        if ssl_status.endswith("timed_out"):
            message = message or ("The certificate couldn't be issued in time. Check the TXT record, and that no "
                                  "CAA record blocks Let's Encrypt or Google Trust Services.")
    out = {
        "id": str(r.get("id")), "status": status, "ssl_status": ssl_status, "ready": owned and certified,
        "blocked": blocked, "message": message, "records": records,
        "http_url": str(http.get("http_url") or "")[:500] or None,
        "http_body": str(http.get("http_body") or "")[:200] or None,
        "checked_at": datetime.now(timezone.utc),
    }
    if routed is not None:
        out["routed"] = routed
    return out


# ── what the domain service calls ──────────────────────────────────────────


async def ensure(host: str, *, db=None, route: bool = True) -> dict:
    """Create ``host``'s custom hostname (or adopt the one Cloudflare has) and its Worker route.
    Returns its state. Raises CfSaasError (try later) or CfSaasRefused (never)."""
    host = checked(host)
    if await _guides_host(db, host):
        raise CfSaasRefused(f"{host} is a guide's domain")
    async with _client() as c:
        r = await _create(c, host)
        routed = await _route_ensure(c, host) if route else None
    return state(host, r, routed=routed)


async def refresh(host: str, cf_id: Any = None, *, nudge: bool = False) -> dict | None:
    """The hostname's current state (None: Cloudflare has none for ``host``). ``nudge``: ask Cloudflare to
    validate again now when it isn't ready (the same ssl settings; resets its backoff)."""
    host = checked(host)
    async with _client() as c:
        r = await _get(c, host, cf_id)
        if r is None:
            return None
        current = state(host, r)
        if nudge and not current["ready"] and not current["blocked"]:
            # its own validation method, whatever the setting says now
            method = str((r.get("ssl") or {}).get("method") or "") or get_settings().cf_saas_ssl_method
            res = await _call(c, "PATCH", f"/zones/{_zone()}/custom_hostnames/{r['id']}",
                              json={"ssl": {**_ssl(), "method": method}})
            r = _mine(res, host) or r
    return state(host, r)


async def remove(host: str, cf_id: Any = None, *, db=None) -> bool:
    """Delete the host's Worker route (only the web Worker's) and its custom hostname. Idempotent: True when
    neither exists any more. Never raises (False: try again later)."""
    try:
        host = checked(host)
        if await _guides_host(db, host):
            return True  # not ours to delete; nothing of ours is there
        async with _client() as c:
            await _route_delete(c, host)
            r = await _get(c, host, cf_id)
            if r is not None:
                await _call(c, "DELETE", f"/zones/{_zone()}/custom_hostnames/{r['id']}", ok_404=True)
                log.info("workspace domains: deleted custom hostname %s", host)
        return True
    except CfSaasRefused:
        return True
    except Exception as exc:  # network, 5xx, refused token
        log.warning("workspace domains: removing %s from Cloudflare failed: %s", host, type(exc).__name__)
        return False
