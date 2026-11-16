"""One-off: meetings with a transcript and no Google notes (Zoom, pasted or uploaded transcripts)
imported before Markdrop wrote its own detailed notes get their notes written again, with Details
(services/meetings_ai.refresh_details). Each runs as the person who imported it, under their Meetings
AI limits; the first limit stops the run, and running it again skips the meetings already done. Dry
run by default.

    cd backend && .venv/bin/python -m scripts.regenerate_meeting_details [--apply] [--workspace <id>]
        [--meeting <id> ...] [--limit N] [--force] [--as <user id>]
"""

from __future__ import annotations

import asyncio
import sys

from app.config import get_settings  # noqa: F401  (loads .env before the services)
from app.database import connect, get_database
from app.services import meetings_ai


def _opt(args: list[str], name: str) -> str | None:
    return args[args.index(name) + 1] if name in args and args.index(name) + 1 < len(args) else None


async def main(args: list[str]) -> int:
    get_settings()
    await connect()
    apply = "--apply" in args
    ids = [args[i + 1] for i, a in enumerate(args) if a == "--meeting" and i + 1 < len(args)]
    lim = _opt(args, "--limit")

    def show(row: dict, outcome: str) -> None:
        print(f"{row['_id']}  {row.get('date') or '':10}  {(row.get('title') or '')[:60]:60}  {outcome}", flush=True)

    out = await meetings_ai.refresh_details(
        get_database(), apply=apply, workspace_id=_opt(args, "--workspace"), meeting_ids=ids or None,
        limit=int(lim) if lim else None, force="--force" in args, as_user=_opt(args, "--as"), on_row=show)
    print(("Applied: " if apply else "Dry run (add --apply): ") + ", ".join(f"{k} {v}" for k, v in out.items()))
    return 1 if out["failed"] else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
