"""One-off: meetings imported before attendee names were cleaned (2026-11-06) can show names with
markdown or bracket noise ("[Ishaan Gupta](mailto:ishaan@…)", "\\[Priya\\]"), so the meeting bar's
initials read "[I". The background loop ("meetings_backfill" → meetings.names_tick) cleans them on
its own; this counts them (dry run, the default) or cleans them now (--apply). Idempotent.

    cd backend && .venv/bin/python -m scripts.fix_meeting_attendees [--apply] [--workspace <id>]
"""

from __future__ import annotations

import asyncio
import sys

from app.config import get_settings  # noqa: F401  (loads .env before the services)
from app.database import connect, get_database
from app.services import meetings


async def main(apply: bool, workspace: str | None) -> int:
    get_settings()
    await connect()
    db = get_database()
    out = await meetings.count_dirty_names(db, workspace_id=workspace)
    print(f"Meetings not yet checked: {out['pending']}; names to clean in {out['would_change']}")
    for ex in out["examples"]:
        print("  e.g.", ex)
    if apply and not workspace:
        done = 0
        while n := await meetings.names_tick(db, batch=200):
            done += n
        print(f"Applied: checked {done}")
    elif apply:
        print("--apply cleans every workspace; run it without --workspace")
    return 0


if __name__ == "__main__":
    args = sys.argv[1:]
    ws = args[args.index("--workspace") + 1] if "--workspace" in args else None
    sys.exit(asyncio.run(main("--apply" in args, ws)))
