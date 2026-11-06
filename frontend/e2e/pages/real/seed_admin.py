"""Something for every admin tab to show (admin-sso.mjs), in db markdrop_docs_demo_<STACK_ID>:

site traffic over the last 30 days (real /beat calls, then spread back in time), feedback, AI ledger
rows. Run after seed.py. Prints {"sessions": n, "feedback": n, "ai": n}.
"""
import json
import os
import random
import secrets
from datetime import datetime, timedelta, timezone

import httpx
from pymongo import MongoClient

STACK_ID = int(os.environ.get("STACK_ID") or os.environ.get("PB_STACK_ID") or 5)
API = f"http://127.0.0.1:{8180 + 10 * STACK_ID}"
APP_HOST = "localhost"
DB = MongoClient("mongodb://127.0.0.1:27019")[f"markdrop_docs_demo_{STACK_ID}"]
rnd = random.Random(7)
now = datetime.now(timezone.utc)

UAS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
]
REFS = [None, None, "https://www.google.com/", "https://news.ycombinator.com/", "https://github.com/x/y", "https://t.co/abc"]
PATHS = ["/", "/new", "/guides", "/dashboard", "/share", "/builder", "/docs-intro", "/pricing", "/login"]

http = httpx.Client(base_url=API, timeout=20)
sids = []
for i in range(90):
    vid, sid = secrets.token_hex(8), secrets.token_hex(8)
    n = rnd.randint(1, 4)
    events = [{"k": "pv", "p": rnd.choice(PATHS)} for _ in range(n)]
    if rnd.random() < 0.3:
        events.append({"k": "ev", "n": "publish", "p": "/new"})
    events.append({"k": "leave", "d": rnd.randint(4000, 240000)})
    body = {"vid": vid, "sid": sid, "host": APP_HOST, "events": events,
            "entry": {"ref": rnd.choice(REFS), **({"utm_source": "newsletter", "utm_medium": "email"} if i % 11 == 0 else {})}}
    r = http.post("/api/v1/beat", content=json.dumps(body),
                  headers={"Content-Type": "text/plain", "User-Agent": rnd.choice(UAS), "X-Real-IP": f"198.51.100.{i % 250}"})
    r.raise_for_status()
    sids.append(sid)

# Spread the sessions over the last 30 days (more recently than not).
for sid in sids:
    back = timedelta(days=min(29, int(rnd.expovariate(1 / 9))), hours=rnd.randint(0, 20), minutes=rnd.randint(0, 59))
    for coll, key in (("traffic_sessions", "_id"), ("traffic_pageviews", "sid"), ("traffic_events", "sid")):
        for doc in DB[coll].find({key: sid}):
            sets = {k: v - back for k, v in doc.items() if isinstance(v, datetime)}
            if sets:
                DB[coll].update_one({"_id": doc["_id"]}, {"$set": sets})
for v in DB["traffic_visitors"].find({}):
    s = DB["traffic_sessions"].find_one({"vid": v["_id"]}, sort=[("started_at", 1)])
    if s:
        DB["traffic_visitors"].update_one({"_id": v["_id"]}, {"$set": {"first_seen": s["started_at"], "last_seen": s.get("last_seen", s["started_at"])}})

# Feedback (bugs and ideas, one resolved).
fb = [("bug", "The share link copies the old slug after a rename."), ("feature", "Dark mode for the admin console, please."),
      ("bug", "PDF preview flickers on Safari when zooming."), ("feature", "Let me pin documents to the top of a folder."),
      ("bug", "Export to Word drops table borders.")]
for i, (t, m) in enumerate(fb):
    http.post("/api/v1/feedback", json={"type": t, "message": m, "email": f"reader{i}@example.com", "page_url": "http://localhost/dashboard"},
              headers={"X-Real-IP": f"203.0.113.{i}"}).raise_for_status()
first = DB["feedback"].find_one({}, sort=[("created_at", 1)])
if first:
    DB["feedback"].update_one({"_id": first["_id"]}, {"$set": {"status": "resolved"}})

# AI ledger rows across features, the last 14 days.
users = [str(u["_id"]) for u in DB["users"].find({}, {"_id": 1}).limit(5)]
rows = []
for i in range(60):
    ts = now - timedelta(days=rnd.randint(0, 13), hours=rnd.randint(0, 23))
    feat = rnd.choice(["pages_ai", "docs_ask", "search_ai", "analytics_ai", "docs_editor_ai"])
    inp, out = rnd.randint(800, 9000), rnd.randint(80, 900)
    rows.append({"feature": feat, "request_id": secrets.token_hex(16), "ts": ts, "day": ts.strftime("%Y-%m-%d"),
                 "model": "claude-haiku-4-5", "priced": True, "calls": 1,
                 "usage": {"input_tokens": inp, "output_tokens": out, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
                 "cost_usd": round(inp * 1e-6 + out * 5e-6, 6), "long_context_calls": 0, "max_prompt_tokens": inp,
                 "latency_ms": rnd.randint(600, 5200), "ttft_ms": rnd.randint(200, 900),
                 "outcome": "answered" if rnd.random() < 0.85 else rnd.choice(["error", "refused"]),
                 "user_id": rnd.choice(users) if users and rnd.random() < 0.7 else None,
                 "ip_hash": secrets.token_hex(32), "visitor": None, **({"site": "markdrop", "question": "How do I add a custom domain?"} if feat == "docs_ask" else {})})
DB["ai_requests"].insert_many(rows)

print(json.dumps({"sessions": len(sids), "feedback": len(fb), "ai": len(rows)}))
