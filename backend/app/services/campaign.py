"""Email campaigns — bulk announcements sent from the admin dashboard.

Reuses the existing Resend transport, but bulk mail is a different animal from
the transactional login/welcome mail already in ``mailer.py``:

* It legally needs a working unsubscribe (CAN-SPAM, and GDPR for EU recipients),
  so every send carries a signed one-click link and a ``List-Unsubscribe``
  header, and unsubscribed users are filtered out of every audience.
* It goes out in batches with pacing, because Resend rate-limits and a blast to
  every user in one loop would trip it.
* It should not share a From address with the sign-in mail. A spam complaint
  against an announcement can hurt deliverability of the login codes people
  actually need, so the From address is per-campaign.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import re
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings

settings = get_settings()

_BATCH_URL = "https://api.resend.com/emails/batch"
# Resend accepts up to 100 messages per batch call.
BATCH_SIZE = 100
# Pause between batches so a large send doesn't trip the API rate limit.
BATCH_PAUSE_SECONDS = 1.0

AUDIENCES = ("all", "with_documents", "with_artifacts", "recent", "custom")


# ── Unsubscribe tokens ─────────────────────────────────────────────────────────


def unsubscribe_token(user_id: str) -> str:
    """Signed, non-guessable opt-out token. Reuses the auth secret; it only ever
    grants the ability to stop receiving mail, so it needs no expiry."""
    sig = hmac.new(
        settings.auth_secret.encode(), f"unsub:{user_id}".encode(), hashlib.sha256
    ).hexdigest()[:32]
    return f"{user_id}.{sig}"


def verify_unsubscribe_token(token: str) -> str | None:
    try:
        user_id, sig = token.rsplit(".", 1)
    except ValueError:
        return None
    expected = unsubscribe_token(user_id).rsplit(".", 1)[1]
    return user_id if hmac.compare_digest(sig, expected) else None


def unsubscribe_url(user_id: str) -> str:
    return (
        f"{settings.api_base_url.rstrip('/')}/api/v1/unsubscribe"
        f"?t={unsubscribe_token(user_id)}"
    )


# ── Audience ───────────────────────────────────────────────────────────────────


async def resolve_audience(
    db: AsyncIOMotorDatabase,
    audience: str,
    *,
    recent_days: int = 30,
    emails: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Recipients for an audience, as ``[{id, email, name}]``.

    Unsubscribed users are excluded from every audience including ``custom`` —
    an explicit list must not be a way to mail someone who opted out.
    """
    query: dict[str, Any] = {"unsubscribed_at": None}

    if audience == "recent":
        query["created_at"] = {"$gte": datetime.now(timezone.utc) - timedelta(days=recent_days)}
    elif audience == "custom":
        cleaned = [e.strip().lower() for e in (emails or []) if e and "@" in e]
        if not cleaned:
            return []
        query["email"] = {"$in": cleaned}
    elif audience in ("with_documents", "with_artifacts"):
        doc_query: dict[str, Any] = {"owner_id": {"$ne": None}}
        if audience == "with_artifacts":
            doc_query["kind"] = "artifact"
        owner_ids = await db["documents"].distinct("owner_id", doc_query)
        valid = [ObjectId(o) for o in owner_ids if o and ObjectId.is_valid(o)]
        if not valid:
            return []
        query["_id"] = {"$in": valid}

    # `unsubscribed_at: None` also has to match users predating the field.
    query = {"$and": [{k: v for k, v in query.items() if k != "unsubscribed_at"},
                      {"$or": [{"unsubscribed_at": None}, {"unsubscribed_at": {"$exists": False}}]}]}

    cursor = db["users"].find(query, {"email": 1, "name": 1})
    return [
        {"id": str(u["_id"]), "email": u["email"], "name": u.get("name")}
        for u in await cursor.to_list(length=10000)
        if u.get("email")
    ]


# ── Rendering ──────────────────────────────────────────────────────────────────

_UNSUB_MARKER = re.compile(r"\{\{\s*unsubscribe_url\s*\}\}", re.I)


def render(html: str, recipient: dict[str, Any]) -> str:
    """Substitute per-recipient placeholders and guarantee an unsubscribe link.

    Supported: ``{{name}}``, ``{{email}}``, ``{{unsubscribe_url}}``. If the
    template never references the unsubscribe URL, a plain footer is appended —
    a bulk send must not be able to go out without one.
    """
    unsub = unsubscribe_url(recipient["id"])
    name = (recipient.get("name") or "").strip() or "there"

    out = html
    out = re.sub(r"\{\{\s*name\s*\}\}", name, out, flags=re.I)
    out = re.sub(r"\{\{\s*email\s*\}\}", recipient["email"], out, flags=re.I)

    if _UNSUB_MARKER.search(out):
        return _UNSUB_MARKER.sub(unsub, out)

    footer = (
        '<div style="margin-top:28px;padding-top:16px;border-top:1px solid #e5e7eb;'
        'font:12px -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#9ca3af;'
        'text-align:center">'
        f'<a href="{unsub}" style="color:#9ca3af">Unsubscribe from Markdrop updates</a>'
        "</div>"
    )
    # A template may be a full document; appending past </body> puts the footer
    # outside the document, where some clients drop it — and a dropped footer
    # means a send with no working opt-out.
    lower = out.lower()
    idx = lower.rfind("</body>")
    if idx == -1:
        idx = lower.rfind("</html>")
    return out[:idx] + footer + out[idx:] if idx != -1 else out + footer


# ── Sending ────────────────────────────────────────────────────────────────────


async def _send_batch(
    client: httpx.AsyncClient, sender: str, subject: str, items: list[dict[str, Any]]
) -> tuple[int, int]:
    """Send one Resend batch. Returns (sent, failed)."""
    payload = [
        {
            "from": sender,
            "to": [r["email"]],
            "subject": subject,
            "html": render(r["_html"], r),
            # One-click opt-out surfaced by the mail client itself.
            # The From address is a send-only mailbox, so replies are pointed
            # at a real inbox instead of being dropped.
            "reply_to": settings.email_reply_to,
            "headers": {
                "List-Unsubscribe": f"<{unsubscribe_url(r['id'])}>",
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            },
        }
        for r in items
    ]
    try:
        resp = await client.post(
            _BATCH_URL,
            headers={"Authorization": f"Bearer {settings.resend_api_key}"},
            json=payload,
        )
        if resp.status_code >= 400:
            return 0, len(items)
        return len(items), 0
    except Exception:
        return 0, len(items)


async def run_campaign(db: AsyncIOMotorDatabase, campaign_id: str) -> None:
    """Send a campaign in batches, recording progress as it goes.

    Runs detached from the request, so progress lives in the document rather
    than the response — the admin UI polls it.
    """
    oid = ObjectId(campaign_id)
    camp = await db["campaigns"].find_one({"_id": oid})
    if not camp or camp.get("status") != "queued":
        return

    recipients = await resolve_audience(
        db,
        camp["audience"],
        recent_days=camp.get("recent_days", 30),
        emails=camp.get("custom_emails"),
    )
    await db["campaigns"].update_one(
        {"_id": oid},
        {"$set": {"status": "sending", "total": len(recipients),
                  "started_at": datetime.now(timezone.utc)}},
    )

    sent = failed = 0
    html, subject, sender = camp["html"], camp["subject"], camp["sender"]
    async with httpx.AsyncClient(timeout=30) as client:
        for i in range(0, len(recipients), BATCH_SIZE):
            batch = [{**r, "_html": html} for r in recipients[i : i + BATCH_SIZE]]
            ok, bad = await _send_batch(client, sender, subject, batch)
            sent += ok
            failed += bad
            await db["campaigns"].update_one(
                {"_id": oid}, {"$set": {"sent": sent, "failed": failed}}
            )
            if i + BATCH_SIZE < len(recipients):
                await asyncio.sleep(BATCH_PAUSE_SECONDS)

    await db["campaigns"].update_one(
        {"_id": oid},
        {"$set": {"status": "sent" if not failed else "partial",
                  "finished_at": datetime.now(timezone.utc)}},
    )


async def send_test(to_email: str, subject: str, html: str, sender: str) -> bool:
    """Send a single preview copy so a template can be checked before the blast."""
    preview_recipient = {"id": "preview", "email": to_email, "name": "there"}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                "https://api.resend.com/emails",
                headers={"Authorization": f"Bearer {settings.resend_api_key}"},
                json={
                    "from": sender,
                    "to": [to_email],
                    "subject": f"[TEST] {subject}",
                    "reply_to": settings.email_reply_to,
                    "html": render(html, preview_recipient),
                },
            )
            return resp.status_code < 400
    except Exception:
        return False
