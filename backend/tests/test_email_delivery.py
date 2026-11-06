"""The one send path (services/email_delivery.py) against a throwaway MongoDB.

Routing (order, per-provider limits, the tier caps: bulk 80%, transactional
95%, auth everything and then some), fallback on provider errors, quota errors,
both providers full (deferred → retried the next UTC day → over_limit), the
send log for single and batch sends, a campaign that stops at the bulk cap and
continues the next day, mailer integration, Brevo's payload shape and the admin
usage / log API. Providers are fakes or httpx.MockTransport: no network, and
never backend/.env's keys.
"""

from __future__ import annotations

import json
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

from tests import _email_env as env

import httpx
import jwt

from app.config import get_settings
from app.services import email_delivery as d
from app.services import mailer
from app.services.email_campaigns import audience, engine, render, templates, transport

settings = get_settings()


class FakeProvider(d.Provider):
    def __init__(self, name: str, limit: int = 5, idempotent: bool = True):
        self.name = name
        self._limit = limit
        self.idempotent = idempotent
        self.sent: list[dict] = []
        self.batches: list[tuple[list[str], str | None]] = []
        self.errors: list[Exception | None] = []
        self.reject: set[str] = set()

    def configured(self) -> bool:
        return True

    def limit(self) -> int:
        return self._limit

    def _maybe_fail(self):
        if self.errors:
            e = self.errors.pop(0)
            if e is not None:
                raise e

    async def send(self, msg):
        self._maybe_fail()
        self.sent.append(msg)
        return f"{self.name}-{len(self.sent)}"

    async def send_batch(self, msgs, idem_key):
        self._maybe_fail()
        self.batches.append(([m["to"][0] for m in msgs], idem_key))
        out = []
        for m in msgs:
            if m["to"][0] in self.reject:
                out.append(d.Outcome(None, "rejected by fake"))
            else:
                self.sent.append(m)
                out.append(d.Outcome(f"{self.name}-{len(self.sent)}", None))
        return out


def msg(to="a@example.com", subject="Hello"):
    return {"from": "Markdrop <login@markdrop.in>", "to": [to] if isinstance(to, str) else to,
            "subject": subject, "html": "<p>hi</p>", "reply_to": "help@markdrop.in"}


def five_xx(name="resend"):
    return d.ProviderError(f"{name} 503: down", status=503)


class Base(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.name = env.new_db_name()
        self.client, self.db = await env.make_db(self.name)
        await d.ensure_indexes(self.db)
        self.resend = FakeProvider("resend", 5)
        self.brevo = FakeProvider("brevo", 5, idempotent=False)
        self._order = settings.email_provider_order
        settings.email_provider_order = "resend,brevo"
        self.patches = [mock.patch.dict(d.PROVIDERS, {"resend": self.resend, "brevo": self.brevo}, clear=True)]
        for p in self.patches:
            p.start()

    async def asyncTearDown(self):
        for p in self.patches:
            p.stop()
        settings.email_provider_order = self._order
        await self.client.drop_database(self.name)
        self.client.close()

    async def rows(self, **q):
        return await self.db[d.LOG].find(q).sort("_id", 1).to_list(length=None)

    async def send(self, kind="share", **kw):
        return await d.send(msg(**kw), kind=kind, db=self.db)


@unittest.skipUnless(env.MONGO, "MongoDB not reachable")
class Routing(Base):
    async def test_order_then_next_provider_when_full(self):
        for i in range(7):
            r = await self.send(to=f"u{i}@example.com")
            self.assertEqual(r.status, "sent")
        self.assertEqual((len(self.resend.sent), len(self.brevo.sent)), (5, 2))
        u = await d.usage(self.db)
        self.assertEqual((u["resend"], u["brevo"], u["all"]), (5, 2, 7))
        settings.email_provider_order = "brevo,resend"
        await self.send(to="x@example.com")
        self.assertEqual(len(self.brevo.sent), 3)

    async def test_unconfigured_or_unknown_providers_are_skipped(self):
        settings.email_provider_order = "mailgun, brevo"
        self.assertEqual([p.name for p in d.providers()], ["brevo", "resend"])
        with mock.patch.object(self.brevo, "configured", lambda: False):
            self.assertEqual([p.name for p in d.providers()], ["resend"])
            self.assertEqual(d.total_limit(), 5)

    async def test_tier_headroom(self):
        # Combined room 10: bulk stops at 8, transactional at 9, auth uses all and then still tries.
        self.assertEqual((d.tier_cap("bulk"), d.tier_cap("transactional"), d.tier_cap("auth")), (8, 9, 10))
        for i in range(8):
            self.assertEqual((await self.send("digest", to=f"b{i}@example.com")).status, "sent")
        self.assertEqual((await self.send("digest", to="b9@example.com")).status, "deferred")
        self.assertEqual((await self.send("campaign_test", to="t1@example.com")).status, "sent")
        self.assertEqual((await self.send("mention", to="t2@example.com")).status, "deferred")
        self.assertEqual((await self.send("login", to="l1@example.com")).status, "sent")
        # Both providers are at their limit now: a sign-in code still goes (forced).
        r = await self.send("login", to="l2@example.com")
        self.assertEqual(r.status, "sent")
        u = await d.usage(self.db)
        self.assertEqual(u["all"], 11)
        self.assertEqual(await self.db[d.RETRY].count_documents({}), 2)
        self.assertEqual({x["priority"] for x in await self.rows(status="deferred")}, {"bulk", "transactional"})

    async def test_multi_recipient_counts_each(self):
        r = await d.send(msg(to=["a@example.com", "Bo <b@example.com>", "c@example.com"]), kind="guide_access_request",
                         db=self.db)
        self.assertEqual(r.status, "sent")
        self.assertEqual((await d.usage(self.db))["resend"], 3)
        rows = await self.rows()
        self.assertEqual(sorted(x["to"] for x in rows), ["a@example.com", "b@example.com", "c@example.com"])
        self.assertTrue(all(x["provider"] == "resend" and x["provider_message_id"] == "resend-1" for x in rows))

    async def test_fallback_on_provider_error(self):
        self.resend.errors = [five_xx()]
        r = await self.send()
        self.assertEqual((r.status, r.provider), ("sent", "brevo"))
        u = await d.usage(self.db)
        self.assertEqual((u.get("resend", 0), u["brevo"], u["all"]), (0, 1, 1))  # the failed claim was released
        self.resend.errors = [d.ProviderError("Couldn't reach Resend: ConnectError")]
        self.brevo.errors = [d.ProviderError("Brevo 429: slow down", status=429)]
        with self.assertRaises(d.DeliveryError) as cm:
            await self.send(to="z@example.com")
        self.assertEqual(len(cm.exception.errors), 2)
        row = (await self.rows(to="z@example.com"))[0]
        self.assertEqual((row["status"], row["provider"]), ("failed", None))
        self.assertIn("Brevo 429", row["error"])
        self.assertEqual((await d.usage(self.db))["all"], 1)

    async def test_payload_error_does_not_fall_back(self):
        self.resend.errors = [d.ProviderError("Resend 422: bad address", status=422, fallback=False)]
        with self.assertRaises(d.DeliveryError):
            await self.send(to="bad@example.com")
        self.assertEqual(self.brevo.sent, [])
        self.assertEqual((await self.rows())[0]["status"], "failed")

    async def test_quota_error_marks_provider_full(self):
        self.resend.errors = [d.ProviderError("Resend 429 daily_quota_exceeded", status=429, quota=True)]
        r = await self.send()
        self.assertEqual(r.provider, "brevo")
        self.assertEqual((await d.usage(self.db))["resend"], 5)
        r = await self.send(to="n@example.com")
        self.assertEqual(r.provider, "brevo")
        self.assertEqual(self.resend.sent, [])

    async def test_both_full_defers_then_sends_next_day_then_gives_up(self):
        self.resend._limit = self.brevo._limit = 1
        # combined 2: transactional cap 1 (int(1.9))
        self.assertEqual((await self.send(to="a@example.com")).status, "sent")
        r = await self.send(to="late@example.com")
        self.assertEqual(r.status, "deferred")
        item = await self.db[d.RETRY].find_one({})
        self.assertEqual(item["due_at"].replace(tzinfo=timezone.utc), d.next_day())
        # Nothing is due yet.
        self.assertEqual(await d.process_retries(self.db), {})
        # Tomorrow (counters are per UTC day).
        tomorrow = d.next_day() + timedelta(minutes=1)
        with mock.patch.object(d, "now", lambda: tomorrow):
            self.assertEqual(await d.process_retries(self.db, at=tomorrow), {"sent": 1})
        row = (await self.rows(to="late@example.com"))
        self.assertEqual(len(row), 1)
        self.assertEqual((row[0]["status"], row[0]["attempts"], row[0]["provider"]), ("sent", 2, "resend"))
        self.assertEqual(await self.db[d.RETRY].count_documents({}), 0)

        # Over the limit three days running: dropped as over_limit.
        self.resend._limit = self.brevo._limit = 0
        self.assertEqual((await self.send(to="never@example.com")).status, "deferred")
        for day in range(1, d.MAX_RETRY_DAYS + 1):
            at = d.next_day() + timedelta(days=day, minutes=1)
            with mock.patch.object(d, "now", lambda at=at: at):
                await d.process_retries(self.db, at=at)
        row = (await self.rows(to="never@example.com"))[0]
        self.assertEqual((row["status"], row["attempts"]), ("over_limit", d.MAX_RETRY_DAYS + 1))
        self.assertEqual(await self.db[d.RETRY].count_documents({}), 0)

    async def test_no_provider_is_skipped(self):
        with mock.patch.dict(d.PROVIDERS, {}, clear=True):
            r = await self.send()
        self.assertEqual(r.status, "skipped")
        self.assertEqual((await self.rows())[0]["status"], "skipped")

    async def test_concurrent_claims_never_exceed_the_limit(self):
        import asyncio

        self.resend._limit, self.brevo._limit = 6, 0
        rs = await asyncio.gather(*[self.send("login", to=f"c{i}@example.com") for i in range(6)],
                                  *[self.send("digest", to=f"d{i}@example.com") for i in range(6)])
        bulk_sent = sum(1 for r in rs[6:] if r.status == "sent")
        self.assertLessEqual(bulk_sent, 4)  # bulk cap int(6 * 0.8)
        self.assertEqual(sum(1 for r in rs[:6] if r.status == "sent"), 6)  # sign-in always goes


@unittest.skipUnless(env.MONGO, "MongoDB not reachable")
class Batches(Base):
    def batch(self, n, cid="c1"):
        return [{**msg(to=f"r{i}@example.com", subject="News"), "headers": {"X-Markdrop-Campaign": cid}}
                for i in range(n)]

    async def test_batch_routes_whole_and_logs_each(self):
        self.resend._limit, self.brevo._limit = 10, 10
        t = d.RoutedTransport(self.db)
        self.assertEqual(await t.room(), 10)  # one provider takes a batch; bulk cap 16
        self.resend.reject = {"r1@example.com"}
        out = await t.send_batch(self.batch(3), "md-c1-k1")
        self.assertEqual([o.error is None for o in out], [True, False, True])
        self.assertEqual(self.resend.batches[0][1], "md-c1-k1")
        rows = await self.rows(kind="campaign")
        self.assertEqual(len(rows), 3)
        self.assertEqual({r["ref"] for r in rows}, {"c1"})
        self.assertEqual(sorted(r["status"] for r in rows), ["failed", "sent", "sent"])
        u = await d.usage(self.db)
        self.assertEqual((u["resend"], u["all"]), (2, 2))  # a rejected message doesn't count
        self.assertEqual((await self.db[d.ROUTES].find_one({"_id": "md-c1-k1"}))["provider"], "resend")

    async def test_batch_falls_back_and_brevo_gets_no_key(self):
        self.resend.errors = [five_xx()]
        out = await d.RoutedTransport(self.db).send_batch(self.batch(2), "md-c1-k2")
        self.assertTrue(all(o.error is None for o in out))
        self.assertEqual(self.brevo.batches, [(["r0@example.com", "r1@example.com"], None)])
        self.assertEqual((await self.db[d.ROUTES].find_one({"_id": "md-c1-k2"}))["provider"], "brevo")
        # A crash mid-post to Brevo can't be re-posted safely.
        again = await d.RoutedTransport(self.db).repost(self.batch(2), "md-c1-k2")
        self.assertTrue(all("may have been delivered" in o.error for o in again))
        self.assertEqual(len(self.brevo.sent), 2)

    async def test_batch_no_room(self):
        self.resend._limit, self.brevo._limit = 2, 2
        t = d.RoutedTransport(self.db)
        self.assertEqual(await t.room(), 2)
        with self.assertRaises(d.NoRoom):
            await t.send_batch(self.batch(3), "k")  # bulk cap 3, but no provider has 3
        self.assertEqual((await d.usage(self.db))["all"], 0)
        self.assertEqual(len(await t.send_batch(self.batch(2), "k2")), 2)
        self.assertEqual(await t.room(), 1)

    async def test_test_send_is_transactional(self):
        out = await d.RoutedTransport(self.db).send_batch(self.batch(1, cid="test"), "md-test-1")
        self.assertIsNone(out[0].error)
        row = (await self.rows())[0]
        self.assertEqual((row["kind"], row["priority"], row["ref"]), ("campaign_test", "transactional", None))


def draft(emails):
    t = templates.get_template("newsletter")
    return render.parse_content({
        "name": "Limit test", "subject": t["subject"], "subject_fallback": t["subject_fallback"],
        "preheader": t["preheader"], "doc": t["doc"], "template": "newsletter",
        "audience": {"kind": "custom", "emails": "\n".join(emails)},
    })


@unittest.skipUnless(env.MONGO, "MongoDB not reachable")
class CampaignLimits(Base):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        audience.invalidate()
        self._batch = settings.email_batch_size
        settings.email_batch_size = 10

    async def asyncTearDown(self):
        settings.email_batch_size = self._batch
        audience.invalidate()
        await super().asyncTearDown()

    async def test_campaign_stops_at_bulk_cap_and_continues_next_day(self):
        self.resend._limit, self.brevo._limit = 5, 0  # bulk cap 4
        emails = [f"p{i}@example.com" for i in range(6)]
        c = await engine.create(self.db, draft(emails), "admin")
        await engine.queue(self.db, str(c["_id"]), "send to 6", "admin")
        t = transport.RoutedTransport(self.db)
        r = await engine.tick(self.db, c["_id"], t=t, owner="w1")
        self.assertEqual(r["sent_now"], 4)
        self.assertEqual(r["campaign"]["status"], "sending")
        self.assertIsNotNone(r["deferred_until"])
        self.assertIn("limit", r["campaign"]["last_error"])
        self.assertEqual(len(await self.rows(kind="campaign", status="sent")), 4)
        # Later today: nothing moves.
        r = await engine.tick(self.db, c["_id"], t=t, owner="w1")
        self.assertEqual(r["sent_now"], 0)
        # Tomorrow: a new day's counters, the rest goes.
        await self.db["email_campaigns"].update_one({"_id": c["_id"]}, {"$set": {
            "deferred_until": datetime.now(timezone.utc) - timedelta(seconds=1)}})
        await self.db[d.QUOTA].delete_many({})
        r = await engine.tick(self.db, c["_id"], t=t, owner="w1")
        self.assertEqual(r["sent_now"], 2)
        self.assertEqual(r["campaign"]["status"], "sent")
        self.assertIsNone(r["campaign"]["last_error"])
        self.assertEqual(len(await self.rows(kind="campaign", status="sent")), 6)
        # The campaign's own report still counts its messages.
        rep = await self.db["email_messages"].count_documents({"campaign_id": c["_id"], "status": "sent"})
        self.assertEqual(rep, 6)

    async def test_campaign_provider_errors_keep_engine_semantics(self):
        self.resend.errors = [d.ProviderError("Resend 403: domain not verified", status=403)]
        self.brevo.errors = [d.ProviderError("Brevo 401: key", status=401)]
        c = await engine.create(self.db, draft(["q1@example.com"]), "admin")
        await engine.queue(self.db, str(c["_id"]), "send to 1", "admin")
        r = await engine.tick(self.db, c["_id"], t=transport.RoutedTransport(self.db), owner="w1")
        self.assertEqual(r["campaign"]["status"], "paused")  # fatal: the sender/key is the problem
        self.assertIn("Brevo 401", r["campaign"]["last_error"])


@unittest.skipUnless(env.MONGO, "MongoDB not reachable")
class MailerPath(Base):
    async def test_login_email_is_auth_and_logged(self):
        with mock.patch("app.database.get_database", lambda: self.db):
            self.assertTrue(mailer.is_configured())
            await mailer.send_login_email("Ann@Example.com", "123456", "https://markdrop.in/login?x")
            await mailer.send_access_decision_email(to_email="b@example.com", owner_name="Ann", document_title="Plan",
                                                    slug="plan-1", approved=True)
        rows = await self.rows()
        self.assertEqual([(r["kind"], r["priority"], r["to"]) for r in rows],
                         [("login", "auth", "ann@example.com"), ("access_decision", "transactional", "b@example.com")])
        self.assertEqual(rows[1]["ref"], "plan-1")
        self.assertIn({"name": "kind", "value": "login"}, self.resend.sent[0]["tags"])

    async def test_failure_raises_for_callers(self):
        self.resend.errors = [five_xx()]
        self.brevo.errors = [five_xx("brevo")]
        with mock.patch("app.database.get_database", lambda: self.db), self.assertRaises(d.DeliveryError):
            await mailer.send_login_email("a@example.com", "1", "https://markdrop.in")


class BrevoWire(unittest.IsolatedAsyncioTestCase):
    """The real Brevo/Resend classes against httpx.MockTransport."""

    def setUp(self):
        self.calls: list[httpx.Request] = []
        self._keys = (settings.brevo_api_key, settings.resend_api_key)
        settings.brevo_api_key, settings.resend_api_key = "xkeysib-test", "re_test"
        self.status, self.body = 201, {"messageId": "<abc@smtp-relay.mailin.fr>"}
        real = httpx.AsyncClient

        def handler(req: httpx.Request) -> httpx.Response:
            self.calls.append(req)
            return httpx.Response(self.status, json=self.body)

        self.p = mock.patch.object(d.httpx, "AsyncClient",
                                   lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
        self.p.start()

    def tearDown(self):
        self.p.stop()
        settings.brevo_api_key, settings.resend_api_key = self._keys

    async def test_payload_shape(self):
        m = {"from": "Markdrop <share@markdrop.in>", "to": ["a@example.com"], "subject": "Hi",
             "html": "<p>x</p>", "text": "x", "reply_to": "help@markdrop.in",
             "headers": {"List-Unsubscribe": "<https://x/u>"}, "tags": [{"name": "kind", "value": "share"}]}
        mid = await d.Brevo().send(m)
        self.assertEqual(mid, "<abc@smtp-relay.mailin.fr>")
        req = self.calls[0]
        self.assertEqual(str(req.url), "https://api.brevo.com/v3/smtp/email")
        self.assertEqual(req.headers["api-key"], "xkeysib-test")
        self.assertEqual(json.loads(req.content), {
            "sender": {"email": "share@markdrop.in", "name": "Markdrop"},
            "to": [{"email": "a@example.com"}],
            "subject": "Hi", "htmlContent": "<p>x</p>", "textContent": "x",
            "replyTo": {"email": "help@markdrop.in"},
            "headers": {"List-Unsubscribe": "<https://x/u>"},
            "tags": ["kind:share"],
        })

    async def test_errors(self):
        self.status, self.body = 402, {"code": "not_enough_credits", "message": "no credits"}
        with self.assertRaises(d.ProviderError) as cm:
            await d.Brevo().send(msg())
        self.assertTrue(cm.exception.quota and cm.exception.fallback)
        self.status, self.body = 400, {"code": "invalid_parameter", "message": "bad email"}
        with self.assertRaises(d.ProviderError) as cm:
            await d.Brevo().send(msg())
        self.assertFalse(cm.exception.fallback)
        self.status, self.body = 429, {"name": "daily_quota_exceeded", "message": "quota"}
        with self.assertRaises(d.ProviderError) as cm:
            await d.Resend().send(msg())
        self.assertTrue(cm.exception.quota)
        self.status, self.body = 502, {}
        with self.assertRaises(d.ProviderError) as cm:
            await d.Resend().send(msg())
        self.assertTrue(cm.exception.fallback and not cm.exception.quota)

    async def test_brevo_batch_loops_one_request_per_message(self):
        out = await d.Brevo().send_batch([msg(to="a@example.com"), msg(to="b@example.com")], "ignored")
        self.assertEqual(len(self.calls), 2)
        self.assertTrue(all(o.provider_id for o in out))
        self.assertNotIn("idempotency-key", {k.lower() for k in self.calls[0].headers})

    async def test_resend_batch_uses_idempotency_key(self):
        self.status, self.body = 200, {"data": [{"id": "r1"}], "errors": [{"index": 1, "message": "bad"}]}
        out = await d.Resend().send_batch([msg(to="a@example.com"), msg(to="b@example.com")], "md-k")
        self.assertEqual([(o.provider_id, o.error) for o in out], [("r1", None), (None, "bad")])
        self.assertEqual(self.calls[0].headers["Idempotency-Key"], "md-k")
        self.assertEqual(str(self.calls[0].url), "https://api.resend.com/emails/batch")


@unittest.skipUnless(env.MONGO, "MongoDB not reachable")
class AdminApi(Base):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        from app.main import app
        from app.routers import admin as admin_router, admin_email
        from tests._admin_session import admin_headers

        self.app = app
        app.dependency_overrides[admin_email.get_db] = lambda: self.db
        app.dependency_overrides[admin_router.get_db] = lambda: self.db
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://api.markdrop.in",
                                      headers=await admin_headers(self.db))

    async def asyncTearDown(self):
        self.app.dependency_overrides.clear()
        await self.http.aclose()
        await super().asyncTearDown()

    async def test_auth(self):
        user_tok = jwt.encode({"sub": "u1", "exp": datetime.now(timezone.utc) + timedelta(hours=1)},
                              settings.auth_secret, algorithm="HS256")
        for path in ("/api/v1/admin/email/usage", "/api/v1/admin/email/log"):
            self.assertEqual((await self.http.get(path, headers={"Authorization": ""})).status_code, 401)
            # A signed-in non-admin (here: not even a full session) gets 404, as if the route didn't exist.
            self.assertEqual((await self.http.get(path, headers={"Authorization": f"Bearer {user_tok}"})).status_code, 404)

    async def test_usage_and_log(self):
        self.resend._limit, self.brevo._limit = 5, 5
        for i in range(6):
            await self.send(to=f"u{i}@example.com", subject=f"S{i}")
        await self.send("digest", to="d@example.com")
        self.brevo.errors = [d.ProviderError("Brevo 400: bad", status=400, fallback=False)]
        with self.assertRaises(d.DeliveryError):
            await self.send(to="fail@example.com")
        u = (await self.http.get("/api/v1/admin/email/usage")).json()
        prov = {p["name"]: p for p in u["providers"]}
        self.assertEqual((prov["resend"]["used"], prov["brevo"]["used"]), (5, 2))
        self.assertEqual(u["total"], {"used": 7, "limit": 10, "pct": 0.7})
        self.assertFalse(u["warn"])
        self.assertEqual(len(u["days"]), 14)
        self.assertEqual(u["days"][-1]["sent"], {"resend": 5, "brevo": 2})
        self.assertEqual(u["days"][-1]["failed"], 1)
        kinds = {k["kind"]: k for k in u["by_kind"]}
        self.assertEqual((kinds["share"]["sent"], kinds["share"]["failed"], kinds["digest"]["priority"]), (6, 1, "bulk"))
        self.assertEqual(u["caps"]["bulk"]["limit"], 8)

        await self.send(to="w@example.com")
        self.assertTrue((await self.http.get("/api/v1/admin/email/usage")).json()["warn"])  # 8 of 10

        log = (await self.http.get("/api/v1/admin/email/log?limit=3")).json()
        self.assertEqual((log["total"], len(log["rows"])), (9, 3))
        self.assertEqual(log["rows"][0]["to"], "w@example.com")
        f = (await self.http.get("/api/v1/admin/email/log?status=failed")).json()
        self.assertEqual(f["total"], 1)
        self.assertIn("Brevo 400", f["rows"][0]["error"])
        self.assertEqual((await self.http.get("/api/v1/admin/email/log?provider=brevo")).json()["total"], 3)
        self.assertEqual((await self.http.get("/api/v1/admin/email/log?kind=digest")).json()["total"], 1)
        self.assertEqual((await self.http.get("/api/v1/admin/email/log?q=U3@")).json()["total"], 1)
        self.assertEqual((await self.http.get("/api/v1/admin/email/log?q=.*")).json()["total"], 0)  # not a regex
        today = d.day_key()
        self.assertEqual((await self.http.get(f"/api/v1/admin/email/log?since={today}&until={today}")).json()["total"], 9)
        self.assertEqual((await self.http.get("/api/v1/admin/email/log?until=2000-01-01")).json()["total"], 0)
