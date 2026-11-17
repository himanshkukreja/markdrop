"""get_document / fetch on PDFs, decks and large HTML files: text by page or part (services/doc_text.py).

Storage is an in-memory dict (r2 patched), never a bucket.
"""

from __future__ import annotations

import io
import json
import sys
import types
import unittest
from datetime import datetime, timezone
from unittest import mock

from tests._mcp_env import McpTestCase

from app.services import doc_text, file_text, r2
from tests.ask_eval.fixtures import make_pptx


def pdf(pages: list[str]) -> bytes:
    """A minimal PDF with one line of Helvetica text per page ("" makes a page with no text: a scan)."""
    objs: list[bytes] = []
    n = len(pages)
    kids = " ".join(f"{3 + 2 * i} 0 R" for i in range(n))
    objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {n} >>".encode())
    font_id = 3 + 2 * n
    for i, text in enumerate(pages):
        content_id = 4 + 2 * i
        objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {content_id} 0 R "
                    f"/Resources << /Font << /F1 {font_id} 0 R >> >> >>".encode())
        stream = (f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET" if text else "0 0 m").encode()
        objs.append(b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream")
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for i, o in enumerate(objs, 1):
        offsets.append(out.tell())
        out.write(f"{i} 0 obj\n".encode() + o + b"\nendobj\n")
    xref = out.tell()
    out.write(f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode())
    for off in offsets:
        out.write(f"{off:010d} 00000 n \n".encode())
    out.write(f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode())
    return out.getvalue()


class Units(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        doc_text.clear_cache()
        self.store: dict[str, bytes] = {}
        self.reads: list[str] = []

        def get(key, max_bytes):
            self.reads.append(key)
            return self.store.get(key, b"")[:max_bytes]

        for p in (mock.patch.object(r2, "is_configured", lambda: True), mock.patch.object(r2, "get_bytes", get)):
            p.start()
            self.addCleanup(p.stop)

    def raw(self, key: str, data: bytes, mime: str, **extra) -> dict:
        self.store[key] = data
        return {"blob_key": key, "mime": mime, "size_bytes": len(data), "rev": 1, **extra}

    async def test_two_page_pdf(self):
        out = await doc_text.paged(self.raw("a", pdf(["Alpha first", "Beta second"]), "application/pdf"))
        self.assertEqual((out["unit"], out["total_pages"], out["page_from"], out["page_to"], out["next_page_from"]),
                         ("page", 2, 1, 2, None))
        self.assertIn("--- Page 1 ---\nAlpha first", out["content"])
        self.assertIn("--- Page 2 ---\nBeta second", out["content"])

    async def test_forty_pages_in_parts_and_cached(self):
        raw = self.raw("b", pdf([f"Page {i} " + "lorem ipsum dolor " * 80 for i in range(1, 41)]), "application/pdf")
        seen, start, calls = [], 1, 0
        while start:
            out = await doc_text.paged(raw, start, max_chars=8_000)
            calls += 1
            self.assertEqual(out["total_pages"], 40)
            self.assertLessEqual(len(out["content"]), 8_000)
            seen += list(range(out["page_from"], out["page_to"] + 1))
            if out["next_page_from"]:
                self.assertIn(f"Continue with page_from={out['next_page_from']}", out["note"])
            start = out["next_page_from"]
        self.assertEqual(seen, list(range(1, 41)))
        self.assertGreater(calls, 3)
        ranged = await doc_text.paged(raw, 5, 6)
        self.assertEqual((ranged["page_from"], ranged["page_to"], ranged["next_page_from"]), (5, 6, None))
        self.assertTrue(ranged["content"].startswith("--- Page 5 ---\nPage 5 "))
        self.assertNotIn("--- Page 7 ---", ranged["content"])
        before = len(self.reads)
        await doc_text.paged(raw, 5, 6)
        self.assertEqual(len(self.reads), before)          # read from the cache
        with self.assertRaises(ValueError):
            await doc_text.paged(raw, 41)

    async def test_scanned_pdf(self):
        out = await doc_text.paged(self.raw("c", pdf(["", "", ""]), "application/pdf"))
        self.assertTrue(out["scanned"])
        self.assertEqual((out["content"], out["total_pages"]), ("", 3))
        self.assertIn("No extractable text (looks scanned)", out["note"])
        mixed = await doc_text.paged(self.raw("c2", pdf(["Cover words", ""]), "application/pdf"))
        self.assertNotIn("scanned", mixed)
        self.assertIn("--- Page 2 ---\n(no extractable text on this page", mixed["content"])

    async def test_unreadable(self):
        with self.assertRaises(doc_text.Unreadable):
            await doc_text.paged(self.raw("d", b"%PDF-1.4 not really", "application/pdf"))

    async def test_deck_slides_and_stored_slide_texts(self):
        deck = make_pptx([("Welcome", "say hello"), ("Pricing tiers", "")])
        out = await doc_text.paged(self.raw("e", deck, file_text.PPTX))
        self.assertEqual((out["unit"], out["total_pages"]), ("slide", 2))
        self.assertIn("--- Slide 1 ---\nWelcome", out["content"])
        self.assertIn("--- Slide 2 ---\nPricing tiers", out["content"])
        # A deck converted to PDF: its slide texts come from the conversion service when there is one.
        fake = types.ModuleType("app.services.pptx_preview")

        async def slide_texts(db, raw, **_):
            return {"total_slides": 3, "pdf_preview": "ready",
                    "slides": [{"slide": 1, "text": "One"}, {"slide": 2, "text": "Two"}, {"slide": 3, "text": ""}]}

        fake.slide_texts = slide_texts
        with mock.patch.dict(sys.modules, {"app.services.pptx_preview": fake}):
            conv = await doc_text.paged(self.raw("f", deck, file_text.PPTX), 2, db=object())
        self.assertEqual((conv["total_pages"], conv["content"]), (3, "--- Slide 2 ---\nTwo\n\n--- Slide 3 ---\n(no text)"))
        fake.slide_texts = None     # no conversion service: the deck itself is read
        with mock.patch.dict(sys.modules, {"app.services.pptx_preview": fake}):
            own = await doc_text.paged(self.raw("g", deck, file_text.PPTX), db=object())
        self.assertEqual(own["total_pages"], 2)

    async def test_html_visible_text(self):
        src = ("<html><head><title>T</title><style>.x{color:red}</style><script>var secret=1</script></head>"
               "<body><h2>Quarter plan</h2><p>See <a href='https://x.example'>the roadmap</a> now.</p>"
               "<svg><text>icon</text></svg></body></html>")
        text = doc_text.html_visible_text(src)
        self.assertIn("## Quarter plan", text)
        self.assertIn("See the roadmap now.", text)
        for gone in ("secret", "color:red", "icon", "<p>"):
            self.assertNotIn(gone, text)


class Tools(McpTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        doc_text.clear_cache()
        _, tokens = await self.connect()
        self.token = tokens["access_token"]
        self.other_id = await self.make_user("sam@example.com", "Sam")
        self.store: dict[str, bytes] = {}
        for p in (mock.patch.object(r2, "is_configured", lambda: True),
                  mock.patch.object(r2, "get_bytes", lambda key, n: self.store.get(key, b"")[:n])):
            p.start()
            self.addCleanup(p.stop)

    async def tool(self, name: str, **arguments) -> dict:
        return await self.call(self.token, name, arguments)

    def ok(self, result: dict) -> dict:
        self.assertFalse(result["isError"], result["content"][0]["text"])
        return result["structuredContent"]

    async def file(self, slug: str, data: bytes, mime: str, *, owner: str | None = None, **fields) -> None:
        now = datetime.now(timezone.utc)
        key = f"u/{slug}"
        self.store[key] = data
        await self.db["documents"].insert_one({
            "slug": slug, "title": fields.pop("title", slug), "content": "", "kind": "artifact", "mime": mime,
            "blob_key": key, "size_bytes": len(data), "original_filename": f"{slug}.bin",
            "edit_secret_hash": "x", "created_at": now, "updated_at": now, "expires_at": None,
            "views": 0, "rev": 1, "owner_id": owner or self.user_id, **fields})

    async def test_get_document_pdf_by_page(self):
        await self.file("two-pager", pdf(["Alpha first", "Beta second"]), "application/pdf")
        res = await self.tool("get_document", document="two-pager")
        out = self.ok(res)
        self.assertEqual((out["kind"], out["total_pages"], out["next_page_from"]), ("artifact", 2, None))
        self.assertIn("--- Page 2 ---\nBeta second", out["content"])
        self.assertIn("--- Page 1 ---\nAlpha first", res["content"][0]["text"])
        self.assertEqual(out["file"]["content_type"], "application/pdf")
        one = self.ok(await self.tool("get_document", document="two-pager", page_from=2, page_to=2))
        self.assertEqual((one["page_from"], one["page_to"], one["content"]), (2, 2, "--- Page 2 ---\nBeta second"))
        bad = await self.tool("get_document", document="two-pager", page_from=3)
        self.assertTrue(bad["isError"])
        self.assertIn("past the end", bad["content"][0]["text"])
        bad = await self.tool("get_document", document="two-pager", page_from=2, page_to=1)
        self.assertIn("at least page_from", bad["content"][0]["text"])

    async def test_fetch_forty_pages_in_parts(self):
        await self.file("long-deck", pdf([f"Page {i} " + "words here " * 400 for i in range(1, 41)]), "application/pdf")
        seen, start = [], 1
        while start:
            res = await self.tool("fetch", id="long-deck", page_from=start)
            out = self.ok(res)
            self.assertEqual(json.loads(res["content"][0]["text"]), out)
            meta = out["metadata"]
            self.assertEqual(meta["total_pages"], 40)
            seen += list(range(meta["page_from"], meta["page_to"] + 1))
            start = meta["next_page_from"]
        self.assertEqual(seen, list(range(1, 41)))

    async def test_scanned_says_so(self):
        await self.file("scan", pdf(["", ""]), "application/pdf")
        out = self.ok(await self.tool("get_document", document="scan"))
        self.assertTrue(out["scanned"])
        self.assertIn("looks scanned", out["note"])
        self.assertNotIn("content", out)
        fetched = self.ok(await self.tool("fetch", id="scan"))
        self.assertIn("looks scanned", fetched["text"])

    async def test_deck_by_slide(self):
        await self.file("deck", make_pptx([("Welcome", "say hello"), ("Pricing tiers", "")]), file_text.PPTX)
        out = self.ok(await self.tool("get_document", document="deck"))
        self.assertEqual((out["unit"], out["total_pages"]), ("slide", 2))
        self.assertIn("--- Slide 2 ---\nPricing tiers", out["content"])

    async def test_large_html_in_parts(self):
        body = "".join(f"<h2>Section {i}</h2><p>{'visible words ' * 300}</p><script>{'x=1;' * 500}</script>"
                       for i in range(80))
        src = f"<html><head><style>{'a{b:c}' * 1000}</style></head><body>{body}</body></html>"
        self.assertGreater(len(src), 200_000)
        await self.file("big-page", src.encode(), "text/html")
        out = self.ok(await self.tool("get_document", document="big-page"))
        self.assertEqual((out["format"], out["part"]), ("text", 1))
        self.assertGreater(out["total_parts"], 1)
        self.assertEqual(out["next_part"], 2)
        self.assertIn("## Section 0", out["content"])
        self.assertNotIn("<p>", out["content"])
        self.assertNotIn("x=1;", out["content"])
        parts = [out["content"]]
        n = out["next_part"]
        while n:
            nxt = self.ok(await self.tool("get_document", document="big-page", part=n))
            parts.append(nxt["content"])
            n = nxt["next_part"]
        self.assertEqual(len(parts), out["total_parts"])
        self.assertIn("## Section 79", parts[-1])
        fetched = self.ok(await self.tool("fetch", id="big-page", part=2))
        self.assertEqual(fetched["text"], parts[1])
        # A small HTML file is still its source (what update_document edits), unless asked for text.
        await self.file("small-page", b"<h1>Hi</h1><p>there</p>", "text/html")
        small = self.ok(await self.tool("get_document", document="small-page"))
        self.assertEqual((small["content"], small["format"]), ("<h1>Hi</h1><p>there</p>", "source"))
        as_text = self.ok(await self.tool("get_document", document="small-page", format="text"))
        self.assertEqual(as_text["content"], "# Hi\n\nthere")

    async def test_no_access_returns_nothing(self):
        await self.file("their-pdf", pdf(["Secret quarterly numbers"]), "application/pdf",
                        owner=self.other_id, access_level="private")
        await self.file("their-page", b"<p>Secret page words</p>" * 20_000, "text/html",
                        owner=self.other_id, access_level="private")
        for name, args in (("get_document", {"document": "their-pdf"}), ("fetch", {"id": "their-pdf"}),
                           ("get_document", {"document": "their-page", "part": 1}),
                           ("fetch", {"id": "their-page", "page_from": 1})):
            res = await self.tool(name, **args)
            self.assertTrue(res["isError"], (name, args))
            self.assertNotIn("structuredContent", res)
            self.assertNotIn("Secret", res["content"][0]["text"])
            self.assertIn("couldn't find", res["content"][0]["text"])


if __name__ == "__main__":
    unittest.main()
