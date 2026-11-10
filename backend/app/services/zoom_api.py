"""Zoom's APIs, as little of them as Markdrop's Zoom integration needs (no SDK).

* Server-to-Server OAuth: :func:`token` (``POST <auth>/oauth/token?grant_type=account_credentials``,
  HTTP Basic with the app's Client ID and Secret). An hour-long access token; there is no refresh
  token (a new one is fetched the same way).
* REST v2: :func:`api` (``<api>/<path>``) and :func:`download` (a recording file's ``download_url``,
  with the access token as a Bearer).

Tests swap :data:`TRANSPORT` for an ``httpx.MockTransport`` (tests/_zoom_fake.py), so nothing leaves
the machine. Zoom answers errors with a 4xx/5xx and ``{"code": n, "message": "…"}`` (OAuth errors:
``{"reason": "…", "error": "…"}``); :class:`ZoomError` carries the status, Zoom's code and a reason.
"""

from __future__ import annotations

import base64
import logging
from typing import Any
from urllib.parse import quote

import httpx

from app.config import get_settings
from app.utils.http import shared_ssl

log = logging.getLogger("markdrop.zoom")

TRANSPORT: httpx.AsyncBaseTransport | None = None
TIMEOUT = 15.0
MAX_TRANSCRIPT_BYTES = 8_000_000


class ZoomError(Exception):
    def __init__(self, status: int, reason: str = "", code: Any = None, retry_after: float | None = None):
        super().__init__(f"{status} {reason}".strip())
        self.status = status
        self.reason = reason
        self.code = code
        self.retry_after = retry_after

    @property
    def auth(self) -> bool:
        """The app's credentials (or its token) are no good: wrong, deactivated or deleted."""
        return self.status == 401 or self.reason in ("invalid_client", "invalid_request", "unauthorized_client")

    @property
    def scope(self) -> bool:
        """The token lacks a scope this call needs (Zoom: 400 code 4711, or 403)."""
        return self.code in (4711, 4700) or self.status == 403

    @property
    def missing(self) -> bool:
        return self.status == 404 or self.code in (1001, 3301, 3001)

    @property
    def limited(self) -> bool:
        return self.status == 429


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(verify=shared_ssl(), timeout=TIMEOUT, transport=TRANSPORT, follow_redirects=True)


def auth_base() -> str:
    return get_settings().zoom_auth_base.rstrip("/")


def api_base() -> str:
    return get_settings().zoom_api_base.rstrip("/")


def uuid_path(uuid: str) -> str:
    """A meeting UUID in a path: Zoom wants it double-encoded when it starts with "/" or has "//"."""
    once = quote(uuid, safe="")
    return quote(once, safe="") if uuid.startswith("/") or "//" in uuid else once


def _error(r: httpx.Response) -> ZoomError:
    reason, code = "", None
    try:
        body = r.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        code = body.get("code")
        reason = str(body.get("reason") or body.get("message") or body.get("error") or "")[:300]
        if body.get("error") and r.request.url.path.endswith("/oauth/token"):
            reason = str(body.get("error"))
    elif r.text:
        reason = r.text[:200]
    ra = r.headers.get("Retry-After")
    try:
        retry = float(ra) if ra else None
    except ValueError:
        retry = None
    return ZoomError(r.status_code, reason, code, retry)


async def token(account_id: str, client_id: str, client_secret: str) -> dict:
    """``{access_token, expires_in, scope}`` for a Server-to-Server OAuth app."""
    basic = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    async with _client() as c:
        r = await c.post(auth_base() + "/oauth/token", params={"grant_type": "account_credentials", "account_id": account_id},
                         headers={"Authorization": f"Basic {basic}"})
    if r.status_code >= 400:
        raise _error(r)
    return r.json()


async def api(method: str, path: str, access_token: str, *, params: dict | None = None, json: Any = None) -> Any:
    async with _client() as c:
        r = await c.request(method, api_base() + "/" + path.lstrip("/"), params=params, json=json,
                            headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"})
    if r.status_code >= 400:
        raise _error(r)
    if r.status_code == 204 or not r.content:
        return None
    return r.json()


async def download(url: str, access_token: str) -> str:
    """A recording file (the transcript, a WebVTT file) as text."""
    async with _client() as c:
        r = await c.get(url, headers={"Authorization": f"Bearer {access_token}"})
    if r.status_code >= 400:
        raise _error(r)
    if len(r.content) > MAX_TRANSCRIPT_BYTES:
        raise ZoomError(413, "The transcript is too big to import.")
    return r.content.decode("utf-8", errors="replace")
