"""Backfill for backlog priorities (services/team_backlog.py, owner 2026-11-26): give every open item that nobody has
prioritized yet (no priority, or Medium by default because the model wasn't asked) the model's priority — Urgent,
High, Medium or Low — with a one-line reason, in batches of 40 items per model call (ledger feature team_backlog).
Never touches a priority set in a call, by a person, or by the model already. Then rewrites the team's page.

Dry run by default: per team, how many open items have no priority and how many model calls that takes; nothing is
written and the model isn't asked. --apply sets them (safe to run again: an item that has a priority is skipped).

    cd backend && .venv/bin/python -m scripts.backlog_priorities --workspace <id> [--team <id|slug|name>] [--apply]
"""

from __future__ import annotations

import asyncio
import json
import sys

from app.config import get_settings  # noqa: F401  (loads .env before the services)
from app.database import connect, get_database
from app.services import team_backlog


def _opt(args: list[str], name: str) -> str | None:
    return args[args.index(name) + 1] if name in args and args.index(name) + 1 < len(args) else None


async def run(db, ws: str, team: str | None, apply: bool) -> tuple[int, dict | None]:
    await team_backlog.ensure_indexes(db)
    print(("APPLY" if apply else "DRY RUN (nothing is written; add --apply)") + f": backlog priorities for workspace {ws}"
          + (f", team {team}" if team else ", every team"))
    try:
        out = await team_backlog.backfill_priorities(db, ws, team, apply=apply, on_line=lambda s: print(s, flush=True))
    except RuntimeError as exc:
        print(str(exc))
        return 1, None
    await team_backlog.drain()
    print()
    print(json.dumps(out, indent=2, default=str))
    return 0, out


async def main(args: list[str]) -> int:
    ws = _opt(args, "--workspace")
    if not ws:
        print(__doc__)
        return 2
    get_settings()
    await connect()
    code, _out = await run(get_database(), ws, _opt(args, "--team"), "--apply" in args)
    return code


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
