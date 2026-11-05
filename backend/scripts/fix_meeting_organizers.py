"""One-off: meetings imported before Organizer and Imported by were separate showed the importer as
Organizer. Sets each meeting's organizer from the Google Doc's owner (when the Google Meet script
reported it), else leaves it unknown, and corrects the page's Organizer property when it still names
the importer. Dry run by default.

    cd backend && .venv/bin/python -m scripts.fix_meeting_organizers [--apply] [--workspace <id>]
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
    out = await meetings.repair_organizers(get_database(), apply=apply, workspace_id=workspace)
    print(("Applied: " if apply else "Dry run (add --apply): ") + ", ".join(f"{k} {v}" for k, v in out.items()))
    return 1 if out["errors"] else 0


if __name__ == "__main__":
    args = sys.argv[1:]
    ws = args[args.index("--workspace") + 1] if "--workspace" in args else None
    sys.exit(asyncio.run(main("--apply" in args, ws)))
