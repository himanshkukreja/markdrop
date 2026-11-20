"""Ask's index (AI quality stage 2, .work/briefs/ai-quality-phase2.md): Layer 1 facts (services/ai_index.py), Layer 2
summaries (ai_summaries.py), Layer 3 semantic search (ai_vectors.py, a fake embedder: nothing leaves the machine),
the routing and index block in Ask (ask_route.py) and the MCP tools (mcp/index_tools.py).

Access first: every row is decided again per asker (a private document, a private team's page, a restricted meeting,
comments on items the asker can't open, a private team's backlog never reach them — not as a row, a count, a team
name or a person's card), and semantic search scores only the chunks of documents the asker may read.
"""

from __future__ import annotations

import hashlib
import json
import re
import unittest
from datetime import date, timedelta

from bson import ObjectId

from tests._access_env import now
from tests.test_ask_context import ContextWorld
from tests.test_pages_ai import prompt_of

from app.config import get_settings
from app.services import (ai_index, ai_summaries, ai_usage, ai_vectors, ask_route, search, search_ai, search_index,
                          workspace_memory)
from app.services import access

settings = get_settings()


class FakeEmbedder:
    """Bag of words hashed into 64 dimensions: deterministic, offline."""

    model = "fake-embed-1"
    dims = 64

    def __init__(self):
        self.calls: list[tuple[str, list[str]]] = []

    async def embed(self, texts, kind):
        self.calls.append((kind, list(texts)))
        out = []
        for t in texts:
            v = [0.0] * self.dims
            for w in re.findall(r"[a-z]{3,}", t.lower()):
                v[int(hashlib.md5(w.encode()).hexdigest(), 16) % self.dims] += 1.0
            out.append(v)
        return out, sum(max(1, len(t) // 4) for t in texts)


class Helpers(unittest.TestCase):
    def test_task_rows(self):
        md = ("## Decisions\n\n- [ ] not an action\n\n## Action items\n\n"
              '- [ ] :person[Arjun Kapoor]{id="u1"} Add disk alerts · due 2026-11-22 [#3](/t#b-t0003) {#b-abcd1}\n'
              "- [x] Publish the postmortem {#b-abcd2}\n")
        rows = ai_index.task_rows(md, meeting=True)
        self.assertEqual([(r["done"], r["owner"], r["due"]) for r in rows], [(False, "u1", "2026-11-22"), (True, None, None)])
        # On other pages, only tasks that mention someone.
        page = '- [ ] :person[Bo]{id="u2"} Ship it by :date[2026-12-01]\n- [ ] nobody owns this\n'
        rows = ai_index.task_rows(page, meeting=False)
        self.assertEqual([(r["owner"], r["due"]) for r in rows], [("u2", "2026-12-01")])

    def test_route_parse(self):
        today = date(2026, 11, 20)
        r = ask_route.parse({"type": "count", "items": "documents", "people": ["Arun"], "since": "garbage"},
                            "How many documents has Arun created?", today)
        self.assertEqual((r.type, r.items, r.people, r.since), ("count", "documents", ["Arun"], None))
        r = ask_route.parse(None, "Which documents were updated in the last 2 days?", today)
        self.assertEqual((r.since, r.until), (date(2026, 11, 18), today))
        r = ask_route.parse({"type": "weird", "items": "meetings", "since": "2026-11-10", "until": "2026-11-01"}, "x", today)
        self.assertEqual((r.type, r.since, r.until), ("time", date(2026, 11, 1), date(2026, 11, 10)))

    def test_chunks(self):
        text = "\n\n".join(f"Paragraph {i} " + "word " * 120 for i in range(10))
        chunks = ai_vectors.chunk_text(text)
        self.assertTrue(all(len(c) <= ai_vectors.CHUNK_CHARS for c in chunks))
        self.assertGreater(len(chunks), 3)
        self.assertEqual(ai_vectors.chunk_text(""), [])


class IndexWorld(ContextWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        for m in (ai_index, ai_summaries, ai_vectors, workspace_memory):
            await m.ensure_indexes(self.db)
        saved = {k: getattr(settings, k) for k in ("ai_index_enabled", "ai_index_daily_usd", "ai_index_monthly_usd",
                                                    "embeddings_enabled", "voyage_api_key")}
        self.addCleanup(lambda: [setattr(settings, k, v) for k, v in saved.items()])
        settings.ai_index_enabled, settings.ai_index_daily_usd, settings.ai_index_monthly_usd = True, 1.0, 10.0
        settings.voyage_api_key = ""
        ai_usage.invalidate_settings()
        self.addCleanup(lambda: ai_vectors.set_embedder(None))
        ai_vectors._cache.clear()
        self.inner = self.fake.script
        self.fake.script = self.script2

    def script2(self, params):
        if params["system"][0]["text"].startswith("You summarize one item"):
            return "A plan for the zebra rollout.\nStatus: in build; two waves, owner Bo."
        return self.inner(params)

    async def reindex(self):
        await search_index.drain()
        await ai_index.drain()
        await self.db[search_index.META].delete_many({"_id": "backfill"})
        for _ in range(50):
            if (await search_index.backfill_tick(self.db))["done"]:
                break
        await self.db[ai_index.META].delete_many({})
        for _ in range(50):
            if (await ai_index.backfill_tick(self.db))["done"]:
                break

    def actor(self, who: str):
        u = type("U", (), {"id": self.uid[who]})()
        return access.Actor.of(u), access.Ctx(self.db, surface="test")

    async def q(self, who: str, **kw) -> ai_index.Result:
        a, c = self.actor(who)
        return await ai_index.query(self.db, a, c, ai_index.Filter(workspaces=[self.W], **kw))


class Facts(IndexWorld):
    async def test_rows_counts_and_system_pages(self):
        tid = await self.team("Platform", "open", "wm", ["wm", "wa"])
        await self.put("prd-a", "PRD: Alpha", f'**Status:** Draft\n\n- [ ] :person[Bo Chen]{{id="{self.uid["wm"]}"}} Write the '
                       "spec · due :date[2026-12-01]\n", owner="wm", team_ids=[tid], created_at=now() - timedelta(days=3))
        await self.put("prd-b", "PRD: Beta", "**Status:** Approved\n\nBeta.", owner="wm")
        await self.put("bl", "Platform — Backlog", "## The team's backlog\n\n- [ ] something", owner="wm", backlog_team_id=tid)
        await self.put("todo", "Bo — To-dos", "- [ ] a", owner="wm", todo_team_id=tid, todo_user_id=self.uid["wm"])
        await self.reindex()
        got = await self.q("wv", kind="doc", creator=self.uid["wm"])
        self.assertEqual(got.total, 2)                         # the backlog and to-do pages never count
        self.assertEqual({r["title"] for r in got.rows}, {"PRD: Alpha", "PRD: Beta"})
        alpha = next(r for r in got.rows if r["title"] == "PRD: Alpha")
        self.assertEqual((alpha["status"], alpha["teams"]), ("Draft", [tid]))
        acts = await self.q("wv", kind="action", owner=self.uid["wm"], done=False)
        self.assertEqual([(r["text"], r["due"]) for r in acts.rows], [("Bo Chen Write the spec · due 2026-12-01", "2026-12-01")])
        titled = await self.q("wv", kind="doc", title="prd")
        self.assertEqual(titled.total, 2)
        week = await self.q("wv", kind="doc", since=(now() - timedelta(days=1)).date(), on="created")
        self.assertNotIn("PRD: Alpha", {r["title"] for r in week.rows})

    async def test_access_per_row(self):
        secret = await self.team("Secret", "private", "wa", ["wa"])
        await self.put("s-plan", "Secret plan", "Body", owner="wa", team_ids=[secret])
        await self.put("mine", "Private notes", "Body", owner="wa", state="P")
        await self.put("open", "Open notes", "Body", owner="wa")
        await self.comment("s-plan", "wa", "Only for the secret team.")
        await self.comment("open", "wa", "A comment everyone can read.")
        await ai_index.drain()
        await self.reindex()
        mine = await self.q("wa", kind="doc", creator=self.uid["wa"])
        self.assertEqual(mine.total, 3)
        self.assertEqual(next(r for r in mine.rows if r["title"] == "Secret plan")["teams"], [secret])
        theirs = await self.q("wv", kind="doc", creator=self.uid["wa"])
        self.assertEqual({r["title"] for r in theirs.rows}, {"Open notes"})
        self.assertEqual(theirs.total, 1)
        self.assertEqual((await self.q("wv", kind="doc", team=secret)).total, 0)
        c_wa = await self.q("wa", kind="comment", author=self.uid["wa"])
        c_wv = await self.q("wv", kind="comment", author=self.uid["wa"])
        self.assertEqual((c_wa.total, c_wv.total), (2, 1))
        self.assertNotIn("secret", json.dumps([r.get("text") for r in c_wv.rows]).lower())
        # Not a member: nothing at all.
        self.assertEqual((await self.q("stranger", kind="doc")).total, 0)

    async def test_meetings_and_restricted(self):
        m = await self.import_meeting(title="Zebra sync", date=now().date().isoformat())
        r = await self.import_meeting(title="Zebra 1:1", date=now().date().isoformat(), restricted=True)
        for got in (m, r):
            row = await self.db["meetings"].find_one({"_id": ObjectId(got["id"])})
            await self.db["meetings"].update_one({"_id": row["_id"]}, {"$set": {"attendees": [
                {"name": "Bo Chen", "user_id": self.uid["wm"]}, {"name": "Ada Lovelace", "user_id": self.uid["owner"]}]}})
            await ai_index.index_doc(self.db, row["doc_id"])
        since = now().date() - timedelta(days=1)
        own = await self.q("owner", kind="meeting", attendee=self.uid["wm"], since=since)
        viewer = await self.q("wv", kind="meeting", attendee=self.uid["wm"], since=since)
        self.assertEqual(own.total, 2)
        self.assertEqual([x["mtitle"] for x in viewer.rows], ["Zebra sync"])
        self.assertEqual(viewer.rows[0]["attendee_names"], ["Bo Chen", "Ada Lovelace"])

    async def test_reconcile_and_sweep(self):
        d = await self.put("r1", "Before", "Body", owner="wm")
        await self.reindex()
        await self.db["documents"].update_one({"_id": d["_id"]}, {"$set": {"title": "After", "updated_at": now()}})
        await self.db[ai_index.META].update_one({"_id": "reconcile"}, {"$set": {"since": now() - timedelta(minutes=5)}}, upsert=True)
        await ai_index.reconcile(self.db)
        self.assertEqual((await self.db[ai_index.COLL].find_one({"_id": f"d:{d['_id']}"}))["title"], "After")
        await self.db["documents"].delete_one({"_id": d["_id"]})
        for _ in range(20):
            if (await ai_index.sweep_tick(self.db))["done"]:
                break
        self.assertIsNone(await self.db[ai_index.COLL].find_one({"_id": f"d:{d['_id']}"}))


class Summaries(IndexWorld):
    async def test_summaries_debounced_cached_and_skipped(self):
        long = " ".join(["The zebra rollout ships in two waves with a load test first."] * 8)
        old = now() - timedelta(minutes=10)
        a = await self.put("long", "Zebra rollout", long, owner="wm", updated_at=old)
        b = await self.put("short", "Tiny", "Just a line.", owner="wm", updated_at=old)
        c = await self.put("enc", "Locked", "secret", owner="wm", encrypted=True, updated_at=old)
        fresh = await self.put("fresh", "Fresh", long, owner="wm")
        await self.reindex()
        self.fake.calls.clear()
        await ai_summaries.tick(self.db)
        got = await ai_summaries.get(self.db, [a["_id"], b["_id"], c["_id"], fresh["_id"]])
        self.assertIn("zebra rollout", got[a["_id"]])
        self.assertEqual(got[b["_id"]], "Just a line.")
        self.assertNotIn(c["_id"], got)                 # encrypted: never
        self.assertNotIn(fresh["_id"], got)             # saved under 2 minutes ago: later
        self.assertEqual(sum(1 for x in self.fake.calls if x["system"][0]["text"].startswith("You summarize")), 1)
        self.assertEqual(await self.db[ai_usage.REQUESTS].count_documents({"feature": "ai_index"}), 1)
        self.fake.calls.clear()
        await ai_summaries.tick(self.db)
        self.assertFalse([x for x in self.fake.calls if x["system"][0]["text"].startswith("You summarize")])
        # A changed text makes it stale again.
        await self.db["documents"].update_one({"_id": a["_id"]}, {"$set": {"content": long + " New wave.", "updated_at": old}})
        await search_index.index_doc(self.db, a["_id"])
        self.assertEqual([r["doc"] for r in await ai_summaries.stale(self.db)], [a["_id"]])


class Vectors(IndexWorld):
    async def test_off_without_a_key(self):
        await self.put("v1", "Zebra", "Zebra rollout waves", owner="wm", updated_at=now() - timedelta(minutes=10))
        await self.reindex()
        self.assertFalse(ai_vectors.configured())
        self.assertEqual((await ai_vectors.tick(self.db))["skipped"], "off")
        self.assertEqual(await ai_vectors.search(self.db, {ObjectId(): self.W}, "zebra"), [])

    async def test_embeds_changed_chunks_and_scores_only_readable(self):
        fake = FakeEmbedder()
        ai_vectors.set_embedder(fake)
        old = now() - timedelta(minutes=10)
        mine = await self.put("v1", "Zebra rollout", "Zebra rollout waves and the load test.", owner="wm", updated_at=old)
        other = await self.put("v2", "Zebra secrets", "Zebra rollout waves zebra rollout waves.", owner="wa", state="P",
                               updated_at=old)
        await self.reindex()
        await ai_vectors.tick(self.db)
        self.assertEqual(await self.db[ai_vectors.COLL].count_documents({}), 2)
        # Both items' chunks go in one call (packed across items), billed under "embeddings".
        self.assertEqual([k for k, _t in fake.calls], ["document"])
        self.assertEqual(await self.db[ai_usage.REQUESTS].count_documents({"feature": "embeddings"}), 1)
        # Nothing changed: no new embedding calls.
        n = len(fake.calls)
        await ai_vectors.tick(self.db)
        self.assertEqual(len(fake.calls), n)
        # Access before scoring: only the allowed documents are scored at all.
        hits = await ai_vectors.search(self.db, {mine["_id"]: self.W}, "zebra rollout waves")
        self.assertEqual([h.doc for h in hits], [mine["_id"]])
        # Through retrieval: wv's candidates never include wa's private page; the semantic ranking marks its hits.
        a, c = self.actor("wv")
        cands, _w = await search_ai.retrieve(self.db, a, c, search.Query(q="zebra waves", scope=self.W), ["zebra waves"])
        keys = [x.key for x in cands]
        self.assertIn(f"d:{mine['_id']}", keys)
        self.assertNotIn(f"d:{other['_id']}", keys)
        self.assertTrue(next(x for x in cands if x.key == f"d:{mine['_id']}").extra.get("semantic"))
        # Encrypted now: its chunks go.
        await self.db["documents"].update_one({"_id": mine["_id"]}, {"$set": {"encrypted": True}})
        await search_index.index_doc(self.db, mine["_id"])
        self.assertEqual(await self.db[ai_vectors.COLL].count_documents({"doc": mine["_id"]}), 0)


class AskIndex(IndexWorld):
    async def test_count_question_gets_exact_table(self):
        for i in range(3):
            await self.put(f"bo-{i}", f"Bo doc {i}", "Body", owner="wm")
        await self.put("pri", "Priya doc", "Body", owner="wa")
        secret = await self.team("Secret", "private", "wa", ["wa", "wm"])
        await self.put("bo-secret", "Bo hidden plan", "Body", owner="wm", team_ids=[secret])
        await self.reindex()
        self.expansion = {"standalone": "How many documents has Bo created?", "terms": ["documents"], "titles": [],
                          "route": {"type": "count", "items": "documents", "people": ["Bo"]}}
        self.fake.calls.clear()
        self.done(await self.ask("wv", "How many documents has Bo created?"))
        p = self.answer_prompt()
        self.assertIn("<untrusted_index>", p)
        self.assertIn("Documents created by Bo Chen", p)
        self.assertRegex(p, r"Documents created by Bo Chen[^\n]*: 3\n")
        self.assertRegex(p, r"- \[\d+\] Bo doc 0")
        self.assertNotIn("Bo hidden plan", p)
        self.assertNotIn("Secret", p)
        # The same question from a member of the private team counts it.
        self.fake.calls.clear()
        self.done(await self.ask("wa", "How many documents has Bo created?"))
        self.assertRegex(self.answer_prompt(), r"Documents created by Bo Chen[^\n]*: 4\n")

    async def test_team_scope_gets_the_overview_and_people_cards_hide_private_teams(self):
        tid = await self.team("Platform", "open", "wm", ["wm", "wa"])
        secret = await self.team("Secret", "private", "wa", ["wa"])
        await self.put("p1", "Platform roadmap", "Body", owner="wm", team_ids=[tid])
        await self.reindex()
        self.expansion = {"standalone": "What is this team working on?", "terms": ["working"], "titles": [],
                          "route": {"type": "team", "items": "any"}}
        self.fake.calls.clear()
        self.done(await self.ask("wm", "What is this team working on?",
                                 scope={"kind": "team", "workspace": self.W, "team": tid}))
        p = self.answer_prompt()
        self.assertIn("Team: Platform (open team) — 2 members: Bo Chen (lead), Priya Sharma", p)
        self.assertIn("Platform roadmap", p)
        # A person card for wv never names the private team.
        self.expansion = {"standalone": "What is Priya working on?", "terms": ["Priya"], "titles": [],
                          "route": {"type": "person", "items": "any", "people": ["Priya"]}}
        self.fake.calls.clear()
        self.done(await self.ask("wv", "What is Priya working on?"))
        p = self.answer_prompt()
        self.assertIn("Person: Priya Sharma — teams: Platform", p)
        self.assertNotIn("Secret", p)
        _ = secret

    async def test_decisions_in_a_period_only_from_readable_meetings(self):
        from app.services import meeting_memory

        await meeting_memory.ensure_indexes(self.db)
        open_page = await self.put("m-open", "Zebra sync", "Notes", owner="wm")
        closed = await self.put("m-closed", "Zebra 1:1", "Notes", owner="wa", state="P")
        day = now().date().isoformat()
        for d, text in ((open_page, "Ship the zebra rollout in two waves."), (closed, "Promote Priya in March.")):
            await self.db[meeting_memory.COLL].insert_one({
                "workspace_id": self.W, "meeting_id": str(ObjectId()), "doc_id": d["_id"], "date": day,
                "meeting_title": d["title"], "kind": "decision", "ord": 0, "text": text})
        await self.reindex()
        self.expansion = {"standalone": "What did we decide this week?", "terms": ["decide"], "titles": [],
                          "route": {"type": "time", "items": "any", "since": (now().date() - timedelta(days=6)).isoformat(),
                                    "until": day}}
        self.fake.calls.clear()
        self.done(await self.ask("wv", "What did we decide this week?"))
        p = self.answer_prompt()
        self.assertRegex(p, r"Decisions recorded in meetings between [^\n]*: 1\n")
        self.assertIn("Ship the zebra rollout in two waves.", p)
        self.assertNotIn("Promote Priya", p)

    async def test_todo_page_item_per_line(self):
        tid = await self.team("Platform", "open", "wm", ["wm", "wa"])
        await self.put("todo-bo", "Bo — To-dos", "# To-dos\n\n## Acme\n\n- [x] Old thing\n- [ ] Send the zebra quote\n\n"
                       "## Empty\n\n## Internal\n\n- [ ] Review the zebra plan\n", owner="wm", todo_team_id=tid,
                       todo_user_id=self.uid["wm"], editor="blocks")
        await self.reindex()
        a, c = self.actor("wm")
        raw = await self.db["documents"].find_one({"slug": "todo-bo"})
        txt = await ask_route.system_text(self.db, a, c, raw)
        self.assertEqual(txt.splitlines()[:4], ["To-dos: 2 open, 1 done.", "Acme:", "- [open] Send the zebra quote",
                                                "- [done] Old thing"])
        self.assertNotIn("Empty", txt)


class MCP(IndexWorld):
    async def test_list_items_person_card_team_overview(self):
        tid = await self.team("Platform", "open", "wm", ["wm", "wa"])
        secret = await self.team("Secret", "private", "wa", ["wa"])
        await self.put("d1", "Bo doc", "Body", owner="wm", team_ids=[tid])
        await self.put("d2", "Hidden", "Body", owner="wm", team_ids=[secret])
        await self.reindex()
        tok = await self.mcp_token("wv", write=False)
        st, res = await self.mcp_call(tok, "list_items", {"workspace": self.W, "kind": "documents", "person": "Bo Chen"})
        self.assertEqual(st, 200)
        sc = res["structuredContent"]
        self.assertEqual(sc["count"], 1)
        self.assertEqual(sc["items"][0]["teams"], ["Platform"])
        st, res = await self.mcp_call(tok, "person_card", {"workspace": self.W, "person": "Priya"})
        self.assertIn("Person: Priya Sharma — teams: Platform", res["content"][0]["text"])
        self.assertNotIn("Secret", json.dumps(res))
        st, res = await self.mcp_call(tok, "team_overview", {"workspace": self.W, "team": "Secret"})
        self.assertTrue(res.get("isError"))
        st, res = await self.mcp_call(tok, "team_overview", {"workspace": self.W, "team": "Platform"})
        self.assertIn("Bo doc", res["content"][0]["text"])


if __name__ == "__main__":
    unittest.main()
