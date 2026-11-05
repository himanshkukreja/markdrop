"""Push notifications (services/webpush.py, services/push.py, routers/push.py).

The protocol is checked against RFC 8291's own example; the rest runs in the access-policy world
(tests/_access_env.py: the test MongoDB or mongomock, never backend/.env). Nothing leaves the
process: the push service is an httpx.MockTransport that records each request, and each test's
"browser" holds its own P-256 key and auth secret so it can decrypt what it got.
"""

from __future__ import annotations

import json
import os
import secrets
import unittest
from datetime import timedelta
from unittest import mock

from tests._access_env import now  # noqa: F401  (pins settings first)

import httpx
import jwt
from bson import ObjectId
from cryptography.hazmat.primitives.asymmetric import ec

from app.config import Settings, get_settings
from app.services import access_requests, notifications, push, webpush
from tests.test_notifications import NotifyWorld, person

settings = get_settings()
FCM = "https://fcm.googleapis.com/fcm/send/"
UA_ANDROID = ("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/130.0.0.0 Mobile Safari/537.36")
UA_IPHONE = ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) "
             "Version/18.1 Mobile/15E148 Safari/604.1")


class Browser:
    """One device's push subscription: its keys, and what the push service delivered to it."""

    def __init__(self, host: str = FCM):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.auth = os.urandom(16)
        self.endpoint = host + secrets.token_urlsafe(24)

    def subscription(self, **extra) -> dict:
        return {"endpoint": self.endpoint, "keys": {"p256dh": webpush.b64u(webpush.public_bytes(self.key)),
                                                    "auth": webpush.b64u(self.auth)}, **extra}

    def read(self, request: httpx.Request) -> dict:
        return json.loads(webpush.decrypt(request.content, self.key, self.auth))


# ── The protocol ──────────────────────────────────────────────────────────────


class Crypto(unittest.TestCase):
    def test_rfc8291_example(self):
        """RFC 8291 Appendix A, byte for byte."""
        as_key = webpush.load_private_key("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")
        ua_key = webpush.load_private_key("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94")
        ua_pub = webpush.b64u(webpush.public_bytes(ua_key))
        self.assertEqual(ua_pub, "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4")
        msg = webpush.encrypt(b"When I grow up, I want to be a watermelon", ua_pub, "BTBZMqHH6r4Tts7J_aSIgg",
                              salt=webpush.unb64u("DGv6ra1nlYgDCS1FRnbzlw"), server_key=as_key)
        self.assertEqual(webpush.b64u(msg),
                         "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6Tlz"
                         "AC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN")
        self.assertEqual(webpush.decrypt(msg, ua_key, webpush.unb64u("BTBZMqHH6r4Tts7J_aSIgg")),
                         b"When I grow up, I want to be a watermelon")

    def test_every_message_has_its_own_salt_and_key(self):
        b = Browser()
        p256dh, auth = b.subscription()["keys"].values()
        one, two = webpush.encrypt(b"hi", p256dh, auth), webpush.encrypt(b"hi", p256dh, auth)
        self.assertNotEqual(one[:16], two[:16])
        self.assertNotEqual(one[21:86], two[21:86])
        self.assertEqual(webpush.decrypt(two, b.key, b.auth), b"hi")

    def test_bad_subscription_keys_and_large_payloads_are_refused(self):
        b = Browser()
        p256dh, auth = b.subscription()["keys"].values()
        with self.assertRaises(ValueError):
            webpush.encrypt(b"x", webpush.b64u(b"\x04" + b"\x00" * 10), auth)
        with self.assertRaises(ValueError):
            webpush.encrypt(b"x" * 4000, p256dh, auth)

    def test_vapid_header_is_an_es256_token_for_the_push_service(self):
        keys = webpush.generate_keys()
        with mock.patch.object(settings, "vapid_private_key", keys["private"]), \
                mock.patch.object(settings, "vapid_public_key", keys["public"]), \
                mock.patch.object(settings, "vapid_subject", "mailto:ops@example.com"):
            v = webpush.vapid()
            header = webpush.vapid_header(FCM + "abc", v)
        self.assertTrue(header.startswith("vapid t="))
        token = header.split("t=", 1)[1].split(",", 1)[0]
        self.assertEqual(header.rsplit("k=", 1)[1], keys["public"])
        pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), webpush.unb64u(keys["public"]))
        claims = jwt.decode(token, pub, algorithms=["ES256"], audience="https://fcm.googleapis.com")
        self.assertEqual(claims["sub"], "mailto:ops@example.com")
        self.assertLessEqual(claims["exp"] - now().timestamp(), 24 * 3600)

    def test_check_keys(self):
        keys, other = webpush.generate_keys(), webpush.generate_keys()

        def check(**kw):
            s = Settings(_env_file=None, **{"vapid_private_key": "", "vapid_public_key": "",
                                            "vapid_subject": "https://markdrop.in", **kw})
            return webpush.check_keys(s)

        self.assertEqual(check()["configured"], False)
        self.assertEqual(check(vapid_public_key=keys["public"])["problems"],
                         ["MARKDROP_VAPID_PUBLIC_KEY is set but MARKDROP_VAPID_PRIVATE_KEY isn't"])
        good = check(vapid_private_key=keys["private"], vapid_public_key=keys["public"])
        self.assertEqual((good["ok"], good["public_key"], good["problems"]), (True, keys["public"], []))
        self.assertTrue(check(vapid_private_key=keys["private"])["ok"])  # the public key is derived
        self.assertIn("doesn't match", check(vapid_private_key=keys["private"],
                                              vapid_public_key=other["public"])["problems"][0])
        self.assertIn("32 bytes", check(vapid_private_key="abc")["problems"][0])
        self.assertIn("mailto:", check(vapid_private_key=keys["private"], vapid_subject="ops@example.com")["problems"][0])

    def test_the_env_keys_are_declared(self):
        """The model forbids unknown MARKDROP_* keys in .env (a misspelt one crash-looped the API once):
        these exact names must load from a .env file, as the owner will paste them."""
        import tempfile

        keys = webpush.generate_keys()
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, ".env")
            with open(path, "w") as f:
                f.write(f"MARKDROP_VAPID_PUBLIC_KEY={keys['public']}\nMARKDROP_VAPID_PRIVATE_KEY={keys['private']}\n"
                        "MARKDROP_VAPID_SUBJECT=mailto:ops@example.com\n")
            s = Settings(_env_file=path)
            self.assertEqual((s.vapid_public_key, s.vapid_private_key, s.vapid_subject),
                             (keys["public"], keys["private"], "mailto:ops@example.com"))
            self.assertTrue(webpush.check_keys(s)["ok"])
            with open(path, "a") as f:
                f.write("MARKDROP_VAPID_PUBLICKEY=x\n")
            with self.assertRaises(Exception):
                Settings(_env_file=path)  # a misspelt key is refused, as before

    def test_only_push_services_are_endpoints(self):
        ok = ["https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/x",
              "https://web.push.apple.com/QGx", "https://wns2-par02p.notify.windows.com/w/?token=x",
              "https://android.googleapis.com/gcm/send/x"]
        bad = ["http://fcm.googleapis.com/fcm/send/abc", "https://fcm.googleapis.com.evil.test/x",
               "https://169.254.169.254/latest/meta-data", "https://localhost/x", "https://127.0.0.1:8080/x",
               "https://user:pw@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x", "ftp://fcm.googleapis.com/",
               "https://api.markdrop.in/api/v1/admin", "not a url", "https://evilnotify.windows.com.test/"]
        for u in ok:
            self.assertTrue(webpush.endpoint_allowed(u), u)
        for u in bad:
            self.assertFalse(webpush.endpoint_allowed(u), u)
        with mock.patch.object(settings, "push_endpoint_hosts_extra", "127.0.0.1:9999"):
            self.assertTrue(webpush.endpoint_allowed("http://127.0.0.1:9999/push/abc"))
            self.assertFalse(webpush.endpoint_allowed("http://127.0.0.1:8080/push/abc"))

    def test_device_labels(self):
        self.assertEqual(push.device_label(UA_ANDROID), "Chrome on Android")
        self.assertEqual(push.device_label(UA_IPHONE), "Safari on iPhone")
        self.assertEqual(push.device_label("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like "
                                           "Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0"), "Edge on Windows")
        self.assertEqual(push.device_label("Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:131.0) Gecko/20100101 "
                                           "Firefox/131.0"), "Firefox on Mac")
        self.assertEqual(push.device_label(None), "Browser")


# ── The world ─────────────────────────────────────────────────────────────────


class PushWorld(NotifyWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await push.ensure_indexes(self.db)
        keys = webpush.generate_keys()
        for p in (mock.patch.object(settings, "vapid_private_key", keys["private"]),
                  mock.patch.object(settings, "vapid_public_key", keys["public"]),
                  mock.patch.object(settings, "vapid_subject", "mailto:ops@example.com"),
                  mock.patch.object(push, "_last_prune", None)):
            p.start()
            self.addCleanup(p.stop)
        self.public_key = keys["public"]
        self.delivered: list[httpx.Request] = []
        self.answer: dict[str, int] = {}  # endpoint → status the push service gives

        def service(request: httpx.Request) -> httpx.Response:
            self.delivered.append(request)
            return httpx.Response(self.answer.get(str(request.url), 201))

        p = mock.patch.object(webpush, "transport", httpx.MockTransport(service))
        p.start()
        self.addCleanup(p.stop)
        self.browsers: dict[str, Browser] = {}

    async def device(self, who: str, ua: str = UA_ANDROID, browser: Browser | None = None, **extra) -> dict:
        b = browser or Browser()
        self.browsers[b.endpoint] = b
        r = await self.http.post("/api/v1/push/subscriptions", json=b.subscription(**extra),
                                 headers={**self.session(who), "User-Agent": ua})
        self.assertEqual(r.status_code, 200, r.text)
        return {"browser": b, **r.json()["device"]}

    def payloads(self, endpoint: str | None = None) -> list[dict]:
        return [self.browsers[str(r.url)].read(r) for r in self.delivered
                if endpoint is None or str(r.url) == endpoint]

    async def flush(self, seconds: float = 30):  # noqa: D401 - the push flush, after GATHER
        return await push.flush(self.db, now() + timedelta(seconds=seconds))

    async def outbox(self, who: str) -> list[dict]:
        return await self.db[push.OUTBOX].find({"user_id": self.uid[who]}).sort("created_at", 1).to_list(length=None)


# ── Devices ───────────────────────────────────────────────────────────────────


class Devices(PushWorld):
    async def test_subscribe_list_and_remove(self):
        d = await self.device("wm", standalone=True)
        self.assertEqual((d["label"], d["app"], d["service"], d["this_device"]), ("Chrome on Android", True, "Google", True))
        await self.device("wm", UA_IPHONE, Browser("https://web.push.apple.com/"))
        r = await self.http.get("/api/v1/push", params={"endpoint": d["browser"].endpoint}, headers=self.session("wm"))
        body = r.json()
        self.assertEqual((body["enabled"], body["public_key"]), (True, self.public_key))
        self.assertEqual([x["label"] for x in body["devices"]], ["Safari on iPhone", "Chrome on Android"])
        self.assertEqual([x["this_device"] for x in body["devices"]], [False, True])
        self.assertNotIn("endpoint", json.dumps(body["devices"]))  # the capability URL never goes back out
        self.assertEqual(body["prefs"], {k: True for k in push.KINDS})
        # Someone else can't remove it; its owner can.
        r = await self.http.delete(f"/api/v1/push/devices/{d['id']}", headers=self.session("wa"))
        self.assertEqual(r.status_code, 404)
        r = await self.http.delete(f"/api/v1/push/devices/{d['id']}", headers=self.session("wm"))
        self.assertEqual(r.status_code, 200)
        r = await self.http.post("/api/v1/push/subscriptions/remove", json={"endpoint": d["browser"].endpoint},
                                 headers=self.session("wm"))
        self.assertEqual(r.json(), {"removed": False})
        self.assertEqual(await self.db[push.SUBS].count_documents({"user_id": self.uid["wm"]}), 1)

    async def test_signing_out_removes_this_device_only_for_its_owner(self):
        d = await self.device("wm")
        r = await self.http.post("/api/v1/push/subscriptions/remove", json={"endpoint": d["browser"].endpoint},
                                 headers=self.session("wa"))
        self.assertEqual(r.json(), {"removed": False})
        r = await self.http.post("/api/v1/push/subscriptions/remove", json={"endpoint": d["browser"].endpoint},
                                 headers=self.session("wm"))
        self.assertEqual(r.json(), {"removed": True})

    async def test_the_same_browser_moves_to_whoever_signed_in_last(self):
        b = Browser()
        await self.device("wm", browser=b)
        await self.device("wa", browser=b)
        rows = await self.db[push.SUBS].find({"endpoint": b.endpoint}).to_list(length=None)
        self.assertEqual([r["user_id"] for r in rows], [self.uid["wa"]])

    async def test_the_app_opening_only_keeps_a_device_already_turned_on(self):
        b = Browser()
        h = {**self.session("wm"), "User-Agent": UA_ANDROID}
        r = await self.http.post("/api/v1/push/subscriptions", json=b.subscription(refresh=True), headers=h)
        self.assertEqual(r.json(), {"device": None})  # never adds one
        self.assertEqual(await self.db[push.SUBS].count_documents({}), 0)
        d = await self.device("wm", browser=b)
        await self.db[push.SUBS].update_one({"_id": ObjectId(d["id"])}, {"$set": {"seen_at": now() - timedelta(days=30)}})
        r = await self.http.post("/api/v1/push/subscriptions", json=b.subscription(refresh=True), headers=h)
        self.assertEqual(r.json()["device"]["id"], d["id"])
        seen = (await self.db[push.SUBS].find_one({"_id": ObjectId(d["id"])}))["seen_at"]
        self.assertGreater(seen.replace(tzinfo=None), (now() - timedelta(minutes=1)).replace(tzinfo=None))
        # Someone else signed in on that browser: the old claim goes, and it isn't theirs either.
        r = await self.http.post("/api/v1/push/subscriptions", json=b.subscription(refresh=True), headers=self.session("wa"))
        self.assertEqual(r.json(), {"device": None})
        self.assertEqual(await self.db[push.SUBS].count_documents({}), 0)

    async def test_refused_subscriptions(self):
        b = Browser("https://169.254.169.254/")
        r = await self.http.post("/api/v1/push/subscriptions", json=b.subscription(), headers=self.session("wm"))
        self.assertEqual(r.status_code, 422)
        b = Browser()
        bad = b.subscription()
        bad["keys"]["p256dh"] = webpush.b64u(b"\x04" + b"\x01" * 64)  # not on the curve
        r = await self.http.post("/api/v1/push/subscriptions", json=bad, headers=self.session("wm"))
        self.assertEqual(r.status_code, 422)
        bad["keys"] = {"p256dh": b.subscription()["keys"]["p256dh"], "auth": "AAAA"}
        r = await self.http.post("/api/v1/push/subscriptions", json=bad, headers=self.session("wm"))
        self.assertEqual(r.status_code, 422)
        r = await self.http.post("/api/v1/push/subscriptions", json=b.subscription())
        self.assertEqual(r.status_code, 401)
        with mock.patch.object(settings, "vapid_private_key", ""):
            r = await self.http.post("/api/v1/push/subscriptions", json=b.subscription(), headers=self.session("wm"))
            self.assertEqual(r.status_code, 503)
            r = await self.http.get("/api/v1/push", headers=self.session("wm"))
            self.assertEqual((r.json()["enabled"], r.json()["public_key"]), (False, None))

    async def test_a_workspace_domain_session_cant_use_it(self):
        b = Browser()
        r = await self.http.post("/api/v1/push/subscriptions", json=b.subscription(), headers=self.tenant("wm", "W1"))
        self.assertIn(r.status_code, (401, 403))

    async def test_at_most_twenty_devices(self):
        for _ in range(push.MAX_DEVICES + 2):
            await self.device("wm")
        self.assertEqual(await self.db[push.SUBS].count_documents({"user_id": self.uid["wm"]}), push.MAX_DEVICES)

    async def test_stale_and_expired_devices_are_pruned(self):
        old, expired, fresh = await self.device("wm"), await self.device("wm"), await self.device("wm")
        await self.db[push.SUBS].update_one({"_id": ObjectId(old["id"])}, {"$set": {"seen_at": now() - timedelta(days=91)}})
        await self.db[push.SUBS].update_one({"_id": ObjectId(expired["id"])},
                                            {"$set": {"expires_at": now() - timedelta(minutes=1)}})
        self.assertEqual(await push._prune(self.db, now(), force=True), 2)
        left = [str(r["_id"]) for r in await self.db[push.SUBS].find({}).to_list(length=None)]
        self.assertEqual(left, [fresh["id"]])

    async def test_a_test_notification(self):
        d = await self.device("wm", UA_IPHONE)
        r = await self.http.post("/api/v1/push/test", json={"device_id": d["id"]}, headers=self.session("wm"))
        self.assertEqual(r.json()["sent"], 1, r.text)
        msg = self.payloads()[0]
        self.assertEqual((msg["title"], msg["url"], msg["tag"]), ("Notifications are on", "/settings/account#push", "md-test"))
        self.assertIn("Safari on iPhone", msg["body"])
        r = await self.http.post("/api/v1/push/test", json={"device_id": d["id"]}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 429)
        r = await self.http.post("/api/v1/push/test", json={"device_id": d["id"]}, headers=self.session("wa"))
        self.assertEqual(r.status_code, 404)

    async def test_prefs(self):
        r = await self.http.patch("/api/v1/push/prefs", json={"mention": False, "nope": True}, headers=self.session("wm"))
        self.assertEqual(r.json()["prefs"], {"mention": False, "signoff_requested": True, "shared": True,
                                             "access_request": True})


# ── Delivery ──────────────────────────────────────────────────────────────────


class Delivery(PushWorld):
    async def mention(self, who: str = "wm", block: str = "b-qa0001", slug: str | None = None, text: str = "about QA"):
        p = {"slug": slug} if slug else await self.page()
        await self.save(p["slug"], "owner", f"# Plan\n\nPing {person(self.uid[who], who.upper())} {text}. {{#{block}}}\n")
        return p

    async def test_a_mention_rings_every_device_with_what_the_bell_says(self):
        phone, laptop = await self.device("wm"), await self.device("wm", UA_IPHONE)
        p = await self.mention()
        self.assertEqual(await self.flush(1), {})  # still gathering
        self.assertEqual(self.delivered, [])
        self.assertEqual(await self.flush(), {"sent": 1})
        self.assertEqual(len(self.delivered), 2)
        req = self.delivered[0]
        self.assertEqual(req.headers["content-encoding"], "aes128gcm")
        self.assertEqual(req.headers["ttl"], str(24 * 3600))
        self.assertTrue(req.headers["authorization"].startswith("vapid t="))
        self.assertLessEqual(len(req.headers["topic"]), 32)
        bell = (await self.listing("wm"))["items"][0]
        for msg in self.payloads():
            self.assertEqual(msg["title"], bell["text"])
            self.assertEqual(msg["title"], "OWNER mentioned you in “Launch plan”")
            self.assertEqual(msg["body"], bell["excerpt"])
            self.assertEqual(msg["url"], f"/{p['slug']}#b-qa0001")
            self.assertEqual(msg["ids"], [bell["id"]])
        # The push services see only ciphertext.
        self.assertNotIn(b"Launch plan", b"".join(r.content for r in self.delivered))
        for d in (phone, laptop):
            self.assertIsNotNone((await self.db[push.SUBS].find_one({"_id": ObjectId(d["id"])}))["last_ok_at"])
        self.assertEqual(await self.flush(), {})  # sent once

    async def test_no_device_means_no_queue(self):
        await self.mention()
        self.assertEqual(await self.outbox("wm"), [])

    async def test_access_revoked_before_sending_sends_nothing(self):
        await self.device("wm")
        await self.mention(text="about the secret merger")
        await self.remove_member("W1", "wm")
        self.assertEqual(await self.flush(), {"no_access": 1})
        self.assertEqual(self.delivered, [])  # not even "a page you can't open"
        self.assertEqual((await self.outbox("wm"))[0]["outcome"], "no_access")

    async def test_a_page_made_private_sends_nothing(self):
        await self.device("wm")
        p = await self.mention()
        await self.set_level(p["slug"], "private")
        self.assertEqual(await self.flush(), {"no_access": 1})
        self.assertEqual(self.delivered, [])

    async def test_read_in_the_app_first_sends_nothing(self):
        await self.device("wm")
        await self.mention()
        await self.http.post("/api/v1/notifications/read", json={"all": True}, headers=self.session("wm"))
        self.assertEqual(await self.flush(), {"seen": 1})
        self.assertEqual(self.delivered, [])

    async def test_a_kind_turned_off_is_not_queued_and_pending_ones_are_dropped(self):
        await self.device("wm")
        p = await self.mention()
        await self.http.patch("/api/v1/push/prefs", json={"mention": False}, headers=self.session("wm"))
        self.assertEqual((await self.outbox("wm"))[0]["outcome"], "off")
        await self.mention(slug=p["slug"], block="b-qa0002", text="again")
        self.assertEqual(len(await self.outbox("wm")), 1)
        self.assertEqual(await self.flush(), {})
        self.assertEqual(self.delivered, [])

    async def test_several_on_one_page_arrive_as_one_then_the_gap(self):
        await self.device("wm")
        p = await self.page()
        base = "# Plan\n\n"
        await self.save(p["slug"], "owner", base + f"A {person(self.uid['wm'], 'WM')} {{#b-aaaa01}}\n")
        await self.save(p["slug"], "owner", base + f"A {person(self.uid['wm'], 'WM')} {{#b-aaaa01}}\n\n"
                        f"B {person(self.uid['wm'], 'WM')} {{#b-aaaa02}}\n")
        self.assertEqual(await self.flush(), {"sent": 1})
        msg = self.payloads()[0]
        self.assertEqual(msg["title"], "You were mentioned 2 times in “Launch plan”")
        self.assertEqual((msg["body"], msg["url"], msg["count"], len(msg["ids"])), ("OWNER", f"/{p['slug']}", 2, 2))
        # A third within two minutes waits for the gap, then goes.
        await self.save(p["slug"], "owner", base + f"A {person(self.uid['wm'], 'WM')} {{#b-aaaa01}}\n\n"
                        f"B {person(self.uid['wm'], 'WM')} {{#b-aaaa02}}\n\nC {person(self.uid['wm'], 'WM')} {{#b-aaaa03}}\n")
        self.assertEqual(await self.flush(30), {"waiting": 1})
        self.assertEqual(await self.flush(150), {"sent": 1})
        self.assertEqual(len(self.delivered), 2)
        self.assertEqual(self.payloads()[1]["url"], f"/{p['slug']}#b-aaaa03")

    async def test_two_pages_are_two_notifications(self):
        await self.device("wm")
        await self.mention()
        await self.mention()
        self.assertEqual(await self.flush(), {"sent": 2})
        self.assertEqual(len({m["tag"] for m in self.payloads()}), 2)

    async def test_a_dead_subscription_is_forgotten(self):
        gone, ok = await self.device("wm"), await self.device("wm")
        self.answer[gone["browser"].endpoint] = 410
        await self.mention()
        self.assertEqual(await self.flush(), {"sent": 1})
        self.assertIsNone(await self.db[push.SUBS].find_one({"_id": ObjectId(gone["id"])}))
        self.assertIsNotNone(await self.db[push.SUBS].find_one({"_id": ObjectId(ok["id"])}))
        for status in (404, 403):
            d = await self.device("wa")
            self.answer[d["browser"].endpoint] = status
            await push.send_test(self.db, self.uid["wa"], d["id"])
            await self.db[push.PUSH_LOG].delete_many({})
            self.assertIsNone(await self.db[push.SUBS].find_one({"_id": ObjectId(d["id"])}), status)

    async def test_a_busy_push_service_is_tried_again(self):
        d = await self.device("wm")
        self.answer[d["browser"].endpoint] = 503
        await self.mention()
        self.assertEqual(await self.flush(), {"retry": 1})
        row = (await self.outbox("wm"))[0]
        self.assertEqual((row["state"], row["attempts"]), ("pending", 1))
        self.assertEqual(await self.flush(40), {})  # not due yet
        self.answer.clear()
        self.assertEqual(await self.flush(70), {"sent": 1})
        self.assertIsNotNone(await self.db[push.SUBS].find_one({"_id": ObjectId(d["id"])}))

    async def test_clicking_marks_it_read(self):
        await self.device("wm")
        await self.mention()
        await self.flush()
        msg = self.payloads()[0]
        self.assertTrue(msg["read"].startswith(settings.api_base_url.rstrip("/") + "/api/v1/push/read?t="))
        t = msg["read"].split("t=", 1)[1]
        forged = push.read_token(self.uid["wm"], msg["ids"])[:-4] + "AAAA"
        r = await self.http.post("/api/v1/push/read", params={"t": forged})
        self.assertEqual(r.status_code, 400)
        r = await self.http.post("/api/v1/push/read", params={"t": t})
        self.assertEqual(r.json(), {"marked": 1})
        self.assertEqual((await self.listing("wm"))["unread_count"], 0)
        # A token only reaches its own person's notifications.
        await self.mention(who="wa")
        other = (await self.notes("wa"))[0]
        r = await self.http.post("/api/v1/push/read", params={"t": push.read_token(self.uid["wm"], [str(other["_id"])])})
        self.assertEqual(r.json(), {"marked": 0})

    async def test_shares_and_sign_offs(self):
        await self.device("gv")
        doc = await self.page("W")
        await notifications.notify(self.db, self.uid["gv"], "shared", doc, None, actor=self.uid["owner"],
                                   extra={"message": "Have a look", "role": "viewer"})
        await self.flush()
        msg = self.payloads()[0]
        self.assertEqual((msg["kind"], msg["body"], msg["url"]), ("shared", "Have a look", f"/{doc['slug']}"))
        self.assertIn("shared “", msg["title"])
        await self.device("wa")
        await self.save(doc["slug"], "owner", f'# Plan\n\n:::signoff{{person="{self.uid["wa"]}" label="Q3 budget" #b-so0001}}\n:::\n')
        await self.flush()
        msg = self.payloads()[-1]
        self.assertEqual((msg["kind"], msg["url"]), ("signoff_requested", f"/{doc['slug']}#b-so0001"))
        self.assertEqual(msg["title"], "OWNER asked you to sign off on “Q3 budget” in “Launch plan”")

    async def test_access_requests_reach_the_owner_until_decided(self):
        await self.device("owner")
        doc = await self.mkdoc("P", grants=False, title="Budget")
        r = await self.http.post(f"/api/v1/documents/{doc['slug']}/access-requests", json={"message": "please"},
                                 headers=self.session("stranger"))
        self.assertEqual(r.status_code, 201, r.text)
        await self.flush()
        msg = self.payloads()[0]
        self.assertEqual((msg["kind"], msg["url"], msg["body"]), ("access_request", f"/requests/{r.json()['id']}", "please"))
        self.assertEqual(msg["title"], "STRANGER asked to open “Budget”")
        # Decided before the push went: nothing.
        doc2 = await self.mkdoc("P", grants=False, title="Other")
        r = await self.http.post(f"/api/v1/documents/{doc2['slug']}/access-requests", json={},
                                 headers=self.session("stranger"))
        await self.db[access_requests.COLL].update_one({"_id": ObjectId(r.json()["id"])}, {"$set": {"status": "declined"}})
        self.assertEqual(await self.flush(), {"gone": 1})
        self.assertEqual(len(self.delivered), 1)

    async def test_payload_never_has_more_than_the_bell(self):
        """Every key a message carries, and nothing about the page beyond the bell's own fields."""
        await self.device("wm")
        await self.mention()
        await self.flush()
        msg = self.payloads()[0]
        self.assertEqual(set(msg), {"v", "title", "body", "url", "tag", "kind", "count", "ids", "read", "ts"})
        raw = json.dumps(msg)
        for secret in ("content", "Body d-", "edit_secret", self.email["owner"], self.email["wm"]):
            self.assertNotIn(secret, raw)

    async def test_unconfigured_does_nothing(self):
        await self.device("wm")
        with mock.patch.object(settings, "vapid_private_key", ""):
            await self.mention()
            self.assertEqual(await self.outbox("wm"), [])
            self.assertEqual(await self.flush(), {})

