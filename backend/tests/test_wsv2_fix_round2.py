"""Regression tests for the Workspaces v2 adversarial fix round 2
(specs/wsv2-fix-round2.md). One class per finding id; each test failed on
feat/workspaces-v2 @ 913e3df and passes with its fix."""

from __future__ import annotations

import asyncio
import os
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


# ── 2. Grants: validity decided at read time ─────────────────────────────────


class _Grants(AccessWorld):
    async def grant(self, who: str, d: dict, email: str, role: str):
        return await self.http.post(f"/api/v1/documents/{d['slug']}/access/people",
                                    json={"email": email, "role": role, "notify": False},
                                    headers=self.session(who))

    async def person(self, name: str) -> str:
        self.email[name] = f"{name}@example.com"
        self.uid[name] = await self.make_user(self.email[name], name.upper())
        return self.email[name]

    async def rows(self, d: dict) -> dict:
        rows = await self.db["document_grants"].find({"document_id": str(d["_id"])}).to_list(500)
        return {g["email"].split("@")[0]: g for g in rows}

    async def reads(self, who: str, d: dict) -> int:
        return (await self.get(d["slug"], self.session(who))).status_code

    async def edits(self, who: str, d: dict) -> int:
        r = await self.http.put(f"/api/v1/documents/{d['slug']}", json={"content": "# changed"},
                                headers=self.session(who))
        return r.status_code

    async def insert(self, d: dict, email: str, role: str, *, by: str, parent=None, via=None, **extra):
        res = await self.db["document_grants"].insert_one({
            "document_id": str(d["_id"]), "email": email, "role": role, "created_at": now(),
            "granted_by_email": self.email.get(by), "granted_by_user_id": self.uid.get(by),
            "granted_via": via, "parent_grant_id": str(parent) if parent else None, **extra})
        return res.inserted_id


class CN1ReGrantCycles(_Grants):
    async def test_g1_regrant_never_rewrites_an_existing_grant(self):
        d = await self.mkdoc("W", grants=False, allow_resharing=True)
        await self.person("x")
        await self.person("y")
        self.assertEqual((await self.grant("wm", d, "x@example.com", "editor")).status_code, 201)
        self.assertEqual((await self.grant("x", d, "y@example.com", "editor")).status_code, 201)
        before = (await self.rows(d))["x"]
        r = await self.grant("y", d, "x@example.com", "editor")  # Y→X would close a cycle
        self.assertLess(r.status_code, 300, r.text)
        after = (await self.rows(d))["x"]
        for k in ("granted_by_user_id", "granted_via", "parent_grant_id", "role"):
            self.assertEqual(after.get(k), before.get(k), k)
        r = await self.http.delete(f"/api/v1/workspaces/{self.ws['W1']}/members/{self.uid['wm']}",
                                   headers=self.session("wo"))
        self.assertEqual(r.status_code, 204)
        self.assertEqual(await self.rows(d), {})
        self.assertEqual(await self.reads("x", d), 404)
        self.assertEqual(await self.reads("y", d), 404)

    async def test_a_cycle_gives_nothing_at_read_time(self):
        d = await self.mkdoc("P", ws=None, grants=False, allow_resharing=True)
        await self.person("x")
        await self.person("y")
        xid = await self.insert(d, "x@example.com", "editor", by="y")
        yid = await self.insert(d, "y@example.com", "editor", by="x", parent=xid)
        await self.db["document_grants"].update_one({"_id": xid}, {"$set": {"parent_grant_id": str(yid)}})
        self.assertEqual(await self.reads("x", d), 404)
        self.assertEqual(await self.reads("y", d), 404)


class CN2NoOverwriteByNonOwners(_Grants):
    async def test_g2_member_cannot_overwrite_the_owners_grant(self):
        d = await self.mkdoc("W", grants=False, allow_resharing=True)
        await self.person("x")
        self.assertEqual((await self.grant("owner", d, "x@example.com", "editor")).status_code, 201)
        r = await self.grant("wm", d, "x@example.com", "viewer")
        self.assertLess(r.status_code, 300, r.text)  # a no-op
        x = (await self.rows(d))["x"]
        self.assertEqual((x["role"], x["granted_by_user_id"], x.get("granted_via")),
                         ("editor", self.uid["owner"], None))
        await self.http.delete(f"/api/v1/workspaces/{self.ws['W1']}/members/{self.uid['wm']}",
                               headers=self.session("wo"))
        self.assertEqual(await self.reads("x", d), 200)  # M7: the owner's grant stays

    async def test_g3_grantee_cannot_downgrade_or_reparent_the_owners_grant(self):
        d = await self.mkdoc("P", ws=None, grants=False, allow_resharing=True)
        await self.person("x")
        await self.person("y")
        await self.grant("owner", d, "x@example.com", "viewer")
        await self.grant("owner", d, "y@example.com", "editor")
        r = await self.grant("x", d, "y@example.com", "viewer")
        self.assertLess(r.status_code, 300, r.text)
        y = (await self.rows(d))["y"]
        self.assertEqual((y["role"], y["granted_by_user_id"], y.get("parent_grant_id")),
                         ("editor", self.uid["owner"], None))
        r = await self.http.delete(f"/api/v1/documents/{d['slug']}/access/people/x@example.com",
                                   headers=self.session("x"))
        self.assertEqual(r.status_code, 204)
        self.assertEqual(await self.reads("y", d), 200)
        self.assertEqual(await self.edits("y", d), 200)

    async def test_higher_role_for_an_existing_grantee_is_409(self):
        d = await self.mkdoc("W", grants=False, allow_resharing=True)
        await self.person("x")
        await self.grant("owner", d, "x@example.com", "viewer")
        r = await self.grant("wm", d, "x@example.com", "editor")
        self.assertEqual(r.status_code, 409, r.text)
        self.assertEqual((await self.rows(d))["x"]["role"], "viewer")


class CN9ChainsAreBoundedAndCascade(_Grants):
    async def test_g4_deep_chains_are_refused_and_die_at_once(self):
        from app.services import access

        d = await self.mkdoc("W", grants=False, allow_resharing=True)
        names = [f"c{i}" for i in range(access.MAX_GRANT_DEPTH + 2)]
        for n in names:
            await self.person(n)
        prev, made = "wm", []
        for n in names:
            r = await self.grant(prev, d, f"{n}@example.com", "viewer")
            if r.status_code != 201:
                break
            made.append(n)
            prev = n
        self.assertEqual(len(made), access.MAX_GRANT_DEPTH + 1)  # the member's own grant is depth 0
        self.assertEqual(r.status_code, 403, r.text)
        self.assertEqual(await self.reads(made[-1], d), 200)
        await self.http.delete(f"/api/v1/workspaces/{self.ws['W1']}/members/{self.uid['wm']}",
                               headers=self.session("wo"))
        self.assertEqual(await self.rows(d), {})  # synchronous, no hop cap
        self.assertEqual(await self.reads(made[-1], d), 404)

    async def test_a_chain_deeper_than_the_cap_gives_nothing_at_read_time(self):
        from app.services import access

        d = await self.mkdoc("P", ws=None, grants=False, allow_resharing=True)
        prev, by = None, "owner"
        names = [f"k{i}" for i in range(access.MAX_GRANT_DEPTH + 2)]
        for n in names:
            await self.person(n)
            prev = await self.insert(d, f"{n}@example.com", "viewer", by=by, parent=prev)
            by = n
        self.assertEqual(await self.reads(names[access.MAX_GRANT_DEPTH], d), 200)
        self.assertEqual(await self.reads(names[access.MAX_GRANT_DEPTH + 1], d), 404)

    async def test_g5_owner_revoking_the_middle_cuts_everything_below(self):
        d = await self.mkdoc("P", ws=None, grants=False, allow_resharing=True)
        for n in ("a", "b", "c"):
            await self.person(n)
        await self.grant("owner", d, "a@example.com", "editor")
        await self.grant("a", d, "b@example.com", "editor")
        await self.grant("b", d, "c@example.com", "editor")
        r = await self.http.delete(f"/api/v1/documents/{d['slug']}/access/people/b@example.com",
                                   headers=self.session("owner"))
        self.assertEqual(r.status_code, 204)
        self.assertEqual(set(await self.rows(d)), {"a"})
        self.assertEqual(await self.reads("c", d), 404)
        self.assertEqual(await self.reads("a", d), 200)

    async def test_self_removal_cascades(self):
        d = await self.mkdoc("P", ws=None, grants=False, allow_resharing=True)
        await self.person("x")
        await self.person("y")
        await self.grant("owner", d, "x@example.com", "editor")
        await self.grant("x", d, "y@example.com", "viewer")
        r = await self.http.delete(f"/api/v1/documents/{d['slug']}/access/people/x@example.com",
                                   headers=self.session("x"))
        self.assertEqual(r.status_code, 204)
        self.assertEqual(await self.rows(d), {})
        self.assertEqual(await self.reads("y", d), 404)

    async def test_g6_owner_downgrade_caps_the_chain(self):
        d = await self.mkdoc("P", ws=None, grants=False, allow_resharing=True)
        await self.person("x")
        await self.person("y")
        await self.grant("owner", d, "x@example.com", "editor")
        await self.grant("x", d, "y@example.com", "editor")
        await self.grant("owner", d, "x@example.com", "viewer")
        self.assertEqual(await self.reads("y", d), 200)
        self.assertEqual(await self.edits("y", d), 403)
        self.assertEqual((await self.rows(d))["y"]["role"], "viewer")

    async def test_read_time_capping_without_any_cleanup(self):
        from app.services import access

        d = await self.mkdoc("P", ws=None, grants=False, allow_resharing=True)
        await self.person("x")
        await self.person("y")
        xid = await self.insert(d, "x@example.com", "viewer", by="owner")
        await self.insert(d, "y@example.com", "editor", by="x", parent=xid)  # never settled
        self.assertEqual(await self.reads("y", d), 200)
        self.assertEqual(await self.edits("y", d), 403)
        with mock.patch.object(access, "settle_document_grants", mock.AsyncMock(return_value=0)):
            await self.http.delete(f"/api/v1/documents/{d['slug']}/access/people/x@example.com",
                                   headers=self.session("owner"))
        self.assertEqual(await self.reads("y", d), 404)  # the row is still there; worth nothing


class MembershipAuthorityAtReadTime(_Grants):
    async def test_member_grant_dies_with_the_membership_without_cleanup(self):
        from app.services import lifecycle

        d = await self.mkdoc("W", grants=False, allow_resharing=True)
        await self.person("x")
        await self.grant("wm", d, "x@example.com", "editor")
        with mock.patch.object(lifecycle, "_settle_documents", mock.AsyncMock(return_value=0)):
            await self.http.delete(f"/api/v1/workspaces/{self.ws['W1']}/members/{self.uid['wm']}",
                                   headers=self.session("wo"))
        self.assertIsNotNone((await self.rows(d)).get("x"))
        self.assertEqual(await self.reads("x", d), 404)

    async def test_demotion_caps_at_read_time(self):
        from app.services import lifecycle

        d = await self.mkdoc("W", grants=False, allow_resharing=True)
        await self.person("x")
        await self.grant("wm", d, "x@example.com", "editor")
        with mock.patch.object(lifecycle, "_settle_documents", mock.AsyncMock(return_value=0)):
            await self.http.put(f"/api/v1/workspaces/{self.ws['W1']}/members/{self.uid['wm']}",
                                json={"role": "viewer"}, headers=self.session("wo"))
        self.assertEqual(await self.reads("x", d), 200)
        self.assertEqual(await self.edits("x", d), 403)

    async def test_member_grant_listing_marks_inactive_for_the_owner(self):
        d = await self.mkdoc("W", grants=False, allow_resharing=True)
        await self.insert(d, "z@example.com", "editor", by="former", via=self.ws["W1"])
        r = await self.http.get(f"/api/v1/documents/{d['slug']}/access", headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        z = next(g for g in r.json()["grants"] if g["email"] == "z@example.com")
        self.assertFalse(z["active"])

    async def test_reconciler_settles_old_dead_grants(self):
        from app.services import lifecycle

        d = await self.mkdoc("W", grants=False)
        await self.insert(d, "z@example.com", "editor", by="former", via=self.ws["W1"])
        await self.db["document_grants"].update_one(
            {"email": "z@example.com"}, {"$set": {"created_at": now() - timedelta(days=3)}})
        lifecycle._DELEGATION_CURSOR["after"] = None
        await lifecycle.reconcile_once(self.db)  # not the daily full pass
        self.assertIsNone(await self.db["document_grants"].find_one({"email": "z@example.com"}))

    async def test_listings_follow_the_chain(self):
        d = await self.mkdoc("P", grants=False)  # private, filed in W1
        await self.person("x")
        await self.add_member("W1", "x", "viewer")
        await self.insert(d, "x@example.com", "viewer", by="former", via=self.ws["W1"])
        r = await self.http.get(f"/api/v1/workspaces/{self.ws['W1']}/items", headers=self.session("x"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn(d["slug"], r.text)


class CN4GranterLostTheirGrant(_Grants):
    async def test_r5_parent_revoked_while_granting(self):
        from app.services import access as access_service

        d = await self.mkdoc("P", ws=None, grants=False, allow_resharing=True)
        await self.person("x")
        await self.grant("owner", d, "x@example.com", "editor")
        orig = access_service.add_grant
        gate = asyncio.Event()

        async def paused(db, raw, email, role, actor, ctx):
            if actor.email == "x@example.com":
                await access_service.require(actor, raw, "share", ctx)
                await access_service.facts(actor, raw, ctx)
                gate.set()
                await asyncio.sleep(0.2)
            return await orig(db, raw, email, role, actor, ctx)

        async def revoke():
            await gate.wait()
            return await self.http.delete(f"/api/v1/documents/{d['slug']}/access/people/x@example.com",
                                          headers=self.session("owner"))

        await self.person("z")
        with mock.patch.object(access_service, "add_grant", paused):
            g, rv = await asyncio.gather(self.grant("x", d, "z@example.com", "editor"), revoke())
        self.assertEqual(rv.status_code, 204)
        self.assertNotEqual(g.status_code, 201, g.text)
        self.assertIsNone((await self.rows(d)).get("z"))
        self.assertEqual(await self.reads("z", d), 404)

    async def test_revoke_landing_after_the_insert_still_gives_nothing(self):
        from app.services import access as access_service

        d = await self.mkdoc("P", ws=None, grants=False, allow_resharing=True)
        await self.person("x")
        await self.person("z")
        await self.grant("owner", d, "x@example.com", "editor")
        orig = access_service.document_grant_graph
        calls = {"n": 0}

        async def revoke_then_graph(db, document_id):
            calls["n"] += 1
            if calls["n"] == 2:  # the post-insert check: the owner revokes X just before it
                await db["document_grants"].delete_one({"document_id": document_id, "email": "x@example.com"})
            return await orig(db, document_id)

        with mock.patch.object(access_service, "document_grant_graph", revoke_then_graph):
            r = await self.grant("x", d, "z@example.com", "viewer")
        self.assertEqual(r.status_code, 403, r.text)
        self.assertEqual(await self.reads("z", d), 404)

    async def test_non_owner_root_without_authority_gives_nothing(self):
        d = await self.mkdoc("P", ws=None, grants=False, allow_resharing=True)
        await self.person("z")
        await self.insert(d, "z@example.com", "editor", by="stranger")  # no parent, no workspace
        self.assertEqual(await self.reads("z", d), 404)

    async def test_migration_links_legacy_reshares(self):
        from app.services import lifecycle

        d = await self.mkdoc("P", ws=None, grants=False, allow_resharing=True)
        await self.person("x")
        await self.person("z")
        await self.insert(d, "x@example.com", "editor", by="owner")
        await self.insert(d, "z@example.com", "viewer", by="x")  # pre-v2 re-share: no parent recorded
        self.assertEqual(await self.reads("z", d), 404)
        await self.db["migrations"].delete_many({})
        await lifecycle.migrate(self.db)
        self.assertEqual(await self.reads("z", d), 200)


# ── 3. Workspace deletion and toggles ─────────────────────────────────────────


class CN5DeletingWorkspaceIsClosed(AccessWorld):
    async def _delete(self, key="WR", name="Acme Private"):
        return await self.http.request("DELETE", f"/api/v1/workspaces/{self.ws[key]}",
                                       json={"confirm_name": name}, headers=self.session("wo"))

    async def test_h1_continuous_filing_cannot_hold_the_delete_hostage(self):
        from bson import ObjectId
        from app.services import lifecycle

        await self.mkdoc("RL")
        orig = lifecycle.release_db_first
        adds: list[int] = []

        async def filing_member(db, raw, ws_id, *, require_auth):
            out = await orig(db, raw, ws_id, require_auth=require_auth)
            mine = await self.mkdoc("L", ws=None, owner="wm")
            r = await self.http.post(f"/api/v1/workspaces/{ws_id}/items/add", json={"slugs": [mine["slug"]]},
                                     headers=self.session("wm"))
            adds.append(r.status_code)
            return out

        with mock.patch.object(lifecycle, "release_db_first", filing_member):
            r = await self._delete()
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(adds)
        self.assertTrue(all(code == 409 for code in adds), adds)
        self.assertIsNone(await self.db["workspaces"].find_one({"_id": ObjectId(self.ws["WR"])}))
        self.assertEqual(await self.db["documents"].count_documents({"workspace_id": self.ws["WR"]}), 0)

    async def test_h2_filing_after_the_release_is_refused(self):
        from app.services import domain as domain_service

        late = await self.mkdoc("L", ws=None, owner="wm", kind="artifact")
        orig = domain_service.detach_from_hosting
        state = {}

        async def slow_detach(host):
            r = await self.http.post(f"/api/v1/workspaces/{self.ws['WR']}/items/add",
                                     json={"slugs": [late["slug"]]}, headers=self.session("wm"))
            state["add"] = r.status_code
            return await orig(host)

        with mock.patch.object(domain_service, "detach_from_hosting", slow_detach):
            r = await self._delete()
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(state["add"], 409)
        row = await self.doc(late["slug"])
        self.assertIsNone(row.get("workspace_id"))

    async def test_h2_a_write_landing_after_the_release_is_swept(self):
        from app.services import domain as domain_service

        late = await self.mkdoc("L", ws=None, owner="wm", kind="artifact")
        orig = domain_service.detach_from_hosting

        async def lands_late(host):
            # A filing that passed its checks before the delete started writes now.
            await self.db["documents"].update_one({"_id": late["_id"]},
                                                  {"$set": {"workspace_id": self.ws["WR"]}})
            return await orig(host)

        with mock.patch.object(domain_service, "detach_from_hosting", lands_late):
            r = await self._delete()
        self.assertEqual(r.status_code, 200, r.text)
        row = await self.doc(late["slug"])
        self.assertIsNone(row.get("workspace_id"))
        self.assertEqual(row["access_level"], "private")  # left a sign-in workspace (Q2)
        self.assertEqual((await self.get(late["slug"])).status_code, 401)

    async def test_filing_that_lands_while_deleting_is_taken_back_out(self):
        from bson import ObjectId
        from app.services import folder as folder_service

        mine = await self.mkdoc("L", ws=None, owner="wm")
        orig = folder_service.assert_doc_fits

        async def deleting_meanwhile(db, ws_id, folder_id, slug):
            await db["workspaces"].update_one({"_id": ObjectId(ws_id)}, {"$set": {"deleting": True}})
            return await orig(db, ws_id, folder_id, slug)

        with mock.patch.object(folder_service, "assert_doc_fits", deleting_meanwhile):
            from app.services import library as lib_service
            from app.models.user import User

            user = User(id=self.uid["wm"], email=self.email["wm"], created_at=now(), updated_at=now())
            with self.assertRaises(Exception) as cm:
                await lib_service.add_document(self.db, self.ws["WR"], str(mine["_id"]), user)
        self.assertEqual(getattr(cm.exception, "status_code", None), 409)
        row = await self.doc(mine["slug"])
        self.assertIsNone(row.get("workspace_id"))
        self.assertEqual(row["access_level"], "private")  # it touched a sign-in workspace: never wider

    async def test_h1b_partial_release_reports_what_happened(self):
        from bson import ObjectId
        from app.services import lifecycle

        a = await self.mkdoc("RL")
        b = await self.mkdoc("RL")
        orig = lifecycle.release_db_first

        async def one_sticks(db, raw, ws_id, *, require_auth):
            if raw["_id"] == b["_id"]:
                return None
            return await orig(db, raw, ws_id, require_auth=require_auth)

        with mock.patch.object(lifecycle, "release_db_first", one_sticks):
            r = await self._delete()
        self.assertEqual(r.status_code, 409, r.text)
        self.assertNotIn("Nothing was deleted", r.text)
        self.assertIn("1 document", r.text)
        self.assertIsNone((await self.doc(a["slug"])).get("workspace_id"))
        ws = await self.db["workspaces"].find_one({"_id": ObjectId(self.ws["WR"])})
        self.assertTrue(ws.get("deleting"))
        mine = await self.mkdoc("L", ws=None, owner="wm")
        r = await self.http.post(f"/api/v1/workspaces/{self.ws['WR']}/items/add",
                                 json={"slugs": [mine["slug"]]}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 409, r.text)
        r = await self.http.post(f"/api/v1/workspaces/{self.ws['WR']}/folders", json={"name": "New"},
                                 headers=self.session("wm"))
        self.assertEqual(r.status_code, 409, r.text)
        r = await self._delete()  # a retry finishes it
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIsNone(await self.db["workspaces"].find_one({"_id": ObjectId(self.ws["WR"])}))


class CN8RequireAuthToggleRace(AccessWorld):
    async def test_h4_racing_toggles_end_with_bytes_matching_the_row(self):
        from bson import ObjectId
        from app.services import workspace as ws_service

        W = self.ws["WR"]
        a = await self.mkdoc("RL", kind="artifact")
        orig = ws_service.update_workspace
        b_read, a_written, b_written = asyncio.Event(), asyncio.Event(), asyncio.Event()
        calls = {"n": 0}

        async def upd(db, wid, **kw):
            calls["n"] += 1
            if calls["n"] == 1:      # A: OFF
                await b_read.wait()
                out = await orig(db, wid, **kw)
                a_written.set()
                await b_written.wait()
                return out
            b_read.set()             # B: ON, after A
            await a_written.wait()
            out = await orig(db, wid, **kw)
            b_written.set()
            return out

        with mock.patch.object(ws_service, "update_workspace", upd):
            ra, rb = await asyncio.gather(
                self.http.put(f"/api/v1/workspaces/{W}", json={"settings": {"require_auth_to_view": False}},
                              headers=self.session("wa")),
                self.http.put(f"/api/v1/workspaces/{W}", json={"settings": {"require_auth_to_view": True}},
                              headers=self.session("wo")))
        self.assertEqual((ra.status_code, rb.status_code), (200, 200))
        ws = await self.db["workspaces"].find_one({"_id": ObjectId(W)})
        self.assertTrue(ws["settings"]["require_auth_to_view"])
        self.assertTrue(ws["require_auth_applied"])
        self.assertFalse(self.r2.objects[a["blob_key"]]["public"])
        self.assertEqual((await self.get(a["slug"])).status_code, 401)

    async def test_toggle_follows_the_current_setting_not_the_request(self):
        from bson import ObjectId
        from app.services import lifecycle

        W = self.ws["W1"]
        a = await self.mkdoc("L", kind="artifact")
        self.assertTrue(self.r2.objects[a["blob_key"]]["public"])
        # The row says ON but nothing was applied yet (a request that wrote and died).
        await self.db["workspaces"].update_one({"_id": ObjectId(W)}, {"$set": {
            "settings.require_auth_to_view": True, "require_auth_applied": False}})
        await lifecycle.sync_require_auth(self.db, W)
        self.assertFalse(self.r2.objects[a["blob_key"]]["public"])
        ws = await self.db["workspaces"].find_one({"_id": ObjectId(W)})
        self.assertTrue(ws["require_auth_applied"])
        self.assertIsNone(ws.get("require_auth_lock"))


# ── Verification-agent additions ──────────────────────────────────────────────


class RedisOutageNeverFailsRequests(AccessWorld):
    """With Redis stopped or hung, rate-limited routes still answer (in-memory
    fallback, short socket timeouts) instead of 500 / blocking."""

    async def asyncSetUp(self):
        import shutil
        import socket
        import subprocess
        import tempfile

        await super().asyncSetUp()
        exe = shutil.which("redis-server") or "/opt/homebrew/bin/redis-server"
        if not os.path.exists(exe):
            self.skipTest("redis-server not installed")
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            self.port = s.getsockname()[1]
        self.tmp = tempfile.mkdtemp()
        self.redis = subprocess.Popen([exe, "--port", str(self.port), "--bind", "127.0.0.1", "--save", "",
                                       "--appendonly", "no", "--dir", self.tmp],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(self._stop_redis)
        for _ in range(50):
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.2):
                    break
            except OSError:
                await asyncio.sleep(0.05)

    def _stop_redis(self):
        import signal

        if self.redis.poll() is None:
            try:
                self.redis.send_signal(signal.SIGCONT)
            except Exception:
                pass
            self.redis.kill()
            self.redis.wait(timeout=5)

    @contextmanager
    def app_limiter_on_redis(self):
        from limits.storage import storage_from_string
        from limits.strategies import STRATEGIES

        from app import limiter as limiter_mod
        from app.limiter import limiter

        # The options production uses for a Redis URL (the test settings use memory://).
        options = getattr(limiter_mod, "STORAGE_OPTIONS", {})
        storage = storage_from_string(f"redis://127.0.0.1:{self.port}/0", **options)
        strategy = STRATEGIES[limiter._strategy or "fixed-window"](storage)
        with mock.patch.object(limiter, "_storage", storage), \
                mock.patch.object(limiter, "_limiter", strategy), \
                mock.patch.object(limiter, "_storage_dead", False), \
                mock.patch.object(limiter, "enabled", True):
            yield

    async def _hit(self, d):
        a = await asyncio.wait_for(self.get(d["slug"]), 5)
        b = await asyncio.wait_for(self.http.get(f"/api/v1/og/{d['slug']}.png"), 5)
        return a.status_code, b.status_code

    async def test_redis_stopped(self):
        d = await self.mkdoc("L", ws=None)
        with self.app_limiter_on_redis():
            self.assertEqual(await self._hit(d), (200, 200))
            self.redis.kill()
            self.redis.wait(timeout=5)
            for _ in range(3):
                self.assertEqual(await self._hit(d), (200, 200))

    async def test_redis_hung(self):
        import signal

        d = await self.mkdoc("L", ws=None)
        with self.app_limiter_on_redis():
            self.assertEqual(await self._hit(d), (200, 200))
            self.redis.send_signal(signal.SIGSTOP)
            # A blocked event loop can't time itself out: resume Redis after
            # 10 s from a thread so a regression fails instead of hanging.
            import threading

            timer = threading.Timer(10, lambda: self.redis.send_signal(signal.SIGCONT))
            timer.start()
            self.addCleanup(timer.cancel)
            t0 = time.monotonic()
            codes = [await self._hit(d) for _ in range(3)]
            elapsed = time.monotonic() - t0
            self.assertEqual(codes, [(200, 200)] * 3)
            self.assertLess(elapsed, 6)


class McpLinkKeepsThePassword(AccessWorld):
    async def call(self, who: str, tool: str, args: dict) -> dict:
        return (await self.mcp_call(await self.mcp_token(who), tool, args))[1]

    async def test_private_then_link_reopens_with_the_password(self):
        d = await self.mkdoc("LP", ws=None)
        res = await self.call("owner", "set_access", {"document": d["slug"], "access": "private"})
        self.assertFalse(res.get("isError"), res)
        res = await self.call("owner", "set_access", {"document": d["slug"], "access": "link"})
        self.assertFalse(res.get("isError"), res)
        self.assertEqual(res["structuredContent"]["access"], "password")
        self.assertIn("remove_password", res["content"][0]["text"])
        row = await self.doc(d["slug"])
        self.assertEqual(row["access_level"], "link")
        self.assertTrue(row.get("read_password_hash"))
        r = await self.get(d["slug"])
        self.assertEqual((r.status_code, r.headers.get("x-markdrop-gate")), (401, "password"))

    async def test_remove_password_only_with_link(self):
        d = await self.mkdoc("LP", ws=None)
        res = await self.call("owner", "set_access", {"document": d["slug"], "access": "private",
                                                       "remove_password": True})
        self.assertTrue(res.get("isError"), res)
        self.assertTrue((await self.doc(d["slug"])).get("read_password_hash"))


# ── 4. Lookup / oracle / routing ──────────────────────────────────────────────


class CN3McpWorkspaceReferences(AccessWorld):
    async def _attacker(self, name: str) -> None:
        from bson import ObjectId

        await self.db["workspaces"].update_one({"_id": ObjectId(self.ws["W2"])}, {"$set": {"name": name}})
        await self.add_member("W2", "wm", "member")

    async def _publish(self, ref: str):
        _s, res = await self.mcp_call(await self.mcp_token("wm"), "publish_document",
                                      {"markdown": "# secret", "workspace": ref})
        if res.get("isError"):
            return None, res["content"][0]["text"]
        return (await self.doc(res["structuredContent"]["slug"]))["workspace_id"], ""

    async def test_r1_pending_domain_beats_a_workspace_named_after_it(self):
        await self.db["domains"].update_many({"workspace_id": self.ws["W1"]}, {"$set": {"status": "pending"}})
        await self._attacker("docs.acme.test")
        for ref in ("docs.acme.test", "https://docs.acme.test/"):
            ws_id, err = await self._publish(ref)
            self.assertEqual(ws_id, self.ws["W1"], err)

    async def test_host_shaped_reference_never_matches_a_name(self):
        await self._attacker("unknown.example")
        ws_id, err = await self._publish("unknown.example")
        self.assertIsNone(ws_id)
        self.assertIn("domain", err)

    async def test_lookalike_names_are_refused(self):
        for name in ("Αcme", "Acme​", "Acme ", "ACME"):
            await self._attacker(name)
            ws_id, err = await self._publish("Acme")
            self.assertIsNone(ws_id, name)
            self.assertIn("looks like", err)


class CN7CollisionsRevealNothing(AccessWorld):
    async def test_h5_folder_delete_is_not_blocked_by_an_invisible_document(self):
        from app.services import folder as folder_service

        W = self.ws["W1"]
        g = await folder_service.create_folder(self.db, W, "Guides", None)
        x = await folder_service.create_folder(self.db, W, "X", None)
        hidden = await self.mkdoc("P", slug="guides", folder_id=x.id, folder_path=["x"], grants=False)
        r = await self.http.delete(f"/api/v1/workspaces/{W}/folders/{x.id}", headers=self.session("wa"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn("guides", r.text)
        row = await self.doc(hidden["slug"])
        self.assertIsNone(row.get("folder_id"))
        moved = await self.db["folders"].find_one({"_id": __import__("bson").ObjectId(g.id)})
        self.assertNotEqual(moved["slug"], "guides")  # the folder stepped aside

    async def test_folder_delete_blocked_by_a_readable_document_says_so(self):
        from app.services import folder as folder_service

        W = self.ws["W1"]
        await folder_service.create_folder(self.db, W, "Guides", None)
        x = await folder_service.create_folder(self.db, W, "X", None)
        await self.mkdoc("W", slug="guides", folder_id=x.id, folder_path=["x"], grants=False)
        r = await self.http.delete(f"/api/v1/workspaces/{W}/folders/{x.id}", headers=self.session("wa"))
        self.assertEqual(r.status_code, 409, r.text)
        self.assertIn("guides", r.text)

    async def test_folder_create_next_to_a_private_document_is_no_oracle(self):
        W = self.ws["W1"]
        await self.mkdoc("P", slug="secret-plan-q3", grants=False)
        a = await self.http.post(f"/api/v1/workspaces/{W}/folders", json={"name": "secret-plan-q3"},
                                 headers=self.session("wm"))
        b = await self.http.post(f"/api/v1/workspaces/{W}/folders", json={"name": "no-such-thing-q3"},
                                 headers=self.session("wm"))
        self.assertEqual((a.status_code, b.status_code), (201, 201), a.text)
        self.assertNotEqual(a.json()["slug"], "secret-plan-q3")

    async def test_clash_message_never_names_an_unreadable_slug(self):
        from app.services import folder as folder_service

        self.assertNotIn("secret", folder_service._clash_detail(None))


class BN2FoldersOwnTheirAddress(AccessWorld):
    async def _setup(self):
        from app.services import folder as folder_service

        W = self.ws["W1"]
        await folder_service.create_folder(self.db, W, "Secret Plans", None)  # /secret-plans
        x = await folder_service.create_folder(self.db, W, "X", None)
        return x

    def _scoped(self, path: str | None) -> dict:
        h = {"X-Markdrop-Workspace": self.ws["W1"]}
        if path is not None:
            h["X-Markdrop-Path"] = path
        return h

    async def test_doc_filed_elsewhere_cannot_take_a_folder_address(self):
        x = await self._setup()
        d = await self.mkdoc("L", owner="wm", slug="secret-plans", folder_id=x.id, folder_path=["x"])
        self.assertEqual((await self.get(d["slug"], self._scoped("secret-plans"))).status_code, 404)
        self.assertEqual((await self.get(d["slug"], self._scoped("x/secret-plans"))).status_code, 200)
        self.assertEqual((await self.get(d["slug"], self._scoped(None))).status_code, 200)
        self.assertEqual((await self.get(d["slug"])).status_code, 200)  # markdrop.in unchanged

    async def test_old_slug_cannot_take_a_folder_address(self):
        x = await self._setup()
        await self.mkdoc("L", owner="wm", slug="current-x", folder_id=x.id, folder_path=["x"],
                         old_slugs=["secret-plans"])
        self.assertEqual((await self.get("secret-plans", self._scoped("secret-plans"))).status_code, 404)
        r = await self.get("secret-plans", self._scoped("x/secret-plans"))
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json().get("moved"))


class SmallBHostFolderFace(AccessWorld):
    async def test_stranger_on_a_sign_in_site_learns_no_id_or_internal_name(self):
        from bson import ObjectId

        await self.db["workspaces"].update_one({"_id": ObjectId(self.ws["WR"])},
                                               {"$set": {"branding.site_name": "Acme Help"}})
        r = await self.http.get("/api/v1/host/folder", params={"host": "docs-r.acme.test", "path": ""},
                                headers=self.session("stranger"))
        self.assertIn(r.status_code, (200, 404), r.text)
        self.assertNotIn(self.ws["WR"], r.text)
        self.assertNotIn("Acme Private", r.text)
        r = await self.http.get("/api/v1/host/folder", params={"host": "docs-r.acme.test", "path": ""},
                                headers=self.session("wv"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["workspace"]["id"], self.ws["WR"])  # members still get it
