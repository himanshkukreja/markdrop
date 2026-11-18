"""The navigation redesign's server side (brief .work/briefs/nav-redesign.md, 2026-11-18): the Meetings section's
"With customers" / "Internal" tabs (``audience`` on GET /meetings and MCP list_meetings), the deal chip on meeting
cards, the sidebar's badges (``to_review`` on the Zoom team, ``deals`` on the HubSpot team), the Zoom review list's
``team_id`` and a team's Files & pages outline without meeting pages (GET /nav?meetings=false).

Run: cd backend && .venv/bin/python -m unittest tests.test_nav_sections -v
"""

from __future__ import annotations

from datetime import datetime, timezone

from bson import ObjectId

from app.services import hubspot_folders as HF
from tests.test_hubspot_deal_folders import DealWorld
from tests.test_meetings_list import ListWorld


class Audience(ListWorld):
    async def test_customers_and_internal_tabs(self):
        member = (await self.db["users"].find_one({"_id": ObjectId(self.uid["wm"])}, {"email": 1}))["email"]
        ids = await self.seed([
            {"title": "Team sync", "attendees": [{"name": "Bo Chen", "user_id": self.uid["wm"], "email": member}]},
            {"title": "Names only", "attendees": [{"name": "Somebody"}]},
            {"title": "Acme call", "attendees": [{"name": "Bo Chen", "email": member}, {"name": "Grace", "email": "grace@acme.io"}]},
            {"title": "Customer type", "type": "Customer", "attendees": []},
            {"title": "Matched", "hubspot": {"match": {"portal_id": "1", "deal_id": "42", "how": "contacts"}}},
        ])
        cust = await self.page("wm", audience="customers")
        self.assertEqual({m["id"] for m in cust["meetings"]}, {ids[2], ids[3], ids[4]})
        self.assertEqual(cust["total"], 3)
        internal = await self.page("wm", audience="internal")
        self.assertEqual({m["id"] for m in internal["meetings"]}, {ids[0], ids[1]})
        r = await self.http.get("/api/v1/meetings", headers=self.session("wm"), params={"workspace": self.W, "audience": "vip"})
        self.assertEqual(r.status_code, 422)
        # MCP: the same filter.
        from app.mcp import meeting_tools

        self.assertIn("audience", next(t for t in meeting_tools.MEETING_TOOLS if t.name == "list_meetings").input_schema["properties"])

    async def test_meeting_pages_leave_the_files_outline(self):
        [mid] = await self.seed([{"title": "A call"}])
        row = await self.db["meetings"].find_one({"_id": ObjectId(mid)})
        page = await self.db["documents"].find_one({"_id": ObjectId(row["doc_id"])})
        r = await self.http.get(f"/api/v1/workspaces/{self.W}/nav", headers=self.session("wm"))
        self.assertIn(page["slug"], {i["slug"] for i in r.json()["items"]})
        r = await self.http.get(f"/api/v1/workspaces/{self.W}/nav", headers=self.session("wm"), params={"meetings": "false"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn(page["slug"], {i["slug"] for i in r.json()["items"]})


class Badges(DealWorld):
    async def test_deal_chip_counts_and_review_team(self):
        w = self.world()
        await self.sync()
        mid = await self.ready_call()
        # The card's deal chip: the HubSpot team's members and admins; nobody else gets one.
        r = await self.http.get("/api/v1/meetings", headers=self.session("wm"), params={"workspace": self.W})
        card = next(m for m in r.json()["meetings"] if m["id"] == mid)
        self.assertEqual(card["deal"], {"id": w["deal"], "name": "Acme annual", "company": "Acme Corp",
                                        "href": f"/deals/{self.W}/{w['deal']}"})
        self.assertFalse(card["deal_pick"])
        r = await self.http.get("/api/v1/meetings", headers=self.session("wm"), params={"workspace": self.W, "audience": "customers"})
        self.assertIn(mid, {m["id"] for m in r.json()["meetings"]})
        # The team's series chips and total count only its meetings (the list agrees).
        sp = f"team:{self.sales}"
        r = await self.http.get("/api/v1/meetings/series", headers=self.session("wm"), params={"workspace": self.W, "space": sp})
        self.assertEqual(r.status_code, 200, r.text)
        listed = await self.http.get("/api/v1/meetings", headers=self.session("wm"), params={"workspace": self.W, "space": sp})
        self.assertEqual(r.json()["total"], listed.json()["total"])
        self.assertGreaterEqual(r.json()["total"], 1)
        # The sidebar: open deals on the HubSpot team; your held Zoom meetings on the Zoom team (none yet).
        open_deals = await self.db[HF.DEALS].count_documents({"workspace_id": self.W, "closed": {"$ne": True}})
        self.assertGreater(open_deals, 0)
        r = await self.http.get(f"/api/v1/workspaces/{self.W}/teams", headers=self.session("wm"))
        cards = {t["id"]: t for t in r.json()["teams"]}
        self.assertEqual(cards[self.sales]["deals"], open_deals)
        self.assertNotIn("to_review", cards[self.sales])
        self.assertFalse(any("deals" in t for tid, t in cards.items() if tid != self.sales))
        await self.db["zoom_meetings"].insert_one({
            "_id": f"{self.W}:held-1", "workspace_id": self.W, "uuid": "held-1", "state": "held", "topic": "Pricing",
            "host": {"id": self.uid["wm"], "name": "Bo Chen"}, "reason": "internal_only",
            "held_at": datetime.now(timezone.utc)})
        r = await self.http.get(f"/api/v1/workspaces/{self.W}/teams", headers=self.session("wm"))
        self.assertEqual({t["id"]: t for t in r.json()["teams"]}[self.sales]["to_review"], 1)
        r = await self.http.get(f"/api/v1/workspaces/{self.W}/teams", headers=self.session("wa"))
        self.assertNotIn("to_review", {t["id"]: t for t in r.json()["teams"]}.get(self.sales, {}))
        # The review list names the Zoom team (the Meetings section's To review tab).
        r = await self.http.get("/api/v1/zoom/review", headers=self.session("wm"), params={"workspace_id": self.W})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([(m["uuid"], m["team_id"]) for m in r.json()["meetings"]], [("held-1", self.sales)])
