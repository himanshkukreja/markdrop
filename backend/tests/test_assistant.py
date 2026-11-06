"""The assistant: one "Ask Markdrop" everywhere (services/assistant.py, POST /api/v1/ask {scope, context},
GET /api/v1/ask/context; .work/assistant/SPEC.md).

Scope routing (This doc → Ask in page with meeting memory and the reader's section; Meetings → the
meetings engine and the Meetings AI budget; This folder / Workspace / Everything → Ask Markdrop's
search under the AI search budget), one thread across scopes (history goes with a follow-up whatever
answers it), citations in one shape, and access: a folder never widens what you can open, a meeting
restricted to its attendees never reaches anyone else whatever the scope, the context endpoint names
only what you can open. The model is always the fake client.
"""

from __future__ import annotations

import re
import unittest

from tests.test_meeting_memory import MemoryWorld
from tests.test_pages_ai import parse_sse, prompt_of

from app.services import ai_usage, assistant, folder as folder_service, search_index


def system_of(call: dict) -> str:
    return call["system"][0]["text"]


class AssistantWorld(MemoryWorld):
    def script(self, params: dict) -> str:
        system = system_of(params)
        user = "\n".join(b["text"] for b in params["messages"][-1]["content"] if b.get("type") == "text")
        if system.startswith("You are Ask Markdrop"):
            ns = re.findall(r'<untrusted_document n="(\d+)"', user)
            top = ns[:3]
            return f"<ranking>{','.join(top)}</ranking>\n\nHere it is: " + " ".join(f"see [{n}]." for n in top)
        return super().script(params)

    async def ask(self, who: str, question: str, scope: dict | None = None, **body) -> list[tuple[str, dict]]:
        r = await self.http.post("/api/v1/ask", headers=self.session(who),
                                 json={"question": question, **({"scope": scope} if scope else {}), **body})
        self.assertEqual(r.status_code, 200, r.text)
        return parse_sse(r.text)

    def done(self, events) -> dict:
        self.assertEqual(events[-1][0], "done", events[-1])
        return events[-1][1]

    def calls(self, prefix: str) -> list[dict]:
        return [c for c in self.fake.calls if system_of(c).startswith(prefix)]

    async def ledger(self, feature: str) -> list[dict]:
        return await self.db[ai_usage.REQUESTS].find({"feature": feature}).to_list(length=100)

    async def prd(self, **kw) -> dict:
        doc = await self.mkdoc("W", slug="checkout-prd", title="Checkout redesign PRD", editor="blocks", grants=False,
                               content="# Checkout redesign PRD\n\n## Payments\n\nThe checkout moves to a hosted page.", **kw)
        await search_index.drain()
        return doc


class Parse(unittest.TestCase):
    def test_scopes(self):
        self.assertEqual(assistant.parse_scope(None).kind, "everything")
        self.assertEqual(assistant.parse_scope({"kind": "doc", "page": "a"}).page, "a")
        for bad in ({"kind": "doc"}, {"kind": "folder", "workspace": "a" * 24}, {"kind": "workspace"},
                    {"kind": "meetings"}, {"kind": "nope"}, {"kind": "workspace", "workspace": "x"},
                    {"kind": "meetings", "workspace": "a" * 24, "since": "yesterday"}):
            with self.assertRaises(ValueError, msg=bad):
                assistant.parse_scope(bad)
        self.assertEqual(assistant.engine_of(assistant.Scope(kind="meetings", workspace="a" * 24)), "meetings_ai")
        self.assertEqual(assistant.engine_of(assistant.Scope(kind="doc", page="x")), "search_ai")

    def test_labels(self):
        self.assertEqual(assistant.meetings_label(None, None, None), "Meetings")
        self.assertEqual(assistant.meetings_label("Daily standup", None, None), "Meetings · Daily standup")
        self.assertEqual(assistant.meetings_label(None, None, None, meeting="Pricing review"), "This meeting · Pricing review")


class Routing(AssistantWorld):
    async def test_doc_scope_is_ask_in_page_with_the_readers_section(self):
        await self.seed_all()
        prd = await self.prd()
        self.fake.calls.clear()
        done = self.done(await self.ask("wm", "When did we decide on Stripe Checkout?",
                                        {"kind": "doc", "page": prd["slug"]},
                                        context={"heading": "Payments", "selection": "moves to a hosted page"}))
        self.assertEqual(done["intent"], "page")
        self.assertEqual(done["scope"], {"kind": "doc", "label": "This page · Checkout redesign PRD"})
        self.assertEqual(done["engine"], "search_ai")
        titles = [c["title"] for c in done["citations"]]
        self.assertTrue(any(t.startswith("Checkout redesign sync") for t in titles), titles)
        p = prompt_of(self.calls("You are Ask AI inside a page")[0])
        self.assertIn("They are at the section headed: Payments", p)
        self.assertIn("<untrusted_selection>\nmoves to a hosted page\n</untrusted_selection>", p)
        # Citations carry when and where (subtitle) and what they say (quote).
        page_cite = next(c for c in done["citations"] if c["title"] == "Checkout redesign PRD")
        self.assertEqual(page_cite["source_kind"], "this page")
        meeting_cite = next(c for c in done["citations"] if c["title"].startswith("Checkout redesign sync"))
        self.assertIn("Oct 28, 2026", meeting_cite["subtitle"])
        # AI search's budget, not Meetings AI's.
        self.assertTrue(await self.ledger("search_ai"))
        self.assertFalse([r for r in await self.ledger("meetings_ai") if r.get("kind") in ("ask", "ask_all")])

    async def test_meetings_scope_uses_the_meetings_engine_and_budget(self):
        ms = await self.seed_all()
        self.fake.calls.clear()
        done = self.done(await self.ask("wm", "What did we decide about pricing?", {"kind": "meetings", "workspace": self.W}))
        self.assertEqual(done["intent"], "meetings")
        self.assertEqual(done["engine"], "meetings_ai")
        self.assertEqual(done["scope"]["kind"], "meetings")
        self.assertTrue(self.calls("You answer questions about a team's meetings"))
        self.assertFalse(self.calls("You are Ask Markdrop"))
        self.assertTrue(done["citations"])
        for c in done["citations"]:
            self.assertTrue(c["key"].startswith("d:"), c)
            self.assertTrue(c["url"].startswith("/"), c)
            self.assertIn(c["meeting_id"], {m["id"] for m in ms.values()})
        moment = next((c for c in done["citations"] if c["source_kind"] == "moment"), None)
        if moment is not None:
            self.assertTrue(moment["quote"])
            self.assertRegex(moment["url"], r"#b-t\d{4}$")
            self.assertTrue(moment["moment"].startswith(moment["speaker"] or "Someone"))
            if moment["at"]:
                self.assertIn(f" · {moment['at']}", moment["moment"])
        rows = [r for r in await self.ledger("meetings_ai") if r.get("kind") == "ask_all"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["via"], "assistant")
        self.assertFalse([r for r in await self.ledger("search_ai") if r.get("outcome") == "ok"])

    async def test_a_scope_read_from_the_question_says_so(self):
        await self.seed_all()
        done = self.done(await self.ask("wm", "What came up in the Daily standup meetings?", {"kind": "meetings", "workspace": self.W}))
        label = done["scope"]["label"]
        self.assertTrue(label.startswith("From your question: ") or label == "Meetings", label)
        done = self.done(await self.ask("wm", "Anything?", {"kind": "meetings", "workspace": self.W, "since": "2026-10-01",
                                                            "until": "2026-10-31"}))
        self.assertTrue(done["scope"]["label"].startswith("Meetings · "), done["scope"])

    async def test_one_meeting(self):
        ms = await self.seed_all()
        m = ms["Pricing review"]
        done = self.done(await self.ask("wm", "When do we ship?", {"kind": "meetings", "workspace": self.W, "meeting": m["id"]}))
        self.assertEqual(done["scope"]["label"], "This meeting · Pricing review")
        self.assertTrue(done["citations"])
        self.assertTrue(all(c["meeting_id"] == m["id"] for c in done["citations"]))
        self.assertTrue(all(c["title"] == "Pricing review" for c in done["citations"]))
        # A meeting that isn't there: not found.
        events = await self.ask("wm", "When?", {"kind": "meetings", "workspace": self.W, "meeting": "a" * 24})
        self.assertEqual(events[-1][1]["code"], "not_found")

    async def test_workspace_and_everything(self):
        await self.mkdoc("W", slug="roadmap-w", title="Roadmap", content="The roadmap for the launch.", grants=False)
        await search_index.drain()
        done = self.done(await self.ask("wm", "What is on the roadmap for launch?", {"kind": "workspace", "workspace": self.W}))
        self.assertEqual(done["scope"]["kind"], "workspace")
        self.assertTrue(done["scope"]["label"].startswith("Workspace"))
        self.assertIn("Roadmap", [c["title"] for c in done["citations"]])
        done = self.done(await self.ask("wm", "What is on the roadmap for launch?", {"kind": "everything"}))
        self.assertEqual(done["scope"], {"kind": "everything", "label": "Everything"})
        # Catch-up still works in Everything.
        done = self.done(await self.ask("wm", "Catch me up on this week", {"kind": "everything"}))
        self.assertEqual(done["intent"], "catch_up")

    async def test_bad_scope_is_422(self):
        r = await self.http.post("/api/v1/ask", headers=self.session("wm"), json={"question": "x", "scope": {"kind": "doc"}})
        self.assertEqual(r.status_code, 422)


class Folder(AssistantWorld):
    async def test_folder_scope_only_reads_that_folder(self):
        f = await folder_service.create_folder(self.db, self.W, "Specs", None)
        sub = await folder_service.create_folder(self.db, self.W, "Drafts", f.id)
        inside = await self.mkdoc("W", slug="spec-in", title="Launch spec inside", content="Launch plan inside.", grants=False)
        deep = await self.mkdoc("W", slug="spec-deep", title="Launch spec deep", content="Launch plan deep.", grants=False)
        await self.mkdoc("W", slug="spec-out", title="Launch spec outside", content="Launch plan outside.", grants=False)
        await self.db["documents"].update_one({"slug": inside["slug"]}, {"$set": {"folder_id": f.id}})
        await self.db["documents"].update_one({"slug": deep["slug"]}, {"$set": {"folder_id": sub.id}})
        await search_index.drain()
        self.fake.calls.clear()
        done = self.done(await self.ask("wm", "What is the launch plan?", {"kind": "folder", "workspace": self.W, "folder": f.id}))
        self.assertEqual(done["scope"], {"kind": "folder", "label": "This folder · Specs"})
        p = "\n".join(prompt_of(c) for c in self.calls("You are Ask Markdrop"))
        self.assertIn("Launch spec inside", p)
        self.assertIn("Launch spec deep", p)
        self.assertNotIn("Launch spec outside", p)
        # Someone else's folder id, or a folder of another workspace: not found.
        events = await self.ask("wm", "What is the launch plan?", {"kind": "folder", "workspace": self.W, "folder": "a" * 24})
        self.assertEqual(events[-1][1]["code"], "not_found")


class Threads(AssistantWorld):
    async def test_one_thread_across_scopes(self):
        await self.seed_all()
        prd = await self.prd()
        d1 = self.done(await self.ask("wm", "What does this page say about payments?", {"kind": "doc", "page": prd["slug"]}))
        tid = d1["thread_id"]
        self.assertTrue(tid)
        self.fake.calls.clear()
        d2 = self.done(await self.ask("wm", "And what did the pricing meetings decide?",
                                      {"kind": "meetings", "workspace": self.W}, thread_id=tid))
        self.assertEqual(d2["thread_id"], tid)
        # The doc turn went with the meetings question.
        p = prompt_of(self.calls("You answer questions about a team's meetings")[0])
        self.assertIn("What does this page say about payments?", p)
        d3 = self.done(await self.ask("wm", "Anything else in the workspace?", {"kind": "workspace", "workspace": self.W},
                                      thread_id=tid))
        self.assertEqual(d3["thread_id"], tid)
        t = (await self.http.get(f"/api/v1/ask/threads/{tid}", headers=self.session("wm"))).json()
        self.assertEqual([x["scope"]["kind"] for x in t["turns"]], ["doc", "meetings", "workspace"])
        self.assertTrue(t["turns"][1]["citations"])
        # The home lists it (it continues anywhere).
        home = (await self.http.get("/api/v1/ask/home", headers=self.session("wm"))).json()
        self.assertIn(tid, [x["id"] for x in home["recent"]])
        # Someone else can't continue it.
        events = await self.ask("wa", "More?", {"kind": "meetings", "workspace": self.W}, thread_id=tid)
        self.assertEqual(events[-1][1]["code"], "not_found")


class Access(AssistantWorld):
    async def restrict(self, title: str = "Checkout redesign sync") -> dict:
        ms = await self.seed_all()
        m = ms[title]
        r = await self.http.patch(f"/api/v1/meetings/{m['id']}", headers=self.session("owner"), json={"restricted": True})
        self.assertEqual(r.status_code, 200, r.text)
        return m

    async def test_restricted_meeting_never_reaches_others_in_any_scope(self):
        m = await self.restrict()     # Ada and Priya's call; Bo (wm) wasn't in it
        prd = await self.prd()
        self.fake.calls.clear()
        for scope in ({"kind": "meetings", "workspace": self.W}, {"kind": "doc", "page": prd["slug"]},
                      {"kind": "workspace", "workspace": self.W}, {"kind": "everything"}):
            events = await self.ask("wm", "When did we decide on Stripe Checkout?", scope)
            done = events[-1][1]
            for c in done.get("citations") or []:
                self.assertNotEqual(c.get("meeting_id"), m["id"], scope)
                self.assertNotIn(m["slug"], c.get("url") or "", scope)
        p = "\n".join(prompt_of(c) for c in self.fake.calls)
        self.assertNotIn("Use Stripe Checkout as the hosted payment page", p)
        self.assertNotIn("I agree we use Stripe Checkout", p)
        # Asking that meeting directly: not found.
        events = await self.ask("wm", "What was decided?", {"kind": "meetings", "workspace": self.W, "meeting": m["id"]})
        self.assertEqual(events[-1][1]["code"], "not_found")
        # Its attendee (Priya) gets it.
        done = self.done(await self.ask("wa", "What was decided?", {"kind": "meetings", "workspace": self.W, "meeting": m["id"]}))
        self.assertTrue(done["citations"])

    async def test_a_turn_from_a_meeting_closed_later_is_withheld(self):
        ms = await self.seed_all()
        m = ms["Checkout redesign sync"]
        done = self.done(await self.ask("wm", "What was decided?", {"kind": "meetings", "workspace": self.W, "meeting": m["id"]}))
        tid = done["thread_id"]
        await self.http.patch(f"/api/v1/meetings/{m['id']}", headers=self.session("owner"), json={"restricted": True})
        t = (await self.http.get(f"/api/v1/ask/threads/{tid}", headers=self.session("wm"))).json()
        self.assertTrue(t["turns"][0]["withheld"])
        self.assertIsNone(t["turns"][0]["answer"])
        # …and its text never goes with a follow-up.
        self.fake.calls.clear()
        self.done(await self.ask("wm", "Anything else?", {"kind": "everything"}, thread_id=tid))
        self.assertNotIn("Stripe", "\n".join(prompt_of(c) for c in self.fake.calls))

    async def test_not_a_member(self):
        for scope in ({"kind": "workspace", "workspace": self.W}, {"kind": "meetings", "workspace": self.W}):
            events = await self.ask("stranger", "What?", scope)
            self.assertEqual(events[-1][1]["code"], "not_found")


class Context(AssistantWorld):
    async def ctx(self, who: str, **params) -> dict:
        r = await self.http.get("/api/v1/ask/context", headers=self.session(who), params=params)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def test_in_a_page(self):
        prd = await self.prd()
        c = await self.ctx("wm", page=prd["slug"])
        self.assertEqual([s["kind"] for s in c["scopes"]], ["doc", "meetings", "workspace", "mine", "everything"])
        self.assertEqual(c["default"], "doc")
        self.assertEqual(c["page"]["title"], "Checkout redesign PRD")
        self.assertEqual(c["workspace"]["id"], self.W)
        self.assertTrue(c["can_insert"])
        self.assertTrue(c["status"]["search"]["enabled"])
        self.assertTrue(c["status"]["meetings"]["enabled"])
        # A viewer of the workspace reads it but can't insert.
        v = await self.ctx("wv", page=prd["slug"])
        self.assertEqual(v["default"], "doc")
        self.assertFalse(v["can_insert"])
        # Someone who can't open it: no doc scope, nothing named.
        secret = await self.mkdoc("P", slug="secret-ctx", title="Secret plan", editor="blocks", grants=False)
        s = await self.ctx("wm", page=secret["slug"])
        self.assertIsNone(s["page"])
        self.assertNotIn("doc", [x["kind"] for x in s["scopes"]])
        self.assertNotIn("Secret plan", str(s))

    async def test_on_a_meeting_page_and_the_series(self):
        ms = await self.seed_all()
        m = ms["Pricing review"]
        c = await self.ctx("wm", page=m["slug"])
        self.assertEqual(c["default"], "meetings")
        self.assertEqual(c["meeting"]["id"], m["id"])
        c = await self.ctx("wm", workspace=self.W, meeting=m["id"])
        self.assertEqual(c["default"], "meetings")
        # A restricted meeting isn't named to someone who wasn't in it.
        r = ms["Checkout redesign sync"]
        await self.http.patch(f"/api/v1/meetings/{r['id']}", headers=self.session("owner"), json={"restricted": True})
        c = await self.ctx("wm", workspace=self.W, meeting=r["id"])
        self.assertIsNone(c["meeting"])
        self.assertNotIn("Checkout redesign sync", str(c))

    async def test_folder_and_workspace(self):
        f = await folder_service.create_folder(self.db, self.W, "Specs", None)
        c = await self.ctx("wm", workspace=self.W, folder=f.id)
        self.assertEqual([s["kind"] for s in c["scopes"]], ["meetings", "folder", "workspace", "mine", "everything"])
        self.assertEqual(c["default"], "folder")
        self.assertEqual(c["folder"]["name"], "Specs")
        c = await self.ctx("wm", workspace=self.W)
        self.assertEqual(c["default"], "workspace")
        # Not a member: only Everything.
        c = await self.ctx("stranger", workspace=self.W, folder=f.id)
        self.assertEqual([s["kind"] for s in c["scopes"]], ["mine", "everything"])
        self.assertIsNone(c["workspace"])


class Mcp(AssistantWorld):
    async def test_ask_documents_page_and_folder(self):
        await self.seed_all()
        prd = await self.prd()
        f = await folder_service.create_folder(self.db, self.W, "Specs", None)
        inside = await self.mkdoc("W", slug="spec-in", title="Launch spec inside", content="Launch plan inside.", grants=False)
        await self.mkdoc("W", slug="spec-out", title="Launch spec outside", content="Launch plan outside.", grants=False)
        await self.db["documents"].update_one({"slug": inside["slug"]}, {"$set": {"folder_id": f.id}})
        await search_index.drain()
        tok = await self.mcp_token("wm", write=False)
        code, res = await self.mcp_call(tok, "ask_documents", {"question": "When did we decide on Stripe Checkout?",
                                                               "page": f"https://markdrop.in/{prd['slug']}"})
        self.assertFalse(res.get("isError"), res)
        self.assertEqual(res["structuredContent"]["intent"], "page")
        self.fake.calls.clear()
        code, res = await self.mcp_call(tok, "ask_documents", {"question": "What is the launch plan?",
                                                               "scope": f"workspace:{self.W}", "folder": f.id})
        self.assertFalse(res.get("isError"), res)
        p = "\n".join(prompt_of(c) for c in self.calls("You are Ask Markdrop"))
        self.assertIn("Launch spec inside", p)
        self.assertNotIn("Launch spec outside", p)
        code, res = await self.mcp_call(tok, "ask_documents", {"question": "What?", "folder": f.id})
        self.assertTrue(res.get("isError"))


if __name__ == "__main__":
    unittest.main()
