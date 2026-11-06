"""One-off: meeting attendees.

* Names (2026-11-06, ``names_v``): names with markdown or bracket noise ("[Ishaan Gupta](mailto:ishaan@…)").
* Who was there (2026-11-06, ``attendees_v`` 2): meetings imported before the calendar invite (Gemini
  notes' "Invited") was told apart from who joined showed every invitee as an attendee ("27 people"
  for 12). meetings.repair_attendees recomputes them from what the meeting kept (see
  meetings.recompute_people) and rewrites the page's Attendees only where Markdrop's words are still there.

The background loop ("meetings_backfill" → meetings.names_tick, meetings.attendees_tick) does both on
its own; this counts them (dry run, the default) or does them now (--apply). Idempotent.

    cd backend && .venv/bin/python -m scripts.fix_meeting_attendees [--apply] [--workspace <id>]
"""

from __future__ import annotations

import asyncio
import json
import sys

from app.config import get_settings  # noqa: F401  (loads .env before the services)
from app.database import connect, get_database
from app.services import meetings


async def main(apply: bool, workspace: str | None) -> int:
    get_settings()
    await connect()
    db = get_database()
    out = await meetings.count_dirty_names(db, workspace_id=workspace)
    print(f"Names: meetings not yet checked: {out['pending']}; names to clean in {out['would_change']}")
    for ex in out["examples"]:
        print("  e.g.", ex)
    att = await meetings.attendees_dry_run(db, workspace_id=workspace)
    print(f"Attendees: meetings not yet checked: {att['pending']}; would change {att['would_change']}")
    print(f"  attendees taken from: {json.dumps(att['from'])}  (speakers = Gemini notes + transcript; "
          "invited = Gemini notes only; attendees = a transcript's Attendees line)")
    print(f"  page: {json.dumps(att['page'])}  (rewritten = untouched page written again; property = only the "
          "Attendees property; left = edited by someone, left alone)")
    print(f"  people shown before {att['people_before']} → after {att['people_after']}; invitees kept apart {att['invited']}")
    for ex in att["examples"]:
        print(f"  e.g. {ex['date']} {ex['title']!r}: {ex['before']} → {ex['after']} attendees "
              f"({ex['from']}), {ex['invited']} invited, page {ex['page']}")
    if apply and not workspace:
        done = 0
        while n := await meetings.names_tick(db, batch=200):
            done += n
        print(f"Applied names: checked {done}")
        done = 0
        while n := await meetings.attendees_tick(db, batch=200):
            done += n
        print(f"Applied attendees: checked {done}")
    elif apply:
        print("--apply repairs every workspace; run it without --workspace")
    return 0


if __name__ == "__main__":
    args = sys.argv[1:]
    ws = args[args.index("--workspace") + 1] if "--workspace" in args else None
    sys.exit(asyncio.run(main("--apply" in args, ws)))
