"""Read tickets (access policy §2.7).

A successful read of a document returns ``read_ticket``: an HMAC token naming
the document and its current access epoch, valid six hours. The live socket and
the view/read beacons require one for any document an anonymous visitor could
not read; for anonymous-readable documents none is needed.

A ticket minted before a narrowing (epoch bump) no longer matches the document
and is refused — silently: the socket is accepted and stays quiet, the beacon
answers 202/204 without recording, so neither is an existence oracle (I5).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import jwt

from app.config import get_settings

settings = get_settings()
TTL = timedelta(hours=6)
_TYP = "rt"


def mint(doc_id: str, epoch: int, *, ttl: timedelta = TTL) -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {"typ": _TYP, "d": doc_id, "e": int(epoch), "iat": now, "exp": now + ttl},
        settings.auth_secret,
        algorithm="HS256",
    )


def valid_for(ticket: str | None, doc: dict) -> bool:
    """Does ``ticket`` admit its holder to ``doc`` *now*?"""
    if not ticket or not doc or doc.get("_id") is None:
        return False
    try:
        claims = jwt.decode(ticket, settings.auth_secret, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        return False
    return (
        claims.get("typ") == _TYP
        and claims.get("d") == str(doc["_id"])
        and int(claims.get("e", -1)) == int(doc.get("access_epoch") or 0)
    )
