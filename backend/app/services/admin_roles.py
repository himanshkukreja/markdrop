"""Who may open the admin console (markdrop.in/admin), and changes to that list.

Two kinds of admin (owner decision 2026-11-07):

- **owners**: the addresses in MARKDROP_ADMIN_EMAILS (settings.admin_email_set). They change only
  there (backend/.env, then a restart); nothing on the web can add or remove an owner. Only owners
  add and remove admins.
- **admins**: rows of the `admins` collection, keyed by lowercase email, added by an owner in
  Admin › Admins (or on the server with `scripts/admin_access.py grant`). They get every admin page
  and power except changing who is an admin. A row for an address with no account yet is a pending
  admin: it becomes an admin the first time someone signs in with that (verified) address.

The console's guard (routers/admin.require_admin) asks :func:`role_of` on every request, so a removal
takes effect on the next request. Every change is written to the admin audit log
(`admin_access_log`, action ``admin_add`` / ``admin_remove``: who, when, whom, from where) and
emailed to every owner (kind ``admin_change``); a new admin is told too.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Literal

import jwt
from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings

log = logging.getLogger(__name__)

COLLECTION = "admins"
AUDIT = "admin_access_log"
ADD, REMOVE = "admin_add", "admin_remove"
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
NOTE_MAX = 200

Role = Literal["owner", "admin"]


class RoleError(Exception):
    """A refused change: an HTTP status and a sentence for the person."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def norm(email: str | None) -> str:
    return (email or "").strip().lower()


def owners() -> frozenset[str]:
    return get_settings().admin_email_set


def is_disabled(raw: dict) -> bool:
    """A disabled account. Markdrop has no switch for this yet; a `disabled` flag or `disabled_at` /
    `deleted_at` stamp set on the user row by hand closes the console to it at once."""
    return bool(raw.get("disabled") or raw.get("disabled_at") or raw.get("deleted_at"))


async def role_of(db: AsyncIOMotorDatabase, email: str | None) -> Role | None:
    """"owner", "admin" or None for an account's email (exact, case-insensitive). A failed read of
    the admins list admits owners only (fails closed for everyone else)."""
    e = norm(email)
    if not e:
        return None
    if e in owners():
        return "owner"
    try:
        row = await db[COLLECTION].find_one({"email": e}, {"_id": 1})
    except Exception:  # pragma: no cover - a database blip never opens the console
        return None
    return "admin" if row else None


async def role_for_session(db: AsyncIOMotorDatabase, token: str, user_id: str, email: str) -> Role | None:
    """The admin role to show in /auth/me for this credential, or None. Only a credential the console
    itself would take: a full session signed in on markdrop.in (not an API or MCP token, not a custom
    domain's tenant token, not the studio host's `via` copy), for an account that isn't disabled.
    Session age doesn't matter here (the console asks a stale session to sign in again)."""
    from app.services import api_token, oauth_server
    from app.utils.auth import decode_access_token

    if not token or token.startswith((api_token.TOKEN_PREFIX, oauth_server.ACCESS_PREFIX)):
        return None
    try:
        payload = decode_access_token(token)
    except jwt.InvalidTokenError:
        return None
    if payload.get("typ") != "access" or payload.get("via") or str(payload.get("sub") or "") != user_id:
        return None
    role = await role_of(db, email)
    if role is None or not ObjectId.is_valid(user_id):
        return None
    raw = await db["users"].find_one({"_id": ObjectId(user_id)}, {"disabled": 1, "disabled_at": 1, "deleted_at": 1})
    if raw is None or is_disabled(raw):
        return None
    return role


# ── Reading ───────────────────────────────────────────────────────────────────


async def _accounts(db: AsyncIOMotorDatabase, emails: list[str]) -> dict[str, dict]:
    if not emails:
        return {}
    out: dict[str, dict] = {}
    async for u in db["users"].find({"email": {"$in": emails}}, {"email": 1, "name": 1, "picture": 1,
                                                               "disabled": 1, "disabled_at": 1, "deleted_at": 1}):
        out[norm(u.get("email"))] = u
    return out


async def _last_visits(db: AsyncIOMotorDatabase, emails: list[str]) -> dict[str, datetime]:
    """Each person's last admin console visit (an allowed access row), from the audit log."""
    if not emails:
        return {}
    out: dict[str, datetime] = {}
    try:
        async for r in db[AUDIT].find({"action": "access", "outcome": "ok", "email": {"$in": emails}},
                                      {"email": 1, "last_at": 1}):
            at = r.get("last_at")
            if at and (r["email"] not in out or at > out[r["email"]]):
                out[r["email"]] = at
    except Exception:  # pragma: no cover
        pass
    return out


def _person(email: str, acc: dict | None, last: datetime | None) -> dict:
    return {"email": email, "name": (acc or {}).get("name"), "picture": (acc or {}).get("picture"),
            "has_account": acc is not None, "disabled": bool(acc and is_disabled(acc)), "last_visit_at": last}


async def listing(db: AsyncIOMotorDatabase) -> dict:
    """Owners and admins, with their accounts and last visits, oldest admin first."""
    rows = await db[COLLECTION].find({}).sort("added_at", 1).to_list(500)
    own = sorted(owners())
    emails = [*own, *[r["email"] for r in rows]]
    accounts = await _accounts(db, emails)
    visits = await _last_visits(db, emails)
    return {
        "owners": [_person(e, accounts.get(e), visits.get(e)) for e in own],
        "admins": [{**_person(r["email"], accounts.get(r["email"]), visits.get(r["email"])),
                    "note": r.get("note"), "added_by": r.get("added_by"), "added_at": r.get("added_at")}
                   for r in rows if r["email"] not in own],
    }


async def history(db: AsyncIOMotorDatabase, limit: int = 30) -> list[dict]:
    rows = await db[AUDIT].find({"action": {"$in": [ADD, REMOVE]}}).sort("ts", -1).to_list(limit)
    return [{"id": str(r["_id"]), "at": r["ts"], "action": "add" if r["action"] == ADD else "remove",
             "actor": r.get("admin"), "target": r.get("target"), "note": r.get("note"), "via": r.get("via", "console")}
            for r in rows]


async def candidates(db: AsyncIOMotorDatabase, q: str, limit: int = 8) -> list[dict]:
    """Existing accounts matching `q` (email or name, case-insensitive), with their current role."""
    q = q.strip()[:100]
    if len(q) < 2:
        return []
    rx = {"$regex": re.escape(q), "$options": "i"}
    users = await db["users"].find({"$or": [{"email": rx}, {"name": rx}]},
                                   {"email": 1, "name": 1, "picture": 1}).sort("email", 1).to_list(limit)
    admins = {r["email"] async for r in db[COLLECTION].find({"email": {"$in": [norm(u.get("email")) for u in users]}}, {"email": 1})}
    out = []
    for u in users:
        e = norm(u.get("email"))
        out.append({"email": e, "name": u.get("name"), "picture": u.get("picture"),
                    "role": "owner" if e in owners() else ("admin" if e in admins else None)})
    return out


# ── Changing ──────────────────────────────────────────────────────────────────


async def _audit(db: AsyncIOMotorDatabase, action: str, actor: dict, target: str, note: str | None, via: str) -> None:
    await db[AUDIT].insert_one({"action": action, "admin": actor.get("email"), "admin_user_id": actor.get("user_id"),
                                "target": target, "note": note, "via": via, "ts": datetime.now(timezone.utc),
                                "ip_hash": actor.get("ip_hash")})


async def grant(db: AsyncIOMotorDatabase, actor: dict, raw_email: str, raw_note: str | None = None, *,
                via: str = "console") -> dict:
    """Make `raw_email` an admin. `actor` is {email, user_id?, ip_hash?, name?}: an owner (the route
    checks), or the server operator for the break-glass script. Raises RoleError."""
    email = norm(raw_email)
    note = " ".join((raw_note or "").split())[:NOTE_MAX] or None
    if not EMAIL_RE.match(email) or len(email) > 254:
        raise RoleError(400, "That isn't a valid email address.")
    if email in owners():
        raise RoleError(409, f"{email} is an owner already.")
    acc = await db["users"].find_one({"email": email}, {"name": 1, "disabled": 1, "disabled_at": 1, "deleted_at": 1})
    if acc is not None and is_disabled(acc):
        raise RoleError(409, f"The account {email} is disabled.")
    now = datetime.now(timezone.utc)
    row = {"email": email, "note": note, "added_by": actor.get("email"), "added_at": now, "via": via}
    res = await db[COLLECTION].update_one({"email": email}, {"$setOnInsert": row}, upsert=True)
    if res.upserted_id is None:
        raise RoleError(409, f"{email} is an admin already.")
    await _audit(db, ADD, actor, email, note, via)
    await _notify(db, ADD, actor, email, note, new_admin_name=(acc or {}).get("name"), has_account=acc is not None)
    return {"email": email, "pending": acc is None}


async def revoke(db: AsyncIOMotorDatabase, actor: dict, raw_email: str, *, via: str = "console") -> None:
    """Take admin away from `raw_email`. Owners can't be removed here; nor can the last person who
    can open the console. Raises RoleError."""
    email = norm(raw_email)
    if email in owners():
        raise RoleError(403, "An owner can't be removed here: owners are set on the server (MARKDROP_ADMIN_EMAILS).")
    row = await db[COLLECTION].find_one({"email": email}, {"_id": 1})
    if row is None:
        raise RoleError(404, f"{email} isn't an admin.")
    if not owners() and await db[COLLECTION].count_documents({}) <= 1:
        raise RoleError(409, "That's the last admin: nobody could open the console. Add another first.")
    await db[COLLECTION].delete_one({"_id": row["_id"]})
    await _audit(db, REMOVE, actor, email, None, via)
    await _notify(db, REMOVE, actor, email, None)


# ── Email ─────────────────────────────────────────────────────────────────────


async def _notify(db: AsyncIOMotorDatabase, action: str, actor: dict, target: str, note: str | None, *,
                  new_admin_name: str | None = None, has_account: bool = True) -> None:
    """Tell every owner (a receipt for the one who made the change, a heads-up for the rest), and
    tell a new admin. Failures are logged, never raised: the change is made and audited already."""
    from app.services import mailer

    actor_label = actor.get("name") or actor.get("email") or "Someone"
    added = action == ADD
    for to in sorted(owners()):
        try:
            await mailer.send_admin_change_email(to_email=to, actor=actor_label, actor_email=actor.get("email") or "",
                                                 target=target, added=added, note=note)
        except Exception as exc:
            log.warning("[admin_roles] change email to an owner failed: %s", exc)
    if added:
        try:
            await mailer.send_admin_granted_email(to_email=target, actor=actor_label, has_account=has_account,
                                                  name=new_admin_name)
        except Exception as exc:
            log.warning("[admin_roles] new admin email failed: %s", exc)
