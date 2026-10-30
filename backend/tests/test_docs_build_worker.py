"""Markdrop Docs build pipeline (scratchpad specs/docs-phase1.md, "Build pipeline"):
snapshot → content folder, the job queue (claim, locks, one build per site,
failure), build coalescing and finishing, restore and unpublish, import
storage, routing and GitHub dispatch, and the internal runner API. Publishes go
through the API's own code (docs_site_publish.publish). Nothing here runs Node
or touches a bucket (a folder store stands in): the runner's side is
docs-platform/test/runner.test.mjs.
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
from app.models.user import User
from app.services import (docs_build, docs_dispatch, docs_import_job, docs_jobs, docs_site_publish, docs_site_settings,
                          docs_site_store, docs_snapshot)
from app.services.docs_jobs import ASSETS, BUILDS, JOBS, PAGES, SITES, VERSIONS

settings = get_settings()
JS = docs_jobs.get_jobs_settings()
SECRET = "test-docs-job-secret"
_DOCS_R2 = ("docs_r2_bucket", "docs_r2_account_id", "docs_r2_access_key_id", "docs_r2_secret_access_key")


def utc(**kw) -> datetime:
    return datetime.now(timezone.utc) + timedelta(**kw)


# ── snapshot → content folder (pure) ────────────────────────────────────────


def _site(**extra) -> dict:
    st = docs_site_settings.default_settings()
    st["theme"].update({"preset": "editorial", "fonts": {"heading": "newsreader", "body": None}, "mode": "light",
                        "corners": "round", "custom_css": ".x{color:red}",
                        "brand": {"enabled": True, "logo_url": "/docs-assets/logo.png", "logo_dark_url": None,
                                  "colors": ["#d9480f", "#111111"], "accent": None, "accent_dark": None}})
    st["access"] = {"level": "password", "password_hash": "$2b$12$secrethash"}
    return {"_id": ObjectId(), "name": "Acme Rockets", "slug": "acme", "domains": [], "settings": st, "engine_extra": extra}


def _pages() -> list[dict]:
    return [
        {"page_id": "a" * 24, "path": "/", "title": "Home", "description": "Welcome", "markdown": "Hello"},
        {"page_id": "b" * 24, "path": "/guide/start", "title": "Start", "description": "Begin here", "icon": "zap",
         "markdown": "## One\n\nBody", "frontmatter_extra": {"nav": "Start", "anchors": {"old": "one"}, "title": "evil"}},
        {"page_id": "c" * 24, "path": "/guide/secret", "title": "Secret", "description": "", "hidden": True, "markdown": "x"},
        {"page_id": "d" * 24, "path": "/loose", "title": "Loose", "description": "Not in nav", "markdown": "y"},
        {"page_id": "e" * 24, "path": "/../etc", "title": "Bad", "markdown": "z"},
        {"page_id": "f" * 24, "path": "/public/x", "title": "Reserved", "markdown": "z"},
    ]


class SnapshotTests(unittest.TestCase):
    def test_content_folder(self):
        site = _site(description="Rocket docs", headline="Hi", pages={"showDescription": True},
                     redirects={"/old": "/guide/start"}, nav={"Guide": {"icon": "home"}},
                     brand={"logo_alt": "Acme", "logo_tile": True, "favicon_url": "/docs-assets/fav.png"})
        site["settings"]["nav"] = [{"group": "Guide", "pages": ["a" * 24, "b" * 24, "c" * 24, "zz"]}]
        snap = {"site": {"name": "Acme Rockets", "slug": "acme"}, "pages": _pages(), "settings": site["settings"],
                "created_at": datetime(2026, 10, 31, tzinfo=timezone.utc)}
        files, warnings = docs_snapshot.content_files(site, snap, url="https://acme.docs.markdrop.in", ai_api="https://api.markdrop.in")
        self.assertEqual(sorted(files), ["guide/secret.md", "guide/start.md", "index.md", "loose.md", "redirects.json", "site.json"])
        self.assertEqual(len(warnings), 2)  # the ../ path and the reserved /public
        sj = json.loads(files["site.json"])
        self.assertEqual((sj["id"], sj["name"], sj["url"], sj["description"], sj["headline"]),
                         (str(site["_id"]), "Acme Rockets", "https://acme.docs.markdrop.in", "Rocket docs", "Hi"))
        # The home leads the editor's first group but is the engine's front page, not a nav entry;
        # hidden pages are built but not listed; pages no group lists land in "More".
        self.assertEqual(sj["nav"], [{"group": "Guide", "icon": "home", "pages": ["/guide/start"]},
                                     {"group": "More", "pages": ["/loose"]}])
        self.assertEqual(sj["brand"]["logo"], {"light": "/docs-assets/logo.png", "alt": "Acme", "tile": True})
        self.assertEqual((sj["brand"]["accent"], sj["brand"]["favicon"]), ("#d9480f", "/docs-assets/fav.png"))
        self.assertEqual(sj["brand"]["colors"], ["#d9480f", "#111111"])
        self.assertEqual(sj["theme"], {"preset": "editorial", "fonts": {"heading": "newsreader"}, "mode": "light",
                                       "corners": "round", "customCss": ".x{color:red}"})
        self.assertEqual((sj["ai"], sj["pages"], sj["integrations"]), ({"enabled": False}, {"showDescription": True}, {"markdropApp": False}))
        self.assertNotIn("secrethash", files["site.json"])  # access settings never reach the site
        self.assertNotIn("access", sj)
        self.assertEqual(json.loads(files["redirects.json"]), {"/old": "/guide/start"})
        start = files["guide/start.md"]
        self.assertTrue(start.startswith('---\ntitle: "Start"\ndescription: "Begin here"\nupdated: 2026-10-31\nicon: "zap"\n'))
        self.assertIn('nav: "Start"\n', start)
        self.assertIn('anchors: {"old": "one"}\n', start)
        self.assertNotIn("evil", start)  # frontmatter_extra can't override the page's own fields
        self.assertTrue(start.endswith("---\n## One\n\nBody\n"))
        self.assertIn('description: "Secret"', files["guide/secret.md"])  # empty → the title

    def test_ai_on_suggestions_and_brand_off(self):
        site = _site()
        site["settings"]["ai"] = {"enabled": True, "name": "Ask Acme", "suggestions": ["How do I launch?", " ", "Fuel?"]}
        site["settings"]["theme"]["brand"]["enabled"] = False
        files, _ = docs_snapshot.content_files(site, {"pages": [], "settings": site["settings"]}, url="https://u", ai_api="https://api.x")
        sj = json.loads(files["site.json"])
        self.assertEqual(sj["ai"], {"enabled": True, "api": "https://api.x", "site": str(site["_id"]), "assistantName": "Ask Acme"})
        self.assertEqual(sj["home"]["chips"], ["How do I launch?", "Fuel?"])
        self.assertEqual(sj["brand"], {"name": "Acme Rockets", "label": "Docs"})

    def test_pasted_frontmatter_and_yaml_safety(self):
        text = docs_snapshot.page_text({"title": 'Say "hi": now', "description": "a: b # c", "markdown": "---\nnav: Short\n---\n\nBody"}, "2026-01-02")
        self.assertIn('title: "Say \\"hi\\": now"', text)
        self.assertIn('description: "a: b # c"', text)
        self.assertIn('nav: "Short"', text)
        self.assertTrue(text.endswith("---\nBody\n"))

    def test_hosts(self):
        site = _site()
        site["domains"] = [{"host": "Docs.Acme.com", "status": "active"}, {"host": "pending.acme.com", "status": "pending"}]
        self.assertEqual(docs_snapshot.site_hosts(site), ["acme.docs.markdrop.in", "docs.acme.com"])
        self.assertEqual(docs_snapshot.site_hosts(site, "newslug")[0], "newslug.docs.markdrop.in")
        self.assertEqual(docs_snapshot.site_url(site), "https://docs.acme.com")
        with mock.patch.object(JS, "docs_site_host_template", "preview.example.workers.dev"):
            self.assertEqual(docs_snapshot.site_hosts(site)[0], "preview.example.workers.dev")

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
        past = int(time.time()) - 5
        self.assertFalse(docs_jobs.verify_job_token("j1", f"{past}.{docs_jobs._sig(SECRET, 'j1', past)}", secret=SECRET))


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
        patches = [mock.patch.object(settings, k, "") for k in _DOCS_R2]
        # enqueue_job's background kick: these tests drive the dispatcher themselves.
        patches.append(mock.patch.object(settings, "background_workers_enabled", False))
        for k, v in {"docs_job_secret": SECRET, "docs_builder_repo": "", "docs_builder_token": "",
                     "docs_build_targets": "actions,local", "docs_job_max_attempts": 3, "docs_site_host_template": ""}.items():
            patches.append(mock.patch.object(JS, k, v))
        self.store = tempfile.mkdtemp(prefix="docs-store-")
        self.addCleanup(shutil.rmtree, self.store, True)
        patches.append(mock.patch.dict(os.environ, {"MARKDROP_DOCS_STORE_DIR": self.store}))
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        await docs_site_store.ensure_indexes(self.db)
        docs_dispatch.reset_state()
        limiter.reset()
        self.user = User(id="u1", email="u1@example.com", created_at=utc(), updated_at=utc(), name="U One")

    async def asyncTearDown(self):
        database._client, settings.mongodb_db = self._saved
        if env.MONGO:
            await self.client.drop_database(self.db_name)
            self.client.close()

    async def make_site(self, slug="acme", **kw) -> dict:
        t = utc()
        site = {"workspace_id": None, "owner_id": "u1", "name": "Acme", "slug": slug, "status": "draft",
                "source": {"kind": "blank"}, "settings": docs_site_settings.default_settings(), "domains": [],
                "live_build_id": None, "last_published_at": None, "last_published_by": None, "build_seq": 0,
                "created_at": t, "updated_at": t, "deleted_at": None, **kw}
        site["_id"] = (await self.db[SITES].insert_one(site)).inserted_id
        return site

    async def make_page(self, site, path, title="T", md="Body", rev=1) -> ObjectId:
        return (await self.db[PAGES].insert_one({
            "site_id": site["_id"], "path": path, "title": title, "description": "D", "icon": None, "hidden": False,
            "draft": {"markdown": md, "frontmatter_extra": {}, "rev": rev, "updated_by": "u1", "updated_at": utc()},
            "published": None, "lock": None, "created_at": utc(), "deleted_at": None,
        })).inserted_id

    async def publish(self, site) -> tuple[dict, dict]:
        """The API's own publish: snapshot + numbered build + enqueue_job (coalescing)."""
        site = await self.db[SITES].find_one({"_id": site["_id"]})
        out = await docs_site_publish.publish(self.db, site, "owner", self.user, note=None)
        build = await self.db[BUILDS].find_one({"_id": ObjectId(out["id"])})
        job = await self.db[JOBS].find_one({"_id": build["job_id"]})
        return build, job

    async def job(self, kind, site, payload=None, **kw) -> dict:
        """A raw job row (no coalescing): queue tests."""
        row = {"kind": kind, "site_id": site["_id"], "payload": payload or {}, "status": "queued", "attempts": 0,
               "locked_by": None, "locked_until": None, "progress": None, "result": None, "error": None,
               "created_at": utc(), "updated_at": utc(), **kw}
        row["_id"] = (await self.db[JOBS].insert_one(row)).inserted_id
        return row

    def put_manifest(self, site_id: str) -> str:
        h = secrets.token_hex(32)
        os.makedirs(os.path.join(self.store, "manifests"), exist_ok=True)
        with open(os.path.join(self.store, "manifests", f"{h}.json"), "w") as f:
            json.dump({"site": {"id": site_id}, "engine": "e123"}, f)
        return h

    async def run_build(self, job, result) -> dict:
        claimed = await docs_jobs.claim_next(self.db, "w1", target=None)
        self.assertEqual(claimed["_id"], job["_id"])
        await docs_build.start_build(self.db, claimed)
        return await docs_build.finish_build(self.db, claimed, "w1", result)


class QueueTests(DbCase):
    async def test_claim_order_lock_and_one_build_per_site(self):
        a = await self.make_site("a")
        b = await self.make_site("b")
        j1 = await self.job("build", a, target="local")
        j2 = await self.job("build", a, target="local")
        j3 = await self.job("build", b, target="local")
        await self.job("build", b, target="actions")
        got = await docs_jobs.claim_next(self.db, "w1")
        self.assertEqual(got["_id"], j1["_id"])
        self.assertEqual((got["status"], got["locked_by"], got["attempts"]), ("running", "w1", 1))
        # Site a is busy: the next claim skips j2 and takes site b's local job (never the Actions one).
        self.assertEqual((await docs_jobs.claim_next(self.db, "w2"))["_id"], j3["_id"])
        self.assertIsNone(await docs_jobs.claim_next(self.db, "w3"))
        # Only the holder can report or renew.
        self.assertFalse(await docs_jobs.set_progress(self.db, j1["_id"], "w2", {"step": "x"}))
        self.assertTrue(await docs_jobs.set_progress(self.db, j1["_id"], "w1", {"step": "build", "done": 1, "total": 4, "message": "m" * 500}))
        self.assertEqual(len((await self.db[JOBS].find_one({"_id": j1["_id"]}))["progress"]["message"]), 200)
        self.assertTrue(await docs_jobs.complete(self.db, j1["_id"], "w1", {"ok": True}))
        self.assertEqual((await docs_jobs.claim_next(self.db, "w3"))["_id"], j2["_id"])

    async def test_expired_lock_is_reclaimed_then_exhausted(self):
        s = await self.make_site()
        j = await self.job("import", s, target="local")
        for n in (1, 2, 3):
            got = await docs_jobs.claim_next(self.db, f"w{n}")
            self.assertEqual((got["_id"], got["attempts"]), (j["_id"], n))
            await self.db[JOBS].update_one({"_id": j["_id"]}, {"$set": {"locked_until": utc(seconds=-1)}})
            self.assertFalse(await docs_jobs.renew(self.db, j["_id"], "someone-else"))
        self.assertIsNone(await docs_jobs.claim_next(self.db, "w4"))
        self.assertEqual([x["_id"] for x in await docs_jobs.exhausted_jobs(self.db)], [j["_id"]])
        self.assertEqual((await docs_dispatch.run_once(self.db))["failed"], 1)
        row = await self.db[JOBS].find_one({"_id": j["_id"]})
        self.assertEqual(row["status"], "failed")
        self.assertIn("stopped responding", row["error"])

    async def test_release_and_site_race(self):
        s = await self.make_site()
        j1 = await self.job("build", s, target="local")
        j2 = await self.job("build", s, target="local")
        got = await docs_jobs.claim_next(self.db, "w1")
        self.assertTrue(await docs_jobs.release(self.db, got["_id"], "w1"))
        row = await self.db[JOBS].find_one({"_id": j1["_id"]})
        self.assertEqual((row["status"], row["attempts"], row["locked_by"]), ("queued", 0, None))
        # j1 runs (claimed earlier): a runner asking for j2 is told the site is busy.
        await self.db[JOBS].update_one({"_id": j1["_id"]}, {"$set": {"status": "running", "locked_by": "w1",
                                                                      "locked_until": utc(minutes=1), "claimed_at": utc(seconds=-5)}})
        self.assertEqual(await docs_jobs.claim_job(self.db, j2["_id"], "gha-1"), (None, "busy"))
        # Both claimed at once: the later claim hands its job back.
        await self.db[JOBS].update_one({"_id": j2["_id"]}, {"$set": {"status": "running", "locked_by": "x", "claimed_at": utc(),
                                                                      "locked_until": utc(minutes=1)}})
        self.assertFalse(await docs_jobs._settle_site_race(self.db, await self.db[JOBS].find_one({"_id": j2["_id"]}), "x"))
        self.assertEqual((await self.db[JOBS].find_one({"_id": j2["_id"]}))["status"], "queued")

    async def test_claim_job_reasons(self):
        s = await self.make_site()
        j = await self.job("import", s, target="actions")
        self.assertEqual((await docs_jobs.claim_job(self.db, ObjectId(), "r"))[1], "missing")
        self.assertEqual((await docs_jobs.claim_job(self.db, j["_id"], "r1"))[1], "ok")
        self.assertEqual((await docs_jobs.claim_job(self.db, j["_id"], "r1"))[1], "ok")  # the holder asks again
        self.assertEqual((await docs_jobs.claim_job(self.db, j["_id"], "r2"))[1], "taken")
        await docs_jobs.complete(self.db, j["_id"], "r1", {})
        self.assertEqual((await docs_jobs.claim_job(self.db, j["_id"], "r1"))[1], "finished")


class BuildTests(DbCase):
    async def test_coalescing_through_the_api_publish(self):
        s = await self.make_site()
        await self.make_page(s, "/a")
        b1, j1 = await self.publish(s)
        b2, j2 = await self.publish(s)
        self.assertEqual(j1["_id"], j2["_id"])
        self.assertEqual((b1["number"], b2["number"]), (1, 2))
        b1 = await self.db[BUILDS].find_one({"_id": b1["_id"]})
        self.assertEqual((b1["status"], b1["coalesced"]), ("superseded", True))
        job = await self.db[JOBS].find_one({"_id": j1["_id"]})
        self.assertEqual((job["payload"]["build_id"], job["payload"]["number"]), (str(b2["_id"]), 2))
        # The build is running: later publishes give exactly one follow-up job, of the latest content.
        await self.db[JOBS].update_one({"_id": j1["_id"]}, {"$set": {"status": "running"}})
        b3, j3 = await self.publish(s)
        b4, j4 = await self.publish(s)
        self.assertNotEqual(j3["_id"], j1["_id"])
        self.assertEqual(j3["_id"], j4["_id"])
        self.assertEqual(await self.db[JOBS].count_documents({"site_id": s["_id"], "kind": "build"}), 2)
        self.assertEqual((await self.db[JOBS].find_one({"_id": j3["_id"]}))["payload"]["build_id"], str(b4["_id"]))

    async def test_spec_finish_and_supersede(self):
        s = await self.make_site()
        home = await self.make_page(s, "/", "Home")
        a = await self.make_page(s, "/guide/a", "A", rev=3)
        await self.db[SITES].update_one({"_id": s["_id"]}, {"$set": {"settings.nav": [{"group": "G", "pages": [str(home), str(a)]}]}})
        b1, j1 = await self.publish(s)
        job = await docs_jobs.claim_next(self.db, "w1", target=None)
        build = await docs_build.start_build(self.db, job)
        self.assertEqual(build["status"], "building")
        spec = await docs_build.build_spec(self.db, job, build)
        self.assertEqual(spec["publish"], {"site": str(s["_id"]), "hosts": ["acme.docs.markdrop.in"]})
        self.assertEqual(spec["build"]["number"], 1)
        self.assertEqual(json.loads(spec["bundle"]["files"]["site.json"])["nav"], [{"group": "G", "pages": ["/guide/a"]}])
        self.assertEqual(sorted(spec["bundle"]["files"]), ["guide/a.md", "index.md", "site.json"])
        h1 = "1" * 64
        out = await docs_build.finish_build(self.db, job, "w1", {"ok": True, "manifest_hash": h1, "engine": "e1",
                                                                   "stats": {"pages": 2, "objects": 9, "uploaded": 9, "bytes": 100, "ms": 5, "x": "no"},
                                                                   "timings": {"nextBuild": 1, "bad": "x"}})
        self.assertTrue(out["ok"])
        b = await self.db[BUILDS].find_one({"_id": b1["_id"]})
        self.assertEqual((b["status"], b["manifest_hash"], b["stats"], b["timings"]),
                         ("live", h1, {"pages": 2, "objects": 9, "uploaded": 9, "bytes": 100, "ms": 5}, {"nextBuild": 1}))
        site = await self.db[SITES].find_one({"_id": s["_id"]})
        self.assertEqual((site["live_build_id"], site["status"], site["last_published_by"]), (b1["_id"], "live", "u1"))
        page = await self.db[PAGES].find_one({"_id": a})
        self.assertEqual((page["published"]["rev"], page["published"]["published_build_id"]), (3, b1["_id"]))
        self.assertEqual((await self.db[JOBS].find_one({"_id": j1["_id"]}))["status"], "done")
        # The API sees no changes now.
        self.assertEqual((await docs_site_publish.changes(self.db, site))["count"], 0)
        # The next build replaces it.
        b2, j2 = await self.publish(site)
        await self.run_build(j2, {"ok": True, "manifest_hash": "2" * 64, "stats": {}})
        self.assertEqual((await self.db[BUILDS].find_one({"_id": b1["_id"]}))["status"], "superseded")
        self.assertEqual((await self.db[BUILDS].find_one({"_id": b2["_id"]}))["status"], "live")
        kinds = [e["kind"] async for e in self.db["docs_events"].find().sort("ts", 1)]
        self.assertEqual(kinds.count("docs_build_live"), 2)

    async def test_failure_keeps_the_live_build(self):
        s = await self.make_site()
        await self.make_page(s, "/a")
        b1, j1 = await self.publish(s)
        await self.run_build(j1, {"ok": True, "manifest_hash": "1" * 64})
        await self.make_page(s, "/b")
        b2, j2 = await self.publish(s)
        out = await self.run_build(j2, {"ok": False, "error": "next build exited with 1"})
        self.assertFalse(out["ok"])
        self.assertEqual((await self.db[BUILDS].find_one({"_id": b2["_id"]}))["status"], "failed")
        self.assertEqual((await self.db[BUILDS].find_one({"_id": b1["_id"]}))["status"], "live")
        self.assertEqual((await self.db[SITES].find_one({"_id": s["_id"]}))["live_build_id"], b1["_id"])
        j = await self.db[JOBS].find_one({"_id": j2["_id"]})
        self.assertEqual((j["status"], j["error"]), ("failed", "next build exited with 1"))
        # An "ok" without a manifest is a failure too.
        await self.make_page(s, "/c")
        b3, j3 = await self.publish(s)
        self.assertFalse((await self.run_build(j3, {"ok": True}))["ok"])

    async def test_slug_change_drops_the_old_address_and_unpublished_sites_stay_down(self):
        s = await self.make_site("old-name")
        await self.make_page(s, "/a")
        _, j1 = await self.publish(s)
        await self.run_build(j1, {"ok": True, "manifest_hash": "1" * 64})
        store = docs_build.FsPointerStore(self.store)
        store.put_text("hosts/old-name.docs.markdrop.in.json", json.dumps({"site": str(s["_id"])}))
        await self.db[SITES].update_one({"_id": s["_id"]}, {"$set": {"slug": "new-name"}})
        b2, j2 = await self.publish(s)
        spec_hosts = (await docs_snapshot.bundle(self.db, b2))["publish"]["hosts"]
        self.assertEqual(spec_hosts, ["new-name.docs.markdrop.in"])
        out = await self.run_build(j2, {"ok": True, "manifest_hash": "2" * 64})
        self.assertEqual(out["old_hosts_removed"], ["old-name.docs.markdrop.in"])
        self.assertIsNone(store.get_text("hosts/old-name.docs.markdrop.in.json"))
        # Unpublished while a build ran: it finishes without going live.
        b3, j3 = await self.publish(s)
        claimed = await docs_jobs.claim_next(self.db, "w1", target=None)
        await docs_build.start_build(self.db, claimed)
        await docs_site_store.unpublish_site(self.db, await self.db[SITES].find_one({"_id": s["_id"]}))
        out = await docs_build.finish_build(self.db, claimed, "w1", {"ok": True, "manifest_hash": "3" * 64})
        self.assertTrue(out["taken_down"])
        self.assertEqual((await self.db[BUILDS].find_one({"_id": b3["_id"]}))["status"], "superseded")
        self.assertEqual((await self.db[SITES].find_one({"_id": s["_id"]}))["status"], "unpublished")

    async def test_restore_and_unpublish_jobs(self):
        s = await self.make_site()
        sid = str(s["_id"])
        h1, h2 = self.put_manifest(sid), self.put_manifest(sid)
        b1 = (await self.db[BUILDS].insert_one({"site_id": s["_id"], "number": 1, "status": "superseded", "manifest_hash": h1})).inserted_id
        b2 = (await self.db[BUILDS].insert_one({"site_id": s["_id"], "number": 2, "status": "live", "manifest_hash": h2})).inserted_id
        failed = (await self.db[BUILDS].insert_one({"site_id": s["_id"], "number": 3, "status": "failed", "manifest_hash": None})).inserted_id
        await self.db[SITES].update_one({"_id": s["_id"]}, {"$set": {"live_build_id": b2, "status": "live"}})
        store = docs_build.FsPointerStore(self.store)
        store.put_text(f"sites/{sid}/current.json", json.dumps({"manifest": h2}))
        # The API's restore queues a job; the dispatcher runs it here (this process has the store).
        site = await self.db[SITES].find_one({"_id": s["_id"]})
        res = await docs_site_publish.restore_build(self.db, site, self.user, str(b1))
        await docs_dispatch.run_once(self.db)
        job = await self.db[JOBS].find_one({"_id": ObjectId(res["job"]["id"])})
        self.assertEqual((job["status"], job["target"], job["result"]["number"]), ("done", "local", 1))
        ptr = json.loads(store.get_text(f"sites/{sid}/current.json"))
        self.assertEqual((ptr["manifest"], ptr["previous"], ptr["engine"], ptr["restored"]), (h1, h2, "e123", True))
        self.assertEqual(set(ptr), {"manifest", "engine", "publishedAt", "previous", "restored"})
        self.assertEqual(json.loads(store.get_text("hosts/acme.docs.markdrop.in.json")), {"site": sid})
        self.assertEqual((await self.db[BUILDS].find_one({"_id": b1}))["status"], "live")
        self.assertEqual((await self.db[BUILDS].find_one({"_id": b2}))["status"], "superseded")
        self.assertEqual((await self.db[SITES].find_one({"_id": s["_id"]}))["live_build_id"], b1)
        # Direct calls: unchanged, refused cases.
        self.assertTrue((await docs_build.restore_build(self.db, s["_id"], b1, "a", store=store))["unchanged"])
        with self.assertRaises(docs_build.RestoreError):
            await docs_build.restore_build(self.db, s["_id"], failed, "a", store=store)
        other = await self.make_site("other")
        with self.assertRaises(docs_build.RestoreError):
            await docs_build.restore_build(self.db, other["_id"], b1, "a", store=store)
        foreign = self.put_manifest("someone-else")
        b4 = (await self.db[BUILDS].insert_one({"site_id": s["_id"], "number": 4, "status": "superseded", "manifest_hash": foreign})).inserted_id
        with self.assertRaises(docs_build.RestoreError):
            await docs_build.restore_build(self.db, s["_id"], b4, "a", store=store)
        b5 = (await self.db[BUILDS].insert_one({"site_id": s["_id"], "number": 5, "status": "superseded", "manifest_hash": "f" * 64})).inserted_id
        with self.assertRaises(docs_build.RestoreError):
            await docs_build.restore_build(self.db, s["_id"], b5, "a", store=store)
        # Unpublish: the API marks it, the job takes the address and the pointer down (never another site's host).
        store.put_text("hosts/shared.example.json", json.dumps({"site": "another"}))
        await self.db[SITES].update_one({"_id": s["_id"]}, {"$set": {"domains": [{"host": "shared.example", "status": "active"}]}})
        job = await docs_site_store.unpublish_site(self.db, await self.db[SITES].find_one({"_id": s["_id"]}))
        await docs_dispatch.run_once(self.db)
        row = await self.db[JOBS].find_one({"_id": job["_id"]})
        self.assertEqual((row["status"], row["result"]["hosts_removed"]), ("done", ["acme.docs.markdrop.in"]))
        self.assertIsNone(store.get_text("hosts/acme.docs.markdrop.in.json"))
        self.assertIsNone(store.get_text(f"sites/{sid}/current.json"))
        self.assertIsNotNone(store.get_text("hosts/shared.example.json"))


class ImportTests(DbCase):
    def data(self) -> dict:
        return {
            "site": {"name": "Senseless", "description": "Docs", "headline": "Hi", "home": {"start": [{"page": "/g/a"}]},
                     "pages": {"showDescription": True, "icons": True}, "footer": [{"label": "llms.txt", "href": "/llms.txt"}],
                     "brand": {"name": "S", "logo": {"light": "/docs-assets/import/brand/logo.png", "alt": "S", "tile": True},
                               "favicon": "/docs-assets/import/brand/logo.png", "accent": "#535061", "accentDark": "#A09FA8",
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
            "assets": {"files": 2, "bytes": 30, "uploaded": 2, "uploaded_bytes": 30, "items": [
                {"rel": "import/brand/logo.png", "size": 10, "sha256": "a" * 64, "content_type": "image/png"},
                {"rel": "import/g/a/shot.png", "size": 20, "sha256": "b" * 64, "content_type": "image/png"},
                {"rel": "import/g/a/same.png", "size": 20, "sha256": "b" * 64, "content_type": "image/png"}]},
        }

    async def test_apply_import(self):
        s = await self.make_site("senseless", source={"kind": "gitbook", "url": "https://docs.example.com"})
        job = await docs_site_store.enqueue_job(self.db, "import", s["_id"], {"source": "gitbook", "url": "https://docs.example.com"})
        job = await docs_jobs.claim_next(self.db, "w1", target=None)
        spec = docs_import_job.import_spec(job, keep_gifs=True)
        self.assertEqual(spec["import"], {"kind": "gitbook", "url": "https://docs.example.com", "site_id": str(s["_id"]), "keep_gifs": True})
        out = await docs_import_job.apply_import(self.db, job, "w1", self.data())
        self.assertEqual(out["pages"], {"created": 3, "updated": 0, "total": 3, "hidden": 1})
        self.assertEqual(out["skipped"], ["/Bad Path: not a usable page path"])
        a = await self.db[PAGES].find_one({"site_id": s["_id"], "path": "/g/a"})
        home = await self.db[PAGES].find_one({"site_id": s["_id"], "path": "/"})
        self.assertEqual((a["title"], a["icon"], a["hidden"], a["draft"]["rev"], a["draft"]["frontmatter_extra"]), ("A", "zap", False, 1, {"anchors": {"x": "y"}}))
        self.assertIsNone(a["published"])
        self.assertEqual(await self.db[VERSIONS].count_documents({"site_id": s["_id"], "kind": "import"}), 3)
        site = await self.db[SITES].find_one({"_id": s["_id"]})
        st = site["settings"]
        # settings stay the API's model: it still validates (a later PATCH must not fail).
        self.assertEqual(docs_site_settings.validate(st), st)
        self.assertEqual(st["nav"], [{"group": "Getting started", "pages": [str(home["_id"]), str(a["_id"])]}])
        self.assertEqual(st["theme"]["brand"], {"enabled": True, "logo_url": "/docs-assets/import/brand/logo.png", "logo_dark_url": None,
                                                "colors": ["#535061"], "accent": "#535061", "accent_dark": "#a09fa8"})
        x = site["engine_extra"]
        self.assertEqual((x["headline"], x["redirects"], x["pages"], x["nav"]),
                         ("Hi", {"/x": "/g/a"}, {"showDescription": True, "icons": True}, {"Getting started": {"icon": "home"}}))
        self.assertEqual(x["brand"], {"logo_alt": "S", "logo_tile": True, "favicon_url": "/docs-assets/import/brand/logo.png", "og": {"background": "#17131f"}})
        rows = [r async for r in self.db[ASSETS].find({"site_id": s["_id"]}).sort("name", 1)]
        self.assertEqual([(r["name"], r["url"], r["size"]) for r in rows],
                         [("import/brand/logo.png", "/docs-assets/import/brand/logo.png", 10), ("import/g/a/shot.png", "/docs-assets/import/g/a/shot.png", 20)])
        self.assertEqual(await docs_site_store.storage_bytes(self.db, s["_id"]), 30)
        job = await self.db[JOBS].find_one({"_id": job["_id"]})
        self.assertEqual(job["status"], "done")
        rep = job["result"]["report"]
        self.assertEqual(rep["counts"]["altGenerated"], 1)
        self.assertEqual(rep["items"]["unmatchedIcons"], [{"icon": "fa-weird", "pages": ["/g/a"]}])
        self.assertEqual(len(rep["items"]["notes"]), docs_import_job.REPORT_ITEMS)
        self.assertEqual(rep["truncated"], {"notes": 300})
        # What was imported builds: the snapshot writer reads settings + engine_extra back.
        _, j = await self.publish(site)
        spec = await docs_build.build_spec(self.db, j)
        sj = json.loads(spec["bundle"]["files"]["site.json"])
        self.assertEqual(sj["brand"]["logo"], {"light": "/docs-assets/import/brand/logo.png", "alt": "S", "tile": True})
        self.assertEqual((sj["brand"]["favicon"], sj["brand"]["accentDark"], sj["headline"], sj["nav"]),
                         ("/docs-assets/import/brand/logo.png", "#a09fa8", "Hi", [{"group": "Getting started", "icon": "home", "pages": ["/g/a"]}]))
        self.assertIn("redirects.json", spec["bundle"]["files"])
        self.assertIn("g/old.md", spec["bundle"]["files"])
        # Importing again: the same pages get a new draft revision, no duplicates.
        await self.db[JOBS].update_one({"_id": job["_id"]}, {"$set": {"status": "running", "locked_by": "w1"}})
        out = await docs_import_job.apply_import(self.db, job, "w1", self.data())
        self.assertEqual(out["pages"]["updated"], 3)
        self.assertEqual((await self.db[PAGES].find_one({"_id": a["_id"]}))["draft"]["rev"], 2)
        self.assertEqual(await self.db[PAGES].count_documents({"site_id": s["_id"]}), 3)

    async def test_bad_brand_is_dropped_not_fatal(self):
        s = await self.make_site()
        job = await self.job("import", s, {"source": "gitbook", "url": "https://x"}, target="local")
        job = await docs_jobs.claim_next(self.db, "w1")
        data = self.data()
        data["site"]["brand"]["accent"] = "not-a-colour"
        out = await docs_import_job.apply_import(self.db, job, "w1", data)
        self.assertTrue(out["ok"])
        self.assertIn("the imported brand (logo or colour) couldn't be used", out["skipped"])
        self.assertFalse((await self.db[SITES].find_one({"_id": s["_id"]}))["settings"]["theme"]["brand"]["enabled"])


class DispatchTests(DbCase):
    async def test_routing(self):
        s = await self.make_site()
        restore = await self.job("restore", s)
        unpub = await self.job("unpublish", s)
        imp = await self.job("import", s, {"source": "gitbook", "url": "https://docs.x"})
        build = await self.job("build", s)

        async def small(url):
            return 12

        async def big(url):
            return 300

        self.assertEqual((await docs_dispatch.choose_target(self.db, restore))[0], "local")
        self.assertEqual((await docs_dispatch.choose_target(self.db, unpub))[0], "local")
        self.assertEqual((await docs_dispatch.choose_target(self.db, imp, probe=small))[0], "local")
        # Actions not configured: big imports and builds fall back to the server.
        self.assertEqual(await docs_dispatch.choose_target(self.db, imp, probe=big), ("local", "actions unavailable: the builder repo isn't configured"))
        self.assertEqual((await docs_dispatch.choose_target(self.db, build))[1], "fallback: the builder repo isn't configured")
        with mock.patch.object(JS, "docs_builder_repo", "o/r"), mock.patch.object(JS, "docs_builder_token", "t"):
            self.assertEqual((await docs_dispatch.choose_target(self.db, imp, probe=big))[0], "actions")
            self.assertEqual((await docs_dispatch.choose_target(self.db, build))[0], "actions")
            # The month's minutes are used up → local.
            await self.job("build", s, status="done", target="actions", finished_at=utc(), actions_minutes=1800)
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
            j1 = await self.job("build", s)
            await docs_dispatch.run_once(self.db, client=client)
            row = await self.db[JOBS].find_one({"_id": j1["_id"]})
            self.assertEqual((row["target"], row["dispatch_attempts"]), ("actions", 1))
            body = json.loads(calls[0].content)
            self.assertEqual(str(calls[0].url), "https://api.github.com/repos/acme/builder/actions/workflows/docs-job.yml/dispatches")
            self.assertEqual(calls[0].headers["authorization"], "Bearer ghp_x")
            self.assertEqual((body["ref"], body["inputs"]["job_id"], body["inputs"]["site_id"], body["inputs"]["kind"], body["inputs"]["api_base"]),
                             ("main", str(j1["_id"]), str(s["_id"]), "build", "https://api.markdrop.in"))
            self.assertTrue(docs_jobs.verify_job_token(str(j1["_id"]), body["inputs"]["token"]))
            await docs_dispatch.run_once(self.db, client=client)  # not re-sent inside the retry window
            self.assertEqual(len(calls), 1)
            # Another site's build: the dispatch fails → Actions is marked down → the build goes local.
            other = await self.make_site("other")
            j2 = await self.job("build", other)
            await docs_dispatch.run_once(self.db, client=client)
            row = await self.db[JOBS].find_one({"_id": j2["_id"]})
            self.assertEqual((row["target"], row["fallback"], row["dispatch_error"][:8]), ("local", True, "HTTP 500"))
            # Actions back (and 2 minutes passed): a fallback build still waiting returns to it.
            docs_dispatch.reset_state()
            await self.db[JOBS].update_one({"_id": j2["_id"]}, {"$set": {"routed_at": utc(minutes=-3)}})
            calls.clear()
            client2 = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: (calls.append(r), httpx.Response(204))[1]))
            await docs_dispatch.run_once(self.db, client=client2)
            await docs_dispatch.run_once(self.db, client=client2)
            self.assertEqual((await self.db[JOBS].find_one({"_id": j2["_id"]}))["target"], "actions")
            self.assertEqual(len(calls), 1)

    async def test_kick_from_enqueue(self):
        s = await self.make_site()
        await self.make_page(s, "/a")
        with mock.patch.object(settings, "background_workers_enabled", True), \
                mock.patch.object(JS, "docs_build_targets", "local"):
            _, job = await self.publish(s)
            from app.services import docs_site_jobs

            for t in list(docs_site_jobs._KICKS):
                await t
        self.assertEqual((await self.db[JOBS].find_one({"_id": job["_id"]}))["target"], "local")

    async def test_sweeper(self):
        s = await self.make_site()
        await self.make_page(s, "/a")
        b, j = await self.publish(s)
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
        old = await self.job("import", s, created_at=utc(hours=-5))
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
        b, j = await self.publish(s)
        url = f"/api/v1/internal/docs-jobs/{j['_id']}"
        r = await self.http.get(url + "?runner=gha-1", headers=self.auth(j["_id"], docs_jobs.job_token(str(ObjectId()))))
        self.assertEqual(r.status_code, 401)
        self.assertEqual((await self.http.get(url + "?runner=gha-1")).status_code, 401)
        r = await self.http.get(url + "?runner=gha-1", headers=self.auth(j["_id"]))
        self.assertEqual(r.status_code, 200, r.text)
        spec = r.json()
        self.assertEqual((spec["job"]["kind"], spec["build"]["number"]), ("build", 1))
        self.assertIn("a.md", spec["bundle"]["files"])
        self.assertEqual((await self.db[BUILDS].find_one({"_id": b["_id"]}))["status"], "building")
        self.assertEqual((await self.http.get(url + "?runner=gha-2", headers=self.auth(j["_id"]))).status_code, 409)
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
        self.assertEqual((await self.http.get(url + "?runner=gha-1", headers=self.auth(j["_id"]))).status_code, 410)
        r = await self.http.post(url + "/result", headers=self.auth(j["_id"]), json={"runner": "gha-1", "ok": True})
        self.assertEqual(r.status_code, 410)

    async def test_import_round_trip_and_failure(self):
        s = await self.make_site()
        j = await self.job("import", s, {"source": "gitbook", "url": "https://docs.example.com"}, target="actions")
        url = f"/api/v1/internal/docs-jobs/{j['_id']}"
        spec = (await self.http.get(url + "?runner=r", headers=self.auth(j["_id"]))).json()
        self.assertEqual(spec["import"]["url"], "https://docs.example.com")
        r = await self.http.post(url + "/import-result", headers=self.auth(j["_id"]), json={"runner": "r", "ok": True, "import": ImportTests.data(self)})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["result"]["pages"]["created"], 3)
        self.assertEqual(await self.db[PAGES].count_documents({"site_id": s["_id"]}), 3)
        j2 = await self.job("import", s, {"source": "gitbook", "url": "https://docs.example.com"}, target="actions")
        url2 = f"/api/v1/internal/docs-jobs/{j2['_id']}"
        await self.http.get(url2 + "?runner=r", headers=self.auth(j2["_id"]))
        r = await self.http.post(url2 + "/result", headers=self.auth(j2["_id"]), json={"runner": "r", "ok": False, "error": "no llms.txt"})
        self.assertEqual(r.status_code, 200)
        row = await self.db[JOBS].find_one({"_id": j2["_id"]})
        self.assertEqual((row["status"], row["error"]), ("failed", "no llms.txt"))

    async def test_server_jobs_and_disabled_without_secret(self):
        s = await self.make_site()
        j = await self.job("restore", s, target="local")
        r = await self.http.get(f"/api/v1/internal/docs-jobs/{j['_id']}?runner=r", headers=self.auth(j["_id"]))
        self.assertEqual(r.status_code, 409)
        self.assertEqual((await self.db[JOBS].find_one({"_id": j["_id"]}))["status"], "queued")
        with mock.patch.object(JS, "docs_job_secret", ""):
            r = await self.http.get(f"/api/v1/internal/docs-jobs/{j['_id']}?runner=r", headers={"authorization": "Bearer 1.x"})
        self.assertEqual(r.status_code, 503)


if __name__ == "__main__":
    unittest.main()
