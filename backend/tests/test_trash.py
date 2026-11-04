"""Trash (services/trash.py): a delete moves the item to the trash for 30 days.

* trashed: gone from every listing and search, its link 404s for everyone but
  says "in the trash" (lookup) only to people who could edit it, its bytes are
  closed under a bumped epoch (objects intact), its slug reserved;
* restore: the same place (folder, parent page, workspace), access, password
  and grants; a batch of sub-pages comes back together; parent / folder /
  workspace gone ⇒ the top level / the workspace root / the owner's own files;
* delete forever and the 30-day purge go through lifecycle.destroy;
* who: the owner (or edit secret) and the workspace's admins; never a tenant
  session;
* MCP: delete_document (trashed, restore_until; deleted / slug /
  deleted_items kept), permanent, restore_document, list_trash, and the
  mcp_events audit (target slug + id, result, never content);
* the same-title regression (Senseloaf).

The access-policy world (tests/_access_env.py): the test MongoDB, an
in-memory R2. Never backend/.env.
"""

from __future__ import annotations

import hashlib
from datetime import timedelta

from bson import ObjectId

from tests._access_env import ES_SECRET, PASSWORD, AccessWorld, now  # noqa: F401  (pins settings first)

from app.services import lifecycle, trash

TITLE = "Product Docs Playbook"
FOLDER = "product-hub"
HTML = b"<html><body><h1>Product Docs Playbook</h1></body></html>"


class TrashWorld(AccessWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        from app.limiter import limiter

        limiter.enabled = False
        self.addCleanup(setattr, limiter, "enabled", True)
        await trash.ensure_indexes(self.db)

    # ── MCP ──

    async def call(self, who: str, name: str, args: dict, *, write: bool = True) -> dict:
        status, res = await self.mcp_call(await self.mcp_token(who, write=write), name, args)
        self.assertEqual(status, 200, res)
        return res

    async def ok(self, who: str, name: str, args: dict, **kw) -> dict:
        res = await self.call(who, name, args, **kw)
        self.assertFalse(res["isError"], res["content"][0]["text"])
        return res["structuredContent"]

    async def err(self, who: str, name: str, args: dict) -> str:
        res = await self.call(who, name, args)
        self.assertTrue(res["isError"], res)
        return res["content"][0]["text"]

    async def upload_html(self, who: str, slug: str, **extra) -> dict:
        out = await self.ok(who, "create_upload", {
            "file_name": "playbook.html", "size_bytes": len(HTML), "sha256": hashlib.sha256(HTML).hexdigest(),
            "slug": slug, "title": TITLE, "workspace": "Acme", "folder": FOLDER, **extra})
        sess = await self.db["file_uploads"].find_one({"_id": out["upload_id"]})
        size = sess["part_size"]
        parts = [{"part_number": n, "etag": self.r2.put_part(sess["r2_upload_id"], n, HTML[(n - 1) * size:n * size])}
                 for n in range(1, sess["part_count"] + 1)]
        done = await self.ok(who, "complete_upload", {"upload_id": out["upload_id"], "parts": parts})
        self.assertEqual(done["slug"], slug)
        return done

    async def page(self, who: str = "wm", **args) -> dict:
        base = {"title": TITLE} if "parent" in args else {"title": TITLE, "workspace": "Acme", "folder": FOLDER}
        return await self.ok(who, "create_page", {**base, **args})

    async def make_folder(self, path: str = FOLDER):
        return await self.ok("wm", "create_folder", {"workspace": "Acme", "path": path})

    async def listed(self, who: str = "wm") -> set[str]:
        out = await self.ok(who, "list_workspace_items", {"workspace": "Acme", "folder": FOLDER})
        return {i["slug"] for i in out["items"]}

    # ── REST ──

    async def rest_delete(self, slug: str, who: str = "wm", **params):
        return await self.http.delete(f"/api/v1/documents/{slug}", params=params, headers=self.session(who))

    async def restore(self, slug: str, headers: dict):
        return await self.http.post(f"/api/v1/trash/{slug}/restore", headers=headers)

    async def lookup(self, slug: str, headers: dict):
        return await self.http.get(f"/api/v1/trash/lookup/{slug}", headers=headers)

    async def trash_list(self, who: str, **params) -> list[dict]:
        r = await self.http.get("/api/v1/trash", params=params, headers=self.session(who))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["items"]

    async def in_trash(self, slug: str) -> dict | None:
        return await self.db["trash"].find_one({"slug": slug})


class Trashed(TrashWorld):
    async def test_rest_delete_moves_to_trash_and_hides_everywhere(self):
        d = await self.mkdoc("L", owner="owner")
        r = await self.rest_delete(d["slug"], who="owner")
        self.assertEqual(r.status_code, 204, r.text)
        self.assertIsNone(await self.doc(d["slug"]))
        row = await self.in_trash(d["slug"])
        self.assertEqual((row["root"], row["deleted_by"], row["via"], row["doc"]["title"]),
                         (True, self.uid["owner"], "web", d["title"]))
        self.assertAlmostEqual((row["purge_at"] - row["deleted_at"]).days, 30)
        # The link: 404 for everyone, the owner too (the 404 page asks the lookup).
        for who in ("owner", "wa", "ge", "stranger"):
            self.assertEqual((await self.get(d["slug"], self.session(who))).status_code, 404, who)
        self.assertEqual((await self.get(d["slug"])).status_code, 404)
        # Lists and search.
        mine = (await self.http.get("/api/v1/me/documents", headers=self.session("owner"))).json()
        self.assertNotIn(d["slug"], {x["slug"] for x in mine["documents"]})
        items = (await self.http.get(f"/api/v1/workspaces/{self.ws['W1']}/items",
                                     headers=self.session("wa"))).json()
        self.assertNotIn(d["slug"], {x["slug"] for x in items["items"]})
        listed = await self.ok("owner", "list_documents", {"scope": "all"})
        self.assertNotIn(d["slug"], {x["slug"] for x in listed["items"]})
        found = await self.ok("owner", "search", {"query": "Title"})
        self.assertNotIn(d["slug"], {x["id"] for x in found["results"]})
        shared = (await self.http.get("/api/v1/me/shared", headers=self.session("ge"))).json()
        self.assertNotIn(d["slug"], str(shared))
        quick = (await self.http.get("/api/v1/search/quick", params={"q": "Title"},
                                     headers=self.session("owner"))).json()
        self.assertNotIn(d["slug"], str(quick))
        self.assertIn("couldn't find", await self.err("owner", "get_document", {"document": d["slug"]}))

    async def test_lookup_only_for_people_who_could_edit(self):
        d = await self.mkdoc("W", owner="owner")
        await self.rest_delete(d["slug"], who="owner")
        expect = {"owner": (200, True), "wa": (200, True), "wo": (200, True), "ge": (200, False),
                  "wm": (200, False), "gv": (404, None), "wv": (404, None), "stranger": (404, None)}
        for who, (status, can) in expect.items():
            r = await self.lookup(d["slug"], self.session(who))
            self.assertEqual(r.status_code, status, (who, r.text))
            if status == 200:
                body = r.json()
                self.assertEqual((body["slug"], body["title"], body["can"]["restore"]), (d["slug"], d["title"], can), who)
                self.assertEqual(body["days_left"], 30)
        self.assertEqual((await self.lookup(d["slug"], {})).status_code, 404)
        self.assertEqual((await self.lookup(d["slug"], {"X-Edit-Secret": ES_SECRET})).json()["can"]["restore"], True)
        self.assertIn((await self.lookup(d["slug"], self.tenant("wa", "W1"))).status_code, (401, 404))
        self.assertEqual((await self.lookup("nothing-here", self.session("owner"))).status_code, 404)

    async def test_bytes_closed_while_trashed_and_reopened_on_restore(self):
        d = await self.mkdoc("UL", owner="owner", kind="artifact")
        key = d["blob_key"]
        self.assertTrue(self.r2.objects[key]["public"])
        await self.rest_delete(d["slug"], who="owner")
        obj = self.r2.objects[key]
        self.assertFalse(obj["public"])          # no longer served without a token
        self.assertEqual(obj["ae"], "1")          # every signed link handed out so far is refused
        self.assertEqual(obj["data"], b"<h1>page</h1>")  # intact
        self.assertEqual((await self.in_trash(d["slug"]))["doc"]["access_epoch"], 1)
        r = await self.restore(d["slug"], self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(self.r2.objects[key]["public"])
        row = await self.doc(d["slug"])
        self.assertEqual((row["access_epoch"], row.get("access_dirty")), (1, False))

    async def test_bundle_and_private_bytes(self):
        site = await self.mkdoc("UL", owner="owner", kind="artifact", bundle=True)
        priv = await self.mkdoc("P", owner="owner", kind="artifact")
        for d in (site, priv):
            await self.rest_delete(d["slug"], who="owner")
        for k, o in self.r2.objects.items():
            if k.startswith(site["bundle_prefix"]) or k == priv["blob_key"]:
                self.assertFalse(o["public"], k)
        await self.restore(site["slug"], self.session("owner"))
        await self.restore(priv["slug"], self.session("owner"))
        for k, o in self.r2.objects.items():
            if k.startswith(site["bundle_prefix"]):
                self.assertTrue(o["public"], k)
        self.assertFalse(self.r2.objects[priv["blob_key"]]["public"])

    async def test_failed_close_moves_nothing(self):
        d = await self.mkdoc("UL", owner="owner", kind="artifact")
        self.r2.fail_set_public = True
        r = await self.rest_delete(d["slug"], who="owner")
        self.assertEqual(r.status_code, 502)
        self.assertIsNotNone(await self.doc(d["slug"]))
        self.assertIsNone(await self.in_trash(d["slug"]))

    async def test_slug_reserved_for_everyone_while_trashed(self):
        d = await self.mkdoc("UL", owner="owner", slug="keep-this-one")
        await self.rest_delete(d["slug"], who="owner")
        for who in ("owner", "stranger"):
            r = await self.http.post("/api/v1/documents", json={"content": "# x", "custom_slug": "keep-this-one"},
                                     headers=self.session(who))
            self.assertEqual(r.status_code, 409, (who, r.text))
        other = await self.mkdoc("UL", owner="owner")
        r = await self.http.patch(f"/api/v1/documents/{other['slug']}/slug", json={"new_slug": "keep-this-one"},
                                  headers=self.session("owner"))
        self.assertEqual(r.status_code, 409, r.text)
        self.assertTrue(await lifecycle.slug_unavailable(self.db, "keep-this-one", self.uid["owner"]))
        # Deleted forever: the usual 30-day tombstone (the same owner may take it back).
        await self.http.delete("/api/v1/trash/keep-this-one", headers=self.session("owner"))
        self.assertFalse(await lifecycle.slug_unavailable(self.db, "keep-this-one", self.uid["owner"]))
        self.assertTrue(await lifecycle.slug_unavailable(self.db, "keep-this-one", self.uid["stranger"]))


class Restore(TrashWorld):
    async def test_restore_puts_it_back_with_access_and_grants(self):
        await self.make_folder()
        fid = (await self.db["folders"].find_one({"slug": FOLDER}))["_id"]
        d = await self.mkdoc("LP", owner="owner", folder_id=str(fid), folder_path=[FOLDER])
        before = await self.db["document_grants"].count_documents({"document_id": str(d["_id"])})
        self.assertEqual(before, 2)
        await self.rest_delete(d["slug"], who="owner")
        # Housekeeping while it is in the trash must not drop its grants.
        await lifecycle.reconcile_once(self.db, full=True)
        await lifecycle.member_left(self.db, self.ws["W1"], self.uid["wm"])
        r = await self.restore(d["slug"], self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual((body["restored"], body["slug"], body["notes"]), (True, d["slug"], []))
        row = await self.doc(d["slug"])
        self.assertEqual((row["_id"], row["workspace_id"], row["folder_id"], row["folder_path"], row["access_level"],
                          bool(row["read_password_hash"])),
                         (d["_id"], self.ws["W1"], str(fid), [FOLDER], "link", True))
        self.assertEqual(await self.db["document_grants"].count_documents({"document_id": str(d["_id"])}), 2)
        self.assertIsNone(await self.in_trash(d["slug"]))
        self.assertEqual((await self.get(d["slug"], self.session("ge"))).status_code, 200)
        self.assertEqual((await self.get(d["slug"], {"X-Read-Password": PASSWORD})).status_code, 200)

    async def test_children_delete_trash_and_restore_together(self):
        await self.make_folder()
        sibling = await self.page()
        parent = await self.page()
        child = await self.page(parent=parent["slug"])
        grandchild = await self.ok("wm", "create_page", {"title": "Deep", "parent": child["slug"]})
        r = await self.rest_delete(parent["slug"], children="delete")
        self.assertEqual(r.status_code, 204, r.text)
        for s in (parent["slug"], child["slug"], grandchild["slug"]):
            self.assertIsNone(await self.doc(s))
        rows = {r["slug"]: r async for r in self.db["trash"].find({})}
        self.assertEqual({s: (rows[s]["root"], rows[s]["depth"]) for s in rows},
                         {parent["slug"]: (True, 0), child["slug"]: (False, 1), grandchild["slug"]: (False, 2)})
        listed = await self.trash_list("wm")
        self.assertEqual([(i["slug"], i["sub_pages"]) for i in listed], [(parent["slug"], 2)])
        self.assertEqual(await self.listed(), {sibling["slug"]})
        # Restoring a sub-page restores the whole batch.
        r = await self.restore(grandchild["slug"], self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([i["slug"] for i in r.json()["items"]], [parent["slug"], child["slug"], grandchild["slug"]])
        p, c, g = [await self.doc(s) for s in (parent["slug"], child["slug"], grandchild["slug"])]
        self.assertEqual((c["parent_id"], g["parent_id"]), (p["_id"], c["_id"]))
        self.assertEqual((c["page_path"], g["page_path"]), ([parent["slug"]], [parent["slug"], child["slug"]]))
        self.assertEqual(await self.listed(), {sibling["slug"], parent["slug"], child["slug"], grandchild["slug"]})
        sub = await self.ok("wa", "list_subpages", {"document": parent["slug"]})
        self.assertEqual([x["slug"] for x in sub["children"]], [child["slug"]])
        self.assertEqual(await self.db["trash"].count_documents({}), 0)

    async def test_lift_then_restore_the_page_alone(self):
        await self.make_folder()
        parent = await self.page()
        child = await self.page(parent=parent["slug"])
        await self.rest_delete(parent["slug"], children="lift")
        self.assertIsNone((await self.doc(child["slug"]))["parent_id"])
        await self.restore(parent["slug"], self.session("wm"))
        self.assertIsNotNone(await self.doc(parent["slug"]))
        self.assertIsNone((await self.doc(child["slug"]))["parent_id"])  # lifted stays lifted

    async def test_sub_page_back_under_its_parent_or_top_when_parent_gone(self):
        await self.make_folder()
        parent = await self.page()
        a = await self.page(parent=parent["slug"])
        b = await self.page(parent=parent["slug"])
        await self.rest_delete(a["slug"])
        await self.rest_delete(b["slug"])
        r = await self.restore(a["slug"], self.session("wm"))
        self.assertEqual((await self.doc(a["slug"]))["parent_id"], (await self.doc(parent["slug"]))["_id"])
        self.assertEqual(r.json()["notes"], [])
        # The parent goes for good: b comes back at the top level of the folder, readable by the team.
        await self.rest_delete(parent["slug"], children="lift")
        await self.http.delete(f"/api/v1/trash/{parent['slug']}", headers=self.session("wm"))
        r = await self.restore(b["slug"], self.session("wm"))
        self.assertIn("top level", " ".join(r.json()["notes"]))
        row = await self.doc(b["slug"])
        self.assertEqual((row["parent_id"], row["page_path"], row["folder_path"], row["access_level"]),
                         (None, [], [FOLDER], "workspace"))
        self.assertIn(b["slug"], await self.listed("wv"))

    async def test_folder_gone_goes_to_the_workspace_root(self):
        await self.make_folder()
        p = await self.page()
        q = await self.page()
        await self.rest_delete(p["slug"])
        await self.rest_delete(q["slug"])
        folder = await self.db["folders"].find_one({"slug": FOLDER})
        # The folder goes to the trash too (the default): p comes back to the top of the workspace.
        r = await self.http.delete(f"/api/v1/workspaces/{self.ws['W1']}/folders/{folder['_id']}",
                                   headers=self.session("wa"))
        self.assertEqual(r.json(), {"unfiled_documents": 0, "trashed": True, "trashed_documents": 0,
                                    "trashed_folders": 1})
        r = await self.restore(p["slug"], self.session("wm"))
        self.assertIn("folder is in the trash", " ".join(r.json()["notes"]))
        row = await self.doc(p["slug"])
        self.assertEqual((row["workspace_id"], row["folder_id"], row["folder_path"]), (self.ws["W1"], None, []))
        # Deleted for good (the folder's trash entry deleted forever): the same.
        r = await self.http.delete(f"/api/v1/trash/{folder['_id']}", headers=self.session("wa"))
        self.assertEqual(r.status_code, 200, r.text)
        r = await self.restore(q["slug"], self.session("wm"))
        self.assertIn("folder was deleted", " ".join(r.json()["notes"]))

    async def test_workspace_gone_goes_to_own_files_never_wider(self):
        d = await self.mkdoc("W", owner="owner")
        await self.rest_delete(d["slug"], who="owner")
        await self.db["workspaces"].delete_one({"_id": ObjectId(self.ws["W1"])})
        r = await self.restore(d["slug"], self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("workspace was deleted", " ".join(r.json()["notes"]))
        row = await self.doc(d["slug"])
        self.assertEqual((row["workspace_id"], row["access_level"]), (None, "private"))
        self.assertEqual((await self.get(d["slug"], self.session("wm"))).status_code, 404)

    async def test_expired_in_the_trash_is_purged_not_restored(self):
        d = await self.mkdoc("UL", owner="owner")
        await self.rest_delete(d["slug"], who="owner")
        await self.db["trash"].update_one({"slug": d["slug"]}, {"$set": {"doc.expires_at": now() - timedelta(minutes=1)}})
        self.assertEqual((await self.restore(d["slug"], self.session("owner"))).status_code, 410)
        self.assertEqual(await trash.purge_due(self.db), 1)
        self.assertIsNone(await self.in_trash(d["slug"]))

    async def test_anonymous_document_restored_with_its_edit_secret(self):
        d = await self.mkdoc("UL", owner=None)
        r = await self.http.delete(f"/api/v1/documents/{d['slug']}", headers={"X-Edit-Secret": ES_SECRET})
        self.assertEqual(r.status_code, 204, r.text)
        self.assertEqual((await self.in_trash(d["slug"]))["via"], "edit secret")
        self.assertEqual((await self.restore(d["slug"], {})).status_code, 404)
        self.assertEqual((await self.restore(d["slug"], {"X-Edit-Secret": "wrong"})).status_code, 404)
        self.assertEqual((await self.restore(d["slug"], {"X-Edit-Secret": ES_SECRET})).status_code, 200)
        self.assertIsNotNone(await self.doc(d["slug"]))


class Forever(TrashWorld):
    async def test_delete_forever_destroys(self):
        d = await self.mkdoc("UL", owner="owner", kind="artifact")
        await self.rest_delete(d["slug"], who="owner")
        self.assertIn(d["blob_key"], self.r2.objects)
        r = await self.http.delete(f"/api/v1/trash/{d['slug']}", headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"deleted": True, "items": [{"slug": d["slug"], "title": d["title"], "kind": "file"}]})
        self.assertNotIn(d["blob_key"], self.r2.objects)
        self.assertIsNone(await self.in_trash(d["slug"]))
        self.assertEqual(await self.db["document_grants"].count_documents({"document_id": str(d["_id"])}), 0)
        self.assertIsNotNone(await self.db["slug_tombstones"].find_one({"slug": d["slug"]}))
        self.assertEqual((await self.restore(d["slug"], self.session("owner"))).status_code, 404)

    async def test_purge_after_30_days(self):
        old = await self.mkdoc("UL", owner="owner", kind="artifact")
        fresh = await self.mkdoc("UL", owner="owner")
        for d in (old, fresh):
            await self.rest_delete(d["slug"], who="owner")
        await self.db["trash"].update_one({"slug": old["slug"]}, {"$set": {"purge_at": now() - timedelta(seconds=1)}})
        from app.services import background

        await background._trash(self.db)
        self.assertIsNone(await self.in_trash(old["slug"]))
        self.assertNotIn(old["blob_key"], self.r2.objects)
        self.assertIsNotNone(await self.in_trash(fresh["slug"]))

    async def test_purge_never_destroys_a_live_row(self):
        d = await self.mkdoc("UL", owner="owner")
        # A move that died half way: the trash row exists, the document is still live.
        await self.db["trash"].insert_one({"_id": d["_id"], "doc": d, "slug": "leftover-" + d["slug"],
                                           "batch": str(d["_id"]), "root": True, "depth": 0,
                                           "purge_at": now() - timedelta(days=1)})
        await trash.purge_due(self.db)
        self.assertIsNotNone(await self.doc(d["slug"]))
        self.assertEqual(await self.db["trash"].count_documents({}), 0)

    async def test_batch_purged_together(self):
        await self.make_folder()
        parent = await self.page()
        child = await self.page(parent=parent["slug"])
        await self.rest_delete(parent["slug"], children="delete")
        await self.db["trash"].update_many({}, {"$set": {"purge_at": now() - timedelta(seconds=1)}})
        self.assertEqual(await trash.purge_due(self.db), 2)
        for s in (parent["slug"], child["slug"]):
            self.assertIsNotNone(await self.db["slug_tombstones"].find_one({"slug": s}))

    async def test_page_images_and_history_survive_cleanups_while_trashed(self):
        from app.services import page_history

        d = await self.mkdoc("UL", owner="owner", editor="blocks")
        await self.db["page_assets"].insert_one({"_id": "img1", "doc_id": str(d["_id"]), "key": f"pa/{d['_id']}/img1.png",
                                                 "mime": "image/png", "size": 3, "owner_id": self.uid["owner"],
                                                 "unreferenced_since": now() - timedelta(days=60)})
        self.r2.put_bytes(f"pa/{d['_id']}/img1.png", b"png", "image/png", True)
        await self.db["page_versions"].insert_one({"doc_id": str(d["_id"]), "ts": now(), "rev": 1})
        await self.rest_delete(d["slug"], who="owner")
        self.assertFalse(self.r2.objects[f"pa/{d['_id']}/img1.png"]["public"])
        await page_history.cleanup_images(self.db)
        await page_history.thin(self.db)
        self.assertIsNotNone(await self.db["page_assets"].find_one({"_id": "img1"}))
        self.assertIn(f"pa/{d['_id']}/img1.png", self.r2.objects)
        self.assertEqual(await self.db["page_versions"].count_documents({"doc_id": str(d["_id"])}), 1)


class Who(TrashWorld):
    async def test_permission_matrix(self):
        mine = await self.mkdoc("W", owner="owner")
        theirs = await self.mkdoc("UL", owner="stranger", ws=None)
        await self.rest_delete(mine["slug"], who="owner")
        await self.rest_delete(theirs["slug"], who="stranger")
        # Who sees it in their trash.
        seen = {who: {i["slug"] for i in await self.trash_list(who)}
                for who in ("owner", "wa", "wo", "wm", "ge", "stranger", "wm2")}
        self.assertEqual(seen, {"owner": {mine["slug"]}, "wa": {mine["slug"]}, "wo": {mine["slug"]},
                                "wm": set(), "ge": set(), "stranger": {theirs["slug"]}, "wm2": set()})
        self.assertEqual({i["slug"] for i in await self.trash_list("wa", workspace=self.ws["W1"])}, {mine["slug"]})
        self.assertEqual(await self.trash_list("wm", workspace=self.ws["W1"]), [])
        r = await self.http.get("/api/v1/trash", params={"workspace": self.ws["W1"]}, headers=self.session("wm2"))
        self.assertEqual(r.status_code, 404)
        self.assertEqual((await self.http.get("/api/v1/trash")).status_code, 401)
        self.assertEqual((await self.http.get("/api/v1/trash", headers=self.tenant("wa", "W1"))).status_code, 401)
        # Restore / delete forever: owner and workspace admins only; never a tenant session.
        for who in ("wm", "ge", "gv", "stranger", "wv"):
            self.assertEqual((await self.restore(mine["slug"], self.session(who))).status_code, 404, who)
            r = await self.http.delete(f"/api/v1/trash/{mine['slug']}", headers=self.session(who))
            self.assertEqual(r.status_code, 404, who)
        self.assertEqual((await self.restore(mine["slug"], self.tenant("wa", "W1"))).status_code, 401)
        self.assertEqual((await self.restore(mine["slug"], self.session("wa"))).status_code, 200)
        await self.rest_delete(mine["slug"], who="owner")
        self.assertEqual((await self.http.delete(f"/api/v1/trash/{mine['slug']}",
                                                 headers=self.session("wo"))).status_code, 200)
        # A delete itself: only the owner (or the edit secret), as before.
        d = await self.mkdoc("W", owner="owner")
        for who in ("wa", "wo", "ge"):
            self.assertEqual((await self.rest_delete(d["slug"], who=who)).status_code, 403, who)
        self.assertEqual((await self.http.delete(f"/api/v1/documents/{d['slug']}",
                                                 headers=self.tenant("owner", "W1"))).status_code, 401)

    async def test_list_item_shape(self):
        await self.make_folder()
        p = await self.page()
        await self.rest_delete(p["slug"])
        (item,) = await self.trash_list("wm")
        self.assertEqual({k: item[k] for k in ("slug", "title", "kind", "days_left", "sub_pages", "is_mine")},
                         {"slug": p["slug"], "title": TITLE, "kind": "page", "days_left": 30, "sub_pages": 0,
                          "is_mine": True})
        self.assertEqual(item["where"]["workspace"]["name"], "Acme")
        self.assertEqual(item["where"]["folder"]["name"], FOLDER)
        self.assertEqual(item["deleted_by"], {"id": self.uid["wm"], "name": "WM", "is_you": True})
        self.assertEqual(item["can"], {"restore": True, "delete_forever": True})
        self.assertTrue(item["url"].endswith("/" + p["slug"]))

    async def test_delete_preview(self):
        await self.make_folder()
        parent = await self.page()
        child = await self.page(parent=parent["slug"])
        await self.ok("wm", "create_page", {"title": "Deep", "parent": child["slug"]})
        r = await self.http.get(f"/api/v1/documents/{parent['slug']}/delete-preview", headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual({k: r.json()[k] for k in ("slug", "title", "kind", "children", "descendants", "days")},
                         {"slug": parent["slug"], "title": TITLE, "kind": "page", "children": 1, "descendants": 2,
                          "days": 30})
        r = await self.http.get(f"/api/v1/documents/{parent['slug']}/delete-preview", headers=self.session("wa"))
        self.assertEqual(r.status_code, 403)


class Mcp(TrashWorld):
    async def test_delete_document_trashes_backwards_compatible(self):
        await self.make_folder()
        await self.upload_html("wm", "sl-product-docs-playbook")
        page = await self.page()
        out = await self.ok("wm", "delete_document", {"document": page["slug"]})
        self.assertEqual({k: out[k] for k in ("deleted", "slug", "deleted_items", "lifted_items", "trashed")},
                         {"deleted": True, "slug": page["slug"], "lifted_items": [], "trashed": True,
                          "deleted_items": [{"slug": page["slug"], "title": TITLE, "kind": "page"}]})
        self.assertTrue(out["restore_until"].endswith("Z"))
        self.assertEqual(await self.listed(), {"sl-product-docs-playbook"})
        text = await self.err("wm", "delete_document", {"document": page["slug"]})
        self.assertIn("already in the trash", text)
        listed = await self.ok("wm", "list_trash", {}, write=False)
        self.assertEqual([(i["slug"], i["kind"], i["workspace"], i["folder"], i["days_left"]) for i in listed["items"]],
                         [(page["slug"], "page", "Acme", FOLDER, 30)])
        self.assertEqual((await self.ok("wa", "list_trash", {"workspace": "Acme"}, write=False))["items"][0]["slug"],
                         page["slug"])
        self.assertEqual((await self.ok("wv", "list_trash", {}, write=False))["items"], [])
        back = await self.ok("wm", "restore_document", {"document": page["slug"]})
        self.assertEqual((back["restored"], back["slug"], back["restored_items"], back["notes"]),
                         (True, page["slug"], [{"slug": page["slug"], "title": TITLE, "kind": "page"}], []))
        self.assertEqual(await self.listed(), {"sl-product-docs-playbook", page["slug"]})
        self.assertIn("isn't in the trash", await self.err("wm", "restore_document", {"document": page["slug"]}))
        self.assertIn("couldn't find", await self.err("wm", "restore_document", {"document": "no-such-thing"}))

    async def test_restore_by_link_and_by_someone_else(self):
        d = await self.mkdoc("W", owner="owner")
        await self.ok("owner", "delete_document", {"document": d["slug"]})
        self.assertIn("couldn't find", await self.err("wm", "restore_document", {"document": d["slug"]}))
        out = await self.ok("wa", "restore_document", {"document": f"https://markdrop.in/{d['slug']}"})
        self.assertEqual(out["slug"], d["slug"])

    async def test_permanent(self):
        d = await self.mkdoc("W", owner="owner", kind="artifact")
        out = await self.ok("owner", "delete_document", {"document": d["slug"], "permanent": True})
        self.assertEqual((out["trashed"], out["restore_until"], out["deleted"]), (False, None, True))
        self.assertIsNone(await self.in_trash(d["slug"]))
        self.assertNotIn(d["blob_key"], self.r2.objects)
        # An admin can't delete someone's live item (forever or not) …
        e = await self.mkdoc("W", owner="owner")
        self.assertIn("only", (await self.err("wa", "delete_document", {"document": e["slug"], "permanent": True})).lower())
        # … but can delete forever what is in their workspace's trash.
        await self.ok("owner", "delete_document", {"document": e["slug"]})
        self.assertIn("couldn't find", await self.err("wm", "delete_document", {"document": e["slug"], "permanent": True}))
        out = await self.ok("wa", "delete_document", {"document": e["slug"], "permanent": True})
        self.assertEqual((out["trashed"], [i["slug"] for i in out["deleted_items"]]), (False, [e["slug"]]))
        self.assertIsNone(await self.in_trash(e["slug"]))

    async def test_children_delete_over_mcp(self):
        await self.make_folder()
        parent = await self.page()
        child = await self.page(parent=parent["slug"])
        out = await self.ok("wm", "delete_document", {"document": parent["slug"], "children": "delete"})
        self.assertEqual([i["slug"] for i in out["deleted_items"]], [child["slug"], parent["slug"]])
        back = await self.ok("wm", "restore_document", {"document": child["slug"]})
        self.assertEqual([i["slug"] for i in back["restored_items"]], [parent["slug"], child["slug"]])

    async def test_audit_records_target_and_result_never_content(self):
        await self.make_folder()
        page = await self.page()
        row = await self.doc(page["slug"])
        await self.ok("wm", "set_access", {"document": page["slug"], "access": "private"})
        await self.ok("wm", "delete_document", {"document": page["slug"]})
        await self.ok("wm", "restore_document", {"document": page["slug"]})
        await self.err("wm", "delete_document", {"document": "missing-one"})
        await self.ok("wm", "get_document", {"document": page["slug"]})
        events = {e["tool"]: e async for e in self.db["mcp_events"].find({"user_id": self.uid["wm"]})}
        target = {"slug": page["slug"], "doc_id": str(row["_id"])}
        self.assertEqual(events["set_access"]["target"], target)
        d = [e async for e in self.db["mcp_events"].find({"tool": "delete_document"}).sort("ts", 1)]
        self.assertEqual(d[0]["target"], target)
        self.assertEqual(d[0]["result"]["items"], [{**target, "kind": "page"}])
        self.assertEqual((d[0]["result"]["trashed"], d[0]["result"]["slug"]), (True, page["slug"]))
        self.assertEqual((d[1]["ok"], d[1]["target"]), (False, None))
        self.assertIn("couldn't find", d[1]["result"]["error"])
        self.assertEqual(events["restore_document"]["target"], target)
        self.assertEqual(events["restore_document"]["result"]["restored"], [page["slug"]])
        self.assertNotIn("target", events["get_document"])  # reads: who/tool/when only, as before
        blob = str([e async for e in self.db["mcp_events"].find({})])
        self.assertNotIn(TITLE, blob)
        self.assertNotIn("content", blob)


class SameTitle(TrashWorld):
    """The Senseloaf incident: a page and an HTML file with the same title in
    one folder; deleting one never touches the other, and nothing is lost."""

    async def test_delete_the_file_page_untouched_then_restore(self):
        await self.make_folder()
        await self.upload_html("wm", "sl-product-docs-playbook")
        page = await self.page()
        await self.ok("wm", "delete_document", {"document": "sl-product-docs-playbook"})
        self.assertEqual(await self.listed(), {page["slug"]})
        self.assertEqual((await self.ok("wa", "get_page", {"document": page["slug"]}))["slug"], page["slug"])
        self.assertEqual([i["slug"] for i in await self.trash_list("wm")], ["sl-product-docs-playbook"])
        await self.ok("wm", "restore_document", {"document": "sl-product-docs-playbook"})
        self.assertEqual(await self.listed(), {page["slug"], "sl-product-docs-playbook"})

    async def test_delete_the_page_file_untouched(self):
        await self.make_folder()
        await self.upload_html("wm", "sl-product-docs-playbook")
        page = await self.page()
        r = await self.rest_delete(page["slug"])
        self.assertEqual(r.status_code, 204)
        self.assertEqual(await self.listed(), {"sl-product-docs-playbook"})
        got = await self.ok("wa", "get_document", {"document": "sl-product-docs-playbook"})
        self.assertEqual(got["title"], TITLE)
        (item,) = await self.trash_list("wm")
        self.assertEqual((item["slug"], item["kind"]), (page["slug"], "page"))


class Folders(TrashWorld):
    """Owner decision: deleting a folder moves it and everything inside to the
    trash; restoring brings the whole folder back with its structure."""

    async def build(self):
        await self.make_folder()
        await self.make_folder(f"{FOLDER}/inner")
        top = await self.db["folders"].find_one({"slug": FOLDER})
        inner = await self.db["folders"].find_one({"slug": "inner"})
        page = await self.page()
        sub = await self.page(parent=page["slug"])
        await self.upload_html("wm", "sl-product-docs-playbook")
        deep = await self.ok("owner", "create_page", {"title": "Inner page", "workspace": "Acme",
                                                      "folder": f"{FOLDER}/inner"})
        return top, inner, page, sub, deep

    async def test_folder_and_everything_inside_trashed_and_restored(self):
        top, inner, page, sub, deep = await self.build()
        slugs = {page["slug"], sub["slug"], "sl-product-docs-playbook", deep["slug"]}
        r = await self.http.delete(f"/api/v1/workspaces/{self.ws['W1']}/folders/{top['_id']}",
                                   headers=self.session("wa"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["trashed_documents"], r.json()["trashed_folders"]), (4, 2))
        self.assertEqual(await self.db["folders"].count_documents({"workspace_id": self.ws["W1"]}), 0)
        for s in slugs:
            self.assertIsNone(await self.doc(s), s)
            self.assertEqual((await self.get(s, self.session("wa"))).status_code, 404)
        tree = (await self.http.get(f"/api/v1/workspaces/{self.ws['W1']}/items", headers=self.session("wa"))).json()
        self.assertEqual(tree["items"], [])
        # Its admins see one folder entry; a member sees their own items from it.
        (entry,) = await self.trash_list("wa")
        self.assertEqual((entry["kind"], entry["title"], entry["key"], entry["contents"]),
                         ("folder", FOLDER, str(top["_id"]), {"items": 4, "folders": 1}))
        self.assertEqual(entry["where"]["workspace"]["name"], "Acme")
        mine = await self.trash_list("wm")
        self.assertEqual({(i["slug"], i["sub_pages"]) for i in mine},
                         {(page["slug"], 1), ("sl-product-docs-playbook", 0)})
        self.assertEqual(mine[0]["deleted_with"]["folder"], FOLDER)
        self.assertEqual({i["slug"] for i in await self.trash_list("owner")}, {deep["slug"]})
        # wm can't restore the folder; wa restores all of it.
        self.assertEqual((await self.restore(str(top["_id"]), self.session("wm"))).status_code, 404)
        r = await self.restore(str(top["_id"]), self.session("wa"))
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual((body["kind"], body["folders"], len(body["items"]), body["notes"]), ("folder", 2, 4, []))
        self.assertEqual({f["slug"] for f in await self.db["folders"].find({}).to_list(length=10)}, {FOLDER, "inner"})
        self.assertEqual((await self.db["folders"].find_one({"slug": "inner"}))["parent_id"], str(top["_id"]))
        self.assertEqual((await self.doc(deep["slug"]))["folder_path"], [FOLDER, "inner"])
        self.assertEqual((await self.doc(sub["slug"]))["parent_id"], (await self.doc(page["slug"]))["_id"])
        self.assertEqual(await self.listed(), slugs - {deep["slug"]})
        self.assertEqual(await self.db["trash"].count_documents({}), 0)

    async def test_member_takes_their_item_out_then_admin_restores_the_rest(self):
        top, inner, page, sub, deep = await self.build()
        await self.http.delete(f"/api/v1/workspaces/{self.ws['W1']}/folders/{top['_id']}", headers=self.session("wa"))
        r = await self.restore(sub["slug"], self.session("wm"))  # a sub-page: its unit is the page
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([i["slug"] for i in r.json()["items"]], [page["slug"], sub["slug"]])
        self.assertIn("folder is in the trash", " ".join(r.json()["notes"]))
        row = await self.doc(page["slug"])
        self.assertEqual((row["folder_id"], row["workspace_id"]), (None, self.ws["W1"]))
        r = await self.restore(str(top["_id"]), self.session("wo"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual({i["slug"] for i in r.json()["items"]}, {"sl-product-docs-playbook", deep["slug"]})

    async def test_restore_renames_when_the_address_was_taken(self):
        top, *_ = await self.build()
        await self.http.delete(f"/api/v1/workspaces/{self.ws['W1']}/folders/{top['_id']}", headers=self.session("wa"))
        await self.make_folder()  # a new folder with the same name
        r = await self.restore(str(top["_id"]), self.session("wa"))
        self.assertIn(f"/{FOLDER}-2", " ".join(r.json()["notes"]))
        self.assertEqual((await self.db["folders"].find_one({"_id": top["_id"]}))["slug"], f"{FOLDER}-2")

    async def test_delete_forever_and_purge(self):
        top, inner, page, sub, deep = await self.build()
        await self.http.delete(f"/api/v1/workspaces/{self.ws['W1']}/folders/{top['_id']}", headers=self.session("wa"))
        self.assertEqual((await self.http.delete(f"/api/v1/trash/{top['_id']}",
                                                 headers=self.session("wm"))).status_code, 404)
        r = await self.http.delete(f"/api/v1/trash/{top['_id']}", headers=self.session("wa"))
        self.assertEqual(len(r.json()["items"]), 4)
        self.assertEqual(await self.db["trash"].count_documents({}), 0)
        self.assertNotIn("sl-product-docs-playbook", {k.split("/")[-1] for k in self.r2.objects})

    async def test_old_modes_still_unfile(self):
        top, inner, page, sub, deep = await self.build()
        r = await self.http.delete(f"/api/v1/workspaces/{self.ws['W1']}/folders/{top['_id']}",
                                   params={"mode": "unfile"}, headers=self.session("wa"))
        self.assertEqual(r.json()["trashed"], False)
        self.assertIsNotNone(await self.doc(page["slug"]))
        self.assertEqual(await self.db["trash"].count_documents({}), 0)

    async def test_only_admins_delete_folders_and_never_on_the_domain(self):
        top, *_ = await self.build()
        for who in ("wm", "wv"):
            r = await self.http.delete(f"/api/v1/workspaces/{self.ws['W1']}/folders/{top['_id']}",
                                       headers=self.session(who))
            self.assertEqual(r.status_code, 403, who)
        self.assertIsNotNone(await self.db["folders"].find_one({"_id": top["_id"]}))

    async def test_mcp_lists_and_restores_a_folder(self):
        top, *_ = await self.build()
        await self.http.delete(f"/api/v1/workspaces/{self.ws['W1']}/folders/{top['_id']}", headers=self.session("wa"))
        (item,) = (await self.ok("wa", "list_trash", {"workspace": "Acme"}, write=False))["items"]
        self.assertEqual((item["kind"], item["slug"], item["items_inside"]), ("folder", str(top["_id"]), 4))
        out = await self.ok("wa", "restore_document", {"document": str(top["_id"])})
        self.assertEqual((out["kind"], len(out["restored_items"])), ("folder", 4))

    async def test_admin_sees_no_title_it_cannot_read(self):
        d = await self.mkdoc("P", owner="owner", grants=False)
        await self.rest_delete(d["slug"], who="owner")
        (item,) = await self.trash_list("wa")
        self.assertEqual((item["slug"], item["title"], item["hidden"], item["can"]["restore"]),
                         (d["slug"], None, True, True))
        (own,) = await self.trash_list("owner")
        self.assertEqual((own["title"], own["hidden"]), (d["title"], False))
