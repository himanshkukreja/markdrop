"""Zoom: which recorded meetings come in, and the host's say (services/zoom_review.py; brief
.work/briefs/zoom-share-control.md).

The rules in order: (1) a personal/private topic never comes in, (2) the host chose never, (3) someone from
outside the company → shared, (4) everyone from the company → held for the host, (5) otherwise the host's
setting. A held meeting keeps only metadata (no transcript, no recording, no Deepgram), only its host sees
and decides it (web, MCP, Slack buttons bound to the host), and it expires after 30 days.

Zoom, Deepgram, R2 and Slack are fakes (tests/_zoom_fake.py, tests/_files_env.FakeR2, tests/test_slack.FakeSlack).
World: tests/test_zoom.ZoomWorld (Sales: owner = Ada, wm = Bo; members are @example.com).

Run: cd backend && MARKDROP_TEST_MONGODB_URI=mongodb://127.0.0.1:27019 .venv/bin/python -m unittest tests.test_zoom_review -v
"""

from __future__ import annotations

import json
from datetime import timedelta

from bson import ObjectId

from tests.test_slack import SlackWorld
from tests.test_zoom import ZoomWorld
from tests.test_zoom_media import MediaWorld

from app.services import notifications, slack, zoom, zoom_media, zoom_review
from tests._zoom_fake import iso_days_ago

EXT = "grace@acme.test"


def people(*rows: tuple[str, str]) -> list[dict]:
    return [{"name": n, "user_email": e} for n, e in rows]


class Rules(ZoomWorld):
    def test_personal_topic_is_a_word_match(self):
        for t in ("Personal: dentist", "my PRIVATE sync", "1:1 (private)", "personal-finance chat"):
            self.assertTrue(zoom_review.personal_topic(t), t)
        for t in ("Privately held companies", "Personality test", "Acme pricing", None):
            self.assertFalse(zoom_review.personal_topic(t), t)

    def test_audience(self):
        emails, domains = {"ada@example.com"}, {"example.com"}
        self.assertEqual(zoom_review.audience([], emails, domains), "unknown")
        self.assertEqual(zoom_review.audience([{"email": "ada@example.com"}, {"email": "new@example.com"}], emails, domains), "internal")
        self.assertEqual(zoom_review.audience([{"email": "ada@example.com"}, {"email": None}], emails, domains), "unknown")
        self.assertEqual(zoom_review.audience([{"email": None}, {"email": EXT}], emails, domains), "external")

    async def test_public_mail_domains_are_never_the_company(self):
        await self.db["users"].update_one({"_id": ObjectId(self.uid["wm"])}, {"$set": {"email": "bo@gmail.com"}})
        emails, domains = await zoom_review.company(self.db, self.W)
        self.assertIn("bo@gmail.com", emails)
        self.assertNotIn("gmail.com", domains)
        self.assertIn("example.com", domains)
        self.assertEqual(zoom_review.audience([{"email": "stranger@gmail.com"}], emails, domains), "external")


class ReviewWorld(ZoomWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.assertEqual((await self.connect()).status_code, 200)

    async def setting(self, who: str, share: str):
        r = await self.http.put("/api/v1/zoom/me", headers=self.session(who), json={"share": share})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def internal(self, uuid: str, topic: str = "Pipeline review", host: str = "owner", **kw):
        return self.fz.add_meeting(uuid, topic, self.email[host], iso_days_ago(0, 6), participants=people(
            ("Ada Lovelace", self.email["owner"]), ("Bo Test", self.email["wm"]), ("Cy New", "cy@example.com")), **kw)

    async def held_list(self, who: str) -> list[dict]:
        r = await self.http.get("/api/v1/zoom/review", headers=self.session(who), params={"workspace_id": self.W})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["meetings"]

    async def decide(self, who: str, uuid: str, decision: str):
        return await self.http.post("/api/v1/zoom/review", headers=self.session(who),
                                    json={"workspace_id": self.W, "uuid": uuid, "decision": decision})

    def downloads(self) -> list[str]:
        return [u for _m, u in self.fz.calls if "/rec/download/" in u]

    async def meeting_of(self, uuid: str) -> dict | None:
        return await self.db["meetings"].find_one({"sources.file_id": f"zoom:{uuid}"})


class Webhook(ReviewWorld):
    async def test_personal_topic_and_never_keep_nothing(self):
        self.fz.add_meeting("p-1", "Personal: visa appointment", self.email["owner"], iso_days_ago(0, 6),
                            participants=people(("Ada", self.email["owner"]), ("Grace", EXT)))
        await self.hook(self.fz.event("recording.transcript_completed", "p-1"))
        self.assertIsNone(await self.meeting_of("p-1"))
        row = await self.db[zoom.MEETINGS].find_one({"uuid": "p-1"})
        self.assertEqual(row["state"], "skipped")
        self.assertEqual(row["reason"], "personal")
        self.assertNotIn("topic", row)
        self.assertNotIn("visa", json.dumps(row, default=str))
        self.assertEqual(self.downloads(), [])                         # nothing downloaded, not even who joined
        self.assertFalse([u for _m, u in self.fz.calls if "/participants" in u])
        # A second event changes nothing.
        await self.hook(self.fz.event("recording.transcript_completed", "p-1"))
        self.assertIsNone(await self.meeting_of("p-1"))
        # The host chose never: an external call stays out too.
        await self.setting("wm", "never")
        self.fz.add_meeting("n-1", "Globex call", self.email["wm"], iso_days_ago(0, 7), participants=people(("Grace", EXT)))
        await self.hook(self.fz.event("recording.transcript_completed", "n-1"))
        self.assertIsNone(await self.meeting_of("n-1"))
        self.assertEqual((await self.db[zoom.MEETINGS].find_one({"uuid": "n-1"}))["reason"], "host_never")
        st = await self.status()
        self.assertEqual(st["connection"]["skipped"], 2)
        self.assertNotIn("visa", json.dumps(st))
        self.assertNotIn("Globex", json.dumps(st))

    async def test_external_shares_even_when_the_host_asks_first(self):
        await self.setting("owner", "ask")
        self.fz.add_meeting("x-1", "Acme pricing", self.email["owner"], iso_days_ago(0, 6),
                            participants=people(("Ada", self.email["owner"]), ("Grace", EXT)))
        await self.hook(self.fz.event("recording.transcript_completed", "x-1"))
        row = await self.meeting_of("x-1")
        self.assertIsNotNone(row)
        self.assertEqual(row["team_ids"], [self.sales])
        self.assertFalse(row.get("restricted"))
        z = await self.db[zoom.MEETINGS].find_one({"uuid": "x-1"})
        self.assertEqual((z["state"], z["decision"], z["decision_by"]), ("imported", "share", "external"))

    async def test_internal_only_is_held_with_metadata_only(self):
        self.internal("i-1")
        await self.hook(self.fz.event("recording.transcript_completed", "i-1"))
        self.assertIsNone(await self.meeting_of("i-1"))
        self.assertEqual(self.downloads(), [])                         # no transcript fetched
        row = await self.db[zoom.MEETINGS].find_one({"uuid": "i-1"})
        self.assertEqual((row["state"], row["reason"]), ("held", "internal_only"))
        self.assertEqual(row["topic"], "Pipeline review")
        self.assertEqual(row["people"], {"names": ["Ada Lovelace", "Bo Test", "Cy New"], "count": 3})
        self.assertNotIn("example.com", json.dumps(row.get("people")))  # names only, no addresses
        self.assertEqual(row["host"]["id"], self.uid["owner"])
        # Only the host sees it: the review list, the inbox, the card's count.
        self.assertEqual([m["uuid"] for m in await self.held_list("owner")], ["i-1"])
        self.assertEqual(await self.held_list("wm"), [])
        self.assertEqual(await self.held_list("wa"), [])
        mine = [i for i in (await notifications.listing(self.db, self.uid["owner"]))["items"] if i["kind"] == "zoom_review"]
        self.assertEqual(len(mine), 1)
        self.assertTrue(mine[0]["available"])
        self.assertIn("Pipeline review", mine[0]["text"])
        self.assertEqual(mine[0]["href"], f"/integrations/zoom/review?workspace={self.W}")
        for who in ("wm", "wa", "wo"):
            items = (await notifications.listing(self.db, self.uid[who]))["items"]
            self.assertFalse([i for i in items if i["kind"] == "zoom_review"], who)
        st = await self.status("wa")
        self.assertEqual(st["connection"]["held"], 1)
        self.assertNotIn("Pipeline review", json.dumps(st))
        self.assertEqual(st["my_review"], 0)
        self.assertEqual((await self.status("owner"))["my_review"], 1)
        # Zoom's other event: still held, told once.
        self.fz.transcript_in_completed = True
        await self.hook(self.fz.event("recording.completed", "i-1"))
        self.assertEqual((await self.db[zoom.MEETINGS].find_one({"uuid": "i-1"}))["state"], "held")
        self.assertEqual(await self.db[notifications.COLL].count_documents({"kind": "zoom_review"}), 1)

    async def test_unknown_follows_the_host_setting(self):
        await self.setting("owner", "ask")
        self.fz.add_meeting("u-1", "Weekly sync", self.email["owner"], iso_days_ago(0, 6),
                            participants=people(("Ada", self.email["owner"]), ("Guest", "")))
        await self.hook(self.fz.event("recording.transcript_completed", "u-1"))
        self.assertEqual((await self.db[zoom.MEETINGS].find_one({"uuid": "u-1"}))["reason"], "host_ask")
        self.assertIsNone(await self.meeting_of("u-1"))
        # Bo shares automatically (the default): the same kind of call comes in.
        self.fz.add_meeting("u-2", "Weekly sync", self.email["wm"], iso_days_ago(0, 7),
                            participants=people(("Bo", self.email["wm"]), ("Guest", "")))
        await self.hook(self.fz.event("recording.transcript_completed", "u-2"))
        self.assertIsNotNone(await self.meeting_of("u-2"))


class Decide(ReviewWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        for u in ("d-1", "d-2", "d-3"):
            self.internal(u, topic=f"Internal {u}")
            await self.hook(self.fz.event("recording.transcript_completed", u))

    async def test_only_the_host_decides(self):
        r = await self.decide("wm", "d-1", "share")
        self.assertEqual(r.status_code, 403, r.text)
        r = await self.decide("wa", "d-1", "share")
        self.assertEqual(r.status_code, 403, r.text)
        r = await self.decide("wv", "d-1", "share")
        self.assertEqual(r.status_code, 403, r.text)
        r = await self.decide("owner", "d-1", "maybe")
        self.assertEqual(r.status_code, 422)
        self.assertEqual((await self.db[zoom.MEETINGS].find_one({"uuid": "d-1"}))["state"], "held")

    async def test_share_private_skip(self):
        r = await self.decide("owner", "d-1", "share")
        self.assertEqual(r.status_code, 200, r.text)
        await zoom.drain()
        row = await self.meeting_of("d-1")
        self.assertIsNotNone(row)
        self.assertEqual(row["team_ids"], [self.sales])
        self.assertFalse(row.get("restricted"))
        self.assertIn(str(row["_id"]), await self.listed_meetings("wm"))
        self.assertEqual((await self.db[zoom.MEETINGS].find_one({"uuid": "d-1"}))["state"], "imported")
        # Keep it just for me: private to the host, the other attendees (members) get nothing.
        r = await self.decide("owner", "d-2", "private")
        self.assertEqual(r.status_code, 200, r.text)
        await zoom.drain()
        row = await self.meeting_of("d-2")
        self.assertTrue(row["restricted"])
        self.assertEqual(row.get("granted"), [])
        page = await self.db["documents"].find_one({"_id": row["doc_id"]})
        self.assertEqual(page["access_level"], "private")
        self.assertEqual((await self.get(page["slug"], self.session("owner"))).status_code, 200)
        self.assertNotEqual((await self.get(page["slug"], self.session("wm"))).status_code, 200)
        self.assertNotIn(str(row["_id"]), await self.listed_meetings("wm"))
        # Skip: nothing but the uuid.
        r = await self.decide("owner", "d-3", "skip")
        self.assertEqual(r.status_code, 200, r.text)
        await zoom.drain()
        self.assertIsNone(await self.meeting_of("d-3"))
        z = await self.db[zoom.MEETINGS].find_one({"uuid": "d-3"})
        self.assertEqual((z["state"], z["reason"]), ("skipped", "host_skipped"))
        self.assertNotIn("topic", z)
        self.assertNotIn("people", z)
        # Decided once: again is a 404, and Zoom's events don't bring it back.
        self.assertEqual((await self.decide("owner", "d-3", "share")).status_code, 404)
        await self.hook(self.fz.event("recording.transcript_completed", "d-3"))
        self.assertIsNone(await self.meeting_of("d-3"))
        self.assertEqual(await self.held_list("owner"), [])
        items = [i for i in (await notifications.listing(self.db, self.uid["owner"]))["items"] if i["kind"] == "zoom_review"]
        self.assertTrue(items and not any(i["available"] for i in items))

    async def test_held_meetings_expire(self):
        await self.db[zoom.MEETINGS].update_one({"uuid": "d-1"}, {"$set": {"expires_at": zoom_review.now_utc() - timedelta(minutes=1)}})
        self.assertEqual(await zoom_review.expire(self.db), 1)
        z = await self.db[zoom.MEETINGS].find_one({"uuid": "d-1"})
        self.assertEqual((z["state"], z["reason"]), ("expired", "expired"))
        for k in ("topic", "people", "host", "start_time"):
            self.assertNotIn(k, z)
        self.assertEqual((await self.decide("owner", "d-1", "share")).status_code, 404)
        self.assertEqual({m["uuid"] for m in await self.held_list("owner")}, {"d-2", "d-3"})

    async def test_mcp_list_decide_settings(self):
        token = await self.mcp_token("owner")
        code, res = await self.mcp_call(token, "zoom_review", {"workspace": self.W})
        self.assertEqual(code, 200)
        out = res["structuredContent"]
        self.assertEqual({m["uuid"] for m in out["meetings"]}, {"d-1", "d-2", "d-3"})
        code, res = await self.mcp_call(token, "zoom_review", {"workspace": self.W, "action": "decide", "uuid": "d-1",
                                                               "decision": "private"})
        self.assertFalse(res.get("isError"), res)
        await zoom.drain()
        self.assertTrue((await self.meeting_of("d-1"))["restricted"])
        code, res = await self.mcp_call(token, "zoom_review", {"action": "settings", "share": "ask"})
        self.assertEqual(res["structuredContent"]["share"], "ask")
        self.assertEqual(res["structuredContent"]["teams"][0]["team"], "Sales")
        # Bo isn't the host.
        token = await self.mcp_token("wm")
        code, res = await self.mcp_call(token, "zoom_review", {"workspace": self.W, "action": "decide", "uuid": "d-2",
                                                               "decision": "share"})
        self.assertTrue(res.get("isError"), res)


class Settings(ReviewWorld):
    async def test_own_setting_and_admin_per_member(self):
        r = await self.http.get("/api/v1/zoom/me", headers=self.session("wm"))
        self.assertEqual(r.json()["share"], "auto")
        self.assertEqual(r.json()["teams"][0]["team"], "Sales")
        self.assertEqual((await self.http.get("/api/v1/zoom/me", headers=self.session("wv"))).json()["teams"], [])
        r = await self.http.put("/api/v1/zoom/me", headers=self.session("wm"), json={"share": "sometimes"})
        self.assertEqual(r.status_code, 422)
        self.assertEqual((await self.setting("wm", "never"))["share"], "never")
        st = await self.status("wa")
        self.assertEqual({m["id"]: m["share"] for m in st["members"]}, {self.uid["owner"]: "auto", self.uid["wm"]: "never"})
        self.assertIsNone((await self.status("wm"))["members"])
        body = {"workspace_id": self.W, "user_id": self.uid["owner"], "share": "ask"}
        r = await self.http.put("/api/v1/zoom/members/share", headers=self.session("wm"), json=body)
        self.assertEqual(r.status_code, 403)
        r = await self.http.put("/api/v1/zoom/members/share", headers=self.session("wa"), json=body)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((await self.http.get("/api/v1/zoom/me", headers=self.session("owner"))).json()["share"], "ask")
        r = await self.http.put("/api/v1/zoom/members/share", headers=self.session("wa"), json={**body, "user_id": self.uid["wv"]})
        self.assertEqual(r.status_code, 404)


class Backfill(ReviewWorld):
    async def test_past_meetings_follow_the_rules(self):
        self.fz.add_meeting("b-pers", "Private: doctor", self.email["owner"], iso_days_ago(3))
        self.internal("b-int", topic="Team retro")
        self.fz.add_meeting("b-ext", "Acme demo", self.email["owner"], iso_days_ago(4), participants=people(("Grace", EXT)))
        self.internal("b-int2", topic="Hiring sync", host="wm")
        r = await self.http.get("/api/v1/zoom/recordings", headers=self.session("wa"), params={"workspace_id": self.W})
        by = {m["uuid"]: m for m in r.json()["meetings"]}
        self.assertEqual(by["b-pers"]["state"], "skipped")
        self.assertNotIn("doctor", json.dumps(r.json()))
        self.assertIsNone(by["b-ext"]["state"])
        r = await self.http.post("/api/v1/zoom/import", headers=self.session("wa"),
                                 json={"workspace_id": self.W, "uuids": ["b-pers", "b-int", "b-ext", "b-int2"]})
        self.assertEqual(r.status_code, 200, r.text)
        res = {x["uuid"]: x for x in r.json()["results"]}
        self.assertEqual(res["b-pers"]["status"], "skipped")
        self.assertIn("personal or private", res["b-pers"]["reason"])
        self.assertEqual(res["b-int"]["status"], "held")
        self.assertIn("host decides", res["b-int"]["reason"])
        self.assertIsNone(res["b-int"]["topic"])
        self.assertEqual(res["b-ext"]["status"], "imported")
        self.assertNotIn("Team retro", r.text)
        self.assertNotIn("host_id", r.text)
        # Each host gets one inbox item for their held past meetings (no Slack); nobody else.
        for who in ("owner", "wm"):
            items = [i for i in (await notifications.listing(self.db, self.uid[who]))["items"] if i["kind"] == "zoom_review"]
            self.assertEqual(len(items), 1, who)
        self.assertFalse([i for i in (await notifications.listing(self.db, self.uid["wa"]))["items"] if i["kind"] == "zoom_review"])
        r = await self.http.get("/api/v1/zoom/recordings", headers=self.session("wa"), params={"workspace_id": self.W})
        by = {m["uuid"]: m for m in r.json()["meetings"]}
        self.assertEqual(by["b-int"]["state"], "held")
        self.assertNotIn("Team retro", r.text)
        # The host shares it: it comes in as a past meeting.
        self.assertEqual((await self.decide("owner", "b-int", "share")).status_code, 200)
        await zoom.drain()
        row = await self.meeting_of("b-int")
        self.assertTrue(row.get("history"))


class HeldMedia(MediaWorld):
    async def test_held_meeting_never_reaches_deepgram_or_r2(self):
        self.assertEqual((await self.switch(True)).status_code, 200)
        self.fz.add_meeting("m-1", "Pricing prep", self.email["owner"], iso_days_ago(2), transcript=False,
                            participants=people(("Ada", self.email["owner"]), ("Bo", self.email["wm"])))
        self.fz.add_media("m-1", audio=b"secret-audio")
        res = await self.import_("m-1")
        self.assertEqual(res["m-1"]["status"], "held")
        await zoom_media.run_all(self.db)
        self.assertEqual(self.dg.received, [])
        self.assertEqual(self.fz.media_gets, [])
        z = await self.db[zoom.MEETINGS].find_one({"uuid": "m-1"})
        self.assertEqual(z["state"], "held")
        self.assertNotIn("rec_state", z)
        # Shared: now it is transcribed and its recording copied.
        r = await self.http.post("/api/v1/zoom/review", headers=self.session("owner"),
                                 json={"workspace_id": self.W, "uuid": "m-1", "decision": "share"})
        self.assertEqual(r.status_code, 200, r.text)
        await zoom.drain()
        await zoom_media.run_all(self.db)
        self.assertTrue(self.dg.received)
        self.assertIsNotNone(await self.meeting_of("m-1"))


class SlackButtons(ReviewWorld, SlackWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await self.install()

    def dms(self, sid: str) -> list[dict]:
        return [d for d in self.sk.of("chat.postMessage") if d["channel"] == sid]

    @staticmethod
    def button(msg: dict, action_id: str) -> dict:
        return [e for b in msg["blocks"] for e in b.get("elements", []) if e.get("action_id") == action_id][0]

    async def test_buttons_work_only_for_the_host(self):
        self.in_slack("owner", "U0ADA")
        self.in_slack("wm", "U0BO")
        self.internal("s-1", topic="Forecast call")
        self.internal("s-2", topic="Roadmap chat")
        await self.hook(self.fz.event("recording.transcript_completed", "s-1"))
        await self.hook(self.fz.event("recording.transcript_completed", "s-2"))
        dm = self.dms("U0ADA")
        self.assertEqual(len(dm), 2, self.sk.of("chat.postMessage"))
        self.assertEqual(self.dms("U0BO"), [])
        self.assertIn("Forecast call", json.dumps(dm[0]["blocks"]))
        self.assertIn("Share with Sales", json.dumps(dm[0]["blocks"]))
        share = self.button(dm[0], "md_zr_share")
        # Bo's click does nothing.
        await self.click("md_zr_share", share["value"], "U0BO")
        await slack.drain()
        self.assertIn("Only the person", json.dumps(self.sk.responds[-1]))
        self.assertIsNone(await self.meeting_of("s-1"))
        await self.click("md_zr_share", share["value"], "U0ADA")
        await slack.drain()
        await zoom.drain()
        self.assertIsNotNone(await self.meeting_of("s-1"))
        self.assertTrue(any("Shared with Sales" in json.dumps(u) for u in self.sk.of("chat.update")))
        # Again: it isn't waiting any more.
        await self.click("md_zr_share", share["value"], "U0ADA")
        await slack.drain()
        self.assertIn("isn't waiting", json.dumps(self.sk.responds[-1]))
        # Skip on the second one.
        await self.click("md_zr_skip", self.button(dm[1], "md_zr_skip")["value"], "U0ADA")
        await slack.drain()
        self.assertEqual((await self.db[zoom.MEETINGS].find_one({"uuid": "s-2"}))["state"], "skipped")
        self.assertIsNone(await self.meeting_of("s-2"))
