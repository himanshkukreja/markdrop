"""Teams inside a workspace (services/teams.py, routers/teams.py, mcp/teams_tools.py; .work/teams/CONTRACT.md).

The LEAK matrix: a private team (Sales: owner + wm) and an open team (Eng: wv + ownv) in W1, with wa the
workspace admin. For items, listings, search, the meetings list, Team memory profiles, Ask's retrieval,
briefs, comments and MCP: a private team's content never reaches a workspace member outside it (wv,
ownv), always reaches its members and the admin; a link share keeps working; open teams are readable
(viewer) by everyone in the workspace but stay out of other teams' spaces. Plus meeting routing on
import, team briefs, the guided review and suggested teams from Team groups. The model is always fake.
"""

from __future__ import annotations

from datetime import date, datetime, timezone

from tests.test_workspace_memory import TeamWorld, _pin_today
from app.services import access, team_briefs, team_extras, teams as T, workspace_memory as wm


class TeamsWorld(TeamWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await team_extras.ensure_indexes(self.db)
        await T.ensure_indexes(self.db)
        _pin_today(self, date(2026, 11, 4))
        self.base = f"/api/v1/workspaces/{self.W}"
        self.sales = await self.mkteam("wa", name="Sales", visibility="private", lead_ids=[self.uid["owner"]],
                                       member_ids=[self.uid["owner"], self.uid["wm"]])
        self.eng = await self.mkteam("wa", name="Eng", visibility="open", lead_ids=[self.uid["wv"]],
                                     member_ids=[self.uid["wv"], self.uid["ownv"]])
        self.s_w = await self.mkdoc("W", grants=False, team_ids=[self.sales])
        self.s_l = await self.mkdoc("L", grants=False, team_ids=[self.sales])
        self.e_w = await self.mkdoc("W", grants=False, owner="wv", team_ids=[self.eng])
        self.c_w = await self.mkdoc("W", grants=False)

    async def mkteam(self, who: str, **body) -> str:
        r = await self.http.post(f"{self.base}/teams", headers=self.session(who), json=body)
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()["id"]

    async def listed(self, who: str, **params) -> set[str]:
        r = await self.http.get(f"{self.base}/items", headers=self.session(who), params=params)
        self.assertEqual(r.status_code, 200, r.text)
        return {i["slug"] for i in r.json()["items"]}

    async def searched(self, who: str, q: str = "Title", **params) -> set[str]:
        r = await self.http.get("/api/v1/search", headers=self.session(who), params={"q": q, "trash": False, **params})
        self.assertEqual(r.status_code, 200, r.text)
        return {i.get("slug") for i in r.json()["items"]}


class Rule(TeamsWorld):
    async def test_direct_reads(self):
        for who, ok in (("owner", True), ("wm", True), ("wa", True), ("wo", True), ("wv", False), ("ownv", False)):
            r = await self.get(self.s_w["slug"], self.session(who))
            self.assertEqual(r.status_code == 200, ok, (who, r.status_code))
        # A deliberate link share keeps working for anyone.
        for who in ("wv", "ownv", "stranger"):
            self.assertEqual((await self.get(self.s_l["slug"], self.session(who))).status_code, 200, who)
        # Open team: everyone in the workspace reads it, as a viewer unless a member.
        for who, role in (("wm", "viewer"), ("wa", "editor"), ("ownv", "viewer")):
            f = await access.facts(access.Actor.of(await self.user(who)), self.e_w, access.Ctx(self.db))
            self.assertTrue(f.team_ok)
            self.assertEqual(f.member_doc_role, role, who)

    async def user(self, who: str):
        from app.services import user as user_service

        return await user_service.get_user_by_id(self.db, self.uid[who])

    async def test_listings_and_spaces(self):
        all_ = {d["slug"] for d in (self.s_w, self.s_l, self.e_w, self.c_w)}
        self.assertEqual(await self.listed("wm"), all_)
        self.assertEqual(await self.listed("wa"), all_)
        self.assertEqual(await self.listed("wv"), {self.e_w["slug"], self.c_w["slug"]})
        self.assertEqual(await self.listed("wm", space=f"team:{self.eng}"), {self.e_w["slug"]})
        self.assertEqual(await self.listed("wm", space="company"), {self.c_w["slug"]})
        r = await self.http.get(f"{self.base}/items", headers=self.session("wv"), params={"space": f"team:{self.sales}"})
        self.assertEqual(r.status_code, 404)
        r = await self.http.get(f"{self.base}/nav", headers=self.session("wv"))
        self.assertNotIn(self.s_l["slug"], {i["slug"] for i in r.json()["items"]})

    async def test_search(self):
        self.assertFalse({self.s_w["slug"], self.s_l["slug"]} & await self.searched("wv"))
        self.assertTrue({self.s_w["slug"], self.s_l["slug"]} <= await self.searched("wm"))
        self.assertTrue({self.s_w["slug"], self.s_l["slug"]} <= await self.searched("wa"))
        got = await self.searched("wm", space=f"team:{self.sales}")
        self.assertIn(self.s_w["slug"], got)
        self.assertNotIn(self.c_w["slug"], got)
        self.assertFalse(await self.searched("wv", space=f"team:{self.sales}") - {None})

    async def test_mcp_search_and_items(self):
        token = await self.mcp_token("wv", write=False)
        _s, res = await self.mcp_call(token, "search", {"query": "Title"})
        ids = {x["id"] for x in res["structuredContent"]["results"]}
        self.assertFalse({self.s_w["slug"], self.s_l["slug"]} & ids)
        _s, res = await self.mcp_call(token, "list_workspace_items", {"workspace": self.W, "space": f"team:{self.eng}"})
        self.assertEqual({i["slug"] for i in res["structuredContent"]["items"]}, {self.e_w["slug"]})
        _s, res = await self.mcp_call(token, "list_teams", {"workspace": self.W})
        cards = {t["name"]: t for t in res["structuredContent"]["teams"]}
        self.assertFalse(cards["Sales"]["can_read"])
        self.assertEqual(cards["Eng"]["my_role"], "lead")

    async def test_move_and_share_rules(self):
        put = f"{self.base}/items/{self.c_w['_id']}/teams"
        # wv (not in Sales) can't move into Sales; wm (member) can; then wv loses it.
        r = await self.http.put(put, headers=self.session("owner"), json={"team_ids": [self.eng]})
        self.assertEqual(r.status_code, 403, r.text)
        r = await self.http.put(put, headers=self.session("owner"), json={"team_ids": [self.sales]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([t["name"] for t in r.json()["teams"]], ["Sales"])
        self.assertNotIn(self.c_w["slug"], await self.listed("wv"))
        # Shared to Eng too (by the admin): everyone reads it again.
        r = await self.http.put(put, headers=self.session("wa"), json={"team_ids": [self.sales, self.eng]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn(self.c_w["slug"], await self.listed("wv"))
        # Back to company-wide: the fields are gone.
        r = await self.http.put(put, headers=self.session("wa"), json={"team_ids": [], "project_ids": []})
        self.assertEqual(r.json()["team_ids"], [])
        raw = await self.db["documents"].find_one({"_id": self.c_w["_id"]})
        self.assertNotIn("team_ids", raw)

    async def test_roles_and_visibility(self):
        r = await self.http.post(f"{self.base}/teams", headers=self.session("wm"), json={"name": "Nope"})
        self.assertEqual(r.status_code, 403)
        t = f"{self.base}/teams/{self.sales}"
        # The lead adds people; a member can't; visibility is the admin's.
        self.assertEqual((await self.http.post(f"{t}/members", headers=self.session("wm"),
                                               json={"user_ids": [self.uid["wv"]]})).status_code, 403)
        r = await self.http.post(f"{t}/members", headers=self.session("owner"), json={"user_ids": [self.uid["wv"]]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((await self.get(self.s_w["slug"], self.session("wv"))).status_code, 200)
        self.assertEqual((await self.http.patch(t, headers=self.session("owner"), json={"visibility": "open"})).status_code, 403)
        r = await self.http.delete(f"{t}/members/{self.uid['wv']}", headers=self.session("wv"))   # leave
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((await self.get(self.s_w["slug"], self.session("wv"))).status_code, 404)
        r = await self.http.patch(t, headers=self.session("wa"), json={"visibility": "open"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((await self.get(self.s_w["slug"], self.session("wv"))).status_code, 200)
        # Settings: private-team pages say admins can see it.
        home = (await self.http.get(f"{self.base}/teams/{self.eng}", headers=self.session("wv"))).json()
        self.assertTrue(home["team"]["admins_can_see"])
        # A private team's home for an outsider: card + brief only.
        await self.http.patch(t, headers=self.session("wa"), json={"visibility": "private"})
        home = (await self.http.get(t, headers=self.session("ownv"))).json()
        self.assertFalse(home["can_read"])
        self.assertNotIn("members", home["team"])
        self.assertNotIn("recent", home)
        # Delete: its items become company-wide.
        self.assertEqual((await self.http.delete(t, headers=self.session("wa"))).status_code, 204)
        self.assertNotIn("team_ids", await self.db["documents"].find_one({"_id": self.s_w["_id"]}))

    async def test_sidebar_and_projects(self):
        side = (await self.http.get(f"{self.base}/teams", headers=self.session("wm"))).json()
        self.assertEqual([t["name"] for t in side["teams"]], ["Sales"])
        self.assertEqual(side["browse"], {"open": 1, "private": 1})
        r = await self.http.post(f"{self.base}/projects", headers=self.session("wm"), json={"name": "Q4", "team_ids": [self.sales]})
        self.assertEqual(r.status_code, 403)
        r = await self.http.post(f"{self.base}/projects", headers=self.session("owner"),
                                 json={"name": "Q4 launch", "team_ids": [self.sales, self.eng]})
        self.assertEqual(r.status_code, 201, r.text)
        pid = r.json()["id"]
        self.assertEqual(r.json()["visibility"], "private")    # a private team is linked
        # Members of every linked team contribute; others don't see it.
        doc = await self.mkdoc("W", grants=False, project_ids=[pid])
        self.assertIn(doc["slug"], await self.listed("ownv"))
        self.assertIn(doc["slug"], await self.listed("wm", space=f"team:{self.sales}"))
        self.assertEqual(await self.listed("wv", space=f"project:{pid}"), {doc["slug"]})
        await self.add_member("W1", "former", "member")
        self.assertNotIn(doc["slug"], await self.listed("former"))


class Memory(TeamsWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await self.turn_on()
        self.m = await self.standup()      # attendees Ada (owner), Bo (wm), Priya (wa), Ravi (wv)
        await self.tick()

    async def test_meeting_routed_to_its_team(self):
        row = await self.db["meetings"].find_one({"_id": T.oid(self.m["id"])})
        self.assertEqual(row["team_ids"], [self.sales])          # Ada + Bo are Sales; Ravi alone isn't Eng
        self.assertEqual(row["routing"]["state"], "auto")
        page = await self.db["documents"].find_one({"_id": row["doc_id"]})
        self.assertEqual(page["team_ids"], [self.sales])
        if row.get("transcript_doc_id"):
            self.assertEqual((await self.db["documents"].find_one({"_id": row["transcript_doc_id"]}))["team_ids"], [self.sales])
        for who, seen in (("wm", True), ("wa", True), ("wv", False), ("ownv", False)):
            r = await self.http.get("/api/v1/meetings", headers=self.session(who), params={"workspace": self.W})
            ids = {m["id"] for m in r.json()["meetings"]}
            self.assertEqual(self.m["id"] in ids, seen, who)
        r = await self.http.get(f"/api/v1/meetings/{self.m['id']}/teams", headers=self.session("owner"))
        self.assertEqual(r.json()["suggestions"][0]["team_id"], self.sales)
        # Confirming (moving it to Eng as the admin) re-routes it.
        r = await self.http.put(f"/api/v1/meetings/{self.m['id']}/teams", headers=self.session("wa"),
                                json={"team_ids": [self.eng]})
        self.assertEqual((r.status_code, r.json()["state"]), (200, "confirmed"), r.text)
        r = await self.http.get("/api/v1/meetings", headers=self.session("ownv"), params={"workspace": self.W})
        self.assertIn(self.m["id"], {m["id"] for m in r.json()["meetings"]})

    async def test_profiles_and_memory_leak_free(self):
        bo = self.uid["wm"]
        mine = (await self.person("wm", who="wm")).json()
        self.assertTrue(mine["working_on"])
        self.assertEqual([t["name"] for t in mine["working_on"][0]["teams"]], ["Sales"])
        self.assertTrue((await self.person("wm", who="wa")).json()["working_on"])
        for outsider in ("wv", "ownv"):
            prof = (await self.person("wm", who=outsider)).json()
            flat = repr(prof)
            self.assertNotIn("sourcing filters", flat.lower(), outsider)
            self.assertNotIn(self.m["slug"] if "slug" in self.m else "zz-none", flat)
        # The memory board scoped to Eng (open) has nothing from Sales.
        r = await self.http.get(f"/api/v1/team/{self.W}", headers=self.session("wm"), params={"space": f"team:{self.eng}"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn("sourcing filters", repr(r.json()).lower())
        r = await self.http.get(f"/api/v1/team/{self.W}", headers=self.session("wv"), params={"space": f"team:{self.sales}"})
        self.assertEqual(r.status_code, 404)
        # Ask's retrieval (team memory + meetings) for an outsider: nothing from Sales.
        actor = access.Actor.of(await self._u("wv"))
        ctx = access.Ctx(self.db)
        ws = await wm.ws_info(self.db, self.W)
        v = await wm.visible(self.db, actor, ctx, ws.id)
        self.assertFalse([f for f in v.facts if f["subject"] == bo])
        from app.services import meeting_memory

        rd = await meeting_memory.readable_meetings(self.db, actor, ctx, self.W)
        self.assertNotIn(self.m["id"], rd.rows)
        # MCP profile for the outsider: no Sales lines.
        token = await self.mcp_token("wv", write=False)
        _s, res = await self.mcp_call(token, "get_person_profile", {"workspace": self.W, "person": "Bo"})
        self.assertNotIn("sourcing filters", repr(res).lower())

    async def _u(self, who: str):
        from app.services import user as user_service

        return await user_service.get_user_by_id(self.db, self.uid[who])

    async def test_brief_bridge(self):
        team = await T.get_team(self.db, self.W, self.sales)
        with __import__("unittest").mock.patch.object(T, "now_utc", lambda: datetime(2026, 11, 9, 10, tzinfo=timezone.utc)):
            row = await team_briefs.draft(self.db, team, now=datetime(2026, 11, 9, 10, tzinfo=timezone.utc), ai=False)
        self.assertIsNotNone(row)
        self.assertTrue(row["lines"])
        url = f"{self.base}/teams/{self.sales}/briefs/latest"
        lead = (await self.http.get(url, headers=self.session("owner"))).json()
        self.assertTrue(lead["can_edit"])
        outsider = (await self.http.get(url, headers=self.session("wv"))).json()
        self.assertFalse(outsider["can_edit"])
        self.assertEqual(len(outsider["lines"]), len(lead["lines"]))
        self.assertTrue(all(not ln["sources"] for ln in outsider["lines"]))       # can't open the meeting
        self.assertTrue(any(ln["sources"] for ln in lead["lines"]))
        # A lead hides a line: outsiders never see it, the lead still does (marked).
        lid = lead["lines"][0]["id"]
        r = await self.http.patch(f"{self.base}/teams/{self.sales}/briefs/{lead['id']}/lines/{lid}",
                                  headers=self.session("owner"), json={"hidden": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn(lid, {ln["id"] for ln in (await self.http.get(url, headers=self.session("wv"))).json()["lines"]})
        self.assertEqual((await self.http.patch(f"{self.base}/teams/{self.sales}/briefs/{lead['id']}/lines/{lid}",
                                                headers=self.session("wm"), json={"hidden": False})).status_code, 403)
        # The company-wide weekly summary no longer carries Sales lines.
        v = await team_extras.team_visible(self.db, self.W)
        self.assertFalse(v.facts)


class Migration(TeamsWorld):
    async def test_groups_become_suggested_teams_and_review(self):
        await team_extras.save_group(self.db, self.W, self.uid["wa"], "Support", [self.uid["wm"], self.uid["wv"]])
        side = (await self.http.get(f"{self.base}/teams", headers=self.session("wa"))).json()
        self.assertEqual([s["name"] for s in side["suggested"]], ["Support"])
        self.assertEqual((await self.http.get(f"{self.base}/teams", headers=self.session("wm"))).json()["suggested"], [])
        gid = side["suggested"][0]["group_id"]
        r = await self.http.post(f"{self.base}/teams/suggested/{gid}/accept", headers=self.session("wa"),
                                 json={"visibility": "open", "lead_ids": [self.uid["wm"]]})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["member_count"], 2)
        self.assertFalse((await self.http.get(f"{self.base}/teams", headers=self.session("wa"))).json()["suggested"])
        # Review: company-wide rows only; apply moves; done hides the chip.
        rv = (await self.http.get(f"{self.base}/teams-review", headers=self.session("wa"))).json()
        page_ids = {p["id"] for p in rv["pages"]}
        self.assertIn(str(self.c_w["_id"]), page_ids)
        self.assertNotIn(str(self.s_w["_id"]), page_ids)
        self.assertEqual((await self.http.get(f"{self.base}/teams-review", headers=self.session("wm"))).status_code, 403)
        r = await self.http.post(f"{self.base}/teams-review/apply", headers=self.session("wa"),
                                 json={"moves": [{"kind": "page", "id": str(self.c_w["_id"]), "team_ids": [self.sales]}]})
        self.assertEqual(r.json(), {"applied": 1})
        self.assertNotIn(self.c_w["slug"], await self.listed("wv"))
        self.assertEqual((await self.http.post(f"{self.base}/teams-review/done", headers=self.session("wa"))).status_code, 204)
        self.assertIsNone((await self.http.get(f"{self.base}/teams", headers=self.session("wa"))).json()["review"])

    async def test_existing_content_untouched(self):
        # A workspace without teams: nothing narrows (the rule's fast path).
        self.assertEqual(await self.listed("wv", space="all") - {self.s_w["slug"], self.s_l["slug"]},
                         {self.e_w["slug"], self.c_w["slug"]})
        f = await access.facts(access.Actor.anonymous(), self.c_w, access.Ctx(self.db))
        self.assertTrue(f.team_ok)
