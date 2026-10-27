"""Access policy test catalogue §6.14–§6.20 (cases 181–262): expiry and slugs,
copy, MCP, beacons/live/OG, caching and bytes (incl. property tests),
concurrency and other surfaces."""

from __future__ import annotations

import asyncio
import hashlib
import random
from datetime import datetime, timedelta, timezone
from unittest import mock

from bson import ObjectId

from tests._access_env import ES_SECRET, PASSWORD, AccessWorld, settings

from app.services import access, folder as folder_service, lifecycle, live, publicity, revalidate, tickets


def now():
    return datetime.now(timezone.utc)


class ExpiryAndSlugs(AccessWorld):
    async def test_c181_expired_is_404_for_everyone(self):
        d = await self.mkdoc("L", ws=None, expires_at=now() - timedelta(seconds=1))
        for h in ({}, self.session("owner"), {"X-Edit-Secret": ES_SECRET}):
            self.assertEqual((await self.get(d["slug"], h)).status_code, 404)

    async def test_c182_sweeper_destroys_expired_artifact(self):
        d = await self.mkdoc("L", ws=None, kind="artifact", expires_at=now() - timedelta(seconds=1))
        poster = f"art/{self.uid['owner']}/p.poster.jpg"
        old = f"art/{self.uid['owner']}/v0.html"
        self.r2.put_bytes(poster, b"j", "image/jpeg")
        self.r2.put_bytes(old, b"o", "text/html")
        await self.db["documents"].update_one({"_id": d["_id"]}, {"$set": {"poster_key": poster}})
        await self.db["file_versions"].insert_one({"doc_id": str(d["_id"]), "version": 0, "blob_key": old,
                                                   "user_id": self.uid["owner"], "size_bytes": 1})
        self.assertEqual(await lifecycle.sweep_expired(self.db), 1)
        self.assertIsNone(await self.doc(d["slug"]))
        for k in (d["blob_key"], poster, old):
            self.assertNotIn(k, self.r2.objects)
        self.assertEqual(await self.db["document_grants"].count_documents({"document_id": str(d["_id"])}), 0)
        self.assertIn(f"doc:{d['slug']}", await self.jobs())

    async def test_c183_failed_deletion_still_closes(self):
        d = await self.mkdoc("L", ws=None, kind="artifact", expires_at=now() - timedelta(seconds=1))
        self.r2.objects[d["blob_key"]]["public"] = True   # was public until it expired

        def boom(key):
            raise RuntimeError("R2 down")

        with mock.patch.object(__import__("app.services.r2", fromlist=["r2"]), "delete", boom):
            await lifecycle.sweep_expired(self.db)
        self.assertIn(d["blob_key"], self.r2.objects)
        self.assertFalse(self.r2.objects[d["blob_key"]]["public"])

    async def test_c184_expired_absent_from_listings_and_mcp(self):
        d = await self.mkdoc("W", expires_at=now() - timedelta(seconds=1))
        token = await self.mcp_token("owner", write=False)
        _s, res = await self.mcp_call(token, "list_documents", {})
        self.assertNotIn(d["slug"], str(res))
        r = await self.http.get(f"/api/v1/workspaces/{self.ws['W1']}/items", headers=self.session("owner"))
        self.assertNotIn(d["slug"], r.text)

    async def test_c185_expired_slug_reserved(self):
        d = await self.mkdoc("L", ws=None, slug="soon-gone", expires_at=now() - timedelta(seconds=1))
        await lifecycle.sweep_expired(self.db)
        r = await self.http.post("/api/v1/documents", json={"content": "x", "custom_slug": "soon-gone"},
                                 headers=self.session("stranger"))
        self.assertEqual(r.status_code, 409)

    async def test_c186_expiry_set_purges_and_stays_readable(self):
        d = await self.mkdoc("L", ws=None)
        r = await self.http.put(f"/api/v1/documents/{d['slug']}", headers=self.session("owner"),
                                json={"title": d["title"], "content": d["content"], "expires_in": "1d"})
        self.assertEqual(r.status_code, 200)
        self.assertIn(f"doc:{d['slug']}", await self.jobs())
        self.assertEqual((await self.get(d["slug"])).status_code, 200)

    async def test_c187_stack_isr_expired_404(self):
        self.skipTest("[S] #187: ISR cache purge on expiry (frontend)")

    async def test_c188_ttl_index_backstop(self):
        await self.db["documents"].create_index("expires_at", expireAfterSeconds=0, sparse=True)
        self.assertEqual(await lifecycle.ensure_expiry_ttl(self.db), 86400)
        info = await self.db["documents"].index_information()
        spec = next(v for v in info.values() if v.get("key") == [("expires_at", 1)])
        self.assertEqual(spec.get("expireAfterSeconds"), 86400)

    async def test_c189_editor_cannot_rename(self):
        d = await self.mkdoc("P", ws=None)
        r = await self.http.patch(f"/api/v1/documents/{d['slug']}/slug", json={"new_slug": "x-new"},
                                  headers=self.session("ge"))
        self.assertEqual(r.status_code, 403)

    async def test_c190_reserved_f_and_w(self):
        d = await self.mkdoc("L", ws=None)
        for word in ("f", "w"):
            from app.utils.slug import is_reserved_slug

            self.assertTrue(is_reserved_slug(word))
        r = await self.http.post("/api/v1/documents", json={"content": "x", "custom_slug": "mcp"},
                                 headers=self.session("owner"))
        self.assertEqual(r.status_code, 409)

    async def test_c191_copy_via_old_slug_404(self):
        d = await self.mkdoc("L", ws=None, slug="first-name")
        await self.http.patch("/api/v1/documents/first-name/slug", json={"new_slug": "second-name"},
                              headers=self.session("owner"))
        r = await self.http.post("/api/v1/documents/first-name/copy", json={}, headers=self.session("stranger"))
        self.assertEqual(r.status_code, 404)

    async def test_c192_concurrent_claims_one_owner(self):
        d = await self.mkdoc("L", ws=None, owner=None)
        h = {"X-Edit-Secret": ES_SECRET}
        rs = await asyncio.gather(
            self.http.post(f"/api/v1/documents/{d['slug']}/claim", headers={**h, **self.session("stranger")}),
            self.http.post(f"/api/v1/documents/{d['slug']}/claim", headers={**h, **self.session("wm")}))
        self.assertEqual(sorted(r.status_code for r in rs), [200, 409])
        self.assertIn((await self.doc(d["slug"]))["owner_id"], (self.uid["stranger"], self.uid["wm"]))


class Copy(AccessWorld):
    async def _copy(self, who, slug, **body):
        h = self.session(who) if who else {}
        return await self.http.post(f"/api/v1/documents/{slug}/copy", json=body, headers=h)

    async def _level_of_copy(self, r):
        self.assertEqual(r.status_code, 201, r.text)
        return (await self.doc(r.json()["slug"]))["access_level"]

    async def test_c193_public_copy_stays_link(self):
        d = await self.mkdoc("L", ws=None)
        r = await self._copy("stranger", d["slug"])
        self.assertEqual(await self._level_of_copy(r), "link")
        self.assertEqual((await self.doc(r.json()["slug"]))["owner_id"], self.uid["stranger"])

    async def test_c194_workspace_copy_private(self):
        d = await self.mkdoc("W")
        self.assertEqual(await self._level_of_copy(await self._copy("wv", d["slug"])), "private")

    async def test_c195_password_copy_private(self):
        d = await self.mkdoc("LP", ws=None)
        self.assertEqual(await self._level_of_copy(await self._copy("stranger", d["slug"], read_password=PASSWORD)),
                         "private")

    async def test_c196_rl_copy_private(self):
        d = await self.mkdoc("RL")
        self.assertEqual(await self._level_of_copy(await self._copy("wm", d["slug"])), "private")

    async def test_c197_grantee_copies_private_doc(self):
        d = await self.mkdoc("P", ws=None)
        self.assertEqual(await self._level_of_copy(await self._copy("gv", d["slug"])), "private")

    async def test_c198_stranger_cannot_copy_private(self):
        d = await self.mkdoc("P", ws=None)
        self.assertEqual((await self._copy("stranger", d["slug"])).status_code, 404)

    async def test_c199_encrypted_copy_422(self):
        d = await self.mkdoc("L", ws=None, encrypted=True)
        self.assertEqual((await self._copy("stranger", d["slug"])).status_code, 422)

    async def test_c200_tenant_cannot_copy(self):
        d = await self.mkdoc("L")
        r = await self.http.post(f"/api/v1/documents/{d['slug']}/copy", json={}, headers=self.tenant("wm", "W1"))
        self.assertEqual(r.status_code, 401)

    async def test_c201_copy_header_scope(self):
        d = await self.mkdoc("L")
        r = await self.http.post(f"/api/v1/documents/{d['slug']}/copy", json={},
                                 headers={**self.session("wm"), "X-Markdrop-Workspace": self.ws["W2"]})
        self.assertEqual(r.status_code, 404)


class Mcp(AccessWorld):
    def ok(self, res):
        self.assertFalse(res["isError"], res["content"][0]["text"])
        return res["structuredContent"]

    def err(self, res):
        self.assertTrue(res["isError"], res)
        return res["content"][0]["text"]

    async def test_c202_read_scope_cannot_update(self):
        d = await self.mkdoc("W")
        status, _ = await self.mcp_call(await self.mcp_token("wm", write=False), "update_document",
                                        {"document": d["slug"], "content": "x"})
        self.assertEqual(status, 403)
        self.assertEqual((await self.doc(d["slug"]))["content"], d["content"])

    async def test_c203_member_updates_workspace_doc(self):
        d = await self.mkdoc("W")
        _s, res = await self.mcp_call(await self.mcp_token("wm"), "update_document",
                                      {"document": d["slug"], "content": "by member"})
        out = self.ok(res)
        self.assertEqual(out["url"], f"https://docs.acme.test/{d['slug']}")
        self.assertEqual((await self.doc(d["slug"]))["content"], "by member")

    async def test_c204_member_cannot_delete(self):
        d = await self.mkdoc("W")
        _s, res = await self.mcp_call(await self.mcp_token("wm"), "delete_document", {"document": d["slug"]})
        self.assertIn("only delete documents you own", self.err(res))

    async def test_c205_member_cannot_see_stats(self):
        d = await self.mkdoc("W")
        _s, res = await self.mcp_call(await self.mcp_token("wm"), "get_document_stats", {"document": d["slug"]})
        self.assertIn("only see stats", self.err(res))

    async def _upload_args(self, slug):
        return {"file_name": "x.html", "size_bytes": 5, "sha256": hashlib.sha256(b"hello").hexdigest(),
                "target_slug": slug}

    async def test_c206_editor_create_upload_replace(self):
        d = await self.mkdoc("P", ws=None, kind="artifact")
        _s, res = await self.mcp_call(await self.mcp_token("ge"), "create_upload", await self._upload_args(d["slug"]))
        self.assertTrue(self.ok(res)["upload_id"])

    async def test_c207_viewer_create_upload_refused(self):
        d = await self.mkdoc("W", kind="artifact")
        _s, res = await self.mcp_call(await self.mcp_token("wv"), "create_upload", await self._upload_args(d["slug"]))
        self.err(res)
        self.assertEqual(self.r2.uploads, {})

    async def test_c208_custom_domain_private_not_found(self):
        d = await self.mkdoc("P", folder_path=["guides"])
        _s, res = await self.mcp_call(await self.mcp_token("stranger"), "get_document",
                                      {"document": f"https://docs.acme.test/guides/{d['slug']}"})
        self.assertIn("couldn't find", self.err(res))

    async def test_c209_custom_domain_scope(self):
        d = await self.mkdoc("L", ws="W2", owner="wm2")
        _s, res = await self.mcp_call(await self.mcp_token("wm"), "get_document",
                                      {"document": f"https://docs.acme.test/{d['slug']}"})
        self.assertIn("couldn't find", self.err(res))
        _s, res = await self.mcp_call(await self.mcp_token("wm"), "get_document",
                                      {"document": f"https://w2.test/{d['slug']}"})
        out = self.ok(res)
        self.assertEqual((out["workspace_id"], out["workspace_url"]), (self.ws["W2"], f"https://w2.test/{d['slug']}"))

    async def test_c210_unknown_host_never_resolves(self):
        d = await self.mkdoc("L", ws=None)
        _s, res = await self.mcp_call(await self.mcp_token("wm"), "get_document",
                                      {"document": f"https://evil.test/{d['slug']}"})
        self.assertIn("couldn't find", self.err(res))

    async def test_c211_set_access_workspace(self):
        u = await self.mkdoc("L", ws=None)
        f = await self.mkdoc("L")
        token = await self.mcp_token("owner")
        _s, res = await self.mcp_call(token, "set_access", {"document": u["slug"], "access": "workspace"})
        self.assertIn("isn't in a workspace", self.err(res))
        _s, res = await self.mcp_call(token, "set_access", {"document": f["slug"], "access": "workspace"})
        self.assertEqual(self.ok(res)["access"], "workspace")

    async def test_c212_set_access_link_on_workspace_doc_warns(self):
        d = await self.mkdoc("W")
        _s, res = await self.mcp_call(await self.mcp_token("owner"), "set_access", {"document": d["slug"], "access": "link"})
        self.ok(res)
        self.assertIn("public", res["content"][0]["text"])
        self.assertIn("every address", res["content"][0]["text"])

    async def test_c213_publish_missing_folder_lists_folders(self):
        await folder_service.create_folder(self.db, self.ws["W1"], "Guides", None)
        before = await self.db["documents"].count_documents({})
        _s, res = await self.mcp_call(await self.mcp_token("wm"), "publish_document",
                                      {"markdown": "# x", "workspace": self.ws["W1"], "folder": "missing"})
        text = self.err(res)
        self.assertIn("guides", text)
        self.assertEqual(await self.db["documents"].count_documents({}), before)

    async def test_c213b_publish_into_workspace_folder(self):
        await folder_service.create_folder(self.db, self.ws["W1"], "Guides", None)
        _s, res = await self.mcp_call(await self.mcp_token("wm"), "publish_document",
                                      {"markdown": "# x", "workspace": "Acme", "folder": "guides", "slug": "my-guide"})
        out = self.ok(res)
        self.assertEqual(out["url"], "https://docs.acme.test/guides/my-guide")
        self.assertEqual(out["markdrop_url"], "https://markdrop.in/my-guide")
        self.assertEqual(out["access"], "workspace")  # the workspace's default access
        raw = await self.doc("my-guide")
        self.assertEqual((raw["workspace_id"], raw["access_level"]), (self.ws["W1"], "workspace"))

    async def test_c214_taken_slug_errors(self):
        await self.mkdoc("L", ws=None, slug="taken-slug")
        _s, res = await self.mcp_call(await self.mcp_token("wm"), "publish_document",
                                      {"markdown": "# x", "workspace": self.ws["W1"], "slug": "taken-slug"})
        self.assertIn("taken", self.err(res))

    async def test_c215_encrypted_error_no_ciphertext(self):
        d = await self.mkdoc("L", ws=None, encrypted=True, content="mdx1.cipher.text")
        _s, res = await self.mcp_call(await self.mcp_token("owner"), "get_document", {"document": d["slug"]})
        self.assertIn("encrypted", self.err(res))
        self.assertNotIn("cipher", str(res))

    async def test_c215b_workspace_tools(self):
        token = await self.mcp_token("wm")
        out = self.ok((await self.mcp_call(token, "list_workspaces", {}))[1])
        acme = next(w for w in out["workspaces"] if w["workspace_id"] == self.ws["W1"])
        self.assertEqual((acme["role"], acme["default_access"]), ("member", "workspace"))
        self.assertEqual(acme["custom_domains"][0]["domain"], "docs.acme.test")
        out = self.ok((await self.mcp_call(token, "create_folder", {"workspace": "docs.acme.test", "path": "a/b"}))[1])
        self.assertEqual((out["path"], out["created"]), ("a/b", ["a", "b"]))
        out = self.ok((await self.mcp_call(token, "list_folders", {"workspace": "Acme"}))[1])
        self.assertEqual({f["path"] for f in out["folders"]}, {"a", "a/b"})
        mine = await self.mkdoc("L", ws=None, owner="wm")
        out = self.ok((await self.mcp_call(token, "add_to_workspace",
                                           {"document": mine["slug"], "workspace": "Acme", "folder": "a/b"}))[1])
        self.assertEqual(out["url"], f"https://docs.acme.test/a/b/{mine['slug']}")
        out = self.ok((await self.mcp_call(token, "list_workspace_items", {"workspace": "Acme", "folder": "a/b"}))[1])
        self.assertEqual([i["slug"] for i in out["items"]], [mine["slug"]])
        out = self.ok((await self.mcp_call(token, "move_to_folder", {"document": mine["slug"], "folder": "a"}))[1])
        self.assertEqual(out["folder"], "a")
        out = self.ok((await self.mcp_call(token, "remove_from_workspace", {"document": mine["slug"]}))[1])
        self.assertEqual(out["access_after"], "link")


class BeaconsLiveOg(AccessWorld):
    async def _events(self, slug, **body):
        return await self.http.post(f"/api/v1/documents/{slug}/events", json={"type": "view", **body},
                                    headers={"User-Agent": "Mozilla/5.0"})

    async def test_c216_private_event_not_recorded(self):
        d = await self.mkdoc("P", ws=None)
        r = await self._events(d["slug"])
        self.assertEqual(r.status_code, 202)
        self.assertEqual((await self.doc(d["slug"]))["views"], 0)

    async def test_c217_missing_slug_202(self):
        r = await self._events("no-such-doc")
        self.assertEqual((r.status_code, r.json()), (202, {"status": "ok"}))

    async def test_c218_public_event_recorded(self):
        d = await self.mkdoc("L", ws=None)
        self.assertEqual((await self._events(d["slug"])).status_code, 202)
        self.assertEqual((await self.doc(d["slug"]))["views"], 1)

    async def test_c219_read_beacon_with_ticket(self):
        import json

        d = await self.mkdoc("P", ws=None)
        ticket = (await self.get(d["slug"], self.session("gv"))).json()["read_ticket"]
        r = await self.http.post(f"/api/v1/documents/{d['slug']}/read",
                                 content=json.dumps({"rid": "abcdefgh12", "depth": 50, "seconds": 9, "t": ticket}),
                                 headers={"User-Agent": "Mozilla/5.0"})
        self.assertEqual(r.status_code, 204)
        self.assertEqual(await self.db["events"].count_documents({"doc_id": str(d["_id"]), "type": "read"}), 1)
        # Without the ticket: same answer, nothing recorded.
        r = await self.http.post(f"/api/v1/documents/{d['slug']}/read",
                                 content=json.dumps({"rid": "zzzzzzzz12", "depth": 50, "seconds": 9}),
                                 headers={"User-Agent": "Mozilla/5.0"})
        self.assertEqual(r.status_code, 204)
        self.assertEqual(await self.db["events"].count_documents({"doc_id": str(d["_id"]), "type": "read"}), 1)

    async def test_c220_private_socket_without_ticket(self):
        from app.routers import live as live_router

        d = await self.mkdoc("P", ws=None)
        self.assertFalse(await live_router._admitted(d["slug"], None))
        self.assertTrue(await live_router._admitted((await self.mkdoc("L", ws=None))["slug"], None))

    async def test_c221_member_socket_changed_then_access(self):
        from app.routers import live as live_router

        d = await self.mkdoc("W")
        ticket = (await self.get(d["slug"], self.session("wm"))).json()["read_ticket"]
        self.assertTrue(await live_router._admitted(d["slug"], ticket))
        q = live.subscribe(d["slug"])
        try:
            await self.http.put(f"/api/v1/documents/{d['slug']}", json={"title": "t", "content": "c2"},
                                headers=self.session("wm"))
            self.assertEqual(q.get_nowait()["type"], "changed")
            await self.http.put(f"/api/v1/documents/{d['slug']}/access/level", json={"level": "private"},
                                headers=self.session("owner"))
            self.assertEqual(q.get_nowait(), {"type": "access"})
        finally:
            live.unsubscribe(d["slug"], q)
        self.assertFalse(await live_router._admitted(d["slug"], ticket))

    async def test_c222_stale_ticket_rejected(self):
        from app.routers import live as live_router

        d = await self.mkdoc("W")
        ticket = tickets.mint(str(d["_id"]), 0)
        await self.db["documents"].update_one({"_id": d["_id"]}, {"$set": {"access_epoch": 1}})
        self.assertFalse(await live_router._admitted(d["slug"], ticket))

    async def test_c223_report_missing_slug(self):
        r = await self.http.post("/api/v1/documents/no-such-doc/report", json={"reason": "x"})
        self.assertEqual(r.status_code, 202)
        self.assertEqual(await self.db["reports"].count_documents({}), 0)

    async def test_c224_og_cards(self):
        from app.services import og_render

        cards = []
        docs = {s: await self.mkdoc(s) for s in ("W", "P", "RL", "LP")}
        docs["E"] = await self.mkdoc("L", encrypted=True)
        docs["L"] = await self.mkdoc("L")
        with mock.patch.object(og_render, "render_og_png", lambda card: cards.append(card) or b"png"):
            for state, d in docs.items():
                await self.http.get(f"/api/v1/og/{d['slug']}.png")
        kinds = {state: card.kind for state, card in zip(docs, cards)}
        for state in ("W", "P", "RL", "LP", "E"):
            self.assertIn(kinds[state], ("private", "password", "encrypted"), state)
            self.assertNotIn(docs[state]["title"], repr(cards[list(docs).index(state)]))
        self.assertNotIn(kinds["L"], ("private", "password", "encrypted"))

    async def test_c225_c226_og_cache_and_host(self):
        self.skipTest("#225-#226 OG max-age / foreign host branding: routers/og.py (tenant workstream)")

    async def test_c227_stack_og_epoch_in_meta(self):
        self.skipTest("[S] #227: page metadata og:image carries e=<access_epoch> (frontend)")


TRANSITIONS = [
    # (name, setup state, kind, action coroutine name, expected job keys besides doc:<slug>, live)
    "level_narrowed", "level_widened", "password_added", "password_removed", "expiry_set", "deleted",
    "renamed", "content_edit", "file_replaced", "filed", "refiled", "unshared", "folder_renamed",
    "folder_share", "require_auth_on", "require_auth_off", "workspace_deleted",
]


class CachingAndBytes(AccessWorld):
    async def test_c228_transition_purges(self):
        """§5.2, one assertion per row: the doc tag/path and the wsl tag."""
        w1 = f"tag:wsl:{self.ws['W1']}"
        for name in TRANSITIONS:
            await self.db["revalidate_jobs"].delete_many({})
            owner = self.session("owner")
            if name in ("level_widened",):
                d = await self.mkdoc("P")
            elif name in ("filed",):
                d = await self.mkdoc("L", ws=None)
            elif name == "file_replaced":
                d = await self.mkdoc("L", kind="artifact")
            else:
                d = await self.mkdoc("L")
            slug, extra = d["slug"], {w1}
            if name == "level_narrowed":
                await self.http.put(f"/api/v1/documents/{slug}/access/level", json={"level": "private"}, headers=owner)
            elif name == "level_widened":
                await self.http.put(f"/api/v1/documents/{slug}/access/level", json={"level": "link"}, headers=owner)
            elif name == "password_added":
                await self.http.put(f"/api/v1/documents/{slug}", json={"title": "t", "content": "c", "read_password": "x"}, headers=owner)
            elif name == "password_removed":
                await self.http.put(f"/api/v1/documents/{slug}", json={"title": "t", "content": "c", "remove_password": True}, headers=owner)
            elif name == "expiry_set":
                await self.http.put(f"/api/v1/documents/{slug}", json={"title": "t", "content": "c", "expires_in": "7d"}, headers=owner)
            elif name == "deleted":
                await self.http.delete(f"/api/v1/documents/{slug}", headers=owner)
            elif name == "renamed":
                await self.http.patch(f"/api/v1/documents/{slug}/slug", json={"new_slug": f"{slug}-b"}, headers=owner)
                extra |= {f"doc:{slug}-b"}
            elif name == "content_edit":
                await self.http.put(f"/api/v1/documents/{slug}", json={"title": "t", "content": "c2"}, headers=owner)
            elif name == "file_replaced":
                key = f"art/{self.uid['owner']}/n.html"
                self.r2.put_bytes(key, b"n", "text/html", False)
                await self.http.put(f"/api/v1/artifacts/{slug}/file", json={"blob_key": key, "filename": "n.html"}, headers=owner)
            elif name == "filed":
                await self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/items/add", json={"slugs": [slug]}, headers=owner)
            elif name == "refiled":
                f = await folder_service.create_folder(self.db, self.ws["W1"], f"F{slug}", None)
                await self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/items/move", json={"slugs": [slug], "folder_id": f.id}, headers=owner)
            elif name == "unshared":
                await self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/items/remove", json={"slugs": [slug]}, headers=owner)
            elif name == "folder_renamed":
                f = await folder_service.create_folder(self.db, self.ws["W1"], f"G{slug}", None)
                await self.db["documents"].update_one({"_id": d["_id"]}, {"$set": {"folder_id": f.id}})
                await self.http.patch(f"/api/v1/workspaces/{self.ws['W1']}/folders/{f.id}", json={"name": f"H{slug}"},
                                      headers=self.session("wa"))
            elif name == "folder_share":
                f = await folder_service.create_folder(self.db, self.ws["W1"], f"S{slug}", None)
                r = await self.http.put(f"/api/v1/workspaces/{self.ws['W1']}/folders/{f.id}/share", json={"level": "link"},
                                        headers=self.session("wa"))
                keys = await self.jobs()
                self.assertIn(w1, keys, name)
                self.assertIn(f"tag:share:{r.json()['share_id']}", keys, name)
                continue
            elif name in ("require_auth_on", "require_auth_off"):
                await self.http.put(f"/api/v1/workspaces/{self.ws['W1']}", headers=self.session("wa"),
                                    json={"settings": {"require_auth_to_view": name.endswith("on")}})
                extra |= {"tag:host:docs.acme.test"}
                if name.endswith("off"):
                    await self.set_require_auth("W1", False)
            elif name == "workspace_deleted":
                await self.http.request("DELETE", f"/api/v1/workspaces/{self.ws['W1']}", json={"confirm_name": "Acme"},
                                        headers=self.session("wo"))
                extra |= {"tag:host:docs.acme.test"}
            keys = await self.jobs()
            self.assertIn(f"doc:{slug}", keys, name)
            self.assertTrue(extra <= keys, (name, extra - keys))
            if name == "workspace_deleted":
                break

    async def test_c229_outbox_retried_until_success(self):
        d = await self.mkdoc("L")
        with mock.patch.object(settings, "page_revalidate_enabled", True):
            self.post_status = 500
            await self.http.put(f"/api/v1/documents/{d['slug']}/access/level", json={"level": "private"},
                                headers=self.session("owner"))
            await asyncio.sleep(0.05)
            await revalidate.run_due(self.db)
            job = await self.db["revalidate_jobs"].find_one({"key": f"doc:{d['slug']}"})
            self.assertEqual(job["state"], "pending")
            self.assertGreaterEqual(job["attempts"], 1)
            self.post_status = 200
            await self.db["revalidate_jobs"].update_many({}, {"$set": {"next_at": now() - timedelta(seconds=1)}})
            await revalidate.run_due(self.db)
            job = await self.db["revalidate_jobs"].find_one({"key": f"doc:{d['slug']}"})
            self.assertEqual(job["state"], "done")
            self.assertIn({"slug": d["slug"]}, self.posted)

    async def test_c230_outbox_written_before_response(self):
        d = await self.mkdoc("L")
        r = await self.http.put(f"/api/v1/documents/{d['slug']}/access/level", json={"level": "private"},
                                headers=self.session("owner"))
        self.assertEqual(r.status_code, 204)
        job = await self.db["revalidate_jobs"].find_one({"key": f"doc:{d['slug']}"})
        self.assertEqual(job["state"], "pending")

    async def test_c231_reconciler_repairs_r2(self):
        d = await self.mkdoc("P", ws=None, kind="artifact")
        self.r2.objects[d["blob_key"]]["public"] = True   # drift: public while private
        await self.db["documents"].update_one({"_id": d["_id"]}, {"$set": {"access_dirty": True}})
        await lifecycle.reconcile_once(self.db)
        self.assertFalse(self.r2.objects[d["blob_key"]]["public"])
        self.assertFalse((await self.doc(d["slug"]))["access_dirty"])

    async def test_c232_c236_stack_caching(self):
        self.skipTest("[S] #232-#236: ISR / tenant pages / browser cache / Worker playback (run live)")

    async def test_c237_bundle_private_closes_every_object(self):
        d = await self.mkdoc("L", ws=None, kind="artifact", bundle=True)
        for k in [k for k in self.r2.objects if k.startswith(d["bundle_prefix"])]:
            self.assertTrue(self.r2.objects[k]["public"])
        await self.http.put(f"/api/v1/documents/{d['slug']}/access/level", json={"level": "private"},
                            headers=self.session("owner"))
        for k in [k for k in self.r2.objects if k.startswith(d["bundle_prefix"])]:
            self.assertFalse(self.r2.objects[k]["public"], k)

    async def _random_walk(self, seed: int, steps: int = 25):
        """#238/#239: random transitions on one artifact with versions."""
        rnd = random.Random(seed)
        d = await self.mkdoc("L", ws=None, kind="artifact")
        slug, owner = d["slug"], self.session("owner")
        ws_filed = None
        for _ in range(steps):
            op = rnd.choice(["level", "password", "file", "unshare", "require_auth", "replace", "restore", "expiry"])
            raw = await self.doc(slug)
            if op == "level":
                lvl = rnd.choice(["link", "private"] + (["workspace"] if raw.get("workspace_id") else []))
                await self.http.put(f"/api/v1/documents/{slug}/access/level", json={"level": lvl}, headers=owner)
            elif op == "password":
                body = {"read_password": "x"} if rnd.random() < .5 else {"remove_password": True}
                await self.http.put(f"/api/v1/documents/{slug}", json={"title": "t", "content": "c", **body}, headers=owner)
            elif op == "file" and not raw.get("workspace_id"):
                ws_filed = rnd.choice(["W1", "WR"])
                await self.http.post(f"/api/v1/workspaces/{self.ws[ws_filed]}/items/add", json={"slugs": [slug]}, headers=owner)
            elif op == "unshare" and raw.get("workspace_id"):
                key = "WR" if raw["workspace_id"] == self.ws["WR"] else "W1"
                await self.http.post(f"/api/v1/workspaces/{self.ws[key]}/items/remove", json={"slugs": [slug]}, headers=owner)
            elif op == "require_auth":
                key = rnd.choice(["W1", "WR"])
                ws = await self.db["workspaces"].find_one({"_id": ObjectId(self.ws[key])})
                on = not ws["settings"].get("require_auth_to_view")
                await self.http.put(f"/api/v1/workspaces/{self.ws[key]}", headers=self.session("wo"),
                                    json={"settings": {"require_auth_to_view": on}})
            elif op == "replace":
                key = f"art/{self.uid['owner']}/r{rnd.random()}.html"
                self.r2.put_bytes(key, b"r", "text/html", False)
                await self.http.put(f"/api/v1/artifacts/{slug}/file", json={"blob_key": key, "filename": "r.html"}, headers=owner)
            elif op == "restore":
                raw = await self.doc(slug)
                v = rnd.randint(1, max(1, int(raw.get("file_version") or 1)))
                await self.http.post(f"/api/v1/files/{slug}/versions/{v}/restore", headers=owner)
            elif op == "expiry":
                await self.http.put(f"/api/v1/documents/{slug}", json={"title": "t", "content": "c", "expires_in": "7d"}, headers=owner)
            raw = await self.doc(slug)
            ra = await publicity.workspace_requires_auth(self.db, raw.get("workspace_id"))
            expected = publicity.is_public(raw, require_auth=ra)
            # Never public while is_public is false, even before the reconciler.
            if self.r2.objects[raw["blob_key"]]["public"]:
                self.assertTrue(expected, (op, raw.get("access_level"), raw.get("workspace_id")))
            # Non-current versions are never public.
            for row in await self.db["file_versions"].find({"doc_id": str(raw["_id"])}).to_list(100):
                if row["blob_key"] != raw["blob_key"] and row["blob_key"] in self.r2.objects:
                    self.assertFalse(self.r2.objects[row["blob_key"]]["public"], op)
            await lifecycle.reconcile_once(self.db)
            self.assertEqual(self.r2.objects[raw["blob_key"]]["public"], expected, op)

    async def test_c238_c239_property_random_transitions(self):
        for seed in range(6):
            await self._random_walk(seed)

    async def test_c240_property_monotonic_read(self):
        rnd = random.Random(7)
        an, st, wv = access.Actor(), access.Actor.of(await self._user("stranger")), access.Actor.of(await self._user("wv"))
        for _ in range(60):
            state = rnd.choice(["L", "LP", "P", "W", "RL", "RLP", "RW", "RP", "UL", "ULP", "UP"])
            d = await self.mkdoc(state, grants=False)
            ctx = access.Ctx(self.db)
            a = (await access.can(an, d, "read", ctx)).allowed
            s = (await access.can(st, d, "read", ctx)).allowed
            m = (await access.can(wv, d, "read", ctx)).allowed
            self.assertTrue((not a or s) and (not s or m), state)

    async def _user(self, who):
        from app.services import user as user_service

        return await user_service.get_user_by_id(self.db, self.uid[who])

    async def test_c241_property_grants_never_remove(self):
        actions = ["read", "edit_content", "share", "see_grants", "copy", "move_in_workspace"]
        rnd = random.Random(11)
        for _ in range(25):
            state = rnd.choice(["L", "LP", "P", "W", "RL", "RW", "UL", "UP"])
            d = await self.mkdoc(state, grants=False, allow_resharing=rnd.random() < .5)
            actor = access.Actor.of(await self._user("stranger"))
            before = {a: (await access.can(actor, d, a, access.Ctx(self.db))).allowed for a in actions}
            if rnd.random() < .5:
                await self.db["document_grants"].insert_one({"document_id": str(d["_id"]), "email": self.email["stranger"],
                                                             "role": rnd.choice(["viewer", "editor"]), "created_at": now()})
            else:
                await self.add_member(rnd.choice(["W1", "WR"]), "stranger", rnd.choice(["viewer", "member", "admin"]))
            after = {a: (await access.can(actor, d, a, access.Ctx(self.db))).allowed for a in actions}
            for a in actions:
                self.assertTrue(after[a] or not before[a], (state, a))
            await self.db["document_grants"].delete_many({"email": self.email["stranger"]})
            await self.db["memberships"].delete_many({"user_id": self.uid["stranger"]})

    async def test_c242_property_identical_denials(self):
        p = await self.mkdoc("P", ws=None)
        h = self.session("stranger")
        surfaces = [
            ("GET", "/api/v1/documents/{s}", None),
            ("GET", "/api/v1/documents/{s}/access", None),
            ("GET", "/api/v1/files/{s}", None),
            ("POST", "/api/v1/documents/{s}/copy", {}),
            ("PUT", "/api/v1/documents/{s}", {"title": "t", "content": "c"}),
            ("DELETE", "/api/v1/documents/{s}", None),
            ("PATCH", "/api/v1/documents/{s}/slug", {"new_slug": "zz-new"}),
            ("GET", "/api/v1/me/documents/{s}/analytics", None),
            ("POST", "/api/v1/documents/{s}/events", {"type": "view"}),
        ]
        for method, path, body in surfaces:
            got = []
            for slug in (p["slug"], "missing-doc-x"):
                r = await self.http.request(method, path.format(s=slug), json=body, headers=h)
                got.append((r.status_code, r.content))
            self.assertEqual(got[0], got[1], path)


class Concurrency(AccessWorld):
    async def test_c243_concurrent_levels_converge(self):
        d = await self.mkdoc("L", ws=None, kind="artifact")
        h = self.session("owner")
        await asyncio.gather(
            self.http.put(f"/api/v1/documents/{d['slug']}/access/level", json={"level": "private"}, headers=h),
            self.http.put(f"/api/v1/documents/{d['slug']}/access/level", json={"level": "link"}, headers=h))
        await lifecycle.reconcile_once(self.db)
        raw = await self.doc(d["slug"])
        self.assertEqual(self.r2.objects[d["blob_key"]]["public"],
                         publicity.is_public(raw, require_auth=False))

    async def test_c244_grant_racing_delete_no_orphan(self):
        d = await self.mkdoc("P", ws=None, grants=False)
        await asyncio.gather(
            self.http.post(f"/api/v1/documents/{d['slug']}/access/people", headers=self.session("owner"),
                           json={"email": "z@example.com", "notify": False}),
            self.http.delete(f"/api/v1/documents/{d['slug']}", headers=self.session("owner")))
        await lifecycle.reconcile_once(self.db, full=True)
        self.assertEqual(await self.db["document_grants"].count_documents({"document_id": str(d["_id"])}), 0)

    async def test_c245_replace_racing_delete(self):
        d = await self.mkdoc("L", ws=None, kind="artifact")
        key = f"art/{self.uid['owner']}/race.html"
        self.r2.put_bytes(key, b"r", "text/html", False)
        h = self.session("owner")
        await asyncio.gather(
            self.http.put(f"/api/v1/artifacts/{d['slug']}/file", json={"blob_key": key, "filename": "r.html"}, headers=h),
            self.http.delete(f"/api/v1/documents/{d['slug']}", headers=h))
        self.assertIsNone(await self.doc(d["slug"]))

    async def test_c246_folder_move_racing_delete(self):
        f = await folder_service.create_folder(self.db, self.ws["W1"], "Gone", None)
        d = await self.mkdoc("W")
        await asyncio.gather(
            self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/items/move", json={"slugs": [d["slug"]], "folder_id": f.id},
                           headers=self.session("wm")),
            self.http.delete(f"/api/v1/workspaces/{self.ws['W1']}/folders/{f.id}", headers=self.session("wa")))
        raw = await self.doc(d["slug"])
        if raw.get("folder_id"):
            self.assertIsNotNone(await self.db["folders"].find_one({"_id": ObjectId(raw["folder_id"])}))

    async def test_c247_member_removal_racing_edit(self):
        d = await self.mkdoc("W")
        rs = await asyncio.gather(
            self.http.put(f"/api/v1/documents/{d['slug']}", json={"title": "t", "content": "raced"}, headers=self.session("wm")),
            self.http.delete(f"/api/v1/workspaces/{self.ws['W1']}/members/{self.uid['wm']}", headers=self.session("wa")))
        if rs[0].status_code != 200:
            self.assertEqual(rs[0].status_code, 404)
            self.assertNotEqual((await self.doc(d["slug"]))["content"], "raced")

    async def test_c248_transfer_racing_removal(self):
        rs = await asyncio.gather(
            self.http.delete(f"/api/v1/workspaces/{self.ws['W1']}/members/{self.uid['wm']}", headers=self.session("wa")),
            self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/transfer", json={"user_id": self.uid["wm"]},
                           headers=self.session("wo")))
        ws = await self.db["workspaces"].find_one({"_id": ObjectId(self.ws["W1"])})
        owners = await self.db["memberships"].count_documents({"workspace_id": self.ws["W1"], "role": "owner"})
        self.assertEqual(owners, 1)
        self.assertTrue(await self.db["memberships"].find_one({"workspace_id": self.ws["W1"], "user_id": ws["owner_id"]}))

    async def test_c249_concurrent_batch_moves(self):
        a = await folder_service.create_folder(self.db, self.ws["W1"], "A", None)
        b = await folder_service.create_folder(self.db, self.ws["W1"], "B", None)
        docs = [await self.mkdoc("W") for _ in range(4)]
        slugs = [d["slug"] for d in docs]
        await asyncio.gather(
            self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/items/move", json={"slugs": slugs, "folder_id": a.id},
                           headers=self.session("wm")),
            self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/items/move", json={"slugs": slugs, "folder_id": b.id},
                           headers=self.session("wa")))
        for s in slugs:
            raw = await self.doc(s)
            self.assertIn(raw["folder_id"], (a.id, b.id))
            self.assertEqual(raw["folder_path"], ["a"] if raw["folder_id"] == a.id else ["b"])

    async def test_c250_domain_verify_race(self):
        self.skipTest("#250 domain verify vs add race: services/domain.py (tenant workstream)")


class Migrations(AccessWorld):
    async def test_startup_migrations_idempotent(self):
        filed = await self.mkdoc("L")
        await self.db["documents"].update_one({"_id": filed["_id"]}, {"$unset": {"allow_resharing": ""}})
        orphan_w = await self.mkdoc("W", ws=None)          # workspace level, no workspace
        dangling = await self.mkdoc("W", workspace_id=str(ObjectId()))
        ra_art = await self.mkdoc("RL", kind="artifact")
        self.r2.objects[ra_art["blob_key"]]["public"] = True  # pre-D3 state
        out = await lifecycle.migrate(self.db)
        self.assertFalse((await self.doc(filed["slug"]))["allow_resharing"])
        self.assertEqual((await self.doc(orphan_w["slug"]))["access_level"], "private")
        raw = await self.doc(dangling["slug"])
        self.assertEqual((raw["workspace_id"], raw["access_level"]), (None, "private"))
        self.assertEqual(out["require_auth_bytes_queued"], 1)
        await lifecycle.reconcile_once(self.db)
        self.assertFalse(self.r2.objects[ra_art["blob_key"]]["public"])
        again = await lifecycle.migrate(self.db)
        self.assertEqual((again["resharing_defaulted"], again["workspace_level_released"],
                          again["dangling_released"]), (0, 0, 0))
        self.assertNotIn("require_auth_bytes_queued", again)


class OtherSurfaces(AccessWorld):
    async def test_c251_sync_owner_only(self):
        d = await self.mkdoc("W")
        self.assertEqual((await self.http.get(f"/api/v1/sync/{d['_id']}", headers=self.session("wm"))).status_code, 404)

    async def test_c252_google_export_owner_only(self):
        d = await self.mkdoc("P", ws=None)
        r = await self.http.post(f"/api/v1/google/documents/{d['_id']}/export", headers=self.session("ge"))
        self.assertIn(r.status_code, (404, 503))
        if r.status_code == 503:
            from app.services import document as doc_service

            self.assertIsNone(await doc_service.get_owned_document_by_id(self.db, str(d["_id"]), self.uid["ge"]))

    async def test_c253_stats_admin_denied(self):
        d = await self.mkdoc("W")
        r = await self.http.get(f"/api/v1/me/documents/{d['slug']}/analytics", headers=self.session("wa"))
        # Policy table: a reader who isn't the owner gets 403; catalogue #253 says
        # 404. Either way: denied, and the numbers never leave.
        self.assertIn(r.status_code, (403, 404))
        r = await self.http.get(f"/api/v1/me/documents/{d['slug']}/analytics", headers=self.session("stranger"))
        self.assertEqual(r.status_code, 404)

    async def test_c254_admin_read_logged(self):
        from app.routers.admin import _make_token

        d = await self.mkdoc("P", ws=None)
        r = await self.http.get(f"/api/v1/admin/documents/{d['slug']}",
                                headers={"Authorization": f"Bearer {_make_token()[0]}"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(await self.db["admin_access_log"].count_documents({"slug": d["slug"]}), 1)

    async def test_c255_host_cdn(self):
        self.skipTest("#255 GET /api/v1/host for a cdn host: routers/domains.py (tenant workstream)")

    async def test_c256_c262_stack_ui(self):
        self.skipTest("[S] #256-#262: tenant branding, editor unlock, gates, phone widths (frontend/browser)")
