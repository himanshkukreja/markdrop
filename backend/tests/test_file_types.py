"""My files › filter by type (feat/files-type-filter).

The type mapping (every whitelisted artifact MIME lands in exactly one type,
by its renderer), `GET /me/documents?type=` combined with search, kind and
paging, the per-type counts (one aggregate, owner's rows only), and MCP
list_documents' `type` across scopes — never a row the caller can't read.
"""

from __future__ import annotations

import unittest

from tests._access_env import AccessWorld

from app.services import artifact, file_types

MIME = {
    "pdf": "application/pdf",
    "video": "video/mp4",
    "mov": "video/quicktime",
    "image": "image/png",
    "svg": "image/svg+xml",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "csv": "text/csv",
    "pptx": artifact.PPTX_MIME,
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "html": "text/html",
    "zip": "application/zip",
    "json": "application/json",
    "mp3": "audio/mpeg",
}


class Mapping(unittest.TestCase):
    def test_every_whitelisted_mime_has_one_type(self):
        expected = {"html": "html", "pdf": "pdf", "sheet": "sheet", "docx": "word", "pptx": "slides",
                    "bundle": "html", "text": "other", "image": "image", "video": "video",
                    "audio": "other"}
        for t in artifact._TYPES:
            self.assertEqual(file_types.type_of("artifact", t.mime), expected[t.renderer], t.mime)

    def test_documents_and_unknowns(self):
        self.assertEqual(file_types.type_of("markdown", None), "document")
        self.assertEqual(file_types.type_of(None, None), "document")  # pre-artifact documents
        self.assertEqual(file_types.type_of("artifact", None), "other")
        self.assertEqual(file_types.type_of("artifact", "application/x-unknown"), "other")

    def test_clauses(self):
        self.assertIsNone(file_types.type_clause(None))
        self.assertIsNone(file_types.type_clause("all"))
        self.assertEqual(file_types.type_clause("document"), {"kind": {"$ne": "artifact"}})
        self.assertEqual(file_types.type_clause("slides"),
                         {"kind": "artifact", "mime": {"$in": [artifact.PPTX_MIME]}})
        other = file_types.type_clause("other")
        self.assertIn("text/html", other["mime"]["$nin"])
        self.assertNotIn("audio/mpeg", other["mime"]["$nin"])
        with self.assertRaises(ValueError):
            file_types.type_clause("spreadsheet")

    def test_fold_counts(self):
        rows = [{"_id": {"kind": "markdown", "mime": None}, "n": 3},
                {"_id": {"kind": "artifact", "mime": "video/mp4"}, "n": 2},
                {"_id": {"kind": "artifact", "mime": "video/webm"}, "n": 1},
                {"_id": {"kind": "artifact", "mime": None}, "n": 1}]
        c = file_types.counts_from_groups(rows)
        self.assertEqual((c["document"], c["video"], c["other"], c["pdf"]), (3, 3, 1, 0))
        self.assertEqual(set(c), set(file_types.FILE_TYPES))


class World(AccessWorld):
    async def art(self, mime_key: str, *, owner: str = "owner", ws: str | None = None, state: str = "UL",
                  **extra) -> dict:
        d = await self.mkdoc(state, owner=owner, ws=ws, kind="artifact", grants=False, **extra)
        await self.db["documents"].update_one({"_id": d["_id"]}, {"$set": {"mime": MIME[mime_key]}})
        return d

    async def seed(self):
        """owner: 2 docs (one a page), 1 pdf, 2 videos, 1 image, 1 svg, 1 xlsx, 1 csv, 1 pptx,
        1 docx, 1 html, 1 bundle, 1 json + 1 audio (other). Plus a stranger's pdf and video."""
        await self.mkdoc("UL", grants=False, slug="roadmap-doc", title="Roadmap notes")
        await self.mkdoc("UL", grants=False, editor="blocks", slug="team-page")
        await self.art("pdf", slug="roadmap-pdf", title="Roadmap PDF")
        await self.art("video", slug="demo-video", title="Roadmap walkthrough")
        await self.art("mov", slug="phone-clip")
        for k in ("image", "svg", "xlsx", "csv", "pptx", "docx", "html", "json", "mp3"):
            await self.art(k, slug=f"f-{k}")
        await self.mkdoc("UL", owner="owner", ws=None, kind="artifact", grants=False, bundle=True,
                         slug="site-bundle")
        await self.db["documents"].update_one({"slug": "site-bundle"}, {"$set": {"mime": MIME["zip"]}})
        # Someone else's files: never in the owner's list or counts.
        await self.art("pdf", owner="stranger", slug="their-pdf")
        await self.art("video", owner="stranger", slug="their-video")

    async def mine(self, who: str = "owner", **params):
        r = await self.http.get("/api/v1/me/documents", params=params, headers=self.session(who))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()


class MyFilesByType(World):
    async def test_counts_cover_only_my_rows_in_one_shape(self):
        await self.seed()
        body = await self.mine()
        c = body["count_by_type"]
        self.assertEqual(c, {"document": 2, "pdf": 1, "video": 2, "image": 2, "sheet": 2,
                             "slides": 1, "word": 1, "html": 2, "other": 2})
        self.assertEqual(body["count_all"], sum(c.values()))
        self.assertEqual(body["count_markdown"], 2)
        self.assertEqual(body["count_artifact"], 13)
        # Counts are the library's, not the filter's.
        self.assertEqual((await self.mine(type="video"))["count_by_type"], c)
        # The stranger sees only their own.
        theirs = (await self.mine("stranger"))["count_by_type"]
        self.assertEqual((theirs["pdf"], theirs["video"], theirs["document"]), (1, 1, 0))

    async def test_each_type_returns_exactly_its_rows(self):
        await self.seed()
        expect = {
            "document": {"roadmap-doc", "team-page"},
            "pdf": {"roadmap-pdf"},
            "video": {"demo-video", "phone-clip"},
            "image": {"f-image", "f-svg"},
            "sheet": {"f-xlsx", "f-csv"},
            "slides": {"f-pptx"},
            "word": {"f-docx"},
            "html": {"f-html", "site-bundle"},
            "other": {"f-json", "f-mp3"},
        }
        for t, slugs in expect.items():
            body = await self.mine(type=t, limit=100)
            self.assertEqual({d["slug"] for d in body["documents"]}, slugs, t)
            self.assertEqual(body["total"], len(slugs), t)

    async def test_combines_with_search_kind_and_paging(self):
        await self.seed()
        body = await self.mine(type="video", q="roadmap")
        self.assertEqual([d["slug"] for d in body["documents"]], ["demo-video"])
        self.assertEqual(body["total"], 1)
        body = await self.mine(type="pdf", kind="document")
        self.assertEqual(body["documents"], [])  # contradictory filters: nothing, not an error
        body = await self.mine(type="video", kind="artifact")
        self.assertEqual(body["total"], 2)
        p1 = await self.mine(type="html", per_page=1, page=1)
        p2 = await self.mine(type="html", per_page=1, page=2)
        self.assertEqual((p1["total"], p1["pages"], p2["pages"]), (2, 2, 2))
        self.assertEqual({p1["documents"][0]["slug"], p2["documents"][0]["slug"]}, {"f-html", "site-bundle"})

    async def test_unknown_type_is_422_and_auth_required(self):
        r = await self.http.get("/api/v1/me/documents", params={"type": "spreadsheet"},
                                headers=self.session("owner"))
        self.assertEqual(r.status_code, 422)
        r = await self.http.get("/api/v1/me/documents", params={"type": "pdf"})
        self.assertEqual(r.status_code, 401)

    async def test_expired_and_templates_are_not_counted(self):
        from datetime import timedelta

        from tests._access_env import now

        await self.art("pdf", slug="old-pdf", expires_at=now() - timedelta(days=1))
        await self.art("pdf", slug="tpl-pdf", template=True)
        await self.art("pdf", slug="live-pdf")
        body = await self.mine(type="pdf")
        self.assertEqual([d["slug"] for d in body["documents"]], ["live-pdf"])
        self.assertEqual(body["count_by_type"]["pdf"], 1)


class McpListByType(World):
    def items(self, res: dict) -> list[dict]:
        return res["structuredContent"]["items"]

    async def test_mine_filters_and_reports_type(self):
        await self.seed()
        tok = await self.mcp_token("owner", write=False)
        st, res = await self.mcp_call(tok, "list_documents", {"type": "video"})
        self.assertEqual(st, 200)
        self.assertFalse(res.get("isError"), res)
        rows = self.items(res)
        self.assertEqual({r["slug"] for r in rows}, {"demo-video", "phone-clip"})
        self.assertEqual({r["type"] for r in rows}, {"video"})
        st, res = await self.mcp_call(tok, "list_documents", {})
        types = {r["slug"]: r["type"] for r in self.items(res)}
        self.assertEqual((types["roadmap-doc"], types["f-pptx"], types["site-bundle"]),
                         ("document", "slides", "html"))

    async def test_unknown_type_is_a_tool_error(self):
        tok = await self.mcp_token("owner", write=False)
        st, res = await self.mcp_call(tok, "list_documents", {"type": "movies"})
        self.assertEqual(st, 200)
        self.assertTrue(res.get("isError"), res)

    async def test_workspace_scope_never_shows_unreadable_rows(self):
        # wm (a W1 member) sees a workspace-access pdf in W1, not the owner's private one
        # nor the unfiled one; and W2's pdf (not a member) never.
        await self.art("pdf", ws="W1", state="W", slug="ws-pdf")
        await self.art("pdf", ws="W1", state="P", slug="private-pdf")
        await self.art("pdf", slug="unfiled-pdf")
        await self.art("pdf", owner="wm2", ws="W2", state="W", slug="other-ws-pdf")
        await self.art("video", ws="W1", state="W", slug="ws-video")
        tok = await self.mcp_token("wm", write=False)
        for scope in ("workspaces", "all"):
            st, res = await self.mcp_call(tok, "list_documents", {"type": "pdf", "scope": scope})
            self.assertEqual(st, 200)
            self.assertEqual({r["slug"] for r in self.items(res)}, {"ws-pdf"}, scope)


if __name__ == "__main__":
    unittest.main()
