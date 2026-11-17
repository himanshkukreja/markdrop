"""HubSpot's APIs, as little of them as Markdrop's HubSpot integration needs (no SDK).

Auth: a workspace's HubSpot **service key** (Development › Keys › Service keys; HubSpot's credential for
in-account integrations since legacy private apps stopped being creatable, Oct 2026) or an existing
legacy **private app** access token. Both are sent the same way: ``Authorization: Bearer <token>``.
A later public OAuth app would send its own access token through :func:`api` just the same.

* :func:`token_info`  ``POST /oauth/v2/private-apps/get/access-token-info`` ``{tokenKey}`` →
  ``{userId, hubId, appId, scopes}`` (private app tokens; a service key may not answer it, and then
  the scopes are probed with cheap reads: services/hubspot.check_scopes).
* :func:`api`         everything else: ``/account-info/v3/details`` (portalId, uiDomain, timeZone),
  CRM v3 objects (contacts, companies, deals, meetings, tasks; ``…/search``; ``…/batch/read``),
  ``/crm/v3/owners``, ``/crm/v3/pipelines/deals``, associations v4
  (``/crm/v4/objects/<from>/<id>/associations/<to>``, ``…/associations/default/<to>/<id>``).

Errors: 4xx/5xx with ``{status: "error", message, category, correlationId, errors?}``; a missing scope is
403 with category ``MISSING_SCOPES``. Rate limits (privately distributed apps: 100-190 requests per
10 s per app; search: 5 requests/s per account): 429 (with ``Retry-After`` sometimes), handled by
services/hubspot.call (retries with backoff). Tests swap :data:`TRANSPORT` for an ``httpx.MockTransport``
(tests/_hubspot_fake.py), so nothing leaves the machine.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from app.config import get_settings
from app.utils.http import shared_ssl

log = logging.getLogger("markdrop.hubspot")

TRANSPORT: httpx.AsyncBaseTransport | None = None
TIMEOUT = 20.0

# HubSpot-defined association type ids (associations v4 reference).
ASSOC = {
    ("meetings", "contacts"): 200, ("meetings", "companies"): 188, ("meetings", "deals"): 212,
    ("tasks", "contacts"): 204, ("tasks", "companies"): 192, ("tasks", "deals"): 216,
}


class HubSpotError(Exception):
    def __init__(self, status: int, message: str = "", category: str = "", retry_after: float | None = None):
        super().__init__(f"{status} {message}".strip())
        self.status = status
        self.message = message
        self.category = category
        self.retry_after = retry_after

    @property
    def auth(self) -> bool:
        """The token is no good: wrong, rotated, deleted, or its key expired."""
        return self.status == 401

    @property
    def scope(self) -> bool:
        return self.status == 403 or self.category == "MISSING_SCOPES"

    @property
    def missing(self) -> bool:
        return self.status == 404

    @property
    def limited(self) -> bool:
        return self.status == 429

    @property
    def retryable(self) -> bool:
        return self.status == 429 or self.status >= 500


def api_base() -> str:
    return get_settings().hubspot_api_base.rstrip("/")


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(verify=shared_ssl(), timeout=TIMEOUT, transport=TRANSPORT)


def _error(r: httpx.Response) -> HubSpotError:
    message, category = "", ""
    try:
        body = r.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        message = str(body.get("message") or body.get("error") or "")[:300]
        category = str(body.get("category") or "")
    elif r.text:
        message = r.text[:200]
    ra = r.headers.get("Retry-After")
    try:
        retry = float(ra) if ra else None
    except ValueError:
        retry = None
    return HubSpotError(r.status_code, message, category, retry)


async def api(method: str, path: str, token: str, *, params: dict | None = None, json: Any = None) -> Any:
    async with _client() as c:
        r = await c.request(method, api_base() + "/" + path.lstrip("/"), params=params, json=json,
                            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
    if r.status_code >= 400:
        raise _error(r)
    if r.status_code == 204 or not r.content:
        return None
    return r.json()


async def token_info(token: str) -> dict:
    """``{userId, hubId, appId, scopes}`` for a private app token (the token goes in the body)."""
    async with _client() as c:
        r = await c.post(api_base() + "/oauth/v2/private-apps/get/access-token-info", json={"tokenKey": token},
                         headers={"Accept": "application/json"})
    if r.status_code >= 400:
        raise _error(r)
    return r.json()
