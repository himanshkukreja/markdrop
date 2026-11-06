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
        answer_calls = [c for c in self.fake.calls if c["system"][0]["text"].startswith("You are Ask Markdrop")]
        self.assertTrue(answer_calls)
        sent = prompt_of(answer_calls[-1])
        self.assertIn("Team memory", sent)
        self.assertIn("Bo Chen — Working on [Sourcing]", sent)
        first = re.search(r'<untrusted_document n="1"[^>]*>', sent).group(0)
        self.assertIn("Sourcing standup", first)


if __name__ == "__main__":
    unittest.main()
