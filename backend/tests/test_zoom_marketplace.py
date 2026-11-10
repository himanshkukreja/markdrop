"""Zoom, one click: Markdrop's Zoom Marketplace app (services/zoom.py start/finish/handle_app_webhook/forget).

Every Zoom call goes to :class:`tests._zoom_fake.FakeZoom`, never the network. The world is test_zoom's
(W with a private Sales team: owner (lead) + wm; an open Eng team; wa the workspace admin).

Run: cd backend && MARKDROP_TEST_MONGODB_URI=mongodb://127.0.0.1:27019 .venv/bin/python -m unittest tests.test_zoom_marketplace -v
"""

from __future__ import annotations

import json
import time
from datetime import timedelta
from urllib.parse import parse_qs, urlparse

from app.services import zoom
from app.utils import crypto
from tests._zoom_fake import (ACCOUNT, APP_CLIENT_ID, APP_CLIENT_SECRET, APP_SECRET_TOKEN, iso_days_ago)
from tests.test_zoom import ZoomWorld, settings

_APP = ("zoom_client_id", "zoom_client_secret", "zoom_webhook_secret", "frontend_url")
REDIRECT = "https://markdrop.in/integrations/zoom/callback"


class AppWorld(ZoomWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self._saved_app = {k: getattr(settings, k) for k in _APP}
        settings.zoom_client_id, settings.zoom_client_secret = APP_CLIENT_ID, APP_CLIENT_SECRET
        settings.zoom_webhook_secret = APP_SECRET_TOKEN
        settings.frontend_url = "https://markdrop.in"

    async def asyncTearDown(self):
        for k, v in self._saved_app.items():
            setattr(settings, k, v)
        await super().asyncTearDown()

    async def start(self, who: str = "wa", ws: str | None = None, team: str | None = "sales"):
        body = {"workspace_id": ws or self.W, **({"team_id": getattr(self, team)} if team else {})}
        return await self.http.post("/api/v1/zoom/connect/start", headers=self.session(who), json=body)

    async def install(self, who: str = "wa", ws: str | None = None, team: str | None = "sales") -> dict:
        r = await self.start(who, ws, team)
        self.assertEqual(r.status_code, 200, r.text)
        q = parse_qs(urlparse(r.json()["url"]).query)
        code = self.fz.authorize(q["redirect_uri"][0])
        r = await self.http.post("/api/v1/zoom/connect/finish", headers=self.session(who), json={"code": code, "state": q["state"][0]})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def app_hook(self, payload: dict, *, secret: str = APP_SECRET_TOKEN, ts: int | None = None):
        body = json.dumps(payload).encode()
        ts_ = str(ts if ts is not None else int(time.time()))
        r = await self.http.post("/api/v1/zoom/webhook", content=body, headers={
            "content-type": "application/json", "x-zm-request-timestamp": ts_, "x-zm-signature": zoom.sign(secret, ts_, body)})
        await zoom.drain()
        return r


class NotConfigured(ZoomWorld):
    async def test_one_click_hidden_without_the_app(self):
        self.assertFalse((await self.status())["app_available"])
        r = await self.http.post("/api/v1/zoom/connect/start", headers=self.session("wa"), json={"workspace_id": self.W})
        self.assertEqual(r.status_code, 503)
        r = await self.http.post("/api/v1/zoom/webhook", content=b"{}")
        self.assertEqual(r.status_code, 404)
        # Server-to-Server still works on its own.
        self.assertEqual((await self.connect()).status_code, 200)


class Install(AppWorld):
    async def test_connect_from_markdrop(self):
        self.assertEqual((await self.start("wm")).status_code, 403)
        r = await self.start()
        url = urlparse(r.json()["url"])
        q = parse_qs(url.query)
        self.assertEqual((url.netloc, url.path), ("zoom.test", "/oauth/authorize"))
        self.assertEqual((q["client_id"][0], q["redirect_uri"][0], q["response_type"][0]), (APP_CLIENT_ID, REDIRECT, "code"))
        code = self.fz.authorize(REDIRECT)
        # Someone else can't finish it (the state is the admin's).
        r = await self.http.post("/api/v1/zoom/connect/finish", headers=self.session("wm"), json={"code": code, "state": q["state"][0]})
        self.assertEqual(r.status_code, 400)
        r = await self.http.post("/api/v1/zoom/connect/finish", headers=self.session("wa"), json={"code": code, "state": q["state"][0]})
        self.assertEqual(r.status_code, 200, r.text)
        st = r.json()
        self.assertEqual((st["connected"], st["mode"], st["workspace_id"]), (True, "oauth", self.W))
        self.assertEqual(st["team"]["id"], self.sales)
        self.assertEqual(st["connection"]["approved_by"], "Zed Admin")
        self.assertEqual(st["connection"]["missing_scopes"], [])
        self.assertIsNone(st["connection"]["broken"])
        self.assertTrue(st["connection"]["verified"])
        row = await self.db[zoom.CONNS].find_one({"_id": self.W})
        self.assertEqual(row["account_id"], ACCOUNT)
        raw = json.dumps(row, default=str)
        for t in ("atok-", "rtok-"):
            self.assertNotIn(t, raw)
        self.assertTrue(crypto.decrypt(row["refresh_enc"]).startswith("rtok-"))
        self.assertNotIn("rtok-", json.dumps(st))
        # The state works once.
        r = await self.http.post("/api/v1/zoom/connect/finish", headers=self.session("wa"),
                                 json={"code": self.fz.authorize(REDIRECT), "state": q["state"][0]})
        self.assertEqual(r.status_code, 400)
        # A Server-to-Server app can't be pasted over it.
        self.assertEqual((await self.connect()).status_code, 409)

    async def test_install_from_the_zoom_marketplace_has_no_state(self):
        code = self.fz.authorize(REDIRECT)
        r = await self.http.post("/api/v1/zoom/connect/finish", headers=self.session("wa"), json={"code": code})
        self.assertEqual(r.status_code, 422)
        r = await self.http.post("/api/v1/zoom/connect/finish", headers=self.session("wm"), json={"code": code, "workspace_id": self.W})
        self.assertEqual(r.status_code, 403)
        r = await self.http.post("/api/v1/zoom/connect/finish", headers=self.session("wa"),
                                 json={"code": code, "workspace_id": self.W, "team_id": self.sales})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["mode"], r.json()["team"]["id"]), ("oauth", self.sales))
        r = await self.http.post("/api/v1/zoom/connect/finish", headers=self.session("wa"), json={"code": "bogus", "workspace_id": self.W})
        self.assertEqual(r.status_code, 400)

    async def test_one_zoom_account_one_workspace_and_switching_from_s2s(self):
        self.assertEqual((await self.connect()).status_code, 200)          # S2S first
        st = await self.install()
        self.assertEqual(st["mode"], "oauth")
        row = await self.db[zoom.CONNS].find_one({"_id": self.W})
        self.assertIsNone(row["client_secret_enc"])
        self.assertIsNone(row["webhook_secret_enc"])
        await self.add_member("W2", "wa", "admin")
        r = await self.start(ws=self.ws["W2"], team=None)
        q = parse_qs(urlparse(r.json()["url"]).query)
        r = await self.http.post("/api/v1/zoom/connect/finish", headers=self.session("wa"),
                                 json={"code": self.fz.authorize(REDIRECT), "state": q["state"][0]})
        self.assertEqual(r.status_code, 409)

    async def test_refresh_rotates_and_a_dead_refresh_token_asks_to_reconnect(self):
        await self.install()
        row = await self.db[zoom.CONNS].find_one({"_id": self.W})
        first = crypto.decrypt(row["refresh_enc"])
        await self.db[zoom.CONNS].update_one({"_id": self.W}, {"$set": {"expires_at": zoom.now_utc() - timedelta(minutes=1)}})
        conn = await zoom.get(self.db, self.W)
        self.assertTrue((await zoom.access_token(self.db, conn)).startswith("atok-"))
        row = await self.db[zoom.CONNS].find_one({"_id": self.W})
        self.assertNotEqual(crypto.decrypt(row["refresh_enc"]), first)
        self.assertNotIn(first, self.fz.refresh)                          # spent
        # Zoom forgets the refresh token (the app was removed without an event, or 90 days idle).
        self.fz.refresh.clear()
        await self.db[zoom.CONNS].update_one({"_id": self.W}, {"$set": {"expires_at": zoom.now_utc() - timedelta(minutes=1)}})
        with self.assertRaises(zoom.ZoomUnavailable):
            await zoom.access_token(self.db, await zoom.get(self.db, self.W))
        self.assertEqual((await self.status())["connection"]["broken"], "reauthorize")
        # Reconnecting fixes it.
        self.assertIsNone((await self.install())["connection"]["broken"])

    async def test_imports_through_the_app_webhook(self):
        await self.install()
        self.fz.add_meeting("uuid-app-1", "Acme pricing call", self.email["owner"], iso_days_ago(0, 6))
        r = await self.app_hook(self.fz.event("recording.transcript_completed", "uuid-app-1"))
        self.assertEqual(r.status_code, 200, r.text)
        row = await self.db["meetings"].find_one({"sources.file_id": "zoom:uuid-app-1"})
        self.assertIsNotNone(row)
        self.assertEqual(row["team_ids"], [self.sales])
        self.assertTrue(any(c[1].startswith("https://zoom.test/rec/download/") for c in self.fz.calls))
        # Its own per-workspace endpoint isn't one (the app's events come to /webhook).
        r = await self.hook({"event": "endpoint.url_validation", "payload": {"plainToken": "x"}})
        self.assertEqual(r.status_code, 404)


class AppWebhook(AppWorld):
    async def test_validation_signature_and_routing_by_account_with_s2s_alongside(self):
        r = await self.app_hook({"event": "endpoint.url_validation", "payload": {"plainToken": "tok123"}})
        self.assertEqual(r.json(), zoom.validation_answer(APP_SECRET_TOKEN, "tok123"))
        r = await self.app_hook({"event": "endpoint.url_validation", "payload": {"plainToken": "tok123"}}, secret="nope-nope-nope")
        self.assertEqual(r.status_code, 401)
        r = await self.app_hook({"event": "endpoint.url_validation", "payload": {"plainToken": "t"}}, ts=int(time.time()) - 3600)
        self.assertEqual(r.status_code, 401)
        # W on its own Server-to-Server app (ACCOUNT); W2 on the Marketplace app (another Zoom account).
        self.assertEqual((await self.connect()).status_code, 200)
        await self.add_member("W2", "wa", "admin")
        self.fz.app_account = "acct-APP2"
        await self.install(ws=self.ws["W2"], team=None)
        self.fz.add_meeting("uuid-s2s-1", "Acme renewal", self.email["owner"], iso_days_ago(0, 6))
        ev = self.fz.event("recording.transcript_completed", "uuid-s2s-1")
        # The S2S account's event at the app endpoint: not the app's customer there, ignored.
        r = await self.app_hook(ev)
        self.assertEqual(r.json().get("ignored"), "account")
        self.assertEqual(await self.db["meetings"].count_documents({}), 0)
        # An unknown account: ignored, nothing stored.
        r = await self.app_hook({**ev, "payload": {**ev["payload"], "account_id": "acct-NOBODY"}})
        self.assertEqual(r.json().get("ignored"), "account")
        # The app's account reaches W2 only (no team there yet: counted as ignored, W untouched).
        r = await self.app_hook({**ev, "payload": {**ev["payload"], "account_id": "acct-APP2"}})
        self.assertEqual(r.status_code, 200)
        w2 = await self.db[zoom.CONNS].find_one({"_id": self.ws["W2"]})
        self.assertIsNotNone(w2["last_event_at"])
        self.assertEqual(w2["stats"].get("ignored"), 1)
        self.assertIsNone((await self.db[zoom.CONNS].find_one({"_id": self.W})).get("last_event_at"))
        # The S2S workspace's own endpoint keeps working.
        r = await self.hook(ev)
        self.assertEqual(r.status_code, 200)
        self.assertIsNotNone(await self.db["meetings"].find_one({"workspace_id": self.W, "sources.file_id": "zoom:uuid-s2s-1"}))

    async def test_app_deauthorized_deletes_tokens_and_zoom_data(self):
        await self.install()
        self.fz.add_meeting("uuid-app-2", "Acme QBR", self.email["owner"], iso_days_ago(0, 6))
        await self.app_hook(self.fz.event("recording.transcript_completed", "uuid-app-2"))
        self.assertEqual(await self.db[zoom.MEETINGS].count_documents({"workspace_id": self.W}), 1)
        r = await self.app_hook({"event": "app_deauthorized", "payload": {
            "account_id": ACCOUNT, "user_id": "zu-admin", "client_id": APP_CLIENT_ID, "signature": "x",
            "deauthorization_time": "2026-11-11T10:00:00Z"}})
        self.assertEqual(r.status_code, 200, r.text)
        row = await self.db[zoom.CONNS].find_one({"_id": self.W})
        for k in ("access_enc", "refresh_enc", "zoom_user", "scopes"):
            self.assertIsNone(row.get(k), k)
        self.assertNotIn("account_id", row)
        self.assertEqual(await self.db[zoom.MEETINGS].count_documents({"workspace_id": self.W}), 0)
        st = await self.status()
        self.assertEqual((st["connected"], st["connection"]["broken"]), (False, "deauthorized"))
        # Imported meetings are the workspace's pages: they stay until an admin deletes them.
        self.assertEqual(await self.db["meetings"].count_documents({"workspace_id": self.W}), 1)
        # Later events for that account are ignored; reconnecting works.
        r = await self.app_hook(self.fz.event("recording.transcript_completed", "uuid-app-2"))
        self.assertEqual(r.json().get("ignored"), "account")
        self.assertTrue((await self.install())["connected"])

    async def test_disconnect_revokes_and_can_delete_imported_meetings(self):
        await self.install()
        self.fz.add_meeting("uuid-app-3", "Acme kickoff", self.email["owner"], iso_days_ago(0, 6))
        await self.app_hook(self.fz.event("recording.transcript_completed", "uuid-app-3"))
        self.assertEqual(await self.db["meetings"].count_documents({"workspace_id": self.W}), 1)
        refresh = crypto.decrypt((await self.db[zoom.CONNS].find_one({"_id": self.W}))["refresh_enc"])
        r = await self.http.delete("/api/v1/zoom/connection", headers=self.session("wa"),
                                   params={"workspace_id": self.W, "delete_meetings": "true"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["connected"], r.json()["deleted_meetings"]), (False, 1))
        self.assertIn(refresh, self.fz.revoked)
        self.assertIsNone(await self.db[zoom.CONNS].find_one({"_id": self.W}))
        self.assertEqual(await self.db["meetings"].count_documents({"workspace_id": self.W}), 0)


class Mcp(AppWorld):
    async def test_zoom_status_offers_a_connect_link_to_admins(self):
        token = await self.mcp_token("wa")
        code, res = await self.mcp_call(token, "zoom_status", {"workspace": self.W})
        self.assertEqual(code, 200)
        out = res["structuredContent"]
        self.assertFalse(out["connected"])
        self.assertTrue(out["one_click_available"])
        self.assertIn("/oauth/authorize?", out["connect_url"])
        token = await self.mcp_token("wm")
        code, res = await self.mcp_call(token, "zoom_status", {"workspace": self.W})
        self.assertIsNone(res["structuredContent"].get("connect_url"))
        await self.install()
        code, res = await self.mcp_call(await self.mcp_token("wa"), "zoom_status", {"workspace": self.W})
        self.assertEqual((res["structuredContent"]["mode"], res["structuredContent"]["connected"]), ("oauth", True))
