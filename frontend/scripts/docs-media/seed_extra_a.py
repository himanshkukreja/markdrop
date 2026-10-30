#!/usr/bin/env python3
"""Extra demo-world helpers for the docs media shots of /get-started/** and /documents/**
(shots/a-start-documents.mjs). Run after seed.py; touches only the local demo db.

    STACK_ID=1 backend/.venv/bin/python frontend/scripts/docs-media/seed_extra_a.py              # no-op (idempotent)
    STACK_ID=1 backend/.venv/bin/python frontend/scripts/docs-media/seed_extra_a.py free q3-plan  # take a seeded doc off its link
    STACK_ID=1 backend/.venv/bin/python frontend/scripts/docs-media/seed_extra_a.py restore q3-plan
    STACK_ID=1 backend/.venv/bin/python frontend/scripts/docs-media/seed_extra_a.py reslug q3-plan-internal

Some shots publish at an address the seeded world already uses (a first document at q3-plan, a
first file at q3-board-deck, a password-protected pricing-faq). `free` stashes the seeded row (and
its file versions) in .data/<N>/stash/ and removes it, so the address is free for the take;
`restore` drops whatever the take published there and puts the seeded row back, unchanged (same
id, same edit-secret hash, same analytics). `reslug` puts a renamed seeded document back on its
seeded link (the Change URL clip renames one).

Without arguments it does nothing: seed.py's world already has everything these shots show. The
shots call the subcommands themselves (prepare / after), so nothing needs running by hand.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

from bson import json_util
from pymongo import MongoClient

HERE = Path(__file__).resolve().parent
STACK_ID = int(os.environ.get("STACK_ID") or 0)
BASE_DATA = Path(os.environ.get("DOCS_MEDIA_DATA") or (HERE / ".data")).resolve()
DATA = BASE_DATA if STACK_ID == 0 else BASE_DATA / str(STACK_ID)
STASH = DATA / "stash"
ENV_FILE = HERE / "stack" / ".env"
if not ENV_FILE.exists():
    ENV_FILE = HERE / "stack" / ".env.example"


def env_value(key: str, default: str = "") -> str:
    for line in ENV_FILE.read_text().splitlines():
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip().strip("'\"")
    return default


MONGO_URI = env_value("MARKDROP_MONGODB_URI", "mongodb://127.0.0.1:27019")
DB_NAME = env_value("MARKDROP_MONGODB_DB", "markdrop_docs_demo")
if STACK_ID:
    DB_NAME = f"markdrop_docs_demo_{STACK_ID}"
if not DB_NAME.startswith("markdrop_docs_demo") or (urlsplit(MONGO_URI).hostname or "") not in ("127.0.0.1", "localhost"):
    sys.exit(f"seed_extra_a.py: refusing to touch {MONGO_URI}/{DB_NAME} (local markdrop_docs_demo only)")

db = MongoClient(MONGO_URI, tz_aware=True)[DB_NAME]
RELATED = ("events", "engage_sessions", "file_versions", "access_requests")


def _drop_doc(row: dict) -> None:
    sid = str(row["_id"])
    db["documents"].delete_one({"_id": row["_id"]})
    for coll in RELATED:
        db[coll].delete_many({"doc_id": sid})
    db["document_grants"].delete_many({"document_id": sid})


def free(slug: str) -> None:
    STASH.mkdir(parents=True, exist_ok=True)
    file = STASH / f"{slug}.json"
    row = db["documents"].find_one({"slug": slug, "demo_seed": True})
    if row and not file.exists():
        versions = list(db["file_versions"].find({"doc_id": str(row["_id"])}))
        file.write_text(json_util.dumps({"doc": row, "versions": versions}))
    if row:
        db["documents"].delete_one({"_id": row["_id"]})
        db["file_versions"].delete_many({"doc_id": str(row["_id"])})
    # Anything a previous take left there, and the address holds.
    for other in db["documents"].find({"$or": [{"slug": slug}, {"old_slugs": slug}], "demo_seed": {"$ne": True}}):
        _drop_doc(other)
    db["slug_tombstones"].delete_many({"slug": slug})
    print(f"free {slug}: {'stashed' if file.exists() else 'nothing seeded there'}")


def restore(slug: str) -> None:
    for other in db["documents"].find({"$or": [{"slug": slug}, {"old_slugs": slug}], "demo_seed": {"$ne": True}}):
        _drop_doc(other)
    db["slug_tombstones"].delete_many({"slug": slug})
    file = STASH / f"{slug}.json"
    if not file.exists():
        print(f"restore {slug}: no stash")
        return
    saved = json_util.loads(file.read_text())
    if not db["documents"].find_one({"_id": saved["doc"]["_id"]}):
        db["documents"].insert_one(saved["doc"])
        for v in saved["versions"]:
            db["file_versions"].replace_one({"_id": v["_id"]}, v, upsert=True)
    file.unlink()
    print(f"restore {slug}: back")


def reslug(slug: str) -> None:
    row = db["documents"].find_one({"$or": [{"slug": slug}, {"old_slugs": slug}], "demo_seed": True})
    if not row:
        print(f"reslug {slug}: not found")
        return
    db["documents"].update_one({"_id": row["_id"]}, {"$set": {"slug": slug, "old_slugs": []}})
    db["slug_tombstones"].delete_many({"slug": slug})
    print(f"reslug {slug}: was {row['slug']}")


if __name__ == "__main__":
    args = sys.argv[1:]
    fn = {"free": free, "restore": restore, "reslug": reslug}.get(args[0]) if args else None
    if not args:
        print("seed_extra_a: nothing extra to seed (seed.py's world covers these shots)")
    elif not fn or len(args) < 2:
        sys.exit(__doc__)
    else:
        for s in args[1:]:
            fn(s)
