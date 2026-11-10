"""Owner 2026-11-10: "Let people I share with add others" is ON by default for
every item in a workspace (documents, pages, files), new and existing, unless
the item's owner chose otherwise. The workspace's "Let people share onward"
(admins, default on) is the default for items without their own choice.
Onward sharing may add people outside the workspace, never gives more access
than the sharer has and never changes the item's level/password. Encrypted and
personal (unfiled) items are unchanged.

Run: MARKDROP_TEST_MONGODB_URI=mongodb://127.0.0.1:27019 .venv/bin/python -m unittest tests.test_reshare_default
"""

from __future__ import annotations

from bson import ObjectId

from app.services import lifecycle
from tests._access_env import AccessWorld

OUTSIDE = "outside@elsewhere.example.org"


class ReshareDefault(AccessWorld):
    async def mk(self, state="P", **kw):
        """A filed document with no resharing choice stored (what the migration leaves)."""
        d = await self.mkdoc(state, **kw)
        await self.db["documents"].update_one({"_id": d["_id"]}, {"$unset": {"allow_resharing": ""}})
        return d

    async def share(self, who, slug, email=OUTSIDE, role="viewer"):
        return await self.http.post(f"/api/v1/documents/{slug}/access/people", headers=self.session(who),
                                    json={"email": email, "role": role, "notify": False})

    async def ws_settings(self, who, ws_key="W1", **settings):
        return await self.http.put(f"/api/v1/workspaces/{self.ws[ws_key]}", headers=self.session(who),
                                   json={"settings": settings})

    async def state(self, who, slug):
        r = await self.http.get(f"/api/v1/documents/{slug}/access", headers=self.session(who))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    # ── Defaults ────────────────────────────────────────────────────────────

    async def test_default_on_for_filed_items(self):
        for kind in ("markdown", "artifact"):
            d = await self.mk("P", kind=kind)
            self.assertTrue((await self.state("owner", d["slug"]))["allow_resharing"])
            self.assertTrue((await self.state("gv", d["slug"]))["can_share"])
            r = await self.share("gv", d["slug"], f"{kind}-{OUTSIDE}")
            self.assertEqual(r.status_code, 201, r.text)

    async def test_workspace_response_carries_the_setting(self):
        r = await self.http.get(f"/api/v1/workspaces/{self.ws['W1']}", headers=self.session("wa"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["settings"]["allow_resharing"])

    async def test_new_page_and_subpage_in_workspace_store_no_choice(self):
        r = await self.http.post("/api/v1/pages", headers=self.session("wm"),
                                 json={"title": "Plan", "workspace": self.ws["W1"]})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertIsNone(r.json()["workspace_error"])
        slug = r.json()["document"]["slug"]
        self.assertNotIn("allow_resharing", await self.doc(slug))
        r = await self.http.post("/api/v1/pages", headers=self.session("wm"),
                                 json={"title": "Child", "parent": slug})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertNotIn("allow_resharing", await self.doc(r.json()["document"]["slug"]))

    async def test_filing_and_workspace_level_write_no_choice(self):
        d = await self.mkdoc("L", ws=None)
        r = await self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/items/add", json={"slugs": [d["slug"]]},
                                 headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn("allow_resharing", await self.doc(d["slug"]))
        r = await self.http.put(f"/api/v1/documents/{d['slug']}/access/level", json={"level": "workspace"},
                                headers=self.session("owner"))
        self.assertEqual(r.status_code, 204, r.text)
        self.assertNotIn("allow_resharing", await self.doc(d["slug"]))
        self.assertEqual((await self.share("gv", d["slug"])).status_code, 201)

    # ── Explicit choices ────────────────────────────────────────────────────

    async def test_explicit_off_is_kept(self):
        d = await self.mk("P")
        r = await self.http.put(f"/api/v1/documents/{d['slug']}/access/resharing", json={"allow": False},
                                headers=self.session("owner"))
        self.assertEqual(r.status_code, 204)
        self.assertEqual((await self.share("ge", d["slug"])).status_code, 403)
        self.assertFalse((await self.state("owner", d["slug"]))["allow_resharing"])
        # The workspace setting doesn't override it either way.
        self.assertEqual((await self.ws_settings("wa", allow_resharing=True)).status_code, 200)
        self.assertEqual((await self.share("ge", d["slug"])).status_code, 403)
        await self.db["migrations"].delete_many({})  # even a re-run of the migration keeps a choice made after it…
        await self.db["migrations"].insert_one({"_id": "resharing_default_on_v1"})
        await lifecycle.migrate(self.db)
        self.assertFalse((await self.doc(d["slug"]))["allow_resharing"])

    async def test_only_owner_switches_an_item(self):
        d = await self.mk("P")
        for who in ("wa", "ge"):
            r = await self.http.put(f"/api/v1/documents/{d['slug']}/access/resharing", json={"allow": False},
                                    headers=self.session(who))
            self.assertIn(r.status_code, (403, 404), who)  # a workspace admin can't open a private item

    # ── Workspace setting ───────────────────────────────────────────────────

    async def test_workspace_setting_off(self):
        d = await self.mk("P")
        on = await self.mk("P", allow_resharing=True)
        await self.db["documents"].update_one({"_id": on["_id"]}, {"$set": {"allow_resharing": True}})
        self.assertEqual((await self.ws_settings("wm", allow_resharing=False)).status_code, 403)  # admins only
        r = await self.ws_settings("wa", allow_resharing=False)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(r.json()["settings"]["allow_resharing"])
        # Other settings untouched (merged, not replaced).
        self.assertTrue(r.json()["settings"]["ai_enabled"])
        self.assertEqual((await self.share("gv", d["slug"])).status_code, 403)
        self.assertFalse((await self.state("owner", d["slug"]))["allow_resharing"])
        self.assertFalse((await self.state("gv", d["slug"]))["can_share"])
        # An item whose owner turned it on keeps it.
        self.assertEqual((await self.share("gv", on["slug"])).status_code, 201)
        # The owner still shares.
        self.assertEqual((await self.share("owner", d["slug"])).status_code, 201)
        # Another workspace is unaffected.
        w2 = await self.mk("P", owner="wm2", ws="W2")
        self.assertEqual((await self.share("gv", w2["slug"])).status_code, 201)

    # ── Onward sharing: external, no escalation, level untouched ────────────

    async def test_external_invite_by_non_owner(self):
        d = await self.mk("W")
        r = await self.share("gv", d["slug"])
        self.assertEqual(r.status_code, 201, r.text)
        row = await self.db["document_grants"].find_one({"document_id": str(d["_id"]), "email": OUTSIDE})
        self.assertEqual(row["granted_by_user_id"], self.uid["gv"])
        self.assertIsNotNone(row["parent_grant_id"])
        # The outsider opens it once they sign in with that address.
        self.uid["out"] = await self.make_user(OUTSIDE)
        self.email["out"] = OUTSIDE
        self.assertEqual((await self.get(d["slug"], self.session("out"))).status_code, 200)
        # The owner (and a workspace admin) see who added whom.
        for who in ("owner", "wa"):
            grants = {g["email"]: g for g in (await self.state(who, d["slug"]))["grants"]}
            self.assertEqual(grants[OUTSIDE]["granted_by_email"], self.email["gv"], who)
        # A workspace member shares too (on their workspace role), with an outsider.
        e = await self.mk("W")
        r = await self.share("wm", e["slug"], "third@elsewhere.example.org", "editor")
        self.assertEqual(r.status_code, 201, r.text)
        row = await self.db["document_grants"].find_one({"email": "third@elsewhere.example.org"})
        self.assertEqual(row["granted_via"], self.ws["W1"])

    async def test_no_escalation_and_level_untouched(self):
        for state in ("P", "W", "L", "LP"):
            d = await self.mk(state)
            before = await self.doc(d["slug"])
            r = await self.share("gv", d["slug"], f"x-{state.lower()}@elsewhere.example.org", "editor")
            self.assertEqual(r.status_code, 403, state)
            self.assertIn("more access than you have", r.json()["detail"])
            self.assertEqual((await self.share("gv", d["slug"], f"y-{state.lower()}@elsewhere.example.org")).status_code,
                             201, state)
            after = await self.doc(d["slug"])
            for k in ("access_level", "read_password_hash", "workspace_id", "access_epoch"):
                self.assertEqual(before.get(k), after.get(k), (state, k))
        # The onward grantee can't give more than they got: a viewer of a viewer's grant can't add an editor.
        d = await self.mk("P")
        self.assertEqual((await self.share("gv", d["slug"], self.email["stranger"])).status_code, 201)
        self.assertEqual((await self.share("stranger", d["slug"], "z@elsewhere.example.org", "editor")).status_code, 403)
        # Non-owners still can't change the level.
        r = await self.http.put(f"/api/v1/documents/{d['slug']}/access/level", json={"level": "link"},
                                headers=self.session("ge"))
        self.assertEqual(r.status_code, 403)

    async def test_team_restricted_item_still_hidden_from_non_team_member(self):
        # A stranger with no access can never share, whatever the default.
        d = await self.mk("P")
        self.assertIn((await self.share("stranger", d["slug"])).status_code, (403, 404))

    # ── Unchanged: personal and encrypted items ─────────────────────────────

    async def test_personal_items_unchanged(self):
        d = await self.mkdoc("P", ws=None)  # unfiled: no stored choice ⇒ on, as ever
        self.assertNotIn("allow_resharing", await self.doc(d["slug"]))
        self.assertEqual((await self.share("gv", d["slug"])).status_code, 201)
        off = await self.mkdoc("P", ws=None, allow_resharing=False)
        self.assertEqual((await self.share("gv", off["slug"])).status_code, 403)

    async def test_encrypted_items_unchanged(self):
        d = await self.mk("P", encrypted=True)
        self.assertEqual((await self.share("gv", d["slug"])).status_code, 403)
        self.assertFalse((await self.state("owner", d["slug"]))["allow_resharing"])

    # ── Migration ───────────────────────────────────────────────────────────

    async def test_migration_flips_old_default_once(self):
        old = await self.mkdoc("P")                                    # filed, stored false (old default)
        on = await self.mkdoc("P", allow_resharing=True)               # filed, stored true
        personal_off = await self.mkdoc("P", ws=None, allow_resharing=False)
        enc = await self.mkdoc("P", encrypted=True)                    # filed + encrypted, stored false
        trashed = await self.mkdoc("P")
        raw = await self.db["documents"].find_one({"_id": trashed["_id"]})
        await self.db["documents"].delete_one({"_id": trashed["_id"]})
        await self.db["trash"].insert_one({"_id": raw["_id"], "doc": raw})
        out = await lifecycle.migrate(self.db)
        self.assertEqual(out["resharing_default_on"], 2)  # `old` and the trashed one
        self.assertNotIn("allow_resharing", await self.doc(old["slug"]))
        self.assertTrue((await self.doc(on["slug"]))["allow_resharing"])
        self.assertFalse((await self.doc(personal_off["slug"]))["allow_resharing"])
        self.assertFalse((await self.doc(enc["slug"]))["allow_resharing"])
        self.assertNotIn("allow_resharing", (await self.db["trash"].find_one({"_id": raw["_id"]}))["doc"])
        self.assertEqual((await self.share("gv", old["slug"])).status_code, 201)
        # Idempotent: a later off (the owner's choice) survives restarts.
        await self.db["documents"].update_one({"_id": old["_id"]}, {"$set": {"allow_resharing": False}})
        again = await lifecycle.migrate(self.db)
        self.assertEqual(again["resharing_default_on"], 0)
        self.assertFalse((await self.doc(old["slug"]))["allow_resharing"])
        self.assertEqual((await self.db["migrations"].find_one({"_id": "resharing_default_on_v1"}))["cleared"], 2)

    # ── MCP ─────────────────────────────────────────────────────────────────

    async def test_mcp(self):
        d = await self.mk("P")
        gv = await self.mcp_token("gv")
        code, res = await self.mcp_call(gv, "share_with_people",
                                        {"document": d["slug"], "emails": [OUTSIDE], "notify": False})
        self.assertEqual(code, 200)
        self.assertFalse(res.get("isError"), res)
        self.assertTrue(res["structuredContent"]["people"][0]["added"], res)
        # Owner turns it off over MCP (set_access without access).
        owner = await self.mcp_token("owner")
        code, res = await self.mcp_call(owner, "set_access", {"document": d["slug"], "allow_resharing": False})
        self.assertFalse(res.get("isError"), res)
        self.assertFalse(res["structuredContent"]["allow_resharing"])
        self.assertFalse((await self.doc(d["slug"]))["allow_resharing"])
        code, res = await self.mcp_call(gv, "share_with_people",
                                        {"document": d["slug"], "emails": ["late@elsewhere.example.org"], "notify": False})
        self.assertTrue(res.get("isError") or res["structuredContent"]["people"][0]["error"], res)
        # A non-owner can't switch it.
        code, res = await self.mcp_call(gv, "set_access", {"document": d["slug"], "allow_resharing": True})
        self.assertTrue(res.get("isError"), res)
        # Neither argument: an error.
        code, res = await self.mcp_call(owner, "set_access", {"document": d["slug"]})
        self.assertTrue(res.get("isError"), res)
        # Both together still work.
        code, res = await self.mcp_call(owner, "set_access", {"document": d["slug"], "access": "private",
                                                              "allow_resharing": True})
        self.assertFalse(res.get("isError"), res)
        self.assertTrue(res["structuredContent"]["allow_resharing"])
        # list_workspaces shows the workspace setting.
        code, res = await self.mcp_call(owner, "list_workspaces", {})
        ws = {w["workspace_id"]: w for w in res["structuredContent"]["workspaces"]}
        self.assertTrue(ws[self.ws["W1"]]["allow_resharing"])
        self.assertIsNotNone(ObjectId(self.ws["W1"]))


if __name__ == "__main__":  # pragma: no cover
    import unittest

    unittest.main()
