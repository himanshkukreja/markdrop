"""Re-mark stored artifact bytes to match the access their document now has.

`_sync_artifact_visibility` keeps R2 in step from here on, but it only fires
when something *changes*. Any artifact made private — or given a password, or
filed into a workspace-only document — before that existed still has its object
marked public in R2, and the Worker serves a public object to anyone with the
URL without asking this API a thing. Those documents are closed at the API and
open at the edge, which is the worst of the two places to be wrong.

This walks every artifact whose document is guarded and re-marks the object.
Idempotent: re-marking an object that is already correct costs one copy and
changes nothing, so it is safe to run again after any deploy.

    cd backend && .venv/bin/python -m scripts.resecure_artifacts [--apply]

Dry by default. Nothing is written until `--apply` is passed, because the first
question anyone will have is "how many, and which ones".
"""

import asyncio
import sys

from app.config import get_settings  # noqa: F401  (loads .env before the services)
from app.database import connect, disconnect, get_database
from app.services import artifact as art_service
from app.services import r2


async def main(apply: bool) -> int:
    get_settings()
    if not r2.is_configured():
        print("R2 is not configured here — nothing to do.")
        return 0

    await connect()
    db = get_database()

    # Only artifacts, and only the guarded ones: a `link` document with no
    # password is *meant* to be served publicly, and re-marking it would be a
    # pointless copy of every file we host.
    cursor = db["documents"].find(
        {
            "kind": "artifact",
            "$or": [
                {"read_password_hash": {"$nin": [None, ""]}},
                {"access_level": {"$in": ["private", "workspace"]}},
            ],
        },
        {"slug": 1, "blob_key": 1, "bundle_prefix": 1, "mime": 1,
         "access_level": 1, "read_password_hash": 1},
    )

    seen = closed = failed = 0
    async for doc in cursor:
        guarded = art_service.is_guarded(
            has_password=bool(doc.get("read_password_hash")),
            access_level=doc.get("access_level"),
        )
        if not guarded:  # belt and braces; the query already filtered for it
            continue
        seen += 1
        why = "password" if doc.get("read_password_hash") else (doc.get("access_level") or "?")
        target = doc.get("bundle_prefix") or doc.get("blob_key")
        if not target:
            continue
        print(f"  /{doc['slug']:<12} {why:<10} {target}")
        if not apply:
            continue

        ok = await asyncio.to_thread(
            r2.set_public_prefix, doc["bundle_prefix"], False
        ) if doc.get("bundle_prefix") else await asyncio.to_thread(
            r2.set_public, doc["blob_key"], False, doc.get("mime")
        )
        if ok:
            closed += 1
        else:
            failed += 1
            print(f"    ! could not re-mark {target}")

    await disconnect()

    print()
    if not apply:
        print(f"{seen} guarded artifact(s) would be re-marked private. "
              f"Re-run with --apply to do it.")
    else:
        print(f"{seen} guarded artifact(s): {closed} re-marked, {failed} failed.")
    # A failure here leaves bytes readable that should not be, so it must not
    # look like success to whatever is running this.
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main("--apply" in sys.argv)))
