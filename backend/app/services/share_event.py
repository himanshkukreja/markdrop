"""Server-side logging of peer-to-peer file-share events.

The transfer itself is pure WebRTC — file bytes never touch the server. This
module records only lightweight *metadata* about a share (filename, size, mime
type and, when the sharer is signed in, their user id) so the admin dashboard
can report feature usage.

Privacy note
------------
The metadata reaches the server folded into the WebRTC signalling *offer* as a
single opaque, unlabelled base64 blob (see ``routers/share.py``). It is never
sent as a separate ``{"type": "share-log", "user": …}``-style frame, so a casual
look at the browser network tab does not reveal that a share is being attributed
to a user. The blob is stripped from the offer before it is relayed to the
recipient, so it only ever exists on the sharer→server hop. This is obfuscation,
not encryption: anything a browser sends is ultimately inspectable, but nothing
is *labelled* as user attribution.
"""

import base64
import binascii
import json
from datetime import datetime, timezone

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.utils.auth import decode_access_token
from app.services import api_token

# Field name carrying the opaque metadata blob on the signalling offer.
# Deliberately terse and generic so it reads like protocol noise.
BLOB_FIELD = "x"


def decode_blob(blob: str) -> dict | None:
    """Decode the opaque base64url metadata blob attached to an offer.

    Expected shape: {"n": name, "s": size, "m": mime, "t": token｜null}.
    Returns None for anything malformed.
    """
    if not isinstance(blob, str) or not blob:
        return None
    try:
        padded = blob + "=" * (-len(blob) % 4)
        raw = base64.urlsafe_b64decode(padded.encode())
        data = json.loads(raw)
    except (ValueError, binascii.Error, json.JSONDecodeError, UnicodeDecodeError):
        return None
    return data if isinstance(data, dict) else None


async def resolve_user_id(db: AsyncIOMotorDatabase, token: str | None) -> str | None:
    """Resolve a session JWT or ``mdk_`` API token to a user id. Never raises."""
    if not token or not isinstance(token, str):
        return None
    if token.startswith(api_token.TOKEN_PREFIX):
        return await api_token.verify_token(db, token)
    try:
        payload = decode_access_token(token)
    except Exception:
        return None
    return payload.get("sub")


async def record_share(
    db: AsyncIOMotorDatabase,
    *,
    room_id: str,
    user_id: str | None,
    file_name: str | None,
    file_size: int | None,
    mime_type: str | None,
    ip_hash: str | None,
) -> None:
    """Insert one share-event document."""
    size: int | None = None
    if isinstance(file_size, bool):
        size = None
    elif isinstance(file_size, (int, float)):
        size = int(file_size)
    await db["share_events"].insert_one(
        {
            "room_id": room_id,
            "user_id": user_id,
            "file_name": ((file_name or "").strip()[:260]) or None,
            "file_size": size,
            "mime_type": ((mime_type or "").strip()[:120]) or None,
            "ip_hash": ip_hash,
            "ts": datetime.now(timezone.utc),
        }
    )
