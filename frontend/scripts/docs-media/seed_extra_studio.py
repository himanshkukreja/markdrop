#!/usr/bin/env python3
"""Docs Studio demo world for the docs media (docs.markdrop.in › Docs Studio pages).

Run after seed.py, against the same instance (STACK_ID), with the whole stack up (stack.sh starts
the Docs Studio worker and the site server too: publishes here are REAL builds by the docs engine,
published into the stack's folder store and served at http://<slug>.docs.markdrop.in:<3405+10N>).

    STACK_ID=13 backend/.venv/bin/python frontend/scripts/docs-media/seed_extra_studio.py
        Resets every Docs Studio row, then builds (writes .data/<N>/fixtures_studio.json):
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
        "docs_jobs", "docs_assets", "docs_events", "docs_studio_members", "docs_site_members", "docs_migrations")
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
    sys.exit(f"build {bid} did not finish in {timeout}s (is the Docs Studio worker running? stack.sh logs docsworker)")


def upload(token: str, sid: str, file: Path, name: str, mime: str) -> str:
    return call("POST", f"/api/v1/docs-sites/{sid}/assets", token,
                files={"file": (name, file.read_bytes(), mime)})["url"]


def reset() -> None:
    for name in DOCS:
        db[name].delete_many({})
    for sub in ("sites", "hosts"):
        shutil.rmtree(STORE / sub, ignore_errors=True)


def add_member(ws_id: str, user: dict, role: str, age: timedelta, now: datetime) -> None:
    db["memberships"].update_one({"workspace_id": ws_id, "user_id": user["id"]}, {"$set": {
        "role": role, "created_at": now - age, "email": user["email"], "name": user["name"]}}, upsert=True)


# ── The world ───────────────────────────────────────────────────────────────────


def seed() -> dict:
    fx = fixtures()
    now = datetime.fromisoformat(fx["demo_now"])
    ws = fx["workspace"]["id"]
    reset()
    clock = Clock()

    # People: three more Acme members (workspace "member" role); the Docs Studio roles come next.
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
    for path, (title, desc, icon, md) in C.ACME_DOCS_PAGES.items():
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
        write_page(T["alex"], sid, path, t, d, i, md + "\n")
    publish(T["alex"], sid, "Postgres guide and alert rules")

    clock.phase(timedelta(days=2, hours=1))
    t, d, i, md = C.ACME_DOCS_PAGES["/getting-started/quickstart"]
    write_page(T["maya"], sid, "/getting-started/quickstart", t, d, i, md.replace("about ten minutes", "about 10 minutes"))
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

    # ── Theme previews: a personal copy of Acme's docs (Jordan's, so it isn't on Riya's home),
    #    without the brand, so each preset shows as it comes. The Themes shots switch its preset
    #    and publish it (shots/d-docs-studio.mjs).
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
    out = {"acme": sid, "help": hid, "developers": did, "themes": tid, "review": review["id"], "workspace": ws,
           "slugs": {"acme": "acme", "help": "acme-help", "developers": "acme-developers", "themes": "acme-themes"}}
    (DATA / "fixtures_studio.json").write_text(json.dumps(out, indent=2))
    print(f"seeded Docs Studio: 3 sites, {moved} rows backdated → {DATA / 'fixtures_studio.json'}")
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


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--import-run", action="store_true")
    ap.add_argument("--slow", action="store_true")
    ap.add_argument("--drop-sites", metavar="WORKSPACE")
    a = ap.parse_args()
    if a.import_run:
        asyncio.run(play_import(None, "Acme", slow=a.slow))
    elif a.drop_sites:
        drop_sites(a.drop_sites)
    else:
        seed()
