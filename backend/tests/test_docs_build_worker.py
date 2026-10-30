"""Markdrop Docs build pipeline (scratchpad specs/docs-phase1.md, "Build pipeline"):
snapshot → content folder, the job queue (claim, locks, one build per site,
failure), build coalescing and finishing, restore, import storage, routing and
GitHub dispatch, and the internal runner API. Nothing here runs Node or touches
a bucket: the runner's side is docs-platform/test/runner.test.mjs.
"""

from __future__ import annotations

from tests import _email_env as env  # noqa: F401  (pins settings first)

import json
import os
import secrets
import shutil
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

import httpx
from bson import ObjectId

from app import database
from app.config import get_settings
from app.limiter import limiter
from app.main import app
from app.services import docs_build, docs_dispatch, docs_import_job, docs_jobs, docs_snapshot
from app.services.docs_jobs import BUILDS, JOBS, PAGES, SITES, SNAPSHOTS, VERSIONS

settings = get_settings()
JS = docs_jobs.get_jobs_settings()
SECRET = "test-docs-job-secret"


def utc(**kw) -> datetime:
    return datetime.now(timezone.utc) + timedelta(**kw)


# ── snapshot → content folder (pure) ────────────────────────────────────────


def _site(**settings_kw) -> dict:
    return {"_id": ObjectId(), "name": "Acme Rockets", "slug": "acme", "domains": [],
            "settings": {"theme": {"preset": "editorial", "brand": {"enabled": True, "logo_url": "/docs-assets/x/logo.png",
                                                                       "accent": "#d9480f", "colors": ["#d9480f", "#111111"]},
                                   "fonts": {"heading": "fraunces"}, "mode": "light", "corners": "round", "custom_css": ".x{color:red}"},
                         "ai": {"enabled": False}, **settings_kw}}


def _pages() -> list[dict]:
    return [
        {"id": "a" * 24, "path": "/", "title": "Home", "description": "Welcome", "markdown": "Hello"},
        {"id": "b" * 24, "path": "/guide/start", "title": "Start", "description": "Begin here", "icon": "zap",
         "markdown": "## One\n\nBody", "frontmatter_extra": {"nav": "Start", "anchors": {"old": "one"}, "title": "evil"}},
        {"id": "c" * 24, "path": "/guide/secret", "title": "Secret", "description": "", "hidden": True, "markdown": "x"},
        {"id": "d" * 24, "path": "/loose", "title": "Loose", "description": "Not in nav", "markdown": "y"},
        {"id": "e" * 24, "path": "/../etc", "title": "Bad", "markdown": "z"},
        {"id": "f" * 24, "path": "/public/x", "title": "Reserved", "markdown": "z"},
    ]


class SnapshotTests(unittest.TestCase):
    def test_content_folder(self):
        site = _site(nav=[{"group": "Guide", "icon": "home", "pages": ["b" * 24, "c" * 24, "zz"]}],
                     redirects={"/old": "/guide/start"}, pages={"showDescription": True},
                     home={"headline": "Hi"}, description="Rocket docs")
        snap = {"pages": _pages(), "settings": site["settings"], "created_at": datetime(2026, 10, 31, tzinfo=timezone.utc)}
        files, warnings = docs_snapshot.content_files(site, snap, url="https://acme.docs.markdrop.in", ai_api="https://api.markdrop.in")
        self.assertEqual(sorted(files), ["guide/secret.md", "guide/start.md", "index.md", "loose.md", "redirects.json", "site.json"])
        self.assertEqual(len(warnings), 2)  # the ../ path and the reserved /public
        sj = json.loads(files["site.json"])
        self.assertEqual(sj["id"], str(site["_id"]))
        self.assertEqual(sj["name"], "Acme Rockets")
        self.assertEqual(sj["url"], "https://acme.docs.markdrop.in")
        self.assertEqual(sj["description"], "Rocket docs")
        # Hidden pages are built but not listed; pages no group lists land in "More".
        self.assertEqual(sj["nav"], [{"group": "Guide", "icon": "home", "pages": ["/guide/start"]},
                                     {"group": "More", "pages": ["/loose"]}])
        self.assertEqual(sj["brand"]["logo"], {"light": "/docs-assets/x/logo.png", "alt": "Acme Rockets"})
        self.assertEqual(sj["brand"]["accent"], "#d9480f")
        self.assertEqual(sj["brand"]["colors"], ["#d9480f", "#111111"])
        self.assertEqual(sj["theme"], {"preset": "editorial", "fonts": {"heading": "fraunces"}, "mode": "light",
                                       "corners": "round", "customCss": ".x{color:red}"})
        self.assertEqual(sj["ai"], {"enabled": False})
        self.assertEqual(sj["pages"], {"showDescription": True})
        self.assertEqual(sj["integrations"], {"markdropApp": False})
        self.assertEqual(json.loads(files["redirects.json"]), {"/old": "/guide/start"})
        start = files["guide/start.md"]
        self.assertTrue(start.startswith('---\ntitle: "Start"\ndescription: "Begin here"\nupdated: 2026-10-31\nicon: "zap"\n'))
        self.assertIn('nav: "Start"\n', start)
        self.assertIn('anchors: {"old": "one"}\n', start)
        self.assertNotIn("evil", start)  # frontmatter_extra can't override the page's own fields
        self.assertTrue(start.endswith("---\n## One\n\nBody\n"))
        # An empty description falls back to the title (the engine wants one).
        self.assertIn('description: "Secret"', files["guide/secret.md"])

    def test_ai_on_and_suggestions(self):
        site = _site()
        site["settings"]["ai"] = {"enabled": True, "name": "Ask Acme", "suggestions": ["How do I launch?", " ", "Fuel?"]}
        files, _ = docs_snapshot.content_files(site, {"pages": [], "settings": site["settings"]}, url="https://u", ai_api="https://api.x")
        sj = json.loads(files["site.json"])
        self.assertEqual(sj["ai"], {"enabled": True, "api": "https://api.x", "site": str(site["_id"]), "assistantName": "Ask Acme"})
        self.assertEqual(sj["home"]["chips"], ["How do I launch?", "Fuel?"])

    def test_pasted_frontmatter_and_yaml_safety(self):
        text = docs_snapshot.page_text({"title": 'Say "hi": now', "description": "a: b # c", "markdown": "---\nnav: Short\n---\n\nBody"}, "2026-01-02")
        self.assertIn('title: "Say \\"hi\\": now"', text)
        self.assertIn('description: "a: b # c"', text)
        self.assertIn('nav: "Short"', text)
        self.assertTrue(text.endswith("---\nBody\n"))

    def test_brand_off_and_hosts(self):
        site = _site()
        site["settings"]["theme"]["brand"]["enabled"] = False
        self.assertEqual(docs_snapshot._brand(site, site["settings"]), {"name": "Acme Rockets", "label": "Docs"})
        site["domains"] = [{"host": "Docs.Acme.com", "status": "active"}, {"host": "pending.acme.com", "status": "pending"}]
        self.assertEqual(docs_snapshot.site_hosts(site), ["acme.docs.markdrop.in", "docs.acme.com"])
        self.assertEqual(docs_snapshot.site_url(site), "https://docs.acme.com")

    def test_paths(self):
        for ok in ("/", "/a", "/a-b/c_d", "/x1/y2/z3"):
            self.assertTrue(docs_snapshot.valid_page_path(ok), ok)
        for bad in ("", "a", "/A", "/a/", "//a", "/_a", "/.a", "/a/../b", "/og/x", "/md", "/docs-assets/a", "/a b"):
            self.assertFalse(docs_snapshot.valid_page_path(bad), bad)


class TokenTests(unittest.TestCase):
    def test_token(self):
        tok = docs_jobs.job_token("j1", 60, secret=SECRET)
        self.assertTrue(docs_jobs.verify_job_token("j1", tok, secret=SECRET))
        self.assertFalse(docs_jobs.verify_job_token("j2", tok, secret=SECRET))
        self.assertFalse(docs_jobs.verify_job_token("j1", tok, secret="other"))
        self.assertFalse(docs_jobs.verify_job_token("j1", tok + "x", secret=SECRET))
        self.assertFalse(docs_jobs.verify_job_token("j1", None, secret=SECRET))
        self.assertFalse(docs_jobs.verify_job_token("j1", tok, secret=""))
        exp, sig = tok.split(".")
        old = f"{int(time.time()) - 5}.{docs_jobs._sig(SECRET, 'j1', int(time.time()) - 5)}"
        self.assertFalse(docs_jobs.verify_job_token("j1", old, secret=SECRET))


# ── with a database ─────────────────────────────────────────────────────────


class DbCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.db_name = f"markdrop_test_docsjobs_{secrets.token_hex(4)}"
        if env.MONGO:
            from motor.motor_asyncio import AsyncIOMotorClient

            self.client = AsyncIOMotorClient(env.MONGO_URI)
        else:
            from mongomock_motor import AsyncMongoMockClient

            self.client = AsyncMongoMockClient()
        self.db = self.client[self.db_name]
        self._saved = (database._client, settings.mongodb_db)
        database._client = self.client
        settings.mongodb_db = self.db_name
        for k, v in {"docs_job_secret": SECRET, "docs_r2_account_id": "", "docs_builder_repo": "", "docs_builder_token": "",
                     "docs_build_targets": "actions,local", "docs_builds_per_day": 30, "docs_job_max_attempts": 3,
                     "docs_site_host_template": "{slug}.docs.markdrop.in"}.items():
            p = mock.patch.object(JS, k, v)
            p.start()
            self.addCleanup(p.stop)
        docs_dispatch.reset_state()
        limiter.reset()
        self.store = tempfile.mkdtemp(prefix="docs-store-")
        self.addCleanup(shutil.rmtree, self.store, True)

    async def asyncTearDown(self):
        database._client, settings.mongodb_db = self._saved
        if env.MONGO:
            await self.client.drop_database(self.db_name)
            self.client.close()

    async def make_site(self, slug="acme", **kw) -> dict:
        t = utc()
        site = {"workspace_id": None, "owner_id": "u1", "name": "Acme", "slug": slug, "status": "draft",
                "source": {"kind": "blank"}, "settings": {"theme": {"preset": "clean"}, "ai": {"enabled": False}, "nav": []},
                "domains": [], "live_build_id": None, "last_published_at": None, "last_published_by": None,
                "created_at": t, "updated_at": t, "deleted_at": None, **kw}
        site["_id"] = (await self.db[SITES].insert_one(site)).inserted_id
        return site

    async def make_page(self, site, path, title="T", md="Body", rev=1) -> ObjectId:
        return (await self.db[PAGES].insert_one({
            "site_id": site["_id"], "path": path, "title": title, "description": "D", "hidden": False,
            "draft": {"markdown": md, "rev": rev}, "published": None, "lock": None, "created_at": utc(), "deleted_at": None,
        })).inserted_id

    async def publish(self, site) -> tuple[dict, dict, bool]:
        pages = [p async for p in self.db[PAGES].find({"site_id": site["_id"]})]
        snap = {"site_id": site["_id"], "settings": site["settings"], "created_at": utc(),
                "pages": [{"id": str(p["_id"]), "path": p["path"], "title": p["title"], "description": p["description"],
                           "hidden": p["hidden"], "markdown": p["draft"]["markdown"], "rev": p["draft"]["rev"]} for p in pages]}
        snap["_id"] = (await self.db[SNAPSHOTS].insert_one(snap)).inserted_id
        return await docs_build.enqueue_build(self.db, site_id=site["_id"], snapshot_id=snap["_id"], requested_by="u1")

    def put_manifest(self, site_id: str) -> str:
        h = secrets.token_hex(32)
        os.makedirs(os.path.join(self.store, "manifests"), exist_ok=True)
        with open(os.path.join(self.store, "manifests", f"{h}.json"), "w") as f:
            json.dump({"site": {"id": site_id}, "engine": "e123"}, f)
        return h


class QueueTests(DbCase):
    async def test_claim_order_lock_and_one_build_per_site(self):
        a = await self.make_site("a")
        b = await self.make_site("b")
        j1 = await docs_jobs.insert_job(self.db, "build", a["_id"], {}, target="local")
        j2 = await docs_jobs.insert_job(self.db, "build", a["_id"], {}, target="local")
        j3 = await docs_jobs.insert_job(self.db, "build", b["_id"], {}, target="local")
        await docs_jobs.insert_job(self.db, "build", b["_id"], {}, target="actions")
        got = await docs_jobs.claim_next(self.db, "w1")
        self.assertEqual(got["_id"], j1["_id"])
        self.assertEqual((got["status"], got["locked_by"], got["attempts"]), ("running", "w1", 1))
        # Site a is busy: the next claim skips j2 and takes site b's local job (never the Actions one).
        got2 = await docs_jobs.claim_next(self.db, "w2")
        self.assertEqual(got2["_id"], j3["_id"])
        self.assertIsNone(await docs_jobs.claim_next(self.db, "w3"))
        # Only the holder can report or renew.
        self.assertFalse(await docs_jobs.set_progress(self.db, j1["_id"], "w2", {"step": "x"}))
        self.assertTrue(await docs_jobs.set_progress(self.db, j1["_id"], "w1", {"step": "build", "done": 1, "total": 4, "message": "m" * 500}))
        row = await self.db[JOBS].find_one({"_id": j1["_id"]})
        self.assertEqual(len(row["progress"]["message"]), 200)
        self.assertTrue(await docs_jobs.complete(self.db, j1["_id"], "w1", {"ok": True}))
        self.assertEqual((await docs_jobs.claim_next(self.db, "w3"))["_id"], j2["_id"])

    async def test_expired_lock_is_reclaimed_then_exhausted(self):
        s = await self.make_site()
        j = await docs_jobs.insert_job(self.db, "import", s["_id"], {}, target="local")
        for n in (1, 2, 3):
            got = await docs_jobs.claim_next(self.db, f"w{n}")
            self.assertEqual((got["_id"], got["attempts"]), (j["_id"], n))
            await self.db[JOBS].update_one({"_id": j["_id"]}, {"$set": {"locked_until": utc(seconds=-1)}})
            self.assertFalse(await docs_jobs.renew(self.db, j["_id"], "someone-else"))
        self.assertIsNone(await docs_jobs.claim_next(self.db, "w4"))
        self.assertEqual([x["_id"] for x in await docs_jobs.exhausted_jobs(self.db)], [j["_id"]])
        stats = await docs_dispatch.run_once(self.db)
        self.assertEqual(stats["failed"], 1)
        row = await self.db[JOBS].find_one({"_id": j["_id"]})
        self.assertEqual(row["status"], "failed")
        self.assertIn("stopped responding", row["error"])

    async def test_release_and_site_race(self):
        s = await self.make_site()
        j1 = await docs_jobs.insert_job(self.db, "build", s["_id"], {}, target="local")
        j2 = await docs_jobs.insert_job(self.db, "build", s["_id"], {}, target="local")
        got = await docs_jobs.claim_next(self.db, "w1")
        self.assertTrue(await docs_jobs.release(self.db, got["_id"], "w1"))
        row = await self.db[JOBS].find_one({"_id": j1["_id"]})
        self.assertEqual((row["status"], row["attempts"], row["locked_by"]), ("queued", 0, None))
        # A race: j2 got claimed although j1 (claimed earlier) is running → j2 goes back.
        await self.db[JOBS].update_one({"_id": j1["_id"]}, {"$set": {"status": "running", "locked_by": "w1",
                                                                      "locked_until": utc(minutes=1), "claimed_at": utc(seconds=-5)}})
        res, why = await docs_jobs.claim_job(self.db, j2["_id"], "gha-1")
        self.assertEqual((res, why), (None, "busy"))
        await self.db[JOBS].update_one({"_id": j1["_id"]}, {"$set": {"locked_until": utc(seconds=-1)}})
        await self.db[JOBS].update_one({"_id": j2["_id"]}, {"$set": {"status": "running", "locked_by": "x", "claimed_at": utc(),
                                                                      "locked_until": utc(minutes=1)}})
        await self.db[JOBS].update_one({"_id": j1["_id"]}, {"$set": {"locked_until": utc(minutes=1)}})
        self.assertFalse(await docs_jobs._settle_site_race(self.db, await self.db[JOBS].find_one({"_id": j2["_id"]}), "x"))
        self.assertEqual((await self.db[JOBS].find_one({"_id": j2["_id"]}))["status"], "queued")

    async def test_claim_job_reasons(self):
        s = await self.make_site()
        j = await docs_jobs.insert_job(self.db, "import", s["_id"], {}, target="actions")
        self.assertEqual((await docs_jobs.claim_job(self.db, ObjectId(), "r"))[1], "missing")
        got, why = await docs_jobs.claim_job(self.db, j["_id"], "r1")
        self.assertEqual(why, "ok")
        self.assertEqual((await docs_jobs.claim_job(self.db, j["_id"], "r1"))[1], "ok")  # the holder asks again
        self.assertEqual((await docs_jobs.claim_job(self.db, j["_id"], "r2"))[1], "taken")
        await docs_jobs.complete(self.db, j["_id"], "r1", {})
        self.assertEqual((await docs_jobs.claim_job(self.db, j["_id"], "r1"))[1], "finished")


class BuildTests(DbCase):
    async def test_coalescing(self):
        s = await self.make_site()
        await self.make_page(s, "/a")
        b1, j1, c1 = await self.publish(s)
        b2, j2, c2 = await self.publish(s)
        self.assertFalse(c1)
        self.assertTrue(c2)
        self.assertEqual(j1["_id"], j2["_id"])
        self.assertEqual((b1["number"], b2["number"]), (1, 2))
        self.assertEqual((await self.db[BUILDS].find_one({"_id": b1["_id"]}))["status"], "superseded")
        self.assertEqual((await self.db[JOBS].find_one({"_id": j1["_id"]}))["payload"]["build_id"], str(b2["_id"]))
        # The build is running: later publishes give exactly one follow-up job, of the latest content.
        await self.db[JOBS].update_one({"_id": j1["_id"]}, {"$set": {"status": "running"}})
        b3, j3, c3 = await self.publish(s)
        b4, j4, c4 = await self.publish(s)
        self.assertFalse(c3)
        self.assertTrue(c4)
        self.assertNotEqual(j3["_id"], j1["_id"])
        self.assertEqual(j3["_id"], j4["_id"])
        self.assertEqual(await self.db[JOBS].count_documents({"site_id": s["_id"], "kind": "build"}), 2)
        self.assertEqual((await self.db[JOBS].find_one({"_id": j3["_id"]}))["payload"]["build_id"], str(b4["_id"]))
        self.assertEqual(await docs_build.builds_today(self.db, s["_id"]), 2)

    async def test_start_spec_finish_and_supersede(self):
        s = await self.make_site()
        p1 = await self.make_page(s, "/", "Home")
        p2 = await self.make_page(s, "/guide/a", "A", rev=3)
        await self.db[SITES].update_one({"_id": s["_id"]}, {"$set": {"settings.nav": [{"group": "G", "pages": [str(p2)]}]}})
        s = await self.db[SITES].find_one({"_id": s["_id"]})
        b1, j1, _ = await self.publish(s)
        job = await docs_jobs.claim_next(self.db, "w1", target=None)
        build = await docs_build.start_build(self.db, job)
        self.assertEqual(build["status"], "building")
        spec = await docs_build.build_spec(self.db, job, build)
        self.assertEqual(spec["publish"], {"site": str(s["_id"]), "hosts": ["acme.docs.markdrop.in"]})
        self.assertEqual(spec["build"]["number"], 1)
        self.assertEqual(json.loads(spec["bundle"]["files"]["site.json"])["nav"], [{"group": "G", "pages": ["/guide/a"]}])
        h1 = "1" * 64
        out = await docs_build.finish_build(self.db, job, "w1", {"ok": True, "manifest_hash": h1, "engine": "e1",
                                                                   "stats": {"pages": 2, "objects": 9, "uploaded": 9, "bytes": 100, "ms": 5, "x": "no"},
                                                                   "timings": {"nextBuild": 1}})
        self.assertTrue(out["ok"])
        b = await self.db[BUILDS].find_one({"_id": b1["_id"]})
        self.assertEqual((b["status"], b["manifest_hash"], b["stats"]), ("live", h1, {"pages": 2, "objects": 9, "uploaded": 9, "bytes": 100, "ms": 5}))
        site = await self.db[SITES].find_one({"_id": s["_id"]})
        self.assertEqual((site["live_build_id"], site["status"], site["last_published_by"]), (b1["_id"], "live", "u1"))
        page = await self.db[PAGES].find_one({"_id": p2})
        self.assertEqual((page["published"]["rev"], page["published"]["published_build_id"]), (3, b1["_id"]))
        self.assertEqual((await self.db[JOBS].find_one({"_id": j1["_id"]}))["status"], "done")
        # The next build replaces it.
        b2, j2, _ = await self.publish(site)
        job2 = await docs_jobs.claim_next(self.db, "w1", target=None)
        await docs_build.start_build(self.db, job2)
        await docs_build.finish_build(self.db, job2, "w1", {"ok": True, "manifest_hash": "2" * 64, "stats": {}})
        self.assertEqual((await self.db[BUILDS].find_one({"_id": b1["_id"]}))["status"], "superseded")
        self.assertEqual((await self.db[BUILDS].find_one({"_id": b2["_id"]}))["status"], "live")
        self.assertEqual([e["type"] async for e in self.db["docs_site_events"].find()], ["docs_site_published"] * 2)

    async def test_failure_keeps_the_live_build(self):
        s = await self.make_site()
        await self.make_page(s, "/a")
        b1, _, _ = await self.publish(s)
        job = await docs_jobs.claim_next(self.db, "w1", target=None)
        await docs_build.start_build(self.db, job)
        await docs_build.finish_build(self.db, job, "w1", {"ok": True, "manifest_hash": "1" * 64})
        b2, _, _ = await self.publish(s)
        job = await docs_jobs.claim_next(self.db, "w1", target=None)
        await docs_build.start_build(self.db, job)
        out = await docs_build.finish_build(self.db, job, "w1", {"ok": False, "error": "next build exited with 1"})
        self.assertFalse(out["ok"])
        self.assertEqual((await self.db[BUILDS].find_one({"_id": b2["_id"]}))["status"], "failed")
        self.assertEqual((await self.db[BUILDS].find_one({"_id": b1["_id"]}))["status"], "live")
        self.assertEqual((await self.db[SITES].find_one({"_id": s["_id"]}))["live_build_id"], b1["_id"])
        j = await self.db[JOBS].find_one({"_id": job["_id"]})
        self.assertEqual((j["status"], j["error"]), ("failed", "next build exited with 1"))
        # No manifest in an "ok" result is a failure too.
        b3, _, _ = await self.publish(s)
        job = await docs_jobs.claim_next(self.db, "w1", target=None)
        await docs_build.start_build(self.db, job)
        self.assertFalse((await docs_build.finish_build(self.db, job, "w1", {"ok": True}))["ok"])

    async def test_daily_cap_and_missing_build(self):
        s = await self.make_site()
        await self.make_page(s, "/a")
        with mock.patch.object(JS, "docs_builds_per_day", 1):
            await self.db[BUILDS].insert_one({"site_id": s["_id"], "number": 99, "status": "live", "started_at": utc(hours=-1), "created_at": utc(hours=-1)})
            await self.publish(s)
            job = await docs_jobs.claim_next(self.db, "w1", target=None)
            with self.assertRaises(PermissionError):
                await docs_build.start_build(self.db, job)
        orphan = await docs_jobs.insert_job(self.db, "build", s["_id"], {"build_id": str(ObjectId())})
        with self.assertRaises(LookupError):
            await docs_build.start_build(self.db, orphan)

    async def test_restore(self):
        s = await self.make_site()
        sid = str(s["_id"])
        h1, h2 = self.put_manifest(sid), self.put_manifest(sid)
        b1 = (await self.db[BUILDS].insert_one({"site_id": s["_id"], "number": 1, "status": "superseded", "manifest_hash": h1})).inserted_id
        b2 = (await self.db[BUILDS].insert_one({"site_id": s["_id"], "number": 2, "status": "live", "manifest_hash": h2})).inserted_id
        failed = (await self.db[BUILDS].insert_one({"site_id": s["_id"], "number": 3, "status": "failed", "manifest_hash": None})).inserted_id
        store = docs_build.FsPointerStore(self.store)
        store.put_text(f"sites/{sid}/current.json", json.dumps({"manifest": h2}))
        res = await docs_build.restore_build(self.db, s["_id"], b1, "admin1", store=store)
        self.assertEqual((res["number"], res["unchanged"]), (1, False))
        ptr = json.loads(store.get_text(f"sites/{sid}/current.json"))
        self.assertEqual((ptr["manifest"], ptr["previous"], ptr["engine"], ptr["restored"]), (h1, h2, "e123", True))
        self.assertEqual(set(ptr), {"manifest", "engine", "publishedAt", "previous", "restored"})
        self.assertEqual((await self.db[BUILDS].find_one({"_id": b1}))["status"], "live")
        self.assertEqual((await self.db[BUILDS].find_one({"_id": b2}))["status"], "superseded")
        self.assertEqual((await self.db[SITES].find_one({"_id": s["_id"]}))["live_build_id"], b1)
        # Again: nothing to write.
        self.assertTrue((await docs_build.restore_build(self.db, s["_id"], b1, "admin1", store=store))["unchanged"])
        with self.assertRaises(docs_build.RestoreError):
            await docs_build.restore_build(self.db, s["_id"], failed, "a", store=store)
        other = await self.make_site("other")
        with self.assertRaises(docs_build.RestoreError):
            await docs_build.restore_build(self.db, other["_id"], b1, "a", store=store)
        # A manifest of another site, or one the store doesn't have, is refused.
        foreign = self.put_manifest("someone-else")
        b4 = (await self.db[BUILDS].insert_one({"site_id": s["_id"], "number": 4, "status": "superseded", "manifest_hash": foreign})).inserted_id
        with self.assertRaises(docs_build.RestoreError):
            await docs_build.restore_build(self.db, s["_id"], b4, "a", store=store)
        b5 = (await self.db[BUILDS].insert_one({"site_id": s["_id"], "number": 5, "status": "superseded", "manifest_hash": "f" * 64})).inserted_id
        with self.assertRaises(docs_build.RestoreError):
            await docs_build.restore_build(self.db, s["_id"], b5, "a", store=store)
        # Without bucket keys on the server, a restore becomes a local job.
        res = await docs_build.request_restore(self.db, s["_id"], b2, "admin1")
        job = await self.db[JOBS].find_one({"_id": ObjectId(res["job_id"])})
        self.assertEqual((job["kind"], job["target"], job["payload"]["build_id"]), ("restore", "local", str(b2)))
        with mock.patch.dict(os.environ, {"MARKDROP_DOCS_STORE_DIR": self.store}):
            res = await docs_build.request_restore(self.db, s["_id"], b2, "admin1")
        self.assertEqual(res["restored"]["number"], 2)


class ImportTests(DbCase):
    def data(self, **kw) -> dict:
        return {
            "site": {"name": "Senseless", "description": "Docs", "headline": "Hi", "home": {"start": [{"page": "/g/a"}]},
                     "pages": {"showDescription": True, "icons": True}, "footer": [{"label": "llms.txt", "href": "/llms.txt"}],
                     "brand": {"name": "S", "logo": {"light": "/docs-assets/x/brand/logo.png", "alt": "S", "tile": True},
                               "favicon": "/docs-assets/x/brand/logo.png", "accent": "#535061", "accentDark": "#a09fa8",
                               "og": {"background": "#17131f"}}},
            "nav": [{"group": "Getting started", "icon": "home", "pages": ["/g/a", "/g/missing"]}],
            "pages": [
                {"path": "/", "title": "Home", "description": "d", "markdown": "home", "hidden": False},
                {"path": "/g/a", "title": "A", "description": "d", "icon": "zap", "markdown": "a", "frontmatter_extra": {"anchors": {"x": "y"}}, "hidden": False},
                {"path": "/g/old", "title": "Old", "description": "d", "markdown": "o", "hidden": True},
                {"path": "/Bad Path", "title": "Bad", "markdown": "b"},
            ],
            "redirects": {"/x": "/g/a"},
            "report": {"counts": {"pages": 3, "altGenerated": 1, "hidden": 1, "brokenLinks": 0, "unmatchedIcons": 1},
                       "items": {"altGenerated": [{"page": "/g/a", "line": 3, "alt": "Screenshot"}], "hidden": [{"page": "/g/old", "title": "Old"}],
                                 "brokenLinks": [], "unmatchedIcons": [{"icon": "fa-weird", "pages": ["/g/a"]}], "notes": [{"page": "/g/a", "kind": "embed"}] * 300}},
            "assets": {"files": 4, "bytes": 1000, "uploaded": 4, "uploaded_bytes": 1000},
            **kw,
        }

    async def test_apply_import(self):
        s = await self.make_site("senseless")
        job = await docs_import_job.enqueue_import(self.db, s["_id"], "https://docs.example.com", "u1")
        job = await docs_jobs.claim_next(self.db, "w1", target=None)
        spec = docs_import_job.import_spec(job, keep_gifs=True)
        self.assertEqual(spec["import"], {"kind": "gitbook", "url": "https://docs.example.com", "site_id": str(s["_id"]), "keep_gifs": True})
        out = await docs_import_job.apply_import(self.db, job, "w1", self.data())
        self.assertEqual(out["pages"], {"created": 3, "updated": 0, "total": 3, "hidden": 1})
        self.assertEqual(len(out["skipped"]), 1)
        a = await self.db[PAGES].find_one({"site_id": s["_id"], "path": "/g/a"})
        self.assertEqual((a["title"], a["icon"], a["hidden"], a["draft"]["rev"], a["draft"]["frontmatter_extra"]), ("A", "zap", False, 1, {"anchors": {"x": "y"}}))
        self.assertIsNone(a["published"])
        self.assertTrue((await self.db[PAGES].find_one({"site_id": s["_id"], "path": "/g/old"}))["hidden"])
        self.assertEqual(await self.db[VERSIONS].count_documents({"site_id": s["_id"], "kind": "import"}), 3)
        site = await self.db[SITES].find_one({"_id": s["_id"]})
        st = site["settings"]
        self.assertEqual(st["nav"], [{"group": "Getting started", "pages": [str(a["_id"])], "icon": "home"}])
        self.assertEqual(st["theme"]["preset"], "clean")  # kept
        self.assertEqual(st["theme"]["brand"], {"enabled": True, "logo_url": "/docs-assets/x/brand/logo.png", "logo_alt": "S", "logo_tile": True,
                                                "favicon_url": "/docs-assets/x/brand/logo.png", "accent": "#535061", "colors": ["#535061"],
                                                "accent_dark": "#a09fa8", "og": {"background": "#17131f"}})
        self.assertEqual((st["headline"], st["redirects"], st["pages"]), ("Hi", {"/x": "/g/a"}, {"showDescription": True, "icons": True}))
        job = await self.db[JOBS].find_one({"_id": job["_id"]})
        self.assertEqual(job["status"], "done")
        rep = job["result"]["report"]
        self.assertEqual(rep["counts"]["altGenerated"], 1)
        self.assertEqual(rep["items"]["unmatchedIcons"], [{"icon": "fa-weird", "pages": ["/g/a"]}])
        self.assertEqual(len(rep["items"]["notes"]), docs_import_job.REPORT_ITEMS)
        self.assertEqual(rep["truncated"], {"notes": 300})
        # The imported settings build: the snapshot writer reads them back into site.json.
        files, _ = docs_snapshot.content_files(site, {"pages": [{"id": str(a["_id"]), "path": "/g/a", "title": "A", "markdown": "a"}],
                                                      "settings": st}, url="https://x", ai_api="https://api")
        sj = json.loads(files["site.json"])
        self.assertEqual(sj["brand"]["logo"], {"light": "/docs-assets/x/brand/logo.png", "alt": "S", "tile": True})
        self.assertEqual((sj["brand"]["favicon"], sj["brand"]["accentDark"], sj["headline"]), ("/docs-assets/x/brand/logo.png", "#a09fa8", "Hi"))
        # Importing again: same pages get a new draft revision, no duplicates.
        await self.db[JOBS].update_one({"_id": job["_id"]}, {"$set": {"status": "running", "locked_by": "w1"}})
        out = await docs_import_job.apply_import(self.db, job, "w1", self.data())
        self.assertEqual(out["pages"]["updated"], 3)
        self.assertEqual((await self.db[PAGES].find_one({"_id": a["_id"]}))["draft"]["rev"], 2)
        self.assertEqual(await self.db[PAGES].count_documents({"site_id": s["_id"]}), 3)

    async def test_bad_url(self):
        s = await self.make_site()
        with self.assertRaises(ValueError):
            await docs_import_job.enqueue_import(self.db, s["_id"], "file:///etc/passwd", "u1")


class DispatchTests(DbCase):
    async def test_routing(self):
        s = await self.make_site()
        restore = await docs_jobs.insert_job(self.db, "restore", s["_id"], {})
        imp = await docs_jobs.insert_job(self.db, "import", s["_id"], {"source": {"url": "https://docs.x"}})
        build = await docs_jobs.insert_job(self.db, "build", s["_id"], {})

        async def small(url):
            return 12

        async def big(url):
            return 300

        self.assertEqual((await docs_dispatch.choose_target(self.db, restore))[0], "local")
        self.assertEqual((await docs_dispatch.choose_target(self.db, imp, probe=small))[0], "local")
        # Actions not configured: big imports and builds fall back to the server.
        self.assertEqual(await docs_dispatch.choose_target(self.db, imp, probe=big), ("local", "actions unavailable: the builder repo isn't configured"))
        self.assertEqual((await docs_dispatch.choose_target(self.db, build))[1], "fallback: the builder repo isn't configured")
        with mock.patch.object(JS, "docs_builder_repo", "o/r"), mock.patch.object(JS, "docs_builder_token", "t"):
            self.assertEqual((await docs_dispatch.choose_target(self.db, imp, probe=big))[0], "actions")
            self.assertEqual((await docs_dispatch.choose_target(self.db, build))[0], "actions")
            # The month's minutes are used up → local.
            await self.db[JOBS].insert_one({"kind": "build", "site_id": s["_id"], "target": "actions", "status": "done",
                                            "finished_at": utc(), "actions_minutes": 1800, "created_at": utc()})
            ok, why = await docs_dispatch.actions_status(self.db)
            self.assertFalse(ok)
            self.assertIn("minutes", why)
            self.assertEqual((await docs_dispatch.choose_target(self.db, build))[0], "local")
        with mock.patch.object(JS, "docs_build_targets", "actions"):
            self.assertEqual((await docs_dispatch.choose_target(self.db, build))[0], None)

    async def test_dispatch_and_fallback(self):
        s = await self.make_site()
        calls = []

        def handler(request: httpx.Request):
            calls.append(request)
            return httpx.Response(204) if len(calls) == 1 else httpx.Response(500, text="boom")

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with mock.patch.object(JS, "docs_builder_repo", "acme/builder"), mock.patch.object(JS, "docs_builder_token", "ghp_x"), \
                mock.patch.object(JS, "docs_job_api_base", "https://api.markdrop.in"):
            j1 = await docs_jobs.insert_job(self.db, "build", s["_id"], {})
            await docs_dispatch.run_once(self.db, client=client)
            row = await self.db[JOBS].find_one({"_id": j1["_id"]})
            self.assertEqual((row["target"], row["dispatch_attempts"]), ("actions", 1))
            body = json.loads(calls[0].content)
            self.assertEqual(str(calls[0].url), "https://api.github.com/repos/acme/builder/actions/workflows/docs-job.yml/dispatches")
            self.assertEqual(calls[0].headers["authorization"], "Bearer ghp_x")
            self.assertEqual((body["ref"], body["inputs"]["job_id"], body["inputs"]["kind"], body["inputs"]["api_base"]),
                             ("main", str(j1["_id"]), "build", "https://api.markdrop.in"))
            self.assertTrue(docs_jobs.verify_job_token(str(j1["_id"]), body["inputs"]["token"]))
            # Not re-sent before the retry window.
            await docs_dispatch.run_once(self.db, client=client)
            self.assertEqual(len(calls), 1)
            # A second site's build: the dispatch fails → Actions is marked down → it goes local.
            other = await self.make_site("other")
            j2 = await docs_jobs.insert_job(self.db, "build", other["_id"], {})
            await docs_dispatch.run_once(self.db, client=client)
            row = await self.db[JOBS].find_one({"_id": j2["_id"]})
            self.assertEqual((row["target"], row["fallback"], row["dispatch_error"][:8]), ("local", True, "HTTP 500"))
            # Once Actions is back (and 2 minutes passed), a fallback build that is still waiting returns to it.
            docs_dispatch.reset_state()
            await self.db[JOBS].update_one({"_id": j2["_id"]}, {"$set": {"routed_at": utc(minutes=-3)}})
            calls.clear()
            client2 = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: (calls.append(r), httpx.Response(204))[1]))
            await docs_dispatch.run_once(self.db, client=client2)
            await docs_dispatch.run_once(self.db, client=client2)
            row = await self.db[JOBS].find_one({"_id": j2["_id"]})
            self.assertEqual(row["target"], "actions")
            self.assertEqual(len(calls), 1)

    async def test_sweeper(self):
        s = await self.make_site()
        await self.make_page(s, "/a")
        b, j, _ = await self.publish(s)
        # An Actions runner vanished mid-build: back to the queue, to be sent again.
        await self.db[JOBS].update_one({"_id": j["_id"]}, {"$set": {"status": "running", "target": "actions", "attempts": 1,
                                                                     "locked_until": utc(seconds=-5), "claimed_at": utc(minutes=-1),
                                                                     "dispatched_at": utc(minutes=-1)}})
        with mock.patch.object(JS, "docs_build_targets", "actions"):
            stats = await docs_dispatch.run_once(self.db)
        self.assertEqual(stats["requeued"], 1)
        row = await self.db[JOBS].find_one({"_id": j["_id"]})
        self.assertEqual((row["status"], row["dispatched_at"]), ("queued", None))
        # Running far too long: failed, and so is its build.
        await self.db[JOBS].update_one({"_id": j["_id"]}, {"$set": {"status": "running", "claimed_at": utc(hours=-2), "locked_until": utc(minutes=1)}})
        await docs_dispatch.run_once(self.db)
        self.assertEqual((await self.db[JOBS].find_one({"_id": j["_id"]}))["status"], "failed")
        self.assertEqual((await self.db[BUILDS].find_one({"_id": b["_id"]}))["status"], "failed")
        # Queued and never picked up for hours: failed.
        old = await docs_jobs.insert_job(self.db, "import", s["_id"], {})
        await self.db[JOBS].update_one({"_id": old["_id"]}, {"$set": {"created_at": utc(hours=-5)}})
        await docs_dispatch.run_once(self.db)
        self.assertIn("picked the job up", (await self.db[JOBS].find_one({"_id": old["_id"]}))["error"])


class InternalApiTests(DbCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://api.markdrop.in")

    async def asyncTearDown(self):
        await self.http.aclose()
        await super().asyncTearDown()

    def auth(self, job_id, token=None):
        return {"authorization": f"Bearer {token or docs_jobs.job_token(str(job_id))}"}

    async def test_build_round_trip(self):
        s = await self.make_site()
        await self.make_page(s, "/a", md="secret words")
        b, j, _ = await self.publish(s)
        url = f"/api/v1/internal/docs-jobs/{j['_id']}"
        r = await self.http.get(url + "?runner=gha-1", headers=self.auth(j["_id"], docs_jobs.job_token(str(ObjectId()))))
        self.assertEqual(r.status_code, 401)
        r = await self.http.get(url + "?runner=gha-1")
        self.assertEqual(r.status_code, 401)
        r = await self.http.get(url + "?runner=gha-1", headers=self.auth(j["_id"]))
        self.assertEqual(r.status_code, 200, r.text)
        spec = r.json()
        self.assertEqual((spec["job"]["kind"], spec["build"]["number"]), ("build", 1))
        self.assertIn("a.md", spec["bundle"]["files"])
        self.assertEqual((await self.db[BUILDS].find_one({"_id": b["_id"]}))["status"], "building")
        r = await self.http.get(url + "?runner=gha-2", headers=self.auth(j["_id"]))
        self.assertEqual(r.status_code, 409)
        r = await self.http.post(url + "/progress", headers=self.auth(j["_id"]), json={"runner": "gha-2", "step": "x"})
        self.assertEqual(r.status_code, 409)
        r = await self.http.post(url + "/progress", headers=self.auth(j["_id"]), json={"runner": "gha-1", "step": "build", "done": 1, "total": 4, "message": "Rendering"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual((await self.db[JOBS].find_one({"_id": j["_id"]}))["progress"]["step"], "build")
        await self.db[JOBS].update_one({"_id": j["_id"]}, {"$set": {"target": "actions"}})
        r = await self.http.post(url + "/result", headers=self.auth(j["_id"]),
                                 json={"runner": "gha-1", "ok": True, "manifest_hash": "a" * 64, "stats": {"pages": 1}, "runner_ms": 61_000})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((await self.db[BUILDS].find_one({"_id": b["_id"]}))["status"], "live")
        row = await self.db[JOBS].find_one({"_id": j["_id"]})
        self.assertEqual((row["status"], row["actions_minutes"]), ("done", 2))
        r = await self.http.get(url + "?runner=gha-1", headers=self.auth(j["_id"]))
        self.assertEqual(r.status_code, 410)
        r = await self.http.post(url + "/result", headers=self.auth(j["_id"]), json={"runner": "gha-1", "ok": True})
        self.assertEqual(r.status_code, 410)

    async def test_import_round_trip_and_failure(self):
        s = await self.make_site()
        j = await docs_import_job.enqueue_import(self.db, s["_id"], "https://docs.example.com", "u1")
        url = f"/api/v1/internal/docs-jobs/{j['_id']}"
        spec = (await self.http.get(url + "?runner=r", headers=self.auth(j["_id"]))).json()
        self.assertEqual(spec["import"]["url"], "https://docs.example.com")
        data = ImportTests.data(self)
        r = await self.http.post(url + "/import-result", headers=self.auth(j["_id"]), json={"runner": "r", "ok": True, "import": data})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["result"]["pages"]["created"], 3)
        self.assertEqual(await self.db[PAGES].count_documents({"site_id": s["_id"]}), 3)
        j2 = await docs_import_job.enqueue_import(self.db, s["_id"], "https://docs.example.com", "u1")
        url2 = f"/api/v1/internal/docs-jobs/{j2['_id']}"
        await self.http.get(url2 + "?runner=r", headers=self.auth(j2["_id"]))
        r = await self.http.post(url2 + "/result", headers=self.auth(j2["_id"]), json={"runner": "r", "ok": False, "error": "no llms.txt"})
        self.assertEqual(r.status_code, 200)
        row = await self.db[JOBS].find_one({"_id": j2["_id"]})
        self.assertEqual((row["status"], row["error"]), ("failed", "no llms.txt"))

    async def test_disabled_without_secret_and_restore_jobs_stay_local(self):
        s = await self.make_site()
        j = await docs_jobs.insert_job(self.db, "restore", s["_id"], {}, target="local")
        r = await self.http.get(f"/api/v1/internal/docs-jobs/{j['_id']}?runner=r", headers=self.auth(j["_id"]))
        self.assertEqual(r.status_code, 409)
        self.assertEqual((await self.db[JOBS].find_one({"_id": j["_id"]}))["status"], "queued")
        with mock.patch.object(JS, "docs_job_secret", ""):
            r = await self.http.get(f"/api/v1/internal/docs-jobs/{j['_id']}?runner=r", headers={"authorization": "Bearer 1.x"})
        self.assertEqual(r.status_code, 503)


if __name__ == "__main__":
    unittest.main()
