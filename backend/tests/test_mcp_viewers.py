"""Who's viewing through MCP: get_viewers and set_presence.

An AI app acting for a user gets the snapshot that user's page shows (the
identity rules of services/viewers.py, unchanged), without joining the list.
Pages are driven through routers.live.serve as in tests/test_viewers.py, in
the access-policy fixture world (tests/_access_env.py).
"""

from __future__ import annotations

import asyncio
import json
from unittest import mock

from tests._access_env import AccessWorld
from tests.test_viewers import CONTENT, FakeSocket, settle

from app.mcp import tools as mcp_tools
from app.routers import live as live_router
from app.services import tickets, viewers


class McpViewers(AccessWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        viewers.clear()
        p = mock.patch.object(viewers, "FLUSH_S", 0.0)
        p.start()
        self.addCleanup(p.stop)
        self.tasks: list[asyncio.Task] = []
        self.addAsyncCleanup(self._close_all)

    async def _close_all(self):
        for t in self.tasks:
            t.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        viewers.clear()

    async def open(self, d: dict, who: str | None = None, *, anon: bool = False, sec=None,
                   state: str = "active") -> FakeSocket:
        ws = FakeSocket(tickets.mint(str(d["_id"]), int(d.get("access_epoch") or 0)))
        self.tasks.append(asyncio.create_task(live_router.serve(ws, d["slug"])))
        await settle(2)
        msg = {"type": "hello", "n": f"tab{len(self.tasks):04d}xyz", "anon": anon, "state": state}
        if who:
            msg["pt"] = tickets.mint_presence(str(d["_id"]), self.uid[who])
        if sec is not None:
            msg["sec"] = sec
        ws.say(**msg)
        await settle()
        return ws

    async def viewers_as(self, who: str, document: str, *, write: bool = True) -> dict:
        status, result = await self.mcp_call(await self.mcp_token(who, write=write), "get_viewers",
                                             {"document": document})
        self.assertEqual(status, 200)
        return result

    async def presence_as(self, who: str, document: str, show: bool, *, write: bool = True) -> dict:
        status, result = await self.mcp_call(await self.mcp_token(who, write=write), "set_presence",
                                             {"document": document, "show": show})
        self.assertEqual(status, 200)
        return result

    def ok(self, result: dict) -> dict:
        self.assertFalse(result["isError"], result["content"][0]["text"])
        return result["structuredContent"]

    def err(self, result: dict) -> str:
        self.assertTrue(result["isError"], result)
        self.assertNotIn("structuredContent", result)
        return result["content"][0]["text"]

    def assert_no_identity(self, result: dict, *who: str):
        blob = json.dumps(result)
        for w in who:
            self.assertNotIn(self.email[w], blob)
            self.assertNotIn(self.uid[w], blob)
        self.assertNotIn("@example.com", blob)
        self.assertNotIn('"pic"', blob)

    @staticmethod
    def labels(snap: dict) -> list[str]:
        """A page snapshot's list in get_viewers' words."""
        return [v.get("name") or f"Anonymous {v['animal']}" for v in snap["viewers"]]

    # ── get_viewers ──

    async def test_same_list_and_rules_as_the_page(self):
        d = await self.mkdoc("L", content=CONTENT)   # link, filed in W1, granted to gv and ge
        await self.open(d, "owner", sec={"h": "user-content-install"})
        await self.open(d, "wm")
        await self.open(d, "gv", state="away")
        await self.open(d, "wv", anon=True)   # a member who asked to be anonymous
        stranger = await self.open(d, "stranger")
        visitor = await self.open(d)
        await settle()
        page = visitor.presence()
        before = len(viewers.room(d["slug"]).conns)

        # A stranger's AI app (signed in, no relationship): exactly what the page shows them, and
        # since 2026-11-04 that is every viewer as an anonymous animal (names only for the doc's people).
        res = await self.viewers_as("stranger", d["slug"])
        out = self.ok(res)
        self.assertEqual((out["presence"], out["total"]), ("on", 6))
        self.assertEqual([v["name"] for v in out["viewers"]], self.labels(page))
        self.assertEqual(sum(v["anonymous"] for v in out["viewers"]), 6)
        for v in out["viewers"]:
            self.assertEqual(set(v), {"name", "anonymous", "owner", "state", "section", "you", "editing"})
            self.assertIn(v["name"].removeprefix("Anonymous "), viewers.ANIMALS)
            self.assertFalse(v["owner"])
        # The caller's own tab is marked, and it stays anonymous to them as to everyone.
        mine = [v for v in out["viewers"] if v["you"]]
        self.assertEqual(len(mine), 1)
        self.assertEqual(mine[0]["name"], f"Anonymous {stranger.presence()['me']['animal']}")
        self.assert_no_identity(res, "stranger", "wv", "owner", "wm", "gv")
        for who in ("WV", "OWNER", "WM", "GV"):
            self.assertNotIn(who, json.dumps(res))
        self.assertIn("6 people are viewing", res["content"][0]["text"])

        # A member's AI app (a relationship): the names, the owner and where they're reading, as the
        # page shows a member; the member who asked to be anonymous stays an animal.
        res = await self.viewers_as("wm", d["slug"])
        out = self.ok(res)
        self.assertEqual((out["presence"], out["total"]), ("on", 6))
        self.assertEqual({v["name"] for v in out["viewers"] if not v["anonymous"]}, {"OWNER", "WM", "GV"})
        self.assertEqual(sum(v["anonymous"] for v in out["viewers"]), 3)
        owner_row = next(v for v in out["viewers"] if v["name"] == "OWNER")
        self.assertEqual((owner_row["owner"], owner_row["section"], owner_row["you"]), (True, "Install", False))
        self.assertEqual(next(v for v in out["viewers"] if v["name"] == "GV")["state"], "away")
        self.assertNotIn("WV", json.dumps(res))
        self.assertIn("OWNER (owner): Install", res["content"][0]["text"])

        # Asking added nobody and told nobody.
        await settle()
        self.assertEqual(len(viewers.room(d["slug"]).conns), before)
        self.assertEqual(visitor.presence()["total"], 6)

    async def test_owner_and_member_see_the_same_snapshot(self):
        d = await self.mkdoc("W", content=CONTENT)   # workspace-only, W1
        await self.open(d, "owner")
        await self.open(d, "wv", sec={"h": "user-content-use-it"})
        page = (await self.open(d, "wm")).presence()
        for who in ("owner", "wm", "wa"):
            out = self.ok(await self.viewers_as(who, d["slug"]))
            self.assertEqual([v["name"] for v in out["viewers"]], self.labels(page))
            self.assertEqual(out["total"], 3)
            you = [v["name"] for v in out["viewers"] if v["you"]]
            self.assertEqual(you, [] if who == "wa" else [who.upper()])
        out = self.ok(await self.viewers_as("owner", d["slug"]))
        self.assertEqual(next(v for v in out["viewers"] if v["name"] == "WV")["section"], "Use it")
        # The canonical link is the workspace's domain.
        self.assertTrue(out["url"].startswith("https://docs.acme.test/"))

    async def test_file_pages_and_video_time(self):
        d = await self.mkdoc("L", kind="artifact")
        await self.open(d, sec={"p": 3})
        await self.open(d, sec={"s": 151.7})
        out = self.ok(await self.viewers_as("owner", d["slug"]))
        self.assertEqual(sorted(v["section"] for v in out["viewers"]), ["At 2:30", "Page 3"])

    async def test_nobody_viewing(self):
        d = await self.mkdoc("L", content=CONTENT)
        res = await self.viewers_as("owner", d["slug"])
        self.assertEqual(self.ok(res)["presence"], "on")
        self.assertEqual((self.ok(res)["total"], self.ok(res)["viewers"]), (0, []))
        self.assertIn("Nobody is viewing", res["content"][0]["text"])
        self.assertIsNone(viewers.room(d["slug"]))   # still no room: asking doesn't open one

    async def test_encrypted_is_count_only(self):
        d = await self.mkdoc("L", content="e2e:v1:opaque", encrypted=True)
        await self.open(d, "owner")
        await self.open(d, "gv")
        await self.open(d)
        for who in ("owner", "gv", "stranger"):
            res = await self.viewers_as(who, d["slug"])
            out = self.ok(res)
            self.assertEqual((out["presence"], out["total"], out["viewers"]), ("count_only", 3, []))
            self.assertNotIn("OWNER", json.dumps(res))
            self.assertNotIn("GV", json.dumps(res))
            self.assertIn("only the count", res["content"][0]["text"])

    async def test_switch_off_says_so(self):
        d = await self.mkdoc("L", content=CONTENT, show_presence=False)
        await self.open(d, "owner")
        await self.open(d)
        for who in ("owner", "gv", "stranger"):
            res = await self.viewers_as(who, d["slug"])
            self.assertEqual(self.ok(res)["presence"], "off")
            self.assertEqual((self.ok(res)["total"], self.ok(res)["viewers"]), (None, []))
            self.assertIn("Presence is off for this document", res["content"][0]["text"])

    async def test_no_access_is_not_found(self):
        missing = self.err(await self.viewers_as("stranger", "no-such-doc"))
        self.assertEqual(missing, mcp_tools.NOT_FOUND)
        private = await self.mkdoc("P", content=CONTENT)
        await self.open(private, "owner")
        for who in ("stranger", "wm2", "former"):
            self.assertEqual(self.err(await self.viewers_as(who, private["slug"])), missing)
        members = await self.mkdoc("W", content=CONTENT)
        await self.open(members, "wm")
        self.assertEqual(self.err(await self.viewers_as("stranger", members["slug"])), missing)
        # A password-protected link: the same refusal as the other read tools.
        locked = await self.mkdoc("LP", content=CONTENT)
        self.assertEqual(self.err(await self.viewers_as("stranger", locked["slug"])), mcp_tools.PASSWORD_GATED)
        # A link on another workspace's domain doesn't resolve to it.
        self.assertEqual(self.err(await self.viewers_as("wm2", f"https://w2.test/{members['slug']}")), missing)

    async def test_read_only_permission_is_enough(self):
        d = await self.mkdoc("L", content=CONTENT)
        await self.open(d, "owner")
        out = self.ok(await self.viewers_as("gv", d["slug"], write=False))
        self.assertEqual([v["name"] for v in out["viewers"]], ["OWNER"])

    # ── set_presence ──

    async def test_owner_turns_it_off_and_on(self):
        d = await self.mkdoc("L", content=CONTENT)
        a = await self.open(d, "owner", sec={"h": "user-content-install"})
        b = await self.open(d)
        res = await self.presence_as("owner", d["slug"], False)
        self.assertEqual(self.ok(res), {"url": f"https://docs.acme.test/{d['slug']}",
                                        "markdrop_url": f"https://markdrop.in/{d['slug']}",
                                        "workspace_url": f"https://docs.acme.test/{d['slug']}",
                                        "domain_url": f"https://docs.acme.test/{d['slug']}",
                                        "slug": d["slug"], "show_presence": False})
        await settle()
        self.assertEqual(a.presence(), {"type": "presence", "on": False})
        self.assertEqual(b.presence(), {"type": "presence", "on": False})
        self.assertFalse((await self.doc(d["slug"]))["show_presence"])
        self.assertTrue(all(c.sec is None for c in viewers.room(d["slug"]).conns.values()))
        self.assertEqual(self.ok(await self.viewers_as("owner", d["slug"]))["presence"], "off")
        # The HTTP settings agree.
        body = (await self.http.get(f"/api/v1/documents/{d['slug']}/access", headers=self.session("owner"))).json()
        self.assertFalse(body["show_presence"])

        self.ok(await self.presence_as("owner", d["slug"], True))
        await settle()
        self.assertTrue(b.presence()["on"])
        self.assertEqual(b.presence()["total"], 2)
        self.assertTrue((await self.doc(d["slug"]))["show_presence"])
        self.assertEqual(self.ok(await self.viewers_as("owner", d["slug"]))["total"], 2)

    async def test_only_the_owner(self):
        d = await self.mkdoc("L", content=CONTENT)
        await self.open(d)
        for who in ("gv", "ge", "wm", "wa", "stranger"):
            text = self.err(await self.presence_as(who, d["slug"], False))
            self.assertIn("documents you own", text)
        private = await self.mkdoc("P", content=CONTENT)
        self.assertEqual(self.err(await self.presence_as("stranger", private["slug"], False)), mcp_tools.NOT_FOUND)
        self.assertEqual(self.err(await self.presence_as("stranger", "no-such-doc", False)), mcp_tools.NOT_FOUND)
        # A read-only app is asked to step up (403 insufficient_scope), like every write tool.
        status, _ = await self.mcp_call(await self.mcp_token("owner", write=False), "set_presence",
                                        {"document": d["slug"], "show": False})
        self.assertEqual(status, 403)
        self.assertIsNot((await self.doc(d["slug"])).get("show_presence"), False)
        self.assertTrue(self.ok(await self.viewers_as("owner", d["slug"]))["presence"] == "on")

    async def test_bad_arguments(self):
        d = await self.mkdoc("L", content=CONTENT)
        status, result = await self.mcp_call(await self.mcp_token("owner"), "set_presence", {"document": d["slug"]})
        self.assertEqual(status, 200)
        self.assertTrue(result["isError"])
        status, result = await self.mcp_call(await self.mcp_token("owner"), "set_presence",
                                             {"document": d["slug"], "show": "no"})
        self.assertTrue(result["isError"])
        self.assertIsNot((await self.doc(d["slug"])).get("show_presence"), False)
