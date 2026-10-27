"""Hosted MCP file tools: create_upload → (curl) → complete_upload, status,
file info, versions and restore, plus get_document / update_document on a
binary file. Handlers are called directly with a tool Context (the JSON-RPC
layer is covered by test_mcp_protocol); arguments go through each tool's input
schema first, as the protocol layer does."""

from __future__ import annotations

import asyncio
import re
from unittest import mock

from tests._files_env import ORIGIN, FakeR2, FilesTestCase, settings, sha
from tests._mcp_env import McpTestCase

from app.mcp import schema, tools
from app.services import media, revalidate
from app.services import user as user_service

DATA = b"mcp-video-bytes" * 300


class McpFiles(FilesTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        user = await user_service.get_user_by_id(self.db, self.user_id)
        other = await user_service.get_user_by_id(self.db, self.other_id)
        self.ctx = tools.Context(db=self.db, user=user, client_id="c", scopes=["documents:read", "documents:write"])
        self.other_ctx = tools.Context(db=self.db, user=other, client_id="c", scopes=["documents:read"])

    async def tool(self, name: str, ctx=None, **args):
        t = tools.BY_NAME[name]
        problem = schema.validate(t.input_schema, args)
        if problem:
            raise tools.ToolError(problem)
        return await t.handler(ctx or self.ctx, args)

    async def err(self, name: str, ctx=None, **args) -> str:
        with self.assertRaises(tools.ToolError) as cm:
            await self.tool(name, ctx, **args)
        return str(cm.exception)

    async def mcp_upload(self, data: bytes, name: str = "demo.mp4", **extra) -> dict:
        text, out = await self.tool("create_upload", file_name=name, size_bytes=len(data),
                                    content_type="video/mp4", sha256=sha(data), **extra)
        parts = await self.send_parts(out["upload_id"], data)
        _t, res = await self.tool("complete_upload", upload_id=out["upload_id"], parts=parts)
        return res

    async def test_create_upload_instructions(self):
        text, out = await self.tool("create_upload", file_name="/Users/me/Movies/My Demo.mp4",
                                    size_bytes=len(DATA), content_type="video/mp4", sha256=sha(DATA))
        self.assertEqual(set(out), {"upload_id", "part_size", "parts", "expires_at", "instructions"})
        self.assertEqual(text, out["instructions"])
        uid = out["upload_id"]
        self.assertIn(f"split -b {out['part_size']} -d -a 4 \"$FILE\" /tmp/md-{uid}.part.", text)
        self.assertIn("FILE='My Demo.mp4'", text)
        curl = [l for l in text.splitlines() if l.startswith("printf")]
        self.assertEqual(len(curl), 1)
        self.assertRegex(curl[0], r"^printf '1 '; curl -sS --fail -X PUT --upload-file "
                                  rf"/tmp/md-{re.escape(uid)}\.part\.0000 'https://r2\.example/[^']+' "
                                  r"-D - -o /dev/null \| grep -i '\^etag'$")
        self.assertIn("complete_upload", text)
        self.assertIn("expire in 60 minutes", text)
        self.assertTrue(isinstance(out["expires_at"], str) and out["expires_at"].endswith("Z"))

    async def test_many_parts_get_one_curl_each(self):
        with mock.patch.object(settings, "file_part_size", 10 * 1024 * 1024):
            _t, out = await self.tool("create_upload", file_name="big.mp4", size_bytes=95 * 1024 * 1024,
                                      sha256="a" * 64)
        lines = [l for l in out["instructions"].splitlines() if l.startswith("printf")]
        self.assertEqual(len(lines), 10)
        self.assertIn(".part.0009 ", lines[-1])
        self.assertTrue(lines[-1].startswith("printf '10 '"))

    async def test_upload_then_replace_then_restore(self):
        res = await self.mcp_upload(DATA, "demo.mp4", title="Demo")
        self.assertEqual((res["state"], res["version"], res["sha256"], res["url"]),
                         ("done", 1, sha(DATA), f"https://markdrop.in/{res['slug']}"))
        slug = res["slug"]
        v2 = b"second-cut" * 400
        res2 = await self.mcp_upload(v2, "demo-final.mp4", target_slug=f"https://markdrop.in/{slug}")
        self.assertEqual((res2["slug"], res2["version"]), (slug, 2))

        text, info = await self.tool("get_file_info", document=slug)
        self.assertEqual((info["version"], info["sha256"], info["content_type"]), (2, sha(v2), "video/mp4"))
        self.assertIn("version 2", text)

        text, vs = await self.tool("list_file_versions", document=slug)
        self.assertEqual([(v["version"], v["current"]) for v in vs["versions"]], [(2, True), (1, False)])
        self.assertIn("v2 (current)", text)

        text, info = await self.tool("restore_file_version", document=slug, version=1)
        self.assertEqual((info["version"], info["sha256"]), (3, sha(DATA)))
        self.assertIn("current again", text)
        self.assertIn("isn't kept", await self.err("restore_file_version", document=slug, version=7))

        # Another user can see a link file's info, but not its versions.
        _t, info = await self.tool("get_file_info", ctx=self.other_ctx, document=slug)
        self.assertEqual(info["version"], 3)
        self.assertIn("only see the versions of", await self.err("list_file_versions", ctx=self.other_ctx,
                                                                 document=slug))

    async def test_complete_reports_verifying(self):
        self.r2.hash_delay = 0.3
        with mock.patch.object(settings, "file_complete_wait_seconds", 0.05):
            _t, out = await self.tool("create_upload", file_name="slow.mp4", size_bytes=len(DATA),
                                      sha256=sha(DATA))
            parts = await self.send_parts(out["upload_id"], DATA)
            text, res = await self.tool("complete_upload", upload_id=out["upload_id"], parts=parts)
            self.assertEqual(res, {"state": "verifying", "upload_id": out["upload_id"]})
            self.assertIn("get_upload_status", text)
            for _ in range(40):
                text, st = await self.tool("get_upload_status", upload_id=out["upload_id"])
                if st["state"] == "done":
                    break
                await asyncio.sleep(0.05)
        self.assertEqual(st["state"], "done")
        self.assertEqual(st["result"]["version"], 1)
        self.assertTrue(text.startswith("Done: https://markdrop.in/"))

    async def test_status_while_uploading_and_errors(self):
        _t, out = await self.tool("create_upload", file_name="a.mp4", size_bytes=len(DATA), sha256=sha(DATA))
        text, st = await self.tool("get_upload_status", upload_id=out["upload_id"])
        self.assertEqual((st["state"], st["parts_uploaded"]), ("uploading", []))
        self.assertIn("0 of 1 received", text)
        self.assertIn("not found", (await self.err("get_upload_status", ctx=self.other_ctx,
                                                   upload_id=out["upload_id"])).lower())
        await self.send_parts(out["upload_id"], DATA)
        # Parts omitted: the parts storage received are used.
        _t, res = await self.tool("complete_upload", upload_id=out["upload_id"])
        self.assertEqual(res["state"], "done")

        _t, bad = await self.tool("create_upload", file_name="b.mp4", size_bytes=len(DATA), sha256="0" * 64)
        await self.send_parts(bad["upload_id"], DATA)
        self.assertIn("sha256 mismatch", await self.err("complete_upload", upload_id=bad["upload_id"]))
        self.assertIn("invalid format", await self.err("complete_upload", upload_id="../etc"))

    async def test_create_upload_refusals(self):
        self.assertIn("Unsupported file type",
                      await self.err("create_upload", file_name="x.exe", size_bytes=10, sha256="a" * 64))
        self.assertIn("2 GB", await self.err("create_upload", file_name="x.mp4", size_bytes=3 * 1024 ** 3,
                                             sha256="a" * 64))
        await self.db["documents"].insert_one({"slug": "my-note", "content": "# x", "edit_secret_hash": "x",
                                               "owner_id": self.user_id, "created_at": self.now(),
                                               "updated_at": self.now()})
        msg = await self.err("create_upload", file_name="x.mp4", size_bytes=10, sha256="a" * 64,
                             target_slug="my-note")
        self.assertIn("markdown document", msg)
        self.assertIn("update_document", msg)
        self.assertIn("couldn't find", await self.err("create_upload", file_name="x.mp4", size_bytes=10,
                                                      sha256="a" * 64, target_slug="no-such-doc"))
        self.assertIn("needs a password", await self.err("create_upload", file_name="x.mp4", size_bytes=10,
                                                         sha256="a" * 64, access="password"))
        with mock.patch.object(settings, "artifact_origin", ""):
            self.assertIn("aren't available", await self.err("create_upload", file_name="x.mp4",
                                                             size_bytes=10, sha256="a" * 64))

    def now(self):
        from datetime import datetime, timezone

        return datetime.now(timezone.utc)

    async def test_get_document_on_a_video_returns_file_info(self):
        res = await self.mcp_upload(DATA, "talk.mp4", title="Talk")
        await self.db["documents"].update_one({"slug": res["slug"]}, {"$set": {"media": {
            "duration_s": 83.2, "width": 3840, "height": 2160, "video_codec": "hevc", "audio_codec": "aac"}}})
        text, out = await self.tool("get_document", document=res["slug"])
        self.assertNotIn("content", out)
        self.assertEqual(out["kind"], "artifact")
        self.assertEqual((out["file"]["version"], out["file"]["sha256"]), (1, sha(DATA)))
        self.assertEqual(out["file"]["media"]["width"], 3840)
        self.assertIn("1:23", text)
        self.assertIn("3840x2160", text)
        self.assertNotIn("not a text file", text)

    async def test_update_document_on_a_binary_points_at_the_upload_tools(self):
        res = await self.mcp_upload(DATA, "clip.mp4")
        msg = await self.err("update_document", document=res["slug"], content="x")
        self.assertIn("isn't a text file", msg)
        self.assertIn("replace_file", msg)
        self.assertIn("create_upload", msg)

    async def test_tool_listing(self):
        new = ("create_upload", "complete_upload", "get_upload_status", "get_file_info",
               "list_file_versions", "restore_file_version")
        for name in new:
            t = tools.BY_NAME[name]
            listing = t.listing()
            self.assertEqual(listing["inputSchema"]["type"], "object")
            self.assertEqual(listing["outputSchema"]["type"], "object")
            self.assertFalse(listing["annotations"]["openWorldHint"])
        reads = {"get_upload_status", "get_file_info", "list_file_versions"}
        for name in new:
            t = tools.BY_NAME[name]
            self.assertEqual(t.scope, "documents:read" if name in reads else "documents:write", name)
            self.assertEqual(t.writes, name not in reads, name)
            self.assertEqual(t.annotations["readOnlyHint"], name in reads, name)
        ann = tools.BY_NAME["restore_file_version"].annotations
        self.assertEqual((ann["destructiveHint"], ann["idempotentHint"]), (False, False))
        from app.mcp import protocol

        for word in ("create_upload", "complete_upload", "replace_file", "markdrop mcp"):
            self.assertIn(word, protocol.INSTRUCTIONS)


class OverJsonRpc(McpTestCase):
    """The same tools through /mcp: scopes, structuredContent, audit. Needs the
    test MongoDB (or MARKDROP_TEST_MONGOMOCK=1), like the other protocol tests."""

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.r2 = FakeR2()
        for p in (*self.r2.patches(), mock.patch.object(settings, "artifact_origin", ORIGIN),
                  mock.patch.object(settings, "artifact_signing_key", "k"),
                  mock.patch.object(media, "schedule", lambda *a, **k: None),
                  mock.patch.object(revalidate, "page", lambda slug: None)):
            p.start()
            self.addCleanup(p.stop)

    async def test_upload_round_trip_and_scopes(self):
        _, tokens = await self.connect()
        token = tokens["access_token"]
        result = await self.call(token, "create_upload", {"file_name": "a.mp4", "size_bytes": len(DATA),
                                                          "sha256": sha(DATA)})
        self.assertFalse(result["isError"], result["content"][0]["text"])
        up = result["structuredContent"]
        self.assertIn("split -b", result["content"][0]["text"])
        sess = await self.db["file_uploads"].find_one({"_id": up["upload_id"]})
        etag = self.r2.put_part(sess["r2_upload_id"], 1, DATA)
        result = await self.call(token, "complete_upload", {"upload_id": up["upload_id"],
                                                            "parts": [{"part_number": 1, "etag": etag}]})
        self.assertFalse(result["isError"], result["content"][0]["text"])
        done = result["structuredContent"]
        self.assertEqual((done["state"], done["version"]), ("done", 1))
        result = await self.call(token, "get_file_info", {"document": done["url"]})
        self.assertEqual(result["structuredContent"]["sha256"], sha(DATA))
        audit = await self.db["mcp_events"].find({"user_id": self.user_id}).to_list(length=10)
        self.assertEqual({a["tool"] for a in audit}, {"create_upload", "complete_upload", "get_file_info"})

        _, read_only = await self.connect(scope="documents:read")
        r = await self.rpc(read_only["access_token"], "tools/call", {
            "name": "create_upload", "arguments": {"file_name": "a.mp4", "size_bytes": 1, "sha256": sha(b"x")}})
        self.assertEqual(r.status_code, 403)
        result = await self.call(read_only["access_token"], "list_file_versions", {"document": done["slug"]})
        self.assertFalse(result["isError"], result["content"][0]["text"])
