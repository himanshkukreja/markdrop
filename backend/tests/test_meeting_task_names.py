"""Gemini's next steps are never speakers or attendees (2026-11-06, ``attendees_v`` 3).

Prod: 51 of Senseloaf's 166 meetings listed attendees like "Gautam Khurana Review Video", "Palak Jain Fix
Email Bug", "S Guruprasad Test Use Cases". Gemini writes a next step as "<Owner Name> <Task Title>:
<Owner> will …"; with a "Transcript" line above the notes (Gemini's meeting records) the parser read the
whole notes tab as a transcript, so each next step was a turn of "Gautam Khurana Review Video", and the
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
FAKE = ["Gautam Khurana Review Video", "Palak Jain Fix Email Bug", "Shreesha Joshi Security Testing",
        "Himanshu Kukreja Update Prompts", "S Guruprasad Test Use Cases", "Bo Chen Trim Intro"]
OWNERS = ["Gautam Khurana", "Palak Jain", "Shreesha Joshi", "Himanshu Kukreja", "S Guruprasad", "Bo Chen"]
NAMED = ["Bo Chen", "Gautam Khurana", "Palak Jain", "Shreesha Joshi", "S Guruprasad", "Himanshu Kukreja"]
REAL = ["Ada Lovelace", "Gautam Khurana", "Bo Chen", "Palak Jain", "Shreesha Joshi", "S Guruprasad"]
TURNS = """
📖 Transcript
Ada Lovelace: Okay, let's start with the release video.
Gautam Khurana: The intro is too long, we should cut it down.
Bo Chen: I can trim the first minute today.
Palak Jain: Separately, the invite email still shows the old logo for some clients.
Shreesha Joshi: And the penetration test is planned for next week on staging.
S Guruprasad: I'll test the use cases before Friday.
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
        self.assertTrue(steps[0].startswith("Gautam Khurana Review Video: Gautam Khurana will review"))
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
        self.assertEqual({a["name"]: a["email"] for a in s.attendees}["Gautam Khurana"], "gautam@senseloaf.test")
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
        known = ["Gautam Khurana", "Palak Jain", "Shreesha Joshi", "Himanshu Kukreja", "S Guruprasad"]
        cases = {"Gautam Khurana Review Video": "Gautam Khurana", "Palak Jain Fix Email Bug": "Palak Jain",
                 "Shreesha Joshi Security Testing": "Shreesha Joshi", "Himanshu Kukreja Update Prompts": "Himanshu Kukreja",
                 "S Guruprasad Test Use Cases": "S Guruprasad"}
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
        text = ("Gautam Khurana: Hi all.\nPalak Jain: The bug is back.\n"
                "Gautam Khurana Review Video: Gautam Khurana will review the video.\nPalak Jain: ok\n")
        s = mp.parse_source("Sync - Transcript", text)
        self.assertEqual(s.speakers, ["Gautam Khurana", "Palak Jain"])
        self.assertEqual([a["name"] for a in s.attendees], ["Gautam Khurana", "Palak Jain"])

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
        notes = {"summary": "Gautam said the demo is ready. Palak will fix the email bug, and Will said nothing.",
                 "details": [], "next_steps": []}
        invited = [{"name": "Gautam Khurana", "email": "g1@x.test"}, {"name": "Gautam Rao", "email": "g2@x.test"},
                   {"name": "Palak Jain", "email": "p@x.test"}, {"name": "Will Smith", "email": "w@x.test"},
                   {"name": "Ravi Kumar", "email": "r@x.test"}]
        self.assertEqual([p["name"] for p in mp.named_in_notes(notes, invited)], ["Palak Jain", "Will Smith"])
        notes["summary"] = "Gautam Rao said the demo is ready. Palak will fix the email bug; it will ship."
        self.assertEqual([p["name"] for p in mp.named_in_notes(notes, invited)], ["Gautam Rao", "Palak Jain"])

    def test_a_name_not_invited_counts_only_for_a_member(self):
        notes = {"summary": "Palak Jain and Zed Nobody met Ravi Kumar about the release.", "details": [],
                 "next_steps": ["Zed Nobody Book Party: Zed Nobody will book the launch party."]}
        invited = [{"name": "Palak Jain", "email": "p@x.test"}, {"name": "Gautam Khurana", "email": "g@x.test"}]
        people = meetings.People([{"id": "u1", "name": "Ravi Kumar", "email": "ravi@acme.test"},
                                  {"id": "u2", "name": "Gautam Khurana", "email": "g@x.test"}])
        got = meetings.notes_attendees(notes, invited, people)
        self.assertEqual([(a["name"], a["user_id"]) for a in got], [("Palak Jain", None), ("Ravi Kumar", "u1")])
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
        self.assertIn("Gautam Khurana Review Video", content)
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
        self.assertIn("Gautam Khurana Review Video", ex["before"])
        self.assertEqual(ex["after"], NAMED)
        await self.tick()
        row = await self.db["meetings"].find_one({"_id": oid})
        self.assertEqual((row["segments"], [a["name"] for a in row["attendees"]], row["attendees_from"], len(row["invited"])),
                         ([], NAMED, "notes", 8))
        self.assertEqual({a["name"]: a["email"] for a in row["attendees"]}["Gautam Khurana"], "gautam@senseloaf.test")
        self.assertEqual((row["attendees_v"], row.get("transcript_doc_id"), row["sources"][0]["kind"]),
                         (meetings.ATTENDEES_V, None, "notes"))
        self.assertEqual((row["restricted"], row["granted"]), (True, ["kept@x.test"]))     # never touched
        self.assertIsNone(await self.db["documents"].find_one({"_id": old["transcript_doc_id"]}))   # in the Trash
        page = await self.doc(m["slug"])
        for f in FAKE:
            self.assertNotIn(f"**{f}**", page["content"])
        self.assertIn(f'## Attendees\n\n:person[Bo Chen]{{id="{self.uid["wm"]}"}}, Gautam Khurana, ', page["content"])
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
        self.assertIn("Gautam Khurana Review Video", (await self.doc(tslug))["content"])
        await self.tick()
        row = await self.db["meetings"].find_one({"_id": oid})
        self.assertEqual(meetings._speakers_of(row), REAL)
        self.assertEqual([a["name"] for a in row["attendees"]], REAL)
        self.assertEqual({a["name"]: a.get("email") for a in row["attendees"]}["Palak Jain"], "palak@senseloaf.test")
        self.assertEqual({a["name"]: a.get("user_id") for a in row["attendees"]}["Bo Chen"], self.uid["wm"])
        self.assertEqual(row["attendees_from"], "speakers")
        # The unedited Transcript page is written again; the edited meeting page only gets its Attendees.
        t = (await self.doc(tslug))["content"]
        self.assertNotIn("Review Video", t)
        self.assertIn("Gautam Khurana", t)
        page = await self.doc(m["slug"])
        self.assertIn("Typed by hand after the call.", page["content"])
        self.assertEqual(page_db.read_values(page["content"])["attendees"], ", ".join(REAL))
        section = page["content"].split("## Attendees\n\n", 1)[1].split("\n\n", 1)[0]
        self.assertNotIn("Review Video", section)
        self.assertIn("Gautam Khurana, ", section)
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
        self.assertIn("Gautam Khurana Review Video", out)
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
            {"workspace_id": self.W, "subject": "Gautam Khurana Review Video", "kind": "action_item", "text": "x"}])
        got = await meetings.stray_fact_subjects(self.db)
        self.assertEqual((got["not_member"], got["not_a_user"], got["removed"]), (1, 1, 0))
        got = await meetings.stray_fact_subjects(self.db, apply=True)
        self.assertEqual(got["removed"], 1)
        self.assertEqual(await self.db[workspace_memory.FACTS].count_documents({"workspace_id": self.W}), 1)


if __name__ == "__main__":
    unittest.main()


# ── Prod shapes (Senseloaf dry run, 2026-11-06: .work/attendee-task-names/prod-dryrun-1.txt) ──────────
# Sync-ups whose every "turn" was a line of Gemini's notes, never marked as notes (format speaker_lines),
# naming people who aren't on any invite (Shreesha, Rehan, Shreya, Venkat, Mayuri: names Gemini's labels
# keep starting with), lower-case task words, first-name labels and topic headings.
INVITE_DOC = """# Sourcing kickoff
Nov 1, 2026
Invited Arunprakaash G <arun@senseloaf.test>, Gautam Khurana <gautam@senseloaf.test>, Palak Jain <palak@senseloaf.test>, S Guruprasad <guru@senseloaf.test>, Jason Chad <jason@client.test>, Himanshu Kukreja <himanshu@senseloaf.test>, Prakhar Agrawal <prakhar@client.test>

## Summary
Kickoff for the sourcing model.

## Details
- Scope: the team agreed the scope.

## Suggested next steps
- [ ] Gautam Khurana Share Plan: Gautam Khurana will share the plan.
"""


def task(label: str, who: str, what: str) -> tuple[str, str]:
    return label, f"{who} will {what}."


PROD = {
    "2026-11-03": ("Daily Syncup", [
        task("Rehan Islam Complete Navbar", "Rehan Islam", "complete the navbar"),
        task("Shreya Sharma Integration Blog", "Shreya", "write the integration blog"),
        task("Gautam Khurana Review Content", "Gautam Khurana", "review the content"),
        task("Venkat Phanindra Greenhouse Logic", "Venkat", "finish the Greenhouse logic"),
        task("Shreesha Joshi Escalate Security", "Shreesha Joshi", "escalate the security issue"),
        task("S Guruprasad Test Workflow", "S Guruprasad", "test the workflow"),
        task("Bo Chen Review Designs", "Bo Chen", "review the designs")],
        ["Rehan Islam", "Shreya Sharma", "Gautam Khurana", "Venkat Phanindra", "Shreesha Joshi", "S Guruprasad", "Bo Chen"]),
    "2026-11-04": ("Daily Syncup", [
        task("Rehan Islam Create navbar iteration", "Rehan", "create the next navbar iteration"),
        task("Rehan Islam Complete integration design", "Rehan", "complete the integration design"),
        task("Shreya Sharma Finalize page content", "Shreya", "finalize the page content"),
        task("Venkat Phanindra Share interview recording", "Venkat", "share the interview recording"),
        task("Shreesha Joshi Document vulnerability checks", "Shreesha", "document the vulnerability checks"),
        task("S Guruprasad Test workflow creation", "S Guruprasad", "test workflow creation")],
        ["Rehan Islam", "Shreya Sharma", "Venkat Phanindra", "Shreesha Joshi", "S Guruprasad"]),
    "2026-10-30": ("Daily Syncup", [
        task("Shreya Research Visitor Emails", "Shreya", "research the visitor emails"),
        task("Gautam Gather Landing Page Content", "Gautam", "gather the landing page content"),
        task("Rehan Establish Structure", "Rehan", "establish the structure"),
        task("Arun Fix Tool Security", "Arun", "fix the tool security"),
        task("Venkat Integrate DocuSign", "Venkat", "integrate DocuSign"),
        task("Palak Complete Design", "Palak", "complete the design"),
        task("Mayuri Confirm Pepco Data", "Mayuri", "confirm the Pepco data")],
        ["Shreya Sharma", "Gautam Khurana", "Rehan Islam", "Arunprakaash G", "Venkat Phanindra", "Palak Jain", "Mayuri Pillay"]),
    "2026-10-27": ("Sourcing Model Discussion", [
        task("Jason Chad Test API Keys", "Jason Chad", "test the API keys"),
        task("Himanshu Kukreja Remove Cost Display", "Himanshu", "remove the cost display"),
        task("Gautam Khurana Adjust Reverse Contact", "Gautam Khurana", "adjust the reverse contact flow"),
        ("Positioning Senso versus Competitors", "The group compared Senso with two competitors on price."),
        ("Workflow Automation", "Prakhar Agrawal asked which steps of the workflow can be automated."),
        ("Prakhar Agrawal", "Prakhar Agrawal explained how the sourcing model ranks candidates.")],
        ["Jason Chad", "Himanshu Kukreja", "Gautam Khurana", "Prakhar Agrawal"]),
    "2026-10-21": ("Daily Syncup", [
        task("Venkat Phanindra Fix Trigger", "Venkat", "fix the trigger"),
        task("S Guruprasad Test Automation", "S Guruprasad", "test the automation"),
        task("Arunprakaash G Verify Pre-screening", "Arunprakaash G", "verify pre-screening"),
        task("Shreesha Joshi Capture Endpoint", "Shreesha Joshi", "capture the endpoint"),
        task("Mayuri Pillay Review Document", "Mayuri Pillay", "review the document"),
        task("Gautam Khurana Check Issues", "Gautam Khurana", "check the issues"),
        ("AI Assessment Endpoint Security Vulnerability", "The AI assessment endpoint had a security vulnerability."),
        ("Standardizing Demo Flows", "The team will standardize the demo flows.")],
        ["Venkat Phanindra", "S Guruprasad", "Arunprakaash G", "Shreesha Joshi", "Mayuri Pillay", "Gautam Khurana"]),
    "2026-10-27b": ("Daily Syncup", [
        task("Venkat Phanindra Add images", "Venkat", "add images"),
        task("Mayuri Pillay Update document", "Mayuri", "update the document"),
        task("Shreya Sharma Contact Jason", "Shreya", "contact Jason"),
        task("Rehan Islam Explore hosting", "Rehan", "explore hosting"),
        task("Gautam Khurana Plan release", "Gautam", "plan the release")],
        ["Venkat Phanindra", "Mayuri Pillay", "Shreya Sharma", "Rehan Islam", "Gautam Khurana"]),
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
        self.assertEqual({a["name"]: a["email"] for a in row["attendees"]}["Arunprakaash G"], "arun@senseloaf.test")
        # Done: nothing left, nothing changes again.
        self.assertEqual((await meetings.attendees_dry_run(self.db))["pending"], 0)

    async def test_new_import_of_unmarked_notes_is_notes(self):
        text = "\n".join(f"{lab}: {t}" for lab, t in PROD["2026-11-04"][1])
        s = mp.parse_source("Daily Syncup (2026-11-04 10:00 GMT+05:30) - Transcript", text)
        self.assertEqual((s.kind, s.segments), ("notes", []))
        self.assertEqual(len(s.notes["next_steps"]), 6)
        m = await self.imported(sources=[{"name": "Daily Syncup (2026-11-04 10:00 GMT+05:30) - Transcript", "text": text}])
        self.assertEqual(m["attendees_from"], "notes")
        # A workspace that knows nobody yet: only the name its labels keep starting with (Rehan Islam); a
        # name no one knows is never guessed (the next sync-up's import mines the others).
        self.assertEqual([a["name"] for a in m["attendees"]], ["Rehan Islam"])
        self.assertFalse(m.get("transcript_slug"))

    async def test_new_import_in_a_workspace_that_knows_them(self):
        await self.imported(sources=[{"name": "Sourcing kickoff - Notes by Gemini", "text": INVITE_DOC}])
        for day in ("2026-11-03", "2026-10-21", "2026-10-27b"):
            await self.prod_meeting(day, PROD[day][0], PROD[day][1])
        text = "\n".join(f"{lab}: {t}" for lab, t in PROD["2026-11-04"][1])
        m = await self.imported(sources=[{"name": "Daily Syncup (2026-11-04 10:00 GMT+05:30) - Transcript", "text": text}])
        self.assertEqual(m["attendees_from"], "notes")
        self.assertEqual(sorted(a["name"] for a in m["attendees"]), sorted(PROD["2026-11-04"][2]))
