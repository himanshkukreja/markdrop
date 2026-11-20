"""Fill Ask's index (AI quality stage 2) on a database that had none: Layer 1 facts, Layer 2 summaries, Layer 3
embeddings. Incremental and resumable: what is already current is skipped, so running it again adds nothing.
The ``ai_index`` background loop does the same a slice at a time; this only gets there sooner.

Dry run by default (what would be done, no model or Voyage calls); ``--apply`` writes.

    cd backend && .venv/bin/python -m scripts.ai_index_backfill [--apply] [--layers facts,summaries,vectors]
        [--limit 2000]

* facts      — every document's row, task lines, comment threads; every team's backlog items (no AI).
* summaries  — two-line page summaries with Claude Haiku under the ``ai_index`` caps (meetings reuse their notes).
* vectors    — Voyage AI embeddings under the ``embeddings`` caps; skipped unless MARKDROP_VOYAGE_API_KEY is set.

Summaries and vectors stop at their caps for the day; run again (or let the loop finish) the next day.
"""

from __future__ import annotations

import asyncio
import sys
from datetime import timedelta

from app.config import get_settings  # noqa: F401  (loads .env before the services)
from app.database import connect, get_database
from app.services import ai_index, ai_summaries, ai_vectors


async def run(db, *, apply: bool, layers: set[str], limit: int) -> dict:
    out: dict = {}
    for mod in (ai_index, ai_summaries, ai_vectors):
        await mod.ensure_indexes(db)
    if "facts" in layers:
        if apply:
            n = 0
            while True:
                r = await ai_index.backfill_tick(db, batch=200)
                n += r.get("n", 0)
                if r.get("done"):
                    break
            out["facts"] = {"documents": n, "rows": await db[ai_index.COLL].count_documents({})}
        else:
            out["facts"] = {"documents": await db["documents"].count_documents({"deleted_at": None, "template": {"$ne": True}}),
                            "rows_now": await db[ai_index.COLL].count_documents({})}
    if "summaries" in layers:
        stale = await ai_summaries.stale(db, limit=limit, settle=timedelta(0))
        if apply:
            done = 0
            while done < limit:
                r = await ai_summaries.tick(db, limit=min(50, limit - done), settle=timedelta(0))
                done += r.get("done", 0)
                if not r.get("picked") or not r.get("done"):
                    break
            out["summaries"] = {"written": done}
        else:
            out["summaries"] = {"stale": len(stale), "model_calls_at_most": sum(1 for r in stale if r.get("kind") != "meeting")}
    if "vectors" in layers:
        if not ai_vectors.configured():
            out["vectors"] = "skipped: MARKDROP_VOYAGE_API_KEY is not set"
        else:
            stale = await ai_vectors.stale(db, limit=limit, settle=timedelta(0))
            if apply:
                done = tokens = 0
                while done < limit:
                    r = await ai_vectors.tick(db, limit=min(100, limit - done), settle=timedelta(0))
                    done += r.get("done", 0)
                    tokens += r.get("tokens", 0)
                    if not r.get("done"):
                        break
                out["vectors"] = {"documents": done, "tokens": tokens, "chunks": await db[ai_vectors.COLL].count_documents({})}
            else:
                out["vectors"] = {"stale_documents": len(stale)}
    return out


async def main(argv: list[str]) -> int:
    layers = {"facts", "summaries", "vectors"}
    limit = 2000
    for i, a in enumerate(argv):
        if a == "--layers" and i + 1 < len(argv):
            layers = {x.strip() for x in argv[i + 1].split(",") if x.strip()}
        if a == "--limit" and i + 1 < len(argv):
            limit = int(argv[i + 1])
    await connect()
    out = await run(get_database(), apply="--apply" in argv, layers=layers, limit=limit)
    print(("APPLIED " if "--apply" in argv else "DRY RUN ") + str(out))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
