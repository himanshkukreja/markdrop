"""Attendee names (2026-11-06): people chips that came through as markdown links or bracketed text
("[Ishaan Gupta](mailto:ishaan@…)") showed "[I" in the meeting bar. The parser cleans every name
and keeps the address for matching members; meetings.names_tick cleans meetings imported before.
"""

from __future__ import annotations

import unittest

from tests._access_env import AccessWorld, now  # noqa: F401  (pins settings first)
from tests.test_meetings import MeetingsWorld, fixture

from bson import ObjectId

from app.services import meetings, page_db
from app.services import meeting_parse as mp


class Names(unittest.TestCase):
    def test_markdown_links_brackets_quotes_and_addresses(self):
        cases = {
            "[Ishaan Gupta](mailto:ishaan@acme.in)": ("Ishaan Gupta", "ishaan@acme.in"),
            "[Ishaan Gupta](mailto:)": ("Ishaan Gupta", None),
            "Gautam Rao <Gautam@Acme.in>": ("Gautam Rao", "gautam@acme.in"),
            "Neha Singh (neha@acme.in)": ("Neha Singh", "neha@acme.in"),
            "\\[Priya Nair\\]": ("Priya Nair", None),
            "[Saurabh Kumar]": ("Saurabh Kumar", None),
            "**Bo Chen**,": ("Bo Chen", None),
            '"Ravi Kumar"': ("Ravi Kumar", None),
            "“Chetan Sharma”": ("Chetan Sharma", None),
            "ishaan.g@acme.in": ("ishaan.g", "ishaan.g@acme.in"),
            "  Rahul   bhai  ": ("Rahul bhai", None),
            "Anne-Marie O'Brien": ("Anne-Marie O'Brien", None),
            "Ãrav Mehtā": ("Ãrav Mehtā", None),
        }
        for raw, want in cases.items():
            p = mp.person_of(raw)
            self.assertEqual((p["name"], p["email"]), want, raw)
        for junk in ("", "  ", "[]", "()", "🙂", "**", "[](mailto:)", "-"):
            self.assertIsNone(mp.person_of(junk), junk)

    def test_a_line_of_chips_with_or_without_separators(self):
        line = ("[Ishaan Gupta](mailto:ishaan@acme.in) [Ishita Rao](mailto:ishita@acme.in) "
                "[Gautam Rao](mailto:gautam@acme.in)")
        self.assertEqual([(p["name"], p["email"]) for p in mp.people_in(line)],
                         [("Ishaan Gupta", "ishaan@acme.in"), ("Ishita Rao", "ishita@acme.in"),
                          ("Gautam Rao", "gautam@acme.in")])
        line = "Ishaan Gupta <ishaan@acme.in> Chetan Sharma <chetan@acme.in>, Shreya Iyer and [Rohit bhai]"
        self.assertEqual([p["name"] for p in mp.people_in(line)], ["Ishaan Gupta", "Chetan Sharma", "Shreya Iyer", "Rohit bhai"])
        # Once each: the same address, or the same name.
        line = "Ishaan Gupta <ishaan@acme.in>; [Ishaan Gupta](mailto:ISHAAN@acme.in), ishaan gupta"
        self.assertEqual(mp.people_in(line), [{"name": "Ishaan Gupta", "email": "ishaan@acme.in"}])

    def test_gemini_notes_exported_as_markdown(self):
        text = fixture("gemini_notes.txt").replace(
            "Invited Ada Lovelace <ada@acme.test>, Bo Chen <bo@acme.test>, Priya Sharma <priya@acme.test>, Ravi Kumar <ravi@acme.test>",
            "Invited [Ada Lovelace](mailto:ada@acme.test) [Bo Chen](mailto:bo@acme.test) "
            "\\[Priya Sharma\\] [Ravi Kumar](mailto:ravi@acme.test)")
        src = mp.parse_source("Weekly product sync - Notes by Gemini", text)
        self.assertEqual([(a["name"], a["email"]) for a in src.invited],
                         [("Ada Lovelace", "ada@acme.test"), ("Bo Chen", "bo@acme.test"),
                          ("Priya Sharma", None), ("Ravi Kumar", "ravi@acme.test")])

    def test_organizer_and_speakers(self):
        self.assertEqual(mp.organizer_in("Organizer: [Gautam Rao](mailto:gautam@acme.in)\nHi."),
                         {"name": "Gautam Rao", "email": "gautam@acme.in"})
        self.assertEqual(mp.clean_speaker("[Ishaan Gupta]"), "Ishaan Gupta")
        self.assertEqual(mp.clean_speaker("Ishaan Gupta"), "Ishaan Gupta")


class Repair(MeetingsWorld):
    async def test_import_matches_members_by_the_address_in_a_link(self):
        text = fixture("gemini_notes.txt").replace(
            "Invited Ada Lovelace <ada@acme.test>, Bo Chen <bo@acme.test>, Priya Sharma <priya@acme.test>, Ravi Kumar <ravi@acme.test>",
            f"Invited [Gautam Rao](mailto:{self.email['wm']}), [Ada Lovelace](mailto:{self.email['owner']}), [Zed Q](mailto:zed@x.test)")
        m = await self.imported(sources=[{"name": "Weekly product sync - Notes by Gemini", "text": text}])
        got = {a["name"]: a["user_id"] for a in m["invited"]}
        self.assertEqual(got.get("Gautam Rao"), self.uid["wm"])     # matched by the address, not the name
        self.assertEqual(got.get("Ada Lovelace"), self.uid["owner"])
        self.assertIsNone(got.get("Zed Q"))
        self.assertFalse(any("[" in a["name"] or "(" in a["name"] for a in m["attendees"]))

    async def test_old_meetings_are_cleaned_once_and_the_restriction_stays(self):
        m = await self.imported()
        oid = ObjectId(m["id"])
        dirty = [{"name": f"[Gautam Rao](mailto:{self.email['wm']})", "user_id": None},
                 {"name": "\\[Ishaan Gupta\\]", "user_id": None},
                 {"name": "[Ishaan Gupta](mailto:)", "user_id": None},
                 {"name": "[]", "user_id": None},
                 {"name": "Ada Lovelace", "user_id": self.uid["owner"]}]
        old = ", ".join(a["name"] for a in dirty)
        page = await self.doc(m["slug"])
        await self.db["documents"].update_one({"_id": page["_id"]}, {"$set": {
            "content": page_db.write_values(page["content"], {"attendees": old})}})
        await self.db["meetings"].update_one({"_id": oid}, {
            "$set": {"attendees": dirty, "restricted": False, "organizer": {"name": "[Bo Chen](mailto:x@y.test)", "user_id": None}},
            "$unset": {"names_v": ""}})
        meetings._NAMES["done"] = False
        self.assertEqual((await meetings.count_dirty_names(self.db))["would_change"], 1)
        self.assertGreaterEqual(await meetings.names_tick(self.db), 1)
        row = await self.db["meetings"].find_one({"_id": oid})
        self.assertEqual([(a["name"], a["user_id"]) for a in row["attendees"]],
                         [("Gautam Rao", self.uid["wm"]), ("Ishaan Gupta", None), ("Ada Lovelace", self.uid["owner"])])
        self.assertEqual(row["organizer"]["name"], "Bo Chen")
        self.assertFalse(row["restricted"])
        self.assertEqual(row["names_v"], meetings.NAMES_V)
        page = await self.doc(m["slug"])
        self.assertEqual(page_db.read_values(page["content"])["attendees"], "Gautam Rao, Ishaan Gupta, Ada Lovelace")
        # Idempotent: nothing left, and a second pass changes nothing.
        rev = page.get("rev")
        meetings._NAMES["done"] = False
        self.assertEqual(await meetings.names_tick(self.db), 0)
        self.assertEqual((await self.doc(m["slug"])).get("rev"), rev)
        row2 = await self.db["meetings"].find_one({"_id": oid})
        await self.db["meetings"].update_one({"_id": oid}, {"$unset": {"names_v": ""}})
        self.assertFalse(await meetings.repair_names(self.db, row2, await meetings.people_of(self.db, row2["workspace_id"])))

    async def test_a_typed_attendees_value_stays(self):
        m = await self.imported()
        oid = ObjectId(m["id"])
        page = await self.doc(m["slug"])
        await self.db["documents"].update_one({"_id": page["_id"]}, {"$set": {
            "content": page_db.write_values(page["content"], {"attendees": "Typed by hand"})}})
        await self.db["meetings"].update_one({"_id": oid}, {"$set": {"attendees": [{"name": "[Ishaan Gupta]", "user_id": None}]},
                                                            "$unset": {"names_v": ""}})
        meetings._NAMES["done"] = False
        await meetings.names_tick(self.db)
        self.assertEqual(page_db.read_values((await self.doc(m["slug"]))["content"])["attendees"], "Typed by hand")
        self.assertEqual((await self.db["meetings"].find_one({"_id": oid}))["attendees"][0]["name"], "Ishaan Gupta")


if __name__ == "__main__":
    unittest.main()
