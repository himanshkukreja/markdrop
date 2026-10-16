"""Link rules shared by the renderer and the public tracking routes.

Only links to allow-listed hosts are wrapped for click tracking, and the click
redirect only ever sends people to those hosts, so ``/api/v1/email/c`` can't be
used as an open redirect. Entries are a host (``x.com``) or a host plus a path
prefix (``github.com/himanshkukreja``); the frontend and API hosts are always
allowed ("same site").

Tokens are random bearer capabilities, one per recipient (no signing): knowing
one lets you mark that one message opened, clicked or unsubscribed, nothing
else. "preview" and "test" are accepted by every route and never recorded.
"""

from __future__ import annotations

import re
import secrets
from urllib.parse import quote, urlsplit

from app.config import get_settings

settings = get_settings()

TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
NON_TRACKING = ("preview", "test")
SAFE_SCHEMES = ("http", "https", "mailto")


def new_token() -> str:
    """24 url-safe characters (144 random bits)."""
    return secrets.token_urlsafe(18)


def is_non_tracking_token(t: str) -> bool:
    return t in NON_TRACKING or t.startswith("test-") or t.startswith("preview-")


def valid_token(t: str) -> bool:
    return bool(t) and (t in NON_TRACKING or bool(TOKEN_RE.match(t)))


def _host(u: str) -> str:
    try:
        return (urlsplit(u).hostname or "").lower().rstrip(".")
    except ValueError:
        return ""


def api_base() -> str:
    return settings.api_base_url.rstrip("/")


def site_base() -> str:
    return settings.frontend_url.rstrip("/")


def own_hosts() -> set[str]:
    """The product's own hosts: links here get UTM parameters."""
    hosts = {"markdrop.in", "www.markdrop.in", _host(settings.frontend_url)}
    return {h for h in hosts if h}


def _allow_entries() -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for raw in [*settings.email_click_hosts, _host(settings.frontend_url), _host(settings.api_base_url)]:
        e = (raw or "").strip().lower().rstrip("/")
        if not e:
            continue
        if "://" in e:
            e = e.split("://", 1)[1]
        host, _, path = e.partition("/")
        out.append((host.rstrip("."), f"/{path}" if path else ""))
    return out


def allowed_url(raw: str) -> str | None:
    """The URL, normalised, if it is http(s) on an allow-listed host; else None."""
    try:
        u = urlsplit((raw or "").strip())
    except ValueError:
        return None
    if u.scheme.lower() not in ("http", "https") or u.username or u.password:
        return None
    host = (u.hostname or "").lower().rstrip(".")
    if not host:
        return None
    path = (u.path or "/").lower()
    for h, prefix in _allow_entries():
        if host == h and (not prefix or path == prefix or path.startswith(prefix + "/")):
            return u.geturl()
    return None


def is_own_url(u: str) -> bool:
    return _host(u) in own_hosts()


def safe_scheme(u: str, *, image: bool = False) -> bool:
    """Link/button URLs: http, https or mailto. Images: https only."""
    t = (u or "").strip()
    if not t:
        return False
    m = re.match(r"^([a-zA-Z][a-zA-Z0-9+.-]*):", t)
    if not m:
        return False
    scheme = m.group(1).lower()
    if image:
        return scheme == "https"
    return scheme in SAFE_SCHEMES


def unsubscribe_url(token: str) -> str:
    return f"{api_base()}/api/v1/email/u/{quote(token, safe='')}"


def open_pixel_url(token: str) -> str:
    return f"{api_base()}/api/v1/email/o/{quote(token, safe='')}.gif"


def click_url(token: str, url: str) -> str:
    return f"{api_base()}/api/v1/email/c/{quote(token, safe='')}?u={quote(url, safe='')}"


def is_tracking_url(u: str) -> bool:
    """Our own pixel / click / unsubscribe links (never wrapped again)."""
    try:
        p = urlsplit(u).path
    except ValueError:
        return False
    return p.startswith("/api/v1/email/") or p.startswith("/api/v1/auth/unsubscribe") or p.startswith("/api/v1/unsubscribe")
