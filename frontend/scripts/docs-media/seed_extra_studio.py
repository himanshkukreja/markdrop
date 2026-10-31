#!/usr/bin/env python3
"""Markdrop Guides demo world for the docs media (docs.markdrop.in › Markdrop Guides pages).

Run after seed.py, against the same instance (STACK_ID), with the whole stack up (stack.sh starts
the Markdrop Guides worker and the site server too: publishes here are REAL builds by the docs engine,
published into the stack's folder store and served at http://<slug>.guides.markdrop.in:<3405+10N>).

    STACK_ID=13 backend/.venv/bin/python frontend/scripts/docs-media/seed_extra_studio.py
        Resets every Markdrop Guides row, then builds (writes .data/<N>/fixtures_studio.json):
        people    Acme gains Noah Kim (reviewer), Priya Nair (no workspace-wide role; Editor on the
                  Help Center only) and Omar Haddad (no access); Alex Chen is an Editor (Viewer on
                  the Developer Docs), Sam Lee a Viewer; Riya (owner) and Maya (admin) are admins
        sites     Acme (acme): product docs from the template, Clean + Acme's brand, Ask AI on, 4 publishes
                  over two weeks, then Alex's unpublished edits (2 changed pages + 1 new page) and
                  a hidden page; Acme Help Center (acme-help): Help center theme, reviews required,
                  Priya's open review; Acme Developers (acme-developers): a synthetic GitBook
                  import (https://acme.gitbook.io/developers) with its "needs a look" report, not
                  published yet
        times     every row is backdated so the history reads naturally ("published 5 h ago")
                  Acme's publishes #2 to #4 each change pages (the publish history and What changed
                  have something to show); Acme Developers has the Acme API's OpenAPI file
                  (acme-openapi.yaml, Settings › API reference)
        insights  two weeks of daily readers (pages, sites, countries, devices, searches), page
                  feedback with comments, and Ask AI questions for each live Acme guide (INSIGHTS_WORLD)

    seed_extra_studio.py --guide-domain SITE HOST live|pending|remove
        A guide's own domain in that state, written directly (the stack never runs the domain job).

    seed_extra_studio.py --import-run [--slow]
        Plays the import worker for the newest queued GitBook import (the stack's worker never
        takes imports, so nothing is ever fetched from the internet): the job's progress steps,
        then the synthetic pages, nav, brand, redirects and report through the API's own
        services/docs_import_job.apply_import. --slow paces the steps for a video.

    seed_extra_studio.py --drop-sites WORKSPACE_NAME
        Delete (for real) every docs site of that workspace (after a shot created one).

Local only: the sandbox API (127.0.0.1) and the local demo Mongo db (markdrop_docs_demo*).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from bson import ObjectId

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import seed as S  # noqa: E402  (its guards: local Mongo db + local API only)
import studio_content as C  # noqa: E402

db, call, DATA = S.db, S.call, S.DATA
STORE = DATA / "docs-store"
DOCS = ("docs_sites", "docs_pages", "docs_page_versions", "docs_builds", "docs_snapshots", "docs_reviews",
        "docs_jobs", "docs_assets", "docs_events", "docs_studio_members", "docs_site_members", "docs_migrations",
        "docs_api_specs")
DEMO_WORKER = "docs-media-demo"


def fixtures() -> dict:
    return json.loads((DATA / "fixtures.json").read_text())


def tok(fx: dict, who: str) -> str:
    return call("POST", "/__sandbox/mint", json={"email": fx["users"][who]["email"]})["token"]


# ── Backend services (for the import worker): the sandbox's settings, never backend/.env ───────

def backend():
    """motor db + the API's services, configured like stack/run_docs_worker.py."""
    stack = HERE / "stack"
    os.chdir(stack)
    for key in [k for k in os.environ if k.startswith("MARKDROP_")]:
        del os.environ[key]
    env = stack / ".env" if (stack / ".env").exists() else stack / ".env.example"
    for line in env.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ[k.strip()] = v.strip().strip("'\"")
    os.environ["MARKDROP_MONGODB_DB"] = S.DB_NAME
    os.environ["MARKDROP_DOCS_STORE_DIR"] = str(STORE)
    sys.path.insert(0, str(HERE.parents[2] / "backend"))
    from motor.motor_asyncio import AsyncIOMotorClient

    from app.config import get_settings
    from app.services import docs_import_job, docs_jobs

    s = get_settings()
    if not s.mongodb_db.startswith("markdrop_docs_demo") or "127.0.0.1" not in s.mongodb_uri:
        sys.exit("seed_extra_studio.py: refusing a non-local database")
    return AsyncIOMotorClient(s.mongodb_uri, tz_aware=True)[s.mongodb_db], docs_import_job, docs_jobs


# ── Helpers ─────────────────────────────────────────────────────────────────────


class Clock:
    """Phases of the story: rows written during a phase are backdated to `age` before demo now."""

    def __init__(self):
        self.marks: list[tuple[datetime, timedelta]] = []

    def phase(self, age: timedelta) -> None:
        self.marks.append((datetime.now(timezone.utc), age))
        time.sleep(0.02)

    def apply(self, now: datetime) -> int:
        marks = sorted(self.marks)

        def move(v):
            if isinstance(v, datetime):
                at = v if v.tzinfo else v.replace(tzinfo=timezone.utc)
                hit = None
                for t, age in marks:
                    if at >= t:
                        hit = (t, age)
                if hit is None:
                    return v
                return now - hit[1] + (at - hit[0])
            if isinstance(v, dict):
                return {k: move(x) for k, x in v.items()}
            if isinstance(v, list):
                return [move(x) for x in v]
            return v

        n = 0
        for name in DOCS:
            for row in db[name].find({}):
                new = {k: move(v) for k, v in row.items() if k != "_id"}
                if new != {k: v for k, v in row.items() if k != "_id"}:
                    db[name].replace_one({"_id": row["_id"]}, {"_id": row["_id"], **new})
                    n += 1
        return n


def pages_of(token: str, sid: str) -> dict[str, dict]:
    return {p["path"]: p for p in call("GET", f"/api/v1/docs-sites/{sid}/pages", token)["pages"]}


def write_page(token: str, sid: str, path: str, title: str, desc: str, icon: str | None, md: str,
               hidden: bool = False, group: str | None = None) -> dict:
    have = pages_of(token, sid)
    if path not in have:
        body = {"path": path, "title": title}
        if group:
            body["group"] = group
        call("POST", f"/api/v1/docs-sites/{sid}/pages", token, json=body)
        have = pages_of(token, sid)
    pid = have[path]["id"]
    cur = call("GET", f"/api/v1/docs-sites/{sid}/pages/{pid}", token)
    page = call("PUT", f"/api/v1/docs-sites/{sid}/pages/{pid}", token, json={
        "base_rev": cur["rev"], "markdown": C.unwrap(md.strip()) + "\n", "title": title, "description": desc,
        "icon": icon, "hidden": hidden})
    # A save holds the page's lock for 2 minutes; let go, as closing the editor does.
    call("DELETE", f"/api/v1/docs-sites/{sid}/pages/{pid}/lock", token)
    return page


def set_nav(token: str, sid: str, groups: list[tuple[str, list[str]]]) -> None:
    have = pages_of(token, sid)
    nav = [{"group": g, "pages": [have[p]["id"] for p in paths if p in have]} for g, paths in groups]
    call("PUT", f"/api/v1/docs-sites/{sid}/nav", token, json={"nav": nav})


def publish(token: str, sid: str, note: str) -> dict:
    b = call("POST", f"/api/v1/docs-sites/{sid}/publish", token, json={"note": note})
    return wait_build(token, sid, b["id"])


def wait_build(token: str, sid: str, bid: str, timeout: float = 600) -> dict:
    end = time.time() + timeout
    while time.time() < end:
        for b in call("GET", f"/api/v1/docs-sites/{sid}/builds", token):
            if b["id"] == bid and b["status"] in ("live", "failed", "superseded"):
                if b["status"] != "live":
                    sys.exit(f"build {bid} {b['status']}: {b.get('error')}")
                print(f"    · publish #{b['number']} live in {b['stats']['ms'] / 1000:.0f}s ({b['note']})", flush=True)
                return b
        time.sleep(2)
    sys.exit(f"build {bid} did not finish in {timeout}s (is the Markdrop Guides worker running? stack.sh logs docsworker)")


def upload(token: str, sid: str, file: Path, name: str, mime: str) -> str:
    return call("POST", f"/api/v1/docs-sites/{sid}/assets", token,
                files={"file": (name, file.read_bytes(), mime)})["url"]


INSIGHTS = ("guide_events", "guide_daily", "guide_feedback")


def reset() -> None:
    for name in DOCS + INSIGHTS:
        db[name].delete_many({})
    db["ai_requests"].delete_many({"feature": "docs_ask", "request_id": {"$regex": "^demo-insights-"}})
    for sub in ("sites", "hosts"):
        shutil.rmtree(STORE / sub, ignore_errors=True)


def add_member(ws_id: str, user: dict, role: str, age: timedelta, now: datetime) -> None:
    db["memberships"].update_one({"workspace_id": ws_id, "user_id": user["id"]}, {"$set": {
        "role": role, "created_at": now - age, "email": user["email"], "name": user["name"]}}, upsert=True)


# What each live guide's readers do (Insights): the share of views per page, where they come from,
# what they search for (count, how many found nothing), what they ask Ask AI, and their feedback.
INSIGHTS_WORLD = {
    "acme": {
        "pages": {"/getting-started/quickstart": 22, "/": 16, "/guides/connect-postgres": 14, "/reference/api-keys": 10,
                  "/guides/alert-rules": 9, "/getting-started/introduction": 7, "/reference/cli": 7,
                  "/guides/build-a-dashboard": 6, "/help/faq": 5, "/guides/invite-your-team": 2, "/help/release-notes": 2},
        "refs": {"google.com": 45, "github.com": 20, "news.ycombinator.com": 8, "bing.com": 7, "linkedin.com": 5,
                 "duckduckgo.com": 3},
        "searches": [("postgres", 46, 0), ("api key", 38, 0), ("alerts", 29, 0), ("invite", 21, 0), ("slack", 17, 0),
                     ("sso", 14, 14), ("webhook", 12, 0), ("snowflake", 9, 9), ("mute alert", 8, 0),
                     ("csv export", 7, 7), ("rate limit", 6, 6)],
        "questions": [("How do I connect Postgres?", 9, 0), ("Where do I find my API key?", 7, 0),
                      ("How do alert rules work?", 6, 0), ("Can I share a dashboard with someone outside my workspace?", 5, 0),
                      ("How do I mute an alert over the weekend?", 4, 0), ("What does \"for 2 checks\" mean?", 3, 0),
                      ("How do I invite my team?", 3, 0), ("Do you support SSO with Okta?", 0, 2),
                      ("Can I export a dashboard to CSV?", 0, 1), ("How do I connect Snowflake?", 0, 1)],
        # path: (yes, no)
        "votes": {"/getting-started/quickstart": (6, 4), "/guides/connect-postgres": (9, 2), "/": (8, 0),
                  "/reference/api-keys": (7, 1), "/guides/alert-rules": (6, 0), "/reference/cli": (5, 1),
                  "/guides/build-a-dashboard": (4, 0), "/help/faq": (3, 0)},
        # (hours ago, path, helpful, comment, source, resolved)
        "comments": [
            (2, "/getting-started/quickstart", False, "Step 2 fails behind our corporate proxy. Is there a proxy flag for acme login?", "page", False),
            (5, "/guides/connect-postgres", False, "Which IP addresses do we allow? The warning says fixed addresses but doesn't list them.", "page", False),
            (26, "/reference/api-keys", False, "How do I rotate a key without breaking our CI jobs?", "page", False),
            (49, "/reference/cli", False, "The example for adding a source uses a project flag that the CLI reference doesn't list.", "mcp", False),
            (73, "/guides/alert-rules", True, "The \"for 2 checks\" note saved us a lot of 3am pages.", "page", False),
            (98, "/getting-started/quickstart", False, "It took us closer to half an hour than ten minutes.", "page", True),
            (130, "/guides/connect-postgres", False, "Does this work with a read replica?", "page", True),
        ],
    },
    "help": {
        "pages": {"/": 24, "/billing/refunds": 19, "/troubleshooting/cant-sign-in": 17, "/account/two-factor": 12,
                  "/billing/change-plan": 10, "/billing/invoices": 9, "/account/change-email": 6,
                  "/troubleshooting/dashboard-not-loading": 3},
        "refs": {"google.com": 52, "acme.com": 30, "bing.com": 6},
        "searches": [("refund", 31, 0), ("invoice", 24, 0), ("password", 19, 0), ("2fa", 12, 0), ("cancel", 9, 9),
                     ("vat", 5, 5)],
        "questions": [("How do I get a refund?", 6, 0), ("I can't sign in", 4, 0), ("How do I cancel my plan?", 0, 2),
                      ("Can I change my invoice address?", 2, 0)],
        "votes": {"/billing/refunds": (5, 2), "/troubleshooting/cant-sign-in": (6, 1), "/": (4, 0), "/account/two-factor": (3, 0)},
        "comments": [
            (7, "/billing/refunds", False, "Doesn't say how long a card refund takes to show up.", "page", False),
            (52, "/troubleshooting/cant-sign-in", False, "My code from the app is always rejected.", "page", False),
        ],
    },
}
COUNTRIES = {"US": 38, "IN": 17, "DE": 12, "GB": 10, "BR": 6, "CA": 5, "FR": 4, "NL": 3, "AU": 3, "JP": 2}
DEVICES = {"desktop": 78, "mobile": 19, "tablet": 3}


def _share(total: int, weights: dict[str, int]) -> list[tuple[str, int]]:
    """``total`` split by ``weights`` into whole numbers that add up to it (largest remainders)."""
    s = sum(weights.values())
    raw = [(k, total * w / s) for k, w in weights.items()]
    out = {k: int(v) for k, v in raw}
    for k, v in sorted(raw, key=lambda kv: kv[1] - int(kv[1]), reverse=True)[: total - sum(out.values())]:
        out[k] += 1
    return [(k, n) for k, n in out.items() if n]


def seed_insights(site: str, world: str, scale: float = 1.0) -> None:
    """Two weeks of a live guide's readers (stored daily rollups up to yesterday, today's raw events):
    pages, where readers come from, searches, page feedback and Ask AI questions asked while Insights
    was on. Deterministic, dated from the API's own clock (the Guides home reads the last 7 UTC days)."""
    w = INSIGHTS_WORLD[world]
    real = datetime.now(timezone.utc)
    today = real.strftime("%Y-%m-%d")
    week = [118, 131, 126, 142, 151, 139, 164]   # oldest → today
    before = [96, 104, 99, 111, 108, 102, 117]
    days = before + week
    for i, views in enumerate(days[:-1]):
        day = (real - timedelta(days=13 - i)).strftime("%Y-%m-%d")
        v = round(views * scale)
        visitors = round(v * 0.62)
        queries = []
        for q, n, z in w["searches"]:
            share = round(n * (i + 1) / 105)  # growing day by day; 1 + … + 14 = 105
            if share:
                queries.append({"k": q, "n": share, "z": min(share, round(z * share / n)) if n else 0})
        db["guide_daily"].replace_one({"_id": f"{site}:{day}"}, {
            "_id": f"{site}:{day}", "site": site, "day": day, "views": v, "visitors": visitors,
            "searches": sum(q["n"] for q in queries), "empty_searches": sum(q["z"] for q in queries),
            "pages": [{"k": p, "n": n, "v": round(n * 0.7)} for p, n in _share(v, w["pages"])],
            "refs": [{"k": r, "n": n} for r, n in _share(round(v * 0.55), w["refs"])],
            "countries": [{"k": c, "n": n} for c, n in _share(v, COUNTRIES)],
            "devices": [{"k": d, "n": n} for d, n in _share(v, DEVICES)],
            "queries": queries, "rolled_at": real, "expires_at": real + timedelta(days=400)}, upsert=True)
    # Today: raw page views (a reader is a visitor code) and a few searches.
    n = round(week[-1] * scale)
    paths = [p for p, k in _share(n, w["pages"]) for _ in range(k)]
    refs = [r for r, k in _share(round(n * 0.55), w["refs"]) for _ in range(k)]
    ccs = [c for c, k in _share(n, COUNTRIES) for _ in range(k)]
    devs = [d for d, k in _share(n, DEVICES) for _ in range(k)]
    db["guide_events"].insert_many([{"site": site, "k": "view", "ts": real - timedelta(minutes=3 * j), "day": today,
                                     "p": paths[j], "ref": refs[j] if j < len(refs) else None, "dev": devs[j], "cc": ccs[j],
                                     "v": f"demo{j % round(n * 0.62)}"} for j in range(n)])
    db["guide_events"].insert_many([{"site": site, "k": "search", "ts": real - timedelta(minutes=7 * j + 1), "day": today,
                                     "q": q, "n": 0 if z else 4, "p": "/", "v": f"demo{j}"}
                                    for j, (q, _, z) in enumerate(w["searches"][:4])])
    # Feedback: votes on pages, then the comments (newest first), some already resolved.
    # Votes without a comment, interleaved page by page and spread evenly over the two weeks.
    queues = []
    for path, (yes, no) in w["votes"].items():
        no -= sum(1 for c in w["comments"] if c[1] == path and not c[2])
        q = [True] * yes
        for k in range(max(0, no)):  # the "no" votes among the yes ones, not all at one end
            q.insert(min(len(q), (k + 1) * (len(q) // (no + 1) + 1)), False)
        queues.append((path, q))
    votes = []
    while any(q for _, q in queues):
        for path, q in queues:
            if q:
                votes.append((path, q.pop(0)))
    gap = 320 / max(1, len(votes))
    rows = [{"path": p, "helpful": ok, "hours": 4 + i * gap} for i, (p, ok) in enumerate(votes)]
    fb = [{"site": site, "ts": real - timedelta(hours=r["hours"]), "day": (real - timedelta(hours=r["hours"])).strftime("%Y-%m-%d"),
           "path": r["path"], "helpful": r["helpful"], "comment": None, "source": "page", "resolved": False} for r in rows]
    fb += [{"site": site, "ts": real - timedelta(hours=hrs), "day": (real - timedelta(hours=hrs)).strftime("%Y-%m-%d"),
            "path": path, "helpful": ok, "comment": text, "source": src, "resolved": res}
           for hrs, path, ok, text, src, res in w["comments"]]
    db["guide_feedback"].insert_many(fb)
    # Ask AI questions, round-robin over the questions and spread over the two weeks (so the ones it
    # couldn't answer show up in any period too).
    queues = [[(q, "answered")] * ok + [(q, "no_answer")] * miss for q, ok, miss in w["questions"]]
    order = []
    while any(queues):
        for q in queues:
            if q:
                order.append(q.pop(0))
    gap = 320 / max(1, len(order))
    db["ai_requests"].insert_many([{"feature": "docs_ask", "request_id": f"demo-insights-{site}-{j}", "site": site,
                                    "ts": real - timedelta(hours=2 + j * gap), "insights": True, "outcome": outcome,
                                    "question": q} for j, (q, outcome) in enumerate(order)])


# ── The world ───────────────────────────────────────────────────────────────────


def seed() -> dict:
    fx = fixtures()
    now = datetime.fromisoformat(fx["demo_now"])
    ws = fx["workspace"]["id"]
    reset()
    clock = Clock()

    # People: three more Acme members (workspace "member" role); the Markdrop Guides roles come next.
    for key, email, name in (("noah", "noah@acme.com", "Noah Kim"), ("priya", "priya@acme.com", "Priya Nair"),
                             ("omar", "omar@acme.com", "Omar Haddad")):
        u = call("POST", "/__sandbox/user", json={"email": email, "name": name})
        fx["users"][key] = {"id": u["id"], "email": email, "name": name}
        add_member(ws, fx["users"][key], "member", timedelta(days=40), now)
    db["users"].update_many({"email": {"$in": ["noah@acme.com", "priya@acme.com", "omar@acme.com"]}},
                            {"$set": {"created_at": now - timedelta(days=60)}})
    (DATA / "fixtures.json").write_text(json.dumps(fx, indent=2))
    T = {k: tok(fx, k) for k in ("riya", "maya", "alex", "noah", "priya", "sam", "jordan")}
    U = {k: fx["users"][k]["id"] for k in fx["users"]}
    studio = f"/api/v1/docs-studio/workspaces/{ws}/members"

    clock.phase(timedelta(days=21))
    for who, role, by in (("alex", "editor", "riya"), ("sam", "viewer", "riya"), ("noah", "reviewer", "maya")):
        call("PUT", f"{studio}/{U[who]}", T[by], json={"role": role})

    # ── Acme (product docs) ──
    print("· Acme (product docs)", flush=True)
    clock.phase(timedelta(days=14))
    acme = call("POST", "/api/v1/docs-sites", T["riya"], json={
        "workspace_id": ws, "name": "Acme", "slug": "acme", "source": {"kind": "template", "template": "product"}})
    sid = acme["id"]
    have = pages_of(T["riya"], sid)
    # The first version of four pages was shorter: publishes #2 to #4 add to them, so the publish
    # history shows what each one changed (and What changed has lines to compare).
    early = {
        "/guides/connect-postgres": lambda md: md.split("## Check the connection")[0],
        "/guides/alert-rules": lambda md: md.split("## Mute a rule")[0],
        "/getting-started/quickstart": lambda md: md.split("## Share it")[0],
        "/help/release-notes": lambda md: md[md.index("## 2.3"):],
    }
    for path, (title, desc, icon, md) in C.ACME_DOCS_PAGES.items():
        md = early[path](md) if path in early else md
        write_page(T["riya"], sid, path, title, desc, icon, md, hidden=path in C.ACME_DOCS_HIDDEN)
    if "/guides/basics" in have:
        call("DELETE", f"/api/v1/docs-sites/{sid}/pages/{have['/guides/basics']['id']}", T["riya"])
    set_nav(T["riya"], sid, C.ACME_DOCS_NAV)
    logo = upload(T["riya"], sid, S.FIX / "acme-favicon.png", "acme-logo.png", "image/png")
    call("PATCH", f"/api/v1/docs-sites/{sid}", T["riya"], json={"settings": {
        "theme": {"preset": "clean", "brand": {"enabled": True, "logo_url": logo,
                                               "colors": ["#0f766e", "#13203a", "#f59e0b"], "accent": "#0f766e"}},
        "ai": {"enabled": True, "name": "Ask Acme",
               "suggestions": ["How do I connect Postgres?", "How do alert rules work?", "Where do I find my API key?"]},
    }})
    clock.phase(timedelta(days=12))
    publish(T["riya"], sid, "First version")

    clock.phase(timedelta(days=6, hours=3))
    for path in ("/guides/connect-postgres", "/guides/alert-rules"):
        t, d, i, md = C.ACME_DOCS_PAGES[path]
        write_page(T["alex"], sid, path, t, d, i, md)
    publish(T["alex"], sid, "Postgres guide and alert rules")

    clock.phase(timedelta(days=2, hours=1))
    t, d, i, md = C.ACME_DOCS_PAGES["/getting-started/quickstart"]
    write_page(T["maya"], sid, "/getting-started/quickstart", t, d, i, md)
    publish(T["maya"], sid, "Quickstart for the new onboarding")

    clock.phase(timedelta(hours=5))
    t, d, i, md = C.ACME_DOCS_PAGES["/help/release-notes"]
    write_page(T["riya"], sid, "/help/release-notes", t, d, i, md)
    publish(T["riya"], sid, "Release notes for 2.4")

    # Alex's work in progress: two edited pages and a new one (Publish shows 3 changes).
    clock.phase(timedelta(minutes=48))
    t, d, i, _ = C.ACME_DOCS_PAGES["/guides/alert-rules"]
    write_page(T["alex"], sid, "/guides/alert-rules", t, d, i, C.ALERT_RULES_V2)
    clock.phase(timedelta(minutes=22))
    t, d, i, _ = C.ACME_DOCS_PAGES["/getting-started/quickstart"]
    write_page(T["alex"], sid, "/getting-started/quickstart", t, d, i, C.QUICKSTART_V2)
    clock.phase(timedelta(minutes=9))
    write_page(T["alex"], sid, "/guides/workflows", "Workflows", "Run a Slack message, a webhook or an email when an alert fires.",
               "zap", C.WORKFLOWS, group="Guides")

    # ── Acme Help Center ──
    print("· Acme Help Center", flush=True)
    clock.phase(timedelta(days=9))
    hc = call("POST", "/api/v1/docs-sites", T["riya"], json={
        "workspace_id": ws, "name": "Acme Help Center", "slug": "acme-help", "source": {"kind": "template", "template": "helpcenter"}})
    hid = hc["id"]
    have = pages_of(T["riya"], hid)
    for path, (title, desc, icon, md) in C.HELP_PAGES.items():
        write_page(T["riya"], hid, path, title, desc, icon, md)
    if "/account/invoices" in have:
        call("DELETE", f"/api/v1/docs-sites/{hid}/pages/{have['/account/invoices']['id']}", T["riya"])
    set_nav(T["riya"], hid, C.HELP_NAV)
    call("PATCH", f"/api/v1/docs-sites/{hid}", T["riya"], json={"settings": {
        "ai": {"enabled": True, "suggestions": ["How do I get a refund?", "I can't sign in"]}}})
    clock.phase(timedelta(days=8, hours=20))
    publish(T["riya"], hid, "Help center launch")
    clock.phase(timedelta(days=8))
    call("PATCH", f"/api/v1/docs-sites/{hid}", T["riya"], json={"settings": {"review": {"required": True}}})
    clock.phase(timedelta(days=3))
    call("PUT", f"/api/v1/docs-sites/{hid}/members/{U['priya']}", T["maya"], json={"role": "editor"})
    clock.phase(timedelta(hours=2))
    for path, md in (("/billing/refunds", C.REFUNDS_V2), ("/account/two-factor", C.TWO_FACTOR_V2)):
        t, d, i, _ = C.HELP_PAGES[path]
        write_page(T["priya"], hid, path, t, d, i, md)
    clock.phase(timedelta(minutes=35))
    review = call("POST", f"/api/v1/docs-sites/{hid}/reviews", T["priya"],
                  json={"note": "Annual plans: the refund window is now 90 days (was 60), per Finance. Also added what to do if you lose your phone."})

    # ── Acme Developers: a GitBook import, not published yet ──
    print("· Acme Developers (synthetic GitBook import)", flush=True)
    clock.phase(timedelta(days=1, hours=4))
    dev = call("POST", "/api/v1/docs-sites", T["riya"], json={
        "workspace_id": ws, "name": "Acme Developers", "slug": "acme-developers",
        "source": {"kind": "gitbook", "url": "https://acme.gitbook.io/developers"}})
    did = dev["id"]
    asyncio.run(play_import(did, "Acme", slow=False))
    clock.phase(timedelta(days=1))
    call("PATCH", f"/api/v1/docs-sites/{did}", T["riya"], json={"settings": {"theme": {"preset": "technical"}}})
    call("PUT", f"/api/v1/docs-sites/{did}/members/{U['alex']}", T["riya"], json={"role": "viewer"})
    # Its API reference: the Acme API's OpenAPI file (Settings › API reference).
    clock.phase(timedelta(hours=20))
    call("POST", f"/api/v1/docs-sites/{did}/api-reference/upload", T["riya"],
         files={"file": ("acme-openapi.yaml", (HERE / "acme-openapi.yaml").read_bytes(), "application/yaml")})

    # ── Theme previews: a personal copy of Acme's docs (Jordan's, so it isn't on Riya's home),
    #    without the brand, so each preset shows as it comes. The Themes shots switch its preset
    #    and publish it (shots/d-guides.mjs).
    print("· acme-themes (theme previews)", flush=True)
    clock.phase(timedelta(days=1))
    th = call("POST", "/api/v1/docs-sites", T["jordan"], json={
        "workspace_id": None, "name": "Acme", "slug": "acme-themes", "source": {"kind": "template", "template": "product"}})
    tid = th["id"]
    have = pages_of(T["jordan"], tid)
    for path, (title, desc, icon, md) in C.ACME_DOCS_PAGES.items():
        write_page(T["jordan"], tid, path, title, desc, icon, md, hidden=path in C.ACME_DOCS_HIDDEN)
    if "/guides/basics" in have:
        call("DELETE", f"/api/v1/docs-sites/{tid}/pages/{have['/guides/basics']['id']}", T["jordan"])
    set_nav(T["jordan"], tid, C.ACME_DOCS_NAV)
    call("PATCH", f"/api/v1/docs-sites/{tid}", T["jordan"], json={"settings": {
        "ai": {"enabled": True, "suggestions": ["How do I connect Postgres?", "How do alert rules work?"]}}})
    publish(T["jordan"], tid, "Theme preview")

    moved = clock.apply(now)
    for i, live in enumerate(r for r in db["docs_sites"].find({"workspace_id": ws, "status": "live"}).sort("created_at", 1)):
        seed_insights(str(live["_id"]), "acme" if i == 0 else "help", scale=1.0 if i == 0 else 0.35)
    out = {"acme": sid, "help": hid, "developers": did, "themes": tid, "review": review["id"], "workspace": ws,
           "slugs": {"acme": "acme", "help": "acme-help", "developers": "acme-developers", "themes": "acme-themes"}}
    (DATA / "fixtures_studio.json").write_text(json.dumps(out, indent=2))
    print(f"seeded Markdrop Guides: 3 sites, {moved} rows backdated → {DATA / 'fixtures_studio.json'}")
    return out


# ── The import worker (synthetic) ─────────────────────────────────────────────


def _import_assets(site_id: str) -> list[dict]:
    """The files the synthetic pages refer to, in the store where a real import puts them; the
    runner's asset list for them (apply_import makes the rows the editor's previews read)."""
    import hashlib

    root = STORE / "sites" / site_id / "assets"
    items = []
    for rel, src in (("import/getting-started/authentication/api-keys.png", "acme-architecture.png"),
                     ("import/api/metrics/ingest/pipeline.png", "acme-architecture.png"),
                     ("import/webhooks/overview/delivery-log.png", "team-photo.png")):
        data = (S.FIX / src).read_bytes()
        f = root / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(data)
        items.append({"rel": rel, "sha256": hashlib.sha256(data + rel.encode()).hexdigest(), "size": len(data),
                      "content_type": "image/png"})
    return items


async def play_import(site_id: str | None, brand: str, slow: bool) -> None:
    mdb, imp, jobs = backend()
    q = {"kind": "import", "status": "queued"}
    if site_id:
        q["site_id"] = ObjectId(site_id)
    job = await mdb["docs_jobs"].find_one(q, sort=[("created_at", -1)])
    if job is None:
        sys.exit("no queued import job")
    if not site_id:
        site = await mdb["docs_sites"].find_one({"_id": job["site_id"]})
        brand = (site or {}).get("name", brand).split()[0]
    t = datetime.now(timezone.utc)
    await mdb["docs_jobs"].update_one({"_id": job["_id"]}, {"$set": {
        "status": "running", "locked_by": DEMO_WORKER, "locked_until": t + timedelta(minutes=10),
        "started_at": t, "updated_at": t, "attempts": 1, "target": "local"}})
    pace = (lambda s: asyncio.sleep(s)) if slow else (lambda s: asyncio.sleep(0))
    data = C.dev_import(brand)
    n = len(data["pages"])
    await pace(1.2)
    for step, total, msg in (("fetch", 0, "Reading llms.txt"), ("convert", n, "Converting pages"),
                             ("upload", 10, "Copying files")):
        for done in ([0] if not total else range(0, total + 1, max(1, total // 4))):
            await jobs.set_progress(mdb, job["_id"], DEMO_WORKER, {"step": step, "done": done, "total": total,
                                                                    "message": f"{done} of {total}" if total else msg})
            await pace(1.0 if slow else 0)
        await pace(0.6)
    data["assets"]["items"] = _import_assets(str(job["site_id"]))
    job = await mdb["docs_jobs"].find_one({"_id": job["_id"]})
    await imp.apply_import(mdb, job, DEMO_WORKER, data)
    print(f"import played for site {job['site_id']} ({n} pages)", flush=True)


def drop_sites(name: str) -> None:
    for w in db["workspaces"].find({"name": name}):
        ids = [s["_id"] for s in db["docs_sites"].find({"workspace_id": str(w["_id"])})]
        for coll in ("docs_pages", "docs_page_versions", "docs_builds", "docs_snapshots", "docs_reviews", "docs_jobs",
                     "docs_assets", "docs_site_members"):
            db[coll].delete_many({"site_id": {"$in": ids}})
        db["docs_sites"].delete_many({"_id": {"$in": ids}})
        for i in ids:
            shutil.rmtree(STORE / "sites" / str(i), ignore_errors=True)
        print(f"dropped {len(ids)} docs sites of {name}")


def guide_domain(key: str, host: str, state: str) -> None:
    """Put a guide's own domain in a state directly (the stack never runs the domain job): ``live``,
    ``pending`` (added, the CNAME not seen yet) or ``remove``. Also drops the site's queued domain jobs."""
    fs = json.loads((DATA / "fixtures_studio.json").read_text())
    sid = ObjectId(fs[key])
    db["docs_sites"].update_one({"_id": sid}, {"$pull": {"domains": {"host": host}}})
    db["docs_jobs"].delete_many({"site_id": sid, "kind": "domain"})
    if state == "remove":
        print(f"{host} removed from {key}")
        return
    t = datetime.now(timezone.utc)
    riya = fixtures()["users"]["riya"]["id"]
    token = ObjectId().binary.hex()
    records = [{"type": "CNAME", "name": host, "value": "cname.guides.markdrop.in", "purpose": "route", "optional": False},
               {"type": "TXT", "name": f"_cf-custom-hostname.{host}", "value": f"{token[:8]}-{token[8:12]}-4{token[13:16]}-a{token[17:20]}-{token[:12]}",
                "purpose": "ownership", "optional": True},
               {"type": "TXT", "name": f"_acme-challenge.{host}", "value": f"Q{token}xT2v", "purpose": "certificate", "optional": True}]
    if state == "live":
        entry = {"host": host, "status": "live", "stage": None, "message": None, "records": records[:1], "cf_id": token[:32],
                 "added_at": t - timedelta(days=6), "added_by": riya, "pending_since": t - timedelta(days=6), "checks": 3,
                 "checked_at": t - timedelta(hours=2), "next_check_at": None, "live_at": t - timedelta(days=6, minutes=-14)}
    else:
        entry = {"host": host, "status": "pending", "stage": "dns", "message": None, "records": records, "cf_id": token[:32],
                 "added_at": t - timedelta(minutes=4), "added_by": riya, "pending_since": t - timedelta(minutes=4), "checks": 2,
                 "checked_at": t - timedelta(minutes=1), "next_check_at": t + timedelta(minutes=1), "live_at": None}
    db["docs_sites"].update_one({"_id": sid}, {"$push": {"domains": entry}})
    print(f"{host} on {key}: {state}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--import-run", action="store_true")
    ap.add_argument("--slow", action="store_true")
    ap.add_argument("--drop-sites", metavar="WORKSPACE")
    ap.add_argument("--guide-domain", nargs=3, metavar=("SITE", "HOST", "STATE"),
                    help="SITE: a key of fixtures_studio.json (acme, help…); STATE: live, pending or remove")
    a = ap.parse_args()
    if a.import_run:
        asyncio.run(play_import(None, "Acme", slow=a.slow))
    elif a.drop_sites:
        drop_sites(a.drop_sites)
    elif a.guide_domain:
        guide_domain(*a.guide_domain)
    else:
        seed()
