"""Team memory (services/workspace_memory.py, routers/team.py, mcp/team_tools.py, the Ask Markdrop hook;
.work/workspace-memory/SPEC.md).

Facts with provenance from meetings (the summary's own action items for free, then one fake-model
call over the notes and transcript) and pages (open task lines that @mention a member for free, then
one call); due dates resolved against the meeting's day; access decided per viewer at read time (a
restricted meeting, a private page, the trash); corrections and hiding that survive re-extraction;
the switch (default off; off deletes); the cap pausing the job; nightly consolidation and decay; the
board's derived status; the assistant hook naming the right person; MCP. The model is always fake.
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta, timezone

from tests._access_env import now  # noqa: F401  (pins settings first)
from tests.test_meeting_memory import MemoryWorld
from tests.test_pages_ai import prompt_of

import unittest

from bson import ObjectId

from app.config import get_settings
from app.services import ai_usage, ask_markdrop, workspace_memory as wm

settings = get_settings()
_SAVED = ("workspace_memory_enabled", "workspace_memory_daily_usd", "workspace_memory_monthly_usd")

STANDUP = {
    "title": "Sourcing standup", "date": "2026-11-03",   # a Tuesday
    "lines": ["Bo Chen: Yesterday I finished the candidate import from Greenhouse.",
              "Bo Chen: Today I am working on the sourcing filters, I will ship them by Thursday.",
              "Priya Sharma: I am blocked, waiting on Ravi Kumar for the API keys.",
              "Ada Lovelace: We agreed the beta goes to Senseloaf first."],
}


STANDUP_GEN = {"summary": "Sourcing standup.", "highlights": [], "decisions": [], "open_questions": [], "topics": [],
               "action_items": [{"text": "Review the filter designs", "owner": "Bo Chen", "due": None, "cite": "s2"}],
               "type": "Standup"}


def _fake_extract(user: str) -> str:
    """The fake model's facts: from transcript lines "[sN] t Speaker: words" (finished → update,
    working on → working_on, "will … by <day>" → target, blocked/waiting on X → blocker) and, for a
    document, from "@Name is …" sentences."""
    facts = []
    for seg, who, text in re.findall(r"\[s(\d+)\] \S+ ([^:\n]+): ([^\n]+)", user):
        t = text.lower()
        if "finished" in t:
            facts.append({"person": who, "kind": "update", "text": re.sub(r"^yesterday i ", "", text, flags=re.I).rstrip("."),
                          "project": "Sourcing", "cite": f"s{seg}", "confidence": 0.9})
        if "working on" in t:
            facts.append({"person": who, "kind": "working_on", "text": "Building the sourcing filters",
                          "project": "Sourcing", "cite": f"s{seg}", "confidence": 0.9})
        m = re.search(r"by (monday|tuesday|wednesday|thursday|friday)", t)
        if m:
            facts.append({"person": who, "kind": "target", "text": "Ship the sourcing filters", "project": "Sourcing",
                          "due": None, "due_text": f"by {m.group(1)}", "cite": f"s{seg}", "confidence": 0.9})
        w = re.search(r"waiting on ([A-Z][a-z]+ [A-Z][a-z]+)", text)
        if "blocked" in t:
            facts.append({"person": who, "kind": "blocker", "text": "Waiting for the API keys",
                          "waiting_on": w.group(1) if w else None, "project": "Sourcing", "cite": f"s{seg}"})
        if "agreed" in t:
            facts.append({"person": who, "kind": "decision", "text": "The beta goes to Senseloaf first",
                          "project": "Sourcing", "cite": f"s{seg}"})
    for name, what in re.findall(r"@([A-Z][a-z]+ [A-Z][a-z]+) is ([^.\n]+)", user):
        facts.append({"person": name, "kind": "working_on", "text": what[:120], "project": "Billing", "cite": None})
    return json.dumps({"facts": facts})


class TeamWorld(MemoryWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await wm.ensure_indexes(self.db)
        self.saved_wm = {k: getattr(settings, k) for k in _SAVED}
        settings.workspace_memory_enabled = True
        settings.workspace_memory_daily_usd = 3.0
        settings.workspace_memory_monthly_usd = 30.0
        ai_usage.invalidate_settings()
        self.addCleanup(lambda: [setattr(settings, k, v) for k, v in self.saved_wm.items()])
        self.extract_reply = None

    def script(self, params: dict) -> str:
        system = params["system"][0]["text"]
        user = "\n".join(b["text"] for b in params["messages"][-1]["content"] if b.get("type") == "text")
        if system.startswith("You write the team's notes") and "Title: Sourcing standup" in user:
            return json.dumps(STANDUP_GEN)
        if system.startswith("You keep a team's memory"):
            user = "\n".join(b["text"] for b in params["messages"][-1]["content"] if b.get("type") == "text")
            return self.extract_reply if self.extract_reply is not None else _fake_extract(user)
        return super().script(params)

    async def turn_on(self, who: str = "wa", on: bool = True):
        r = await self.http.put(f"/api/v1/workspaces/{self.W}", headers=self.session(who),
                                json={"settings": {"team_memory": on}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["settings"]["team_memory"], on)

    async def standup(self, **body) -> dict:
        title = body.pop("title", None) or STANDUP["title"]
        lines = STANDUP["lines"] + ([f"Ada Lovelace: Thanks all ({title})."] if title != STANDUP["title"] else [])
        r = await self.http.post("/api/v1/meetings/import", headers=self.session("owner"), json={
            "workspace": self.W, "sources": [{"name": title, "text": "\n".join(lines)}],
            "title": title, "date": (body.pop("date", None) or STANDUP["date"]), "wait": True,
            **{"restricted": False, **body}})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["meetings"][0]

    async def tick(self) -> dict:
        return await wm.background(self.db, now=datetime(2026, 11, 4, 1, 0, tzinfo=timezone.utc))

    async def board(self, who: str = "wm"):
        return await self.http.get(f"/api/v1/team/{self.W}", headers=self.session(who))

    async def person(self, uid_of: str, who: str = "wm"):
        return await self.http.get(f"/api/v1/team/{self.W}/people/{self.uid[uid_of]}", headers=self.session(who))

    def extract_calls(self) -> list[dict]:
        return [c for c in self.fake.calls if c["system"][0]["text"].startswith("You keep a team's memory")]


def _pin_today(test, day: date):
    """Freeze the service's clock (dates in the seeds are fixed)."""
    from unittest import mock

    p = mock.patch.object(wm, "now_utc", lambda: datetime(day.year, day.month, day.day, 12, tzinfo=timezone.utc))
    p.start()
    test.addCleanup(p.stop)


class Due(unittest.TestCase):
    def test_resolve(self):
        b = date(2026, 11, 3)  # Tuesday
        cases = {"by Thursday": "2026-11-05", "early next week": "2026-11-09", "end of month": "2026-11-30",
                 "Nov 12": "2026-11-12", "in 3 days": "2026-11-06", "tomorrow": "2026-11-04", "this week": "2026-11-06",
                 "next Monday": "2026-11-09", "by Tuesday": "2026-11-10", "someday": None}
        for text, want in cases.items():
            got = wm.resolve_due(text, b)
            self.assertEqual(got.isoformat() if got else None, want, text)

    def test_deadline_in_a_sentence(self):
        b = date(2026, 11, 4)  # Wednesday (the meeting's day)
        cases = {
            "Sam Lee will update the pricing page with the new tiers by Friday.": ("2026-11-06", "by Friday"),
            "Ravi will send the deck to the client by EOD": ("2026-11-04", "by EOD"),
            "Priya to share the launch notes by Nov 12": ("2026-11-12", "by Nov 12"),
            "Bo will check with sales by 12 Nov": ("2026-11-12", "by 12 Nov"),
            "Bo will look at the flaky tests next week": ("2026-11-09", "next week"),
            "Ada will follow up with legal early next week.": ("2026-11-09", "early next week"),
            "Ravi to share the draft tomorrow": ("2026-11-05", "tomorrow"),
            "Close the books by the end of the month": ("2026-11-30", "by the end of the month"),
            "Ship v2 by the end of next week": ("2026-11-13", "by the end of next week"),
            "Bo will demo it on Thursday": ("2026-11-05", "on Thursday"),
            "Draft due EOD Friday": ("2026-11-06", "due EOD Friday"),
            "Fix the export in 3 days": ("2026-11-07", "in 3 days"),
            # Hinglish
            "Neha kal tak deck bhej degi": ("2026-11-05", "kal tak"),
            "Amit Monday tak API ready karega": ("2026-11-09", "Monday tak"),
            "Amit agle hafte tak fix karega": ("2026-11-09", "agle hafte tak"),
            "Kiran mahine ke end tak report dega": ("2026-11-30", "mahine ke end tak"),
            "Ravi parso tak review karega": ("2026-11-06", "parso tak"),
            # Not deadlines
            "Sam will review the Monday standup notes": None,
            "Sam may update the pricing page": None,
            "Review today's numbers with finance": None,
            "Ship it once approved by the team": None,
        }
        for text, want in cases.items():
            got = wm.due_in_text(text, b)
            self.assertEqual((got[0].isoformat(), got[1]) if got else None, want, text)
        # The meeting's own "due" wins; the sentence is read when there is none.
        self.assertEqual(wm.free_due("Send the sheet by Friday", "Thursday", b), ("2026-11-05", "Thursday"))
        self.assertEqual(wm.free_due("Send the sheet by Friday", None, b), ("2026-11-06", "by Friday"))
        self.assertEqual(wm.free_due("Send the sheet", None, b), (None, None))
        self.assertEqual(wm.resolve_due("kal tak", b).isoformat(), "2026-11-05")
        self.assertEqual(wm.resolve_due("Friday tak", b).isoformat(), "2026-11-06")

    def test_prefer_dated(self):
        page = {"doc_id": "p", "meeting_id": "m"}
        talk = {"doc_id": "p", "meeting_id": "m", "also": ["t"]}
        undated = {"_id": 1, "kind": "action_item", "text": "will refresh the checklist", "due": None, "sources": [page],
                   "done_at": None}
        dated = {"_id": 2, "kind": "target", "text": "Refresh the checklist", "due": "2026-11-06", "sources": [talk]}
        got = wm.prefer_dated(undated, dated)
        self.assertEqual((got["_id"], got["due"], got["alt_text"]), (2, "2026-11-06", "will refresh the checklist"))
        self.assertEqual(got["sources"], [talk])                       # same meeting: one source
        self.assertIs(wm.prefer_dated(dated, undated), dated)          # already dated: kept
        other = {**undated, "sources": [{"doc_id": "q", "meeting_id": "m2"}]}
        self.assertEqual(len(wm.prefer_dated(other, dated)["sources"]), 2)
        update = {**dated, "kind": "update"}
        self.assertIs(wm.prefer_dated(undated, update), undated)       # only commitments
        self.assertEqual(wm.kind_group("target"), wm.kind_group("action_item"))
        self.assertNotEqual(wm.kind_group("update"), wm.kind_group("action_item"))

    def test_due_of_keeps_sane_model_dates(self):
        b = date(2026, 11, 3)
        self.assertEqual(wm.due_of({"due": "2026-11-05", "due_text": "by Thursday"}, b), "2026-11-05")
        # A model date far off is replaced by the words.
        self.assertEqual(wm.due_of({"due": "2024-01-01", "due_text": "by Thursday"}, b), "2026-11-05")

    def test_parse_facts_bounds(self):
        raw = json.dumps({"facts": [{"person": "Bo", "kind": "working_on", "text": "x " * 400},
                                    {"person": "Bo", "kind": "gossip", "text": "no"},
                                    {"person": "", "kind": "update", "text": "no one"},
                                    {"person": "Bo", "kind": "target", "text": "Ship", "due": "2026-11-05", "cite": "s3"}]})
        got = wm.parse_facts("here: " + raw)
        self.assertEqual([g["kind"] for g in got], ["working_on", "target"])
        self.assertLessEqual(len(got[0]["text"]), wm.MAX_TEXT)
        self.assertEqual((got[1]["due"], got[1]["seg"]), ("2026-11-05", 3))
        self.assertIsNone(wm.parse_facts("no json"))

    def test_match_people(self):
        members = [{"id": "1", "name": "Abhishek Rao"}, {"id": "2", "name": "Bo Chen"}, {"id": "3", "name": "Priya Sharma"}]
        self.assertEqual([m["id"] for m in wm.match_people("What is Abhishek working on?", members, None)], ["1"])
        self.assertEqual([m["id"] for m in wm.match_people("abhishek's status", members, None)], ["1"])
        self.assertEqual([m["id"] for m in wm.match_people("what am I doing", members, "2")], ["2"])
        self.assertEqual([m["id"] for m in wm.match_people("Is Sharma blocked?", members, None)], ["3"])
        self.assertEqual(wm.match_people("what is the team doing", members, None), [])


class Extraction(TeamWorld):
    async def test_off_by_default_and_nothing_extracted(self):
        await self.standup()
        r = await self.board()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["enabled"], False)
        self.assertEqual(r.json()["can_enable"], False)
        r = await self.board("wa")
        self.assertEqual(r.json()["can_enable"], True)
        await self.tick()
        self.assertEqual(self.extract_calls(), [])
        self.assertEqual(await self.db[wm.FACTS].count_documents({}), 0)
        # Members only (viewers too); not a member: 404. Member writes can't switch it (admins only).
        self.assertEqual((await self.board("stranger")).status_code, 404)
        self.assertEqual((await self.board("gv")).status_code, 404)
        r = await self.http.put(f"/api/v1/workspaces/{self.W}", headers=self.session("wm"),
                                json={"settings": {"team_memory": True}})
        self.assertEqual(r.status_code, 403)

    async def test_meeting_facts_with_provenance_and_dates(self):
        _pin_today(self, date(2026, 11, 4))
        await self.turn_on()
        m = await self.standup()
        rep = await self.tick()
        self.assertEqual(rep["done"], 1, rep)
        calls = self.extract_calls()
        self.assertEqual(len(calls), 1)
        sent = prompt_of(calls[0])
        self.assertIn("Date: 2026-11-03 (Tuesday)", sent)
        self.assertIn("<untrusted_meeting>", sent)
        facts = await self.db[wm.FACTS].find({}).to_list(100)
        by = {(f["subject"], f["kind"]): f for f in facts}
        bo = by[(self.uid["wm"], "target")]
        self.assertEqual((bo["due"], bo["text"]), ("2026-11-05", "Ship the sourcing filters"))
        self.assertEqual(bo["sources"][0]["type"], "meeting")
        self.assertEqual(bo["sources"][0]["meeting_id"], m["id"])
        self.assertEqual(bo["sources"][0]["seg"], 2)
        page = await self.doc(m["slug"])
        self.assertEqual(bo["sources"][0]["doc_id"], page["_id"])
        self.assertTrue(bo["sources"][0]["also"])             # the transcript was read: it is needed too
        pr = by[(self.uid["wa"], "blocker")]
        self.assertEqual(pr["waiting_on"], {"id": self.uid["wv"], "name": "Ravi Kumar"})
        self.assertIn((self.uid["owner"], "decision"), by)
        self.assertEqual(by[(self.uid["wm"], "update")]["origin"], "ai")
        # Ledger: one row on the workspace_memory feature, no user.
        rows = await self.db[ai_usage.REQUESTS].find({"feature": "workspace_memory"}).to_list(10)
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["user_id"], rows[0]["visitor"], rows[0]["kind"]), (None, "system", "meeting"))
        # Unchanged: no second call.
        await self.tick()
        self.assertEqual(len(self.extract_calls()), 1)

    async def test_pages_tasks_free_and_debounced(self):
        _pin_today(self, date(2026, 11, 4))
        await self.turn_on()
        wmid = self.uid["wm"]
        content = (f"# Billing\n\n@Bo Chen is rebuilding the invoice export for the finance team this sprint. " + "word " * 50 +
                   f"\n\n- [ ] :person[Bo Chen]{{id=\"{wmid}\"}} send the export spec\n- [x] :person[Bo Chen]{{id=\"{wmid}\"}} done one\n")
        old = datetime(2026, 11, 4, 0, 30, tzinfo=timezone.utc)
        doc = await self.mkdoc("W", owner="owner", content=content, editor="blocks", updated_at=old, grants=False)
        fresh = await self.mkdoc("W", owner="owner", content=content, editor="blocks", grants=False,
                                 updated_at=datetime(2026, 11, 4, 0, 55, tzinfo=timezone.utc))
        enc = await self.mkdoc("W", owner="owner", content="secret " * 80, encrypted=True, updated_at=old, grants=False)
        pw = await self.mkdoc("LP", owner="owner", content="password protected " * 40, updated_at=old, grants=False)
        await self.tick()
        sent = "\n".join(prompt_of(c) for c in self.extract_calls())
        self.assertEqual(len(self.extract_calls()), 1)               # the fresh one waits; encrypted / password never
        self.assertIn(doc["title"], sent)
        self.assertNotIn("secret secret", sent)
        self.assertNotIn("password protected", sent)
        facts = await self.db[wm.FACTS].find({"src_key": f"d:{doc['_id']}"}).to_list(100)
        kinds = sorted((f["kind"], f["origin"]) for f in facts)
        self.assertEqual(kinds, [("action_item", "task"), ("working_on", "ai")])
        self.assertTrue(all(f["subject"] == wmid for f in facts))
        self.assertIsNone(await self.db[wm.SOURCES].find_one({"_id": f"d:{fresh['_id']}"}))
        self.assertIsNone(await self.db[wm.SOURCES].find_one({"_id": f"d:{enc['_id']}"}))
        self.assertIsNone(await self.db[wm.SOURCES].find_one({"_id": f"d:{pw['_id']}"}))

    async def test_cap_pauses_the_job(self):
        await self.turn_on()
        await self.standup()
        settings.workspace_memory_daily_usd = 0.0
        ai_usage.invalidate_settings()
        rep = await self.tick()
        self.assertEqual(rep.get("limit"), "daily")
        self.assertEqual(self.extract_calls(), [])
        self.assertIsNotNone(await wm.paused(self.db))
        settings.workspace_memory_daily_usd = 3.0
        ai_usage.invalidate_settings()
        rep = await self.tick()
        self.assertTrue(rep.get("paused"))                           # until the next UTC day
        self.assertEqual(self.extract_calls(), [])
        r = await self.board("wa")
        self.assertEqual(r.json()["paused"]["reason"], "daily")
        await self.db[wm.STATE].update_one({"_id": "*"}, {"$set": {"paused.until": datetime(2000, 1, 1, tzinfo=timezone.utc)}})
        await self.tick()
        self.assertEqual(len(self.extract_calls()), 1)

    async def test_turning_off_deletes_and_hides(self):
        await self.turn_on()
        await self.standup()
        await self.tick()
        self.assertGreater(await self.db[wm.FACTS].count_documents({}), 0)
        r = await self.http.put(f"/api/v1/team/{self.W}/me/focus", headers=self.session("wm"), json={"text": "Filters"})
        self.assertEqual(r.status_code, 200)
        await self.turn_on(on=False)
        self.assertEqual(await self.db[wm.FACTS].count_documents({}), 0)
        self.assertEqual(await self.db[wm.SOURCES].count_documents({}), 0)
        self.assertEqual((await self.board()).json()["enabled"], False)
        self.assertEqual((await self.person("wm")).status_code, 404)
        self.assertIsNotNone(await self.db[wm.PROFILES].find_one({"user_id": self.uid["wm"]}))   # notes stay
        # MCP and the assistant: nothing.
        token = await self.mcp_token("wm", write=False)
        status, res = await self.mcp_call(token, "get_person_profile", {"workspace": self.W, "person": "Bo"})
        self.assertTrue(res.get("isError"))
        self.assertEqual((await wm.context_for(self.db, *self._ac("wm"), "What is Bo working on?"))["facts"], [])
        # On again: read again from scratch.
        await self.turn_on()
        await self.tick()
        self.assertGreater(await self.db[wm.FACTS].count_documents({}), 0)

    def _ac(self, who: str):
        from app.models.user import User
        from app.services import access

        u = User(id=self.uid[who], email=self.email[who], name=who, created_at=now(), updated_at=now())
        return access.Actor.of(u), access.Ctx(self.db)


class Reading(TeamWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        _pin_today(self, date(2026, 11, 4))
        await self.turn_on()
        self.m = await self.standup()
        await self.tick()

    async def test_board_cards_status_and_targets(self):
        r = await self.board("wv")                                    # a viewer sees the board too
        self.assertEqual(r.status_code, 200, r.text)
        b = r.json()
        cards = {c["id"]: c for c in b["people"]}
        bo = cards[self.uid["wm"]]
        self.assertEqual(bo["status"]["state"], "on_track")
        self.assertEqual([(t["text"], t["due"], t["state"]) for t in bo["targets"]],
                         [("Ship the sourcing filters", "2026-11-05", "due_soon")])
        self.assertEqual(bo["now"]["text"], "Building the sourcing filters")
        self.assertEqual(len(bo["activity"]), 14)
        self.assertEqual(bo["activity"][-2], 4)                       # Nov 3: update, working on, target, action item
        self.assertEqual(bo["open_items"], 2)
        pr = cards[self.uid["wa"]]
        self.assertEqual(pr["status"]["state"], "waiting")
        self.assertEqual(pr["status"]["waiting_on"]["name"], "Ravi Kumar")
        self.assertEqual(b["blockers"][0]["person"]["id"], self.uid["wa"])
        self.assertEqual(cards[self.uid["wv"]]["status"]["state"], "quiet")
        self.assertEqual(b["totals"]["due_week"], 1)
        # Own status wins; "on leave" never reads as quiet.
        r = await self.http.put(f"/api/v1/team/{self.W}/me/status", headers=self.session("wv"),
                                json={"text": "On leave till Monday", "emoji": "🌴",
                                      "until": "2026-11-09T09:00:00Z"})
        self.assertEqual(r.status_code, 200, r.text)
        cards = {c["id"]: c for c in (await self.board()).json()["people"]}
        self.assertEqual((cards[self.uid["wv"]]["status"]["state"], cards[self.uid["wv"]]["status"]["label"]),
                         ("away", "On leave till Monday"))

    async def test_person_profile_links_and_transcript_rule(self):
        r = await self.person("wm", who="wa")
        self.assertEqual(r.status_code, 200, r.text)
        p = r.json()
        self.assertEqual(p["working_on"][0]["text"], "Building the sourcing filters")
        src = p["working_on"][0]["sources"][0]
        self.assertEqual((src["kind"], src["href"], src["date"]), ("meeting", f"/{self.m['slug']}", "2026-11-03"))
        self.assertTrue(src["moment"]["href"].startswith(f"/{self.m['transcript_slug']}#b-t0002"))
        self.assertEqual(p["targets"][0]["due"], "2026-11-05")
        self.assertEqual(p["timeline"][0]["day"], "2026-11-03")
        self.assertEqual(p["meetings"][0]["href"], f"/{self.m['slug']}")
        self.assertFalse(p["working_on"][0]["can_correct"])          # not about Priya
        # The transcript restricted on its own: lines that needed it are gone for others.
        t = await self.doc(self.m["transcript_slug"])
        await self.db["documents"].update_one({"_id": t["_id"]}, {"$set": {"access_level": "private", "access_inherit": False}})
        p = (await self.person("wm", who="wa")).json()
        self.assertEqual(p["working_on"], [])

    async def test_restricted_meeting_private_page_and_trash(self):
        r = await self.http.patch(f"/api/v1/meetings/{self.m['id']}", headers=self.session("owner"), json={"restricted": True})
        self.assertEqual(r.status_code, 200, r.text)
        # Ravi (a viewer, only named in it) isn't in its audience; Priya (she spoke) is.
        rv = json.dumps((await self.board("wv")).json())
        self.assertNotIn("sourcing filters", rv)
        self.assertNotIn("API keys", rv)
        self.assertEqual((await self.person("wm", who="wv")).json()["working_on"], [])
        ra = json.dumps((await self.board("wa")).json())
        self.assertIn("sourcing filters", ra)
        # The assistant context and MCP for Ravi: nothing from it.
        got = await wm.context_for(self.db, *Extraction._ac(self, "wv"), "What is Bo working on?")
        self.assertEqual(got["facts"], [])
        token = await self.mcp_token("wv", write=False)
        _s, res = await self.mcp_call(token, "get_person_profile", {"workspace": self.W, "person": "Bo"})
        self.assertNotIn("sourcing", json.dumps(res).lower())
        # A private page: only its owner sees what it said.
        wmid = self.uid["wm"]
        old = datetime(2026, 11, 3, 20, tzinfo=timezone.utc)
        priv = await self.mkdoc("P", owner="wa", grants=False, editor="blocks", updated_at=old,
                                content="# Plan\n\n@Bo Chen is drafting the secret pricing memo. " + "word " * 60)
        await self.tick()
        self.assertIn("secret pricing memo", json.dumps((await self.person("wm", who="wa")).json()))
        self.assertNotIn("secret pricing memo", json.dumps((await self.person("wm", who="wm")).json()))
        # Trash: gone for everyone, its owner too.
        await self.db["documents"].update_one({"_id": priv["_id"]}, {"$set": {"deleted_at": now()}})
        self.assertNotIn("secret pricing memo", json.dumps((await self.person("wm", who="wa")).json()))
        self.assertIsNotNone(wmid)

    async def test_hide_and_correct_survive_reextraction(self):
        p = (await self.person("wm", who="wm")).json()
        line = p["working_on"][0]
        self.assertTrue(line["can_correct"])
        # Someone else can't.
        r = await self.http.post(f"/api/v1/team/{self.W}/facts/{line['id']}/hide", headers=self.session("wa"))
        self.assertEqual(r.status_code, 403)
        r = await self.http.post(f"/api/v1/team/{self.W}/facts/{line['id']}/hide", headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((await self.person("wm", who="wa")).json()["working_on"], [])
        mine = (await self.person("wm", who="wm")).json()
        self.assertEqual([h["text"] for h in mine["hidden"]], ["Building the sourcing filters"])
        # Correct the update.
        up = next(x for x in mine["updates"] if x["kind"] == "update")
        r = await self.http.post(f"/api/v1/team/{self.W}/facts/{up['id']}/correct", headers=self.session("wm"),
                                 json={"text": "Finished the Lever import, not Greenhouse"})
        self.assertEqual(r.status_code, 200, r.text)
        seen = (await self.person("wm", who="wa")).json()
        self.assertEqual(seen["updates"][0]["text"], "Finished the Lever import, not Greenhouse")
        self.assertTrue(seen["updates"][0]["corrected"])
        # Re-extract the meeting (it changed): still hidden, still corrected, and the model was told.
        await self.db["meetings"].update_one({"_id": ObjectId(self.m["id"])}, {"$set": {"updated_at": now(), "title": "Sourcing standup!"}})
        n = len(self.extract_calls())
        await self.tick()
        self.assertEqual(len(self.extract_calls()), n + 1)
        self.assertIn("Finished the Lever import", prompt_of(self.extract_calls()[-1]))
        self.assertEqual((await self.person("wm", who="wa")).json()["working_on"], [])
        self.assertEqual((await self.person("wm", who="wa")).json()["updates"][0]["text"], "Finished the Lever import, not Greenhouse")
        # Undo.
        new_id = (await self.person("wm", who="wm")).json()["hidden"][0]["id"]
        r = await self.http.delete(f"/api/v1/team/{self.W}/facts/{new_id}/hide", headers=self.session("wm"))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len((await self.person("wm", who="wa")).json()["working_on"]), 1)
        # "This is wrong" without a better version: gone for others.
        up2 = (await self.person("wm", who="wm")).json()["working_on"][0]
        await self.http.post(f"/api/v1/team/{self.W}/facts/{up2['id']}/correct", headers=self.session("wm"), json={})
        self.assertEqual((await self.person("wm", who="wa")).json()["working_on"], [])

    async def test_focus_note_tops_the_card(self):
        r = await self.http.put(f"/api/v1/team/{self.W}/me/focus", headers=self.session("wm"),
                                json={"text": "Shipping the sourcing filters this week"})
        self.assertEqual(r.status_code, 200)
        cards = {c["id"]: c for c in (await self.board("wa")).json()["people"]}
        self.assertEqual(cards[self.uid["wm"]]["now"], {**cards[self.uid["wm"]]["now"], "text": "Shipping the sourcing filters this week", "focus": True})

    async def test_consolidation_clusters_and_decays(self):
        # The same "working on" said again a day later joins the first one's cluster.
        m2 = await self.standup(date="2026-11-04", title="Sourcing standup 2")
        await self.db["meetings"].update_one({"_id": ObjectId(m2["id"])}, {"$set": {"title": "Sourcing standup (Wed)"}})
        await self.tick()
        rows = await self.db[wm.FACTS].find({"subject": self.uid["wm"], "kind": "working_on"}).to_list(10)
        self.assertEqual(len(rows), 2)
        self.assertEqual(len({r["cluster"] for r in rows}), 1)
        p = (await self.person("wm", who="wa")).json()
        self.assertEqual(len(p["working_on"]), 1)                     # one line per cluster, the newest
        self.assertEqual(p["working_on"][0]["day"], "2026-11-04")
        # 20 days later nobody said it again: stale, and the card goes quiet.
        later = datetime(2026, 11, 24, 3, tzinfo=timezone.utc)
        await wm.consolidate(self.db, self.W, now=later)
        rows = await self.db[wm.FACTS].find({"subject": self.uid["wm"], "kind": "working_on"}).to_list(10)
        self.assertEqual({r["status"] for r in rows}, {"stale"})

    async def test_project_page_and_mcp(self):
        await self.standup(date="2026-11-04", title="Sourcing standup 2")
        await self.tick()
        b = (await self.board("wa")).json()
        self.assertEqual([p["name"] for p in b["projects"]], ["Sourcing"])
        self.assertEqual(b["lanes"][0]["key"], "sourcing")
        r = await self.http.get(f"/api/v1/team/{self.W}/projects/sourcing", headers=self.session("wa"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("The beta goes to Senseloaf first", json.dumps(r.json()["decisions"]))
        token = await self.mcp_token("wa", write=False)
        _s, res = await self.mcp_call(token, "get_project_status", {"workspace": self.W, "project": "sourcing"})
        self.assertFalse(res.get("isError"), res)
        self.assertIn("Sourcing", res["content"][0]["text"])
        _s, res = await self.mcp_call(token, "get_person_profile", {"workspace": self.W, "person": "Bo"})
        self.assertFalse(res.get("isError"), res)
        sc = res["structuredContent"]
        self.assertEqual(sc["name"], "Bo Chen")
        self.assertEqual(sc["targets"][0]["due"], "2026-11-05")
        self.assertTrue(sc["working_on"][0]["sources"][0]["url"].startswith("http"))
        _s, res = await self.mcp_call(token, "list_team", {"workspace": self.W})
        self.assertFalse(res.get("isError"), res)
        self.assertIn("Bo Chen", res["content"][0]["text"])

    async def test_assistant_hook_names_the_right_person(self):
        got = await wm.context_for(self.db, *Extraction._ac(self, "wa"), "What is Bo working on?")
        self.assertEqual([p["name"] for p in got["people"]], ["Bo Chen"])
        self.assertTrue(all(f["subject"] == self.uid["wm"] for f in got["facts"]))
        self.assertIn("sourcing filters", " ".join(f["text"] for f in got["facts"]).lower())
        got = await wm.context_for(self.db, *Extraction._ac(self, "wm"), "what am I working on")
        self.assertEqual([p["id"] for p in got["people"]], [self.uid["wm"]])
        got = await wm.context_for(self.db, *Extraction._ac(self, "wa"), "who is working on the sourcing filters?")
        self.assertIn(self.uid["wm"], {f["subject"] for f in got["facts"]})
        # Ask Markdrop: the meeting comes first with the facts as its excerpt, and is cited.
        r = await self.http.post("/api/v1/ask", headers=self.session("wa"), json={"question": "What is Bo Chen working on?"})
        self.assertEqual(r.status_code, 200, r.text)
        answer_calls = [c for c in self.fake.calls if c["system"][0]["text"].startswith("You are Ask, the assistant")]
        self.assertTrue(answer_calls)
        sent = prompt_of(answer_calls[-1])
        self.assertIn("Team memory", sent)
        self.assertIn("Bo Chen — Working on [Sourcing]", sent)
        first = re.search(r'<untrusted_document n="1"[^>]*>', sent).group(0)
        self.assertIn("Sourcing standup", first)


class Extras(TeamWorld):
    """Groups and the weekly summary (services/team_extras.py)."""

    async def asyncSetUp(self):
        await super().asyncSetUp()
        from app.services import team_extras

        await team_extras.ensure_indexes(self.db)
        _pin_today(self, date(2026, 11, 4))
        await self.turn_on()
        self.m = await self.standup()
        self.m2 = await self.standup(date="2026-11-04", title="Sourcing standup 2")
        await self.tick()

    async def test_ask_suggestions_get_active_projects(self):
        from app.services import ask_suggestions

        src = await ask_suggestions.team_sources(self.db, self.W, now=datetime(2026, 11, 5, 12, tzinfo=timezone.utc))
        self.assertEqual([p["name"] for p in src["projects"]], ["Sourcing"])
        self.assertIn("Project: Sourcing", ask_suggestions.source_text(src))
        # Restricted meetings don't count (team-visible only); Team memory off: none.
        await self.db["meetings"].update_many({}, {"$set": {"restricted": True}})
        src = await ask_suggestions.team_sources(self.db, self.W, now=datetime(2026, 11, 5, 12, tzinfo=timezone.utc))
        self.assertEqual(src["projects"], [])
        await self.db["meetings"].update_many({}, {"$set": {"restricted": False}})
        await self.turn_on(on=False)
        src = await ask_suggestions.team_sources(self.db, self.W, now=datetime(2026, 11, 5, 12, tzinfo=timezone.utc))
        self.assertEqual(src["projects"], [])

    async def test_groups_admins_only_and_suggested_from_series(self):
        r = await self.http.post(f"/api/v1/team/{self.W}/groups", headers=self.session("wm"),
                                 json={"name": "Sourcing team", "member_ids": [self.uid["wm"]]})
        self.assertEqual(r.status_code, 403)
        await self.db["meetings"].update_many({}, {"$set": {"series": "Sourcing standup"}})
        r = await self.http.get(f"/api/v1/team/{self.W}/groups", headers=self.session("wa"))
        sug = r.json()["suggestions"]
        self.assertEqual(sug[0]["name"], "Sourcing standup")
        self.assertEqual(set(sug[0]["member_ids"]), {self.uid["wm"], self.uid["wa"], self.uid["owner"]})
        self.assertEqual(r.json()["groups"], [])
        r = await self.http.post(f"/api/v1/team/{self.W}/groups", headers=self.session("wa"),
                                 json={"name": "Sourcing team", "member_ids": [self.uid["wm"], self.uid["stranger"]]})
        self.assertEqual(r.status_code, 200, r.text)
        g = r.json()
        self.assertEqual(g["member_ids"], [self.uid["wm"]])          # not a member: dropped
        r = await self.http.post(f"/api/v1/team/{self.W}/groups", headers=self.session("wa"), json={"name": "sourcing TEAM"})
        self.assertEqual(r.status_code, 409)
        b = (await self.board("wv")).json()
        self.assertEqual([x["name"] for x in b["groups"]], ["Sourcing team"])
        cards = {c["id"]: c for c in b["people"]}
        self.assertEqual(cards[self.uid["wm"]]["groups"], [g["id"]])
        self.assertFalse(b["can_manage"])
        r = await self.http.delete(f"/api/v1/team/{self.W}/groups/{g['id']}", headers=self.session("wa"))
        self.assertEqual(r.status_code, 200)

    async def test_weekly_summary_team_visible_only(self):
        from unittest import mock

        from app.services import mailer, slack, slack_api, team_extras

        # A restricted 1:1 with a blocker nobody else may see.
        r = await self.http.patch(f"/api/v1/meetings/{self.m['id']}", headers=self.session("owner"), json={"restricted": True})
        self.assertEqual(r.status_code, 200)
        await self.db["workspaces"].update_one({"_id": ObjectId(self.W)}, {"$set": {"settings.timezone": "Asia/Kolkata"}})
        ws = await wm.ws_info(self.db, self.W)
        monday_early = datetime(2026, 11, 9, 3, 0, tzinfo=timezone.utc)      # 08:30 in Kolkata
        monday = datetime(2026, 11, 9, 4, 0, tzinfo=timezone.utc)            # 09:30 in Kolkata
        self.assertFalse(await team_extras.weekly_due(self.db, ws, monday_early))
        self.assertTrue(await team_extras.weekly_due(self.db, ws, monday))
        sent, posted = [], []

        async def fake_post(payload, *, kind, ref=None):
            sent.append((payload, kind))
            return "sent"

        async def fake_call(method, token, **kw):
            posted.append((method, kw))
            return {"ok": True, "ts": "1"}

        with mock.patch.object(mailer, "_post", fake_post), mock.patch.object(mailer, "is_configured", lambda: True), \
                mock.patch.object(slack, "install_for_workspace", mock.AsyncMock(return_value={"_id": "T1", "meetings_channel": {"id": "C1"}})), \
                mock.patch.object(slack, "bot_token", lambda inst: "xoxb-test"), mock.patch.object(slack_api, "call", fake_call):
            self.extract_reply = None
            n = await team_extras.background(self.db, [ws], monday)
            self.assertEqual(n, 1)
            self.assertEqual(await team_extras.background(self.db, [ws], monday), 0)     # once a week
        row = await self.db[team_extras.WEEKLY].find_one({})
        self.assertEqual(row["week"], "2026-W46")
        everything = json.dumps({k: row[k] for k in ("highlights", "blockers", "due", "overdue")}, default=str)
        self.assertIn("sourcing filters", everything.lower())                 # from standup 2 (team-visible)
        # Nothing sourced from the restricted standup (its lines also said in standup 2 cite standup 2).
        self.assertNotIn(self.m["transcript_slug"], everything)
        self.assertIn(self.m2["transcript_slug"], everything)
        self.assertEqual(posted[0][0], "chat.postMessage")
        self.assertEqual(posted[0][1]["channel"], "C1")
        to = sorted(p["to"][0] for p, _k in sent)
        self.assertEqual(to, sorted([self.email["wa"], self.email["wo"]]))
        self.assertTrue(all(k == "digest" for _p, k in sent))
        # The card is about the current week: in W46 it carries the sent summary; a week later it is live.
        _pin_today(self, date(2026, 11, 10))
        b = (await self.board("wv")).json()
        self.assertEqual(b["this_week"]["week"], "2026-W46")
        self.assertEqual((b["this_week"]["from"], b["this_week"]["to"]), ("2026-11-09", "2026-11-15"))
        self.assertFalse(b["this_week"]["live"])
        self.assertNotIn(self.m["transcript_slug"], json.dumps(b["this_week"]))


class ThisWeek(TeamWorld):
    """The "This week" card's rules (team_extras.compose): Mon–Sun in the workspace's timezone; highlights
    spread across people; due = this week; overdue = the last 14 days; done items never show."""

    async def asyncSetUp(self):
        await super().asyncSetUp()
        from app.services import team_extras

        await team_extras.ensure_indexes(self.db)
        _pin_today(self, date(2026, 11, 4))                  # a Wednesday
        await self.turn_on()
        self.m = await self.standup()
        self.m2 = await self.standup(date="2026-11-04", title="Sourcing standup 2")
        await self.tick()
        self.proto = await self.db[wm.FACTS].find_one({"sources.meeting_id": self.m2["id"]})
        self.assertIsNotNone(self.proto)

    async def fact(self, who: str, kind: str, text: str, *, when: datetime | None = None, due: str | None = None,
                   **extra) -> str:
        _id = ObjectId()
        await self.db[wm.FACTS].insert_one({
            **{k: self.proto[k] for k in ("workspace_id", "sources", "subject_type", "origin", "confidence", "src_key")},
            "_id": _id, "subject": self.uid[who], "kind": kind, "text": text, "norm": wm.norm(text), "cluster": str(_id),
            "when": when or datetime(2026, 11, 4, 9, tzinfo=timezone.utc), "due": due, "status": "active",
            "hidden": False, "correction": None, "project": None, **extra})
        return str(_id)

    async def compose(self, tz: str = "UTC", now: datetime | None = None):
        from app.services import team_extras

        ws = await wm.ws_info(self.db, self.W)
        return await team_extras.compose(self.db, ws, team_extras.tz_of(tz),
                                         now or datetime(2026, 11, 4, 12, tzinfo=timezone.utc), ai=False)

    def test_week_bounds(self):
        from app.services import team_extras

        self.assertEqual(team_extras.week_bounds(date(2026, 11, 4)), (date(2026, 11, 2), date(2026, 11, 8)))
        self.assertEqual(team_extras.week_bounds(date(2026, 11, 2)), (date(2026, 11, 2), date(2026, 11, 8)))
        self.assertEqual(team_extras.week_bounds(date(2026, 11, 8)), (date(2026, 11, 2), date(2026, 11, 8)))

    async def test_week_window_follows_the_timezone(self):
        # Sunday 20:00 UTC is already Monday in Kolkata: a new week there, still the old one in UTC.
        late_sunday = datetime(2026, 11, 8, 20, tzinfo=timezone.utc)
        utc = await self.compose("UTC", late_sunday)
        ist = await self.compose("Asia/Kolkata", late_sunday)
        self.assertEqual((utc["from"], utc["to"], utc["week"]), ("2026-11-02", "2026-11-08", "2026-W45"))
        self.assertEqual((ist["from"], ist["to"], ist["week"]), ("2026-11-09", "2026-11-15", "2026-W46"))
        await self.fact("wm", "target", "Close the Q4 hiring plan", due="2026-11-09")
        utc = await self.compose("UTC", late_sunday)
        ist = await self.compose("Asia/Kolkata", late_sunday)
        self.assertNotIn("Close the Q4 hiring plan", [x["text"] for x in utc["due"]])
        self.assertIn("Close the Q4 hiring plan", [x["text"] for x in ist["due"]])

    async def test_due_overdue_and_stale(self):
        await self.fact("wm", "target", "Due friday item", due="2026-11-06")
        await self.fact("wm", "target", "Due monday item", due="2026-11-02")          # this week, already late
        await self.fact("wa", "action_item", "Ten days late item", due="2026-10-25")
        await self.fact("wa", "action_item", "Twenty days late item", due="2026-10-15")  # stale
        await self.fact("wa", "target", "Next week item", due="2026-11-12")
        s = await self.compose()
        due = {x["text"]: x for x in s["due"]}
        over = {x["text"]: x for x in s["overdue"]}
        self.assertIn("Due friday item", due)
        self.assertIn("Due monday item", due)
        self.assertEqual(due["Due monday item"]["days"], -2)
        self.assertEqual(list(over), ["Ten days late item"])
        self.assertEqual(over["Ten days late item"]["days"], -10)
        self.assertEqual(over["Ten days late item"]["person"]["name"], "Priya Sharma")
        self.assertNotIn("Next week item", due)
        # Stale ones stay on the person's page.
        r = await self.person("wa", who="wa")
        self.assertIn("Twenty days late item", [t["text"] for t in r.json()["targets"]])

    async def test_done_items_never_show(self):
        fid = await self.fact("wm", "target", "Send the export spec", due="2026-11-05")
        other = await self.fact("wa", "action_item", "Review the pricing page", due="2026-10-30")
        s = await self.compose()
        self.assertIn("Send the export spec", [x["text"] for x in s["due"]])
        self.assertIn("Review the pricing page", [x["text"] for x in s["overdue"]])
        # Only its person may mark it done.
        r = await self.http.post(f"/api/v1/team/{self.W}/facts/{fid}/done", headers=self.session("wa"))
        self.assertEqual(r.status_code, 403)
        r = await self.http.post(f"/api/v1/team/{self.W}/facts/{fid}/done", headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        s = await self.compose()
        self.assertNotIn("Send the export spec", [x["text"] for x in s["due"]])
        p = (await self.person("wm", who="wm")).json()
        self.assertNotIn("Send the export spec", [t["text"] for t in p["targets"]])
        # The mark survives the source being read again.
        await self.db[wm.FACTS].update_many({"_id": ObjectId(fid)}, {"$set": {"done_at": None}})
        f = await self.db[wm.FACTS].find_one({"_id": ObjectId(fid)})
        await wm._write_facts(self.db, self.W, "test:redo", [{**{k: f[k] for k in ("subject", "kind", "text", "due")}, "origin": "ai"}],
                              when=f["when"], source=f["sources"][0], members=await wm.members_of(self.db, self.W))
        again = await self.db[wm.FACTS].find_one({"src_key": "test:redo"})
        self.assertIsNotNone(again["done_at"])
        r = await self.http.delete(f"/api/v1/team/{self.W}/facts/{fid}/done", headers=self.session("wm"))
        self.assertEqual(r.status_code, 200)
        # Ticked on its meeting page (- [x]): done too.
        page = await self.db["documents"].find_one({"_id": self.proto["sources"][0]["doc_id"]})
        await self.db["documents"].update_one({"_id": page["_id"]}, {"$set": {
            "content": (page.get("content") or "") + "\n\n- [x] Review the pricing page\n"}})
        s = await self.compose()
        self.assertNotIn("Review the pricing page", [x["text"] for x in s["overdue"]])
        # Not for a decision.
        dec = await self.fact("wm", "decision", "Annual plans get twenty percent off")
        r = await self.http.post(f"/api/v1/team/{self.W}/facts/{dec}/done", headers=self.session("wm"))
        self.assertEqual(r.status_code, 422)

    async def test_ticked_page_task_is_done(self):
        wmid = self.uid["wm"]
        content = f"# Billing\n\n- [ ] :person[Bo Chen]{{id=\"{wmid}\"}} send the invoice export\n"
        doc = await self.mkdoc("W", owner="owner", content=content, editor="blocks", grants=False,
                               updated_at=datetime(2026, 11, 2, 9, tzinfo=timezone.utc))
        fid = await self.fact("wm", "target", "@Bo Chen send the invoice export", due="2026-11-06",
                              sources=[{"type": "page", "doc_id": doc["_id"]}])
        s = await self.compose()
        self.assertIn(fid, [x["id"] for x in s["due"]])
        await self.db["documents"].update_one({"_id": doc["_id"]}, {"$set": {"content": content.replace("- [ ]", "- [x]")}})
        s = await self.compose()
        self.assertNotIn(fid, [x["id"] for x in s["due"]])

    async def test_highlights_this_week_spread_and_capped(self):
        old = datetime(2026, 10, 20, 9, tzinfo=timezone.utc)
        await self.fact("wa", "update", "Old July launch note from last month", when=old)
        for i, t in enumerate(["Shipped the talent pool import", "Finished the talent pool filters",
                               "Released talent pool search", "Working on talent pool export"]):
            await self.fact("owner", "update", t, when=datetime(2026, 11, 3, 9 + i, tzinfo=timezone.utc))
        await self.fact("owner", "update", "Shipped the talent pool import!", when=datetime(2026, 11, 3, 15, tzinfo=timezone.utc))
        await self.fact("wa", "decision", "We use Stripe Checkout", when=datetime(2026, 11, 3, 10, tzinfo=timezone.utc))
        s = await self.compose()
        self.assertEqual(s["window"], "week")
        texts = [h["text"] for h in s["highlights"]]
        self.assertNotIn("Old July launch note from last month", texts)
        per: dict[str, int] = {}
        for h in s["highlights"]:
            per[h["person"]["id"]] = per.get(h["person"]["id"], 0) + 1
            self.assertFalse(h["text"].startswith(h["person"]["name"]))       # no "Name: " prefix
        self.assertTrue(all(n <= 2 for n in per.values()), per)
        self.assertGreaterEqual(len(per), 2)                                   # spread across people
        self.assertEqual(sum(1 for t in texts if t.startswith("Shipped the talent pool import")), 1)   # no near-duplicates
        self.assertIn("We use Stripe Checkout", texts)
        # Nothing this week yet (a Monday morning): the last 7 days instead.
        s = await self.compose(now=datetime(2026, 11, 9, 0, 30, tzinfo=timezone.utc))
        self.assertEqual(s["window"], "last7")
        self.assertTrue(s["highlights"])

    async def test_card_access_team_visible_only(self):
        # A restricted meeting's lines never reach the card, for anyone.
        r = await self.http.patch(f"/api/v1/meetings/{self.m2['id']}", headers=self.session("owner"), json={"restricted": True})
        self.assertEqual(r.status_code, 200)
        await self.fact("wm", "target", "Secret restricted target", due="2026-11-06")    # sourced from m2
        for who in ("owner", "wm", "wv"):
            b = (await self.board(who)).json()
            self.assertNotIn("Secret restricted target", json.dumps(b.get("this_week")), who)
        # The person it is about still sees it on their own page (they were in the meeting).
        p = (await self.person("wm", who="owner")).json()
        self.assertIn("Secret restricted target", [t["text"] for t in p["targets"]])


class GeminiDates(TeamWorld):
    """Gemini's "Suggested next steps" reach Team with the deadline their words give ("by Friday", "kal
    tak"), resolved against the meeting's day, and so the "This week" card; a near-duplicate the model
    found with a date keeps it (the dated line wins); facts recorded before get their date nightly."""

    async def asyncSetUp(self):
        await super().asyncSetUp()
        from app.services import team_extras

        await team_extras.ensure_indexes(self.db)
        _pin_today(self, date(2026, 11, 4))                  # a Wednesday
        await self.turn_on()
        self.m = await self.standup(date="2026-11-04", title="Pricing sync")
        await self.tick()
        self.extract_reply = json.dumps({"facts": []})

    async def gemini_steps(self, steps: list[str]):
        from app.services import meeting_memory

        await self.db["meetings"].update_one({"_id": ObjectId(self.m["id"])}, {"$set": {"notes": {"next_steps": steps}}})
        await meeting_memory.sync_meeting(self.db, self.m["id"])

    async def extract(self) -> dict:
        ws = await wm.ws_info(self.db, self.W)
        row = await self.db["meetings"].find_one({"_id": ObjectId(self.m["id"])})
        return await wm.extract_meeting(self.db, ws, row, await wm.members_of(self.db, self.W))

    async def mine(self, who: str, needle: str) -> list[dict]:
        return [f for f in await self.db[wm.FACTS].find({"subject": self.uid[who], "src_key": f"m:{self.m['id']}"}).to_list(100)
                if needle in f["text"].lower()]

    async def test_next_steps_with_deadlines_reach_this_week(self):
        await self.gemini_steps(["Bo Chen <bo@acme.test> will update the pricing page with the new tiers by Friday.",
                                 "Priya Sharma kal tak pricing deck bhej degi",
                                 "Ravi Kumar will think about the FAQ"])
        await self.extract()
        bo = (await self.mine("wm", "pricing page"))[0]
        self.assertEqual((bo["kind"], bo["due"], bo["due_text"], bo["origin"]),
                         ("target", "2026-11-06", "by Friday", "meeting_fact"))
        pr = (await self.mine("wa", "deck"))[0]
        self.assertEqual((pr["kind"], pr["due"], pr["due_text"]), ("target", "2026-11-05", "kal tak"))
        rv = (await self.mine("wv", "faq"))[0]
        self.assertEqual((rv["kind"], rv["due"]), ("action_item", None))
        b = (await self.board("wv")).json()
        due = {x["text"]: x for x in b["this_week"]["due"]}
        self.assertIn("will update the pricing page with the new tiers by Friday.", due)
        self.assertEqual(due["will update the pricing page with the new tiers by Friday."]["due"], "2026-11-06")
        self.assertEqual(due["will update the pricing page with the new tiers by Friday."]["person"]["id"], self.uid["wm"])
        self.assertIn("kal tak pricing deck bhej degi", due)
        cards = {c["id"]: c for c in b["people"]}
        self.assertIn("2026-11-06", [t["due"] for t in cards[self.uid["wm"]]["targets"]])
        self.assertGreaterEqual(b["totals"]["week_due"], 2)

    async def test_the_dated_duplicate_wins(self):
        await self.gemini_steps(["Bo Chen will refresh the onboarding checklist for the pilot"])
        self.extract_reply = json.dumps({"facts": [
            {"person": "Bo Chen", "kind": "target", "text": "Refresh the onboarding checklist for the pilot",
             "due": None, "due_text": "by Friday", "cite": "s2", "confidence": 0.9}]})
        await self.extract()
        rows = await self.mine("wm", "checklist")
        self.assertEqual(sorted((r["origin"], r["due"]) for r in rows), [("ai", "2026-11-06"), ("meeting_fact", None)])
        self.assertEqual(len({r["cluster"] for r in rows}), 1)       # one commitment
        self.assertEqual(len({r["norm"] for r in rows}), 1)          # one correction key
        ai = next(r for r in rows if r["origin"] == "ai")
        self.assertTrue(ai["sources"][0].get("also"))               # the date came from the call
        # Board, person page and This week: one line, the dated one, with both sources.
        b = (await self.board("wa")).json()
        lines = [x for x in b["this_week"]["due"] if "checklist" in x["text"].lower()]
        self.assertEqual([(x["id"], x["due"]) for x in lines], [(str(ai["_id"]), "2026-11-06")])
        p = (await self.person("wm", who="wa")).json()
        self.assertEqual([t["due"] for t in p["targets"] if "checklist" in t["text"].lower()], ["2026-11-06"])
        self.assertEqual([a for a in p["action_items"] if "checklist" in a["text"].lower()], [])
        # Someone who can't open the transcript (where the date was said) gets the undated line.
        t = await self.doc(self.m["transcript_slug"])
        await self.db["documents"].update_one({"_id": t["_id"]}, {"$set": {"access_level": "private", "access_inherit": False}})
        p = (await self.person("wm", who="wa")).json()
        self.assertEqual([t["due"] for t in p["targets"] if "checklist" in t["text"].lower()], [])
        self.assertEqual(len([a for a in p["action_items"] if "checklist" in a["text"].lower()]), 1)
        await self.db["documents"].update_one({"_id": t["_id"]}, {"$set": {"access_level": "workspace", "access_inherit": True}})
        # Hiding the line hides its twin too (one correction key).
        r = await self.http.post(f"/api/v1/team/{self.W}/facts/{ai['_id']}/hide", headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        p = (await self.person("wm", who="wa")).json()
        self.assertFalse([x for x in p["targets"] + p["action_items"] if "checklist" in x["text"].lower()])
        # A model match that already had its own deadline adds nothing.
        await self.gemini_steps(["Bo Chen will send the pricing FAQ by Thursday"])
        self.extract_reply = json.dumps({"facts": [
            {"person": "Bo Chen", "kind": "target", "text": "Send the pricing FAQ", "due_text": "by Friday", "cite": "s2"}]})
        await self.extract()
        rows = await self.mine("wm", "faq")
        self.assertEqual([(r["origin"], r["due"]) for r in rows], [("meeting_fact", "2026-11-05")])

    async def test_recorded_before_get_their_date_nightly(self):
        await self.gemini_steps(["Bo Chen will update the pricing page by Friday", "Priya Sharma Monday tak deck ready karegi",
                                 "Ravi Kumar will think about the FAQ"])
        await self.extract()
        # As recorded before the fix: no due date.
        await self.db[wm.FACTS].update_many({"origin": "meeting_fact"}, {"$set": {"due": None, "due_text": None,
                                                                              "kind": "action_item"}})
        rep = await wm.consolidate(self.db, self.W, now=datetime(2026, 11, 5, 3, tzinfo=timezone.utc))
        self.assertEqual(rep["dated"], 2)
        bo = (await self.mine("wm", "pricing page"))[0]
        self.assertEqual((bo["kind"], bo["due"], bo["due_text"]), ("target", "2026-11-06", "by Friday"))
        pr = (await self.mine("wa", "deck"))[0]
        self.assertEqual((pr["kind"], pr["due"]), ("target", "2026-11-09"))
        self.assertIsNone((await self.mine("wv", "faq"))[0]["due"])
        # Idempotent.
        rep = await wm.consolidate(self.db, self.W, now=datetime(2026, 11, 6, 3, tzinfo=timezone.utc))
        self.assertEqual(rep["dated"], 0)
        b = (await self.board("wv")).json()
        self.assertIn("will update the pricing page by Friday", [x["text"] for x in b["this_week"]["due"]])


if __name__ == "__main__":
    unittest.main()
