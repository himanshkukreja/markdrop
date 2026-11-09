"""perf/scale (2026-11-09): "if 3-4 users come together, everything gets blocked".

What changed, and what must hold:

* the home's to-dos come from the search index (``td``/``tdl``, services/todos.py) once it carries them —
  the same items as the old regex scan, for every case the home's own tests cover (ActionsFromIndex
  re-runs them all through the index);
* bcrypt never runs on the event loop, and a correct secret is checked once (utils/security.check);
* rate limits count per signed-in account, never per invented token (utils/net.rate_limit_key);
* a read request asks for the caller, a workspace and a role once (services/request_memo.py); a write
  request always asks again;
* background loops renew their lease at half-life, and an idle revalidation pass is one claim;
* the loop monitor reports a blocked event loop with the stack that blocked it.
"""

from __future__ import annotations

import asyncio
import time
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

from tests import test_home as _home  # (pins settings first; a module import, so its tests run once)

import jwt
from starlette.requests import Request

from app.config import get_settings
from app.services import search_index, todos
from app.utils import net, security
from app.utils.auth import create_access_token

settings = get_settings()


# ── The home's to-dos through the index ──────────────────────────────────────


class ActionsFromIndex(_home.Actions):
    """Every Actions test again, with the index carrying ``td``/``tdl`` (rebuilt before each read)."""

    async def home(self, who: str) -> dict:
        await search_index.drain()
        await self.db[search_index.META].delete_many({"_id": {"$in": ["backfill", "todos"]}})
        while not (await search_index.backfill_tick(self.db))["done"]:
            pass
        while not (await search_index.todos_tick(self.db))["done"]:
            pass
        self.assertTrue(await search_index.todos_ready(self.db))
        return await super().home(who)


class IndexPathIsUsed(_home.HomeWorld):
    async def test_no_content_regex_once_the_index_is_ready(self):
        wm = self.uid["wm"]
        await self.put("launch", "Launch prep", f'- [ ] :person[Bo]{{id="{wm}"}} Order the banners {{#b-aaaa1111}}',
                       editor="blocks")
        await search_index.drain()
        while not (await search_index.backfill_tick(self.db))["done"]:
            pass
        while not (await search_index.todos_tick(self.db))["done"]:
            pass
        seen = []
        real_find = type(self.db["documents"]).find

        def spy(coll, *a, **kw):
            if coll.name == "documents" and a:
                seen.append(repr(a[0]))
            return real_find(coll, *a, **kw)

        with mock.patch.object(type(self.db["documents"]), "find", spy):
            h = await self.home("wm")
        self.assertEqual([a["text"] for a in h["actions"]["items"]], ["Order the banners"])
        self.assertFalse(any("$regex" in q for q in seen), seen)


class TodoFields(unittest.TestCase):
    def test_people_and_lines(self):
        md = "\n".join([
            '- [ ] Ship it :person[Ben]{id="u1"} by :date[Fri] {#b-aaaa1111}',
            '- [x] done :person[Ada]{id="u2"}',
            "```", '- [ ] fenced :person[Q]{id="u3"}', "```",
            '1. [ ] numbered :person[Wes]{id="u4"} with :person[Ben]{id="u1"} [00:04](/x#b-t3)',
            '- plain mention :person[Z]{id="u5"}',
            '- [ ] odd id :person[X]{id="a.b"}',
        ])
        raw = {"editor": "blocks", "content": md}
        self.assertEqual(todos.people(raw), ["u1", "u4"])
        lines = todos.lines(raw)
        self.assertEqual(lines["u1"], [["Ship it by Fri", "b-aaaa1111"], ["Numbered @Wes with", None]])
        self.assertEqual(lines["u4"], [["Numbered with @Ben", None]])

    def test_never_for_locked_or_non_pages(self):
        md = '- [ ] x :person[Ben]{id="u1"}'
        for raw in ({"editor": "blocks", "content": md, "encrypted": True},
                    {"editor": "blocks", "content": md, "read_password_hash": "h"},
                    {"content": md},
                    {"editor": "blocks", "kind": "artifact", "content": md}):
            self.assertEqual(search_index.todo_fields(raw), {"td": [], "tdl": {}})
        self.assertEqual(search_index.doc_row({"content": md, "encrypted": True})["td"], [])


class Fold(unittest.TestCase):
    def test_same_as_one_character_at_a_time(self):
        import random

        from app.services import search

        def ref(text):
            if text.isascii():
                return text.lower()
            return "".join(search._fold_char(c) if ord(c) > 127 else c.lower() for c in text)

        rng = random.Random(7)
        pool = "aZq —…éÉİßñ“”ÅKﬁΩ中文😀\u0301\u212b\u212a"
        for _ in range(3000):
            t = "".join(rng.choice(pool) for _ in range(rng.randint(0, 40)))
            self.assertEqual(search.fold(t), ref(t), t)
            self.assertEqual(len(search.fold(t)), len(t))


# ── bcrypt off the loop, remembered when right ───────────────────────────────


class Secrets(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        security.forget()
        self.hashed = security.hash_sync("sk_right", rounds=4)

    async def test_right_secret_checked_once(self):
        with mock.patch.object(security, "check_sync", wraps=security.check_sync) as spy:
            self.assertTrue(await security.check("sk_right", self.hashed))
            self.assertTrue(await security.check("sk_right", self.hashed))
        self.assertEqual(spy.call_count, 1)

    async def test_wrong_secret_never_remembered(self):
        with mock.patch.object(security, "check_sync", wraps=security.check_sync) as spy:
            self.assertFalse(await security.check("sk_wrong", self.hashed))
            self.assertFalse(await security.check("sk_wrong", self.hashed))
        self.assertEqual(spy.call_count, 2)
        self.assertFalse(await security.check(None, self.hashed))
        self.assertFalse(await security.check("x", None))
        self.assertFalse(await security.check("x", "not-a-hash"))

    async def test_loop_keeps_running_while_bcrypt_works(self):
        slow = security.hash_sync("sk_slow", rounds=12)   # ~0.2 s of bcrypt
        ticks = 0

        async def ticker():
            nonlocal ticks
            while True:
                await asyncio.sleep(0.01)
                ticks += 1

        t = asyncio.create_task(ticker())
        t0 = time.monotonic()
        self.assertTrue(await security.check("sk_slow", slow))
        took = time.monotonic() - t0
        t.cancel()
        self.assertGreater(ticks, (took / 0.01) * 0.3)    # the loop ticked through it

    async def test_new_edit_secret_verifies(self):
        raw, hashed = await security.new_edit_secret()
        self.assertTrue(raw.startswith("sk_"))
        self.assertTrue(security.verify_edit_secret(raw, hashed))


# ── Rate limits per account ──────────────────────────────────────────────────


def _req(auth: str | None = None, ip: str = "203.0.113.9") -> Request:
    headers = [(b"x-real-ip", ip.encode())]
    if auth:
        headers.append((b"authorization", auth.encode()))
    return Request({"type": "http", "method": "GET", "path": "/", "headers": headers, "query_string": b""})


class RateLimitKey(unittest.TestCase):
    def setUp(self):
        net._KEY_CACHE.clear()

    def test_signed_in_counts_per_account(self):
        token, _ = create_access_token("6af1796ee15410a7a72b64e0", "a@example.com")
        self.assertEqual(net.rate_limit_key(_req(f"Bearer {token}")), "user:6af1796ee15410a7a72b64e0")
        # Two colleagues behind one office address: two budgets.
        other, _ = create_access_token("6af1796ee15410a7a72b64e1", "b@example.com")
        self.assertNotEqual(net.rate_limit_key(_req(f"Bearer {token}")), net.rate_limit_key(_req(f"Bearer {other}")))

    def test_anything_unverified_counts_per_address(self):
        self.assertEqual(net.rate_limit_key(_req()), "203.0.113.9")
        self.assertEqual(net.rate_limit_key(_req("Bearer made.up.token")), "203.0.113.9")
        self.assertEqual(net.rate_limit_key(_req("Bearer mdk_whatever")), "203.0.113.9")
        forged = jwt.encode({"sub": "6af1796ee15410a7a72b64e0", "exp": int(time.time()) + 600}, "not-our-secret",
                            algorithm="HS256")
        self.assertEqual(net.rate_limit_key(_req(f"Bearer {forged}")), "203.0.113.9")
        expired = jwt.encode({"sub": "6af1796ee15410a7a72b64e0", "exp": int(time.time()) - 5}, settings.auth_secret,
                             algorithm="HS256")
        self.assertEqual(net.rate_limit_key(_req(f"Bearer {expired}")), "203.0.113.9")

    def test_cached_key_expires_with_the_token(self):
        token = jwt.encode({"sub": "u1", "exp": int(time.time()) + 600}, settings.auth_secret, algorithm="HS256")
        self.assertEqual(net.rate_limit_key(_req(f"Bearer {token}")), "user:u1")
        net._KEY_CACHE[token] = ("user:u1", time.time() - 1)
        self.assertEqual(net.rate_limit_key(_req(f"Bearer {token}")), "203.0.113.9")


# ── One lookup per read request ──────────────────────────────────────────────


class RequestMemo(_home.HomeWorld):
    async def _count(self, method: str, path: str, coll: str, **kw) -> int:
        n = 0
        real = type(self.db[coll]).find_one

        def spy(c, *a, **k):
            nonlocal n
            if c.name == coll:
                n += 1
            return real(c, *a, **k)

        with mock.patch.object(type(self.db[coll]), "find_one", spy):
            r = await self.http.request(method, path, headers=self.session("wm"), **kw)
        self.assertLess(r.status_code, 500, r.text)
        return n

    async def test_read_request_asks_for_a_role_once(self):
        # The rail's tree asks for your role (require_role) and again deciding what you can read: one read.
        ws = self.ws["W1"]
        self.assertEqual(await self._count("GET", f"/api/v1/workspaces/{ws}/tree", "memberships"), 1)

    async def test_outside_a_request_nothing_is_remembered(self):
        from app.services import user as user_service

        n = 0
        real = type(self.db["users"]).find_one

        def spy(c, *a, **k):
            nonlocal n
            n += 1
            return real(c, *a, **k)

        with mock.patch.object(type(self.db["users"]), "find_one", spy):
            await user_service.get_user_by_id(self.db, self.uid["wm"])
            await user_service.get_user_by_id(self.db, self.uid["wm"])
        self.assertEqual(n, 2)

    async def test_write_request_reads_fresh(self):
        from app.services import request_memo

        seen = []

        async def app(scope, receive, send):
            seen.append(request_memo._memo.get())
            await send({"type": "http.response.start", "status": 204, "headers": []})
            await send({"type": "http.response.body", "body": b""})

        mw = request_memo.RequestMemoMiddleware(app)

        async def receive():
            return {"type": "http.request", "body": b""}

        async def send(_m):
            pass

        for method in ("GET", "POST", "PUT", "PATCH", "DELETE"):
            await mw({"type": "http", "method": method, "path": "/api/v1/workspaces/w1/members", "headers": []},
                     receive, send)
        self.assertEqual([m is not None for m in seen], [True, False, False, False, False])
        # The editor's autosave and lock calls never change a person, a workspace or a role.
        self.assertTrue(request_memo.memo_applies("PUT", "/api/v1/documents/abc"))
        self.assertTrue(request_memo.memo_applies("POST", "/api/v1/documents/abc/lock"))
        self.assertTrue(request_memo.memo_applies("DELETE", "/api/v1/documents/abc/lock"))
        self.assertFalse(request_memo.memo_applies("DELETE", "/api/v1/documents/abc"))
        self.assertFalse(request_memo.memo_applies("POST", "/api/v1/documents/abc/claim"))
        self.assertFalse(request_memo.memo_applies("PATCH", "/api/v1/documents/abc/settings"))


class RecentViews(_home.HomeWorld):
    async def test_live_rereads_write_recent_once_but_order_still_follows_you(self):
        from bson import ObjectId

        from app.services import personal

        a, b = ObjectId(), ObjectId()
        wm = self.uid["wm"]
        writes = 0
        real = type(self.db["recent_views"]).update_one

        def spy(c, *x, **k):
            nonlocal writes
            if c.name == "recent_views":
                writes += 1
            return real(c, *x, **k)

        with mock.patch.object(type(self.db["recent_views"]), "update_one", spy):
            for _ in range(5):                       # a reader following someone's edits
                await personal.record_view(self.db, wm, a)
            self.assertEqual(writes, 1)
            await personal.record_view(self.db, wm, b)
            await personal.record_view(self.db, wm, a)  # back to A: A is the newest again
        self.assertEqual(writes, 3)
        rows = await self.db["recent_views"].find({"user_id": wm}).sort("viewed_at", -1).to_list(10)
        self.assertEqual([r["doc_id"] for r in rows], [str(a), str(b)])


# ── Quieter background loops ─────────────────────────────────────────────────


class Loops(unittest.IsolatedAsyncioTestCase):
    async def test_lease_renewed_at_half_life_not_every_pass(self):
        from app.services import background

        calls = {"acquire": 0, "body": 0}

        async def acquire(db, name, ttl, holder=background.HOLDER):
            calls["acquire"] += 1
            return True

        async def body(db):
            calls["body"] += 1

        with mock.patch.object(background, "acquire", acquire):
            task = asyncio.create_task(background._loop("t", 0.01, lambda: object(), body))
            await asyncio.sleep(0.3)
            task.cancel()
        self.assertGreater(calls["body"], 5)
        self.assertEqual(calls["acquire"], 1)          # a 30 s lease, renewed after 15 s

    async def test_idle_revalidation_pass_is_one_claim(self):
        from app.services import revalidate

        claims = []

        async def claim(db, query):
            claims.append(query)
            return None

        with mock.patch.object(revalidate, "_claim", claim), \
                mock.patch.object(revalidate.settings, "page_revalidate_enabled", True):
            self.assertEqual(await revalidate.run_due(object()), 0)
        self.assertEqual(len(claims), 1)

    async def test_busy_revalidation_pass_sends_every_due_job(self):
        from app.services import revalidate

        jobs = [{"_id": i, "key": f"doc:s{i}"} for i in range(11)]
        sent = []

        async def claim(db, query):
            return jobs.pop() if jobs else None

        async def run(db, job):
            sent.append(job["_id"])
            return "done"

        with mock.patch.object(revalidate, "_claim", claim), mock.patch.object(revalidate, "_run_job", run), \
                mock.patch.object(revalidate.settings, "page_revalidate_enabled", True):
            self.assertEqual(await revalidate.run_due(object(), limit=100), 11)
        self.assertEqual(sorted(sent), list(range(11)))


# ── The loop monitor ─────────────────────────────────────────────────────────


class LoopMonitor(unittest.IsolatedAsyncioTestCase):
    async def test_reports_a_block_with_its_stack(self):
        from app.services import loop_monitor

        with mock.patch.dict("os.environ", {"MARKDROP_LOOP_BLOCK_MS": "100", "MARKDROP_LOOP_MONITOR": "1"}):
            loop_monitor.start()
        try:
            await asyncio.sleep(0.25)
            loop_monitor.snapshot(reset=True)

            def hold_the_loop_on_purpose():
                time.sleep(0.4)

            hold_the_loop_on_purpose()
            await asyncio.sleep(0.25)
            snap = loop_monitor.snapshot()
            self.assertGreater(snap["max_ms"], 250)
            self.assertTrue(any("hold_the_loop_on_purpose" in b["stack"] for b in snap["blocks"]), snap["blocks"])
        finally:
            await loop_monitor.stop()

    async def test_health_loop_only_on_the_box(self):
        import httpx

        from app.main import app

        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("127.0.0.1", 5000)),
                                     base_url="http://api") as c:
            self.assertEqual((await c.get("/health/loop")).status_code, 200)
            r = await c.get("/health/loop", headers={"X-Forwarded-For": "198.51.100.1"})
            self.assertEqual(r.status_code, 404)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("198.51.100.1", 5000)),
                                     base_url="http://api") as c:
            self.assertEqual((await c.get("/health/loop")).status_code, 404)


if __name__ == "__main__":
    unittest.main()
