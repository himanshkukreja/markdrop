"""~300 meetings in the seed workspace for meetings-perf.mjs (feat/meetings-perf). Run AFTER seed.py, with the
API up with PB_FAKE_MEETINGS_AI=1:

    STACK_ID=… PB_STACK=… [PERF_N=300] python seed_meetings_perf.py

Imports two real meetings through the API (one open to the team, one restricted to Ada and Wes), then clones
them in the sandbox db into PERF_N meetings with realistic sizes: a ~700-line transcript on the row, Gemini
notes, AI sections, a ~10 KB page body, six series, two meetings a day, every 10th restricted (Ben, a member,
wasn't there). Writes seed-meetings-perf.json ({open, restricted, total}) to $PB_STACK.
"""
import json
import os
import random
import secrets
import sys
from copy import deepcopy
from datetime import timedelta
from pathlib import Path

import httpx
from bson import ObjectId
from pymongo import MongoClient

STACK_ID = int(os.environ.get("STACK_ID", "5"))
API = os.environ.get("PB_API", f"http://127.0.0.1:{8180 + 10 * STACK_ID}")
DB_NAME = os.environ.get("PB_DB", f"markdrop_docs_demo_{STACK_ID}")
assert DB_NAME.startswith("markdrop_docs_demo"), "seed_meetings_perf only writes to a sandbox db"
OUT = Path(os.environ.get("PB_STACK") or ".")
N = int(os.environ.get("PERF_N", "300"))
DB = MongoClient("mongodb://127.0.0.1:27019")[DB_NAME]
http = httpx.Client(base_url=API, timeout=120)
rng = random.Random(11)

seed = json.loads((OUT / "seed.json").read_text())
U = seed["users"]
WS = seed["ws"]


def call(method, path, token=None, **kw):
    r = http.request(method, path, headers={"Authorization": f"Bearer {token}"} if token else {}, **kw)
    if r.status_code >= 400:
        sys.exit(f"{method} {path} → {r.status_code}: {r.text[:400]}")
    return r.json() if r.content else None


def transcript(title, day, people, lines):
    return (f"{title} ({day} 10:00 GMT+05:30) - Transcript\nAttendees\n{', '.join(people)}\nTranscript\n"
            "This editable transcript was computer generated and might contain errors.\n" + "\n".join(lines)
            + "\nTranscription ended after 00:31:10\n")


ada = U["owner"]["token"]
lines = ["Ada Owner: Morning everyone, quick round please.", "Ben Member: I will finish the export fix today.",
         "Wes Admin: We agree the release candidate is cut on Thursday.", "Ada Owner: Is the pricing copy blocked?"]
open_m = call("POST", "/api/v1/meetings/import", ada, json={"workspace": WS, "wait": True, "sources": [
    {"name": "Weekly product sync (2026-11-04 10:00 GMT+05:30) - Transcript",
     "text": transcript("Weekly product sync", "2026-11-04", ["Ada Owner", "Ben Member", "Wes Admin"], lines)}]})["meetings"][0]
secret_m = call("POST", "/api/v1/meetings/import", ada, json={"workspace": WS, "wait": True, "restricted": True, "sources": [
    {"name": "Leadership 1:1 (2026-11-03 10:00 GMT+05:30) - Transcript",
     "text": transcript("Leadership 1:1", "2026-11-03", ["Ada Owner", "Wes Admin"],
                        ["Ada Owner: The secret plan is codename-zebra.", "Wes Admin: Agreed, zebra it is."])}]})["meetings"][0]

tpl = {}
for key, m in (("open", open_m), ("secret", secret_m)):
    row = DB["meetings"].find_one({"_id": ObjectId(m["id"])})
    page = DB["documents"].find_one({"_id": ObjectId(row["doc_id"])})
    grants = list(DB["document_grants"].find({"document_id": str(page["_id"])}))
    tpl[key] = (row, page, grants)

SERIES = ["Daily Standup", "Weekly product sync", "Design review", "Customer: Senseloaf", "Sprint planning", None, None]
WORDS = ("we should ship the release on friday if the dry run passes and update the onboarding docs with new "
         "screenshots pricing annual discount staging customer feedback roadmap").split()
NAMES = ["Ada Owner", "Ben Member", "Wes Admin", "Vic Viewer", "Lena Ortiz", "Sam Patel", "Kim Lee", "Noor Ali"]


def sentence(n=28):
    return " ".join(rng.choice(WORDS) for _ in range(n)).capitalize() + "."


rows, docs, grants, out = [], [], [], {"open": [], "restricted": []}
base = tpl["open"][0]["created_at"]
for i in range(N):
    secret = i % 10 == 3
    row0, page0, grants0 = tpl["secret" if secret else "open"]
    r, d = deepcopy(row0), deepcopy(page0)
    r["_id"], d["_id"] = ObjectId(), ObjectId()
    d["slug"] = f"perf-{i}-{secrets.token_hex(3)}"
    r["doc_id"], d["meeting_id"] = str(d["_id"]), str(r["_id"])
    r["date"] = (base - timedelta(days=1 + i // 2)).date().isoformat()
    r["time"] = "09:30" if i % 2 == 0 else "15:00"
    r["series"] = SERIES[i % len(SERIES)]
    r["title"] = "Leadership 1:1" if secret else (r["series"] or f"Call with partner {i}")
    r["created_at"] = base - timedelta(minutes=i)
    k = rng.randint(3, 8)
    if not secret:
        r["attendees"] = [{"name": n, "user_id": None} for n in NAMES[:k]]
    r["segments"] = [{"t": j * 5, "speaker": NAMES[j % k], "text": sentence()} for j in range(700)]
    r["notes"] = {"summary": " ".join(sentence() for _ in range(6)), "details": [sentence(60) for _ in range(8)],
                  "next_steps": [sentence() for _ in range(5)]}
    gen = deepcopy(r.get("generated") or {})
    gen["summary"] = " ".join(sentence() for _ in range(5))
    gen["decisions"] = [{"text": sentence(), "cite": f"s{j}"} for j in range(rng.randint(0, 5))]
    gen["open_questions"] = [{"text": sentence(), "cite": f"s{j}"} for j in range(rng.randint(0, 3))]
    r["generated"] = gen
    d["content"] = page0["content"] + "\n\n" + "\n\n".join(f"- {sentence(40)}" for _ in range(40))
    for g in grants0:
        grants.append({**{x: v for x, v in g.items() if x != "_id"}, "document_id": str(d["_id"])})
    rows.append(r)
    docs.append(d)
    out["restricted" if secret else "open"].append(str(r["_id"]))

DB["documents"].insert_many(docs)
DB["meetings"].insert_many(rows)
if grants:
    DB["document_grants"].insert_many(grants)
# The two imported ones stay too (one open, one restricted).
out["open"].append(open_m["id"])
out["restricted"].append(secret_m["id"])
out["total"] = len(out["open"]) + len(out["restricted"])
(OUT / "seed-meetings-perf.json").write_text(json.dumps(out))
print(json.dumps({"open": len(out["open"]), "restricted": len(out["restricted"])}))
