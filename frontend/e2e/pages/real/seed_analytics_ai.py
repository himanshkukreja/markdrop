"""Analytics AI per document (analytics-ai.mjs): a page, a PDF and a two-version video owned by Ada,
each with enough reading / watching sessions for ✦ Insights, and a thin document that has too few.
Run AFTER seed.py (it reuses seed.json's people and adds to the same db; it never wipes):

    STACK_ID=31 PB_STACK=… PB_FIXTURES=… python seed_analytics_ai.py

Sessions go straight into engage_sessions (as the engagement beacon would leave them), spread over
the last week, with made-up visitor hashes and countries (which must never reach the model).
Writes seed-analytics-ai.json to $PB_STACK.
"""
import json
import os
import random
import secrets
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from pymongo import MongoClient

WT = Path(__file__).resolve().parents[4]
ROOT = Path(str(WT).split("/.claude/worktrees/")[0])
sys.path.insert(0, str(WT / "backend"))
from app.services import md_outline  # noqa: E402

STACK_ID = int(os.environ.get("STACK_ID", "5"))
API = f"http://127.0.0.1:{8180 + 10 * STACK_ID}"
OUT = Path(os.environ.get("PB_STACK") or ".")
FIX = Path(os.environ.get("PB_FIXTURES") or ROOT / "frontend" / "scripts" / "docs-media" / ".data" / "fixtures")
DB = MongoClient("mongodb://127.0.0.1:27019")[f"markdrop_docs_demo_{STACK_ID}"]
http = httpx.Client(base_url=API, timeout=120)
rnd = random.Random(7)


def call(method, path, token=None, **kw):
    headers = kw.pop("headers", {})
    if token:
        headers["Authorization"] = f"Bearer {token}"
    r = http.request(method, path, headers=headers, **kw)
    if r.status_code >= 400:
        sys.exit(f"{method} {path} → {r.status_code}: {r.text[:400]}")
    return r.json() if r.content else None


seed = json.loads((OUT / "seed.json").read_text())
ada = seed["users"]["owner"]
T = ada["token"]


def upload(data, filename, mime, title, slug=None, target=None):
    body = {"filename": filename, "content_type": mime, "size_bytes": len(data)}
    if target:
        body["target_slug"] = target
    u = call("POST", "/api/v1/artifacts/upload-url", T, json=body)
    httpx.put(u["upload_url"], content=data, headers={"Content-Type": u["required_content_type"]}, timeout=120).raise_for_status()
    if target:
        return call("PUT", f"/api/v1/artifacts/{target}/file", T, json={"blob_key": u["blob_key"], "filename": filename})["slug"]
    return call("POST", "/api/v1/artifacts", T, json={"blob_key": u["blob_key"], "title": title, "filename": filename,
                                                       "custom_slug": slug, "expires_in": "never"})["slug"]


def doc_row(slug):
    return DB["documents"].find_one({"slug": slug})


now = datetime.now(timezone.utc)


def session(raw, **fields):
    started = now - timedelta(days=rnd.uniform(0.2, 6.5))
    row = {
        "sid": "s" + secrets.token_hex(8), "doc_id": str(raw["_id"]), "owner_id": raw.get("owner_id"),
        "kind": fields.pop("kind"), "ver": fields.pop("ver", None), "started_at": started,
        "updated_at": started + timedelta(minutes=3), "seq": 3, "ended": True,
        "ip_hash": "ip" + secrets.token_hex(6), "country": rnd.choice(["DE", "FR", "US", "IN", "BR"]),
        "region": None, "city": None, "device": rnd.choice(["Desktop", "Desktop", "Mobile"]), "os": "macOS",
        "browser": "Safari", "channel": rnd.choice(["Direct", "Social", "Email"]), "ref": "https://news.example.com/item",
        "utm_source": None, "utm_medium": None, "utm_campaign": None, "internal": False,
        "active_s": 30, "depth": 0, "reached": [], "sec": {}, "copies": {}, "links": {}, "prints": 0,
        "pages": {}, "npages": None, "pmax": 0, "rv": {}, "media": None,
    }
    row.update(fields)
    return row


# ── A page: readers leave at "Configuration" ─────────────────────────────────
LONG = " ".join(["Every option is explained here in detail, with its default, its range and the reasons you might change it."] * 6)
PAGE = f"""# Getting started with Acme

Acme sends your reports every morning. This guide sets you up in five minutes.

## Install

Install the command-line tool, then sign in.

```bash
npm install -g acme-cli
acme login
```

## Configuration

{LONG}

At the very end: set your API key with `acme config set key <your key>`. Nothing works without it.

## Your first report

Run `acme report --today` and open the link it prints.

## Troubleshooting

If the report is empty, check that the API key is set.
"""
page = call("POST", "/api/v1/pages", T, json={"title": "Getting started with Acme", "content": PAGE})["document"]["slug"]
raw = doc_row(page)
ids = [h["id"] for h in md_outline.extract_headings(PAGE)]   # what the reader's tracker reports
rows = []
for i in range(48):
    reach = 2 + (1 if i % 3 else 0) + (1 if i % 3 and i % 2 == 0 else 0) + (1 if i % 7 == 0 else 0)
    got = ids[:min(len(ids), reach)]
    rows.append(session(raw, kind="doc", reached=got, sec={h: rnd.randint(8, 40) + (60 if "configuration" in h else 0) for h in got},
                        active_s=rnd.randint(40, 200), depth=100 if len(got) == len(ids) else 30 + 15 * len(got),
                        copies={f"1a2b3c4d|{ids[1]}": 1} if i % 4 == 0 else {}))
DB["engage_sessions"].insert_many(rows)

# ── A thin document: three sessions ──────────────────────────────────────────
thin = call("POST", "/api/v1/documents", T, json={"title": "Draft notes", "custom_slug": "ai-thin-notes", "expires_in": "never",
                                                  "content": "# Draft notes\n\n## One\n\nText.\n"})["slug"]
traw = doc_row(thin)
DB["engage_sessions"].insert_many([session(traw, kind="doc", active_s=20) for _ in range(3)])

# ── A PDF: readers stop after page 4 ─────────────────────────────────────────
pdf = upload((FIX / "q3-board-deck-v1.pdf").read_bytes(), "q3-board-deck.pdf", "application/pdf", "Q3 board deck", "ai-q3-deck")
praw = doc_row(pdf)
NP = 12
rows = []
for i in range(36):
    pmax = 12 if i % 6 == 0 else (4 if i % 2 else rnd.randint(5, 9))
    rows.append(session(praw, kind="pdf", ver=int(praw.get("file_version") or 1), npages=NP, pmax=pmax,
                        pages={str(p): rnd.randint(6, 20) + (40 if p == 3 else 0) for p in range(1, pmax + 1)},
                        rv={"3": 1} if i % 5 == 0 else {}, active_s=rnd.randint(60, 240)))
DB["engage_sessions"].insert_many(rows)

# ── A video with two versions: v2 keeps people longer ────────────────────────
video = upload((FIX / "product-demo-v1.mp4").read_bytes(), "product-demo.mp4", "video/mp4", "Product demo", "ai-product-demo")
upload((FIX / "product-demo-v2.mp4").read_bytes(), "product-demo-v2.mp4", "video/mp4", "Product demo", target=video)
vraw = doc_row(video)
DUR = 40.6
rows = []
for v, n, keep in ((1, 60, 0.45), (2, 70, 0.75)):
    for i in range(n):
        if rnd.random() < keep:
            segs = [[0, DUR]]
        elif i % 3 == 0:
            segs = [[0, 12.0], [22.0, DUR]]                  # skips the setup part
        else:
            segs = [[0, rnd.uniform(6, 11)]]                  # leaves in the intro
        if i % 5 == 0:
            segs.append([28.0, 34.0])                         # replays the result
        watched = sum(e - s for s, e in segs)
        rows.append(session(vraw, kind="video", ver=v,
                            media={"dur": DUR, "segs": segs, "plays": 1, "watched_s": watched,
                                   "ended": 1 if segs[-1][1] >= DUR - 0.5 else 0, "startup_ms": rnd.randint(300, 2500),
                                   "speed": {"1": watched}}))
DB["engage_sessions"].insert_many(rows)
DB["analytics_ai_doc"].delete_many({})

out = {"page": page, "thin": thin, "pdf": pdf, "video": video, "owner": {"email": ada["email"], "token": T},
       "member": seed["users"]["member"]}
(OUT / "seed-analytics-ai.json").write_text(json.dumps(out, indent=1))
print(json.dumps({k: v for k, v in out.items() if k not in ("owner", "member")}))
