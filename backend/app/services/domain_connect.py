"""One-click DNS for a guide's own domain: the Domain Connect synchronous flow.

Domain Connect (github.com/Domain-Connect/spec) lets a DNS provider add a service's records after
the customer signs in and approves them, from a template the service published in the shared
Templates repo. Ours is ``markdrop.in.guides`` (docs-platform/domain-connect/): one CNAME at the
host the customer chose, pointing at ``cname.guides.markdrop.in``. Nothing in it is a variable, so a
link can't be bent to point the customer's name anywhere else.

The flow, all optional (no answer anywhere → the button is hidden and the manual steps stand):

1. discovery: the TXT record ``_domainconnect.<zone>`` names the provider's API host;
2. ``GET https://<that host>/v2/<zone>/settings`` → ``providerId``, ``providerName`` /
   ``providerDisplayName``, ``urlSyncUX``, ``urlAPI`` (and the popup's ``width`` / ``height``);
3. ``GET <urlAPI>/v2/domainTemplates/providers/markdrop.in/services/guides`` answers 200 when that
   provider has onboarded our template;
4. the apply link: ``<urlSyncUX>/v2/domainTemplates/providers/markdrop.in/services/guides/apply?
   domain=<zone>&host=<label>&redirect_uri=…&state=…&key=<key host>&sig=<signature>``, opened in a
   new tab. The customer approves there; the provider adds the record; our usual checks see it.

Signed: the template names ``syncPubKeyDomain: markdrop.in`` because the providers that matter
(Cloudflare among them) take only signed requests. The signature is RS256 (PKCS#1 v1.5, SHA-256)
over the query string as sent, without ``key`` and ``sig``, base64-encoded; ``key`` names the TXT
record under markdrop.in holding the public key (``_dcpubkeyv1``), and ``sig`` comes last. The
private key is MARKDROP_DOCS_DOMAIN_CONNECT_KEY (PEM; ``\\n`` escapes allowed); without it the
one-click path is off. ``python -m app.services.domain_connect pubkey`` prints the TXT records to
publish for it.

Every request leaves through services/safe_fetch (https only, public addresses only, no redirects
followed blindly, size and time caps): the URLs come from a TXT record the customer's DNS controls.
Answers are cached for ten minutes per zone. Tests replace the DNS lookup (``_TXT``) and the
connection (``_TRANSPORT``); nothing here reaches a provider in tests.
"""

from __future__ import annotations

import base64
import json
import logging
import re
import sys
import time
from typing import Any, Callable
from urllib.parse import quote, urlsplit

from starlette.concurrency import run_in_threadpool

from app.services import safe_fetch

log = logging.getLogger(__name__)

PROVIDER_ID = "markdrop.in"
SERVICE_ID = "guides"
KEY_HOST_DEFAULT = "_dcpubkeyv1"
TIMEOUT = 5.0
MAX_BYTES = 64 * 1024
CACHE_SECONDS = 600
_HOST = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$")

# Test hooks: the TXT lookup, safe_fetch's resolver and connection.
_TXT: Callable[[str], list[str]] | None = None
_RESOLVE = None
_TRANSPORT = None

_cache: dict[str, tuple[float, dict | None]] = {}


def _settings():
    from app.services.docs_jobs import get_jobs_settings

    return get_jobs_settings()


def _private_key():
    pem = (_settings().docs_domain_connect_key or "").strip()
    if not pem:
        return None
    pem = pem.replace("\\n", "\n")
    try:
        from cryptography.hazmat.primitives import serialization

        return serialization.load_pem_private_key(pem.encode(), password=None)
    except Exception:
        log.warning("domain connect: MARKDROP_DOCS_DOMAIN_CONNECT_KEY isn't a usable PEM private key")
        return None


def enabled() -> bool:
    """One-click setup is offered only with a signing key (the template requires signed calls)."""
    return _private_key() is not None


def key_host() -> str:
    return (_settings().docs_domain_connect_key_host or KEY_HOST_DEFAULT).strip() or KEY_HOST_DEFAULT


# ── Signing ─────────────────────────────────────────────────────────────────


def sign(query: str, key=None) -> str:
    """The base64 RS256 signature of ``query`` (a query string, exactly as it is sent)."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding

    key = key or _private_key()
    if key is None:
        raise RuntimeError("no Domain Connect signing key")
    return base64.b64encode(key.sign(query.encode(), padding.PKCS1v15(), hashes.SHA256())).decode()


def public_key_records(key=None) -> list[str]:
    """The TXT values to publish at ``<key host>.markdrop.in`` (the spec's p=/a=/d= parts)."""
    from cryptography.hazmat.primitives import serialization

    key = key or _private_key()
    if key is None:
        raise RuntimeError("no Domain Connect signing key")
    der = key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    data = base64.b64encode(der).decode()
    chunks = [data[i:i + 200] for i in range(0, len(data), 200)]
    return [f"p={i + 1},a=RS256,d={c}" for i, c in enumerate(chunks)]


# ── Discovery ───────────────────────────────────────────────────────────────


def _txt_lookup(name: str) -> list[str]:
    if _TXT is not None:
        return _TXT(name)
    try:
        import dns.resolver

        resolver = dns.resolver.Resolver()
        resolver.lifetime = 4.0
        resolver.timeout = 4.0
        out = []
        for r in resolver.resolve(name, "TXT"):
            out.append(b"".join(r.strings).decode("utf-8", "replace"))
        return out
    except Exception:
        return []


def _api_host(txt: list[str]) -> str | None:
    """The discovery record's value: a host with an optional path ("api.cloudflare.com/client/v4/dns/domainconnect")."""
    for raw in txt:
        v = raw.strip().strip('"').strip().rstrip("/")
        if v.lower().startswith("https://"):
            v = v[8:]
        host = v.split("/")[0].lower()
        if v and _HOST.fullmatch(host) and len(v) <= 300 and not re.search(r"[\s?#@\\]", v):
            return v
    return None


async def _get_json(url: str) -> tuple[int, Any]:
    try:
        res = await safe_fetch.safe_get(url, max_bytes=MAX_BYTES, timeout=TIMEOUT, max_redirects=2,
                                        accept="application/json", resolve=_RESOLVE, transport=_TRANSPORT)
    except safe_fetch.FetchError:
        return 0, None
    try:
        return res.status, json.loads(res.body or b"null")
    except ValueError:
        return res.status, None


def _https(url: Any) -> str | None:
    if not isinstance(url, str) or len(url) > 500:
        return None
    try:
        p = urlsplit(url.strip())
    except ValueError:
        return None
    if p.scheme != "https" or not p.hostname or p.username or p.password or p.query or p.fragment:
        return None
    return url.strip().rstrip("/")


async def discover(zone: str) -> dict | None:
    """The zone's provider settings when it supports our template: {provider_id, provider_name,
    url_sync_ux, width, height}. None when there's no Domain Connect, no sync flow, or no template."""
    zone = zone.lower().rstrip(".")
    hit = _cache.get(zone)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    found = await _discover(zone)
    if len(_cache) > 2000:
        _cache.clear()
    _cache[zone] = (time.monotonic() + CACHE_SECONDS, found)
    return found


async def _discover(zone: str) -> dict | None:
    if not _HOST.fullmatch(zone):
        return None
    api = _api_host(await run_in_threadpool(_txt_lookup, f"_domainconnect.{zone}"))
    if not api:
        return None
    status, body = await _get_json(f"https://{api}/v2/{quote(zone)}/settings")
    if status != 200 or not isinstance(body, dict):
        return None
    sync_ux, url_api = _https(body.get("urlSyncUX")), _https(body.get("urlAPI"))
    provider_id = str(body.get("providerId") or "").strip()[:100]
    if not sync_ux or not url_api or not provider_id:
        return None
    status, _ = await _get_json(f"{url_api}/v2/domainTemplates/providers/{PROVIDER_ID}/services/{SERVICE_ID}")
    if status != 200:
        return None
    name = str(body.get("providerDisplayName") or body.get("providerName") or provider_id).strip()[:80]

    def dim(v: Any, default: int) -> int:
        return int(v) if isinstance(v, (int, float)) and 300 <= v <= 1600 else default

    return {"provider_id": provider_id, "provider_name": name, "url_sync_ux": sync_ux,
            "width": dim(body.get("width"), 750), "height": dim(body.get("height"), 750)}


# ── The apply link ──────────────────────────────────────────────────────────


def apply_url(found: dict, zone: str, label: str, *, redirect_uri: str | None = None, state: str | None = None,
              key=None) -> str:
    """The signed synchronous-flow link that adds the CNAME at ``label``.``zone``."""
    params = [("domain", zone), ("host", label)]
    if redirect_uri:
        params.append(("redirect_uri", redirect_uri))
    if state:
        params.append(("state", state))
    query = "&".join(f"{k}={quote(v, safe='')}" for k, v in params)
    sig = sign(query, key)
    base = f"{found['url_sync_ux']}/v2/domainTemplates/providers/{PROVIDER_ID}/services/{SERVICE_ID}/apply"
    return f"{base}?{query}&key={quote(key_host(), safe='')}&sig={quote(sig, safe='')}"


async def one_click(host: str, zone: str, *, redirect_uri: str | None = None, state: str | None = None) -> dict | None:
    """{provider_id, provider_name, url, width, height} for ``host`` in ``zone``, or None (no key,
    a root domain, no Domain Connect at that provider, or our template isn't onboarded there)."""
    host, zone = host.lower().rstrip("."), zone.lower().rstrip(".")
    if not enabled() or not host.endswith("." + zone):
        return None
    try:
        found = await discover(zone)
    except Exception:  # discovery is a nicety: never fail the setup screen over it
        log.warning("domain connect: discovery failed", exc_info=True)
        return None
    if not found:
        return None
    label = host[: -(len(zone) + 1)]
    return {"provider_id": found["provider_id"], "provider_name": found["provider_name"],
            "url": apply_url(found, zone, label, redirect_uri=redirect_uri, state=state),
            "width": found["width"], "height": found["height"]}


if __name__ == "__main__":  # pragma: no cover - an owner's tool
    if sys.argv[1:] == ["pubkey"]:
        for rec in public_key_records():
            print(f'{key_host()}.markdrop.in. TXT "{rec}"')
    elif sys.argv[1:] == ["newkey"]:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import rsa

        k = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        print(k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                              serialization.NoEncryption()).decode())
    else:
        print("usage: python -m app.services.domain_connect newkey | pubkey")
