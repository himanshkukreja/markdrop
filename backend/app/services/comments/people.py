"""Who a comment can @mention (CONTRACT §5 ``/people``), and checking the mentions a comment carries.

Candidates are the people around the item — its owner, the members of its workspace, the people it was
shared with, and whoever already took part in its threads — each marked ``has_access`` from the access
layer now. Typing a full email that isn't one of them answers ``invite`` (with whether the caller may
share the item), never whether that address has an account: the picker is no lookup service.

Emails are shown only to someone with a relationship to the item (owner, member, grantee) on markdrop.in,
never on a workspace's own domain (as the page editor's mention list).
"""

from __future__ import annotations

import re

from bson import ObjectId

from app.services import access
from app.services.comments import perms as perms_mod
from app.services.comments.model import MAX_MENTIONS, THREADS

LIMIT = 20
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _oid(v) -> ObjectId | None:
    try:
        return ObjectId(str(v))
    except Exception:
        return None


async def _candidate_ids(db, raw: dict, ctx) -> list[str]:
    ids: list[str] = []
    if raw.get("owner_id"):
        ids.append(str(raw["owner_id"]))
    f = await access.facts(access.Actor(), raw, ctx)
    if f.ws_id:
        async for m in db["memberships"].find({"workspace_id": f.ws_id}, {"user_id": 1}).limit(500):
            ids.append(str(m["user_id"]))
    emails = [g.get("email") async for g in db["document_grants"].find(
        {"document_id": str(raw["_id"])}, {"email": 1}).limit(200)]
    if emails:
        async for u in db["users"].find({"email": {"$in": emails}}, {"_id": 1}).limit(200):
            ids.append(str(u["_id"]))
    async for t in db[THREADS].find({"doc_id": str(raw["_id"]), "deleted_at": None}, {"participants": 1}).limit(500):
        ids.extend(t.get("participants") or [])
    return list(dict.fromkeys(i for i in ids if i))


async def _can_read(db, raw: dict, user_row: dict) -> bool:
    from app.services.notifications import _as_user

    d = await access.can(access.Actor.of(_as_user(user_row)), raw, "read", access.Ctx(db))
    return bool(d.allowed)


async def mentionable(db, actor, raw: dict, ctx, q: str | None = None, limit: int = LIMIT) -> dict:
    await perms_mod.require(db, actor, raw, ctx, "comment")
    f = await access.facts(actor, raw, ctx)
    show_email = f.role is not None and actor.cred != "tenant"
    ids = await _candidate_ids(db, raw, ctx)
    oids = [o for o in (_oid(i) for i in ids) if o is not None]
    rows = await db["users"].find({"_id": {"$in": oids}}, {"name": 1, "email": 1, "picture": 1}) \
        .to_list(length=len(oids) or 1)
    needle = (q or "").strip().lower()
    out = []
    from app.services.comments.service import _display_name

    matched = []
    for u in rows:
        name = _display_name(u)
        email = (u.get("email") or "").lower()
        if needle and not (needle in name.lower() or (show_email and email.startswith(needle))):
            continue
        matched.append((name, u))
    # Access is decided per person, so only for the few the picker can show (a big workspace has hundreds).
    matched.sort(key=lambda x: (str(x[1]["_id"]) == actor.user_id, x[0].casefold()))
    for name, u in matched[: limit * 2]:
        pic = u.get("picture")
        out.append({"id": str(u["_id"]), "name": name,
                    "picture": pic if isinstance(pic, str) and pic.startswith("https://") else None,
                    **({"email": u.get("email")} if show_email else {}),
                    "has_access": await _can_read(db, raw, u),
                    "you": str(u["_id"]) == actor.user_id})
    out.sort(key=lambda p: (not p["has_access"], p["you"], p["name"].casefold()))
    invite = None
    if _EMAIL.match(needle) and not any((p.get("email") or "").lower() == needle for p in out):
        # With emails hidden, an address never finds anyone (no lookup); the caller is offered to share.
        can_share = (await access.can(actor, raw, "share", ctx)).allowed
        invite = {"email": needle, "has_access": False, "can_share": can_share}
    return {"people": out[:limit], "invite": invite}


async def valid_mentions(db, raw: dict, ctx, ids: list[str] | None) -> list[str]:
    """The ids that name an account which can read the item now (deduped, ≤ MAX_MENTIONS)."""
    clean = list(dict.fromkeys(str(i) for i in (ids or []) if isinstance(i, str) and ObjectId.is_valid(i)))
    clean = clean[:MAX_MENTIONS]
    if not clean:
        return []
    rows = await db["users"].find({"_id": {"$in": [ObjectId(i) for i in clean]}}).to_list(length=len(clean))
    by_id = {str(r["_id"]): r for r in rows}
    out = []
    for i in clean:
        u = by_id.get(i)
        if u is not None and await _can_read(db, raw, u):
            out.append(i)
    return out
