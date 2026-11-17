"""Folder access (services/folder_access.py): a folder restricted to people and teams, inherited by
everything inside — existing items, items created / uploaded / moved in later, subfolders — and the leaks
that must never happen.

World (tests/_access_env.py): W1 with wa (admin), wm (member), wv (viewer), owner (member), ownv (viewer);
gv / ge are named on fixture docs; stranger is in no workspace. Folder Sales (+ subfolder Q4) and a
private team "Sales" (wm only).
"""

from __future__ import annotations

from app.services import access, folder_access, notifications
from app.services import teams as T
from tests._access_env import AccessWorld


class FolderWorld(AccessWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await T.ensure_indexes(self.db)
        await folder_access.ensure_indexes(self.db)
        self.W = self.ws["W1"]
        self.base = f"/api/v1/workspaces/{self.W}"
        self.sales = await self.mkfolder("Sales")
        self.q4 = await self.mkfolder("Q4", parent=self.sales)
        r = await self.http.post(f"{self.base}/teams", headers=self.session("wa"),
                                 json={"name": "Sales", "visibility": "private", "member_ids": [self.uid["wm"]],
                                       "lead_ids": [self.uid["wm"]]})
        self.assertEqual(r.status_code, 201, r.text)
        self.team = r.json()["id"]
        self.d_ws = await self.mkdoc("W", folder_id=self.sales, folder_path=["sales"])
        self.d_link = await self.mkdoc("L", kind="artifact", folder_id=self.sales, folder_path=["sales"])
        self.d_priv = await self.mkdoc("P", folder_id=self.sales, folder_path=["sales"])
        self.d_q4 = await self.mkdoc("W", grants=False, folder_id=self.q4, folder_path=["sales", "q4"])
        self.d_out = await self.mkdoc("W", grants=False)

    async def mkfolder(self, name: str, parent: str | None = None, who: str = "wa") -> str:
        r = await self.http.post(f"{self.base}/folders", headers=self.session(who),
                                 json={"name": name, "parent_id": parent})
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()["id"]

    async def put_access(self, folder: str, who: str = "wa", status: int = 200, **body) -> dict:
        r = await self.http.put(f"{self.base}/folders/{folder}/access", headers=self.session(who), json=body)
        self.assertEqual(r.status_code, status, r.text)
        return r.json()

    async def restrict_to_team(self):
        return await self.put_access(self.sales, restricted=True, teams=[{"team_id": self.team, "role": "editor"}])

    async def reads(self, who: str, doc: dict) -> int:
        return (await self.get(doc["slug"], self.session(who) if who != "AN" else {})).status_code

    async def listed(self, who: str) -> set[str]:
        r = await self.http.get(f"{self.base}/items", headers=self.session(who), params={"folder": "all"})
        self.assertEqual(r.status_code, 200, r.text)
        return {i["slug"] for i in r.json()["items"]}

    async def searched(self, who: str) -> set[str]:
        r = await self.http.get("/api/v1/search", headers=self.session(who), params={"q": "Title", "trash": False})
        self.assertEqual(r.status_code, 200, r.text)
        return {i.get("slug") for i in r.json()["items"]}

    async def team_add(self, who: str):
        r = await self.http.post(f"{self.base}/teams/{self.team}/members", headers=self.session("wa"),
                                 json={"user_ids": [self.uid[who]]})
        self.assertEqual(r.status_code, 200, r.text)


class NoRuleNoChange(FolderWorld):
    async def test_folders_start_open_and_nothing_changes(self):
        # No folder rule anywhere: every decision is what it always was.
        self.assertFalse((await folder_access.load_rules(self.db, self.W)).any)
        self.assertEqual(await self.reads("wv", self.d_ws), 200)
        self.assertEqual(await self.reads("AN", self.d_link), 200)
        self.assertEqual(await self.reads("wv", self.d_priv), 404)
        self.assertIn(self.d_q4["slug"], await self.listed("wv"))
        r = await self.http.get(f"{self.base}/folders/{self.sales}/access", headers=self.session("wv"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(r.json()["restricted"])
        self.assertFalse(r.json()["can_manage"])


class Restricted(FolderWorld):
    async def test_existing_items_hidden_from_non_members(self):
        await self.restrict_to_team()
        for doc in (self.d_ws, self.d_q4, self.d_link):
            self.assertEqual(await self.reads("wv", doc), 404, doc["slug"])
            self.assertEqual(await self.reads("ownv", doc), 404, doc["slug"])
            self.assertEqual(await self.reads("stranger", doc), 404, doc["slug"])
        # The link no longer opens it, for anyone; and its bytes stopped being public.
        self.assertEqual(await self.reads("AN", self.d_link), 401)
        self.assertFalse(self.r2.objects[self.d_link["blob_key"]]["public"])
        self.assertTrue((await self.doc(self.d_link["slug"])).get("folder_capped"))
        # Listings and search: nothing of the folder for wv.
        hidden = {self.d_ws["slug"], self.d_q4["slug"], self.d_link["slug"], self.d_priv["slug"]}
        self.assertFalse(hidden & await self.listed("wv"))
        self.assertFalse(hidden & await self.searched("wv"))
        self.assertIn(self.d_out["slug"], await self.listed("wv"))

    async def test_team_members_admins_owner_and_named_people_keep_access(self):
        await self.restrict_to_team()
        for who in ("wm", "wa", "wo", "owner"):
            for doc in (self.d_ws, self.d_q4, self.d_link):
                self.assertEqual(await self.reads(who, doc), 200, (who, doc["slug"]))
        # Private stays private: the team doesn't get it.
        self.assertEqual(await self.reads("wm", self.d_priv), 404)
        # A person the item was shared with by name keeps it.
        self.assertEqual(await self.reads("gv", self.d_ws), 200)
        self.assertEqual(await self.reads("gv", self.d_q4), 404)
        listed = await self.listed("wm")
        self.assertTrue({self.d_ws["slug"], self.d_q4["slug"], self.d_link["slug"]} <= listed)
        self.assertNotIn(self.d_priv["slug"], listed)
        self.assertTrue({self.d_ws["slug"], self.d_q4["slug"]} <= await self.searched("wm"))

    async def test_why_explains_the_inheritance(self):
        await self.restrict_to_team()
        r = await self.get(self.d_q4["slug"], self.session("wm"))
        why = r.json()["access_why"]
        self.assertEqual(why["source"], "folder_team")
        self.assertEqual(why["text"], "Inherited from sales/ · Sales team")
        self.assertTrue(why["folder"]["restricted"])
        r = await self.http.get(f"/api/v1/documents/{self.d_q4['slug']}/access", headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["why"]["text"], "Inherited from sales/ · Sales team")
        self.assertEqual(r.json()["folder_access"]["path"], "sales/q4/")
        self.assertEqual(r.json()["folder_access"]["restricted_by"], "sales/")
        r = await self.get(self.d_ws["slug"], self.session("owner"))
        self.assertEqual(r.json()["access_why"]["source"], "owner")

    async def test_adding_a_person_to_the_team_grants_everything(self):
        await self.restrict_to_team()
        later = await self.mkdoc("W", grants=False, owner="wm", folder_id=self.q4, folder_path=["sales", "q4"])
        for doc in (self.d_ws, self.d_q4, later):
            self.assertEqual(await self.reads("wv", doc), 404)
        await self.team_add("wv")
        for doc in (self.d_ws, self.d_q4, self.d_link, later):
            self.assertEqual(await self.reads("wv", doc), 200, doc["slug"])
        # A workspace viewer reaches through the team as a viewer only.
        f = await access.facts(access.Actor.of(await self.user("wv")), self.d_ws, access.Ctx(self.db))
        self.assertEqual(f.folder_role, "viewer")
        self.assertTrue({self.d_ws["slug"], later["slug"]} <= await self.listed("wv"))

    async def user(self, who: str):
        from app.services import user as user_service

        return await user_service.get_user_by_id(self.db, self.uid[who])

    async def test_future_items_inherit(self):
        await self.restrict_to_team()
        # What new items start as here: the folder's people (stored as workspace, narrowed by the folder).
        r = await self.http.get(f"{self.base}/folders/{self.q4}/access", headers=self.session("wm"))
        self.assertEqual(r.json()["effective_default_access"], "workspace")
        token = await self.mcp_token("wm")
        _s, res = await self.mcp_call(token, "publish_document", {
            "markdown": "# Later\nnew", "workspace": self.W, "folder": "sales/q4"})
        self.assertFalse(res.get("isError"), res)
        slug = res["structuredContent"]["slug"]
        new = await self.doc(slug)
        self.assertEqual(new["folder_id"], self.q4)
        self.assertEqual(await self.reads("wv", new), 404)
        self.assertEqual(await self.reads("AN", new), 401)
        self.assertEqual(await self.reads("owner", new), 404)   # a member outside the team
        self.assertEqual(await self.reads("wa", new), 200)
        # Even asked for a public link, a new item in the folder isn't public.
        _s, res = await self.mcp_call(token, "publish_document", {
            "markdown": "# Linky", "workspace": self.W, "folder": "sales", "access": "link"})
        self.assertFalse(res.get("isError"), res)
        linky = await self.doc(res["structuredContent"]["slug"])
        self.assertEqual(await self.reads("AN", linky), 401)
        self.assertEqual(await self.reads("wv", linky), 404)

    async def test_moves_in_and_out(self):
        await self.restrict_to_team()
        self.assertEqual(await self.reads("wv", self.d_out), 200)
        r = await self.http.post(f"{self.base}/documents/move", headers=self.session("owner"),
                                 json={"slug": self.d_out["slug"], "folder_id": self.q4})
        self.assertEqual(r.status_code, 204, r.text)
        self.assertEqual(await self.reads("wv", self.d_out), 404)
        self.assertNotIn(self.d_out["slug"], await self.listed("wv"))
        # Out again: its own setting applies again.
        r = await self.http.post(f"{self.base}/documents/move", headers=self.session("owner"),
                                 json={"slug": self.d_link["slug"], "folder_id": None})
        self.assertEqual(r.status_code, 204, r.text)
        self.assertEqual(await self.reads("AN", self.d_link), 200)
        self.assertFalse((await self.doc(self.d_link["slug"])).get("folder_capped"))
        self.assertTrue(self.r2.objects[self.d_link["blob_key"]]["public"])

    async def test_lifting_the_restriction_reopens(self):
        await self.restrict_to_team()
        await self.put_access(self.sales, restricted=False)
        self.assertEqual(await self.reads("wv", self.d_ws), 200)
        self.assertEqual(await self.reads("AN", self.d_link), 200)
        self.assertTrue(self.r2.objects[self.d_link["blob_key"]]["public"])

    async def test_only_managers_change_it(self):
        await self.put_access(self.sales, who="wv", status=403, restricted=True)
        await self.put_access(self.sales, who="wm", status=403, restricted=True)
        await self.restrict_to_team()
        # A team editor of the folder manages it now; the stranger never sees it.
        d = await self.put_access(self.sales, who="wm", default_access="folder")
        self.assertEqual(d["default_access"], "folder")
        r = await self.http.get(f"{self.base}/folders/{self.sales}/access", headers=self.session("stranger"))
        self.assertEqual(r.status_code, 404)

    async def test_subfolder_adds_people_without_opening_the_parent(self):
        await self.restrict_to_team()
        await self.put_access(self.q4, add_people=None, people=[{"email": self.email["ownv"], "role": "viewer"}])
        self.assertEqual(await self.reads("ownv", self.d_q4), 200)
        self.assertEqual(await self.reads("ownv", self.d_ws), 404)
        r = await self.http.get(f"{self.base}/folders/{self.q4}/access", headers=self.session("wa"))
        body = r.json()
        self.assertTrue(body["restricted"])
        self.assertEqual(body["restricted_by"], "sales/")
        self.assertEqual({t["inherited_from"] for t in body["teams"]}, {"sales/"})


class Override(FolderWorld):
    async def test_editor_override_is_logged(self):
        await self.restrict_to_team()
        url = f"/api/v1/documents/{self.d_link['slug']}/access/folder-override"
        r = await self.http.put(url, headers=self.session("wv"), json={"override": True})
        self.assertEqual(r.status_code, 404)  # can't even read it
        r = await self.http.put(url, headers=self.session("gv"), json={"override": True})
        self.assertEqual(r.status_code, 403)  # a viewer
        r = await self.http.put(url, headers=self.session("owner"), json={"override": True, "reason": "press kit"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["folder_access"]["override"])
        self.assertEqual(await self.reads("AN", self.d_link), 200)
        self.assertTrue(self.r2.objects[self.d_link["blob_key"]]["public"])
        logged = await self.db[folder_access.LOG].find_one({"doc_id": str(self.d_link["_id"])})
        self.assertIn("press kit", logged["text"])
        self.assertEqual(logged["by"], self.uid["owner"])
        # The workspace's members still don't get it from their membership (only the link level opens it).
        self.assertIn(self.d_link["slug"], await self.listed("wv"))  # link items are listed to members
        r = await self.http.put(url, headers=self.session("owner"), json={"override": False})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(await self.reads("AN", self.d_link), 401)


class Sharing(FolderWorld):
    async def test_share_folder_one_notification_per_person(self):
        token = await self.mcp_token("wa")
        _s, res = await self.mcp_call(token, "share_folder", {
            "workspace": self.W, "folder": "sales", "people": [self.email["stranger"]], "teams": ["Sales"],
            "role": "viewer", "restrict": True})
        self.assertFalse(res.get("isError"), res)
        sc = res["structuredContent"]
        self.assertEqual(sc["added_people"], [self.email["stranger"]])
        self.assertTrue(sc["restricted"])
        for doc in (self.d_ws, self.d_q4, self.d_link):
            self.assertEqual(await self.reads("stranger", doc), 200, doc["slug"])
        self.assertEqual(await self.reads("stranger", self.d_priv), 404)
        self.assertEqual(await self.reads("wv", self.d_ws), 404)
        rows = await self.db[notifications.COLL].find({"user_id": self.uid["stranger"]}).to_list(10)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["kind"], "folder_shared")
        rows = await self.db[notifications.COLL].find({"user_id": self.uid["wm"]}).to_list(10)
        self.assertEqual(len(rows), 1)  # the team's member, once
        r = await self.http.get("/api/v1/notifications", headers=self.session("stranger"))
        if r.status_code == 200:
            items = r.json().get("items") or []
            self.assertTrue(items and items[0]["available"])
        # Sharing again tells nobody twice.
        _s, res = await self.mcp_call(token, "share_folder", {
            "workspace": self.W, "folder": "sales", "people": [self.email["stranger"]]})
        self.assertEqual(await self.db[notifications.COLL].count_documents({"user_id": self.uid["stranger"]}), 1)
        # The stranger can't see what's private, and search finds the folder's items for them.
        found = await self.searched("stranger")
        self.assertIn(self.d_ws["slug"], found)
        self.assertNotIn(self.d_priv["slug"], found)

    async def test_unrestricted_share_adds_people_and_keeps_members(self):
        await self.put_access(self.sales, people=[{"email": self.email["stranger"], "role": "editor"}])
        self.assertEqual(await self.reads("stranger", self.d_ws), 200)
        self.assertEqual(await self.reads("wv", self.d_ws), 200)
        f = await access.facts(access.Actor.of(await self.user("stranger")), self.d_ws, access.Ctx(self.db))
        self.assertEqual(f.role, "editor")

    async def user(self, who: str):
        from app.services import user as user_service

        return await user_service.get_user_by_id(self.db, self.uid[who])

    async def test_share_with_people_list_and_folder(self):
        token = await self.mcp_token("owner")
        a = await self.mkdoc("W", grants=False)
        b = await self.mkdoc("W", grants=False)
        _s, res = await self.mcp_call(token, "share_with_people", {
            "documents": [a["slug"], b["slug"]], "emails": [self.email["stranger"]]})
        self.assertFalse(res.get("isError"), res)
        for doc in (a, b):
            self.assertEqual(await self.reads("stranger", doc), 200)
        rows = await self.db[notifications.COLL].find({"user_id": self.uid["stranger"]}).to_list(10)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["extra"].get("count"), 2)
        wa = await self.mcp_token("wa")
        _s, res = await self.mcp_call(wa, "share_with_people", {
            "folder": "sales", "workspace": self.W, "emails": [self.email["ownx"]]})
        self.assertFalse(res.get("isError"), res)
        self.assertEqual(await self.reads("ownx", self.d_q4), 200)
        _s, res = await self.mcp_call(token, "share_with_people", {
            "document": a["slug"], "documents": [b["slug"]], "emails": [self.email["ownx"]]})
        self.assertTrue(res.get("isError"))

    async def test_mcp_get_and_set_folder_access(self):
        token = await self.mcp_token("wa")
        _s, res = await self.mcp_call(token, "set_folder_access", {
            "workspace": self.W, "folder": "sales", "restricted": True,
            "teams": [{"team": "Sales", "role": "editor"}], "default_access": "folder"})
        self.assertFalse(res.get("isError"), res)
        _s, res = await self.mcp_call(await self.mcp_token("wm", write=False), "get_folder_access",
                                      {"workspace": self.W, "folder": "sales/q4"})
        sc = res["structuredContent"]
        self.assertTrue(sc["restricted"])
        self.assertEqual(sc["restricted_by"], "sales/")
        self.assertEqual(sc["teams"][0]["name"], "Sales")
        _s, res = await self.mcp_call(await self.mcp_token("wm", write=False), "get_file_info",
                                      {"document": self.d_link["slug"]})
        self.assertEqual(res["structuredContent"]["access_why"]["text"], "Inherited from sales/ · Sales team")
        _s, res = await self.mcp_call(await self.mcp_token("wv"), "set_folder_access",
                                      {"workspace": self.W, "folder": "sales", "restricted": False})
        self.assertTrue(res.get("isError"))


class Surfaces(FolderWorld):
    async def test_folder_link_and_domain_never_leak(self):
        r = await self.http.put(f"{self.base}/folders/{self.sales}/share", headers=self.session("wa"), json={"level": "link"})
        self.assertEqual(r.status_code, 200, r.text)
        share_id = r.json().get("id") or r.json().get("share", {}).get("id")
        await self.restrict_to_team()
        if share_id:
            r = await self.http.get(f"/api/v1/folders/shared/{share_id}")
            self.assertNotIn(self.d_link["slug"], r.text)
        # The workspace's own domain (tenant token): same answer as markdrop.in.
        r = await self.get(self.d_ws["slug"], self.tenant("wv", "W1"))
        self.assertEqual(r.status_code, 404)
        r = await self.get(self.d_ws["slug"], self.tenant("wm", "W1"))
        self.assertEqual(r.status_code, 200)

    async def test_addresses_only_for_managers(self):
        await self.put_access(self.sales, restricted=True, people=[{"email": self.email["stranger"], "role": "viewer"}])
        r = await self.http.get(f"{self.base}/folders/{self.sales}/access", headers=self.session("wv"))
        body = r.json()
        self.assertEqual([p["email"] for p in body["people"]], [None])
        self.assertEqual(body["log"], [])
        r = await self.http.get(f"{self.base}/folders/{self.sales}/access", headers=self.session("wa"))
        self.assertEqual([p["email"] for p in r.json()["people"]], [self.email["stranger"]])
        self.assertTrue(r.json()["log"])
