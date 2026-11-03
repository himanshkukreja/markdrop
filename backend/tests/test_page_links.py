"""Page links (Senseloaf P0 #1): a custom link on create_page, set_slug with
redirects from the old link (markdrop.in and the workspace's domain, folders
and sub-page paths included), the slug-check endpoint behind "Change link…",
and publish_document(editor).

The access-policy world (tests/_access_env.py): the test MongoDB (or mongomock),
an in-memory R2. Never backend/.env.
"""

from __future__ import annotations

import unittest
from datetime import timedelta

from tests._access_env import HOSTS, AccessWorld, now

from app.mcp import tools as mcp_tools
from app.services import lifecycle, viewers

W1 = HOSTS["W1"]


class PageLinks(AccessWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        from app.limiter import limiter

        limiter.enabled = False
        self.addCleanup(setattr, limiter, "enabled", True)
        viewers.clear()

    async def call(self, who: str, name: str, args: dict, *, write: bool = True):
        status, res = await self.mcp_call(await self.mcp_token(who, write=write), name, args)
        self.assertEqual(status, 200)
        return res

    async def ok(self, who: str, name: str, args: dict) -> dict:
        res = await self.call(who, name, args)
        self.assertFalse(res["isError"], res["content"][0]["text"])
        return res["structuredContent"]

    async def err(self, who: str, name: str, args: dict) -> str:
        res = await self.call(who, name, args)
        self.assertTrue(res["isError"], res)
        return res["content"][0]["text"]

    async def folders(self, path: str = "product-hub/templates") -> None:
        await self.ok("owner", "create_folder", {"workspace": "Acme", "path": path})

    async def moved_to(self, slug: str, headers: dict | None = None) -> dict:
        r = await self.get(slug, headers or self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertTrue(body.get("moved"), body)
        self.assertEqual(r.headers.get("x-markdrop-moved"), body["slug"])
        return body

    async def check(self, slug: str, new: str, who: str | None = "owner"):
        return await self.http.get(f"/api/v1/documents/{slug}/slug-check", params={"new_slug": new},
                                   headers=self.session(who) if who else {})

    # ── catalogue ──

    def test_tool_listing(self):
        by = mcp_tools.BY_NAME
        self.assertIn("set_slug", by)
        t = by["set_slug"]
        self.assertTrue(t.writes)
        self.assertEqual(t.scope, "documents:write")
        self.assertEqual(t.input_schema["required"], ["document", "slug"])
        self.assertIn("redirects", t.description)
        self.assertIn("slug", by["create_page"].input_schema["properties"])
        self.assertIn("set_slug", by["create_page"].description)
        ed = by["publish_document"].input_schema["properties"]["editor"]
        self.assertEqual((ed["enum"], ed["default"]), (["classic", "blocks"], "classic"))
        # publish_page shares the publish options but has no editor.
        self.assertNotIn("editor", by["publish_page"].input_schema["properties"])
        self.assertNotIn("editor", by["publish_document"].input_schema["required"])

    # ── create_page(slug) ──

    async def test_done_when_custom_domain_folder_and_block_editor(self):
        await self.folders()
        out = await self.ok("owner", "create_page", {
            "title": "PRD template", "slug": "sl-template-prd", "workspace": "Acme",
            "folder": "product-hub/templates"})
        self.assertEqual(out["url"], f"https://{W1}/product-hub/templates/sl-template-prd")
        self.assertEqual(out["workspace_url"], out["url"])
        self.assertEqual(out["markdrop_url"], "https://markdrop.in/sl-template-prd")
        self.assertEqual((out["slug"], out["editor"]), ("sl-template-prd", "blocks"))
        raw = await self.doc("sl-template-prd")
        self.assertEqual(raw["editor"], "blocks")
        self.assertEqual(raw["folder_path"], ["product-hub", "templates"])
        # It opens in the block editor: what the reader and get_page say.
        r = await self.get("sl-template-prd", self.session("owner"))
        self.assertEqual(r.json()["editor"], "blocks")
        self.assertEqual((await self.ok("owner", "get_page", {"document": out["url"]}))["editor"], "blocks")

    async def test_create_page_slug_personal_and_sub_page(self):
        top = await self.ok("owner", "create_page", {"title": "Mine", "slug": "my-own-page"})
        self.assertEqual(top["url"], "https://markdrop.in/my-own-page")
        await self.folders("hub")
        parent = await self.ok("owner", "create_page", {"title": "P", "workspace": "Acme", "folder": "hub",
                                                        "slug": "hub-parent"})
        kid = await self.ok("owner", "create_page", {"title": "K", "parent": "hub-parent", "slug": "hub-kid"})
        self.assertEqual(kid["url"], f"https://{W1}/hub/hub-parent/hub-kid")
        self.assertEqual(parent["url"], f"https://{W1}/hub/hub-parent")
        # REST: POST /pages takes slug too.
        r = await self.http.post("/api/v1/pages", json={"title": "Rest", "slug": "rest-page"},
                                 headers=self.session("owner"))
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["document"]["slug"], "rest-page")
        r = await self.http.post("/api/v1/pages", json={"title": "Rest", "slug": "rest-page"},
                                 headers=self.session("owner"))
        self.assertEqual(r.status_code, 409, r.text)

    async def test_create_page_clash_names_the_slug_and_creates_nothing(self):
        await self.mkdoc("W", slug="taken-one", owner="wm")
        msg = await self.err("owner", "create_page", {"title": "Clash", "slug": "taken-one"})
        self.assertIn("'taken-one'", msg)
        self.assertIn("already taken", msg)
        await self.folders()
        msg = await self.err("owner", "create_page", {"title": "Clash", "slug": "taken-one", "workspace": "Acme",
                                                      "folder": "product-hub/templates"})
        self.assertIn("'taken-one'", msg)
        self.assertIn("reserved", await self.err("owner", "create_page", {"title": "Clash", "slug": "admin"}))
        # Beside a folder of that slug on the workspace's domain.
        self.assertIn("templates", await self.err("owner", "create_page", {
            "title": "Clash", "slug": "templates", "workspace": "Acme", "folder": "product-hub"}))
        # Someone else's old slug, and someone else's deleted slug (30 days), are taken.
        other = await self.mkdoc("W", owner="wm", slug="was-here")
        r = await self.http.patch("/api/v1/documents/was-here/slug", json={"new_slug": "is-here"},
                                  headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("'was-here'", await self.err("owner", "create_page", {"title": "Clash", "slug": "was-here"}))
        await lifecycle.tombstone(self.db, ["gone-soon"], self.uid["wm"])
        self.assertIn("'gone-soon'", await self.err("owner", "create_page", {"title": "Clash", "slug": "gone-soon"}))
        self.assertEqual(await self.db["documents"].count_documents({"title": "Clash"}), 0)
        self.assertIsNotNone(await self.doc("is-here"))
        self.assertEqual((await self.doc("taken-one"))["owner_id"], self.uid["wm"])
        del other
        # The owner's own deleted slug is theirs again.
        await lifecycle.tombstone(self.db, ["mine-again"], self.uid["owner"])
        out = await self.ok("owner", "create_page", {"title": "Back", "slug": "mine-again"})
        self.assertEqual(out["slug"], "mine-again")

    # ── set_slug ──

    async def test_set_slug_renames_and_old_link_redirects_everywhere(self):
        await self.folders()
        out = await self.ok("owner", "create_page", {"title": "PRD", "slug": "sl-prd", "workspace": "Acme",
                                                     "folder": "product-hub/templates"})
        kid = await self.ok("owner", "create_page", {"title": "Kid", "parent": "sl-prd", "slug": "sl-kid"})
        await self.db["documents"].update_one({"slug": "sl-prd"}, {"$set": {"access_level": "link"}})
        await self.db["documents"].update_one({"slug": "sl-kid"}, {"$set": {"access_level": "link"}})
        from app.services import revalidate

        await self.db[revalidate.JOBS].delete_many({})
        res = await self.ok("owner", "set_slug", {"document": out["url"], "slug": "sl-prd-v2"})
        self.assertEqual(res["url"], f"https://{W1}/product-hub/templates/sl-prd-v2")
        self.assertEqual(res["markdrop_url"], "https://markdrop.in/sl-prd-v2")
        self.assertEqual((res["previous_slug"], res["redirects_from"]), ("sl-prd", ["sl-prd"]))
        # Both slugs' renders are purged.
        jobs = await self.jobs()
        self.assertIn("doc:sl-prd", jobs)
        self.assertIn("doc:sl-prd-v2", jobs)
        # markdrop.in: GET by the old slug says where it lives now (anonymous reader too).
        body = await self.moved_to("sl-prd", {})
        self.assertEqual((body["slug"], body["url"]), ("sl-prd-v2", "https://markdrop.in/sl-prd-v2"))
        self.assertEqual(body["workspace_url"], res["url"])
        self.assertEqual(body["folder_path"], ["product-hub", "templates"])
        # The workspace's domain: the tenant render's request, folders included.
        ws = {"X-Markdrop-Workspace": self.ws["W1"]}
        self.assertEqual((await self.moved_to("sl-prd", ws))["folder_path"], ["product-hub", "templates"])
        # The sub-page's address follows its parent: /<folders>/<parent>/<sub-page>.
        r = await self.get("sl-kid", ws)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["folder_path"], ["product-hub", "templates", "sl-prd-v2"])
        # And a renamed sub-page's old slug redirects to its full path.
        await self.ok("owner", "set_slug", {"document": kid["slug"], "slug": "sl-kid-v2"})
        body = await self.moved_to("sl-kid", ws)
        self.assertEqual(body["slug"], "sl-kid-v2")
        self.assertEqual(body["folder_path"], ["product-hub", "templates", "sl-prd-v2"])
        self.assertEqual(body["workspace_url"], f"https://{W1}/product-hub/templates/sl-prd-v2/sl-kid-v2")
        # The same name again is a no-op.
        same = await self.ok("owner", "set_slug", {"document": "sl-kid-v2", "slug": "sl-kid-v2"})
        self.assertIsNone(same["previous_slug"])

    async def test_old_slug_of_a_gated_document_answers_only_readers(self):
        await self.mkdoc("P", slug="secret-a")
        await self.ok("owner", "set_slug", {"document": "secret-a", "slug": "secret-b"})
        r = await self.get("secret-a", {})
        self.assertIn(r.status_code, (401, 404))
        self.assertNotIn("secret-b", r.text)
        self.assertEqual((await self.moved_to("secret-a"))["slug"], "secret-b")

    async def test_chained_renames_all_redirect_to_the_newest(self):
        await self.mkdoc("UL", slug="chain-a")
        await self.ok("owner", "set_slug", {"document": "chain-a", "slug": "chain-b"})
        # Referred to by its old slug, or a link with it: follows the rename.
        await self.ok("owner", "set_slug", {"document": "https://markdrop.in/chain-a", "slug": "chain-c"})
        self.assertEqual((await self.doc("chain-c"))["old_slugs"], ["chain-a", "chain-b"])
        for old in ("chain-a", "chain-b"):
            self.assertEqual((await self.moved_to(old, {}))["slug"], "chain-c")
        # Back to an old slug of its own: allowed, and the others still redirect.
        await self.ok("owner", "set_slug", {"document": "chain-c", "slug": "chain-a"})
        self.assertEqual((await self.doc("chain-a"))["old_slugs"], ["chain-b", "chain-c"])
        self.assertEqual((await self.moved_to("chain-c", {}))["slug"], "chain-a")

    async def test_set_slug_refusals_name_the_slug(self):
        await self.mkdoc("UL", slug="mine-1")
        await self.mkdoc("UL", owner="wm", slug="theirs-1")
        msg = await self.err("owner", "set_slug", {"document": "mine-1", "slug": "theirs-1"})
        self.assertIn("'theirs-1'", msg)
        self.assertIn("already taken", msg)
        # Another document's former slug.
        await self.ok("wm", "set_slug", {"document": "theirs-1", "slug": "theirs-2"})
        self.assertIn("'theirs-1'", await self.err("owner", "set_slug", {"document": "mine-1", "slug": "theirs-1"}))
        # Someone else's deleted slug, for 30 days; not one's own.
        await lifecycle.tombstone(self.db, ["their-tomb"], self.uid["wm"])
        self.assertIn("'their-tomb'", await self.err("owner", "set_slug", {"document": "mine-1",
                                                                         "slug": "their-tomb"}))
        await self.db[lifecycle.TOMBSTONES].update_one({"slug": "their-tomb"},
                                                       {"$set": {"until": now() - timedelta(seconds=1)}})
        await lifecycle.tombstone(self.db, ["my-tomb"], self.uid["owner"])
        self.assertEqual((await self.ok("owner", "set_slug", {"document": "mine-1", "slug": "my-tomb"}))["slug"],
                         "my-tomb")
        self.assertEqual((await self.ok("owner", "set_slug", {"document": "my-tomb", "slug": "their-tomb"}))["slug"],
                         "their-tomb")
        self.assertIn("reserved", await self.err("owner", "set_slug", {"document": "their-tomb", "slug": "dashboard"}))
        res = await self.call("owner", "set_slug", {"document": "their-tomb", "slug": "a b"})
        self.assertTrue(res["isError"])
        self.assertIsNotNone(await self.doc("their-tomb"))
        self.assertIsNotNone(await self.doc("theirs-2"))

    async def test_permission_matrix(self):
        doc = await self.mkdoc("W", slug="perm-doc")
        expected = {
            "owner": None,
            "ge": "You can only change the link of documents you own.",
            "gv": "You can only change the link of documents you own.",
            "wm": "You can only change the link of documents you own.",
            "wa": "You can only change the link of documents you own.",
            "wo": "You can only change the link of documents you own.",
            "stranger": "couldn't find",
        }
        for who, want in expected.items():
            if want is None:
                continue
            self.assertIn(want, await self.err(who, "set_slug", {"document": "perm-doc", "slug": f"by-{who}"}), who)
        status, _ = await self.mcp_call(await self.mcp_token("owner", write=False), "set_slug",
                                        {"document": "perm-doc", "slug": "read-only"})
        self.assertEqual(status, 403)
        self.assertEqual((await self.doc("perm-doc"))["_id"], doc["_id"])
        self.assertEqual((await self.ok("owner", "set_slug", {"document": "perm-doc", "slug": "by-owner"}))["slug"],
                         "by-owner")
        # REST: the same rule for PATCH …/slug and GET …/slug-check (the edit secret too).
        for who, code in (("ge", 403), ("wa", 403), ("stranger", 404)):
            self.assertEqual((await self.check("by-owner", "zzz-new", who)).status_code, code, who)
        self.assertEqual((await self.check("by-owner", "zzz-new", None)).status_code, 401)
        r = await self.http.get("/api/v1/documents/by-owner/slug-check", params={"new_slug": "zzz-new"},
                                headers={"X-Edit-Secret": "sk_test_edit_secret"})
        self.assertEqual(r.status_code, 200, r.text)
        r = await self.http.patch("/api/v1/documents/by-owner/slug", json={"new_slug": "by-secret"},
                                  headers={"X-Edit-Secret": "sk_test_edit_secret"})
        self.assertEqual(r.status_code, 200, r.text)

    async def test_edit_lock(self):
        page = await self.ok("owner", "create_page", {"title": "Locked", "slug": "lock-page"})
        await self.db["documents"].update_one({"slug": "lock-page"}, {"$set": {"access_level": "link"}})
        await self.db["document_grants"].insert_one({
            "document_id": str((await self.doc("lock-page"))["_id"]), "email": self.email["ge"], "role": "editor",
            "created_at": now(), "granted_by_email": self.email["owner"], "granted_by_user_id": self.uid["owner"],
            "granted_via": None})
        r = await self.http.post("/api/v1/documents/lock-page/lock", headers=self.session("ge"))
        self.assertEqual(r.status_code, 200, r.text)
        # Someone else is editing: their next save would go to the old link.
        self.assertIn("editing", await self.err("owner", "set_slug", {"document": page["slug"], "slug": "lock-2"}))
        r = await self.http.patch("/api/v1/documents/lock-page/slug", json={"new_slug": "lock-2"},
                                  headers=self.session("owner"))
        self.assertEqual(r.status_code, 423, r.text)
        await self.http.delete("/api/v1/documents/lock-page/lock", headers=self.session("ge"))
        # The owner's own editor holds it: the Change link dialog in that editor works.
        r = await self.http.post("/api/v1/documents/lock-page/lock", headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        r = await self.http.patch("/api/v1/documents/lock-page/slug", json={"new_slug": "lock-2"},
                                  headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        # The lock moves with the row: the editor at the new address keeps it.
        r = await self.http.post("/api/v1/documents/lock-2/lock", headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)

    async def test_embeds_and_mentions_by_the_old_slug_still_resolve(self):
        await self.mkdoc("UL", slug="embed-old", title="Target doc")
        page = await self.ok("owner", "create_page", {
            "title": "Hub", "slug": "embed-hub",
            "content": '# Hub\n\n::markdrop{src="embed-old" mode="card"}\n\nSee :markdrop[Target doc]{src="embed-old"}\n'})
        await self.db["documents"].update_one({"slug": "embed-hub"}, {"$set": {"access_level": "link"}})
        await self.ok("owner", "set_slug", {"document": "embed-old", "slug": "embed-new"})
        out = await self.ok("owner", "get_page", {"document": page["slug"]})
        self.assertEqual([(e["slug"], e["as"], e["state"]) for e in out["embeds"]],
                         [("embed-old", "embed", "ok"), ("embed-old", "link", "ok")])
        self.assertEqual(out["embeds"][0]["url"], "https://markdrop.in/embed-new")
        self.assertEqual(out["embeds"][0]["title"], "Target doc")
        # The page's Markdown is untouched (nothing to rewrite).
        self.assertIn('src="embed-old"', (await self.doc("embed-hub"))["content"])
        # The reader's embed resolution (anonymous reader of a public page).
        r = await self.http.post("/api/v1/documents/embed-hub/embeds", json={"slugs": ["embed-old"]})
        self.assertEqual(r.status_code, 200, r.text)
        e = r.json()["embeds"]["embed-old"]
        self.assertEqual((e["state"], e["slug"], e["url"]), ("ok", "embed-new", "https://markdrop.in/embed-new"))

    # ── slug-check (the Change link dialog) ──

    async def test_slug_check(self):
        await self.folders()
        await self.ok("owner", "create_page", {"title": "PRD", "slug": "chk-prd", "workspace": "Acme",
                                               "folder": "product-hub/templates"})
        await self.mkdoc("UL", owner="wm", slug="chk-taken")
        r = await self.check("chk-prd", "chk-free")
        self.assertEqual(r.status_code, 200, r.text)
        b = r.json()
        self.assertEqual((b["available"], b["code"], b["current"]), (True, None, "chk-prd"))
        self.assertEqual(b["url"], f"https://{W1}/product-hub/templates/chk-free")
        self.assertEqual(b["markdrop_url"], "https://markdrop.in/chk-free")
        for new, code in (("chk-prd", "same"), ("chk-taken", "taken"), ("ab", "invalid"), ("a/b", "invalid"),
                          ("login", "reserved")):
            b = (await self.check("chk-prd", new)).json()
            self.assertEqual(b["code"], code, new)
            self.assertEqual(b["available"], code == "same", new)
        await self.ok("owner", "create_folder", {"workspace": "Acme", "path": "product-hub/templates/specs"})
        b = (await self.check("chk-prd", "specs")).json()
        self.assertEqual((b["available"], b["code"]), (False, "folder"))
        # Nothing was written by asking.
        self.assertIsNotNone(await self.doc("chk-prd"))
        await self.ok("owner", "set_slug", {"document": "chk-prd", "slug": "chk-prd-2"})
        b = (await self.check("chk-prd-2", "chk-prd")).json()
        self.assertEqual((b["available"], b["redirects_from"]), (True, ["chk-prd"]))

    # ── publish_document(editor) ──

    async def test_publish_document_editor(self):
        out = await self.ok("owner", "publish_document", {"markdown": "# Plain", "slug": "pub-classic"})
        self.assertEqual(out["editor"], "classic")
        self.assertIsNone((await self.doc("pub-classic")).get("editor"))
        out = await self.ok("owner", "publish_document", {"markdown": "# Blocks", "slug": "pub-blocks",
                                                          "editor": "blocks"})
        self.assertEqual(out["editor"], "blocks")
        self.assertEqual((await self.doc("pub-blocks"))["editor"], "blocks")
        self.assertEqual((await self.ok("owner", "get_page", {"document": "pub-blocks"}))["editor"], "blocks")
        # In a workspace folder, as a page, with its link on the domain.
        await self.folders()
        out = await self.ok("owner", "publish_document", {"markdown": "# WS", "slug": "pub-ws", "editor": "blocks",
                                                          "workspace": "Acme", "folder": "product-hub/templates"})
        self.assertEqual(out["url"], f"https://{W1}/product-hub/templates/pub-ws")
        self.assertEqual((await self.doc("pub-ws"))["editor"], "blocks")
        # A taken slug names it.
        self.assertIn("'pub-ws'", await self.err("owner", "publish_document", {"markdown": "x", "slug": "pub-ws"}))
        # Beside a folder of that slug: refused before anything exists.
        msg = await self.err("owner", "publish_document", {"markdown": "# F", "slug": "templates",
                                                           "workspace": "Acme", "folder": "product-hub"})
        self.assertIn("templates", msg)
        self.assertIsNone(await self.doc("templates"))


if __name__ == "__main__":
    unittest.main()
