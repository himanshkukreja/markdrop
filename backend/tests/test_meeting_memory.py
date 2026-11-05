"""Meeting memory while writing (services/meeting_memory.py, routers/meeting_memory.py, ask_markdrop
intent "page", MCP meeting_context; .work/meeting-memory/SPEC.md).

Facts come from the meeting summary's own output (no extra model call), on import, regenerate and a
background backfill; they leave with the meeting. Relevance on seeded meetings (a PRD titled after a
topic finds that topic's decision first), the clear-match hint, the AI check (fake model, cached,
under meetings_ai), Ask AI in a page citing the meeting, the MCP tool, the switches — and access: a
meeting restricted to its attendees never reaches anyone else. The model is always the fake client.
"""

from __future__ import annotations

import asyncio
import json
import re

from tests._access_env import AccessWorld, now  # noqa: F401  (pins settings first)
from tests.test_meetings import GEN, fake_script as meetings_script
from tests.test_pages_ai import AIEnv, parse_sse, prompt_of

from bson import ObjectId

from app.config import get_settings
from app.services import ai_usage, ask_markdrop, meeting_memory, meetings, search_index

settings = get_settings()
_SAVED = ("search_ai_enabled", "search_ai_daily_usd", "search_ai_monthly_usd", "meetings_ai_enabled",
          "meetings_ai_daily_usd", "meetings_ai_monthly_usd")

# Three calls of the team, each with its own decisions (the fake model reads the title it is sent).
SEEDS = {
    "Checkout redesign sync": {
        "date": "2026-10-28",
        "lines": ["Ada Lovelace: Let's settle the checkout redesign today.",
                  "Priya Sharma: I agree we use Stripe Checkout for the hosted payment page.",
                  "Ada Lovelace: Decided. Priya will draft the migration plan by Friday."],
        "gen": {"summary": "Checkout redesign: Stripe Checkout.", "highlights": [],
                "decisions": [{"text": "Use Stripe Checkout as the hosted payment page for the checkout redesign.", "cite": "s2"}],
                "action_items": [{"text": "Draft the checkout migration plan", "owner": "Priya Sharma", "due": "Friday", "cite": "s3"}],
                "open_questions": [{"text": "Do we keep Apple Pay in the first release of the checkout?", "cite": "s1"}],
                "topics": [{"title": "Checkout redesign", "gist": "Moving payments to Stripe Checkout.", "cite": "s1"}],
                "type": "Planning"},
    },
    "Pricing review": {
        "date": "2026-11-03",
        "lines": ["Bo Chen: Annual plans need a discount.", "Ada Lovelace: We agreed on twenty percent off annual plans."],
        "gen": {"summary": "Pricing.", "highlights": [],
                "decisions": [{"text": "Annual plans get a twenty percent discount from January.", "cite": "s2"}],
                "action_items": [], "open_questions": [], "topics": [{"title": "Annual pricing", "gist": "Discount for annual plans.", "cite": "s1"}],
                "type": "Review"},
    },
    "Daily standup": {
        "date": "2026-11-04",
        "lines": ["Bo Chen: I fixed the flaky login test.", "Ada Lovelace: Good, the onboarding emails go out Monday."],
        "gen": {"summary": "Standup.", "highlights": [],
                "decisions": [{"text": "Onboarding emails go out on Monday.", "cite": "s2"}],
                "action_items": [{"text": "Fix the flaky login test", "owner": "Bo Chen", "due": None, "cite": "s1"}],
                "open_questions": [], "topics": [], "type": "Standup"},
    },
}


class MemoryWorld(AccessWorld, AIEnv):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await ai_usage.ensure_indexes(self.db)
        await meetings.ensure_indexes(self.db)
        await search_index.ensure_indexes(self.db)
        await ask_markdrop.ensure_indexes(self.db)
        await meeting_memory.ensure_indexes(self.db)
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
        self.check_reply = None
        self.fake.script = self.script

    async def asyncTearDown(self):
        for t in list(meetings._bg):
            await asyncio.wait({t}, timeout=10)
        await super().asyncTearDown()

    def script(self, params: dict) -> str:
        system = params["system"][0]["text"]
        user = "\n".join(b["text"] for b in params["messages"][-1]["content"] if b.get("type") == "text")
        if system.startswith("You write the team's notes"):
            m = re.search(r"Title: ([^\n]+)", user)
            seed = SEEDS.get((m.group(1) if m else "").strip())
            return json.dumps(seed["gen"] if seed else GEN)
        if system.startswith("You compare a section"):
            if self.check_reply is not None:
                return self.check_reply
            return json.dumps({"results": [{"id": "d1", "verdict": "contradicts", "note": "The section says Adyen."}]})
        if "Return only JSON" in system and "standalone" in system:
            q = user.rsplit("Search: ", 1)[-1]
            words = [w for w in re.findall(r"[A-Za-z]{4,}", q) if w.lower() not in ("what", "when", "does", "with", "decide")]
            return json.dumps({"standalone": q, "terms": words[:6], "titles": []})
        if system.startswith("You are Ask AI inside a page"):
            ns = re.findall(r'<untrusted_document n="(\d+)"', user)
            meeting_n = re.search(r'<untrusted_document n="(\d+)"[^>]*kind="meeting"', user)
            pick = meeting_n.group(1) if meeting_n else (ns[0] if ns else "1")
            return f"<ranking>{pick},1</ranking>\n\nThe team decided it on Oct 28, 2026 [{pick}]. The page agrees [1]."
        return meetings_script(params)

    async def seed(self, title: str, *, who: str = "owner", **body) -> dict:
        s = SEEDS[title]
        r = await self.http.post("/api/v1/meetings/import", headers=self.session(who), json={
            "workspace": self.W, "sources": [{"name": title, "text": "\n".join(s["lines"])}], "title": title,
            "date": s["date"], "wait": True, **body})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["meetings"][0]

    async def seed_all(self) -> dict[str, dict]:
        return {t: await self.seed(t) for t in SEEDS}

    async def related(self, who: str = "wm", **body):
        r = await self.http.post("/api/v1/meeting-memory/related", headers=self.session(who),
                                 json={"workspace": self.W, **body})
        return r

    async def facts_of(self, mid: str) -> list[dict]:
        return await self.db[meeting_memory.COLL].find({"meeting_id": mid}).sort("ord", 1).to_list(100)


import unittest  # noqa: E402


class Extract(unittest.TestCase):
    def test_from_summary_and_google_steps(self):
        people = meetings.People([{"id": "u1", "name": "Priya Sharma", "email": "priya@acme.test"},
                                  {"id": "u2", "name": "Bo Chen", "email": "bo@acme.test"}])
        row = {"_id": ObjectId(), "workspace_id": "w", "doc_id": ObjectId(), "title": "Weekly sync", "date": "2026-11-04",
               "type": "Planning", "series": "Weekly sync",
               "segments": [{"t": 10 * i, "speaker": "Ada", "text": f"line {i}"} for i in range(1, 13)],
               "notes": {"next_steps": ["Priya Sharma <priya@acme.test> will run the migration dry run."]},
               "generated": GEN}
        fs = meeting_memory.extract(row, people)
        self.assertEqual([f["kind"] for f in fs], ["decision", "action_item", "action_item", "action_item", "action_item",
                                                   "open_question", "topic"])
        self.assertEqual([f["ord"] for f in fs], list(range(7)))
        d = fs[0]
        self.assertEqual((d["seg"], d["seg_t"], d["seg_speaker"]), (4, 40, "Ada"))
        self.assertEqual((d["date"], d["meeting_title"], d["series"], d["source"]), ("2026-11-04", "Weekly sync", "Weekly sync", "ai"))
        g = fs[1]
        self.assertEqual((g["source"], g["owner"], g["owner_id"]), ("google", "Priya Sharma", "u1"))
        self.assertNotIn("@", g["text"])
        bo = fs[3]
        self.assertEqual((bo["owner"], bo["owner_id"], bo["due"]), ("Bo Chen", "u2", "next Wednesday"))
        self.assertIsNone(fs[4]["seg"])                    # s99999 is out of range
        self.assertEqual(fs[4]["owner_id"], None)          # not a member: the name as said
        t = fs[-1]
        self.assertEqual((t["title"], t["gist"]), ("Release timing", "Friday, after the dry run."))
        row2 = meeting_memory.index_row(t)
        self.assertEqual(row2["src"], "meeting_fact")
        self.assertIn("release", row2["hw"])
        self.assertIn("weekly", row2["hw"])
        self.assertIn("friday", row2["w"])

    def test_insert_markdown(self):
        f = {"kind": "decision", "text": "Use Stripe [Checkout] {now}", "seg": 2}
        md = meeting_memory.insert_markdown(f, {"date": "2026-10-28", "title": "Checkout [sync]", "slug": "m-1"},
                                            {"clock": "0:12", "url": "/t-1#b-t0002"})
        self.assertEqual(md, '**Decided on Oct 28, 2026** (:markdrop[Checkout sync]{src="m-1"}): '
                             'Use Stripe \\[Checkout\\] (now) ([0:12](/t-1#b-t0002))')
        a = {"kind": "action_item", "text": "Draft the plan", "owner": "Priya Sharma", "owner_id": "u1", "due": "Friday"}
        md = meeting_memory.insert_markdown(a, {"date": "2026-10-28", "title": "Sync", "series": "Weekly", "slug": "m"}, None)
        self.assertEqual(md, '**Action item from Oct 28, 2026** (:markdrop[Weekly]{src="m"}): '
                             ':person[Priya Sharma]{id="u1"} Draft the plan · due Friday')


class Sync(MemoryWorld):
    async def test_import_writes_facts_and_search_rows(self):
        m = await self.seed("Checkout redesign sync")
        fs = await self.facts_of(m["id"])
        self.assertEqual([f["kind"] for f in fs], ["decision", "action_item", "open_question", "topic"])
        self.assertEqual(fs[1]["owner_id"], self.uid["wa"])
        rows = await self.db[search_index.COLL].find({"src": "meeting_fact"}).to_list(100)
        self.assertEqual({r["_id"] for r in rows}, {f"mf:{f['_id']}" for f in fs})
        row = await self.db["meetings"].find_one({"_id": ObjectId(m["id"])})
        self.assertEqual((row["memory"]["v"], row["memory"]["n"]), (meeting_memory.VERSION, 4))
        # One model call for the meeting: the facts are its own output.
        self.assertEqual(len([c for c in self.fake.calls if c["system"][0]["text"].startswith("You write")]), 1)
        self.assertEqual(len(self.fake.calls), 1)

    async def test_regenerate_replaces_and_delete_drops(self):
        m = await self.seed("Pricing review")
        old = {f["_id"] for f in await self.facts_of(m["id"])}
        SEEDS["Pricing review"]["gen"]["decisions"].append({"text": "Monthly plans stay at the same price.", "cite": "s1"})
        try:
            r = await self.http.post(f"/api/v1/meetings/{m['id']}/regenerate", headers=self.session("owner"))
            self.assertEqual(r.status_code, 200, r.text)
        finally:
            SEEDS["Pricing review"]["gen"]["decisions"].pop()
        fs = await self.facts_of(m["id"])
        self.assertEqual([f["text"] for f in fs if f["kind"] == "decision"],
                         ["Annual plans get a twenty percent discount from January.", "Monthly plans stay at the same price."])
        self.assertFalse(old & {f["_id"] for f in fs})
        self.assertEqual(await self.db[search_index.COLL].count_documents({"_id": {"$in": [f"mf:{i}" for i in old]}}), 0)
        r = await self.http.delete(f"/api/v1/meetings/{m['id']}", headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(await self.db[meeting_memory.COLL].count_documents({}), 0)
        self.assertEqual(await self.db[search_index.COLL].count_documents({"src": "meeting_fact"}), 0)

    async def test_backfill_and_changes_through_other_paths(self):
        ms = await self.seed_all()
        # Meetings from before the feature: no facts, no stamp.
        await self.db[meeting_memory.COLL].delete_many({})
        await self.db[search_index.COLL].delete_many({"src": "meeting_fact"})
        await self.db["meetings"].update_many({}, {"$unset": {"memory": ""}})
        got = await meeting_memory.background(self.db)
        self.assertEqual(got["synced"], 3)
        self.assertEqual(await self.db[meeting_memory.COLL].count_documents({}), 4 + 2 + 2)
        self.assertEqual((await meeting_memory.background(self.db))["synced"], 0)
        # A change that didn't go through the hook (a rename): the next pass re-derives that meeting.
        mid = ObjectId(ms["Daily standup"]["id"])
        await asyncio.sleep(0.01)
        await self.db["meetings"].update_one({"_id": mid}, {"$set": {"title": "Team standup", "updated_at": meetings.now_utc()}})
        self.assertEqual((await meeting_memory.background(self.db))["synced"], 1)
        f = await self.db[meeting_memory.COLL].find_one({"meeting_id": str(mid)})
        self.assertEqual(f["meeting_title"], "Team standup")
        # A meeting gone without the hook: its facts are swept.
        await self.db["meetings"].delete_one({"_id": mid})
        meeting_memory._last_sweep.clear()
        await meeting_memory.background(self.db)
        self.assertEqual(await self.db[meeting_memory.COLL].count_documents({"meeting_id": str(mid)}), 0)


class Related(MemoryWorld):
    async def test_prd_titled_after_a_topic_finds_its_decision_first(self):
        await self.seed_all()
        r = await self.related(title="Checkout redesign PRD")
        self.assertEqual(r.status_code, 200, r.text)
        got = r.json()
        self.assertEqual(got["meetings"], 3)
        first = got["facts"][0]
        self.assertEqual(first["kind"], "decision")
        self.assertIn("Stripe Checkout", first["text"])
        self.assertEqual(first["meeting"]["title"], "Checkout redesign sync")
        self.assertEqual(first["meeting"]["date"], "2026-10-28")
        self.assertTrue(first["moment"]["href"].endswith("#b-t0002"))
        self.assertIn("Priya Sharma", first["moment"]["label"])
        self.assertTrue(first["markdown"].startswith("**Decided on Oct 28, 2026** (:markdrop[Checkout redesign sync]"))
        self.assertTrue(first["cite"].startswith("Decided on Oct 28, 2026 (Checkout redesign sync): Use Stripe"))
        self.assertNotIn("twenty percent", " ".join(f["text"] for f in got["facts"][:3]))
        # The section under the caret moves the answer: pricing.
        r = await self.related(title="Checkout redesign PRD", heading="Pricing and annual plans")
        self.assertIn("twenty percent", r.json()["facts"][0]["text"])
        # A typo'd typed search still finds it; kinds filter.
        r = await self.related(q="onbording emails", kinds=["decision"])
        self.assertEqual(r.json()["facts"][0]["text"], "Onboarding emails go out on Monday.")
        self.assertEqual({f["kind"] for f in r.json()["facts"]}, {"decision"})
        # Action items carry owner, due and their checklist status from the meeting page.
        r = await self.related(q="migration plan", kinds=["action_item"])
        a = r.json()["facts"][0]
        self.assertEqual((a["owner"], a["due"], a["status"]), ("Priya Sharma", "Friday", "open"))

    async def test_page_and_its_own_meeting(self):
        ms = await self.seed_all()
        prd = await self.mkdoc("W", slug="checkout-prd", title="Checkout redesign PRD", content="# Checkout redesign PRD\n",
                               editor="blocks", grants=False)
        r = await self.http.post("/api/v1/meeting-memory/related", headers=self.session("wm"),
                                 json={"page": prd["slug"], "title": prd["title"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["workspace_id"], self.W)
        self.assertIn("Stripe", r.json()["facts"][0]["text"])
        # On a meeting's own page, that meeting isn't suggested to itself.
        mp = ms["Checkout redesign sync"]
        r = await self.http.post("/api/v1/meeting-memory/related", headers=self.session("wm"),
                                 json={"page": mp["slug"], "title": "Checkout redesign"})
        self.assertFalse(any(f["meeting"]["id"] == mp["id"] for f in r.json()["facts"]))
        # Not a member of the workspace: nothing.
        r = await self.http.post("/api/v1/meeting-memory/related", headers=self.session("stranger"),
                                 json={"workspace": self.W, "title": "Checkout"})
        self.assertEqual(r.status_code, 404)

    async def test_hint_only_for_a_clear_match(self):
        await self.seed_all()
        r = await self.related(title="Checkout redesign PRD", heading="Checkout payment page",
                               section="## Checkout payment page\n\nWe build our own card form with Adyen.")
        hints = r.json()["hints"]
        self.assertEqual(len(hints), 1)
        self.assertEqual(hints[0]["kind"], "omits")
        self.assertIn("On Oct 28, 2026 the team decided: Use Stripe Checkout", hints[0]["message"])
        self.assertEqual(hints[0]["fact"], r.json()["facts"][0]["id"])
        # The section already says it: no hint.
        r = await self.related(title="Checkout redesign PRD", heading="Checkout payment page",
                               section="We use Stripe Checkout as the hosted payment page for the redesign.")
        self.assertEqual(r.json()["hints"], [])
        # A loose match (only the title, nothing about the heading): no hint.
        r = await self.related(title="Q4 plan", heading="Team offsite", section="Lisbon in March.")
        self.assertEqual(r.json()["hints"], [])
        # Switched off by the person: no hints.
        r = await self.http.patch("/api/v1/meeting-memory/prefs", headers=self.session("wm"), json={"hints": False})
        self.assertEqual(r.json(), {"panel": True, "hints": False})
        r = await self.related(title="Checkout redesign PRD", heading="Checkout payment page",
                               section="We build our own card form with Adyen.")
        self.assertEqual(r.json()["hints"], [])
        self.assertEqual(r.json()["prefs"], {"panel": True, "hints": False})
        r = await self.http.get("/api/v1/meeting-memory/prefs", headers=self.session("owner"))
        self.assertEqual(r.json(), {"panel": True, "hints": True})


class Access(MemoryWorld):
    async def restricted_checkout(self) -> dict:
        m = await self.seed("Checkout redesign sync")
        r = await self.http.patch(f"/api/v1/meetings/{m['id']}", headers=self.session("owner"), json={"restricted": True})
        self.assertEqual(r.status_code, 200, r.text)
        return m

    async def test_restricted_meeting_never_reaches_others(self):
        m = await self.restricted_checkout()
        await self.seed("Pricing review")
        # Priya spoke in it (an attendee, granted); Bo did not.
        r = await self.related("wa", title="Checkout redesign PRD")
        self.assertIn("Stripe", r.json()["facts"][0]["text"])
        r = await self.related("wm", title="Checkout redesign PRD", heading="Checkout payment page",
                               section="We build our own card form.")
        body = json.dumps(r.json())
        self.assertNotIn("Stripe", body)
        self.assertNotIn(m["id"], body)
        self.assertEqual(r.json()["meetings"], 1)
        self.assertEqual(r.json()["hints"], [])
        # The AI check with that meeting's fact ids: dropped before any model call.
        prd = await self.mkdoc("W", slug="prd", title="Checkout PRD", content="# x", editor="blocks", grants=False, owner="wm")
        ids = [str(f["_id"]) for f in await self.facts_of(m["id"]) if f["kind"] == "decision"]
        self.fake.calls.clear()
        r = await self.http.post("/api/v1/meeting-memory/check", headers=self.session("wm"),
                                 json={"page": prd["slug"], "section": "We build our own card form with Adyen today.", "facts": ids})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["results"], [])
        self.assertEqual(self.fake.calls, [])
        # MCP: the same.
        token = await self.mcp_token("wm", write=False)
        status, res = await self.mcp_call(token, "meeting_context", {"workspace": self.W, "topic": "checkout stripe"})
        self.assertEqual(status, 200)
        self.assertNotIn("Stripe", json.dumps(res))
        # Ask AI in a page: the restricted decision is never sent.
        r = await self.http.post("/api/v1/ask", headers=self.session("wm"),
                                 json={"question": "When did we decide on Stripe Checkout?", "page": prd["slug"]})
        self.assertEqual(r.status_code, 200, r.text)
        sent = "\n".join(prompt_of(c) for c in self.fake.calls)
        self.assertNotIn("Use Stripe Checkout as the hosted", sent)
        # Lifted: Bo sees it again.
        await self.http.patch(f"/api/v1/meetings/{m['id']}", headers=self.session("owner"), json={"restricted": False})
        r = await self.related("wm", title="Checkout redesign PRD")
        self.assertIn("Stripe", r.json()["facts"][0]["text"])

    async def test_transcript_moment_needs_the_transcript(self):
        m = await self.seed("Checkout redesign sync")
        t = await self.doc(m["transcript_slug"])
        await self.db["documents"].update_one({"_id": t["_id"]}, {"$set": {"access_inherit": False, "access_level": "private"}})
        r = await self.related("wm", title="Checkout redesign PRD")
        f = r.json()["facts"][0]
        self.assertIsNone(f["moment"])
        self.assertEqual(f["href"], f"/{m['slug']}")
        self.assertNotIn(m["transcript_slug"], f["markdown"])


class Check(MemoryWorld):
    async def test_ai_check_is_cached_and_metered(self):
        await self.seed_all()
        prd = await self.mkdoc("W", slug="prd2", title="Checkout PRD", content="# x", editor="blocks", grants=False, owner="wm")
        r = await self.related(title="Checkout redesign PRD", kinds=["decision"])
        ids = [r.json()["facts"][0]["id"]]
        self.fake.calls.clear()
        body = {"page": prd["slug"], "heading": "Payments", "section": "We will build our own card form with Adyen.", "facts": ids}
        r = await self.http.post("/api/v1/meeting-memory/check", headers=self.session("wm"), json=body)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"results": [{"id": ids[0], "verdict": "contradicts", "note": "The section says Adyen."}],
                                    "cached": False})
        self.assertEqual(len(self.fake.calls), 1)
        p = prompt_of(self.fake.calls[0])
        self.assertIn("<untrusted_section>", p)
        self.assertIn("[d1] (2026-10-28, Checkout redesign sync) Use Stripe Checkout", p)
        self.assertEqual(self.fake.calls[0]["model"], "claude-haiku-5-5")
        r = await self.http.post("/api/v1/meeting-memory/check", headers=self.session("wm"), json=body)
        self.assertTrue(r.json()["cached"])
        self.assertEqual(len(self.fake.calls), 1)
        rows = await self.db[ai_usage.REQUESTS].find({"feature": "meetings_ai", "kind": "check"}).to_list(10)
        self.assertEqual(len(rows), 1)
        # A viewer can't run it on a page they can't edit; AI off answers a reason, no call.
        r = await self.http.post("/api/v1/meeting-memory/check", headers=self.session("wv"), json=body)
        self.assertEqual(r.status_code, 403)
        settings.meetings_ai_enabled = False
        ai_usage.invalidate_settings()
        r = await self.http.post("/api/v1/meeting-memory/check", headers=self.session("wm"),
                                 json={**body, "section": "Something else entirely about the card form."})
        self.assertEqual(r.json()["reason"], "off")
        self.assertEqual(len(self.fake.calls), 1)

    async def test_bad_output_and_unknown_labels(self):
        self.assertEqual(meeting_memory.parse_check("nope", {"d1": "a"}), [])
        got = meeting_memory.parse_check('{"results":[{"id":"d9","verdict":"contradicts"},{"id":"[d1]","verdict":"omits","note":"x"},'
                                         '{"id":"d1","verdict":"maybe"}]}', {"d1": "a"})
        self.assertEqual(got, [{"id": "a", "verdict": "omits", "note": "x"}])


class AskInPage(MemoryWorld):
    async def test_ask_in_page_cites_the_meeting(self):
        ms = await self.seed_all()
        prd = await self.mkdoc("W", slug="checkout-prd", title="Checkout redesign PRD", editor="blocks", grants=False,
                               content="# Checkout redesign PRD\n\n## Payments\n\nThe checkout moves to a hosted page.")
        await search_index.drain()
        self.fake.calls.clear()
        r = await self.http.post("/api/v1/ask", headers=self.session("wm"),
                                 json={"question": "When did we decide on Stripe Checkout?", "page": prd["slug"]})
        self.assertEqual(r.status_code, 200, r.text)
        events = parse_sse(r.text)
        self.assertEqual(events[-1][0], "done", events[-1])
        done = events[-1][1]
        self.assertEqual(done["intent"], "page")
        titles = [c["title"] for c in done["citations"]]
        self.assertTrue(any(t.startswith("Checkout redesign sync") for t in titles), titles)
        self.assertIn("Checkout redesign PRD", titles)
        meeting_cite = next(c for c in done["citations"] if c["title"].startswith("Checkout redesign sync"))
        self.assertTrue(meeting_cite["url"].endswith(ms["Checkout redesign sync"]["slug"]))
        p = prompt_of([c for c in self.fake.calls if c["system"][0]["text"].startswith("You are Ask AI inside a page")][0])
        self.assertIn('kind="this page"', p)
        self.assertIn("The checkout moves to a hosted page.", p)
        self.assertIn("Recorded in this meeting:", p)
        self.assertIn("- Decision: Use Stripe Checkout as the hosted payment page", p)
        self.assertIn('date="2026-10-28"', p)
        self.assertIn("answer from the meetings first", p)
        # A page conversation stays off the home's recent questions; a follow-up continues it.
        home = (await self.http.get("/api/v1/ask/home", headers=self.session("wm"))).json()
        self.assertEqual(home["recent"], [])
        r = await self.http.post("/api/v1/ask", headers=self.session("wm"), json={
            "question": "And who drafts the migration plan?", "page": prd["slug"], "thread_id": done["thread_id"]})
        self.assertEqual(parse_sse(r.text)[-1][1]["thread_id"], done["thread_id"])
        # A page the asker can't open: not found.
        secret = await self.mkdoc("P", slug="secret-prd", title="Secret", editor="blocks", grants=False, owner="owner")
        r = await self.http.post("/api/v1/ask", headers=self.session("wm"), json={"question": "What?", "page": secret["slug"]})
        self.assertEqual(parse_sse(r.text)[-1][1]["code"], "not_found")


class Mcp(MemoryWorld):
    async def test_meeting_context(self):
        await self.seed_all()
        token = await self.mcp_token("wm", write=False)
        status, res = await self.mcp_call(token, "meeting_context", {"workspace": self.W, "topic": "checkout redesign"})
        self.assertEqual(status, 200)
        out = res["structuredContent"]
        self.assertEqual(out["meetings"], 3)
        f = out["facts"][0]
        self.assertEqual((f["kind"], f["date"]), ("decision", "2026-10-28"))
        self.assertIn("Stripe Checkout", f["text"])
        self.assertTrue(f["moment_url"].startswith("http"))
        self.assertTrue(f["markdown"].startswith("**Decided on Oct 28, 2026**"))
        text = res["content"][0]["text"]
        self.assertIn("Decision (2026-10-28, Checkout redesign sync): Use Stripe Checkout", text)
        # From a page: its title and headings are the topic.
        await self.mkdoc("W", slug="pricing-prd", title="Pricing PRD", editor="blocks", grants=False,
                         content="# Pricing PRD\n\n## Annual plans\n\nTBD")
        status, res = await self.mcp_call(token, "meeting_context", {"page": "pricing-prd"})
        self.assertIn("twenty percent", res["structuredContent"]["facts"][0]["text"])
        status, res = await self.mcp_call(token, "meeting_context", {"workspace": self.W})
        self.assertTrue(res.get("isError"))
