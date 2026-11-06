"""Ask's live suggestions (services/ask_suggestions.py, GET /api/v1/ask/suggestions; .work/briefs/ask-page.md).

The one cached list per workspace is shown to every member, so it is built **only from what every member
can read**: a meeting restricted to its attendees, a private page, a password page, an encrypted one and
another workspace's items never reach the model or the list. Then the cache (a rebuild only when the
sources changed: same text, no call), the debounce (quiet for DEBOUNCE, MIN_GAP between checks, at least
DAILY), the ``ask_suggestions`` switch and caps (a limit keeps the last list), personal suggestions per
viewer (no AI), the API (a non-member gets 404, sign-in needed) and the "My files" scope. The model is
always the fake client: nothing leaves the machine.
"""

from __future__ import annotations

import asyncio
import json
import unittest
from datetime import timedelta

from tests.test_ask_markdrop import AskWorld
from tests.test_pages_ai import parse_sse, prompt_of

from bson import ObjectId

from app.config import get_settings
from app.services import access, ai_usage, ask_suggestions as sug

settings = get_settings()
_SAVED = ("ask_suggestions_enabled", "ask_suggestions_daily_usd", "ask_suggestions_monthly_usd")

SECRET_MEETING = {"name": "Secret acquisition sync",
                  "text": "Ada Lovelace: The acquisition codename is codename-heron.\nBo Chen: Heron closes Friday."}


def is_sug(params: dict) -> bool:
    return params["system"][0]["text"].startswith('You write suggested questions for "Ask"')


class SugWorld(AskWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await sug.ensure_indexes(self.db)
        self.saved_sug = {k: getattr(settings, k) for k in _SAVED}
        settings.ask_suggestions_enabled = True
        settings.ask_suggestions_daily_usd = 0.5
        settings.ask_suggestions_monthly_usd = 5.0
        ai_usage.invalidate_settings()
        self.addCleanup(lambda: [setattr(settings, k, v) for k, v in self.saved_sug.items()])
        self.questions = [{"topic": "Sourcing", "question": "What did we decide about Sourcing this week"},
                          {"topic": "Pricing", "question": "Who owns the pricing page rewrite?"},
                          {"topic": "Pricing", "question": "who owns the pricing page rewrite?"},   # a duplicate
                          {"topic": "Launch", "question": "1. What's still open on the launch?"},
                          {"topic": "x", "question": "Short"}]                                      # too short
        base = self.fake.script

        def script(params):
            if is_sug(params):
                return json.dumps({"questions": self.questions})
            return base(params)
        self.fake.script = script

    async def asyncTearDown(self):
        for t in list(sug._bg):
            await asyncio.wait({t}, timeout=10)
        await super().asyncTearDown()

    def sug_calls(self) -> list[dict]:
        return [c for c in self.fake.calls if is_sug(c)]

    async def seed(self) -> None:
        await self.import_meeting()                                                   # the team's
        await self.import_meeting(sources=[SECRET_MEETING], restricted=True)          # Ada and Bo only
        await self.put("open-plan", "Sourcing plan", "# Sourcing plan\n\n## Vendors shortlist\n\nText.\n\n## Timeline\n")
        await self.put("priv-plan", "Layoff plan", "# Layoff plan\n\n## Names", owner="wm", state="P")
        await self.put("pw-plan", "Board deck ostrich", "# Board deck\n\n## Ostrich numbers", state="LP")
        await self.mkdoc("W", slug="enc-plan", title="Encrypted pelican", content="cipher", encrypted=True, grants=False)
        await self.put("other-ws", "Other workspace gecko", "# Gecko", owner="wm2", ws="W2")

    async def get(self, who: str, workspace: str | None = None):
        q = f"?workspace={workspace}" if workspace else ""
        return await self.http.get(f"/api/v1/ask/suggestions{q}", headers=self.session(who))


class Sources(SugWorld):
    async def test_only_what_every_member_can_read(self):
        await self.seed()
        src = await sug.team_sources(self.db, self.W)
        text = sug.source_text(src)
        self.assertIn("Weekly product sync", text)
        self.assertIn("Sourcing plan", text)
        self.assertIn("Vendors shortlist", text)                                      # its headings
        for secret in ("Secret acquisition", "heron", "Heron", "Layoff", "ostrich", "Ostrich", "pelican", "gecko"):
            self.assertNotIn(secret, text, secret)
        row = await self.build()
        self.assertEqual(len(self.sug_calls()), 1)
        p = prompt_of(self.sug_calls()[0])
        for secret in ("Secret acquisition", "heron", "Layoff", "ostrich", "pelican", "gecko"):
            self.assertNotIn(secret, p, secret)
        self.assertIn("<untrusted_workspace>", p)
        # Cleaned: a "?" at the end, numbering gone, duplicates and too-short ones dropped.
        self.assertEqual([q["question"] for q in row["questions"]], [
            "What did we decide about Sourcing this week?", "Who owns the pricing page rewrite?",
            "What's still open on the launch?"])
        # Ledger: one row under ask_suggestions.
        rows = await self.db[ai_usage.REQUESTS].find({"feature": "ask_suggestions"}).to_list(length=10)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["outcome"], "ok")

    async def test_restricting_a_meeting_later_takes_it_out(self):
        m = await self.import_meeting()
        self.assertIn("Weekly product sync", sug.source_text(await sug.team_sources(self.db, self.W)))
        r = await self.http.patch(f"/api/v1/meetings/{m['id']}", headers=self.session("owner"), json={"restricted": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn("Weekly product sync", sug.source_text(await sug.team_sources(self.db, self.W)))

    async def test_inheriting_sub_page_of_a_private_page_is_left_out(self):
        parent = await self.put("p-parent", "Private parent", "# Private parent", state="P")
        await self.put("p-child", "Child of private kiwi", "# Kiwi", parent_id=parent["_id"])
        await self.put("w-parent", "Team parent", "# Team parent")
        self.assertNotIn("kiwi", sug.source_text(await sug.team_sources(self.db, self.W)).lower())

    async def build(self, **kw):
        return await sug.build(self.db, self.W, **kw)


class Cache(SugWorld):
    async def test_same_sources_no_new_call_and_force(self):
        await self.seed()
        await sug.build(self.db, self.W)
        await sug.build(self.db, self.W)
        self.assertEqual(len(self.sug_calls()), 1)                                   # nothing changed
        # A body edit that doesn't touch a title or heading: still the same fingerprint.
        await self.db["documents"].update_one({"slug": "open-plan"}, {"$set": {"content": "# Sourcing plan\n\n## Vendors shortlist\n\nMore text.\n\n## Timeline\n"}})
        await sug.build(self.db, self.W)
        self.assertEqual(len(self.sug_calls()), 1)
        # A new heading: a new list.
        await self.db["documents"].update_one({"slug": "open-plan"}, {"$set": {"content": "# Sourcing plan\n\n## Budget\n"}})
        await sug.build(self.db, self.W)
        self.assertEqual(len(self.sug_calls()), 2)
        await sug.build(self.db, self.W, force=True)
        self.assertEqual(len(self.sug_calls()), 3)

    async def test_nothing_to_say_no_call(self):
        row = await sug.build(self.db, self.W)
        self.assertEqual(row["state"], "empty")
        self.assertEqual(row["questions"], [])
        self.assertEqual(self.sug_calls(), [])

    async def test_debounce(self):
        await self.seed()
        now = sug.now_utc()
        self.assertTrue(await sug.due(self.db, self.W, None, now=now))               # never built
        row = await sug.build(self.db, self.W)
        checked = row["checked_at"].replace(tzinfo=now.tzinfo) if row["checked_at"].tzinfo is None else row["checked_at"]
        # Just checked: not due, even after a change (MIN_GAP).
        self.assertFalse(await sug.due(self.db, self.W, row, now=checked + timedelta(minutes=5)))
        # A change after the check, still busy (within DEBOUNCE of it): not yet.
        changed = checked + sug.MIN_GAP + timedelta(minutes=1)
        await self.db["documents"].update_one({"slug": "open-plan"}, {"$set": {"updated_at": changed}})
        self.assertFalse(await sug.due(self.db, self.W, row, now=changed + timedelta(minutes=2)))
        # Quiet for DEBOUNCE: due.
        self.assertTrue(await sug.due(self.db, self.W, row, now=changed + sug.DEBOUNCE + timedelta(seconds=1)))
        # Nothing changed, but a day since the check: due (the window slides).
        await self.db["documents"].update_one({"slug": "open-plan"}, {"$set": {"updated_at": checked - timedelta(hours=1)}})
        await self.db["meetings"].update_many({}, {"$set": {"updated_at": checked - timedelta(hours=1)}})
        self.assertFalse(await sug.due(self.db, self.W, row, now=checked + timedelta(hours=5)))
        self.assertTrue(await sug.due(self.db, self.W, row, now=checked + sug.DAILY))
        # Someone building it now: not due.
        await self.db[sug.COLL].update_one({"_id": self.W}, {"$set": {"building_until": checked + sug.DAILY + timedelta(minutes=1)}})
        row = await self.db[sug.COLL].find_one({"_id": self.W})
        self.assertFalse(await sug.due(self.db, self.W, row, now=checked + sug.DAILY))

    async def test_background_rebuilds_only_recently_viewed(self):
        await self.seed()
        await self.db[sug.COLL].insert_one({"_id": self.W, "questions": [], "viewed_at": sug.now_utc()})
        await self.db[sug.COLL].insert_one({"_id": self.ws["W2"], "questions": [],
                                            "viewed_at": sug.now_utc() - sug.ACTIVE - timedelta(days=1)})
        await sug.background(self.db)
        self.assertEqual(len(self.sug_calls()), 1)
        self.assertTrue((await self.db[sug.COLL].find_one({"_id": self.W}))["questions"])
        self.assertIsNone((await self.db[sug.COLL].find_one({"_id": self.ws["W2"]})).get("checked_at"))


class Limits(SugWorld):
    async def test_switch_and_cap_keep_the_last_list(self):
        await self.seed()
        await sug.build(self.db, self.W)
        settings.ask_suggestions_enabled = False
        ai_usage.invalidate_settings()
        row = await sug.build(self.db, self.W, force=True)
        self.assertEqual(row["state"], "limited")
        self.assertEqual(row["reason"], "off")
        self.assertEqual(len(row["questions"]), 3)                                    # the last list stays
        self.assertEqual(len(self.sug_calls()), 1)
        settings.ask_suggestions_enabled = True
        settings.ask_suggestions_daily_usd = 0.0000001
        ai_usage.invalidate_settings()
        await self.db[ai_usage.SPEND].update_many({}, {"$set": {"usd": 1.0}})
        row = await sug.build(self.db, self.W, force=True)
        self.assertEqual(row["state"], "limited")
        self.assertEqual(row["reason"], "daily")
        self.assertEqual(len(self.sug_calls()), 1)

    async def test_workspace_ai_off_no_team_list(self):
        await self.seed()
        await sug.build(self.db, self.W)
        await self.db["workspaces"].update_one({"_id": ObjectId(self.W)}, {"$set": {"settings.ai_enabled": False}})
        body = (await self.get("wm", self.W)).json()
        self.assertEqual(body["team"], [])
        self.assertTrue(body["ai_off"])
        row = await sug.build(self.db, self.W, force=True)
        self.assertEqual(row["questions"], [])
        self.assertEqual(len(self.sug_calls()), 1)

    async def test_model_failure_keeps_the_last_list(self):
        await self.seed()
        await sug.build(self.db, self.W)
        self.questions = "not a list"
        row = await sug.build(self.db, self.W, force=True)
        self.assertEqual(len(row["questions"]), 3)


class Api(SugWorld):
    async def test_members_get_one_list_and_strangers_404(self):
        await self.seed()
        r = await self.get("wm", self.W)
        self.assertEqual(r.status_code, 200, r.text)
        first = r.json()
        self.assertEqual(first["workspace"], {"id": self.W, "name": "Acme"})
        self.assertTrue(first["refreshing"])                                          # built in the background
        self.assertEqual(first["team"], [])
        for t in list(sug._bg):
            await asyncio.wait({t}, timeout=10)
        a = (await self.get("wm", self.W)).json()
        b = (await self.get("wv", self.W)).json()
        self.assertFalse(a["refreshing"])
        self.assertEqual(a["team"], b["team"])                                        # the same for every member
        self.assertEqual(a["team"][0], {"topic": "Sourcing", "question": "What did we decide about Sourcing this week?",
                                        "label": "Sourcing: What did we decide about Sourcing this week?"})
        self.assertTrue(a["updated_at"])
        self.assertEqual(len(self.sug_calls()), 1)
        # Not a member: 404, nothing named. Signed out: 401. A bad id: 404.
        r = await self.get("stranger", self.W)
        self.assertEqual(r.status_code, 404)
        self.assertNotIn("Sourcing", r.text)
        self.assertEqual((await self.http.get(f"/api/v1/ask/suggestions?workspace={self.W}")).status_code, 401)
        self.assertEqual((await self.get("wm", "nope")).status_code, 404)

    async def test_personal_per_viewer(self):
        await self.seed()
        # Ravi (wv) was in the team's meeting only; Bo (wm) in both, the restricted one last.
        bo = (await self.get("wm", self.W)).json()["personal"]
        ravi = (await self.get("wv", self.W)).json()["personal"]
        self.assertEqual(bo[0]["intent"], "my_actions")
        self.assertTrue(bo[1]["label"].startswith("Catch me up on Secret acquisition sync"), bo)
        self.assertEqual(ravi[0]["intent"], "my_actions")
        self.assertTrue(ravi[1]["label"].startswith("Catch me up on Weekly product sync"), ravi)
        self.assertNotIn("Secret", json.dumps(ravi))
        # Without a workspace: the viewer's own, across their workspaces; no team list.
        mine = (await self.get("wm")).json()
        self.assertIsNone(mine["workspace"])
        self.assertEqual(mine["team"], [])
        self.assertEqual(mine["personal"][1]["label"], bo[1]["label"])


class MyFiles(SugWorld):
    async def test_mine_scope_only_my_unfiled_items(self):
        await self.put("my-note", "Zeppelin notes", "# Zeppelin notes\n\nZeppelin launch plan.", state="UL", owner="wm")
        await self.put("ws-note", "Zeppelin team plan", "# Zeppelin team\n\nZeppelin launch.", owner="wm")
        await self.put("their-note", "Zeppelin of someone else", "# Zeppelin\n\nZeppelin launch.", state="UL", owner="wv")
        await self.index_all()
        self.fake.calls.clear()
        r = await self.http.post("/api/v1/ask", headers=self.session("wm"),
                                 json={"question": "What is the Zeppelin launch plan?", "scope": {"kind": "mine"}})
        self.assertEqual(r.status_code, 200, r.text)
        ev = parse_sse(r.text)
        self.assertEqual(ev[-1][0], "done", ev[-1])
        self.assertEqual(ev[-1][1]["scope"], {"kind": "mine", "label": "My files"})
        p = self.prompts()
        self.assertIn("Zeppelin notes", p)
        self.assertNotIn("Zeppelin team plan", p)
        self.assertNotIn("someone else", p)

    async def test_context_lists_workspaces_and_my_files(self):
        r = await self.http.get(f"/api/v1/ask/context?workspace={self.W}", headers=self.session("wm"))
        c = r.json()
        self.assertIn("mine", [s["kind"] for s in c["scopes"]])
        self.assertEqual(c["workspaces"][0], {"id": self.W, "name": "Acme"})
        self.assertNotIn(self.ws["W2"], [w["id"] for w in c["workspaces"]])


class Pure(unittest.TestCase):
    def test_headings_and_clean(self):
        self.assertEqual(sug.headings_of("# A\n```\n# not\n```\n## B {#b-abcd1234}\n### **C**\n#### D"), ["A", "B", "C"])
        self.assertEqual(sug.clean_questions({"questions": [{"topic": "<b>T</b>", "question": "See [x](http://e) now"}]}),
                         [{"topic": "T", "question": "See x now?"}])
        self.assertEqual(sug.clean_questions("nope"), [])


if __name__ == "__main__":
    unittest.main()
