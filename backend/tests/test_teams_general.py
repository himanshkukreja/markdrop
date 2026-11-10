"""The default team, General (nav redesign 2026-11-10; services/teams.ensure_general / migrate_general).

Every workspace has exactly one open General team that every member is in (new members join it, leaving the
workspace takes you out). It can be renamed but not deleted, made private, or have people removed. Its content
is the company-wide content: its id is never stored on items, so the access rule and the private-team leak
matrix (tests/test_teams.py) are unchanged.
"""

from __future__ import annotations

from datetime import datetime, timezone

from bson import ObjectId

from tests.test_teams import TeamsWorld
from app.services import team_routing, teams as T


class General(TeamsWorld):
    async def general(self) -> dict:
        row = await self.db[T.TEAMS].find_one({"workspace_id": self.W, "general": True})
        self.assertIsNotNone(row)
        return row

    async def sidebar(self, who: str) -> dict:
        r = await self.http.get(f"{self.base}/teams", headers=self.session(who))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def test_migration_is_idempotent_and_has_everyone(self):
        made = await T.migrate_general(self.db)
        self.assertGreaterEqual(made, 1)
        self.assertEqual(await T.migrate_general(self.db), 0)
        await T.ensure_general(self.db, self.W)
        self.assertEqual(await self.db[T.TEAMS].count_documents({"workspace_id": self.W, "general": True}), 1)
        g = await self.general()
        members = {m["user_id"] for m in await self.db["memberships"].find({"workspace_id": self.W}).to_list(length=100)}
        self.assertEqual(set(g["member_ids"]), members)
        self.assertEqual(g["visibility"], "open")
        self.assertEqual(g["name"], "General")
        ws = await self.db["workspaces"].find_one({"_id": ObjectId(self.W)})
        self.assertEqual(g["lead_ids"], [ws["owner_id"]])
        # Every workspace, not only this one.
        n_ws = await self.db["workspaces"].count_documents({})
        self.assertEqual(await self.db[T.TEAMS].count_documents({"general": True}), n_ws)

    async def test_sidebar_pins_general_first_for_everyone(self):
        for who in ("owner", "wm", "wv", "wa", "ownv"):
            side = await self.sidebar(who)
            self.assertTrue(side["teams"][0]["general"], who)
            self.assertEqual(side["teams"][0]["name"], "General")
            self.assertEqual(sum(1 for t in side["teams"] if t["general"]), 1)
        # Browse counts leave General out (it's not "more teams to join").
        side = await self.sidebar("wv")
        self.assertEqual(side["browse"], {"open": 1, "private": 1})
        r = await self.http.get(f"{self.base}/teams/browse", headers=self.session("wv"))
        self.assertTrue(r.json()["teams"][0]["general"])

    async def test_new_members_auto_join_and_leaving_removes(self):
        await T.migrate_general(self.db)
        new = str(ObjectId())
        await self.db["users"].insert_one({"_id": ObjectId(new), "email": "late@x.test", "name": "Late"})
        await self.db["memberships"].insert_one({"workspace_id": self.W, "user_id": new, "role": "member",
                                                 "created_at": datetime.now(timezone.utc)})
        await T.ensure_general(self.db, self.W)
        self.assertIn(new, (await self.general())["member_ids"])
        # Leaving the workspace (services/workspace.remove_member) takes them out of every team, General too.
        from app.services import workspace as ws_service

        await ws_service.remove_member(self.db, self.W, new)
        self.assertNotIn(new, (await self.general())["member_ids"])

    async def test_cannot_delete_private_or_remove_people_but_can_rename(self):
        await self.sidebar("wa")
        gid = str((await self.general())["_id"])
        r = await self.http.delete(f"{self.base}/teams/{gid}", headers=self.session("wa"))
        self.assertEqual(r.status_code, 409, r.text)
        r = await self.http.patch(f"{self.base}/teams/{gid}", headers=self.session("wa"), json={"visibility": "private"})
        self.assertEqual(r.status_code, 409, r.text)
        r = await self.http.delete(f"{self.base}/teams/{gid}/members/{self.uid['wv']}", headers=self.session("wa"))
        self.assertEqual(r.status_code, 409, r.text)
        r = await self.http.delete(f"{self.base}/teams/{gid}/members/{self.uid['wv']}", headers=self.session("wv"))
        self.assertEqual(r.status_code, 409, r.text)   # can't leave General either
        r = await self.http.patch(f"{self.base}/teams/{gid}", headers=self.session("wa"),
                                  json={"name": "Everyone at Acme", "icon": "glyph:building", "description": "All of us"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["name"], "Everyone at Acme")
        self.assertTrue(r.json()["general"])
        g = await self.general()
        self.assertEqual((g["visibility"], g["slug"]), ("open", "general"))
        # Old Company links and "company" scopes still land on it.
        for ref in ("general", "company", gid):
            r = await self.http.get(f"{self.base}/teams/{ref}", headers=self.session("wv"))
            self.assertEqual(r.status_code, 200, (ref, r.text))
            self.assertEqual(r.json()["team"]["id"], gid)
        # Still 409 after the rename, and only admins/leads may rename.
        r = await self.http.patch(f"{self.base}/teams/{gid}", headers=self.session("wv"), json={"name": "Mine"})
        self.assertEqual(r.status_code, 403, r.text)

    async def test_general_space_is_company_wide_and_access_unchanged(self):
        await self.sidebar("wa")
        gid = str((await self.general())["_id"])
        # General's space = the company-wide items, for everyone; private-team items never appear in it.
        for who in ("wv", "wm", "wa"):
            self.assertEqual(await self.listed(who, space=f"team:{gid}"), {self.c_w["slug"]}, who)
        self.assertEqual(await self.listed("wv", space="company"), {self.c_w["slug"]})
        got = await self.searched("wv", space=f"team:{gid}")
        self.assertNotIn(self.s_w["slug"], got)
        # Putting an item in General = company-wide (no General id is ever stored).
        doc = self.e_w
        r = await self.http.put(f"{self.base}/items/{doc['slug']}/teams", headers=self.session("wa"),
                                json={"team_ids": [gid], "project_ids": []})
        self.assertEqual(r.status_code, 200, r.text)
        raw = await self.db["documents"].find_one({"slug": doc["slug"]})
        self.assertNotIn("team_ids", raw)
        r = await self.http.put(f"{self.base}/items/{doc['slug']}/teams", headers=self.session("wa"),
                                json={"team_ids": [gid, self.eng], "project_ids": []})
        raw = await self.db["documents"].find_one({"slug": doc["slug"]})
        self.assertEqual(raw["team_ids"], [self.eng])
        # The leak matrix is unchanged: a private team's page stays out of reach for non-members.
        self.assertEqual((await self.get(self.s_w["slug"], self.session("wv"))).status_code == 200, False)
        self.assertNotIn(self.s_w["slug"], await self.listed("wv"))

    async def test_general_home_across_activity_new_people(self):
        await self.sidebar("wa")
        r = await self.http.get(f"{self.base}/teams/general", headers=self.session("wv"))
        self.assertEqual(r.status_code, 200, r.text)
        home = r.json()
        names = {a["team"]["name"]: a for a in home["across"]}
        self.assertEqual(set(names), {"Sales", "Eng"})
        self.assertIsNone(names["Sales"]["line"])          # private, not a member: its name only
        self.assertFalse(names["Sales"]["team"]["can_read"])
        slugs = {i["slug"] for i in home["activity"]["items"]}
        self.assertNotIn(self.s_w["slug"], slugs)
        self.assertNotIn(self.s_l["slug"], slugs)
        self.assertIn(self.c_w["slug"], slugs)
        self.assertIn("new_people", home)
        # A regular team's home has none of these.
        r = await self.http.get(f"{self.base}/teams/{self.eng}", headers=self.session("wv"))
        self.assertNotIn("across", r.json())

    async def test_meeting_suggestions_never_pick_general(self):
        await self.sidebar("wa")
        row = {"attendees": [{"user_id": self.uid[u]} for u in ("owner", "wm", "wv", "ownv")]}
        sug = await team_routing.suggest(self.db, self.W, row)
        gid = str((await self.general())["_id"])
        self.assertNotIn(gid, {s["team_id"] for s in sug})
        self.assertTrue(sug)
