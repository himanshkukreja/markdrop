"""Each MCP tool's happy path and main refusals, on the real services."""

from __future__ import annotations

import json
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

import bcrypt
from bson import ObjectId

from tests._mcp_env import McpTestCase, settings

from app.services import r2


class Tools(McpTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        _, tokens = await self.connect()
        self.token = tokens["access_token"]
        self.other_id = await self.make_user("sam@example.com", "Sam")

    async def tool(self, name: str, **arguments) -> dict:
        return await self.call(self.token, name, arguments)

    def ok(self, result: dict) -> dict:
        self.assertFalse(result["isError"], result["content"][0]["text"])
        self.assertEqual(result["content"][0]["type"], "text")
        return result["structuredContent"]

    def err(self, result: dict) -> str:
        self.assertTrue(result["isError"], result)
        self.assertNotIn("structuredContent", result)
        return result["content"][0]["text"]

    async def seed(self, slug: str, *, owner: str | None = None, content: str = "# Seeded\n\nbody",
                   **fields) -> dict:
        now = datetime.now(timezone.utc)
        doc = {"slug": slug, "title": fields.pop("title", None), "content": content,
               "edit_secret_hash": "x", "created_at": now, "updated_at": now, "expires_at": None,
               "views": 0, "rev": 1, "owner_id": owner, **fields}
        await self.db["documents"].insert_one(doc)
        return doc

    # ── publish_document ──

    async def test_publish_document(self):
        out = self.ok(await self.tool("publish_document", markdown="# Hello\n\nworld", title="Hello"))
        self.assertEqual(set(out), {"url", "markdrop_url", "workspace_url", "slug", "title", "access",
                                    "expires_at"})
        self.assertEqual(out["url"], f"https://markdrop.in/{out['slug']}")
        self.assertEqual((out["markdrop_url"], out["workspace_url"]), (out["url"], None))
        self.assertEqual((out["title"], out["access"], out["expires_at"]), ("Hello", "link", None))
        raw = await self.db["documents"].find_one({"slug": out["slug"]})
        self.assertEqual(raw["owner_id"], self.user_id)
        self.assertEqual(raw["content"], "# Hello\n\nworld")
        self.assertFalse(raw["encrypted"])

    async def test_publish_options(self):
        out = self.ok(await self.tool("publish_document", markdown="x", slug="my-notes", access="private",
                                      expires="1h"))
        self.assertEqual((out["slug"], out["access"]), ("my-notes", "private"))
        exp = datetime.fromisoformat(out["expires_at"].replace("Z", "+00:00"))
        self.assertAlmostEqual((exp - datetime.now(timezone.utc)).total_seconds(), 3600, delta=60)
        raw = await self.db["documents"].find_one({"slug": "my-notes"})
        self.assertEqual(raw["access_level"], "private")
        out = self.ok(await self.tool("publish_document", markdown="x", password="hunter2"))
        self.assertEqual(out["access"], "password")
        raw = await self.db["documents"].find_one({"slug": out["slug"]})
        self.assertTrue(bcrypt.checkpw(b"hunter2", raw["read_password_hash"].encode()))
        out = self.ok(await self.tool("publish_document", markdown="x", expires="7d"))
        self.assertIsNotNone(out["expires_at"])

    async def test_publish_refusals(self):
        self.assertIn("reserved", self.err(await self.tool("publish_document", markdown="x", slug="mcp")))
        await self.tool("publish_document", markdown="x", slug="taken-one")
        self.assertIn("taken", self.err(await self.tool("publish_document", markdown="x", slug="taken-one")))
        self.assertIn("needs a password", self.err(await self.tool("publish_document", markdown="x", access="password")))
        self.assertIn("only applies", self.err(await self.tool("publish_document", markdown="x", access="private",
                                                                password="p")))
        self.assertIn("markdown is required", self.err(await self.tool("publish_document")))
        self.assertIn("must be one of", self.err(await self.tool("publish_document", markdown="x", expires="2y")))
        self.assertIn("invalid format", self.err(await self.tool("publish_document", markdown="x", slug="a b")))
        big = "x" * (settings.max_content_chars + 1)
        self.assertIn("too long", self.err(await self.tool("publish_document", markdown=big)))

    # ── publish_page ──

    async def test_publish_page_without_storage(self):
        text = self.err(await self.tool("publish_page", filename="report.html", content="<h1>hi</h1>"))
        self.assertIn("isn't available", text)
        self.assertEqual(await self.db["documents"].count_documents({}), 0)

    async def test_publish_page_bad_extension(self):
        text = self.err(await self.tool("publish_page", filename="notes.md", content="# hi"))
        self.assertIn("publish_document", text)

    def _r2(self, stored: dict):
        def put(key, data, content_type, public=True, live=False):
            stored[key] = {"data": data, "type": content_type, "public": public, "live": live}
            return True

        return [
            mock.patch.object(r2, "is_configured", lambda: True),
            mock.patch.object(r2, "put_bytes", put),
            mock.patch.object(r2, "get_bytes", lambda key, max_bytes: stored[key]["data"]),
            mock.patch.object(r2, "delete", lambda key: stored.pop(key, None)),
            mock.patch.object(r2, "set_public", lambda key, public, content_type=None, epoch=None: stored[key].update(public=public) or True),
            mock.patch.object(settings, "artifact_origin", "https://markdrop-artifacts.example.workers.dev"),
            mock.patch.object(settings, "artifact_signing_key", "k"),
        ]

    async def test_publish_page_and_round_trip_with_storage_mocked(self):
        stored: dict = {}
        patches = self._r2(stored)
        for p in patches:
            p.start()
        try:
            out = self.ok(await self.tool("publish_page", filename="Q3 Report.html",
                                          content="<h1>Q3</h1>", title="Q3"))
            self.assertEqual(out["kind"], "artifact")
            self.assertEqual(out["access"], "link")
            raw = await self.db["documents"].find_one({"slug": out["slug"]})
            self.assertEqual((raw["kind"], raw["mime"], raw["owner_id"]), ("artifact", "text/html", self.user_id))
            self.assertTrue(out["slug"].startswith("q3"))
            blob = stored[raw["blob_key"]]
            self.assertEqual((blob["data"], blob["public"], blob["live"]), (b"<h1>Q3</h1>", True, True))

            got = self.ok(await self.tool("get_document", document=out["url"]))
            self.assertEqual((got["kind"], got["content"]), ("artifact", "<h1>Q3</h1>"))

            upd = self.ok(await self.tool("update_document", document=out["slug"], content="<h1>Q3 v2</h1>"))
            self.assertEqual(upd["rev"], 2)
            self.assertEqual(stored[raw["blob_key"]]["data"], b"<h1>Q3 v2</h1>")

            out2 = self.ok(await self.tool("publish_page", filename="data.csv", content="a,b\n1,2",
                                           access="password", password="pw"))
            raw2 = await self.db["documents"].find_one({"slug": out2["slug"]})
            self.assertEqual(raw2["mime"], "text/csv")
            self.assertFalse(stored[raw2["blob_key"]]["public"])

            # Making it private closes the stored bytes too.
            self.ok(await self.tool("set_access", document=out["slug"], access="private"))
            self.assertFalse(stored[raw["blob_key"]]["public"])

            self.ok(await self.tool("delete_document", document=out["slug"]))
            self.assertNotIn(raw["blob_key"], stored)
        finally:
            for p in patches:
                p.stop()

    async def test_publish_page_quota(self):
        stored: dict = {}
        patches = self._r2(stored)
        for p in patches:
            p.start()
        try:
            await self.seed("big-file", owner=self.user_id, kind="artifact", mime="application/pdf",
                            size_bytes=settings.artifact_user_quota_bytes)
            self.assertIn("full", self.err(await self.tool("publish_page", filename="a.txt", content="hi")))
            self.assertEqual(stored, {})
        finally:
            for p in patches:
                p.stop()

    # ── get_document / fetch ──

    async def test_get_own_and_public_documents(self):
        await self.seed("mine-1", owner=self.user_id, title="Mine")
        await self.seed("theirs-1", owner=self.other_id, content="# Theirs\n\npublic")
        got = self.ok(await self.tool("get_document", document="https://markdrop.in/mine-1"))
        self.assertEqual((got["owner"], got["title"], got["access"]), ("you", "Mine", "link"))
        self.assertEqual(got["content"], "# Seeded\n\nbody")
        got = self.ok(await self.tool("get_document", document="theirs-1"))
        self.assertEqual((got["owner"], got["title"]), ("someone else", "Theirs"))

    async def test_get_document_gates(self):
        await self.seed("private-1", owner=self.other_id, access_level="private")
        pw = bcrypt.hashpw(b"pw", bcrypt.gensalt()).decode()
        await self.seed("pw-1", owner=self.other_id, read_password_hash=pw)
        await self.seed("enc-1", owner=self.user_id, encrypted=True, content="mdx1.aaa.bbb")
        self.assertIn("couldn't find", self.err(await self.tool("get_document", document="private-1")))
        self.assertIn("password-protected", self.err(await self.tool("get_document", document="pw-1")))
        self.assertIn("end-to-end encrypted", self.err(await self.tool("get_document", document="enc-1")))
        self.assertIn("couldn't find", self.err(await self.tool("get_document", document="no-such-doc")))
        self.assertIn("doesn't look like", self.err(await self.tool("get_document", document="a b c")))
        self.assertIn("end-to-end encrypted", self.err(await self.tool("fetch", id="enc-1")))
        self.assertIn("password-protected", self.err(await self.tool("fetch", id="pw-1")))
        # A named grant opens a private document, exactly as on the site.
        raw = await self.db["documents"].find_one({"slug": "private-1"})
        await self.db["document_grants"].insert_one({"document_id": str(raw["_id"]), "email": "priya@example.com",
                                                     "role": "viewer", "created_at": datetime.now(timezone.utc)})
        self.assertEqual(self.ok(await self.tool("get_document", document="private-1"))["access"], "private")

    async def test_password_doc_owned_by_user_is_readable(self):
        pw = bcrypt.hashpw(b"pw", bcrypt.gensalt()).decode()
        await self.seed("mine-pw", owner=self.user_id, read_password_hash=pw)
        self.assertEqual(self.ok(await self.tool("get_document", document="mine-pw"))["access"], "password")

    async def test_fetch(self):
        await self.seed("fetch-me", owner=self.user_id, title="Fetched", content="text body")
        result = await self.tool("fetch", id="fetch-me")
        out = self.ok(result)
        self.assertEqual(json.loads(result["content"][0]["text"]), out)
        self.assertEqual((out["id"], out["title"], out["text"]), ("fetch-me", "Fetched", "text body"))
        self.assertEqual(out["metadata"]["kind"], "document")
        self.assertTrue(out["url"].endswith("/fetch-me"))

    # ── list / search ──

    async def test_list_documents_paginates_and_filters(self):
        for i in range(5):
            await self.tool("publish_document", markdown=f"# Doc {i}", title=f"Doc {i}")
        await self.seed("an-artifact", owner=self.user_id, kind="artifact", mime="text/html",
                        created_at=datetime.now(timezone.utc) - timedelta(days=1))
        await self.seed("someone-elses", owner=self.other_id)
        first = self.ok(await self.tool("list_documents", limit=2))
        self.assertEqual([i["title"] for i in first["items"]], ["Doc 4", "Doc 3"])
        self.assertIsNotNone(first["next_cursor"])
        second = self.ok(await self.tool("list_documents", limit=2, cursor=first["next_cursor"]))
        self.assertEqual([i["title"] for i in second["items"]], ["Doc 2", "Doc 1"])
        files = self.ok(await self.tool("list_documents", kind="file"))
        self.assertEqual([i["slug"] for i in files["items"]], ["an-artifact"])
        self.assertIsNone(files["next_cursor"])
        docs = self.ok(await self.tool("list_documents", kind="document", query="doc 3"))
        self.assertEqual([i["title"] for i in docs["items"]], ["Doc 3"])
        everything = self.ok(await self.tool("list_documents", limit=50))
        self.assertNotIn("someone-elses", [i["slug"] for i in everything["items"]])
        self.assertIn("isn't valid", self.err(await self.tool("list_documents", cursor="!!!")))
        self.assertIn("at most 50", self.err(await self.tool("list_documents", limit=500)))

    async def test_search(self):
        await self.seed("roadmap-q4", owner=self.user_id, title="Roadmap Q4")
        await self.seed("untitled-1", owner=self.user_id, content="# Launch plan\n\nmentions roadmap here")
        await self.seed("enc-roadmap", owner=self.user_id, encrypted=True, content="roadmap ciphertext")
        await self.seed("theirs-roadmap", owner=self.other_id, title="Roadmap theirs")
        result = await self.tool("search", query="roadmap")
        out = self.ok(result)
        self.assertEqual(json.loads(result["content"][0]["text"]), out)
        ids = [r["id"] for r in out["results"]]
        self.assertIn("roadmap-q4", ids)
        self.assertIn("untitled-1", ids)
        self.assertNotIn("theirs-roadmap", ids)
        titles = {r["id"]: r["title"] for r in out["results"]}
        self.assertEqual(titles["untitled-1"], "Launch plan")
        # The slug matches, but the encrypted title is never echoed.
        self.assertEqual(titles.get("enc-roadmap"), "enc-roadmap")

    # ── update_document ──

    async def test_update_document(self):
        pub = self.ok(await self.tool("publish_document", markdown="v1", title="Keep me"))
        out = self.ok(await self.tool("update_document", document=pub["url"], content="v2"))
        self.assertEqual(out["rev"], 2)
        raw = await self.db["documents"].find_one({"slug": pub["slug"]})
        self.assertEqual((raw["content"], raw["title"]), ("v2", "Keep me"))
        self.ok(await self.tool("update_document", document=pub["slug"], content="v3", title="New title"))
        raw = await self.db["documents"].find_one({"slug": pub["slug"]})
        self.assertEqual((raw["content"], raw["title"], raw["rev"]), ("v3", "New title", 3))

    async def test_update_refusals(self):
        await self.seed("theirs-2", owner=self.other_id)
        await self.seed("theirs-private", owner=self.other_id, access_level="private")
        await self.seed("enc-2", owner=self.user_id, encrypted=True, content="mdx1.a.b")
        await self.seed("pdf-1", owner=self.user_id, kind="artifact", mime="application/pdf")
        self.assertIn("only update documents you own", self.err(await self.tool("update_document", document="theirs-2", content="x")))
        self.assertIn("couldn't find", self.err(await self.tool("update_document", document="theirs-private", content="x")))
        self.assertIn("end-to-end encrypted", self.err(await self.tool("update_document", document="enc-2", content="x")))
        self.assertIn("isn't a text file", self.err(await self.tool("update_document", document="pdf-1", content="x")))
        raw = await self.db["documents"].find_one({"slug": "theirs-2"})
        self.assertEqual(raw["rev"], 1)

    # ── set_access ──

    async def test_set_access(self):
        pub = self.ok(await self.tool("publish_document", markdown="x"))
        slug = pub["slug"]
        out = self.ok(await self.tool("set_access", document=slug, access="password", password="pw", expires="1d"))
        self.assertEqual(out["access"], "password")
        self.assertIsNotNone(out["expires_at"])
        out = self.ok(await self.tool("set_access", document=slug, access="private"))
        self.assertEqual(out["access"], "private")
        raw = await self.db["documents"].find_one({"slug": slug})
        self.assertEqual(raw["access_level"], "private")
        # Kept inert (policy §1.2, C5): it applies again if the doc becomes a link
        # through anything other than an explicit "link" here.
        self.assertIsNotNone(raw["read_password_hash"])
        out = self.ok(await self.tool("set_access", document=slug, access="link", expires="never"))
        self.assertEqual((out["access"], out["expires_at"]), ("link", None))
        raw = await self.db["documents"].find_one({"slug": slug})
        self.assertEqual(raw["access_level"], "link")
        self.assertIsNone(raw["read_password_hash"])  # plain "link" asked for no password
        self.assertEqual(raw["content"], "x")

    async def test_set_access_refusals(self):
        await self.seed("theirs-3", owner=self.other_id)
        mine = self.ok(await self.tool("publish_document", markdown="x"))
        self.assertIn("only change access to documents you own",
                      self.err(await self.tool("set_access", document="theirs-3", access="private")))
        self.assertIn("needs a password", self.err(await self.tool("set_access", document=mine["slug"], access="password")))
        self.assertIn("only applies", self.err(await self.tool("set_access", document=mine["slug"], access="link",
                                                                password="p")))
        raw = await self.db["documents"].find_one({"slug": "theirs-3"})
        self.assertNotIn("access_level", raw)

    # ── delete_document ──

    async def test_delete_document(self):
        pub = self.ok(await self.tool("publish_document", markdown="bye"))
        out = self.ok(await self.tool("delete_document", document=pub["slug"]))
        self.assertEqual(out, {"deleted": True, "slug": pub["slug"]})
        self.assertIsNone(await self.db["documents"].find_one({"slug": pub["slug"]}))
        await self.seed("theirs-4", owner=self.other_id)
        self.assertIn("only delete documents you own", self.err(await self.tool("delete_document", document="theirs-4")))
        self.assertIsNotNone(await self.db["documents"].find_one({"slug": "theirs-4"}))

    # ── get_document_stats ──

    async def test_stats(self):
        doc = await self.seed("stats-1", owner=self.user_id, views=3)
        doc_id = str(doc["_id"])
        now = datetime.now(timezone.utc).replace(microsecond=0)
        await self.db["events"].insert_many([
            {"doc_id": doc_id, "type": "view", "ts": now - timedelta(hours=2), "ip_hash": "a",
             "referrer": "https://news.ycombinator.com/item"},
            {"doc_id": doc_id, "type": "view", "ts": now - timedelta(hours=1), "ip_hash": "b",
             "referrer": "https://news.ycombinator.com/item"},
            {"doc_id": doc_id, "type": "view", "ts": now, "ip_hash": "a", "referrer": None},
            {"doc_id": doc_id, "type": "read", "rid": "r1", "ts": now, "depth": 100, "seconds": 30},
            {"doc_id": doc_id, "type": "read", "rid": "r2", "ts": now, "depth": 50, "seconds": 10},
            {"doc_id": doc_id, "type": "read", "rid": "r3", "ts": now, "depth": 5, "seconds": 1},
        ])
        out = self.ok(await self.tool("get_document_stats", document="stats-1"))
        self.assertEqual(out["views"], 3)
        self.assertEqual(out["unique_readers"], 2)
        self.assertEqual(out["reads"], 2)
        self.assertEqual(out["avg_read_depth"], 75.0)
        self.assertEqual(out["top_referrers"], [{"referrer": "https://news.ycombinator.com/item", "views": 2}])
        self.assertEqual(out["last_viewed_at"], now.isoformat().replace("+00:00", "Z"))
        await self.seed("theirs-5", owner=self.other_id)
        self.assertIn("only see stats for documents you own",
                      self.err(await self.tool("get_document_stats", document="theirs-5")))

    async def test_stats_empty(self):
        await self.seed("quiet", owner=self.user_id)
        out = self.ok(await self.tool("get_document_stats", document="quiet"))
        self.assertEqual((out["views"], out["avg_read_depth"], out["last_viewed_at"], out["top_referrers"]),
                         (0, None, None, []))

    # ── cross-cutting ──

    async def test_audit_rows_have_no_content(self):
        pub = self.ok(await self.tool("publish_document", markdown="secret words", title="Secret"))
        self.err(await self.tool("get_document", document="nope-nope"))
        rows = await self.db["mcp_events"].find({}, {"_id": 0}).to_list(10)
        self.assertEqual([(r["tool"], r["ok"]) for r in rows], [("publish_document", True), ("get_document", False)])
        for r in rows:
            self.assertEqual(set(r), {"user_id", "client_id", "tool", "ok", "ms", "ts"})
            self.assertEqual(r["user_id"], self.user_id)
        events = await self.db["traffic_events"].find({"name": "mcp_tool"}, {"_id": 0}).to_list(10)
        self.assertEqual(len(events), 2)
        dumped = json.dumps(events, default=str)
        self.assertNotIn(pub["slug"], dumped)
        self.assertNotIn("secret", dumped.lower())
        self.assertEqual(events[0]["props"], {"tool": "publish_document", "ok": True})

    async def test_write_rate_limit_per_user(self):
        with mock.patch.object(settings, "mcp_write_rate_limit", "2/minute"):
            self.ok(await self.tool("publish_document", markdown="1"))
            self.ok(await self.tool("publish_document", markdown="2"))
            self.assertIn("Too many requests", self.err(await self.tool("publish_document", markdown="3")))
            # Reads have their own budget.
            self.ok(await self.tool("list_documents"))
        self.assertEqual(await self.db["documents"].count_documents({}), 2)

    async def test_internal_errors_are_tool_errors(self):
        from app.services import document as doc_service

        with mock.patch.object(doc_service, "list_user_documents", mock.AsyncMock(side_effect=RuntimeError("boom"))):
            text = self.err(await self.tool("list_documents"))
        self.assertIn("went wrong", text)
        self.assertNotIn("boom", text)

    async def test_ref_parsing(self):
        from app.mcp.tools import ToolError, resolve_ref

        for value, slug in (("abc", "abc"), ("/abc", "abc"), ("markdrop.in/abc", "abc"),
                            ("https://www.markdrop.in/abc?x=1#k=key", "abc"),
                            ("https://docs.acme.com/reports/q3/abc", "abc")):
            self.assertEqual(resolve_ref(value), slug)
        for bad in ("", "https://markdrop.in/", "a b"):
            with self.assertRaises(ToolError):
                resolve_ref(bad)


if __name__ == "__main__":
    unittest.main()
