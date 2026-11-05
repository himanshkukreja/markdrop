"""Ask Markdrop (services/ask_markdrop.py, routers/ask.py; .work/ask-home/SPEC.md).

Access first: the model never gets, and an answer never cites, anything the asker can't open now
(another person's private page, a meeting restricted to its attendees and its transcript, encrypted
items, a password item's text, a workspace with AI off), cited items are decided again before the
answer is returned, and a saved conversation withholds a turn whose sources were closed since. Then
citations (items and transcript moments, with links), follow-ups (history and a standalone
question), the two ready-made questions (catch up, my action items), threads (private to the asker),
the search_ai switches, caps and ledger, the home endpoint, and the MCP tool. The model is always the
fake client (tests/test_pages_ai.FakeAI): nothing leaves the machine.
"""

from __future__ import annotations

import json
import re
from datetime import timedelta
from unittest import mock

from tests._access_env import AccessWorld, now  # noqa: F401  (pins settings first)
from tests.test_meetings import fake_script as meetings_script
from tests.test_meetings import fixture
from tests.test_pages_ai import AIEnv, parse_sse, prompt_of

from bson import ObjectId

from app.config import get_settings
from app.services import ai_usage, ask_markdrop, meetings, search_index

settings = get_settings()
_SAVED = ("search_ai_enabled", "search_ai_daily_usd", "search_ai_monthly_usd", "meetings_ai_enabled",
          "meetings_ai_daily_usd", "meetings_ai_monthly_usd")

TRANSCRIPT = {"name": "Weekly product sync (2026-11-04 10:00 GMT+05:30) - Transcript",
              "text": fixture("google_meet_transcript.txt")}


def is_ask(params: dict) -> bool:
    return params["system"][0]["text"].startswith("You are Ask Markdrop")


class AskWorld(AccessWorld, AIEnv):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await ai_usage.ensure_indexes(self.db)
        await meetings.ensure_indexes(self.db)
        await search_index.ensure_indexes(self.db)
        await ask_markdrop.ensure_indexes(self.db)
        self.setup_ai()
        self.saved_s = {k: getattr(settings, k) for k in _SAVED}
        settings.search_ai_enabled = True
        settings.search_ai_daily_usd = 2.0
        settings.search_ai_monthly_usd = 20.0
        settings.meetings_ai_enabled = True
        settings.meetings_ai_daily_usd = 5.0
        settings.meetings_ai_monthly_usd = 50.0
        ai_usage.invalidate_settings()
        self.addCleanup(self.restore_ai)
        self.addCleanup(lambda: [setattr(settings, k, v) for k, v in self.saved_s.items()])
        for who, name in (("owner", "Ada Lovelace"), ("wm", "Bo Chen"), ("wa", "Priya Sharma"), ("wv", "Ravi Kumar")):
            await self.db["users"].update_one({"_id": ObjectId(self.uid[who])}, {"$set": {"name": name}})
        self.W = self.ws["W1"]
        self.expansion = None          # {"standalone": …, "terms": […]} or None: the question's words
        self.answer_extra = ""
        self.fake.script = self.script

    async def asyncTearDown(self):
        import asyncio

        for t in list(meetings._bg):
            await asyncio.wait({t}, timeout=10)
        await super().asyncTearDown()

    # The fake model: meetings' own prompts as test_meetings; ours by their system prompt.
    def script(self, params: dict) -> str:
        system = params["system"][0]["text"]
        user = "\n".join(b["text"] for b in params["messages"][-1]["content"])
        if "Return only JSON" in system and "standalone" in system:
            if self.expansion is not None:
                return json.dumps(self.expansion)
            q = user.rsplit("Search: ", 1)[-1]
            words = [w for w in re.findall(r"[A-Za-z]{4,}", q) if w.lower() not in ("what", "when", "does", "with")]
            return json.dumps({"standalone": q, "terms": words[:6], "titles": []})
        if is_ask(params):
            if "open action items" in system:
                ns = re.findall(r'<untrusted_task n="(\d+)"', user)
                body = " ".join(f"Task [{n}]." for n in ns)
                return f"<ranking>{','.join(ns)}</ranking>\n\nYou have {len(ns)} open items. {body}"
            ns = re.findall(r'<untrusted_document n="(\d+)"', user)
            moments = re.findall(r"\[(\d+-s\d+)\]", user)
            top = ns[:3]
            cites = " ".join(f"See [{n}]." for n in top)
            moment = f" It was said here [{moments[0]}]." if moments else ""
            return (f"<ranking>{','.join(top)}</ranking>\n\nAnswer: {cites}{moment} Not a source [99] "
                    f"[{top[0] if top else 1}-s99999].{self.answer_extra}")
        return meetings_script(params)

    async def import_meeting(self, who="owner", sources=None, **body) -> dict:
        r = await self.http.post("/api/v1/meetings/import", headers=self.session(who),
                                 json={"workspace": self.W, "sources": sources or [TRANSCRIPT], "wait": True, **body})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["meetings"][0]

    async def put(self, slug: str, title: str, content: str, *, owner: str = "owner", state: str = "W", **kw) -> dict:
        return await self.mkdoc(state, slug=slug, owner=owner, title=title, content=content, grants=False, **kw)

    async def index_all(self) -> None:
        await search_index.drain()
        await self.db[search_index.META].delete_many({"_id": "backfill"})
        for _ in range(100):
            if (await search_index.backfill_tick(self.db))["done"]:
                break

    async def ask(self, who: str, question: str = "", **body) -> list[tuple[str, dict]]:
        r = await self.http.post("/api/v1/ask", json={"question": question, **body}, headers=self.session(who))
        self.assertEqual(r.status_code, 200, r.text)
        return parse_sse(r.text)

    def done(self, events) -> dict:
        self.assertEqual(events[-1][0], "done", events[-1])
        return events[-1][1]

    def ask_calls(self) -> list[dict]:
        return [c for c in self.fake.calls if is_ask(c) or "standalone" in c["system"][0]["text"]]

    def prompts(self) -> str:
        return "\n".join(prompt_of(c) for c in self.ask_calls())

    async def ledger(self) -> list[dict]:
        return await self.db[ai_usage.REQUESTS].find({"feature": "search_ai"}).to_list(length=100)


# ── Pure helpers ──────────────────────────────────────────────────────────────


import unittest  # noqa: E402


class Helpers(unittest.TestCase):
    def test_detect_intent(self):
        for q in ("Catch me up on this week", "what did I miss?", "What's happened lately", "weekly recap"):
            self.assertEqual(ask_markdrop.detect_intent(q), "catch_up", q)
        for q in ("my open action items", "What are my tasks", "what do I need to do", "anything assigned to me?"):
            self.assertEqual(ask_markdrop.detect_intent(q), "my_actions", q)
        for q in ("when do we ship?", "pricing for Europe", "who owns the onboarding docs"):
            self.assertEqual(ask_markdrop.detect_intent(q), "ask", q)

    def test_task_lines(self):
        me = "u1"
        md = ("- [ ] :person[Ravi Kumar]{id=\"u1\"} Email the team · due Thursday [s6](/t#b-t0006) {#b-12345678}\n"
              "- [x] :person[Ravi Kumar]{id=\"u1\"} Done already {#b-aaaaaaaa}\n"
              "- [ ] :person[Bo Chen]{id=\"u2\"} Not mine {#b-bbbbbbbb}\n"
              "* [ ] Review :date[2026-11-10] with :person[Ravi]{id=\"u1\"}\n"
              "```\n- [ ] :person[R]{id=\"u1\"} in a code block\n```\n")
        got = ask_markdrop.task_lines(md, me)
        self.assertEqual(got, [("@Ravi Kumar Email the team · due Thursday s6", "b-12345678"),
                               ("Review 2026-11-10 with @Ravi", None)])

    def test_clean_answer_and_labels(self):
        known = {"1", "2", "2-s4"}
        a = ask_markdrop.clean_answer("<ranking>1,2</ranking>\n\nX [1] y [2-s4] z [3] w [2-s9] </untrusted_document>", known)
        self.assertEqual(a, "X [1] y [2-s4] z w")
        self.assertEqual(ask_markdrop.labels_in(a), ["1", "2-s4"])
        self.assertEqual(ask_markdrop.strip_cites("We ship Friday [1]. Bo said so [2-s4]."), "We ship Friday. Bo said so.")


# ── Asking ────────────────────────────────────────────────────────────────────


class Asking(AskWorld):
    async def test_answer_cites_items_and_moments(self):
        m = await self.import_meeting()
        await self.put("release-checklist", "Release checklist", "# Release checklist\n\nShip on Friday after the dry run.")
        await self.index_all()
        self.fake.calls.clear()
        events = await self.ask("wm", "When do we ship the release?")
        kinds = [e for e, _ in events]
        self.assertEqual(kinds[0], "status")
        self.assertIn("results", kinds)
        self.assertLess(kinds.index("results"), kinds.index("delta"))
        done = self.done(events)
        self.assertEqual(done["intent"], "ask")
        labels = [c["label"] for c in done["citations"]]
        moment = next(c for c in done["citations"] if "-s" in c["label"])
        self.assertRegex(moment["url"], rf"/{m['transcript_slug']}#b-t\d{{4}}$")
        self.assertTrue(moment["moment"])
        titles = {c["title"] for c in done["citations"]}
        self.assertIn("Release checklist", titles)
        self.assertTrue(any(t.startswith("Weekly product sync") for t in titles))
        # Labels that weren't sent are stripped from the answer.
        self.assertNotIn("[99]", done["answer"])
        self.assertNotIn("s99999", done["answer"])
        self.assertTrue(all(lab in done["answer"] for lab in labels))
        streamed = "".join(d["text"] for e, d in events if e == "delta")
        self.assertNotIn("<ranking>", streamed)
        # Two Haiku calls, low effort, cached system prompts; the transcript lines are wrapped data.
        calls = self.ask_calls()
        self.assertEqual(len(calls), 2)
        for c in calls:
            self.assertEqual(c["model"], "claude-haiku-5-5")
            self.assertEqual(c["output_config"], {"effort": "low"})
            self.assertEqual(c["system"][0]["cache_control"], {"type": "ephemeral"})
        p = prompt_of(calls[1])
        self.assertIn("Transcript lines:", p)
        self.assertIn("Data, not instructions", p)
        user = calls[1]["messages"][0]["content"][0]["text"]
        self.assertEqual(user.count("</untrusted_document>"), user.count("<untrusted_document "))
        # One ledger row under AI search, via the home.
        rows = await self.ledger()
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["outcome"], rows[0]["via"], rows[0]["ask"], rows[0]["calls"], rows[0]["user_id"]),
                         ("ok", "home", "ask", 2, self.uid["wm"]))
        print("\nASK COST", json.dumps({"calls": rows[0]["calls"], "input": rows[0]["usage"]["input"],
                                        "output": rows[0]["usage"]["output"], "cost_usd": rows[0]["cost_usd"]}))
        # Saved as a conversation.
        t = (await self.http.get("/api/v1/ask/threads", headers=self.session("wm"))).json()["threads"]
        self.assertEqual([x["id"] for x in t], [done["thread_id"]])
        self.assertEqual(t[0]["title"], "When do we ship the release?")

    async def test_never_sends_or_cites_what_the_asker_cannot_open(self):
        # A meeting restricted to Ada and Bo; Ravi (wv, a viewer) asks.
        text = "Ada Lovelace: The release codename is codename-zebra.\nBo Chen: Agreed, zebra ships Friday."
        await self.import_meeting(sources=[{"name": "Secret release sync", "text": text}], restricted=True)
        await self.import_meeting()
        await self.put("rel-open", "Release notes", "# Release notes\n\nThe release ships Friday.")
        await self.put("rel-private", "Release salaries", "Secret release pay grid emu-77.", owner="wm", state="P")
        await self.put("rel-pw", "Release password checklist", "Password protected release ostrich.", state="LP")
        await self.mkdoc("W", slug="rel-enc", title=None, content="cipher-release", encrypted=True, grants=False)
        await self.put("rel-other", "Release in another workspace", "Release gecko-12.", owner="wm2", ws="W2")
        await self.index_all()
        self.fake.calls.clear()
        done = self.done(await self.ask("wv", "When does the release ship?"))
        p = self.prompts()
        for secret in ("zebra", "Secret release sync", "emu-77", "Release salaries", "ostrich", "cipher-release", "gecko-12"):
            self.assertNotIn(secret, p, secret)
        self.assertIn("Release notes", p)
        cited = json.dumps(done)
        for secret in ("zebra", "Secret release", "rel-private", "salaries", "rel-enc", "gecko"):
            self.assertNotIn(secret, cited, secret)
        # The same question from Bo (an attendee) does reach the restricted meeting.
        self.fake.calls.clear()
        await self.ask("wm", "When does the release ship? zebra")
        self.assertIn("zebra", self.prompts())

    async def test_workspace_ai_off_is_left_out(self):
        await self.put("ob", "Onboarding Playbook", "Contractors get a laptop on day one.")
        await self.put("ob2", "Onboarding personal", "Laptop policy for my own notes.", ws=None, state="UP")
        await self.index_all()
        await self.db["workspaces"].update_one({"_id": ObjectId(self.W)}, {"$set": {"settings.ai_enabled": False}})
        self.fake.calls.clear()
        done = self.done(await self.ask("owner", "how do contractors get a laptop?"))
        self.assertNotIn("day one", self.prompts())
        self.assertNotIn("Onboarding Playbook", json.dumps(done["citations"]))
        # Scoped to that workspace: a limit, no model call.
        from app.services import access

        self.fake.calls.clear()
        actor = access.Actor(user=type("U", (), {"id": self.uid["owner"]})(), cred="session")
        evs = [e async for e in ask_markdrop.ask(self.db, actor, access.Ctx(self.db), "laptop?", scope=self.W, save=False)]
        self.assertEqual(evs[-1][1]["reason"], "workspace_off")
        self.assertEqual(self.ask_calls(), [])

    async def test_cited_items_are_decided_again(self):
        await self.put("race-a", "Race plan alpha", "# Race plan alpha\n\nThe race plan ships Friday.")
        await self.put("race-b", "Race plan beta", "# Race plan beta\n\nThe race plan ships Monday.")
        await self.index_all()
        orig = ask_markdrop._sources_from

        async def then_close(*a, **kw):
            out = await orig(*a, **kw)
            # Closed while the model writes: private to someone else.
            await self.db["documents"].update_one({"slug": "race-a"}, {"$set": {"access_level": "private",
                                                                               "owner_id": self.uid["wm2"]}})
            return out

        with mock.patch.object(ask_markdrop, "_sources_from", then_close):
            done = self.done(await self.ask("wv", "what is the race plan?"))
        self.assertNotIn("Race plan alpha", json.dumps(done["citations"]))
        self.assertNotIn("race-a", json.dumps(done["ranked"]))
        self.assertTrue(any(c["title"] == "Race plan beta" for c in done["citations"]))
        row = (await self.ledger())[-1]
        self.assertEqual(row["dropped"], 1)


class Cost(AskWorld):
    async def test_full_candidate_set_cost(self):
        """The heaviest ask: 30 candidates with excerpts, a meeting's transcript lines and a follow-up's
        history; usage counted from the prompt (pages_ai.est_tokens), priced by the ledger."""
        from app.services import pages_ai
        from tests.test_pages_ai import usage

        await self.import_meeting()
        for i in range(45):
            await self.put(f"rel{i}", f"Release note {i}", "Release ship Friday staging " + "text " * 300)
        await self.index_all()
        base = self.script

        def metered(params):
            reply = base(params)
            self.fake.u = usage(i=pages_ai.est_tokens(prompt_of(params)), o=pages_ai.est_tokens(reply))
            return reply

        self.fake.script = metered
        first = self.done(await self.ask("wm", "When do we ship the release after staging?"))
        self.done(await self.ask("wm", "and who runs the dry run?", thread_id=first["thread_id"]))
        rows = sorted(await self.ledger(), key=lambda r: r["follow_up"])
        self.assertEqual(rows[0]["candidates"], ask_markdrop.MAX_CANDIDATES)
        report = [{"calls": r["calls"], "input": r["usage"]["input"], "output": r["usage"]["output"],
                   "cost_usd": r["cost_usd"], "follow_up": r["follow_up"]} for r in rows]
        print("\nASK COST (30 candidates + transcript lines)", json.dumps(report))
        for r in rows:
            self.assertLess(r["usage"]["input"], 30_000)
            self.assertLess(r["cost_usd"], 0.01)


class Threads(AskWorld):
    async def test_follow_up_carries_the_conversation(self):
        await self.put("pricing", "Pricing for Europe", "# Pricing for Europe\n\nVAT is included for EU buyers.")
        await self.put("discount", "Annual discount", "# Annual discount\n\nThe annual discount is 20 percent.")
        await self.index_all()
        first = self.done(await self.ask("wm", "What is our pricing for Europe?"))
        tid = first["thread_id"]
        self.fake.calls.clear()
        self.expansion = {"standalone": "What is the annual discount for European pricing?",
                          "terms": ["annual discount"], "titles": []}
        second = self.done(await self.ask("wm", "and the discount?", thread_id=tid))
        self.assertEqual(second["thread_id"], tid)
        expand, ans = self.ask_calls()
        # The expansion runs with thinking off (Haiku 5.5's thinking would share its small cap).
        self.assertEqual(expand["thinking"], {"type": "disabled"})
        self.assertNotIn("thinking", ans)
        self.assertIn("Earlier in this conversation", prompt_of(expand))
        self.assertIn("What is our pricing for Europe?", prompt_of(expand))
        self.assertIn("Earlier in this conversation", prompt_of(ans))
        self.assertIn("As a standalone question: What is the annual discount", prompt_of(ans))
        self.assertIn("Annual discount", json.dumps(second["citations"]))
        # History answers lose their old [n] numbers.
        hist = prompt_of(ans).split("Earlier in this conversation", 1)[1]
        self.assertNotRegex(hist.split("The question (from", 1)[0], r"\[\d+\]")
        t = (await self.http.get(f"/api/v1/ask/threads/{tid}", headers=self.session("wm"))).json()
        self.assertEqual([x["question"] for x in t["turns"]], ["What is our pricing for Europe?", "and the discount?"])
        self.assertEqual(sorted(r["follow_up"] for r in await self.ledger()), [False, True])

    async def test_turn_withheld_when_a_source_is_closed(self):
        await self.put("plan", "Launch plan", "# Launch plan\n\nThe launch is codename-heron on the 12th.")
        await self.index_all()
        done = self.done(await self.ask("wv", "When is the launch?"))
        self.assertIn("Launch plan", json.dumps(done["citations"]))
        tid = done["thread_id"]
        await self.db["documents"].update_one({"slug": "plan"}, {"$set": {"access_level": "private",
                                                                         "owner_id": self.uid["wm2"]}})
        t = (await self.http.get(f"/api/v1/ask/threads/{tid}", headers=self.session("wv"))).json()
        turn = t["turns"][0]
        self.assertTrue(turn["withheld"])
        self.assertIsNone(turn["answer"])
        self.assertEqual(turn["citations"], [])
        self.assertNotIn("heron", json.dumps(t))
        # A follow-up doesn't send the withheld answer to the model.
        self.fake.calls.clear()
        self.answer_extra = ""
        self.done(await self.ask("wv", "and after that?", thread_id=tid))
        self.assertNotIn("Earlier in this conversation", self.prompts())

    async def test_threads_are_private_to_the_asker(self):
        await self.put("x", "Roadmap", "# Roadmap\n\nQ1 themes.")
        await self.index_all()
        tid = self.done(await self.ask("wm", "What is on the roadmap?"))["thread_id"]
        for method in ("get", "delete"):
            r = await getattr(self.http, method)(f"/api/v1/ask/threads/{tid}", headers=self.session("wv"))
            self.assertEqual(r.status_code, 404)
        self.assertEqual((await self.http.get("/api/v1/ask/threads", headers=self.session("wv"))).json()["threads"], [])
        events = await self.ask("wv", "more?", thread_id=tid)
        self.assertEqual(events[-1], ("error", {"type": "error", "detail": "That conversation isn't there any more.",
                                                "code": "not_found"}))
        self.assertEqual((await self.http.get(f"/api/v1/ask/threads/{tid}x", headers=self.session("wm"))).status_code, 404)
        self.assertEqual((await self.http.delete(f"/api/v1/ask/threads/{tid}", headers=self.session("wm"))).json(), {"deleted": 1})
        self.done(await self.ask("wm", "What is on the roadmap?"))
        self.assertEqual((await self.http.delete("/api/v1/ask/threads", headers=self.session("wm"))).json(), {"deleted": 1})
        self.assertEqual((await self.http.get("/api/v1/ask", headers=self.session("wm"))).status_code, 405)
        self.assertEqual((await self.http.post("/api/v1/ask", json={"question": "hi"})).status_code, 401)
        self.assertIsNone(await self.db[ask_markdrop.COLL].find_one({}))

    async def test_thread_expiry_and_turn_cap(self):
        await self.put("x", "Roadmap", "# Roadmap\n\nQ1 themes.")
        await self.index_all()
        tid = self.done(await self.ask("wm", "What is on the roadmap?"))["thread_id"]
        row = await self.db[ask_markdrop.COLL].find_one({})
        self.assertGreater(row["expires_at"].replace(tzinfo=None), (now() + timedelta(days=89)).replace(tzinfo=None))
        with mock.patch.object(ask_markdrop, "MAX_TURNS", 3):
            for i in range(4):
                self.done(await self.ask("wm", f"roadmap follow-up {i}?", thread_id=tid))
        row = await self.db[ask_markdrop.COLL].find_one({})
        self.assertEqual([t["q"] for t in row["turns"]], ["roadmap follow-up 1?", "roadmap follow-up 2?", "roadmap follow-up 3?"])


class Intents(AskWorld):
    async def test_catch_up(self):
        await self.import_meeting()
        await self.put("fresh", "Fresh spec", "# Fresh spec\n\nWe changed the billing flow.")
        old = await self.put("stale", "Stale spec", "# Stale spec\n\nAn old plan.")
        await self.db["documents"].update_one({"_id": old["_id"]}, {"$set": {"updated_at": now() - timedelta(days=10)}})
        await self.put("hidden", "Hidden fresh", "Private fresh moth-3.", owner="wm2", state="P", ws="W2")
        await self.index_all()
        self.fake.calls.clear()
        done = self.done(await self.ask("wm", "Catch me up on this week"))
        self.assertEqual(done["intent"], "catch_up")
        calls = self.ask_calls()
        self.assertEqual(len(calls), 1)                        # no expansion
        self.assertIn("caught up", calls[0]["system"][0]["text"])
        p = prompt_of(calls[0])
        self.assertIn("Fresh spec", p)
        self.assertNotIn("Stale spec", p)
        self.assertNotIn("moth-3", p)
        first = re.search(r'<untrusted_document n="1" title="([^"]+)" kind="([^"]+)"', p)
        self.assertTrue(first.group(1).startswith("Weekly product sync"))   # meetings first
        self.assertEqual(first.group(2), "meeting")
        self.assertNotIn('kind="meeting transcript"', p)                   # the page stands for its transcript
        self.assertTrue(done["citations"])
        # The chip sends its intent with any words.
        self.fake.calls.clear()
        done = self.done(await self.ask("wm", "", intent="catch_up"))
        self.assertEqual(done["intent"], "catch_up")

    async def test_my_actions(self):
        m = await self.import_meeting()
        await self.put("ravi-private", "Someone's private todo", f'- [ ] :person[Ravi Kumar]{{id="{self.uid["wv"]}"}} Secret task kiwi-9',
                       owner="wm2", state="P", ws="W2", editor="blocks")
        await self.put("ravi-todo", "Launch prep", f'# Launch prep\n\n- [ ] :person[Ravi Kumar]{{id="{self.uid["wv"]}"}} Order the banners :date[2026-11-09] {{#b-a1b2c3d4}}',
                       editor="blocks")
        await self.index_all()
        self.fake.calls.clear()
        done = self.done(await self.ask("wv", "What are my open action items?"))
        self.assertEqual(done["intent"], "my_actions")
        calls = self.ask_calls()
        self.assertEqual(len(calls), 1)
        p = prompt_of(calls[0])
        self.assertIn("Email the Senseloaf team", p)
        self.assertNotIn("Update the onboarding docs", p)       # Bo's
        self.assertNotIn("kiwi-9", p)
        self.assertIn("Order the banners 2026-11-09", p)               # any page, not only meetings
        banners = next(c for c in done["citations"] if "banners" in (c["text"] or ""))
        self.assertTrue(banners["url"].endswith("/ravi-todo#b-a1b2c3d4"), banners["url"])
        c = next(c for c in done["citations"] if c["slug"] == m["slug"])
        self.assertRegex(c["url"], r"#b-[0-9a-f]{8}$")
        self.assertIn("Email the Senseloaf team", c["text"])
        # Priya has none: a fixed answer, no model call, no ledger row (nothing spent).
        self.fake.calls.clear()
        before = len(await self.ledger())
        done = self.done(await self.ask("wa", "", intent="my_actions"))
        self.assertEqual(done["answer"], ask_markdrop.EMPTY["my_actions"])
        self.assertEqual(self.ask_calls(), [])
        self.assertEqual(len(await self.ledger()), before)
        # Ticked: gone.
        page = await self.doc(m["slug"])
        ticked = re.sub(r"- \[ \] (:person\[Ravi Kumar\])", r"- [x] \1", page["content"])
        await self.db["documents"].update_one({"_id": page["_id"]}, {"$set": {"content": ticked}})
        done = self.done(await self.ask("wv", "", intent="my_actions"))
        self.assertEqual([c["slug"] for c in done["citations"]], ["ravi-todo"])


class Limits(AskWorld):
    async def test_switches_caps_and_ledger(self):
        await self.put("ob", "Onboarding Playbook", "Contractors get a laptop on day one.")
        await self.index_all()
        settings.search_ai_enabled = False
        ai_usage.invalidate_settings()
        self.assertEqual((await self.ask("owner", "onboarding?"))[-1][1]["reason"], "off")
        settings.search_ai_enabled = True
        await self.db[ai_usage.SETTINGS].update_one({"_id": ai_usage.BUDGETS_ID},
                                                    {"$set": {"enabled": {"search_ai": False}}}, upsert=True)
        ai_usage.invalidate_settings()
        self.assertEqual((await self.ask("owner", "onboarding?"))[-1][1]["reason"], "off")
        await self.db[ai_usage.SETTINGS].delete_many({})
        settings.search_ai_daily_usd = 0.0
        ai_usage.invalidate_settings()
        last = (await self.ask("owner", "onboarding?"))[-1]
        self.assertEqual((last[0], last[1]["reason"]), ("limit", "daily"))
        settings.search_ai_daily_usd = 2.0
        await self.db[ai_usage.SETTINGS].insert_one({"_id": f"user:{self.uid['owner']}", "blocked": True})
        ai_usage.invalidate_settings()
        self.assertEqual((await self.ask("owner", "onboarding?"))[-1][1]["reason"], "blocked")
        await self.db[ai_usage.SETTINGS].delete_many({})
        settings.anthropic_api_key = ""
        ai_usage.invalidate_settings()
        self.assertEqual((await self.ask("owner", "onboarding?"))[-1][1]["reason"], "not_configured")
        self.assertEqual(self.ask_calls(), [])
        settings.anthropic_api_key = "sk-test-not-a-real-key"
        ai_usage.invalidate_settings()
        self.done(await self.ask("owner", "onboarding?"))
        rows = await self.ledger()
        self.assertEqual({r["outcome"] for r in rows}, {"limit", "ok"})
        self.assertTrue(all(r["feature"] == "search_ai" for r in rows))
        self.assertEqual(ai_usage._reserved, {})

    async def test_upstream_error(self):
        import anthropic

        await self.put("ob", "Onboarding Playbook", "Contractors get a laptop on day one.")
        await self.index_all()
        self.fake.raise_exc = anthropic.APIConnectionError(request=mock.Mock())
        events = await self.ask("owner", "how do contractors get onboarded?")
        self.assertEqual(events[-1][0], "error")
        self.assertEqual((await self.ledger())[-1]["outcome"], "error")
        self.assertEqual(ai_usage._reserved, {})
        self.assertEqual(await self.db[ask_markdrop.COLL].count_documents({}), 0)

    async def test_empty_question(self):
        events = await self.ask("owner", "   ")
        self.assertEqual(events[-1][1]["code"], "empty_question")


class Home(AskWorld):
    async def test_home_suggestions_and_recent(self):
        await self.import_meeting(sources=[{"name": "Secret board sync", "text": "Ada Lovelace: Board stuff.\nBo Chen: Fine."}],
                                  restricted=True)
        h = (await self.http.get("/api/v1/ask/home", headers=self.session("wv"))).json()
        self.assertTrue(h["status"]["enabled"])
        self.assertEqual([s["intent"] for s in h["suggestions"]], ["catch_up", "my_actions"])   # the restricted one isn't named
        self.assertEqual(h["recent"], [])
        await self.import_meeting()
        h = (await self.http.get("/api/v1/ask/home", headers=self.session("wv"))).json()
        self.assertEqual(h["suggestions"][2]["label"], "What was decided in Weekly product sync?")
        h = (await self.http.get("/api/v1/ask/home", headers=self.session("wa"))).json()
        self.assertNotIn("Secret board", json.dumps(h))                          # an admin who wasn't there
        self.assertEqual((await self.http.get("/api/v1/ask/home")).status_code, 401)


class MCP(AskWorld):
    async def test_ask_documents_threads_and_intents(self):
        await self.import_meeting()
        await self.put("ob", "Onboarding Playbook", "# Onboarding Playbook\n\nContractors get a laptop on day one.")
        await self.index_all()
        tok = await self.mcp_token("wv", write=False)
        code, res = await self.mcp_call(tok, "ask_documents", {"question": "how do contractors get a laptop?"})
        self.assertEqual(code, 200)
        self.assertFalse(res.get("isError"), res)
        out = res["structuredContent"]
        self.assertTrue(out["thread_id"])
        self.assertIn("Onboarding Playbook", {c["title"] for c in out["citations"]})
        self.assertTrue(all(c["url"].startswith("http") for c in out["citations"]))
        self.assertEqual((await self.ledger())[-1]["via"], "mcp")
        code, res = await self.mcp_call(tok, "ask_documents", {"question": "and on day two?", "thread_id": out["thread_id"]})
        self.assertEqual(res["structuredContent"]["thread_id"], out["thread_id"])
        code, res = await self.mcp_call(tok, "ask_documents", {"question": "", "intent": "my_actions"})
        out = res["structuredContent"]
        self.assertEqual(out["intent"], "my_actions")
        self.assertIn("Email the Senseloaf team", out["citations"][0]["task"])
        settings.search_ai_daily_usd = 0.0
        ai_usage.invalidate_settings()
        code, res = await self.mcp_call(tok, "ask_documents", {"question": "onboarding?"})
        self.assertTrue(res.get("isError"))

    async def test_answer_interface_for_other_surfaces(self):
        """The function Slack's /markdrop ask calls: a dict back, nothing saved by default."""
        from app.services import access, pages_ai

        await self.put("ob", "Onboarding Playbook", "# Onboarding Playbook\n\nContractors get a laptop on day one.")
        await self.index_all()
        user = type("U", (), {"id": self.uid["wv"]})()
        actor = access.Actor(user=user, cred="session")
        out = await ask_markdrop.answer(self.db, actor, access.Ctx(self.db), "how do contractors get a laptop?")
        self.assertIn("Onboarding Playbook", {c["title"] for c in out["citations"]})
        self.assertTrue(all(c["web_url"].startswith("http") for c in out["citations"]))
        self.assertIsNone(out["thread_id"])
        self.assertEqual(await self.db[ask_markdrop.COLL].count_documents({}), 0)
        self.assertEqual((await self.ledger())[-1]["via"], "slack")
        with self.assertRaises(pages_ai.AIError) as cm:
            await ask_markdrop.answer(self.db, actor, access.Ctx(self.db), "  ")
        self.assertEqual(cm.exception.status, 400)
