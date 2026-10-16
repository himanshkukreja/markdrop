"""From addresses for campaigns.

The env sender (``MARKDROP_EMAIL_CAMPAIGN_FROM``, else ``updates@`` on the
``email_from`` domain) is always listed, read-only, and is the default unless a
saved sender is marked default. Saved senders live in ``email_senders``.

Identity check: Resend's ``GET /domains`` (cached 5 minutes) says whether the
From domain is verified. ``bad`` blocks tests and sends in live mode; ``warn``
(e.g. a send-only key that can't list domains) never blocks.
"""

from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from typing import Any

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings

from . import store, transport

settings = get_settings()

EMAIL_RE = re.compile(r"^[^\s@<>,;\"']+@[^\s@<>,;\"']+\.[^\s@<>,;\"']+$")
ENV_ID = "env"

_cache: dict[str, Any] = {"at": 0.0, "value": None}
_TTL = 300.0


def is_email(s: str | None) -> bool:
    return bool(s) and len(s) <= 254 and bool(EMAIL_RE.match(s))


def env_from_email() -> str:
    if settings.email_campaign_from:
        return settings.email_campaign_from.strip().lower()
    domain = settings.email_from.split("@")[-1] if "@" in settings.email_from else ""
    return f"updates@{domain}" if domain else settings.email_from


def env_sender() -> dict[str, Any]:
    return {
        "id": ENV_ID,
        "label": "Env default",
        "from_name": settings.email_from_name,
        "from_email": env_from_email(),
        "reply_to": settings.email_reply_to or None,
        "is_default": True,
        "source": "env",
    }


async def domains(force: bool = False) -> dict[str, Any]:
    now = time.monotonic()
    if not force and _cache["value"] is not None and now - _cache["at"] < _TTL:
        return _cache["value"]
    value = await transport.fetch_domains()
    value["checked_at"] = datetime.now(timezone.utc).isoformat()
    _cache.update(at=now, value=value)
    return value


def check(sender: dict[str, Any], info: dict[str, Any]) -> dict[str, str]:
    email = sender.get("from_email") or ""
    if not is_email(email):
        return {"level": "bad", "message": "The From address isn't valid."}
    if sender.get("reply_to") and not is_email(sender["reply_to"]):
        return {"level": "bad", "message": "The reply-to address isn't valid."}
    domain = email.split("@", 1)[1].lower()
    state = info.get("state")
    if state == "console":
        return {"level": "warn", "message": f"Console transport: {domain} isn't checked, and nothing is emailed."}
    if state == "restricted":
        return {"level": "warn", "message": f"Can't verify {domain} with this key (send-only). Resend refuses unverified domains when sending."}
    if state != "ok":
        return {"level": "warn", "message": info.get("message") or f"Couldn't check {domain} with Resend."}
    status = info.get("domains", {}).get(domain)
    if status == "verified":
        return {"level": "ok", "message": f"{domain} is verified in Resend."}
    if status is None:
        return {"level": "bad", "message": f"{domain} isn't added to Resend. Add and verify it (SPF + DKIM) before sending from it."}
    return {"level": "bad", "message": f"{domain} is “{status.replace('_', ' ')}” in Resend, not verified yet."}


def _public(doc: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(doc["_id"]),
        "label": doc.get("label") or "",
        "from_name": doc.get("from_name") or "",
        "from_email": doc.get("from_email") or "",
        "reply_to": doc.get("reply_to"),
        "is_default": bool(doc.get("is_default")),
        "source": "db",
        "created_at": store.iso(doc.get("created_at")),
        "updated_at": store.iso(doc.get("updated_at")),
    }


async def list_senders(db: AsyncIOMotorDatabase, *, force_check: bool = False) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    info = await domains(force_check)
    saved = [_public(d) for d in await db["email_senders"].find().sort("created_at", 1).to_list(length=200)]
    env = env_sender()
    if any(s["is_default"] for s in saved):
        env["is_default"] = False
    out = [env, *saved]
    for s in out:
        s["check"] = check(s, info)
    return out, info


async def resolve(db: AsyncIOMotorDatabase, sender_id: str | None) -> dict[str, Any]:
    senders, _ = await list_senders(db)
    return (
        (sender_id and next((s for s in senders if s["id"] == sender_id), None))
        or next((s for s in senders if s["is_default"]), None)
        or senders[0]
    )


class SenderError(ValueError):
    pass


def parse(body: Any) -> dict[str, Any]:
    b = body if isinstance(body, dict) else {}
    s = lambda v, n: v.strip()[:n] if isinstance(v, str) else ""  # noqa: E731
    from_email = s(b.get("from_email"), 254).lower()
    reply_to = s(b.get("reply_to"), 254).lower() or None
    if not is_email(from_email):
        raise SenderError("The From address isn't valid.")
    if reply_to and not is_email(reply_to):
        raise SenderError("The reply-to address isn't valid.")
    from_name = re.sub(r"[<>\"\r\n]", "", s(b.get("from_name"), 80))
    return {
        "label": s(b.get("label"), 60) or from_name or from_email,
        "from_name": from_name,
        "from_email": from_email,
        "reply_to": reply_to,
        "is_default": b.get("is_default") is True,
    }


async def save(db: AsyncIOMotorDatabase, sender_id: str | None, data: dict[str, Any]) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    if data["is_default"]:
        await db["email_senders"].update_many({"is_default": True}, {"$set": {"is_default": False}})
    if sender_id:
        if not ObjectId.is_valid(sender_id):
            raise SenderError("Unknown sender.")
        res = await db["email_senders"].find_one_and_update(
            {"_id": ObjectId(sender_id)}, {"$set": {**data, "updated_at": now}}, return_document=True
        )
        if not res:
            raise SenderError("Unknown sender.")
        return _public(res)
    doc = {**data, "created_at": now, "updated_at": now}
    res = await db["email_senders"].insert_one(doc)
    doc["_id"] = res.inserted_id
    return _public(doc)


async def delete(db: AsyncIOMotorDatabase, sender_id: str) -> bool:
    if not ObjectId.is_valid(sender_id):
        return False
    res = await db["email_senders"].delete_one({"_id": ObjectId(sender_id)})
    return res.deleted_count > 0


def snapshot(sender: dict[str, Any]) -> dict[str, Any]:
    return {k: sender.get(k) for k in ("id", "from_name", "from_email", "reply_to")}
