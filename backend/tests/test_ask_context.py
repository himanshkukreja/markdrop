"""Ask's records beside the excerpts (services/ask_context.py; AI quality stage 1, .work/briefs/ai-quality-phase2.md).

R1 — every document source carries who created it, when, who last edited it, its teams, its status and its comment
counts; a meeting brings its action items, open and done. R3 — comments are a source: a document's open threads
reach the model with it, and a document whose comments match the question becomes a candidate. R6 — a name two
members share ("Rahul") or no member has ("Arun Kapoor") is spelled out for the model, with both full names in the
search. R8 — the answer-shape rules are in the prompt.

Access first, as everywhere in Ask: comments only from items the asker may open (and view comments on), people's
names only inside the item's circle, teams only those the asker can read — a private team's name never reaches a
non-member through a person's card. The model is the fake client: nothing leaves the machine.
"""

from __future__ import annotations

import unittest
from datetime import timedelta

from bson import ObjectId

from tests._access_env import now
from tests.test_ask_markdrop import AskWorld

from app.services import ask_context, ask_markdrop
from app.services.comments import model as comments_model


class Helpers(unittest.TestCase):
    def test_status_of(self):
        self.assertEqual(ask_context.status_of('---\nprops: {status: "In build", owner: "6566c0ffee0000000000abcd"}\n---\n# X'),
                         "In build")
        self.assertEqual(ask_context.status_of("# PRD\n\n**Author:** Arun · **Status:** In review · **Eng lead:** Arjun"),
                         "In review")
        self.assertEqual(ask_context.status_of("# Notes\n\nStatus: Paused (until Q1)\n"), "Paused (until Q1)")
        self.assertIsNone(ask_context.status_of("# Notes\n\nNothing here."))

    def test_action_items(self):
        md = ("## Decisions\n\n- [ ] not an action\n\n## Action items\n\n"
              '- [ ] :person[Arjun Kapoor]{id="u1"} Add disk alerts · due :date[Nov 22] [#3](/t#b-t0003) {#b-abcd1}\n'
              "- [x] Publish the postmortem {#b-abcd2}\n\n## Open questions\n\n- [ ] also not an action\n")
        self.assertEqual(ask_context.action_items(md), [(False, "Arjun Kapoor Add disk alerts · due Nov 22"),
                                                        (True, "Publish the postmortem")])
        text = ask_context.actions_text(ask_context.action_items(md))
        self.assertIn("(1 open, 1 done", text)
        self.assertIn("- [open] Arjun Kapoor Add disk alerts", text)

    def test_resolve_names(self):
        m = [{"id": "1", "name": "Rahul Verma"}, {"id": "2", "name": "Rahul Das"}, {"id": "3", "name": "Arun Sharma"},
             {"id": "4", "name": "Arjun Kapoor"}, {"id": "5", "name": "Meera Iyer"}]

        def names(q):
            sure, unclear = ask_context.resolve_names(q, m)
            return [x["name"] for x in sure], [(w, sorted(x["name"] for x in ms), none) for w, ms, none in unclear]

        self.assertEqual(names("What did Rahul commit to?"), ([], [("Rahul", ["Rahul Das", "Rahul Verma"], False)]))
        self.assertEqual(names("What is Arun Kapoor working on?"),
                         ([], [("Arun Kapoor", ["Arjun Kapoor", "Arun Sharma"], True)]))
        self.assertEqual(names("Which documents did Rahul Das write?"), (["Rahul Das"], []))
        self.assertEqual(names("What are Arjun's PRDs?"), (["Arjun Kapoor"], []))
        self.assertEqual(names("what feedback has meera given"), (["Meera Iyer"], []))
        self.assertEqual(names("Who owns pricing?"), ([], []))

    def test_prompt_shape_rules(self):
        for system in (ask_markdrop.ANSWER_SYSTEM, ask_markdrop.PAGE_SYSTEM):
            self.assertIn("starts with the number", system)
            self.assertIn("300 words", system)
            self.assertIn("answer for each of them by full name", system)
            self.assertIn("never talk about the items, excerpts", system)
            self.assertIn("created_by", system)
        self.assertIn("never talk about the items", ask_markdrop.CATCHUP_SYSTEM)


class ContextWorld(AskWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await comments_model.ensure_indexes(self.db)

    async def comment(self, slug: str, who: str, body: str) -> None:
        r = await self.http.post(f"/api/v1/documents/{slug}/comments", headers=self.session(who),
                                 json={"anchor": {"type": "page"}, "body": body})
        self.assertEqual(r.status_code, 201, r.text)

    async def team(self, name: str, visibility: str, lead: str, members: list[str]) -> str:
        r = await self.http.post(f"/api/v1/workspaces/{self.W}/teams", headers=self.session("wo"), json={
            "name": name, "visibility": visibility, "lead_ids": [self.uid[lead]],
            "member_ids": [self.uid[m] for m in members]})
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()["id"]

    def answer_prompt(self) -> str:
        from tests.test_pages_ai import prompt_of
        from tests.test_ask_markdrop import is_ask

        calls = [c for c in self.fake.calls if is_ask(c)]
        self.assertTrue(calls)
        return prompt_of(calls[-1])


class Records(ContextWorld):
    async def test_sources_carry_markdrops_records(self):
        tid = await self.team("Platform", "open", "wm", ["wm", "wa"])
        d = await self.put("rollout-plan", "Zebra rollout plan",
                           '---\nprops: {status: "In build"}\n---\n# Zebra rollout plan\n\nThe zebra rollout ships in two waves.',
                           owner="wm", team_ids=[tid], created_at=now() - timedelta(days=9))
        await self.db["document_versions"].insert_one({
            "doc_id": str(d["_id"]), "slug": d["slug"], "n": 1, "ts": now() - timedelta(days=1), "author_id": self.uid["wa"],
            "author_kind": "user", "author_name": "Priya Sharma", "title": d["title"], "markdown": d["content"], "sealed": True})
        await self.comment("rollout-plan", "wa", "Wave two needs the load test first.")
        await self.index_all()
        self.fake.calls.clear()
        self.done(await self.ask("wv", "When does the zebra rollout ship?"))
        p = self.answer_prompt()
        self.assertIn('created_by="Bo Chen"', p)
        self.assertIn(f'created="{(now() - timedelta(days=9)):%Y-%m-%d}"', p)
        self.assertIn('last_edited_by="Priya Sharma on', p)
        self.assertIn('teams="Platform"', p)
        self.assertIn('status="In build"', p)
        self.assertIn('comments="1 open, 0 resolved"', p)
        # R3: the open thread itself, who said what.
        self.assertIn("Comments on this item:", p)
        self.assertIn("Priya Sharma (", p)
        self.assertIn("Wave two needs the load test first.", p)

    async def test_meeting_brings_its_action_items(self):
        m = await self.import_meeting()
        page = await self.db["documents"].find_one({"slug": m["slug"]})
        content = (page["content"] + "\n\n## Action items\n\n- [ ] Bo Chen: book the zebra venue {#b-zz001}\n"
                   "- [x] Ada Lovelace: send the zebra invite {#b-zz002}\n")
        await self.db["documents"].update_one({"_id": page["_id"]}, {"$set": {"content": content}})
        await self.index_all()
        self.fake.calls.clear()
        self.done(await self.ask("wm", "Weekly product sync zebra venue"))
        p = self.answer_prompt()
        self.assertIn("Action items on this meeting's page", p)
        self.assertIn("- [open] Bo Chen: book the zebra venue", p)
        self.assertIn("- [done] Ada Lovelace: send the zebra invite", p)

    async def test_names_only_inside_the_circle(self):
        # A link-shared personal page of someone else's: Ravi can read it, but he isn't in its circle, so neither its
        # creator's nor its last editor's name reaches the model.
        from app.services import access, pages, search

        d = await self.put("other-zebra", "Zebra notes elsewhere", "# Zebra notes\n\nZebra rollout notes.", owner="wm2",
                           ws=None, state="L")
        await self.db["users"].update_one({"_id": ObjectId(self.uid["wm2"])}, {"$set": {"name": "Zed Outsider"}})
        await self.db["document_versions"].insert_one({
            "doc_id": str(d["_id"]), "slug": d["slug"], "n": 1, "ts": now(), "author_id": self.uid["wm2"],
            "author_kind": "user", "author_name": "Zed Outsider", "title": d["title"], "markdown": "x", "sealed": True})
        user = type("U", (), {"id": self.uid["wv"], "email": self.email["wv"]})()
        actor, ctx = access.Actor.of(user), access.Ctx(self.db)
        self.assertTrue((await access.can(actor, d, "read", ctx)).allowed)
        self.assertFalse(await pages.sees_people(actor, d, ctx))
        src = ask_markdrop.Source(1, search._doc_cand(d, self.uid["wv"]), item={"key": f"d:{d['_id']}"},
                                  attrs={"title": "x"})
        await ask_context.annotate(self.db, actor, ctx, [src])
        self.assertIn("created", src.attrs)
        self.assertNotIn("created_by", src.attrs)
        self.assertNotIn("last_edited_by", src.attrs)
        self.assertNotIn("Zed", str(src.attrs))
        # And an item they can't read gets nothing at all.
        p = await self.put("bo-only", "Bo only", "# Bo\n\nStatus: Secret", owner="wm", state="P")
        src2 = ask_markdrop.Source(2, search._doc_cand(p, self.uid["wv"]), item={"key": f"d:{p['_id']}"},
                                   attrs={"title": "x"})
        await ask_context.annotate(self.db, actor, ctx, [src2])
        self.assertEqual(src2.attrs, {"title": "x"})


class Comments(ContextWorld):
    async def test_comment_search_finds_the_document(self):
        await self.put("billing-prd", "PRD: Billing revamp", "# Billing revamp\n\nAnnual plans and per-seat pricing.")
        await self.comment("billing-prd", "wm", "The pricing table needs the kangaroo discount before sign-off.")
        for i in range(40):
            await self.put(f"filler-{i}", f"Billing note {i}", f"# Billing note {i}\n\nBilling revamp notes, billing revamp again.")
        await self.index_all()
        self.fake.calls.clear()
        self.expansion = {"standalone": "What feedback has Bo given on the kangaroo discount?", "terms": ["kangaroo discount"],
                          "titles": []}
        self.done(await self.ask("wa", "What feedback has Bo given on the kangaroo discount?"))
        p = self.answer_prompt()
        self.assertIn("PRD: Billing revamp", p)
        self.assertIn("kangaroo discount before sign-off", p)

    async def test_comments_never_leak(self):
        # Bo's private page, a page with comments turned off, and a private team's page: their comments never reach
        # Ravi (a viewer outside the team), even when the question names their words.
        await self.put("bo-private", "Bo's private plan", "# Plan\n\nPrivate.", owner="wm", state="P")
        await self.comment("bo-private", "wm", "Ostrich budget is 40k.")
        await self.put("quiet", "Quiet page", "# Quiet\n\nNothing.")
        await self.comment("quiet", "wm", "Ostrich budget draft is 41k.")
        await self.db["documents"].update_one({"slug": "quiet"}, {"$set": {"comments_off": True}})
        tid = await self.team("Secret squad", "private", "wm", ["wm", "wa"])
        await self.put("squad-page", "Squad page", "# Squad\n\nTeam things.", team_ids=[tid])
        await self.comment("squad-page", "wa", "Ostrich budget final is 42k.")
        await self.put("open-page", "Ostrich budget overview", "# Ostrich budget\n\nThe budget is being set.")
        await self.index_all()
        self.fake.calls.clear()
        self.expansion = {"standalone": "What is the ostrich budget?", "terms": ["ostrich budget"], "titles": []}
        self.done(await self.ask("wv", "What comments mention the ostrich budget?"))
        p = self.prompts()
        for secret in ("40k", "41k", "42k", "Bo's private plan", "Squad page", "Secret squad"):
            self.assertNotIn(secret, p, secret)
        self.assertIn("Ostrich budget overview", p)
        # Positive control: a member of the team sees the squad's comment.
        self.fake.calls.clear()
        self.done(await self.ask("wa", "What comments mention the ostrich budget?"))
        self.assertIn("42k", self.prompts())


class Names(ContextWorld):
    async def test_two_members_one_name(self):
        await self.db["users"].update_one({"_id": ObjectId(self.uid["wm"])}, {"$set": {"name": "Rahul Verma"}})
        await self.db["users"].update_one({"_id": ObjectId(self.uid["wa"])}, {"$set": {"name": "Rahul Das"}})
        await self.team("Deals", "private", "wm", ["wm", "owner"])
        await self.team("Engineering", "open", "wa", ["wa"])
        await self.put("commitments", "Commitments", "# Commitments\n\nRahul will send the quote. Rahul will fix the bug.")
        await self.index_all()
        self.fake.calls.clear()
        self.done(await self.ask("wv", "What did Rahul commit to?"))
        p = self.answer_prompt()
        self.assertIn("<untrusted_people>\nThe people the question names", p)
        self.assertIn("“Rahul” matches 2 members", p)
        self.assertIn("Rahul Verma", p)
        self.assertIn("Rahul Das (teams: Engineering (lead))", p)
        # The private team stays with its members: Ravi isn't in Deals.
        self.assertNotIn("Deals", p)
        # A member of Deals sees it.
        self.fake.calls.clear()
        self.done(await self.ask("owner", "What did Rahul commit to?"))
        self.assertIn("Deals (lead)", self.answer_prompt())

    async def test_no_note_without_names(self):
        await self.put("pricing", "Pricing", "# Pricing\n\nTeam plan is 8 dollars.")
        await self.index_all()
        self.fake.calls.clear()
        self.done(await self.ask("wm", "How much is the team plan?"))
        self.assertNotIn("<untrusted_people>\n", self.answer_prompt())


if __name__ == "__main__":
    unittest.main()
