"""One-off for personal to-do pages (services/todo_pages.py): a "<Name> — To-dos" page for EVERY member of the
workspace's teams (or one team; never General), built from the team's existing calls' action items — one collapsible
section per company, Internal for the rest; members without items get the empty state. From then on every new call
(and every change to a call's action items) keeps them up to date, and people added to the team later get theirs.

Dry run by default: lists each member's open items by company and writes nothing. --apply makes and fills the pages
(safe to run again: a page already up to date isn't written).

    cd backend && .venv/bin/python -m scripts.todo_pages --workspace <id> [--team <id|slug|name>] [--apply]
"""

from __future__ import annotations

import asyncio
import json
import sys

from app.config import get_settings  # noqa: F401  (loads .env before the services)
from app.database import connect, get_database
from app.services import todo_pages


def _opt(args: list[str], name: str) -> str | None:
    return args[args.index(name) + 1] if name in args and args.index(name) + 1 < len(args) else None


async def main(args: list[str]) -> int:
    ws = _opt(args, "--workspace")
    if not ws:
        print(__doc__)
        return 2
    team = _opt(args, "--team")
    apply = "--apply" in args
    get_settings()
    await connect()
    db = get_database()
    await todo_pages.ensure_indexes(db)
    print(("APPLY" if apply else "DRY RUN (nothing is written; add --apply)") + f": to-do pages for workspace {ws}"
          + (f", team {team}" if team else ", every team"))
    try:
        out = await todo_pages.backfill(db, ws, team, apply=apply, on_line=lambda s: print(s, flush=True))
    except RuntimeError as exc:
        print(str(exc))
        return 1
    await todo_pages.drain()
    print()
    print(json.dumps(out, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
