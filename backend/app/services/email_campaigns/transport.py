"""How campaign mail leaves the building.

``resend``   Resend's batch API: up to 100 messages per request, each rendered
             for its own recipient. ``Idempotency-Key`` per batch (Resend keeps
             keys 24 h), so re-posting a batch after a crash never sends twice.
             ``x-batch-validation: permissive`` so one bad address fails that
             message, not the batch.
``console``  the dry run used whenever MARKDROP_RESEND_API_KEY is unset (local
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

RESEND_BATCH_URL = "https://api.resend.com/emails/batch"
RESEND_DOMAINS_URL = "https://api.resend.com/domains"
MAX_BATCH = 100


def mode() -> str:
    if (settings.email_transport or "").lower() == "console" or not settings.resend_api_key:
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
                 status: int | None = None, code: str | None = None):
        super().__init__(message)
        self.fatal = fatal
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


def _retry_after(resp: httpx.Response) -> float:
    for h in ("retry-after", "ratelimit-reset"):
        try:
            v = float(resp.headers.get(h, ""))
            if v > 0:
                return min(v, 60.0)
        except ValueError:
            pass
    return 2.0


def classify(resp: httpx.Response) -> SendError:
    try:
        body = resp.json()
    except ValueError:
        body = {}
    code = str(body.get("name") or "")
    msg = str(body.get("message") or resp.text[:300] or f"HTTP {resp.status_code}")
    s = resp.status_code
    if s in (401, 403):
        return SendError(f"Resend rejected the API key ({code or s}): {msg}", fatal=True, status=s, code=code)
    if s == 429:
        if "quota" in code:
            return SendError(f"Resend quota reached ({code}): {msg}", fatal=True, status=s, code=code)
        return SendError(f"Rate limited by Resend: {msg}", retry_after=_retry_after(resp), status=s, code=code)
    if s == 422 or s == 400:
        # Validation errors here are about the sender or the payload as a whole
        # (permissive mode reports single bad recipients per message instead):
        # an unverified domain, a malformed From. Same for every message.
        return SendError(f"Resend refused the batch ({code or s}): {msg}", fatal=True, status=s, code=code)
    if s == 409:
        if code == "concurrent_idempotent_requests":
            return SendError(msg, retry_after=1.0, status=s, code=code)
        return SendError(f"Resend idempotency conflict ({code}): {msg}", status=s, code=code)
    return SendError(f"Resend error {s}: {msg}", status=s, code=code)


class ResendTransport:
    name = "resend"

    async def send_batch(self, messages: list[dict[str, Any]], idem_key: str) -> list[Outcome]:
        headers = {
            "Authorization": f"Bearer {settings.resend_api_key}",
            "Idempotency-Key": idem_key,
            "x-batch-validation": "permissive",
        }
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(RESEND_BATCH_URL, headers=headers, json=messages)
        except httpx.HTTPError as e:
            raise SendError(f"Couldn't reach Resend: {e.__class__.__name__}") from e
        if resp.status_code >= 400:
            raise classify(resp)
        body = resp.json() if resp.content else {}
        data = list(body.get("data") or [])
        errors = {int(e.get("index", -1)): str(e.get("message") or "rejected") for e in body.get("errors") or []}
        out: list[Outcome] = []
        it = iter(data)
        for i in range(len(messages)):
            if i in errors:
                out.append(Outcome(None, errors[i][:400]))
            else:
                item = next(it, None) or {}
                out.append(Outcome(item.get("id"), None))
        return out


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


def make(db: AsyncIOMotorDatabase | None):
    return ConsoleTransport(db) if mode() == "console" else ResendTransport()


async def fetch_domains() -> dict[str, Any]:
    """Resend's domain list, for the sender identity check.

    A send-only key answers 401/403 ("restricted_api_key"): that is reported as
    ``restricted`` (a warning, not a failure: the key can still send).
    """
    if mode() == "console":
        return {"state": "console", "domains": {}, "message": "Console transport: identities aren't checked."}
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
