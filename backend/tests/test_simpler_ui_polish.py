"""Simpler UI polish: document password / expiry from the share dialog
(``PATCH /documents/{slug}/settings``), the share dialog's real addresses on
``GET …/access``, and titles taken from the text when none was typed.

The settings route must behave exactly like the password / expiry fields of
``PUT /documents/{slug}`` (services/transitions.py): a new password narrows
(epoch bump, bytes closed first, purge awaited), removing one widens, an
expiry books its purge — and only the owner or the edit secret may do it.
"""

from __future__ import annotations

from datetime import timedelta
from unittest import mock

from tests._access_env import ES_SECRET, PASSWORD, AccessWorld, now, settings

from app.services.document import title_from_markdown


class DocumentSettings(AccessWorld):
    async def patch(self, slug: str, body: dict, headers: dict | None = None):
        return await self.http.patch(f"/api/v1/documents/{slug}/settings", json=body, headers=headers or {})

    async def test_only_the_owner_or_the_edit_secret(self):
        d = await self.mkdoc("L")
        slug = d["slug"]
        for who, status in (("ge", 403), ("gv", 403), ("wm", 403), ("wa", 403), ("wo", 403), ("wv", 403)):
            r = await self.patch(slug, {"read_password": "nope-123"}, self.session(who))
            self.assertEqual(r.status_code, status, (who, r.text))
        # A W document: someone who can't read it learns nothing (404).
        w = await self.mkdoc("W")
        r = await self.patch(w["slug"], {"expires_in": "7d"}, self.session("stranger"))
        self.assertEqual(r.status_code, 404)
        r = await self.patch("no-such-doc", {"expires_in": "7d"}, self.session("owner"))
        self.assertEqual(r.status_code, 404)
        # Anonymous without the secret, and a tenant session: account needed.
        self.assertEqual((await self.patch(slug, {"expires_in": "7d"})).status_code, 401)
        r = await self.patch(slug, {"expires_in": "7d"}, self.tenant("owner", "W1"))
        self.assertEqual(r.status_code, 401)
        after = await self.doc(slug)
        self.assertIsNone(after["read_password_hash"])
        self.assertIsNone(after["expires_at"])
        self.assertEqual(after["access_epoch"], 0)

        r = await self.patch(slug, {"expires_in": "7d"}, self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        # The edit secret (owner-less documents, and owned ones per D4).
        u = await self.mkdoc("UL", owner=None)
        r = await self.patch(u["slug"], {"read_password": "pw-new-1"}, {"X-Edit-Secret": ES_SECRET})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["is_password_protected"])

    async def test_password_added_narrows(self):
        d = await self.mkdoc("UL")
        slug = d["slug"]
        self.assertEqual((await self.get(slug)).status_code, 200)
        await self.db["revalidate_jobs"].delete_many({})
        with mock.patch.object(settings, "page_revalidate_enabled", True):
            r = await self.patch(slug, {"read_password": "s3cret-pw"}, self.session("owner"))
            self.assertEqual(r.status_code, 200, r.text)
            # The purge was sent before the answer came back (B2).
            self.assertIn({"slug": slug}, self.posted)
        self.assertTrue(r.json()["is_password_protected"])
        self.assertIn(f"doc:{slug}", await self.jobs())
        raw = await self.doc(slug)
        self.assertEqual(raw["access_epoch"], 1)
        self.assertFalse(raw["access_dirty"])
        r = await self.get(slug)
        self.assertEqual((r.status_code, r.headers.get("X-Markdrop-Gate")), (401, "password"))
        self.assertEqual((await self.get(slug, {"X-Read-Password": "s3cret-pw"})).status_code, 200)
        self.assertEqual((await self.get(slug, {"X-Read-Password": PASSWORD})).status_code, 403)

    async def test_password_added_closes_a_files_bytes_first(self):
        d = await self.mkdoc("UL", kind="artifact")
        self.assertTrue(self.r2.objects[d["blob_key"]]["public"])
        r = await self.patch(d["slug"], {"read_password": "s3cret-pw"}, self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(self.r2.objects[d["blob_key"]]["public"])
        self.assertEqual((await self.doc(d["slug"]))["access_epoch"], 1)

    async def test_password_removed_widens(self):
        d = await self.mkdoc("ULP", kind="artifact")
        slug = d["slug"]
        self.assertFalse(self.r2.objects[d["blob_key"]]["public"])
        self.assertEqual((await self.get(slug)).status_code, 401)
        r = await self.patch(slug, {"remove_password": True}, self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(r.json()["is_password_protected"])
        raw = await self.doc(slug)
        self.assertIsNone(raw["read_password_hash"])
        self.assertEqual(raw["access_epoch"], 0)   # widening never bumps the epoch
        self.assertTrue(self.r2.objects[d["blob_key"]]["public"])
        self.assertEqual((await self.get(slug)).status_code, 200)
        self.assertIn(f"doc:{slug}", await self.jobs())
        # "" removes too.
        m = await self.mkdoc("ULP")
        r = await self.patch(m["slug"], {"read_password": ""}, self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((await self.get(m["slug"])).status_code, 200)

    async def test_expiry_books_the_purge(self):
        d = await self.mkdoc("L")
        slug = d["slug"]
        await self.db["revalidate_jobs"].delete_many({})
        r = await self.patch(slug, {"expires_in": "7d"}, self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        exp = (await self.doc(slug))["expires_at"]
        if exp.tzinfo is None:
            from datetime import timezone

            exp = exp.replace(tzinfo=timezone.utc)
        self.assertAlmostEqual((exp - now()).total_seconds(), 7 * 86400, delta=120)
        job = await self.db["revalidate_jobs"].find_one({"key": f"doc:{slug}", "scheduled": True})
        self.assertIsNotNone(job)
        due = job["next_at"] if job["next_at"].tzinfo else job["next_at"].replace(tzinfo=exp.tzinfo)
        self.assertGreater(due, exp)
        # The workspace listing goes too.
        self.assertIsNotNone(await self.db["revalidate_jobs"].find_one(
            {"key": f"tag:wsl:{self.ws['W1']}", "scheduled": True}))

        r = await self.patch(slug, {"expires_in": "1h"}, self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        when = now() + timedelta(days=3)
        r = await self.patch(slug, {"expires_in": "custom", "custom_expires_at": when.isoformat()},
                             self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        r = await self.patch(slug, {"expires_in": "never"}, self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIsNone((await self.doc(slug))["expires_at"])

    async def test_bad_dates_and_empty_bodies_are_422(self):
        d = await self.mkdoc("L")
        slug = d["slug"]
        owner = self.session("owner")
        past = (now() - timedelta(hours=2)).isoformat()
        for body in ({"expires_in": "custom", "custom_expires_at": past},
                     {"custom_expires_at": past},
                     {"expires_in": "custom"},
                     {"expires_in": "2y"},
                     {}):
            r = await self.patch(slug, body, owner)
            self.assertEqual(r.status_code, 422, (body, r.text))
        raw = await self.doc(slug)
        self.assertIsNone(raw["expires_at"])
        self.assertEqual(raw["rev"], 1)


class AccessAddresses(AccessWorld):
    async def test_access_names_the_real_addresses(self):
        d = await self.mkdoc("L")
        await self.db["documents"].update_one({"_id": d["_id"]}, {"$set": {"folder_path": ["guides"]}})
        r = await self.http.get(f"/api/v1/documents/{d['slug']}/access", headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertTrue(body["url"].endswith(f"/{d['slug']}"))
        self.assertEqual(body["workspace_url"], f"https://docs.acme.test/guides/{d['slug']}")
        self.assertIsNone(body["expires_at"])

        u = await self.mkdoc("UL")
        body = (await self.http.get(f"/api/v1/documents/{u['slug']}/access", headers=self.session("owner"))).json()
        self.assertIsNone(body["workspace_url"])
        self.assertTrue(body["url"].endswith(f"/{u['slug']}"))

    async def test_no_live_domain_no_workspace_url(self):
        await self.db["domains"].update_many({"workspace_id": self.ws["W1"]}, {"$set": {"status": "pending"}})
        d = await self.mkdoc("L")
        body = (await self.http.get(f"/api/v1/documents/{d['slug']}/access", headers=self.session("owner"))).json()
        self.assertIsNone(body["workspace_url"])


class TitleFromContent(AccessWorld):
    def test_rules(self):
        self.assertEqual(title_from_markdown("# Hello world\n\ntext"), "Hello world")
        self.assertEqual(title_from_markdown("intro line\n\n# The heading #\n"), "The heading")
        self.assertEqual(title_from_markdown("## Sub only\nbody"), "Sub only")
        self.assertEqual(title_from_markdown("\n\n  > quoted first line  \n"), "quoted first line")
        self.assertEqual(title_from_markdown("```\n# not a title\n```\nplain"), "plain")
        self.assertEqual(title_from_markdown("---\ntitle: x\n---\n# Real\n"), "Real")
        self.assertIsNone(title_from_markdown("   \n\n"))
        long = title_from_markdown("x" * 500)
        self.assertEqual(len(long), 120)

    async def test_create_derives_a_missing_title(self):
        r = await self.http.post("/api/v1/documents", json={"content": "Some intro\n\n# Launch plan\n\nBody"})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["title"], "Launch plan")
        self.assertEqual((await self.doc(r.json()["slug"]))["title"], "Launch plan")

        r = await self.http.post("/api/v1/documents", json={"content": "No heading here, " + "y" * 300},
                                 headers=self.session("owner"))
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(len(r.json()["title"]), 120)
        self.assertTrue(r.json()["title"].startswith("No heading here, "))

        r = await self.http.post("/api/v1/documents", json={"content": "# From text", "title": "Typed"})
        self.assertEqual(r.json()["title"], "Typed")
        r = await self.http.post("/api/v1/documents", json={"content": "# From text", "title": ""})
        self.assertEqual(r.json()["title"], "From text")

    async def test_encrypted_documents_keep_a_null_title(self):
        r = await self.http.post("/api/v1/documents", json={"content": "# looks like a heading", "encrypted": True})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertIsNone(r.json()["title"])
        self.assertIsNone((await self.doc(r.json()["slug"]))["title"])
