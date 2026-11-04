"""Analytics AI's e2e world (analytics-ai.mjs), straight into db markdrop_docs_demo_<STACK_ID>:

    seed_analytics_ai.py views <owner id> <slug>:<n>[:<referrer>] ...   view events (this week, a few last week)
    seed_analytics_ai.py gaps <workspace id> <owner id>                  failed searches + a guide with unanswered questions
    seed_analytics_ai.py searches <workspace id> <q>                     how many search_queries rows have q (prints JSON)
"""
import json
import os
import secrets
import sys
from datetime import datetime, timedelta, timezone

from pymongo import MongoClient

STACK_ID = int(os.environ.get("STACK_ID") or os.environ.get("PB_STACK_ID") or 5)
DB = MongoClient("mongodb://127.0.0.1:27019")[f"markdrop_docs_demo_{STACK_ID}"]
now = datetime.now(timezone.utc)
cmd = sys.argv[1]

if cmd == "views":
    owner = sys.argv[2]
    rows = []
    for spec in sys.argv[3:]:
        slug, n, *rest = spec.split(":", 2)
        ref = rest[0] if rest else None
        doc = DB["documents"].find_one({"slug": slug})
        for i in range(int(n)):
            rows.append({"doc_id": str(doc["_id"]), "owner_id": owner, "type": "view", "internal": False,
                         "ts": now - timedelta(hours=2 + i), "referrer": ref, "ip_hash": f"e2e-{slug}-{i % 9}",
                         "country": "DE" if i % 3 else "US", "device": "Desktop" if i % 4 else "Mobile"})
        for i in range(3):
            rows.append({"doc_id": str(doc["_id"]), "owner_id": owner, "type": "view", "internal": False,
                         "ts": now - timedelta(days=9, hours=i), "referrer": None, "ip_hash": f"e2e-old-{i}",
                         "country": "DE", "device": "Desktop"})
    DB["events"].insert_many(rows)
    print(json.dumps({"views": len(rows)}))
elif cmd == "gaps":
    ws, owner = sys.argv[2], sys.argv[3]
    DB["search_queries"].delete_many({"ws": ws})
    rows = []
    for q, n, results in (("contractor onboarding", 4, 0), ("laptop setup", 3, 0), ("vpn access", 2, 4)):
        for i in range(n):
            rows.append({"_id": secrets.token_hex(16), "q": q, "ws": ws, "results": results, "clicked": False,
                         "ts": now - timedelta(days=1, minutes=i)})
    DB["search_queries"].insert_many(rows)
    site = DB["docs_sites"].insert_one({"name": "Acme Help", "workspace_id": ws, "owner_id": owner, "deleted_at": None,
                                        "created_at": now})
    DB["ai_requests"].insert_many([
        {"feature": "docs_ask", "site": str(site.inserted_id), "ts": now - timedelta(days=2), "insights": True,
         "outcome": "no_answer", "question": "How do contractors get a laptop?", "request_id": secrets.token_hex(8)}
        for _ in range(2)])
    print(json.dumps({"searches": len(rows)}))
elif cmd == "searches":
    ws, q = sys.argv[2], sys.argv[3]
    rows = list(DB["search_queries"].find({"ws": ws, "q": q}))
    print(json.dumps({"n": len(rows), "fields": sorted({k for r in rows for k in r}),
                      "clicked": any(r.get("clicked") for r in rows)}))
