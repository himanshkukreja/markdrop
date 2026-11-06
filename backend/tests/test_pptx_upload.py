"""PowerPoint decks as files (feat/pptx-crumbs): a .pptx is accepted everywhere a file is uploaded
(the browser's upload + confirm, replacing a file, the MCP create_upload → complete_upload), opens in
the Worker's slide viewer (/v/pptx/), and is refused when it can't be shown safely: a .pptm, a macro
deck renamed .pptx, a password-protected (encrypted) deck, XML with a DOCTYPE, something that isn't a
deck. A deck's text is read for search and Ask by slide, and a slide links as ``#slide=N`` (the app
opens the viewer there with ``?at=N``).

R2 is the in-memory FakeR2 (tests/_files_env.py); MongoDB is a throwaway database.
"""

from __future__ import annotations

import io
import zipfile

from tests._files_env import FilesTestCase, sha

from app.mcp import schema, tools
from app.services import artifact as art_service
from app.services import card_preview_proc, file_text, search_chunks, search_index
from app.services import user as user_service

from tests.ask_eval.fixtures import make_pptx

PPTX = art_service.PPTX_MIME
PPTM = "application/vnd.ms-powerpoint.presentation.macroEnabled.12"
DECK = make_pptx([("Welcome to the board review", "say hello"), ("Pricing tiers", "mention the walrus discount")])


def with_member(data: bytes, name: str, content: bytes) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(data)) as src, zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as out:
        for info in src.infolist():
            out.writestr(info, src.read(info))
        out.writestr(name, content)
    return buf.getvalue()


def replaced(data: bytes, name: str, fn) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(data)) as src, zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as out:
        for info in src.infolist():
            body = src.read(info)
            out.writestr(info, fn(body) if info.filename == name else body)
    return buf.getvalue()


OLE = bytes.fromhex("d0cf11e0a1b11ae1") + b"\0" * 1024   # a password-protected Office file
MACRO_RENAMED = with_member(DECK, "ppt/vbaProject.bin", b"Attribute VB_Name")
MACRO_TYPES = replaced(DECK, "[Content_Types].xml", lambda _b: (
    b'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override '
    b'PartName="/ppt/presentation.xml" ContentType="application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml"/></Types>'))
DOCTYPE = replaced(DECK, "ppt/slides/slide1.xml",
                   lambda b: b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "boom">]>' + b.split(b"?>", 1)[-1])


class DeckCheck(FilesTestCase):
    """art_service.check_upload / file_text.check_deck on their own."""

    def test_accepts_a_deck(self):
        self.assertEqual(file_text.PPTX, PPTX)
        self.assertIsNone(art_service.check_upload(DECK, PPTX))
        self.assertEqual(art_service.normalize_mime(None, "Board review.PPTX"), PPTX)
        self.assertEqual(art_service.renderer_for(PPTX), "pptx")
        self.assertEqual(art_service.max_bytes_for(PPTX), art_service.settings.artifact_max_bytes)

    def test_refuses(self):
        for data, why in [(MACRO_RENAMED, "macros"), (MACRO_TYPES, "macros"), (OLE, "encrypted or damaged"),
                          (DOCTYPE, "DOCTYPE"), (b"not a zip at all", "encrypted or damaged")]:
            reason = art_service.check_upload(data, PPTX)
            self.assertIsNotNone(reason, why)
            self.assertIn(why, reason)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("word/document.xml", "<w:document/>")
        self.assertIn("isn't a PowerPoint deck", art_service.check_upload(buf.getvalue(), PPTX))
        # A ZIP bomb: one member that inflates enormously.
        bomb = with_member(DECK, "ppt/media/zeros.bin", b"\0" * (30 * 1024 * 1024))
        self.assertIsNotNone(art_service.check_upload(bomb, PPTX))
        # Other types aren't read here.
        self.assertIsNone(art_service.check_upload(b"anything", "application/pdf"))

    def test_pptm_is_not_an_accepted_type(self):
        self.assertIsNone(art_service.normalize_mime(PPTM, "deck.pptm"))
        self.assertIsNone(art_service.normalize_mime(None, "deck.pptm"))
        self.assertIsNone(art_service.normalize_mime("application/vnd.ms-powerpoint", "deck.ppt"))

    def test_card_preview_first_slide(self):
        out = card_preview_proc.pptx(DECK)
        self.assertEqual(out["pages"], 2)
        self.assertEqual(out["blocks"][0]["x"], "Welcome to the board review")


class DeckUploads(FilesTestCase):
    def put(self, name: str, data: bytes, mime: str = PPTX) -> str:
        key = f"art/{self.user_id}/{name}"
        self.r2.objects[key] = {"data": data, "content_type": mime, "public": False}
        return key

    async def confirm(self, name: str, data: bytes, **extra):
        key = self.put(name, data)
        r = await self.http.post("/api/v1/artifacts", headers=self.auth,
                                 json={"blob_key": key, "filename": name, **extra})
        return r, key

    async def test_upload_url_accepts_pptx_refuses_pptm(self):
        r = await self.http.post("/api/v1/artifacts/upload-url", headers=self.auth,
                                 json={"filename": "Board review.pptx", "content_type": PPTX, "size_bytes": len(DECK)})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["mime"], PPTX)
        self.assertTrue(r.json()["blob_key"].endswith(".pptx"))
        r = await self.http.post("/api/v1/artifacts/upload-url", headers=self.auth,
                                 json={"filename": "Board review.pptm", "content_type": PPTM, "size_bytes": len(DECK)})
        self.assertEqual(r.status_code, 415, r.text)
        self.assertIn("pptx", r.json()["detail"])

    async def test_confirm_publishes_a_deck_in_the_slide_viewer(self):
        r, key = await self.confirm("board.pptx", DECK, custom_slug="board-deck")
        self.assertEqual(r.status_code, 201, r.text)
        body = r.json()
        self.assertEqual(body["renderer"], "pptx")
        self.assertIn(f"/v/pptx/{key}", body["artifact_url"])
        self.assertIn(key, self.r2.objects)
        r = await self.http.get("/api/v1/artifacts/status", headers=self.auth)
        self.assertIn(PPTX, r.json()["accepted_types"])

    async def test_confirm_refuses_and_deletes_bad_decks(self):
        for name, data, why in [("macro.pptx", MACRO_RENAMED, "macros"), ("locked.pptx", OLE, "encrypted"),
                                ("dtd.pptx", DOCTYPE, "DOCTYPE")]:
            r, key = await self.confirm(name, data)
            self.assertEqual(r.status_code, 422, (name, r.text))
            self.assertIn("This PowerPoint file can't be published", r.json()["detail"])
            self.assertIn(why, r.json()["detail"])
            self.assertNotIn(key, self.r2.objects, name)
        self.assertEqual(await self.db["documents"].count_documents({}), 0)

    async def test_replace_with_a_bad_deck_is_refused(self):
        r, _ = await self.confirm("board.pptx", DECK, custom_slug="board-deck")
        self.assertEqual(r.status_code, 201, r.text)
        key = self.put("v2.pptx", MACRO_RENAMED)
        r = await self.http.put("/api/v1/artifacts/board-deck/file", headers=self.auth,
                                json={"blob_key": key, "filename": "v2.pptx"})
        self.assertEqual(r.status_code, 422, r.text)
        self.assertNotIn(key, self.r2.objects)
        key = self.put("v3.pptx", DECK)
        r = await self.http.put("/api/v1/artifacts/board-deck/file", headers=self.auth,
                                json={"blob_key": key, "filename": "v3.pptx"})
        self.assertEqual(r.status_code, 200, r.text)

    async def test_deck_text_is_searchable_by_slide(self):
        r, _ = await self.confirm("board.pptx", DECK, custom_slug="board-deck")
        raw = await self.db["documents"].find_one({"slug": "board-deck"})
        await search_index.index_doc(self.db, raw["_id"])
        self.assertEqual(await search_index.extract_file(self.db, raw["_id"]), "done")
        rows = await self.db[search_chunks.COLL].find({"p": raw["_id"]}).to_list(length=None)
        walrus = next(r for r in rows if "walrus" in r["x"])
        self.assertEqual((walrus["l"], walrus["f"]), ("slide 2", "slide=2"))
        self.assertEqual(search_chunks.fragment_url("https://markdrop.in/board-deck", walrus),
                         "https://markdrop.in/board-deck#slide=2")


class DeckMcp(FilesTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        user = await user_service.get_user_by_id(self.db, self.user_id)
        self.ctx = tools.Context(db=self.db, user=user, client_id="c", scopes=["documents:read", "documents:write"])

    async def tool(self, name: str, **args):
        t = tools.BY_NAME[name]
        problem = schema.validate(t.input_schema, args)
        if problem:
            raise tools.ToolError(problem)
        return await t.handler(self.ctx, args)

    async def upload(self, data: bytes, name: str):
        _t, out = await self.tool("create_upload", file_name=name, size_bytes=len(data), sha256=sha(data))
        parts = await self.send_parts(out["upload_id"], data)
        return await self.tool("complete_upload", upload_id=out["upload_id"], parts=parts)

    async def test_create_upload_takes_a_deck_and_refuses_a_macro_deck(self):
        self.assertIn(".pptx", tools.BY_NAME["create_upload"].description)
        _t, res = await self.upload(DECK, "Board review.pptx")
        self.assertEqual(res["state"], "done")
        raw = await self.db["documents"].find_one({"slug": res["slug"]})
        self.assertEqual(raw["mime"], PPTX)
        with self.assertRaises(tools.ToolError) as cm:
            await self.upload(MACRO_RENAMED, "macro.pptx")
        self.assertIn("macros", str(cm.exception))
        with self.assertRaises(tools.ToolError) as cm:
            await self.tool("create_upload", file_name="deck.pptm", size_bytes=10, sha256="a" * 64)
        self.assertIn("Unsupported file type", str(cm.exception))


if __name__ == "__main__":  # pragma: no cover
    import unittest

    unittest.main()
