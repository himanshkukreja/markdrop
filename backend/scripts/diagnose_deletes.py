"""READ-ONLY diagnostic for the delete_document incident (Senseloaf REQUESTS.md #2)
and for pages a delete/lift could have left unreadable, orphaned or invisible.

It never writes: only find / aggregate / count on the production database.

    cd backend && .venv/bin/python -m scripts.diagnose_deletes \\
        [--slug EegpMKD --slug sl-product-docs-playbook] [--days 14] [--limit 50]

Uses MONGODB_URI / MONGODB_DB from the environment, else the app's settings
(backend/.env on the server). Prints:

  A. Each --slug: its row (or the row that renamed away from it), its trash
     row (services/trash.py: a delete since the trash shipped moves the row
     there for 30 days: who deleted it, when, how, the batch it went with),
     its slug tombstone (written by lifecycle.destroy the moment a delete
     forever/expiry/purge took it, so tombstone.created_at = when it was
     destroyed), every other item the same owner lost within 10 s of that,
     the owner's MCP calls around it (tool, time, and for write tools the
     target {slug, doc_id} and result; arguments and content are never
     stored), and every MCP call whose target was this slug.
  B. Rows in a bad state:
     1. sub-pages whose parent row is gone (they read as private + unfiled:
        invisible to everyone but their owner, missing from folder listings);
     2. sub-pages filed in a different workspace/folder than their parent;
     3. inheriting sub-pages whose stored level/password differ from their parent's
        (listings filter on the stored copy, so they can be hidden from members);
     4. documents whose owner account is gone;
     5. documents filed in a workspace or folder that no longer exists;
     6. rows still marked access_dirty;
     7. deletes in the last --days that removed more than one item at once
        (several tombstones for one owner within 2 s) — what a children=delete
        does, and what an unexpected second deletion would look like.
"""

from __future__ import annotations

import argparse
import os
from datetime import datetime, timedelta, timezone

from bson import ObjectId
from pymongo import MongoClient

ROW = {"slug": 1, "title": 1, "kind": 1, "editor": 1, "owner_id": 1, "workspace_id": 1, "folder_id": 1,
       "folder_path": 1, "parent_id": 1, "access_inherit": 1, "access_level": 1, "page_path": 1,
       "old_slugs": 1, "expires_at": 1, "created_at": 1, "updated_at": 1, "access_dirty": 1,
       "read_password_hash": 1}


def connect():
    uri = os.environ.get("MONGODB_URI")
    name = os.environ.get("MONGODB_DB")
    if not uri or not name:
        from app.config import get_settings

        s = get_settings()
        uri, name = uri or s.mongodb_uri, name or s.mongodb_db
    client = MongoClient(uri, tz_aware=True, serverSelectionTimeoutMS=8000)
    return client[name]


def oid(v):
    if isinstance(v, ObjectId):
        return v
    try:
        return ObjectId(str(v))
    except Exception:
        return None


def show(raw: dict | None) -> str:
    if raw is None:
        return "-"
    keep = {k: raw.get(k) for k in ROW if k in raw and k != "read_password_hash"}
    keep["has_password"] = bool(raw.get("read_password_hash"))
    return f"_id={raw['_id']} " + " ".join(f"{k}={v!r}" for k, v in keep.items())


def aware(dt):
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def incident(db, slugs: list[str]) -> None:
    print("\n== A. The items named ==")
    for slug in slugs:
        print(f"\n-- {slug}")
        raw = db["documents"].find_one({"slug": slug}, ROW)
        print("row:            ", show(raw))
        moved = db["documents"].find_one({"old_slugs": slug}, ROW)
        if moved:
            print("renamed to:     ", show(moved))
        tomb = db["slug_tombstones"].find_one({"slug": slug})
        print("tombstone:      ", tomb and {k: tomb.get(k) for k in ("owner_id", "created_at", "until")})
        trashed = db["trash"].find_one({"$or": [{"slug": slug}, {"old_slugs": slug}]},
                                       {"doc.content": 0, "doc.edit_secret_hash": 0, "doc.read_password_hash": 0})
        if trashed:
            print("in the trash:   ", show(trashed.get("doc")))
            print("    deleted_at=%s deleted_by=%s via=%s purge_at=%s batch=%s root=%s depth=%s" % (
                trashed.get("deleted_at"), trashed.get("deleted_by"), trashed.get("via"), trashed.get("purge_at"),
                trashed.get("batch"), trashed.get("root"), trashed.get("depth")))
            mates = list(db["trash"].find({"batch": trashed.get("batch"), "_id": {"$ne": trashed["_id"]}},
                                          {"slug": 1, "depth": 1}))
            if mates:
                print("    deleted with it:", [(m["slug"], m.get("depth")) for m in mates])
        else:
            print("in the trash:    -")
        hits = list(db["mcp_events"].find(
            {"$or": [{"target.slug": slug}, {"targets.slug": slug}, {"result.slug": slug},
                     {"result.items.slug": slug}]},
            {"tool": 1, "ok": 1, "ts": 1, "client_id": 1, "user_id": 1, "target": 1, "result": 1}).sort("ts", 1))
        print(f"MCP calls that targeted it ({len(hits)}):")
        for c in hits:
            print(f"    {c['ts'].isoformat()} {c.get('tool')} ok={c.get('ok')} user={c.get('user_id')} "
                  f"client={c.get('client_id')} target={c.get('target')} result={c.get('result')}")
        if raw is not None:
            parent = db["documents"].find_one({"_id": oid(raw.get("parent_id"))}, ROW) if raw.get("parent_id") else None
            if raw.get("parent_id"):
                print("parent:         ", show(parent) if parent else "MISSING (dangling parent_id)")
            owner = db["users"].find_one({"_id": oid(raw.get("owner_id"))}, {"email": 1}) if raw.get("owner_id") else None
            print("owner account:  ", owner and owner.get("email"), "" if owner or not raw.get("owner_id") else "MISSING")
            if raw.get("workspace_id"):
                ws = db["workspaces"].find_one({"_id": oid(raw["workspace_id"])}, {"name": 1})
                print("workspace:      ", ws and ws.get("name") or "MISSING")
            if raw.get("folder_id"):
                f = db["folders"].find_one({"_id": oid(raw["folder_id"])}, {"name": 1, "slug": 1})
                print("folder:         ", f and (f.get("slug") or f.get("name")) or "MISSING")
            kids = list(db["documents"].find({"parent_id": raw["_id"]}, {"slug": 1, "title": 1}))
            if kids:
                print("sub-pages:      ", [(k["slug"], k.get("title")) for k in kids])
        if tomb and tomb.get("created_at"):
            at = aware(tomb["created_at"])
            owner_id = tomb.get("owner_id")
            same = list(db["slug_tombstones"].find(
                {"owner_id": owner_id, "created_at": {"$gte": at - timedelta(seconds=10),
                                                      "$lte": at + timedelta(seconds=10)}},
                {"slug": 1, "created_at": 1}).sort("created_at", 1))
            print("deleted within 10 s by the same owner:")
            for t in same:
                print("   ", t["created_at"].isoformat(), t["slug"])
            if owner_id:
                print_calls(db, owner_id, at)
        elif trashed and trashed.get("deleted_by") and trashed.get("deleted_at"):
            print_calls(db, trashed["deleted_by"], aware(trashed["deleted_at"]))


def print_calls(db, user_id: str, at) -> None:
    """The user's MCP calls within 30 minutes of ``at``; write tools with their target and result."""
    calls = list(db["mcp_events"].find(
        {"user_id": user_id, "ts": {"$gte": at - timedelta(minutes=30), "$lte": at + timedelta(minutes=30)}},
        {"tool": 1, "ok": 1, "ts": 1, "client_id": 1, "target": 1, "result": 1}).sort("ts", 1))
    print(f"their MCP calls ±30 min ({len(calls)}):")
    for c in calls:
        mark = "  <-- delete" if c.get("tool") == "delete_document" else ""
        extra = ""
        if "target" in c or "result" in c:
            extra = f" target={c.get('target')} result={c.get('result')}"
        print(f"    {c['ts'].isoformat()} {c.get('tool')} ok={c.get('ok')} client={c.get('client_id')}{extra}{mark}")


def trash_summary(db, days: int, limit: int) -> None:
    print("\n== C. The trash ==")
    n = db["trash"].count_documents({})
    print(f"rows in the trash: {n} ({db['trash'].count_documents({'root': True})} deletes)")
    since = datetime.now(timezone.utc) - timedelta(days=days)
    for t in db["trash"].find({"root": True, "deleted_at": {"$gte": since}},
                              {"slug": 1, "owner_id": 1, "deleted_by": 1, "via": 1, "deleted_at": 1, "batch": 1,
                               "doc.kind": 1, "doc.editor": 1}).sort("deleted_at", -1).limit(limit):
        subs = db["trash"].count_documents({"batch": t.get("batch"), "root": False})
        print(f"    {t['deleted_at'].isoformat()} {t['slug']} kind={(t.get('doc') or {}).get('kind')} "
              f"by={t.get('deleted_by')} via={t.get('via')} sub_pages={subs}")


def bad_rows(db, days: int, limit: int) -> None:
    print("\n== B. Rows in a bad state ==")
    docs = db["documents"]
    subpages = list(docs.find({"parent_id": {"$ne": None}}, ROW))
    ids = {d["_id"] for d in subpages} | {oid(d["parent_id"]) for d in subpages}
    by_id = {d["_id"]: d for d in docs.find({"_id": {"$in": [i for i in ids if i is not None]}}, ROW)}

    dangling, misplaced, stale = [], [], []
    for d in subpages:
        p = by_id.get(oid(d["parent_id"]))
        if p is None:
            dangling.append(d)
            continue
        if any((d.get(k) or None) != (p.get(k) or None) for k in ("workspace_id", "folder_id")):
            misplaced.append((d, p))
        inherits = d.get("access_inherit") is not False
        if inherits and ((d.get("access_level") or "link") != (p.get("access_level") or "link")
                         or (d.get("read_password_hash") or None) != (p.get("read_password_hash") or None)):
            stale.append((d, p))

    print(f"\n1. sub-pages whose parent is gone: {len(dangling)}")
    for d in dangling[:limit]:
        print("   ", show(d))
    print(f"\n2. sub-pages filed apart from their parent: {len(misplaced)}")
    for d, p in misplaced[:limit]:
        print("    child ", show(d))
        print("    parent", show(p))
    print(f"\n3. inheriting sub-pages whose stored access differs from their parent's: {len(stale)}")
    for d, p in stale[:limit]:
        print(f"    {d['slug']} level={d.get('access_level')} vs parent {p['slug']} level={p.get('access_level')}")

    owners = docs.distinct("owner_id", {"owner_id": {"$ne": None}})
    present = {str(u["_id"]) for u in db["users"].find({"_id": {"$in": [o for o in map(oid, owners) if o]}}, {"_id": 1})}
    gone_owners = [o for o in owners if o not in present]
    n = docs.count_documents({"owner_id": {"$in": gone_owners}}) if gone_owners else 0
    print(f"\n4. documents whose owner account is gone: {n}")
    for d in (docs.find({"owner_id": {"$in": gone_owners}}, ROW).limit(limit) if gone_owners else []):
        print("   ", show(d))

    ws_ids = docs.distinct("workspace_id", {"workspace_id": {"$ne": None}})
    ws_present = {str(w["_id"]) for w in db["workspaces"].find({"_id": {"$in": [o for o in map(oid, ws_ids) if o]}}, {"_id": 1})}
    ws_gone = [w for w in ws_ids if w not in ws_present]
    f_ids = docs.distinct("folder_id", {"folder_id": {"$ne": None}})
    f_present = {str(f["_id"]) for f in db["folders"].find({"_id": {"$in": [o for o in map(oid, f_ids) if o]}}, {"_id": 1})}
    f_gone = [f for f in f_ids if f not in f_present]
    q = {"$or": [{"workspace_id": {"$in": ws_gone}}, {"folder_id": {"$in": f_gone}}]}
    n = docs.count_documents(q) if (ws_gone or f_gone) else 0
    print(f"\n5. documents filed in a missing workspace or folder: {n}")
    for d in (docs.find(q, ROW).limit(limit) if n else []):
        print("   ", show(d))

    n = docs.count_documents({"access_dirty": True})
    print(f"\n6. rows marked access_dirty: {n}")
    for d in docs.find({"access_dirty": True}, ROW).limit(limit):
        print("   ", show(d))

    since = datetime.now(timezone.utc) - timedelta(days=days)
    tombs = list(db["slug_tombstones"].find({"created_at": {"$gte": since}},
                                            {"slug": 1, "owner_id": 1, "created_at": 1}).sort("created_at", 1))
    bursts, cur = [], []
    for t in tombs:
        if cur and (t.get("owner_id") != cur[-1].get("owner_id")
                    or aware(t["created_at"]) - aware(cur[-1]["created_at"]) > timedelta(seconds=2)):
            if len(cur) > 1:
                bursts.append(cur)
            cur = []
        cur.append(t)
    if len(cur) > 1:
        bursts.append(cur)
    print(f"\n7. deletes in the last {days} days that removed several items at once: {len(bursts)}")
    print("   (a rename also tombstones old slugs; a lone delete of a renamed item shows its old slugs here)")
    for b in bursts[:limit]:
        print(f"    owner={b[0].get('owner_id')} at {b[0]['created_at'].isoformat()}: {[t['slug'] for t in b]}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--slug", action="append", default=None)
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--limit", type=int, default=50)
    args = ap.parse_args()
    db = connect()
    incident(db, args.slug or ["EegpMKD", "sl-product-docs-playbook"])
    bad_rows(db, args.days, args.limit)
    trash_summary(db, args.days, args.limit)


if __name__ == "__main__":
    main()
