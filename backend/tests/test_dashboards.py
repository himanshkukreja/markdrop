"""Customizable Home (services/dashboards.py, routers/dashboards.py, mcp/dashboard_tools.py; brief
.work/briefs/custom-dashboard.md).

W1 with a private team (Sales: owner = lead, wm) and an open one (Eng: wv = lead, ownv); wa is the workspace
admin, wo its owner. A Home is per person and workspace; the registry refuses unknown types and settings,
caps the widgets, and a team / folder / page must be one the saver can open. Reading re-checks access: a
team you left shows as not available, never its name. Templates are filled in per person; an admin's
workspace default is what members who never customized see, with its placeholders filled in for each.

Run: cd backend && MARKDROP_TEST_MONGODB_URI=mongodb://127.0.0.1:27019 .venv/bin/python -m unittest tests.test_dashboards -v
"""

from __future__ import annotations

from bson import ObjectId

from tests.test_teams import TeamsWorld
from app.services import dashboards as D

URL = "/api/v1/me/dashboard"


class DashWorld(TeamsWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await D.ensure_indexes(self.db)
        from app.services import teams as T

        self.general = str((await T.ensure_general(self.db, self.W))["_id"])

    async def user(self, who: str):
        from app.services import user as user_service

        return await user_service.get_user_by_id(self.db, self.uid[who])

    async def dash(self, who: str, ws: str | None = None, status: int = 200) -> dict:
        r = await self.http.get(URL, headers=self.session(who), params={"workspace": ws} if ws else {})
        self.assertEqual(r.status_code, status, r.text)
        return r.json()

    async def put(self, who: str, status: int = 200, **body) -> dict:
        r = await self.http.put(URL, headers=self.session(who), json=body)
        self.assertEqual(r.status_code, status, r.text)
        return r.json()

    @staticmethod
    def types(d: dict, col: str) -> list[str]:
        return [w["type"] for w in d[col]]


class Layout(DashWorld):
    async def test_default_is_todays_home_with_catalog_and_templates(self):
        d = await self.dash("wm", self.W)
        self.assertEqual(d["source"], "default")
        self.assertEqual(self.types(d, "main"), ["recent", "meetings", "workspaces"])
        self.assertEqual(self.types(d, "side"), ["needs_you", "todos"])
        self.assertEqual(d["workspace"]["id"], self.W)
        self.assertEqual({c["type"] for c in d["catalog"]}, set(D.WIDGETS))
        deals = next(c for c in d["catalog"] if c["type"] == "deals")
        self.assertFalse(deals["available"])                       # no HubSpot in this workspace
        self.assertEqual([p["id"] for p in d["presets"]], ["default", "writer", "meetings", "sales", "manager"])
        self.assertFalse(d["can_set_default"])
        self.assertTrue((await self.dash("wa", self.W))["can_set_default"])
        # The same request twice: the same ids (the page keeps its cards while it reloads).
        self.assertEqual([w["id"] for w in d["main"]], [w["id"] for w in (await self.dash("wm", self.W))["main"]])

    async def test_save_reorder_and_per_workspace(self):
        d = await self.put("wm", workspace=self.W, main=[{"type": "meetings", "settings": {"team": self.sales, "count": 40}},
                                                         {"type": "recent"}],
                           side=[{"type": "backlog", "settings": {"team": self.sales, "category": "bug"}}, {"type": "quick"}])
        self.assertEqual(d["source"], "mine")
        self.assertEqual(self.types(d, "main"), ["meetings", "recent"])
        self.assertEqual(d["main"][0]["settings"], {"team": self.sales, "count": 12})          # clamped
        self.assertEqual(d["side"][0]["settings"], {"team": self.sales, "category": "bug", "status": None, "count": 6})
        ids = [w["id"] for w in d["main"]]
        # Move: ids are kept.
        d2 = await self.put("wm", workspace=self.W, main=[d["main"][1], d["main"][0]], side=d["side"])
        self.assertEqual([w["id"] for w in d2["main"]], ids[::-1])
        self.assertEqual(self.types(await self.dash("wm", self.W), "main"), ["recent", "meetings"])
        # Another person, and the same person without a workspace, are untouched.
        self.assertEqual((await self.dash("owner", self.W))["source"], "default")
        none = await self.dash("wm")
        self.assertEqual((none["source"], none["workspace"]), ("default", None))
        # Reset: back to Default.
        r = await self.http.delete(URL, headers=self.session("wm"), params={"workspace": self.W})
        self.assertEqual(r.json()["source"], "default")

    async def test_validation(self):
        bad = [
            ({"main": [{"type": "nope"}]}, "Unknown widget"),
            ({"main": [{"type": "recent", "settings": {"colour": "red"}}]}, "unknown setting colour"),
            ({"main": [{"type": "recent", "settings": {"count": "ten"}}]}, "a number"),
            ({"main": [{"type": "backlog", "settings": {"team": self.sales, "category": "rumour"}}]}, "category"),
            ({"main": [{"type": "brief", "settings": {"team": "not-an-id"}}]}, "a team id"),
            ({"main": [{"type": "brief", "settings": {"team": str(ObjectId())}}]}, "no team"),
            ({"main": [{"type": "folder", "settings": {"folder": str(ObjectId())}}]}, "no folder"),
            ({"main": [{"type": "pinned", "settings": {"page": "no-such-page"}}]}, "no page"),
            ({"main": [{"type": "quick"}] * 10, "side": [{"type": "quick"}] * 7}, "At most 16"),
            ({"preset": "chaos"}, "Unknown template"),
        ]
        for body, words in bad:
            r = await self.http.put(URL, headers=self.session("wm"), json={"workspace": self.W, **body})
            self.assertEqual(r.status_code, 422, (body, r.text))
            self.assertIn(words, r.text, body)
        # General has no backlog.
        general = self.general
        r = await self.http.put(URL, headers=self.session("wm"), json={"workspace": self.W, "main": [
            {"type": "backlog", "settings": {"team": str(general)}}]})
        self.assertEqual(r.status_code, 422, r.text)
        # Workspace widgets need a workspace; a workspace you're not in is 404.
        r = await self.http.put(URL, headers=self.session("wm"), json={"main": [{"type": "favorites"}]})
        self.assertEqual(r.status_code, 422, r.text)
        await self.dash("wm", self.ws["W2"], status=404)
        await self.put("wm", status=404, workspace=self.ws["W2"], main=[])
        await self.put("wm", status=422, workspace=self.W)
        # Signed out: 401.
        self.assertEqual((await self.http.get(URL)).status_code, 401)
        # Exactly 16 is fine.
        d = await self.put("wm", workspace=self.W, main=[{"type": "quick"}] * 9, side=[{"type": "quick"}] * 7)
        self.assertEqual(len({w["id"] for w in d["main"] + d["side"]}), 16)

    async def test_access_rechecked_on_read(self):
        # wv can't save a widget for the private Sales team …
        r = await self.http.put(URL, headers=self.session("wv"), json={"workspace": self.W, "main": [
            {"type": "brief", "settings": {"team": self.sales}}]})
        self.assertEqual(r.status_code, 422, r.text)
        # … and wm, who can, sees it go "not available" after leaving the team (no name anywhere).
        slug = (await self.mkdoc("W", owner="wm", editor="blocks", title="Plan of record"))["slug"]
        await self.put("wm", workspace=self.W, main=[{"type": "brief", "settings": {"team": self.sales}},
                                                     {"type": "pinned", "settings": {"page": slug}}], side=[])
        d = await self.dash("wm", self.W)
        self.assertTrue(all(w["available"] for w in d["main"]))
        self.assertEqual(d["main"][1]["title"], "Plan of record")
        await self.db["teams"].update_one({"_id": ObjectId(self.sales)}, {"$pull": {"member_ids": self.uid["wm"]}})
        await self.db["documents"].update_one({"slug": slug}, {"$set": {"access_level": "private", "owner_id": self.uid["owner"]}})
        d = await self.dash("wm", self.W)
        self.assertEqual([w["available"] for w in d["main"]], [False, False])
        self.assertNotIn("Sales", str(d["main"]))
        self.assertNotIn("Plan of record", str(d["main"]))
        self.assertIn("can't open this team", d["main"][0]["note"])


class Presets(DashWorld):
    async def test_presets_fill_in_your_team_and_page(self):
        slug = (await self.mkdoc("W", owner="wm", editor="blocks", title="My draft"))["slug"]
        d = await self.put("wm", workspace=self.W, preset="manager")
        self.assertEqual(self.types(d, "main"), ["brief", "memory", "activity"])
        self.assertEqual(self.types(d, "side"), ["needs_you", "backlog"])
        self.assertEqual({w["settings"].get("team") for w in d["main"][:2]} | {d["side"][1]["settings"]["team"]}, {self.sales})
        d = await self.put("wm", workspace=self.W, preset="writer")
        pinned = next(w for w in d["main"] if w["type"] == "pinned")
        self.assertEqual((pinned["settings"]["page"], pinned["title"]), (slug, "My draft"))
        # Sales without HubSpot: no Deals card; the backlog filters follow-ups.
        d = await self.put("wm", workspace=self.W, preset="sales")
        self.assertNotIn("deals", self.types(d, "main"))
        self.assertEqual(d["side"][1]["settings"]["category"], "follow_up")
        # Someone in no team: General for brief/memory, no backlog card.
        d = await self.put("wo", workspace=self.W, preset="manager")
        general = self.general
        self.assertEqual(d["main"][0]["settings"]["team"], general)
        self.assertEqual(self.types(d, "side"), ["needs_you"])
        # No workspace: only the widgets that work without one.
        d = await self.put("wm", preset="manager")
        self.assertEqual((self.types(d, "main"), self.types(d, "side")), ([], ["needs_you"]))

    async def test_workspace_default_for_members_who_never_customized(self):
        body = {"preset": "manager"}
        r = await self.http.put(f"/api/v1/workspaces/{self.W}/dashboard-default", headers=self.session("wm"), json=body)
        self.assertEqual(r.status_code, 403, r.text)
        r = await self.http.put(f"/api/v1/workspaces/{self.W}/dashboard-default", headers=self.session("wa"), json=body)
        self.assertEqual(r.status_code, 200, r.text)
        stored = (await self.db["workspaces"].find_one({"_id": ObjectId(self.W)}))["home_default"]
        self.assertEqual(stored["main"][0]["settings"]["team"], "@team")              # filled in per member
        # wm (Sales) sees Sales; wv (Eng lead) sees Eng; neither sees the other's team.
        wm, wv = await self.dash("wm", self.W), await self.dash("wv", self.W)
        self.assertEqual((wm["source"], wv["source"]), ("workspace", "workspace"))
        self.assertEqual(wm["main"][0]["settings"]["team"], self.sales)
        self.assertEqual(wv["main"][0]["settings"]["team"], self.eng)
        self.assertTrue(wm["has_workspace_default"])
        # Someone who customized keeps theirs; reset brings the workspace default back.
        await self.put("wm", workspace=self.W, main=[{"type": "recent"}], side=[])
        self.assertEqual((await self.dash("wm", self.W))["source"], "mine")
        r = await self.http.delete(URL, headers=self.session("wm"), params={"workspace": self.W})
        self.assertEqual(r.json()["source"], "workspace")
        # A default naming a team only some can open: the others simply don't get that card.
        r = await self.http.put(f"/api/v1/workspaces/{self.W}/dashboard-default", headers=self.session("wa"), json={
            "main": [{"type": "brief", "settings": {"team": self.sales}}, {"type": "recent"}], "side": []})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.types(await self.dash("wv", self.W), "main"), ["recent"])
        self.assertEqual(self.types(await self.dash("wm", self.W), "main"), ["brief", "recent"])
        # Clearing it: Default again.
        r = await self.http.delete(f"/api/v1/workspaces/{self.W}/dashboard-default", headers=self.session("wa"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((await self.dash("wv", self.W))["source"], "default")


class Mcp(DashWorld):
    async def test_tools(self):
        from app.mcp import dashboard_tools as DT
        from app.mcp.tools import BY_NAME, Context, ToolError

        self.assertIn("get_dashboard", BY_NAME)
        self.assertIn("set_dashboard", BY_NAME)

        async def ctx(who: str) -> Context:
            return Context(db=self.db, user=await self.user(who), client_id="test", scopes=["read", "write"])

        text, data = await DT.get_dashboard(await ctx("wm"), {"workspace": self.W})
        self.assertIn("Main column:", text)
        self.assertIn("Recent pages & files [recent", text)
        self.assertEqual(data["source"], "default")
        text, data = await DT.set_dashboard(await ctx("wm"), {"workspace": self.W, "preset": "meetings"})
        self.assertTrue(text.startswith("Saved."))
        self.assertEqual(self.types(data, "main")[0], "meetings")
        text, data = await DT.set_dashboard(await ctx("wm"), {"workspace": self.W, "main": [{"type": "todos"}],
                                                              "side": [{"type": "brief", "settings": {"team": self.sales}}]})
        self.assertEqual((self.types(data, "main"), self.types(data, "side")), (["todos"], ["brief"]))
        with self.assertRaises(ToolError):
            await DT.set_dashboard(await ctx("wv"), {"workspace": self.W, "main": [{"type": "brief", "settings": {"team": self.sales}}]})
        with self.assertRaises(ToolError):
            await DT.set_dashboard(await ctx("wm"), {"workspace": self.W})
        text, data = await DT.set_dashboard(await ctx("wm"), {"workspace": self.W, "reset": True})
        self.assertEqual(data["source"], "default")
