"""Notion's REST API, as little of it as "Connect Notion" needs (no SDK; read-only apart from OAuth).

* OAuth (public integration): :func:`exchange` (``POST /v1/oauth/token``, authorization_code / refresh_token,
  HTTP Basic with the client id and secret), :func:`revoke` (``POST /v1/oauth/revoke``).
* Reading: :meth:`Client.call` for ``/v1/search``, ``/v1/pages/{id}``, ``/v1/blocks/{id}/children``,
  ``/v1/databases/{id}``, ``/v1/data_sources/{id}`` and ``/v1/data_sources/{id}/query`` (Notion-Version
  ``settings.notion_version``: data sources, ``in_trash``), :meth:`Client.pages` for cursor pagination,
  :meth:`Client.download` for the files Notion hosts (short-lived signed URLs).

Rate limits: Notion allows about 3 requests a second per connection. A :class:`Client` spaces its calls
(``MIN_INTERVAL``) and, on a 429, waits the ``Retry-After`` it was given (then backs off, up to 30 s, at
most ``MAX_TRIES`` times); 5xx answers to reads are retried the same way.

Tests swap :data:`TRANSPORT` for an ``httpx.MockTransport`` (tests/_notion_api_fake.py) and set
``MIN_INTERVAL`` / ``SLEEP`` so nothing waits and nothing leaves the machine.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import random
import time
from typing import Any, AsyncIterator

import httpx

from app.config import get_settings
from app.utils.http import shared_ssl

log = logging.getLogger("markdrop.notion")

TRANSPORT: httpx.AsyncBaseTransport | None = None
TIMEOUT = 30.0
MIN_INTERVAL = 0.34          # ~3 requests a second
MAX_TRIES = 6
MAX_WAIT = 30.0
SLEEP = asyncio.sleep        # tests record the waits instead


class NotionError(Exception):
    def __init__(self, status: int, code: str = "", message: str = ""):
        super().__init__(f"{status} {code} {message}".strip())
        self.status = status
        self.code = code
        self.message = message

    @property
    def auth(self) -> bool:
        """The token is no good (revoked, or the person removed Markdrop in Notion)."""
        return self.status == 401 or self.code in ("unauthorized", "invalid_grant", "invalid_client")

    @property
    def missing(self) -> bool:
        """Gone, or not shared with Markdrop (Notion answers both with 404 object_not_found)."""
        return self.status == 404 or self.code == "object_not_found"


def base() -> str:
    return get_settings().notion_api_base.rstrip("/")


def _http() -> httpx.AsyncClient:
    return httpx.AsyncClient(verify=shared_ssl(), timeout=TIMEOUT, transport=TRANSPORT, follow_redirects=True)


def _basic() -> str:
    s = get_settings()
    return "Basic " + base64.b64encode(f"{s.notion_client_id}:{s.notion_client_secret}".encode()).decode()


def _error(r: httpx.Response) -> NotionError:
    try:
        body = r.json()
    except ValueError:
        body = {}
    if not isinstance(body, dict):
        body = {}
    code = str(body.get("code") or body.get("error") or "")
    msg = str(body.get("message") or body.get("error_description") or "")[:300]
    return NotionError(r.status_code, code, msg)


async def exchange(**body: Any) -> dict:
    """``POST /v1/oauth/token`` (grant_type authorization_code with code + redirect_uri, or refresh_token)."""
    async with _http() as c:
        r = await c.post(base() + "/v1/oauth/token", json=body,
                         headers={"Authorization": _basic(), "Notion-Version": get_settings().notion_version})
    if r.status_code >= 400:
        raise _error(r)
    return r.json()


async def revoke(token: str) -> bool:
    """Tell Notion to forget a token (``POST /v1/oauth/revoke``). Best effort: False when it didn't."""
    try:
        async with _http() as c:
            r = await c.post(base() + "/v1/oauth/revoke", json={"token": token},
                             headers={"Authorization": _basic(), "Notion-Version": get_settings().notion_version})
        return r.status_code < 400
    except httpx.HTTPError:
        return False


def _retry_after(r: httpx.Response) -> float | None:
    v = r.headers.get("Retry-After")
    try:
        return max(0.0, float(v)) if v is not None else None
    except ValueError:
        return None


class Client:
    """Calls as one connection (one token), spaced to Notion's rate limit, with backoff."""

    def __init__(self, token: str, *, on_auth_error=None):
        self.token = token
        self.on_auth_error = on_auth_error      # async () → a new token, or None (a refresh)
        self._last = 0.0
        self._lock = asyncio.Lock()
        self.calls = 0
        self._http: httpx.AsyncClient | None = None

    async def __aenter__(self) -> "Client":
        self._http = _http()
        return self

    async def __aexit__(self, *exc) -> None:
        await self.close()

    async def close(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    async def _space(self) -> None:
        async with self._lock:
            wait = self._last + MIN_INTERVAL - time.monotonic()
            if wait > 0:
                await SLEEP(wait)
            self._last = time.monotonic()

    async def call(self, method: str, path: str, *, json: Any = None, params: dict | None = None) -> dict:
        if self._http is None:
            self._http = _http()
        refreshed = False
        delay = 1.0
        for attempt in range(1, MAX_TRIES + 1):
            await self._space()
            self.calls += 1
            try:
                r = await self._http.request(method, base() + path, json=json, params=params, headers={
                    "Authorization": f"Bearer {self.token}", "Notion-Version": get_settings().notion_version})
            except httpx.HTTPError as exc:
                if attempt >= MAX_TRIES:
                    raise NotionError(0, "network", str(exc)[:200])
                await SLEEP(min(MAX_WAIT, delay) + random.random() * 0.25)
                delay *= 2
                continue
            if r.status_code < 400:
                return r.json() if r.content else {}
            err = _error(r)
            if r.status_code == 401 and not refreshed and self.on_auth_error is not None:
                new = await self.on_auth_error()
                refreshed = True
                if new:
                    self.token = new
                    continue
            retry = r.status_code in (429, 529) and err.code != "public_api_request_blocked"
            retry = retry or (r.status_code in (500, 502, 503, 504) and (method == "GET" or path.endswith("/query")
                                                                         or path == "/v1/search"))
            if not retry or attempt >= MAX_TRIES:
                raise err
            wait = _retry_after(r)
            wait = min(MAX_WAIT, max(wait if wait is not None else 0.0, delay))
            log.info("notion: %s %s → %s, waiting %.1fs", method, path, r.status_code, wait)
            await SLEEP(wait + random.random() * 0.25)
            delay = min(MAX_WAIT, delay * 2)
        raise NotionError(0, "retries", "Notion kept asking to slow down.")

    async def pages(self, method: str, path: str, *, json: dict | None = None, limit: int = 100_000
                    ) -> AsyncIterator[dict]:
        """Every result of a paginated list (start_cursor / next_cursor), up to ``limit``."""
        cursor = None
        n = 0
        while True:
            if method == "GET":
                params = {"page_size": 100, **({"start_cursor": cursor} if cursor else {})}
                page = await self.call("GET", path, params=params)
            else:
                body = {**(json or {}), "page_size": 100, **({"start_cursor": cursor} if cursor else {})}
                page = await self.call(method, path, json=body)
            for item in page.get("results") or []:
                yield item
                n += 1
                if n >= limit:
                    return
            if not page.get("has_more") or not page.get("next_cursor"):
                return
            cursor = page["next_cursor"]

    async def download(self, url: str, path: str, max_bytes: int) -> int | None:
        """A file Notion holds (or an external one), to ``path``: its size, -1 when larger than ``max_bytes``,
        None when the link didn't work (expired, gone). No Authorization header: the URL is signed."""
        if self._http is None:
            self._http = _http()
        try:
            async with self._http.stream("GET", url) as r:
                if r.status_code >= 400:
                    return None
                n = 0
                with open(path, "wb") as f:
                    async for chunk in r.aiter_bytes():
                        n += len(chunk)
                        if n > max_bytes:
                            return -1
                        f.write(chunk)
                return n
        except httpx.HTTPError:
            return None
