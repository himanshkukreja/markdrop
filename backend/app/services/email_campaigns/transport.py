"""How campaign mail leaves the building.

``resend``   (the live mode, whichever providers are configured) the one send
             path in ``services/email_delivery.py``: a batch goes to the first
             provider with room under today's limits (Resend's batch API, up to
             100 messages per request, ``Idempotency-Key`` per batch so a re-post
             after a crash never sends twice, ``x-batch-validation: permissive``
             so one bad address fails that message, not the batch; or Brevo, one
             request per message), falls back to the next on a provider error,
             and logs every message in ``email_log``. Over the bulk share of the
             day's limit the batch raises ``SendError(deferred=True)`` and the
             campaign waits for the next UTC day.
``console``  the dry run used whenever no provider key is set (local
             development) or MARKDROP_EMAIL_TRANSPORT=console: renders exactly
             what would be sent, logs a line, stores the message in the
             ``email_outbox`` collection (kept 7 days) and returns a fake id.
             Nothing is emailed. Addresses whose local part contains "+fail"
             are rejected, so failure handling can be exercised locally.
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import httpx
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings

settings = get_settings()
log = logging.getLogger("uvicorn.error").getChild("email")

RESEND_DOMAINS_URL = "https://api.resend.com/domains"
MAX_BATCH = 100


def mode() -> str:
    from app.services import email_delivery

    if (settings.email_transport or "").lower() == "console" or not email_delivery.configured():
        return "console"
    return "resend"


class SendError(Exception):
    """A request-level failure.

    ``fatal``: the sender, key or account is the problem (auth, unverified
    domain, quota). Retrying won't help; the campaign pauses with the message.
    ``retry_after``: rate limited; try the same batch again after that many
    seconds. Otherwise transient (network, 5xx).
    """

    def __init__(self, message: str, *, fatal: bool = False, retry_after: float | None = None,
                 status: int | None = None, code: str | None = None, deferred: bool = False):
        super().__init__(message)
        self.fatal = fatal
        # Today's email limit has no room for it: wait for the next UTC day.
        self.deferred = deferred
        self.retry_after = retry_after
        self.status = status
        self.code = code


@dataclass
class Outcome:
    provider_id: str | None
    error: str | None


def format_from(name: str | None, email: str) -> str:
    n = (name or "").replace('"', "").replace("\r", "").replace("\n", "").strip()
    return f"{n} <{email}>" if n else email


class ConsoleTransport:
    name = "console"

    def __init__(self, db: AsyncIOMotorDatabase | None):
        self.db = db

    async def send_batch(self, messages: list[dict[str, Any]], idem_key: str) -> list[Outcome]:
        await asyncio.sleep(0.02)
        now = datetime.now(timezone.utc)
        out: list[Outcome] = []
        rows: list[dict[str, Any]] = []
        for m in messages:
            to = (m.get("to") or [""])[0]
            if "+fail" in to.split("@")[0]:
                out.append(Outcome(None, "console: simulated rejection (+fail address)"))
                continue
            pid = f"console-{secrets.token_hex(8)}"
            out.append(Outcome(pid, None))
            hdr = m.get("headers") or {}
            rows.append({
                "_id": pid, "ts": now, "idempotency_key": idem_key, "to": to, "from": m.get("from"),
                "reply_to": m.get("reply_to"), "subject": m.get("subject"), "html": m.get("html"),
                "text": m.get("text"), "headers": hdr, "campaign": hdr.get("X-Markdrop-Campaign"),
                "message_id": hdr.get("X-Markdrop-Message"),
            })
            log.info("[email:console] %s → %s · %r · %d bytes · not sent", m.get("from"), to, m.get("subject"),
                     len(json.dumps(m)))
        if rows and self.db is not None:
            await self.db["email_outbox"].insert_many(rows, ordered=False)
        return out


def _as_send_error(e: Exception) -> SendError:
    from app.services import email_delivery as d

    if isinstance(e, d.NoRoom):
        return SendError(str(e), deferred=True)
    assert isinstance(e, d.ProviderError)
    s, code = e.status, e.code
    if e.quota:
        return SendError(f"Every email provider is at its quota today ({e}).", deferred=True, status=s, code=code)
    if s == 429:
        return SendError(str(e), retry_after=e.retry_after or 2.0, status=s, code=code)
    if s == 409 and code == "concurrent_idempotent_requests":
        return SendError(str(e), retry_after=1.0, status=s, code=code)
    if s in (400, 401, 403, 422):
        return SendError(str(e), fatal=True, status=s, code=code)
    return SendError(str(e), status=s, code=code)


class RoutedTransport:
    """Live sending through ``services/email_delivery`` (limits, fallback, log)."""

    name = "resend"

    def __init__(self, db: AsyncIOMotorDatabase):
        from app.services import email_delivery

        self.inner = email_delivery.RoutedTransport(db)

    async def room(self) -> int:
        """The largest batch today's limits allow (one provider takes a batch)."""
        return await self.inner.room()

    async def send_batch(self, messages: list[dict[str, Any]], idem_key: str) -> list[Outcome]:
        from app.services import email_delivery as d

        try:
            out = await self.inner.send_batch(messages, idem_key)
        except (d.NoRoom, d.ProviderError) as e:
            raise _as_send_error(e) from e
        return [Outcome(o.provider_id, o.error) for o in out]

    async def repost(self, messages: list[dict[str, Any]], idem_key: str) -> list[Outcome]:
        from app.services import email_delivery as d

        try:
            out = await self.inner.repost(messages, idem_key)
        except (d.NoRoom, d.ProviderError) as e:
            raise _as_send_error(e) from e
        return [Outcome(o.provider_id, o.error) for o in out]


def make(db: AsyncIOMotorDatabase | None):
    if mode() == "console" or db is None:
        return ConsoleTransport(db)
    return RoutedTransport(db)


async def fetch_domains() -> dict[str, Any]:
    """Resend's domain list, for the sender identity check.

    A send-only key answers 401/403 ("restricted_api_key"): that is reported as
    ``restricted`` (a warning, not a failure: the key can still send).
    """
    if mode() == "console":
        return {"state": "console", "domains": {}, "message": "Console transport: identities aren't checked."}
    if not settings.resend_api_key:
        return {"state": "restricted", "domains": {},
                "message": "Resend isn't configured, so domains can't be checked here. Brevo refuses senders it hasn't verified at send time."}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(RESEND_DOMAINS_URL, headers={"Authorization": f"Bearer {settings.resend_api_key}"})
    except httpx.HTTPError as e:
        return {"state": "error", "domains": {}, "message": f"Couldn't reach Resend ({e.__class__.__name__})."}
    if resp.status_code in (401, 403):
        return {"state": "restricted", "domains": {},
                "message": "This API key is send-only, so domains can't be checked from here. Resend still refuses unverified senders at send time."}
    if resp.status_code >= 400:
        return {"state": "error", "domains": {}, "message": f"Resend answered {resp.status_code} for /domains."}
    data = resp.json().get("data") or []
    return {
        "state": "ok",
        "domains": {str(d.get("name", "")).lower(): str(d.get("status", "unknown")) for d in data if d.get("name")},
        "message": None,
    }
