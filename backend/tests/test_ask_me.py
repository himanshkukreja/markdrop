"""Ask Markdrop knows who is asking (services/ask_me.py; .work/briefs/assistant-me.md).

Every assistant prompt carries the asker's own "You" block (name, email, workspaces and role, today,
the names they appear under in meetings, matched with the import's people matcher incl. a first
name); a question about "I / me / my" brings their meetings (latest first, the named series first)
with their own transcript lines marked "(you)" and whether they attended / spoke; a restricted meeting
never reaches anyone outside it; another member gets their own identity. The model is the fake client.
"""

from __future__ import annotations

import unittest

from tests.test_assistant import AssistantWorld
from tests.test_pages_ai import prompt_of

from bson import ObjectId

from app.services import ask_me, meetings

SYNCUPS = {
    "2026-11-03": ["Attendees: Ada Lovelace, Bo Chen, Priya Sharma",
                   "Ada Lovelace: Morning all, quick round please.",
                   "Bo: I shipped the CSV export API yesterday and started on rate limits.",
                   "Priya Sharma: I'm reviewing the billing migration.",
                   "Bo: I'll pair with Priya on the webhook retries this afternoon."],
    "2026-11-05": ["Attendees: Ada Lovelace, Bo Chen, Priya Sharma",
                   "Ada Lovelace: Let's keep it short today.",
                   "Priya Sharma: The billing migration dry run passed."],
}
SECRET = "Restricted salary bands for the platform team are frozen."


class AskMeWorld(AssistantWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        ask_me.forget_names()
        self.addCleanup(ask_me.forget_names)

    async def syncup(self, day: str, *, who: str = "owner", restricted: bool = False, lines: list[str] | None = None) -> dict:
        r = await self.http.post("/api/v1/meetings/import", headers=self.session(who), json={
            "workspace": self.W, "sources": [{"name": "Daily Syncup", "text": "\n".join(lines or SYNCUPS[day])}],
            "title": "Daily Syncup", "date": day, "wait": True, "restricted": restricted})
        self.assertEqual(r.status_code, 200, r.text)
        m = r.json()["meetings"][0]
        await self.db[meetings.COLL].update_one({"_id": ObjectId(m["id"])}, {"$set": {"series": "Daily Syncup"}})
        return m

    async def seed_syncups(self) -> dict[str, dict]:
        return {d: await self.syncup(d) for d in SYNCUPS}

    def answer_prompt(self, prefix: str = "You are Ask, the assistant") -> str:
        calls = self.calls(prefix)
        self.assertTrue(calls, f"no {prefix!r} call")
        return prompt_of(calls[-1])


class Detect(unittest.TestCase):
    def test_personal_and_profile(self):
        for q in ("what did I tell in my last sync-up discussion", "What are my documents?", "maine kya bola standup mein",
                  "who am I", "What have I been working on lately?"):
            self.assertTrue(ask_me.is_personal(q), q)
        for q in ("What did Bo say in the standup?", "When is the release?", "Summarize the pricing review"):
            self.assertFalse(ask_me.is_personal(q), q)
        for q in ("who am I?", "what's my email", "Which workspaces am I in?", "what is my role", "what's my plan"):
            self.assertTrue(ask_me.is_profile(q), q)
        self.assertFalse(ask_me.is_profile("what did I say in the standup"))
        self.assertTrue(ask_me.wants_meetings("what did I say in my last sync-up"))
        self.assertTrue(ask_me.wants_work("what have I been working on"))

    def test_topical(self):
        row = {"title": "Daily Syncup", "series": "Daily Syncup"}
        q = "what did I tell in my last sync-up discussion"
        self.assertTrue(ask_me._topical(row, ask_me.topic_terms(q), q))
        self.assertTrue(ask_me._topical(row, ask_me.topic_terms("my last sync up"), "my last sync up"))
        self.assertFalse(ask_me._topical({"title": "Pricing review"}, ask_me.topic_terms(q), q))


class YouBlock(AskMeWorld):
    async def test_every_prompt_names_the_asker(self):
        await self.seed_syncups()
        self.fake.calls.clear()
        await self.ask("wm", "What is the billing migration status?", {"kind": "everything"})
        p = self.answer_prompt()
        self.assertIn("<untrusted_you>", p)
        self.assertIn("Name: Bo Chen", p)
        self.assertIn(f"Email: {self.email['wm']}", p)
        self.assertIn("Acme (member)", p)
        self.assertRegex(p, r"In meetings they appear as \(attendee / speaker names\): [^\n]*Bo Chen")
        self.assertRegex(p, r"appear as[^\n]*\bBo\b")             # the speaker "Bo": a first name only Bo has
        self.assertIn('"I", "me", "my" in the question mean', p)
        # Nobody else's email is in the block.
        block = p.split("<untrusted_you>", 1)[1].split("</untrusted_you>", 1)[0]
        for other in ("owner", "wa", "wv"):
            self.assertNotIn(self.email[other], block)
        # The Meetings scope and one meeting carry it too.
        self.fake.calls.clear()
        await self.ask("wm", "What happened in the syncups?", {"kind": "meetings", "workspace": self.W})
        self.assertIn("Name: Bo Chen", self.answer_prompt("You answer questions about a team's meetings"))
        ms = await self.seed_syncups()
        self.fake.calls.clear()
        await self.ask("wm", "What did I say?", {"kind": "meetings", "workspace": self.W, "meeting": ms["2026-11-03"]["id"]})
        p = self.answer_prompt("You answer questions about one meeting")
        self.assertIn("Name: Bo Chen", p)
        self.assertIn("The person asking: they attended and spoke 2 times", p)
        self.assertIn("Bo (you): I shipped the CSV export API", p)
        self.assertNotIn("Priya Sharma (you)", p)

    async def test_another_member_gets_their_own_identity(self):
        await self.seed_syncups()
        self.fake.calls.clear()
        await self.ask("wa", "What did I say in my last sync-up?", {"kind": "everything"})
        p = self.answer_prompt()
        self.assertIn("Name: Priya Sharma", p)
        self.assertIn("Acme (admin)", p)
        self.assertNotIn("Name: Bo Chen", p)
        self.assertIn("Priya Sharma (you): The billing migration dry run passed.", p)
        self.assertNotIn("Bo (you)", p)

    async def test_profile_questions_need_no_search_hit(self):
        self.fake.calls.clear()
        done = self.done(await self.ask("wm", "Who am I, and which workspaces am I in?", {"kind": "everything"}))
        p = self.answer_prompt()
        self.assertIn("Name: Bo Chen", p)
        self.assertIn("Workspaces (their role): ", p)
        self.assertNotIn("Nothing you can open matches", done["answer"])


class Personal(AskMeWorld):
    async def test_my_last_syncup_brings_my_lines_and_says_when_i_didnt_speak(self):
        ms = await self.seed_syncups()
        self.fake.calls.clear()
        await self.ask("wm", "what did I tell in my last sync-up discussion", {"kind": "everything"})
        p = self.answer_prompt()
        # Both syncups: the latest (attended, silent) and the one where they spoke, with their own lines.
        self.assertIn("Bo (you): I shipped the CSV export API yesterday", p)
        self.assertIn("Bo (you): I'll pair with Priya on the webhook retries", p)
        self.assertIn('you="they attended but didn', p)
        self.assertIn("they attended and spoke 2 times", p)
        self.assertLess(p.index("2026-11-05"), p.index("2026-11-03"))
        # Its lines link to the transcript moment.
        events = await self.ask("wm", "what did I say in my last sync-up", {"kind": "everything"})
        self.assertEqual(events[-1][0], "done")
        self.assertTrue(ms)

    async def test_meetings_scope_puts_my_meetings_first(self):
        await self.seed("Pricing review")
        await self.seed_syncups()
        self.fake.calls.clear()
        done = self.done(await self.ask("wm", "What did I say in my last sync-up?", {"kind": "meetings", "workspace": self.W}))
        p = self.answer_prompt("You answer questions about a team's meetings")
        first = p.split('<untrusted_meeting n="1"', 1)[1].split("</untrusted_meeting>", 1)[0]
        self.assertIn('title="Daily Syncup"', first)
        self.assertIn('date="2026-11-05"', first)
        self.assertIn("they attended but didn", first)
        self.assertIn("Bo (you): I shipped the CSV export API", p)
        self.assertEqual(done["engine"], "meetings_ai")

    async def test_restricted_meeting_never_reaches_others(self):
        await self.seed_syncups()
        await self.syncup("2026-11-06", restricted=True, lines=[
            "Attendees: Ada Lovelace, Priya Sharma", "Ada Lovelace: " + SECRET, "Priya Sharma: Understood."])
        for scope in ({"kind": "everything"}, {"kind": "meetings", "workspace": self.W}, {"kind": "workspace", "workspace": self.W}):
            self.fake.calls.clear()
            await self.ask("wm", "What did I say in my last sync-up?", scope)
            for c in self.fake.calls:
                self.assertNotIn("salary bands", prompt_of(c), scope)
        # Its attendee sees it, marked as theirs.
        self.fake.calls.clear()
        await self.ask("owner", "What did I say in my last sync-up?", {"kind": "everything"})
        self.assertIn("Ada Lovelace (you): " + SECRET, self.answer_prompt())

    async def test_not_in_the_named_meeting(self):
        # Bo was in none of these: the latest one comes with "not in this meeting".
        await self.syncup("2026-11-05", lines=["Attendees: Ada Lovelace, Priya Sharma", "Ada Lovelace: Short one.",
                                               "Priya Sharma: Dry run passed."])
        self.fake.calls.clear()
        await self.ask("wm", "What did I say in my last sync-up?", {"kind": "everything"})
        p = self.answer_prompt()
        self.assertIn("was not in this meeting", p)
        self.assertNotRegex(p, r"\] \S+ [^\n:]*\(you\):")

    async def test_my_recent_work(self):
        await self.mkdoc("W", owner="wm", slug="bo-export-spec", title="CSV export spec", content="The export spec.", grants=False)
        await self.mkdoc("P", owner="owner", slug="ada-only", title="Ada private notes", content="Private.", grants=False)
        from app.services import search_index

        await search_index.drain()
        self.fake.calls.clear()
        await self.ask("wm", "What have I been working on lately?", {"kind": "everything"})
        p = self.answer_prompt()
        self.assertIn("CSV export spec", p)
        self.assertRegex(p, r'yours="you (created|updated) it')
        self.assertNotIn("Ada private notes", p)


class Accuracy(AskMeWorld):
    """What the eval harness (tests/ask_eval) found, pinned."""

    def test_intent_and_citation_lists(self):
        from app.services import ai_output, ask_markdrop

        self.assertEqual(ask_markdrop.detect_intent("What happened in the latest Daily Syncup?"), "ask")
        self.assertEqual(ask_markdrop.detect_intent("What happened this week?"), "catch_up")
        self.assertEqual(ask_markdrop.detect_intent("Catch me up"), "catch_up")
        self.assertEqual(ai_output.split_cites("a [2-s1, 2-s2] b [1, 3] c [M2-s4; M3] d [x, y]"),
                         "a [2-s1][2-s2] b [1][3] c [M2-s4][M3] d [x, y]")
        self.assertEqual(ask_markdrop.clean_answer("<ranking>1</ranking>\n\nHi [1, 2-s3].", {"1", "2-s3"}), "Hi [1][2-s3].")

    async def test_the_same_member_twice_is_one_attendee_and_a_1on1_is_restricted(self):
        r = await self.http.post("/api/v1/meetings/import", headers=self.session("owner"), json={
            "workspace": self.W, "sources": [{"name": "Ada / Priya", "text": "\n".join([
                "Attendees: Ada Lovelace, Priya Sharma", "Ada: How is the migration?", "Priya: On track for Friday."])}],
            "title": "Ada / Priya 1:1", "date": "2026-11-02", "wait": True})
        self.assertEqual(r.status_code, 200, r.text)
        row = await self.db[meetings.COLL].find_one({"_id": ObjectId(r.json()["meetings"][0]["id"])})
        ids = [a.get("user_id") for a in row["attendees"]]
        self.assertEqual(sorted(i for i in ids if i), sorted([self.uid["owner"], self.uid["wa"]]))
        self.assertEqual(len(ids), 2, row["attendees"])
        self.assertTrue(row["restricted"])

    async def test_latest_named_meeting_comes_first(self):
        for day in ("2026-10-01", "2026-10-02", "2026-10-03", "2026-10-06", "2026-10-07"):
            await self.syncup(day, lines=["Attendees: Ada Lovelace, Bo Chen, Priya Sharma", "Ada Lovelace: Routine round.",
                                          "Priya Sharma: Nothing new, still on the docs."])
        await self.seed_syncups()
        self.fake.calls.clear()
        await self.ask("wm", "What happened in the latest Daily Syncup?", {"kind": "everything"})
        p = self.answer_prompt()
        first = p.split('<untrusted_document n="1"', 1)[1].split(">", 1)[0]
        self.assertIn('date="2026-11-05"', first)

    async def test_catch_up_counts_a_meeting_by_its_day(self):
        from app.services import search_index

        await self.syncup("2026-08-01", lines=["Attendees: Ada Lovelace, Bo Chen", "Ada Lovelace: An old backfilled call.",
                                               "Bo: Old news about the archive."])
        await self.mkdoc("W", slug="fresh-doc", title="Fresh launch doc", content="Launch moved to Monday.", grants=False)
        await search_index.drain()
        self.fake.calls.clear()
        await self.ask("wm", "Catch me up on this week", {"kind": "everything"})
        p = self.answer_prompt()
        self.assertNotIn("2026-08-01", p)
        self.assertIn("Fresh launch doc", p)

    async def test_a_specific_document_is_not_crowded_out_by_meetings(self):
        from app.services import search_index

        for i, day in enumerate(("2026-10-01", "2026-10-02", "2026-10-03", "2026-10-06", "2026-10-07", "2026-10-08")):
            await self.syncup(day, lines=["Attendees: Ada Lovelace, Bo Chen, Priya Sharma",
                                          f"Ada Lovelace: Open items from round {i}, still open.", "Priya Sharma: Still open on my side."])
        await self.mkdoc("W", slug="q4-roadmap", title="Q4 Roadmap", content="# Q4 Roadmap\n\n- [ ] Slack app beta\n- [ ] Export limits",
                         grants=False)
        await search_index.drain()
        self.fake.calls.clear()
        await self.ask("wm", "What's still open in the Q4 Roadmap?", {"kind": "everything"})
        self.assertIn('title="Q4 Roadmap"', self.answer_prompt())

    async def test_a_question_naming_the_asker_is_about_them(self):
        await self.seed_syncups()
        self.fake.calls.clear()
        await self.ask("wm", "What has Bo Chen said in the syncups?", {"kind": "everything"})
        self.assertIn("Bo (you): I shipped the CSV export API", self.answer_prompt())


if __name__ == "__main__":
    unittest.main()
