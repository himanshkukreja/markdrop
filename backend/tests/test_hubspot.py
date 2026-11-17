"""HubSpot (services/hubspot.py, hubspot_api.py, routers/hubspot.py, mcp/hubspot_tools.py).

Every HubSpot call goes to :class:`tests._hubspot_fake.FakeHubSpot` (an httpx.MockTransport), never the
network. The world is test_zoom's: W1 with a private Sales team (owner = Ada, lead; wm = Bo), an open Eng
team (wv, ownv), wa the workspace admin; Sales calls come in from the fake Zoom.

Run: cd backend && MARKDROP_TEST_MONGODB_URI=mongodb://127.0.0.1:27019 .venv/bin/python -m unittest tests.test_hubspot -v
"""

from __future__ import annotations

import asyncio
import json

from bson import ObjectId

from app.config import get_settings
from app.services import hubspot, hubspot_api, meetings, meetings_ai, zoom
from app.utils import crypto
from tests._hubspot_fake import API, PORTAL, TOKEN, FakeHubSpot, ms
from tests._zoom_fake import iso_days_ago
from tests.test_zoom import ZoomWorld

settings = get_settings()
START = "2026-11-03T06:00:00Z"          # 11:30 in Kolkata, a Tuesday
GEN = {"summary": "Acme wants the annual plan.\n\nSecurity review is the blocker.",
       "decisions": [{"text": "Go with the annual plan"}],
       "action_items": [{"text": "Send the proposal to Acme", "owner": "Ada Lovelace", "due": "Friday"},
                        {"text": "Book the security review", "owner": None, "due": None}],
       "open_questions": [], "topics": [], "highlights": []}


class HubSpotWorld(ZoomWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self._saved_h = settings.hubspot_api_base
        settings.hubspot_api_base = API
        await hubspot.ensure_indexes(self.db)
        self.fh = FakeHubSpot()
        self._htransport = hubspot_api.TRANSPORT
        hubspot_api.TRANSPORT = self.fh.transport()
        self._hs = (hubspot.SLEEP_CAP, hubspot.PACE, hubspot.SEARCH_PACE)
        hubspot.SLEEP_CAP, hubspot.PACE, hubspot.SEARCH_PACE = 0.0, 0.0, 0.0
        for who in ("owner", "wm", "wv", "wa"):
            await self.db["users"].update_one({"_id": ObjectId(self.uid[who])}, {"$set": {"name": {
                "owner": "Ada Lovelace", "wm": "Bo Chen", "wv": "Ravi Kumar", "wa": "Priya Sharma"}[who]}})
        self.ada = self.fh.add_owner(self.email["owner"], "Ada", "Lovelace")
        self.bo = self.fh.add_owner(self.email["wm"], "Bo", "Chen")
        self.rep = self.fh.add_owner("rep@acme-seller.test", "Rita", "Rep")
        self.assertEqual((await self.connect()).status_code, 200)      # Zoom, Sales team
        self.n_zoom = 0

    async def asyncTearDown(self):
        await hubspot.drain()
        hubspot_api.TRANSPORT = self._htransport
        settings.hubspot_api_base = self._saved_h
        hubspot.SLEEP_CAP, hubspot.PACE, hubspot.SEARCH_PACE = self._hs
        await super().asyncTearDown()

    # ── Helpers ──

    async def hs_connect(self, who: str = "wa", token: str | None = TOKEN, team: str | None = "sales", ws: str | None = None):
        body = {"workspace_id": ws or self.W, "token": token, **({"team_id": getattr(self, team)} if team else {})}
        return await self.http.put("/api/v1/hubspot/connection", headers=self.session(who), json=body)

    async def call(self, start: str = START, topic: str = "Acme discovery call", host: str = "owner", gen: dict | None = GEN,
                   **sets) -> str:
        self.n_zoom += 1
        uuid = f"hs-uuid-{self.n_zoom}"
        self.fz.add_meeting(uuid, topic, self.email[host], start)
        r = await self.hook(self.fz.event("recording.transcript_completed", uuid))
        self.assertEqual(r.status_code, 200, r.text)
        # The import's own background work (its summary) first, so the notes set here stay.
        await zoom.drain()
        for t in list(meetings._bg):
            await asyncio.wait({t}, timeout=10)
        await hubspot.drain()
        row = await self.db["meetings"].find_one({"zoom.uuid": uuid})
        self.assertIsNotNone(row, "the Zoom call came in")
        self.assertEqual(row["team_ids"], [self.sales])
        await self.db["meetings"].update_one({"_id": row["_id"]}, {"$set": {"generated": gen, **sets}})
        return str(row["_id"])

    async def panel(self, mid: str, who: str = "wm", code: int = 200) -> dict:
        r = await self.http.get(f"/api/v1/hubspot/meetings/{mid}", headers=self.session(who))
        self.assertEqual(r.status_code, code, r.text)
        return r.json()

    async def log(self, mid: str, who: str = "wm"):
        return await self.http.post(f"/api/v1/hubspot/meetings/{mid}/log", headers=self.session(who))

    def booked(self, start: str = START, owner: str | None = None, **props) -> tuple[str, str, str, str]:
        """A HubSpot meeting booked for the call (HubSpot's own Zoom connection), with a contact, company and deal."""
        c = self.fh.add("contacts", email="grace@acme.test", firstname="Grace", lastname="Hopper")
        co = self.fh.add("companies", name="Acme Corp", domain="acme.test")
        d = self.fh.add("deals", dealname="Acme annual", dealstage="qualifiedtobuy", amount="48000", closedate="2026-12-15T00:00:00Z",
                        hubspot_owner_id=self.rep, hs_lastmodifieddate="2026-11-02T00:00:00Z", hs_is_closed="false")
        m = self.fh.add("meetings", hs_meeting_title="Acme <> Seller intro", hs_meeting_start_time=start,
                        hubspot_owner_id=owner or self.ada, hs_meeting_body="Agenda for the attendees",
                        **props)
        self.fh.link("meetings", m, "contacts", c)
        self.fh.link("meetings", m, "companies", co)
        self.fh.link("meetings", m, "deals", d)
        self.fh.link("contacts", c, "companies", co)
        self.fh.link("deals", d, "contacts", c)
        self.fh.link("deals", d, "companies", co)
        return m, c, co, d

    def writes(self) -> list[tuple[str, str]]:
        return [(m, p) for m, p in self.fh.calls if m in ("PATCH", "PUT", "DELETE")
                or (m == "POST" and not p.endswith("/search") and not p.endswith("/batch/read") and "access-token-info" not in p)]


class Connect(HubSpotWorld):
    async def test_connect_checks_the_key_and_stores_it_encrypted(self):
        self.assertEqual((await self.hs_connect("wm")).status_code, 403)
        r = await self.hs_connect(token="fake-wrong-key-000")
        self.assertEqual(r.status_code, 400)
        self.assertIn("didn't accept the key", r.json()["detail"])
        r = await self.hs_connect()
        self.assertEqual(r.status_code, 200, r.text)
        st = r.json()
        self.assertTrue(st["connected"])
        self.assertEqual(st["mode"], "token")
        self.assertEqual(st["connection"]["portal_id"], str(PORTAL))
        self.assertEqual(st["team"]["id"], self.sales)
        self.assertEqual(st["connection"]["missing_scopes"], [])
        self.assertFalse(st["auto_log"])                                   # off by default
        self.assertNotIn(TOKEN, json.dumps(st))
        row = await self.db[hubspot.CONNS].find_one({"_id": self.W})
        self.assertNotIn(TOKEN, json.dumps(row, default=str))
        self.assertEqual(crypto.decrypt(row["token_enc"]), TOKEN)
        # Saving again with a blank token keeps it.
        r = await self.hs_connect(token="")
        self.assertEqual(r.status_code, 200, r.text)
        # Members see it's connected, never the scopes.
        r = await self.http.get("/api/v1/hubspot/status", headers=self.session("wm"), params={"workspace_id": self.W})
        self.assertTrue(r.json()["connected"])
        self.assertTrue(r.json()["can_use"])
        self.assertNotIn("missing_scopes", r.json()["connection"])
        self.assertIsNone(r.json()["scopes_needed"])
        r = await self.http.get("/api/v1/hubspot/status", headers=self.session("wv"), params={"workspace_id": self.W})
        self.assertFalse(r.json()["can_use"])                              # not in the Sales team

    async def test_missing_scopes_are_listed(self):
        self.fh.scopes.remove("crm.objects.deals.read")
        self.fh.scopes.remove("crm.objects.contacts.write")
        r = await self.hs_connect()
        self.assertEqual(r.status_code, 200, r.text)
        c = r.json()["connection"]
        self.assertEqual(c["broken"], "missing_scopes")
        self.assertEqual({m["scope"] for m in c["missing_scopes"]}, {"crm.objects.deals.read", "crm.objects.contacts.write"})

    async def test_a_service_key_is_checked_with_reads(self):
        self.fh.service_key = True
        self.fh.scopes.remove("crm.objects.companies.read")
        r = await self.hs_connect()
        self.assertEqual(r.status_code, 200, r.text)
        c = r.json()["connection"]
        self.assertEqual(c["scopes_from"], "probe")
        self.assertEqual([m["scope"] for m in c["missing_scopes"]], ["crm.objects.companies.read"])
        self.assertEqual(c["unchecked_scopes"], ["crm.objects.contacts.write", "crm.objects.deals.write"])

    async def test_one_hubspot_account_per_workspace(self):
        self.assertEqual((await self.hs_connect()).status_code, 200)
        await self.db["memberships"].insert_one({"workspace_id": self.ws["W2"], "user_id": self.uid["wa"], "role": "admin"})
        r = await self.hs_connect(ws=self.ws["W2"], team=None)
        self.assertIn(r.status_code, (403, 409), r.text)

    async def test_team_and_switch_admins_only(self):
        self.assertEqual((await self.hs_connect(team=None)).status_code, 200)
        r = await self.http.put("/api/v1/hubspot/team", headers=self.session("wm"), json={"workspace_id": self.W, "team_id": self.sales})
        self.assertEqual(r.status_code, 403)
        r = await self.http.put("/api/v1/hubspot/team", headers=self.session("wa"), json={"workspace_id": self.W, "team_id": self.sales})
        self.assertEqual(r.json()["team"]["name"], "Sales")
        r = await self.http.put("/api/v1/hubspot/settings", headers=self.session("wm"), json={"workspace_id": self.W, "auto_log": True})
        self.assertEqual(r.status_code, 403)
        r = await self.http.put("/api/v1/hubspot/settings", headers=self.session("wa"), json={"workspace_id": self.W, "auto_log": True})
        self.assertTrue(r.json()["auto_log"])


class Matching(HubSpotWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.assertEqual((await self.hs_connect()).status_code, 200)

    async def test_a_the_meeting_hubspot_booked(self):
        m, c, co, d = self.booked("2026-11-03T06:10:00Z")
        self.fh.add("meetings", hs_meeting_title="Someone else's", hs_meeting_start_time=START, hubspot_owner_id=self.bo)
        mid = await self.call()
        p = await self.panel(mid)
        self.assertTrue(p["available"])
        self.assertEqual((p["match"]["how"], p["match"]["confidence"]), ("meeting", "high"))
        self.assertTrue(p["match"]["meeting_found"])
        self.assertEqual(p["deal"]["name"], "Acme annual")
        self.assertEqual(p["deal"]["stage"], "Qualified to buy")
        self.assertEqual(p["deal"]["amount"], 48000)
        self.assertEqual(p["deal"]["owner"], "Rita Rep")
        self.assertEqual(p["deal"]["close_date"], "2026-12-15")
        self.assertEqual(p["deal"]["url"], f"https://app-eu1.hubspot.com/contacts/{PORTAL}/record/0-3/{d}")
        self.assertEqual([x["name"] for x in p["contacts"]], ["Grace Hopper"])
        self.assertEqual([x["name"] for x in p["companies"]], ["Acme Corp"])
        row = await self.db["meetings"].find_one({"_id": ObjectId(mid)})
        self.assertEqual(row["hubspot"]["match"]["meeting_id"], m)

    async def test_a_needs_the_call_within_15_minutes(self):
        self.booked("2026-11-03T06:40:00Z")
        mid = await self.call()
        p = await self.panel(mid)
        self.assertFalse(p["match"]["meeting_found"])
        self.assertEqual((p["match"]["how"], p["match"]["confidence"]), ("names", "low"))   # Zoom's attendee "Grace Hopper"

    async def test_b_attendee_emails_to_the_open_deal(self):
        c = self.fh.add("contacts", email="grace@acme.test", firstname="Grace", lastname="Hopper")
        co = self.fh.add("companies", name="Acme Corp")
        old = self.fh.add("deals", dealname="Acme pilot", dealstage="closedwon", hs_lastmodifieddate="2026-11-02T00:00:00Z")
        new = self.fh.add("deals", dealname="Acme expansion", dealstage="appointmentscheduled", hs_lastmodifieddate="2026-10-01T00:00:00Z")
        self.fh.link("contacts", c, "companies", co)
        self.fh.link("companies", co, "deals", old)
        self.fh.link("contacts", c, "deals", new)
        mid = await self.call(attendees=[{"name": "Ada Lovelace", "user_id": self.uid["owner"], "email": self.email["owner"]},
                                         {"name": "Grace Hopper", "user_id": None, "email": "grace@acme.test"}])
        p = await self.panel(mid)
        self.assertEqual((p["match"]["how"], p["match"]["confidence"]), ("contacts", "medium"))
        self.assertEqual(p["deal"]["name"], "Acme expansion")              # the open one, not the newer closed one
        self.assertEqual([x["name"] for x in p["companies"]], ["Acme Corp"])
        # A second open deal: the most recently active is picked, the other offered, confidence low.
        newer = self.fh.add("deals", dealname="Acme renewal", dealstage="qualifiedtobuy", hs_lastmodifieddate="2026-11-03T00:00:00Z")
        self.fh.link("companies", co, "deals", newer)
        r = await self.http.post(f"/api/v1/hubspot/meetings/{mid}/match", headers=self.session("wm"))
        p = r.json()
        self.assertEqual((p["deal"]["name"], p["match"]["confidence"]), ("Acme renewal", "low"))
        self.assertEqual([x["name"] for x in p["match"]["candidates"]], ["Acme expansion"])

    async def test_b_names_when_there_are_no_emails(self):
        c = self.fh.add("contacts", email="grace@acme.test", firstname="Grace", lastname="Hopper")
        d = self.fh.add("deals", dealname="Acme expansion", dealstage="appointmentscheduled")
        self.fh.link("contacts", c, "deals", d)
        mid = await self.call(attendees=[{"name": "Grace Hopper", "user_id": None, "email": None}])
        p = await self.panel(mid)
        self.assertEqual((p["match"]["how"], p["match"]["confidence"], p["deal"]["name"]), ("names", "low", "Acme expansion"))

    async def test_c_pick_the_deal(self):
        d = self.fh.add("deals", dealname="Globex rollout", dealstage="qualifiedtobuy")
        c = self.fh.add("contacts", email="hank@globex.test", firstname="Hank", lastname="Scorpio")
        self.fh.link("deals", d, "contacts", c)
        mid = await self.call()
        p = await self.panel(mid)
        self.assertEqual(p["match"]["how"], "none")
        r = await self.http.get("/api/v1/hubspot/deals", headers=self.session("wm"), params={"workspace_id": self.W, "q": "globex"})
        self.assertEqual([x["id"] for x in r.json()["deals"]], [d])
        r = await self.http.get("/api/v1/hubspot/deals", headers=self.session("wv"), params={"workspace_id": self.W, "q": "globex"})
        self.assertEqual(r.status_code, 403)
        r = await self.http.put(f"/api/v1/hubspot/meetings/{mid}/match", headers=self.session("wm"), json={"deal_id": d})
        self.assertEqual(r.status_code, 200, r.text)
        p = r.json()
        self.assertEqual((p["match"]["how"], p["deal"]["name"]), ("user", "Globex rollout"))
        self.assertEqual([x["name"] for x in p["contacts"]], ["Hank Scorpio"])
        # An automatic match never replaces a person's pick.
        row = await self.db["meetings"].find_one({"_id": ObjectId(mid)})
        conn = await hubspot.get(self.db, self.W)
        await hubspot.match(self.db, conn, row)
        self.assertEqual((await self.db["meetings"].find_one({"_id": ObjectId(mid)}))["hubspot"]["match"]["how"], "user")


class Logging(HubSpotWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.assertEqual((await self.hs_connect()).status_code, 200)

    async def test_fills_the_booked_meeting_internal_notes_and_never_duplicates(self):
        m, _c, _co, _d = self.booked("2026-11-03T06:05:00Z", hs_internal_meeting_notes="<p>Rita's prep: ask about SSO</p>")
        mid = await self.call()
        r = await self.log(mid)
        self.assertEqual(r.status_code, 200, r.text)
        p = r.json()
        self.assertTrue(p["logged"]["at"])
        self.assertFalse(p["logged"]["created"])
        self.assertEqual(p["logged"]["by"], "Bo Chen")
        props = self.fh.objects["meetings"][m]["properties"]
        notes = props["hs_internal_meeting_notes"]
        self.assertIn("Rita's prep: ask about SSO", notes)                 # the rep's own notes stay
        self.assertIn("Acme wants the annual plan.", notes)
        self.assertIn("Send the proposal to Acme", notes)
        self.assertIn("Go with the annual plan", notes)
        row = await self.db["meetings"].find_one({"_id": ObjectId(mid)})
        self.assertIn(f"/{row['slug']}", notes)
        self.assertEqual(props["hs_meeting_body"], "Agenda for the attendees")    # attendee-facing body untouched
        n = len(self.fh.objects["meetings"])
        # Again (after the summary changed): the same HubSpot meeting, Markdrop's block replaced, not added.
        await self.db["meetings"].update_one({"_id": ObjectId(mid)}, {"$set": {"generated.summary": "Acme signed off."}})
        self.assertEqual((await self.log(mid, "owner")).status_code, 200)
        notes = self.fh.objects["meetings"][m]["properties"]["hs_internal_meeting_notes"]
        self.assertEqual(len(self.fh.objects["meetings"]), n)
        self.assertEqual(notes.count(hubspot.MARK_START), 1)
        self.assertIn("Acme signed off.", notes)
        self.assertNotIn("Acme wants the annual plan.", notes)
        self.assertIn("Rita's prep: ask about SSO", notes)
        self.assertFalse(any(m_ == "POST" and p_ == "/crm/v3/objects/meetings" for m_, p_ in self.fh.calls))
        st = (await self.http.get("/api/v1/hubspot/status", headers=self.session("wa"), params={"workspace_id": self.W})).json()
        self.assertEqual(st["connection"]["logged"], 2)

    async def test_creates_one_meeting_when_none_was_booked(self):
        c = self.fh.add("contacts", email="grace@acme.test", firstname="Grace", lastname="Hopper")
        d = self.fh.add("deals", dealname="Acme expansion", dealstage="appointmentscheduled")
        self.fh.link("contacts", c, "deals", d)
        mid = await self.call(attendees=[{"name": "Grace Hopper", "user_id": None, "email": "grace@acme.test"}])
        r = await self.log(mid)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["logged"]["created"])
        self.assertEqual(len(self.fh.objects["meetings"]), 1)
        hid = next(iter(self.fh.objects["meetings"]))
        props = self.fh.objects["meetings"][hid]["properties"]
        self.assertEqual(props["hubspot_owner_id"], self.ada)
        self.assertEqual(props["hs_meeting_start_time"], START)
        self.assertIn("Acme wants the annual plan.", props["hs_internal_meeting_notes"])
        self.assertNotIn("hs_meeting_body", props)
        self.assertEqual(self.fh.linked("meetings", hid, "deals"), [d])
        self.assertEqual(self.fh.linked("meetings", hid, "contacts"), [c])
        for _ in range(2):
            self.assertEqual((await self.log(mid)).status_code, 200)
        self.assertEqual(len(self.fh.objects["meetings"]), 1)

    async def test_nothing_matched_asks_for_the_deal(self):
        mid = await self.call()
        r = await self.log(mid)
        self.assertEqual(r.status_code, 409)
        self.assertIn("Pick the deal", r.json()["detail"])
        self.assertEqual(self.writes(), [])

    async def test_rate_limits_are_retried(self):
        self.booked("2026-11-03T06:00:00Z")
        mid = await self.call()
        self.fh.limit(3)
        r = await self.log(mid)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertGreaterEqual(sum(1 for _ in self.fh.calls), 4)

    async def test_a_rejected_key_marks_the_connection(self):
        self.booked()
        mid = await self.call()
        self.fh.token = "fake-rotated-key"
        r = await self.log(mid)
        self.assertEqual(r.status_code, 409, r.text)
        self.assertIn("no longer accepts", r.json()["detail"])
        self.assertEqual((await hubspot.get(self.db, self.W))["broken"], "token")


class Tasks(HubSpotWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.assertEqual((await self.hs_connect()).status_code, 200)

    async def test_proposed_approved_created_once(self):
        _m, c, _co, d = self.booked()
        mid = await self.call()
        p = await self.panel(mid)
        tasks = {t["text"]: t for t in p["tasks"]}
        self.assertEqual(set(tasks), {"Send the proposal to Acme", "Book the security review"})
        send, book = tasks["Send the proposal to Acme"], tasks["Book the security review"]
        self.assertEqual(send["due"], "2026-11-06")                       # "Friday", said on Tuesday the 3rd
        self.assertEqual(send["assignee"]["owner_id"], self.ada)          # the person named
        self.assertEqual(book["assignee"]["owner_id"], self.rep)          # else the deal's owner
        self.assertEqual(book["due"], "2026-11-06")                       # 3 days after the call
        self.assertEqual(self.fh.objects["tasks"], {})                    # nothing before approval
        r = await self.http.post(f"/api/v1/hubspot/meetings/{mid}/tasks", headers=self.session("wm"), json={"keys": [send["key"]]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([x["status"] for x in r.json()["results"]], ["created"])
        self.assertEqual(len(self.fh.objects["tasks"]), 1)
        tid = next(iter(self.fh.objects["tasks"]))
        tp = self.fh.objects["tasks"][tid]["properties"]
        self.assertEqual((tp["hs_task_subject"], tp["hubspot_owner_id"], tp["hs_task_status"]),
                         ("Send the proposal to Acme", self.ada, "NOT_STARTED"))
        self.assertTrue(tp["hs_timestamp"].startswith("2026-11-06"))
        self.assertIn("Open the meeting in Markdrop", tp["hs_task_body"])
        self.assertEqual(self.fh.linked("tasks", tid, "deals"), [d])
        self.assertEqual(self.fh.linked("tasks", tid, "contacts"), [c])
        # Again, and with both: only the new one is created.
        r = await self.http.post(f"/api/v1/hubspot/meetings/{mid}/tasks", headers=self.session("owner"),
                                 json={"keys": [send["key"], book["key"], send["key"]]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(sorted(x["status"] for x in r.json()["results"]), ["created", "exists"])
        self.assertEqual(len(self.fh.objects["tasks"]), 2)
        p = await self.panel(mid)
        self.assertTrue(all(t["created"] for t in p["tasks"]))
        r = await self.http.post(f"/api/v1/hubspot/meetings/{mid}/tasks", headers=self.session("wm"), json={"keys": ["$set"]})
        self.assertEqual(r.status_code, 422)


class Privacy(HubSpotWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.assertEqual((await self.hs_connect()).status_code, 200)

    async def test_private_team_meeting_never_reaches_non_readers(self):
        self.booked()
        mid = await self.call()
        before = len(self.fh.calls)
        for who in ("wv", "ownv", "stranger"):                           # can't read the private Sales call
            await self.panel(mid, who, 404)
            self.assertEqual((await self.log(mid, who)).status_code, 404)
            r = await self.http.post(f"/api/v1/hubspot/meetings/{mid}/tasks", headers=self.session(who), json={"keys": ["x"]})
            self.assertEqual(r.status_code, 404)
        self.assertEqual(len(self.fh.calls), before)                      # nothing asked of HubSpot for them
        # Workspace admins and the team's members can.
        self.assertTrue((await self.panel(mid, "wa"))["available"])

    async def test_only_the_connected_team_and_workspace(self):
        mid = await self.call()
        await self.db["meetings"].update_one({"_id": ObjectId(mid)}, {"$set": {"team_ids": [self.eng]}})
        before = len(self.fh.calls)
        p = await self.panel(mid)
        self.assertEqual((p["available"], p["reason"]), (False, "not_team"))
        self.assertEqual((await self.log(mid)).status_code, 409)
        self.assertEqual(len(self.fh.calls), before)
        # Another workspace's meeting: its own (absent) connection, never this one's.
        await self.db["meetings"].update_one({"_id": ObjectId(mid)}, {"$set": {"workspace_id": self.ws["W2"], "team_ids": [self.sales]}})
        p = await self.http.get(f"/api/v1/hubspot/meetings/{mid}", headers=self.session("wm"))
        if p.status_code == 200:
            self.assertEqual(p.json()["reason"], "not_connected")
        self.assertEqual(len(self.fh.calls), before)

    async def test_disconnect_forgets_the_key_and_matches(self):
        m, _c, _co, _d = self.booked()
        mid = await self.call()
        self.assertEqual((await self.log(mid)).status_code, 200)
        r = await self.http.delete("/api/v1/hubspot/connection", headers=self.session("wm"), params={"workspace_id": self.W})
        self.assertEqual(r.status_code, 403)
        r = await self.http.delete("/api/v1/hubspot/connection", headers=self.session("wa"), params={"workspace_id": self.W})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(r.json()["connected"])
        self.assertIsNone(await hubspot.get(self.db, self.W))
        row = await self.db["meetings"].find_one({"_id": ObjectId(mid)})
        self.assertNotIn("match", row["hubspot"])
        self.assertEqual(row["hubspot"]["logged"]["meeting_id"], m)        # only the id stays
        p = await self.panel(mid)
        self.assertEqual(p["reason"], "not_connected")
        # Reconnecting the same account updates the same HubSpot meeting.
        self.assertEqual((await self.hs_connect()).status_code, 200)
        n = len(self.fh.objects["meetings"])
        self.assertEqual((await self.log(mid)).status_code, 200)
        self.assertEqual(len(self.fh.objects["meetings"]), n)


class Auto(HubSpotWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.assertEqual((await self.hs_connect()).status_code, 200)

    async def ready(self, mid: str) -> None:
        await meetings_ai._slack_ready(self.db, await self.db["meetings"].find_one({"_id": ObjectId(mid)}))
        await hubspot.drain()

    async def test_off_by_default_then_only_confident_matches(self):
        start = iso_days_ago(0, 1)          # today: a meeting from more than a day ago is a past one, never auto-logged
        m, _c, _co, _d = self.booked(start)
        mid = await self.call(start=start)
        self.assertFalse((await self.db["meetings"].find_one({"_id": ObjectId(mid)})).get("history"))
        await self.ready(mid)
        self.assertNotIn("hs_internal_meeting_notes", self.fh.objects["meetings"][m]["properties"])
        await self.http.put("/api/v1/hubspot/settings", headers=self.session("wa"), json={"workspace_id": self.W, "auto_log": True})
        await self.ready(mid)
        self.assertIn(hubspot.MARK_START, self.fh.objects["meetings"][m]["properties"]["hs_internal_meeting_notes"])
        p = await self.panel(mid)
        self.assertTrue(p["logged"]["auto"])
        # Medium confidence (attendees only): not automatically.
        c = self.fh.add("contacts", email="lin@initech.test", firstname="Lin", lastname="Tech")
        d = self.fh.add("deals", dealname="Initech", dealstage="appointmentscheduled")
        self.fh.link("contacts", c, "deals", d)
        mid2 = await self.call(start=iso_days_ago(0, 3), attendees=[{"name": "Lin Tech", "email": "lin@initech.test", "user_id": None}])
        n = len(self.fh.objects["meetings"])
        await self.ready(mid2)
        self.assertEqual(len(self.fh.objects["meetings"]), n)
        self.assertNotIn("logged", (await self.db["meetings"].find_one({"_id": ObjectId(mid2)})).get("hubspot") or {})
        # A past meeting (imported in bulk, or held days ago): never automatically.
        await self.db["meetings"].update_one({"_id": ObjectId(mid)}, {"$set": {"history": True}, "$unset": {"hubspot.logged": ""}})
        calls = len(self.fh.calls)
        await self.ready(mid)
        self.assertEqual(len(self.fh.calls), calls)


class DryRunAndMCP(HubSpotWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.assertEqual((await self.hs_connect()).status_code, 200)

    async def test_match_report_writes_nothing(self):
        self.booked()
        await self.call()
        await self.call(start="2026-11-05T09:00:00Z", topic="Globex intro")
        before = [r async for r in self.db["meetings"].find({}, {"hubspot": 1})]
        self.fh.calls.clear()
        got = await hubspot.match_report(self.db, self.W)
        self.assertEqual(got["total"], 2)
        self.assertEqual(got["counts"], {"meeting": 1, "names": 1})     # the other: Zoom's attendee "Grace Hopper"
        self.assertEqual(got["confidence"], {"high": 1, "low": 1})
        self.assertEqual([(r["title"], r["how"]) for r in got["rows"]], [("Globex intro", "names"), ("Acme discovery call", "meeting")])
        self.assertEqual(self.writes(), [])
        after = [r async for r in self.db["meetings"].find({}, {"hubspot": 1})]
        self.assertEqual(before, after)

    async def test_mcp_tools(self):
        _m, _c, _co, _d = self.booked()
        mid = await self.call()
        token = await self.mcp_token("wm")
        code, res = await self.mcp_call(token, "hubspot_status", {"workspace": self.W})
        self.assertEqual(code, 200)
        self.assertTrue(res["structuredContent"]["connected"])
        self.assertEqual(res["structuredContent"]["team"]["name"], "Sales")
        code, res = await self.mcp_call(token, "hubspot_match", {"meeting": mid})
        self.assertEqual(res["structuredContent"]["panel"]["deal"]["name"], "Acme annual", res)
        code, res = await self.mcp_call(token, "log_to_hubspot", {"meeting": mid})
        self.assertFalse(res.get("isError"), res)
        self.assertFalse(res["structuredContent"]["logged"]["created"])
        code, res = await self.mcp_call(token, "hubspot_tasks", {"meeting": mid})
        keys = [t["key"] for t in res["structuredContent"]["tasks"]]
        self.assertEqual(len(keys), 2, res["structuredContent"]["tasks"])
        code, res = await self.mcp_call(token, "hubspot_tasks", {"meeting": mid, "action": "create", "keys": keys[:1]})
        self.assertEqual([r["status"] for r in res["structuredContent"]["results"]], ["created"])
        code, res = await self.mcp_call(token, "hubspot_match", {"meeting": mid, "action": "search", "query": "acme"})
        self.assertEqual(len(res["structuredContent"]["deals"]), 1)
        # Someone outside the team: refused.
        token = await self.mcp_token("wv")
        code, res = await self.mcp_call(token, "log_to_hubspot", {"meeting": mid})
        self.assertTrue(res.get("isError"), res)


class WriteGuard(__import__("unittest").TestCase):
    """Markdrop never deletes or overwrites in a customer's HubSpot (Senseloaf, 2026-11-17)."""

    def test_allowed_and_refused(self):
        from app.services import hubspot as H
        from app.services.hubspot_api import HubSpotError
        conn = {"_id": "w"}
        ok = [("GET", "crm/v3/objects/deals/1", None), ("POST", "crm/v3/objects/meetings/search", {}),
              ("POST", "crm/v4/associations/meetings/deals/batch/read", {}), ("POST", "crm/v3/objects/meetings", {"properties": {}}),
              ("POST", "crm/v3/objects/tasks", {"properties": {}}),
              ("PUT", "crm/v4/objects/meetings/12/associations/default/deals/34", None),
              ("PATCH", "crm/v3/objects/meetings/12", {"properties": {"hs_internal_meeting_notes": "x"}})]
        for m, p, j in ok:
            H.guard(conn, m, p, j)
        refused = [("DELETE", "crm/v3/objects/meetings/12", None), ("DELETE", "crm/v3/objects/deals/9", None),
                   ("PATCH", "crm/v3/objects/meetings/12", {"properties": {"hs_meeting_body": "x"}}),
                   ("PATCH", "crm/v3/objects/meetings/12", {"properties": {"hs_internal_meeting_notes": "x", "hs_meeting_title": "y"}}),
                   ("PATCH", "crm/v3/objects/deals/9", {"properties": {"dealstage": "x"}}),
                   ("PATCH", "crm/v3/objects/contacts/5", {"properties": {"email": "x"}}),
                   ("PATCH", "crm/v3/objects/companies/5", {"properties": {"name": "x"}}),
                   ("POST", "crm/v3/objects/deals", {"properties": {}}), ("POST", "crm/v3/objects/contacts", {"properties": {}}),
                   ("POST", "crm/v3/objects/deals/batch/archive", {}), ("PUT", "crm/v3/objects/deals/9", {})]
        for m, p, j in refused:
            with self.assertRaises(HubSpotError, msg=f"{m} {p}"):
                H.guard(conn, m, p, j)
        # A deal field only when the workspace turned deal updates on.
        H.guard({"_id": "w", "deal_updates": True}, "PATCH", "crm/v3/objects/deals/9", {"properties": {"dealstage": "x"}})
