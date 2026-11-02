"""Help for adding a guide's own domain: who runs its DNS, the record in their words, whether it's
there yet, a one-click link where the provider offers one, and the public check page.

The record itself and the domain's lifecycle are services/docs_custom_domains.py's. This module only
reads DNS (services/dns_provider.py, the same provider table the workspace domains use) and asks
services/domain_connect.py for a one-click link. Lookups are cached per host for a minute, since the
setup screen and the public page poll.

The public view (``GET /api/v1/docs-sites/domain-check/<host>``, behind markdrop.in/d/check/<host>)
is for the person who runs the DNS: the host, the record to add, who runs the DNS, and how far along
it is. Never which guide or workspace it is, who added it, Cloudflare's tokens or the optional TXT
records, and only for a host some guide is setting up.
"""

from __future__ import annotations

import time
from typing import Any
from urllib.parse import quote

from motor.motor_asyncio import AsyncIOMotorDatabase
from starlette.concurrency import run_in_threadpool

from app.config import get_settings
from app.services import dns_provider, domain_connect, mailer
from app.services import docs_custom_domains as domains
from app.services.docs_jobs import SITES, aware

CACHE_SECONDS = 60
_cache: dict[str, tuple[float, dict]] = {}


def _lookup(host: str) -> dict:
    """Provider hint + the CNAME as DNS has it now. Synchronous (DNS); through a threadpool."""
    found = dns_provider.detect(host)
    zone = dns_provider.zone_for(host)
    hint = dns_provider.hint(host, {"record": host}, zone=zone, found=found)
    return {"hint": hint, "cname": dns_provider.cname_of(host)}


async def lookup(host: str) -> dict:
    hit = _cache.get(host)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    out = await run_in_threadpool(_lookup, host)
    if len(_cache) > 2000:
        _cache.clear()
    _cache[host] = (time.monotonic() + CACHE_SECONDS, out)
    return out


def forget(host: str) -> None:
    """"Check now": the next lookup reads DNS again."""
    _cache.pop(host, None)


def check_url(host: str) -> str:
    return f"{get_settings().frontend_url.rstrip('/')}/d/check/{quote(host, safe='')}"


def _provider(hint: dict) -> dict:
    keep = ("detected", "zone", "provider_id", "provider_name", "panel_url", "host_field", "value_field", "extras",
            "note", "nameservers")
    return {k: hint.get(k) for k in keep if k in hint}


def _record(host: str, hint: dict) -> dict:
    """The CNAME, with its name both ways: in full and as this provider's form wants it."""
    return {"type": "CNAME", "name": host, "value": domains.target(),
            "host": (hint.get("names") or {}).get("record") or host}


def _seen(entry: dict | None, cname: str | None) -> dict:
    """{record_seen: True/False/None, record_points_to}: what DNS has for the name right now."""
    if entry and entry.get("status") == domains.LIVE:
        return {"record_seen": True, "record_points_to": None}
    target = domains.target()
    if cname is None:
        return {"record_seen": None, "record_points_to": None}
    if cname == target:
        return {"record_seen": True, "record_points_to": None}
    return {"record_seen": False, "record_points_to": cname or None}


def _entry(site: dict, host: str) -> dict | None:
    return next((d for d in site.get("domains") or [] if isinstance(d, dict) and d.get("host") == host), None)


async def setup_view(site: dict, raw_host: Any, *, fresh: bool = False, user_id: str | None = None) -> dict | None:
    """What the setup screen shows for one of the site's domains (admins). None: no such domain."""
    host = domains.clean(raw_host)
    entry = _entry(site, host)
    if entry is None:
        return None
    if fresh:
        forget(host)
    info = await lookup(host)
    hint = info["hint"]
    zone = hint.get("zone") or dns_provider.zone_of(host)
    one_click = None
    if entry.get("status") not in (domains.LIVE, domains.REMOVING):
        # Deliberately markdrop.in/guides/…, not the studio host: the Domain Connect template's
        # syncRedirectDomain is markdrop.in (docs-platform/domain-connect), and the app redirects
        # it to guides.markdrop.in/… with its query.
        back = f"{get_settings().frontend_url.rstrip('/')}/guides/{quote(str(site['_id']), safe='')}/settings/domains/{quote(host, safe='')}?connected=1"
        one_click = await domain_connect.one_click(host, zone, redirect_uri=back)
    return {
        "host": host,
        "zone": zone,
        "label": host[: -(len(zone) + 1)] if host.endswith("." + zone) else host,
        "record": _record(host, hint),
        "provider": _provider(hint),
        **_seen(entry, info["cname"]),
        "one_click": one_click,
        "check_url": check_url(host),
        # The email when it goes live goes to whoever added it (services/docs_custom_domains.notify).
        "emails_you": mailer.is_configured() and bool(user_id) and entry.get("added_by") == user_id,
    }


async def public_view(db: AsyncIOMotorDatabase, raw_host: Any) -> dict | None:
    """The public check page's answer for a host a guide is setting up, else None."""
    host = domains.clean(raw_host)
    if domains.host_problem(host):
        return None
    site = await db[SITES].find_one({"domains.host": host, "deleted_at": None}, {"domains": 1})
    entry = _entry(site or {}, host)
    if entry is None or entry.get("status") == domains.REMOVING:
        return None
    info = await lookup(host)
    hint = info["hint"]
    return {
        "host": host,
        "status": entry.get("status") or domains.PENDING,
        "stage": entry.get("stage"),
        "live_at": aware(entry.get("live_at")),
        "checked_at": aware(entry.get("checked_at")),
        "record": _record(host, hint),
        "provider": _provider(hint),
        **_seen(entry, info["cname"]),
    }
