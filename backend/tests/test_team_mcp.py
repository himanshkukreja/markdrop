"""Team's write tools over MCP (app/mcp/team_tools.py): the same rules as routers/team.py.

Own status and focus note; hide / correct / mark done on the caller's own lines only (someone else's
line is refused, like the 403 on the website); groups and "send this week's summary now" for
workspace admins only; Team memory off refuses everything; a read-only token can't write; and
meetings_connection reports what waits for Gemini's notes and whether Check now is on. The model is
always fake (TeamWorld).
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from unittest import mock

from bson import ObjectId

from tests.test_workspace_memory import TeamWorld, _pin_today
from app.services import team_extras, workspace_memory as wm


class TeamMcp(TeamWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await team_extras.ensure_indexes(self.db)
        _pin_today(self, date(2026, 11, 4))
        await self.turn_on()
        self.m = await self.standup()
        await self.tick()

    async def call(self, who: str, name: str, args: dict, *, write: bool = True) -> dict:
        token = await self.mcp_token(who, write=write)
        status, res = await self.mcp_call(token, name, {"workspace": self.W, **args})
        self.assertEqual(status, 200)
        return res

    def ok(self, res: dict) -> dict:
        self.assertFalse(res.get("isError"), res)
        return res["structuredContent"]

    def refused(self, res: dict, text: str) -> None:
        self.assertTrue(res.get("isError"), res)
        self.assertIn(text, res["content"][0]["text"])

    async def test_status_and_focus_are_the_callers_own(self):
        sc = self.ok(await self.call("wm", "set_my_status", {"status": "On leave till Monday", "emoji": "🌴",
                                                             "until": "2026-11-10T09:00:00+00:00"}))
        self.assertEqual(sc["status"]["text"], "On leave till Monday")
        card = {c["id"]: c for c in (await self.board("wa")).json()["people"]}[self.uid["wm"]]
        self.assertEqual(card["status"]["label"], "On leave till Monday")
        self.refused(await self.call("wm", "set_my_status", {"status": "x", "until": "2020-01-01T00:00:00Z"}),
                     "future")
        self.refused(await self.call("wm", "set_my_status", {"status": "x", "until": "next week"}), "ISO")
        self.ok(await self.call("wm", "set_my_status", {"status": ""}))
        card = {c["id"]: c for c in (await self.board("wa")).json()["people"]}[self.uid["wm"]]
        self.assertNotEqual(card["status"]["label"], "On leave till Monday")

        sc = self.ok(await self.call("wm", "set_focus_note", {"text": "Shipping the sourcing filters"}))
        self.assertEqual(sc["focus"]["text"], "Shipping the sourcing filters")
        prof = self.ok(await self.call("wa", "get_person_profile", {"person": "Bo"}, write=False))
        self.assertEqual(prof["focus"], "Shipping the sourcing filters")
        self.assertFalse(prof["you"])
        # A read-only token can't write.
        token = await self.mcp_token("wm", write=False)
        status, _res = await self.mcp_call(token, "set_focus_note", {"workspace": self.W, "text": "nope"})
        self.assertEqual(status, 403)
        row = await self.db[wm.PROFILES].find_one({"_id": f"{self.W}:{self.uid['wm']}"})
        self.assertEqual(row["focus"]["text"], "Shipping the sourcing filters")

    async def test_own_lines_only_hide_correct_done(self):
        mine = self.ok(await self.call("wm", "get_person_profile", {"person": "me"}, write=False))
        self.assertTrue(mine["you"])
        working = mine["working_on"][0]
        self.assertTrue(working["id"] and working["can_correct"])
        target = mine["targets"][0]
        # Someone else's line: refused, like the 403 on the website (an admin too).
        self.refused(await self.call("wa", "hide_team_line", {"line_id": working["id"]}), "Only the person")
        self.refused(await self.call("wa", "mark_team_item_done", {"line_id": target["id"]}), "Only the person")
        self.refused(await self.call("wa", "correct_team_line", {"line_id": working["id"], "text": "x"}), "Only the person")
        self.refused(await self.call("wm", "hide_team_line", {"line_id": str(ObjectId())}), "isn't there")
        # Hide, then undo.
        self.ok(await self.call("wm", "hide_team_line", {"line_id": working["id"]}))
        seen = self.ok(await self.call("wa", "get_person_profile", {"person": "Bo"}, write=False))
        self.assertEqual(seen["working_on"], [])
        mine = self.ok(await self.call("wm", "get_person_profile", {"person": "me"}, write=False))
        self.assertEqual([h["text"] for h in mine["hidden"]], ["Building the sourcing filters"])
        self.ok(await self.call("wm", "hide_team_line", {"line_id": mine["hidden"][0]["id"], "hidden": False}))
        self.assertEqual(len(self.ok(await self.call("wa", "get_person_profile", {"person": "Bo"}, write=False))["working_on"]), 1)
        # Correct with the right version, then clear it.
        up = mine["updates"][0]
        self.ok(await self.call("wm", "correct_team_line", {"line_id": up["id"], "text": "Finished the Lever import"}))
        seen = self.ok(await self.call("wa", "get_person_profile", {"person": "Bo"}, write=False))
        self.assertEqual(seen["updates"][0]["text"], "Finished the Lever import")
        self.assertTrue(seen["updates"][0]["corrected"])
        self.ok(await self.call("wm", "correct_team_line", {"line_id": up["id"], "clear": True}))
        seen = self.ok(await self.call("wa", "get_person_profile", {"person": "Bo"}, write=False))
        self.assertFalse(seen["updates"][0]["corrected"])
        # Mark done: only action items and targets; it leaves the open items; undo brings it back.
        self.refused(await self.call("wm", "mark_team_item_done", {"line_id": working["id"]}), "Only action items")
        self.ok(await self.call("wm", "mark_team_item_done", {"line_id": target["id"]}))
        self.assertEqual(self.ok(await self.call("wa", "get_person_profile", {"person": "Bo"}, write=False))["targets"], [])
        self.ok(await self.call("wm", "mark_team_item_done", {"line_id": target["id"], "done": False}))
        self.assertEqual(len(self.ok(await self.call("wa", "get_person_profile", {"person": "Bo"}, write=False))["targets"]), 1)

    async def test_groups_admins_only(self):
        self.refused(await self.call("wm", "save_team_group", {"name": "Sourcing", "members": ["Bo"]}), "admins")
        await self.standup(date="2026-11-04", title="Sourcing standup 2")
        await self.db["meetings"].update_many({}, {"$set": {"series": "Sourcing standup"}})
        got = self.ok(await self.call("wm", "list_team_groups", {}, write=False))
        self.assertEqual((got["groups"], got["suggestions"], got["can_manage"]), ([], [], False))
        got = self.ok(await self.call("wa", "list_team_groups", {}, write=False))
        self.assertEqual(got["suggestions"][0]["name"], "Sourcing standup")
        g = self.ok(await self.call("wa", "save_team_group", {"name": "Sourcing team", "members": ["Bo", self.email["wa"]]}))
        self.assertTrue(g["created"])
        self.assertEqual(sorted(g["members"]), ["Bo Chen", "Priya Sharma"])
        self.refused(await self.call("wa", "save_team_group", {"name": "x", "members": ["Nobody Here"]}), "No member")
        self.refused(await self.call("wa", "save_team_group", {"name": "sourcing TEAM"}), "already exists")
        g2 = self.ok(await self.call("wa", "save_team_group", {"group_id": g["id"], "name": "Sourcing crew"}))
        self.assertEqual((g2["name"], sorted(g2["members"]), g2["created"]), ("Sourcing crew", ["Bo Chen", "Priya Sharma"], False))
        board = (await self.board("wv")).json()
        self.assertEqual([x["name"] for x in board["groups"]], ["Sourcing crew"])
        self.refused(await self.call("wm", "delete_team_group", {"group_id": g["id"]}), "admins")
        self.ok(await self.call("wa", "delete_team_group", {"group_id": g["id"]}))
        self.refused(await self.call("wa", "delete_team_group", {"group_id": g["id"]}), "not found")

    async def test_weekly_summary_now_admins_only(self):
        from app.services import mailer, slack

        self.refused(await self.call("wm", "send_weekly_summary_now", {}), "admins")
        sent = []

        async def fake_post(payload, *, kind, ref=None):
            sent.append(payload["to"][0])
            return "sent"

        with mock.patch.object(mailer, "_post", fake_post), mock.patch.object(mailer, "is_configured", lambda: True), \
                mock.patch.object(slack, "install_for_workspace", mock.AsyncMock(return_value=None)):
            sc = self.ok(await self.call("wa", "send_weekly_summary_now", {}))
        self.assertEqual(sc["week"], "2026-W45")
        self.assertGreater(sc["highlights"] + sc["due"], 0)
        self.assertIsNone(sc["slack"])
        self.assertEqual(sc["emails"], len(sent))
        self.assertIn(self.email["wa"], sent)
        self.assertTrue(await self.db[team_extras.WEEKLY].find_one({"_id": f"{self.W}:2026-W45"}))

    async def test_off_refuses_everything(self):
        await self.turn_on(on=False)
        for who, name, args in (("wm", "set_my_status", {"status": "x"}), ("wm", "set_focus_note", {"text": "x"}),
                                ("wm", "hide_team_line", {"line_id": str(ObjectId())}),
                                ("wa", "list_team_groups", {}), ("wa", "send_weekly_summary_now", {})):
            self.refused(await self.call(who, name, args), "Team memory is off")
        # Someone outside the workspace: not theirs.
        self.refused(await self.call("stranger", "set_my_status", {"status": "x"}), "")


class MeetingsConnectionWaiting(TeamWorld):
    async def test_waiting_and_check_now(self):
        from app.services import meetings_inbox

        now = datetime(2026, 11, 4, 9, tzinfo=timezone.utc)
        await self.db["api_tokens"].insert_one({
            "scope": meetings_inbox.SCOPE, "workspace_id": self.W, "user_id": self.uid["wm"], "created_at": now,
            "token_hash": "x" * 64, "stats": {"imported": 2, "not_ready": 3, "last_imported_at": now},
            "script": {"version": 4, "ran_at": now, "found": 5, "sent": 4, "results": {"imported": 2, "not_ready": 1},
                       "skipped": {"not_ready": 1, "already_sent": 1}},
            "check_now": {"url": "https://script.google.com/macros/s/x/exec", "last_at": now}})
        token = await self.mcp_token("wa", write=False)
        _s, res = await self.mcp_call(token, "meetings_connection", {"workspace": self.W})
        self.assertFalse(res.get("isError"), res)
        c = res["structuredContent"]["connections"][0]
        self.assertEqual((c["waiting"], c["not_ready"], c["script_version"]), (2, 3, 4))
        self.assertTrue(c["check_now"]["ready"])
        self.assertNotIn("script.google.com", str(res))                # never the script's address
        text = res["content"][0]["text"]
        self.assertIn("2 meeting(s) waiting for Gemini's notes", text)
        self.assertIn("Check now: on", text)
