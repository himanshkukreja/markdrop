"""AI quality stage 4 (.work/briefs/ai-quality-phase2.md): one engine for ⌘K and Slack (services/ask_surfaces.py),
person cards (person_cards.py), "what changed since I last looked" (what_changed.py) and "who knows about X"
(who_knows.py), with their routes, Ask hooks and MCP tools.

Access first: a card never names a private team or a document the reader can't open, a stranger gets no card, the
changes list only readable items (a private team's page, a private document, comments on items the reader can't open
never show — not as a row, a count or a title), a team they can't open is a 404, and ⌘K / Slack answers only ever send
what the asker can read.
"""

from __future__ import annotations

import json
import unittest
from datetime import timedelta

from tests._access_env import now
from tests.test_ai_index import IndexWorld
from tests.test_pages_ai import parse_sse, prompt_of
from tests.test_ask_markdrop import is_ask

from app.config import get_settings
from app.services import ai_index, ai_usage, ask_markdrop, ask_surfaces, what_changed, who_knows

settings = get_settings()


class Helpers(unittest.TestCase):
    def test_flat_labels_and_stream(self):
        self.assertEqual(ask_surfaces.flat("Said here [3-s12] and [3-s14], see [3]. Also [4]."), "Said here [3] and [3], see [3]. Also [4].")
        self.assertEqual(ask_surfaces.flat("x [2-s1][2-s3] y"), "x [2] y")
        st = ask_surfaces._Stream()
        out = st.push("Shipped [1") + st.push("2-s4") + st.push("] today [3") + st.end()
        self.assertEqual(out, "Shipped [12] today [3")

    def test_card_item_text_without_its_owner(self):
        from app.services import person_cards

        self.assertEqual(person_cards._own("Riya Sharma Draft the pilot proposal", "Riya Sharma"), "Draft the pilot proposal")
        self.assertEqual(person_cards._own("Bo Chen: write the spec", "Bo Chen"), "Write the spec")
        self.assertEqual(person_cards._own("Write the spec", "Bo Chen"), "Write the spec")

    def test_mrkdwn(self):
        self.assertEqual(ask_surfaces.mrkdwn("## Status\n**Seven**: done\n- one\n  - two"), "*Status*\n*Seven*: done\n• one\n  • two")

    def test_intents(self):
        for q in ("What changed since I last looked?", "anything new since my last visit", "what's new since I was here"):
            self.assertEqual(ask_markdrop.detect_intent(q), "what_changed", q)
        self.assertEqual(ask_markdrop.detect_intent("What changed this week?"), "catch_up")
        for q in ("Who knows about index sharding?", "who should I talk to about the Globex renewal",
                  "Who's the expert on billing?", "who has been working on SSO?"):
            self.assertTrue(who_knows.is_expert_question(q), q)
        self.assertFalse(who_knows.is_expert_question("What does Arjun know about sharding?"))


class Stage4(IndexWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await what_changed.ensure_indexes(self.db)

    async def world(self) -> dict:
        tid = await self.team("Platform", "open", "wm", ["wm", "wa"])
        secret = await self.team("Secret", "private", "wa", ["wa"])
        old = now() - timedelta(days=10)
        await self.put("zebra-rfc", "RFC: Zebra sharding", "# RFC: Zebra sharding\n\nZebra sharding splits the index.",
                       owner="wm", team_ids=[tid], created_at=old, updated_at=now() - timedelta(hours=2))
        await self.put("zebra-old", "Zebra history", "# Zebra history\n\nOld zebra notes.", owner="wm", created_at=old,
                       updated_at=old)
        await self.put("zebra-secret", "Secret zebra plan", "# Secret zebra plan\n\nZebra sharding in secret.", owner="wa",
                       team_ids=[secret], created_at=now() - timedelta(hours=3))
        await self.put("zebra-private", "Private zebra diary", "# Diary\n\nZebra sharding private notes.", owner="wa",
                       state="P", created_at=now() - timedelta(hours=3))
        await self.comment("zebra-rfc", "wa", "Zebra sharding needs a load test first.")
        await self.comment("zebra-secret", "wa", "Secret zebra comment.")
        await ai_index.drain()
        await self.reindex()
        return {"team": tid, "secret": secret}

    # ── Person cards ──

    async def test_person_card_route_is_access_filtered(self):
        await self.world()
        r = await self.http.get(f"/api/v1/people/{self.uid['wa']}/card", headers=self.session("wv"))
        self.assertEqual(r.status_code, 200, r.text)
        c = r.json()
        self.assertEqual(c["name"], "Priya Sharma")
        self.assertEqual([t["name"] for t in c["teams"]], ["Platform"])        # never the private team
        body = json.dumps(c)
        for leak in ("Secret", "Private zebra diary"):
            self.assertNotIn(leak, body)
        r = await self.http.get(f"/api/v1/people/{self.uid['wm']}/card", headers=self.session("wv"))
        c = r.json()
        self.assertEqual(c["created"]["total"], 2)
        self.assertTrue(any(t["lead"] for t in c["teams"]))
        # A member of the private team sees it on the card.
        r = await self.http.get(f"/api/v1/people/{self.uid['wa']}/card", headers=self.session("wa"))
        self.assertEqual({t["name"] for t in r.json()["teams"]}, {"Platform", "Secret"})
        self.assertTrue(r.json()["you"])
        # Not sharing a workspace: 404, nothing about them.
        r = await self.http.get(f"/api/v1/people/{self.uid['wa']}/card", headers=self.session("stranger"))
        self.assertEqual(r.status_code, 404)
        r = await self.http.get(f"/api/v1/people/{self.uid['wm2']}/card", headers=self.session("wv"))
        self.assertEqual(r.status_code, 404)

    async def test_person_question_brings_the_card_on_done(self):
        await self.world()
        self.expansion = {"standalone": "Tell me about Priya", "terms": ["Priya"], "titles": [],
                          "route": {"type": "person", "items": "any", "people": ["Priya"]}}
        done = self.done(await self.ask("wv", "Tell me about Priya"))
        self.assertEqual([p["name"] for p in done["people"]], ["Priya Sharma"])
        self.assertNotIn("Secret", json.dumps(done["people"]))
        self.expansion = {"standalone": "When does zebra ship?", "terms": ["zebra"], "titles": [], "route": {"type": "lookup"}}
        self.assertEqual(self.done(await self.ask("wv", "When does zebra ship?"))["people"], [])

    # ── What changed ──

    async def test_visit_marks_the_end_of_the_previous_look(self):
        uid = self.uid["wm"]
        space = f"ws:{self.W}"
        self.assertEqual((await self.http.post(f"/api/v1/workspaces/{self.W}/visit", headers=self.session("wm"), json={})).json(),
                         {"since": None})
        self.assertIsNone(await what_changed.last_looked(self.db, uid, space))
        past = now() - timedelta(hours=5)
        await self.db[what_changed.COLL].update_one({"_id": f"{uid}|{space}"}, {"$set": {"seen": past}})
        # Away for five hours: the last look is the mark, and a new look keeps it.
        self.assertAlmostEqual((await what_changed.last_looked(self.db, uid, space)).timestamp(), past.timestamp(), delta=1)
        got = (await self.http.post(f"/api/v1/workspaces/{self.W}/visit", headers=self.session("wm"), json={})).json()
        self.assertIsNotNone(got["since"])
        await self.http.post(f"/api/v1/workspaces/{self.W}/visit", headers=self.session("wm"), json={})
        self.assertAlmostEqual((await what_changed.last_looked(self.db, uid, space)).timestamp(), past.timestamp(), delta=1)
        # Not a member, a team they can't open: 404.
        r = await self.http.post(f"/api/v1/workspaces/{self.W}/visit", headers=self.session("stranger"), json={})
        self.assertEqual(r.status_code, 404)
        secret = await self.team("Secret", "private", "wa", ["wa"])
        r = await self.http.post(f"/api/v1/workspaces/{self.W}/visit", headers=self.session("wv"), json={"space": f"team:{secret}"})
        self.assertEqual(r.status_code, 404)

    async def test_changes_only_readable_and_since_the_mark(self):
        ids = await self.world()
        await self.db[what_changed.COLL].insert_one({"_id": f"{self.uid['wv']}|ws:{self.W}", "user_id": self.uid["wv"],
                                                     "space": f"ws:{self.W}", "workspace_id": self.W,
                                                     "seen": now() - timedelta(days=1), "since": None})
        r = await self.http.get(f"/api/v1/workspaces/{self.W}/changes", headers=self.session("wv"))
        self.assertEqual(r.status_code, 200, r.text)
        ch = r.json()
        self.assertEqual(ch["basis"], "visit")
        titles = [d["title"] for d in ch["documents_updated"] + ch["documents_new"]]
        self.assertIn("RFC: Zebra sharding", titles)
        self.assertNotIn("Zebra history", titles)                  # older than the mark
        body = json.dumps(ch)
        for leak in ("Secret", "Private zebra diary"):
            self.assertNotIn(leak, body)
        self.assertEqual(ch["totals"]["comments"], 1)
        # wa (in the private team, owner of the diary) sees both.
        r = await self.http.get(f"/api/v1/workspaces/{self.W}/changes", headers=self.session("wa"),
                                params={"since": (now() - timedelta(days=1)).isoformat()})
        self.assertIn("Secret zebra plan", json.dumps(r.json()))
        self.assertEqual(r.json()["basis"], "given")
        # A team: only its items; a team they can't open: 404.
        r = await self.http.get(f"/api/v1/workspaces/{self.W}/changes", headers=self.session("wv"), params={"team": ids["team"]})
        self.assertEqual([d["title"] for d in r.json()["documents_updated"]], ["RFC: Zebra sharding"])
        r = await self.http.get(f"/api/v1/workspaces/{self.W}/changes", headers=self.session("wv"), params={"team": ids["secret"]})
        self.assertEqual(r.status_code, 404)
        r = await self.http.get(f"/api/v1/workspaces/{self.W}/changes", headers=self.session("stranger"))
        self.assertEqual(r.status_code, 404)

    async def test_what_changed_intent_in_ask(self):
        await self.world()
        self.fake.calls.clear()
        done = self.done(await self.ask("wv", "What changed since I last looked?", scope={"kind": "workspace", "workspace": self.W}))
        self.assertEqual(done["intent"], "what_changed")
        p = self.answer_prompt()
        self.assertIn("What changed since", p)
        self.assertIn("no earlier visit: the last 7 days", p)
        self.assertIn("RFC: Zebra sharding", p)
        self.assertIn("They asked what changed since they last looked", p)
        for leak in ("Secret zebra", "Private zebra diary"):
            self.assertNotIn(leak, self.prompts())

    # ── Who knows ──

    async def test_who_knows_in_ask_and_mcp(self):
        await self.world()
        self.expansion = {"standalone": "Who knows about zebra sharding?", "terms": ["zebra", "sharding"], "titles": [],
                          "route": {"type": "lookup"}}
        self.fake.calls.clear()
        self.done(await self.ask("wv", "Who knows about zebra sharding?"))
        p = self.answer_prompt()
        self.assertIn("People connected to this topic", p)
        self.assertRegex(p, r"Bo Chen — created “RFC: Zebra sharding” \[\d+\]")
        self.assertNotIn("Secret", p)
        tok = await self.mcp_token("wv", write=False)
        st, res = await self.mcp_call(tok, "who_knows", {"workspace": self.W, "topic": "zebra sharding"})
        self.assertEqual(st, 200)
        names = [x["name"] for x in res["structuredContent"]["people"]]
        self.assertEqual(names[0], "Bo Chen")
        self.assertNotIn("Secret", json.dumps(res))
        st, res = await self.mcp_call(tok, "what_changed", {"workspace": self.W, "since": (now() - timedelta(days=1)).date().isoformat()})
        self.assertEqual(st, 200)
        self.assertIn("RFC: Zebra sharding", res["content"][0]["text"])
        self.assertNotIn("Secret", json.dumps(res))
        st, res = await self.mcp_call(tok, "person_card", {"workspace": self.W, "person": "Priya"})
        self.assertEqual(res["structuredContent"]["card"]["name"], "Priya Sharma")
        self.assertNotIn("Secret", json.dumps(res))

    # ── One engine: ⌘K and Slack ──

    async def test_palette_runs_on_ask(self):
        await self.world()
        self.expansion = {"standalone": "zebra sharding", "terms": ["zebra"], "titles": [], "route": {"type": "lookup"}}
        self.fake.calls.clear()
        r = await self.http.post("/api/v1/search/ask", json={"question": "what is zebra sharding?"}, headers=self.session("wv"))
        self.assertEqual(r.status_code, 200)
        events = parse_sse(r.text)
        kinds = [e for e, _ in events]
        self.assertEqual(kinds[-1], "done")
        stages = {d["stage"] for e, d in events if e == "status"}
        self.assertTrue(stages <= {"expanding", "searching", "answering"}, stages)
        done = events[-1][1]
        self.assertNotRegex(done["answer"], r"\[\d+-s\d+\]")
        self.assertTrue(all(isinstance(c["n"], int) and c["title"] for c in done["citations"]))
        results = next(d for e, d in events if e == "results")["items"]
        self.assertTrue(all("n" in it for it in results))
        self.assertTrue(any(is_ask(c) for c in self.fake.calls))          # Ask's engine, not the older one
        sent = "\n".join(prompt_of(c) for c in self.fake.calls)
        for leak in ("Secret zebra", "Private zebra diary"):
            self.assertNotIn(leak, sent)
        row = await self.db[ai_usage.REQUESTS].find_one({"feature": "search_ai"}, sort=[("ts", -1)])
        self.assertEqual(row["via"], "palette")
        self.assertEqual(await self.db[ask_markdrop.COLL].count_documents({}), 0)       # no thread saved
        # The switch back: the older engine.
        saved = settings.search_ai_engine
        settings.search_ai_engine = "search"
        self.addCleanup(lambda: setattr(settings, "search_ai_engine", saved))
        self.fake.calls.clear()
        await self.http.post("/api/v1/search/ask", json={"question": "what is zebra sharding?"}, headers=self.session("wv"))
        self.assertFalse(any(is_ask(c) for c in self.fake.calls))

    async def test_slack_answer_on_ask(self):
        await self.world()
        user = await self._user("wv")
        from app.services import slack_api, slack_events

        sent = []

        async def respond(url, msg):
            sent.append(msg)
            return True

        from unittest import mock

        self.expansion = {"standalone": "zebra sharding", "terms": ["zebra"], "titles": [], "route": {"type": "lookup"}}
        self.fake.calls.clear()
        with mock.patch.object(slack_api, "respond", respond):
            await slack_events._ask(self.db, {"workspace_id": self.W}, user, "what is zebra sharding?", "https://hooks.slack.com/x",
                                    meetings=False)
        text = json.dumps(sent[-1])
        self.assertIn("Sources", text)
        self.assertNotRegex(text, r"\[\d+-s\d+\]")
        self.assertTrue(any(is_ask(c) for c in self.fake.calls))
        for leak in ("Secret zebra", "Private zebra diary"):
            self.assertNotIn(leak, "\n".join(prompt_of(c) for c in self.fake.calls))
        row = await self.db[ai_usage.REQUESTS].find_one({"feature": "search_ai"}, sort=[("ts", -1)])
        self.assertEqual(row["via"], "slack")

    async def _user(self, who: str):
        from app.services.user import get_user_by_id

        return await get_user_by_id(self.db, self.uid[who])


if __name__ == "__main__":
    unittest.main()
