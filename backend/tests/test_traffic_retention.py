"""Site traffic retention: the privacy page says raw analytics are kept about
13 months. Every traffic collection, visitors included, carries a 400-day TTL
on a datetime field, so Mongo enforces it rather than a promise."""

from __future__ import annotations

from datetime import datetime

from tests._access_env import AccessWorld

from app.services import traffic


class TrafficRetention(AccessWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await traffic.ensure_indexes(self.db)

    async def ttl(self, coll: str) -> dict[str, int]:
        """field → expireAfterSeconds for the collection's TTL indexes."""
        out: dict[str, int] = {}
        for i in await self.db[coll].list_indexes().to_list(None):
            if i.get("expireAfterSeconds") is not None:
                out[next(iter(i["key"]))] = i["expireAfterSeconds"]
        return out

    async def test_every_collection_expires_after_400_days(self):
        year = 400 * 24 * 3600
        self.assertEqual(traffic.RETENTION_SECONDS, year)
        self.assertEqual(await self.ttl("traffic_pageviews"), {"ts": year})
        self.assertEqual(await self.ttl("traffic_events"), {"ts": year})
        self.assertEqual(await self.ttl("traffic_sessions"), {"started_at": year})
        self.assertEqual(await self.ttl("traffic_visitors"), {"last_seen": year})

    async def test_ensure_indexes_is_idempotent(self):
        await traffic.ensure_indexes(self.db)
        self.assertEqual(await self.ttl("traffic_visitors"), {"last_seen": traffic.RETENTION_SECONDS})

    async def test_visitor_last_seen_is_a_datetime(self):
        """A TTL index only expires documents whose field is a date."""
        body = {"vid": "visitor_0001", "sid": "session_0001", "host": "markdrop.in",
                "events": [{"k": "pv", "p": "/"}]}
        await traffic.ingest(self.db, body, ip=None, user_agent="Mozilla/5.0", user_id=None)
        first = await self.db["traffic_visitors"].find_one({"_id": "visitor_0001"})
        self.assertIsInstance(first["last_seen"], datetime)
        await traffic.ingest(self.db, body, ip=None, user_agent="Mozilla/5.0", user_id=None)
        again = await self.db["traffic_visitors"].find_one({"_id": "visitor_0001"})
        self.assertIsInstance(again["last_seen"], datetime)
        self.assertGreaterEqual(again["last_seen"], first["last_seen"])
