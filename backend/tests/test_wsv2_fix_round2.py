"""Regression tests for the Workspaces v2 adversarial fix round 2
(specs/wsv2-fix-round2.md). One class per finding id; each test failed on
feat/workspaces-v2 @ 913e3df and passes with its fix."""

from __future__ import annotations

import asyncio
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from unittest import mock

from tests._access_env import AccessWorld

from app.services import revalidate


def now():
    return datetime.now(timezone.utc)


@contextmanager
def sending(post):
    """The outbox on, nothing spawned in the background, ``post`` as the frontend."""
    with mock.patch.object(revalidate.settings, "page_revalidate_enabled", True), \
            mock.patch.object(revalidate, "_spawn", lambda *a, **k: None), \
            mock.patch.object(revalidate, "_post", post):
        yield


# ── 1. Cache correctness ──────────────────────────────────────────────────────


class BN1NoPurgeIsSwallowed(AccessWorld):
    """A newer purge must never be merged into a job that is already being
    sent (it may have reached the frontend with the older state)."""

    async def test_bn1_enqueue_while_the_job_is_being_sent_sends_again(self):
        d = await self.mkdoc("L", ws=None)
        key = revalidate.doc_key(d["slug"])
        started, release = asyncio.Event(), asyncio.Event()
        sent: list[dict] = []

        async def post(payload):
            sent.append(payload)
            if len(sent) == 1:
                started.set()
                await release.wait()
            return 200

        with sending(post):
            await revalidate.enqueue(self.db, slugs=[d["slug"]], attempt_now=False)
            first = asyncio.create_task(revalidate.run_due(self.db, keys=[key]))
            await started.wait()
            # The narrowing's purge arrives while the first send is in flight.
            await revalidate.enqueue(self.db, slugs=[d["slug"]], attempt_now=False)
            release.set()
            await first
            await revalidate.run_due(self.db, keys=[key])
        self.assertEqual(len(sent), 2, sent)
        self.assertEqual(await revalidate.pending_keys(self.db), set())

    async def test_bn1_merge_into_a_lapsed_lease_is_not_marked_done(self):
        d = await self.mkdoc("L", ws=None)
        key = revalidate.doc_key(d["slug"])

        async def post(payload):
            return 200

        with sending(post):
            await revalidate.enqueue(self.db, slugs=[d["slug"]], attempt_now=False)
            job = await revalidate._claim(self.db, {"key": key})
            # The sender is slow: its lease lapses and a newer purge is merged in.
            await self.db["revalidate_jobs"].update_one(
                {"_id": job["_id"]}, {"$set": {"lease_until": now() - timedelta(seconds=1)}})
            await revalidate.enqueue(self.db, slugs=[d["slug"]], attempt_now=False)
            state = await revalidate._run_job(self.db, job)
        self.assertEqual(state, "pending")
        row = await self.db["revalidate_jobs"].find_one({"key": key, "state": "pending"})
        self.assertIsNotNone(row)
        self.assertLessEqual(revalidate._aware(row["next_at"]), now())

    async def test_bn1_job_sent_before_the_narrowing_write_is_sent_after_it(self):
        """transitions writes the jobs before the narrower row; a worker that
        claims one in that window sends the old state — another send must follow."""
        d = await self.mkdoc("L", ws=None)
        seen: list[str] = []

        async def post(payload):
            if payload == {"slug": d["slug"]}:
                seen.append((await self.doc(d["slug"]))["access_level"])
            return 200

        orig = revalidate.purge_doc

        async def purge_then_worker(db, raw, **kw):
            keys = await orig(db, raw, **kw)
            if kw.get("attempt") is False:
                await revalidate.run_due(db, keys=keys)  # the background worker wins the race
            return keys

        with sending(post), mock.patch.object(revalidate, "purge_doc", purge_then_worker):
            r = await self.http.put(f"/api/v1/documents/{d['slug']}/access/level",
                                    json={"level": "private"}, headers=self.session("owner"))
            self.assertEqual(r.status_code, 204, r.text)
        self.assertEqual(seen[0], "link")
        self.assertEqual(seen[-1], "private")  # delivered before the answer, after the write

    async def test_bn1_flush_waits_for_a_send_in_flight_elsewhere(self):
        d = await self.mkdoc("L", ws=None)
        key = revalidate.doc_key(d["slug"])
        started = asyncio.Event()

        async def post(payload):
            started.set()
            await asyncio.sleep(0.3)
            return 200

        with sending(post):
            await revalidate.enqueue(self.db, slugs=[d["slug"]], attempt_now=False)
            worker = asyncio.create_task(revalidate.run_due(self.db, keys=[key]))
            await started.wait()
            await revalidate.flush(self.db, [key])
            job = await self.db["revalidate_jobs"].find_one({"key": key})
            await worker
        self.assertEqual(job["state"], "done")


class BR1BatchesFlushOnce(AccessWorld):
    """A batch narrowing waits once for all its purges (bounded concurrency),
    not ≈ one round trip (or 3 s) per document."""

    async def _slow(self, action, slugs):
        sent: list[dict] = []

        async def post(payload):
            sent.append(payload)
            await asyncio.sleep(0.4)
            return 200

        with sending(post):
            t0 = time.monotonic()
            r = await action()
            elapsed = time.monotonic() - t0
        self.assertLess(r.status_code, 300, r.text)
        for s in slugs:
            self.assertIn({"slug": s}, sent)
        return elapsed

    async def test_br1_batch_level_change(self):
        docs = [await self.mkdoc("L", ws=None) for _ in range(6)]
        slugs = [d["slug"] for d in docs]
        elapsed = await self._slow(lambda: self.http.post(
            "/api/v1/documents/access/level", json={"slugs": slugs, "level": "private"},
            headers=self.session("owner")), slugs)
        self.assertLess(elapsed, 1.6)
        for s in slugs:
            self.assertEqual((await self.doc(s))["access_level"], "private")

    async def test_br1_items_remove(self):
        docs = [await self.mkdoc("RL") for _ in range(6)]
        slugs = [d["slug"] for d in docs]
        elapsed = await self._slow(lambda: self.http.post(
            f"/api/v1/workspaces/{self.ws['WR']}/items/remove", json={"slugs": slugs},
            headers=self.session("owner")), slugs)
        self.assertLess(elapsed, 1.6)

    async def test_br1_batch_flushes_even_when_the_block_fails(self):
        d = await self.mkdoc("L", ws=None)
        sent: list[dict] = []

        async def post(payload):
            sent.append(payload)
            return 200

        with sending(post):
            with self.assertRaises(RuntimeError):
                async with revalidate.batch(self.db):
                    await revalidate.purge_doc(self.db, d, inline=True)
                    self.assertEqual(sent, [])  # collected, not sent yet
                    raise RuntimeError("boom")
        self.assertIn({"slug": d["slug"]}, sent)


class BN4MassExpiryDrainsConcurrently(AccessWorld):
    async def test_bn4_due_jobs_are_sent_concurrently(self):
        async def post(payload):
            await asyncio.sleep(0.2)
            return 200

        with sending(post):
            await revalidate.enqueue(self.db, slugs=[f"bulk-{i}" for i in range(16)], attempt_now=False)
            t0 = time.monotonic()
            n = await revalidate.run_due(self.db, limit=200)
            elapsed = time.monotonic() - t0
        self.assertEqual(n, 16)
        self.assertLess(elapsed, 1.5)

    async def test_bn4_listing_purges_of_one_second_are_one_job(self):
        base = (now() + timedelta(minutes=5)).replace(microsecond=0)
        for i, micro in enumerate((100_000, 600_000, 900_000)):
            d = await self.mkdoc("W", expires_at=base + timedelta(microseconds=micro))
            await revalidate.schedule_expiry(self.db, await self.doc(d["slug"]))
        tag_jobs = await self.db["revalidate_jobs"].count_documents(
            {"key": f"tag:wsl:{self.ws['W1']}", "scheduled": True})
        self.assertEqual(tag_jobs, 1)
        job = await self.db["revalidate_jobs"].find_one({"key": f"tag:wsl:{self.ws['W1']}"})
        self.assertGreater(revalidate._aware(job["next_at"]), base + timedelta(seconds=1))  # never early

    async def test_bn4_sweeper_flushes_once(self):
        for _ in range(8):
            await self.mkdoc("L", ws=None, expires_at=now() - timedelta(seconds=1))

        async def post(payload):
            await asyncio.sleep(0.3)
            return 200

        from app.services import lifecycle

        with sending(post):
            t0 = time.monotonic()
            n = await lifecycle.sweep_expired(self.db)
            elapsed = time.monotonic() - t0
        self.assertEqual(n, 8)
        self.assertLess(elapsed, 1.5)
