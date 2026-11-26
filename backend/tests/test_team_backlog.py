"""Team backlogs (services/team_backlog.py, routers/backlog.py, mcp/backlog_tools.py; brief .work/briefs/team-backlog.md).

Sales (private: Ada Lovelace = owner, the lead; Bo Chen = wm; Ravi Kumar = wv, a workspace viewer) gets ONE
"Sales — Backlog" page, filled after every call: each action item plus the customer asks the (fake) model finds in
the call's notes, sorted into categories, repeats from several calls merged. Page edits flow back (tick, move a line
under another heading, edit the text, delete a line, "· In progress"); a human edit always wins; ticking syncs with
the meeting page both ways; calls restricted to their attendees stay off the page. The model is always fake.

Run: cd backend && MARKDROP_TEST_MONGODB_URI=mongodb://127.0.0.1:27019 .venv/bin/python -m unittest tests.test_team_backlog -v
"""

from __future__ import annotations

import io
import json
import re
from contextlib import redirect_stdout
from datetime import datetime, timezone

from bson import ObjectId

from app.config import get_settings
from app.services import ai_usage, team_backlog as TB, teams as T, todo_pages as TP, todos
from tests.test_todo_pages import GENS, TodoWorld

settings = get_settings()
_SAVED = ("team_backlog_enabled", "team_backlog_daily_usd", "team_backlog_monthly_usd")

ASKS = {
    "Acme renewal": [{"text": "Export reports to CSV", "category": "feature", "cite": "s1"},
                     {"text": "Login fails on Safari", "category": "bug", "cite": None}],
    "Globex intro": [{"text": "Export the reports as CSV files", "category": "feature", "cite": None}],
    "Secret pricing": [{"text": "Volume discount for 500 seats", "category": "question", "cite": None}],
}
GENS.setdefault("Northwind check-in", {"summary": "Check-in.", "highlights": [], "decisions": [], "open_questions": [],
                                       "topics": [], "action_items": [], "type": "Customer"})


def _cat(text: str) -> str:
    t = text.lower()
    return "follow_up" if any(w in t for w in ("pricing", "share", "quote", "discount")) else "task"


class BacklogWorld(TodoWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await TB.ensure_indexes(self.db)
        self.saved_tb = {k: getattr(settings, k) for k in _SAVED}
        settings.team_backlog_enabled = True
        settings.team_backlog_daily_usd, settings.team_backlog_monthly_usd = 3.0, 30.0
        ai_usage.invalidate_settings()
        self.addCleanup(lambda: [setattr(settings, k, v) for k, v in self.saved_tb.items()])

    async def asyncTearDown(self):
        await TB.drain()
        await super().asyncTearDown()

    def script(self, params: dict) -> str:
        system = params["system"][0]["text"]
        user = "\n".join(b["text"] for b in params["messages"][-1]["content"] if b.get("type") == "text")
        if system.startswith("You keep a team's backlog"):
            title = (re.search(r"Title: ([^\n]+)", user) or [None, ""])[1].strip()
            acts = re.findall(r"^(A\d+): (.+)$", user, re.M)
            return json.dumps({"actions": [{"id": i, "category": _cat(t)} for i, t in acts], "asks": ASKS.get(title, [])})
        if system.startswith("You match new backlog items"):
            existing = dict(re.findall(r"^(E\d+): (.+)$", user, re.M))
            same = []
            for n, text in re.findall(r"^(N\d+): (.+)$", user, re.M):
                if "csv" in text:
                    e = next((k for k, v in existing.items() if "csv" in v), None)
                    if e:
                        same.append({"new": n, "existing": e})
            return json.dumps({"same": same})
        return super().script(params)

    def backlog_calls(self, kind: str = "You keep a team's backlog") -> list[dict]:
        return [c for c in self.fake.calls if c["system"][0]["text"].startswith(kind)]

    async def settle(self):
        for _ in range(3):
            await TP.drain()
            await TB.drain()

    async def call(self, title: str, date: str = "2026-11-03", **extra) -> dict:
        m = await super().call(title, date, **extra)
        await self.settle()
        return m

    async def page(self) -> dict | None:
        return await TB.page_of(self.db, self.sales)

    async def items(self, **q) -> list[dict]:
        return await self.db[TB.ITEMS].find({"team_id": self.sales, **q}).to_list(length=500)

    async def item(self, words: str) -> dict:
        return next(it for it in await self.items() if words.lower() in TB.norm(it["text"]))

    def line(self, content: str, words: str) -> str:
        return next(ln for ln in TB.region(content).split("\n") if words in ln and ln.lstrip().startswith("- ["))

    async def edit_page(self, fn, who: str = "wm"):
        raw = await self.page()
        r = await self.save(raw, fn(raw["content"]), who)
        self.assertEqual(r.status_code, 200, r.text)
        await self.settle()
        return await self.page()


class Fill(BacklogWorld):
    async def test_a_call_fills_one_categorized_page_for_the_team(self):
        acme = await self.call("Acme renewal")
        raw = await self.page()
        self.assertIsNotNone(raw)
        # The model is told who in the call is a member and who is a guest (internal ideas aren't customer asks).
        sent = self.backlog_calls()[0]["messages"][0]["content"][0]["text"]
        self.assertRegex(sent, r"People: .*\((member|guest)\)")
        self.assertEqual((raw["title"], raw["team_ids"], raw["backlog_team_id"]), ("Sales — Backlog", [self.sales], self.sales))
        body = raw["content"]
        reg = TB.region(body)
        self.assertTrue(reg.startswith(TB.START))
        # Every category has its toggle heading, with its open count, in the constant's order.
        heads = re.findall(r':::details\{summary="([^"]+)"', reg)
        self.assertEqual([h.split(" · ")[0] for h in heads], [label for _k, label in TB.CATEGORIES])
        self.assertIn('summary="Feature request · 1 open"', reg)
        self.assertIn('summary="Follow-up · 1 open"', reg)
        self.assertIn('summary="Improvement · 0 open"', reg)
        # Action items (categorized) and the customer asks from the notes.
        by = {TB.norm(it["text"]): it for it in await self.items()}
        self.assertEqual(set(by), {"send the pricing deck · due thursday", "book the security review",
                                   "export reports to csv", "login fails on safari"})
        self.assertEqual(by["send the pricing deck · due thursday"]["category"], "follow_up")
        self.assertEqual(by["book the security review"]["category"], "task")
        self.assertEqual((by["export reports to csv"]["category"], by["login fails on safari"]["category"]), ("feature", "bug"))
        # The line: text — owner chip, the call it came from (the item on the meeting page), first seen.
        mp = await self.mpage(acme)
        blk, _ = self.block_of(mp["content"], "Send the pricing deck")
        ln = self.line(body, "Send the pricing deck")
        self.assertIn(f':person[Bo Chen]{{id="{self.uid["wm"]}"}}', ln)
        self.assertIn(f"from [Acme renewal · Nov 3](/{mp['slug']}#{blk})", ln)
        self.assertIn("first seen Nov 3", ln)
        self.assertRegex(ln, r"\{#b-[0-9a-f]{10}\}$")
        self.assertNotIn(blk, ln.rsplit("{#", 1)[1])            # its own identity, not the meeting's
        csv = self.line(body, "Export reports to CSV")
        self.assertRegex(csv, r"from \[Acme renewal · Nov 3\]\(/[^)#]+#b-t0001\)")   # the transcript moment
        # Home doesn't list the backlog's lines again, and nobody's to-do page picks them up.
        self.assertFalse(todos.eligible(raw))
        bo = await self.rebuild("wm")
        self.assertEqual(bo.open, 1)
        # The sidebar's Backlog row.
        r = await self.http.get(f"{self.base}/teams", headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        card = next(t for t in r.json()["teams"] if t["id"] == self.sales)
        self.assertEqual(card["backlog"], {"slug": raw["slug"], "open": 4})
        # The page's meta tells the reader and the editor to show the filter bar.
        r = await self.http.get(f"/api/v1/documents/{raw['slug']}", headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["backlog"], {"team_id": self.sales, "workspace_id": self.W})

    async def test_rerunning_is_idempotent_and_the_model_reads_a_call_once(self):
        await self.call("Acme renewal")
        n_calls, raw = len(self.backlog_calls()), await self.page()
        self.assertEqual(n_calls, 1)
        before = sorted((it["block"], it["text"]) for it in await self.items())
        for _ in range(2):
            await TB.sync_team(self.db, self.sales)
            await self.settle()
        self.assertEqual(sorted((it["block"], it["text"]) for it in await self.items()), before)
        again = await self.page()
        self.assertEqual((again["rev"], again["content"]), (raw["rev"], raw["content"]))   # nothing rewritten
        self.assertEqual(len(self.backlog_calls()), 1)
        # The script: a dry run writes nothing; --apply is safe to repeat.
        from scripts import team_backlog as script

        await self.db[TB.ITEMS].delete_many({})
        out = io.StringIO()
        with redirect_stdout(out):
            code, got = await script.run(self.db, self.W, "Sales", False)
        self.assertEqual(code, 0)
        self.assertIn("DRY RUN", out.getvalue())
        self.assertEqual(got["teams"][0]["calls"], 1)
        self.assertEqual(await self.db[TB.ITEMS].count_documents({}), 0)
        with redirect_stdout(io.StringIO()):
            code, got = await script.run(self.db, self.W, "Sales", True)
        self.assertEqual((code, got["teams"][0]["added"]), (0, 4))
        self.assertEqual(len(self.backlog_calls()), 1)              # the call's reading was cached

    async def test_the_same_ask_from_two_calls_is_one_item(self):
        await self.call("Acme renewal")
        await self.call("Globex intro", date="2026-11-04")
        csv = [it for it in await self.items() if "csv" in TB.norm(it["text"])]
        self.assertEqual(len(csv), 1)
        self.assertEqual(len(csv[0]["sources"]), 2)
        self.assertEqual(len(self.backlog_calls("You match new backlog items")), 1)
        ln = self.line((await self.page())["content"], "Export reports to CSV")
        self.assertIn("2 calls", ln)
        self.assertIn("first seen Nov 3", ln)
        self.assertIn("from [Globex intro · Nov 4]", ln)            # the latest call

    async def test_without_the_model_items_land_as_tasks_and_are_sorted_later(self):
        settings.team_backlog_enabled = False
        ai_usage.invalidate_settings()
        await self.call("Acme renewal")
        its = await self.items()
        self.assertEqual({(it["category"], it["category_by"]) for it in its}, {("task", "default")})
        self.assertEqual(len(its), 2)                                # asks wait for the model
        settings.team_backlog_enabled = True
        ai_usage.invalidate_settings()
        r = await self.http.post(f"{self.base}/teams/{self.sales}/backlog/refresh", headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        await self.settle()
        by = {TB.norm(it["text"]): it for it in await self.items()}
        self.assertEqual(by["send the pricing deck · due thursday"]["category"], "follow_up")
        self.assertIn("export reports to csv", by)

    async def test_a_call_moved_to_another_team_moves_its_items(self):
        acme = await self.call("Acme renewal")
        mp = await self.mpage(acme)
        await T.apply_to_doc(self.db, mp, [self.eng], [])
        await self.settle()
        self.assertEqual(await self.items(), [])
        self.assertNotIn("Send the pricing deck", (await self.page())["content"])
        eng = await self.db[TB.ITEMS].count_documents({"team_id": self.eng})
        self.assertEqual(eng, 4)

    async def test_turned_off_in_team_settings(self):
        r = await self.http.patch(f"{self.base}/teams/{self.sales}", headers=self.session("owner"), json={"backlog": False})
        self.assertEqual(r.status_code, 200, r.text)
        await self.call("Acme renewal")
        self.assertEqual(await self.items(), [])
        self.assertIsNone(await self.page())
        r = await self.http.get(f"{self.base}/teams/{self.sales}", headers=self.session("owner"))
        self.assertFalse(r.json().get("backlog_enabled", r.json().get("team", {}).get("backlog_enabled")))


class Edits(BacklogWorld):
    async def test_page_edits_flow_back_and_a_human_edit_wins(self):
        await self.call("Acme renewal")
        # Move "Login fails on Safari" under Improvement, reword the security review, mark CSV in progress.
        def edit(c: str) -> str:
            ln = self.line(c, "Login fails on Safari")
            c = c.replace(ln + "\n", "")
            c = c.replace('summary="Improvement · 0 open" heading="3"}\n' + TB.EMPTY_SECTION,
                          'summary="Improvement · 0 open" heading="3"}\n' + ln)
            sec = self.line(c, "Book the security review")
            c = c.replace(sec, sec.replace("Book the security review", "Book the SOC 2 security review"))
            csv = self.line(c, "Export reports to CSV")
            return c.replace(csv, csv.replace(" {#", " · In progress {#"))
        raw = await self.edit_page(edit)
        login, sec, csv = await self.item("login fails"), await self.item("soc 2"), await self.item("csv")
        self.assertEqual((login["category"], login["category_by"]), ("improvement", "human"))
        self.assertEqual((sec["text"], sec["human_text"]), ("Book the SOC 2 security review", True))
        self.assertEqual((csv["status"], csv["status_by"]), ("in_progress", "human"))
        # The page was rewritten in order: counts follow, the moved line sits in its new section.
        reg = TB.region(raw["content"])
        self.assertIn('summary="Improvement · 1 open"', reg)
        self.assertIn('summary="Bug · 0 open"', reg)
        self.assertIn("Export reports to CSV — In progress · ", reg)
        # The model reads the call again (regenerated notes): the human's edits stay.
        await self.db["meetings"].update_many({}, {"$unset": {"backlog_ai": ""}})
        await TB.sync_team(self.db, self.sales)
        await self.settle()
        login, sec = await self.item("login fails"), await self.item("soc 2")
        self.assertEqual(login["category"], "improvement")
        self.assertEqual(sec["text"], "Book the SOC 2 security review")
        # The API edit wins the same way.
        r = await self.http.patch(f"/api/v1/backlog/items/{login['_id']}", headers=self.session("wm"),
                                  json={"category": "bug", "owner": self.uid["owner"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["category"], r.json()["owner"]["name"]), ("bug", "Ada Lovelace"))
        self.assertIn(':person[Ada Lovelace]', self.line((await self.page())["content"], "Login fails on Safari"))

    async def test_text_outside_the_list_stays_and_a_deleted_line_is_wont_do(self):
        await self.call("Acme renewal")
        raw = await self.edit_page(lambda c: "Our notes stay here.\n\n" + c.replace(self.line(c, "Login fails on Safari") + "\n", "")
                                   + "\nAnd here.\n")
        login = await self.item("login fails")
        self.assertEqual((login["status"], login["status_by"]), ("wont_do", "human"))
        self.assertNotIn("Login fails on Safari", raw["content"])
        self.assertTrue(raw["content"].startswith("Our notes stay here."))
        self.assertTrue(raw["content"].rstrip().endswith("And here."))
        await TB.sync_team(self.db, self.sales)                     # not added back
        await self.settle()
        self.assertNotIn("Login fails on Safari", (await self.page())["content"])
        # A task line someone types in the list becomes an item of its own.
        def add(c: str) -> str:
            return c.replace('summary="Improvement · 0 open" heading="3"}\n' + TB.EMPTY_SECTION,
                             'summary="Improvement · 0 open" heading="3"}\n- [ ] Dark mode for the dashboard {#b-typed01}')
        raw = await self.edit_page(add)
        typed = await self.item("dark mode")
        self.assertEqual((typed["category"], typed["manual"], typed["block"]), ("improvement", True, "b-typed01"))
        self.assertIn("{#b-typed01}", TB.region(raw["content"]))

    async def test_ticking_syncs_with_the_meeting_page_both_ways(self):
        acme = await self.call("Acme renewal")
        mp = await self.mpage(acme)
        blk, _ = self.block_of(mp["content"], "Send the pricing deck")
        # Ticked on the meeting page → Done in the backlog.
        r = await self.save(mp, TP._set_mark(mp["content"], blk, True), "owner")
        self.assertEqual(r.status_code, 200, r.text)
        await self.settle()
        it = await self.item("pricing deck")
        self.assertEqual((it["status"], it["status_by"]), ("done", "auto"))
        self.assertTrue(self.line((await self.page())["content"], "Send the pricing deck").startswith("- [x]"))
        # A human sets In progress after the tick: it stays (the call didn't change since).
        r = await self.http.patch(f"/api/v1/backlog/items/{it['_id']}", headers=self.session("wm"), json={"status": "in_progress"})
        self.assertEqual(r.status_code, 200, r.text)
        await TB.sync_team(self.db, self.sales)
        await self.settle()
        self.assertEqual((await self.item("pricing deck"))["status"], "in_progress")
        # Done on the backlog page → ticked on the meeting page.
        sec_blk, _ = self.block_of(mp["content"], "Book the security review")
        await self.edit_page(lambda c: c.replace(self.line(c, "Book the security review"),
                                                 self.line(c, "Book the security review").replace("- [ ]", "- [x]", 1)), who="owner")
        self.assertEqual((await self.item("security review"))["status"], "done")
        self.assertEqual(TP.marks((await self.mpage(acme))["content"]).get(sec_blk), True)
        # Unticked on the meeting page → open again.
        mp = await self.mpage(acme)
        r = await self.save(mp, TP._set_mark(mp["content"], sec_blk, False), "owner")
        self.assertEqual(r.status_code, 200, r.text)
        await self.settle()
        self.assertEqual((await self.item("security review"))["status"], "open")

    async def test_comments_on_an_item_stay_attached_across_rebuilds(self):
        from app.services.comments import anchoring

        await self.call("Acme renewal")
        raw = await self.page()
        blk = re.search(r"\{#(b-[0-9a-f]+)\}", self.line(raw["content"], "Login fails on Safari")).group(1)
        anchor = anchoring.anchor_from_quote(raw["content"], "Login fails on Safari", int(raw["rev"]), block_id=blk)
        await self.call("Globex intro", date="2026-11-04")         # a rebuild: new items, counts, order change
        await self.call("Pipeline review", date="2026-11-05")
        new = await self.page()
        self.assertGreater(new["rev"], raw["rev"])
        got, state = anchoring.resolve(new["content"], anchor, int(new["rev"]))
        self.assertEqual(state, "attached")
        self.assertEqual(got["quote"]["exact"], "Login fails on Safari")


class Access(BacklogWorld):
    async def test_items_from_restricted_calls_stay_off_the_page(self):
        await self.call("Acme renewal")
        await self.call("Secret pricing", restricted=True)
        body = (await self.page())["content"]
        self.assertNotIn("confidential discount", body)
        self.assertNotIn("Volume discount", body)
        self.assertNotIn("Secret pricing", body)
        self.assertEqual(await self.db[TB.ITEMS].count_documents({"team_id": self.sales}), 6)
        lead = await self.http.get(f"{self.base}/teams/{self.sales}/backlog", headers=self.session("owner"))
        self.assertEqual(lead.status_code, 200, lead.text)
        self.assertEqual((lead.json()["private"], lead.json()["open"]), (2, 4))
        member = await self.http.get(f"{self.base}/teams/{self.sales}/backlog", headers=self.session("wm"))
        self.assertIsNone(member.json()["private"])
        # The items as data: Bo (on the call) sees them; Ravi (in Sales, not on the call) doesn't, and gets no count.
        mine = await self.http.get(f"{self.base}/teams/{self.sales}/backlog/items", headers=self.session("wm"))
        self.assertIn("Volume discount for 500 seats", [i["text"] for i in mine.json()["items"]])
        bo = await self.http.get(f"{self.base}/teams/{self.sales}/backlog/items", headers=self.session("wv"))
        texts = [i["text"] for i in bo.json()["items"]]
        self.assertNotIn("Volume discount for 500 seats", texts)
        self.assertIn("Export reports to CSV", texts)
        self.assertIsNone(bo.json()["private"])
        hidden = await self.item("volume discount")
        r = await self.http.patch(f"/api/v1/backlog/items/{hidden['_id']}", headers=self.session("wv"), json={"status": "done"})
        self.assertEqual(r.status_code, 404, r.text)

    async def test_endpoint_auth(self):
        await self.call("Acme renewal")
        # Eng's lead (not in Sales, a private team): 404 everywhere.
        for path in ("backlog", "backlog/items"):
            r = await self.http.get(f"{self.base}/teams/{self.sales}/{path}", headers=self.session("ownv"))
            self.assertEqual(r.status_code, 404, (path, r.text))
        r = await self.http.post(f"{self.base}/teams/{self.sales}/backlog/refresh", headers=self.session("wm"))
        self.assertEqual(r.status_code, 403, r.text)                 # a member, not a lead
        it = await self.item("csv")
        r = await self.http.patch(f"/api/v1/backlog/items/{it['_id']}", headers=self.session("ownv"), json={"status": "done"})
        self.assertEqual(r.status_code, 404, r.text)
        r = await self.http.get(f"{self.base}/teams/{self.sales}/backlog")
        self.assertIn(r.status_code, (401, 403))
        general = await T.ensure_general(self.db, self.W)
        r = await self.http.get(f"{self.base}/teams/{general['_id']}/backlog",
                                headers=self.session("owner"))
        self.assertEqual(r.status_code, 404, r.text)


class Mcp(BacklogWorld):
    async def test_tools(self):
        from app.mcp import backlog_tools as BT
        from app.mcp.tools import Context, ToolError

        await self.call("Acme renewal")

        async def ctx(who: str) -> Context:
            return Context(db=self.db, user=await self.user(who), client_id="test", scopes=["read", "write"])

        text, data = await BT.team_backlog(await ctx("wm"), {"team": "Sales", "workspace": self.W})
        self.assertIn("Feature request (1):", text)
        self.assertEqual(len(data["items"]), 4)
        text, data = await BT.team_backlog(await ctx("wm"), {"team": "Sales", "workspace": self.W, "category": "bug"})
        self.assertEqual([i["text"] for i in data["items"]], ["Login fails on Safari"])
        iid = data["items"][0]["id"]
        text, got = await BT.update_backlog_item(await ctx("wm"), {"id": iid, "status": "in_progress", "category": "improvement"})
        self.assertEqual((got["item"]["status"], got["item"]["category"]), ("in_progress", "improvement"))
        self.assertIn("Login fails on Safari — In progress", (await self.page())["content"])
        with self.assertRaises(ToolError):
            await BT.refresh_team_backlog(await ctx("wm"), {"team": "Sales", "workspace": self.W})
        text, got = await BT.refresh_team_backlog(await ctx("owner"), {"team": "Sales", "workspace": self.W})
        self.assertIn("Refreshed Sales's backlog", text)
        self.assertEqual(got["added"], 0)


# ── Priorities (owner, 2026-11-26; brief .work/briefs/backlog-priority-dates.md) ──────────────────────────────────

PRIOS = {   # the (fake) model's priority per item text, with its reason
    "Send the pricing deck": ("high", "Due Thursday"), "Book the security review": ("low", "No date"),
    "Export reports to CSV": ("medium", None), "Login fails on Safari": ("urgent", "Blocks logins at Acme"),
    "Share two references": ("urgent", "Due Friday for the pilot"), "Export the reports as CSV files": ("high", "Asked again"),
}
SAID = {    # the priority decisions said in a call
    "Weekly prioritization": [
        {"about": "CSV export", "priority": "low", "speaker": "Ada Lovelace", "quote": "the CSV export can wait"},
        {"about": "Safari login bug", "priority": "high", "speaker": "Bo Chen", "quote": "Safari login is a P1"},
        {"about": "security review", "priority": "wont_do", "speaker": "Ada Lovelace", "quote": "let's drop the security review"},
        {"about": "pricing deck", "priority": "urgent", "speaker": "Ada Lovelace", "quote": "the pricing deck is top priority"},
        {"about": "the Salesforce thing", "priority": "high", "speaker": "Bo Chen", "quote": "the Salesforce thing matters"},
        {"about": "confidential discount", "priority": "urgent", "speaker": "Bo Chen", "quote": "the confidential discount first"}],
    "Planning sync": [{"about": "CSV export", "priority": "urgent", "speaker": "Bo Chen", "quote": "CSV is urgent now"}],
}
for _t in SAID:
    GENS.setdefault(_t, {"summary": "Prioritization.", "highlights": [], "decisions": [], "open_questions": [], "topics": [],
                         "action_items": [], "type": "Internal"})
WORDS = {"csv": "csv", "safari": "safari", "security": "security", "pricing deck": "pricing deck", "confidential": "confidential"}


class PrioWorld(BacklogWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.slack: list[dict] = []

    def script(self, params: dict) -> str:
        system = params["system"][0]["text"]
        user = "\n".join(b["text"] for b in params["messages"][-1]["content"] if b.get("type") == "text")
        if system.startswith("You keep a team's backlog"):
            got = json.loads(super().script(params))
            acts = dict(re.findall(r"^(A\d+): (.+)$", user, re.M))
            for a in got["actions"]:
                text = re.sub(r" · due .*$", "", acts[a["id"]])
                a["priority"], a["why"] = PRIOS.get(text, ("medium", None))
            for a in got["asks"]:
                a["priority"], a["why"] = PRIOS.get(a["text"], ("medium", None))
            title = (re.search(r"Title: ([^\n]+)", user) or [None, ""])[1].strip()
            got["priorities"] = SAID.get(title, [])
            return json.dumps(got)
        if system.startswith("You match priority decisions"):
            items = dict(re.findall(r"^(E\d+): (.+)$", user, re.M))
            out = []
            for sid, about, cands in re.findall(r"^(S\d+): (.+?) → .*\n\s+could be: (.+)$", user, re.M):
                key = next((w for w in WORDS if w in about.lower()), None)
                hit = next((e for e in [c.strip() for c in cands.split(",")] if key and key in items[e].lower()), None)
                if hit:
                    out.append({"decision": sid, "item": hit, "confidence": 0.95})
            return json.dumps({"matches": out})
        if system.startswith("You set priorities for a team's open backlog"):
            ids = re.findall(r"^(I\d+): ", user, re.M)
            return json.dumps({"items": [{"id": i, "priority": "high", "why": "Came up in a call"} for i in ids]})
        return super().script(params)

    def patch_slack(self):
        from unittest import mock

        from app.services import slack, slack_api
        from app.services import slack_notify as SN

        async def install(_db, _ws):
            return {"_id": "T0ACME", "post_meetings": True}

        async def shared(_token, _ch):
            return False

        async def call(method, token, **data):
            self.slack.append({"method": method, **data})
            return {"ok": True, "ts": "1.0001", "channel": data.get("channel")}

        for p in (mock.patch.object(slack, "configured", lambda: True), mock.patch.object(slack, "install_for_workspace", install),
                  mock.patch.object(slack, "bot_token", lambda _i: "xoxb-test"), mock.patch.object(SN, "channel_is_shared", shared),
                  mock.patch.object(slack_api, "call", call)):
            p.start()
            self.addCleanup(p.stop)

    def prio_posts(self) -> list[dict]:
        return [p for p in self.slack if p["method"] == "chat.postMessage" and "Priorit" in str(p.get("text"))]

    async def set_channel(self):
        await self.db[T.TEAMS].update_one({"_id": ObjectId(self.sales)}, {"$set": {"slack_channel": {"id": "C9SALES", "name": "sales"}}})


class Priorities(PrioWorld):
    async def test_the_model_sets_priorities_and_the_page_sorts_by_them(self):
        await self.call("Acme renewal")
        safari, deck, sec, csv = (await self.item("safari"), await self.item("pricing deck"), await self.item("security review"),
                                  await self.item("csv"))
        self.assertEqual((safari["priority"], safari["priority_source"], safari["priority_why"]), ("urgent", "ai", "Blocks logins at Acme"))
        self.assertEqual((deck["priority"], sec["priority"], csv["priority"]), ("high", "low", "medium"))
        self.assertEqual(safari["priority_link"]["title"], "Acme renewal")
        body = (await self.page())["content"]
        self.assertIn("Login fails on Safari — **Urgent** · ", self.line(body, "Login fails on Safari"))
        self.assertIn(" — **Low** · ", self.line(body, "Book the security review"))
        self.assertNotIn("Medium", self.line(body, "Export reports to CSV"))       # Medium isn't written
        # Inside a category: the most urgent first.
        await self.call("Globex intro", date="2026-11-04")
        reg = TB.region((await self.page())["content"])
        self.assertLess(reg.index("Share two references"), reg.index("Send the pricing deck"))
        # The same ask again, more urgently: the model raises its own priority (never lowers it).
        csv = await self.item("csv")
        self.assertEqual((len(csv["sources"]), csv["priority"], csv["priority_why"]), (2, "high", "Asked again"))
        # Done items sink into the category's closed "Done" toggle (the category's toggle gets four colons).
        r = await self.http.patch(f"/api/v1/backlog/items/{deck['_id']}", headers=self.session("wm"), json={"status": "done"})
        self.assertEqual(r.status_code, 200, r.text)
        reg = TB.region((await self.page())["content"])
        self.assertIn('::::details{summary="Follow-up · 1 open" heading="3" open="1"}', reg)
        self.assertRegex(reg, r':::details\{summary="Done · 1"\}\n- \[x\] Send the pricing deck')
        parsed = TB.parse_region((await self.page())["content"])
        self.assertEqual(parsed[deck["block"]].category, "follow_up")
        self.assertTrue(parsed[deck["block"]].done)

    async def test_a_person_wins_over_the_model_on_the_page_and_the_api(self):
        await self.call("Acme renewal")
        # "· High" typed on the line: a person's priority.
        def edit(c: str) -> str:
            ln = self.line(c, "Export reports to CSV")
            return c.replace(ln, ln.replace(" {#", " · Low {#"))
        await self.edit_page(edit)
        csv = await self.item("csv")
        self.assertEqual((csv["priority"], csv["priority_source"], csv["priority_why"]), ("low", "person", "Set by Bo Chen"))
        # The model reads it again (and a later call asks for it "high"): the person's stays.
        await self.db["meetings"].update_many({}, {"$unset": {"backlog_ai": ""}})
        await self.call("Globex intro", date="2026-11-04")
        self.assertEqual((await self.item("csv"))["priority"], "low")
        # Taking the word out = Medium (a person's decision too).
        def clear(c: str) -> str:
            ln = self.line(c, "Export reports to CSV")
            return c.replace(ln, ln.replace("**Low** · ", ""))
        await self.edit_page(clear)
        self.assertEqual(((await self.item("csv"))["priority"], (await self.item("csv"))["priority_source"]), ("medium", "person"))
        # The API, and a wrong value.
        r = await self.http.patch(f"/api/v1/backlog/items/{csv['_id']}", headers=self.session("wm"), json={"priority": "urgent"})
        self.assertEqual((r.status_code, r.json()["priority"], r.json()["priority_source"]), (200, "urgent", "person"))
        r = await self.http.patch(f"/api/v1/backlog/items/{csv['_id']}", headers=self.session("wm"), json={"priority": "p0"})
        self.assertEqual(r.status_code, 422, r.text)


class CallDecisions(PrioWorld):
    async def test_a_call_sets_priorities_posts_to_slack_and_tells_owners(self):
        from app.services import notifications

        self.patch_slack()
        await self.set_channel()
        await self.call("Acme renewal")
        await self.call("Secret pricing", restricted=True, date="2026-11-04")
        # Bo set Safari's priority himself before the call: the call is newer and wins.
        safari = await self.item("safari")
        r = await self.http.patch(f"/api/v1/backlog/items/{safari['_id']}", headers=self.session("wm"), json={"priority": "low"})
        self.assertEqual(r.status_code, 200, r.text)
        today = datetime.now(timezone.utc).date().isoformat()    # an older call is a quiet "past meeting": no Slack post
        weekly = await self.call("Weekly prioritization", date=today)
        csv, deck, sec, safari = (await self.item("csv"), await self.item("pricing deck"), await self.item("security review"),
                                  await self.item("safari"))
        self.assertEqual((csv["priority"], csv["priority_source"], csv["priority_by"]), ("low", "call", "Ada Lovelace"))
        self.assertTrue(csv["priority_why"].startswith("Ada Lovelace: “the CSV export can wait” — Weekly prioritization, "))
        self.assertEqual(csv["priority_link"]["title"], "Weekly prioritization")
        self.assertEqual((deck["priority"], deck["priority_source"]), ("urgent", "call"))
        self.assertEqual((sec["status"], sec["status_by"]), ("wont_do", "call"))
        self.assertEqual((safari["priority"], safari["priority_source"]), ("high", "call"))
        # Only one matcher call; the restricted call's item was never a candidate (nobody else may name it).
        matcher = self.backlog_calls("You match priority decisions")
        self.assertEqual(len(matcher), 1)
        self.assertNotIn("send the confidential discount", matcher[0]["messages"][0]["content"][0]["text"].lower())
        mark = (await self.mrow(weekly))["backlog_prio"][self.sales]
        self.assertEqual(sorted(c["to"] for c in mark["changes"]), ["high", "low", "urgent", "wont_do"])
        self.assertIn("The Salesforce thing", [u["about"] for u in mark["unmatched"]])
        self.assertIn("Confidential discount", [u["about"] for u in mark["unmatched"]])
        # The meeting page lists what changed and what couldn't be matched.
        mp = await self.mpage(weekly)
        self.assertIn(TB.M_START, mp["content"])
        self.assertIn("→ **Urgent** (was High) — Ada Lovelace", mp["content"])
        self.assertIn("Couldn't match: “the Salesforce thing matters” (High) — Bo Chen", mp["content"])
        # One Slack message in the team's channel, linking to the changed items.
        posts = self.prio_posts()
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0]["channel"], "C9SALES")
        text = json.dumps(posts[0], ensure_ascii=False)
        self.assertIn("Priorities updated from", text)
        self.assertIn("*Send the pricing deck · due Thursday* → *Urgent* (was High) — Ada Lovelace", text)
        self.assertIn("→ *Won't do* (was Open)", text)
        self.assertIn("Couldn't match: “the Salesforce thing matters”", text)
        self.assertIn("?items=", text)
        self.assertIn(deck["block"], text)
        self.assertNotIn("Send the confidential discount", text)                  # the restricted call's item
        # The pricing deck's owner (Bo) is told in the app; nobody else.
        rows = await self.db[notifications.COLL].find({"kind": "mention", "doc_id": str((await self.page())["_id"])}).to_list(length=20)
        self.assertEqual([r["user_id"] for r in rows], [self.uid["wm"]])
        self.assertIn("Send the pricing deck · due Thursday → Urgent (was High) · from Weekly prioritization", rows[0]["extra"]["excerpt"])
        # Idempotent: syncing again asks nothing and posts nothing.
        await TB.sync_team(self.db, self.sales)
        await self.settle()
        self.assertEqual(len(self.backlog_calls("You match priority decisions")), 1)
        self.assertEqual(len(self.prio_posts()), 1)
        # A person changes it after the call: theirs wins; a later call decides again: the call wins.
        r = await self.http.patch(f"/api/v1/backlog/items/{csv['_id']}", headers=self.session("wm"), json={"priority": "high"})
        self.assertEqual(r.json()["priority"], "high")
        await TB.sync_team(self.db, self.sales)
        await self.settle()
        self.assertEqual((await self.item("csv"))["priority"], "high")
        await self.call("Planning sync", date="2099-01-15")
        csv = await self.item("csv")
        self.assertEqual((csv["priority"], csv["priority_source"]), ("urgent", "call"))
        # The items API shows the evidence only to people who can open that call.
        r = await self.http.get(f"{self.base}/teams/{self.sales}/backlog/items", headers=self.session("wv"))
        it = next(i for i in r.json()["items"] if i["id"] == str(csv["_id"]))
        self.assertEqual((it["priority"], it["priority_source"]), ("urgent", "call"))
        self.assertIn("CSV is urgent now", it["priority_why"])

    async def test_a_restricted_call_never_reaches_slack_and_its_words_stay_with_its_readers(self):
        self.patch_slack()
        await self.set_channel()
        await self.call("Acme renewal")
        deck = await self.item("pricing deck")
        r = await self.http.patch(f"/api/v1/backlog/items/{deck['_id']}", headers=self.session("wm"), json={"priority": "low"})
        self.assertEqual(r.status_code, 200, r.text)
        await self.call("Weekly prioritization", date=datetime.now(timezone.utc).date().isoformat(), restricted=True)
        csv = await self.item("csv")
        self.assertEqual((csv["priority"], csv["priority_source"]), ("low", "call"))
        self.assertEqual(self.prio_posts(), [])
        # Ravi (in Sales, not on the call) sees the priority, not the words said in it; the page never has them.
        r = await self.http.get(f"{self.base}/teams/{self.sales}/backlog/items", headers=self.session("wv"))
        it = next(i for i in r.json()["items"] if i["id"] == str(csv["_id"]))
        self.assertEqual((it["priority"], it["priority_why"], it["priority_from"]), ("low", None, None))
        self.assertNotIn("can wait", (await self.page())["content"])
        self.assertNotIn("Weekly prioritization", (await self.page())["content"])
        r = await self.http.get(f"{self.base}/teams/{self.sales}/backlog/items", headers=self.session("owner"))
        it = next(i for i in r.json()["items"] if i["id"] == str(csv["_id"]))
        self.assertIn("can wait", it["priority_why"])

    async def test_an_older_call_never_overrides_a_newer_person(self):
        await self.call("Acme renewal")
        deck = await self.item("pricing deck")
        r = await self.http.patch(f"/api/v1/backlog/items/{deck['_id']}", headers=self.session("wm"), json={"priority": "low"})
        self.assertEqual(r.status_code, 200, r.text)
        await self.call("Weekly prioritization", date="2026-11-10")          # brought in later, said before
        self.assertEqual(((await self.item("pricing deck"))["priority"], (await self.item("csv"))["priority"]), ("low", "low"))
        self.assertEqual((await self.item("csv"))["priority_source"], "call")

    async def test_without_the_model_decisions_wait(self):
        await self.call("Acme renewal")
        settings.team_backlog_enabled = False
        ai_usage.invalidate_settings()
        await self.call("Weekly prioritization", date="2026-11-10")
        self.assertEqual((await self.item("csv"))["priority_source"], "ai")
        settings.team_backlog_enabled = True
        ai_usage.invalidate_settings()
        await TB.sync_team(self.db, self.sales)
        await self.settle()
        self.assertEqual((await self.item("csv"))["priority_source"], "call")


class Filters(PrioWorld):
    async def test_api_and_mcp_filters_sort_and_set_priorities(self):
        from app.mcp import backlog_tools as BT
        from app.mcp.tools import Context, ToolError

        await self.call("Acme renewal")
        await self.call("Globex intro", date="2026-11-20")
        await self.call("Secret pricing", restricted=True, date="2026-11-21")
        url = f"{self.base}/teams/{self.sales}/backlog/items"
        r = await self.http.get(url, params={"priority": "urgent,high", "sort": "priority"}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([i["priority"] for i in r.json()["items"]], ["urgent", "urgent", "high", "high"])
        r = await self.http.get(url, params={"since": "2026-11-15"}, headers=self.session("wv"))
        self.assertEqual([i["text"] for i in r.json()["items"]], ["Share two references · due Friday"])   # not the restricted one
        r = await self.http.get(url, params={"since": "2026-11-15", "date_by": "last"}, headers=self.session("wv"))
        self.assertIn("Export reports to CSV", [i["text"] for i in r.json()["items"]])               # mentioned again Nov 20
        r = await self.http.get(url, params={"until": "2026-11-03"}, headers=self.session("wm"))
        self.assertEqual(len(r.json()["items"]), 4)
        for bad in ({"priority": "p1"}, {"since": "1y"}):
            r = await self.http.get(url, params=bad, headers=self.session("wm"))
            self.assertEqual(r.status_code, 422, (bad, r.text))

        async def ctx(who: str) -> Context:
            return Context(db=self.db, user=await self.user(who), client_id="test", scopes=["read", "write"])

        text, data = await BT.team_backlog(await ctx("wm"), {"team": "Sales", "workspace": self.W, "priority": ["urgent"], "sort": "priority"})
        self.assertEqual({i["priority"] for i in data["items"]}, {"urgent"})
        self.assertIn("(Urgent", text)
        safari = await self.item("safari")
        text, got = await BT.update_backlog_item(await ctx("wm"), {"id": str(safari["_id"]), "priority": "low"})
        self.assertEqual(got["item"]["priority"], "low")
        hidden = await self.item("confidential")
        text, got = await BT.set_backlog_priorities(await ctx("wv"), {"team": "Sales", "workspace": self.W, "changes": [
            {"id": safari["block"], "priority": "high"}, {"id": str(hidden["_id"]), "priority": "urgent"}]})
        self.assertEqual([c["priority"] for c in got["changed"]], ["high"])
        self.assertEqual(got["failed"][0]["error"], "No such backlog item.")      # can't read it: not found, no leak
        self.assertEqual((await self.item("confidential"))["priority"], "medium")
        self.assertIn("— **High** · ", self.line((await self.page())["content"], "Login fails on Safari"))
        with self.assertRaises(ToolError):                                        # Eng's lead: not in Sales
            await BT.set_backlog_priorities(await ctx("ownv"), {"team": "Sales", "workspace": self.W,
                                                               "changes": [{"id": safari["block"], "priority": "low"}]})
        r = await self.http.post(f"{self.base}/teams/{self.sales}/backlog/priorities", headers=self.session("ownv"),
                                 json={"changes": [{"id": safari["block"], "priority": "low"}]})
        self.assertEqual(r.status_code, 404, r.text)
        r = await self.http.post(f"{self.base}/teams/{self.sales}/backlog/priorities", headers=self.session("wm"),
                                 json={"changes": [{"id": safari["block"], "priority": "urgent"}]})
        self.assertEqual((r.status_code, r.json()["changed"][0]["priority"]), (200, "urgent"))

    async def test_the_home_widget_takes_priority_and_since(self):
        from app.services import dashboards

        spec = dashboards.WIDGETS["backlog"]["settings"]
        self.assertEqual(spec["priority"]["options"], ["urgent", "high", "medium", "low"])
        self.assertEqual(spec["since"]["options"], ["7d", "30d", "90d", "month"])


class Backfill(PrioWorld):
    async def test_the_script_sets_priorities_for_items_without_one(self):
        from scripts import backlog_priorities as script

        await self.call("Acme renewal")
        safari = await self.item("safari")
        await self.db[TB.ITEMS].update_many({"team_id": self.sales}, {"$unset": {"priority": "", "priority_source": ""}})
        await self.db[TB.ITEMS].update_one({"_id": safari["_id"]}, {"$set": {"priority": "low", "priority_source": "person"}})
        out = io.StringIO()
        with redirect_stdout(out):
            code, got = await script.run(self.db, self.W, "Sales", False)
        self.assertEqual((code, got["teams"][0]["items"]), (0, 3))
        self.assertIn("DRY RUN", out.getvalue())
        self.assertEqual(await self.db[TB.ITEMS].count_documents({"priority_source": "ai"}), 0)
        with redirect_stdout(io.StringIO()):
            code, got = await script.run(self.db, self.W, "Sales", True)
        self.assertEqual(got["teams"][0]["set"], 3)
        self.assertEqual((await self.item("csv"))["priority"], "high")
        self.assertEqual((await self.item("safari"))["priority"], "low")              # a person's is never touched
        self.assertEqual(len(self.backlog_calls("You set priorities")), 1)
        with redirect_stdout(io.StringIO()):
            code, got = await script.run(self.db, self.W, "Sales", True)
        self.assertEqual(got["teams"][0]["items"], 0)                                 # safe to repeat


class Messages(PrioWorld):
    def test_the_slack_message_and_the_page_parser(self):
        from app.services import message_gallery as g, slack_preview

        msg = g.backlog_priorities_post()
        text = json.dumps(msg, ensure_ascii=False)
        self.assertIn("Priorities updated from <", text)
        self.assertIn("*SSO via Okta for the Globex pilot* → *Urgent* (was Medium) — Riya Sharma", text)
        self.assertIn("→ *Won't do* (was Open)", text)
        self.assertIn("Couldn't match: “the Salesforce thing” — Sam Lee", text)
        self.assertIn("Open the changed items", text)
        self.assertTrue(slack_preview.blocks_html(msg["blocks"]))
        self.assertEqual(TB.parse_line("Export CSV — In progress · **High** · Acme · first seen Nov 3"), ("Export CSV", "in_progress", "high"))
        self.assertEqual(TB.parse_line("Dark mode · Low"), ("Dark mode", None, "low"))
        self.assertEqual(TB.parse_since("month", __import__("datetime").date(2026, 11, 26)), "2026-11-01")
