"""One-off: Zoom meetings Markdrop transcribed (no Zoom transcript) whose speakers are still
"Speaker 1", "Speaker 2"… (Zoom's timeline wasn't available) get names from what was said
(services/meeting_speakers.repair: one small Meetings AI call per meeting, as the person who imported
it, under their limits; only confident names of people who are there). --apply puts them in the
meeting's segments and attendees and its Transcript page (only a Transcript page nobody edited); the
meeting page is left as it is (rewrite it after with scripts.regenerate_meeting_details --force).
Speech-to-text is not run again. Dry run by default: it still asks the model, and prints what it
would change.

    cd backend && .venv/bin/python -m scripts.rename_zoom_speakers [--apply] [--workspace <id>]
        [--meeting <id> ...] [--limit N]
"""

from __future__ import annotations

import asyncio
import sys

from app.config import get_settings  # noqa: F401  (loads .env before the services)
from app.database import connect, get_database
from app.services import meeting_speakers


def _opt(args: list[str], name: str) -> str | None:
    return args[args.index(name) + 1] if name in args and args.index(name) + 1 < len(args) else None


def show(row: dict, got: dict) -> None:
    head = f"{row['_id']}  {row.get('date') or '':10}  {(row.get('title') or '')[:60]}"
    if got["names"]:
        names = ", ".join(f"{k} → {v}" for k, v in sorted(got["names"].items()))
        state = "applied" if got["applied"] else "would apply" if not got.get("reason") else got["reason"]
        print(f"{head}\n    {names}  [{state}; transcript page: {got['transcript']}]", flush=True)
    else:
        print(f"{head}\n    unchanged ({got.get('reason') or 'no confident names'})", flush=True)
    for a in got.get("answers") or []:
        print(f"      {a.get('label')}: {a.get('name')} ({a.get('confidence')}) {str(a.get('evidence') or '')[:100]}",
              flush=True)


async def main(args: list[str]) -> int:
    get_settings()
    await connect()
    apply = "--apply" in args
    ids = [args[i + 1] for i, a in enumerate(args) if a == "--meeting" and i + 1 < len(args)]
    lim = _opt(args, "--limit")
    out = await meeting_speakers.repair(get_database(), apply=apply, workspace_id=_opt(args, "--workspace"),
                                        meeting_ids=ids or None, limit=int(lim) if lim else None, on_row=show)
    print(("Applied: " if apply else "Dry run (add --apply): ") + ", ".join(f"{k} {v}" for k, v in out.items()))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
