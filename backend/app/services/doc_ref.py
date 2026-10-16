"""Opaque document references for third-party analytics.

A document's slug is its capability: anyone holding a link-access slug can read
the document (frontend lib/analyticsPath.ts). So PostHog and Google Analytics
never receive slugs. The viewer reports `doc_ref` instead: a keyed hash of the
document's internal id. It is stable (the same document always has the same
ref, so reads aggregate), it can't be turned back into a slug without our key,
and it opens nothing.

The admin Journeys tab resolves refs back to slugs and titles with
`resolve_refs`, which hashes every document id once and caches the map.
"""

import hashlib
import hmac
import time

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings

settings = get_settings()

_REF_LEN = 16  # 64 bits: no collisions at this scale, short in event payloads
_CACHE_TTL = 600

_map: dict[str, dict] = {}
_map_built_at = 0.0


def _key() -> bytes:
    secret = settings.doc_ref_secret or f"{settings.auth_secret}:doc-ref"
    return secret.encode()


def doc_ref(doc_id: object) -> str | None:
    """The analytics reference for a document id, or None without one."""
    if not doc_id:
        return None
    return hmac.new(_key(), str(doc_id).encode(), hashlib.sha256).hexdigest()[:_REF_LEN]


async def _build_map(db: AsyncIOMotorDatabase) -> dict[str, dict]:
    out: dict[str, dict] = {}
    cursor = db["documents"].find(
        {}, {"_id": 1, "slug": 1, "title": 1, "kind": 1, "encrypted": 1, "owner_id": 1}
    )
    async for raw in cursor:
        ref = doc_ref(raw["_id"])
        if ref:
            out[ref] = {
                "slug": raw.get("slug"),
                # An encrypted document's stored title is not readable text.
                "title": None if raw.get("encrypted") else raw.get("title"),
                "kind": raw.get("kind") or "document",
                "encrypted": bool(raw.get("encrypted")),
                "owner_id": raw.get("owner_id"),
            }
    return out


async def resolve_refs(db: AsyncIOMotorDatabase, refs: set[str]) -> dict[str, dict]:
    """Map refs to {slug, title, kind, encrypted, owner_id}; unknown refs are left out.

    Rebuilds the whole map at most every ten minutes, or sooner when a ref is
    missing (a document published since the last build).
    """
    global _map, _map_built_at
    refs = {r for r in refs if r}
    if not refs:
        return {}
    stale = time.monotonic() - _map_built_at > _CACHE_TTL
    if stale or not refs.issubset(_map.keys()):
        # A ref that is still missing after a rebuild belongs to a deleted
        # document; don't rebuild again for it within the minute.
        if stale or time.monotonic() - _map_built_at > 60:
            _map = await _build_map(db)
            _map_built_at = time.monotonic()
    return {r: _map[r] for r in refs if r in _map}
