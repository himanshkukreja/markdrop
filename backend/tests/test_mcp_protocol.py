"""/mcp transport and JSON-RPC: both protocol eras, header validation, origin
checks, auth challenges and scope enforcement."""

from __future__ import annotations

import base64
import unittest

from tests._mcp_env import RESOURCE, McpTestCase

MODERN = "2026-07-28"
META = {
    "io.modelcontextprotocol/protocolVersion": MODERN,
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": {"name": "test", "version": "1"},
}


class Transport(McpTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        _, tokens = await self.connect()
        self.token = tokens["access_token"]

    async def modern(self, method: str, params: dict | None = None, *, headers: dict | None = None,
                     meta: dict | None = None):
        p = {**(params or {}), "_meta": meta if meta is not None else META}
        h = {"MCP-Protocol-Version": MODERN, "Mcp-Method": method}
        if method == "tools/call":
            h["Mcp-Name"] = p.get("name", "")
        h.update(headers or {})
        h = {k: v for k, v in h.items() if v is not None}
        return await self.rpc(self.token, method, p, headers=h)

    # ── auth ──

    async def test_unauthenticated_challenge(self):
        r = await self.http.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
        self.assertEqual(r.status_code, 401)
        challenge = r.headers["www-authenticate"]
        self.assertTrue(challenge.startswith("Bearer "))
        self.assertIn('resource_metadata="https://api.markdrop.in/.well-known/oauth-protected-resource/mcp"', challenge)
        self.assertIn('scope="documents:read documents:write"', challenge)
        self.assertNotIn("error=", challenge)
        r = await self.rpc("mdat_bogus", "ping")
        self.assertEqual(r.status_code, 401)
        self.assertIn('error="invalid_token"', r.headers["www-authenticate"])

    async def test_read_only_token_cannot_write(self):
        _, tokens = await self.connect(scope="documents:read")
        r = await self.rpc(tokens["access_token"], "tools/call",
                           {"name": "publish_document", "arguments": {"markdown": "# hi"}}, id_=7)
        self.assertEqual(r.status_code, 403)
        self.assertIn('error="insufficient_scope"', r.headers["www-authenticate"])
        self.assertIn('scope="documents:write"', r.headers["www-authenticate"])
        self.assertEqual(r.json()["id"], 7)
        self.assertEqual(await self.db["documents"].count_documents({}), 0)
        r = await self.rpc(tokens["access_token"], "tools/call", {"name": "list_documents", "arguments": {}})
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["result"]["isError"])

    async def test_write_only_token_cannot_read(self):
        _, tokens = await self.connect(scope="documents:write")
        r = await self.rpc(tokens["access_token"], "tools/call", {"name": "list_documents", "arguments": {}})
        self.assertEqual(r.status_code, 403)
        self.assertIn('scope="documents:read"', r.headers["www-authenticate"])

    async def test_origin(self):
        r = await self.rpc(self.token, "ping", headers={"Origin": "https://evil.example"})
        self.assertEqual(r.status_code, 403)
        for ok in ("https://claude.ai", "https://chatgpt.com", "http://localhost:6274", "https://markdrop.in"):
            r = await self.rpc(self.token, "ping", headers={"Origin": ok})
            self.assertEqual(r.status_code, 200, ok)

    # ── handshake era ──

    async def test_initialize_negotiation(self):
        for asked, expected in (("2025-06-18", "2025-06-18"), ("2025-11-25", "2025-11-25"),
                                ("2025-03-26", "2025-03-26"), ("2099-01-01", "2025-11-25"),
                                ("2026-07-28", "2025-11-25")):
            r = await self.rpc(self.token, "initialize", {
                "protocolVersion": asked, "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}})
            self.assertEqual(r.status_code, 200)
            self.assertNotIn("mcp-session-id", r.headers)
            self.assertEqual(r.headers["content-type"], "application/json")
            result = r.json()["result"]
            self.assertEqual(result["protocolVersion"], expected, asked)
            self.assertEqual(result["capabilities"], {"tools": {"listChanged": False}})
            self.assertEqual(result["serverInfo"]["name"], "markdrop")
            self.assertEqual(result["serverInfo"]["title"], "Markdrop")
            self.assertIn("publish_document", result["instructions"])

    async def test_notifications_get_202(self):
        r = await self.http.post("/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"},
                                 headers={"Authorization": f"Bearer {self.token}", "Mcp-Session-Id": "abc"})
        self.assertEqual(r.status_code, 202)
        self.assertEqual(r.content, b"")

    async def test_get_and_delete_are_405(self):
        self.assertEqual((await self.http.get("/mcp")).status_code, 405)
        self.assertEqual((await self.http.delete("/mcp")).status_code, 405)

    async def test_tools_list(self):
        r = await self.rpc(self.token, "tools/list")
        tools = {t["name"]: t for t in r.json()["result"]["tools"]}
        self.assertEqual(set(tools), {
            "publish_document", "publish_page", "update_document", "get_document", "list_documents",
            "set_access", "delete_document", "get_document_stats", "search", "fetch",
            "list_shares", "get_share_status"})
        for t in tools.values():
            self.assertEqual(t["inputSchema"]["type"], "object")
            self.assertEqual(t["outputSchema"]["type"], "object")
            ann = t["annotations"]
            self.assertFalse(ann["openWorldHint"])
            self.assertEqual(set(ann), {"title", "readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"})
        self.assertTrue(tools["delete_document"]["annotations"]["destructiveHint"])
        self.assertTrue(tools["get_document"]["annotations"]["readOnlyHint"])
        self.assertFalse(tools["publish_document"]["annotations"]["readOnlyHint"])

    async def test_empty_lists_and_unknown_method(self):
        self.assertEqual((await self.rpc(self.token, "resources/list")).json()["result"], {"resources": []})
        self.assertEqual((await self.rpc(self.token, "prompts/list")).json()["result"], {"prompts": []})
        r = await self.rpc(self.token, "sampling/whatever")
        self.assertEqual(r.json()["error"]["code"], -32601)

    async def test_malformed(self):
        r = await self.http.post("/mcp", content=b"{nope", headers={"Authorization": f"Bearer {self.token}"})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["error"]["code"], -32700)
        r = await self.http.post("/mcp", json=[{"jsonrpc": "2.0", "id": 1, "method": "ping"}],
                                 headers={"Authorization": f"Bearer {self.token}"})
        self.assertEqual(r.json()["error"]["code"], -32600)

    async def test_bad_version_header_on_handshake_request(self):
        r = await self.rpc(self.token, "tools/list", headers={"MCP-Protocol-Version": "1999-01-01"})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["error"]["code"], -32022)

    async def test_unknown_tool(self):
        r = await self.rpc(self.token, "tools/call", {"name": "nope", "arguments": {}})
        self.assertEqual(r.json()["error"]["code"], -32602)

    # ── envelope era ──

    async def test_discover(self):
        r = await self.modern("server/discover")
        self.assertEqual(r.status_code, 200, r.text)
        result = r.json()["result"]
        self.assertEqual(result["resultType"], "complete")
        self.assertIn(MODERN, result["supportedVersions"])
        self.assertIn("2025-11-25", result["supportedVersions"])
        self.assertEqual(result["capabilities"], {"tools": {"listChanged": False}})
        self.assertEqual(result["_meta"]["io.modelcontextprotocol/serverInfo"]["name"], "markdrop")
        self.assertIn("instructions", result)
        self.assertEqual((result["cacheScope"], result["ttlMs"]), ("public", 300000))

    async def test_modern_tools_list_and_call(self):
        r = await self.modern("tools/list")
        self.assertEqual(r.json()["result"]["resultType"], "complete")
        self.assertEqual(len(r.json()["result"]["tools"]), 12)
        r = await self.modern("tools/call", {"name": "list_documents", "arguments": {}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["result"]["resultType"], "complete")
        encoded = "=?base64?" + base64.b64encode(b"list_documents").decode() + "?="
        r = await self.modern("tools/call", {"name": "list_documents", "arguments": {}},
                              headers={"Mcp-Name": encoded})
        self.assertEqual(r.status_code, 200, r.text)

    async def test_header_mismatches(self):
        cases = [
            ("tools/list", {}, {"MCP-Protocol-Version": None}),
            ("tools/list", {}, {"MCP-Protocol-Version": "2025-11-25"}),
            ("tools/list", {}, {"Mcp-Method": "tools/call"}),
            ("tools/list", {}, {"Mcp-Method": None}),
            ("tools/call", {"name": "list_documents", "arguments": {}}, {"Mcp-Name": "search"}),
            ("tools/call", {"name": "list_documents", "arguments": {}}, {"Mcp-Name": None}),
            ("tools/call", {"name": "list_documents", "arguments": {}}, {"Mcp-Name": "=?base64?!!!?="}),
        ]
        for method, params, headers in cases:
            r = await self.modern(method, params, headers=headers)
            self.assertEqual(r.status_code, 400, (method, headers))
            self.assertEqual(r.json()["error"]["code"], -32020, (method, headers))

    async def test_unsupported_modern_version(self):
        meta = {**META, "io.modelcontextprotocol/protocolVersion": "2030-01-01"}
        r = await self.modern("tools/list", meta=meta, headers={"MCP-Protocol-Version": "2030-01-01"})
        self.assertEqual(r.status_code, 400)
        err = r.json()["error"]
        self.assertEqual(err["code"], -32022)
        self.assertEqual(err["data"]["requested"], "2030-01-01")
        self.assertIn(MODERN, err["data"]["supported"])

    async def test_modern_unknown_method_is_404(self):
        r = await self.modern("nope/nothing")
        self.assertEqual(r.status_code, 404)
        self.assertEqual(r.json()["error"]["code"], -32601)

    async def test_modern_missing_capabilities(self):
        meta = {"io.modelcontextprotocol/protocolVersion": MODERN}
        r = await self.modern("tools/list", meta=meta)
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["error"]["code"], -32602)

    async def test_modern_notification_202(self):
        r = await self.http.post("/mcp", json={"jsonrpc": "2.0", "method": "notifications/cancelled",
                                               "params": {"_meta": META}},
                                 headers={"Authorization": f"Bearer {self.token}"})
        self.assertEqual(r.status_code, 202)

    async def test_resource_constant(self):
        self.assertEqual(RESOURCE, "https://api.markdrop.in/mcp")


if __name__ == "__main__":
    unittest.main()
