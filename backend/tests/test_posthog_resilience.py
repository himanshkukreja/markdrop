"""PostHog transport resilience (services/posthog_api.py) and the Live feed: stale-while-error,
the circuit breaker, Retry-After, the read-budget backoff, retries with jitter, the last-good
store's bounds, incremental snapshots, and the `stale` field the admin API adds.

PostHog is an httpx.MockTransport: no network.
"""

from __future__ import annotations

import asyncio
import json
import time
import unittest
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from unittest import mock

from tests import _email_env  # noqa: F401  (pins settings before app.config is read)

import httpx
import jwt

from app.config import get_settings
from app.services import journeys as jm
from app.services import posthog_api as ph

settings = get_settings()


def rows_answer(columns: list[str], rows: list[list]) -> dict:
    return {"columns": columns, "results": rows, "is_cached": False}


class FakePostHog:
    """Answers queued per route; records every request that reached it."""

    def __init__(self):
        self.calls: list[httpx.Request] = []
        self.queue: list = []  # callables or httpx.Response, consumed in order
        self.default = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        nxt = self.queue.pop(0) if self.queue else self.default
        if nxt is None:
            return httpx.Response(500, json={"detail": "no answer queued"})
        return nxt(request) if callable(nxt) else nxt

    def query_names(self) -> list[str]:
        out = []
        for r in self.calls:
            if r.url.path.endswith("/query/") and r.method == "POST":
                out.append(json.loads(r.content).get("name"))
        return out


def ok(cols=("n",), rows=((1,),)):
    return httpx.Response(200, json=rows_answer(list(cols), [list(r) for r in rows]))


def err(status: int, *, code: str | None = None, detail: str = "nope", retry_after: str | None = None):
    headers = {"Retry-After": retry_after} if retry_after is not None else {}
    return httpx.Response(status, json={"type": "x", "code": code, "detail": detail}, headers=headers)


class TransportCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        ph.reset()
        ph._slots = None
        self.fake = FakePostHog()
        ph._client = httpx.AsyncClient(transport=httpx.MockTransport(self.fake.handler))
        # No real waiting: the retry's jittered sleep becomes 0 s (and is recorded).
        self.jitter = mock.patch.object(ph.random, "uniform", side_effect=lambda a, b: 0.0)
        self.jitter_mock = self.jitter.start()

    async def asyncTearDown(self):
        self.jitter.stop()
        await ph._client.aclose()
        ph._client = None
        ph.reset()

    async def query(self, sql="SELECT 1", ttl=0.0, **kw):
        return await ph.hogql(sql, name="t", ttl=ttl, **kw)


class StaleWhileError(TransportCase):
    async def test_429_serves_the_last_good_answer_and_notes_it(self):
        self.fake.queue = [ok(rows=((7,),)), err(429, retry_after="30")]
        self.assertEqual(await self.query(), [{"n": 7}])
        notes = ph.track_stale()
        self.assertEqual(await self.query(), [{"n": 7}])
        summary = ph.stale_summary(notes)
        self.assertIsNotNone(summary)
        self.assertEqual(summary["reason"], "rate_limited")
        self.assertGreaterEqual(summary["retry_in"], 29)
        self.assertEqual(len(self.fake.calls), 2, "a 429 is never retried")

    async def test_504_is_retried_once_then_served_stale(self):
        self.fake.queue = [ok(rows=((3,),)), err(504, detail="Gateway timeout"), err(504, detail="Gateway timeout")]
        await self.query()
        notes = ph.track_stale()
        self.assertEqual(await self.query(), [{"n": 3}])
        self.assertEqual(len(self.fake.calls), 3, "one retry after a 504")
        self.assertEqual(ph.stale_summary(notes)["reason"], "slow")
        self.jitter_mock.assert_called_with(0.8, 2.2)

    async def test_capacity_503_trips_for_retry_after_and_serves_stale(self):
        self.fake.queue = [ok(rows=((5,),)), err(503, code="clickhouse_at_capacity", detail="too busy", retry_after="8")]
        await self.query()
        notes = ph.track_stale()
        self.assertEqual(await self.query(), [{"n": 5}])
        self.assertEqual(ph.stale_summary(notes)["reason"], "capacity")
        left, why = ph.cooldown_left("query")
        self.assertEqual(why, "capacity")
        self.assertTrue(6 < left <= 8)
        self.assertEqual(len(self.fake.calls), 2, "an answer carrying Retry-After is not retried")

    async def test_failure_with_nothing_cached_is_an_error(self):
        self.fake.queue = [err(429)]
        with self.assertRaises(ph.PostHogError) as cm:
            await self.query()
        self.assertEqual(cm.exception.status, 429)
        self.assertEqual(cm.exception.reason, "rate_limited")
        self.assertEqual(cm.exception.retry_after, ph.COOLDOWN_DEFAULT)

    async def test_hogql_bug_is_not_masked_by_stale_data(self):
        self.fake.queue = [ok(), err(400, detail="Unknown column foo")]
        await self.query()
        with self.assertRaises(ph.PostHogError) as cm:
            await self.query()
        self.assertEqual(cm.exception.status, 502)
        self.assertIsNone(cm.exception.reason)

    async def test_stale_answer_is_held_so_posthog_is_not_asked_again_at_once(self):
        self.fake.queue = [ok(rows=((1,),)), err(502, detail="bad gateway"), err(502, detail="bad gateway")]
        await self.query()
        await self.query()  # fails twice (one retry), serves stale, holds it
        calls = len(self.fake.calls)
        notes = ph.track_stale()
        self.assertEqual(await self.query(), [{"n": 1}])
        self.assertEqual(len(self.fake.calls), calls, "held stale answer served without a call")
        self.assertEqual(ph.stale_summary(notes)["reason"], "unavailable")


class Breaker(TransportCase):
    async def test_cooldown_skips_upstream_for_every_query(self):
        self.fake.queue = [ok(rows=((1,),)), err(429, retry_after="45")]
        await self.query("SELECT 1")
        await self.query("SELECT 1")  # 429: breaker opens, stale served
        calls = len(self.fake.calls)
        # A different query has nothing cached: it fails fast, without touching PostHog.
        with self.assertRaises(ph.PostHogError) as cm:
            await self.query("SELECT 2")
        self.assertTrue(cm.exception.skipped)
        self.assertEqual(cm.exception.status, 429)
        self.assertTrue(40 < cm.exception.retry_after <= 45)
        self.assertIn("trying again in", cm.exception.message)
        # The cached one keeps answering from the last good result.
        notes = ph.track_stale()
        ph.uncache("q:")
        self.assertEqual(await self.query("SELECT 1"), [{"n": 1}])
        self.assertEqual(ph.stale_summary(notes)["reason"], "rate_limited")
        self.assertEqual(len(self.fake.calls), calls, "no request reached PostHog during the cooldown")

    async def test_query_and_rest_buckets_are_separate(self):
        self.fake.queue = [err(429, retry_after="60"), httpx.Response(200, json={"results": [], "has_next": False})]
        with self.assertRaises(ph.PostHogError):
            await self.query()
        self.assertIsNotNone(ph.cooldown_left("query"))
        self.assertIsNone(ph.cooldown_left("rest"))
        await ph.list_recordings({"limit": 1})
        self.assertEqual(len(self.fake.calls), 2)

    async def test_budget_exceeded_backs_off_ten_minutes(self):
        self.fake.queue = [err(429, code="api_queries_budget_exceeded", detail="Query budget exceeded")]
        with self.assertRaises(ph.PostHogError) as cm:
            await self.query()
        self.assertEqual(cm.exception.reason, "budget")
        left, why = ph.cooldown_left("query")
        self.assertEqual(why, "budget")
        self.assertTrue(ph.COOLDOWN_BUDGET - 5 < left <= ph.COOLDOWN_BUDGET)

    async def test_budget_exceeded_honours_a_longer_retry_after(self):
        self.fake.queue = [err(429, code="api_queries_budget_exceeded", retry_after="1500")]
        with self.assertRaises(ph.PostHogError):
            await self.query()
        self.assertTrue(1495 < ph.cooldown_left("query")[0] <= 1500)

    async def test_three_transient_failures_in_a_row_open_the_breaker(self):
        self.fake.default = err(500, detail="internal")
        for sql in ("SELECT 1", "SELECT 2"):
            with self.assertRaises(ph.PostHogError):
                await self.query(sql)  # two attempts each
        self.assertIsNotNone(ph.cooldown_left("query"))
        self.assertEqual(ph.cooldown_left("query")[1], "unavailable")
        self.assertEqual(len(self.fake.calls), 3, "the breaker opened on the third failure; the fourth attempt was skipped")

    async def test_success_resets_the_failure_streak(self):
        self.fake.queue = [err(500), ok(), err(500), ok()]
        await self.query("SELECT 1")
        await self.query("SELECT 2")
        self.assertIsNone(ph.cooldown_left("query"))

    async def test_breaker_reopens_after_cooldown(self):
        ph.trip("query", 1.0, "rate_limited")
        self.fake.queue = [ok(rows=((9,),))]
        with mock.patch.object(ph.time, "monotonic", return_value=time.monotonic() + 2):
            self.assertIsNone(ph.cooldown_left("query"))
        ph._breaker.clear()
        self.assertEqual(await self.query(), [{"n": 9}])

    async def test_limits_reported_in_status(self):
        ph.trip("rest", 30, "rate_limited")
        self.assertEqual(ph.status()["limits"]["rest"]["reason"], "rate_limited")


class RetryAfter(unittest.TestCase):
    def test_seconds(self):
        self.assertEqual(ph.parse_retry_after("17"), 17.0)
        self.assertEqual(ph.parse_retry_after(" 2.5 "), 2.5)

    def test_http_date(self):
        when = datetime.now(timezone.utc) + timedelta(seconds=120)
        got = ph.parse_retry_after(format_datetime(when, usegmt=True))
        self.assertTrue(115 <= got <= 121, got)

    def test_past_date_is_zero(self):
        when = datetime.now(timezone.utc) - timedelta(seconds=120)
        self.assertEqual(ph.parse_retry_after(format_datetime(when, usegmt=True)), 0.0)

    def test_missing_or_garbage(self):
        self.assertIsNone(ph.parse_retry_after(None))
        self.assertIsNone(ph.parse_retry_after(""))
        self.assertIsNone(ph.parse_retry_after("soon"))

    def test_negative_clamped(self):
        self.assertEqual(ph.parse_retry_after("-5"), 0.0)


class LastGoodStore(unittest.TestCase):
    def setUp(self):
        ph.reset()

    def tearDown(self):
        ph.reset()

    def test_key_bound_evicts_least_recently_used(self):
        for i in range(ph.GOOD_KEYS + 5):
            ph.remember(f"k{i}", [i])
        self.assertEqual(len(ph._good), ph.GOOD_KEYS)
        self.assertIsNone(ph.recall("k0"))
        self.assertIsNotNone(ph.recall(f"k{ph.GOOD_KEYS + 4}"))

    def test_recall_refreshes_recency(self):
        for i in range(ph.GOOD_KEYS):
            ph.remember(f"k{i}", [i])
        ph.recall("k0")  # now the most recent
        ph.remember("new", [1])
        self.assertIsNotNone(ph.recall("k0"))
        self.assertIsNone(ph.recall("k1"))

    def test_row_bound(self):
        big = list(range(ph.GOOD_ROWS // 2 + 1))
        ph.remember("a", big)
        ph.remember("b", big)
        self.assertIsNone(ph.recall("a"))
        self.assertIsNotNone(ph.recall("b"))
        self.assertLessEqual(ph._good_rows, ph.GOOD_ROWS)

    def test_max_age(self):
        ph.remember("old", [1])
        with mock.patch.object(ph.time, "monotonic", return_value=time.monotonic() + ph.GOOD_AGE + 1):
            self.assertIsNone(ph.recall("old"))
        self.assertNotIn("old", ph._good)
        self.assertEqual(ph._good_rows, 0)

    def test_replacing_a_key_keeps_the_row_count_right(self):
        ph.remember("a", [1, 2, 3])
        ph.remember("a", [1])
        self.assertEqual(ph._good_rows, 1)

    def test_summary_picks_the_oldest_age_and_strongest_reason(self):
        now = time.time()
        s = ph.stale_summary([{"as_of": now - 30, "reason": "slow"}, {"as_of": now - 600, "reason": "budget"}])
        self.assertEqual(s["reason"], "budget")
        self.assertTrue(599 <= s["age_s"] <= 601)
        self.assertEqual(s["message"], ph.REASON_TEXT["budget"])
        self.assertIsNone(ph.stale_summary([]))


class InFlight(TransportCase):
    async def test_concurrent_callers_share_one_request(self):
        gate = asyncio.Event()

        async def slow_handler(request):
            await gate.wait()
            return ok(rows=((2,),))

        transport = httpx.MockTransport(lambda r: None)
        calls = []

        async def handle(request):
            calls.append(request)
            return await slow_handler(request)

        transport.handle_async_request = handle  # type: ignore[assignment]
        await ph._client.aclose()
        ph._client = httpx.AsyncClient(transport=transport)
        tasks = [asyncio.create_task(self.query(ttl=5)) for _ in range(5)]
        await asyncio.sleep(0.05)
        gate.set()
        results = await asyncio.gather(*tasks)
        self.assertEqual(results, [[{"n": 2}]] * 5)
        self.assertEqual(len(calls), 1)

    async def test_concurrent_waiters_also_get_the_stale_fallback(self):
        self.fake.queue = [ok(rows=((4,),))]
        await self.query(ttl=0)
        gate = asyncio.Event()

        async def handle(request):
            await gate.wait()
            return err(429, retry_after="20")

        transport = httpx.MockTransport(lambda r: None)
        transport.handle_async_request = handle  # type: ignore[assignment]
        await ph._client.aclose()
        ph._client = httpx.AsyncClient(transport=transport)
        tasks = [asyncio.create_task(self.query(ttl=0)) for _ in range(3)]
        await asyncio.sleep(0.05)
        gate.set()
        self.assertEqual(await asyncio.gather(*tasks), [[{"n": 4}]] * 3)


class AsyncQueries(TransportCase):
    async def test_async_refresh_polls_until_complete(self):
        started = httpx.Response(202, json={"query_status": {"id": "abc", "complete": False}})
        pending = httpx.Response(200, json={"query_status": {"id": "abc", "complete": False}})
        done = httpx.Response(200, json={"query_status": {"id": "abc", "complete": True, "results": rows_answer(["n"], [[11]])}})
        self.fake.queue = [started, pending, done]
        with mock.patch.object(ph.asyncio, "sleep", new=mock.AsyncMock()):
            self.assertEqual(await self.query(refresh="async"), [{"n": 11}])
        self.assertEqual([r.url.path.rsplit("/", 2)[-2] for r in self.fake.calls[1:]], ["abc", "abc"])
        self.assertEqual(json.loads(self.fake.calls[0].content)["refresh"], "async")

    async def test_async_error_is_mapped(self):
        started = httpx.Response(202, json={"query_status": {"id": "q1", "complete": False}})
        failed = httpx.Response(200, json={"query_status": {"id": "q1", "complete": True, "error": True, "error_message": "Timeout exceeded: elapsed 600 s"}})
        self.fake.queue = [started, failed, started, failed]
        with mock.patch.object(ph.asyncio, "sleep", new=mock.AsyncMock()):
            with self.assertRaises(ph.PostHogError) as cm:
                await self.query(refresh="async")
        self.assertEqual(cm.exception.reason, "slow")


class Snapshots(TransportCase):
    def sources(self, n: int) -> httpx.Response:
        return httpx.Response(200, json={"sources": [
            {"source": "blob_v2", "blob_key": str(i), "start_timestamp": f"2026-10-16T15:00:{i:02d}Z", "end_timestamp": f"2026-10-16T15:00:{i:02d}.5Z"}
            for i in range(n)
        ]})

    def blob(self, request: httpx.Request) -> httpx.Response:
        a, b = int(request.url.params["start_blob_key"]), int(request.url.params["end_blob_key"])
        self.assertLessEqual(b - a + 1, ph.BLOB_SPAN)
        lines = [json.dumps(["w", {"type": 3, "timestamp": 1000 + i, "data": {}}]) for i in range(a, b + 1)]
        return httpx.Response(200, text="\n".join(lines))

    async def test_full_fetch_is_split_into_spans_of_twenty(self):
        self.fake.queue = [self.sources(25), self.blob, self.blob]
        snap = await ph.snapshots("rec-00000001")
        self.assertEqual(len(snap["events"]), 25)
        self.assertEqual(snap["last_key"], 24)
        self.assertEqual(snap["live_edge"], "2026-10-16T15:00:24.5Z")
        spans = [(r.url.params.get("start_blob_key"), r.url.params.get("end_blob_key")) for r in self.fake.calls[1:]]
        self.assertEqual(spans, [("0", "19"), ("20", "24")])

    async def test_after_fetches_only_new_blobs(self):
        self.fake.queue = [self.sources(25), self.blob]
        snap = await ph.snapshots("rec-00000001", after=22)
        self.assertEqual([e["timestamp"] for e in snap["events"]], [1023, 1024])
        self.assertEqual(self.fake.calls[1].url.params["start_blob_key"], "23")

    async def test_after_with_nothing_new_makes_one_call(self):
        self.fake.queue = [self.sources(5)]
        snap = await ph.snapshots("rec-00000001", after=4)
        self.assertEqual(snap["events"], [])
        self.assertEqual(snap["last_key"], 4)
        self.assertEqual(len(self.fake.calls), 1)

    async def test_missing_recording(self):
        self.fake.queue = [err(404, detail="not found")]
        self.assertIsNone(await ph.snapshots("rec-00000002"))


class LiveFeed(TransportCase):
    """The Live feed over a fake PostHog: sessions, stream buffer, recordings, stale fallback."""

    async def asyncSetUp(self):
        await super().asyncSetUp()
        jm.reset_stream()
        now = datetime.now(timezone.utc)
        self.now = now
        sid = "01a1453d-62a0-7599-8709-fb7b273e35fa"
        props = json.dumps({"$session_id": sid, "$pathname": "/new", "$geoip_country_code": "IN", "$geoip_city_name": "Pune",
                            "$device_type": "Desktop", "$browser": "Chrome", "$el_text": "Publish", "$event_type": "click",
                            "$current_url": "https://x/secret"})
        sess_cols = ["sid", "person_id", "did", "email", "name", "first_t", "last_t", "n", "n_now", "pv", "path", "last_id", "last_event"]
        self.sessions = rows_answer(sess_cols, [
            [sid, "p-1", "d-1", "ann@example.com", "Ann", (now - timedelta(minutes=12)).isoformat(), (now - timedelta(seconds=20)).isoformat(),
             14, 3, 4, "/new", "e-9", "$autocapture"],
            ["d:anon-xyz", "p-2", "anon-xyz", None, None, (now - timedelta(minutes=29, seconds=50)).isoformat(),
             (now - timedelta(minutes=10)).isoformat(), 2, 0, 1, "/", "e-old", "$pageview"],
        ])
        stream_cols = ["uuid", "event", "timestamp", "chain", "person_id", "distinct_id", "properties"]
        self.stream = rows_answer(stream_cols, [
            ["e-9", "$autocapture", (now - timedelta(seconds=20)).isoformat(), 'button:text="Publish"', "p-1", "d-1", props],
            ["e-8", "$pageview", (now - timedelta(seconds=90)).isoformat(), None, "p-1", "d-1",
             json.dumps({"$session_id": sid, "$pathname": "/new", "$geoip_country_code": "IN"})],
        ])
        self.recs = {"results": [{"id": sid, "ongoing": True, "start_time": (now - timedelta(minutes=40)).isoformat(), "recording_duration": 2400}]}

        def route(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/query/"):
                name = json.loads(request.content)["name"]
                if self.fail_queries:
                    return err(429, retry_after="30")
                return httpx.Response(200, json=self.sessions if name.endswith("live_sessions") else self.stream)
            return httpx.Response(200, json=self.recs)

        self.fail_queries = False
        self.fake.default = route

    async def resolve(self, refs):
        return {}

    async def test_feed_shape(self):
        feed = await jm.live_feed(self.resolve, None)
        self.assertEqual(feed["counts"], {"visitors_now": 1, "sessions": 2, "events_now": 3, "pageviews": 5, "capped": False})
        s = feed["sessions"][0]
        self.assertEqual(s["who"], "ann@example.com")
        self.assertTrue(s["identified"])
        self.assertEqual(s["recording"]["ongoing"], True)
        self.assertEqual(s["last"]["label"], "Clicked “Publish”")
        self.assertEqual(s["page"]["title"], "Editor")
        # The recording began before the 30-minute window: its start wins.
        self.assertFalse(s["started_before_window"])
        self.assertLess(datetime.fromisoformat(s["started"].replace("Z", "+00:00")), self.now - timedelta(minutes=30))
        # The second session started at the window's edge with no recording: flagged.
        self.assertTrue(feed["sessions"][1]["started_before_window"])
        # Its last event is older than the buffer: described from the event name and route.
        self.assertEqual(feed["sessions"][1]["last"]["label"], "Viewed “Home”")
        self.assertEqual(feed["sessions"][1]["page"]["key"], "/")
        self.assertEqual(s["country"], "IN")
        self.assertEqual(feed["pages"], [{"page": s["page"], "n": 1}])
        self.assertEqual([e["id"] for e in feed["events"]], ["e-9", "e-8"])
        self.assertEqual(feed["events"][0]["who"], "ann@example.com")
        self.assertNotIn("secret", json.dumps(feed), "only picked properties leave the server")
        self.assertEqual(feed["cursor"], feed["events"][0]["t"])

    async def test_since_trims_the_stream(self):
        await jm.live_feed(self.resolve, None)
        since = self.now + timedelta(minutes=5)
        feed = await jm.live_feed(self.resolve, since)
        self.assertEqual(feed["events"], [])

    async def test_stream_is_incremental(self):
        await jm.live_feed(self.resolve, None)
        ph.uncache("live:")
        await jm.live_feed(self.resolve, None)
        stream_sql = [json.loads(r.content)["query"]["values"]["lo"] for r in self.fake.calls
                      if r.url.path.endswith("/query/") and json.loads(r.content)["name"].endswith("live_stream")]
        self.assertEqual(len(stream_sql), 2)
        first, second = (datetime.strptime(x, "%Y-%m-%d %H:%M:%S") for x in stream_sql)
        self.assertGreater(second, first, "the second fetch starts near the newest event, not 30 minutes back")

    async def test_rate_limit_serves_last_feed_as_stale(self):
        await jm.live_feed(self.resolve, None)
        ph.uncache("live:")
        ph.uncache("q:")
        self.fail_queries = True
        feed = await jm.live_feed(self.resolve, None)
        self.assertEqual(len(feed["sessions"]), 2)
        summary = ph.stale_summary(feed["_stale_notes"])
        self.assertEqual(summary["reason"], "rate_limited")


class AdminApi(TransportCase):
    """The router adds `stale` and maps cooldowns to 429 + Retry-After."""

    async def asyncSetUp(self):
        await super().asyncSetUp()
        from app.main import app
        from app.routers import admin_journeys

        self.app = app
        self.saved = (settings.posthog_project_id, settings.posthog_personal_api_key)
        settings.posthog_project_id, settings.posthog_personal_api_key = "1", "phx_test"
        app.dependency_overrides[admin_journeys.get_db] = lambda: None
        tok = jwt.encode({"sub": "admin", "exp": datetime.now(timezone.utc) + timedelta(hours=1)}, settings.admin_secret, algorithm="HS256")
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://api.markdrop.in",
                                      headers={"Authorization": f"Bearer {tok}"})
        cols = ["id", "did", "email", "name", "created", "first_event", "last_seen", "sessions", "pageviews", "n", "country", "city",
                "device", "browser", "os", "referrer", "top_pages"]
        self.people = rows_answer(cols, [["p-1", "d-1", "a@b.c", None, None, "2026-10-01T00:00:00Z", "2026-10-16T00:00:00Z", 1, 1, 1,
                                          "IN", "Pune", "Desktop", "Chrome", "Mac", "$direct", ["/"]]])

    async def asyncTearDown(self):
        settings.posthog_project_id, settings.posthog_personal_api_key = self.saved
        self.app.dependency_overrides.clear()
        await self.http.aclose()
        await super().asyncTearDown()

    async def test_stale_field_and_cooldown_429(self):
        self.fake.queue = [httpx.Response(200, json=self.people), err(429, retry_after="40")]
        r1 = await self.http.get("/api/v1/admin/journeys/people", params={"days": 30})
        self.assertEqual(r1.status_code, 200)
        self.assertNotIn("stale", r1.json())
        ph.uncache("q:")
        r2 = await self.http.get("/api/v1/admin/journeys/people", params={"days": 30})
        self.assertEqual(r2.status_code, 200)
        body = r2.json()
        self.assertEqual(body["people"][0]["email"], "a@b.c")
        self.assertEqual(body["stale"]["reason"], "rate_limited")
        self.assertGreaterEqual(body["stale"]["retry_in"], 39)
        # Nothing cached for another range: 429 with Retry-After, without calling PostHog.
        calls = len(self.fake.calls)
        r3 = await self.http.get("/api/v1/admin/journeys/people", params={"days": 7})
        self.assertEqual(r3.status_code, 429)
        self.assertTrue(39 <= int(r3.headers["retry-after"]) <= 40)
        self.assertEqual(r3.json()["reason"], "rate_limited")
        self.assertEqual(len(self.fake.calls), calls)

    async def test_live_viewer_cap(self):
        from app.routers import admin_journeys

        admin_journeys._live_viewers.clear()
        self.fake.default = httpx.Response(200, json={"sources": []})
        for rid in ("rec-0000000a", "rec-0000000b"):
            r = await self.http.get(f"/api/v1/admin/journeys/recordings/{rid}/snapshots", params={"after": 3})
            self.assertEqual(r.status_code, 200)
        r = await self.http.get("/api/v1/admin/journeys/recordings/rec-0000000c/snapshots", params={"after": 3})
        self.assertEqual(r.status_code, 429)
        self.assertEqual(r.json()["reason"], "live_viewers")
        # The same recording keeps polling; a plain open is never capped.
        self.assertEqual((await self.http.get("/api/v1/admin/journeys/recordings/rec-0000000a/snapshots", params={"after": 3})).status_code, 200)
        self.assertEqual((await self.http.get("/api/v1/admin/journeys/recordings/rec-0000000c/snapshots")).status_code, 200)
        admin_journeys._live_viewers.clear()

    async def test_fault_hook_is_off_by_default(self):
        r = await self.http.post("/api/v1/admin/journeys/_debug/fault", json={"status": 429})
        self.assertEqual(r.status_code, 404)


if __name__ == "__main__":
    unittest.main()
