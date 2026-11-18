"""MCP tools that close gaps with the website (.work/mcp-gaps/AUDIT.md): the same rules as the REST routes.

Workspaces (routers/workspaces.py): get_workspace (settings, counts, integrations), update_workspace (admins,
only what is sent), invite_to_workspace (admins; admins only by the owner), update_workspace_member (role,
remove, leave, withdraw an invitation), list_workspace_members include_invitations (admins).
Access (routers/access.py): get_document_access (holders only; the people list for owner/editors),
share_with_people remove (owner anyone, others only themselves). list_documents scope shared; bulk
move_to_folder (all-or-nothing). Teams: update_team leads, update_project, delete_team. Meetings:
update_meeting, delete_meeting.
"""

from __future__ import annotations

from unittest import mock

from bson import ObjectId

from tests._access_env import AccessWorld
from tests.test_teams import TeamsWorld
from app.services import mailer


class _Calls:
    async def call(self, who: str, name: str, args: dict, *, write: bool = True) -> dict:
        status, res = await self.mcp_call(await self.mcp_token(who, write=write), name, args)
        self.assertEqual(status, 200)
        return res

    def ok(self, res: dict) -> dict:
        self.assertFalse(res.get("isError"), res)
        return res["structuredContent"]

    def refused(self, res: dict, text: str) -> None:
        self.assertTrue(res.get("isError"), res)
        self.assertIn(text, res["content"][0]["text"])


class WorkspaceAdmin(_Calls, AccessWorld):
    async def test_get_workspace(self):
        W = self.ws["W1"]
        sc = self.ok(await self.call("wm", "get_workspace", {"workspace": W}, write=False))
        self.assertEqual((sc["your_role"], sc["name"]), ("member", "Acme"))
        self.assertIsNone(sc["counts"]["pending_invitations"])  # members don't see invitations
        self.assertEqual(set(sc["integrations"]), {"slack", "jira", "zoom", "hubspot", "google_meet"})
        self.assertFalse(sc["integrations"]["zoom"]["connected"])
        self.assertIn("default_access", sc["settings"])
        self.assertTrue(sc["domains"])
        sc = self.ok(await self.call("wa", "get_workspace", {"workspace": W}, write=False))
        self.assertEqual(sc["counts"]["pending_invitations"], 1)
        self.refused(await self.call("stranger", "get_workspace", {"workspace": W}, write=False), "isn't in any")

    async def test_update_workspace_admins_only_and_partial(self):
        W = self.ws["W1"]
        before = await self.db["workspaces"].find_one({"_id": ObjectId(W)})
        self.refused(await self.call("wm", "update_workspace", {"workspace": W, "default_access": "private"}),
                     "admins and owner")
        self.refused(await self.call("wa", "update_workspace", {"workspace": W}), "Nothing to change")
        self.refused(await self.call("wa", "update_workspace", {"workspace": W, "timezone": "Mars/Base"}), "Invalid")
        sc = self.ok(await self.call("wa", "update_workspace", {"workspace": W, "default_access": "private",
                                                               "timezone": "Asia/Kolkata"}))
        self.assertEqual(sc["settings"]["default_access"], "private")
        row = await self.db["workspaces"].find_one({"_id": ObjectId(W)})
        self.assertEqual((row["settings"]["default_access"], row["settings"]["timezone"]), ("private", "Asia/Kolkata"))
        # Nothing else changed (C3: a partial update never resets the rest).
        self.assertEqual(row["settings"].get("require_auth_to_view"), before["settings"].get("require_auth_to_view"))
        self.assertEqual(row["name"], "Acme")
        status, _ = await self.mcp_call(await self.mcp_token("wa", write=False), "update_workspace",
                                        {"workspace": W, "ai_enabled": False})
        self.assertEqual(status, 403)

    async def test_invitations(self):
        W = self.ws["W1"]
        send = mock.AsyncMock()
        with mock.patch.object(mailer, "is_configured", lambda: True), mock.patch.object(mailer, "send_invite_email", send):
            self.refused(await self.call("wm", "invite_to_workspace", {"workspace": W, "emails": ["n@example.com"]}),
                         "admins and owner")
            self.refused(await self.call("wa", "invite_to_workspace", {"workspace": W, "emails": ["n@example.com"],
                                                                       "role": "admin"}), "owner")
            sc = self.ok(await self.call("wa", "invite_to_workspace", {"workspace": W,
                                                                       "emails": ["N@example.com", self.email["wm"]]}))
            got = {p["email"]: p for p in sc["people"]}
            self.assertTrue(got["n@example.com"]["invited"])
            self.assertFalse(got[self.email["wm"]]["invited"])
            self.assertIn("already", got[self.email["wm"]]["error"])
            self.assertEqual(send.await_count, 1)
            sc = self.ok(await self.call("wo", "invite_to_workspace", {"workspace": W, "emails": ["boss@example.com"],
                                                                       "role": "admin"}))
            self.assertTrue(sc["people"][0]["invited"])
        self.refused(await self.call("wm", "list_workspace_members", {"workspace": W, "include_invitations": True},
                                     write=False), "admins and owner")
        sc = self.ok(await self.call("wa", "list_workspace_members", {"workspace": W, "include_invitations": True},
                                     write=False))
        self.assertEqual({i["email"] for i in sc["invitations"]},
                         {self.email["invitee"], "n@example.com", "boss@example.com"})
        sc = self.ok(await self.call("wa", "list_workspace_members", {"workspace": W}, write=False))
        self.assertNotIn("invitations", sc)
        # Withdraw: an admin's invitation only by the owner; a member's by an admin.
        self.refused(await self.call("wa", "update_workspace_member", {"workspace": W, "person": "boss@example.com",
                                                                       "remove": True}), "owner")
        sc = self.ok(await self.call("wa", "update_workspace_member", {"workspace": W, "person": "n@example.com",
                                                                       "remove": True}))
        self.assertTrue(sc["invitation_withdrawn"])
        self.assertIsNone(await self.db["invitations"].find_one({"email": "n@example.com", "status": "pending"}))

    async def test_member_role_remove_and_leave(self):
        W = self.ws["W1"]

        async def role(who):
            m = await self.db["memberships"].find_one({"workspace_id": W, "user_id": self.uid[who]})
            return m and m["role"]

        self.refused(await self.call("wm", "update_workspace_member", {"workspace": W, "person": self.email["wv"],
                                                                       "role": "member"}), "admins and owner")
        self.refused(await self.call("wa", "update_workspace_member", {"workspace": W, "person": self.email["wv"]}),
                     "either role")
        sc = self.ok(await self.call("wa", "update_workspace_member", {"workspace": W, "person": self.uid["wv"],
                                                                       "role": "member"}))
        self.assertEqual(sc["role"], "member")
        self.assertEqual(await role("wv"), "member")
        # Only the owner touches an admin, and nobody changes the owner.
        self.refused(await self.call("wa", "update_workspace_member", {"workspace": W, "person": "WM", "role": "admin"}),
                     "owner")
        self.refused(await self.call("wa", "update_workspace_member", {"workspace": W, "person": self.email["wo"],
                                                                       "role": "member"}), "owner")
        self.ok(await self.call("wa", "update_workspace_member", {"workspace": W, "person": self.email["wv"],
                                                                  "remove": True}))
        self.assertIsNone(await role("wv"))
        # Anyone may leave.
        self.ok(await self.call("wm", "update_workspace_member", {"workspace": W, "person": "me", "remove": True}))
        self.assertIsNone(await role("wm"))
        self.refused(await self.call("wa", "update_workspace_member", {"workspace": W, "person": "nobody@x.test",
                                                                       "remove": True}), "No member")

    async def test_document_access_and_unshare(self):
        d = await self.mkdoc("W", owner="owner")  # grants: gv viewer, ge editor
        sc = self.ok(await self.call("owner", "get_document_access", {"document": d["slug"]}, write=False))
        self.assertEqual((sc["level"], sc["your_role"]), ("workspace", "owner"))
        self.assertEqual({p["email"]: p["role"] for p in sc["people"]}, {self.email["gv"]: "viewer", self.email["ge"]: "editor"})
        self.assertTrue(sc["can_change_access"])
        self.assertEqual(sc["owner"]["email"], self.email["owner"])
        # A viewer (by grant) sees their role, not the list nor the owner's address.
        sc = self.ok(await self.call("gv", "get_document_access", {"document": d["slug"]}, write=False))
        self.assertIsNone(sc["people"])
        self.assertIsNone(sc["owner"]["email"])
        # A link reader with no role learns nothing more.
        link = await self.mkdoc("L", owner="owner")
        self.refused(await self.call("stranger", "get_document_access", {"document": link["slug"]}, write=False),
                     "no role")
        # Remove: the owner anyone; others only themselves.
        sc = self.ok(await self.call("wm", "share_with_people", {"document": d["slug"], "emails": [self.email["gv"]],
                                                                  "remove": True}))
        self.assertFalse(sc["people"][0]["removed"])
        self.assertIn("owner", sc["people"][0]["error"])
        sc = self.ok(await self.call("owner", "share_with_people", {"document": d["slug"], "emails": [self.email["gv"]],
                                                                     "remove": True}))
        self.assertTrue(sc["people"][0]["removed"])
        sc = self.ok(await self.call("ge", "share_with_people", {"document": d["slug"], "emails": [self.email["ge"]],
                                                                  "remove": True}))
        self.assertTrue(sc["people"][0]["removed"])
        self.assertEqual(await self.db["document_grants"].count_documents({"document_id": str(d["_id"])}), 0)
        self.refused(await self.call("owner", "share_with_people", {"folder": "x", "workspace": self.ws["W1"],
                                                                     "emails": [self.email["gv"]], "remove": True}),
                     "set_folder_access")

    async def test_list_documents_shared(self):
        mine = await self.mkdoc("UP", owner="gv", grants=False)
        shared = await self.mkdoc("UP", owner="owner")  # granted to gv
        sc = self.ok(await self.call("gv", "list_documents", {"scope": "shared"}, write=False))
        slugs = {i["slug"] for i in sc["items"]}
        self.assertIn(shared["slug"], slugs)
        self.assertNotIn(mine["slug"], slugs)
        sc = self.ok(await self.call("owner", "list_documents", {"scope": "shared"}, write=False))
        self.assertNotIn(shared["slug"], {i["slug"] for i in sc["items"]})

    async def test_bulk_move_all_or_nothing(self):
        W = self.ws["W1"]
        r = await self.http.post(f"/api/v1/workspaces/{W}/folders", json={"name": "Archive"}, headers=self.session("wa"))
        self.assertEqual(r.status_code, 201, r.text)
        fid = r.json()["id"]
        a, b = await self.mkdoc("W", owner="wm", grants=False), await self.mkdoc("W", owner="wm", grants=False)
        other = await self.mkdoc("W", owner="wm2", ws="W2", grants=False)
        self.refused(await self.call("wm", "move_to_folder", {"documents": [a["slug"], other["slug"]], "folder": "Archive"}),
                     "Nothing was moved")
        self.assertIsNone((await self.doc(a["slug"]))["folder_id"])
        sc = self.ok(await self.call("wm", "move_to_folder", {"documents": [a["slug"], b["slug"]], "folder": "Archive"}))
        self.assertEqual((sc["moved"], sc["folder"]), (2, "archive"))
        for d in (a, b):
            self.assertEqual((await self.doc(d["slug"]))["folder_id"], fid)
        self.refused(await self.call("wm", "move_to_folder", {"folder": "Archive"}), "Give document")
        # One item still works as before.
        sc = self.ok(await self.call("wm", "move_to_folder", {"document": a["slug"]}))
        self.assertIsNone(sc["folder"])


class TeamsAndMeetings(_Calls, TeamsWorld):
    async def test_team_leads(self):
        self.refused(await self.call("wm", "update_team", {"workspace": self.W, "team": "Eng", "leads": [self.uid["wm"]]}),
                     "admins")
        self.refused(await self.call("wa", "update_team", {"workspace": self.W, "team": "Eng"}), "Nothing to change")
        self.ok(await self.call("wa", "update_team", {"workspace": self.W, "team": "Eng", "leads": [self.email["wm"]]}))
        row = await self.db["teams"].find_one({"_id": ObjectId(self.eng)})
        self.assertEqual(row["lead_ids"], [self.uid["wm"]])
        self.assertIn(self.uid["wm"], row["member_ids"])

    async def test_projects_and_delete(self):
        p = self.ok(await self.call("wa", "create_project", {"workspace": self.W, "name": "Q4 launch", "teams": ["Eng"]}))["project"]
        self.refused(await self.call("wm", "update_project", {"workspace": self.W, "project": p["id"], "status": "archived"}),
                     "Only")
        sc = self.ok(await self.call("wa", "update_project", {"workspace": self.W, "project": p["id"], "status": "archived",
                                                              "name": "Q4 launch (done)"}))
        self.assertEqual((sc["project"]["status"], sc["project"]["name"]), ("archived", "Q4 launch (done)"))
        self.refused(await self.call("wm", "delete_team", {"workspace": self.W, "project": p["id"]}), "admins")
        self.refused(await self.call("wa", "delete_team", {"workspace": self.W}), "team or project")
        self.ok(await self.call("wa", "delete_team", {"workspace": self.W, "project": p["id"]}))
        self.assertIsNone(await self.db["team_projects"].find_one({"_id": ObjectId(p["id"])}))
        from app.services import teams as T

        await T.ensure_general(self.db, self.W)
        self.refused(await self.call("wa", "delete_team", {"workspace": self.W, "team": "General"}), "default team")
        self.refused(await self.call("wm", "delete_team", {"workspace": self.W, "team": "Eng"}), "admins")
        self.ok(await self.call("wa", "delete_team", {"workspace": self.W, "team": "Eng"}))
        self.assertIsNone(await self.db["teams"].find_one({"_id": ObjectId(self.eng)}))
        # Its items stay (company-wide now).
        self.assertIsNotNone(await self.db["documents"].find_one({"_id": self.e_w["_id"]}))

    async def test_update_and_delete_meeting(self):
        m = await self.standup()
        mid = m["id"]
        self.refused(await self.call("owner", "update_meeting", {"meeting": mid}), "Nothing to change")
        sc = self.ok(await self.call("owner", "update_meeting", {"meeting": mid, "type": "Planning", "series": "Weekly sync"}))
        self.assertEqual((sc["type"], sc["series"]), ("Planning", "Weekly sync"))
        row = await self.db["meetings"].find_one({"_id": ObjectId(mid)})
        self.assertEqual((row["type"], row["series"]), ("Planning", "Weekly sync"))
        sc = self.ok(await self.call("owner", "update_meeting", {"meeting": mid, "restricted": True}))
        self.assertTrue(sc["restricted"])
        self.refused(await self.call("owner", "update_meeting", {"meeting": mid, "remove_recording": True}), "no recording")
        with mock.patch("app.mcp.meeting_tools.meetings_ai.generate", mock.AsyncMock()) as gen:
            sc = self.ok(await self.call("owner", "update_meeting", {"meeting": mid, "regenerate": True}))
        gen.assert_awaited_once()
        self.assertIn("summary and details written again", sc["changed"])
        # A member who isn't the importer nor an admin can't delete it (restricted: they can't even see it).
        self.refused(await self.call("wv", "delete_meeting", {"meeting": mid}), "not found")
        sc = self.ok(await self.call("owner", "delete_meeting", {"meeting": mid}))
        self.assertTrue(sc["deleted"] and sc["trashed"])
        self.assertIsNone(await self.db["meetings"].find_one({"_id": ObjectId(mid)}))
        self.refused(await self.call("owner", "get_meeting", {"meeting": mid}, write=False), "not found")
