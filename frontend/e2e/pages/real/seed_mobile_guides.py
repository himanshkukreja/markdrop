"""Seed for mobile-guides.mjs (the Guides studio + Analytics touch audit), on top of seed.py's world.

Run after seed.py (lib.mjs reseed()) against the same stack (PB_STACK_ID). Adds:

  Guides  · "Acme Docs" (slug acme-docs, product template + a long page with a wide table and long code,
            Ask AI on), live (a publish recorded as built: this stack runs no build worker), then one
            edited page (unpublished changes); two weeks of reader Insights and Fix list signals.
          · "Acme Help" (helpcenter template, never published) and "API" (api template) for the grid.
          · Ben (workspace member) is a Guides editor; Wes (admin) is a Guides admin through his role.
  Analytics · 120 days of views and reading sessions on launch-plan (Markdown), q3-report (a PDF, now
            version 2) and a new product-demo video (version 2), plus views in the last minutes (Live).

Writes mobile.json beside seed.json: {"site", "help", "api", "page", "long_page", "video"}.
"""
import json
import os
import random
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from bson import ObjectId
from pymongo import MongoClient

WT = Path(__file__).resolve().parents[4]
ROOT = Path(str(WT).split("/.claude/worktrees/")[0])
OUT = Path(os.environ.get("PB_STACK") or ROOT / ".work" / "page-builder" / "stack")
STACK_ID = int(os.environ.get("STACK_ID") or 5)
API = f"http://127.0.0.1:{8180 + 10 * STACK_ID}"
FIX = Path(os.environ.get("PB_FIXTURES") or ROOT / "frontend" / "scripts" / "docs-media" / ".data" / "fixtures")
db = MongoClient("mongodb://127.0.0.1:27019")[f"markdrop_docs_demo_{STACK_ID}"]
http = httpx.Client(base_url=API, timeout=60)
RNG = random.Random(36)
NOW = datetime.now(timezone.utc)
seed = json.loads((OUT / "seed.json").read_text())
U = seed["users"]
ADA, BEN = U["owner"]["token"], U["member"]["token"]
WS = seed["ws"]


def call(method, path, token=None, **kw):
    headers = kw.pop("headers", {})
    if token:
        headers["Authorization"] = f"Bearer {token}"
    r = http.request(method, path, headers=headers, **kw)
    if r.status_code >= 400:
        sys.exit(f"{method} {path} → {r.status_code}: {r.text[:400]}")
    return r.json() if r.content else None


# ── Guides ────────────────────────────────────────────────────────────────────

LONG = """Everything you need to wire Acme into a production service, end to end.

## Configuration reference

| Option | Type | Default | Environment variable | What it does |
|---|---|---|---|---|
| `endpoint` | string | `https://api.acme.dev/v2/ingest/events` | `ACME_ENDPOINT` | Where events go; change it only for a self-hosted collector. |
| `batch_size` | integer | `500` | `ACME_BATCH_SIZE` | How many events go in one request before it is sent. |
| `flush_interval_ms` | integer | `10000` | `ACME_FLUSH_INTERVAL_MS` | The longest an event waits in the buffer. |
| `retry_policy` | object | `{ max: 5, backoff: "exponential" }` | `ACME_RETRY_POLICY` | How failed requests are retried. |

## Install

```bash
curl -fsSL https://get.acme.dev/install.sh | ACME_CHANNEL=stable ACME_INSTALL_DIR="$HOME/.local/share/acme/bin" sh -s -- --no-modify-path --yes
```

## Send your first event

```ts
import { Acme } from "@acme/sdk";
const acme = new Acme({ apiKey: process.env.ACME_API_KEY!, endpoint: process.env.ACME_ENDPOINT ?? "https://api.acme.dev/v2/ingest/events", batchSize: 500 });
await acme.track({ event: "checkout_completed", properties: { orderId: "ord_9f2c1d", amountCents: 129900, currency: "USD", items: 3 } });
```

:::note[Rate limits]
Each key sends up to 1,000 events a second. Bursts above that are queued for a minute, then dropped.
:::

## Troubleshooting

If nothing shows up after a minute, check the key, then the endpoint, then the clock on the machine: events more than a day in the future are dropped.

### Proxy

Set `HTTPS_PROXY` before you start the service.

### Firewalls

Allow outbound HTTPS to `api.acme.dev` on port 443.
"""


def pages_of(token, sid):
    return {p["path"]: p for p in call("GET", f"/api/v1/docs-sites/{sid}/pages", token)["pages"]}


def write_page(token, sid, path, title, md, group=None, desc=""):
    have = pages_of(token, sid)
    if path not in have:
        body = {"path": path, "title": title}
        if group:
            body["group"] = group
        call("POST", f"/api/v1/docs-sites/{sid}/pages", token, json=body)
        have = pages_of(token, sid)
    pid = have[path]["id"]
    cur = call("GET", f"/api/v1/docs-sites/{sid}/pages/{pid}", token)
    call("PUT", f"/api/v1/docs-sites/{sid}/pages/{pid}", token,
         json={"base_rev": cur["rev"], "markdown": md.strip() + "\n", "title": title, "description": desc})
    call("DELETE", f"/api/v1/docs-sites/{sid}/pages/{pid}/lock", token)
    return pid


def make_live(token, sid, note):
    """A publish, recorded as built and live (what docs_build.finish_build does when a build succeeds)."""
    b = call("POST", f"/api/v1/docs-sites/{sid}/publish", token, json={"note": note})
    bid = ObjectId(b["id"])
    build = db["docs_builds"].find_one({"_id": bid})
    t = datetime.now(timezone.utc)
    db["docs_builds"].update_many({"site_id": build["site_id"], "status": "live"}, {"$set": {"status": "superseded", "superseded_at": t}})
    db["docs_builds"].update_one({"_id": bid}, {"$set": {
        "status": "live", "manifest_hash": "f" * 64, "finished_at": t, "started_at": t - timedelta(seconds=48),
        "stats": {"pages": 9, "files": 120, "bytes": 2400000, "ms": 48000}, "error": None}})
    db["docs_jobs"].update_many({"build_id": bid}, {"$set": {"status": "done", "finished_at": t}})
    db["docs_sites"].update_one({"_id": build["site_id"]}, {"$set": {
        "live_build_id": bid, "last_published_at": t, "last_published_by": build.get("requested_by"), "status": "live", "updated_at": t}})
    snap = db["docs_snapshots"].find_one({"_id": build["snapshot_id"]}, {"pages": 1})
    for p in (snap or {}).get("pages") or []:
        pid = p.get("page_id") or p.get("id")
        q = {"site_id": build["site_id"]}
        if pid and ObjectId.is_valid(str(pid)):
            q["_id"] = ObjectId(str(pid))
        else:
            q["path"] = p.get("path")
        db["docs_pages"].update_one(q, {"$set": {"published": {"markdown": p.get("markdown") or "", "rev": p.get("rev"),
                                                               "published_build_id": bid}}})


PAGES = {"/getting-started/quickstart": 22, "/": 16, "/getting-started/introduction": 14, "/guides/production-setup": 12,
         "/help/faq": 9, "/help/release-notes": 6, "/guides/basics": 5}
REFS = {"google.com": 45, "github.com": 20, "news.ycombinator.com": 8, "bing.com": 7, "linkedin.com": 5}
COUNTRIES = {"US": 38, "IN": 17, "DE": 12, "GB": 10, "BR": 6, "CA": 5, "FR": 4, "NL": 3}
DEVICES = {"desktop": 70, "mobile": 25, "tablet": 5}
SEARCHES = [("postgres", 46, 0), ("api key", 38, 0), ("alerts", 29, 0), ("sso", 14, 14), ("snowflake", 9, 9),
            ("csv export with a very long query that people really typed", 7, 7)]
QUESTIONS = [("How do I connect Postgres?", 9, 0), ("Where do I find my API key?", 7, 0),
             ("Can I share a dashboard with someone outside my workspace, and keep it read-only for them?", 5, 0),
             ("Do you support SSO with Okta?", 0, 2), ("How do I connect Snowflake?", 0, 1)]


def share(total, weights):
    s = sum(weights.values())
    raw = [(k, total * w / s) for k, w in weights.items()]
    out = {k: int(v) for k, v in raw}
    for k, v in sorted(raw, key=lambda kv: kv[1] - int(kv[1]), reverse=True)[: total - sum(out.values())]:
        out[k] += 1
    return [(k, n) for k, n in out.items() if n]


def seed_insights(site):
    today = NOW.strftime("%Y-%m-%d")
    days = [96, 104, 99, 111, 108, 102, 117, 118, 131, 126, 142, 151, 139, 164]
    for i, views in enumerate(days[:-1]):
        day = (NOW - timedelta(days=13 - i)).strftime("%Y-%m-%d")
        queries = [{"k": q, "n": max(1, round(n * (i + 1) / 105)), "z": min(max(1, round(n * (i + 1) / 105)), round(z * (i + 1) / 105))}
                   for q, n, z in SEARCHES]
        db["guide_daily"].replace_one({"_id": f"{site}:{day}"}, {
            "_id": f"{site}:{day}", "site": site, "day": day, "views": views, "visitors": round(views * 0.62),
            "searches": sum(q["n"] for q in queries), "empty_searches": sum(q["z"] for q in queries),
            "pages": [{"k": p, "n": n, "v": round(n * 0.7)} for p, n in share(views, PAGES)],
            "refs": [{"k": r, "n": n} for r, n in share(round(views * 0.55), REFS)],
            "countries": [{"k": c, "n": n} for c, n in share(views, COUNTRIES)],
            "devices": [{"k": d, "n": n} for d, n in share(views, DEVICES)],
            "queries": queries, "rolled_at": NOW, "expires_at": NOW + timedelta(days=400)}, upsert=True)
    n = days[-1]
    paths = [p for p, k in share(n, PAGES) for _ in range(k)]
    devs = [d for d, k in share(n, DEVICES) for _ in range(k)]
    ccs = [c for c, k in share(n, COUNTRIES) for _ in range(k)]
    db["guide_events"].insert_many([{"site": site, "k": "view", "ts": NOW - timedelta(minutes=3 * j), "day": today, "p": paths[j],
                                     "ref": "google.com" if j % 3 == 0 else None, "dev": devs[j], "cc": ccs[j], "v": f"demo{j % 90}"}
                                    for j in range(n)])
    db["guide_events"].insert_many([{"site": site, "k": "search", "ts": NOW - timedelta(minutes=7 * j + 1), "day": today,
                                     "q": q, "n": 0 if z else 4, "p": "/", "v": f"demo{j}"} for j, (q, _, z) in enumerate(SEARCHES)])
    fb = []
    for j in range(24):
        hrs = 4 + j * 13
        p = list(PAGES)[j % len(PAGES)]
        fb.append({"site": site, "ts": NOW - timedelta(hours=hrs), "day": (NOW - timedelta(hours=hrs)).strftime("%Y-%m-%d"), "path": p,
                   "helpful": j % 4 != 0, "comment": None, "source": "page", "resolved": False})
    for hrs, p, ok, text in [(2, "/getting-started/quickstart", False, "Step 2 fails behind our corporate proxy. Is there a proxy flag for acme login? We tried HTTPS_PROXY and it still times out after thirty seconds."),
                             (26, "/guides/production-setup", False, "The configuration table is hard to read on my phone."),
                             (73, "/", True, "Clear and short, thanks.")]:
        fb.append({"site": site, "ts": NOW - timedelta(hours=hrs), "day": (NOW - timedelta(hours=hrs)).strftime("%Y-%m-%d"), "path": p,
                   "helpful": ok, "comment": text, "source": "page", "resolved": False})
    db["guide_feedback"].insert_many(fb)
    order = [(q, "answered") for q, ok, _ in QUESTIONS for _ in range(ok)] + [(q, "no_answer") for q, _, m in QUESTIONS for _ in range(m)]
    db["ai_requests"].insert_many([{"feature": "docs_ask", "request_id": f"mobile-{site}-{j}", "site": site, "ts": NOW - timedelta(hours=2 + j * 9),
                                    "insights": True, "outcome": o, "question": q} for j, (q, o) in enumerate(order)])


def seed_fixes(site):
    rows = []
    ids = ["before-you-start", "install-the-cli", "create-a-project", "share-it"]
    j = 0
    for d, count in zip(range(-1, len(ids) + 1), [14, 12, 131, 11, 9, 97]):
        for _ in range(count):
            t = NOW - timedelta(hours=1 + (j * 7) % 230)
            j += 1
            row = {"site": site, "k": "read", "ts": t, "day": t.strftime("%Y-%m-%d"), "p": "/getting-started/quickstart",
                   "n": len(ids), "d": d, "w": 1, "t": 20 + (j * 13) % 160}
            if 0 <= d < len(ids):
                row["h"] = ids[d]
            rows.append(row)
    for _ in range(9):
        t = NOW - timedelta(hours=3 + j % 100)
        j += 1
        rows.append({"site": site, "k": "broken", "ts": t, "day": t.strftime("%Y-%m-%d"), "p": "/guides/alerts", "f": "/guides/basics"})
    for q, count in [("terraform provider", 11), ("acme terraform", 5)]:
        for _ in range(count):
            t = NOW - timedelta(hours=2 + j % 90)
            j += 1
            rows.append({"site": site, "k": "agent_search", "ts": t, "day": t.strftime("%Y-%m-%d"), "q": q, "n": 0})
    db["guide_events"].insert_many(rows)
    db["ai_requests"].insert_many([{"feature": "docs_ask", "request_id": f"mobile-{site}-fix-{k}", "site": site, "ts": NOW - timedelta(hours=5 + k * 7),
                                    "insights": True, "outcome": "no_answer", "question": "Is there a Terraform provider?", "page_path": "/"}
                                   for k in range(4)])
    got = call("POST", f"/api/v1/docs-sites/{site}/fixes/check", ADA)
    print(f"  fix list: {len(got['items'])} items", flush=True)


def guides():
    for c in [c for c in db.list_collection_names() if c.startswith("docs_") or c.startswith("guide_")]:
        db[c].drop()
    db["ai_requests"].delete_many({"feature": "docs_ask"})
    call("PUT", f"/api/v1/docs-studio/workspaces/{WS}/members/{U['member']['id']}", ADA, json={"role": "editor"})
    site = call("POST", "/api/v1/docs-sites", ADA, json={"workspace_id": WS, "name": "Acme Docs", "slug": "acme-docs",
                                                         "source": {"kind": "template", "template": "product"}})
    sid = site["id"]
    long_id = write_page(ADA, sid, "/guides/production-setup", "Production setup with a long title that wraps on phones",
                         LONG, group="Guides", desc="Configure, install and troubleshoot Acme in production.")
    call("PATCH", f"/api/v1/docs-sites/{sid}", ADA, json={"settings": {"ai": {
        "enabled": True, "name": "Ask Acme", "suggestions": ["How do I connect Postgres?", "Where do I find my API key?"]}}})
    make_live(ADA, sid, "First version")
    have = pages_of(ADA, sid)
    qs = have["/getting-started/quickstart"]["id"]
    cur = call("GET", f"/api/v1/docs-sites/{sid}/pages/{qs}", BEN)
    call("PUT", f"/api/v1/docs-sites/{sid}/pages/{qs}", BEN, json={"base_rev": cur["rev"], "markdown": cur["markdown"] + "\n## Share it\n\nSend the link to your team.\n"})
    call("DELETE", f"/api/v1/docs-sites/{sid}/pages/{qs}/lock", BEN)
    seed_insights(sid)
    seed_fixes(sid)
    help_ = call("POST", "/api/v1/docs-sites", ADA, json={"workspace_id": WS, "name": "Acme Help Center", "slug": "acme-help",
                                                          "source": {"kind": "template", "template": "helpcenter"}})
    api_ = call("POST", "/api/v1/docs-sites", ADA, json={"workspace_id": WS, "name": "API reference", "slug": "acme-api",
                                                         "source": {"kind": "template", "template": "api"}})
    # The create jobs (template imports) never run here: settle them so nothing shows a spinner forever.
    db["docs_jobs"].update_many({"status": {"$in": ["queued", "running"]}}, {"$set": {"status": "done", "finished_at": NOW}})
    return {"site": sid, "help": help_["id"], "api": api_["id"], "page": qs, "long_page": long_id}


# ── Analytics ─────────────────────────────────────────────────────────────────

A_COUNTRIES = [("US", 30), ("IN", 18), ("GB", 10), ("DE", 9), ("CA", 6), ("FR", 5), ("AU", 5), ("SG", 4)]
CHANNELS = [("Direct", None, 34), ("Email", None, 10), ("Social", "https://www.linkedin.com/", 12),
            ("Search", "https://www.google.com/", 14), ("Referral", "https://news.ycombinator.com/", 6),
            ("AI assistants", "https://claude.ai/", 4)]
A_DEVICES = [(("Desktop", "macOS", "Chrome"), 30), (("Desktop", "Windows", "Chrome"), 18), (("Mobile", "iOS", "Safari"), 18),
             (("Mobile", "Android", "Chrome"), 11), (("Tablet", "iOS", "Safari"), 3)]


def pick(options):
    x = RNG.uniform(0, sum(o[-1] for o in options))
    for o in options:
        x -= o[-1]
        if x <= 0:
            return o
    return options[-1]


def when(days=120):
    while True:
        t = NOW - timedelta(days=int(days * (RNG.random() ** 1.8)), hours=RNG.uniform(0, 24))
        if t < NOW - timedelta(minutes=40):
            return t


def visitor():
    ch, ref, _ = pick(CHANNELS)
    device, os_, browser = pick(A_DEVICES)[0]
    return {"ip_hash": f"demo-{RNG.getrandbits(48):012x}", "country": pick(A_COUNTRIES)[0], "channel": ch, "referrer": ref,
            "device": device, "os": os_, "browser": browser}


def view_row(doc, ts, v, ver=None):
    return {"doc_id": str(doc["_id"]), "owner_id": doc.get("owner_id"), "type": "view", "ts": ts, "country": v["country"],
            "region": None, "city": None, "referrer": v["referrer"], "ip_hash": v["ip_hash"], "channel": v["channel"],
            "utm_source": None, "utm_medium": None, "utm_campaign": None, "ver": ver, "internal": False,
            "device": v["device"], "os": v["os"], "browser": v["browser"]}


def session_row(doc, kind, started, v, ver=None, **fields):
    row = {"sid": f"demo{RNG.getrandbits(64):016x}", "doc_id": str(doc["_id"]), "owner_id": doc.get("owner_id"), "kind": kind,
           "ver": ver if kind != "doc" else None, "started_at": started, "updated_at": started + timedelta(seconds=fields.get("active_s", 30) + 5),
           "seq": 4, "ended": True, "ip_hash": v["ip_hash"], "country": v["country"], "region": None, "city": None,
           "device": v["device"], "os": v["os"], "browser": v["browser"], "channel": v["channel"], "ref": v["referrer"],
           "utm_source": None, "utm_medium": None, "utm_campaign": None, "internal": False, "active_s": 30, "depth": 0,
           "reached": [], "sec": {}, "copies": {}, "links": {}, "prints": 0, "pages": {}, "npages": None, "pmax": 0, "rv": {}, "media": None}
    row.update(fields)
    return row


def views(doc, n, ver_split=None):
    pool = [visitor() for _ in range(max(10, int(n * 0.72)))]
    rows = []
    for _ in range(n):
        ts = when()
        rows.append(view_row(doc, ts, RNG.choice(pool), (2 if ts > NOW - timedelta(days=ver_split) else 1) if ver_split else None))
    # A few in the last half hour: the Live board's feed.
    rows += [view_row(doc, NOW - timedelta(minutes=2 + 4 * k), RNG.choice(pool), 2 if ver_split else None) for k in range(4)]
    db["events"].insert_many(rows)
    db["documents"].update_one({"_id": doc["_id"]}, {"$set": {"views": n + 4}})
    return pool


def analytics(video_slug):
    doc = db["documents"].find_one({"slug": "launch-plan"})
    md = "# Launch plan\n\n" + "\n\n".join(f"## {h}\n\nText." for h in ["Goals", "Timeline", "Owners", "Rollout waves", "Risks", "Open questions"])
    db["documents"].update_one({"_id": doc["_id"]}, {"$set": {"content": md}})
    ids = ["goals", "timeline", "owners", "rollout-waves", "risks", "open-questions"]
    pool = views(doc, 900)
    rows = []
    for _ in range(320):
        n = max(1, round(len(ids) * min(1.0, RNG.betavariate(2.0, 1.4) * 1.12)))
        reached = ids[:n]
        sec = {h: round(RNG.uniform(6, 60), 1) for h in reached}
        copies = {"7f3a9c|timeline": 1} if n > 1 and RNG.random() < 0.4 else {}
        rows.append(session_row(doc, "doc", when(), RNG.choice(pool), active_s=int(sum(sec.values()) + 9),
                                depth=RNG.randint(92, 100) if n == len(ids) else int(n / len(ids) * 90), reached=reached, sec=sec,
                                copies=copies, links={"https://example.com/a-very-long-link/that-wraps/on-small-screens?utm=x": 1} if RNG.random() < 0.2 else {}))
    db["engage_sessions"].insert_many(rows)

    pdf = db["documents"].find_one({"slug": "q3-report"})
    v2 = (FIX / "q3-board-deck-v2.pdf").read_bytes()
    u = call("POST", "/api/v1/artifacts/upload-url", ADA, json={"filename": "q3-report.pdf", "content_type": "application/pdf", "size_bytes": len(v2)})
    httpx.put(u["upload_url"], content=v2, headers={"Content-Type": u["required_content_type"]}, timeout=60).raise_for_status()
    call("PUT", "/api/v1/artifacts/q3-report/file", ADA, json={"blob_key": u["blob_key"], "filename": "q3-report.pdf"})
    pdf = db["documents"].find_one({"slug": "q3-report"})
    pool = views(pdf, 600, ver_split=20)
    rows = []
    for _ in range(260):
        last = 1
        for p in range(2, 13):
            if RNG.random() > (0.55 if p == 4 else 0.92):
                break
            last = p
        pages = {str(p): round(RNG.uniform(5, 26), 1) for p in range(1, last + 1)}
        started = when()
        rows.append(session_row(pdf, "pdf", started, RNG.choice(pool), ver=2 if started > NOW - timedelta(days=20) else 1,
                                active_s=int(sum(pages.values())), npages=12, pmax=last, pages=pages, depth=int(last / 12 * 100)))
    db["engage_sessions"].insert_many(rows)

    vid = db["documents"].find_one({"slug": video_slug})
    db["documents"].update_one({"_id": vid["_id"]}, {"$set": {"media": {**(vid.get("media") or {}), "duration_s": 42.0}}})
    pool = views(vid, 500, ver_split=15)
    rows = []
    for i in range(240):
        end = RNG.choice([RNG.uniform(3, 7), 42.0, min(42.0, 7 + RNG.expovariate(1 / 15))])
        segs = [[0.0, round(end, 2)]]
        media = {"dur": 42.0, "segs": segs, "plays": 1, "ended": 1 if end >= 41.5 else 0, "watched_s": round(end, 1),
                 "startup_ms": int(RNG.lognormvariate(6.6, 0.4)), "speed": {"1": round(end, 1)}, "fs_s": 0, "pip_s": 0,
                 "muted_s": 0, "rebuf_n": 0, "rebuf_ms": 0, "err": None if i % 41 else "network", "seeks": 0, "dropped": 0,
                 "frames": int(end * 30)}
        started = when()
        rows.append(session_row(vid, "video", started, RNG.choice(pool), ver=2 if started > NOW - timedelta(days=15) else 1,
                                active_s=int(end + 5), media=media))
    db["engage_sessions"].insert_many(rows)


def upload_video():
    data = (FIX / "product-demo-v1.mp4").read_bytes()
    u = call("POST", "/api/v1/artifacts/upload-url", ADA, json={"filename": "product-demo.mp4", "content_type": "video/mp4", "size_bytes": len(data)})
    httpx.put(u["upload_url"], content=data, headers={"Content-Type": u["required_content_type"]}, timeout=60).raise_for_status()
    call("POST", "/api/v1/artifacts", ADA, json={"blob_key": u["blob_key"], "title": "Product demo", "filename": "product-demo.mp4",
                                                 "custom_slug": "product-demo"})
    v2 = (FIX / "product-demo-v2.mp4").read_bytes()
    u = call("POST", "/api/v1/artifacts/upload-url", ADA, json={"filename": "product-demo.mp4", "content_type": "video/mp4", "size_bytes": len(v2)})
    httpx.put(u["upload_url"], content=v2, headers={"Content-Type": u["required_content_type"]}, timeout=60).raise_for_status()
    call("PUT", "/api/v1/artifacts/product-demo/file", ADA, json={"blob_key": u["blob_key"], "filename": "product-demo.mp4"})
    return "product-demo"


out = guides()
out["video"] = upload_video()
analytics(out["video"])
(OUT / "mobile.json").write_text(json.dumps(out, indent=1))
print(json.dumps(out))
