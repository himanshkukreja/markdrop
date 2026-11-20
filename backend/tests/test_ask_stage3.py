"""AI quality stage 3 (.work/briefs/ai-quality-phase2.md): "likely done" action items (services/likely_done.py — marked by
Team memory's extraction, shown in Ask, on to-do and backlog pages, never ticked), the planner for hard questions
(services/ask_plan.py — a short lookup loop, its model answers, the model mix logged) and the team overview's
blockers and members' open items.

Access first: a candidate's evidence is shown only to askers who may open it (and on a shared page only when every
reader may); the planner's lookups are the asker's own (a private team's documents never reach its prompt or the
answer's prompt).
"""

from __future__ import annotations

import json
import unittest
from datetime import date, timedelta

from tests._access_env import now
from tests.test_ai_index import IndexWorld

from app.config import get_settings
from app.services import ai_index, ai_usage, ask_plan, ask_route, likely_done, workspace_memory

settings = get_settings()


class Helpers(unittest.TestCase):
    def test_key_and_parse_done(self):
        self.assertEqual(likely_done.key_of("d1", "b-abc12", "x"), "d1:b-abc12")
        self.assertEqual(likely_done.key_of("d1", None, "Write the PRD!"), likely_done.key_of("d1", None, "write the prd"))
        raw = json.dumps({"facts": [], "done": [{"item": "a2", "evidence": "The draft · is up", "cite": "s4"},
                                                {"item": "a2", "evidence": "dup"}, {"item": "a9", "evidence": "out of range"},
                                                {"item": "a1", "evidence": ""}, "junk"]})
        got = likely_done.parse_done(raw, 3)
        self.assertEqual(got, [{"i": 2, "evidence": "The draft - is up", "seg": 4}])
        self.assertEqual(likely_done.parse_done("not json", 3), [])
        self.assertEqual(likely_done.parse_done(raw, 0), [])

    def test_task_rows_carry_the_block(self):
        md = '## Action items\n\n- [ ] :person[Bo]{id="u1"} Ship it {#b-abcd1}\n- [ ] No block\n'
        rows = ai_index.task_rows(md, meeting=True)
        self.assertEqual([r["block"] for r in rows], ["b-abcd1", None])

    def test_route_hard(self):
        today = date(2026, 11, 20)
        self.assertTrue(ask_route.parse({"type": "lookup", "hard": True}, "x", today).hard)
        self.assertFalse(ask_route.parse({"type": "lookup", "hard": "yes"}, "Who owns pricing?", today).hard)
        for q in ("Compare what Product and Engineering did", "What did Bo commit to, and has he delivered each one?",
                  "Is anything blocking the launch, and who owns it?"):
            self.assertTrue(ask_route.parse({}, q, today).hard, q)
        self.assertFalse(ask_route.parse({}, "What are Arun's PRDs?", today).hard)

    def test_parse_calls(self):
        raw = json.dumps({"calls": [{"tool": "list_items", "args": {"kind": "documents", "person": "Bo" * 100}},
                                    {"tool": "rm -rf", "args": {}}, {"tool": "search", "args": "nope"},
                                    *[{"tool": "read", "args": {"item": f"#{i}"}} for i in range(9)]]})
        got = ask_plan.parse_calls(raw)
        self.assertEqual(len(got), ask_plan.MAX_CALLS - 1)          # the bad tool is dropped, the list is capped first
        self.assertEqual(got[0]["args"]["person"], ("Bo" * 100)[:80])
        self.assertEqual(got[1], {"tool": "search", "args": {}})
        self.assertEqual(ask_plan.parse_calls('{"calls": []}'), [])
        self.assertEqual(ask_plan.parse_calls("garbage"), [])

    def test_meter_prices_each_model(self):
        m = ai_usage.Meter("claude-haiku-5-5")
        m.add({"input_tokens": 10_000, "output_tokens": 0})
        m.add({"input_tokens": 10_000, "output_tokens": 0}, "claude-sonnet-5-5")
        self.assertAlmostEqual(m.cost_usd, 0.001 + 0.02)
        self.assertEqual(m.models, {"claude-haiku-5-5": 1, "claude-sonnet-5-5": 1})


class Stage3World(IndexWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await likely_done.ensure_indexes(self.db)
        self.plan_rounds: list = []      # the planner's replies, in order
        self.memory_reply = None
        inner = self.fake.script

        def script(params):
            s = params["system"][0]["text"]
            if s.startswith("You plan the lookups"):
                return json.dumps(self.plan_rounds.pop(0) if self.plan_rounds else {"calls": []})
            if s.startswith("You keep a team's memory") and self.memory_reply is not None:
                return json.dumps(self.memory_reply)
            return inner(params)

        self.fake.script = script

    async def action_page(self, team_id: str | None = None):
        """A meeting-notes-like page with Bo's open action item (block b-ship1)."""
        return await self.put("sync-notes", "Zebra sync notes", "# Zebra sync notes\n\n## Action items\n\n"
                              f'- [ ] :person[Bo Chen]{{id="{self.uid["wm"]}"}} Write the zebra rollout plan {{#b-ship1}}\n',
                              owner="wo", editor="blocks", team_ids=[team_id] if team_id else [],
                              updated_at=now() - timedelta(days=3))

    async def mark(self, evidence_doc: dict, text: str = "The rollout plan is up.") -> int:
        rows = await self.db[ai_index.COLL].find({"t": "action", "done": False}).to_list(length=10)
        self.assertTrue(rows)
        return await likely_done.record(self.db, self.W, f"d:{evidence_doc['_id']}",
                                        {"doc": evidence_doc["_id"], "title": evidence_doc["title"],
                                         "date": now().date().isoformat()}, rows, [{"i": 1, "evidence": text}])


class LikelyDone(Stage3World):
    async def test_memory_extraction_marks_candidates_and_never_ticks(self):
        await self.action_page()
        plan = await self.put("rollout-plan", "Zebra rollout plan", "# Zebra rollout plan\n\n"
                              + " ".join(["The zebra rollout ships in two waves with a load test first."] * 8),
                              owner="wm", editor="blocks")
        await self.reindex()
        self.memory_reply = {"facts": [], "done": [{"item": "a1", "evidence": "This page is the rollout plan."}]}
        settings.workspace_memory_enabled, settings.workspace_memory_daily_usd = True, 3.0
        settings.workspace_memory_monthly_usd = 30.0
        ai_usage.invalidate_settings()
        info = await workspace_memory.ws_info(self.db, self.W)
        members = await workspace_memory.members_of(self.db, self.W)
        self.fake.calls.clear()
        out = await workspace_memory.extract_page(self.db, info, await self.db["documents"].find_one({"_id": plan["_id"]}), members)
        self.assertEqual(out["outcome"], "ok")
        p = next(c for c in self.fake.calls if c["system"][0]["text"].startswith("You keep a team's memory"))
        text = "\n".join(b["text"] for b in p["messages"][-1]["content"])
        self.assertIn("<untrusted_open_items>", text)
        self.assertIn("a1: Bo Chen Write the zebra rollout plan", text)
        cand = await self.db[likely_done.COLL].find_one({})
        self.assertEqual((cand["block"], cand["evidence"]["title"]), ("b-ship1", "Zebra rollout plan"))
        # Never ticked: the page still has the open box.
        self.assertIn("- [ ] :person[Bo Chen]", (await self.db["documents"].find_one({"slug": "sync-notes"}))["content"])
        # Read again and the model no longer says so: the candidate goes.
        self.memory_reply = {"facts": []}
        await workspace_memory.extract_page(self.db, info, await self.db["documents"].find_one({"_id": plan["_id"]}), members)
        self.assertEqual(await self.db[likely_done.COLL].count_documents({}), 0)

    async def test_ask_shows_it_only_with_readable_evidence(self):
        await self.action_page()
        public = await self.put("rollout-plan", "Zebra rollout plan", "Body", owner="wm")
        secret = await self.put("secret-plan", "Hidden rollout memo", "Body", owner="wa", state="P")
        await self.reindex()
        self.assertEqual(await self.mark(public), 1)
        self.expansion = {"standalone": "What open action items does Bo have?", "terms": ["action items"], "titles": [],
                          "route": {"type": "list", "items": "action_items", "people": ["Bo"]}}
        self.fake.calls.clear()
        self.done(await self.ask("wv", "What open action items does Bo have?"))
        p = self.answer_prompt()
        self.assertIn("(1 of them likely done, not ticked)", p)
        self.assertIn("[open — likely done: The rollout plan is up. (Zebra rollout plan,", p)
        # Evidence the asker can't open: no note, no title.
        await self.db[likely_done.COLL].delete_many({})
        await self.mark(secret, "The hidden memo says it shipped.")
        self.fake.calls.clear()
        self.done(await self.ask("wv", "What open action items does Bo have?"))
        p = self.answer_prompt()
        self.assertNotIn("[open — likely done", p)
        self.assertNotIn("Hidden rollout memo", p)
        self.assertNotIn("hidden memo", p)
        # Its author sees it.
        self.fake.calls.clear()
        self.done(await self.ask("wa", "What open action items does Bo have?"))
        self.assertIn("likely done: The hidden memo says it shipped.", self.answer_prompt())

    async def test_page_notes_need_every_reader(self):
        await self.action_page()
        public = await self.put("rollout-plan", "Zebra rollout plan", "Body", owner="wm")
        secret = await self.put("secret-plan", "Hidden rollout memo", "Body", owner="wm", state="P")
        await self.reindex()
        page = await self.db["documents"].find_one({"slug": "sync-notes"})
        await self.mark(public)
        notes = await likely_done.page_notes(self.db, [(page["_id"], "b-ship1", "x")], [self.uid["wm"], self.uid["wv"]])
        self.assertEqual(list(notes), ["b-ship1"])
        self.assertTrue(notes["b-ship1"].startswith(" · likely done: The rollout plan is up. ("))
        await self.db[likely_done.COLL].delete_many({})
        await self.mark(secret)
        # wm can open the memo, wv can't: a shared page shows nothing.
        self.assertEqual(await likely_done.page_notes(self.db, [(page["_id"], "b-ship1", "x")], [self.uid["wm"]]),
                         {"b-ship1": notes["b-ship1"]})
        self.assertEqual(await likely_done.page_notes(self.db, [(page["_id"], "b-ship1", "x")],
                                                      [self.uid["wm"], self.uid["wv"]]), {})
        # Dismissed: never shown, never offered again.
        key = likely_done.key_of(page["_id"], "b-ship1", None)
        self.assertTrue(await likely_done.dismiss(self.db, key, self.uid["wm"]))
        self.assertEqual(await likely_done.page_notes(self.db, [(page["_id"], "b-ship1", "x")], [self.uid["wm"]]), {})

    def test_line_renderers(self):
        from app.services import team_backlog, todo_pages

        it = todo_pages.Item("b-ship1", "Write the plan", None, None, False, None, "sync", "Zebra sync", None, "internal", "Internal")
        note = " · likely done: The plan is up. (Nov 19)"
        self.assertIn(" · likely done: The plan is up. (Nov 19) {#b-ship1}", todo_pages.item_line(it, False, note))
        self.assertNotIn("likely done", todo_pages.item_line(it, True, note))
        line = team_backlog.item_line({"text": "Write the plan", "status": "open", "block": "b-x1"}, [], {}, note)
        self.assertIn("likely done", line)
        # The backlog reads the line back without taking the note for a status or a text change.
        rest = line.split("] ", 1)[1].rsplit(" {#", 1)[0]
        self.assertEqual(team_backlog.parse_line(rest), ("Write the plan", None))


class Planner(Stage3World):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        # The planner ships off (config.ask_planner_enabled); these tests turn it on.
        saved = settings.ask_planner_enabled
        self.addCleanup(lambda: setattr(settings, "ask_planner_enabled", saved))
        settings.ask_planner_enabled = True

    async def test_hard_question_runs_the_loop_on_the_planner_model(self):
        secret = await self.team("Secret", "private", "wa", ["wa"])
        await self.put("bo-1", "Zebra launch plan", "Body", owner="wm")
        await self.put("bo-2", "Zebra pricing notes", "Body", owner="wm")
        await self.put("s-1", "Secret zebra memo", "Body", owner="wa", team_ids=[secret])
        await self.reindex()
        self.expansion = {"standalone": "Compare Bo's and Priya's zebra documents", "terms": ["zebra"], "titles": [],
                          "route": {"type": "list", "items": "any", "hard": True}}
        self.plan_rounds = [{"calls": [{"tool": "list_items", "args": {"kind": "documents", "person": "Bo"}},
                                       {"tool": "list_items", "args": {"kind": "documents", "person": "Priya"}},
                                       {"tool": "list_items", "args": {"kind": "documents", "team": "Secret"}}]},
                            {"calls": [{"tool": "read", "args": {"item": "#1"}}]},
                            {"calls": []}]
        self.fake.calls.clear()
        done = self.done(await self.ask("wv", "Compare Bo's and Priya's zebra documents"))
        plans = [c for c in self.fake.calls if c["system"][0]["text"].startswith("You plan the lookups")]
        self.assertEqual(len(plans), 3)
        self.assertEqual({c["model"] for c in plans}, {settings.ask_planner_model})
        second = "\n".join(b["text"] for b in plans[1]["messages"][-1]["content"])
        self.assertIn("<untrusted_results>", second)
        self.assertIn("Documents created by Bo Chen: 2", second)
        self.assertIn("No team “Secret” this person can open.", second)
        self.assertNotIn("Secret zebra memo", second)
        ans = [c for c in self.fake.calls if c["system"][0]["text"].startswith("You are Ask, the assistant")][-1]
        self.assertEqual(ans["model"], "claude-haiku-5-5")         # Haiku answers from the planner's lookups by default
        p = self.answer_prompt()
        self.assertIn("Documents created by Bo Chen: 2", p)
        self.assertNotIn("Secret zebra memo", p)
        self.assertTrue(done["answer"])
        row = (await self.ledger())[-1]
        self.assertEqual(row["models"], {"claude-haiku-5-5": 2, settings.ask_planner_model: 3})
        self.assertTrue(row["route"]["hard"])
        self.assertEqual(row["plan"]["calls"], 4)
        # With ask_planner_answers on, the planner's model writes the answer too.
        saved = settings.ask_planner_answers
        self.addCleanup(lambda: setattr(settings, "ask_planner_answers", saved))
        settings.ask_planner_answers = True
        self.plan_rounds = [{"calls": [{"tool": "search", "args": {"query": "zebra"}}]}]
        self.fake.calls.clear()
        self.done(await self.ask("wv", "Compare Bo's and Priya's zebra documents"))
        ans = [c for c in self.fake.calls if c["system"][0]["text"].startswith("You are Ask, the assistant")][-1]
        self.assertEqual(ans["model"], settings.ask_planner_model)
        self.assertNotIn("Secret zebra memo", self.answer_prompt())

    async def test_easy_questions_and_planner_off_stay_on_haiku(self):
        await self.put("bo-1", "Zebra launch plan", "Body", owner="wm")
        await self.reindex()
        self.expansion = {"standalone": "What is the zebra launch plan?", "terms": ["zebra"], "titles": [],
                          "route": {"type": "lookup", "items": "any"}}
        self.fake.calls.clear()
        self.done(await self.ask("wv", "What is the zebra launch plan?"))
        self.assertFalse([c for c in self.fake.calls if c["system"][0]["text"].startswith("You plan the lookups")])
        self.assertEqual({c["model"] for c in self.fake.calls}, {"claude-haiku-5-5"})
        saved = settings.ask_planner_enabled
        self.addCleanup(lambda: setattr(settings, "ask_planner_enabled", saved))
        settings.ask_planner_enabled = False
        self.expansion["route"]["hard"] = True
        self.fake.calls.clear()
        self.done(await self.ask("wv", "What is the zebra launch plan, and who wrote it?"))
        self.assertEqual({c["model"] for c in self.fake.calls}, {"claude-haiku-5-5"})


class TeamOverview(Stage3World):
    async def test_members_open_items(self):
        eng = await self.team("Platform", "open", "wm", ["wm", "wa"])
        await self.action_page(eng)
        await self.reindex()
        self.expansion = {"standalone": "What is this team working on?", "terms": ["working"], "titles": [],
                          "route": {"type": "team", "items": "any"}}
        self.fake.calls.clear()
        self.done(await self.ask("wa", "What is this team working on?", scope={"kind": "team", "workspace": self.W, "team": eng}))
        p = self.answer_prompt()
        self.assertIn("Open action items of the members: 1", p)
        self.assertIn("Bo Chen: [open] Bo Chen Write the zebra rollout plan", p)


class MCPLikelyDone(Stage3World):
    async def test_likely_done_tools(self):
        await self.action_page()
        public = await self.put("rollout-plan", "Zebra rollout plan", "Body", owner="wm")
        secret = await self.put("secret-plan", "Hidden rollout memo", "Body", owner="wa", state="P")
        await self.reindex()
        await self.mark(public)
        tok = await self.mcp_token("wv", write=False)
        st, res = await self.mcp_call(tok, "likely_done", {"workspace": self.W, "person": "Bo Chen"})
        sc = res["structuredContent"]
        self.assertEqual((st, sc["count"]), (200, 1))
        self.assertEqual((sc["items"][0]["evidence"], sc["items"][0]["source"], sc["items"][0]["block"]),
                         ("The rollout plan is up.", "Zebra rollout plan", "b-ship1"))
        st, res = await self.mcp_call(tok, "list_items", {"workspace": self.W, "kind": "action_items", "person": "Bo Chen"})
        self.assertEqual(res["structuredContent"]["items"][0]["likely_done"]["source"], "Zebra rollout plan")
        # Evidence the caller can't open: nothing.
        await self.db[likely_done.COLL].delete_many({})
        await self.mark(secret)
        st, res = await self.mcp_call(tok, "likely_done", {"workspace": self.W})
        self.assertEqual(res["structuredContent"]["count"], 0)
        self.assertNotIn("Hidden", json.dumps(res))
        # Dismiss: a viewer who doesn't own the item can't; its owner can.
        key = likely_done.key_of((await self.db["documents"].find_one({"slug": "sync-notes"}))["_id"], "b-ship1", None)
        st, res = await self.mcp_call(await self.mcp_token("wv"), "dismiss_likely_done", {"key": key})
        self.assertTrue(res.get("isError"))
        st, res = await self.mcp_call(await self.mcp_token("wm"), "dismiss_likely_done", {"key": key})
        self.assertEqual(res["structuredContent"], {"dismissed": True})
