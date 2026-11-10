"""Zoom (services/zoom.py, zoom_api.py, routers/zoom.py, mcp/zoom_tools.py).

Every Zoom call goes to :class:`tests._zoom_fake.FakeZoom` (an httpx.MockTransport), never the network;
the model is the test fake. The world (tests/test_teams.TeamsWorld): W1 with a private Sales team (owner,
lead + wm), an open Eng team (wv, ownv), wa the workspace admin. Zoom users: owner and wm (Sales), wv (Eng).

Run: cd backend && MARKDROP_TEST_MONGODB_URI=mongodb://127.0.0.1:27019 .venv/bin/python -m unittest tests.test_zoom -v
"""

from __future__ import annotations

import asyncio
import json
import time

from tests.test_teams import TeamsWorld

from app.config import get_settings
from app.services import meetings, zoom, zoom_api
from app.utils import crypto
from tests._zoom_fake import (ACCOUNT, API, AUTH, CLIENT_ID, CLIENT_SECRET, SECRET_TOKEN, FakeZoom, iso_days_ago)

settings = get_settings()
FERNET = "8Kq0Qb3oQ1n3yYbqQh1w8sV9t6rXo5Wm2Zc4Jd7Lp0E="
_SAVED = ("zoom_auth_base", "zoom_api_base", "token_encryption_key", "api_base_url")


class ZoomWorld(TeamsWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self._saved_z = {k: getattr(settings, k) for k in _SAVED}
        settings.zoom_auth_base, settings.zoom_api_base = AUTH, API
        settings.token_encryption_key = FERNET
        settings.api_base_url = "https://api.markdrop.in"
        crypto._fernet.cache_clear()
        await zoom.ensure_indexes(self.db)
        self.fz = FakeZoom()
        self._transport = zoom_api.TRANSPORT
        zoom_api.TRANSPORT = self.fz.transport()
        self._cap = zoom.SLEEP_CAP
        zoom.SLEEP_CAP = 0.0
        for who, first in (("owner", "Ada"), ("wm", "Bo"), ("wv", "Ravi")):
            self.fz.add_user(self.email[who], first, "Test")

    async def asyncTearDown(self):
        await zoom.drain()
        for t in list(meetings._bg):
            await asyncio.wait({t}, timeout=10)
        zoom_api.TRANSPORT = self._transport
        zoom.SLEEP_CAP = self._cap
        zoom._locks.clear()
        for k, v in self._saved_z.items():
            setattr(settings, k, v)
        crypto._fernet.cache_clear()
        await super().asyncTearDown()

    # ── Helpers ──

    async def connect(self, who: str = "wa", team: str | None = "sales", **over) -> dict:
        body = {"workspace_id": self.W, "account_id": ACCOUNT, "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
                "secret_token": SECRET_TOKEN, **({"team_id": getattr(self, team)} if team else {}), **over}
        return await self.http.put("/api/v1/zoom/connection", headers=self.session(who), json=body)

    async def hook(self, payload: dict, *, secret: str = SECRET_TOKEN, ts: int | None = None, ws: str | None = None):
        body = json.dumps(payload).encode()
        ts_ = str(ts if ts is not None else int(time.time()))
        r = await self.http.post(f"/api/v1/zoom/webhook/{ws or self.W}", content=body, headers={
            "content-type": "application/json", "x-zm-request-timestamp": ts_, "x-zm-signature": zoom.sign(secret, ts_, body)})
        await zoom.drain()
        return r

    async def status(self, who: str = "wa") -> dict:
        r = await self.http.get("/api/v1/zoom/status", headers=self.session(who), params={"workspace_id": self.W})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def listed_meetings(self, who: str) -> set[str]:
        r = await self.http.get("/api/v1/meetings", headers=self.session(who), params={"workspace": self.W})
        self.assertEqual(r.status_code, 200, r.text)
        return {m["id"] for m in r.json()["meetings"]}


class Connect(ZoomWorld):
    async def test_connect_checks_with_zoom_and_stores_secrets_encrypted(self):
        r = await self.connect("wm")
        self.assertEqual(r.status_code, 403, r.text)
        r = await self.connect(client_secret="wrong-secret-123")
        self.assertEqual(r.status_code, 400)
        self.assertIn("Client Secret", r.json()["detail"])
        self.fz.scopes.remove("meeting:read:list_past_participants:admin")
        r = await self.connect()
        self.assertEqual(r.status_code, 200, r.text)
        st = r.json()
        self.assertTrue(st["connected"])
        self.assertEqual(st["team"]["id"], self.sales)
        self.assertEqual(st["team"]["visibility"], "private")
        self.assertEqual([m["scope"] for m in st["connection"]["missing_scopes"]], ["meeting:read:list_past_participants:admin"])
        self.assertFalse(st["connection"]["missing_scopes"][0]["required"])
        self.assertIsNone(st["connection"]["broken"])
        self.assertEqual(st["webhook_url"], f"https://api.markdrop.in/api/v1/zoom/webhook/{self.W}")
        text = json.dumps(st)
        for secret in (CLIENT_SECRET, SECRET_TOKEN, ACCOUNT, "ztok-"):
            self.assertNotIn(secret, text)
        row = await self.db[zoom.CONNS].find_one({"_id": self.W})
        raw = json.dumps(row, default=str)
        for secret in (CLIENT_SECRET, SECRET_TOKEN, "ztok-1"):
            self.assertNotIn(secret, raw)
        self.assertEqual(crypto.decrypt(row["client_secret_enc"]), CLIENT_SECRET)
        # Saving again with blank secrets keeps them.
        r = await self.connect(client_secret="", secret_token="")
        self.assertEqual(r.status_code, 200, r.text)
        # Members see that it's connected, never the setup details.
        st = await self.status("wm")
        self.assertTrue(st["connected"])
        self.assertIsNone(st["webhook_url"])
        self.assertNotIn("missing_scopes", st["connection"])

    async def test_required_scope_missing_is_reported(self):
        self.fz.scopes.remove("cloud_recording:read:list_recording_files:admin")
        r = await self.connect()
        self.assertEqual(r.status_code, 200, r.text)
        c = r.json()["connection"]
        self.assertEqual(c["broken"], "missing_scopes")
        self.assertIn("cloud_recording:read:list_recording_files:admin", [m["scope"] for m in c["missing_scopes"]])

    async def test_team_picker(self):
        r = await self.connect(team=None)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIsNone(r.json()["team"])
        self.assertEqual({t["name"] for t in r.json()["teams"]}, {"Sales", "Eng"})     # never General
        general = await self.db["teams"].find_one({"workspace_id": self.W, "general": True})
        if general:
            r = await self.http.put("/api/v1/zoom/team", headers=self.session("wa"),
                                    json={"workspace_id": self.W, "team_id": str(general["_id"])})
            self.assertEqual(r.status_code, 422)
        r = await self.http.put("/api/v1/zoom/team", headers=self.session("wm"), json={"workspace_id": self.W, "team_id": self.sales})
        self.assertEqual(r.status_code, 403)
        r = await self.http.put("/api/v1/zoom/team", headers=self.session("wa"), json={"workspace_id": self.W, "team_id": self.eng})
        self.assertEqual((r.status_code, r.json()["team"]["visibility"]), (200, "open"))

    async def test_one_workspace_per_zoom_account(self):
        await self.add_member("W2", "wa", "admin")
        self.assertEqual((await self.connect()).status_code, 200)
        r = await self.http.put("/api/v1/zoom/connection", headers=self.session("wa"), json={
            "workspace_id": self.ws["W2"], "account_id": ACCOUNT, "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
            "secret_token": SECRET_TOKEN})
        self.assertEqual(r.status_code, 409)


class Webhook(ZoomWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.assertEqual((await self.connect()).status_code, 200)
        self.fz.add_meeting("uuid-sales-1", "Acme discovery call", self.email["owner"], iso_days_ago(0, 6))

    async def test_url_validation_and_signatures(self):
        r = await self.hook({"event": "endpoint.url_validation", "payload": {"plainToken": "abc123"}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), zoom.validation_answer(SECRET_TOKEN, "abc123"))
        self.assertTrue((await self.status())["connection"]["verified"])
        r = await self.hook({"event": "endpoint.url_validation", "payload": {"plainToken": "abc"}}, secret="not-the-secret")
        self.assertEqual(r.status_code, 401)
        r = await self.hook(self.fz.event("recording.transcript_completed", "uuid-sales-1"), ts=int(time.time()) - 3600)
        self.assertEqual(r.status_code, 401)
        r = await self.http.post(f"/api/v1/zoom/webhook/{self.W}", content=b"{}")
        self.assertEqual(r.status_code, 401)
        r = await self.hook({"event": "endpoint.url_validation", "payload": {"plainToken": "x"}}, ws=self.ws["W2"])
        self.assertEqual(r.status_code, 404)
        self.assertEqual(await self.db["meetings"].count_documents({}), 0)

    async def test_transcript_completed_imports_into_the_team_only(self):
        r = await self.hook(self.fz.event("recording.transcript_completed", "uuid-sales-1"))
        self.assertEqual(r.status_code, 200, r.text)
        row = await self.db["meetings"].find_one({"sources.file_id": "zoom:uuid-sales-1"})
        self.assertIsNotNone(row)
        self.assertEqual(row["via"], "zoom")
        self.assertEqual(row["title"], "Acme discovery call")
        self.assertEqual(row["team_ids"], [self.sales])
        self.assertFalse(row.get("restricted"))
        self.assertEqual(row["imported_by"], self.uid["owner"])
        self.assertEqual((row.get("organizer") or {}).get("user_id"), self.uid["owner"])
        names = {a.get("name") for a in row["attendees"]}
        self.assertIn("Client Person", names)              # from the participants report
        self.assertTrue(row.get("time"))
        self.assertTrue(row["segments"])
        page = await self.db["documents"].find_one({"_id": row["doc_id"]})
        self.assertEqual(page["team_ids"], [self.sales])
        # Privacy: the team and admins read it; nobody else in the workspace does.
        for who, ok in (("owner", True), ("wm", True), ("wa", True), ("wo", True), ("wv", False), ("ownv", False)):
            self.assertEqual(str(row["_id"]) in await self.listed_meetings(who), ok, who)
            r = await self.get(page["slug"], self.session(who))
            self.assertEqual(r.status_code == 200, ok, (who, r.status_code))
        st = await self.status()
        self.assertEqual(st["connection"]["imported"], 1)
        self.assertEqual(st["recent"][0]["state"], "imported")
        self.assertEqual(await self.status("owner") and (await self.status("owner"))["can_import"], True)   # the team's lead
        self.assertFalse((await self.status("wm"))["can_import"])

    async def test_host_outside_the_team_is_ignored_and_not_stored(self):
        self.fz.add_meeting("uuid-eng-1", "Eng secret roadmap", self.email["wv"], iso_days_ago(0, 6))
        r = await self.hook(self.fz.event("recording.transcript_completed", "uuid-eng-1"))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(await self.db["meetings"].count_documents({}), 0)
        self.assertEqual(await self.db[zoom.MEETINGS].count_documents({}), 0)
        self.assertNotIn("Eng secret roadmap", json.dumps(await self.status(), default=str))
        self.assertEqual((await self.status())["connection"]["ignored"], 1)
        # A host Zoom doesn't name by address (no host_email): found through the account's users.
        self.fz.add_meeting("uuid-sales-2", "Pricing call", self.email["wm"], iso_days_ago(0, 7))
        await self.hook(self.fz.event("recording.transcript_completed", "uuid-sales-2", host_email=False))
        self.assertEqual(await self.db["meetings"].count_documents({"sources.file_id": "zoom:uuid-sales-2"}), 1)

    async def test_dedupe_by_meeting_uuid(self):
        ev = self.fz.event("recording.transcript_completed", "uuid-sales-1")
        await asyncio.gather(self.hook(ev), self.hook(ev))
        self.fz.transcript_in_completed = True
        await self.hook(self.fz.event("recording.completed", "uuid-sales-1"))
        await self.hook(ev)
        self.assertEqual(await self.db["meetings"].count_documents({"sources.file_id": "zoom:uuid-sales-1"}), 1)

    async def test_no_transcript_then_transcript(self):
        self.fz.add_meeting("uuid-quiet", "Quiet call", self.email["owner"], iso_days_ago(0, 8), transcript=False)
        await self.hook(self.fz.event("recording.completed", "uuid-quiet"))
        self.assertEqual(await self.db["meetings"].count_documents({}), 0)
        rec = await self.db[zoom.MEETINGS].find_one({"uuid": "uuid-quiet"})
        self.assertEqual(rec["state"], "no_transcript")
        st = await self.status()
        self.assertEqual(st["recent"][0]["state"], "no_transcript")
        self.assertIn("audio transcript", st["recent"][0]["reason"].lower())
        self.assertEqual(st["connection"]["no_transcript"], 1)
        self.fz.add_transcript("uuid-quiet")
        await self.hook(self.fz.event("recording.transcript_completed", "uuid-quiet"))
        self.assertEqual(await self.db["meetings"].count_documents({"sources.file_id": "zoom:uuid-quiet"}), 1)
        self.assertEqual((await self.db[zoom.MEETINGS].find_one({"uuid": "uuid-quiet"}))["state"], "imported")

    async def test_rate_limit_and_token_refresh(self):
        self.fz.limit(2)
        await self.hook(self.fz.event("recording.transcript_completed", "uuid-sales-1"))
        self.assertEqual(await self.db["meetings"].count_documents({}), 1)
        # An expired token (Zoom revoked it early): a new one, and the call goes through.
        self.fz.tokens.clear()
        self.fz.add_meeting("uuid-sales-3", "Renewal", self.email["owner"], iso_days_ago(0, 9))
        await self.hook(self.fz.event("recording.transcript_completed", "uuid-sales-3"))
        self.assertEqual(await self.db["meetings"].count_documents({}), 2)
        # Credentials Zoom no longer accepts: the connection says so.
        self.fz.tokens.clear()
        self.fz.client_secret = "rotated"
        await self.db[zoom.CONNS].update_one({"_id": self.W}, {"$set": {"expires_at": None}})
        self.fz.add_meeting("uuid-sales-4", "After rotation", self.email["owner"], iso_days_ago(0, 10))
        await self.hook(self.fz.event("recording.transcript_completed", "uuid-sales-4"))
        self.assertEqual((await self.status())["connection"]["broken"], "credentials")

    async def test_disconnect_and_deauthorization(self):
        await self.hook(self.fz.event("recording.transcript_completed", "uuid-sales-1"))
        r = await self.hook({"event": "app_deauthorized", "payload": {"account_id": ACCOUNT, "client_id": CLIENT_ID}})
        self.assertEqual(r.status_code, 200)
        row = await self.db[zoom.CONNS].find_one({"_id": self.W})
        self.assertIsNone(row["client_secret_enc"])
        self.assertIsNone(row["access_enc"])
        st = await self.status()
        self.assertFalse(st["connected"])
        self.assertEqual(st["connection"]["broken"], "deauthorized")
        self.assertEqual((await self.connect()).status_code, 200)
        r = await self.http.delete("/api/v1/zoom/connection", headers=self.session("wm"), params={"workspace_id": self.W})
        self.assertEqual(r.status_code, 403)
        r = await self.http.delete("/api/v1/zoom/connection", headers=self.session("wa"), params={"workspace_id": self.W})
        self.assertEqual((r.status_code, r.json()["connected"]), (200, False))
        self.assertIsNone(await self.db[zoom.CONNS].find_one({"_id": self.W}))
        r = await self.hook(self.fz.event("recording.transcript_completed", "uuid-sales-1"))
        self.assertEqual(r.status_code, 404)
        # The meeting already imported stays.
        self.assertEqual(await self.db["meetings"].count_documents({}), 1)


class Backfill(ZoomWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.assertEqual((await self.connect()).status_code, 200)
        self.fz.add_meeting("b-1", "Acme demo", self.email["owner"], iso_days_ago(3))
        self.fz.add_meeting("b-2", "Globex follow-up", self.email["wm"], iso_days_ago(45), duration=55)
        self.fz.add_meeting("b-3", "No transcript call", self.email["wm"], iso_days_ago(10), transcript=False)
        self.fz.add_meeting("b-eng", "Eng planning", self.email["wv"], iso_days_ago(5))
        self.fz.add_meeting("/b//odd", "Odd uuid call", self.email["owner"], iso_days_ago(2))

    async def recordings(self, who: str = "wa", **params) -> dict:
        r = await self.http.get("/api/v1/zoom/recordings", headers=self.session(who), params={"workspace_id": self.W, **params})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def test_list_and_import(self):
        r = await self.http.get("/api/v1/zoom/recordings", headers=self.session("wm"), params={"workspace_id": self.W})
        self.assertEqual(r.status_code, 403)
        got = await self.recordings(days=30)
        self.assertEqual({m["uuid"] for m in got["meetings"]}, {"b-1", "b-3", "/b//odd"})
        got = await self.recordings(days=90)
        by = {m["uuid"]: m for m in got["meetings"]}
        self.assertEqual(set(by), {"b-1", "b-2", "b-3", "/b//odd"})       # never the Eng host's meeting
        self.assertFalse(by["b-3"]["transcript"])
        self.assertTrue(by["b-2"]["transcript"])
        self.assertEqual(by["b-2"]["duration_min"], 55)
        self.assertEqual(by["b-2"]["host"]["email"], self.email["wm"])
        self.assertIn("audio transcript", got["no_transcript_help"].lower())
        # Zoom allows a month per request: 90 days are several windows.
        rec_calls = [u for _m, u in self.fz.calls if "/recordings?" in u and self.email["owner"].replace("@", "%40") in u]
        self.assertGreaterEqual(len(rec_calls), 3)
        # The lead of the team imports too.
        r = await self.http.post("/api/v1/zoom/import", headers=self.session("owner"),
                                 json={"workspace_id": self.W, "uuids": ["b-1", "b-2", "b-3", "/b//odd", "b-eng"]})
        self.assertEqual(r.status_code, 200, r.text)
        res = {x["uuid"]: x for x in r.json()["results"]}
        self.assertEqual(res["b-1"]["status"], "imported")
        self.assertEqual(res["b-2"]["status"], "imported")
        self.assertEqual(res["/b//odd"]["status"], "imported")
        self.assertEqual(res["b-3"]["status"], "no_transcript")
        self.assertEqual(res["b-eng"]["status"], "ignored")
        self.assertIsNone(res["b-eng"]["topic"])
        self.assertTrue(res["b-1"]["url"].endswith(res["b-1"]["slug"]))
        rows = await self.db["meetings"].find({"via": "zoom"}).to_list(length=10)
        self.assertEqual(len(rows), 3)
        for row in rows:
            self.assertTrue(row.get("history"))                         # past meetings: nobody notified
            self.assertEqual(row["team_ids"], [self.sales])
        got = await self.recordings(days=90)
        by = {m["uuid"]: m for m in got["meetings"]}
        self.assertTrue(by["b-1"]["imported"])
        self.assertFalse(by["b-3"]["imported"])
        self.assertEqual(by["b-3"]["state"], "no_transcript")
        # Importing again: duplicates, nothing new.
        r = await self.http.post("/api/v1/zoom/import", headers=self.session("wa"), json={"workspace_id": self.W, "uuids": ["b-1"]})
        self.assertEqual(r.json()["results"][0]["status"], "duplicate")
        self.assertEqual(await self.db["meetings"].count_documents({"via": "zoom"}), 3)

    async def test_custom_range_and_members_not_in_zoom(self):
        del self.fz.users[self.fz.uid_of(self.email["wm"])]
        got = await self.recordings(**{"from": iso_days_ago(5)[:10], "to": iso_days_ago(0)[:10]})
        self.assertEqual({m["uuid"] for m in got["meetings"]}, {"b-1", "/b//odd"})
        self.assertEqual(got["not_in_zoom"], ["WM"])
        r = await self.http.get("/api/v1/zoom/recordings", headers=self.session("wa"),
                                params={"workspace_id": self.W, "from": "2025-01-01", "to": "2026-11-01"})
        self.assertEqual(r.status_code, 422)

    async def test_mcp_tools(self):
        token = await self.mcp_token("wa")
        code, res = await self.mcp_call(token, "zoom_status", {"workspace": self.W})
        self.assertEqual(code, 200)
        out = res["structuredContent"]
        self.assertTrue(out["connected"])
        self.assertEqual(out["team"]["name"], "Sales")
        code, res = await self.mcp_call(token, "import_zoom_meetings", {"workspace": self.W, "action": "list", "days": 90})
        out = res["structuredContent"]
        self.assertEqual(out["total"], 4)
        code, res = await self.mcp_call(token, "import_zoom_meetings", {"workspace": self.W, "action": "import", "uuids": ["b-1"]})
        out = res["structuredContent"]
        self.assertEqual(out["counts"], {"imported": 1})
        # A member who isn't an admin or the team's lead can't.
        token = await self.mcp_token("wm")
        code, res = await self.mcp_call(token, "import_zoom_meetings", {"workspace": self.W})
        self.assertTrue(res.get("isError"), res)
