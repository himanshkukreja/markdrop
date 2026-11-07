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


class SharedRecentFoldersByType(World):
    """The same chips on Shared with me, Recent and workspace folders: filtered server-side,
    counted per type, and never counting (or listing) what the caller can't open."""

    async def asyncSetUp(self):
        await super().asyncSetUp()
        from app.services import personal

        await personal.ensure_indexes(self.db)

    async def get_json(self, path: str, who: str, **params) -> dict:
        r = await self.http.get(path, params=params, headers=self.session(who))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def shared_art(self, mime_key: str, slug: str, *, state: str = "UP") -> dict:
        # mkdoc with grants: gv (viewer) and ge (editor) are named on it.
        d = await self.mkdoc(state, kind="artifact", slug=slug)
        await self.db["documents"].update_one({"_id": d["_id"]}, {"$set": {"mime": MIME[mime_key]}})
        return d

    async def test_shared_with_me(self):
        await self.shared_art("pdf", "s-pdf")
        await self.shared_art("video", "s-video")
        await self.shared_art("video", "s-video2")
        await self.mkdoc("UP", slug="s-doc")
        gone = await self.shared_art("pdf", "s-gone")
        await self.db["documents"].update_one({"_id": gone["_id"]}, {"$set": {"expires_at": now_minus()}})
        body = await self.get_json("/api/v1/me/shared", "gv", counts="true")
        c = body["count_by_type"]
        self.assertEqual((c["pdf"], c["video"], c["document"], sum(c.values())), (1, 2, 1, 4))
        body = await self.get_json("/api/v1/me/shared", "gv", type="video", counts="true")
        self.assertEqual({i["slug"] for i in body["items"]}, {"s-video", "s-video2"})
        self.assertEqual(body["count_by_type"], c)
        # Paging within a type: the cursor continues the filtered list; later pages carry no counts.
        p1 = await self.get_json("/api/v1/me/shared", "gv", type="video", limit=1, counts="true")
        self.assertEqual(len(p1["items"]), 1)
        self.assertTrue(p1["next_cursor"])
        self.assertEqual(p1["count_by_type"], c)
        p2 = await self.get_json("/api/v1/me/shared", "gv", type="video", limit=1, cursor=p1["next_cursor"], counts="true")
        self.assertEqual({p1["items"][0]["slug"], p2["items"][0]["slug"]}, {"s-video", "s-video2"})
        self.assertIsNone(p2["next_cursor"])
        self.assertIsNone(p2["count_by_type"])
        # The sidebar's badge call doesn't ask for counts (and doesn't pay for them).
        self.assertNotIn("count_by_type", await self.get_json("/api/v1/me/shared", "gv"))
        # Someone not named on anything: nothing, counts all zero.
        self.assertEqual(sum((await self.get_json("/api/v1/me/shared", "stranger", counts="true"))["count_by_type"].values()), 0)
        r = await self.http.get("/api/v1/me/shared", params={"type": "movies"}, headers=self.session("gv"))
        self.assertEqual(r.status_code, 422)

    async def test_recent(self):
        from app.services import personal

        mine = await self.art("pdf", owner="wm", slug="r-pdf")
        vid = await self.art("video", owner="wm", slug="r-video")
        page = await self.mkdoc("UL", owner="wm", grants=False, slug="r-page", editor="blocks")
        secret = await self.art("video", owner="owner", state="UP", slug="r-secret")  # wm can't open it
        for d in (mine, vid, page, secret):
            await personal.record_view(self.db, self.uid["wm"], d["_id"])
        self.assertNotIn("count_by_type", await self.get_json("/api/v1/me/recent", "wm"))  # Home, ⌘K
        body = await self.get_json("/api/v1/me/recent", "wm", counts="true")
        c = body["count_by_type"]
        self.assertEqual((c["pdf"], c["video"], c["document"], sum(c.values())), (1, 1, 1, 3))
        self.assertNotIn("r-secret", {i["slug"] for i in body["items"]})
        body = await self.get_json("/api/v1/me/recent", "wm", type="video")
        self.assertEqual([i["slug"] for i in body["items"]], ["r-video"])
        body = await self.get_json("/api/v1/me/recent", "wm", type="document")
        self.assertEqual([i["slug"] for i in body["items"]], ["r-page"])

    async def test_workspace_folder_items(self):
        W = self.ws["W1"]
        await self.art("pdf", ws="W1", state="W", slug="w-pdf")
        await self.art("video", ws="W1", state="W", slug="w-video")
        await self.mkdoc("W", grants=False, slug="w-doc")
        await self.art("video", ws="W1", state="P", slug="w-private-video")  # owner's, private
        url = f"/api/v1/workspaces/{W}/items"
        body = await self.get_json(url, "wm", folder="root")
        c = body["count_by_type"]
        self.assertEqual((c["pdf"], c["video"], c["document"], sum(c.values())), (1, 1, 1, 3))
        body = await self.get_json(url, "wm", folder="root", type="video")
        self.assertEqual([i["slug"] for i in body["items"] if i.get("slug")], ["w-video"])
        self.assertEqual(body["count_by_type"], c)
        # An admin sees a placeholder for the private item in the plain list, never under a type.
        plain = await self.get_json(url, "wa", folder="root")
        self.assertTrue(any(i.get("redacted") for i in plain["items"]))
        self.assertEqual(plain["count_by_type"]["video"], 1)  # counts are what they can open
        typed = await self.get_json(url, "wa", folder="root", type="video")
        self.assertFalse(any(i.get("redacted") for i in typed["items"]))
        # The owner can open their private video: counted and listed for them.
        own = await self.get_json(url, "owner", folder="root", type="video")
        self.assertEqual({i["slug"] for i in own["items"]}, {"w-video", "w-private-video"})
        self.assertEqual(own["count_by_type"]["video"], 2)
        # Not a member: no listing at all.
        r = await self.http.get(url, params={"folder": "root", "type": "pdf"}, headers=self.session("stranger"))
        self.assertIn(r.status_code, (403, 404))
        r = await self.http.get(url, params={"folder": "root", "type": "x"}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 422)


def now_minus():
    from datetime import timedelta

    from tests._access_env import now

    return now() - timedelta(seconds=5)


if __name__ == "__main__":
    unittest.main()
