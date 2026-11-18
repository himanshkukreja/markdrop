"""One-off for HubSpot deal folders (services/hubspot_folders.py): a folder for every OPEN deal of the workspace's
connected HubSpot account (in the HubSpot team's hidden Deals folder, with its Deal overview page), the calls already
matched to a deal moved into it (only confident matches; several open deals → left for "Pick the deal"), and the old
company account pages moved to an "Accounts (archived)" folder.

HubSpot is only READ (GET, search, batch read). Dry run by default: says what would happen and writes nothing in
Markdrop or HubSpot. --apply does it (safe to run again: everything is idempotent).

    cd backend && .venv/bin/python -m scripts.hubspot_deal_folders --workspace <id> [--apply]
"""

from __future__ import annotations

import asyncio
import json
import sys

from app.config import get_settings  # noqa: F401  (loads .env before the services)
from app.database import connect, get_database
from app.services import hubspot, hubspot_folders


def _opt(args: list[str], name: str) -> str | None:
    return args[args.index(name) + 1] if name in args and args.index(name) + 1 < len(args) else None


async def main(args: list[str]) -> int:
    ws = _opt(args, "--workspace")
    if not ws:
        print(__doc__)
        return 2
    apply = "--apply" in args
    get_settings()
    await connect()
    db = get_database()
    await hubspot.ensure_indexes(db)
    print(("APPLY" if apply else "DRY RUN (nothing is written; add --apply)") + f": HubSpot deal folders for workspace {ws}")
    try:
        out = await hubspot_folders.backfill(db, ws, apply=apply, on_line=lambda s: print(s, flush=True))
    except RuntimeError as exc:
        print(str(exc))
        return 1
    await hubspot.drain()
    print()
    print(json.dumps(out, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
