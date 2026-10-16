"""Campaign engine against a real MongoDB (throwaway database).

Covers queue snapshots and exclusions, batching, the claim/lease model,
pause/cancel between rounds, retries, fatal errors, rate limits, send-time
suppression re-checks, top-ups, scheduling, and restart recovery without
duplicates.
"""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from tests import _email_env as env

from app.config import get_settings
from app.services.email_campaigns import audience, engine, render, store, templates, transport

settings = get_settings()


class FakeTransport:
    """Records every provider call; scripted failures."""

    name = "fake"

    def __init__(self, fail: set[str] | None = None, errors: list[Exception] | None = None, on_send=None):
        self.calls: list[tuple[str, list[str]]] = []
        self.fail = fail or set()
        self.errors = list(errors or [])
        self.on_send = on_send
        self.n = 0

    async def send_batch(self, messages, key):
        if self.errors:
            e = self.errors.pop(0)
            if e is not None:
                self.calls.append((key, []))
                raise e
        self.calls.append((key, [m["to"][0] for m in messages]))
        if self.on_send:
            await self.on_send(self)
        out = []
        for m in messages:
            to = m["to"][0]
            self.n += 1
            out.append(transport.Outcome(None, "rejected by fake") if to in self.fail else transport.Outcome(f"fake-{self.n}", None))
        return out

    def sent_to(self) -> list[str]:
        return [e for _, emails in self.calls for e in emails]


def draft(emails: list[str], **kw):
    t = templates.get_template("newsletter")
    return render.parse_content({
        "name": "Engine test", "subject": t["subject"], "subject_fallback": t["subject_fallback"],
        "preheader": t["preheader"], "doc": t["doc"], "template": "newsletter",
        "audience": {"kind": "custom", "emails": "\n".join(emails)}, **kw,
    })


@unittest.skipUnless(env.MONGO, "MongoDB not reachable")
class Engine(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.name = env.new_db_name()
        self.client, self.db = await env.make_db(self.name)
        audience.invalidate()
        self._batch = settings.email_batch_size
        settings.email_batch_size = 10
        settings.email_round_gap_ms = 0

    async def asyncTearDown(self):
        settings.email_batch_size = self._batch
        audience.invalidate()
        await self.client.drop_database(self.name)
        self.client.close()

    async def make(self, n=25, extra: list[str] | None = None, **kw):
        emails = [f"r{i:03d}@example.com" for i in range(n)] + (extra or [])
        c = await engine.create(self.db, draft(emails, **kw), "admin")
        return c, emails

    async def queue_all(self, c):
        cnt = (await engine.pending(self.db, c))["count"]["eligible"]
        return await engine.queue(self.db, str(c["_id"]), f"send to {cnt}", "admin")

    async def run_until_done(self, c, t, owner="w1", rounds=20):
        last = None
        for _ in range(rounds):
            last = await engine.tick(self.db, c["_id"], budget_s=30, t=t, owner=owner)
            if last["done"] or last["error"]:
                break
        return last

    async def test_queue_snapshot_exclusions_and_confirm(self):
        await self.db["users"].insert_many([
            {"email": "gone@example.com", "name": "Gone", "unsubscribed_at": datetime.now(timezone.utc)},
            {"email": "acct@example.com", "name": "Acct Person"},
        ])
        await store.suppress(self.db, "bounced@example.com", "bounced")
        c, _ = await self.make(3, extra=["R000@example.com", "gone@example.com", "bounced@example.com", "acct@example.com", "nope@", "x"])
        res = await engine.pending(self.db, c)
        cnt = res["count"]
        self.assertEqual(cnt["eligible"], 4)
        self.assertEqual(cnt["duplicates"], 1)
        self.assertEqual(cnt["unsubscribed"], 1)
        self.assertEqual(cnt["suppressed"], 1)
        self.assertEqual(cnt["invalid"], 2)
        with self.assertRaises(engine.EngineError) as e:
            await engine.queue(self.db, str(c["_id"]), "send to 5", "admin")
        self.assertEqual(e.exception.extra["expected"], "send to 4")
        out = await engine.queue(self.db, str(c["_id"]), "  SEND TO 4 ", "admin")
        self.assertEqual(out["added"], 4)
        self.assertEqual(out["campaign"]["status"], "sending")
        rows = await self.db["email_messages"].find({"campaign_id": c["_id"]}).to_list(None)
        self.assertEqual(len({r["token"] for r in rows}), 4)
        self.assertTrue(all(len(r["token"]) == 24 for r in rows))
        acct = next(r for r in rows if r["email"] == "acct@example.com")
        self.assertEqual(acct["name"], "Acct Person")
        self.assertIsNotNone(acct["user_id"])

    async def test_sends_in_batches_and_finishes(self):
        c, emails = await self.make(25)
        await self.queue_all(c)
        t = FakeTransport()
        r = await self.run_until_done(c, t)
        self.assertEqual(r["campaign"]["status"], "sent")
        self.assertEqual(sorted(t.sent_to()), sorted(emails))
        self.assertEqual([len(x[1]) for x in t.calls], [10, 10, 5])
        self.assertEqual(len({k for k, _ in t.calls}), 3)  # one idempotency key per batch
        counts = await store.counts(self.db, c["_id"])
        self.assertEqual((counts["sent"], counts["queued"], counts["sending"]), (25, 0, 0))
        m = await self.db["email_messages"].find_one({"campaign_id": c["_id"]})
        self.assertTrue(m["provider_id"].startswith("fake-"))
        self.assertEqual(m["vars"]["email"], m["email"])
        batches = await self.db["email_batches"].find({"campaign_id": c["_id"]}).to_list(None)
        self.assertTrue(batches and all(b["state"] == "done" for b in batches))

    async def test_failures_retry_and_suppression_recheck(self):
        c, emails = await self.make(12)
        await self.queue_all(c)
        await store.suppress(self.db, emails[3], "complained")  # after queueing
        await store.suppress(self.db, emails[4], "unsubscribed")
        t = FakeTransport(fail={emails[0]})
        r = await self.run_until_done(c, t)
        self.assertEqual(r["campaign"]["status"], "sent")
        counts = await store.counts(self.db, c["_id"])
        self.assertEqual((counts["sent"], counts["failed"], counts["skipped"]), (9, 1, 2))
        self.assertNotIn(emails[3], t.sent_to())
        skipped = {m["email"]: m["error"] async for m in self.db["email_messages"].find({"status": "skipped"})}
        self.assertEqual(skipped, {emails[3]: "suppressed", emails[4]: "unsubscribed"})
        out = await engine.control(self.db, str(c["_id"]), "retry")
        self.assertEqual(out["requeued"], 1)
        self.assertEqual(out["campaign"]["status"], "sending")
        t2 = FakeTransport()
        r = await self.run_until_done(c, t2)
        self.assertEqual(t2.sent_to(), [emails[0]])
        self.assertEqual(r["campaign"]["counts"]["sent"], 10)

    async def test_fatal_error_pauses_and_resume_continues(self):
        c, emails = await self.make(15)
        await self.queue_all(c)
        t = FakeTransport(errors=[None, transport.SendError("Resend refused the batch: domain not verified", fatal=True)])
        r = await self.run_until_done(c, t)
        self.assertEqual(r["campaign"]["status"], "paused")
        self.assertIn("not verified", r["campaign"]["last_error"])
        counts = await store.counts(self.db, c["_id"])
        self.assertEqual((counts["sent"], counts["queued"], counts["sending"]), (10, 5, 0))
        out = await engine.control(self.db, str(c["_id"]), "resume")
        self.assertIsNone(out["campaign"]["last_error"])
        t2 = FakeTransport()
        r = await self.run_until_done(c, t2)
        self.assertEqual(r["campaign"]["status"], "sent")
        self.assertEqual(sorted(t.sent_to() + t2.sent_to()), sorted(emails))

    async def test_rate_limit_retries_same_key(self):
        c, _ = await self.make(5)
        await self.queue_all(c)
        t = FakeTransport(errors=[transport.SendError("slow down", retry_after=0.01)])
        r = await self.run_until_done(c, t)
        self.assertEqual(r["campaign"]["status"], "sent")
        self.assertEqual(len(t.calls), 2)
        self.assertEqual(t.calls[0][0], t.calls[1][0])

    async def test_transient_errors_back_off_then_pause(self):
        c, _ = await self.make(5)
        await self.queue_all(c)
        t = FakeTransport(errors=[transport.SendError("Couldn't reach Resend")] * 10)
        for i in range(engine.MAX_TRANSIENT):
            r = await engine.tick(self.db, c["_id"], t=t, owner="w1")
        self.assertEqual(r["campaign"]["status"], "paused")
        self.assertIn("failed attempts in a row", r["campaign"]["last_error"])
        self.assertEqual((await store.counts(self.db, c["_id"]))["queued"], 5)

    async def test_pause_and_cancel_between_rounds(self):
        c, _ = await self.make(30)
        await self.queue_all(c)

        async def pause_once(tr):
            if len(tr.calls) == 1:
                await engine.control(self.db, str(c["_id"]), "pause")

        t = FakeTransport(on_send=pause_once)
        r = await engine.tick(self.db, c["_id"], t=t, owner="w1")
        self.assertEqual(r["campaign"]["status"], "paused")
        self.assertEqual(len(t.calls), 1)  # the batch in flight finished, nothing after
        out = await engine.control(self.db, str(c["_id"]), "cancel")
        self.assertEqual(out["skipped"], 20)
        self.assertEqual(out["campaign"]["status"], "cancelled")
        r = await engine.tick(self.db, c["_id"], t=t, owner="w1")
        self.assertTrue(r["done"])
        self.assertEqual(len(t.calls), 1)
        with self.assertRaises(engine.EngineError):
            await engine.control(self.db, str(c["_id"]), "resume")

    async def test_lease_blocks_second_sender_and_claims_are_exclusive(self):
        c, _ = await self.make(5)
        await self.queue_all(c)
        self.assertTrue(await store.acquire_lease(self.db, c["_id"], "other", 60))
        r = await engine.tick(self.db, c["_id"], t=FakeTransport(), owner="w1")
        self.assertTrue(r["busy"])
        await store.release_lease(self.db, c["_id"], "other")
        ids = [m["_id"] for m in await store.peek_queued(self.db, c["_id"], 5)]
        a = await store.claim(self.db, ids, "claim-a")
        b = await store.claim(self.db, ids, "claim-b")
        self.assertEqual((len(a), len(b)), (5, 0))

    async def test_restart_recovery_never_duplicates(self):
        """A worker died: one batch claimed but never posted, one mid-request."""
        c, emails = await self.make(25)
        await self.queue_all(c)
        cid = c["_id"]
        sender = {"from_name": "Markdrop", "from_email": "updates@markdrop.in", "reply_to": None}
        await store.update_campaign(self.db, cid, {"sender": sender})
        ids = [m["_id"] for m in await store.peek_queued(self.db, cid, 20)]
        old = datetime.now(timezone.utc) - timedelta(minutes=10)
        # batch A: claimed, nothing sent
        await self.db["email_batches"].insert_one({"_id": "deadA", "campaign_id": cid, "state": "claimed", "created_at": old, "updated_at": old})
        await store.claim(self.db, ids[:10], "deadA")
        # batch B: posting with vars stored (the request may have reached Resend)
        await self.db["email_batches"].insert_one({"_id": "deadB", "campaign_id": cid, "state": "posting",
                                                   "idem_key": "md-key-B", "created_at": old, "updated_at": old})
        rows_b = await store.claim(self.db, ids[10:20], "deadB")
        vm = await audience.merge_vars_for(self.db, [m["email"] for m in rows_b])
        for m in rows_b:
            await self.db["email_messages"].update_one({"_id": m["_id"]}, {"$set": {"vars": vm[m["email"]]}})
        # the dead worker's lease has expired
        await self.db["email_campaigns"].update_one({"_id": cid}, {"$set": {"lock_owner": "dead", "lock_until": old}})

        t = FakeTransport()
        r = await self.run_until_done(c, t, owner="fresh")
        self.assertEqual(r["campaign"]["status"], "sent")
        self.assertEqual(t.calls[0][0], "md-key-B")  # re-posted with the SAME key
        sent = t.sent_to()
        self.assertEqual(sorted(sent), sorted(emails))
        self.assertEqual(len(sent), len(set(sent)))  # nobody twice
        states = {b["_id"]: b["state"] async for b in self.db["email_batches"].find({"_id": {"$in": ["deadA", "deadB"]}})}
        self.assertEqual(states, {"deadA": "released", "deadB": "done"})

    async def test_recovery_conflict_means_already_sent(self):
        c, _ = await self.make(3)
        await self.queue_all(c)
        cid = c["_id"]
        old = datetime.now(timezone.utc) - timedelta(minutes=10)
        ids = [m["_id"] for m in await store.peek_queued(self.db, cid, 3)]
        await self.db["email_batches"].insert_one({"_id": "deadC", "campaign_id": cid, "state": "posting",
                                                   "idem_key": "md-key-C", "created_at": old, "updated_at": old})
        await store.claim(self.db, ids, "deadC")
        t = FakeTransport(errors=[transport.SendError("conflict", code="invalid_idempotent_request")])
        r = await self.run_until_done(c, t, owner="fresh")
        self.assertEqual(r["campaign"]["counts"]["sent"], 3)
        self.assertEqual(t.sent_to(), [])
        m = await self.db["email_messages"].find_one({"_id": ids[0]})
        self.assertIn("before a restart", m["error"])

    async def test_top_up_adds_only_new_people(self):
        c, emails = await self.make(4)
        await self.queue_all(c)
        await self.run_until_done(c, FakeTransport())
        spec = {**c["audience"], "emails": c["audience"]["emails"] + "\nnew1@example.com\nnew2@example.com"}
        await self.db["email_campaigns"].update_one({"_id": c["_id"]}, {"$set": {"audience": spec}})
        c = await store.get_campaign(self.db, c["_id"])
        res = await engine.pending(self.db, c)
        self.assertEqual((res["count"]["eligible"], res["count"]["already"]), (2, 4))
        out = await engine.queue(self.db, str(c["_id"]), "send to 2", "admin")
        self.assertEqual(out["added"], 2)
        t = FakeTransport()
        await self.run_until_done(c, t)
        self.assertEqual(sorted(t.sent_to()), ["new1@example.com", "new2@example.com"])

    async def test_schedule_unschedule_and_promote(self):
        c, _ = await self.make(3)
        when = datetime.now(timezone.utc) + timedelta(hours=1)
        out = await engine.queue(self.db, str(c["_id"]), "send to 3", "admin", scheduled_at=when)
        self.assertEqual(out["campaign"]["status"], "scheduled")
        r = await engine.tick(self.db, c["_id"], t=FakeTransport(), owner="w1")
        self.assertTrue(r["done"])  # not due: nothing sends
        self.assertEqual(await engine.promote_scheduled(self.db), 0)
        out = await engine.control(self.db, str(c["_id"]), "unschedule")
        self.assertEqual((out["campaign"]["status"], out["removed"]), ("draft", 3))
        out = await engine.queue(self.db, str(c["_id"]), "send to 3", "admin", scheduled_at=when)
        await self.db["email_campaigns"].update_one({"_id": c["_id"]}, {"$set": {"scheduled_at": datetime.now(timezone.utc) - timedelta(seconds=1)}})
        self.assertEqual(await engine.promote_scheduled(self.db), 1)
        r = await self.run_until_done(c, FakeTransport())
        self.assertEqual(r["campaign"]["status"], "sent")
        with self.assertRaises(engine.EngineError):
            await engine.queue(self.db, str(c["_id"]), "send to 0", "admin", scheduled_at=datetime.now(timezone.utc) + timedelta(seconds=5))

    async def test_requeue_stuck_and_delete_rules(self):
        c, _ = await self.make(3)
        await self.queue_all(c)
        ids = [m["_id"] for m in await store.peek_queued(self.db, c["_id"], 3)]
        await store.claim(self.db, ids[:1], "lost")
        await self.db["email_messages"].update_one({"_id": ids[0]}, {"$set": {"claimed_at": datetime.now(timezone.utc) - timedelta(minutes=6)}})
        self.assertEqual((await store.counts(self.db, c["_id"]))["stuck"], 1)
        out = await engine.control(self.db, str(c["_id"]), "retry", failed=False, stuck=True)
        self.assertEqual(out["requeued"], 1)
        with self.assertRaises(engine.EngineError) as e:
            await engine.delete(self.db, str(c["_id"]))
        self.assertEqual(e.exception.status, 409)
        await engine.control(self.db, str(c["_id"]), "cancel")
        await engine.delete(self.db, str(c["_id"]))
        self.assertEqual(await self.db["email_messages"].count_documents({"campaign_id": c["_id"]}), 0)

    async def test_problems_block_queue_and_drafts_only_edit(self):
        c = await engine.create(self.db, draft(["a@example.com"], subject=""), "admin")
        with self.assertRaises(engine.EngineError) as e:
            await engine.queue(self.db, str(c["_id"]), "send to 1", "admin")
        self.assertIn("Subject is empty", str(e.exception))
        c2, _ = await self.make(1)
        await self.queue_all(c2)
        with self.assertRaises(engine.EngineError) as e:
            await engine.update_draft(self.db, str(c2["_id"]), draft(["b@example.com"]))
        self.assertEqual(e.exception.status, 409)
        dup = await engine.duplicate(self.db, str(c2["_id"]), "admin")
        self.assertEqual((dup["status"], dup["name"]), ("draft", "Engine test (copy)"))

    async def test_send_test_console(self):
        await self.db["users"].insert_one({"email": "priya@example.com", "name": "Priya Raman"})
        out = await engine.send_test(self.db, draft(["x@example.com"]), "admin@example.com", "priya@example.com")
        self.assertEqual(out["mode"], "console")
        self.assertTrue(out["subject"].startswith("[test] Priya"))
        row = await self.db["email_outbox"].find_one({"_id": out["provider_id"]})
        self.assertEqual(row["to"], "admin@example.com")
        self.assertIn("/api/v1/email/u/test", row["headers"]["List-Unsubscribe"])
        self.assertEqual(row["headers"]["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click")


if __name__ == "__main__":
    unittest.main()
