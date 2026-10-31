"""Markdrop Guides in Markdrop's own analytics: route shapes in the first-party beat, readable
Journeys labels, the server-side usage events (a failed import, durations, no source URLs) and the
admin's Guides adoption numbers (feature usage and the users list)."""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from tests import _email_env as env  # noqa: F401  (pins settings first)

import httpx
import jwt
from bson import ObjectId

from app.config import get_settings
from app.main import app
from app.routers import admin as admin_router
from app.services import docs_jobs, journeys, traffic
from app.services.docs_site_store import EVENTS, JOBS, SITES

settings = get_settings()
SITE = "6650f2c4a1b2c3d4e5f60718"


def now() -> datetime:
    return datetime.now(timezone.utc)


class GuidesShapes(unittest.TestCase):
    def test_beat_paths_are_route_shapes(self):
        host = "markdrop.in"
        for root in ("guides", "docs-studio"):
            self.assertEqual(traffic.clean_path(f"/{root}", host), f"/{root}")
            self.assertEqual(traffic.clean_path(f"/{root}/new?ws=abc", host), f"/{root}/new")
            self.assertEqual(traffic.clean_path(f"/{root}/members", host), f"/{root}/members")
            self.assertEqual(traffic.clean_path(f"/{root}/{SITE}?page=p1", host), f"/{root}/[site]")
            for s in ("design", "publish", "settings", "import", "insights"):
                self.assertEqual(traffic.clean_path(f"/{root}/{SITE}/{s}", host), f"/{root}/[site]/{s}")
            self.assertEqual(traffic.clean_path(f"/{root}/{SITE}/x/y", host), f"/{root}/[site]/[other]")
        # Still a document.
        self.assertEqual(traffic.clean_path("/guidesXy", host), "/[slug]")

    def test_journeys_titles_and_labels(self):
        self.assertEqual(journeys.app_title("/guides/[site]/publish"), "Guides · publish")
        self.assertEqual(journeys.app_title("/docs-studio/[site]"), "Guides · editor")
        self.assertEqual(journeys.app_title("/guides"), "Guides · all sites")
        page = {"title": "Guides · editor", "doc": None}
        d = journeys.describe("guide_created", {"source": "import", "workspace": True}, None, page)
        self.assertEqual((d["kind"], d["label"], d["detail"]), ("connect", "Guides: created a site", "imported from GitBook · in a workspace"))
        d = journeys.describe("guide_ask_ai_toggled", {"enabled": True}, None, page)
        self.assertEqual(d["label"], "Guides: turned Ask AI on")
        d = journeys.describe("guide_publish_requested", {"note": False}, None, page)
        self.assertEqual((d["kind"], d["detail"]), ("publish", "Guides · editor"))
        d = journeys.describe("guide_something_new", {}, None, page)
        self.assertTrue(d["label"].startswith("Guides: "))
        for p in ("template", "preset", "mode", "brand", "css", "enabled", "role", "scope", "note"):
            self.assertIn(p, journeys.EVENT_PROPS)

    def test_duration_bucket(self):
        t = now()
        self.assertEqual(docs_jobs.duration_bucket(t - timedelta(seconds=30), t), "<1m")
        self.assertEqual(docs_jobs.duration_bucket(t - timedelta(minutes=3), t), "1-5m")
        self.assertEqual(docs_jobs.duration_bucket(t - timedelta(minutes=10), t), "5-15m")
        self.assertEqual(docs_jobs.duration_bucket(t - timedelta(minutes=30), t), "15-60m")
        self.assertEqual(docs_jobs.duration_bucket(t - timedelta(hours=2), t), ">1h")
        self.assertIsNone(docs_jobs.duration_bucket(None))


@unittest.skipUnless(env.MONGO, "MongoDB not reachable")
class GuidesUsage(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.name = env.new_db_name()
        self.client, self.db = await env.make_db(self.name)
        app.dependency_overrides[admin_router.get_db] = lambda: self.db
        tok = jwt.encode({"sub": "admin", "exp": now() + timedelta(hours=1)}, settings.admin_secret, algorithm="HS256")
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://api.markdrop.in",
                                      headers={"Authorization": f"Bearer {tok}"})

    async def asyncTearDown(self):
        app.dependency_overrides.clear()
        await self.http.aclose()
        await self.client.drop_database(self.name)
        self.client.close()

    async def test_a_failed_import_is_logged_without_its_source(self):
        site = (await self.db[SITES].insert_one({"workspace_id": None, "owner_id": "u1", "deleted_at": None})).inserted_id
        job = (await self.db[JOBS].insert_one({
            "kind": "import", "site_id": site, "status": "running", "locked_by": "w1",
            "payload": {"source": "gitbook", "url": "https://docs.acme.example", "requested_by": "u1"},
            "created_at": now() - timedelta(minutes=2),
        })).inserted_id
        self.assertTrue(await docs_jobs.fail(self.db, job, "w1", "the site was unreachable"))
        ev = await self.db[EVENTS].find_one({"kind": "docs_import_failed"})
        self.assertEqual((ev["site_id"], ev["user_id"]), (site, "u1"))
        self.assertEqual(ev["meta"], {"source": "gitbook", "took": "1-5m"})
        self.assertNotIn("acme", repr(ev))
        # A build's failure is the build runner's to log; a second fail() matches nothing.
        build = (await self.db[JOBS].insert_one({"kind": "build", "site_id": site, "status": "running", "locked_by": "w1",
                                                 "payload": {}, "created_at": now()})).inserted_id
        self.assertTrue(await docs_jobs.fail(self.db, build, "w1", "x"))
        self.assertFalse(await docs_jobs.fail(self.db, job, "w1", "again"))
        self.assertEqual(await self.db[EVENTS].count_documents({}), 1)

    async def test_admin_reports_guides_adoption(self):
        alice = ObjectId()
        bob = ObjectId()
        await self.db["users"].insert_many([
            {"_id": alice, "email": "alice@example.com", "created_at": now()},
            {"_id": bob, "email": "bob@example.com", "created_at": now() - timedelta(days=1)},
        ])
        a, b = str(alice), str(bob)
        s1, s2, s3 = ObjectId(), ObjectId(), ObjectId()
        await self.db[SITES].insert_many([
            {"_id": s1, "owner_id": a, "status": "live", "source": {"kind": "gitbook"}, "deleted_at": None},
            {"_id": s2, "owner_id": a, "status": "draft", "source": {"kind": "template"}, "deleted_at": None},
            {"_id": s3, "owner_id": b, "status": "unpublished", "source": {"kind": "blank"}, "deleted_at": now()},
        ])
        ev = lambda kind, site, user: {"kind": kind, "site_id": site, "user_id": user, "workspace_id": None, "ts": now()}  # noqa: E731
        await self.db[EVENTS].insert_many([
            ev("docs_site_created", s1, a), ev("docs_site_created", s2, a), ev("docs_site_created", s3, b),
            ev("docs_imported", s1, a), ev("docs_import_finished", s1, a),
            ev("docs_published", s1, a), ev("docs_build_live", s1, a), ev("docs_published", s1, a),
            ev("docs_build_failed", s1, a), ev("docs_review_submitted", s2, b), ev("docs_review_approved", s2, a),
            ev("docs_role_granted", s2, None),
        ])
        await self.db["ai_requests"].insert_many([
            {"feature": "docs_ask", "outcome": "answered", "site": str(s1), "ts": now()},
            {"feature": "docs_ask", "outcome": "answered", "site": str(s1), "ts": now()},
            {"feature": "docs_ask", "outcome": "limit", "site": str(s1), "ts": now()},
            {"feature": "docs_ask", "outcome": "answered", "site": "markdrop", "ts": now()},
        ])

        r = await self.http.get("/api/v1/admin/feature-usage")
        self.assertEqual(r.status_code, 200, r.text)
        g = r.json()["guides"]
        self.assertEqual(g["sites"], 2)
        self.assertEqual(g["sites_live"], 1)
        self.assertEqual(g["sites_deleted"], 1)
        self.assertEqual(g["by_source"], {"gitbook": 1, "template": 1})
        self.assertEqual((g["creators"], g["publishers"], g["publishes"]), (2, 1, 3))
        self.assertEqual((g["builds_live"], g["builds_failed"], g["reviews_submitted"]), (1, 1, 1))
        self.assertEqual((g["imports"], g["imports_finished"], g["imports_failed"]), (1, 1, 0))
        self.assertEqual((g["ai_answers"], g["ai_sites"]), (2, 1))

        users = {u["email"]: u for u in (await self.http.get("/api/v1/admin/users")).json()["users"]}
        self.assertEqual((users["alice@example.com"]["guides_site_count"], users["alice@example.com"]["guides_publish_count"]), (2, 3))
        self.assertEqual((users["bob@example.com"]["guides_site_count"], users["bob@example.com"]["guides_publish_count"]), (0, 0))

    async def test_admin_feature_usage_needs_the_admin_token(self):
        r = await self.http.get("/api/v1/admin/feature-usage", headers={"Authorization": "Bearer nope"})
        self.assertEqual(r.status_code, 401)


if __name__ == "__main__":
    unittest.main()
