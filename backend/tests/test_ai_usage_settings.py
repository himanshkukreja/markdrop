"""services/ai_usage.py: the FEATURES registry, admin-overridable caps and switches, and the
per-person check (blocked, daily USD cap, burst limit). No model calls, no backend/.env.
"""

from __future__ import annotations

import secrets
import unittest
from datetime import timedelta

from tests import _email_env as env  # noqa: F401  (pins settings first)

from bson import ObjectId

from app.config import get_settings
from app.services import ai_usage

settings = get_settings()
_SAVED = ("docs_ai_enabled", "docs_ai_daily_usd", "docs_ai_monthly_usd", "docs_editor_ai_enabled",
          "docs_editor_ai_daily_usd", "docs_editor_ai_monthly_usd", "pages_ai_enabled", "pages_ai_daily_usd",
          "pages_ai_monthly_usd", "ai_daily_usd", "ai_monthly_usd", "ai_burst_per_minute", "ai_burst_per_day",
          "ai_user_daily_usd")


class AiSettingsCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        if env.MONGO:
            from motor.motor_asyncio import AsyncIOMotorClient

            self.client = AsyncIOMotorClient(env.MONGO_URI)
        else:
            from mongomock_motor import AsyncMongoMockClient

            self.client = AsyncMongoMockClient()
        self.db = self.client[f"markdrop_test_ai_settings_{secrets.token_hex(4)}"]
        await ai_usage.ensure_indexes(self.db)
        self.saved = {k: getattr(settings, k) for k in _SAVED}
        settings.docs_ai_enabled = True
        settings.docs_editor_ai_enabled = True
        settings.pages_ai_enabled = True
        settings.docs_ai_daily_usd, settings.docs_ai_monthly_usd = 5.0, 50.0
        settings.docs_editor_ai_daily_usd, settings.docs_editor_ai_monthly_usd = 2.0, 20.0
        settings.pages_ai_daily_usd, settings.pages_ai_monthly_usd = 5.0, 50.0
        settings.ai_daily_usd = settings.ai_monthly_usd = None
        settings.ai_burst_per_minute, settings.ai_burst_per_day = 30, 300
        settings.ai_user_daily_usd = None
        ai_usage.invalidate_settings()
        ai_usage._reserved.clear()
        ai_usage._recent.clear()
        self.uid = str(ObjectId())

    async def asyncTearDown(self):
        for k, v in self.saved.items():
            setattr(settings, k, v)
        ai_usage.invalidate_settings()
        ai_usage._reserved.clear()
        ai_usage._recent.clear()
        if env.MONGO:
            await self.client.drop_database(self.db.name)

    async def override(self, **fields):
        await self.db[ai_usage.SETTINGS].update_one({"_id": ai_usage.BUDGETS_ID}, {"$set": fields}, upsert=True)
        ai_usage.invalidate_settings()

    async def seed(self, n: int, *, minutes_ago: float = 0.5, cost: float = 0.0, outcome: str = "ok",
                   user_id: str | None = None, feature: str = "docs_editor"):
        ts = ai_usage.now_utc() - timedelta(minutes=minutes_ago)
        await self.db[ai_usage.REQUESTS].insert_many([{
            "request_id": secrets.token_hex(8), "feature": feature, "ts": ts, "user_id": user_id or self.uid,
            "outcome": outcome, "cost_usd": cost} for _ in range(n)])


class Registry(AiSettingsCase):
    async def test_features_cover_every_recorder_and_pages(self):
        from app.services import docs_agent, docs_editor_ai

        self.assertIn(docs_agent.FEATURE, ai_usage.FEATURES)
        self.assertIn(docs_editor_ai.FEATURE, ai_usage.FEATURES)
        self.assertEqual(ai_usage.FEATURES["pages_ai"], "Pages AI")
        for k in ai_usage.FEATURES:
            self.assertIn(k, ai_usage._CONFIG)


class Caps(AiSettingsCase):
    async def test_defaults_come_from_config(self):
        self.assertEqual(await ai_usage.caps(self.db, "docs_ask"), (5.0, 50.0))
        self.assertEqual(await ai_usage.caps(self.db, "docs_editor"), (2.0, 20.0))
        self.assertEqual(await ai_usage.caps(self.db, "pages_ai"), (5.0, 50.0))
        self.assertEqual(await ai_usage.caps(self.db, "*"), (ai_usage.INF, ai_usage.INF))
        self.assertEqual(await ai_usage.caps(self.db, "unknown"), (ai_usage.INF, ai_usage.INF))
        settings.ai_daily_usd, settings.ai_monthly_usd = 10.0, 100.0
        self.assertEqual(await ai_usage.caps(self.db, "*"), (10.0, 100.0))

    async def test_admin_override_wins_per_field(self):
        await self.override(caps={"docs_ask": {"daily_usd": 1.5}, "*": {"daily_usd": 3, "monthly_usd": 30}})
        self.assertEqual(await ai_usage.caps(self.db, "docs_ask"), (1.5, 50.0))
        self.assertEqual(await ai_usage.caps(self.db, "*"), (3.0, 30.0))
        self.assertEqual(await ai_usage.caps(self.db, "docs_editor"), (2.0, 20.0))

    async def test_cache_holds_until_invalidated(self):
        self.assertEqual(await ai_usage.caps(self.db, "docs_ask"), (5.0, 50.0))
        await self.db[ai_usage.SETTINGS].update_one(
            {"_id": ai_usage.BUDGETS_ID}, {"$set": {"caps": {"docs_ask": {"daily_usd": 0.5}}}}, upsert=True)
        self.assertEqual(await ai_usage.caps(self.db, "docs_ask"), (5.0, 50.0))  # cached
        ai_usage.invalidate_settings()
        self.assertEqual(await ai_usage.caps(self.db, "docs_ask"), (0.5, 50.0))

    async def test_cache_expires(self):
        await ai_usage.caps(self.db, "docs_ask")
        await self.db[ai_usage.SETTINGS].update_one(
            {"_id": ai_usage.BUDGETS_ID}, {"$set": {"caps": {"docs_ask": {"daily_usd": 0.5}}}}, upsert=True)
        for k, (_exp, v) in list(ai_usage._cache.items()):
            ai_usage._cache[k] = (0.0, v)
        self.assertEqual(await ai_usage.caps(self.db, "docs_ask"), (0.5, 50.0))

    async def test_check_budget_feature_then_global(self):
        state = await ai_usage.check_budget(self.db, "docs_ask", reserve=0.01)
        self.assertTrue(state.ok)
        meter = ai_usage.Meter("claude-haiku-5-5")
        meter.cost_usd = 1.0
        await ai_usage.record(self.db, feature="docs_editor", meter=meter, request_id="r1", outcome="ok")
        await self.override(caps={"*": {"daily_usd": 1.0}})
        state = await ai_usage.check_budget(self.db, "docs_ask", reserve=0.01)
        self.assertEqual((state.ok, state.reason), (False, "global_daily"))
        await self.override(caps={"*": {"daily_usd": 100.0, "monthly_usd": 1.0}})
        self.assertEqual((await ai_usage.check_budget(self.db, "docs_ask", reserve=0.01)).reason, "global_monthly")
        await self.override(caps={"docs_ask": {"daily_usd": 0}})
        self.assertEqual((await ai_usage.check_budget(self.db, "docs_ask", reserve=0.01)).reason, "daily")

    async def test_hold_request_holds_global_too(self):
        await self.override(caps={"*": {"daily_usd": 0.05}})
        ai_usage.hold_request("pages_ai", 0.04)
        self.assertEqual((await ai_usage.check_budget(self.db, "docs_ask", reserve=0.02)).reason, "global_daily")
        ai_usage.release_request("pages_ai", 0.04)
        self.assertTrue((await ai_usage.check_budget(self.db, "docs_ask", reserve=0.02)).ok)
        self.assertEqual(ai_usage._reserved, {})


class Switches(AiSettingsCase):
    async def test_feature_on(self):
        for f in ai_usage.FEATURES:
            self.assertTrue(await ai_usage.feature_on(self.db, f))
        await self.override(enabled={"pages_ai": False})
        self.assertFalse(await ai_usage.feature_on(self.db, "pages_ai"))
        self.assertTrue(await ai_usage.feature_on(self.db, "docs_ask"))

    async def test_config_kill_switch_wins(self):
        await self.override(enabled={"docs_ask": True})
        settings.docs_ai_enabled = False
        self.assertFalse(await ai_usage.feature_on(self.db, "docs_ask"))
        self.assertFalse(await ai_usage.feature_on(self.db, "docs_editor"))  # off whenever Ask AI is
        settings.docs_ai_enabled = True
        settings.pages_ai_enabled = False
        self.assertFalse(await ai_usage.feature_on(self.db, "pages_ai"))


class UserCheck(AiSettingsCase):
    async def test_anonymous_and_fresh_user_pass(self):
        self.assertIsNone(await ai_usage.user_check(self.db, None, "docs_ask"))
        self.assertIsNone(await ai_usage.user_check(self.db, self.uid, "pages_ai"))

    async def test_blocked(self):
        await self.db[ai_usage.SETTINGS].insert_one({"_id": f"user:{self.uid}", "kind": "user", "blocked": True})
        ai_usage.invalidate_settings()
        self.assertEqual(await ai_usage.user_check(self.db, self.uid, "pages_ai"), "blocked")
        self.assertIsNone(await ai_usage.user_check(self.db, str(ObjectId()), "pages_ai"))

    async def test_user_daily_default_and_override(self):
        await self.seed(2, cost=0.30)
        await self.seed(1, cost=5.0, minutes_ago=60 * 30)  # yesterday: not counted
        self.assertEqual(await ai_usage.user_spend_today(self.db, self.uid), 0.60)
        self.assertIsNone(await ai_usage.user_check(self.db, self.uid, "docs_ask"))  # no cap by default
        settings.ai_user_daily_usd = 0.5
        self.assertEqual(await ai_usage.user_check(self.db, self.uid, "docs_ask"), "user_daily")
        await self.override(user_daily_usd=1.0)
        self.assertIsNone(await ai_usage.user_check(self.db, self.uid, "docs_ask"))
        await self.override(user_daily_usd=None)  # admin: explicitly no default cap
        self.assertIsNone(await ai_usage.user_check(self.db, self.uid, "docs_ask"))
        await self.db[ai_usage.SETTINGS].insert_one({"_id": f"user:{self.uid}", "kind": "user", "daily_usd": 0.6})
        ai_usage.invalidate_settings()
        self.assertEqual(await ai_usage.user_check(self.db, self.uid, "docs_ask"), "user_daily")
        self.assertEqual(await ai_usage.user_daily_cap(self.db, self.uid), 0.6)

    async def test_burst_per_minute_from_the_ledger(self):
        await self.seed(29)
        await self.seed(5, outcome="limit")  # refused requests don't count
        await self.seed(5, minutes_ago=3)    # older than a minute
        self.assertIsNone(await ai_usage.user_check(self.db, self.uid, "docs_ask"))
        await self.seed(1)
        self.assertEqual(await ai_usage.user_check(self.db, self.uid, "docs_ask"), "burst")
        await self.override(burst={"per_minute": 100})
        self.assertIsNone(await ai_usage.user_check(self.db, self.uid, "docs_ask"))

    async def test_burst_per_day(self):
        now = ai_usage.now_utc()
        if now - ai_usage.utc_midnight(now) < timedelta(minutes=10):
            self.skipTest("too close to UTC midnight")
        await self.override(burst={"per_day": 10})
        await self.seed(10, minutes_ago=5)
        self.assertEqual(await ai_usage.user_check(self.db, self.uid, "pages_ai"), "burst")
        settings.ai_burst_per_day = 3  # the override still wins
        await self.override(burst={"per_day": 11})
        self.assertIsNone(await ai_usage.user_check(self.db, self.uid, "pages_ai"))

    async def test_burst_counts_concurrent_checks_in_process(self):
        await self.override(burst={"per_minute": 3})
        for _ in range(3):
            self.assertIsNone(await ai_usage.user_check(self.db, self.uid, "pages_ai"))
        self.assertEqual(await ai_usage.user_check(self.db, self.uid, "pages_ai"), "burst")
        self.assertIsNone(await ai_usage.user_check(self.db, str(ObjectId()), "pages_ai"))

    async def test_burst_is_across_features(self):
        await self.override(burst={"per_minute": 4})
        await self.seed(2, feature="docs_ask")
        await self.seed(2, feature="docs_editor")
        self.assertEqual(await ai_usage.user_check(self.db, self.uid, "pages_ai"), "burst")


if __name__ == "__main__":
    unittest.main()
