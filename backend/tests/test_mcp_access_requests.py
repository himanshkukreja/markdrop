"""The access-request MCP tools (app/mcp/access_request_tools.py): request_edit_access,
list_access_requests and decide_access_request over services/access_requests.py — the same
rules, emails and grants as the web routes (tests/test_tenant_edit.py RequestEditAccess,
tests/test_simpler_ui.py RequestAccess).

The access-policy world (tests/_access_env.py): the test MongoDB (or mongomock) and a fake R2,
never backend/.env. Email is never sent: ``mailer._post`` records each payload.
"""

from __future__ import annotations

from tests._access_env import now  # noqa: F401  (pins settings first)

from bson import ObjectId

from app.mcp import protocol
from app.mcp import tools as mcp_tools
from tests.test_tenant_edit import TenantWorld


class McpAccessRequests(TenantWorld):
    async def call(self, who: str, name: str, args: dict, *, write: bool = True) -> dict:
        status, res = await self.mcp_call(await self.mcp_token(who, write=write), name, args)
        self.assertEqual(status, 200, name)
        return res

    async def ok(self, who: str, name: str, args: dict, *, write: bool = True) -> dict:
        res = await self.call(who, name, args, write=write)
        self.assertFalse(res["isError"], res["content"][0]["text"])
        return res["structuredContent"]

    async def refused(self, who: str, name: str, args: dict) -> str:
        res = await self.call(who, name, args)
        self.assertTrue(res["isError"], (who, name, args))
        return res["content"][0]["text"]

    async def ask(self, who: str, doc: dict, **args) -> dict:
        return await self.ok(who, "request_edit_access", {"document": doc["slug"], **args})

    async def incoming(self, who: str, **args) -> list[dict]:
        return (await self.ok(who, "list_access_requests", args, write=False))["requests"]

    async def outgoing(self, who: str, **args) -> list[dict]:
        return (await self.ok(who, "list_access_requests", {"direction": "outgoing", **args},
                              write=False))["requests"]

    # ── request_edit_access ──

    async def test_catalogue(self):
        by = {t.name: t for t in mcp_tools.TOOLS}
        self.assertEqual(len(mcp_tools.TOOLS), 104)  # + jira (5), ask_suggestions, rename_folder, move_folder, delete_folder, import_meetings_bulk, organize_meetings, meeting_context, slack_status, post_meeting_to_slack, team (12), check_meetings_now
        self.assertEqual((by["request_edit_access"].scope, by["request_edit_access"].writes), ("documents:write", True))
        self.assertEqual((by["list_access_requests"].scope, by["list_access_requests"].writes), ("documents:read", False))
        self.assertEqual((by["decide_access_request"].scope, by["decide_access_request"].writes),
                         ("documents:write", True))
        self.assertIn("request_edit_access", protocol.INSTRUCTIONS)

    async def test_request_happy_path_with_a_message(self):
        out = await self.ask("gv", self.W, message="Typo in step 3")
        self.assertEqual((out["slug"], out["status"], out["sent_to"]), (self.W["slug"], "pending", "owner"))
        self.assertEqual(out["title"], self.W["title"])
        row = await self.db["access_requests"].find_one({"_id": ObjectId(out["request_id"])})
        self.assertEqual((row["role_requested"], row["requester_user_id"], row["message"], row["owner_id"]),
                         ("editor", self.uid["gv"], "Typo in step 3", self.uid["owner"]))
        # The owner's Approve / Decline email, exactly as from the page's ⋯ menu.
        self.assertEqual([m["to"] for m in self.mail], [["owner@example.com"]])
        self.assertIn("asked to edit", self.mail[0]["subject"])
        self.assertIn(f"/requests/{out['request_id']}?action=edit", self.mail[0]["html"])
        self.assertIn("Typo in step 3", self.mail[0]["html"])
        # Recorded in mcp_events: the document it acted on, never the message.
        ev = await self.db["mcp_events"].find_one({"tool": "request_edit_access", "ok": True})
        self.assertEqual(ev["target"], {"slug": self.W["slug"], "doc_id": str(self.W["_id"])})
        self.assertEqual(ev["result"]["request_id"], out["request_id"])
        self.assertNotIn("Typo", str(ev))

    async def test_a_link_works_and_a_link_page_reader_may_ask(self):
        out = await self.ask("stranger", self.L | {"slug": f"https://markdrop.in/{self.L['slug']}"})
        self.assertEqual((out["slug"], out["sent_to"]), (self.L["slug"], "owner"))

    async def test_who_may_not_ask(self):
        self.assertEqual(await self.refused("wm", "request_edit_access", {"document": self.W["slug"]}),
                         "You can already edit this.")
        self.assertEqual(await self.refused("owner", "request_edit_access", {"document": self.W["slug"]}),
                         "You can already edit this.")
        # Can't read it: the tools' usual not-found (never learns it exists).
        self.assertEqual(await self.refused("stranger", "request_edit_access", {"document": self.W["slug"]}),
                         mcp_tools.NOT_FOUND)
        P = await self.mkdoc("P")
        self.assertEqual(await self.refused("wv", "request_edit_access", {"document": P["slug"]}),
                         mcp_tools.NOT_FOUND)
        self.assertEqual(await self.refused("gv", "request_edit_access", {"document": "no-such-doc"}),
                         mcp_tools.NOT_FOUND)
        LP = await self.mkdoc("LP")
        self.assertEqual(await self.refused("stranger", "request_edit_access", {"document": LP["slug"]}),
                         mcp_tools.PASSWORD_GATED)
        self.assertEqual(await self.db["access_requests"].count_documents({}), 0)
        self.assertEqual(self.mail, [])

    async def test_duplicate_and_declined_cooldown(self):
        out = await self.ask("gv", self.W)
        self.assertEqual(await self.refused("gv", "request_edit_access", {"document": self.W["slug"]}),
                         "You've already asked. You'll get an email when they decide.")
        await self.ok("owner", "decide_access_request", {"request": out["request_id"], "decision": "decline"})
        self.assertEqual(await self.refused("gv", "request_edit_access", {"document": self.W["slug"]}),
                         "They declined your last request. You can ask again tomorrow.")
        # The refusal's fixed sentence is kept in the audit.
        ev = await self.db["mcp_events"].find_one({"tool": "request_edit_access", "ok": False})
        self.assertIn("already asked", ev["result"]["error"])

    async def test_read_only_tokens_cant_write(self):
        status, _ = await self.mcp_call(await self.mcp_token("gv", write=False), "request_edit_access",
                                        {"document": self.W["slug"]})
        self.assertEqual(status, 403)
        rid = (await self.ask("gv", self.W))["request_id"]
        status, _ = await self.mcp_call(await self.mcp_token("owner", write=False), "decide_access_request",
                                        {"request": rid, "decision": "approve"})
        self.assertEqual(status, 403)
        self.assertEqual((await self.db["access_requests"].find_one({}))["status"], "pending")
        # Listing is a read: a read-only token sees what its user decides on.
        self.assertEqual([r["id"] for r in await self.incoming("owner")], [rid])

    # ── list_access_requests ──

    async def test_incoming_and_outgoing(self):
        rid = (await self.ask("gv", self.W, message="please"))["request_id"]
        inc = await self.incoming("owner")
        self.assertEqual(len(inc), 1)
        r = inc[0]
        self.assertEqual((r["id"], r["status"], r["role_requested"], r["message"], r["as_admin"]),
                         (rid, "pending", "editor", "please", False))
        self.assertEqual(r["requester"]["email"], "gv@example.com")
        self.assertEqual((r["document"]["slug"], r["document"]["title"], r["document"]["available"]),
                         (self.W["slug"], self.W["title"], True))
        self.assertTrue(r["document"]["url"].endswith(self.W["slug"]))
        self.assertTrue(r["created_at"].endswith("Z"))
        out = await self.ok("owner", "list_access_requests", {}, write=False)
        self.assertEqual((out["direction"], out["status"], out["pending_count"]), ("incoming", "pending", 1))
        # The requester's own list; nobody else sees it.
        mine = await self.outgoing("gv")
        self.assertEqual([(x["id"], x["status"], x["document"]["title"]) for x in mine],
                         [(rid, "pending", self.W["title"])])
        self.assertEqual(await self.outgoing("owner"), [])
        self.assertEqual(await self.incoming("gv"), [])
        for who in ("wa", "wo", "wm", "ge", "stranger"):  # the owner is reachable: admins don't see it
            self.assertEqual(await self.incoming(who, status="all"), [], who)
        # Status filters.
        self.assertEqual(await self.incoming("owner", status="approved"), [])
        await self.ok("owner", "decide_access_request", {"request": rid, "decision": "approve"})
        self.assertEqual(await self.incoming("owner"), [])
        self.assertEqual([x["status"] for x in await self.incoming("owner", status="approved")], ["approved"])
        self.assertEqual([x["role_granted"] for x in await self.outgoing("gv", status="all")], ["editor"])

    async def test_outgoing_hides_what_they_still_cant_open(self):
        P = await self.mkdoc("P", ws=None)
        r = await self.http.post(f"/api/v1/documents/{P['slug']}/access-requests", json={"message": "hi"},
                                 headers=self.session("stranger"))
        self.assertEqual(r.status_code, 201, r.text)
        x = (await self.outgoing("stranger"))[0]
        self.assertEqual((x["role_requested"], x["document"]["slug"], x["document"]["title"], x["document"]["url"],
                          x["document"]["available"]), ("viewer", P["slug"], None, None, False))
        # The owner sees it (a request to open), with the asker's address.
        inc = await self.incoming("owner")
        self.assertEqual((inc[0]["role_requested"], inc[0]["requester"]["email"], inc[0]["document"]["title"]),
                         ("viewer", "stranger@example.com", P["title"]))
        # Approved: now they can open it, so it shows.
        await self.ok("owner", "decide_access_request", {"request": r.json()["id"], "decision": "approve"})
        x = (await self.outgoing("stranger", status="all"))[0]
        self.assertEqual((x["status"], x["role_granted"], x["document"]["title"], x["document"]["available"]),
                         ("approved", "viewer", P["title"], True))

    async def test_encrypted_titles_stay_hidden(self):
        E = await self.mkdoc("L", encrypted=True)
        await self.ask("gv", E)
        self.assertIsNone((await self.incoming("owner"))[0]["document"]["title"])
        self.assertIsNone((await self.outgoing("gv"))[0]["document"]["title"])

    # ── decide_access_request ──

    async def test_owner_approves_and_the_requester_can_edit(self):
        rid = (await self.ask("gv", self.W))["request_id"]
        self.assertEqual((await self.put(self.W["slug"], self.session("gv"))).status_code, 403)
        self.mail.clear()
        out = await self.ok("owner", "decide_access_request", {"request": rid, "decision": "approve"})
        self.assertEqual((out["id"], out["status"], out["role_granted"], out["slug"]),
                         (rid, "approved", "editor", self.W["slug"]))
        self.assertEqual(out["requester"]["email"], "gv@example.com")
        self.assertEqual([m["to"] for m in self.mail], [["gv@example.com"]])
        self.assertIn("You can edit", self.mail[0]["subject"])
        self.assertEqual((await self.put(self.W["slug"], self.session("gv"))).status_code, 200)
        g = await self.db["document_grants"].find_one({"document_id": str(self.W["_id"]), "email": "gv@example.com"})
        self.assertEqual((g["role"], g["sub_role"], g["granted_by_user_id"]), ("editor", "viewer", self.uid["owner"]))
        # Idempotent; the other way is refused.
        out = await self.ok("owner", "decide_access_request", {"request": rid, "decision": "approve"})
        self.assertEqual(out["status"], "approved")
        self.assertEqual(await self.refused("owner", "decide_access_request", {"request": rid, "decision": "decline"}),
                         "This request was already approved.")
        ev = await self.db["mcp_events"].find_one({"tool": "decide_access_request", "ok": True})
        self.assertEqual(ev["target"]["doc_id"], str(self.W["_id"]))
        self.assertEqual((ev["result"]["status"], ev["result"]["role_granted"]), ("approved", "editor"))

    async def test_decline(self):
        rid = (await self.ask("gv", self.W))["request_id"]
        self.mail.clear()
        out = await self.ok("owner", "decide_access_request", {"request": rid, "decision": "decline"})
        self.assertEqual((out["status"], out["role_granted"]), ("declined", None))
        self.assertIn("request to edit", self.mail[0]["subject"])
        self.assertEqual((await self.put(self.W["slug"], self.session("gv"))).status_code, 403)
        self.assertEqual([x["status"] for x in await self.outgoing("gv", status="declined")], ["declined"])
        self.assertIn("role only goes with",
                      await self.refused("owner", "decide_access_request",
                                         {"request": rid, "decision": "decline", "role": "editor"}))

    async def test_only_who_decides_on_the_web(self):
        rid = (await self.ask("gv", self.W))["request_id"]
        for who in ("wa", "wo", "wm", "ge", "gv", "stranger"):
            self.assertIn("couldn't find that access request",
                          await self.refused(who, "decide_access_request", {"request": rid, "decision": "approve"}),
                          who)
        for bad in (str(ObjectId()), "not-an-id"):
            self.assertIn("couldn't find that access request",
                          await self.refused("owner", "decide_access_request", {"request": bad, "decision": "approve"}))
        # An edit request is approved as editor only.
        self.assertEqual(await self.refused("owner", "decide_access_request",
                                            {"request": rid, "decision": "approve", "role": "viewer"}),
                         "They can already view it. Let them edit, or decline.")
        self.assertEqual((await self.db["access_requests"].find_one({}))["status"], "pending")

    async def test_no_reachable_owner_an_admin_decides(self):
        await self.remove_member("W1", "owner")
        out = await self.ask("gv", self.W, message="please")
        self.assertEqual(out["sent_to"], "admins")
        rid = out["request_id"]
        self.assertEqual(sorted(m["to"][0] for m in self.mail), ["wa@example.com", "wo@example.com"])
        inc = await self.incoming("wa")
        self.assertEqual(([x["id"] for x in inc], inc[0]["as_admin"]), ([rid], True))
        self.assertEqual(await self.incoming("wm"), [])
        self.assertIn("couldn't find", await self.refused("wm", "decide_access_request",
                                                          {"request": rid, "decision": "approve"}))
        await self.add_member("W2", "stranger", "admin")  # an admin of another workspace: no
        self.assertIn("couldn't find", await self.refused("stranger", "decide_access_request",
                                                          {"request": rid, "decision": "approve"}))
        self.mail.clear()
        out = await self.ok("wa", "decide_access_request", {"request": rid, "decision": "approve"})
        self.assertEqual((out["status"], out["role_granted"]), ("approved", "editor"))
        g = await self.db["document_grants"].find_one({"document_id": str(self.W["_id"]), "email": "gv@example.com"})
        self.assertEqual((g["role"], g["granted_via"], g["granted_by_user_id"]), ("editor", self.ws["W1"], self.uid["wa"]))
        self.assertEqual((await self.put(self.W["slug"], self.session("gv"))).status_code, 200)
        self.assertEqual([m["to"] for m in self.mail], [["gv@example.com"]])

    async def test_a_request_to_open_view_or_edit(self):
        rids = []
        for state in ("P", "P"):
            P = await self.mkdoc(state, ws=None)
            r = await self.http.post(f"/api/v1/documents/{P['slug']}/access-requests", json={},
                                     headers=self.session("stranger"))
            rids.append((P, r.json()["id"]))
        (p1, r1), (p2, r2) = rids
        out = await self.ok("owner", "decide_access_request", {"request": r1, "decision": "approve"})
        self.assertEqual(out["role_granted"], "viewer")
        self.assertEqual((await self.get(p1["slug"], self.session("stranger"))).status_code, 200)
        self.assertEqual((await self.put(p1["slug"], self.session("stranger"))).status_code, 403)
        out = await self.ok("owner", "decide_access_request", {"request": r2, "decision": "approve", "role": "editor"})
        self.assertEqual(out["role_granted"], "editor")
        self.assertEqual((await self.put(p2["slug"], self.session("stranger"))).status_code, 200)
        # An admin never decides a request to open something.
        P3 = await self.mkdoc("P", ws=None)
        r3 = (await self.http.post(f"/api/v1/documents/{P3['slug']}/access-requests", json={},
                                   headers=self.session("stranger"))).json()["id"]
        self.assertIn("couldn't find", await self.refused("wa", "decide_access_request",
                                                          {"request": r3, "decision": "approve"}))
