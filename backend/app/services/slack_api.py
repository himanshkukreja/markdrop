"""Slack's Web API, as little of it as Markdrop for Slack needs (no slack_sdk / Bolt dependency).

Every call goes through :func:`call` (``https://slack.com/api/<method>``), and replies to slash
commands and button clicks through :func:`respond` (their ``response_url``, always on
hooks.slack.com). Tests swap :data:`TRANSPORT` for an ``httpx.MockTransport`` (the house pattern,
like docs_github_app), so nothing leaves the machine.

Slack answers HTTP 200 with ``{"ok": false, "error": "..."}`` for most failures; :func:`call` turns
that into :class:`SlackError` (``.error`` is Slack's code, e.g. ``channel_not_found``,
``not_in_channel``, ``invalid_auth``, ``token_revoked``, ``ratelimited``).
"""

from __future__ import annotations

import json
import logging
from typing import Any
from urllib.parse import urlsplit

import httpx

from app.config import get_settings

log = logging.getLogger("markdrop.slack")

TRANSPORT: httpx.AsyncBaseTransport | None = None
TIMEOUT = 10.0

# Methods Slack wants as application/json (the rest take form fields, including the OAuth
# exchanges, which also carry the client id and secret).
_JSON_METHODS = frozenset({
    "chat.postMessage", "chat.update", "chat.postEphemeral", "chat.unfurl", "conversations.open",
})

# Errors that mean the team's token no longer works: the install is gone.
DEAD_TOKEN = frozenset({"invalid_auth", "account_inactive", "token_revoked", "token_expired",
                        "not_authed", "team_access_not_granted", "missing_scope"})


class SlackError(Exception):
    def __init__(self, error: str, *, status: int = 200, retry_after: int | None = None):
        super().__init__(error)
        self.error = error
        self.status = status
        self.retry_after = retry_after

    @property
    def dead_token(self) -> bool:
        return self.error in DEAD_TOKEN


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=TIMEOUT, transport=TRANSPORT)


def api_url(method: str) -> str:
    return get_settings().slack_api_base.rstrip("/") + "/" + method


async def call(method: str, token: str | None = None, **data: Any) -> dict:
    """``method`` with ``data``; returns Slack's JSON (``ok`` is true) or raises SlackError."""
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    clean = {k: v for k, v in data.items() if v is not None}
    try:
        async with _client() as c:
            if method in _JSON_METHODS:
                r = await c.post(api_url(method), headers={**headers, "Content-Type": "application/json; charset=utf-8"},
                                 content=json.dumps(clean))
            else:
                form = {k: (json.dumps(v) if isinstance(v, (dict, list)) else
                            ("true" if v is True else "false" if v is False else str(v))) for k, v in clean.items()}
                r = await c.post(api_url(method), headers=headers, data=form)
    except httpx.HTTPError as exc:
        log.info("slack %s: %s", method, exc)
        raise SlackError("network_error", status=0) from exc
    if r.status_code == 429:
        ra = r.headers.get("retry-after")
        raise SlackError("ratelimited", status=429, retry_after=int(ra) if ra and ra.isdigit() else 30)
    try:
        body = r.json()
    except ValueError:
        raise SlackError(f"http_{r.status_code}", status=r.status_code)
    if not isinstance(body, dict) or not body.get("ok"):
        raise SlackError(str((body or {}).get("error") or f"http_{r.status_code}"), status=r.status_code)
    return body


def response_url_ok(url: str | None) -> bool:
    """Slack's response URLs live on hooks.slack.com (https). Anything else is never fetched."""
    if not url:
        return False
    parts = urlsplit(url)
    if parts.scheme != "https" or (parts.hostname or "").lower() != "hooks.slack.com":
        # Tests and the sandbox stack point the API elsewhere; their response URLs share its host.
        base = urlsplit(get_settings().slack_api_base)
        return bool(base.hostname) and base.hostname not in ("slack.com",) and \
            (parts.hostname or "") == base.hostname and parts.scheme == base.scheme
    return True


async def respond(response_url: str | None, payload: dict) -> bool:
    """Reply through a slash command's or a click's ``response_url`` (ephemeral unless the payload
    says otherwise). False when the URL isn't Slack's or Slack refused it."""
    if not response_url_ok(response_url):
        log.info("slack respond: refused response_url %r", (response_url or "")[:80])
        return False
    body = {"response_type": "ephemeral", **payload}
    try:
        async with _client() as c:
            r = await c.post(response_url, headers={"Content-Type": "application/json"}, content=json.dumps(body))
        return r.status_code < 300
    except httpx.HTTPError as exc:
        log.info("slack respond: %s", exc)
        return False
