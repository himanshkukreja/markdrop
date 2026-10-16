"""Resend webhooks (delivery, bounce, complaint, open, click).

Resend signs webhooks with Svix: headers ``svix-id``, ``svix-timestamp`` and
``svix-signature`` (space-separated ``v1,<base64 HMAC-SHA256>``), over
``"{id}.{timestamp}.{raw body}"`` with the base64 key after ``whsec_``. The
timestamp must be within five minutes, so a captured request can't be replayed
later; a processed id is remembered for 30 days, so Resend's own retries are
no-ops.

Effects:

* ``email.delivered``  → ``delivered_at``
* ``email.bounced``    → ``bounced_at`` + bounce type; a permanent (hard) bounce
  suppresses the address, for every future campaign
* ``email.complained`` → ``complained_at``, suppression, and the account is
  marked unsubscribed
* ``email.opened`` / ``email.clicked`` → only fill ``first_open_at`` /
  ``first_click_at`` when our own pixel / redirect hasn't, so unique counts stay
  right whether or not Resend's tracking is on, and nothing is counted twice.

Bounces and complaints for mail that isn't a campaign (sign-in codes, invites)
still suppress the address for campaigns: a dead or complaining inbox is dead
for marketing too. Transactional mail never consults the suppression list.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import time
from datetime import datetime, timezone
from typing import Any

from motor.motor_asyncio import AsyncIOMotorDatabase

from . import store

TOLERANCE_S = 5 * 60


class SignatureError(ValueError):
    pass


def _key(secret: str) -> bytes:
    s = secret.strip()
    if s.startswith("whsec_"):
        s = s[len("whsec_"):]
    try:
        return base64.b64decode(s)
    except Exception as e:  # noqa: BLE001
        raise SignatureError("Webhook secret isn't valid base64.") from e


def sign(secret: str, msg_id: str, ts: str, body: bytes) -> str:
    mac = hmac.new(_key(secret), f"{msg_id}.{ts}.".encode() + body, hashlib.sha256).digest()
    return "v1," + base64.b64encode(mac).decode()


def verify(secret: str, headers: dict[str, str], body: bytes, now: float | None = None) -> None:
    msg_id = headers.get("svix-id") or headers.get("webhook-id") or ""
    ts = headers.get("svix-timestamp") or headers.get("webhook-timestamp") or ""
    sigs = headers.get("svix-signature") or headers.get("webhook-signature") or ""
    if not msg_id or not ts or not sigs:
        raise SignatureError("Missing signature headers.")
    try:
        t = int(ts)
    except ValueError as e:
        raise SignatureError("Bad timestamp.") from e
    if abs((now or time.time()) - t) > TOLERANCE_S:
        raise SignatureError("Timestamp outside the tolerance window.")
    expected = sign(secret, msg_id, ts, body).split(",", 1)[1]
    for part in sigs.split():
        version, _, sig = part.partition(",")
        if version == "v1" and hmac.compare_digest(sig, expected):
            return
    raise SignatureError("No matching signature.")


def _when(data: dict[str, Any], event: dict[str, Any]) -> datetime:
    for v in (event.get("created_at"), data.get("created_at")):
        if isinstance(v, str):
            try:
                d = datetime.fromisoformat(v.replace("Z", "+00:00"))
                return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
            except ValueError:
                pass
    return store.now()


async def handle(db: AsyncIOMotorDatabase, msg_id: str, event: dict[str, Any]) -> dict[str, Any]:
    """Apply one verified event. Idempotent per Svix id."""
    t_now = store.now()
    try:
        await db["email_webhook_events"].insert_one({"_id": msg_id, "type": event.get("type"), "ts": t_now})
    except Exception:  # duplicate key: already processed
        return {"ok": True, "duplicate": True}

    kind = str(event.get("type") or "")
    data = event.get("data") or {}
    pid = data.get("email_id") or data.get("id")
    to = data.get("to") or []
    email = (to[0] if isinstance(to, list) and to else str(to or "")).strip().lower()
    when = _when(data, event)
    m = await db["email_messages"].find_one({"provider_id": pid}) if pid else None
    result: dict[str, Any] = {"ok": True, "type": kind, "matched": bool(m)}

    async def event_row(etype: str, url: str | None = None) -> None:
        if m:
            await db["email_events"].insert_one({
                "campaign_id": m["campaign_id"], "message_id": m["_id"], "email": m.get("email"),
                "type": etype, "url": url, "ua": None, "ts": when, "source": "resend",
            })

    if kind == "email.delivered":
        if m:
            await db["email_messages"].update_one({"_id": m["_id"]}, {"$min": {"delivered_at": when}} if m.get("delivered_at") else {"$set": {"delivered_at": when}})
    elif kind == "email.bounced":
        bounce = data.get("bounce") or {}
        btype = str(bounce.get("type") or "").lower()
        hard = btype in ("permanent", "hard", "") or "permanent" in btype
        detail = str(bounce.get("message") or bounce.get("subType") or btype or "bounced")[:400]
        if m:
            await db["email_messages"].update_one({"_id": m["_id"]}, {"$set": {
                "bounced_at": when, "bounce_type": btype or "permanent", "error": f"bounced: {detail}"[:400]}})
            await event_row("bounce")
        if hard and email:
            await store.suppress(db, email, "bounced", detail)
        result["suppressed"] = bool(hard and email)
    elif kind == "email.complained":
        if m:
            await db["email_messages"].update_one({"_id": m["_id"]}, {"$set": {"complained_at": when}})
            await event_row("complaint")
        if email:
            await store.suppress(db, email, "complained", "spam complaint")
            await db["users"].update_one({"email": email, "unsubscribed_at": None}, {"$set": {"unsubscribed_at": when}})
        result["suppressed"] = bool(email)
    elif kind == "email.opened":
        if m and not m.get("first_open_at"):
            await db["email_messages"].update_one({"_id": m["_id"]}, {"$set": {"first_open_at": when}})
    elif kind == "email.clicked":
        click = data.get("click") or {}
        if m and not m.get("first_click_at"):
            await db["email_messages"].update_one({"_id": m["_id"]}, {"$set": {"first_click_at": when}, "$max": {"click_count": 1}})
            if not m.get("first_open_at"):
                await db["email_messages"].update_one({"_id": m["_id"]}, {"$set": {"first_open_at": when}})
            await event_row("click", (click.get("link") or None))
    return result
