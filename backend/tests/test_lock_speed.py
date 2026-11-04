"""Team → Locked without the wait (fix/lock-speed).

Turning "visitors must sign in" on used to re-derive every document of the
workspace inside the request (≈ 80 s for 300 documents against R2). Now the
request does the database part — the gate, the access epochs, the marks and
the purge jobs — and a background runner does the bytes, page images and
cached renders (services/lifecycle.py: begin_require_auth / run_require_auth).

These tests hold that split to the security guarantee: nothing of the
workspace is readable without sign-in once the PUT returns; the runner gets
everything else done with bounded parallelism; a runner that stops is
resumed; and toggling back while it works ends in the right state.
"""

from __future__ import annotations

import asyncio
import time
from unittest import mock

from bson import ObjectId

from tests._access_env import AccessWorld
from tests import _lock_world as lw

from app.config import get_settings
from app.routers import workspaces as ws_router
from app.services import background, lifecycle, revalidate

settings = get_settings()


class LockWorld(AccessWorld):
    N = 40

    async def asyncSetUp(self):
        await super().asyncSetUp()
        # R2 and the frontend with network-like latency (20–40 ms a call).
        self.r2 = lw.SlowR2(lo=0.02, hi=0.04)
        self.slow_posted: list = []
        self.slow_post = lw.slow_post_factory(self.slow_posted, lo=0.01, hi=0.02)
        for p in [*self.r2.patches(),
                  mock.patch.object(settings, "page_revalidate_enabled", True),
                  mock.patch.object(revalidate, "_post", self.slow_post),
                  # Every PUT answers at once: what it guarantees must hold before any background work.
                  mock.patch.object(ws_router, "REQUIRE_AUTH_WAIT_S", 0.0)]:
            p.start()
            self.addCleanup(p.stop)
        self.W = self.ws["W1"]
        await self.db["workspaces"].update_one({"_id": ObjectId(self.W)}, {"$set": {
            "settings.default_access": "workspace", "require_auth_applied": False}})
        self.rows = await lw.seed(self, self.N)
        self.links = [d for d in self.rows if d.get("access_level") == "link"]
        self.open_links = [d for d in self.links if not d.get("read_password_hash")]

    async def put(self, on: bool):
        r = await self.http.put(f"/api/v1/workspaces/{self.W}", json={"settings": {
            "require_auth_to_view": on, "default_access": "workspace"}}, headers=self.session("wo"))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def drain(self, timeout: float = 60.0):
        deadline = time.perf_counter() + timeout
        while lifecycle._RUNNERS and time.perf_counter() < deadline:
            await asyncio.wait(set(lifecycle._RUNNERS.values()), timeout=1)
        self.assertFalse(lifecycle._RUNNERS, "runner still working")

    async def pending(self) -> int:
        return await self.db["documents"].count_documents({"ra_pending.ws": self.W})

    async def assert_settled(self, *, locked: bool):
        """The end state for ``locked``: bytes and page images follow it,
        nothing left marked or dirty, the lease released, progress done."""
        self.assertEqual(await self.pending(), 0)
        self.assertEqual(await self.db["documents"].count_documents(
            {"workspace_id": self.W, "access_dirty": True}), 0)
        public = set(lw.public_keys(self, self.rows))
        if locked:
            self.assertEqual(public, set())
        else:
            for d in self.open_links:
                if d.get("blob_key"):
                    self.assertIn(d["blob_key"], public, d["_kind"])
                if d.get("poster_key"):
                    self.assertIn(d["poster_key"], public)
                for a in await self.db["page_assets"].find({"doc_id": str(d["_id"])}).to_list(None):
                    self.assertIn(a["key"], public)
            for d in self.rows:
                if d not in self.open_links:
                    self.assertFalse(d.get("blob_key") in public)
        ws = await self.db["workspaces"].find_one({"_id": ObjectId(self.W)})
        self.assertEqual(ws["require_auth_applied"], locked)
        self.assertIsNone(ws.get("require_auth_lock"))
        self.assertNotIn("require_auth_running", ws)
        r = await self.http.get(f"/api/v1/workspaces/{self.W}", headers=self.session("wo"))
        sync = r.json()["access_sync"]  # None: nothing had to be applied (racing toggles cancelled out)
        self.assertTrue(sync is None or sync["state"] == "done", sync)


class LockedHoldsOnReturn(LockWorld):
    async def test_nothing_is_readable_without_sign_in_once_the_put_returns(self):
        epochs = {d["_id"]: int(d.get("access_epoch") or 0) for d in self.links}
        self.assertTrue(lw.public_keys(self, self.rows))  # open before
        for d in self.open_links[:3]:
            self.assertEqual((await self.get(d["slug"])).status_code, 200)

        t = time.perf_counter()
        body = await self.put(True)
        took = time.perf_counter() - t
        # Answered at once, with the background part still to go.
        self.assertLess(took, 2.0)
        sync = body["access_sync"]
        self.assertEqual(sync["state"], "applying")
        self.assertTrue(sync["want"])
        self.assertEqual(sync["total"], len(self.links))
        self.assertGreater(sync["pending"], 0)

        # The gate: every document answers 401 to a visitor, through the API
        # and on the workspace's domain (no bytes URL is handed out).
        for d in self.rows:
            self.assertEqual((await self.get(d["slug"])).status_code, 401, d["_kind"])
        # The epochs moved on (signed links and read tickets from before die).
        for d in self.links:
            row = await self.doc(d["slug"])
            self.assertEqual(int(row.get("access_epoch") or 0), epochs[d["_id"]] + 1)
        # Every cached render has its purge job durable in the outbox.
        jobs = await self.jobs()
        for d in self.rows:
            self.assertIn(revalidate.doc_key(d["slug"]), jobs)
            for s in d.get("old_slugs") or []:
                self.assertIn(revalidate.doc_key(s), jobs)
        self.assertIn(revalidate.tag_key(f"wsl:{self.W}"), jobs)
        # A member still reads, with signed (not public) bytes under the new epoch.
        art = next(d for d in self.open_links if d.get("blob_key"))
        r = await self.get(art["slug"], headers=self.session("wm"))
        self.assertEqual(r.status_code, 200)
        self.assertIn("t=", r.json().get("artifact_url") or "")

        await self.drain()
        await self.assert_settled(locked=True)
        # Every document's cached render was purged, by the runner.
        posted = {p.get("slug") for p in self.slow_posted}
        self.assertLessEqual({d["slug"] for d in self.rows}, posted)
        # Bounded and parallel: never more R2 calls at once than the runner's lanes.
        self.assertGreater(self.r2.max_in_flight, 1)
        self.assertLessEqual(self.r2.max_in_flight, lifecycle.RA_CONCURRENCY)
        self.assertLessEqual(self.slow_post.state["max"], lifecycle.RA_PURGE_CONCURRENCY + revalidate.CONCURRENCY)

    async def test_progress_counts_down_on_the_settings_page(self):
        await self.put(True)
        seen = []
        for _ in range(400):
            r = await self.http.get(f"/api/v1/workspaces/{self.W}", headers=self.session("wa"))
            s = r.json()["access_sync"]
            seen.append(s["pending"])
            if s["state"] == "done":
                break
            await asyncio.sleep(0.02)
        self.assertEqual(seen[-1], 0)
        self.assertGreater(max(seen), 0)
        self.assertEqual(seen, sorted(seen, reverse=True))
        await self.drain()

    async def test_small_workspace_finishes_inside_the_request(self):
        with mock.patch.object(ws_router, "REQUIRE_AUTH_WAIT_S", 30.0):
            body = await self.put(True)
        self.assertEqual(body["access_sync"]["state"], "done")
        await self.assert_settled(locked=True)


class LockedRunnerResumes(LockWorld):
    async def test_a_runner_stopped_mid_way_is_resumed_by_the_background_loop(self):
        await self.put(True)
        # Let it get some way, then stop it like a restart would (no cleanup ran).
        while await self.pending() > self.N // 2 and lifecycle._RUNNERS:
            await asyncio.sleep(0.02)
        task = lifecycle._RUNNERS.get(self.W)
        self.assertIsNotNone(task)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        left = await self.pending()
        self.assertGreater(left, 0)
        # The gate held all along.
        for d in self.open_links[:5]:
            self.assertEqual((await self.get(d["slug"])).status_code, 401)
        # The dead process's lease is still live (its finally ran here, so
        # put it back): nobody else may work the workspace until it lapses.
        await self.db["workspaces"].update_one({"_id": ObjectId(self.W)}, {"$set": {
            "require_auth_lock": lifecycle._now() + lifecycle.REQUIRE_AUTH_LEASE,
            "require_auth_lock_holder": "dead-process"}})
        self.assertIsNone(await lifecycle.run_require_auth(self.db, self.W))
        self.assertEqual(await lifecycle.resume_require_auth(self.db), 0)
        self.assertEqual(await self.pending(), left)
        # The reconciler leaves the marked documents to the runner.
        await lifecycle.reconcile_once(self.db)
        self.assertEqual(await self.pending(), left)
        # Lapsed: the background loop picks it up and finishes.
        await self.db["workspaces"].update_one({"_id": ObjectId(self.W)}, {"$set": {
            "require_auth_lock": lifecycle._now() - lifecycle.REQUIRE_AUTH_LEASE}})
        await background._require_auth(self.db)
        await self.drain()
        await self.assert_settled(locked=True)

    async def test_a_setting_written_by_a_request_that_died_is_applied(self):
        # The request wrote the setting and died before marking anything.
        await self.set_require_auth("W1", True)
        self.assertTrue(lw.public_keys(self, self.rows))
        lifecycle._RESUME_SCAN.clear()
        await background._require_auth(self.db)
        await self.assert_settled(locked=True)

    async def test_a_stale_mark_falls_to_the_reconciler(self):
        await self.put(True)
        task = lifecycle._RUNNERS.get(self.W)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        left = await self.pending()
        self.assertGreater(left, 0)
        # Nobody resumed it for RA_STALE: the reconciler takes the documents over.
        await self.db["documents"].update_many({"ra_pending.ws": self.W}, {"$set": {
            "ra_pending.at": lifecycle._now() - lifecycle.RA_STALE * 2}})
        res = await lifecycle.reconcile_once(self.db, limit=500)
        self.assertEqual(res["failed"], 0)
        self.assertEqual(await self.pending(), 0)
        self.assertEqual(lw.public_keys(self, self.rows), [])


class LockedToggleBack(LockWorld):
    async def test_switching_back_while_the_runner_works_ends_open(self):
        await self.put(True)
        while await self.pending() > self.N // 2 and lifecycle._RUNNERS:
            await asyncio.sleep(0.02)
        body = await self.put(False)
        self.assertFalse(body["settings"]["require_auth_to_view"])
        for d in self.open_links[:5]:
            self.assertEqual((await self.get(d["slug"])).status_code, 200)
        await self.drain()
        await self.assert_settled(locked=False)

    async def test_locked_team_locked_in_quick_succession_ends_locked(self):
        epochs = {d["_id"]: int(d.get("access_epoch") or 0) for d in self.links}
        await self.put(True)
        await asyncio.sleep(0.05)
        await self.put(False)
        await asyncio.sleep(0.05)
        await self.put(True)
        for d in self.rows:
            self.assertEqual((await self.get(d["slug"])).status_code, 401)
        await self.drain()
        await self.assert_settled(locked=True)
        # Locked twice: each one revoked what was handed out before it.
        for d in self.links:
            row = await self.doc(d["slug"])
            self.assertEqual(int(row.get("access_epoch") or 0), epochs[d["_id"]] + 2)
        # Every object carries the final epoch (old signed links fail at the Worker).
        for d in self.links:
            row = await self.doc(d["slug"])
            if d.get("blob_key") and not d.get("bundle_prefix"):
                self.assertEqual(self.r2.objects[d["blob_key"]].get("ae"), str(row["access_epoch"]))

    async def test_racing_toggles_follow_the_last_write(self):
        # Two admins at once: one Locked, one Team. Whatever the order, the
        # documents end matching the setting the row ends with.
        r1, r2 = await asyncio.gather(
            self.http.put(f"/api/v1/workspaces/{self.W}", json={"settings": {"require_auth_to_view": True}},
                          headers=self.session("wo")),
            self.http.put(f"/api/v1/workspaces/{self.W}", json={"settings": {"require_auth_to_view": False}},
                          headers=self.session("wa")))
        self.assertEqual((r1.status_code, r2.status_code), (200, 200))
        await self.drain()
        lifecycle._RESUME_SCAN.clear()
        await background._require_auth(self.db)
        await self.drain()
        ws = await self.db["workspaces"].find_one({"_id": ObjectId(self.W)})
        await self.assert_settled(locked=bool(ws["settings"]["require_auth_to_view"]))

    async def test_while_reopening_readers_get_links_that_work_either_way(self):
        await self.put(True)
        await self.drain()
        # Team again, with the runner held back: the gate is open, the stored
        # objects still say private.
        with mock.patch.object(lifecycle, "kick_require_auth", lambda *a, **k: None):
            await self.put(False)
        art = next(d for d in self.open_links if d.get("blob_key") and not d.get("bundle_prefix"))
        self.assertFalse(self.r2.objects[art["blob_key"]]["public"])
        r = await self.get(art["slug"])
        self.assertEqual(r.status_code, 200)
        # Signed, under the epoch the object carries: the Worker serves it.
        url = r.json()["artifact_url"]
        self.assertIn("t=", url)
        row = await self.doc(art["slug"])
        self.assertEqual(self.r2.objects[art["blob_key"]].get("ae"), str(row["access_epoch"]))
        await lifecycle.run_require_auth(self.db, self.W)
        await self.assert_settled(locked=False)
        self.assertNotIn("t=", (await self.get(art["slug"])).json()["artifact_url"])
