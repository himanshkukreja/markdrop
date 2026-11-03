"""Link previews for the page editor's bookmark block (``::bookmark{url="…"}``).

``POST /api/v1/bookmarks/preview {url}`` → ``{url, title, description, site_name,
favicon, image, fetched}``. The page is fetched here, never by the browser, and
only the safe way (services/safe_fetch.py): http or https on the standard port,
no credentials, no IP literals or ``localhost``; the name is resolved here and
every address must be public (loopback, private, link-local, CGNAT, metadata
addresses… refused), the connection goes to the checked address, and every
redirect hop (at most 5) is checked again. 5 s for the whole fetch, 1 MB at most.

The image and favicon come back as the site's own URLs (not proxied through
Markdrop): the reader's browser loads them from the site, as it would any
image linked from a page. Only http(s) URLs are ever returned.

Answers are cached per URL for 24 hours (``bookmark_cache``, TTL index), so a
page full of bookmarks costs the sites nothing on every view. Failures other
than a refused address are answered with what we know (the URL and its host,
``fetched: false``) and cached for a few minutes only.
"""

from __future__ import annotations

import hashlib
import html
import logging
import re
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import safe_fetch

log = logging.getLogger(__name__)

COLL = "bookmark_cache"
TTL = timedelta(hours=24)
FAIL_TTL = timedelta(minutes=10)
MAX_BYTES = 1024 * 1024
TIMEOUT_S = 5.0
SCHEMES = ("http", "https")
_TEXT_MAX = {"title": 300, "description": 600, "site_name": 120}
# Stand-ins for DNS and the connection (tests); None means the real ones.
_resolve = None
_transport = None


class BookmarkError(Exception):
    """The URL may not be fetched at all (a private address, a bad scheme…)."""


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[COLL].create_index("expires_at", expireAfterSeconds=0)


def normalize(url: str) -> str:
    text = (url or "").strip()
    if not text:
        raise BookmarkError("Paste a link.")
    if len(text) > 2048:
        raise BookmarkError("That link is too long.")
    if "://" not in text and not text.startswith("//"):
        text = "https://" + text
    try:
        safe_fetch.check_url(text, SCHEMES)
    except safe_fetch.FetchError as exc:
        raise BookmarkError(str(exc)) from None
    parts = urlsplit(text)
    return parts._replace(fragment="", path=parts.path or "/").geturl()


class _Head(HTMLParser):
    """The <title>, <meta> and <link rel=icon> of a page (stops at <body>)."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.icons: list[tuple[str, str]] = []
        self.title = ""
        self._in_title = False
        self.done = False

    def handle_starttag(self, tag, attrs):
        if self.done:
            return
        a = {k.lower(): (v or "") for k, v in attrs if k}
        if tag == "title":
            self._in_title = True
        elif tag == "meta":
            key = (a.get("property") or a.get("name") or "").strip().lower()
            if key and "content" in a and key not in self.meta:
                self.meta[key] = a["content"]
        elif tag == "link":
            rel = a.get("rel", "").lower().split()
            if "icon" in rel and a.get("href"):
                self.icons.append((a.get("sizes", ""), a["href"]))
        elif tag == "body":
            self.done = True

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title and not self.done and len(self.title) < 1000:
            self.title += data


def _clean(text: str | None, key: str) -> str | None:
    if not text:
        return None
    t = " ".join(html.unescape(text).split())
    limit = _TEXT_MAX[key]
    if len(t) > limit:
        t = t[: limit - 1].rstrip() + "…"
    return t or None


def _abs(base: str, ref: str | None) -> str | None:
    if not ref:
        return None
    try:
        u = urljoin(base, ref.strip())
        parts = urlsplit(u)
    except ValueError:
        return None
    if parts.scheme not in SCHEMES or not parts.hostname or parts.username or parts.password:
        return None
    return u if len(u) <= 2048 else None


def _charset(content_type: str, body: bytes) -> str:
    m = re.search(r"charset=([\w-]+)", content_type or "", re.I)
    if m:
        return m.group(1)
    m = re.search(rb"<meta[^>]+charset=[\"']?([\w-]+)", body[:4096], re.I)
    return m.group(1).decode("ascii", "ignore") if m else "utf-8"


def parse(url: str, content_type: str, body: bytes) -> dict:
    host = urlsplit(url).hostname or url
    out = {"url": url, "title": None, "description": None, "site_name": None,
           "favicon": _abs(url, "/favicon.ico"), "image": None}
    if "html" not in (content_type or "").lower():
        name = urlsplit(url).path.rstrip("/").rsplit("/", 1)[-1]
        out["title"] = _clean(name or host, "title")
        out["site_name"] = _clean(host, "site_name")
        return out
    try:
        text = body.decode(_charset(content_type, body), errors="replace")
    except LookupError:
        text = body.decode("utf-8", errors="replace")
    p = _Head()
    try:
        p.feed(text[:MAX_BYTES])
    except Exception:  # a broken page still gets whatever was read
        pass
    m = p.meta
    out["title"] = _clean(m.get("og:title") or m.get("twitter:title") or p.title, "title") or _clean(host, "title")
    out["description"] = _clean(m.get("og:description") or m.get("twitter:description") or m.get("description"),
                                "description")
    out["site_name"] = _clean(m.get("og:site_name") or m.get("application-name") or host, "site_name")
    out["image"] = _abs(url, m.get("og:image:secure_url") or m.get("og:image") or m.get("twitter:image")
                        or m.get("twitter:image:src"))
    if p.icons:
        def size(s: str) -> int:
            mm = re.match(r"(\d+)", s or "")
            return int(mm.group(1)) if mm else 0
        best = sorted(p.icons, key=lambda i: -size(i[0]))[0][1]
        out["favicon"] = _abs(url, best) or out["favicon"]
    return out


def _key(url: str) -> str:
    return hashlib.sha256(url.encode()).hexdigest()


async def preview(db: AsyncIOMotorDatabase, url: str) -> dict:
    """The preview for ``url`` (cached 24 h). :class:`BookmarkError` when the
    address may not be fetched at all."""
    clean = normalize(url)
    key = _key(clean)
    now = now_utc()
    hit = await db[COLL].find_one({"_id": key, "expires_at": {"$gt": now}})
    if hit is not None:
        return hit["preview"]
    try:
        res = await safe_fetch.safe_get(clean, max_bytes=MAX_BYTES, timeout=TIMEOUT_S, schemes=SCHEMES,
                                        accept="text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
                                        resolve=_resolve, transport=_transport)
    except safe_fetch.FetchError as exc:
        msg = str(exc)
        if any(s in msg for s in ("private network", "IP address", "Only ", "port", "username",
                                  "valid address", "too long")):
            raise BookmarkError(msg) from None
        out = {**parse(clean, "", b""), "fetched": False}
        await _store(db, key, out, now + FAIL_TTL)
        return out
    except Exception:
        log.warning("bookmark preview of a URL failed", exc_info=True)
        out = {**parse(clean, "", b""), "fetched": False}
        await _store(db, key, out, now + FAIL_TTL)
        return out
    if res.status >= 400:
        out = {**parse(res.url, "", b""), "url": clean, "fetched": False}
        await _store(db, key, out, now + FAIL_TTL)
        return out
    out = {**parse(res.url, res.content_type, res.body), "url": clean, "fetched": True}
    await _store(db, key, out, now + TTL)
    return out


async def _store(db: AsyncIOMotorDatabase, key: str, out: dict, expires: datetime) -> None:
    try:
        await db[COLL].update_one({"_id": key}, {"$set": {"preview": out, "expires_at": expires}}, upsert=True)
    except Exception:  # pragma: no cover - a cache write never fails the request
        log.warning("bookmark cache write failed", exc_info=True)
