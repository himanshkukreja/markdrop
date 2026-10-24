"""The P2P share helpers on the remote MCP server: list_shares and get_share_status.

Live state comes from the signalling server's in-memory rooms, so these tests
put fake rooms into `share._rooms` (and take them out again) rather than
opening WebSockets.
"""

from __future__ import annotations

import json
import time
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

from tests._mcp_env import McpTestCase, settings

from app.mcp import schema
from app.mcp.tools import BY_NAME, ToolError, resolve_share
from app.routers import share


def room(*, host: bool = True, guests: int = 0, multi: bool = True, key: str | None = None,
         left_at: float | None = None) -> dict:
    r = {"host": object() if host else None, "multi": multi,
         "guests": {f"g{i}": object() for i in range(guests)}, "key": key}
    if left_at is not None:
        r["left_at"] = left_at
    return r


class Shares(McpTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        _, tokens = await self.connect()
        self.token = tokens["access_token"]
        self.other_id = await self.make_user("sam@example.com", "Sam")
        self._rooms_before = dict(share._rooms)
        self.now = datetime.now(timezone.utc).replace(microsecond=0)

    async def asyncTearDown(self):
        share._rooms.clear()
        share._rooms.update(self._rooms_before)
        await super().asyncTearDown()

    async def tool(self, name: str, **arguments) -> dict:
        return await self.call(self.token, name, arguments)

    def ok(self, result: dict, name: str) -> dict:
        self.assertFalse(result["isError"], result["content"][0]["text"])
        out = result["structuredContent"]
        self.assertIsNone(schema.validate(BY_NAME[name].output_schema, out))
        return out

    def err(self, result: dict) -> str:
        self.assertTrue(result["isError"], result)
        self.assertNotIn("structuredContent", result)
        return result["content"][0]["text"]

    async def event(self, room_id: str, user_id: str | None, *, ago: timedelta = timedelta(0),
                    name: str | None = "report.pdf", size: int | None = 2048, count: int = 1) -> None:
        await self.db["share_events"].insert_one({
            "room_id": room_id, "user_id": user_id, "file_name": name, "file_size": size,
            "mime_type": "application/pdf", "file_count": count, "ip_hash": "iphash",
            "ts": self.now - ago,
        })

    async def transfers(self, room_id: str, n: int) -> None:
        for _ in range(n):
            await self.db["share_transfers"].insert_one({
                "room_id": room_id, "bytes": 2048, "ms": 100, "files": 1, "route": "direct",
                "protocol": 2, "ts": self.now,
            })

    # ── list_shares ──

    async def test_list_only_own_shares_newest_first(self):
        await self.event("aaaaaaaaaa", self.user_id, ago=timedelta(hours=3), name="old.zip")
        await self.event("bbbbbbbbbb", self.user_id, ago=timedelta(hours=1), name="new.png", count=3,
                         size=5 * 1024 * 1024)
        await self.event("cccccccccc", self.other_id, name="theirs.txt")
        await self.event("dddddddddd", None, name="anonymous.txt")
        result = await self.tool("list_shares")
        out = self.ok(result, "list_shares")
        self.assertEqual(out["count"], 2)
        self.assertEqual([s["id"] for s in out["shares"]], ["bbbbbbbbbb", "aaaaaaaaaa"])
        first = out["shares"][0]
        self.assertEqual(first, {
            "id": "bbbbbbbbbb", "url": "https://markdrop.in/share/bbbbbbbbbb", "file_name": "new.png",
            "file_count": 3, "total_bytes": 5 * 1024 * 1024,
            "started_at": (self.now - timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
            "live": False, "recipients_now": 0, "downloads_completed": 0,
        })
        text = result["content"][0]["text"]
        self.assertIn("new.png and 2 more (5.0 MB)", text)
        self.assertNotIn("theirs.txt", json.dumps(out))
        self.assertNotIn("anonymous", text)

    async def test_list_dedupes_reconnects(self):
        # A sender that reconnects logs the same room again.
        await self.event("aaaaaaaaaa", self.user_id, ago=timedelta(minutes=30), name="first-name.pdf")
        await self.event("aaaaaaaaaa", self.user_id, ago=timedelta(minutes=5), name="report.pdf")
        await self.event("bbbbbbbbbb", self.user_id, ago=timedelta(minutes=10))
        out = self.ok(await self.tool("list_shares"), "list_shares")
        self.assertEqual([s["id"] for s in out["shares"]], ["aaaaaaaaaa", "bbbbbbbbbb"])
        row = out["shares"][0]
        self.assertEqual(row["file_name"], "report.pdf")  # the newest row describes it …
        self.assertEqual(row["started_at"],  # … the oldest says when it started
                         (self.now - timedelta(minutes=30)).isoformat().replace("+00:00", "Z"))

    async def test_list_live_flags_and_downloads(self):
        await self.event("live000001", self.user_id, ago=timedelta(minutes=1))
        await self.event("held000002", self.user_id, ago=timedelta(minutes=2))
        await self.event("gone000003", self.user_id, ago=timedelta(minutes=3))
        share._rooms["live000001"] = room(guests=2)
        share._rooms["held000002"] = room(host=False, guests=1, key="k")
        await self.transfers("live000001", 3)
        await self.transfers("gone000003", 1)
        await self.transfers("someone-else-room", 4)
        before = dict(share._rooms)
        out = self.ok(await self.tool("list_shares"), "list_shares")
        rows = {s["id"]: s for s in out["shares"]}
        self.assertEqual((rows["live000001"]["live"], rows["live000001"]["recipients_now"],
                          rows["live000001"]["downloads_completed"]), (True, 2, 3))
        # A held room has no sender online: not live, but its waiting recipients count.
        self.assertEqual((rows["held000002"]["live"], rows["held000002"]["recipients_now"]), (False, 1))
        self.assertEqual((rows["gone000003"]["live"], rows["gone000003"]["recipients_now"],
                          rows["gone000003"]["downloads_completed"]), (False, 0, 1))
        live = self.ok(await self.tool("list_shares", live_only=True), "list_shares")
        self.assertEqual([s["id"] for s in live["shares"]], ["live000001"])
        self.assertEqual(share._rooms, before)  # reading never touches the rooms

    async def test_list_limit_and_empty(self):
        for i in range(5):
            await self.event(f"room00000{i}", self.user_id, ago=timedelta(minutes=i))
        out = self.ok(await self.tool("list_shares", limit=2), "list_shares")
        self.assertEqual([s["id"] for s in out["shares"]], ["room000000", "room000001"])
        share._rooms["room000004"] = room()
        share._rooms["room000003"] = room()
        live = self.ok(await self.tool("list_shares", limit=1, live_only=True), "list_shares")
        self.assertEqual([s["id"] for s in live["shares"]], ["room000003"])
        self.assertIn("at most 50", self.err(await self.tool("list_shares", limit=51)))
        self.assertIn("at least 1", self.err(await self.tool("list_shares", limit=0)))
        self.assertIn("must be boolean", self.err(await self.tool("list_shares", live_only="yes")))

        await self.db["share_events"].delete_many({})
        result = await self.tool("list_shares")
        self.assertEqual(self.ok(result, "list_shares"), {"shares": [], "count": 0})
        self.assertIn("No shares found", result["content"][0]["text"])
        result = await self.tool("list_shares", live_only=True)
        self.assertIn("live right now", result["content"][0]["text"])

    async def test_missing_metadata(self):
        await self.event("bare000001", self.user_id, name=None, size=None)
        out = self.ok(await self.tool("list_shares"), "list_shares")
        self.assertEqual((out["shares"][0]["file_name"], out["shares"][0]["total_bytes"]), (None, None))

    # ── get_share_status ──

    async def status(self, link: str) -> dict:
        return self.ok(await self.tool("get_share_status", link=link), "get_share_status")

    async def test_status_reasons(self):
        cases = {
            "okroom0001": (room(guests=3), True, True, "ok"),
            "heldroom01": (room(host=False, key="k"), False, True, "held"),
            "nokeyroom1": (room(host=False, guests=1), False, False, "no_sender"),
            "busyroom01": (room(guests=1, multi=False), True, False, "busy"),
            "fullroom01": (room(guests=share.MAX_GUESTS), True, False, "full"),
            "v1idle0001": (room(multi=False), True, True, "ok"),
            "expired001": (room(host=False, key="k",
                                left_at=time.monotonic() - share.KEY_HOLD_SECONDS - 5), False, False, "no_sender"),
        }
        for rid, (r, *_rest) in cases.items():
            share._rooms[rid] = r
        for rid, (_r, online, can_join, reason) in cases.items():
            out = await self.status(rid)
            self.assertEqual((out["sender_online"], out["can_join"], out["reason"]), (online, can_join, reason), rid)
            self.assertEqual(out["url"], f"https://markdrop.in/share/{rid}")
        out = await self.status("nosuchroom")
        self.assertEqual((out["sender_online"], out["can_join"], out["reason"], out["yours"]),
                         (False, False, "no_sender", False))

    async def test_status_never_creates_a_room(self):
        before = set(share._rooms)
        await self.status("https://markdrop.in/share/fresh00001")
        self.assertEqual(set(share._rooms), before)

    async def test_non_owner_learns_nothing_more(self):
        await self.event("theirs0001", self.other_id, name="salary.xlsx", size=999)
        await self.event("anon000001", None, name="anon.txt")
        await self.transfers("theirs0001", 2)
        share._rooms["theirs0001"] = room(guests=2)
        share._rooms["anon000001"] = room()
        for rid in ("theirs0001", "anon000001"):
            result = await self.tool("get_share_status", link=f"https://markdrop.in/share/{rid}")
            out = self.ok(result, "get_share_status")
            self.assertEqual(set(out), {"id", "url", "sender_online", "can_join", "reason", "yours"})
            self.assertFalse(out["yours"])
            dumped = json.dumps(result)
            for leaked in ("salary", "anon.txt", "999", "iphash", self.other_id, "recipient"):
                self.assertNotIn(leaked, dumped)

    async def test_owner_gets_details(self):
        await self.event("mine000001", self.user_id, ago=timedelta(minutes=20), name="old-name.zip")
        await self.event("mine000001", self.user_id, ago=timedelta(minutes=2), name="photos.zip",
                         size=3 * 1024 * 1024 * 1024, count=40)
        await self.event("mine000001", self.other_id, name="not-mine.txt")  # can't happen, but never shown
        await self.transfers("mine000001", 2)
        share._rooms["mine000001"] = room(guests=1)
        result = await self.tool("get_share_status", link="markdrop.in/share/mine000001")
        out = self.ok(result, "get_share_status")
        self.assertEqual(out, {
            "id": "mine000001", "url": "https://markdrop.in/share/mine000001", "sender_online": True,
            "can_join": True, "reason": "ok", "yours": True, "file_name": "photos.zip", "file_count": 40,
            "total_bytes": 3 * 1024 * 1024 * 1024,
            "started_at": (self.now - timedelta(minutes=20)).isoformat().replace("+00:00", "Z"),
            "recipients_now": 1, "downloads_completed": 2,
        })
        self.assertIn("photos.zip and 39 more (3.0 GB)", result["content"][0]["text"])
        # An ended share of the user's still reports its details.
        del share._rooms["mine000001"]
        out = await self.status("mine000001")
        self.assertEqual((out["yours"], out["reason"], out["recipients_now"], out["downloads_completed"]),
                         (True, "no_sender", 0, 2))

    async def test_bad_links_are_tool_errors(self):
        for bad in ("https://example.com/share/abcdefabcd", "https://markdrop.in/abcdefabcd",
                    "https://markdrop.in/share/abc", "https://markdrop.in/share/abcdefabcd/extra",
                    "not a link", "https://markdrop.in/share/<script>", "http://[::1"):
            self.assertIn("doesn't look like", self.err(await self.tool("get_share_status", link=bad)), bad)
        self.assertIn("link is required", self.err(await self.tool("get_share_status")))
        self.assertIn("can't be empty", self.err(await self.tool("get_share_status", link="")))
        self.assertIn("Give a Markdrop share link", self.err(await self.tool("get_share_status", link="   ")))

    def test_link_parsing(self):
        for value in ("abcdef1234", " abcdef1234 ", "https://markdrop.in/share/abcdef1234",
                      "https://www.markdrop.in/share/abcdef1234/", "markdrop.in/share/abcdef1234",
                      "https://markdrop.in/share/abcdef1234?x=1#frag", "HTTPS://MARKDROP.IN/share/abcdef1234"):
            self.assertEqual(resolve_share(value), "abcdef1234", value)
        with self.assertRaises(ToolError):
            resolve_share("http://localhost:3000/share/abcdef1234")  # production: no localhost links
        with mock.patch.object(settings, "frontend_url", "http://localhost:3000"):
            self.assertEqual(resolve_share("http://localhost:3197/share/abcdef1234"), "abcdef1234")
            self.assertEqual(resolve_share("http://127.0.0.1:3000/share/abcdef1234"), "abcdef1234")

    # ── cross-cutting ──

    async def test_scope(self):
        _, write_only = await self.connect(scope="documents:write")
        for name, args in (("list_shares", {}), ("get_share_status", {"link": "abcdef1234"})):
            r = await self.rpc(write_only["access_token"], "tools/call", {"name": name, "arguments": args})
            self.assertEqual(r.status_code, 403, name)
            self.assertIn('scope="documents:read"', r.headers["www-authenticate"])
        _, read_only = await self.connect(scope="documents:read")
        self.assertFalse((await self.call(read_only["access_token"], "list_shares", {}))["isError"])
        self.assertFalse((await self.call(read_only["access_token"], "get_share_status",
                                          {"link": "abcdef1234"}))["isError"])

    async def test_listing_annotations(self):
        r = await self.rpc(self.token, "tools/list")
        tools = {t["name"]: t for t in r.json()["result"]["tools"]}
        for name in ("list_shares", "get_share_status"):
            ann = tools[name]["annotations"]
            self.assertEqual((ann["readOnlyHint"], ann["destructiveHint"], ann["idempotentHint"],
                              ann["openWorldHint"]), (True, False, True, False), name)
            self.assertEqual(BY_NAME[name].scope, "documents:read")
            self.assertFalse(BY_NAME[name].writes)

    async def test_audit_rows_have_no_file_names(self):
        await self.event("mine000001", self.user_id, name="top-secret-plans.pdf")
        self.ok(await self.tool("list_shares"), "list_shares")
        self.ok(await self.tool("get_share_status", link="mine000001"), "get_share_status")
        self.err(await self.tool("get_share_status", link="https://evil.example/x"))
        rows = await self.db["mcp_events"].find({}, {"_id": 0}).to_list(10)
        self.assertEqual([(r["tool"], r["ok"]) for r in rows],
                         [("list_shares", True), ("get_share_status", True), ("get_share_status", False)])
        for r in rows:
            self.assertEqual(set(r), {"user_id", "client_id", "tool", "ok", "ms", "ts"})
        dumped = json.dumps(await self.db["traffic_events"].find({}, {"_id": 0}).to_list(10), default=str)
        self.assertNotIn("top-secret", dumped)
        self.assertNotIn("mine000001", dumped)

    async def test_read_rate_limit(self):
        with mock.patch.object(settings, "mcp_read_rate_limit", "2/minute"):
            self.ok(await self.tool("list_shares"), "list_shares")
            self.ok(await self.tool("get_share_status", link="abcdef1234"), "get_share_status")
            self.assertIn("Too many requests", self.err(await self.tool("list_shares")))


if __name__ == "__main__":
    unittest.main()
