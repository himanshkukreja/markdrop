"""Workspaces v2 integration glue: the seams between the three builders.

- domain state changes enqueue `host:<host>` + `wsl:<ws>` purges (revalidate outbox);
- one liveness rule (`domain.is_live`) behind urls / tokens / CORS / MCP;
- `txt_ok` is reported so the UI can say which DNS record is missing;
- top-level folder slugs may not collide with paths a custom domain can't serve
  as folders (`api`, `_next`, `mdp`, `h`, …);
- `/documents/{slug}/access` `can` flags use the §7 names;
- a shared folder's hidden rows keep the document's level (`has_password` says why);
- OG cards are cached 300 s and gated by `access.anonymous_can_read`;
- `/f/<id>` and `/w/<id>` analytics paths are redacted like the frontend does.

Real MongoDB or MARKDROP_TEST_MONGOMOCK=1 (see tests/_mcp_env.py).
"""

from __future__ import annotations

from tests.test_domains_lifecycle import DomainCase

from app.services import domain as domain_service
from app.services import revalidate, traffic, urls


class DomainPurgesAndLiveness(DomainCase):
    async def test_verify_and_lapse_enqueue_host_and_listing_purges(self):
        d = await self.live_domain("docs.acme.com")
        keys = await revalidate.all_keys(self.db)
        self.assertIn("tag:host:docs.acme.com", keys)
        self.assertIn(f"tag:wsl:{self.ws}", keys)

        await self.db["revalidate_jobs"].delete_many({})
        raw = await self.row("docs.acme.com")
        await domain_service.lapse(self.db, raw, self.clock(), "gone")
        keys = await revalidate.all_keys(self.db)
        self.assertEqual(keys, {"tag:host:docs.acme.com", f"tag:wsl:{self.ws}"})
        self.assertTrue(d["live"])

    async def test_remove_enqueues_host_purge(self):
        d = await self.live_domain("docs.acme.com")
        await self.db["revalidate_jobs"].delete_many({})
        r = await self.http.delete(f"/api/v1/workspaces/{self.ws}/domains/{d['id']}", headers=self.auth)
        self.assertIn(r.status_code, (200, 204), r.text)
        self.assertIn("tag:host:docs.acme.com", await revalidate.all_keys(self.db))

    async def test_one_liveness_rule(self):
        await self.live_domain("docs.acme.com")
        row = await self.row("docs.acme.com")
        self.assertTrue(domain_service.is_live(row))
        self.assertTrue(urls.is_live(row))
        self.assertEqual((await urls.live_host(self.db, "Docs.Acme.com."))["host"], "docs.acme.com")
        self.assertEqual(await urls.live_primary_host(self.db, self.ws), "docs.acme.com")

        # A lapsed flag, a cdn kind or a detached row is not live, everywhere.
        for patch in ({"lapsed": True}, {"kind": "cdn"}, {"attached": False}, {"status": "lapsed"}):
            probe = {**row, **patch}
            self.assertFalse(domain_service.is_live(probe), patch)
            self.assertFalse(urls.is_live(probe), patch)
        self.assertTrue(domain_service.is_serving({**row, "kind": "cdn"}))

        await self.db["domains"].update_one({"_id": row["_id"]}, {"$set": {"lapsed": True}})
        self.assertIsNone(await urls.live_host(self.db, "docs.acme.com"))
        self.assertIsNone(await urls.live_primary_host(self.db, self.ws))
        self.assertIsNone(await domain_service.live_app_domain(self.db, "docs.acme.com"))

    async def test_cdn_domain_is_serving_but_not_a_live_app_host(self):
        d = await self.live_domain("cdn.acme.com", kind="cdn")
        self.assertTrue(d["live"])  # the domains tab: it serves files
        self.assertIsNone(await urls.live_host(self.db, "cdn.acme.com"))
        r = await self.http.get("/api/v1/host", params={"host": "cdn.acme.com"})
        self.assertEqual(r.json()["kind"], "cdn")

    async def test_txt_ok_says_which_record_is_missing(self):
        r = await self.add("docs.acme.com")
        did = r.json()["id"]
        self.dns.routing["docs.acme.com"] = "ok"
        body = (await self.verify(did)).json()
        self.assertEqual((body["status"], body["txt_ok"], body["routing_ok"]), ("pending", False, True))
        self.dns.txt["docs.acme.com"] = "ok"
        body = (await self.verify(did)).json()
        self.assertEqual((body["status"], body["txt_ok"]), ("verified", True))
        listed = (await self.http.get(f"/api/v1/workspaces/{self.ws}/domains", headers=self.auth)).json()
        self.assertTrue(listed["domains"][0]["txt_ok"])


class FolderSlugsAndContracts(DomainCase):
    async def folder(self, name: str, parent_id: str | None = None):
        return await self.http.post(f"/api/v1/workspaces/{self.ws}/folders",
                                    json={"name": name, "parent_id": parent_id}, headers=self.auth)

    async def test_top_level_folder_names_that_shadow_tenant_paths_are_refused(self):
        for name in ("api", "mdp", "h", "f", "w", "settings"):
            r = await self.folder(name)
            self.assertEqual(r.status_code, 422, (name, r.text))
        # "_next" slugifies to "next", which is fine; nested reserved names are fine too.
        ok = await self.folder("Guides")
        self.assertEqual(ok.status_code, 201, ok.text)
        nested = await self.folder("mdp", ok.json()["id"])
        self.assertEqual(nested.status_code, 201, nested.text)
        # Renaming a top-level folder onto a reserved name is refused as well.
        r = await self.http.patch(f"/api/v1/workspaces/{self.ws}/folders/{ok.json()['id']}",
                                  json={"name": "api"}, headers=self.auth)
        self.assertEqual(r.status_code, 422, r.text)

    async def test_access_can_flags_use_the_section_7_names(self):
        r = await self.http.post("/api/v1/documents", json={"content": "# Hi"}, headers=self.auth)
        self.assertEqual(r.status_code, 201, r.text)
        slug = r.json()["slug"]
        body = (await self.http.get(f"/api/v1/documents/{slug}/access", headers=self.auth)).json()
        self.assertEqual(set(body["can"]), {"edit", "replace", "settings", "access", "rename",
                                            "delete", "share", "move", "unshare"})
        doc = (await self.http.get(f"/api/v1/documents/{slug}", headers=self.auth)).json()
        self.assertEqual(set(doc["can"]), set(body["can"]))
        self.assertIsInstance(doc["access_epoch"], int)
        self.assertTrue(doc["read_ticket"])

    async def test_narrowing_purges_old_slugs_too(self):
        r = await self.http.post("/api/v1/documents", json={"content": "# Old", "custom_slug": "glue-old"},
                                 headers=self.auth)
        self.assertEqual(r.status_code, 201, r.text)
        r = await self.http.patch("/api/v1/documents/glue-old/slug", json={"new_slug": "glue-new"}, headers=self.auth)
        self.assertEqual(r.status_code, 200, r.text)
        await self.db["revalidate_jobs"].delete_many({})
        r = await self.http.put("/api/v1/documents/glue-new/access/level", json={"level": "private"},
                                headers=self.auth)
        self.assertIn(r.status_code, (200, 204), r.text)
        keys = await revalidate.all_keys(self.db)
        self.assertTrue({"doc:glue-new", "doc:glue-old"} <= keys, keys)

    async def test_og_card_cached_300s_and_gated_by_anonymous_read(self):
        r = await self.http.post("/api/v1/documents", json={"content": "# Secret plans"}, headers=self.auth)
        slug = r.json()["slug"]
        r = await self.http.get(f"/api/v1/og/{slug}.png", params={"e": "0"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["cache-control"], "public, max-age=300")
        r = await self.http.put(f"/api/v1/documents/{slug}/access/level", json={"level": "private"},
                                headers=self.auth)
        self.assertIn(r.status_code, (200, 204), r.text)
        r = await self.http.get(f"/api/v1/og/{slug}.png", params={"e": "x"})
        self.assertEqual(r.headers["cache-control"], "public, max-age=300")


class AnalyticsPaths(DomainCase):
    def test_f_and_w_are_redacted_like_the_frontend(self):
        host = "localhost"
        self.assertEqual(traffic.clean_path("/f/AbC123xyz", host), "/f/[share]")
        self.assertEqual(traffic.clean_path("/f/AbC123xyz/guides/q3", host), "/f/[share]")
        self.assertEqual(traffic.clean_path("/w/65a1b2c3d4e5f6a7b8c9d0e1", host), "/w/[workspace]")
        self.assertEqual(traffic.clean_path("/w/65a1b2c3d4e5f6a7b8c9d0e1/f/65a1b2c3d4e5f6a7b8c9d0e2", host),
                         "/w/[workspace]/f/[folder]")
        self.assertEqual(traffic.clean_path("/f", host), "/f")
        self.assertEqual(traffic.clean_path("/w", host), "/w")
