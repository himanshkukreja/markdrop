"""Both addresses by name (owner, 2026-11-10): every item response keeps ``url`` as it was and
also names ``markdrop_url`` (markdrop.in/<slug>, always) and ``domain_url`` (the workspace's
own domain address when that domain is live, else null) — REST, workspace listings and MCP."""

from __future__ import annotations

from tests._access_env import AccessWorld

from app.mcp import tools as mcp_tools


class DualLinks(AccessWorld):
    def ok(self, res):
        self.assertFalse(res["isError"], res["content"][0]["text"])
        return res["structuredContent"]

    async def test_rest_document_names_both(self):
        d = await self.mkdoc("L", folder_path=["guides"])
        body = (await self.get(d["slug"], self.session("owner"))).json()
        self.assertEqual(body["url"], f"https://markdrop.in/{d['slug']}")  # unchanged
        self.assertEqual(body["markdrop_url"], f"https://markdrop.in/{d['slug']}")
        self.assertEqual(body["domain_url"], f"https://docs.acme.test/guides/{d['slug']}")
        self.assertEqual(body["domain_url"], body["workspace_url"])

    async def test_rest_unfiled_has_no_domain(self):
        d = await self.mkdoc("UL")
        body = (await self.get(d["slug"])).json()
        self.assertEqual(body["markdrop_url"], f"https://markdrop.in/{d['slug']}")
        self.assertIsNone(body["domain_url"])

    async def test_workspace_items_name_both(self):
        d = await self.mkdoc("W")
        r = await self.http.get(f"/api/v1/workspaces/{self.ws['W1']}/items?folder=all",
                                headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        row = next(i for i in r.json()["items"] if i.get("slug") == d["slug"])
        self.assertEqual(row["url"], f"https://docs.acme.test/{d['slug']}")  # unchanged: the domain
        self.assertEqual(row["domain_url"], row["url"])
        self.assertEqual(row["markdrop_url"], f"https://markdrop.in/{d['slug']}")

    async def test_mcp_get_and_list_name_both(self):
        d = await self.mkdoc("L")
        token = await self.mcp_token("owner")
        _s, res = await self.mcp_call(token, "get_document", {"document": d["slug"]})
        out = self.ok(res)
        self.assertEqual(out["url"], f"https://docs.acme.test/{d['slug']}")
        self.assertEqual(out["domain_url"], out["url"])
        self.assertEqual(out["markdrop_url"], f"https://markdrop.in/{d['slug']}")
        _s, res = await self.mcp_call(token, "list_documents", {})
        row = next(i for i in self.ok(res)["items"] if i["slug"] == d["slug"])
        self.assertEqual((row["domain_url"], row["markdrop_url"]),
                         (f"https://docs.acme.test/{d['slug']}", f"https://markdrop.in/{d['slug']}"))

    async def test_mcp_unfiled_domain_url_null(self):
        d = await self.mkdoc("UL")
        _s, res = await self.mcp_call(await self.mcp_token("owner"), "get_document", {"document": d["slug"]})
        out = self.ok(res)
        self.assertIsNone(out["domain_url"])
        self.assertEqual(out["url"], out["markdrop_url"])

    def test_mcp_schemas_and_texts_mention_both(self):
        by = {t.name: t for t in mcp_tools.TOOLS}
        for name in ("publish_document", "get_document", "list_documents"):
            schema = by[name].output_schema
            props = schema["properties"]
            if name == "list_documents":
                props = props["items"]["items"]["properties"]
            self.assertIn("domain_url", props, name)
            self.assertIn("markdrop_url", props, name)
        self.assertIn("markdrop_url", by["publish_document"].description)
        from app.mcp import protocol
        self.assertIn("markdrop_url", protocol.INSTRUCTIONS)
        self.assertIn("domain_url", protocol.INSTRUCTIONS)

    def test_with_domain_url_mirrors_nested(self):
        out = mcp_tools.with_domain_url({"workspace_url": "https://a.test/x",
                                         "result": {"workspace_url": None}, "items": [{"workspace_url": "u"}]})
        self.assertEqual(out["domain_url"], "https://a.test/x")
        self.assertIsNone(out["result"]["domain_url"])
        self.assertEqual(out["items"][0]["domain_url"], "u")
        # A result that already says domain_url keeps its own.
        self.assertEqual(mcp_tools.with_domain_url({"workspace_url": "a", "domain_url": "b"})["domain_url"], "b")
