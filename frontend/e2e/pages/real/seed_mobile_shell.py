"""Shares for the mobile-shell audit (mobile-shell.mjs), written straight to the sandbox db: the seed's
people have reserved @*.test addresses, which the sharing route's email check rightly refuses.

    STACK_ID=34 python seed_mobile_shell.py '[{"slug": "…", "from": "<user id>", "from_email": "…", "from_name": "Ada", "to": "<user id>", "to_email": "…"}]'

Each share: an owner grant (document_grants, as access.add_grant writes it) and a "shared"
notification under the recipient's bell (as notifications.notify writes it).
"""
import json
import os
import sys
from datetime import datetime, timezone

from pymongo import MongoClient

STACK_ID = int(os.environ.get("STACK_ID", "5"))
DB_NAME = os.environ.get("PB_DB", f"markdrop_docs_demo_{STACK_ID}")
assert DB_NAME.startswith("markdrop_docs_demo"), "seed_mobile_shell only writes to a sandbox db"
DB = MongoClient("mongodb://127.0.0.1:27019")[DB_NAME]

now = datetime.now(timezone.utc)
for s in json.loads(sys.argv[1]):
    doc = DB["documents"].find_one({"slug": s["slug"]})
    assert doc, s["slug"]
    doc_id = str(doc["_id"])
    DB["document_grants"].update_one(
        {"document_id": doc_id, "email": s["to_email"]},
        {"$set": {"document_id": doc_id, "email": s["to_email"], "role": "viewer", "granted_by_email": s["from_email"],
                  "granted_by_user_id": s["from"], "granted_via": None, "parent_grant_id": None,
                  "created_at": now, "notified": False}},
        upsert=True)
    DB["notifications"].insert_one({
        "user_id": s["to"], "kind": "shared", "doc_id": doc_id, "block_id": None, "actor_id": s["from"],
        "actor_name": s["from_name"], "via": None, "extra": {"role": "viewer", "message": "Have a look before Friday."},
        "created_at": now, "read_at": None, "email": "off", "emailed_at": None})
print("ok")
