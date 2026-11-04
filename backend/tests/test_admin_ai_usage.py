"""Admin → AI: usage per person across every AI feature, exports, and the budgets editor
(routers/admin_ai.py, the /usage/* and /budgets endpoints). No model calls, no backend/.env.
"""

from __future__ import annotations

import csv
import io
import secrets
import unittest
from datetime import datetime, timedelta, timezone

from tests import _email_env as env  # noqa: F401  (pins settings first)

import httpx
from bson import ObjectId

from app import database
from app.config import get_settings
from app.limiter import limiter
from app.main import app
from app.routers.admin import _make_token
from app.services import ai_usage
from app.utils.auth import create_access_token

settings = get_settings()
API = "https://api.markdrop.in"
BASE = "/api/v1/admin/ai"
SECRET_Q = "what is the secret-question-4411"
SECRET_A = "the secret-answer-9921"
_SAVED = ("mongodb_db", "docs_ai_enabled", "docs_ai_daily_usd", "docs_ai_monthly_usd", "docs_editor_ai_enabled",
          "docs_editor_ai_daily_usd", "docs_editor_ai_monthly_usd", "pages_ai_enabled", "pages_ai_daily_usd",
          "pages_ai_monthly_usd", "ai_daily_usd", "ai_monthly_usd", "ai_burst_per_minute", "ai_burst_per_day",
          "ai_user_daily_usd", "anthropic_api_key")


def meter(inp=1000, out=100, read=0, cost=None):
    m = ai_usage.Meter("claude-haiku-5-5")
    m.add({"input_tokens": inp, "output_tokens": out, "cache_read_input_tokens": read,
           "cache_creation_input_tokens": 0})
    if cost is not None:
        m.cost_usd = cost
    return m


class AdminAiUsage(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.saved = {k: getattr(settings, k) for k in _SAVED}
        self.db_name = f"markdrop_test_admin_ai_{secrets.token_hex(4)}"
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
        settings.docs_ai_enabled = settings.docs_editor_ai_enabled = settings.pages_ai_enabled = True
        settings.docs_ai_daily_usd, settings.docs_ai_monthly_usd = 5.0, 50.0
        settings.docs_editor_ai_daily_usd, settings.docs_editor_ai_monthly_usd = 2.0, 20.0
        settings.pages_ai_daily_usd, settings.pages_ai_monthly_usd = 5.0, 50.0
        settings.ai_daily_usd = settings.ai_monthly_usd = settings.ai_user_daily_usd = None
        settings.ai_burst_per_minute, settings.ai_burst_per_day = 30, 300
        await ai_usage.ensure_indexes(self.db)
        ai_usage.invalidate_settings()
        ai_usage._recent.clear()
        limiter.reset()
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=API)
        token, _ = _make_token()
        self.h = {"Authorization": f"Bearer {token}"}
        self.uid = {}
        for who, name in (("ana", "Ana Admin"), ("bo", "=HYPERLINK(\"x\")"), ("cy", "Cy Quiet")):
            res = await self.db["users"].insert_one({"email": f"{who}@example.com", "name": name,
                                                     "created_at": datetime.now(timezone.utc)})
            self.uid[who] = str(res.inserted_id)

    async def asyncTearDown(self):
        await self.http.aclose()
        for k, v in self.saved.items():
            setattr(settings, k, v)
        database._client = self._saved_client
        ai_usage.invalidate_settings()
        ai_usage._recent.clear()
        if env.MONGO:
            await self.client.drop_database(self.db_name)
            self.client.close()

    async def rec(self, feature, who=None, outcome="ok", ago=timedelta(minutes=5), m=None, **meta):
        await ai_usage.record(self.db, feature=feature, meter=m or meter(), request_id=secrets.token_hex(16),
                              outcome=outcome, latency_ms=800, user_id=self.uid.get(who) if who else None,
                              visitor=f"u:{self.uid[who]}" if who else f"ip:{secrets.token_hex(4)}",
                              ts=datetime.now(timezone.utc) - ago, meta=meta)

    async def seed(self):
        await self.rec("docs_ask", "ana", outcome="answered", site="markdrop", action="ask", question=SECRET_Q,
                       answer=SECRET_A, conversation_id="conv12345678", m=meter(2000, 300, read=6000))
        await self.rec("docs_editor", "ana", action="improve", site="s1", page_id="p1")
        await self.rec("pages_ai", "ana", action="summary", slug="team-notes", workspace_id="w1",
                       m=meter(cost=0.25))
        await self.rec("pages_ai", "bo", action="ask", slug="team-notes", ago=timedelta(days=2))
        await self.rec("pages_ai", "bo", outcome="limit", limit_reason="burst", action="ask", slug="team-notes",
                       m=meter(0, 0))
        await self.rec("docs_ask", None, outcome="answered", question=SECRET_Q, answer=SECRET_A)
        await self.rec("docs_ask", None, outcome="error", error_code="upstream_500")
        await self.rec("docs_ask", "cy", ago=timedelta(days=60))  # outside 30d

    async def get(self, path, expect=200, **params):
        r = await self.http.get(BASE + path, headers=self.h, params=params)
        self.assertEqual(r.status_code, expect, r.text)
        return r.json() if r.headers.get("content-type", "").startswith("application/json") else r

    async def put(self, path, body, expect=200):
        r = await self.http.put(BASE + path, headers=self.h, json=body)
        self.assertEqual(r.status_code, expect, r.text)
        return r.json()

    # ── auth ──

    async def test_every_endpoint_needs_the_admin_token(self):
        user_token, _ = create_access_token(self.uid["ana"], "ana@example.com")
        calls = [("GET", "/usage/overview"), ("GET", "/usage/users"), ("GET", f"/usage/users/{self.uid['ana']}"),
                 ("GET", "/usage/export.csv"), ("GET", "/budgets"), ("PUT", "/budgets"),
                 ("PUT", f"/users/{self.uid['ana']}"), ("GET", "/budgets/audit")]
        for method, path in calls:
            for h in ({}, {"Authorization": f"Bearer {user_token}"}):
                r = await self.http.request(method, BASE + path, headers=h, json={} if method == "PUT" else None)
                self.assertEqual(r.status_code, 401, (method, path))
        self.assertIsNone(await self.db[ai_usage.SETTINGS].find_one({}))

    # ── overview ──

    async def test_overview_all_features(self):
        await self.seed()
        ov = await self.get("/usage/overview", range="30d", tz="Asia/Kolkata")
        keys = [f["key"] for f in ov["features"]]
        self.assertEqual(keys[:3], ["docs_ask", "docs_editor", "pages_ai"])
        f = {x["key"]: x for x in ov["features"]}
        self.assertEqual((f["docs_ask"]["requests"], f["docs_ask"]["errors"]), (3, 1))
        self.assertEqual((f["pages_ai"]["requests"], f["pages_ai"]["limited"], f["pages_ai"]["users"]), (3, 1, 2))
        self.assertEqual((f["pages_ai"]["daily_cap_usd"], f["pages_ai"]["monthly_cap_usd"]), (5.0, 50.0))
        self.assertEqual(f["pages_ai"]["label"], "Pages AI")
        self.assertTrue(f["pages_ai"]["enabled"])
        self.assertAlmostEqual(f["pages_ai"]["today_usd"], 0.25, places=6)  # bo's was 2 days ago
        self.assertGreater(f["docs_ask"]["cache_hit_pct"], 0)
        self.assertEqual((ov["global"]["daily_cap_usd"], ov["global"]["monthly_cap_usd"]), (None, None))
        k = ov["kpis"]
        self.assertEqual((k["requests"], k["users"], k["anonymous_requests"], k["limited"]), (7, 2, 2, 1))
        self.assertEqual(len(ov["series"]), 31)
        self.assertEqual(sum(d["requests"] for d in ov["series"]), 7)
        self.assertAlmostEqual(sum(d["by_feature"]["pages_ai"] for d in ov["series"]), f["pages_ai"]["cost_usd"],
                               places=5)
        self.assertEqual(ov["limit_reasons"], [{"feature": "pages_ai", "reason": "burst", "n": 1}])
        self.assertNotIn("secret", repr(ov))
        # Admin overrides show at once.
        await self.put("/budgets", {"caps": {"*": {"daily_usd": 3, "monthly_usd": 30}}, "enabled": {"pages_ai": False}})
        ov = await self.get("/usage/overview")
        self.assertEqual((ov["global"]["daily_cap_usd"], ov["global"]["monthly_cap_usd"]), (3.0, 30.0))
        self.assertFalse({x["key"]: x for x in ov["features"]}["pages_ai"]["enabled"])

    async def test_overview_empty(self):
        ov = await self.get("/usage/overview", range="7d")
        self.assertEqual(ov["kpis"]["requests"], 0)
        self.assertEqual(len(ov["features"]), len(ai_usage.FEATURES))
        self.assertIsNone(ov["kpis"]["cache_hit_pct"])

    # ── users ──

    async def test_users_table(self):
        await self.seed()
        res = await self.get("/usage/users")
        items = {r["user_id"]: r for r in res["items"]}
        self.assertEqual(set(items), {self.uid["ana"], self.uid["bo"], "anonymous"})  # cy is outside 30d
        ana = items[self.uid["ana"]]
        self.assertEqual((ana["email"], ana["name"], ana["requests"]), ("ana@example.com", "Ana Admin", 3))
        self.assertEqual(set(ana["features"]), {"docs_ask", "docs_editor", "pages_ai"})
        self.assertEqual(ana["tokens"]["cache_read"], 6000)
        self.assertFalse(ana["blocked"])
        self.assertAlmostEqual(ana["today_usd"], ana["cost_usd"], places=6)
        anon = items["anonymous"]
        self.assertEqual((anon["name"], anon["requests"], anon["visitors"], anon["errors"]),
                         ("Anonymous visitors", 2, 2, 1))
        self.assertEqual(res["items"][0]["user_id"], self.uid["ana"])  # most expensive first
        self.assertNotIn("secret", repr(res))
        # Sort, search, feature, pages.
        res = await self.get("/usage/users", sort="requests", order="asc")
        self.assertEqual(res["items"][0]["requests"], 2)
        res = await self.get("/usage/users", q="ANA@")
        self.assertEqual([r["user_id"] for r in res["items"]], [self.uid["ana"]])
        res = await self.get("/usage/users", feature="pages_ai")
        self.assertEqual({r["user_id"] for r in res["items"]}, {self.uid["ana"], self.uid["bo"]})
        res = await self.get("/usage/users", limit=1, page=2, sort="email", order="asc")
        self.assertEqual((res["total"], res["pages"], len(res["items"])), (3, 3, 1))
        res = await self.get("/usage/users", range="90d")
        self.assertIn(self.uid["cy"], {r["user_id"] for r in res["items"]})

    async def test_blocked_people_stay_listed(self):
        await self.put(f"/users/{self.uid['cy']}", {"blocked": True})
        res = await self.get("/usage/users", range="7d")
        cy = next(r for r in res["items"] if r["user_id"] == self.uid["cy"])
        self.assertEqual((cy["blocked"], cy["requests"], cy["email"]), (True, 0, "cy@example.com"))

    async def test_user_detail_never_has_content(self):
        await self.seed()
        d = await self.get(f"/usage/users/{self.uid['ana']}", tz="UTC")
        self.assertEqual(d["user"]["email"], "ana@example.com")
        self.assertEqual([f["key"] for f in d["by_feature"]], ["docs_ask", "docs_editor", "pages_ai"])
        self.assertEqual(d["kpis"]["requests"], 3)
        self.assertEqual(len(d["recent"]), 3)
        pages = next(r for r in d["recent"] if r["feature"] == "pages_ai")
        self.assertEqual((pages["action"], pages["slug"], pages["workspace_id"], pages["outcome"]),
                         ("summary", "team-notes", "w1", "ok"))
        self.assertEqual(pages["cost_usd"], 0.25)
        ask = next(r for r in d["recent"] if r["feature"] == "docs_ask")
        self.assertEqual((ask["conversation_id"], ask["site"], ask["action"]), ("conv12345678", "markdrop", "ask"))
        self.assertEqual(d["settings"]["blocked"], False)
        self.assertEqual(d["settings"]["burst"], {"per_minute": 30, "per_day": 300})
        self.assertGreater(d["settings"]["today_usd"], 0.25)
        self.assertNotIn("secret", repr(d))
        self.assertEqual(sum(x["requests"] for x in d["by_action"]), 3)
        anon = await self.get("/usage/users/anonymous")
        self.assertEqual((anon["user"]["name"], anon["kpis"]["requests"], anon["settings"]),
                         ("Anonymous visitors", 2, None))
        self.assertNotIn("secret", repr(anon))
        await self.get("/usage/users/not-an-id", expect=404)
        await self.get(f"/usage/users/{ObjectId()}", expect=404)
        quiet = await self.get(f"/usage/users/{self.uid['cy']}", range="7d")
        self.assertEqual(quiet["kpis"]["requests"], 0)

    # ── export ──

    async def test_csv_exports(self):
        await self.seed()
        r = await self.get("/usage/export.csv", kind="users")
        self.assertIn("text/csv", r.headers["content-type"])
        self.assertIn('filename="markdrop-ai-users-30d.csv"', r.headers["content-disposition"])
        rows = list(csv.DictReader(io.StringIO(r.text)))
        self.assertEqual(len(rows), 3)
        bo = next(x for x in rows if x["email"] == "bo@example.com")
        self.assertEqual(bo["name"], "'=HYPERLINK(\"x\")")  # no formula injection
        r = await self.get("/usage/export.csv", kind="requests", feature="docs_ask")
        rows = list(csv.DictReader(io.StringIO(r.text)))
        self.assertEqual(len(rows), 3)
        self.assertEqual({x["user_id"] for x in rows}, {self.uid["ana"], "anonymous"})
        self.assertNotIn("secret", r.text)
        await self.get("/usage/export.csv", kind="nope", expect=400)

    # ── budgets ──

    async def test_budgets_defaults(self):
        b = await self.get("/budgets")
        caps = {c["key"]: c for c in b["caps"]}
        self.assertEqual(list(caps), ["*", "docs_ask", "docs_editor", "pages_ai", "search_ai", "meetings_ai"])
        # Meetings AI's own caps (owner decision 2026-11-05): $5 a day, $50 a month, editable here.
        self.assertEqual((caps["meetings_ai"]["default_daily_usd"], caps["meetings_ai"]["effective_monthly_usd"]),
                         (5.0, 50.0))
        # AI search's own caps (owner decision 2026-11-04): $2 a day, $20 a month, editable here.
        self.assertEqual((caps["search_ai"]["default_daily_usd"], caps["search_ai"]["effective_monthly_usd"]),
                         (2.0, 20.0))
        self.assertEqual((caps["*"]["effective_daily_usd"], caps["*"]["daily_usd"]), (None, None))
        self.assertEqual((caps["docs_editor"]["default_daily_usd"], caps["docs_editor"]["effective_monthly_usd"]),
                         (2.0, 20.0))
        self.assertTrue(caps["pages_ai"]["enabled"] and caps["pages_ai"]["effective_enabled"])
        self.assertEqual(b["burst"]["effective_per_minute"], 30)
        self.assertEqual(b["burst"]["effective_per_day"], 300)
        self.assertIsNone(b["effective_user_daily_usd"])

    async def test_put_budgets_takes_effect_and_is_audited(self):
        await self.rec("pages_ai", "ana", m=meter(cost=0.4))
        b = await self.put("/budgets", {
            "caps": {"*": {"daily_usd": 10, "monthly_usd": 100}, "pages_ai": {"daily_usd": 0.5},
                     "docs_ask": {"daily_usd": None, "monthly_usd": None}},
            "enabled": {"docs_editor": False, "pages_ai": True},
            "burst": {"per_minute": 5, "per_day": 50}, "user_daily_usd": 1.25})
        caps = {c["key"]: c for c in b["caps"]}
        self.assertEqual((caps["pages_ai"]["daily_usd"], caps["pages_ai"]["effective_monthly_usd"]), (0.5, 50.0))
        self.assertAlmostEqual(caps["pages_ai"]["today_usd"], 0.4, places=6)
        self.assertEqual(caps["*"]["effective_daily_usd"], 10.0)
        self.assertFalse(caps["docs_editor"]["effective_enabled"])
        self.assertEqual((b["burst"]["effective_per_minute"], b["effective_user_daily_usd"]), (5, 1.25))
        self.assertEqual(b["updated_by"], settings.admin_username)
        # The contract functions see it immediately.
        self.assertEqual(await ai_usage.caps(self.db, "pages_ai"), (0.5, 50.0))
        self.assertEqual(await ai_usage.caps(self.db, "*"), (10.0, 100.0))
        self.assertFalse(await ai_usage.feature_on(self.db, "docs_editor"))
        self.assertTrue(await ai_usage.feature_on(self.db, "pages_ai"))
        self.assertEqual(await ai_usage.burst_limits(self.db), (5, 50))
        st = await ai_usage.check_budget(self.db, "pages_ai", reserve=0.2)
        self.assertEqual(st.reason, "daily")
        audit = (await self.get("/budgets/audit"))["items"]
        self.assertEqual(len(audit), 1)
        self.assertEqual((audit[0]["admin"], audit[0]["kind"], audit[0]["before"]), (settings.admin_username, "budgets", None))
        self.assertEqual(audit[0]["after"]["caps"]["pages_ai"], {"daily_usd": 0.5})
        # Saving the same again isn't a change; clearing goes back to the defaults.
        await self.put("/budgets", {
            "caps": {"*": {"daily_usd": 10, "monthly_usd": 100}, "pages_ai": {"daily_usd": 0.5}},
            "enabled": {"docs_editor": False}, "burst": {"per_minute": 5, "per_day": 50}, "user_daily_usd": 1.25})
        self.assertEqual(len((await self.get("/budgets/audit"))["items"]), 1)
        b = await self.put("/budgets", {})
        self.assertEqual(await ai_usage.caps(self.db, "pages_ai"), (5.0, 50.0))
        self.assertTrue(await ai_usage.feature_on(self.db, "docs_editor"))
        self.assertIsNone(b["effective_user_daily_usd"])
        audit = (await self.get("/budgets/audit"))["items"]
        self.assertEqual(len(audit), 2)
        self.assertEqual(audit[0]["before"]["caps"]["pages_ai"], {"daily_usd": 0.5})  # newest first

    async def test_put_budgets_validation(self):
        bad = [
            {"caps": {"pages_ai": {"daily_usd": -1}}},
            {"caps": {"pages_ai": {"daily_usd": 10, "monthly_usd": 5}}},
            {"caps": {"pages_ai": {"daily_usd": 60}}},  # above the default monthly cap of 50
            {"caps": {"docs_editor": {"monthly_usd": 1}}},  # below the default daily cap of 2
            {"caps": {"nope": {"daily_usd": 1}}},
            {"enabled": {"nope": False}},
            {"burst": {"per_minute": 0}},
            {"burst": {"per_minute": 50, "per_day": 10}},
            {"burst": {"per_minute": 500}},  # above the default per-day 300
            {"user_daily_usd": -0.01},
            {"caps": {"*": {"daily_usd": 2_000_000}}},
        ]
        for body in bad:
            r = await self.http.put(BASE + "/budgets", headers=self.h, json=body)
            self.assertEqual(r.status_code, 400, body)
        r = await self.http.put(BASE + "/budgets", headers=self.h, json={"caps": {"*": {"daily_usd": "x"}}})
        self.assertEqual(r.status_code, 422)
        self.assertIsNone(await self.db[ai_usage.SETTINGS].find_one({}))
        self.assertEqual(await self.db[ai_usage.SETTINGS_AUDIT].count_documents({}), 0)
        # 0 is a valid cap: no spend at all.
        await self.put("/budgets", {"caps": {"pages_ai": {"daily_usd": 0, "monthly_usd": 0}}})
        self.assertEqual(await ai_usage.caps(self.db, "pages_ai"), (0.0, 0.0))

    async def test_block_and_cap_a_person(self):
        uid = self.uid["bo"]
        r = await self.put(f"/users/{uid}", {"blocked": True})
        self.assertEqual((r["blocked"], r["daily_cap_usd"]), (True, None))
        self.assertEqual(await ai_usage.user_check(self.db, uid, "pages_ai"), "blocked")
        r = await self.put(f"/users/{uid}", {"daily_usd": 0.5})
        self.assertEqual((r["blocked"], r["daily_cap_usd"], r["effective_daily_cap_usd"]), (True, 0.5, 0.5))
        await self.put(f"/users/{uid}", {"blocked": False})
        self.assertIsNone(await ai_usage.user_check(self.db, uid, "pages_ai"))
        await self.rec("pages_ai", "bo", m=meter(cost=0.6))
        self.assertEqual(await ai_usage.user_check(self.db, uid, "pages_ai"), "user_daily")
        d = await self.get(f"/usage/users/{uid}")
        self.assertEqual((d["settings"]["blocked"], d["settings"]["daily_cap_usd"]), (False, 0.5))
        r = await self.put(f"/users/{uid}", {"daily_usd": None})
        self.assertIsNone(r["daily_cap_usd"])
        self.assertIsNone(await self.db[ai_usage.SETTINGS].find_one({"_id": f"user:{uid}"}))  # back to defaults
        self.assertIsNone(await ai_usage.user_check(self.db, uid, "pages_ai"))
        audit = (await self.get("/budgets/audit"))["items"]
        self.assertEqual([a["after"] for a in audit][::-1], [
            {"blocked": True, "daily_usd": None}, {"blocked": True, "daily_usd": 0.5},
            {"blocked": False, "daily_usd": 0.5}, {"blocked": False, "daily_usd": None}])
        self.assertEqual({a["target_label"] for a in audit}, {"bo@example.com"})
        await self.put(f"/users/{ObjectId()}", {"blocked": True}, expect=404)
        await self.put("/users/nope", {"blocked": True}, expect=404)
        await self.put(f"/users/{uid}", {}, expect=400)
        await self.put(f"/users/{uid}", {"daily_usd": -1}, expect=400)


if __name__ == "__main__":
    unittest.main()
