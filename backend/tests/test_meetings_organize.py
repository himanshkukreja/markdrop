"""Organize meetings as a background job (services/meeting_organize.py; .work/meetings/ORGANIZE-FIX.md).

The 2026-11-05 outage: POST /meetings/organize ran over ~80 meetings inside the request and outlived
nginx's 60 s. Now: the request answers at once (202) with a run, the run goes in batches in the
background with progress, one run per workspace (a second click joins it), it carries on after a
restart, and it is idempotent — also from the half-done layout a cut-off run left, with the duplicate
series folders overlapping runs made. 100 meetings with a slow frontend purge finish in well under a
minute. The model is always the fake client.
"""

from __future__ import annotations

import asyncio
import time
from datetime import timedelta
from unittest import mock

from tests.test_meetings_backfill import BackfillWorld, ago, g_title, standup  # noqa: F401  (pins settings first)

from bson import ObjectId

from app.config import get_settings
from app.services import meeting_organize as mo
from app.services import meetings, revalidate

settings = get_settings()


class OrganizeWorld(BackfillWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        settings.meetings_ai_enabled = False    # the AI isn't what's measured here
        self.ms: list[dict] = []

    async def seed(self, plan: list[tuple[str, int]]) -> list[dict]:
        """Meetings ``(title, days ago)``, imported, then put back as before folders: all in the
        Meetings folder itself, no series."""
        for title, d in plan:
            self.ms.append(await self.imported(sources=[{"name": g_title(title, ago(d)), "text": standup(f" {title} {d}")}]))
        await self.unorganize([m["id"] for m in self.ms])
        return self.ms

    async def root(self) -> dict:
        return await self.db["folders"].find_one({"workspace_id": self.W, "meetings": True})

    async def unorganize(self, ids: list[str]) -> None:
        root = str((await self.root())["_id"])
        for mid in ids:
            row = await self.db[meetings.COLL].find_one({"_id": ObjectId(mid)})
            await self.db[meetings.COLL].update_one({"_id": row["_id"]}, {
                "$set": {"series": None, "series_from": None, "folder_id": root}, "$unset": {"organize_run": ""}})
            for did in (row["doc_id"], row.get("transcript_doc_id")):
                if did:
                    await self.db["documents"].update_one({"_id": did}, {"$set": {"folder_id": root}})

    async def layout(self) -> dict[str, tuple[str, str]]:
        """{meeting id: (folder id, folder name)} — the page's folder (checked against the row's)."""
        out = {}
        async for r in self.db[meetings.COLL].find({"workspace_id": self.W}):
            page = await self.db["documents"].find_one({"_id": r["doc_id"]})
            self.assertEqual(page["folder_id"], r["folder_id"], r["title"])
            if r.get("transcript_doc_id"):
                t = await self.db["documents"].find_one({"_id": r["transcript_doc_id"]})
                self.assertEqual(t["folder_id"], r["folder_id"], f"{r['title']}: the transcript moved with its page")
            f = await self.db["folders"].find_one({"_id": ObjectId(r["folder_id"])})
            out[str(r["_id"])] = (r["folder_id"], f["name"])
        return out

    async def subfolders(self) -> list[dict]:
        root = await self.root()
        return await self.db["folders"].find({"workspace_id": self.W, "parent_id": str(root["_id"])}).to_list(length=200)

    async def finish(self) -> None:
        t = mo._tasks.get(self.W)
        if t is not None:
            await asyncio.wait({t}, timeout=120)

    async def status(self, who="wa") -> dict:
        r = await self.http.get("/api/v1/meetings/organize", params={"workspace": self.W}, headers=self.session(who))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()


MIX = [("Daily Sync Up", 9), ("Daily Syncup", 6), ("Daily Sync Up", 2), ("Weekly ops", 14), ("Weekly ops", 7),
       ("Kickoff", 20), ("Hiring loop", 3)]


class Lifecycle(OrganizeWorld):
    async def test_answers_at_once_with_progress_and_a_summary(self):
        await self.seed(MIX)
        st = await self.status()
        self.assertIsNone(st["job"])
        p = st["preview"]
        self.assertEqual((p["meetings"], p["series"], p["other"], p["to_move"], p["series_set"]), (7, 2, 2, 7, 5))
        self.assertEqual({s["name"] for s in p["series_names"]}, {"Daily Sync Up", "Weekly ops"})
        # Members and viewers can't; their requests are refused, not run.
        for who, code in (("wm", 403), ("wv", 403), ("stranger", 404)):
            r = await self.http.post("/api/v1/meetings/organize", headers=self.session(who), json={"workspace": self.W})
            self.assertEqual(r.status_code, code, who)
            r = await self.http.get("/api/v1/meetings/organize", params={"workspace": self.W}, headers=self.session(who))
            self.assertEqual(r.status_code, code, who)
        seen: list[int] = []
        real = mo._batch

        async def spy(db, job, user):
            n = await real(db, job, user)
            seen.append(int((await db[mo.JOBS].find_one({"_id": self.W}))["done"]))
            return n

        with mock.patch.object(mo, "BATCH", 3), mock.patch.object(mo, "_batch", spy):
            t0 = time.monotonic()
            r = await self.http.post("/api/v1/meetings/organize", headers=self.session("wa"), json={"workspace": self.W})
            self.assertLess(time.monotonic() - t0, 2.0)
            self.assertEqual(r.status_code, 202, r.text)
            job = r.json()["job"]
            self.assertEqual((job["state"], job["total"], job["done"]), ("running", 7, 0))
            await self.finish()
        self.assertEqual(seen[:3], [3, 6, 7])                                # progress, batch by batch
        r = await self.http.get(f"/api/v1/meetings/organize/{job['id']}", headers=self.session("wa"))
        v = r.json()["job"]
        self.assertEqual((v["state"], v["done"], v["total"], v["filed"], v["series_set"], v["errors"]), ("done", 7, 7, 7, 5, 0))
        self.assertEqual((v["series"], v["folders"]), (2, 3))               # 2 series + Other meetings
        names = sorted(n for _f, n in (await self.layout()).values())
        self.assertEqual(names, ["Daily Sync Up"] * 3 + ["Other meetings"] * 2 + ["Weekly ops"] * 2)
        # The run is the workspace admins' to see.
        for who in ("wm", "stranger"):
            r = await self.http.get(f"/api/v1/meetings/organize/{job['id']}", headers=self.session(who))
            self.assertEqual(r.status_code, 404, who)
        st = await self.status()
        self.assertEqual((st["preview"]["to_move"], st["preview"]["series_set"], st["job"]["id"]), (0, 0, job["id"]))
        # Again: a new run, nothing to do.
        again = await self.organize()
        self.assertNotEqual(again["id"], job["id"])
        self.assertEqual((again["filed"], again["series_set"], again["covers"], again["done"]), (0, 0, 0, 7))

    async def test_a_second_click_joins_the_running_run(self):
        await self.seed(MIX[:4])
        with mock.patch.object(mo, "kick", lambda db, job: None):          # nothing runs yet
            a, b = await asyncio.gather(*[self.http.post("/api/v1/meetings/organize", headers=self.session(w),
                                                         json={"workspace": self.W}) for w in ("wa", "wo")])
        self.assertEqual((a.status_code, b.status_code), (202, 202))
        self.assertEqual(a.json()["job"]["id"], b.json()["job"]["id"])
        self.assertEqual(await self.db[mo.JOBS].count_documents({}), 1)
        # The next poll picks it up (nobody holds it) and it runs once.
        await self.status()
        self.assertIn(self.W, mo._tasks)
        await self.status()
        await self.finish()
        v = (await self.status())["job"]
        self.assertEqual((v["state"], v["done"], v["filed"]), ("done", 4, 4))

    async def test_carries_on_after_a_restart(self):
        await self.seed(MIX)
        with mock.patch.object(mo, "kick", lambda db, job: None):
            r = await self.http.post("/api/v1/meetings/organize", headers=self.session("wa"), json={"workspace": self.W})
        run_id = r.json()["job"]["id"]
        # A process takes it, does one batch of two, and dies (its lease is left behind).
        user = await mo._admin(self.db, await self.db[mo.JOBS].find_one({"_id": self.W}))
        with mock.patch.object(mo, "_holder", lambda: "dead-process"):
            job = await mo._claim(self.db, self.W)
            job = await mo._prepare(self.db, job, user)
            with mock.patch.object(mo, "BATCH", 2):
                self.assertEqual(await mo._batch(self.db, job, user), 2)
        self.assertEqual(await self.db[meetings.COLL].count_documents({"organize_run": run_id}), 2)
        # While its lease runs, nobody else takes it over.
        await mo.background(self.db)
        await self.status()
        self.assertNotIn(self.W, mo._tasks)
        await self.db[mo.JOBS].update_one({"_id": self.W}, {"$set": {"lease.until": mo.now_utc() - timedelta(seconds=1)}})
        await mo.background(self.db)                                          # the loop carries on
        self.assertIn(self.W, mo._tasks)
        await self.finish()
        v = (await self.status())["job"]
        self.assertEqual((v["id"], v["state"], v["done"], v["total"], v["filed"], v["errors"]), (run_id, "done", 7, 7, 7, 0))
        names = sorted(n for _f, n in (await self.layout()).values())
        self.assertEqual(names, ["Daily Sync Up"] * 3 + ["Other meetings"] * 2 + ["Weekly ops"] * 2)

    async def test_one_meeting_failing_doesnt_stop_the_rest(self):
        await self.seed(MIX[:4])
        real = mo._one
        calls = {"n": 0}

        async def flaky(db, ws, r, plan, actor, ctx):
            calls["n"] += 1
            if calls["n"] == 2:
                raise RuntimeError("boom")
            return await real(db, ws, r, plan, actor, ctx)

        with mock.patch.object(mo, "_one", flaky):
            v = await self.organize()
        self.assertEqual((v["done"], v["errors"], v["filed"]), (4, 1, 3))
        self.assertEqual(len(v["error_samples"]), 1)
        self.assertEqual((await self.organize())["errors"], 0)               # the next run files it
        self.assertEqual((await self.status())["preview"]["to_move"], 0)

    async def test_a_former_admin_cannot_carry_it_on(self):
        await self.seed(MIX[:2])
        with mock.patch.object(mo, "kick", lambda db, job: None):
            await self.http.post("/api/v1/meetings/organize", headers=self.session("wa"), json={"workspace": self.W})
        await self.add_member("W1", "wa", "member")
        self.assertEqual(await mo.run(self.db, self.W), "failed")
        job = await self.db[mo.JOBS].find_one({"_id": self.W})
        self.assertIn("no longer an admin", job["message"])


class Idempotent(OrganizeWorld):
    async def test_after_a_cut_off_run_with_duplicate_folders(self):
        await self.seed(MIX)
        await self.organize()
        want = await self.layout()
        names_before = sorted(f["name"] for f in await self.subfolders())
        self.assertEqual(names_before, ["Daily Sync Up", "Other meetings", "Weekly ops"])
        # As two overlapping cut-off runs left it (the owner clicked twice): half the meetings back in the
        # Meetings folder without a series, and each series folder made twice — the extra "Weekly ops" made
        # FIRST (so it becomes the series' folder), the extra "Other meetings" made later.
        await self.unorganize([m["id"] for m in self.ms[::2]])
        root = await self.root()
        by = {f["name"]: f for f in await self.subfolders()}
        early = by["Weekly ops"]["created_at"] - timedelta(minutes=5)
        late = by["Other meetings"]["created_at"] + timedelta(minutes=5)
        for name, key, at in (("Weekly ops", {"meetings_series": "weekly ops"}, early),
                              ("Other meetings", {"meetings_other": True}, late)):
            await self.db["folders"].insert_one({"workspace_id": self.W, "parent_id": str(root["_id"]), "name": name,
                                                 "slug": f"{name.lower().replace(' ', '-')}-2", "meetings_sub": True,
                                                 "meetings_views": True, "properties": root.get("properties") or [],
                                                 "created_at": at, "updated_at": at, **key})
        v = await self.organize()
        self.assertEqual((v["errors"], v["duplicates_removed"]), (0, 2))
        got = await self.layout()
        self.assertEqual({k: n for k, (_f, n) in got.items()}, {k: n for k, (_f, n) in want.items()})
        # One folder per series, every meeting of a series in it (no duplicates).
        subs = await self.subfolders()
        self.assertEqual(sorted(f["name"] for f in subs), names_before)
        for name in ("Daily Sync Up", "Weekly ops", "Other meetings"):
            self.assertEqual(len({f for f, n in got.values() if n == name}), 1, name)
        # And once more: nothing to do.
        again = await self.organize()
        self.assertEqual((again["filed"], again["series_set"], again["covers"], again["duplicates_removed"]), (0, 0, 0, 0))
        self.assertEqual(await self.layout(), got)

    async def test_a_person_s_series_choice_stays(self):
        await self.seed(MIX[:3])
        a = self.ms[0]
        await self.db[meetings.COLL].update_one({"_id": ObjectId(a["id"])}, {"$set": {"series": None, "series_from": "user"}})
        await self.organize()
        lay = await self.layout()
        self.assertEqual(lay[a["id"]][1], "Other meetings")
        self.assertEqual({lay[m["id"]][1] for m in self.ms[1:]}, {"Daily Sync Up"})


class Scale(OrganizeWorld):
    async def test_100_meetings_with_a_slow_frontend_purge(self):
        plan = [(f"Standup {['Alpha', 'Beta', 'Gamma', 'Delta'][i % 4]}", 1 + i // 4) for i in range(60)]
        plan += [(f"One-off {w}", 1 + i % 40) for i, w in enumerate(
            "apple berry cedar delta ember fable grove harbor indigo juniper kestrel lumen maple nectar onyx "
            "pepper quartz raven sable tundra umber velvet willow xenon yarrow zephyr amber birch coral dune "
            "elm fjord garnet hazel iris jade koala lotus mosaic nimbus".split())]
        self.assertEqual(len(plan), 100)
        await self.seed(plan)
        posts = {"n": 0}

        async def slow_post(payload):   # Vercel's revalidate: ~150 ms a call
            posts["n"] += 1
            await asyncio.sleep(0.15)
            return 200

        with mock.patch.object(revalidate.settings, "page_revalidate_enabled", True), \
                mock.patch.object(revalidate, "_post", slow_post):
            t0 = time.monotonic()
            r = await self.http.post("/api/v1/meetings/organize", headers=self.session("wa"), json={"workspace": self.W})
            answered = time.monotonic() - t0
            self.assertEqual(r.status_code, 202, r.text)
            await self.finish()
            took = time.monotonic() - t0
            for t in list(revalidate._TASKS):
                await asyncio.wait({t}, timeout=30)
        v = (await self.status())["job"]
        print(f"\norganize 100 meetings: answered in {answered:.2f} s, done in {took:.1f} s, {posts['n']} purges sent")
        self.assertLess(answered, 2.0)
        self.assertLess(took, 60.0)
        self.assertEqual((v["state"], v["done"], v["filed"], v["errors"], v["series"]), ("done", 100, 100, 0, 4))
        names = [n for _f, n in (await self.layout()).values()]
        self.assertEqual(names.count("Other meetings"), 40)
        self.assertEqual(len(await self.subfolders()), 5)


class MCP(OrganizeWorld):
    async def test_organize_meetings_tool(self):
        await self.seed(MIX[:4])
        tok = await self.mcp_token("wa")
        code, res = await self.mcp_call(tok, "organize_meetings", {"workspace": self.W})
        self.assertFalse(res.get("isError"), res)
        sc = res["structuredContent"]
        self.assertEqual((sc["state"], sc["done"], sc["filed"]), ("done", 4, 4))
        self.assertIn("Organized 4 meetings", res["content"][0]["text"])
        # A big workspace: the tool returns the run and its progress, and a second call joins it.
        await self.unorganize([m["id"] for m in self.ms])
        from app.mcp import meeting_backfill_tools as tools

        with mock.patch.object(tools, "ORGANIZE_WAIT_S", 0.0):
            code, res = await self.mcp_call(tok, "organize_meetings", {"workspace": self.W})
            sc = res["structuredContent"]
            self.assertEqual(sc["state"], "running")
            self.assertIn("organize_meetings again", res["content"][0]["text"])
            code, res2 = await self.mcp_call(tok, "organize_meetings", {"workspace": self.W})
            if res2["structuredContent"]["state"] == "running":
                self.assertEqual(res2["structuredContent"]["id"], sc["id"])
        await self.finish()
        code, res = await self.mcp_call(await self.mcp_token("wm"), "organize_meetings", {"workspace": self.W})
        self.assertTrue(res.get("isError"))
