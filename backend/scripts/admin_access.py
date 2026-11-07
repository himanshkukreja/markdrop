"""Break-glass for the admin console, run ON THE SERVER only. Nothing here is exposed on the web.

The console at markdrop.in/admin opens for the owner's own Markdrop session (routers/admin
require_admin): an account in MARKDROP_ADMIN_EMAILS (default kukreja.him@gmail.com), signed in within
MARKDROP_ADMIN_SESSION_MAX_AGE_DAYS. There is no admin password. If the owner can't sign in the
normal way (Google or an emailed code), someone with shell access to the API server can:

    cd backend && .venv/bin/python -m scripts.admin_access status
        who may open the console, whether each account exists or is disabled, the session age rule

    cd backend && .venv/bin/python -m scripts.admin_access session you@example.com [--hours 1] [--create]
        mint a short-lived session (default 1 hour) for an address that is ALREADY in
        MARKDROP_ADMIN_EMAILS, print it once, and record it in admin_access_log (action
        "break_glass"). --create makes the account first if it doesn't exist. Use it in a browser:
        open https://markdrop.in, then in the devtools console
            localStorage.setItem("markdrop_token", "<token>"); location.href = "/admin"

    cd backend && .venv/bin/python -m scripts.admin_access log [--days 7]
        recent admin access: allowed, refused (signed in but not an admin), asked to sign in again,
        break-glass sessions, and moderation reads/edits/deletes

    cd backend && .venv/bin/python -m scripts.admin_access list
        the owners and the admins (added in Admin › Admins or with `grant`), pending or not

    cd backend && .venv/bin/python -m scripts.admin_access grant you@example.com [--note "why"]
    cd backend && .venv/bin/python -m scripts.admin_access revoke you@example.com
        add or remove an ADMIN (not an owner) without the web console, e.g. when no owner can sign
        in. Audited as an admin_add / admin_remove by "server (break-glass)" and emailed to every
        owner, like a change made in the console.

Two kinds of admin (services/admin_roles): OWNERS are MARKDROP_ADMIN_EMAILS (edit backend/.env and
restart the API with deploy.sh to change them; only owners add or remove admins in the console), and
ADMINS are rows an owner added. `session` mints only for an owner.

Uses the app's settings (backend/.env on the server).
"""

from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timedelta, timezone

import jwt

from app.config import get_settings
from app.services import admin_roles

settings = get_settings()
OPERATOR = {"email": None, "name": "The server operator (break-glass script)"}
ACCESS_LOG = "admin_access_log"
MAX_HOURS = 24


class BreakGlassError(Exception):
    pass


async def mint_session(db, email: str, *, hours: float = 1, create: bool = False) -> tuple[str, datetime]:
    """A fresh session for an allowlisted admin account, logged as action "break_glass"."""
    email = email.strip().lower()
    if email not in settings.admin_email_set:
        raise BreakGlassError(f"{email} is not in MARKDROP_ADMIN_EMAILS. Add it to backend/.env and restart the API first.")
    if not 0 < hours <= MAX_HOURS:
        raise BreakGlassError(f"--hours must be more than 0 and at most {MAX_HOURS}.")
    now = datetime.now(timezone.utc)
    raw = await db["users"].find_one({"email": email})
    if raw is None:
        if not create:
            raise BreakGlassError(f"No account for {email}. Pass --create to make one.")
        res = await db["users"].insert_one({"email": email, "providers": ["break_glass"], "created_at": now, "updated_at": now})
        raw = {"_id": res.inserted_id, "email": email}
    if raw.get("disabled") or raw.get("disabled_at") or raw.get("deleted_at"):
        raise BreakGlassError(f"The account {email} is disabled; the console would refuse it.")
    exp = now + timedelta(hours=hours)
    # The same shape as utils/auth.create_access_token, with a short life.
    token = jwt.encode({"sub": str(raw["_id"]), "email": email, "typ": "access", "iat": now, "exp": exp},
                       settings.auth_secret, algorithm="HS256")
    await db[ACCESS_LOG].insert_one({"action": "break_glass", "email": email, "user_id": str(raw["_id"]),
                                     "ts": now, "expires_at": exp})
    return token, exp


async def status(db) -> list[str]:
    out = [f"MARKDROP_ADMIN_EMAILS: {', '.join(sorted(settings.admin_email_set)) or '(none: no owner, only added admins can open the console)'}",
           f"Session must be signed in within: {settings.admin_session_max_age_days or 'any'} day(s)"]
    for email in sorted(settings.admin_email_set):
        raw = await db["users"].find_one({"email": email})
        if raw is None:
            out.append(f"  {email}: no account yet (sign in once, or `session {email} --create`)")
        else:
            off = raw.get("disabled") or raw.get("disabled_at") or raw.get("deleted_at")
            out.append(f"  {email}: account {raw['_id']}{' DISABLED' if off else ''}, last sign-in {raw.get('last_login_at') or 'never'}")
    n = await db[admin_roles.COLLECTION].count_documents({})
    out.append(f"Admins added by an owner: {n} (`list` shows them)")
    return out


async def admins(db) -> list[str]:
    data = await admin_roles.listing(db)
    out = [f"Owners (MARKDROP_ADMIN_EMAILS): {len(data['owners'])}"]
    for p in data["owners"]:
        out.append(f"  {p['email']}{'' if p['has_account'] else ' (no account yet)'}")
    out.append(f"Admins: {len(data['admins'])}")
    for p in data["admins"]:
        state = "pending: no account yet" if not p["has_account"] else ("DISABLED" if p["disabled"] else "active")
        out.append(f"  {p['email']}  {state}, added by {p['added_by'] or 'server'} {p['added_at']:%Y-%m-%d}"
                   + (f"  ({p['note']})" if p.get("note") else ""))
    return out


async def recent(db, days: int) -> list[str]:
    since = datetime.now(timezone.utc) - timedelta(days=days)
    rows = await db[ACCESS_LOG].find({"$or": [{"last_at": {"$gte": since}}, {"ts": {"$gte": since}}]}).sort(
        [("day", -1), ("ts", -1)]).to_list(500)
    out = []
    for r in rows:
        if r.get("action") == "access":
            out.append(f"{r.get('day')}  {r.get('outcome'):7}  {r.get('email') or '-':32} x{r.get('count', 1):<4} "
                       f"ip {str(r.get('ip_hash') or '-')[:10]}  last {r.get('last_path')}")
        else:
            out.append(f"{r.get('ts'):%Y-%m-%d %H:%M}  {r.get('action'):12}  {r.get('admin') or r.get('email') or 'server':32} "
                       f"{r.get('slug') or r.get('target') or ''}")
    return out or [f"No admin access in the last {days} day(s)."]


async def _main(args) -> int:
    from motor.motor_asyncio import AsyncIOMotorClient

    client = AsyncIOMotorClient(settings.mongodb_uri)
    db = client[settings.mongodb_db]
    try:
        if args.cmd == "status":
            print("\n".join(await status(db)))
        elif args.cmd == "log":
            print("\n".join(await recent(db, args.days)))
        elif args.cmd == "list":
            print("\n".join(await admins(db)))
        elif args.cmd in ("grant", "revoke"):
            from app import database

            database._client = client  # the owners' emails go through the app's send path
            try:
                if args.cmd == "grant":
                    r = await admin_roles.grant(db, OPERATOR, args.email, args.note, via="break_glass")
                    print(f"{r['email']} is now an admin{' (pending: no account yet)' if r['pending'] else ''}.")
                else:
                    await admin_roles.revoke(db, OPERATOR, args.email, via="break_glass")
                    print(f"{admin_roles.norm(args.email)} is no longer an admin.")
            except admin_roles.RoleError as e:
                print(f"refused: {e.message}")
                return 1
        else:
            try:
                token, exp = await mint_session(db, args.email, hours=args.hours, create=args.create)
            except BreakGlassError as e:
                print(f"refused: {e}")
                return 1
            print(f"Session for {args.email.strip().lower()}, valid until {exp:%Y-%m-%d %H:%M} UTC (logged as break_glass).")
            print("On https://markdrop.in, in the devtools console:")
            print(f'  localStorage.setItem("markdrop_token", "{token}"); location.href = "/admin"')
        return 0
    finally:
        client.close()


def main() -> int:
    p = argparse.ArgumentParser(prog="python -m scripts.admin_access", description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status", help="who may open the admin console")
    s = sub.add_parser("session", help="mint a short-lived session for an allowlisted admin")
    s.add_argument("email")
    s.add_argument("--hours", type=float, default=1)
    s.add_argument("--create", action="store_true", help="make the account if it doesn't exist")
    sub.add_parser("list", help="owners and admins")
    g = sub.add_parser("grant", help="make an address an admin (not an owner)")
    g.add_argument("email")
    g.add_argument("--note", default=None)
    rv = sub.add_parser("revoke", help="take admin away from an address")
    rv.add_argument("email")
    lg = sub.add_parser("log", help="recent admin access")
    lg.add_argument("--days", type=int, default=7)
    return asyncio.run(_main(p.parse_args()))


if __name__ == "__main__":  # pragma: no cover - an operator's tool
    raise SystemExit(main())
