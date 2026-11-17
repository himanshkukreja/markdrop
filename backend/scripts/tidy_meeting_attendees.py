"""One-off (owner, 2026-11-17): meetings' attendees tidied the way new imports are
(services/meetings.tidy_attendees):

* speech-to-text's labels ("Speaker 2", "Speaker 3"…) are nobody's name: taken out of the attendees;
* a name that is the first name (or first words) of exactly one other attendee's name is that person
  ("Mayuri", Zoom's display name, and "Mayuri Pillay", the speaker / member): one attendee with the
  fuller name and either one's address and member. Never when it's ambiguous (two attendees or two
  workspace members it could be, or two different addresses).

The page's Attendees property follows where it still reads what Markdrop wrote. The restriction and
its grants are left as they are. Dry run by default (prints what would change). Idempotent.

    cd backend && .venv/bin/python -m scripts.tidy_meeting_attendees [--apply] [--workspace <id>]
"""

from __future__ import annotations

import asyncio
import sys

from app.config import get_settings  # noqa: F401  (loads .env before the services)
from app.database import connect, get_database
from app.services import meetings


def show(row: dict, before: list[dict], after: list[dict]) -> None:
    names = lambda xs: ", ".join(a.get("name") or "?" for a in xs)  # noqa: E731
    print(f"{row['_id']}  {row.get('date') or '':10}  {(row.get('title') or '')[:60]}\n"
          f"    before: {names(before)}\n    after:  {names(after)}", flush=True)


async def main(args: list[str]) -> int:
    get_settings()
    await connect()
    apply = "--apply" in args
    ws = args[args.index("--workspace") + 1] if "--workspace" in args and args.index("--workspace") + 1 < len(args) else None
    out = await meetings.tidy_existing_attendees(get_database(), workspace_id=ws, apply=apply, on_row=show)
    print(("Applied: " if apply else "Dry run (add --apply): ") + ", ".join(f"{k} {v}" for k, v in out.items()))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
