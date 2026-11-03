"""MCP tools for pages (app/mcp/page_tools.py): every tool's happy path and its
refusals, and the edit lock's interplay with MCP writes (423 vs append).

The access-policy world (tests/_access_env.py): the test MongoDB (or mongomock),
an in-memory R2. Never backend/.env.
"""

from __future__ import annotations

import base64
import unittest
from datetime import timedelta
from pathlib import Path

from tests._access_env import AccessWorld, now  # noqa: F401  (pins settings first)

from app.mcp import tools as mcp_tools
from app.services import live, viewers
from tests.test_pages import png

PAGE_TOOLS = {"create_page", "get_page", "update_page", "append_blocks", "replace_section", "insert_embed",
              "list_page_templates", "list_subpages", "move_page", "upload_page_image", "set_page_properties",
              "duplicate_page"}


class McpPages(AccessWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        from app.limiter import limiter

        limiter.enabled = False
        self.addCleanup(setattr, limiter, "enabled", True)
        viewers.clear()

    async def call(self, who: str, name: str, args: dict, *, write: bool = True):
        status, res = await self.mcp_call(await self.mcp_token(who, write=write), name, args)
        self.assertEqual(status, 200)
        return res

    async def ok(self, who: str, name: str, args: dict) -> dict:
        res = await self.call(who, name, args)
        self.assertFalse(res["isError"], res["content"][0]["text"])
        return res["structuredContent"]

    async def err(self, who: str, name: str, args: dict) -> str:
        res = await self.call(who, name, args)
        self.assertTrue(res["isError"], res)
        return res["content"][0]["text"]

    async def lock(self, slug: str, who: str):
        r = await self.http.post(f"/api/v1/documents/{slug}/lock", headers=self.session(who))
        self.assertEqual(r.status_code, 200, r.text)

    # ── catalogue ──

    def test_catalogue(self):
        names = {t.name for t in mcp_tools.TOOLS}
        self.assertEqual(len(mcp_tools.TOOLS), 41)
        self.assertTrue(PAGE_TOOLS <= names)
        for t in mcp_tools.TOOLS:
            if t.name in PAGE_TOOLS:
                self.assertEqual(t.writes, t.scope == "documents:write", t.name)

    async def test_read_only_token_cannot_write(self):
        page = await self.mkdoc("UL")
        for name, args in (("create_page", {"title": "x"}),
                           ("append_blocks", {"document": page["slug"], "markdown": "x"}),
                           ("update_page", {"document": page["slug"], "markdown": "x", "base_rev": 1}),
                           ("upload_page_image", {"document": page["slug"], "filename": "a.png",
                                                  "content_base64": "AAAA"})):
            status, _ = await self.mcp_call(await self.mcp_token("owner", write=False), name, args)
            self.assertEqual(status, 403, name)
        self.assertEqual((await self.doc(page["slug"]))["content"], page["content"])

    # ── create_page / list_page_templates ──

    async def test_list_templates(self):
        out = await self.ok("owner", "list_page_templates", {})
        self.assertEqual([t["id"] for t in out["templates"]][-1], "blank")
        self.assertEqual(len(out["templates"]), 7)

    async def test_create_page_from_template(self):
        out = await self.ok("owner", "create_page", {"title": "Runbook: DB", "template": "runbook"})
        raw = await self.doc(out["slug"])
        self.assertEqual((raw["editor"], raw["template_id"]), ("blocks", "runbook"))
        self.assertIn(":::danger", raw["content"])
        self.assertTrue(out["url"].endswith(out["slug"]))

    async def test_create_page_in_workspace_and_inside_a_page(self):
        out = await self.ok("wm", "create_page", {"title": "Spec", "workspace": "Acme"})
        self.assertEqual((await self.doc(out["slug"]))["workspace_id"], self.ws["W1"])
        self.assertTrue(out["url"].startswith("https://docs.acme.test/"))
        child = await self.ok("wm", "create_page", {"title": "Child", "parent": out["slug"]})
        raw = await self.doc(child["slug"])
        self.assertEqual(raw["page_path"], [out["slug"]])
        self.assertTrue(raw["access_inherit"])
        self.assertEqual(child["url"], f"https://docs.acme.test/{out['slug']}/{child['slug']}")

    async def test_create_page_refusals(self):
        self.assertIn("viewer", await self.err("wv", "create_page", {"title": "x", "workspace": "Acme"}))
        parent = await self.mkdoc("P")
        self.assertIn("parent", await self.err("owner", "create_page", {"title": "x", "parent": parent["slug"],
                                                                         "workspace": "Acme"}))
        self.assertIn("couldn't find", await self.err("stranger", "create_page", {"title": "x",
                                                                                "parent": parent["slug"]}))
        self.assertIn("can edit", await self.err("gv", "create_page", {"title": "x", "parent": parent["slug"]}))
        res = await self.call("owner", "create_page", {"title": "x", "template": "nope"})
        self.assertTrue(res["isError"])
        self.assertEqual(await self.db["documents"].count_documents({"title": "x"}), 0)

    # ── get_page ──

    async def test_get_page_resolves_for_the_caller(self):
        visible = await self.mkdoc("UL", title="Visible doc")
        hidden = await self.mkdoc("UP", owner="wm", grants=False, title="Secret plan")
        page = await self.mkdoc("UL")
        info = (await self.http.post(f"/api/v1/documents/{page['slug']}/assets",
                                     files={"file": ("a.png", png(), "image/png")},
                                     headers=self.session("owner"))).json()
        content = (f"# Page\n\n::markdrop{{src=\"{visible['slug']}\" mode=\"card\"}}\n\n"
                   f"See :markdrop[Secret plan]{{src=\"{hidden['slug']}\"}}\n\n![x](asset:{info['id']})\n")
        await self.db["documents"].update_one({"_id": page["_id"]}, {"$set": {"content": content, "rev": 3}})
        child = await self.ok("owner", "create_page", {"title": "Kid", "parent": page["slug"]})
        out = await self.ok("stranger", "get_page", {"document": page["slug"]})
        self.assertEqual(out["rev"], 3)
        # The mention of an item the stranger can't open has no label (BUGS.md #1).
        self.assertEqual(out["markdown"], content.replace(":markdrop[Secret plan]", ":markdrop[]"))
        self.assertNotIn("Secret plan", str(out))
        # The item's own owner can open it: the label stays. (The page's owner can't, so theirs is empty.)
        self.assertEqual((await self.ok("wm", "get_page", {"document": page["slug"]}))["markdown"], content)
        self.assertEqual(out["editor"], "classic")
        self.assertEqual(out["children"], [{"slug": child["slug"], "title": "Kid"}])
        self.assertEqual(out["embeds"][0], {"slug": visible["slug"], "as": "embed", "state": "ok",
                                            "title": "Visible doc", "kind": "document",
                                            "url": f"https://markdrop.in/{visible['slug']}"})
        self.assertEqual(out["embeds"][1], {"slug": hidden["slug"], "as": "link", "state": "missing"})
        self.assertEqual([a["id"] for a in out["assets"]], [info["id"]])
        kid = await self.ok("stranger", "get_page", {"document": child["slug"]})
        self.assertEqual(kid["parent"], {"slug": page["slug"], "title": page["title"], "icon": None, "icon_url": None})

    async def test_get_page_refusals(self):
        private = await self.mkdoc("UP")
        self.assertIn("couldn't find", await self.err("stranger", "get_page", {"document": private["slug"]}))
        enc = await self.mkdoc("UL", encrypted=True, content="mdx1.aaaaaaaaaaaaaaaaaaaa.bbbb")
        self.assertIn("encrypted", await self.err("owner", "get_page", {"document": enc["slug"]}))
        art = await self.mkdoc("UL", kind="artifact")
        self.assertIn("file", await self.err("owner", "get_page", {"document": art["slug"]}))
        pw = await self.mkdoc("ULP")
        self.assertIn("password", await self.err("stranger", "get_page", {"document": pw["slug"]}))

    # ── update_page, replace_section, append_blocks and the lock ──

    async def test_update_page(self):
        page = await self.mkdoc("UP")
        out = await self.ok("ge", "update_page", {"document": page["slug"], "markdown": "# v2", "base_rev": 1})
        self.assertEqual(out["rev"], 2)
        self.assertIn("revision 1", await self.err("ge", "update_page", {"document": page["slug"],
                                                                         "markdown": "# v3", "base_rev": 1}))
        self.assertIn("can edit", await self.err("gv", "update_page", {"document": page["slug"],
                                                                       "markdown": "x", "base_rev": 2}))
        self.assertIn("couldn't find", await self.err("stranger", "update_page", {"document": page["slug"],
                                                                                 "markdown": "x", "base_rev": 2}))
        self.assertEqual((await self.doc(page["slug"]))["content"], "# v2")

    async def test_lock_refuses_mcp_writes_except_append(self):
        page = await self.mkdoc("UP")
        await self.db["documents"].update_one({"_id": page["_id"]},
                                              {"$set": {"content": "# Top\n\n## Rollout\n\nold\n"}})
        await self.lock(page["slug"], "ge")
        for name, args in (("update_page", {"markdown": "x", "base_rev": 1}),
                           ("replace_section", {"heading": "Rollout", "markdown": "new"}),
                           ("insert_embed", {"item": page["slug"], "after_heading": "Rollout"})):
            text = await self.err("owner", name, {"document": page["slug"], **args})
            self.assertIn("GE is editing this page", text, name)
        # Even the lock holder's own assistant waits: their open editor would overwrite it.
        self.assertIn("editing", await self.err("ge", "update_page", {"document": page["slug"],
                                                                      "markdown": "x", "base_rev": 1}))
        q = live.subscribe(page["slug"])
        try:
            out = await self.ok("owner", "append_blocks", {"document": page["slug"], "markdown": "- [ ] new task"})
            events = [q.get_nowait() for _ in range(q.qsize())]
        finally:
            live.unsubscribe(page["slug"], q)
        self.assertEqual(events[0], {"type": "appended", "rev": out["rev"], "markdown": "- [ ] new task"})
        self.assertEqual(events[1], {"type": "changed", "rev": out["rev"]})
        self.assertEqual((await self.doc(page["slug"]))["content"], "# Top\n\n## Rollout\n\nold\n\n- [ ] new task\n")
        # insert_embed at the end behaves as an append, so it works too.
        item = await self.mkdoc("UL")
        await self.ok("owner", "insert_embed", {"document": page["slug"], "item": item["slug"]})
        # The lock gone (expired), everything works again.
        await self.db["documents"].update_one({"_id": page["_id"]},
                                              {"$set": {"edit_lock.expires_at": now() - timedelta(seconds=1)}})
        await self.ok("owner", "replace_section", {"document": page["slug"], "heading": "Rollout", "markdown": "new"})

    async def test_get_page_says_who_is_editing(self):
        page = await self.mkdoc("UP")
        await self.lock(page["slug"], "ge")
        res = await self.call("owner", "get_page", {"document": page["slug"]})
        self.assertEqual(res["structuredContent"]["editing"], "GE")
        self.assertIn("append_blocks still works", res["content"][0]["text"])

    async def test_replace_section(self):
        page = await self.mkdoc("UP")
        md = "# Doc\n\n## Steps\n\n1. a\n\n### Detail\n\nd\n\n## After\n\nz\n\n```\n## Steps\n```\n"
        await self.db["documents"].update_one({"_id": page["_id"]}, {"$set": {"content": md}})
        await self.ok("owner", "replace_section", {"document": page["slug"], "heading": "steps",
                                                   "markdown": "1. b\n2. c"})
        self.assertEqual((await self.doc(page["slug"]))["content"],
                         "# Doc\n\n## Steps\n\n1. b\n2. c\n\n## After\n\nz\n\n```\n## Steps\n```\n")
        await self.ok("owner", "replace_section", {"document": page["slug"], "heading": "## After",
                                                   "markdown": "## Later\n\ny"})
        # The fenced "## Steps" isn't a heading: the After section ran to the end.
        self.assertEqual((await self.doc(page["slug"]))["content"],
                         "# Doc\n\n## Steps\n\n1. b\n2. c\n\n## Later\n\ny\n")
        text = await self.err("owner", "replace_section", {"document": page["slug"], "heading": "Nope",
                                                           "markdown": "x"})
        self.assertIn("no heading", text)
        self.assertIn("Steps", text)
        self.assertIn("can edit", await self.err("gv", "replace_section", {"document": page["slug"],
                                                                           "heading": "Steps", "markdown": "x"}))

    async def test_append_refusals(self):
        page = await self.mkdoc("UP")
        self.assertIn("can edit", await self.err("gv", "append_blocks", {"document": page["slug"], "markdown": "x"}))
        self.assertIn("couldn't find", await self.err("stranger", "append_blocks",
                                                      {"document": page["slug"], "markdown": "x"}))
        enc = await self.mkdoc("UL", encrypted=True, content="mdx1.aaaaaaaaaaaaaaaaaaaa.bbbb")
        self.assertIn("encrypted", await self.err("owner", "append_blocks", {"document": enc["slug"], "markdown": "x"}))
        self.assertIn("Nothing", await self.err("owner", "append_blocks", {"document": page["slug"], "markdown": "  "}))

    # ── insert_embed ──

    async def test_insert_embed_and_mention(self):
        page = await self.mkdoc("UP")
        await self.db["documents"].update_one({"_id": page["_id"]},
                                              {"$set": {"content": "# P\n\n## Files\n\nx\n\n## End\n"}})
        art = await self.mkdoc("UP", kind="artifact", title="Deck")
        doc = await self.mkdoc("UL", title="Plan")
        out = await self.ok("owner", "insert_embed", {"document": page["slug"], "item": art["slug"],
                                                      "after_heading": "Files"})
        self.assertEqual(out["markdown"], f'::markdrop{{src="{art["slug"]}" mode="live"}}')
        out = await self.ok("owner", "insert_embed", {"document": page["slug"], "item": doc["slug"], "as": "link"})
        self.assertEqual(out["markdown"], f':markdrop[Plan]{{src="{doc["slug"]}"}}')
        content = (await self.doc(page["slug"]))["content"]
        self.assertEqual(content, (f"# P\n\n## Files\n\nx\n\n::markdrop{{src=\"{art['slug']}\" mode=\"live\"}}\n\n"
                                   f"## End\n\n:markdrop[Plan]{{src=\"{doc['slug']}\"}}\n"))
        out = await self.ok("owner", "insert_embed", {"document": page["slug"], "item": doc["slug"], "mode": "preview"})
        self.assertIn('mode="preview"', out["markdown"])
        # The page's readers who can't open the item get a placeholder: the tool says so.
        res = await self.call("owner", "insert_embed", {"document": page["slug"], "item": art["slug"]})
        self.assertIn("locked placeholder", res["content"][0]["text"])

    async def test_insert_embed_refusals(self):
        page = await self.mkdoc("UL", owner="stranger", grants=False)
        hidden = await self.mkdoc("UP", grants=False)
        self.assertIn("couldn't find", await self.err("stranger", "insert_embed",
                                                      {"document": page["slug"], "item": hidden["slug"]}))
        self.assertNotIn(hidden["slug"], (await self.doc(page["slug"]))["content"])
        self.assertIn("no heading", await self.err("stranger", "insert_embed",
                                                   {"document": page["slug"], "item": page["slug"],
                                                    "after_heading": "Nope"}))
        mine = await self.mkdoc("UL")
        self.assertIn("own or can edit", await self.err("stranger", "insert_embed",
                                                        {"document": mine["slug"], "item": page["slug"]}))

    # ── sub-pages ──

    async def test_list_subpages_and_move(self):
        public = await self.mkdoc("UL", grants=False)
        private = await self.mkdoc("UP", grants=False)
        a = await self.ok("owner", "create_page", {"title": "A", "parent": public["slug"]})
        b = await self.ok("owner", "create_page", {"title": "B", "parent": public["slug"]})
        await self.http.put(f"/api/v1/documents/{b['slug']}/access/level", json={"level": "private"},
                            headers=self.session("owner"))
        out = await self.ok("stranger", "list_subpages", {"document": public["slug"]})
        self.assertEqual([c["slug"] for c in out["children"]], [a["slug"]])
        out = await self.ok("owner", "list_subpages", {"document": public["slug"]})
        self.assertEqual(len(out["children"]), 2)
        self.assertIn("couldn't find", await self.err("stranger", "list_subpages", {"document": private["slug"]}))
        text = await self.err("owner", "move_page", {"document": a["slug"], "parent": private["slug"]})
        self.assertIn("anyone with the link", text)
        self.assertIn("confirm_access_change", text)
        self.assertEqual((await self.get(a["slug"])).status_code, 200)
        await self.ok("owner", "move_page", {"document": a["slug"], "parent": private["slug"],
                                             "confirm_access_change": True})
        self.assertEqual((await self.get(a["slug"])).status_code, 401)
        await self.ok("owner", "move_page", {"document": a["slug"], "parent": None, "confirm_access_change": True})
        self.assertIsNone((await self.doc(a["slug"]))["parent_id"])
        self.assertIn("inside itself", await self.err("owner", "move_page", {"document": a["slug"], "parent": a["slug"]}))
        self.assertIn("couldn't find", await self.err("stranger", "move_page", {"document": private["slug"],
                                                                               "parent": None}))

    async def test_delete_with_children(self):
        page = await self.mkdoc("UL")
        kid = await self.ok("owner", "create_page", {"title": "K", "parent": page["slug"]})
        self.assertIn("children=delete", await self.err("owner", "delete_document", {"document": page["slug"]}))
        await self.ok("owner", "delete_document", {"document": page["slug"], "children": "lift"})
        self.assertIsNone((await self.doc(kid["slug"]))["parent_id"])

    # ── page properties ──

    async def test_set_page_properties_and_get(self):
        page = await self.mkdoc("W")
        img = await self.ok("owner", "upload_page_image", {"document": page["slug"], "filename": "c.png",
                                                           "content_base64": base64.b64encode(png()).decode()})
        out = await self.ok("wm", "set_page_properties", {"document": page["slug"], "icon": "🚀",
                                                          "cover": f"asset:{img['id']}", "cover_y": 30,
                                                          "full_width": True, "font": "mono"})
        self.assertEqual(out["properties"]["font"], "mono")
        raw = await self.doc(page["slug"])
        self.assertTrue(raw["content"].startswith(f"---\nicon: 🚀\ncover: asset:{img['id']}\ncover_y: 30\n"))
        got = await self.ok("wv", "get_page", {"document": page["slug"]})
        self.assertEqual(got["properties"]["icon"], "🚀")
        self.assertTrue(got["properties"]["full_width"])
        self.assertIn(img["id"], [a["id"] for a in got["assets"]])
        await self.ok("wm", "set_page_properties", {"document": page["slug"], "icon": None, "full_width": None})
        self.assertNotIn("icon:", (await self.doc(page["slug"]))["content"])
        self.assertIn("isn't an image of this page", await self.err("wm", "set_page_properties", {
            "document": page["slug"], "cover": "asset:0123456789abcdef01234567"}))
        self.assertIn("font", await self.err("wm", "set_page_properties", {"document": page["slug"], "font": "comic"}))
        self.assertIn("Nothing to change", await self.err("wm", "set_page_properties", {"document": page["slug"]}))
        self.assertIn("can edit", await self.err("wv", "set_page_properties", {"document": page["slug"], "icon": "x"}))

    async def test_locked_page_via_mcp(self):
        page = await self.mkdoc("W")
        self.assertIn("owner or a workspace admin", await self.err("wm", "set_page_properties",
                                                                   {"document": page["slug"], "locked": True}))
        await self.ok("owner", "set_page_properties", {"document": page["slug"], "locked": True})
        for name, args in (("append_blocks", {"markdown": "x"}),
                           ("update_page", {"markdown": "x", "base_rev": 2}),
                           ("set_page_properties", {"icon": "x"}),
                           ("upload_page_image", {"filename": "a.png",
                                                  "content_base64": base64.b64encode(png()).decode()})):
            self.assertIn("locked", await self.err("wm", name, {"document": page["slug"], **args}), name)
        await self.ok("wa", "append_blocks", {"document": page["slug"], "markdown": "admin note"})
        await self.ok("owner", "set_page_properties", {"document": page["slug"], "locked": False})
        await self.ok("wm", "append_blocks", {"document": page["slug"], "markdown": "member note"})

    async def test_create_page_with_properties(self):
        out = await self.ok("owner", "create_page", {"title": "P", "template": "prd",
                                                     "properties": {"icon": "📘", "full_width": True}})
        raw = await self.doc(out["slug"])
        self.assertTrue(raw["content"].startswith("---\nicon: 📘\nfull_width: true\n---\n:::note"))
        self.assertEqual(raw["template_id"], "prd")
        self.assertIn("upload_page_image", await self.err("owner", "create_page", {
            "title": "Q", "properties": {"cover": "asset:0123456789abcdef01234567"}}))

    # ── upload_page_image ──

    async def test_upload_page_image(self):
        page = await self.mkdoc("UP")
        b64 = base64.b64encode(png()).decode()
        out = await self.ok("ge", "upload_page_image", {"document": page["slug"], "filename": "shot [1].png",
                                                        "content_base64": b64})
        self.assertEqual(out["markdown"], f"![shot  1](asset:{out['id']})")
        self.assertEqual((out["width"], out["height"]), (3, 2))
        out2 = await self.ok("owner", "upload_page_image", {"document": page["slug"], "filename": "b.png",
                                                            "content_base64": "data:image/png;base64," + b64})
        self.assertNotEqual(out2["id"], out["id"])
        self.assertIn("base64", await self.err("owner", "upload_page_image",
                                               {"document": page["slug"], "filename": "a.png",
                                                "content_base64": "%%%%"}))
        self.assertIn("PNG", await self.err("owner", "upload_page_image",
                                            {"document": page["slug"], "filename": "a.svg",
                                             "content_base64": base64.b64encode(b"<svg/>").decode()}))
        self.assertIn("can edit", await self.err("gv", "upload_page_image",
                                                 {"document": page["slug"], "filename": "a.png",
                                                  "content_base64": b64}))
        self.assertIn("couldn't find", await self.err("stranger", "upload_page_image",
                                                      {"document": page["slug"], "filename": "a.png",
                                                       "content_base64": b64}))
        self.assertEqual(await self.db["page_assets"].count_documents({}), 2)


class PageSyntax(unittest.TestCase):
    """PAGE_SYNTAX names every construct the page editor writes, and so does the docs page. (That
    each one round-trips through the editor is frontend/src/components/docs-editor/test/
    pageSyntax.test.mjs.)"""

    CONSTRUCTS = ["- [ ]", "```mermaid", "$$", ":::note", ":::details", "heading=2", ":span[", "color=",
                  "bg=", ":u[", "#b-", "caption=", "header-column", "widths=", "header-row", "::::columns",
                  ":::column", ":::indent", ":::button", "asset:", "width=", "align=", "::markdrop{",
                  ":markdrop[", "::page{", "::toc", "::breadcrumb", "::bookmark{", "::embed{", ":person[",
                  ":date[", ":kbd[", "set_page_properties"]

    def test_page_syntax_names_every_construct(self):
        from app.mcp.page_tools import PAGE_SYNTAX

        self.assertEqual([c for c in self.CONSTRUCTS if c not in PAGE_SYNTAX], [])
        self.assertNotIn("TODO", PAGE_SYNTAX)

    def test_the_reference_page_names_them_too(self):
        ref = (Path(__file__).resolve().parents[2] / "frontend" / "content" / "docs" / "pages"
               / "markdown-reference.md").read_text()
        self.assertEqual([c for c in self.CONSTRUCTS if c != "set_page_properties" and c not in ref], [])
