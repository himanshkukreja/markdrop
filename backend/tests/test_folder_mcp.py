"""Folders through MCP (Senseloaf: "create_folder but no way to delete, rename
or move a folder"; create_folder silently made "feat-0001-talent-pool-2").

* create_folder refuses an address something already holds where the folder
  would go — a page there (named, the caller can read it), a document the
  caller can't read (not named), a sibling folder (named) — and creates
  nothing; ``on_conflict: "suffix"`` opts into the next free address. The
  app's New folder / rename / move (REST) refuse the same way.
* rename_folder / move_folder: admins; clashes refused; old addresses of the
  folder (and of its subfolders, by prefix) answer ``moved_to`` on the
  workspace's domain, items' old addresses still reach them (slug).
* delete_folder: admins; empty → trash (restore_document brings it back);
  non-empty → refused with what's inside (structuredContent, unreadable items
  counted but never named); ``move_to_parent``; ``trash`` + restore.

The access-policy world (tests/_access_env.py): the test MongoDB, an
in-memory R2. Never backend/.env.
"""

from __future__ import annotations

from bson import ObjectId

from tests._access_env import HOSTS, AccessWorld  # noqa: F401  (pins settings first)

from app.services import folder as folder_service

WS = "Acme"


class FolderMcp(AccessWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        from app.limiter import limiter

        limiter.enabled = False
        self.addCleanup(setattr, limiter, "enabled", True)

    async def call(self, who: str, name: str, args: dict, *, write: bool = True) -> dict:
        status, res = await self.mcp_call(await self.mcp_token(who, write=write), name, args)
        self.assertEqual(status, 200, res)
        return res

    async def ok(self, who: str, name: str, args: dict, **kw) -> dict:
        res = await self.call(who, name, args, **kw)
        self.assertFalse(res["isError"], res["content"][0]["text"])
        return res["structuredContent"]

    async def err(self, who: str, name: str, args: dict, **kw) -> str:
        res = await self.call(who, name, args, **kw)
        self.assertTrue(res["isError"], res)
        return res["content"][0]["text"]

    async def folder(self, name: str, parent=None):
        return await folder_service.create_folder(self.db, self.ws["W1"], name, parent)

    async def filed(self, f, state: str = "L", **kw) -> dict:
        path = await folder_service.path_of(self.db, self.ws["W1"], f.id)
        return await self.mkdoc(state, folder_id=f.id, folder_path=path, **kw)

    async def host_folder(self, path: str, headers: dict | None = None):
        return await self.http.get("/api/v1/host/folder", params={"host": HOSTS["W1"], "path": path},
                                   headers=headers or {})

    async def folders(self) -> dict[str, dict]:
        rows = await self.db["folders"].find({"workspace_id": self.ws["W1"]}).to_list(length=100)
        return {"/".join(await folder_service.path_of(self.db, self.ws["W1"], str(r["_id"]))): r for r in rows}

    # ── create_folder ──

    async def test_senseloaf_create_folder_next_to_a_page_refuses_instead_of_dash_2(self):
        hub = await self.folder("product-hub")
        prds = await self.folder("prds", hub.id)
        await self.filed(prds, "W", slug="feat-0001-talent-pool", owner="wm", title="Talent pool PRD")
        text = await self.err("wm", "create_folder", {"workspace": WS, "path": "product-hub/prds/feat-0001-talent-pool"})
        self.assertIn("Talent pool PRD", text)
        self.assertIn("/product-hub/prds/feat-0001-talent-pool", text)
        self.assertIn("on_conflict", text)
        self.assertNotIn("product-hub/prds/feat-0001-talent-pool-2", await self.folders())
        self.assertEqual(len(await self.folders()), 2)
        # Opting in takes the next free address, as before.
        out = await self.ok("wm", "create_folder", {"workspace": WS, "path": "product-hub/prds/feat-0001-talent-pool",
                                                    "on_conflict": "suffix"})
        self.assertEqual(out["path"], "product-hub/prds/feat-0001-talent-pool-2")
        # Asking again finds that folder by its name: idempotent, nothing new.
        again = await self.ok("wm", "create_folder", {"workspace": WS, "path": "product-hub/prds/feat-0001-talent-pool"})
        self.assertEqual((again["folder_id"], again["created"]), (out["folder_id"], []))

    async def test_create_folder_clash_with_a_document_the_caller_cant_read_is_not_named(self):
        # Never named and never a refusal (C-N7: no answer that differs from a free address but the
        # suffix the old behaviour gave too); the result says the address was suffixed.
        await self.mkdoc("P", owner="owner", slug="secret-plans", title="Codename Falcon")
        res = await self.call("wm", "create_folder", {"workspace": WS, "path": "secret-plans"})
        self.assertFalse(res["isError"], res)
        self.assertNotIn("Falcon", str(res))
        self.assertEqual(res["structuredContent"]["path"], "secret-plans-2")
        self.assertIn("can't open", res["structuredContent"]["note"])
        # Same for a rename onto it.
        await self.folder("Other")
        out = await self.ok("wa", "rename_folder", {"workspace": WS, "path": "other", "new_name": "Secret Plans"})
        self.assertEqual(out["path"], "secret-plans-3")
        self.assertNotIn("Falcon", str(out))
        self.assertIn("note", out)

    async def test_create_folder_clash_with_a_sibling_folder_names_it(self):
        await self.folder("Release Notes")  # address release-notes
        text = await self.err("wm", "create_folder", {"workspace": WS, "path": "Release-Notes"})
        self.assertIn("“Release Notes”", text)
        self.assertEqual(set(await self.folders()), {"release-notes"})
        # Its own address or name finds it (nothing new).
        out = await self.ok("wm", "create_folder", {"workspace": WS, "path": "release-notes/2026"})
        self.assertEqual((out["path"], out["created"]), ("release-notes/2026", ["2026"]))

    async def test_rest_new_folder_refuses_a_taken_address_and_suffix_is_opt_in(self):
        await self.folder("Reports")
        url = f"/api/v1/workspaces/{self.ws['W1']}/folders"
        r = await self.http.post(url, json={"name": "reports"}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 409, r.text)
        self.assertIn("“Reports”", r.json()["detail"])
        r = await self.http.post(url, json={"name": "reports", "on_conflict": "suffix"}, headers=self.session("wm"))
        self.assertEqual((r.status_code, r.json()["slug"]), (201, "reports-2"))
        # A readable page at the address is named; one the caller can't read isn't.
        await self.mkdoc("W", owner="wm", slug="handbook", title="The Handbook")
        r = await self.http.post(url, json={"name": "Handbook"}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 409)
        self.assertIn("The Handbook", r.json()["detail"])
        await self.mkdoc("P", owner="owner", slug="hidden-one", title="Hidden Title")
        r = await self.http.post(url, json={"name": "Hidden One"}, headers=self.session("wm"))
        self.assertEqual((r.status_code, r.json()["slug"]), (201, "hidden-one-2"))
        self.assertNotIn("Hidden Title", r.text)

    async def test_create_folder_needs_a_member(self):
        self.assertIn("viewer", await self.err("wv", "create_folder", {"workspace": WS, "path": "x-folder"}))

    # ── rename_folder ──

    async def test_rename_folder_redirects_old_addresses(self):
        hub = await self.folder("product-hub")
        prds = await self.folder("prds", hub.id)
        doc = await self.filed(prds, "L")
        self.assertIn("admins", await self.err("wm", "rename_folder",
                                               {"workspace": WS, "path": "product-hub", "new_name": "Hub"}))
        out = await self.ok("wa", "rename_folder", {"workspace": WS, "path": "product-hub", "new_name": "Hub"})
        self.assertEqual((out["path"], out["previous_path"], out["redirects_from"]), ("hub", "product-hub", ["product-hub"]))
        self.assertEqual(out["url"], f"https://{HOSTS['W1']}/hub")
        self.assertEqual((await self.doc(doc["slug"]))["folder_path"], ["hub", "prds"])
        # The folder's old address and its subfolder's old address redirect (anonymous: L items are public).
        r = await self.host_folder("product-hub")
        self.assertEqual((r.status_code, r.json()), (200, {"moved_to": ["hub"]}))
        r = await self.host_folder("product-hub/prds")
        self.assertEqual(r.json(), {"moved_to": ["hub", "prds"]})
        self.assertEqual((await self.host_folder("product-hub/nope")).status_code, 404)
        self.assertEqual((await self.host_folder("hub/prds")).json()["folder"]["path"], ["hub", "prds"])
        # Renaming the subfolder too: an old path through both renames still lands.
        await self.ok("wa", "rename_folder", {"workspace": WS, "path": "hub/prds", "new_name": "Specs"})
        self.assertEqual((await self.host_folder("product-hub/prds")).json(), {"moved_to": ["hub", "specs"]})
        # The item's own address is its slug: still found, now under the new path.
        r = await self.get(doc["slug"], {"X-Markdrop-Workspace": self.ws["W1"]})
        self.assertEqual(r.json()["folder_path"], ["hub", "specs"])
        # A new folder at the old address wins over the redirect.
        await self.ok("wm", "create_folder", {"workspace": WS, "path": "product-hub"})
        self.assertNotIn("moved_to", (await self.host_folder("product-hub")).json())

    async def test_moved_folder_redirect_follows_access(self):
        f = await self.folder("Members only")
        await self.filed(f, "W")  # readable by members only
        await self.ok("wa", "rename_folder", {"workspace": WS, "path": "members-only", "new_name": "Team"})
        self.assertEqual((await self.host_folder("members-only")).status_code, 404)  # anonymous: nothing
        r = await self.host_folder("members-only", self.tenant("wm", "W1"))
        self.assertEqual(r.json(), {"moved_to": ["team"]})

    async def test_rename_folder_clashes_are_refused_and_case_only_renames_keep_the_address(self):
        await self.folder("Reports")
        g = await self.folder("Guides")
        text = await self.err("wa", "rename_folder", {"workspace": WS, "path": "guides", "new_name": "Reports"})
        self.assertIn("“Reports”", text)
        self.assertIn("Nothing was renamed", text)
        self.assertEqual((await self.db["folders"].find_one({"_id": ObjectId(g.id)}))["name"], "Guides")
        out = await self.ok("wa", "rename_folder", {"workspace": WS, "path": "guides", "new_name": "Reports",
                                                    "on_conflict": "suffix"})
        self.assertEqual(out["path"], "reports-2")
        out = await self.ok("wa", "rename_folder", {"workspace": WS, "path": "reports-2", "new_name": "REPORTS"})
        self.assertEqual((out["path"], out["name"]), ("reports-2", "REPORTS"))
        out = await self.ok("wa", "rename_folder", {"workspace": WS, "path": "reports-2", "new_name": "Annual",
                                                    "slug": "annual-reports"})
        self.assertEqual(out["path"], "annual-reports")
        # The app's rename (PATCH) refuses the same way.
        r = await self.http.patch(f"/api/v1/workspaces/{self.ws['W1']}/folders/{g.id}", json={"name": "Reports"},
                                  headers=self.session("wa"))
        self.assertEqual(r.status_code, 409, r.text)

    # ── move_folder ──

    async def test_move_folder(self):
        a = await self.folder("Alpha")
        b = await self.folder("Beta")
        inner = await self.folder("Inner", a.id)
        doc = await self.filed(inner, "L")
        self.assertIn("admins", await self.err("wm", "move_folder", {"workspace": WS, "path": "alpha", "new_parent": "beta"}))
        out = await self.ok("wa", "move_folder", {"workspace": WS, "path": "alpha", "new_parent": "beta"})
        self.assertEqual((out["path"], out["previous_path"]), ("beta/alpha", "alpha"))
        self.assertEqual((await self.doc(doc["slug"]))["folder_path"], ["beta", "alpha", "inner"])
        self.assertEqual((await self.host_folder("alpha/inner")).json(), {"moved_to": ["beta", "alpha", "inner"]})
        self.assertIn("inside itself", await self.err("wa", "move_folder",
                                                      {"workspace": WS, "path": "beta", "new_parent": "beta/alpha"}))
        out = await self.ok("wa", "move_folder", {"workspace": WS, "path": "beta/alpha/inner", "new_parent": "/"})
        self.assertEqual(out["path"], "inner")
        # A folder of that address at the destination: refused, nothing moves.
        await self.folder("Inner", b.id)
        text = await self.err("wa", "move_folder", {"workspace": WS, "path": "inner", "new_parent": "beta"})
        self.assertIn("Nothing was moved", text)
        self.assertIsNone((await self.db["folders"].find_one({"_id": ObjectId(inner.id)}))["parent_id"])
        out = await self.ok("wa", "move_folder", {"workspace": WS, "path": "inner", "new_parent": "beta",
                                                  "on_conflict": "suffix"})
        self.assertEqual(out["path"], "beta/inner-2")
        self.assertIn("no folder", await self.err("wa", "move_folder", {"workspace": WS, "path": "nope", "new_parent": "/"}))

    # ── delete_folder ──

    async def test_delete_empty_folder_goes_to_trash_and_restores(self):
        await self.folder("templates")
        self.assertIn("admins", await self.err("wm", "delete_folder", {"workspace": WS, "path": "templates"}))
        out = await self.ok("wa", "delete_folder", {"workspace": WS, "path": "templates"})
        self.assertEqual((out["deleted"], out["result"]["mode"], out["result"]["trashed"]), (True, "trash", True))
        self.assertEqual(await self.folders(), {})
        back = await self.ok("wa", "restore_document", {"document": out["result"]["restore_key"]})
        self.assertEqual(back["kind"], "folder")
        self.assertIn("templates", await self.folders())

    async def test_delete_non_empty_folder_is_refused_with_a_listing(self):
        f = await self.folder("product-hub")
        await self.folder("prds", f.id)
        mine = await self.filed(f, "W", owner="wa", title="Roadmap")
        await self.filed(f, "P", owner="owner", title="Secret Plan")  # wa can't read it
        res = await self.call("wa", "delete_folder", {"workspace": WS, "path": "product-hub"})
        self.assertTrue(res["isError"])
        text, data = res["content"][0]["text"], res["structuredContent"]
        self.assertIn("Roadmap", text)
        self.assertNotIn("Secret Plan", text)
        self.assertIn("product-hub/prds", text)
        self.assertFalse(data["deleted"])
        c = data["contents"]
        self.assertEqual((c["folders"], c["items"], c["hidden_items"], c["subfolders"]), (1, 1, 1, ["product-hub/prds"]))
        self.assertEqual([i["slug"] for i in c["sample"]], [mine["slug"]])
        self.assertNotIn("Secret Plan", str(data))
        self.assertIn("product-hub", await self.folders())

    async def test_delete_folder_move_to_parent(self):
        top = await self.folder("Top")
        mid = await self.folder("Mid", top.id)
        await self.folder("Leaf", mid.id)
        d = await self.filed(mid, "L")
        out = await self.ok("wa", "delete_folder", {"workspace": WS, "path": "top/mid", "contents": "move_to_parent"})
        self.assertEqual((out["deleted"], out["result"]["mode"], out["result"]["moved_to"]), (True, "move_to_parent", "top"))
        self.assertEqual(set(await self.folders()), {"top", "top/leaf"})
        self.assertEqual((await self.doc(d["slug"]))["folder_path"], ["top"])
        # A top-level folder's contents go to the top of the workspace.
        out = await self.ok("wa", "delete_folder", {"workspace": WS, "path": "top", "contents": "move_to_parent"})
        self.assertIsNone(out["result"]["moved_to"])
        self.assertEqual(set(await self.folders()), {"leaf"})
        self.assertEqual((await self.doc(d["slug"]))["folder_id"], None)

    async def test_delete_folder_to_trash_with_everything_and_restore(self):
        f = await self.folder("product-hub")
        sub = await self.folder("templates", f.id)
        a = await self.filed(f, "W")
        b = await self.filed(sub, "L")
        out = await self.ok("wa", "delete_folder", {"workspace": WS, "path": "product-hub", "contents": "trash"})
        self.assertEqual((out["result"]["trashed_documents"], out["result"]["trashed_folders"]), (2, 2))
        self.assertIsNone(await self.doc(a["slug"]))
        self.assertEqual(await self.folders(), {})
        await self.ok("wa", "restore_document", {"document": f.id})
        self.assertEqual(set(await self.folders()), {"product-hub", "product-hub/templates"})
        self.assertEqual((await self.doc(b["slug"]))["folder_path"], ["product-hub", "templates"])

    async def test_read_only_token_cannot_change_folders(self):
        await self.folder("Docs")
        for name, args in (("delete_folder", {"path": "docs"}), ("rename_folder", {"path": "docs", "new_name": "X"}),
                           ("move_folder", {"path": "docs", "new_parent": "/"})):
            status, res = await self.mcp_call(await self.mcp_token("wa", write=False), name,
                                              {"workspace": WS, **args})
            self.assertTrue(status == 403 or (res or {}).get("isError"), (status, res))
        self.assertIn("docs", await self.folders())

    async def test_list_folders_gives_what_the_folder_tools_take(self):
        top = await self.folder("Top")
        await self.folder("Sub", top.id)
        out = await self.ok("wm", "list_folders", {"workspace": WS}, write=False)
        sub = next(f for f in out["folders"] if f["path"] == "top/sub")
        self.assertEqual((sub["slug"], sub["parent_id"]), ("sub", top.id))
        # Either the path or the id works.
        out = await self.ok("wa", "rename_folder", {"workspace": WS, "path": sub["id"], "new_name": "Below"})
        self.assertEqual(out["path"], "top/below")
