"""Markdrop for Slack: each person's action items as a direct message after a meeting
(services/slack_action_items.py). Slack is :class:`tests.test_slack.FakeSlack`; the meeting AI is
the fake model client of tests.test_meetings (never the real API).

Run: cd backend && MARKDROP_TEST_MONGODB_URI=mongodb://127.0.0.1:27019 .venv/bin/python -m unittest tests.test_slack_action_items -v
"""

from __future__ import annotations

import json
import unittest
from datetime import timedelta

from tests.test_slack import TEAM, SlackWorld  # noqa: F401  (pins settings first)
from tests.test_meetings import MeetingsWorld

from app.services import meetings, slack, slack_notify
from app.services import slack_action_items as sai


def today() -> str:
    return meetings.now_utc().date().isoformat()


def notes_doc(title: str = "Daily Syncup", invited: str | None = None, steps: list[str] | None = None) -> str:
    d = meetings.now_utc()
    invited = invited or "Ada Lovelace <owner@example.com>, Bo Chen <wm@example.com>, Zara Khan <zara@ext.test>"
    steps = steps if steps is not None else [
        "Zara Khan will send the pricing sheet to finance by Friday.",
        "Bo Chen will update the onboarding docs.",
        "Zara Khan will book the demo room.",
        "Ada Lovelace will write the release notes.",
    ]
    return (f"# {title}\n{d.strftime('%b')} {d.day}, {d.year}\nInvited {invited}\n"
            f"Attachments {title}\nMeeting records Transcript\n\n"
            "## Summary\nThe team walked through the launch checklist. SECRET-SUMMARY-TEXT.\n\n"
            "## Details\n- **Launch**: on track for Friday (00:00:20).\n\n"
            "## Suggested next steps\n" + "".join(f"- [ ] {s}\n" for s in steps) +
            "\nYou should review Gemini's notes to make sure they're accurate.\n")


def ext(sid: str, name: str, email: str | None = None, **extra) -> dict:
    """Someone in the Slack team who isn't in Markdrop."""
    return {"id": sid, "name": name.split()[0].lower(), "real_name": name, "deleted": False, "is_bot": False,
            "is_email_confirmed": True, "profile": {"email": email, "real_name": name, "display_name": ""}, **extra}


class Parsing(unittest.TestCase):
    def test_items_and_their_person(self):
        uid = "a" * 24
        md = ("## Action items\n\n"
              f'- [ ] :person[Bo Chen]{{id="{uid}"}} Update the docs · due next Wednesday [12:01](/x#b-t0010) {{#b-1111}}\n'
              "- [ ] **Zara Khan** Book the room {#b-2222}\n"
              "- [x] Zara Khan will send the sheet\\. {#b-3333}\n"
              "- [ ] \\[Sam Lee\\] Review the deck {#b-4444}\n"
              "- [ ] Nobody in particular should tidy up {#b-5555}\n\n## Open questions\n\n- [ ] Not an item {#b-6666}\n")
        items = sai.page_items(md)
        self.assertEqual([i.block for i in items], ["b-1111", "b-2222", "b-3333", "b-4444", "b-5555"])
        self.assertEqual((items[0].who_id, items[0].text, items[0].due), (uid, "Update the docs", "next Wednesday"))
        self.assertEqual((items[1].who_name, items[1].text), ("Zara Khan", "Book the room"))
        self.assertTrue(items[2].done)
        self.assertEqual((items[3].who_name, items[3].text), ("Sam Lee", "Review the deck"))
        row = {"attendees": [{"name": "Bo Chen", "user_id": uid}, {"name": "Zara Khan", "email": "zara@ext.test"}],
               "organizer": {"name": "Ada Lovelace"}}
        people = {p.name: [i.text for i in p.items] for p in sai.assign(row, items)}
        # Sam isn't an attendee, nor is "Nobody"; Zara's ticked one isn't open.
        self.assertEqual(people, {"Bo Chen": ["Update the docs"], "Zara Khan": ["Book the room"]})
        self.assertEqual(items[2].text, "Send the sheet.")   # the name taken off a ticked one too

    def test_invited_attendees_and_organizer_are_one_list(self):
        uid = "a" * 24
        row = {"attendees": [{"name": "Bo Chen", "user_id": uid, "email": None}],
               "invited": [{"name": "Bo Chen", "user_id": uid, "email": "bo@acme.test"},
                           {"name": "Zara Khan", "user_id": None, "email": "zara@ext.test"}],
               "organizer": {"name": "Zara Khan", "email": None}}
        people = sai._people(row)
        self.assertEqual([(p.name, p.user_id, p.email) for p in people],
                         [("Bo Chen", uid, "bo@acme.test"), ("Zara Khan", None, "zara@ext.test")])

    def test_a_mentioned_member_who_didnt_attend_gets_nothing(self):
        md = '## Action items\n\n- [ ] :person[Priya]{id="' + "b" * 24 + '"} Ship it {#b-1}\n'
        row = {"attendees": [{"name": "Bo Chen", "user_id": "a" * 24}]}
        self.assertEqual(sai.assign(row, sai.page_items(md)), [])

    def test_due_dates(self):
        it = sai.Item(block="b", done=False, text="Send the sheet by Friday.")
        self.assertEqual(sai.due_label(it, "2026-11-04"), "Fri, Nov 6")
        self.assertEqual(sai.due_label(sai.Item(block="b", done=False, text="x", due="Thursday"), "2026-11-04"),
                         "Thursday (Thu, Nov 5)")
        self.assertIsNone(sai.due_label(sai.Item(block="b", done=False, text="Book the room."), "2026-11-04"))
        self.assertEqual(sai.due_label(sai.Item(block="b", done=False, text="Deck kal tak bhejna"), "2026-11-04"), "Thu, Nov 5")
        self.assertEqual(sai.due_label(sai.Item(block="b", done=False, text="Update the pricing page early next week"),
                                       "2026-11-04"), "Mon, Nov 9")

    def test_too_old(self):
        now = meetings.now_utc()
        self.assertTrue(sai.too_old({"history": True, "date": today(), "created_at": now}))
        self.assertTrue(sai.too_old({"date": (now - timedelta(days=3)).date().isoformat(), "created_at": now}))
        self.assertTrue(sai.too_old({"date": today(), "created_at": now - timedelta(hours=25)}))
        self.assertFalse(sai.too_old({"date": today(), "created_at": now - timedelta(hours=2)}))


class ActionItemsWorld(MeetingsWorld, SlackWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        sai._NAMES.clear()
        await self.install()

    async def imported(self, sources=None, **kw) -> dict:
        kw.setdefault("date", today())
        r = await self.do_import(sources=sources, **kw)
        self.assertEqual(r.status_code, 200, r.text)
        await slack.drain()
        return r.json()["meetings"][0]

    async def notes_meeting(self, **kw) -> dict:
        title = kw.pop("title", "Daily Syncup")
        doc = notes_doc(title, kw.pop("invited", None), kw.pop("steps", None))
        return await self.imported(sources=[{"name": f"{title} - Notes by Gemini", "text": doc}], **kw)

    async def send(self, minutes: float = 1.1) -> int:
        return await slack_notify.flush(self.db, now=meetings.now_utc() + timedelta(minutes=minutes))

    def dms(self, sid: str | None = None) -> list[dict]:
        return [d for d in self.sk.of("chat.postMessage") if d["channel"].startswith("U")
                and (sid is None or d["channel"] == sid)]

    @staticmethod
    def buttons(msg: dict, action_id: str) -> list[dict]:
        out = []
        for b in msg["blocks"]:
            if b.get("accessory", {}).get("action_id") == action_id:
                out.append(b["accessory"])
            out += [e for e in b.get("elements", []) if e.get("action_id") == action_id]
        return out


class Sending(ActionItemsWorld):
    async def test_each_person_gets_only_their_own_items(self):
        self.in_slack("wm", "U0BO")      # Bo Chen: a member who can edit
        self.in_slack("wv", "U0RAVI")    # Ravi Kumar: a viewer
        self.in_slack("owner", "U0ADA")  # Ada: no items of her own
        self.sk.directory["zed@else.test"] = ext("U0ZED", "Zed Nobody", "zed@else.test")
        m = await self.imported()
        self.assertEqual(self.dms(), [])           # waits a minute first
        self.assertEqual(await self.send(), 2)
        bo, ravi = self.dms("U0BO"), self.dms("U0RAVI")
        self.assertEqual((len(bo), len(ravi)), (1, 1))
        self.assertEqual(self.dms("U0ADA") + self.dms("U0ZED"), [])   # no items / not an attendee
        text = json.dumps(bo[0])
        self.assertIn("Your action items from *Weekly product sync*", text)
        self.assertIn("Update the onboarding docs with the new screenshots", text)
        self.assertIn("due next Wednesday (", text)      # with the date it means
        self.assertNotIn("Senseloaf", text)        # Ravi's
        self.assertNotIn("launch party", text)
        self.assertIn("Open the notes", text)
        self.assertIn(m["slug"], text)
        self.assertEqual(len(self.buttons(bo[0], "md_ai_done")), 1)
        self.assertEqual(len(self.buttons(bo[0], "md_ai_stop")), 1)
        # A viewer: the link, no Done button.
        self.assertIn("Email the Senseloaf team", json.dumps(ravi[0]))
        self.assertIn("Open the notes", json.dumps(ravi[0]))
        self.assertEqual(self.buttons(ravi[0], "md_ai_done"), [])
        # Writing the summary again sends nothing new.
        r = await self.http.post(f"/api/v1/meetings/{m['id']}/regenerate", headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        await slack.drain()
        await self.send()
        self.assertEqual(len(self.dms()), 2)

    async def test_people_outside_markdrop_get_their_items_and_nothing_else(self):
        self.sk.directory["zara@ext.test"] = ext("U0ZARA", "Zara Khan", "zara@ext.test")
        self.in_slack("wm", "U0BO")
        await self.notes_meeting()
        await self.send()
        z = self.dms("U0ZARA")
        self.assertEqual(len(z), 1)
        text = json.dumps(z[0])
        self.assertIn("Send the pricing sheet to finance by Friday.", text)
        self.assertIn("_due Fri, ", text)                 # "by Friday" read as a date
        self.assertIn("Book the demo room.", text)
        self.assertNotIn("onboarding", text)
        self.assertNotIn("release notes", text)
        self.assertNotIn("SECRET-SUMMARY-TEXT", text)
        self.assertNotIn("markdrop.in", text)          # no link anywhere
        self.assertNotIn("Open the notes", text)
        self.assertIn("Notes are in Markdrop (ask Ada Lovelace for access)", text)
        self.assertEqual(self.buttons(z[0], "md_ai_done"), [])
        self.assertEqual(len(self.buttons(z[0], "md_ai_stop")), 1)
        # Bo (a member found by his email) gets his, with Done.
        b = self.dms("U0BO")
        self.assertEqual(len(b), 1)
        self.assertIn("Update the onboarding docs.", json.dumps(b[0]))
        self.assertEqual(len(self.buttons(b[0], "md_ai_done")), 1)
        # The address Google gave is kept on the row but never shown.
        row = await self.db[meetings.COLL].find_one({})
        self.assertIn("zara@ext.test", [a.get("email") for a in row["attendees"] + row["invited"]])
        r = await self.http.get(f"/api/v1/meetings/{row['_id']}", headers=self.session("owner"))
        self.assertNotIn("zara@ext.test", r.text)

    async def test_without_meetings_ai_googles_notes_still_send(self):
        from tests.test_meetings import settings as msettings

        msettings.meetings_ai_enabled = False
        self.sk.directory["zara@ext.test"] = ext("U0ZARA", "Zara Khan", "zara@ext.test")
        await self.notes_meeting()
        await self.send()
        self.assertEqual(len(self.dms("U0ZARA")), 1)

    async def test_by_name_only_when_unambiguous_and_never_for_restricted(self):
        steps = ["Sam Lee will review the deck."]
        invited = "Ada Lovelace <owner@example.com>, Bo Chen <wm@example.com>, Sam Lee"
        self.sk.members = [ext("U0SAM", "Sam Lee")]
        await self.notes_meeting(steps=steps, invited=invited, title="Planning one")
        await self.send()
        self.assertEqual(len(self.dms("U0SAM")), 1)
        self.assertNotIn("Open the notes", json.dumps(self.dms("U0SAM")[0]))   # a name is no proof: text only
        # Two people with that name: nobody.
        sai._NAMES.clear()
        self.sk.members = [ext("U0SAM", "Sam Lee"), ext("U0SAM2", "Sam Lee")]
        await self.notes_meeting(steps=steps, invited=invited, title="Planning two")
        await self.send()
        self.assertEqual(len(self.dms("U0SAM")) + len(self.dms("U0SAM2")), 1)
        last = (await self.db[slack.INSTALLS].find_one({"_id": TEAM}))["action_items_last"]
        self.assertEqual((last["queued"], last["missing"]), (0, 1))
        # Restricted to its attendees: never by name.
        sai._NAMES.clear()
        self.sk.members = [ext("U0SAM", "Sam Lee")]
        await self.notes_meeting(steps=steps, invited=invited, title="Planning three", restricted=True)
        await self.send()
        self.assertEqual(len(self.dms("U0SAM")), 1)

    async def test_restricted_meeting_reaches_only_its_attendees(self):
        self.in_slack("wm", "U0BO")
        self.in_slack("wa", "U0PRIYA")                 # an admin who wasn't in the call
        self.sk.directory["zed@else.test"] = ext("U0ZED", "Zed Nobody", "zed@else.test")
        m = await self.imported(restricted=True)
        await self.send()
        self.assertEqual(len(self.dms("U0BO")), 1)
        self.assertEqual(self.dms("U0ZED"), [])
        self.assertEqual(self.dms("U0PRIYA"), [])      # no items of hers
        self.assertEqual([d for d in self.sk.of("chat.postMessage") if d["channel"] == "C2"], [])
        self.assertIn(m["slug"], json.dumps(self.dms("U0BO")[0]))   # Bo is granted as an attendee

    async def test_history_and_old_meetings_are_skipped(self):
        self.in_slack("wm", "U0BO")
        await self.imported(date=(meetings.now_utc() - timedelta(days=3)).date().isoformat())
        from app.services import meeting_backfill as bf
        from tests.test_meetings import fixture

        owner = await bf._owner(self.db, {"user_id": self.uid["owner"], "workspace_id": self.W})
        inc = [meetings.Incoming(name="Weekly product sync - Transcript", text=fixture("google_meet_transcript.txt"),
                                 origin="upload")]
        await meetings.import_meetings(self.db, owner, self.W, inc, wait=True, via="backfill", notify=False,
                                       date_=today())
        await slack.drain()
        await self.send()
        self.assertEqual(self.dms(), [])

    async def test_ticked_before_sending_is_dropped(self):
        self.in_slack("wm", "U0BO")
        self.sk.directory["zara@ext.test"] = ext("U0ZARA", "Zara Khan", "zara@ext.test")
        m = await self.notes_meeting()
        page = await self.doc(m["slug"])
        c = page["content"].replace("- [ ] Zara Khan will book", "- [x] Zara Khan will book")
        c = c.replace("- [ ] :person[Bo Chen]", "- [x] :person[Bo Chen]")
        await self.db["documents"].update_one({"_id": page["_id"]}, {"$set": {"content": c}})
        await self.send()
        self.assertEqual(self.dms("U0BO"), [])         # nothing left for him
        z = json.dumps(self.dms("U0ZARA")[0])
        self.assertIn("pricing sheet", z)
        self.assertNotIn("demo room", z)

    async def test_admin_switch(self):
        self.in_slack("wm", "U0BO")
        r = await self.http.patch("/api/v1/slack/settings", json={"workspace_id": self.W, "action_item_dms": False},
                                  headers=self.session("wm"))
        self.assertEqual(r.status_code, 403)
        r = await self.http.patch("/api/v1/slack/settings", json={"workspace_id": self.W, "action_item_dms": False},
                                  headers=self.session("wa"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(r.json()["install"]["action_item_dms"])
        await self.imported()
        await self.send()
        self.assertEqual(self.dms(), [])
        # Turned off after queueing: nothing goes either.
        await self.db[slack.INSTALLS].update_one({"_id": TEAM}, {"$unset": {"action_item_dms": ""}})
        st = (await self.http.get(f"/api/v1/slack/status?workspace_id={self.W}", headers=self.session("wa"))).json()
        self.assertTrue(st["install"]["action_item_dms"])       # on by default
        await self.notes_meeting()
        await self.db[slack.INSTALLS].update_one({"_id": TEAM}, {"$set": {"action_item_dms": False}})
        await self.send()
        self.assertEqual(self.dms(), [])

    async def test_without_the_email_permission(self):
        """The install predates users:read.email: linked members still get theirs; the card says why
        the others don't."""
        self.sk.fail["users.lookupByEmail"] = "missing_scope"
        await self.link("wm", "U0BO")
        self.in_slack("wv", "U0RAVI")
        await self.imported()
        await self.send()
        self.assertEqual(len(self.dms("U0BO")), 1)
        self.assertEqual(self.dms("U0RAVI"), [])
        st = (await self.http.get(f"/api/v1/slack/status?workspace_id={self.W}", headers=self.session("wa"))).json()
        self.assertFalse(st["install"]["can_find_by_email"])
        last = st["install"]["action_items_last"]
        self.assertTrue(last["needs_update"])
        self.assertEqual((last["queued"], last["missing"]), (1, 1))
        # Not for members who aren't admins.
        st = (await self.http.get(f"/api/v1/slack/status?workspace_id={self.W}", headers=self.session("wm"))).json()
        self.assertIsNone(st["install"]["action_items_last"])
        self.assertIsNotNone(await slack.get_install(self.db, TEAM))   # a missing scope isn't a dead install


class Bundling(ActionItemsWorld):
    async def test_meetings_ready_together_share_one_message_later_ones_get_their_own(self):
        self.sk.directory["zara@ext.test"] = ext("U0ZARA", "Zara Khan", "zara@ext.test")
        await self.notes_meeting(title="Daily Syncup")
        await self.notes_meeting(title="Design review", steps=["Zara Khan will share the mockups."])
        await self.send()
        z = self.dms("U0ZARA")
        self.assertEqual(len(z), 1)
        text = json.dumps(z[0])
        self.assertIn("Your action items from 2 meetings", text)
        self.assertIn("pricing sheet", text)
        self.assertIn("mockups", text)
        # Another one after that message went: a message of its own (an edit wouldn't be noticed).
        await self.notes_meeting(title="Customer call", steps=["Zara Khan will call Acme back."])
        await self.send()
        z = self.dms("U0ZARA")
        self.assertEqual(len(z), 2)
        self.assertIn("Call Acme back.", json.dumps(z[1]))
        self.assertNotIn("pricing sheet", json.dumps(z[1]))
        self.assertEqual([u for u in self.sk.of("chat.update") if u["channel"] == "U0ZARA"], [])


class Buttons(ActionItemsWorld):
    async def test_done_ticks_the_page_only_for_editors(self):
        await self.db[slack.INSTALLS].update_one({"_id": TEAM}, {"$set": {"meetings_channel": {"id": "C2", "name": "m"}}})
        self.in_slack("wm", "U0BO")
        self.in_slack("wv", "U0RAVI")
        m = await self.imported()
        await self.send()
        done = self.buttons(self.dms("U0BO")[0], "md_ai_done")[0]
        block = done["value"].split("|")[2]
        # Someone else can't use Bo's button.
        await self.click("md_ai_done", done["value"], "U0RAVI")
        await slack.drain()
        self.assertIn("Only the person", json.dumps(self.sk.responds[-1]))
        self.assertNotIn("- [x]", (await self.doc(m["slug"]))["content"])
        # Ravi (a viewer) has no button; a value made for his message with Bo's block doesn't tick it.
        ravi_row = await self.db[slack_notify.OUTBOX].find_one({"kind": "action_items", "slack_user_id": "U0RAVI"})
        forged = slack.sign_value(TEAM, "aid", str(ravi_row["_id"]), block)
        await self.click("md_ai_done", forged, "U0RAVI")
        await slack.drain()
        self.assertNotIn("- [x]", (await self.doc(m["slug"]))["content"])
        ravi_block = ravi_row["meetings"][0]["blocks"][0]
        await self.click("md_ai_done", slack.sign_value(TEAM, "aid", str(ravi_row["_id"]), ravi_block), "U0RAVI")
        await slack.drain()
        self.assertIn("can't edit", json.dumps(self.sk.responds[-1]))
        self.assertNotIn("- [x]", (await self.doc(m["slug"]))["content"])
        # Bo can, without having linked his Slack account.
        await self.click("md_ai_done", done["value"], "U0BO")
        await slack.drain()
        page = await self.doc(m["slug"])
        self.assertRegex(page["content"], rf"- \[x\] .*\{{#{block}\}}")
        self.assertEqual(page["content"].count("- [x]"), 1)
        mine = [u for u in self.sk.of("chat.update") if u["channel"] == "C2" and u["ts"] == "9.0001"]
        self.assertTrue(mine and ":white_check_mark:" in json.dumps(mine[-1]))
        # The channel post shows it too.
        post = await self.db[slack_notify.POSTS].find_one({"meeting_id": m["id"]})
        self.assertEqual(next(i for i in post["items"] if i["block"] == block)["done_by"], "Bo Chen")
        self.assertIsNone(await slack.linked_user(self.db, TEAM, "U0BO"))

    async def test_stop_these_by_slack_user(self):
        self.sk.directory["zara@ext.test"] = ext("U0ZARA", "Zara Khan", "zara@ext.test")
        await self.notes_meeting()
        await self.send()
        stop = self.buttons(self.dms("U0ZARA")[0], "md_ai_stop")[0]
        await self.click("md_ai_stop", stop["value"], "U0OTHER")
        await slack.drain()
        self.assertFalse(await sai.stopped(self.db, TEAM, "U0ZARA"))
        await self.click("md_ai_stop", stop["value"], "U0ZARA")
        await slack.drain()
        self.assertTrue(await sai.stopped(self.db, TEAM, "U0ZARA"))
        start = self.buttons(self.sk.responds[-1], "md_ai_start")[0]
        await self.notes_meeting(title="Design review", steps=["Zara Khan will share the mockups."])
        await self.send()
        self.assertEqual(len(self.dms("U0ZARA")), 1)
        # Turn back on.
        await self.click("md_ai_start", start["value"], "U0ZARA")
        await slack.drain()
        self.assertFalse(await sai.stopped(self.db, TEAM, "U0ZARA"))
        await self.notes_meeting(title="Customer call", steps=["Zara Khan will call Acme back."])
        await self.send()
        self.assertEqual(len(self.dms("U0ZARA")), 2)

    async def test_members_switch_in_settings(self):
        self.in_slack("wm", "U0BO")
        r = await self.http.get("/api/v1/slack/me", headers=self.session("wm"))
        self.assertTrue(r.json()["action_items"])      # on by default, though Slack notifications are off
        self.assertFalse(r.json()["on"])
        await self.imported()
        await self.send()
        stop = self.buttons(self.dms("U0BO")[0], "md_ai_stop")[0]
        await self.click("md_ai_stop", stop["value"], "U0BO")
        await slack.drain()
        r = await self.http.get("/api/v1/slack/me", headers=self.session("wm"))
        self.assertFalse(r.json()["action_items"])     # Stop these turns the switch off too
        r = await self.http.patch("/api/v1/slack/me/prefs", json={"action_items": True}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["action_items"])
        self.assertFalse(await sai.stopped(self.db, TEAM, "U0BO"))
        # Off in Settings: no message.
        await self.http.patch("/api/v1/slack/me/prefs", json={"action_items": False}, headers=self.session("wm"))
        await self.notes_meeting()
        await self.send()
        self.assertEqual(len(self.dms("U0BO")), 1)


class Preview(ActionItemsWorld):
    async def test_admins_see_who_would_get_one(self):
        await self.link("wm", "U0BO")
        await self.notes_meeting()
        r = await self.http.get(f"/api/v1/slack/action-items/preview?workspace_id={self.W}", headers=self.session("wm"))
        self.assertEqual(r.status_code, 403)
        r = await self.http.get(f"/api/v1/slack/action-items/preview?workspace_id={self.W}", headers=self.session("wa"))
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        self.assertTrue(out["on"])
        self.assertEqual(out["meeting"]["title"], "Daily Syncup")
        people = {p["name"]: p for p in out["people"]}
        self.assertEqual(people["Zara Khan"]["items"], 2)
        self.assertFalse(people["Zara Khan"]["member"])
        self.assertEqual(people["Bo Chen"]["reach"], "linked")
        self.assertEqual(out["message"]["to"], "Zara Khan")
        self.assertIsNone(out["message"]["open_link"])
        self.assertEqual(out["message"]["organizer"], "Ada Lovelace")
        self.assertEqual([i["text"] for i in out["message"]["items"]],
                         ["Send the pricing sheet to finance by Friday.", "Book the demo room."])
        self.assertEqual(self.dms(), [])               # nothing sent by a preview


class Mcp(ActionItemsWorld):
    async def test_slack_status_shows_the_setting(self):
        code, res = await self.mcp_call(await self.mcp_token("wa"), "slack_status", {"workspace": self.W})
        self.assertEqual(code, 200)
        out = res["structuredContent"]
        self.assertTrue(out["action_item_dms"])
        self.assertTrue(out["me"]["action_items"])
        self.assertIn("own action items", res["content"][0]["text"])
        await self.db[slack.INSTALLS].update_one({"_id": TEAM}, {"$set": {"action_item_dms": False}})
        code, res = await self.mcp_call(await self.mcp_token("wm"), "slack_status", {"workspace": self.W})
        self.assertFalse(res["structuredContent"]["action_item_dms"])


if __name__ == "__main__":
    unittest.main()
