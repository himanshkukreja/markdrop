"""Client ID Metadata Documents: an OAuth client_id that is an https URL.

Instead of registering, a client such as Claude or ChatGPT can use the URL of a
JSON document it hosts as its client_id. We fetch that document, check that it
names itself, and take its name and redirect URIs from it.

Fetching a URL that someone else chose is a server-side request forgery risk:
the client_id could point at 169.254.169.254 (cloud metadata), at Redis on
localhost, or at a hostname that resolves to a private address. So:

* https only (http to loopback only behind an explicit development setting),
  no userinfo, no fragment, a real path;
* the host is resolved first and every address must be public, and the
  connection is then pinned to the address that was checked (the TLS name is
  still the hostname), so DNS can't answer differently a moment later;
* at most 3 redirects, each one held to the same rules, never to plain http;
* 5 seconds and 64 KB, whichever comes first;
* successful documents are cached for an hour.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import socket
import time
from dataclasses import dataclass, field
from urllib.parse import urljoin, urlsplit

import httpx

from app.config import get_settings

settings = get_settings()

MAX_BYTES = 64 * 1024
TIMEOUT_SECONDS = 5.0
CACHE_SECONDS = 3600
MAX_REDIRECTS = 3
_LOOPBACK_NAMES = frozenset({"localhost", "127.0.0.1", "::1"})

_cache: dict[str, tuple[float, "ClientMetadata"]] = {}
_CACHE_MAX = 512


class CIMDError(Exception):
    """The client_id URL can't be used. The message is safe to show to a user."""


@dataclass
class ClientMetadata:
    client_id: str
    client_name: str
    redirect_uris: list[str]
    client_uri: str | None = None
    logo_uri: str | None = None
    token_endpoint_auth_method: str = "none"
    grant_types: list[str] = field(default_factory=lambda: ["authorization_code", "refresh_token"])


def is_cimd_client_id(client_id: str) -> bool:
    """Whether this client_id is shaped like a metadata-document URL."""
    if client_id.startswith("https://"):
        return True
    return settings.oauth_cimd_allow_http_loopback and client_id.startswith("http://")


def _allow_http_loopback(host: str) -> bool:
    return settings.oauth_cimd_allow_http_loopback and host in _LOOPBACK_NAMES


def check_url_shape(url: str) -> tuple[str, str, int]:
    """(scheme, host, port) of an acceptable metadata URL, else CIMDError."""
    if len(url) > 2048:
        raise CIMDError("The app's client ID is too long.")
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        raise CIMDError("The app's client ID isn't a valid URL.")
    host = (parts.hostname or "").lower()
    if not host:
        raise CIMDError("The app's client ID isn't a valid URL.")
    if parts.username is not None or parts.password is not None or parts.fragment:
        raise CIMDError("The app's client ID URL can't carry credentials or a fragment.")
    if parts.path in ("", "/"):
        raise CIMDError("The app's client ID URL needs a path.")
    if parts.scheme == "https":
        return "https", host, port or 443
    if parts.scheme == "http" and _allow_http_loopback(host):
        return "http", host, port or 80
    raise CIMDError("The app's client ID must be an https URL.")


def _address_allowed(ip: ipaddress.IPv4Address | ipaddress.IPv6Address, host: str) -> bool:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    if ip.is_loopback and _allow_http_loopback(host):
        return True
    return ip.is_global and not (
        ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast
        or ip.is_reserved or ip.is_unspecified
    )


async def _resolve(host: str, port: int) -> str:
    """One public address for `host`, or CIMDError. Every answer must be public:
    a name that resolves to a mix is refused rather than raced."""
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        addresses = [literal]
    else:
        try:
            infos = await asyncio.get_running_loop().getaddrinfo(
                host, port, type=socket.SOCK_STREAM
            )
        except (socket.gaierror, UnicodeError):
            raise CIMDError("The app's client ID host doesn't resolve.")
        addresses = []
        for info in infos:
            try:
                addresses.append(ipaddress.ip_address(info[4][0].split("%")[0]))
            except ValueError:
                continue
    if not addresses:
        raise CIMDError("The app's client ID host doesn't resolve.")
    if not all(_address_allowed(a, host) for a in addresses):
        raise CIMDError("The app's client ID points at a private network address.")
    return str(addresses[0])


async def _get(url: str) -> tuple[int, str | None, bytes]:
    """GET `url` pinned to a checked address: (status, redirect location, body).
    Redirects are returned, not followed."""
    scheme, host, port = check_url_shape(url)
    ip = await _resolve(host, port)
    parts = urlsplit(url)
    ip_host = f"[{ip}]" if ":" in ip else ip
    default_port = 443 if scheme == "https" else 80
    netloc = ip_host if port == default_port else f"{ip_host}:{port}"
    target = f"{scheme}://{netloc}{parts.path or '/'}" + (f"?{parts.query}" if parts.query else "")
    host_header = host if port == default_port else f"{host}:{port}"
    headers = {"Host": host_header, "Accept": "application/json", "User-Agent": "Markdrop-OAuth/1.0"}
    # The connection goes to the address we checked; TLS still verifies the
    # certificate against the hostname.
    extensions = {"sni_hostname": host} if scheme == "https" else {}
    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS, follow_redirects=False) as client:
        request = client.build_request("GET", target, headers=headers, extensions=extensions)
        response = await client.send(request, stream=True)
        try:
            if response.is_redirect:
                return response.status_code, response.headers.get("location") or "", b""
            declared = response.headers.get("content-length")
            if declared and declared.isdigit() and int(declared) > MAX_BYTES:
                raise CIMDError("The app's metadata document is too large.")
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) > MAX_BYTES:
                    raise CIMDError("The app's metadata document is too large.")
            return response.status_code, None, bytes(body)
        finally:
            await response.aclose()


async def _fetch_document(url: str) -> dict:
    current = url
    try:
        async with asyncio.timeout(TIMEOUT_SECONDS):
            for _ in range(MAX_REDIRECTS + 1):
                status, location, body = await _get(current)
                if location is not None:
                    # check_url_shape on the next hop refuses plain http.
                    current = urljoin(current, location)
                    continue
                if status != 200:
                    raise CIMDError("The app's metadata document couldn't be fetched.")
                try:
                    data = json.loads(body)
                except (ValueError, UnicodeDecodeError):
                    raise CIMDError("The app's metadata document isn't valid JSON.")
                if not isinstance(data, dict):
                    raise CIMDError("The app's metadata document isn't a JSON object.")
                return data
            raise CIMDError("The app's metadata document redirects too many times.")
    except TimeoutError:
        raise CIMDError("The app's metadata document took too long to load.")
    except httpx.HTTPError:
        raise CIMDError("The app's metadata document couldn't be fetched.")


def validate_document(url: str, data: dict) -> ClientMetadata:
    """Check a fetched document against the URL it came from."""
    from app.services import oauth_server

    if data.get("client_id") != url:
        raise CIMDError("The app's metadata document doesn't match its client ID.")
    name = data.get("client_name")
    if not isinstance(name, str) or not name.strip():
        raise CIMDError("The app's metadata document has no client_name.")
    uris = data.get("redirect_uris")
    if not isinstance(uris, list) or not uris or len(uris) > 20:
        raise CIMDError("The app's metadata document lists no redirect URIs.")
    for uri in uris:
        if not isinstance(uri, str) or not oauth_server.redirect_uri_allowed(uri):
            raise CIMDError("The app's metadata document lists an unsafe redirect URI.")
    method = data.get("token_endpoint_auth_method") or "none"
    # A document anyone can read cannot hold a shared secret, and we don't
    # verify signed assertions; such a client has nothing it can authenticate with.
    if method != "none":
        raise CIMDError("The app's metadata document asks for an unsupported sign-in method.")
    grant_types = data.get("grant_types") or ["authorization_code", "refresh_token"]
    if not isinstance(grant_types, list) or "authorization_code" not in grant_types:
        raise CIMDError("The app's metadata document doesn't use the authorization code flow.")

    def _opt_https(value) -> str | None:
        if isinstance(value, str) and value.startswith("https://") and len(value) <= 500:
            return value
        return None

    return ClientMetadata(
        client_id=url,
        client_name=name.strip()[:100],
        redirect_uris=list(uris),
        client_uri=_opt_https(data.get("client_uri")),
        logo_uri=_opt_https(data.get("logo_uri")),
        token_endpoint_auth_method="none",
        grant_types=[g for g in grant_types if isinstance(g, str)],
    )


async def fetch_client(url: str) -> ClientMetadata:
    """The validated metadata behind a CIMD client_id (cached for an hour)."""
    now = time.monotonic()
    hit = _cache.get(url)
    if hit and hit[0] > now:
        return hit[1]
    check_url_shape(url)
    meta = validate_document(url, await _fetch_document(url))
    if len(_cache) >= _CACHE_MAX:
        for key in [k for k, (exp, _) in _cache.items() if exp <= now]:
            _cache.pop(key, None)
        if len(_cache) >= _CACHE_MAX:
            _cache.clear()
    _cache[url] = (now + CACHE_SECONDS, meta)
    return meta


def clear_cache() -> None:
    _cache.clear()
