"""Move a folder to another team (services/folder_move.py; brief .work/briefs/jason-folders-todos.md §1).

The privacy contract, before and after:
* workspace-visible items: readable by the source team's members before, by the target team's after —
  never by anyone else (a non-member of the target team loses them, a workspace viewer in neither never
  gets them);
* private items stay private (the target team's members don't get them);
* a person an item was shared with by name keeps it;
* public links keep working (anonymous 200 before and after), and the preview lists them;
* subfolders and deep trees (folders four deep, sub-pages) all move; folder rules move with them (a grant to
  the source team names the target team; a rule inherited from the parent it leaves is copied onto it);
* who may: admins, or a lead of the source team who is also in the target team;
* big folders: a background job with progress.

World: tests/test_folder_access.FolderWorld (W1: wa admin, wm member, wv viewer, owner member, ownv viewer;
gv is named on the fixture docs). Sales (private: wm, lead wm) holds the folder Sales/Q4; Marketing
(private: ownv, lead ownv).
"""

from __future__ import annotations

import asyncio
from unittest import mock

from app.services import folder_move
from app.services import teams as T
from tests.test_folder_access import FolderWorld


class MoveWorld(FolderWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        from app.limiter import limiter

        limiter.enabled = False
        self.addCleanup(setattr, limiter, "enabled", True)
        await T.ensure_general(self.db, self.W)
        r = await self.http.post(f"{self.base}/teams", headers=self.session("wa"),
                                 json={"name": "Marketing", "visibility": "private", "member_ids": [self.uid["ownv"]],
                                       "lead_ids": [self.uid["ownv"]]})
        self.assertEqual(r.status_code, 201, r.text)
        self.mkt = r.json()["id"]
        self.deals = await self.mkfolder("Deals", parent=self.q4)
        self.acme = await self.mkfolder("Acme", parent=self.deals)
        self.d_deep = await self.mkdoc("W", grants=False, folder_id=self.acme, folder_path=["sales", "q4", "deals", "acme"])
        self.d_sub = await self.mkdoc("W", grants=False, folder_id=self.sales, folder_path=["sales"],
                                      parent_id=self.d_ws["_id"], editor="blocks")
        self.d_deep_link = await self.mkdoc("L", grants=False, folder_id=self.acme,
                                            folder_path=["sales", "q4", "deals", "acme"])
        r = await self.http.put(f"{self.base}/folders/{self.sales}/teams", headers=self.session("wa"),
                                json={"team_ids": [self.team], "project_ids": [], "apply_to_items": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.moved = [self.d_ws, self.d_q4, self.d_deep, self.d_sub]

    async def preview(self, who: str, folder: str, team: str, status: int = 200) -> dict:
        r = await self.http.get(f"{self.base}/folders/{folder}/move-to-team", headers=self.session(who),
                                params={"team": team})
        self.assertEqual(r.status_code, status, r.text)
        return r.json()

    async def move(self, who: str, folder: str, team: str, status: int = 200, **body) -> dict:
        r = await self.http.post(f"{self.base}/folders/{folder}/move-to-team", headers=self.session(who),
                                 json={"team": team, **body})
        self.assertEqual(r.status_code, status, r.text)
        return r.json()

    async def team_ids(self, doc: dict) -> list[str]:
        return T.ids_of(await self.doc(doc["slug"]), "team_ids")


class Preview(MoveWorld):
    async def test_counts_and_public_links(self):
        p = await self.preview("wa", self.sales, self.mkt)
        c = p["counts"]
        self.assertEqual(c["folders"], 4)
        self.assertEqual(c["items"], 7)
        self.assertEqual(c["pages"], 1)
        self.assertEqual(c["files"], 1)
        self.assertEqual(c["workspace_to_team"], 4)
        self.assertEqual(c["private"], 1)
        self.assertEqual(c["public_links"], 2)
        self.assertEqual(c["shared_with_people"], 3)  # the fixture docs with grants (gv/ge)
        self.assertEqual({x["slug"] for x in p["public_links"]}, {self.d_link["slug"], self.d_deep_link["slug"]})
        self.assertTrue(p["can_move"])
        self.assertFalse(p["same_team"])
        self.assertEqual(p["to_team"]["name"], "Marketing")
        self.assertEqual([t["name"] for t in p["from_teams"]], ["Sales"])
        self.assertFalse(p["moves_to_top"])
        # Nothing changed.
        self.assertEqual(await self.team_ids(self.d_ws), [self.team])

    async def test_same_team_and_not_allowed(self):
        p = await self.preview("wa", self.sales, self.team)
        self.assertTrue(p["same_team"])
        self.assertFalse(p["can_move"])
        p = await self.preview("wm", self.sales, "General")
        self.assertTrue(p["can_move"])  # wm leads Sales and is in General
        # A private team the caller isn't in is not found.
        await self.preview("wm", self.sales, self.mkt, status=404)


class Visibility(MoveWorld):
    async def test_before_and_after(self):
        anon = lambda d: self.reads("AN", d)  # noqa: E731
        # Before: Sales sees them, Marketing doesn't, wv never.
        for d in self.moved:
            self.assertEqual(await self.reads("wm", d), 200, d["slug"])
            self.assertEqual(await self.reads("ownv", d), 404, d["slug"])
            self.assertEqual(await self.reads("wv", d), 404, d["slug"])
        self.assertEqual(await anon(self.d_link), 200)
        self.assertEqual(await anon(self.d_deep_link), 200)

        out = await self.move("wa", self.sales, self.mkt)
        self.assertEqual(out["job"]["state"], "done")

        # After: the target team's members see the workspace-visible items, the source team's members don't.
        for d in self.moved:
            self.assertEqual(await self.team_ids(d), [self.mkt], d["slug"])
            self.assertEqual(await self.reads("ownv", d), 200, d["slug"])
            self.assertEqual(await self.reads("wm", d), 404, d["slug"])
            self.assertEqual(await self.reads("wv", d), 404, d["slug"])
        # Private stays private.
        self.assertEqual(await self.reads("ownv", self.d_priv), 404)
        self.assertEqual(await self.reads("wm", self.d_priv), 404)
        self.assertEqual(await self.reads("owner", self.d_priv), 200)
        # Shared by name: kept.
        self.assertEqual(await self.reads("gv", self.d_ws), 200)
        # Public links still work.
        self.assertEqual(await anon(self.d_link), 200)
        self.assertEqual(await anon(self.d_deep_link), 200)
        # Listings follow.
        self.assertFalse({d["slug"] for d in self.moved} & await self.listed("wm"))
        self.assertTrue({d["slug"] for d in self.moved} <= await self.listed("ownv"))
        self.assertFalse({d["slug"] for d in self.moved} & await self.listed("wv"))
        # The folders are in Marketing's Files & pages (subfolders, four deep).
        for fid in (self.sales, self.q4, self.deals, self.acme):
            row = await self.db["folders"].find_one({"_id": T.oid(fid)})
            self.assertEqual(T.ids_of(row, "team_ids"), [self.mkt])
        # Logged in the folder log.
        row = await self.db["folder_access_log"].find_one({"folder_id": self.sales, "kind": "move_team"})
        self.assertIn("from Sales to Marketing", row["text"])

    async def test_move_to_general_makes_them_company_wide(self):
        await self.move("wm", self.sales, "General")
        for d in self.moved:
            self.assertEqual(await self.team_ids(d), [])
            self.assertEqual(await self.reads("wv", d), 200, d["slug"])
        self.assertEqual(await self.reads("wv", self.d_priv), 404)

    async def test_open_team_is_readable_by_the_workspace_only_as_the_team_rule_says(self):
        r = await self.http.patch(f"{self.base}/teams/{self.mkt}", headers=self.session("wa"), json={"visibility": "open"})
        self.assertEqual(r.status_code, 200, r.text)
        p = await self.preview("wa", self.sales, self.mkt)
        self.assertTrue(p["to_team_open"])
        await self.move("wa", self.sales, self.mkt)
        self.assertEqual(await self.reads("wv", self.d_ws), 200)
        self.assertEqual(await self.reads("wv", self.d_priv), 404)

    async def test_projects_of_the_old_team_are_dropped(self):
        r = await self.http.post(f"{self.base}/projects", headers=self.session("wa"),
                                 json={"name": "Launch", "team_ids": [self.team]})
        self.assertEqual(r.status_code, 201, r.text)
        pid = r.json()["id"]
        await self.db["documents"].update_one({"_id": self.d_ws["_id"]}, {"$set": {"project_ids": [pid]}})
        self.assertEqual((await self.preview("wa", self.sales, self.mkt))["counts"]["projects_dropped"], 1)
        await self.move("wa", self.sales, self.mkt)
        self.assertEqual(T.ids_of(await self.doc(self.d_ws["slug"]), "project_ids"), [])
        self.assertEqual(await self.reads("wm", self.d_ws), 404)


class Permission(MoveWorld):
    async def test_lead_of_source_must_be_in_target(self):
        await self.move("wm", self.sales, self.mkt, status=404)   # Marketing is private and wm isn't in it
        r = await self.http.post(f"{self.base}/teams/{self.mkt}/members", headers=self.session("wa"),
                                 json={"user_ids": [self.uid["wm"]]})
        self.assertEqual(r.status_code, 200, r.text)
        await self.move("wm", self.sales, self.mkt)
        self.assertEqual(await self.team_ids(self.d_ws), [self.mkt])

    async def test_members_who_arent_leads_and_others_are_refused(self):
        await self.team_add("owner")      # a Sales member, not a lead
        r = await self.http.post(f"{self.base}/teams/{self.mkt}/members", headers=self.session("wa"),
                                 json={"user_ids": [self.uid["owner"]]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse((await self.preview("owner", self.sales, self.mkt))["can_move"])
        await self.move("owner", self.sales, self.mkt, status=403)
        await self.move("ownv", self.sales, self.mkt, status=403)  # Marketing's lead, not Sales'
        r = await self.http.post(f"{self.base}/folders/{self.sales}/move-to-team", headers=self.session("stranger"),
                                 json={"team": self.mkt})
        self.assertEqual(r.status_code, 404)
        self.assertEqual(await self.team_ids(self.d_ws), [self.team])

    async def test_meetings_folders_stay(self):
        await self.db["folders"].update_one({"_id": T.oid(self.q4)}, {"$set": {"meetings": True}})
        await self.move("wa", self.q4, self.mkt, status=409)


class Rules(MoveWorld):
    async def test_team_grant_repointed(self):
        await self.restrict_to_team()
        self.assertEqual(await self.reads("wm", self.d_ws), 200)
        p = await self.preview("wa", self.sales, self.mkt)
        self.assertEqual(p["counts"]["team_grants_repointed"], 1)
        await self.move("wa", self.sales, self.mkt)
        row = await self.db["folders"].find_one({"_id": T.oid(self.sales)})
        self.assertTrue(row["access"]["restricted"])
        self.assertEqual([t["team_id"] for t in row["access"]["teams"]], [self.mkt])
        self.assertEqual(await self.reads("ownv", self.d_ws), 200)
        self.assertEqual(await self.reads("wm", self.d_ws), 404)
        self.assertEqual(await self.reads("wv", self.d_ws), 404)
        # A restricted folder's link items were closed to the link before; still closed (never more open).
        self.assertEqual(await self.reads("AN", self.d_link), 401)

    async def test_subfolder_leaving_a_restricted_parent_keeps_the_restriction(self):
        await self.put_access(self.sales, restricted=True, teams=[{"team_id": self.team, "role": "editor"}],
                              people=[{"email": self.email["gv"], "role": "viewer"}])
        p = await self.preview("wa", self.q4, self.mkt)
        self.assertTrue(p["moves_to_top"])
        self.assertTrue(p["keeps_inherited_rule"])
        await self.move("wa", self.q4, self.mkt)
        q4 = await self.db["folders"].find_one({"_id": T.oid(self.q4)})
        self.assertIsNone(q4.get("parent_id"))
        self.assertTrue(q4["access"]["restricted"])
        self.assertEqual({t["team_id"] for t in q4["access"]["teams"]}, {self.mkt})
        self.assertEqual({p["email"] for p in q4["access"]["people"]}, {self.email["gv"]})
        for d in (self.d_q4, self.d_deep):
            self.assertEqual(await self.reads("ownv", d), 200, d["slug"])
            self.assertEqual(await self.reads("gv", d), 200, d["slug"])
            self.assertEqual(await self.reads("wm", d), 404, d["slug"])
            self.assertEqual(await self.reads("wv", d), 404, d["slug"])
        # The parent's own items didn't move.
        self.assertEqual(await self.team_ids(self.d_ws), [self.team])
        self.assertEqual(await self.reads("AN", self.d_deep_link), 401)  # capped before and after


class Background(MoveWorld):
    async def test_big_folder_moves_in_a_job(self):
        for _ in range(5):
            await self.mkdoc("W", grants=False, folder_id=self.acme, folder_path=["sales", "q4", "deals", "acme"],
                             team_ids=[self.team])
        with mock.patch.object(folder_move, "INLINE_MAX", 2), mock.patch.object(folder_move, "BATCH", 2):
            p = await self.preview("wa", self.sales, self.mkt)
            self.assertTrue(p["background"])
            out = await self.move("wa", self.sales, self.mkt)
            self.assertEqual(out["job"]["state"], "running")
            self.assertEqual(out["job"]["total"], 11)
            await self.move("wa", self.sales, self.team, status=409)  # still moving
            for t in list(folder_move._TASKS):
                await asyncio.wait({t}, timeout=30)
        r = await self.http.get(f"{self.base}/folders/{self.sales}/move-to-team/job", headers=self.session("wa"))
        self.assertEqual(r.json()["job"], {"state": "done", "done": 11, "total": 11, "to_team": "Marketing"})
        left = await self.db["documents"].count_documents({"workspace_id": self.W, "team_ids": self.team})
        self.assertEqual(left, 0)
        for d in self.moved:
            self.assertEqual(await self.reads("ownv", d), 200)

    async def test_reconciler_resumes_a_stopped_job(self):
        from datetime import timedelta

        with mock.patch.object(folder_move, "INLINE_MAX", 1), \
                mock.patch.object(folder_move, "run_job", mock.AsyncMock()):
            await self.move("wa", self.sales, self.mkt)
        await self.db[folder_move.JOBS].update_one({}, {"$set": {"updated_at": folder_move.now_utc() - timedelta(minutes=5)}})
        self.assertEqual(await self.team_ids(self.d_ws), [self.team])  # not yet
        self.assertEqual(await folder_move.run_pending(self.db), 1)
        self.assertEqual(await self.team_ids(self.d_ws), [self.mkt])


class Mcp(MoveWorld):
    async def call(self, who: str, args: dict) -> dict:
        status, res = await self.mcp_call(await self.mcp_token(who, write=True), "move_folder_to_team", args)
        self.assertEqual(status, 200, res)
        return res

    async def test_dry_run_then_move(self):
        res = await self.call("wa", {"workspace": "Acme", "path": "sales", "team": "Marketing", "dry_run": True})
        self.assertFalse(res["isError"], res)
        self.assertIn("Dry run", res["content"][0]["text"])
        self.assertIn("2 public link(s) keep working", res["content"][0]["text"])
        self.assertEqual(await self.team_ids(self.d_ws), [self.team])
        res = await self.call("wa", {"workspace": "Acme", "path": "sales", "team": "Marketing"})
        self.assertFalse(res["isError"], res)
        self.assertEqual(res["structuredContent"]["job"]["state"], "done")
        self.assertEqual(await self.team_ids(self.d_ws), [self.mkt])

    async def test_refused_for_a_member(self):
        res = await self.call("owner", {"workspace": "Acme", "path": "sales", "team": "General"})
        self.assertTrue(res["isError"])
        self.assertEqual(await self.team_ids(self.d_ws), [self.team])
