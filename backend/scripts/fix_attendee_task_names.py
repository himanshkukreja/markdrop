"""One-off: Gemini's next steps taken for speakers and attendees (2026-11-06, ``attendees_v`` 3), and
meetings with only Gemini's notes listing the people the notes name as attendees (``attendees_v`` 4).

Gemini writes a next step as "Gautam Khurana Review Video: Gautam Khurana will review the video …". The
parser read those lines as transcript turns, so "Gautam Khurana Review Video" became a speaker, and an
attendee (51 of Senseloaf's 166 meetings). meetings.repair_attendees fixes every meeting (all
workspaces): fake turns that came from the notes Doc dropped (no real transcript left: the meeting has
none, its unedited Transcript page goes to the Trash), elsewhere the owner is the speaker; a meeting
with nobody known to have joined and Gemini's notes gets the people the notes name ("notes"); attendees
mapped to the known person each starts with (invite, members, other attendees), once; the page's
Attendees property / section and the Transcript page written again only where Markdrop's own words are
still there. Never touches the restriction or its grants. Team memory facts whose subject isn't a
member are counted (and removed with --apply when the subject isn't anyone's account).

The background loop ("meetings_backfill" → meetings.attendees_tick) does it on its own; this shows what
it would do (dry run, the default: counts and 15 examples before → after) or does it now (--apply).
Idempotent.

    cd backend && .venv/bin/python -m scripts.fix_attendee_task_names [--apply] [--workspace <id>]
"""

from __future__ import annotations

import asyncio
import json
import sys

from app.config import get_settings  # noqa: F401  (loads .env before the services)
from app.database import connect, get_database
from app.services import meetings


def _names(xs: list) -> str:
    return ", ".join(str(x) for x in xs[:8]) + (f" (+{len(xs) - 8})" if len(xs) > 8 else "")


async def main(apply: bool, workspace: str | None) -> int:
    get_settings()
    await connect()
    db = get_database()
    out = await meetings.attendees_dry_run(db, workspace_id=workspace, examples=15)
    print(f"Meetings not yet checked (attendees_v < {meetings.ATTENDEES_V}): {out['pending']}; "
          f"would change {out['would_change']}; with next-step names or turns: {out['task_names']}")
    print(f"  attendees taken from: {json.dumps(out['from'])}  (notes = Gemini notes only: the people they name; "
          "invited = notes name nobody)")
    print(f"  transcript segments: {json.dumps(out['segments'])}  (dropped = all came from the notes Doc)")
    print(f"  Transcript page: {json.dumps(out['transcript'])}  (left = edited by someone, left alone)")
    print(f"  meeting page: {json.dumps(out['page'])}  (rewritten = untouched page written again; attendees = only "
          "the Attendees property/section; left = edited by someone, left alone)")
    print(f"  people shown before {out['people_before']} → after {out['people_after']}; invitees kept apart {out['invited']}")
    for ex in out["examples"]:
        print(f"  e.g. [{ex['workspace_id']}] {ex['date']} {ex['title']!r} ({ex['from']}, segments {ex['segments']}, "
              f"transcript {ex['transcript']}, page {ex['page']})")
        print(f"       before: {_names(ex['before'])}")
        print(f"       after:  {_names(ex['after'])}")
    print(f"Attendee names still with task words or headings after: {len(out['bad_after'])}")
    for x in out["bad_after"][:30]:
        print(f"  ! {x}")
    print(f"Meetings with attendees before and none after: {len(out['empty_after'])}")
    for x in out["empty_after"][:30]:
        print(f"  ! {x}")
    facts = await meetings.stray_fact_subjects(db, apply=False)
    print(f"Team memory facts: {facts['facts']}; subject not a member of its workspace {facts['not_member']} "
          f"(not anyone's account: {facts['not_a_user']})")
    if apply and not workspace:
        meetings._ATTENDEES["done"] = False
        done = 0
        while n := await meetings.attendees_tick(db, batch=200):
            done += n
        print(f"Applied: checked {done}")
        facts = await meetings.stray_fact_subjects(db, apply=True)
        print(f"Team memory facts removed: {facts['removed']}")
    elif apply:
        print("--apply repairs every workspace; run it without --workspace")
    return 0


if __name__ == "__main__":
    args = sys.argv[1:]
    ws = args[args.index("--workspace") + 1] if "--workspace" in args else None
    sys.exit(asyncio.run(main("--apply" in args, ws)))
