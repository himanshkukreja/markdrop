"""One-off (2026-11-19): "Imported from Notion" on pages imported before the writer stamped ``source``.

Every page imported from Notion (Connect Notion or an export file) now carries ``source: {kind: "notion",
via, notion_id, url, sync_id, imported_at}`` (services/notion_import/source.py), which the page's
"Imported from Notion" strip reads. This fills it in for older imports from ``notion_links``; a kept sync
also fills in its own pages on its next run. Dry run by default (counts and examples); --apply writes.
Idempotent; never touches a page's content or revision.

    cd backend && .venv/bin/python -m scripts.backfill_notion_source [--apply]
"""

from __future__ import annotations

import asyncio
import sys

from app.config import get_settings  # noqa: F401  (loads .env before the services)
from app.database import connect, get_database
from app.services.notion_import import source


async def main(apply: bool) -> int:
    get_settings()
    await connect()
    db = get_database()
    out = await source.backfill(db, apply=apply)
    print(f"Notion links: {out['links']}; pages already marked: {out['already']}; page gone: {out['missing_page']}")
    print(f"{'Marked' if apply else 'Would mark'}: {out['set'] if apply else out['would_set']} "
          f"(Connect Notion {out['api']}, export file {out['zip']}; with their sync {out['with_sync']})")
    for ex in out["examples"]:
        print(f"  e.g. {ex['slug']} {ex['title']!r} via {ex['via']}" + (f", sync {ex['sync_id']}" if ex["sync_id"] else ""))
    if not apply:
        print("Dry run: nothing written. Run again with --apply to write.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main("--apply" in sys.argv[1:])))
