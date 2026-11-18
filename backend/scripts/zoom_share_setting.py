"""One person's "When my Zoom meetings are recorded" setting (services/zoom_review.py), set by an operator.

Everyone starts on "auto" (share automatically); a person changes it in Settings › Account › Zoom, and a
workspace admin on the Zoom card. This sets it for one account by email (the address is matched as stored:
lowercase). Dry run by default: prints who was found and their current setting.

    cd backend && .venv/bin/python -m scripts.zoom_share_setting --email <address> --set ask [--apply]
"""

from __future__ import annotations

import asyncio
import sys

from app.config import get_settings  # noqa: F401  (loads .env before the services)
from app.database import connect, get_database
from app.services import zoom_review


def _opt(args: list[str], name: str) -> str | None:
    return args[args.index(name) + 1] if name in args and args.index(name) + 1 < len(args) else None


async def main(args: list[str]) -> int:
    email, value = (_opt(args, "--email") or "").strip().lower(), _opt(args, "--set")
    if not email or value not in zoom_review.CHOICES:
        print(__doc__)
        return 2
    await connect()
    db = get_database()
    users = await db["users"].find({"email": email}, {"name": 1, "email": 1, "zoom_share": 1}).to_list(length=5)
    if len(users) != 1:
        print(f"{len(users)} accounts have that address; nothing changed.")
        return 1
    u = users[0]
    teams = await zoom_review.zoom_teams_of(db, str(u["_id"]))
    print(f"{u.get('name') or '?'} <{u['email']}> ({u['_id']}): now {zoom_review.choice_of(u)!r}; "
          f"Zoom teams: {', '.join(t['team'] or '?' for t in teams) or 'none'}")
    if "--apply" not in args:
        print(f"Dry run (add --apply) to set {value!r}.")
        return 0
    await db["users"].update_one({"_id": u["_id"]}, {"$set": {"zoom_share": value}})
    print(f"Set to {value!r}.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
