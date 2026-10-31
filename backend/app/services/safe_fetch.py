"""Fetching a URL someone else chose, without reaching anything private.

The Python twin of the docs importers' guard (frontend/scripts/docs-import/lib/guard.mjs): a guide's
API reference can come from an https URL, which the API fetches. That URL could point at cloud
metadata (169.254.169.254), at Redis on localhost, or at a name that resolves to a private address,
or redirect to one. So, for every request:

* https only, on the default port, without credentials, and never to an IP address written as the
  host (or ``localhost``);
* the name is resolved here and every address it has must be public (:func:`blocked_address`:
  loopback, private, link-local, CGNAT, unique-local, multicast, reserved, unspecified, the
  documentation ranges, and the IPv4-mapped / NAT64 / 6to4 / Teredo spellings of those, so the
  metadata addresses 169.254.169.254, fd00:ec2::254, 100.100.100.200 and 192.0.0.192 are refused);
* the connection goes to the address that was checked (TLS still verifies the hostname), so a DNS
  answer that changes between the check and the connect can't move it;
* redirects aren't followed by the HTTP client: each hop (at most ``max_redirects``) is checked
  like the first;
* a size limit (the declared length and the bytes actually read) and one deadline for the whole
  fetch, redirects included.

Errors are :class:`FetchError` with a message fit for the person who typed the URL.
"""

from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
from dataclasses import dataclass, field
from typing import Awaitable, Callable
from urllib.parse import urljoin, urlsplit

import httpx

MAX_REDIRECTS = 5
USER_AGENT = "Markdrop-Guides/1.0 (+https://markdrop.in)"

_V4_BLOCKED = [ipaddress.ip_network(n) for n in (
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
    "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15",
    "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
)]
_NAT64 = ipaddress.ip_network("64:ff9b::/96")
_GLOBAL_UNICAST = ipaddress.ip_network("2000::/3")
_TEREDO = ipaddress.ip_network("2001::/32")
_DOC_V6 = ipaddress.ip_network("2001:db8::/32")
_6TO4 = ipaddress.ip_network("2002::/16")


class FetchError(Exception):
    """The URL can't be fetched. The message is safe to show the person who gave it."""


def blocked_address(address: str) -> bool:
    """True when nothing of ours may connect to this address (anything not plainly public)."""
    try:
        ip = ipaddress.ip_address(str(address).split("%")[0])
    except ValueError:
        return True
    if isinstance(ip, ipaddress.IPv4Address):
        return any(ip in n for n in _V4_BLOCKED)
    if ip.ipv4_mapped is not None:
        return blocked_address(str(ip.ipv4_mapped))
    packed = ip.packed
    if packed[:8] == b"\0" * 8 and packed[8:10] == b"\xff\xff" and packed[10:12] == b"\0\0":
        return blocked_address(str(ipaddress.IPv4Address(packed[12:])))  # ::ffff:0:a.b.c.d
    if packed[:12] == b"\0" * 12:
        return True  # ::, ::1, ::a.b.c.d
    if ip in _NAT64:
        return blocked_address(str(ipaddress.IPv4Address(packed[12:])))
    if packed[:4] == b"\x00\x64\xff\x9b":
        return True  # the rest of 64:ff9b::/32 (local-use NAT64)
    if ip not in _GLOBAL_UNICAST:
        return True  # link-local, unique-local (fd00:ec2::254), multicast, …
    if ip in _6TO4:
        return blocked_address(str(ipaddress.IPv4Address(packed[2:6])))
    if ip in _TEREDO or ip in _DOC_V6:
        return True
    return False


def check_url(url: str) -> tuple[str, str]:
    """(url without fragment, hostname) when the URL may be fetched, else :class:`FetchError`."""
    if not isinstance(url, str) or not url.strip():
        raise FetchError("Enter an https:// address.")
    url = url.strip()
    if len(url) > 2048:
        raise FetchError("That address is too long.")
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        raise FetchError("That isn't a valid address.") from None
    if parts.scheme.lower() != "https":
        raise FetchError("Only https:// addresses can be fetched.")
    if parts.username is not None or parts.password is not None:
        raise FetchError("Addresses with a username or password in them can't be fetched.")
    if port is not None and port != 443:
        raise FetchError("Only the standard https port can be fetched.")
    host = (parts.hostname or "").rstrip(".").lower()
    if not host:
        raise FetchError("That isn't a valid address.")
    try:
        ipaddress.ip_address(host)
        raise FetchError("Use the site's name, not an IP address.")
    except ValueError:
        pass
    # An address in another spelling ("0x7f.1", "2130706433", "127.1"): a name's last label is never a number.
    if re.fullmatch(r"0x[0-9a-f]*|\d+", host.rsplit(".", 1)[-1]):
        raise FetchError("Use the site's name, not an IP address.")
    if host == "localhost" or host.endswith(".localhost") or "." not in host:
        raise FetchError("That address points at a private network.")
    clean = parts._replace(fragment="").geturl()
    return clean, host


Resolver = Callable[[str], Awaitable[list[str]]]


async def system_resolve(host: str) -> list[str]:
    infos = await asyncio.get_running_loop().getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    return [info[4][0] for info in infos]


async def resolve_public(host: str, resolve: Resolver | None = None) -> str:
    """The name's first address when every address it has is public; else :class:`FetchError`."""
    try:
        addrs = await (resolve or system_resolve)(host)
    except (OSError, UnicodeError):
        raise FetchError(f"{host} doesn't resolve.") from None
    if not addrs:
        raise FetchError(f"{host} doesn't resolve.")
    if any(blocked_address(a) for a in addrs):
        raise FetchError("That address points at a private network.")
    return str(addrs[0]).split("%")[0]


@dataclass
class Response:
    status: int
    url: str
    content_type: str
    body: bytes
    headers: dict = field(default_factory=dict)


async def _get_pinned(url: str, host: str, ip: str, *, max_bytes: int, timeout: float,
                      accept: str) -> tuple[int, str | None, str, bytes]:
    """One GET to ``url`` at the checked address ``ip``: (status, redirect location, type, body)."""
    parts = urlsplit(url)
    ip_host = f"[{ip}]" if ":" in ip else ip
    target = f"https://{ip_host}{parts.path or '/'}" + (f"?{parts.query}" if parts.query else "")
    headers = {"Host": host, "Accept": accept, "User-Agent": USER_AGENT, "Accept-Encoding": "gzip, deflate"}
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, trust_env=False) as client:
        request = client.build_request("GET", target, headers=headers, extensions={"sni_hostname": host})
        response = await client.send(request, stream=True)
        try:
            if response.is_redirect:
                return response.status_code, response.headers.get("location") or "", "", b""
            declared = response.headers.get("content-length")
            if declared and declared.isdigit() and int(declared) > max_bytes:
                raise FetchError(f"The file is larger than {max_bytes // (1024 * 1024)} MB.")
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) > max_bytes:
                    raise FetchError(f"The file is larger than {max_bytes // (1024 * 1024)} MB.")
            return response.status_code, None, response.headers.get("content-type", ""), bytes(body)
        finally:
            await response.aclose()


Transport = Callable[..., Awaitable[tuple[int, str | None, str, bytes]]]


async def safe_get(url: str, *, max_bytes: int, timeout: float = 15.0, max_redirects: int = MAX_REDIRECTS,
                   accept: str = "*/*", resolve: Resolver | None = None,
                   transport: Transport | None = None) -> Response:
    """GET ``url`` the safe way (see the top of this module). ``resolve`` and ``transport`` stand in
    for DNS and the connection in tests."""
    send = transport or _get_pinned
    current, host = check_url(url)
    try:
        async with asyncio.timeout(timeout):
            for hop in range(max_redirects + 1):
                ip = await resolve_public(host, resolve)
                status, location, ctype, body = await send(current, host, ip, max_bytes=max_bytes,
                                                           timeout=timeout, accept=accept)
                if location is not None:
                    if hop >= max_redirects:
                        raise FetchError("The address redirects too many times.")
                    if not location:
                        raise FetchError("The address redirects nowhere.")
                    current, host = check_url(urljoin(current, location))
                    continue
                return Response(status=status, url=current, content_type=ctype, body=body)
            raise FetchError("The address redirects too many times.")
    except TimeoutError:
        raise FetchError(f"The address took longer than {int(timeout)} seconds to answer.") from None
    except httpx.HTTPError:
        raise FetchError("The address couldn't be reached.") from None
