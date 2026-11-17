"""One-off (2026-11-17): Zoom meetings imported before Markdrop kept attendees' addresses get them.

For each imported Zoom meeting of the workspace, Zoom is asked again who joined (past meeting
participants) and each address Zoom gives goes on the attendee with that name who has none (HubSpot
then finds attendees by address). Nothing else changes: no attendee added or removed, no names, no
pages. Addresses are never printed. Dry run by default.

    cd backend && .venv/bin/python -m scripts.zoom_backfill_attendee_emails --workspace <id> [--apply]
"""

from __future__ import annotations

import asyncio
import sys

from app.config import get_settings  # noqa: F401  (loads .env before the services)
from app.database import connect, get_database
from app.services import zoom


def _opt(args: list[str], name: str) -> str | None:
    return args[args.index(name) + 1] if name in args and args.index(name) + 1 < len(args) else None


def show(row: dict, sets: dict) -> None:
    if sets:
        print(f"{row['_id']}  {row.get('date') or '':10}  {(row.get('title') or '')[:60]}  "
              f"+{len(sets)} address{'es' if len(sets) != 1 else ''}", flush=True)


async def main(args: list[str]) -> int:
    ws = _opt(args, "--workspace")
    if not ws:
        print(__doc__)
        return 2
    get_settings()
    await connect()
    apply = "--apply" in args
    try:
        out = await zoom.backfill_attendee_emails(get_database(), ws, apply=apply, on_row=show)
    except ValueError as exc:
        print(exc)
        return 1
    print(("Applied: " if apply else "Dry run (add --apply): ") + ", ".join(f"{k} {v}" for k, v in out.items()))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
