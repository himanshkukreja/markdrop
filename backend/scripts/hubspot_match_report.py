"""Read-only: how each meeting of a workspace's HubSpot team would match in HubSpot (services/hubspot.match_report).
Nothing is written, in Markdrop or in HubSpot: per meeting, how it matched (meeting: the HubSpot meeting booked
for the call; contacts / names: its attendees; none), how sure, and the deal; then the counts.

    cd backend && .venv/bin/python -m scripts.hubspot_match_report --workspace <id> [--limit N] [--json]
"""

from __future__ import annotations

import asyncio
import json
import sys

from app.config import get_settings  # noqa: F401  (loads .env before the services)
from app.database import connect, get_database
from app.services import hubspot


def _opt(args: list[str], name: str) -> str | None:
    return args[args.index(name) + 1] if name in args and args.index(name) + 1 < len(args) else None


def _line(r: dict) -> str:
    d = r.get("deal") or {}
    deal = (f"{d.get('name')} · {d.get('stage') or '?'}" + (f" · {d['amount']:g}" if d.get("amount") is not None else "")
            + (f" · owner {d['owner']}" if d.get("owner") else "")) if d else "-"
    when = f"{r.get('date') or '':10} {r.get('time') or '':5}"
    extra = r.get("error") or r.get("detail") or ""
    if r.get("others"):
        extra += f" (also: {', '.join(x for x in r['others'] if x)})"
    return f"{when}  {(r.get('title') or '')[:44]:44}  {r['how']:8} {r['confidence']:6}  {deal[:60]:60}  {extra}"


async def main(args: list[str]) -> int:
    ws = _opt(args, "--workspace")
    if not ws:
        print(__doc__)
        return 2
    get_settings()
    await connect()
    lim = _opt(args, "--limit")
    as_json = "--json" in args
    if not as_json:
        print(f"{'date':10} {'time':5}  {'meeting':44}  {'how':8} {'conf':6}  {'deal':60}  detail")
    try:
        out = await hubspot.match_report(get_database(), ws, limit=int(lim) if lim else None,
                                         on_row=None if as_json else (lambda r: print(_line(r), flush=True)))
    except RuntimeError as exc:
        print(str(exc))
        return 1
    if as_json:
        print(json.dumps(out, indent=2, default=str))
        return 0
    with_deal = sum(1 for r in out["rows"] if r.get("deal"))
    print()
    print(f"{out['total']} meetings: " + ", ".join(f"{k} {v}" for k, v in sorted(out["counts"].items(), key=lambda kv: -kv[1])))
    print("Confidence: " + ", ".join(f"{k} {out['confidence'].get(k, 0)}" for k in hubspot.CONFIDENCE))
    print(f"With a deal: {with_deal}; HubSpot errors: {out['errors']}. Nothing was written.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
