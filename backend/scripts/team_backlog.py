"""Backfill for team backlogs (services/team_backlog.py): read every call of the workspace's teams (or one team;
never General, never a team with its backlog turned off) into the team's backlog and write its "<Team> — Backlog"
page — action items, the customer asks the model finds in each call's notes, repeats merged, each sorted into a
category. From then on every call keeps it up to date.

Dry run by default: per team, how many calls and action items there are, how many calls the model still has to read,
and how many items exist now; nothing is written and the model isn't asked. --apply reads the calls and writes the
pages (safe to run again: a call already read isn't sent to the model again, and existing items keep their edits).

    cd backend && .venv/bin/python -m scripts.team_backlog --workspace <id> [--team <id|slug|name>] [--apply]
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
    print(("APPLY" if apply else "DRY RUN (nothing is written; add --apply)") + f": team backlogs for workspace {ws}"
          + (f", team {team}" if team else ", every team"))
    try:
        out = await team_backlog.backfill(db, ws, team, apply=apply, on_line=lambda s: print(s, flush=True))
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
