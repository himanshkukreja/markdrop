"""Timing of Team → Locked on a realistic workspace (not part of the suite).

    MARKDROP_TEST_MONGODB_URI=mongodb://127.0.0.1:27019 \\
    LOCK_BENCH_N=300 python -m unittest tests.bench_lock_speed -v

Seeds ``LOCK_BENCH_N`` documents (tests/_lock_world.py: R2 and the frontend's
revalidate endpoint with 50–150 ms per call), then times the PUT that turns
sign-in on and, separately, how long until nothing of the workspace is served
without a token and every cached render was purged.
"""

from __future__ import annotations

import asyncio
import os
import time
from unittest import mock

from app.config import get_settings
from app.routers import workspaces as ws_router
from app.services import revalidate
from tests import _lock_world as lw
from tests._access_env import AccessWorld

settings = get_settings()
N = int(os.environ.get("LOCK_BENCH_N", "300"))


class LockSpeedBench(AccessWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.r2 = lw.SlowR2()
        self.slow_posted: list = []
        patches = [*self.r2.patches(),
                   mock.patch.object(settings, "page_revalidate_enabled", True),
                   mock.patch.object(revalidate, "_post", lw.slow_post_factory(self.slow_posted))]
        if os.environ.get("LOCK_BENCH_WAIT") and hasattr(ws_router, "REQUIRE_AUTH_WAIT_S"):
            # How long the PUT waits for the background part (0: the database part alone).
            patches.append(mock.patch.object(ws_router, "REQUIRE_AUTH_WAIT_S", float(os.environ["LOCK_BENCH_WAIT"])))
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    async def test_team_to_locked(self):
        from bson import ObjectId

        W = self.ws["W1"]
        await self.db["workspaces"].update_one({"_id": ObjectId(W)}, {"$set": {
            "settings.default_access": "workspace", "require_auth_applied": False}})
        t = time.perf_counter()
        rows = await lw.seed(self, N)
        seed_s = time.perf_counter() - t
        open_before = len(lw.public_keys(self, rows))
        links = sum(1 for d in rows if d.get("access_level") == "link")
        self.r2.calls = 0
        t0 = time.perf_counter()
        r = await self.http.put(f"/api/v1/workspaces/{W}",
                                json={"settings": {"require_auth_to_view": True, "default_access": "workspace"}},
                                headers=self.session("wo"))
        put_s = time.perf_counter() - t0
        self.assertEqual(r.status_code, 200, r.text)
        open_at_return = len(lw.public_keys(self, rows))
        slugs = {d["slug"] for d in rows}
        while True:
            left = len(lw.public_keys(self, rows))
            purged = {p.get("slug") for p in self.slow_posted}
            if not left and slugs <= purged:
                break
            if time.perf_counter() - t0 > 900:
                break
            await asyncio.sleep(0.05)
        all_s = time.perf_counter() - t0
        print(f"\nLOCK BENCH n={N} links={links} seed={seed_s:.1f}s public_objects_before={open_before} "
              f"put={put_s:.2f}s public_objects_at_return={open_at_return} fully_applied={all_s:.2f}s "
              f"r2_calls={self.r2.calls} r2_max_in_flight={self.r2.max_in_flight} "
              f"purges={len(self.slow_posted)} body_sync={r.json().get('access_sync')}")
