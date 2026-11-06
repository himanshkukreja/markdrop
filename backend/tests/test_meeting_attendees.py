"""Who was there (owner, 2026-11-06): a Daily Syncup auto-imported from Gemini notes showed "27 people"
(everyone on the calendar invite) and a paragraph for Attendees. Attendees are now who joined (a Meet
transcript's "Attendees" line and the speakers; else the speakers), the invite is kept apart as
``invited``, a label's value is taken only when it is a list of names, the page lists the attendees
(members as quiet @mentions), and meetings.attendees_tick repairs meetings imported before.

Fixtures (tests/fixtures/meetings/syncup_*): 27 invited (chips "Name <email>" one after another, as the
Docs API reader writes them), 12 joined (the transcript Doc's Attendees line), 8 speakers.
"""

from __future__ import annotations

import unittest

from tests._access_env import AccessWorld, now  # noqa: F401  (pins settings first)
from tests.test_meetings import MeetingsWorld, fixture

from bson import ObjectId

from app.services import meetings, page_db
from app.services import meeting_parse as mp

JOINED = ["Ada Lovelace", "Bo Chen", "Priya Sharma", "Rahul bhai", "Saurabh Kr. Singh", "Mohd. Arif",
          "Neha Verma", "Ankit Jha", "Divya S", "Karan Mehta", "Ishaan Gupta", "Shreya Iyer"]
SPEAKERS = ["Ada Lovelace", "Bo Chen", "Priya Sharma", "Rahul bhai", "Saurabh Kr. Singh", "Neha Verma",
            "Ishaan Gupta", "Karan Mehta"]
NOTES = ("Daily Syncup - 2026/11/06 10:00 GMT+05:30 - Notes by Gemini", "syncup_gemini_notes.txt")
BOTH = ("Daily Syncup - 2026/11/06 10:00 GMT+05:30 - Notes by Gemini", "syncup_gemini_with_transcript.txt")
TRANSCRIPT = ("Daily Syncup (2026-11-06 10:00 GMT+05:30) - Transcript", "syncup_meet_transcript.txt")


def src(which) -> mp.Source:
    return mp.parse_source(which[0], fixture(which[1]))


def body(which) -> dict:
    return {"name": which[0], "text": fixture(which[1])}


class Parser(unittest.TestCase):
    def test_a_notes_and_transcript_attendees_are_who_joined_and_the_invite_is_apart(self):
        groups = mp.pair([src(NOTES), src(TRANSCRIPT)])
        self.assertEqual(len(groups), 1)
        m = mp.merge(groups[0])
        self.assertEqual([a["name"] for a in m.attendees], JOINED)
        self.assertEqual(m.attendees_from, "attendees")
        self.assertEqual(len(m.invited), 27)
        self.assertNotIn("Ravi Kumar", [a["name"] for a in m.attendees])     # invited, never joined
        self.assertEqual(mp.summary_of([src(NOTES), src(TRANSCRIPT)])[0]["invited"][:2], ["Ada Lovelace", "Bo Chen"])

    def test_a_gemini_notes_with_a_transcript_tab_speakers_with_the_invites_addresses(self):
        s = src(BOTH)
        self.assertEqual(s.kind, "both")
        self.assertEqual([a["name"] for a in s.attendees], SPEAKERS)
        self.assertEqual(s.attendees_from, "speakers")
        self.assertEqual(len(s.invited), 27)
        self.assertEqual({a["name"]: a["email"] for a in s.attendees}["Bo Chen"], "bo@acme.test")

    def test_b_notes_only_have_no_attendees_only_the_invite(self):
        s = src(NOTES)
        self.assertEqual((s.attendees, s.attendees_from, len(s.invited)), ([], "none", 27))
        m = mp.merge([s])
        self.assertEqual((m.attendees, m.attendees_from, len(m.invited)), ([], "invited", 27))

    def test_c_chips_glued_without_separators(self):
        with_mail = "Invited Ada Lovelace <ada@x.test>Bo Chen <bo@x.test> Rahul bhai <rahul@x.test>"
        self.assertEqual([p["name"] for p in mp.people_lists([with_mail])[1]], ["Ada Lovelace", "Bo Chen", "Rahul bhai"])
        links = "Attendees [Ada Lovelace](mailto:ada@x.test)[Bo Chen](mailto:bo@x.test) [Divya S](mailto:d@x.test)"
        self.assertEqual([p["name"] for p in mp.people_lists([links])[0]], ["Ada Lovelace", "Bo Chen", "Divya S"])
        # Names only (chips exported without addresses): split at names the transcript knows.
        bare = "Attendees Ada Lovelace Saurabh Kr. Singh Bo Chen Neha Verma"
        got = mp.people_lists([bare], ["Ada Lovelace", "Bo Chen", "Neha Verma"])[0]
        self.assertEqual([p["name"] for p in got], ["Ada Lovelace", "Saurabh Kr. Singh", "Bo Chen", "Neha Verma"])
        # Nothing to split by: not one 8-word "person", nothing.
        self.assertEqual(mp.people_lists([bare], []), ([], []))

    def test_d_a_paragraph_after_the_label_is_never_names(self):
        for lines in (["Attendees", "", "Participants discussed the sprint status, agreed to move the demo to Friday."],
                      ["Attendees:", "## Summary", "Ada Lovelace, Bo Chen and Priya Sharma agreed to ship."],
                      ["Participants discussed the sprint status, agreed to move the demo, and Bo Chen will test."],
                      ["Present the plan to finance, Ritu and Amit"],
                      ["Presentation of results, Q3"],
                      ["Invited", "Attachments Daily Syncup"]):
            self.assertEqual(mp.people_lists(lines), ([], []), lines)
        # The Summary paragraph of the notes is not read as people either.
        s = src(NOTES)
        self.assertFalse(any("discussed" in a["name"] for a in s.invited + s.attendees))
        # A label alone with the names under it (one line, or a bulleted list) is read.
        self.assertEqual([p["name"] for p in mp.people_lists(["Attendees", "Ada Lovelace, Bo Chen"])[0]], ["Ada Lovelace", "Bo Chen"])
        self.assertEqual([p["name"] for p in mp.people_lists(["**Attendees:**", "- Ada Lovelace", "- anand.k", "Transcript"])[0]],
                         ["Ada Lovelace", "anand.k"])

    def test_e_hinglish_and_other_names_read_as_names(self):
        for n in ("Rahul bhai", "Saurabh Kr. Singh", "Mohd. Arif", "Divya S", "Neha ji", "anand.k", "Anne-Marie O'Brien",
                  "राहुल शर्मा", "Priya (Senseloaf)"):
            self.assertTrue(mp.name_like(n), n)
        for n in ("discussed the plan", "agreed to move the demo to Friday", "Summary", "the team", "Bo Chen will test.",
                  "https://meet.google.com/abc", "Q3 2026 results 12"):
            self.assertFalse(mp.name_like(n), n)
        s = src(TRANSCRIPT)
        self.assertEqual([a["name"] for a in s.attendees], JOINED)


class Import(MeetingsWorld):
    async def test_a_g_attendees_listed_with_mentions_for_members_only(self):
        r = await self.do_import(sources=[body(NOTES), body(TRANSCRIPT)])
        self.assertEqual(r.status_code, 200, r.text)
        m = r.json()["meetings"][0]
        self.assertEqual([a["name"] for a in m["attendees"]], JOINED)
        self.assertEqual(len(m["invited"]), 27)
        self.assertEqual(m["attendees_from"], "attendees")
        ids = {a["name"]: a["user_id"] for a in m["attendees"]}
        self.assertEqual(ids["Bo Chen"], self.uid["wm"])
        self.assertIsNone(ids["Rahul bhai"])
        self.assertFalse(m["restricted"])            # 27 invited, 12 joined: the team's
        c = (await self.doc(m["slug"]))["content"]
        sect = c.split("## Attendees\n\n", 1)[1].split("\n\n", 1)[0]
        self.assertIn(f':person[Bo Chen]{{id="{self.uid["wm"]}"}}', sect)
        self.assertIn(f':person[Ada Lovelace]{{id="{self.uid["owner"]}"}}', sect)
        self.assertIn("Rahul bhai", sect)
        self.assertNotIn(":person[Rahul", sect)          # not a member: a name
        self.assertNotIn("Ravi Kumar", sect)              # invited (a member), didn't join
        self.assertEqual(page_db.read_values(c)["attendees"], ", ".join(JOINED))
        self.assertEqual(await self.db["notifications"].count_documents({}), 0)   # meeting writes are quiet
        # The list's cards and Home count attendees.
        r = await self.http.get(f"/api/v1/meetings?workspace={self.W}", headers=self.session("owner"))
        card = r.json()["meetings"][0]                     # the light card: the first five + the count
        self.assertEqual(card["attendee_count"], 12)
        self.assertLessEqual(len(card["attendees"]), 5)

    async def test_b_notes_only_say_invited_never_attendees(self):
        m = await self.imported(sources=[body(NOTES)])
        self.assertEqual((m["attendees"], len(m["invited"]), m["attendees_from"]), ([], 27, "invited"))
        self.assertFalse(m["restricted"])
        c = (await self.doc(m["slug"]))["content"]
        self.assertIn("## Invited\n\n", c)
        self.assertNotIn("## Attendees", c)
        self.assertNotIn("attendees", page_db.read_values(c))

    async def test_attaching_the_transcript_later_uses_the_same_rules(self):
        from app.services import user as user_service

        user = await user_service.get_user_by_id(self.db, self.uid["owner"])

        async def send(which):
            return await meetings.import_meetings(self.db, user, self.W, [meetings.Incoming(
                name=which[0], text=fixture(which[1]), origin="upload")], dedupe="all", wait=True)

        first = (await send(NOTES))[0]
        second = (await send(TRANSCRIPT))[0]
        self.assertEqual((second["_status"], second["_id"]), ("attached", first["_id"]))
        row = await self.db["meetings"].find_one({"_id": first["_id"]})
        self.assertEqual([a["name"] for a in row["attendees"]], JOINED)
        self.assertEqual((len(row["invited"]), row["attendees_from"]), (27, "attendees"))
        page = await self.db["documents"].find_one({"_id": row["doc_id"]})
        self.assertIn("## Attendees\n\n", page["content"])
        self.assertNotIn("## Invited", page["content"])


class Repair(MeetingsWorld):
    async def old_row(self, which, *, restricted=False) -> tuple[dict, ObjectId]:
        """A meeting as imported before attendees_v 2: every invitee and speaker in ``attendees``."""
        m = await self.imported(sources=[body(which)])
        oid = ObjectId(m["id"])
        row = await self.db["meetings"].find_one({"_id": oid})
        s = src(which)
        old = mp.dedupe_people([*s.invited, *s.attendees])
        people = await meetings.people_of(self.db, row["workspace_id"])
        dirty = [{"name": a["name"], "user_id": (people.match(a["name"], a["email"]) or {}).get("id")} for a in old]
        page = await self.doc(m["slug"])
        content = page_db.write_values(page["content"], {"attendees": ", ".join(a["name"] for a in dirty)[:page_db.TEXT_MAX]})
        content = content.replace("## Attendees", "## Old attendees").replace("## Invited", "## Old invited")
        await self.db["documents"].update_one({"_id": page["_id"]}, {"$set": {"content": content}})
        await self.db["meetings"].update_one({"_id": oid}, {
            "$set": {"attendees": dirty, "restricted": restricted, "granted": ["kept@x.test"] if restricted else []},
            "$unset": {"attendees_v": "", "invited": "", "attendees_from": ""}})
        meetings._ATTENDEES["done"] = False
        return m, oid

    async def test_f_gemini_meetings_repaired_once_restriction_unchanged(self):
        m, oid = await self.old_row(BOTH, restricted=True)
        self.assertEqual(len((await self.db["meetings"].find_one({"_id": oid}))["attendees"]), 27)
        dry = await meetings.attendees_dry_run(self.db)
        self.assertEqual((dry["would_change"], dry["from"], dry["people_before"], dry["people_after"]),
                         (1, {"speakers": 1}, 27, 8))
        self.assertGreaterEqual(await meetings.attendees_tick(self.db), 1)
        row = await self.db["meetings"].find_one({"_id": oid})
        self.assertEqual([a["name"] for a in row["attendees"]], SPEAKERS)
        self.assertEqual(len(row["invited"]), 27)
        self.assertEqual((row["attendees_from"], row["attendees_v"], row["attendees_repair"]["before"]), ("speakers", 2, 27))
        self.assertEqual((row["restricted"], row["granted"]), (True, ["kept@x.test"]))
        page = await self.doc(m["slug"])
        self.assertEqual(page_db.read_values(page["content"])["attendees"], ", ".join(SPEAKERS))
        self.assertIn("## Attendees\n\n", page["content"])     # untouched page: written again
        self.assertIn("Summary · From Google Meet notes", page["content"])   # from the whole row
        # Idempotent: nothing left, the page isn't written again.
        rev = page.get("rev")
        meetings._ATTENDEES["done"] = False
        self.assertEqual(await meetings.attendees_tick(self.db), 0)
        self.assertEqual((await self.doc(m["slug"])).get("rev"), rev)
        people = await meetings.people_of(self.db, row["workspace_id"])
        self.assertFalse((await meetings.repair_attendees(self.db, row, people, apply=False))["changed"])

    async def test_f_notes_only_become_invited_and_an_edited_value_stays(self):
        m, oid = await self.old_row(NOTES)
        page = await self.doc(m["slug"])
        await self.db["documents"].update_one({"_id": page["_id"]}, {"$set": {
            "content": page_db.write_values(page["content"], {"attendees": "Typed by hand"}), "rev": int(page.get("rev") or 1) + 1}})
        await meetings.attendees_tick(self.db)
        row = await self.db["meetings"].find_one({"_id": oid})
        self.assertEqual((row["attendees"], len(row["invited"]), row["attendees_from"]), ([], 27, "invited"))
        page = await self.doc(m["slug"])
        self.assertEqual(page_db.read_values(page["content"])["attendees"], "Typed by hand")
        self.assertNotIn("## Invited\n\n", page["content"])    # edited page: its body is left alone

    async def test_f_a_transcript_meeting_keeps_its_list_and_the_property_follows_when_unedited(self):
        m, oid = await self.old_row(TRANSCRIPT)
        page = await self.doc(m["slug"])
        await self.db["documents"].update_one({"_id": page["_id"]}, {"$set": {"rev": int(page.get("rev") or 1) + 1}})
        before = await self.db["meetings"].find_one({"_id": oid})
        await self.db["meetings"].update_one({"_id": oid}, {"$push": {"attendees": {"name": "discussed the sprint status", "user_id": None}}})
        await meetings.attendees_tick(self.db)
        row = await self.db["meetings"].find_one({"_id": oid})
        self.assertEqual([a["name"] for a in row["attendees"]], [a["name"] for a in before["attendees"]])
        self.assertEqual(row["attendees_from"], "attendees")
        page = await self.doc(m["slug"])
        # The property still read what Markdrop wrote (not the garbage name): written again, nothing else.
        self.assertEqual(page_db.read_values(page["content"])["attendees"], ", ".join(JOINED))


if __name__ == "__main__":
    unittest.main()


class GeminiTitleLines(unittest.TestCase):
    """Gemini's notes open with "📝 Notes" and a date line above the meeting's name: neither is its title."""

    def test_section_labels_and_dates_are_not_titles(self):
        from app.services import meeting_parse as mp
        self.assertEqual(mp._first_title(["📝 Notes", "Nov 6, 2026", "Daily Syncup", "Invited Ada Bo"]), "Daily Syncup")
        self.assertEqual(mp._first_title(["# 📖 Transcript", "2026/11/06", "Daily Syncup - Transcript"]),
                         "Daily Syncup - Transcript")
        self.assertEqual(mp._first_title(["Thursday, Nov 6, 2026", "Weekly product sync"]), "Weekly product sync")
        self.assertEqual(mp._first_title(["Weekly product sync", "Ada: hi"]), "Weekly product sync")
