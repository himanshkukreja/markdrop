"""Personal to-do pages (services/todo_pages.py, routers/todos.py, mcp/todo_tools.py; brief .work/briefs/jason-folders-todos.md §2).

Sales (private: owner = Ada Lovelace, the lead; wm = Bo Chen; wv = Ravi Kumar, a workspace viewer) gets a to-do page per
member from its calls: a collapsible section per company (the HubSpot deal's company, else the outside attendees'
company, else Internal), only that person's items, people's own notes kept, re-runs idempotent. Privacy: the owner
only, plus the team's leads (read, decided at read time); a member who isn't a lead can't read it until the owner
shares it. Ticking syncs both ways (the to-do page ↔ the meeting page), also while someone is editing. The model is fake.

Run: cd backend && MARKDROP_TEST_MONGODB_URI=mongodb://127.0.0.1:27019 .venv/bin/python -m unittest tests.test_todo_pages -v
"""

from __future__ import annotations

import json
import re

from bson import ObjectId

from app.services import access, pages, teams as T, todo_pages as TP
from tests.test_teams import TeamsWorld

GENS = {
    "Acme renewal": {"summary": "Renewal call.", "highlights": [], "decisions": [], "open_questions": [], "topics": [],
                     "action_items": [{"text": "Send the pricing deck", "owner": "Bo Chen", "due": "Thursday", "cite": "s1"},
                                      {"text": "Book the security review", "owner": "Ada Lovelace", "due": None, "cite": None}],
                     "type": "Customer"},
    "Pipeline review": {"summary": "Internal review.", "highlights": [], "decisions": [], "open_questions": [], "topics": [],
                        "action_items": [{"text": "Update the forecast sheet", "owner": "Bo Chen", "due": None, "cite": "s2"}],
                        "type": "Review"},
    "Globex intro": {"summary": "Intro.", "highlights": [], "decisions": [], "open_questions": [], "topics": [],
                     "action_items": [{"text": "Share two references", "owner": "Bo Chen", "due": "Friday", "cite": None}],
                     "type": "Customer"},
}


class TodoWorld(TeamsWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await TP.ensure_indexes(self.db)
        # Ravi (a workspace viewer) is in Sales too, not a lead.
        r = await self.http.post(f"{self.base}/teams/{self.sales}/members", headers=self.session("owner"),
                                 json={"user_ids": [self.uid["wv"]]})
        self.assertEqual(r.status_code, 200, r.text)

    async def asyncTearDown(self):
        await TP.drain()
        await super().asyncTearDown()

    def script(self, params: dict) -> str:
        system = params["system"][0]["text"]
        user = "\n".join(b["text"] for b in params["messages"][-1]["content"] if b.get("type") == "text")
        if system.startswith("You write the team's notes"):
            m = re.search(r"Title: ([^\n]+)", user)
            gen = GENS.get((m.group(1) if m else "").strip())
            if gen is not None:
                return json.dumps(gen)
        return super().script(params)

    async def call(self, title: str, date: str = "2026-11-03", **extra) -> dict:
        lines = ["Ada Lovelace: Thanks for joining.", "Bo Chen: I will send it over.", "Ada Lovelace: Great, talk soon."]
        r = await self.http.post("/api/v1/meetings/import", headers=self.session("owner"), json={
            "workspace": self.W, "sources": [{"name": title, "text": "\n".join(lines)}], "title": title, "date": date,
            "wait": True, "restricted": False, "team_ids": [self.sales], **extra})
        self.assertEqual(r.status_code, 200, r.text)
        await TP.drain()
        return r.json()["meetings"][0]

    async def user(self, who: str):
        from app.services import user as user_service

        return await user_service.get_user_by_id(self.db, self.uid[who])

    async def mrow(self, m: dict) -> dict:
        return await self.db["meetings"].find_one({"_id": ObjectId(m["id"])})

    async def mpage(self, m: dict) -> dict:
        return await self.db["documents"].find_one({"_id": (await self.mrow(m))["doc_id"]})

    async def todo(self, who: str) -> dict | None:
        row = await self.db[TP.PAGES].find_one({"_id": TP.page_key(self.sales, self.uid[who])})
        return await self.db["documents"].find_one({"_id": row["doc_id"]}) if row else None

    async def rebuild(self, who: str) -> TP.Built:
        b = await TP.build(self.db, self.sales, self.uid[who])
        await TP.drain()
        return b

    async def save(self, raw: dict, content: str, who: str):
        return await self.http.put(f"/api/v1/documents/{raw['slug']}", headers=self.session(who),
                                   json={"title": raw.get("title"), "content": content, "base_rev": raw.get("rev")})

    def block_of(self, content: str, words: str) -> tuple[str, bool]:
        ln = next(x for x in TP.task_lines(content) if words in x.rest)
        return ln.block, ln.done


class Pages(TodoWorld):
    async def test_a_page_per_member_by_company_and_only_their_items(self):
        acme = await self.call("Acme renewal")
        await self.db["meetings"].update_one({"_id": ObjectId(acme["id"])}, {"$push": {"attendees": {
            "name": "Grace Hopper", "email": "grace@acme-corp.com"}}})
        await self.call("Pipeline review", date="2026-11-04")
        for who in ("owner", "wm", "wv"):
            await self.rebuild(who)
        bo, ada, ravi = await self.todo("wm"), await self.todo("owner"), await self.todo("wv")
        # Every member has one (Ravi with no items: the empty state), all in Sales, private, owned by the person.
        for who, raw in (("wm", bo), ("owner", ada), ("wv", ravi)):
            self.assertIsNotNone(raw, who)
            self.assertEqual((raw["owner_id"], raw["access_level"], raw["team_ids"], raw["todo_team_id"]),
                             (self.uid[who], "private", [self.sales], self.sales))
            f = await self.db["folders"].find_one({"_id": ObjectId(raw["folder_id"])})
            self.assertEqual((f["name"], f["hidden"], f["team_ids"]), ("To-dos", True, [self.sales]))
        self.assertEqual(bo["title"], "Bo Chen — To-dos")
        self.assertIn(TP.EMPTY, ravi["content"])
        body = bo["content"]
        self.assertNotIn(TP.EMPTY, body)
        self.assertIn('summary="Acme-corp · 1 open · last call', body)
        self.assertIn('summary="Internal · 1 open · last call', body)
        self.assertLess(body.index("Acme-corp"), body.index("Internal ·"))           # Internal last
        self.assertIn("Send the pricing deck · due Thursday", body)
        self.assertIn("Update the forecast sheet", body)
        self.assertNotIn("Book the security review", body)                          # Ada's, not Bo's
        self.assertIn("Book the security review", ada["content"])
        # The same task identity as the meeting page, and a link to the item there.
        mp = await self.mpage(acme)
        blk, _ = self.block_of(mp["content"], "Send the pricing deck")
        self.assertIn(f"(/{mp['slug']}#{blk}) ", body)
        self.assertIn(f"{{#{blk}}}", body)
        self.assertNotIn('id="', TP.region(body))                                   # no mentions: Home doesn't list it twice
        # Listings: yours, and the team's (the lead sees every member's; Bo only his).
        r = await self.http.get("/api/v1/me/todos", headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        (card,) = r.json()["pages"]
        self.assertEqual((card["slug"], card["open"], card["team"]["name"]), (bo["slug"], 2, "Sales"))
        r = await self.http.get(f"{self.base}/teams/{self.sales}/todos", headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["lead"])
        self.assertEqual({c["user"]["id"] for c in r.json()["pages"]}, {self.uid[x] for x in ("owner", "wm", "wv")})
        r = await self.http.get(f"{self.base}/teams/{self.sales}/todos", headers=self.session("wm"))
        self.assertEqual([c["user"]["id"] for c in r.json()["pages"]], [self.uid["wm"]])
        r = await self.http.get(f"{self.base}/teams/{self.sales}/todos", headers=self.session("ownv"))   # not in the private team
        self.assertEqual(r.status_code, 404)

    async def test_hubspot_company_wins_and_people_notes_stay_and_reruns_change_nothing(self):
        acme = await self.call("Acme renewal")
        await self.call("Globex intro", date="2026-11-05")
        await self.db["hubspot_deal_folders"].insert_one({"_id": f"{self.W}:1:77", "workspace_id": self.W, "deal_id": "77",
                                                           "name": "Annual", "company": {"id": "501", "name": "Acme Corp"}})
        await self.db["meetings"].update_one({"_id": ObjectId(acme["id"])}, {"$set": {"hubspot.match": {"deal_id": "77"}}})
        await self.rebuild("wm")
        raw = await self.todo("wm")
        self.assertIn('summary="Acme Corp · 1 open', raw["content"])
        # Bo's own notes above and below the section stay.
        mine = "My own list:\n\n- [ ] Call mum\n\n" + raw["content"] + "\nNotes at the bottom.\n"
        self.assertEqual((await self.save(raw, mine, "wm")).status_code, 200)
        await TP.drain()
        await self.call("Pipeline review", date="2026-11-06")
        raw = await self.todo("wm")
        for want in ("My own list:", "- [ ] Call mum", "Notes at the bottom.", "Update the forecast sheet", "Acme Corp"):
            self.assertIn(want, raw["content"])
        self.assertEqual(raw["content"].count(TP.START), 1)
        # Idempotent: building again writes nothing.
        rev = raw["rev"]
        b = await self.rebuild("wm")
        self.assertFalse(b.written)
        self.assertEqual((await self.todo("wm"))["rev"], rev)
        # The backfill: a dry run writes nothing; --apply builds every member (again: nothing new).
        out = await TP.backfill(self.db, self.W, "Sales", apply=False)
        self.assertEqual(out["teams"][0]["members"], 3)
        self.assertEqual((await self.todo("wm"))["rev"], rev)
        await TP.backfill(self.db, self.W, "sales", apply=True)
        self.assertEqual((await self.todo("wm"))["rev"], rev)
        with self.assertRaises(RuntimeError):
            await TP.backfill(self.db, self.W, "Nope", apply=False)

    async def test_a_member_added_later_gets_theirs(self):
        await self.call("Pipeline review")
        self.assertIsNotNone(await self.todo("wv"))                                   # the team uses to-dos: everyone
        r = await self.http.post(f"{self.base}/teams/{self.sales}/members", headers=self.session("owner"),
                                 json={"user_ids": [self.uid["wa"]]})
        self.assertEqual(r.status_code, 200, r.text)
        await TP.drain()
        raw = await self.todo("wa")
        self.assertIsNotNone(raw)
        self.assertIn(TP.EMPTY, raw["content"])
        # General never has to-do pages.
        gen = await T.ensure_general(self.db, self.W)
        self.assertEqual((await TP.build(self.db, str(gen["_id"]), self.uid["wm"])).skipped, "General has no to-do pages")


class Privacy(TodoWorld):
    async def test_owner_and_leads_only_until_shared(self):
        await self.call("Pipeline review")
        raw = await self.todo("wm")
        self.assertEqual((await self.get(raw["slug"], self.session("wm"))).status_code, 200)
        self.assertEqual((await self.get(raw["slug"], self.session("owner"))).status_code, 200)     # the lead reads it
        for who in ("wv", "wa", "ownv", "stranger"):                                               # a member, an admin, outsiders
            self.assertNotEqual((await self.get(raw["slug"], self.session(who))).status_code, 200, who)
        # The lead reads, never edits.
        r = await self.save(raw, raw["content"] + "\nlead was here\n", "owner")
        self.assertEqual(r.status_code, 403, r.text)
        # Decided now: Ada stops leading → no more access; Bo leaves the team → nor for leads.
        await self.db[T.TEAMS].update_one({"_id": ObjectId(self.sales)}, {"$set": {"lead_ids": [self.uid["wa"]]}})
        self.assertNotEqual((await self.get(raw["slug"], self.session("owner"))).status_code, 200)
        self.assertEqual((await self.get(raw["slug"], self.session("wa"))).status_code, 200)
        await self.db[T.TEAMS].update_one({"_id": ObjectId(self.sales)}, {"$pull": {"member_ids": self.uid["wm"]}})
        self.assertNotEqual((await self.get(raw["slug"], self.session("wa"))).status_code, 200)
        self.assertEqual((await self.get(raw["slug"], self.session("wm"))).status_code, 200)
        # The owner shares it like any page.
        r = await self.http.post(f"/api/v1/documents/{raw['slug']}/access/people", headers=self.session("wm"),
                                 json={"email": self.email["wv"], "role": "viewer"})
        self.assertIn(r.status_code, (200, 201), r.text)
        self.assertEqual((await self.get(raw["slug"], self.session("wv"))).status_code, 200)

    async def test_lead_rule_is_read_only_and_needs_the_team(self):
        await self.call("Pipeline review")
        raw = await self.todo("wm")
        ada = access.Actor.of(await self.user("owner"))
        self.assertTrue((await access.can(ada, raw, "read", access.Ctx(self.db))).allowed)
        self.assertFalse((await access.can(ada, raw, "edit_content", access.Ctx(self.db))).allowed)
        self.assertFalse((await access.can(ada, raw, "change_access", access.Ctx(self.db))).allowed)
        # MCP: the lead's team_todos lists Bo's open items; Bo (not a lead) is refused and uses my_todos.
        tok = await self.mcp_token("owner", write=False)
        _s, res = await self.mcp_call(tok, "team_todos", {"workspace": self.W, "team": "Sales"})
        people = {p["person"]: p for p in res["structuredContent"]["pages"]}
        self.assertEqual([i["text"] for i in people["Bo Chen"]["items"]], ["Update the forecast sheet"])
        tok = await self.mcp_token("wm", write=True)
        _s, res = await self.mcp_call(tok, "team_todos", {"workspace": self.W, "team": "Sales"})
        self.assertTrue(res.get("isError"))
        _s, res = await self.mcp_call(tok, "my_todos", {})
        (p,) = res["structuredContent"]["pages"]
        self.assertEqual((p["team"], p["open"]), ("Sales", 1))


class Sync(TodoWorld):
    async def test_ticking_either_side_follows_on_the_other(self):
        m = await self.call("Pipeline review")
        mp, raw = await self.mpage(m), await self.todo("wm")
        blk, done = self.block_of(mp["content"], "Update the forecast sheet")
        self.assertFalse(done)
        # Ticked on the to-do page (Bo's own save) → the meeting page's item is ticked.
        r = await self.save(raw, TP._set_mark(raw["content"], blk, True), "wm")
        self.assertEqual(r.status_code, 200, r.text)
        await TP.drain()
        self.assertTrue(self.block_of((await self.mpage(m))["content"], "Update the forecast sheet")[1])
        self.assertTrue(self.block_of((await self.todo("wm"))["content"], "Update the forecast sheet")[1])   # stays (to untick)
        # Opened again on the meeting page (Home's tick: Undo) → the to-do page follows.
        r = await self.http.post("/api/v1/home/actions/tick", headers=self.session("wm"),
                                 json={"slug": mp["slug"], "block": blk, "done": False})
        self.assertEqual(r.status_code, 200, r.text)
        await TP.drain()
        self.assertFalse(self.block_of((await self.todo("wm"))["content"], "Update the forecast sheet")[1])
        # MCP tick_todo by words: both sides.
        tok = await self.mcp_token("wm", write=True)
        _s, res = await self.mcp_call(tok, "tick_todo", {"item": "forecast"})
        self.assertFalse(res.get("isError"), res)
        await TP.drain()
        self.assertTrue(self.block_of((await self.mpage(m))["content"], "Update the forecast sheet")[1])
        self.assertTrue(self.block_of((await self.todo("wm"))["content"], "Update the forecast sheet")[1])
        r = await self.http.post("/api/v1/todos/tick", headers=self.session("wm"), json={"block": blk, "done": True})
        self.assertEqual(r.status_code, 409)
        r = await self.http.post("/api/v1/todos/tick", headers=self.session("wv"), json={"block": blk, "done": False})
        self.assertEqual(r.status_code, 404)

    async def test_while_someone_edits_the_call_and_edits_to_the_item_text(self):
        m = await self.call("Pipeline review")
        mp, raw = await self.mpage(m), await self.todo("wm")
        blk, _ = self.block_of(mp["content"], "Update the forecast sheet")
        # Ada holds the meeting page's edit lock: Bo's tick still lands (merged into her editor), no 423.
        r = await self.http.post(f"/api/v1/documents/{mp['slug']}/lock", headers=self.session("owner"), json={"intent": "edit"})
        self.assertIn(r.status_code, (200, 201), r.text)
        self.assertTrue((await self.mpage(m)).get("edit_lock"))
        r = await self.save(raw, TP._set_mark(raw["content"], blk, True), "wm")
        self.assertEqual(r.status_code, 200, r.text)
        await TP.drain()
        self.assertTrue(self.block_of((await self.mpage(m))["content"], "Update the forecast sheet")[1])
        # Someone rewords the item on the call: the to-do page follows, same identity, the tick kept.
        mp = await self.mpage(m)
        new = mp["content"].replace("Update the forecast sheet", "Update the Q4 forecast sheet")
        r = await self.http.post(f"/api/v1/documents/{mp['slug']}/unlock", headers=self.session("owner"), json={})
        r = await self.save(mp, new, "owner")
        self.assertEqual(r.status_code, 200, r.text)
        await TP.drain()
        body = (await self.todo("wm"))["content"]
        self.assertIn("Update the Q4 forecast sheet", body)
        self.assertTrue(self.block_of(body, "Q4 forecast")[1])
        self.assertEqual(self.block_of(body, "Q4 forecast")[0], blk)
        # The item deleted from the call: gone from the to-do page (the empty state again).
        mp = await self.mpage(m)
        new = "\n".join(ln for ln in mp["content"].split("\n") if blk not in ln)
        self.assertEqual((await self.save(mp, new, "owner")).status_code, 200)
        await TP.drain()
        body = (await self.todo("wm"))["content"]
        self.assertNotIn(blk, body)
        self.assertIn(TP.EMPTY, body)

    async def test_a_tick_the_call_missed_is_kept_and_pushed_again(self):
        m = await self.call("Pipeline review")
        raw = await self.todo("wm")
        blk, _ = self.block_of(raw["content"], "Update the forecast sheet")
        # Written without the hook (as if the push failed): the page says done, the call doesn't.
        await self.db["documents"].update_one({"_id": raw["_id"]}, {"$set": {"content": TP._set_mark(raw["content"], blk, True)}})
        await self.rebuild("wm")
        self.assertTrue(self.block_of((await self.todo("wm"))["content"], "forecast")[1])
        self.assertTrue(self.block_of((await self.mpage(m))["content"], "Update the forecast sheet")[1])

    async def test_a_call_moved_out_of_the_team_leaves_the_page(self):
        m = await self.call("Pipeline review")
        self.assertIn("Update the forecast sheet", (await self.todo("wm"))["content"])
        r = await self.http.put(f"/api/v1/meetings/{m['id']}/teams", headers=self.session("owner"), json={"team_ids": [], "project_ids": []})
        self.assertEqual(r.status_code, 200, r.text)
        await TP.drain()
        self.assertNotIn("Update the forecast sheet", (await self.todo("wm"))["content"])


class Merge(TodoWorld):
    async def test_system_writes_merge_while_the_owner_edits(self):
        """pages.MERGE_EDIT lets Markdrop's own write ("system") through someone else's edit lock."""
        await self.call("Pipeline review")
        raw = await self.todo("wm")
        r = await self.http.post(f"/api/v1/documents/{raw['slug']}/lock", headers=self.session("wm"), json={"intent": "edit"})
        self.assertIn(r.status_code, (200, 201), r.text)
        before = (await self.todo("wm"))["edit_lock"]
        await self.call("Acme renewal", date="2026-11-05")
        after = await self.todo("wm")
        self.assertIn("Send the pricing deck", after["content"])
        self.assertEqual(after["edit_lock"].get("user_id"), before.get("user_id"))      # still Bo's
        self.assertFalse(pages.MERGE_EDIT.get())
