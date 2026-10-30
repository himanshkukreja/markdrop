#!/usr/bin/env python3
"""Extra demo data for the docs media shots of /files, /sharing and /account (shots/b-files-sharing-account.mjs).

Run after seed.py, on the same instance:

    STACK_ID=2 backend/.venv/bin/python frontend/scripts/docs-media/seed.py
    STACK_ID=2 backend/.venv/bin/python frontend/scripts/docs-media/seed_extra_b.py
    STACK_ID=2 backend/.venv/bin/python frontend/scripts/docs-media/seed_extra_b.py --state dana-no-request

Without --state it applies everything below and puts every state back to its default; each
--state only touches what that state is about (the shots call it from prepare/after). Idempotent.

What it adds to the world seed.py builds:
  files      .data/<N>/b/: q3-dashboard.html and site.zip (the zipped help site), the files the
             upload shots choose
  storage    Riya's storage reads 1.2 GB of 20 GB on the upload page: one kept old version (of a
             file since deleted) makes up the difference; it appears in no file's version list
  sharing    on onboarding-guide, Alex and Sam were emailed when added (only priya@northwind.com
             is "Added without an email")

States (--state):
  default            all of the below, as seeded
  dana-pending       Dana's request on q3-plan-internal is pending (seed.py's row, same id), and
                     she has no grant there
  dana-no-request    Dana has no request and no grant on q3-plan-internal (the "ask" screen)
  shares-reset       onboarding-guide back to Alex/Sam/priya; roadmap-2027 shared with nobody
  tokens-reset       Riya's API tokens back to My laptop / Nightly report / VS Code
  deck-v1            q3-board-deck shows its first version (for the replace video, which then
                     replaces it with v2); its seeded row is snapshotted in .data/<N>/b/deck.json
  deck-reset         q3-board-deck back to the snapshot (any later versions dropped)
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import zipfile
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlsplit

from bson import ObjectId
from pymongo import MongoClient

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import demo_content as C  # noqa: E402

STACK_ID = int(os.environ.get("STACK_ID") or 0)
BASE_DATA = Path(os.environ.get("DOCS_MEDIA_DATA") or (HERE / ".data")).resolve()
DATA = BASE_DATA if STACK_ID == 0 else BASE_DATA / str(STACK_ID)
OUT = DATA / "b"
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
    sys.exit(f"seed_extra_b.py: refusing to touch {MONGO_URI}/{DB_NAME} (local markdrop_docs_demo only)")

db = MongoClient(MONGO_URI, tz_aware=True)[DB_NAME]
MARK = "demo_extra_b"
GB = 1024 ** 3


def fixtures() -> dict:
    f = DATA / "fixtures.json"
    if not f.exists():
        sys.exit(f"seed_extra_b.py: no {f} — run seed.py first")
    return json.loads(f.read_text())


def doc_id(slug: str) -> str:
    raw = db["documents"].find_one({"slug": slug}, {"_id": 1})
    if raw is None:
        sys.exit(f"seed_extra_b.py: no document {slug} — run seed.py first")
    return str(raw["_id"])


# ── Files on disk ─────────────────────────────────────────────────────────────


def write_files() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "q3-dashboard.html").write_text(C.q3_dashboard_html())
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, body in C.help_site_files().items():
            z.writestr(name, body)
    (OUT / "site.zip").write_bytes(buf.getvalue())


# ── Storage: 1.2 GB used ──────────────────────────────────────────────────────


def usage(user_id: str) -> int:
    """services/file_versions.usage_bytes, without the rows this script adds."""
    total, current = 0, set()
    for d in db["documents"].find({"owner_id": user_id, "kind": "artifact"}, {"size_bytes": 1, "blob_key": 1}):
        total += int(d.get("size_bytes") or 0)
        if d.get("blob_key"):
            current.add(d["blob_key"])
    sizes: dict[str, int] = {}
    for r in db["file_versions"].find({"user_id": user_id, MARK: {"$ne": True}}, {"blob_key": 1, "size_bytes": 1}):
        if r.get("blob_key"):
            sizes[r["blob_key"]] = max(sizes.get(r["blob_key"], 0), int(r.get("size_bytes") or 0))
    return total + sum(s for k, s in sizes.items() if k not in current)


def storage(fx: dict) -> None:
    riya = fx["users"]["riya"]["id"]
    db["file_versions"].delete_many({"user_id": riya, MARK: True})
    missing = int(1.2 * GB) - usage(riya)
    if missing <= 0:
        return
    now = datetime.fromisoformat(fx["demo_now"])
    db["file_versions"].insert_one({
        "version": 1, "doc_id": str(ObjectId()), "slug": "all-hands-sept",
        "blob_key": f"art/{riya}/demo-extra-b-all-hands-sept.mp4", "created_at": now - timedelta(days=40),
        "filename": "all-hands-sept.mp4", "media": None, "mime": "video/mp4", "poster_key": None,
        "sha256": None, "size_bytes": missing, "user_id": riya, MARK: True,
    })


# ── States ────────────────────────────────────────────────────────────────────


def dana_no_request(fx: dict) -> None:
    doc = doc_id("q3-plan-internal")
    db["access_requests"].delete_many({"doc_id": doc, "requester_user_id": fx["users"]["dana"]["id"]})
    db["document_grants"].delete_many({"document_id": doc, "email": fx["users"]["dana"]["email"]})


def dana_pending(fx: dict) -> None:
    dana_no_request(fx)
    riya, dana = fx["users"]["riya"], fx["users"]["dana"]
    now = datetime.fromisoformat(fx["demo_now"])
    db["access_requests"].insert_one({
        "_id": ObjectId(fx["access_request"]), "doc_id": doc_id("q3-plan-internal"), "slug": "q3-plan-internal",
        "owner_id": riya["id"], "requester_user_id": dana["id"], "requester_email": dana["email"],
        "requester_name": dana["name"], "message": "Hi, I need this for Thursday's review.", "status": "pending",
        "role_granted": None, "created_at": now - timedelta(minutes=40), "decided_at": None, "decided_by": None,
        "notified": True,
    })


def shares_reset(fx: dict) -> None:
    guide = doc_id("onboarding-guide")
    db["document_grants"].delete_many({"document_id": guide,
                                       "email": {"$nin": ["alex@acme.com", "sam@acme.com", "priya@northwind.com"]}})
    db["document_grants"].update_many({"document_id": guide, "email": {"$in": ["alex@acme.com", "sam@acme.com"]}},
                                      {"$set": {"notified": True}})
    db["document_grants"].delete_many({"document_id": doc_id("roadmap-2027")})


def tokens_reset(fx: dict) -> None:
    keep = [ObjectId(i) for i in fx["tokens"].values()]
    db["api_tokens"].delete_many({"user_id": fx["users"]["riya"]["id"], "_id": {"$nin": keep}})


def _deck_snapshot() -> dict:
    """The seeded q3-board-deck row and its version ids (taken once per seed, i.e. per doc id)."""
    snap_file = OUT / "deck.json"
    raw = db["documents"].find_one({"slug": "q3-board-deck"})
    if raw is None:
        sys.exit("seed_extra_b.py: no q3-board-deck — run seed.py first")
    if snap_file.exists():
        snap = json.loads(snap_file.read_text())
        if snap["id"] == str(raw["_id"]):
            return snap
    from bson import json_util
    versions = [str(r["_id"]) for r in db["file_versions"].find({"doc_id": str(raw["_id"])})]
    snap = {"id": str(raw["_id"]), "doc": json_util.dumps(raw), "versions": versions}
    OUT.mkdir(parents=True, exist_ok=True)
    snap_file.write_text(json.dumps(snap))
    return snap


def _r2_public(key: str, public: bool) -> None:
    """Flip a fake-R2 object's public flag (run_api.py's FakeR2 metadata), as set_public does."""
    import hashlib
    meta = DATA / "r2" / f"{hashlib.sha256(key.encode()).hexdigest()}.json"
    if meta.exists():
        m = json.loads(meta.read_text())
        m["public"] = public
        meta.write_text(json.dumps(m))


def deck_reset(fx: dict) -> None:
    from bson import json_util
    snap = _deck_snapshot()
    # Every field back as seeded, except timestamps: seed.py --rebase may have shifted those since.
    doc = {k: v for k, v in json_util.loads(snap["doc"]).items() if not isinstance(v, datetime)}
    live = db["documents"].find_one({"_id": ObjectId(snap["id"])}) or {}
    doc.update({k: v for k, v in live.items() if isinstance(v, datetime)})
    db["documents"].replace_one({"_id": ObjectId(snap["id"])}, doc)
    db["file_versions"].delete_many({"doc_id": snap["id"], "_id": {"$nin": [ObjectId(i) for i in snap["versions"]]}})
    current = json_util.loads(snap["doc"]).get("blob_key")
    for v in db["file_versions"].find({"doc_id": snap["id"]}):
        _r2_public(v["blob_key"], v["blob_key"] == current)


def deck_v1(fx: dict) -> None:
    deck_reset(fx)
    snap = _deck_snapshot()
    v1 = db["file_versions"].find_one({"doc_id": snap["id"], "version": 1})
    db["documents"].update_one({"_id": ObjectId(snap["id"])}, {"$set": {
        "blob_key": v1["blob_key"], "size_bytes": v1["size_bytes"], "filename": v1["filename"]}})
    _r2_public(v1["blob_key"], True)


STATES = {
    "deck-v1": deck_v1,
    "deck-reset": deck_reset,
    "dana-pending": dana_pending,
    "dana-no-request": dana_no_request,
    "shares-reset": shares_reset,
    "tokens-reset": tokens_reset,
}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--state", choices=["default", *STATES], default=None)
    args = ap.parse_args()
    fx = fixtures()
    if args.state and args.state != "default":
        STATES[args.state](fx)
        print(f"seed_extra_b: {args.state}")
        return
    write_files()
    storage(fx)
    for name in ("dana-pending", "shares-reset", "tokens-reset", "deck-reset"):
        STATES[name](fx)
    print(f"seed_extra_b: {DB_NAME} — files in {OUT}, storage 1.2 GB, default states")


if __name__ == "__main__":
    main()
