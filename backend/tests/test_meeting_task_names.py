"""Gemini's next steps are never speakers or attendees (2026-11-06, ``attendees_v`` 3).

Prod: 51 of a pilot workspace's 166 meetings listed attendees like "Nikhil Bansal Review Video", "Meera Kapoor Fix
Email Bug", "K Raghavan Test Use Cases". Gemini writes a next step as "<Owner Name> <Task Title>:
<Owner> will …"; with a "Transcript" line above the notes (Gemini's meeting records) the parser read the
whole notes tab as a transcript, so each next step was a turn of "Nikhil Bansal Review Video", and the
attendees repair (attendees_v 2) rebuilt attendees from those speakers. Now: notes sections are never
transcript turns, a "<known person> <Title Case task>" label is that person (or, in a notes Doc, a next
step), and meetings.repair_attendees fixes the meetings imported before.

Fixtures: tests/fixtures/meetings/gemini_task_steps_notes.txt (notes only, the "Transcript" line in its
header) and gemini_task_steps_with_transcript.txt (the same + a Transcript tab).
"""

from __future__ import annotations

import unittest
from unittest import mock

from tests._access_env import AccessWorld, now  # noqa: F401  (pins settings first)
from tests.test_meetings import MeetingsWorld, fixture

from bson import ObjectId

from app.services import meetings, page_db
from app.services import meeting_parse as mp

NAME = "Release Review - 2026/11/05 10:00 GMT+05:30 - Notes by Gemini"
NOTES = "gemini_task_steps_notes.txt"
WITH_TAB = "gemini_task_steps_with_transcript.txt"
FAKE = ["Nikhil Bansal Review Video", "Meera Kapoor Fix Email Bug", "Lavanya Rao Security Testing",
        "Siddharth Menon Update Prompts", "K Raghavan Test Use Cases", "Bo Chen Trim Intro"]
OWNERS = ["Nikhil Bansal", "Meera Kapoor", "Lavanya Rao", "Siddharth Menon", "K Raghavan", "Bo Chen"]
NAMED = ["Bo Chen", "Nikhil Bansal", "Meera Kapoor", "Lavanya Rao", "K Raghavan", "Siddharth Menon"]
REAL = ["Ada Lovelace", "Nikhil Bansal", "Bo Chen", "Meera Kapoor", "Lavanya Rao", "K Raghavan"]
TURNS = """
📖 Transcript
Ada Lovelace: Okay, let's start with the release video.
Nikhil Bansal: The intro is too long, we should cut it down.
Bo Chen: I can trim the first minute today.
Meera Kapoor: Separately, the invite email still shows the old logo for some clients.
Lavanya Rao: And the penetration test is planned for next week on staging.
K Raghavan: I'll test the use cases before Friday.
Ada Lovelace: Great, then we ship on Friday.
"""


def single_tab() -> str:
    """The notes and the transcript in one tab (Drive's text export): the "Transcript" line of the
    header above the notes, the transcript's own heading after them."""
    return fixture(NOTES) + TURNS


def old_parser():
    """The parser as it was before attendees_v 3 (the bug, for building old meetings)."""
    return [mock.patch.object(mp, "notes_span", lambda lines: set()),
            mock.patch.object(mp, "clean_task_speakers", lambda segs, known=(), notes_doc=False: (segs, [], [])),
            mock.patch.object(mp, "resolve_speaker", lambda name, known=(), text=None: mp.clean_name(name) or None)]


class Parser(unittest.TestCase):
    def test_a_notes_only_next_steps_are_never_turns(self):
        s = mp.parse_source(NAME, fixture(NOTES))
        self.assertEqual((s.kind, s.format, s.segments, s.speakers), ("notes", "gemini_notes", [], []))
        self.assertEqual(s.attendees, [])
        steps = s.notes["next_steps"]
        self.assertEqual(len(steps), 6)
        self.assertTrue(steps[0].startswith("Nikhil Bansal Review Video: Nikhil Bansal will review"))
        known = [a["name"] for a in s.invited]
        self.assertEqual([mp.owner_of_step(x, known) for x in steps], OWNERS)
        m = mp.merge(mp.pair([s])[0])
        # No transcript: the invited people the notes name joined (owner, 2026-11-06); Ada and Priya stay invited.
        self.assertEqual(([a["name"] for a in m.attendees], m.attendees_from, len(m.invited)), (NAMED, "notes", 8))

    def test_a_notes_and_a_transcript_tab_speakers_are_the_real_ones(self):
        s = mp.parse_source(NAME, fixture(WITH_TAB))
        self.assertEqual(s.kind, "both")
        self.assertEqual(s.speakers, REAL)
        self.assertEqual([a["name"] for a in s.attendees], REAL)
        self.assertEqual({a["name"]: a["email"] for a in s.attendees}["Nikhil Bansal"], "nikhil@acme-hr.test")
        self.assertEqual(len(s.notes["next_steps"]), 6)

    def test_a_one_tab_notes_then_transcript(self):
        s = mp.parse_source(NAME, single_tab())
        self.assertEqual(s.kind, "both")
        self.assertEqual(s.speakers, REAL)
        self.assertFalse(any("Review Video" in (x.get("speaker") or "") for x in s.segments))
        self.assertFalse(any("Okay, let's start" in x for x in s.notes["next_steps"]))   # the notes end at its heading
        self.assertEqual(len(s.notes["next_steps"]), 6)

    def test_b_the_old_parser_read_them_as_speakers(self):
        """The regression this guards: the same Doc through the old reading."""
        patches = old_parser()
        for p in patches:
            p.start()
        try:
            s = mp.parse_source(NAME, fixture(NOTES))
        finally:
            for p in patches:
                p.stop()
        for f in FAKE:
            self.assertIn(f, s.speakers)

    def test_c_prod_examples_map_to_the_person(self):
        known = ["Nikhil Bansal", "Meera Kapoor", "Lavanya Rao", "Siddharth Menon", "K Raghavan"]
        cases = {"Nikhil Bansal Review Video": "Nikhil Bansal", "Meera Kapoor Fix Email Bug": "Meera Kapoor",
                 "Lavanya Rao Security Testing": "Lavanya Rao", "Siddharth Menon Update Prompts": "Siddharth Menon",
                 "K Raghavan Test Use Cases": "K Raghavan"}
        for label, owner in cases.items():
            self.assertEqual(mp.task_owner(label, None, known), owner, label)
            self.assertEqual(mp.resolve_speaker(label, known), owner, label)
            # Nobody known: the words after the colon name the owner again.
            first = owner.split()[0]
            self.assertEqual(mp.task_owner(label, f"{owner} will do it.", []), owner, label)
            self.assertEqual(mp.owner_of_step(f"{label}: {first} will do it.", []), owner, label)

    def test_c_real_names_are_never_tasks(self):
        known = ["Bo Chen", "Saurabh Kr. Singh", "Ada Lovelace", "Mohd Arif"]
        for name in ("Bo Chen", "Saurabh Kr. Singh", "Rahul bhai", "Ada Lovelace", "Priya", "Divya S", "anand.k"):
            self.assertIsNone(mp.task_owner(name, "Bo, can you take it?", known), name)
            self.assertEqual(mp.resolve_speaker(name, known), name)
        # A single-word known name never eats a two-word one; lower-case words aren't a task title.
        self.assertIsNone(mp.task_owner("Bo Chen", None, ["Bo"]))
        self.assertIsNone(mp.task_owner("Mohd Arif bhai", None, known))
        self.assertIsNone(mp.resolve_speaker("discussed the sprint plan", known))

    def test_d_a_transcript_line_shaped_like_a_next_step_is_its_owner(self):
        text = ("Nikhil Bansal: Hi all.\nMeera Kapoor: The bug is back.\n"
                "Nikhil Bansal Review Video: Nikhil Bansal will review the video.\nMeera Kapoor: ok\n")
        s = mp.parse_source("Sync - Transcript", text)
        self.assertEqual(s.speakers, ["Nikhil Bansal", "Meera Kapoor"])
        self.assertEqual([a["name"] for a in s.attendees], ["Nikhil Bansal", "Meera Kapoor"])

    def test_d_a_label_longer_than_a_name_is_not_a_speaker(self):
        text = "Ada Lovelace: Hi.\nBo Chen: Hello.\nThe Very Long Agenda Item Name Here: something\n"
        s = mp.parse_source("Sync - Transcript", text)
        self.assertEqual(s.speakers, ["Ada Lovelace", "Bo Chen"])


SYNCUP_INVITE = fixture("syncup_gemini_notes.txt").split("\n")[2]     # "Invited <27 chips>"
TWELVE = ["Ada Lovelace", "Bo Chen", "Priya Sharma", "Rahul bhai", "Saurabh Kr. Singh", "Mohd. Arif", "Neha Verma",
          "Ankit Jha", "Karan Mehta", "Ishaan Gupta", "Shreya Iyer", "Zoya Ali"]


def syncup_notes(summary: str, details: list[str], steps: list[str]) -> str:
    return "\n".join(["Nov 6, 2026", "# Daily Syncup", SYNCUP_INVITE, "", "## Summary", summary, "", "## Details",
                      *[f"- {d}" for d in details], "", "## Suggested next steps", *[f"- [ ] {x}" for x in steps]])


class NotesAttendees(unittest.TestCase):
    """Owner, 2026-11-06: a sync-up with only Gemini's notes lists (and @mentions) the people the notes
    name as attendees ("notes"); the rest of the invite stays invited."""

    def test_27_invited_12_named_12_attendees(self):
        text = syncup_notes(
            "Ada Lovelace ran the sync. Saurabh Kr. Singh said infra is quiet; Zoya confirmed the hiring plan.",
            ["Client demo: Rahul bhai has the deck ready, pricing pending (00:01:10).",
             "Migration: Mohd. Arif and Neha Verma reviewed the dry run with Ankit (00:03:00).",
             "Staging import: Ishaan will pair with Bo Chen after the call (00:05:00)."],
            ["Priya Sharma Run Migration: Priya Sharma will run the migration dry run tomorrow.",
             "Karan Mehta Update Docs: Karan Mehta will update the onboarding docs.",
             "Shreya Iyer Check Alerts: Shreya will check the alerts by Friday."])
        s = mp.parse_source("Daily Syncup - Notes by Gemini", text)
        self.assertEqual(len(s.invited), 27)
        m = mp.merge(mp.pair([s])[0])
        self.assertEqual(m.attendees_from, "notes")
        self.assertEqual(sorted(a["name"] for a in m.attendees), sorted(TWELVE))
        self.assertEqual(len(m.invited), 27)        # the whole invite is kept
        self.assertEqual({a["name"]: a["email"] for a in m.attendees}["Zoya Ali"], "zoya.ali@senseloaf.test")

    def test_a_first_name_two_invitees_share_is_nobody(self):
        notes = {"summary": "Nikhil said the demo is ready. Meera will fix the email bug, and Will said nothing.",
                 "details": [], "next_steps": []}
        invited = [{"name": "Nikhil Bansal", "email": "g1@x.test"}, {"name": "Nikhil Rao", "email": "g2@x.test"},
                   {"name": "Meera Kapoor", "email": "p@x.test"}, {"name": "Will Smith", "email": "w@x.test"},
                   {"name": "Ravi Kumar", "email": "r@x.test"}]
        self.assertEqual([p["name"] for p in mp.named_in_notes(notes, invited)], ["Meera Kapoor", "Will Smith"])
        notes["summary"] = "Nikhil Rao said the demo is ready. Meera will fix the email bug; it will ship."
        self.assertEqual([p["name"] for p in mp.named_in_notes(notes, invited)], ["Nikhil Rao", "Meera Kapoor"])

    def test_a_name_not_invited_counts_only_for_a_member(self):
        notes = {"summary": "Meera Kapoor and Zed Nobody met Ravi Kumar about the release.", "details": [],
                 "next_steps": ["Zed Nobody Book Party: Zed Nobody will book the launch party."]}
        invited = [{"name": "Meera Kapoor", "email": "p@x.test"}, {"name": "Nikhil Bansal", "email": "g@x.test"}]
        people = meetings.People([{"id": "u1", "name": "Ravi Kumar", "email": "ravi@acme.test"},
                                  {"id": "u2", "name": "Nikhil Bansal", "email": "g@x.test"}])
        got = meetings.notes_attendees(notes, invited, people)
        self.assertEqual([(a["name"], a["user_id"]) for a in got], [("Meera Kapoor", None), ("Ravi Kumar", "u1")])
        # Nothing named: nobody, the invite stays "invited".
        self.assertEqual(meetings.with_notes_people([], invited, "invited", {"summary": "We met."}, people),
                         ([], "invited"))


class Repair(MeetingsWorld):
    async def old_meeting(self, text: str, *, v2: bool = True, edited: bool = False,
                          restricted: bool = False) -> tuple[dict, ObjectId, dict]:
        """A meeting imported by the old parser, its attendees as prod has them: after the v2 repair
        (``v2``: the fake speakers as attendees, member-matched by the start of the name) or before it
        (every invitee and speaker in one list)."""
        patches = old_parser()
        for p in patches:
            p.start()
        try:
            m = await self.imported(sources=[{"name": NAME, "text": text}])
        finally:
            for p in patches:
                p.stop()
        oid = ObjectId(m["id"])
        row = await self.db["meetings"].find_one({"_id": oid})
        self.assertTrue(any(s.get("speaker") in FAKE for s in row["segments"]))
        people = await meetings.people_of(self.db, row["workspace_id"])
        speakers = meetings._speakers_of(row)
        if v2:
            att = [{"name": sp, "user_id": (people.match(sp) or {}).get("id"), "email": None} for sp in speakers]
            sets = {"attendees": att, "attendees_from": "speakers", "attendees_v": 2}
            unset = {}
        else:
            att = [{"name": a["name"], "user_id": (people.match(a["name"], a.get("email")) or {}).get("id")}
                   for a in mp.dedupe_people([*row["invited"], *[{"name": sp} for sp in speakers]])]
            sets, unset = {"attendees": att}, {"attendees_v": "", "invited": "", "attendees_from": ""}
        sets.update(restricted=restricted, granted=["kept@x.test"] if restricted else [])
        await self.db["meetings"].update_one({"_id": oid}, {"$set": sets, **({"$unset": unset} if unset else {})})
        old = await self.db["meetings"].find_one({"_id": oid})
        page = await self.doc(m["slug"])
        content = await meetings.full_markdown(self.db, old, old.get("generated"), people)
        rev = int(page.get("rev") or 1)
        if edited:
            content = content.rstrip() + "\n\nTyped by hand after the call.\n"
            rev += 1
        await self.db["documents"].update_one({"_id": page["_id"]}, {"$set": {"content": content, "rev": rev}})
        self.assertIn("Nikhil Bansal Review Video", content)
        meetings._ATTENDEES["done"] = False
        return m, oid, old

    async def tick(self) -> None:
        meetings._ATTENDEES["done"] = False
        while await meetings.attendees_tick(self.db):
            pass

    async def test_e_notes_only_lose_the_fake_transcript_and_attendees(self):
        m, oid, old = await self.old_meeting(fixture(NOTES), restricted=True)
        self.assertTrue(old.get("transcript_doc_id"))
        dry = await meetings.attendees_dry_run(self.db)
        self.assertEqual((dry["would_change"], dry["segments"], dry["transcript"]), (1, {"dropped": 1}, {"trashed": 1}))
        ex = dry["examples"][0]
        self.assertIn("Nikhil Bansal Review Video", ex["before"])
        self.assertEqual(ex["after"], NAMED)
        await self.tick()
        row = await self.db["meetings"].find_one({"_id": oid})
        self.assertEqual((row["segments"], [a["name"] for a in row["attendees"]], row["attendees_from"], len(row["invited"])),
                         ([], NAMED, "notes", 8))
        self.assertEqual({a["name"]: a["email"] for a in row["attendees"]}["Nikhil Bansal"], "nikhil@acme-hr.test")
        self.assertEqual((row["attendees_v"], row.get("transcript_doc_id"), row["sources"][0]["kind"]),
                         (meetings.ATTENDEES_V, None, "notes"))
        self.assertEqual((row["restricted"], row["granted"]), (True, ["kept@x.test"]))     # never touched
        self.assertIsNone(await self.db["documents"].find_one({"_id": old["transcript_doc_id"]}))   # in the Trash
        page = await self.doc(m["slug"])
        for f in FAKE:
            self.assertNotIn(f"**{f}**", page["content"])
        self.assertIn(f'## Attendees\n\n:person[Bo Chen]{{id="{self.uid["wm"]}"}}, Nikhil Bansal, ', page["content"])
        self.assertIn("_From Google's notes", page["content"])
        self.assertNotIn(old["transcript_slug"], page["content"])
        self.assertEqual(len(row["notes"]["next_steps"]), 6)      # the next steps stay next steps
        # Idempotent.
        rev = page.get("rev")
        await self.tick()
        self.assertEqual((await self.doc(m["slug"])).get("rev"), rev)
        self.assertEqual((await meetings.attendees_dry_run(self.db))["pending"], 0)
        people = await meetings.people_of(self.db, row["workspace_id"])
        self.assertFalse((await meetings.repair_attendees(self.db, row, people, apply=False))["changed"])

    async def test_e_before_v2_too(self):
        m, oid, _old = await self.old_meeting(fixture(NOTES), v2=False)
        await self.tick()
        row = await self.db["meetings"].find_one({"_id": oid})
        self.assertEqual((row["segments"], [a["name"] for a in row["attendees"]], row["attendees_from"], len(row["invited"])),
                         ([], NAMED, "notes", 8))
        self.assertFalse(any(a["name"] in FAKE for a in row["invited"]))      # the old list went to the invite

    async def test_f_notes_and_transcript_in_one_tab_keep_the_real_turns(self):
        m, oid, old = await self.old_meeting(single_tab(), edited=True)
        tslug = old["transcript_slug"]
        self.assertIn("Nikhil Bansal Review Video", (await self.doc(tslug))["content"])
        await self.tick()
        row = await self.db["meetings"].find_one({"_id": oid})
        self.assertEqual(meetings._speakers_of(row), REAL)
        self.assertEqual([a["name"] for a in row["attendees"]], REAL)
        self.assertEqual({a["name"]: a.get("email") for a in row["attendees"]}["Meera Kapoor"], "meera@acme-hr.test")
        self.assertEqual({a["name"]: a.get("user_id") for a in row["attendees"]}["Bo Chen"], self.uid["wm"])
        self.assertEqual(row["attendees_from"], "speakers")
        # The unedited Transcript page is written again; the edited meeting page only gets its Attendees.
        t = (await self.doc(tslug))["content"]
        self.assertNotIn("Review Video", t)
        self.assertIn("Nikhil Bansal", t)
        page = await self.doc(m["slug"])
        self.assertIn("Typed by hand after the call.", page["content"])
        self.assertEqual(page_db.read_values(page["content"])["attendees"], ", ".join(REAL))
        section = page["content"].split("## Attendees\n\n", 1)[1].split("\n\n", 1)[0]
        self.assertNotIn("Review Video", section)
        self.assertIn("Nikhil Bansal, ", section)
        self.assertIn(f':person[Bo Chen]{{id="{self.uid["wm"]}"}}', section)

    async def test_f_an_edited_transcript_page_is_left(self):
        m, oid, old = await self.old_meeting(single_tab())
        t = await self.doc(old["transcript_slug"])
        await self.db["documents"].update_one({"_id": t["_id"]}, {"$set": {"content": t["content"] + "\nfixed a typo\n"}})
        await self.tick()
        self.assertIn("fixed a typo", (await self.doc(old["transcript_slug"]))["content"])
        row = await self.db["meetings"].find_one({"_id": oid})
        self.assertEqual(meetings._speakers_of(row), REAL)      # the row's segments are fixed all the same

    async def test_g_a_transcript_without_notes_renames_to_the_owner(self):
        text = ("Ada Lovelace: Hi all.\nBo Chen: The bug is back.\nPriya Sharma: I'll look.\n"
                "Bo Chen Fix Email Bug: Bo Chen will fix the email bug.\nAda Lovelace: Thanks.\n")
        patches = old_parser()
        for p in patches:
            p.start()
        try:
            m = await self.imported(sources=[{"name": "Sync (2026-11-05 10:00 GMT+05:30) - Transcript", "text": text}])
        finally:
            for p in patches:
                p.stop()
        oid = ObjectId(m["id"])
        people = await meetings.people_of(self.db, self.W)
        row = await self.db["meetings"].find_one({"_id": oid})
        att = [{"name": sp, "user_id": (people.match(sp) or {}).get("id"), "email": None} for sp in meetings._speakers_of(row)]
        await self.db["meetings"].update_one({"_id": oid}, {"$set": {"attendees": att, "attendees_from": "speakers",
                                                                     "attendees_v": 2}})
        self.assertIn("Bo Chen Fix Email Bug", [a["name"] for a in att])
        await self.tick()
        row = await self.db["meetings"].find_one({"_id": oid})
        self.assertEqual(meetings._speakers_of(row), ["Ada Lovelace", "Bo Chen", "Priya Sharma"])
        self.assertEqual(len(row["segments"]), 5)
        self.assertEqual([a["name"] for a in row["attendees"]], ["Ada Lovelace", "Bo Chen", "Priya Sharma"])

    async def test_h_person_rows_names_a_member_not_the_task(self):
        people = await meetings.people_of(self.db, self.W)
        rows = meetings.person_rows([{"name": "Bo Chen Trim Intro"}, {"name": "Bo Chen"}], people)
        self.assertEqual([(r["name"], r["user_id"]) for r in rows], [("Bo Chen", self.uid["wm"])])

    async def test_i_the_script_dry_runs_then_applies(self):
        import contextlib
        import io

        from scripts import fix_attendee_task_names as script

        m, oid, _old = await self.old_meeting(fixture(NOTES))

        async def no_connect():
            return None

        buf = io.StringIO()
        with mock.patch.object(script, "connect", no_connect), mock.patch.object(script, "get_database", lambda: self.db), \
                contextlib.redirect_stdout(buf):
            await script.main(False, None)
        out = buf.getvalue()
        self.assertIn("would change 1", out)
        self.assertIn("before: ", out)
        self.assertIn("Nikhil Bansal Review Video", out)
        self.assertEqual((await self.db["meetings"].find_one({"_id": oid}))["attendees_v"], 2)   # a dry run
        buf = io.StringIO()
        with mock.patch.object(script, "connect", no_connect), mock.patch.object(script, "get_database", lambda: self.db), \
                contextlib.redirect_stdout(buf):
            await script.main(True, None)
        self.assertIn("Applied: checked", buf.getvalue())
        self.assertEqual((await self.db["meetings"].find_one({"_id": oid}))["attendees_v"], meetings.ATTENDEES_V)

    async def test_h_memory_facts_never_have_a_fake_subject(self):
        from app.services import workspace_memory

        await self.db[workspace_memory.FACTS].insert_many([
            {"workspace_id": self.W, "subject": self.uid["wm"], "kind": "action_item", "text": "trim the intro"},
            {"workspace_id": self.W, "subject": "Nikhil Bansal Review Video", "kind": "action_item", "text": "x"}])
        got = await meetings.stray_fact_subjects(self.db)
        self.assertEqual((got["not_member"], got["not_a_user"], got["removed"]), (1, 1, 0))
        got = await meetings.stray_fact_subjects(self.db, apply=True)
        self.assertEqual(got["removed"], 1)
        self.assertEqual(await self.db[workspace_memory.FACTS].count_documents({"workspace_id": self.W}), 1)


if __name__ == "__main__":
    unittest.main()


# ── Prod shapes (a pilot workspace's dry run, 2026-11-06; names invented) ──────────
# Sync-ups whose every "turn" was a line of Gemini's notes, never marked as notes (format speaker_lines),
# naming people who aren't on any invite (Lavanya, Imran, Tanvi, Harsha, Nandini: names Gemini's labels
# keep starting with), lower-case task words, first-name labels and topic headings.
INVITE_DOC = """# Sourcing kickoff
Nov 1, 2026
Invited Balakrishnan R <bala@acme-hr.test>, Nikhil Bansal <nikhil@acme-hr.test>, Meera Kapoor <meera@acme-hr.test>, K Raghavan <raghavan@acme-hr.test>, Oliver Grant <oliver@client.test>, Siddharth Menon <siddharth@acme-hr.test>, Kunal Sethi <kunal@client.test>

## Summary
Kickoff for the sourcing model.

## Details
- Scope: the team agreed the scope.

## Suggested next steps
- [ ] Nikhil Bansal Share Plan: Nikhil Bansal will share the plan.
"""


def task(label: str, who: str, what: str) -> tuple[str, str]:
    return label, f"{who} will {what}."


PROD = {
    "2026-11-03": ("Daily Syncup", [
        task("Imran Qureshi Complete Navbar", "Imran Qureshi", "complete the navbar"),
        task("Tanvi Desai Integration Blog", "Tanvi", "write the integration blog"),
        task("Nikhil Bansal Review Content", "Nikhil Bansal", "review the content"),
        task("Harsha Vardhan Workday Logic", "Harsha", "finish the Workday logic"),
        task("Lavanya Rao Escalate Security", "Lavanya Rao", "escalate the security issue"),
        task("K Raghavan Test Workflow", "K Raghavan", "test the workflow"),
        task("Bo Chen Review Designs", "Bo Chen", "review the designs")],
        ["Imran Qureshi", "Tanvi Desai", "Nikhil Bansal", "Harsha Vardhan", "Lavanya Rao", "K Raghavan", "Bo Chen"]),
    "2026-11-04": ("Daily Syncup", [
        task("Imran Qureshi Create navbar iteration", "Imran", "create the next navbar iteration"),
        task("Imran Qureshi Complete integration design", "Imran", "complete the integration design"),
        task("Tanvi Desai Finalize page content", "Tanvi", "finalize the page content"),
        task("Harsha Vardhan Share interview recording", "Harsha", "share the interview recording"),
        task("Lavanya Rao Document vulnerability checks", "Lavanya", "document the vulnerability checks"),
        task("K Raghavan Test workflow creation", "K Raghavan", "test workflow creation")],
        ["Imran Qureshi", "Tanvi Desai", "Harsha Vardhan", "Lavanya Rao", "K Raghavan"]),
    "2026-10-30": ("Daily Syncup", [
        task("Tanvi Research Visitor Emails", "Tanvi", "research the visitor emails"),
        task("Nikhil Gather Landing Page Content", "Nikhil", "gather the landing page content"),
        task("Imran Establish Structure", "Imran", "establish the structure"),
        task("Bala Fix Tool Security", "Bala", "fix the tool security"),
        task("Harsha Integrate DocuSign", "Harsha", "integrate DocuSign"),
        task("Meera Complete Design", "Meera", "complete the design"),
        task("Nandini Confirm Northwind Data", "Nandini", "confirm the Northwind data")],
        ["Tanvi Desai", "Nikhil Bansal", "Imran Qureshi", "Balakrishnan R", "Harsha Vardhan", "Meera Kapoor", "Nandini Pai"]),
    "2026-10-27": ("Sourcing Model Discussion", [
        task("Oliver Grant Test API Keys", "Oliver Grant", "test the API keys"),
        task("Siddharth Menon Remove Cost Display", "Siddharth", "remove the cost display"),
        task("Nikhil Bansal Adjust Reverse Contact", "Nikhil Bansal", "adjust the reverse contact flow"),
        ("Positioning Acme versus Competitors", "The group compared Acme with two competitors on price."),
        ("Workflow Automation", "Kunal Sethi asked which steps of the workflow can be automated."),
        ("Kunal Sethi", "Kunal Sethi explained how the sourcing model ranks candidates.")],
        ["Oliver Grant", "Siddharth Menon", "Nikhil Bansal", "Kunal Sethi"]),
    "2026-10-21": ("Daily Syncup", [
        task("Harsha Vardhan Fix Trigger", "Harsha", "fix the trigger"),
        task("K Raghavan Test Automation", "K Raghavan", "test the automation"),
        task("Balakrishnan R Verify Pre-screening", "Balakrishnan R", "verify pre-screening"),
        task("Lavanya Rao Capture Endpoint", "Lavanya Rao", "capture the endpoint"),
        task("Nandini Pai Review Document", "Nandini Pai", "review the document"),
        task("Nikhil Bansal Check Issues", "Nikhil Bansal", "check the issues"),
        ("AI Assessment Endpoint Security Vulnerability", "The AI assessment endpoint had a security vulnerability."),
        ("Standardizing Demo Flows", "The team will standardize the demo flows.")],
        ["Harsha Vardhan", "K Raghavan", "Balakrishnan R", "Lavanya Rao", "Nandini Pai", "Nikhil Bansal"]),
    "2026-10-27b": ("Daily Syncup", [
        task("Harsha Vardhan Add images", "Harsha", "add images"),
        task("Nandini Pai Update document", "Nandini", "update the document"),
        task("Tanvi Desai Contact Oliver", "Tanvi", "contact Oliver"),
        task("Imran Qureshi Explore hosting", "Imran", "explore hosting"),
        task("Nikhil Bansal Plan release", "Nikhil", "plan the release")],
        ["Harsha Vardhan", "Nandini Pai", "Tanvi Desai", "Imran Qureshi", "Nikhil Bansal"]),
}


class ProdShapes(MeetingsWorld):
    async def prod_meeting(self, day: str, title: str, turns: list[tuple[str, str]]) -> ObjectId:
        """A meeting as prod has it: imported as a transcript, its "turns" Gemini's notes, its attendees the
        labels (after the v2 repair), its Transcript page as Markdrop wrote it."""
        from app.services import page_props

        d = day[:10]
        m = await self.imported(sources=[{"name": f"{title} ({d} 10:00 GMT+05:30) - Transcript",
                                          "text": "Ada Lovelace: Hi.\nBo Chen: Hello.\n"}])
        oid = ObjectId(m["id"])
        row = await self.db["meetings"].find_one({"_id": oid})
        segs = [{"speaker": lab, "t": None, "text": text} for lab, text in turns]
        people = await meetings.people_of(self.db, row["workspace_id"])
        att = [{"name": lab, "user_id": (people.match(lab) or {}).get("id"), "email": None} for lab, _t in turns]
        await self.db["meetings"].update_one({"_id": oid}, {"$set": {
            "segments": segs, "notes": None, "attendees": att, "invited": [], "attendees_from": "speakers",
            "attendees_v": 2, "date": d, "sources": [{**row["sources"][0], "kind": "transcript", "format": "speaker_lines"}]}})
        t = await self.doc(row["transcript_slug"])
        await self.db["documents"].update_one({"_id": t["_id"]}, {"$set": {"content": page_props.apply(
            meetings.transcript_markdown(segs, approx=False), {"icon": meetings.TRANSCRIPT_ICON})}})
        return oid

    async def test_prod_sync_ups_list_real_people_only(self):
        await self.imported(sources=[{"name": "Sourcing kickoff - Notes by Gemini", "text": INVITE_DOC}])
        ids = {day: await self.prod_meeting(day, title, turns) for day, (title, turns, _want) in PROD.items()}
        dry = await meetings.attendees_dry_run(self.db)
        self.assertEqual(dry["bad_after"], [])
        self.assertEqual(dry["empty_after"], [])
        self.assertEqual(dry["segments"].get("dropped"), len(PROD))
        meetings._ATTENDEES["done"] = False
        while await meetings.attendees_tick(self.db):
            pass
        for day, (_title, turns, want) in PROD.items():
            row = await self.db["meetings"].find_one({"_id": ids[day]})
            names = [a["name"] for a in row["attendees"]]
            self.assertEqual(sorted(names), sorted(want), day)
            self.assertEqual((row["segments"], row["attendees_from"], row.get("transcript_doc_id")), ([], "notes", None), day)
            self.assertEqual(row["sources"][0]["kind"], "notes")
            self.assertTrue(row["notes"]["next_steps"], day)          # the lines are the meeting's notes now
            for n in names:
                self.assertFalse(mp.topicish(n), n)
        row = await self.db["meetings"].find_one({"_id": ids["2026-11-03"]})
        self.assertEqual({a["name"]: a["user_id"] for a in row["attendees"]}["Bo Chen"], self.uid["wm"])
        page = await self.doc(row["slug"])
        self.assertIn(f':person[Bo Chen]{{id="{self.uid["wm"]}"}}', page["content"].split("## Attendees", 1)[1])
        row = await self.db["meetings"].find_one({"_id": ids["2026-10-30"]})
        self.assertEqual({a["name"]: a["email"] for a in row["attendees"]}["Balakrishnan R"], "bala@acme-hr.test")
        # Done: nothing left, nothing changes again.
        self.assertEqual((await meetings.attendees_dry_run(self.db))["pending"], 0)

    async def test_new_import_of_unmarked_notes_is_notes(self):
        text = "\n".join(f"{lab}: {t}" for lab, t in PROD["2026-11-04"][1])
        s = mp.parse_source("Daily Syncup (2026-11-04 10:00 GMT+05:30) - Transcript", text)
        self.assertEqual((s.kind, s.segments), ("notes", []))
        self.assertEqual(len(s.notes["next_steps"]), 6)
        m = await self.imported(sources=[{"name": "Daily Syncup (2026-11-04 10:00 GMT+05:30) - Transcript", "text": text}])
        self.assertEqual(m["attendees_from"], "notes")
        # A workspace that knows nobody yet: only the name its labels keep starting with (Imran Qureshi); a
        # name no one knows is never guessed (the next sync-up's import mines the others).
        self.assertEqual([a["name"] for a in m["attendees"]], ["Imran Qureshi"])
        self.assertFalse(m.get("transcript_slug"))

    async def test_new_import_in_a_workspace_that_knows_them(self):
        await self.imported(sources=[{"name": "Sourcing kickoff - Notes by Gemini", "text": INVITE_DOC}])
        for day in ("2026-11-03", "2026-10-21", "2026-10-27b"):
            await self.prod_meeting(day, PROD[day][0], PROD[day][1])
        text = "\n".join(f"{lab}: {t}" for lab, t in PROD["2026-11-04"][1])
        m = await self.imported(sources=[{"name": "Daily Syncup (2026-11-04 10:00 GMT+05:30) - Transcript", "text": text}])
        self.assertEqual(m["attendees_from"], "notes")
        self.assertEqual(sorted(a["name"] for a in m["attendees"]), sorted(PROD["2026-11-04"][2]))

    async def test_an_attendees_line_with_glued_names_and_a_task_label(self):
        await self.imported(sources=[{"name": "Sourcing kickoff - Notes by Gemini", "text": INVITE_DOC}])
        oid = await self.prod_meeting("2026-11-02", "Sourcing discussion", [
            ("Oliver Grant", "Can we see the ranking for the last search?"),
            ("Kunal Sethi", "Yes, it is on the second tab."),
            task("Balakrishnan R Fix Production Loop", "Balakrishnan R", "fix the production loop"),
            ("Oliver Grant", "Great, thanks.")])
        await self.db["meetings"].update_one({"_id": oid}, {"$set": {"attendees_from": "attendees", "attendees": [
            {"name": "Siddharth Menon Balakrishnan R Oliver Grant", "user_id": None, "email": None},
            {"name": "Balakrishnan R Fix Production Loop", "user_id": None, "email": None},
            {"name": "Oliver Grant", "user_id": None, "email": None}, {"name": "Kunal Sethi", "user_id": None, "email": None}]}})
        meetings._ATTENDEES["done"] = False
        while await meetings.attendees_tick(self.db):
            pass
        row = await self.db["meetings"].find_one({"_id": oid})
        self.assertEqual([a["name"] for a in row["attendees"]], ["Siddharth Menon", "Balakrishnan R", "Oliver Grant", "Kunal Sethi"])
        self.assertEqual(row["attendees_from"], "attendees")
        self.assertEqual(meetings._speakers_of(row), ["Oliver Grant", "Kunal Sethi", "Balakrishnan R"])   # a real call: renamed
        self.assertEqual({a["name"]: a["email"] for a in row["attendees"]}["Oliver Grant"], "oliver@client.test")


# ── attendees_v 5 (2026-11-07): what was left after v4 (shapes from a pilot workspace, names invented) ──
EMPTY_NOTES = {
    "summary": "A summary wasn't produced for this meeting because there wasn't enough conversation in a supported "
               "language.\n\nIf the meeting was transcribed, you can review the transcript linked in the meeting records "
               "section of this document.\n\nVisit the help center for troubleshooting information",
    "details": ["Details weren't produced for this meeting.",
                "How is the quality of these specific notes? Take a short survey to let us know your feedback, "
                "including how helpful the notes were for your needs."],
    "next_steps": ["No suggested next steps were found for this meeting."]}


class LeftOvers(MeetingsWorld):
    async def knows_people(self) -> None:
        """A workspace that has seen these people before (an invite with addresses)."""
        await self.imported(sources=[{"name": "Sourcing kickoff - Notes by Gemini", "text": INVITE_DOC}])

    async def row_of(self, title: str, day: str, **sets) -> tuple[ObjectId, dict]:
        m = await self.imported(sources=[{"name": f"{title} ({day} 10:00 GMT+05:30) - Transcript",
                                          "text": "Ada Lovelace: Hi.\nBo Chen: Hello.\n"}])
        oid = ObjectId(m["id"])
        await self.db["meetings"].update_one({"_id": oid}, {"$set": {"date": day, "attendees_v": 4, **sets}})
        return oid, m

    async def tick(self) -> None:
        meetings._ATTENDEES["done"] = False
        while await meetings.attendees_tick(self.db):
            pass

    def test_parse_gemini_placeholders_are_nobodys_words(self):
        text = "\n".join(["# Daily Standup", "Nov 4, 2026", "## Summary", *EMPTY_NOTES["summary"].split("\n"),
                          "## Details", *[f"- {d}" for d in EMPTY_NOTES["details"]], "## Suggested next steps",
                          *[f"- [ ] {x}" for x in EMPTY_NOTES["next_steps"]]])
        s = mp.parse_source("Daily Standup - 2026/11/04 11:00 IST - Notes by Gemini", text)
        self.assertEqual((s.kind, s.notes["summary"], s.notes["details"], s.notes["next_steps"]), ("notes", "", [], []))

    async def test_v4_dropped_lines_are_read_back_from_the_trash(self):
        """v4 dropped the notes read as turns (first-name labels) and kept notes that say nothing: the
        Transcript page it moved to the Trash still has them."""
        from app.services import page_props, trash, user as user_service

        await self.knows_people()
        await self.prod_like_names()
        turns = PROD["2026-10-30"][1]
        segs = [{"speaker": lab, "t": None, "text": t} for lab, t in turns]
        oid, m = await self.row_of("Daily Syncup", "2026-10-30", notes=EMPTY_NOTES, attendees=[],
                                   attendees_from="invited", sources=[{"kind": "notes", "format": "gemini_notes",
                                                                       "name": "Daily Syncup - Notes by Gemini"}])
        row = await self.db["meetings"].find_one({"_id": oid})
        t = await self.doc(row["transcript_slug"])
        await self.db["documents"].update_one({"_id": t["_id"]}, {"$set": {"content": page_props.apply(
            meetings.transcript_markdown(segs, approx=False), {"icon": meetings.TRANSCRIPT_ICON})}})
        user = await user_service.get_user_by_id(self.db, self.uid["owner"])
        from app.services import access
        await trash.move(self.db, [await self.doc(row["transcript_slug"])], await self.doc(row["transcript_slug"]),
                         access.Actor.of(user))
        await self.db["meetings"].update_one({"_id": oid}, {"$set": {"segments": [], "transcript_doc_id": None,
                                                                     "transcript_slug": None}})
        await self.tick()
        row = await self.db["meetings"].find_one({"_id": oid})
        self.assertEqual(sorted(a["name"] for a in row["attendees"]), sorted(PROD["2026-10-30"][2]))
        self.assertEqual((row["attendees_from"], row["attendees_v"]), ("notes", meetings.ATTENDEES_V))
        self.assertEqual(len(row["notes"]["next_steps"]), len(turns))
        self.assertNotIn("No suggested next steps", " ".join(row["notes"]["next_steps"]))
        page = await self.doc(m["slug"])
        self.assertNotIn("No suggested next steps", page["content"])

    async def prod_like_names(self) -> None:
        """Other sync-ups whose labels keep naming the same people (as in the pilot workspace)."""
        for day in ("2026-11-03", "2026-10-27b", "2026-10-21"):
            await ProdShapes.prod_meeting(self, day, PROD[day][0], PROD[day][1])

    async def test_bracketed_owners_and_odd_names(self):
        await self.knows_people()
        await self.prod_like_names()
        # A second Doc read as a transcript, Gemini's newer "[Owner] Task" lines; notes that say nothing.
        segs = [{"speaker": None, "t": None, "text": "Meeting records Transcript"},
                {"speaker": "[Nikhil] Post Video", "t": None, "text": "Post the demo video on the website."},
                {"speaker": "[Nandini] Knowledge Transfer", "t": None, "text": "Hand over the client accounts."}]
        oid, _m = await self.row_of("Daily Standup", "2026-09-18", segments=segs, notes=EMPTY_NOTES, attendees_from="speakers",
                                    attendees=[{"name": "Nikhil Post Video", "user_id": None, "email": None},
                                               {"name": "Nandini Knowledge Transfer", "user_id": None, "email": None}],
                                    invited=[{"name": "Nikhil Post Video", "user_id": None, "email": None},
                                             {"name": "Imran Qureshi", "user_id": None, "email": None}],
                                    sources=[{"kind": "notes", "format": "gemini_notes", "name": "a"},
                                             {"kind": "transcript", "format": "speaker_lines", "name": "b"}])
        # Notes in the newer shape: chips after the title, "[Owner] Task: …" next steps, topic labels.
        notes = {"summary": "", "details": [
            "### Daily Standup Nikhil Bansal <nikhil@acme-hr.test> Harsha Vardhan <harsha@acme-hr.test> "
            "Nandini Pai <nandini@acme-hr.test> K Raghavan <raghavan@acme-hr.test> The launch week went well.",
            "Video Proctoring Threshold: K Raghavan lowered the detection threshold.",
            "Profile Verification: the team agreed on the checks."],
            "next_steps": ["[Harsha Vardhan] Check Scopes: Keep the API scopes under 20.",
                           "[Nandini Pai, Imran Qureshi] Prepare Presentation: Share the deck with the client.",
                           "Video Proctoring Update Threshold: Lower the threshold."]}
        oid2, _m2 = await self.row_of("Daily Standup", "2026-09-07", segments=[], notes=notes, attendees_from="notes",
                                      attendees=[{"name": "Video Proctoring", "user_id": None, "email": None},
                                                 {"name": "Harsha Vardhan", "user_id": None, "email": None}],
                                      invited=[], sources=[{"kind": "notes", "format": "gemini_notes", "name": "c"}])
        await self.tick()
        row = await self.db["meetings"].find_one({"_id": oid})
        self.assertEqual(sorted(a["name"] for a in row["attendees"]), ["Nandini Pai", "Nikhil Bansal"])
        self.assertNotIn("Nikhil Post Video", [a["name"] for a in row["invited"]])
        row = await self.db["meetings"].find_one({"_id": oid2})
        names = [a["name"] for a in row["attendees"]]
        self.assertNotIn("Video Proctoring", names)
        for n in ("Harsha Vardhan", "Nandini Pai", "Imran Qureshi", "K Raghavan"):
            self.assertIn(n, names)
        self.assertEqual(sorted(a["name"] for a in row["invited"]),
                         ["Harsha Vardhan", "K Raghavan", "Nandini Pai", "Nikhil Bansal"])    # the chip line
        self.assertFalse(any(mp.topicish(n) for n in names))

    async def test_an_empty_notes_meeting_stays_empty_and_loses_its_placeholder_item(self):
        oid, m = await self.row_of("Daily Standup", "2026-08-11", segments=[], notes=EMPTY_NOTES, attendees=[],
                                   invited=[], attendees_from="none", action_items=1,
                                   sources=[{"kind": "notes", "format": "gemini_notes", "name": "d"}])
        await self.tick()
        row = await self.db["meetings"].find_one({"_id": oid})
        self.assertEqual((row["attendees"], row["attendees_from"], row["notes"]["next_steps"], row["action_items"]),
                         ([], "none", [], 0))

    async def test_one_writer_per_meeting_and_a_409_is_retried(self):
        from fastapi import HTTPException

        await self.knows_people()
        oid = await ProdShapes.prod_meeting(self, "2026-11-04", PROD["2026-11-04"][0], PROD["2026-11-04"][1])
        await self.db["meetings"].update_one({"_id": oid}, {"$set": {"attendees_lock": meetings.now_utc()}})
        row = await self.db["meetings"].find_one({"_id": oid})
        people = await meetings.people_of(self.db, self.W)
        self.assertEqual((await meetings.repair_attendees(self.db, row, people))["page"], "busy")
        await self.db["meetings"].update_one({"_id": oid}, {"$unset": {"attendees_lock": ""}})
        real, calls = meetings._save, {"n": 0}

        async def flaky(db, raw, content, actor, ctx, *, base_rev=None):
            if raw.get("meeting_role") == "page" and calls["n"] == 0:
                calls["n"] += 1
                await self.db["documents"].update_one({"_id": raw["_id"]}, {"$inc": {"rev": 1}})
                raise HTTPException(status_code=409, detail="Saved meanwhile")
            return await real(db, raw, content, actor, ctx, base_rev=base_rev)

        with mock.patch.object(meetings, "_save", flaky):
            got = await meetings.repair_attendees(self.db, await self.db["meetings"].find_one({"_id": oid}), people)
        self.assertEqual((calls["n"], got["page"]), (1, "attendees"))
        row = await self.db["meetings"].find_one({"_id": oid})
        self.assertEqual((row["attendees_v"], row.get("attendees_lock")), (meetings.ATTENDEES_V, None))
        page = await self.doc(row["slug"])
        self.assertNotIn("Create navbar iteration", page["content"].split("## Attendees", 1)[-1].split("##", 1)[0])
