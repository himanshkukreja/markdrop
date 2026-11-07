"""Admin → AI → Workspaces: AI cost per workspace (routers/admin_ai_workspaces.py), and the requests
CSV filtered to one workspace. No model calls, no backend/.env.
"""

from __future__ import annotations

import csv
import io
import secrets
import unittest
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from tests import _email_env as env  # noqa: F401  (pins settings first)

import httpx
from bson import ObjectId

from app import database
from app.config import get_settings
from app.limiter import limiter
from app.main import app
from app.routers import admin_ai_workspaces as aw
from app.services import ai_log, ai_usage
from app.utils.auth import create_access_token
from tests._admin_session import admin_headers

settings = get_settings()
API = "https://api.markdrop.in"
BASE = "/api/v1/admin/ai/usage"
_SAVED = ("mongodb_db", "anthropic_api_key", "workspace_memory_daily_usd", "workspace_memory_monthly_usd",
          "workspace_memory_enabled", "pages_ai_daily_usd", "pages_ai_monthly_usd", "ai_daily_usd", "ai_monthly_usd")


def usage(inp=1000, out=100):
    return {"input": inp, "output": out, "cache_read": 0, "cache_write_5m": 0, "cache_write_1h": 0}


class AdminAiWorkspaces(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.saved = {k: getattr(settings, k) for k in _SAVED}
        self.db_name = f"markdrop_test_admin_ai_ws_{secrets.token_hex(4)}"
        if env.MONGO:
            from motor.motor_asyncio import AsyncIOMotorClient

            self.client = AsyncIOMotorClient(env.MONGO_URI)
        else:
            from mongomock_motor import AsyncMongoMockClient

            self.client = AsyncMongoMockClient()
        self.db = self.client[self.db_name]
        self._saved_client = database._client
        database._client = self.client
        settings.mongodb_db = self.db_name
        settings.anthropic_api_key = "sk-test-not-a-real-key"
        settings.workspace_memory_enabled = True
        settings.workspace_memory_daily_usd, settings.workspace_memory_monthly_usd = 3.0, 30.0
        settings.pages_ai_daily_usd, settings.pages_ai_monthly_usd = 5.0, 50.0
        settings.ai_daily_usd = settings.ai_monthly_usd = None
        await ai_usage.ensure_indexes(self.db)
        ai_usage.invalidate_settings()
        ai_log.invalidate()
        limiter.reset()
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=API)
        self.h = await admin_headers(self.db)
        self.now = datetime.now(timezone.utc)
        self.uid = {}
        for who in ("ana", "bo", "cy"):
            res = await self.db["users"].insert_one({"email": f"{who}@acme.io", "name": who.capitalize(),
                                                     "created_at": self.now})
            self.uid[who] = str(res.inserted_id)
        self.w1 = await self.workspace("Acme", "ana", ["bo", "cy"])
        self.w2 = await self.workspace("=Beta", "bo", [])

    async def asyncTearDown(self):
        await self.http.aclose()
        for k, v in self.saved.items():
            setattr(settings, k, v)
        database._client = self._saved_client
        ai_usage.invalidate_settings()
        ai_log.invalidate()
        if env.MONGO:
            await self.client.drop_database(self.db_name)
            self.client.close()

    async def workspace(self, name, owner, members):
        res = await self.db["workspaces"].insert_one({"name": name, "owner_id": self.uid[owner], "created_at": self.now,
                                                      "updated_at": self.now, "settings": {"team_memory": True}})
        wid = str(res.inserted_id)
        for who, role in [(owner, "owner"), *((m, "member") for m in members)]:
            await self.db["memberships"].insert_one({"workspace_id": wid, "user_id": self.uid[who], "role": role})
        return wid

    async def row(self, feature, cost, *, ws=None, who=None, actor="user", test=False, ago=timedelta(minutes=1),
                  job=None, app_name=None, **extra):
        """One ledger row as ai_usage.record writes it (actor_kind kept when a call is test traffic)."""
        doc = {"feature": feature, "request_id": secrets.token_hex(16), "ts": self.now - ago, "cost_usd": cost,
               "usage": usage(), "outcome": "ok", "user_id": self.uid.get(who) if who else None,
               "actor": "test" if test else actor, "actor_kind": actor, "test": test, **extra}
        if ws is not None:
            doc["workspace_id"] = ws
        if job:
            doc["job"] = job
        if app_name:
            doc["app"] = app_name
        await self.db[ai_usage.REQUESTS].insert_one(doc)

    async def seed(self):
        await self.row("pages_ai", 0.10, ws=self.w1, who="ana")
        await self.row("pages_ai", 0.05, ws=self.w1, who="ana", actor="api", app_name="Claude")
        await self.row("meetings_ai", 0.20, ws=self.w1, who="bo")
        # A background job, recorded the way Team memory records it: attributed to its workspace.
        m = ai_usage.Meter("claude-haiku-5-5")
        m.add({"input_tokens": 2000, "output_tokens": 300})
        m.cost_usd = 0.30
        await ai_usage.record(self.db, feature="workspace_memory", meter=m, request_id=secrets.token_hex(16),
                              outcome="ok", job="Team memory", ts=self.now - timedelta(minutes=1),
                              meta={"via": "background", "kind": "extract", "workspace_id": self.w1})
        await self.row("ask_suggestions", 0.01, ws=self.w1, actor="system", job="Ask suggestions",
                       ago=timedelta(days=2))
        await self.row("pages_ai", 1.00, ws=self.w1, who="cy", test=True)            # test traffic
        await self.row("search_ai", 0.40, ws=self.w2, who="bo")
        await self.row("docs_ask", 0.07, actor="public")                             # no workspace_id at all
        await self.row("pages_ai", 0.03, ws="", who="ana")                           # an empty workspace_id
        await self.row("pages_ai", 2.00, ws=self.w1, who="ana", ago=timedelta(days=60))   # outside 30 days

    async def get(self, path, expect=200, **params):
        r = await self.http.get(BASE + path, headers=self.h, params=params)
        self.assertEqual(r.status_code, expect, r.text)
        return r.json() if r.headers.get("content-type", "").startswith("application/json") else r

    # ── auth ──

    async def test_admins_only(self):
        token, _ = create_access_token(self.uid["ana"], "ana@acme.io")
        for path in ("/workspaces", f"/workspaces/{self.w1}", "/workspaces/none", "/workspaces.csv"):
            for h, status in (({}, 401), ({"Authorization": f"Bearer {token}"}, 404)):
                r = await self.http.get(BASE + path, headers=h)
                self.assertEqual(r.status_code, status, (path, h))

    # ── the list ──

    async def test_list_attributes_cost_and_splits_by_actor(self):
        await self.seed()
        res = await self.get("/workspaces", range="30d")
        self.assertEqual(res["audience"], "live")
        items = {r["workspace_id"]: r for r in res["items"]}
        self.assertEqual([r["workspace_id"] for r in res["items"]], [self.w1, self.w2, "none"])  # by cost
        a = items[self.w1]
        self.assertEqual((a["name"], a["members"], a["owner"]["email"], a["none"]), ("Acme", 3, "ana@acme.io", False))
        self.assertAlmostEqual(a["cost_usd"], 0.66, places=6)
        self.assertEqual(a["requests"], 5)
        self.assertAlmostEqual(a["by_actor"]["people"]["cost_usd"], 0.30, places=6)
        self.assertAlmostEqual(a["by_actor"]["apps"]["cost_usd"], 0.05, places=6)
        self.assertAlmostEqual(a["by_actor"]["system"]["cost_usd"], 0.31, places=6)   # Team memory + suggestions
        self.assertEqual(a["by_actor"]["system"]["requests"], 2)
        self.assertEqual(a["by_actor"]["public"]["requests"], 0)
        self.assertEqual(a["test"]["requests"], 0)
        self.assertEqual([f["key"] for f in a["features"]], ["workspace_memory", "meetings_ai", "pages_ai", "ask_suggestions"])
        self.assertAlmostEqual(a["features"][2]["cost_usd"], 0.15, places=6)
        self.assertEqual(a["people"], 2)
        self.assertEqual([(u["email"], u["cost_usd"]) for u in a["top_users"]], [("bo@acme.io", 0.2), ("ana@acme.io", 0.15)])
        self.assertEqual(len(a["spark"]), len(res["days"]))
        self.assertAlmostEqual(sum(a["spark"]), 0.66, places=6)
        self.assertEqual((a["tokens_in"], a["tokens_out"]), (6000, 700))
        # The No workspace row: a missing and an empty workspace_id alike.
        n = items["none"]
        self.assertEqual((n["name"], n["none"], n["members"], n["owner"]), ("No workspace", True, None, None))
        self.assertAlmostEqual(n["cost_usd"], 0.10, places=6)
        self.assertAlmostEqual(n["by_actor"]["public"]["cost_usd"], 0.07, places=6)
        self.assertAlmostEqual(n["by_actor"]["people"]["cost_usd"], 0.03, places=6)
        t = res["totals"]
        self.assertAlmostEqual(t["cost_usd"], 1.16, places=6)
        self.assertEqual((t["workspaces"], t["requests"]), (2, 8))
        self.assertAlmostEqual(t["no_workspace_usd"], 0.10, places=6)
        # The filter left the test call out, and says so.
        self.assertEqual((res["left_out"]["calls"], res["left_out"]["test"]), (1, 1))
        self.assertAlmostEqual(res["left_out"]["cost_usd"], 1.0, places=6)

    async def test_audience_filters(self):
        await self.seed()
        res = await self.get("/workspaces", audience="all")
        a = {r["workspace_id"]: r for r in res["items"]}[self.w1]
        self.assertAlmostEqual(a["cost_usd"], 1.66, places=6)
        self.assertAlmostEqual(a["test"]["cost_usd"], 1.0, places=6)
        self.assertAlmostEqual(a["by_actor"]["people"]["cost_usd"], 1.30, places=6)   # a test call keeps its actor
        self.assertEqual(res["left_out"]["calls"], 0)
        res = await self.get("/workspaces", audience="system")
        self.assertEqual([r["workspace_id"] for r in res["items"]], [self.w1])
        self.assertAlmostEqual(res["items"][0]["cost_usd"], 0.31, places=6)
        res = await self.get("/workspaces", audience="real")
        self.assertAlmostEqual({r["workspace_id"]: r for r in res["items"]}[self.w1]["cost_usd"], 0.35, places=6)
        res = await self.get("/workspaces", audience="public")
        self.assertEqual([r["workspace_id"] for r in res["items"]], ["none"])
        res = await self.get("/workspaces", range="24h")
        self.assertAlmostEqual({r["workspace_id"]: r for r in res["items"]}[self.w1]["cost_usd"], 0.65, places=6)

    async def test_sort_search_and_pages(self):
        await self.seed()
        res = await self.get("/workspaces", sort="name", order="asc")
        self.assertEqual([r["name"] for r in res["items"]], ["=Beta", "Acme", "No workspace"])
        res = await self.get("/workspaces", sort="cost", order="asc")
        self.assertEqual(res["items"][0]["workspace_id"], "none")
        res = await self.get("/workspaces", sort="members", order="desc")
        self.assertEqual(res["items"][0]["workspace_id"], self.w1)
        self.assertEqual([r["workspace_id"] for r in (await self.get("/workspaces", q="beta"))["items"]], [self.w2])
        self.assertEqual([r["workspace_id"] for r in (await self.get("/workspaces", q="ana@acme"))["items"]], [self.w1])
        res = await self.get("/workspaces", limit=2, page=2)
        self.assertEqual((res["total"], res["pages"], len(res["items"])), (3, 2, 1))

    async def test_caps_show_the_workspace_share_of_each_feature_cap(self):
        await self.seed()
        a = {r["workspace_id"]: r for r in (await self.get("/workspaces"))["items"]}[self.w1]
        caps = {c["feature"]: c for c in a["caps"]}
        wm = caps["workspace_memory"]
        self.assertEqual((wm["daily_cap_usd"], wm["monthly_cap_usd"]), (3.0, 30.0))
        self.assertAlmostEqual(wm["today_usd"], 0.30, places=6)
        self.assertEqual((wm["today_pct"], wm["month_pct"]), (10.0, 1.0))
        self.assertAlmostEqual(wm["feature_today_usd"], 0.30, places=6)   # the spend counter the cap reads
        # Caps count every call, test traffic included, whatever the filter shows.
        self.assertAlmostEqual(caps["pages_ai"]["today_usd"], 1.15, places=6)
        self.assertNotIn("*", caps)
        settings.ai_daily_usd, settings.ai_monthly_usd = 10.0, 100.0
        ai_usage.invalidate_settings()
        a = {r["workspace_id"]: r for r in (await self.get("/workspaces"))["items"]}[self.w1]
        allc = {c["feature"]: c for c in a["caps"]}["*"]
        self.assertEqual((allc["label"], allc["daily_cap_usd"]), ("All AI features", 10.0))
        self.assertGreaterEqual(allc["today_usd"], 1.65 - 1e-6)

    def test_local_days_from_half_hour_buckets(self):
        ist = ZoneInfo("Asia/Kolkata")
        self.assertEqual(aw._bucket_day({"h": "2026-11-01T18", "m": True}, ist), "2026-11-02")    # 00:00 IST
        self.assertEqual(aw._bucket_day({"h": "2026-11-01T18", "m": False}, ist), "2026-11-01")   # 23:30 IST
        self.assertEqual(aw._bucket_day({"h": "2026-11-01T23", "m": True}, ZoneInfo("UTC")), "2026-11-01")
        self.assertIsNone(aw._bucket_day({}, ist))

    # ── one workspace ──

    async def test_detail(self):
        await self.seed()
        d = await self.get(f"/workspaces/{self.w1}", tz="Asia/Kolkata")
        self.assertEqual((d["workspace"]["name"], d["workspace"]["members"]), ("Acme", 3))
        self.assertEqual(d["workspace"]["switches"], {"page_ai": True, "team_memory": True})
        self.assertAlmostEqual(d["kpis"]["cost_usd"], 0.66, places=6)
        self.assertEqual(d["kpis"]["people"], 2)
        users = d["users"]
        self.assertEqual([(u["email"], u["role"]) for u in users], [("bo@acme.io", "member"), ("ana@acme.io", "owner")])
        self.assertAlmostEqual(users[1]["apps"]["cost_usd"], 0.05, places=6)
        self.assertEqual(users[1]["features"], ["pages_ai"])
        self.assertEqual([(j["job"], j["feature"]) for j in d["jobs"]],
                         [("Team memory", "workspace_memory"), ("Ask suggestions", "ask_suggestions")])
        self.assertEqual(d["by_feature"][0]["key"], "workspace_memory")
        self.assertAlmostEqual(d["by_feature"][0]["share_pct"], 45.5, places=1)
        self.assertEqual(d["public"]["requests"], 0)
        self.assertEqual(sum(s["requests"] for s in d["series"]), 5)
        self.assertAlmostEqual(sum(s["by_feature"].get("workspace_memory", 0) for s in d["series"]), 0.30, places=6)
        self.assertAlmostEqual(sum(s["cost_usd"] for s in d["series"]), 0.66, places=6)
        self.assertEqual([f["key"] for f in d["features"]], ["pages_ai", "meetings_ai", "ask_suggestions", "workspace_memory"])
        self.assertLessEqual({"workspace_memory", "pages_ai", "meetings_ai"}, {c["feature"] for c in d["caps"]})
        self.assertEqual((d["left_out"]["calls"], d["left_out"]["test"]), (1, 1))
        # Everything, test traffic included.
        d = await self.get(f"/workspaces/{self.w1}", audience="all")
        self.assertAlmostEqual(d["test"]["cost_usd"], 1.0, places=6)
        self.assertEqual(d["users"][0]["email"], "cy@acme.io")

    async def test_detail_no_workspace_and_unknown(self):
        await self.seed()
        d = await self.get("/workspaces/none")
        self.assertEqual((d["workspace"]["name"], d["workspace"]["none"]), ("No workspace", True))
        self.assertAlmostEqual(d["kpis"]["cost_usd"], 0.10, places=6)
        self.assertAlmostEqual(d["public"]["cost_usd"], 0.07, places=6)
        self.assertEqual([u["email"] for u in d["users"]], ["ana@acme.io"])
        self.assertIsNone(d["users"][0]["role"])
        await self.get(f"/workspaces/{ObjectId()}", expect=404)
        await self.get("/workspaces/not-an-id", expect=404)
        # A workspace with no AI use is still a page (zeros), not a 404.
        d = await self.get(f"/workspaces/{self.w2}", range="24h", audience="system")
        self.assertEqual(d["kpis"]["requests"], 0)

    # ── exports ──

    async def test_csv(self):
        await self.seed()
        r = await self.get("/workspaces.csv")
        self.assertIn("markdrop-ai-workspaces-30d.csv", r.headers["content-disposition"])
        rows = list(csv.DictReader(io.StringIO(r.text)))
        self.assertEqual([x["workspace_id"] for x in rows], [self.w1, self.w2, "none"])
        self.assertEqual(rows[1]["name"], "'=Beta")   # never a formula
        self.assertEqual((rows[0]["system_cost_usd"], rows[0]["workspace_memory_cost_usd"]), ("0.310000", "0.300000"))
        self.assertEqual(rows[0]["top_user_email"], "bo@acme.io")
        r = await self.http.get("/api/v1/admin/ai/usage/export.csv", headers=self.h,
                                params={"kind": "requests", "workspace": self.w1, "audience": "all"})
        rows = list(csv.DictReader(io.StringIO(r.text)))
        self.assertEqual(len(rows), 6)
        self.assertEqual({x["workspace_id"] for x in rows}, {self.w1})
        self.assertIn("Team memory", {x["job"] for x in rows})
        r = await self.http.get("/api/v1/admin/ai/usage/export.csv", headers=self.h,
                                params={"kind": "requests", "workspace": "none"})
        self.assertEqual(len(list(csv.DictReader(io.StringIO(r.text)))), 2)

    async def test_index(self):
        info = await self.db[ai_usage.REQUESTS].index_information()
        self.assertIn([("workspace_id", 1), ("ts", -1)], [v["key"] for v in info.values()])


if __name__ == "__main__":
    unittest.main()
