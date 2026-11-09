"""Atlassian's APIs, as little of them as Markdrop's Jira integration needs (no SDK).

* OAuth 2.0 (3LO): :func:`token` (``POST <auth>/oauth/token``: the code exchange and the refresh,
  JSON bodies) and :func:`accessible_resources` (the Jira sites a token reaches).
* Jira Cloud REST v3 on a site: :func:`jira` (``<api>/ex/jira/<cloud id>/rest/api/3/<path>``).

Tests swap :data:`TRANSPORT` for an ``httpx.MockTransport`` (the house pattern, like slack_api), so
nothing leaves the machine. Atlassian answers errors with a 4xx/5xx and a JSON body
(``errorMessages`` / ``errors`` / ``error``); :class:`JiraError` carries the status and a short reason.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx

from app.config import get_settings
from app.utils.http import shared_ssl

log = logging.getLogger("markdrop.jira")

TRANSPORT: httpx.AsyncBaseTransport | None = None
TIMEOUT = 12.0


class JiraError(Exception):
    def __init__(self, status: int, reason: str = "", body: Any = None):
        super().__init__(f"{status} {reason}".strip())
        self.status = status
        self.reason = reason
        self.body = body

    @property
    def auth(self) -> bool:
        """The token is no good (expired, revoked, or the refresh token was used up)."""
        return self.status == 401 or self.reason in ("invalid_grant", "unauthorized_client", "access_denied")

    @property
    def forbidden(self) -> bool:
        return self.status == 403

    @property
    def missing(self) -> bool:
        return self.status == 404


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(verify=shared_ssl(), timeout=TIMEOUT, transport=TRANSPORT)


def auth_base() -> str:
    return get_settings().atlassian_auth_base.rstrip("/")


def api_base() -> str:
    return get_settings().atlassian_api_base.rstrip("/")


def _reason(r: httpx.Response) -> tuple[str, Any]:
    try:
        body = r.json()
    except ValueError:
        return (r.text or "")[:200], None
    if isinstance(body, dict):
        msgs = body.get("errorMessages") or []
        errs = body.get("errors") or {}
        if body.get("error") and isinstance(body.get("error"), str):
            return body["error"], body
        if msgs:
            return "; ".join(str(m) for m in msgs)[:300], body
        if isinstance(errs, dict) and errs:
            return "; ".join(f"{k}: {v}" for k, v in errs.items())[:300], body
        if body.get("message"):
            return str(body["message"])[:300], body
    return "", body


async def _send(method: str, url: str, *, token: str | None = None, body: Any = None,
                params: dict | None = None) -> Any:
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    kw: dict[str, Any] = {"headers": headers}
    if params:
        kw["params"] = {k: v for k, v in params.items() if v is not None}
    if body is not None:
        headers["Content-Type"] = "application/json"
        kw["content"] = json.dumps(body)
    try:
        async with _client() as c:
            r = await c.request(method, url, **kw)
    except httpx.HTTPError as exc:
        log.info("jira %s %s: %s", method, url.split("?")[0], type(exc).__name__)
        raise JiraError(0, "network_error") from exc
    if r.status_code >= 400:
        reason, parsed = _reason(r)
        raise JiraError(r.status_code, reason, parsed)
    if r.status_code == 204 or not r.content:
        return None
    try:
        return r.json()
    except ValueError:
        return None


async def token(**data: Any) -> dict:
    """``POST <auth>/oauth/token`` with the client id and secret: the code exchange
    (``grant_type="authorization_code", code, redirect_uri``) or a refresh
    (``grant_type="refresh_token", refresh_token``)."""
    s = get_settings()
    body = {"client_id": s.atlassian_client_id, "client_secret": s.atlassian_client_secret, **data}
    out = await _send("POST", auth_base() + "/oauth/token", body=body)
    if not isinstance(out, dict) or not out.get("access_token"):
        raise JiraError(502, "no_token")
    return out


async def accessible_resources(access_token: str) -> list[dict]:
    out = await _send("GET", api_base() + "/oauth/token/accessible-resources", token=access_token)
    return [r for r in (out or []) if isinstance(r, dict) and r.get("id")]


def site_url(cloud_id: str, path: str) -> str:
    return f"{api_base()}/ex/jira/{cloud_id}/rest/api/3/{path.lstrip('/')}"


async def jira(method: str, cloud_id: str, path: str, access_token: str, *, body: Any = None,
               params: dict | None = None) -> Any:
    return await _send(method, site_url(cloud_id, path), token=access_token, body=body, params=params)
