"""MCP gaps an agent hit (.work/ai-eval/REPORT.md issue 9), each with the same access rules as before.

search without a query (owner / updated / space narrows it) and with a person as owner; list_workspace_items
filters (owner, team, created/updated ranges), created_at / teams / system_page on each item, and a cursor that
round-trips (and says so in the text the model reads); get_meeting by title; list_team for one team's space.
World (tests/test_teams.py): Sales is private (owner + wm, owner leads), Eng is open (wv + ownv, wv leads),
wa is the workspace admin.
"""

from __future__ import annotations

from datetime import datetime

from bson import ObjectId

from tests.test_mcp_gaps import _Calls
from tests.test_teams import TeamsWorld


class AgentGaps(_Calls, TeamsWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        # Pages Markdrop keeps: the Sales backlog (owned by its lead) and wm's to-do page.
        self.backlog = await self.mkdoc("W", grants=False, team_ids=[self.sales], backlog_team_id=self.sales,
                                        editor="blocks")
        self.todo = await self.mkdoc("W", owner="wm", grants=False, todo_user_id=self.uid["wm"], editor="blocks")
        # Names (tests/test_meeting_memory.py): owner Ada Lovelace, wm Bo Chen, wa Priya Sharma, wv Ravi Kumar; and
        # a look-alike first name.
        await self.db["users"].update_one({"_id": ObjectId(self.uid["ownv"])}, {"$set": {"name": "Ada Byron"}})

    async def slugs(self, who: str, tool: str, args: dict) -> list[str]:
        sc = self.ok(await self.call(who, tool, args, write=False))
        return [r.get("slug") or r.get("id") for r in sc.get("items", sc.get("results", []))]

    # ── search ────────────────────────────────────────────────────────────────

    async def test_search_without_query_by_owner(self):
        self.refused(await self.call("wm", "search", {}, write=False), "Give a query")
        got = set(await self.slugs("wm", "search", {"owner": "Ada Lovelace"}))
        self.assertEqual(got, {self.s_w["slug"], self.s_l["slug"], self.c_w["slug"]})   # no backlog page
        # By email or id: the same; a member outside Sales never gets its items.
        self.assertEqual(set(await self.slugs("wm", "search", {"owner": self.email["owner"]})), got)
        self.assertEqual(set(await self.slugs("wv", "search", {"owner": self.uid["owner"]})), {self.c_w["slug"]})
        # With words too.
        got = set(await self.slugs("wv", "search", {"query": "Title", "owner": "lovelace"}))
        self.assertEqual(got, {self.c_w["slug"]})
        self.assertNotIn(self.e_w["slug"], got)
        # me: own items without the to-do page.
        mine = set(await self.slugs("wm", "search", {"owner": "me"}))
        self.assertNotIn(self.todo["slug"], mine)
        self.refused(await self.call("wm", "search", {"owner": "Ada"}, write=False), "More than one person")
        self.refused(await self.call("wm", "search", {"owner": "STRANGER"}, write=False), "No member")
        self.refused(await self.call("wm", "search", {"owner": "Ada Lovelace", "kind": "folder"}, write=False),
                     "documents, pages and files")
        # Unchanged: a plain search.
        self.assertIn(self.c_w["slug"], set(await self.slugs("wm", "search", {"query": "Title"})))
        # updated alone narrows it too.
        self.assertIn(self.c_w["slug"], set(await self.slugs("wm", "search", {"updated": "week"})))

    # ── list_workspace_items ──────────────────────────────────────────────────

    async def test_cursor_round_trips(self):
        everything = set(await self.slugs("wm", "list_workspace_items", {"workspace": self.W, "limit": 100}))
        self.assertGreaterEqual(len(everything), 5)
        seen, cursor, rounds = [], None, 0
        while True:
            res = await self.call("wm", "list_workspace_items",
                                  {"workspace": self.W, "limit": 2, **({"cursor": cursor} if cursor else {})}, write=False)
            sc = self.ok(res)
            seen += [i["slug"] for i in sc["items"]]
            cursor = sc["next_cursor"]
            rounds += 1
            if not cursor:
                break
            # The model reads the text: the cursor is in it.
            self.assertIn(cursor, res["content"][0]["text"])
        self.assertEqual(len(seen), len(set(seen)))
        self.assertEqual(set(seen), everything)
        self.assertGreater(rounds, 2)
        self.refused(await self.call("wm", "list_workspace_items", {"workspace": self.W, "cursor": "100"}, write=False),
                     "next_cursor")
        # With a filter, page by page.
        seen, cursor = [], None
        while True:
            sc = self.ok(await self.call("wm", "list_workspace_items", {"workspace": self.W, "limit": 1, "owner": "Ada Lovelace",
                                                                        **({"cursor": cursor} if cursor else {})}, write=False))
            seen += [i["slug"] for i in sc["items"]]
            cursor = sc["next_cursor"]
            if not cursor:
                break
        self.assertEqual(sorted(seen), sorted([self.s_w["slug"], self.s_l["slug"], self.c_w["slug"]]))

    async def test_owner_team_and_dates(self):
        W = self.W
        sales_items = {self.s_w["slug"], self.s_l["slug"]}
        self.assertEqual(set(await self.slugs("wm", "list_workspace_items", {"workspace": W, "owner": "Ada Lovelace"})),
                         sales_items | {self.c_w["slug"]})
        self.assertEqual(set(await self.slugs("wv", "list_workspace_items", {"workspace": W, "owner": "ada lovelace"})),
                         {self.c_w["slug"]})
        # Without an owner filter the system pages are listed, marked.
        sc = self.ok(await self.call("wm", "list_workspace_items", {"workspace": W}, write=False))
        by = {i["slug"]: i for i in sc["items"]}
        self.assertEqual(by[self.backlog["slug"]]["system_page"], "team_backlog")
        self.assertEqual(by[self.todo["slug"]]["system_page"], "to_dos")
        self.assertIsNone(by[self.c_w["slug"]]["system_page"])
        self.assertEqual(by[self.s_w["slug"]]["teams"], ["Sales"])
        self.assertEqual(by[self.e_w["slug"]]["teams"], ["Eng"])
        self.assertEqual(by[self.c_w["slug"]]["teams"], [])
        self.assertEqual(by[self.c_w["slug"]]["owner"], "Ada Lovelace")
        self.assertTrue(by[self.c_w["slug"]]["created_at"])
        self.assertNotIn(self.todo["slug"], set(await self.slugs("wm", "list_workspace_items", {"workspace": W, "owner": "me"})))
        # Team: id, slug or name; a private team for a non-member is "no such team".
        self.assertEqual(set(await self.slugs("wm", "list_workspace_items", {"workspace": W, "team": "Eng"})), {self.e_w["slug"]})
        self.assertEqual(set(await self.slugs("wm", "list_workspace_items", {"workspace": W, "team": "sales"})),
                         sales_items | {self.backlog["slug"]})
        for ref in ("Sales", self.sales):
            self.refused(await self.call("wv", "list_workspace_items", {"workspace": W, "team": ref}, write=False), "No team")
        self.refused(await self.call("wv", "list_workspace_items", {"workspace": W, "team": "Nope"}, write=False), "No team")
        self.assertEqual(set(await self.slugs("wa", "list_workspace_items", {"workspace": W, "team": "Sales", "owner": "Ada Lovelace"})),
                         sales_items)
        # Dates (both ends inclusive; a date is the whole day).
        await self.db["documents"].update_one({"_id": self.c_w["_id"]}, {"$set": {
            "created_at": datetime(2026, 10, 1, 15), "updated_at": datetime(2026, 10, 5, 9)}})
        self.assertEqual(set(await self.slugs("wm", "list_workspace_items",
                                              {"workspace": W, "created_before": "2026-10-01"})), {self.c_w["slug"]})
        self.assertNotIn(self.c_w["slug"], set(await self.slugs("wm", "list_workspace_items",
                                                                {"workspace": W, "created_after": "2026-10-02"})))
        self.assertEqual(set(await self.slugs("wm", "list_workspace_items", {
            "workspace": W, "updated_after": "2026-10-05", "updated_before": "2026-10-05T23:00:00Z"})), {self.c_w["slug"]})
        self.refused(await self.call("wm", "list_workspace_items", {"workspace": W, "created_after": "last week"}, write=False),
                     "ISO date")

    # ── get_meeting ───────────────────────────────────────────────────────────

    async def test_get_meeting_by_title(self):
        old = await self.standup(date="2026-11-02")
        new = await self.standup()
        secret = await self.standup(title="Secret sync", restricted=True)
        sc = self.ok(await self.call("wm", "get_meeting", {"meeting": "sourcing STANDUP"}, write=False))
        self.assertEqual(sc["id"], new["id"])
        sc = self.ok(await self.call("wm", "get_meeting", {"meeting": "Sourcing standup", "date": "2026-11-02"}, write=False))
        self.assertEqual(sc["id"], old["id"])
        sc = self.ok(await self.call("wm", "get_meeting", {"meeting": "sourcing", "workspace": self.W}, write=False))
        self.assertEqual(sc["id"], new["id"])
        self.refused(await self.call("wm", "get_meeting", {"meeting": "Sourcing standup", "date": "2026-01-01"}, write=False),
                     "not found")
        # A restricted meeting doesn't exist for someone outside it, by title as by id.
        self.refused(await self.call("wv", "get_meeting", {"meeting": "Secret sync"}, write=False), "not found")
        self.refused(await self.call("wv", "get_meeting", {"meeting": secret["id"]}, write=False), "not found")
        self.assertEqual(self.ok(await self.call("owner", "get_meeting", {"meeting": "secret sync"}, write=False))["id"],
                         secret["id"])
        self.refused(await self.call("stranger", "get_meeting", {"meeting": "Sourcing standup"}, write=False), "not found")
        # Ids still work.
        self.assertEqual(self.ok(await self.call("wm", "get_meeting", {"meeting": old["id"]}, write=False))["id"], old["id"])

    # ── list_team ─────────────────────────────────────────────────────────────

    async def test_list_team_for_a_team(self):
        await self.turn_on()
        sc = self.ok(await self.call("wm", "list_team", {"workspace": self.W}, write=False))
        self.assertGreaterEqual(len(sc["people"]), 5)
        self.assertNotIn("team", sc)
        res = await self.call("wm", "list_team", {"workspace": self.W, "space": f"team:{self.eng}"}, write=False)
        sc = self.ok(res)
        self.assertEqual({p["id"]: p["lead"] for p in sc["people"]}, {self.uid["wv"]: True, self.uid["ownv"]: False})
        self.assertEqual(sc["team"]["name"], "Eng")
        self.assertIn("(lead)", res["content"][0]["text"])
        sc = self.ok(await self.call("wa", "list_team", {"workspace": self.W, "space": f"team:{self.sales}"}, write=False))
        self.assertEqual({p["id"]: p["lead"] for p in sc["people"]}, {self.uid["owner"]: True, self.uid["wm"]: False})
        self.refused(await self.call("wv", "list_team", {"workspace": self.W, "space": f"team:{self.sales}"}, write=False),
                     "No team")
        # company / all: everyone, as before.
        sc = self.ok(await self.call("wv", "list_team", {"workspace": self.W, "space": "company"}, write=False))
        self.assertGreaterEqual(len(sc["people"]), 5)
