"""Memory stays bounded (prod OOM, 2026-11-09: the API climbed ~1 GB in 28 minutes and was killed).

* The hot endpoints seen in prod and every background loop body, run many times in-process: the known
  long-lived structures (services/memory_health.KNOWN) don't grow with the number of requests or
  ticks, and the traced Python heap doesn't either.
* PostHog's request cache drops expired entries (it kept them until 400 keys: a replay's decompressed
  events, tens to hundreds of MB, per live poll) and keeps at most SNAP_MAX replay snapshots.
* A live socket's queue is bounded; a reader that stopped reading is told to close.
* Team memory: a meeting whose page is gone is marked (it was re-read whole every 30 s), a failed
  extraction waits before it is retried (the model was asked again every 30 s), and picking reads
  only what it needs.
* The watchdog: a sample is kept, the owners are emailed over the line, at most once an hour;
  /admin/health/memory is admins only.
* MARKDROP_ROLE: web runs no loops; the worker does; the bus delivers another process's events.
"""

from __future__ import annotations

import asyncio
import gc
import json
import secrets
import tracemalloc
from datetime import datetime, timedelta, timezone
from unittest import mock

from tests.test_workspace_memory import TeamWorld

import unittest

from bson import ObjectId

from app.config import get_settings
from app.services import background, live, memory_health, posthog_api as ph, workspace_memory as wm
from tests._admin_session import admin_headers

settings = get_settings()
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15"


def _numbers(c: dict) -> dict[str, int]:
    """The known structures' sizes, flattened to {name: int}."""
    out: dict[str, int] = {}
    for k, v in c.items():
        if isinstance(v, int):
            out[k] = v
        elif isinstance(v, dict):
            out.update({f"{k}.{kk}": vv for kk, vv in v.items() if isinstance(vv, int)})
    return out


class HotPathsAndLoops(TeamWorld):
    """Each round: every hot endpoint a few times, every loop body once."""

    async def asyncSetUp(self):
        await super().asyncSetUp()
        await self.turn_on()
        await self.standup()
        self.pub = await self.mkdoc("L")
        self.pages = [await self.mkdoc("W") for _ in range(4)]

    async def round(self, i: int) -> None:
        h, m = self.session("owner"), self.session("wm")
        pub = self.pub["slug"]
        anon = {"User-Agent": UA, "Content-Type": "text/plain"}
        slugs = [d["slug"] for d in self.pages]
        calls = [
            ("POST", "/api/v1/beat", dict(headers=anon, content=json.dumps({
                "v": 1, "t": "pageview", "path": f"/{pub}", "vid": secrets.token_hex(8), "sid": secrets.token_hex(8)}))),
            ("GET", f"/api/v1/documents/{slugs[i % 4]}", dict(headers=h)),
            ("GET", f"/api/v1/documents/{pub}", dict(headers={"User-Agent": UA})),
            ("POST", f"/api/v1/documents/{pub}/engage", dict(headers=anon, content=json.dumps({
                # Three readers coming back (a fresh sid per beacon is a new visitor: presence and the
                # pending sessions keep one each, until their TTL or cap — tested in their own suites).
                "sid": f"reader-{i % 3}-0123456789", "seq": i + 1, "first": {"ref": "https://google.com/"},
                "d": {"active": 5}, "pos": {"h": "intro"}}))),
            ("POST", f"/api/v1/documents/{pub}/events", dict(headers={"User-Agent": UA}, json={"type": "view"})),
            ("POST", f"/api/v1/documents/{slugs[0]}/embeds", dict(headers=h, json={"slugs": slugs})),
            ("POST", "/api/v1/meeting-memory/related", dict(headers=h, json={
                "workspace": self.W, "title": "Sourcing", "section": "The beta goes to Senseloaf first."})),
            ("GET", "/api/v1/auth/me", dict(headers=m)),
            ("GET", "/api/v1/host", dict(params={"host": "docs.acme.test", "path": "/x"})),
            ("GET", "/api/v1/google/status", dict(headers=h)),
            ("GET", "/api/v1/ai/pages/status", dict(headers=h)),
            ("GET", f"/api/v1/documents/{slugs[1]}/access", dict(headers=h)),
            ("GET", f"/api/v1/documents/{slugs[2]}/access-requests/mine", dict(headers=m)),
            ("GET", "/api/v1/meetings", dict(headers=h, params={"workspace": self.W})),
            ("GET", f"/api/v1/team/{self.W}", dict(headers=h)),
        ]
        for method, path, kw in calls:
            r = await self.http.request(method, path, **kw)
            self.assertLess(r.status_code, 500, f"{method} {path}: {r.status_code} {r.text[:200]}")
        for body in (background._revalidate, background._reconcile, background._require_auth, background._notifications,
                     background._slack, background._push, background._page_covers, background._meetings_backfill,
                     background._search_index, background._email_retry, background._meeting_memory,
                     background._ask_suggestions, background._workspace_memory, background._jira):
            await body(self.db)

    async def test_known_structures_and_heap_stay_bounded(self):
        for i in range(3):  # warm: first-time imports, caches filling once
            await self.round(i)
        gc.collect()
        before = _numbers(memory_health.caches())
        tracemalloc.start(5)
        try:
            await self.round(3)
            gc.collect()
            t0 = tracemalloc.take_snapshot()
            for i in range(4, 34):
                await self.round(i)
            gc.collect()
            t1 = tracemalloc.take_snapshot()
        finally:
            tracemalloc.stop()
        after = _numbers(memory_health.caches())
        grown = {k: (before.get(k, 0), v) for k, v in after.items() if v - before.get(k, 0) > 8}
        self.assertFalse(grown, f"structures grew with the number of requests / ticks: {grown}")
        growth = sum(s.size_diff for s in t1.compare_to(t0, "filename"))
        top = [str(s) for s in t1.compare_to(t0, "lineno")[:8]]
        self.assertLess(growth, 3 * 2**20, f"traced heap grew {growth / 2**20:.1f} MB over 30 rounds:\n" + "\n".join(top))


class PostHogCache(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        ph.reset()

    async def asyncTearDown(self):
        ph.reset()

    async def test_expired_entries_are_dropped_below_the_cap(self):
        for i in range(20):
            await ph.cached(f"q:{i}", 0.01, lambda i=i: asyncio.sleep(0, result=[i] * 1000), keep=False)
        await asyncio.sleep(0.02)
        await ph.cached("q:last", 60, lambda: asyncio.sleep(0, result=[1]), keep=False)
        self.assertEqual(ph.cache_stats()["entries"], 1, "expired entries were kept (the cap was 400 keys)")

    async def test_live_replay_polls_keep_at_most_two_snapshots(self):
        sources = [{"source": "blob_v2", "blob_key": str(k), "end_timestamp": k} for k in range(40)]
        events = lambda: asyncio.sleep(0, result=[{"type": 3, "data": "x" * 1000} for _ in range(200)])
        with mock.patch.object(ph, "_sources", mock.AsyncMock(return_value=sources)), \
                mock.patch.object(ph, "_blob_events", side_effect=lambda rid, keys: events()):
            await ph.snapshots("rec-1")
            for after in range(0, 39):           # a live viewer polling, each poll a new key
                await ph.snapshots("rec-1", after=after)
            for rid in ("rec-2", "rec-3", "rec-4"):
                await ph.snapshots(rid)
        self.assertLessEqual(ph.cache_stats()["snapshots"], ph.SNAP_MAX)


class LiveQueues(unittest.IsolatedAsyncioTestCase):
    async def test_a_reader_that_stopped_reading_is_told_to_close(self):
        q = live.subscribe("slow")
        try:
            for rev in range(500):
                live.publish("slow", rev)
            self.assertLessEqual(q.qsize(), live.QUEUE_MAX)
            items = [q.get_nowait() for _ in range(q.qsize())]
            self.assertIn({"type": "_overflow"}, items)
        finally:
            live.unsubscribe("slow", q)
        self.assertEqual(live.subscriber_count("slow"), 0)
        self.assertNotIn("slow", live._subscribers)

    async def test_the_bus_delivers_other_processes_events_only(self):
        q = live.subscribe("bus-doc")
        try:
            live._received(json.dumps({"o": "elsewhere", "s": "bus-doc", "e": {"type": "changed", "rev": 3}}))
            live._received(json.dumps({"o": live.ORIGIN, "s": "bus-doc", "e": {"type": "changed", "rev": 4}}))
            live._received(b"not json")
            self.assertEqual(q.get_nowait(), {"type": "changed", "rev": 3})
            self.assertTrue(q.empty())
        finally:
            live.unsubscribe("bus-doc", q)

    async def test_one_process_publishes_nothing(self):
        self.assertEqual(settings.role, "all")
        with mock.patch.object(live, "_send") as send:
            live.publish("x", 1)
            await asyncio.sleep(0)
        send.assert_not_called()


class TeamMemoryPicking(TeamWorld):
    NOW = datetime(2026, 11, 4, 1, 0, tzinfo=timezone.utc)

    async def asyncSetUp(self):
        await super().asyncSetUp()
        await self.turn_on()

    async def wsinfo(self):
        return next(w for w in await wm.enabled_workspaces(self.db) if w.id == self.W)

    async def test_a_meeting_whose_page_is_gone_is_marked_not_reread(self):
        m = await self.standup()
        row = await self.db["meetings"].find_one({"_id": ObjectId(m["id"])})
        await self.db["documents"].update_one({"_id": ObjectId(row["doc_id"])}, {"$set": {"deleted_at": self.NOW}})
        ws = await self.wsinfo()
        state = await wm._state(self.db, ws)
        todo = await wm.stale_sources(self.db, ws, state, now=self.NOW)
        self.assertIn(row["_id"], [r["_id"] for k, r in todo if k == "meeting"])
        await wm.run_workspace(self.db, ws, now=self.NOW)
        src = await self.db[wm.SOURCES].find_one({"_id": f"m:{row['_id']}"})
        self.assertEqual(src["outcome"], "no_page")
        todo = await wm.stale_sources(self.db, ws, state, now=self.NOW)
        self.assertNotIn(row["_id"], [r["_id"] for k, r in todo if k == "meeting"])

    async def test_picking_reads_only_ids_and_dates(self):
        await self.standup()
        ws = await self.wsinfo()
        todo = await wm.stale_sources(self.db, ws, await wm._state(self.db, ws), now=self.NOW)
        self.assertTrue(todo)
        for kind, r in todo:
            if kind == "meeting":
                self.assertLessEqual(set(r), {"_id", "updated_at", "date"})

    async def test_a_failed_extraction_waits_before_it_is_tried_again(self):
        from app.services import pages_ai

        await self.standup()
        ws = await self.wsinfo()
        calls = []

        async def boom(run, blocks):
            calls.append(1)
            raise pages_ai.Upstream("overloaded", "busy")

        with mock.patch.object(wm, "_extract_json", boom):
            await wm.run_workspace(self.db, ws, now=self.NOW)
            n = len(calls)
            self.assertGreaterEqual(n, 1)
            await wm.run_workspace(self.db, ws, now=self.NOW)
            self.assertEqual(len(calls), n, "the model was asked again on the next tick")
        src = await self.db[wm.SOURCES].find_one({"retry_at": {"$exists": True}})
        self.assertEqual(src["errors"], 1)
        # Past the wait it is picked again; a success clears the backoff.
        later = datetime.now(timezone.utc) + timedelta(minutes=3)
        todo = await wm.stale_sources(self.db, ws, await wm._state(self.db, ws), now=later)
        self.assertTrue(any(f"{'m' if k == 'meeting' else 'd'}:{r['_id']}" == src["_id"] for k, r in todo))


class Watchdog(TeamWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await memory_health.ensure_indexes(self.db)

    async def test_a_sample_is_kept_and_the_owners_are_alerted_once_an_hour(self):
        sent = []

        async def fake_send(**kw):
            sent.append(kw["to_email"])

        with mock.patch.object(settings, "memory_alert_rss_mb", 1), \
                mock.patch("app.services.mailer.send_ops_alert_email", side_effect=fake_send):
            p = await memory_health.tick(self.db)
            self.assertTrue(p.get("alerted"))
            p2 = await memory_health.tick(self.db)
            self.assertFalse(p2.get("alerted"))
        self.assertEqual(sorted(sent), sorted(settings.admin_email_set))
        self.assertEqual(await self.db[memory_health.COLL].count_documents({}), 2)
        # An hour later, again.
        await self.db[memory_health.ALERTS].update_one({"_id": "memory"}, {"$set": {
            "last_at": datetime.now(timezone.utc) - timedelta(hours=1, minutes=1)}})
        with mock.patch.object(settings, "memory_alert_rss_mb", 1), \
                mock.patch("app.services.mailer.send_ops_alert_email", side_effect=fake_send):
            self.assertTrue((await memory_health.tick(self.db)).get("alerted"))

    async def test_under_the_line_no_alert(self):
        with mock.patch("app.services.mailer.send_ops_alert_email") as send:
            p = await memory_health.tick(self.db)
        self.assertIsNone(memory_health.over(p))
        send.assert_not_called()

    async def test_the_alert_email_renders(self):
        from app.services import mailer

        mail = mailer.compose_ops_alert(host="ip-1", role="web", pid=42, why="RSS 950 MB is over 900 MB", rss_mb=950,
                                        swap_mb=0, peak_mb=990, uptime_s=5400, top=[("presence.entries", 120)])
        self.assertIn("950 MB", mail["subject"])
        self.assertIn("presence.entries", mail["html"])

    async def test_the_endpoint_is_for_admins(self):
        r = await self.http.get("/api/v1/admin/health/memory", headers=self.session("wm"))
        self.assertEqual(r.status_code, 404)
        await memory_health.tick(self.db)
        r = await self.http.get("/api/v1/admin/health/memory", headers=await admin_headers(self.db))
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertGreater(body["process"]["rss_mb"], 0)
        self.assertIn("posthog", body["caches"])
        self.assertIn("live", body["caches"])
        self.assertEqual(len(body["samples"]), 1)
        self.assertEqual(body["processes"][0]["role"], "all")
        self.assertIsNone(body["tracemalloc"])  # MARKDROP_TRACEMALLOC is off


class Roles(unittest.IsolatedAsyncioTestCase):
    async def test_web_runs_no_loops_and_the_worker_does(self):
        from app import worker

        with mock.patch.object(settings, "role", "web"):
            self.assertFalse(worker.runs_loops())
            self.assertTrue(live._bus_on())
        for role in ("all", "worker"):
            with mock.patch.object(settings, "role", role):
                self.assertTrue(worker.runs_loops())

    async def test_web_lifespan_starts_no_loop(self):
        from app import main

        with mock.patch.object(settings, "role", "web"), mock.patch.object(settings, "background_workers_enabled", True), \
                mock.patch.object(settings, "memory_watchdog_enabled", False), \
                mock.patch("app.main.connect", mock.AsyncMock()), mock.patch("app.main.disconnect", mock.AsyncMock()), \
                mock.patch.object(live, "start_bus"), mock.patch.object(live, "stop_bus", mock.AsyncMock()):
            async with main.lifespan(main.app):
                self.assertEqual(background._TASKS, [])
        gc.unfreeze()


if __name__ == "__main__":
    unittest.main()
