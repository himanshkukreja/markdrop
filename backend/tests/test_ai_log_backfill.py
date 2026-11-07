"""scripts/backfill_ai_log.py: saved Ask / meetings conversations and docs Ask AI ledger rows from
before the AI request log become ``ai_log`` rows like the live ones (label, actor, workspace,
conversation, masking, the content setting), marked ``backfilled``; a dry run writes nothing and a
second run adds nothing. Fixtures only: no model calls, no backend/.env.
"""

from __future__ import annotations

import contextlib
import io
import secrets
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

from tests import _email_env as env  # noqa: F401  (pins settings first)

from bson import ObjectId

from app import database
from app.config import get_settings
from app.routers import admin_ai_log
from app.services import ai_log, ai_usage
from scripts import backfill_ai_log as script

settings = get_settings()
NOW = datetime.now(timezone.utc).replace(microsecond=0)


def ago(**kw) -> datetime:
    return NOW - timedelta(**kw)


class Backfill(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.saved = {k: getattr(settings, k) for k in ("mongodb_db", "ai_log_internal_ips")}
        self.db_name = f"markdrop_test_ai_log_bf_{secrets.token_hex(4)}"
        if env.MONGO:
            from motor.motor_asyncio import AsyncIOMotorClient

            self.client = AsyncIOMotorClient(env.MONGO_URI)
        else:
            from mongomock_motor import AsyncMongoMockClient

            self.client = AsyncMongoMockClient()
        self.db = self.client[self.db_name]
        self._saved_client = database._client
        database._client = self.client
        settings.mongodb_db = self.db_name
        settings.ai_log_internal_ips = ""
        await ai_usage.ensure_indexes(self.db)
        await ai_log.ensure_indexes(self.db)
        ai_usage.invalidate_settings()
        ai_log.invalidate()
        db = self.db
        self.ana = str((await db["users"].insert_one({"email": "ana@senseloaf.com", "name": "Ana Real"})).inserted_id)
        self.bo = str((await db["users"].insert_one({"email": "bo@example.com", "name": "Bo Test"})).inserted_id)
        self.ws = str((await db["workspaces"].insert_one({"name": "Senseloaf"})).inserted_id)
        self.doc = (await db["documents"].insert_one({"slug": "roadmap", "title": "Roadmap", "workspace_id": self.ws})).inserted_id
        page = (await db["documents"].insert_one({"slug": "daily-syncup", "title": "Daily Syncup",
                                                  "workspace_id": self.ws})).inserted_id
        self.meeting = (await db["meetings"].insert_one({"title": "Daily Syncup", "doc_id": str(page),
                                                         "workspace_id": self.ws})).inserted_id

        async def ledger(rid, feature, ts, *, user=None, actor=True, **meta):
            row = {"feature": feature, "request_id": rid, "ts": ts, "model": "claude-haiku-5-5", "calls": 2,
                   "usage": {"input": 1200, "output": 300, "cache_read": 0}, "cost_usd": 0.0042,
                   "latency_ms": 2100, "ttft_ms": 900, "outcome": "ok", "user_id": user,
                   "visitor": f"u:{user}" if user else "v:abc", **meta}
            if actor:
                kind = "user" if user else "public"
                row.update(actor=kind, actor_kind=kind, test=False)
            await db[ai_usage.REQUESTS].insert_one(row)

        # Ana's home Ask thread: an old turn, a turn the live log already has, and "my action items"
        # answered without the model (no ledger row).
        self.t1 = ObjectId()
        await ledger("r1", "search_ai", ago(days=5), user=self.ana, via="home", ask="ask", scope="workspace")
        await ledger("r2", "search_ai", ago(days=4), user=self.ana, via="home", ask="ask", scope="workspace")
        await db[ai_log.COLL].insert_one({"_id": "r2", "request_id": "r2", "ts": ago(days=4), "conversation_id": f"t:{self.t1}",
                                          "feature": "search_ai", "label": "Ask · Senseloaf", "preview": "live row"})
        cite = {"label": "1", "n": 1, "key": f"d:{self.doc}", "title": "Roadmap", "url": "/roadmap", "kind": "document",
                "quote": "Ship v2 in May"}
        await db[script.THREADS].insert_one({"_id": self.t1, "user_id": self.ana, "title": "When do we ship v2?",
                                             "via": "home", "updated_at": ago(days=3), "turns": [
            {"q": "When do we ship v2? cc bob@other.com, ana@senseloaf.com, key sk-ant-abcdefghijklmnop",
             "a": "In May [1]. Call +1 415 555 0100 today.", "intent": "ask", "citations": [cite], "request_id": "r1",
             "at": ago(days=5)},
            {"q": "And v3?", "a": "Not planned.", "intent": "ask", "citations": [], "request_id": "r2", "at": ago(days=4)},
            {"q": "My action items", "a": "Nothing open.", "intent": "my_actions", "citations": [], "request_id": "r3",
             "at": ago(days=3)},
        ]})
        # A meetings chat (meetings page) about one meeting.
        self.t2 = ObjectId()
        await ledger("r4", "meetings_ai", ago(days=2), user=self.ana, via="web", kind="ask",
                     meeting_id=str(self.meeting), workspace_id=self.ws)
        await db[script.THREADS].insert_one({"_id": self.t2, "user_id": self.ana, "title": "Who owns QA?", "via": "web",
                                             "kind": "meetings", "ref": str(self.meeting), "updated_at": ago(days=2),
                                             "turns": [{"q": "Who owns QA?", "a": "Priya [1-s3].", "intent": "ask",
                                                        "citations": [{"label": "1-s3", "kind": "segment",
                                                                       "meeting_id": str(self.meeting)}],
                                                        "request_id": "r4", "at": ago(days=2)}]})
        # Bo (a test-domain account) through the assistant, ledger row written before actors existed;
        # plus a turn whose call is older than the log keeps.
        self.t3 = ObjectId()
        await ledger("r8", "search_ai", ago(days=1), user=self.bo, actor=False, via="assistant", ask="ask", scope="all")
        await ledger("r5", "search_ai", ago(days=40), user=self.bo, via="assistant", ask="ask", scope="all")
        await db[script.THREADS].insert_one({"_id": self.t3, "user_id": self.bo, "title": "x", "via": "assistant",
                                             "updated_at": ago(days=1), "turns": [
            {"q": "Old one", "a": "a", "intent": "ask", "request_id": "r5", "at": ago(days=40)},
            {"q": "What's new in my files?", "a": "Two docs.", "intent": "ask", "request_id": "r8", "at": ago(days=1),
             "scope": {"kind": "mine", "label": "My files"}},
        ]})
        # A thread untouched for two months is not read at all.
        await db[script.THREADS].insert_one({"user_id": self.ana, "title": "old", "updated_at": ago(days=60),
                                             "turns": [{"q": "q", "a": "a", "request_id": "r9", "at": ago(days=60)}]})
        await ledger("r9", "search_ai", ago(days=60), user=self.ana, ask="ask")
        # Docs Ask AI: a public conversation on the docs site, one call already logged.
        await ledger("r6", "docs_ask", ago(days=6), action="ask", conversation_id="c1", turn=1,
                     question="How do I share a folder?", answer="Open the folder and press Share [1].",
                     citations=[{"n": 1, "id": "s1", "title": "Sharing", "url": "/docs/sharing"}])
        await ledger("r7", "docs_ask", ago(days=6), action="ask", conversation_id="c1", turn=2,
                     question="And revoke?", answer="Press Remove.")
        await db[ai_log.COLL].insert_one({"_id": "r7", "request_id": "r7", "ts": ago(days=6), "conversation_id": "d:c1",
                                          "feature": "docs_ask", "label": "Docs Ask (public)", "preview": "live"})

    async def asyncTearDown(self):
        for k, v in self.saved.items():
            setattr(settings, k, v)
        database._client = self._saved_client
        ai_usage.invalidate_settings()
        ai_log.invalidate()
        if env.MONGO:
            await self.client.drop_database(self.db_name)
            self.client.close()

    async def log_ids(self) -> set:
        return {r["_id"] async for r in self.db[ai_log.COLL].find({}, {"_id": 1})}

    async def test_a_dry_run_counts_and_writes_nothing(self):
        before = await self.log_ids()
        out = await script.run(self.db, now=NOW)
        c = out["counts"]
        self.assertEqual(c["threads"], 3)
        self.assertEqual(c["ask_turns"], 3)          # r1, r4, r8
        self.assertEqual(c["already_logged"], 1)     # r2
        self.assertEqual(c["no_ledger_row"], 1)      # r3
        self.assertEqual(c["older"], 1)              # r5
        self.assertEqual(c["docs_turns"], 1)         # r6
        self.assertEqual(c["docs_already_logged"], 1)
        self.assertEqual(out["entries"], 4)
        self.assertEqual(out["conversations"], 4)
        self.assertEqual(out["written"], 0)
        self.assertEqual(await self.log_ids(), before)
        text = script.report(out)
        self.assertIn("dry run", text)
        self.assertIn("4 entries in 4 conversations", text)
        self.assertIn("Ask · Senseloaf", text)
        self.assertIn("Meeting chat · Daily Syncup", text)
        self.assertNotIn("bob@other.com", text)
        self.assertNotIn("sk-ant-", text)

    async def test_b_apply_writes_rows_like_the_live_log(self):
        out = await script.run(self.db, apply=True, now=NOW)
        self.assertEqual(out["written"], 4)
        L = self.db[ai_log.COLL]
        r1 = await L.find_one({"_id": "r1"})
        self.assertTrue(r1["backfilled"])
        self.assertEqual(r1["conversation_id"], f"t:{self.t1}")
        self.assertEqual(r1["label"], "Ask · Senseloaf")
        self.assertEqual(r1["workspace_id"], self.ws)
        self.assertEqual((r1["actor"], r1["test"], r1["user_email"]), ("user", False, "ana@senseloaf.com"))
        self.assertEqual((r1["model"], r1["cost_usd"], r1["latency_ms"]), ("claude-haiku-5-5", 0.0042, 2100))
        self.assertIn("[email]", r1["input"])              # someone else's address
        self.assertIn("ana@senseloaf.com", r1["input"])     # the asker's own stays
        self.assertIn("[secret]", r1["input"])
        self.assertNotIn("sk-ant-", r1["input"])
        self.assertIn("[phone]", r1["output"])
        self.assertEqual(r1["citations"][0]["title"], "Roadmap")
        self.assertTrue(r1["content"])
        # The live row is left alone; the conversation reads in order.
        r2 = await L.find_one({"_id": "r2"})
        self.assertNotIn("backfilled", r2)
        self.assertEqual(r2["preview"], "live row")
        conv = [r["_id"] async for r in L.find({"conversation_id": f"t:{self.t1}"}).sort("ts", 1)]
        self.assertEqual(conv, ["r1", "r2"])
        self.assertIsNone(await L.find_one({"_id": "r3"}))
        self.assertIsNone(await L.find_one({"_id": "r5"}))
        self.assertIsNone(await L.find_one({"_id": "r9"}))
        # Meetings chat: the meeting is the subject, scope and context.
        r4 = await L.find_one({"_id": "r4"})
        self.assertEqual(r4["label"], "Meeting chat · Daily Syncup")
        self.assertEqual(r4["conversation_id"], f"t:{self.t2}")
        self.assertEqual(r4["scope_label"], "This meeting: Daily Syncup")
        self.assertEqual(r4["context"]["items"][0]["url"], "/daily-syncup")
        self.assertEqual(r4["workspace_name"], "Senseloaf")
        # A ledger row without an actor: classified as the startup backfill would (test domain).
        r8 = await L.find_one({"_id": "r8"})
        self.assertEqual((r8["actor"], r8["actor_kind"], r8["test_reason"]), ("test", "user", "test_domain"))
        self.assertEqual(r8["scope_label"], "My files")
        # Docs Ask AI: rebuilt from the ledger row, in its docs conversation.
        r6 = await L.find_one({"_id": "r6"})
        self.assertEqual((r6["conversation_id"], r6["label"], r6["actor"]), ("d:c1", "Docs Ask (public)", "public"))
        self.assertEqual(r6["input"], "How do I share a folder?")
        self.assertEqual(r6["citations"][0]["url"], "/docs/sharing")
        self.assertTrue(r6["backfilled"])
        self.assertNotIn("backfilled", await L.find_one({"_id": "r7"}))
        # The admin API says which turns were backfilled.
        self.assertTrue(admin_ai_log._turn(r1)["backfilled"])
        self.assertFalse(admin_ai_log._turn(r2)["backfilled"])

    async def test_c_running_again_adds_nothing(self):
        await script.run(self.db, apply=True, now=NOW)
        n = await self.db[ai_log.COLL].count_documents({})
        out = await script.run(self.db, apply=True, now=NOW)
        self.assertEqual((out["entries"], out["written"]), (0, 0))
        self.assertEqual(out["counts"]["already_logged"], 4)
        self.assertEqual(await self.db[ai_log.COLL].count_documents({}), n)

    async def test_d_content_capture_off_keeps_metadata_only(self):
        await self.db[ai_usage.SETTINGS].insert_one({"_id": ai_log.SETTINGS_ID, "content": False})
        ai_log.invalidate()
        out = await script.run(self.db, apply=True, now=NOW)
        self.assertIn("content capture OFF", script.report(out))
        async for r in self.db[ai_log.COLL].find({"backfilled": True}):
            self.assertFalse(r["content"])
            for k in ("input", "output", "citations", "context"):
                self.assertNotIn(k, r)
            self.assertIsNotNone(r.get("label"))

    async def test_e_no_docs_and_the_cli(self):
        out = await script.run(self.db, docs=False, now=NOW)
        self.assertEqual(out["entries"], 3)
        self.assertNotIn("docs_rows", out["counts"])

        async def no_connect():
            return None

        buf = io.StringIO()
        with mock.patch.object(script, "connect", no_connect), mock.patch.object(script, "get_database", lambda: self.db), \
                contextlib.redirect_stdout(buf):
            await script.main(["--examples", "2"])
        text = buf.getvalue()
        self.assertIn("nothing written", text)
        self.assertEqual(text.count("  e.g. "), 2)
        self.assertNotIn("backfilled", {k for r in await self.db[ai_log.COLL].find().to_list(length=50) for k in r})


if __name__ == "__main__":
    unittest.main()
