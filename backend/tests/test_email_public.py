"""Public email endpoints over HTTP (ASGI, no network): open pixel, click
redirect (allow-list, no open redirect), unsubscribe by message token and by
the legacy user token (GET and RFC 8058 one-click POST), and Resend webhook
signature verification.
"""

from __future__ import annotations

import json
import time
import unittest
from datetime import datetime, timezone

from tests import _email_env as env

import httpx

from app.config import get_settings
from app.main import app
from app.routers import auth as auth_router
from app.routers import email_public
from app.services import campaign as legacy_campaign
from app.services.email_campaigns import audience, store, webhooks

settings = get_settings()
SECRET = "whsec_" + "c2VjcmV0LWZvci10ZXN0cy1vbmx5LTEyMzQ1Njc4OTA="


@unittest.skipUnless(env.MONGO, "MongoDB not reachable")
class Public(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.name = env.new_db_name()
        self.client, self.db = await env.make_db(self.name)
        audience.invalidate()
        app.dependency_overrides[email_public.get_db] = lambda: self.db
        app.dependency_overrides[auth_router.get_db] = lambda: self.db
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://api.markdrop.in")
        self.cid = (await self.db["email_campaigns"].insert_one({"name": "c", "status": "sent"})).inserted_id
        self.user = (await self.db["users"].insert_one({"email": "ann@example.com", "name": "Ann"})).inserted_id
        self.token = "tokenAAAAAAAAAAAAAAAAAAA"
        m = store.new_message(self.cid, {"email": "ann@example.com", "name": "Ann", "user_id": str(self.user)}, self.token)
        m.update(status="sent", provider_id="re_123")
        self.mid = (await self.db["email_messages"].insert_one(m)).inserted_id
        self._secret = settings.resend_webhook_secret

    async def asyncTearDown(self):
        settings.resend_webhook_secret = self._secret
        app.dependency_overrides.clear()
        await self.http.aclose()
        await self.client.drop_database(self.name)
        self.client.close()

    async def msg(self):
        return await self.db["email_messages"].find_one({"_id": self.mid})

    # ── pixel ──
    async def test_open_pixel(self):
        r = await self.http.get(f"/api/v1/email/o/{self.token}.gif", headers={"user-agent": "Mail/1"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["content-type"], "image/gif")
        self.assertIn("no-store", r.headers["cache-control"])
        self.assertTrue(r.content.startswith(b"GIF89a"))
        await self.http.get(f"/api/v1/email/o/{self.token}.gif")
        m = await self.msg()
        self.assertEqual(m["open_count"], 2)
        self.assertIsNotNone(m["first_open_at"])
        self.assertEqual(await self.db["email_events"].count_documents({"type": "open"}), 2)
        for t in ("preview", "test", "unknownTOKEN1234567890", "bad$token"):
            r = await self.http.get(f"/api/v1/email/o/{t}.gif")
            self.assertEqual(r.status_code, 200)
        self.assertEqual((await self.msg())["open_count"], 2)

    # ── click ──
    async def test_click_redirect_and_allow_list(self):
        u = "https://markdrop.in/new?utm_source=email"
        r = await self.http.get(f"/api/v1/email/c/{self.token}", params={"u": u})
        self.assertEqual(r.status_code, 302)
        self.assertEqual(r.headers["location"], u)
        self.assertEqual(r.headers["referrer-policy"], "no-referrer")
        m = await self.msg()
        self.assertEqual(m["click_count"], 1)
        self.assertIsNotNone(m["first_open_at"])  # a click counts as an open
        ev = await self.db["email_events"].find_one({"type": "click"})
        self.assertEqual(ev["url"], u)
        for bad in ("https://evil.example/", "javascript:alert(1)", "https://markdrop.in.evil.example/x",
                    "//evil.example", "https://user@markdrop.in/", ""):
            r = await self.http.get(f"/api/v1/email/c/{self.token}", params={"u": bad})
            self.assertEqual(r.status_code, 400, bad)
            self.assertNotIn("location", r.headers)
        self.assertEqual((await self.msg())["click_count"], 1)
        # unknown and preview tokens still redirect (never reveal validity), never record
        for t in ("preview", "unknownTOKEN1234567890"):
            r = await self.http.get(f"/api/v1/email/c/{t}", params={"u": "https://github.com/himanshkukreja/markdrop"})
            self.assertEqual(r.status_code, 302)
        self.assertEqual(await self.db["email_events"].count_documents({"type": "click"}), 1)

    # ── unsubscribe (message token) ──
    async def test_unsubscribe_page_then_post(self):
        r = await self.http.get(f"/api/v1/email/u/{self.token}")
        self.assertEqual(r.status_code, 200)
        self.assertIn('<form method="post"', r.text)
        self.assertNotIn("unsubscribed_at", await self.msg())  # GET alone changes nothing (link scanners)
        r = await self.http.post(f"/api/v1/email/u/{self.token}")
        self.assertEqual(r.status_code, 200)
        self.assertIn("unsubscribed", r.text)
        self.assertIsNotNone((await self.msg())["unsubscribed_at"])
        self.assertEqual((await self.db["email_suppressions"].find_one({"_id": "ann@example.com"}))["reason"], "unsubscribed")
        self.assertIsNotNone((await self.db["users"].find_one({"_id": self.user}))["unsubscribed_at"])
        # idempotent: one event however often
        await self.http.post(f"/api/v1/email/u/{self.token}")
        self.assertEqual(await self.db["email_events"].count_documents({"type": "unsubscribe"}), 1)

    async def test_one_click_post_and_test_token(self):
        r = await self.http.post(f"/api/v1/email/u/{self.token}", content=b"List-Unsubscribe=One-Click",
                                 headers={"content-type": "application/x-www-form-urlencoded"})
        self.assertEqual(r.status_code, 200)
        self.assertIsNotNone((await self.msg())["unsubscribed_at"])
        r = await self.http.post("/api/v1/email/u/test", content=b"List-Unsubscribe=One-Click")
        self.assertEqual(r.status_code, 200)
        self.assertIn("Nothing changed", r.text)
        self.assertEqual(await self.db["email_suppressions"].count_documents({}), 1)
        r = await self.http.post("/api/v1/email/u/unknownTOKEN1234567890")
        self.assertEqual(r.status_code, 400)

    # ── unsubscribe (legacy user tokens, already in inboxes) ──
    async def test_legacy_user_token_links(self):
        t = legacy_campaign.unsubscribe_token(str(self.user))
        r = await self.http.get("/api/v1/auth/unsubscribe", params={"t": t})
        self.assertEqual(r.status_code, 200)
        self.assertIsNotNone((await self.db["users"].find_one({"_id": self.user}))["unsubscribed_at"])
        self.assertEqual((await self.db["email_suppressions"].find_one({"_id": "ann@example.com"}))["reason"], "unsubscribed")
        await self.db["users"].update_one({"_id": self.user}, {"$set": {"unsubscribed_at": None}})
        r = await self.http.post("/api/v1/unsubscribe", params={"t": t}, content=b"List-Unsubscribe=One-Click")
        self.assertEqual(r.status_code, 200)
        self.assertIsNotNone((await self.db["users"].find_one({"_id": self.user}))["unsubscribed_at"])
        r = await self.http.get("/api/v1/auth/unsubscribe", params={"t": t[:-1] + ("1" if t[-1] == "0" else "0")})
        self.assertEqual(r.status_code, 400)

    # ── webhooks ──
    def signed(self, payload: dict, *, secret=SECRET, ts=None, msg_id="msg_1"):
        body = json.dumps(payload).encode()
        ts = str(ts or int(time.time()))
        return body, {"svix-id": msg_id, "svix-timestamp": ts, "svix-signature": webhooks.sign(secret, msg_id, ts, body),
                      "content-type": "application/json"}

    async def test_webhook_requires_secret(self):
        settings.resend_webhook_secret = ""
        body, h = self.signed({"type": "email.delivered", "data": {"email_id": "re_123"}})
        r = await self.http.post("/api/v1/email/webhooks/resend", content=body, headers=h)
        self.assertEqual(r.status_code, 503)

    async def test_webhook_signature_and_effects(self):
        settings.resend_webhook_secret = SECRET
        ev = {"type": "email.delivered", "created_at": datetime.now(timezone.utc).isoformat(),
              "data": {"email_id": "re_123", "to": ["ann@example.com"]}}
        body, h = self.signed(ev)
        r = await self.http.post("/api/v1/email/webhooks/resend", content=body, headers=h)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIsNotNone((await self.msg())["delivered_at"])
        # replay of the same Svix id is a no-op
        r = await self.http.post("/api/v1/email/webhooks/resend", content=body, headers=h)
        self.assertTrue(r.json().get("duplicate"))
        # tampered body, wrong secret, stale timestamp, missing headers
        r = await self.http.post("/api/v1/email/webhooks/resend", content=body + b" ", headers=h)
        self.assertEqual(r.status_code, 401)
        b2, h2 = self.signed(ev, secret="whsec_" + "d3Jvbmc=", msg_id="msg_2")
        self.assertEqual((await self.http.post("/api/v1/email/webhooks/resend", content=b2, headers=h2)).status_code, 401)
        b3, h3 = self.signed(ev, ts=int(time.time()) - 3600, msg_id="msg_3")
        self.assertEqual((await self.http.post("/api/v1/email/webhooks/resend", content=b3, headers=h3)).status_code, 401)
        self.assertEqual((await self.http.post("/api/v1/email/webhooks/resend", content=body)).status_code, 401)
        # hard bounce → suppression; complaint → suppression + account unsubscribed
        b4, h4 = self.signed({"type": "email.bounced", "data": {"email_id": "re_123", "to": ["ann@example.com"],
                                                               "bounce": {"type": "Permanent", "message": "no such user"}}}, msg_id="msg_4")
        self.assertEqual((await self.http.post("/api/v1/email/webhooks/resend", content=b4, headers=h4)).status_code, 200)
        self.assertIsNotNone((await self.msg())["bounced_at"])
        self.assertEqual((await self.db["email_suppressions"].find_one({"_id": "ann@example.com"}))["reason"], "bounced")
        b5, h5 = self.signed({"type": "email.complained", "data": {"email_id": "re_x", "to": ["bob@example.com"]}}, msg_id="msg_5")
        self.assertEqual((await self.http.post("/api/v1/email/webhooks/resend", content=b5, headers=h5)).status_code, 200)
        self.assertEqual((await self.db["email_suppressions"].find_one({"_id": "bob@example.com"}))["reason"], "complained")
        # transient bounce does not suppress
        b6, h6 = self.signed({"type": "email.bounced", "data": {"email_id": "re_y", "to": ["carl@example.com"],
                                                               "bounce": {"type": "Transient"}}}, msg_id="msg_6")
        await self.http.post("/api/v1/email/webhooks/resend", content=b6, headers=h6)
        self.assertIsNone(await self.db["email_suppressions"].find_one({"_id": "carl@example.com"}))

    def test_verify_unit(self):
        body = b'{"a":1}'
        ts = str(int(time.time()))
        sig = webhooks.sign(SECRET, "m", ts, body)
        webhooks.verify(SECRET, {"svix-id": "m", "svix-timestamp": ts, "svix-signature": f"v1,bogus {sig}"}, body)
        with self.assertRaises(webhooks.SignatureError):
            webhooks.verify(SECRET, {"svix-id": "m", "svix-timestamp": ts, "svix-signature": "v1,bogus"}, body)


if __name__ == "__main__":
    unittest.main()
