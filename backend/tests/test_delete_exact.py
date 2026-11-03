"""delete_document deletes exactly the item at the slug or link given
(Senseloaf REQUESTS.md #2): another item with the same title in the same
folder — a file and a page, two pages, a parent and its sub-page — is
untouched, still listed by list_workspace_items and still opens with
get_document / get_page. The result lists every item deleted (and every
sub-page moved up). A lifted sub-page stays in its folder, readable.

The access-policy world (tests/_access_env.py): the test MongoDB, an
in-memory R2. Never backend/.env.
"""

from __future__ import annotations

import hashlib

from fastapi import HTTPException

from tests._access_env import AccessWorld, now  # noqa: F401  (pins settings first)

from app.services import access
from app.services import document as doc_service

TITLE = "Product Docs Playbook"
FOLDER = "product-hub"
HTML = b"<html><body><h1>Product Docs Playbook</h1></body></html>"


class DeleteExact(AccessWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        from app.limiter import limiter

        limiter.enabled = False
        self.addCleanup(setattr, limiter, "enabled", True)

    async def call(self, who: str, name: str, args: dict) -> dict:
        status, res = await self.mcp_call(await self.mcp_token(who, write=True), name, args)
        self.assertEqual(status, 200, res)
        return res

    async def ok(self, who: str, name: str, args: dict) -> dict:
        res = await self.call(who, name, args)
        self.assertFalse(res["isError"], res["content"][0]["text"])
        return res["structuredContent"]

    async def err(self, who: str, name: str, args: dict) -> str:
        res = await self.call(who, name, args)
        self.assertTrue(res["isError"], res)
        return res["content"][0]["text"]

    async def upload_html(self, who: str, slug: str) -> dict:
        """create_upload → (the parts) → complete_upload, as an MCP client does."""
        out = await self.ok(who, "create_upload", {
            "file_name": "playbook.html", "size_bytes": len(HTML), "sha256": hashlib.sha256(HTML).hexdigest(),
            "slug": slug, "title": TITLE, "workspace": "Acme", "folder": FOLDER})
        sess = await self.db["file_uploads"].find_one({"_id": out["upload_id"]})
        size = sess["part_size"]
        parts = [{"part_number": n, "etag": self.r2.put_part(sess["r2_upload_id"], n, HTML[(n - 1) * size:n * size])}
                 for n in range(1, sess["part_count"] + 1)]
        done = await self.ok(who, "complete_upload", {"upload_id": out["upload_id"], "parts": parts})
        self.assertEqual((done["state"], done["slug"]), ("done", slug))
        return done

    async def page(self, who: str, **args) -> dict:
        base = {"title": TITLE} if "parent" in args else {"title": TITLE, "workspace": "Acme", "folder": FOLDER}
        return await self.ok(who, "create_page", {**base, **args})

    async def listed(self, who: str = "wm") -> set[str]:
        out = await self.ok(who, "list_workspace_items", {"workspace": "Acme", "folder": FOLDER})
        return {i["slug"] for i in out["items"]}

    async def assert_intact(self, slug: str, *, readers=("wm", "wa")) -> None:
        self.assertIsNotNone(await self.doc(slug), f"{slug} was deleted")
        for who in readers:
            self.assertIn(slug, await self.listed(who), who)
            got = await self.ok(who, "get_document", {"document": slug})
            self.assertEqual((got["slug"], got["title"]), (slug, TITLE))
            if (await self.doc(slug)).get("kind") != "artifact":
                self.assertEqual((await self.ok(who, "get_page", {"document": slug}))["slug"], slug)

    async def assert_gone(self, slug: str) -> None:
        self.assertIsNone(await self.doc(slug))
        self.assertNotIn(slug, await self.listed())
        self.assertIn("couldn't find", await self.err("wm", "get_document", {"document": slug}))

    async def make_folder(self):
        await self.ok("wm", "create_folder", {"workspace": "Acme", "path": FOLDER})

    # ── the repro ──

    async def test_file_then_same_title_page_delete_the_file(self):
        await self.make_folder()
        await self.upload_html("wm", "sl-product-docs-playbook")
        page = await self.page("wm")
        self.assertEqual(await self.listed(), {"sl-product-docs-playbook", page["slug"]})
        out = await self.ok("wm", "delete_document", {"document": "sl-product-docs-playbook"})
        self.assertEqual(out, {"deleted": True, "slug": "sl-product-docs-playbook", "lifted_items": [],
                               "deleted_items": [{"slug": "sl-product-docs-playbook", "title": TITLE,
                                                  "kind": "file"}]})
        await self.assert_gone("sl-product-docs-playbook")
        await self.assert_intact(page["slug"])

    async def test_file_and_page_delete_the_page(self):
        await self.make_folder()
        await self.upload_html("wm", "sl-product-docs-playbook")
        page = await self.page("wm")
        out = await self.ok("wm", "delete_document", {"document": page["slug"]})
        self.assertEqual(out["deleted_items"], [{"slug": page["slug"], "title": TITLE, "kind": "page"}])
        await self.assert_gone(page["slug"])
        await self.assert_intact("sl-product-docs-playbook")

    async def test_delete_by_custom_domain_link(self):
        await self.make_folder()
        await self.upload_html("wm", "sl-product-docs-playbook")
        page = await self.page("wm")
        link = f"https://docs.acme.test/{FOLDER}/sl-product-docs-playbook"
        out = await self.ok("wm", "delete_document", {"document": link})
        self.assertEqual([i["slug"] for i in out["deleted_items"]], ["sl-product-docs-playbook"])
        await self.assert_intact(page["slug"])

    async def test_two_pages_same_title(self):
        await self.make_folder()
        a = await self.page("wm")
        b = await self.page("wo")  # another member's page with the same title
        out = await self.ok("wm", "delete_document", {"document": a["slug"]})
        self.assertEqual([i["slug"] for i in out["deleted_items"]], [a["slug"]])
        await self.assert_gone(a["slug"])
        await self.assert_intact(b["slug"])

    # ── parent and sub-page with the same title ──

    async def test_parent_and_child_same_title_lift(self):
        await self.make_folder()
        sibling = await self.page("wm")
        parent = await self.page("wm")
        child = await self.page("wm", parent=parent["slug"])
        self.assertIn("children=delete", await self.err("wm", "delete_document", {"document": parent["slug"]}))
        self.assertIsNotNone(await self.doc(parent["slug"]))
        out = await self.ok("wm", "delete_document", {"document": parent["slug"], "children": "lift"})
        self.assertEqual(out["deleted_items"], [{"slug": parent["slug"], "title": TITLE, "kind": "page"}])
        self.assertEqual(out["lifted_items"], [{"slug": child["slug"], "title": TITLE, "kind": "page"}])
        await self.assert_gone(parent["slug"])
        row = await self.doc(child["slug"])
        self.assertEqual((row["parent_id"], row["page_path"]), (None, []))
        self.assertEqual(row["folder_path"], [FOLDER])
        await self.assert_intact(child["slug"])
        await self.assert_intact(sibling["slug"])

    async def test_parent_and_child_same_title_delete_child_only(self):
        await self.make_folder()
        parent = await self.page("wm")
        child = await self.page("wm", parent=parent["slug"])
        out = await self.ok("wm", "delete_document", {"document": child["slug"]})
        self.assertEqual([i["slug"] for i in out["deleted_items"]], [child["slug"]])
        await self.assert_intact(parent["slug"])

    async def test_children_delete_lists_every_item(self):
        await self.make_folder()
        sibling = await self.page("wm")
        parent = await self.page("wm")
        child = await self.page("wm", parent=parent["slug"])
        grandchild = await self.ok("wm", "create_page", {"title": "Deep", "parent": child["slug"]})
        out = await self.ok("wm", "delete_document", {"document": parent["slug"], "children": "delete"})
        self.assertEqual(out["deleted_items"], [
            {"slug": grandchild["slug"], "title": "Deep", "kind": "page"},
            {"slug": child["slug"], "title": TITLE, "kind": "page"},
            {"slug": parent["slug"], "title": TITLE, "kind": "page"},
        ])
        self.assertEqual(out["lifted_items"], [])
        for s in (parent["slug"], child["slug"], grandchild["slug"]):
            await self.assert_gone(s)
        await self.assert_intact(sibling["slug"])

    async def test_lift_repairs_a_stale_copy(self):
        """A sub-page whose copied placement/access went stale (a cascade that
        failed) is lifted to what applied through its parent: its parent's
        folder and level, readable by the workspace as before."""
        await self.make_folder()
        parent = await self.page("wm")
        child = await self.page("wm", parent=parent["slug"])
        await self.db["documents"].update_one({"slug": child["slug"]}, {"$set": {
            "folder_id": None, "folder_path": [], "access_level": "private"}})
        await self.ok("wm", "delete_document", {"document": parent["slug"], "children": "lift"})
        row = await self.doc(child["slug"])
        self.assertEqual((row["folder_path"], row["access_level"], row.get("access_dirty")),
                         ([FOLDER], "workspace", True))
        await self.assert_intact(child["slug"])

    # ── the service deletes only the row the caller resolved ──

    async def test_expected_id_mismatch_deletes_nothing(self):
        await self.make_folder()
        a = await self.page("wm")
        b = await self.page("wm")
        row_b = await self.doc(b["slug"])
        actor = access.Actor.of(await self._user("wm"))
        with self.assertRaises(HTTPException) as cm:
            await doc_service.delete_document(self.db, a["slug"], actor, access.Ctx(self.db),
                                              expected_id=row_b["_id"])
        self.assertEqual(cm.exception.status_code, 409)
        self.assertIsNotNone(await self.doc(a["slug"]))
        self.assertIsNotNone(await self.doc(b["slug"]))

    async def _user(self, who: str):
        from app.services import user as user_service

        return await user_service.get_user_by_id(self.db, self.uid[who])
