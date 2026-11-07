"""The AI request log (services/ai_log.py, routers/admin_ai_log.py): who made every AI call (actor and
test tagging), the readable log with its privacy rules, the startup backfill, and the admin API.

Every feature's own tests check what it logs (test_search, test_ask_markdrop, test_meetings,
test_pages_ai, test_workspace_memory, test_ask_suggestions, test_analytics_ai_home / _doc, test_jira,
test_docs_ai, test_meeting_memory). No model calls, no backend/.env.
"""

from __future__ import annotations

import secrets
import unittest
from datetime import datetime, timedelta, timezone

from tests import _email_env as env  # noqa: F401  (pins settings first)

import httpx
from bson import ObjectId

from app import database
from app.config import get_settings
from app.limiter import limiter
from app.main import app
from app.services import ai_log, ai_usage, page_history
from app.utils.auth import create_access_token
from tests._admin_session import admin_email, admin_headers

settings = get_settings()
API = "https://api.markdrop.in"
BASE = "/api/v1/admin/ai"


def meter(inp=1000, out=100):
    m = ai_usage.Meter("claude-haiku-5-5")
    m.add({"input_tokens": inp, "output_tokens": out, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0})
    return m


class LogWorld(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.saved = {k: getattr(settings, k) for k in ("mongodb_db", "ai_log_internal_ips")}
        self.db_name = f"markdrop_test_ai_log_{secrets.token_hex(4)}"
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
        limiter.reset()
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=API)
        self.uid = {}
        for who, email, name in (("ana", "ana@senseloaf.com", "Ana Real"), ("bo", "bo@example.com", "Bo Test"),
                                 ("cy", "cy@acme.test", "Cy Acme"), ("dee", "dee@corp.invalid", "Dee")):
            res = await self.db["users"].insert_one({"email": email, "name": name, "created_at": datetime.now(timezone.utc)})
            self.uid[who] = str(res.inserted_id)
        res = await self.db["workspaces"].insert_one({"name": "Senseloaf"})
        self.ws = str(res.inserted_id)

    async def asyncTearDown(self):
        await self.http.aclose()
        for k, v in self.saved.items():
            setattr(settings, k, v)
        database._client = self._saved_client
        ai_usage.invalidate_settings()
        ai_log.invalidate()
        if env.MONGO:
            await self.client.drop_database(self.db_name)
            self.client.close()

    async def rec(self, feature="search_ai", who=None, *, outcome="ok", meta=None, log=None, ago=timedelta(minutes=5),
                  visitor=None, job=None) -> str:
        rid = secrets.token_hex(16)
        uid = self.uid.get(who) if who else None
        await ai_usage.record(self.db, feature=feature, meter=meter(), request_id=rid, outcome=outcome, latency_ms=900,
                              user_id=uid, visitor=visitor or (f"u:{uid}" if uid else f"ip:{secrets.token_hex(4)}"),
                              ip_hash=None if uid else secrets.token_hex(32), ts=datetime.now(timezone.utc) - ago,
                              meta=meta or {}, log=log, job=job)
        return rid

    def request(self, **kw):
        """As if inside an HTTP request (the middleware's context)."""
        token = ai_log.REQUEST.set(ai_log.RequestInfo(**{"ip": "198.51.100.4", "ua": "Mozilla/5.0 Safari", **kw}))
        self.addCleanup(ai_log.REQUEST.reset, token)

    async def ledger(self, rid: str) -> dict:
        return await self.db[ai_usage.REQUESTS].find_one({"request_id": rid})

    async def logged(self, rid: str) -> dict:
        return await self.db[ai_log.COLL].find_one({"_id": rid})


# ── Who made the call ─────────────────────────────────────────────────────────


class Classify(LogWorld):
    async def test_a_real_person_in_the_app(self):
        self.request()
        r = await self.ledger(await self.rec(who="ana", meta={"via": "home"}))
        self.assertEqual((r["actor"], r["actor_kind"], r["test"]), ("user", "user", False))
        self.assertNotIn("test_reason", r)

    async def test_each_test_rule(self):
        cases = [
            ({"test": True}, "ana", "header"),
            ({}, "bo", "test_domain"),          # @example.com
            ({}, "cy", "test_domain"),          # @acme.test
            ({}, "dee", "test_domain"),         # *.invalid
            ({"ip": "127.0.0.1"}, "ana", "local"),
            ({"ip": "::1"}, "ana", "local"),
            ({"ua": "Mozilla/5.0 (X11) HeadlessChrome/131.0 Playwright"}, "ana", "client"),
            ({"ua": "python-httpx/0.28.1"}, "ana", "client"),
        ]
        for info, who, reason in cases:
            with self.subTest(info=info, who=who):
                token = ai_log.REQUEST.set(ai_log.RequestInfo(**{"ip": "198.51.100.4", "ua": "Mozilla/5.0", **info}))
                try:
                    r = await self.ledger(await self.rec(who=who))
                finally:
                    ai_log.REQUEST.reset(token)
                self.assertEqual((r["actor"], r["actor_kind"], r["test"], r["test_reason"]), ("test", "user", True, reason))

    async def test_internal_accounts_default_to_the_admin_emails_and_can_change(self):
        res = await self.db["users"].insert_one({"email": admin_email(), "name": "Owner"})
        owner = str(res.inserted_id)
        self.uid["owner"] = owner
        self.request()
        r = await self.ledger(await self.rec(who="owner"))
        self.assertEqual((r["actor"], r["test_reason"]), ("test", "internal"))
        await self.db[ai_usage.SETTINGS].insert_one({"_id": ai_log.SETTINGS_ID, "internal_emails": ["ana@senseloaf.com"]})
        ai_log.invalidate()
        self.assertEqual((await self.ledger(await self.rec(who="owner")))["actor"], "user")
        self.assertEqual((await self.ledger(await self.rec(who="ana")))["test_reason"], "internal")

    async def test_our_server_addresses(self):
        settings.ai_log_internal_ips = "203.0.113.9"
        self.request(ip="203.0.113.9")
        self.assertEqual((await self.ledger(await self.rec(who="ana")))["test_reason"], "local")

    async def test_system_public_and_api(self):
        self.request()
        r = await self.ledger(await self.rec("workspace_memory", visitor="system", meta={"kind": "meeting", "via": "background"}))
        self.assertEqual((r["actor"], r["job"]), ("system", "Team memory"))
        r = await self.ledger(await self.rec("workspace_memory", visitor="system", meta={"kind": "weekly"}))
        self.assertEqual(r["job"], "Weekly summary")
        r = await self.ledger(await self.rec("ask_suggestions", who="ana"))
        self.assertEqual((r["actor"], r["job"]), ("system", "Ask suggestions"))
        r = await self.ledger(await self.rec("meetings_ai", who="ana", meta={"kind": "generate"},
                                             job="Meeting summary (auto-import)"))
        self.assertEqual((r["actor"], r["job"], r["user_id"]), ("system", "Meeting summary (auto-import)", self.uid["ana"]))
        r = await self.ledger(await self.rec("docs_ask"))
        self.assertEqual(r["actor"], "public")
        # An AI app through MCP: named from its OAuth client.
        await self.db["oauth_clients"].insert_one({"_id": "cl_1", "client_name": "Claude"})
        tok = page_history.MCP_CLIENT.set("cl_1")
        try:
            r = await self.ledger(await self.rec(who="ana", meta={"via": "mcp"}))
        finally:
            page_history.MCP_CLIENT.reset(tok)
        self.assertEqual((r["actor"], r["app"]), ("api", "Claude"))
        # An API token; a script's default client through it is not a test.
        token = ai_log.REQUEST.set(ai_log.RequestInfo(ip="198.51.100.4", ua="python-httpx/0.28", api_token=True))
        try:
            r = await self.ledger(await self.rec(who="ana"))
        finally:
            ai_log.REQUEST.reset(token)
        self.assertEqual((r["actor"], r["app"], r["test"]), ("api", "API token", False))

    async def test_middleware_reads_the_request(self):
        info = ai_log.request_info({"type": "http", "client": ("10.0.0.1", 1), "headers": [
            (b"x-markdrop-test", b"1"), (b"user-agent", b"UA"), (b"authorization", b"Bearer mdk_abc"),
            (b"x-real-ip", b"198.51.100.7")]})
        self.assertEqual((info.test, info.ip, info.ua, info.api_token), (True, "198.51.100.7", "UA", True))
        info = ai_log.request_info({"type": "http", "client": ("127.0.0.1", 1), "headers": [
            (b"cookie", b"a=b; md_test=1"), (b"x-forwarded-for", b"1.2.3.4, 5.6.7.8")]})
        self.assertEqual((info.test, info.ip, info.api_token), (True, "5.6.7.8", False))
        info = ai_log.request_info({"type": "http", "client": ("127.0.0.1", 1), "headers": []})
        self.assertEqual((info.test, info.ip), (False, "127.0.0.1"))

    async def test_header_reaches_a_call_made_in_a_request(self):
        """End to end: the middleware sets the context a feature's ledger row is classified in."""
        from fastapi import APIRouter

        router = APIRouter()
        seen = {}

        @router.get("/__test/ai-log-probe")
        async def probe():
            seen["info"] = ai_log.REQUEST.get()
            return {}

        app.include_router(router)
        try:
            await self.http.get("/__test/ai-log-probe", headers={"X-Markdrop-Test": "1", "User-Agent": "Firefox"})
        finally:
            app.router.routes[:] = [r for r in app.router.routes if getattr(r, "path", "") != "/__test/ai-log-probe"]
        self.assertTrue(seen["info"].test)
        self.assertEqual(seen["info"].ua, "Firefox")
        self.assertIsNone(ai_log.REQUEST.get())


# ── What is logged ────────────────────────────────────────────────────────────


class Content(LogWorld):
    async def test_ttl_and_indexes(self):
        info = await self.db[ai_log.COLL].index_information()
        ttl = [v for v in info.values() if v.get("expireAfterSeconds") is not None]
        self.assertEqual([(t["key"][0][0], t["expireAfterSeconds"]) for t in ttl], [("ts", 30 * 24 * 3600)])

    async def test_chat_kept_whole_others_cut(self):
        self.request()
        long_q = "why " * 3000              # 12,000 characters
        rid = await self.rec(who="ana", meta={"ask": "ask"}, log={"input": long_q, "output": "A" * 60_000})
        lg = await self.logged(rid)
        self.assertEqual(lg["input"], long_q)
        self.assertFalse(lg["input_truncated"])
        self.assertEqual(len(lg["output"]), ai_log.CHAT_CAP + 1)     # 50k and "…"
        self.assertTrue(lg["output_truncated"])
        rid = await self.rec("pages_ai", who="ana", meta={"action": "transform", "transform": "improve"},
                             log={"input": "x" * 5000, "selection": "s" * 9000, "output": "y" * 9000})
        lg = await self.logged(rid)
        self.assertEqual((len(lg["input"]), len(lg["selection"]), len(lg["output"])),
                         (ai_log.INPUT_CAP + 1, ai_log.INPUT_CAP + 1, ai_log.OUTPUT_CAP + 1))
        self.assertEqual(len(lg["preview"]), ai_log.PREVIEW_CAP)

    async def test_secrets_and_other_peoples_contacts_masked(self):
        self.request()
        q = ("my key is sk-ant-api03-abcdefghijklmnopqrstuvwx and token=hunter2hunter2, mdk_0123456789abcdef; "
             "mail bo@example.com or me at ana@senseloaf.com, call +1 415 555 0134 or 98765 43210; "
             "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop on 2026-11-07 at 10:30")
        rid = await self.rec(who="ana", meta={"ask": "ask"}, log={"input": q, "output": "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 ok"})
        lg = await self.logged(rid)
        for secret in ("sk-ant-api03", "hunter2", "mdk_0123", "bo@example.com", "415 555 0134", "98765 43210",
                       "eyJhbGci", "ghp_ABCD"):
            self.assertNotIn(secret, repr(lg), secret)
        self.assertIn("ana@senseloaf.com", lg["input"])      # the actor's own address stays
        self.assertIn("2026-11-07 at 10:30", lg["input"])    # dates and times aren't phone numbers
        self.assertIn("[secret]", lg["input"])
        self.assertIn("[email]", lg["input"])
        self.assertIn("[phone]", lg["input"])

    async def test_content_capture_off_keeps_metadata(self):
        self.request()
        await self.db[ai_usage.SETTINGS].insert_one({"_id": ai_log.SETTINGS_ID, "content": False})
        ai_log.invalidate()
        rid = await self.rec(who="ana", meta={"ask": "ask"}, log={
            "input": "secret question", "output": "secret answer", "citations": [{"n": 1, "title": "Doc"}],
            "context": [{"kind": "page", "title": "Doc"}], "scope_label": "Everything"})
        lg = await self.logged(rid)
        self.assertFalse(lg["content"])
        for k in ("input", "output", "citations", "context"):
            self.assertNotIn(k, lg)
        self.assertEqual((lg["label"], lg["scope_label"], lg["user_email"], lg["outcome"]),
                         ("Ask", "Everything", "ana@senseloaf.com", "ok"))
        self.assertGreater(lg["cost_usd"], 0)
        # docs Ask AI's own question on the ledger row doesn't sneak in either.
        rid = await self.rec("docs_ask", meta={"question": "q?", "answer": "a."})
        self.assertNotIn("input", await self.logged(rid))

    async def test_context_summary_and_labels(self):
        self.request()
        rid = await self.rec(who="ana", meta={"ask": "ask"}, log={"input": "q", "workspace_id": self.ws, "context": [
            {"kind": "meeting", "title": "Daily Syncup", "id": "d:1", "url": "/daily"},
            {"kind": "meeting", "title": "Retro", "id": "d:2"}, {"kind": "page", "title": "PRD", "id": "d:3"}]})
        lg = await self.logged(rid)
        self.assertEqual(lg["context"]["summary"], "3 sources: 2 meetings, 1 page")
        self.assertEqual(lg["label"], "Ask · Senseloaf")
        self.assertEqual(lg["workspace_name"], "Senseloaf")
        rid = await self.rec("docs_ask", meta={"question": "How?", "answer": "Like so [1].", "conversation_id": "c9",
                                               "citations": [{"n": 1, "title": "Domains", "url": "/d"}]})
        lg = await self.logged(rid)
        self.assertEqual((lg["label"], lg["conversation_id"], lg["input"]), ("Docs Ask (public)", "d:c9", "How?"))
        self.assertEqual(lg["citations"], [{"n": 1, "title": "Domains", "url": "/d", "label": "1"}])

    async def test_link_before_or_after_the_row(self):
        self.request()
        rid = secrets.token_hex(16)
        await ai_log.link(self.db, rid, thread_id="abc", scope_label="Workspace · Senseloaf")
        await ai_usage.record(self.db, feature="search_ai", meter=meter(), request_id=rid, outcome="ok",
                              user_id=self.uid["ana"], visitor="u:x", meta={"ask": "ask"}, log={"input": "q1", "output": "a1"})
        lg = await self.logged(rid)
        self.assertEqual((lg["conversation_id"], lg["scope_label"], lg["input"]), ("t:abc", "Workspace · Senseloaf", "q1"))
        rid2 = await self.rec(who="ana", meta={"ask": "ask"}, log={"input": "q2"})
        self.assertEqual((await self.logged(rid2))["conversation_id"], f"r:{rid2}")
        await ai_log.link(self.db, rid2, thread_id="abc")
        self.assertEqual((await self.logged(rid2))["conversation_id"], "t:abc")

    async def test_follow_ups_join_by_thread_key(self):
        self.request()
        a = await self.rec("pages_ai", who="ana", meta={"action": "ask"}, ago=timedelta(minutes=30),
                           log={"input": "q1", "thread_key": "pages_ai:ask:launch", "follow_up": False})
        b = await self.rec("pages_ai", who="ana", meta={"action": "ask"}, ago=timedelta(minutes=10),
                           log={"input": "q2", "thread_key": "pages_ai:ask:launch", "follow_up": True})
        c = await self.rec("pages_ai", who="ana", meta={"action": "ask"}, ago=timedelta(minutes=5),
                           log={"input": "q3", "thread_key": "pages_ai:ask:launch", "follow_up": False})
        d = await self.rec("pages_ai", who="bo", meta={"action": "ask"}, ago=timedelta(minutes=4),
                           log={"input": "q4", "thread_key": "pages_ai:ask:launch", "follow_up": True})
        convs = [(await self.logged(x))["conversation_id"] for x in (a, b, c, d)]
        self.assertEqual(convs[0], convs[1])               # a follow-up joins
        self.assertNotEqual(convs[2], convs[0])            # a new question starts its own
        self.assertNotIn(convs[3], convs[:3])              # someone else's never joins

    async def test_logging_never_fails_the_call(self):
        from unittest import mock

        with mock.patch.object(ai_log, "write", side_effect=RuntimeError("boom")), \
                mock.patch.object(ai_log, "classify", side_effect=RuntimeError("boom")):
            rid = await self.rec(who="ana")
        self.assertIsNotNone(await self.ledger(rid))


# ── Backfill ──────────────────────────────────────────────────────────────────


class Backfill(LogWorld):
    async def test_rows_from_before_actors(self):
        now = datetime.now(timezone.utc)
        base = {"ts": now, "cost_usd": 0.001, "usage": {}, "outcome": "ok"}
        await self.db[ai_usage.REQUESTS].insert_many([
            {**base, "request_id": "wm1", "feature": "workspace_memory", "kind": "meeting", "user_id": None, "visitor": "system"},
            {**base, "request_id": "wm2", "feature": "workspace_memory", "kind": "weekly", "user_id": None, "visitor": "system"},
            {**base, "request_id": "sg1", "feature": "ask_suggestions", "user_id": self.uid["ana"]},
            {**base, "request_id": "da1", "feature": "docs_ask", "user_id": None, "visitor": "ip:abc"},
            {**base, "request_id": "pa1", "feature": "pages_ai", "user_id": None, "visitor": None},
            {**base, "request_id": "u1", "feature": "search_ai", "user_id": self.uid["ana"], "via": "home"},
            {**base, "request_id": "u2", "feature": "search_ai", "user_id": self.uid["ana"], "via": "mcp"},
            {**base, "request_id": "t1", "feature": "pages_ai", "user_id": self.uid["bo"]},
            {**base, "request_id": "done", "feature": "pages_ai", "user_id": self.uid["bo"], "actor": "user"},
        ])
        n = await ai_log.backfill(self.db)
        self.assertGreaterEqual(n, 8)
        got = {r["request_id"]: (r.get("actor"), r.get("job"), r.get("test"))
               async for r in self.db[ai_usage.REQUESTS].find({})}
        self.assertEqual(got["wm1"], ("system", "Team memory", False))
        self.assertEqual(got["wm2"], ("system", "Weekly summary", False))
        self.assertEqual(got["sg1"], ("system", "Ask suggestions", False))
        self.assertEqual(got["da1"], ("public", None, False))
        self.assertEqual(got["pa1"], ("public", None, False))
        self.assertEqual(got["u1"], ("user", None, False))
        self.assertEqual(got["u2"], ("api", None, False))
        self.assertEqual(got["t1"], ("test", None, True))
        self.assertEqual(got["done"], ("user", None, None))            # already had one: untouched
        self.assertEqual(await ai_log.backfill(self.db), 0)          # idempotent


# ── Admin API ─────────────────────────────────────────────────────────────────


class Admin(LogWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.h = await admin_headers(self.db)
        self.request()
        # Ana (real) asks twice in one Ask thread; Bo (example.com: test) asks once; team memory runs;
        # a visitor asks the docs; Ana's page AI fails.
        self.a1 = await self.rec(who="ana", meta={"ask": "ask"}, ago=timedelta(hours=2), log={
            "input": "When do we ship Senseloaf v2?", "output": "## Plan\n\nWe ship **Friday** [1].",
            "citations": [{"label": "1", "title": "Release checklist", "url": "/release"}],
            "workspace_id": self.ws, "conversation_id": "t:th1", "scope_label": "Workspace · Senseloaf"})
        self.a2 = await self.rec(who="ana", meta={"ask": "ask"}, ago=timedelta(hours=1), log={
            "input": "and the dry run?", "output": "Thursday [1].", "workspace_id": self.ws, "conversation_id": "t:th1"})
        self.b1 = await self.rec(who="bo", meta={"ask": "ask"}, log={"input": "test question pelican", "output": "x"})
        self.s1 = await self.rec("workspace_memory", visitor="system", meta={"kind": "meeting", "workspace_id": self.ws},
                                 log={"subject": "read meeting 'Daily Syncup' → 4 facts", "output": "- fact",
                                      "description": "Team memory read meeting 'Daily Syncup': 4 facts"})
        self.p1 = await self.rec("docs_ask", meta={"question": "How do domains work?", "answer": "Like so.",
                                                   "conversation_id": "c1"})
        self.e1 = await self.rec("pages_ai", who="ana", outcome="error", meta={"action": "summary", "error_code": "upstream_500"},
                                 log={"input": "Summarise this page"})

    async def get(self, path, expect=200, headers=None, **params):
        r = await self.http.get(BASE + path, headers=self.h if headers is None else headers, params=params)
        self.assertEqual(r.status_code, expect, r.text)
        return r.json() if expect == 200 else r

    async def test_admins_only(self):
        token, _ = create_access_token(self.uid["ana"], "ana@senseloaf.com")
        for path in ("/log/conversations", "/log/conversations/t:th1", "/log/conversations/t:th1/markdown",
                     "/log/summary", "/log/settings"):
            with self.subTest(path=path):
                await self.get(path, expect=404, headers={"Authorization": f"Bearer {token}"})
                await self.get(path, expect=401, headers={})
        r = await self.http.put(BASE + "/log/settings", json={"content": False},
                                headers={"Authorization": f"Bearer {token}"})
        self.assertEqual(r.status_code, 404)

    async def test_conversations_by_audience(self):
        real = await self.get("/log/conversations")
        self.assertEqual(real["audience"], "real")
        self.assertEqual([c["conversation_id"] for c in real["items"]], [f"r:{self.e1}", "t:th1"])
        th = real["items"][1]
        self.assertEqual((th["title"], th["turns"], th["who"]["name"], th["who"]["email"], th["scope_label"],
                          th["workspace_name"]),
                         ("When do we ship Senseloaf v2?", 2, "Ana Real", "ana@senseloaf.com", "Workspace · Senseloaf",
                          "Senseloaf"))
        self.assertTrue(real["items"][0]["has_error"])
        self.assertEqual(real["counts"]["test"], 1)
        self.assertEqual(real["counts"]["system"], 1)
        self.assertEqual(real["counts"]["public"], 1)
        test = await self.get("/log/conversations", audience="test")
        self.assertEqual([c["who"]["test_reason"] for c in test["items"]], ["test_domain"])
        system = await self.get("/log/conversations", audience="system")
        self.assertEqual(system["items"][0]["who"]["name"], "Team memory")
        self.assertEqual(system["items"][0]["title"], "Team memory read meeting 'Daily Syncup': 4 facts")
        public = await self.get("/log/conversations", audience="public")
        self.assertTrue(public["items"][0]["who"]["name"].startswith("Visitor "))
        self.assertEqual(len((await self.get("/log/conversations", audience="all"))["items"]), 5)

    async def test_filters(self):
        q = await self.get("/log/conversations", q="dry run")
        self.assertEqual([c["conversation_id"] for c in q["items"]], ["t:th1"])
        self.assertEqual(q["items"][0]["turns"], 2)               # the whole conversation counts
        self.assertEqual((await self.get("/log/conversations", q="pelican"))["total"], 0)   # test traffic
        self.assertEqual((await self.get("/log/conversations", q="pelican", audience="test"))["total"], 1)
        self.assertEqual((await self.get("/log/conversations", feature="pages_ai"))["total"], 1)
        self.assertEqual((await self.get("/log/conversations", outcome="error"))["total"], 1)
        self.assertEqual((await self.get("/log/conversations", outcome="ok"))["total"], 1)
        self.assertEqual((await self.get("/log/conversations", workspace=self.ws))["total"], 1)
        self.assertEqual((await self.get("/log/conversations", user=self.uid["ana"]))["total"], 2)
        self.assertEqual((await self.get("/log/conversations", user="senseloaf.com"))["total"], 2)
        today = datetime.now(timezone.utc).date()
        self.assertEqual((await self.get("/log/conversations", since=(today + timedelta(days=1)).isoformat()))["total"], 0)
        self.assertEqual((await self.get("/log/conversations", until=today.isoformat()))["total"], 2)
        await self.get("/log/conversations", expect=400, since="yesterday")
        await self.get("/log/conversations", expect=400, outcome="weird")
        page = await self.get("/log/conversations", audience="all", limit=2, page=2)
        self.assertEqual((page["pages"], len(page["items"])), (3, 2))

    async def test_transcript_and_markdown(self):
        c = await self.get("/log/conversations/t:th1")
        turns = c["turns_list"]
        self.assertEqual([t["input"] for t in turns], ["When do we ship Senseloaf v2?", "and the dry run?"])
        self.assertEqual(turns[0]["output"], "## Plan\n\nWe ship **Friday** [1].")
        self.assertEqual(turns[0]["citations"][0]["title"], "Release checklist")
        self.assertEqual((turns[0]["model"], turns[0]["outcome_kind"], turns[0]["who"]["kind"]), ("claude-haiku-5-5", "ok", "user"))
        self.assertGreater(turns[0]["tokens"]["prompt"], 0)
        md = await self.get("/log/conversations/t:th1/markdown")
        self.assertTrue(md["filename"].startswith("ai-when-do-we-ship") and md["filename"].endswith(".md"))
        text = md["markdown"]
        self.assertIn("**Ana Real asked:**", text)
        self.assertIn("> When do we ship Senseloaf v2?", text)
        self.assertIn("**Markdrop replied:**\n\n## Plan", text)
        self.assertIn("- [1] [Release checklist](/release)", text)
        err = await self.get(f"/log/conversations/r:{self.e1}/markdown")
        self.assertIn("_No answer: upstream_500_", err["markdown"])
        await self.get("/log/conversations/t:nope", expect=404)

    async def test_summary(self):
        s = await self.get("/log/summary", audience="all")
        self.assertEqual(s["total"]["calls"], 6)
        by_f = {f["key"]: f for f in s["by_feature"]}
        self.assertEqual(by_f["search_ai"]["calls"], 3)
        self.assertEqual(by_f["search_ai"]["conversations"], 2)
        who = {w["key"]: w for w in s["by_who"]}
        self.assertEqual(who[self.uid["ana"]]["calls"], 3)
        self.assertEqual(who[self.uid["ana"]]["errors"], 1)
        self.assertEqual(who["job:Team memory"]["name"], "Team memory")
        self.assertEqual(who["public"]["name"], "Visitors")
        real = await self.get("/log/summary")
        self.assertEqual(real["total"]["calls"], 3)

    async def test_settings(self):
        s = await self.get("/log/settings")
        self.assertEqual((s["content"], s["internal_emails_default"], s["retention_days"]), (True, True, 30))
        self.assertEqual(s["internal_emails"], sorted(settings.admin_email_set))
        r = await self.http.put(BASE + "/log/settings", headers=self.h,
                                json={"content": False, "internal_emails": ["QA@Senseloaf.com", " "], "internal_ips": ["203.0.113.9"]})
        self.assertEqual(r.status_code, 200, r.text)
        s = r.json()
        self.assertEqual((s["content"], s["internal_emails"], s["internal_ips"], s["internal_emails_default"]),
                         (False, ["qa@senseloaf.com"], ["203.0.113.9"], False))
        rid = await self.rec(who="ana", meta={"ask": "ask"}, log={"input": "now hidden"})
        self.assertNotIn("input", await self.logged(rid))
        for bad in ({"internal_emails": ["not-an-email"]}, {"internal_ips": ["999.1.1.1"]}):
            r = await self.http.put(BASE + "/log/settings", headers=self.h, json=bad)
            self.assertEqual(r.status_code, 400, bad)
        r = await self.http.put(BASE + "/log/settings", headers=self.h, json={"reset_internal": True, "content": True})
        self.assertEqual((r.json()["internal_emails_default"], r.json()["content"]), (True, True))
        audit = await self.db[ai_usage.SETTINGS_AUDIT].find({"kind": "log"}).to_list(10)
        self.assertEqual(len(audit), 2)

    async def test_usage_dashboards_leave_tests_out(self):
        ov = await self.get("/usage/overview")
        self.assertEqual(ov["audience"], "live")
        self.assertEqual(ov["kpis"]["requests"], 5)
        self.assertEqual(ov["left_out"]["test"], 1)
        self.assertEqual((ov["kpis"]["system_requests"], ov["kpis"]["anonymous_requests"]), (1, 1))
        self.assertEqual((await self.get("/usage/overview", audience="all"))["kpis"]["requests"], 6)
        self.assertEqual((await self.get("/usage/overview", audience="test"))["kpis"]["requests"], 1)
        users = await self.get("/usage/users")
        ids = {u["user_id"]: u for u in users["items"]}
        self.assertNotIn(self.uid["bo"], ids)
        self.assertEqual(ids["system"]["name"], "System jobs")
        self.assertEqual(ids["anonymous"]["requests"], 1)
        sysd = await self.get("/usage/users/system")
        self.assertEqual((sysd["user"]["name"], sysd["kpis"]["requests"]), ("System jobs", 1))
        anon = await self.get("/usage/users/anonymous")
        self.assertEqual(anon["kpis"]["requests"], 1)
        csv_ = await self.http.get(BASE + "/usage/export.csv", headers=self.h, params={"kind": "requests"})
        self.assertNotIn(self.uid["bo"], csv_.text)
        self.assertIn(",actor,test", csv_.text.splitlines()[0])


def load_tests(loader, tests, pattern):
    suite = unittest.TestSuite()
    for cls in (Classify, Content, Backfill, Admin):
        suite.addTests(loader.loadTestsFromTestCase(cls))
    return suite
