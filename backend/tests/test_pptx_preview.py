"""Exact PDF previews of PowerPoint decks (services/pptx_preview.py).

A deck uploaded (or replaced, or restored) is queued; the background loop converts it with headless
LibreOffice into ``<blob_key>.pdf`` beside it, and the file then opens in the PDF viewer while the
.pptx stays the download. Every file version keeps its own PDF. While converting the API says
``pdf_preview: "converting"``; when conversion fails, ``"failed"`` and the slide viewer stays.

CI has no LibreOffice: the queue tests use a fake converter (``pptx_preview.CONVERTER``), the
subprocess tests a fake ``soffice`` script, and the real conversion test is skipped without it.
R2 is the in-memory FakeR2 (tests/_files_env.py).
"""

from __future__ import annotations

import io
import os
import shutil
import stat
import tempfile
import unittest
from unittest import mock

from tests._files_env import FilesTestCase, settings

from app.services import lifecycle, pptx_preview, publicity
from app.services import artifact as art_service

from tests.ask_eval.fixtures import make_pptx

PPTX = art_service.PPTX_MIME
DECK = make_pptx([("Welcome to the board review", "say hello"), ("Pricing tiers", "mention the walrus discount"),
                  ("Questions", "")])
DECK2 = make_pptx([("Board review, take two", ""), ("New pricing", "")])
SOFFICE = shutil.which("soffice") or shutil.which("libreoffice") or (
    "/Applications/LibreOffice.app/Contents/MacOS/soffice"
    if os.path.exists("/Applications/LibreOffice.app/Contents/MacOS/soffice") else None)


def make_pdf(pages: int) -> bytes:
    from pypdf import PdfWriter

    w = PdfWriter()
    for _ in range(pages):
        w.add_blank_page(width=960, height=540)
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


class Pure(unittest.TestCase):
    def test_enabled_follows_the_setting_and_the_binary(self):
        with mock.patch.object(settings, "pptx_convert", None), \
                mock.patch.object(pptx_preview, "binary", lambda: "/usr/bin/soffice"):
            self.assertTrue(pptx_preview.enabled())
        with mock.patch.object(settings, "pptx_convert", None), mock.patch.object(pptx_preview, "binary", lambda: None):
            self.assertFalse(pptx_preview.enabled())
        with mock.patch.object(settings, "pptx_convert", False), \
                mock.patch.object(pptx_preview, "binary", lambda: "/usr/bin/soffice"):
            self.assertFalse(pptx_preview.enabled())

    def test_pdf_sits_beside_its_deck(self):
        self.assertEqual(pptx_preview.pdf_key_for("art/u1/abc.pptx"), "art/u1/abc.pptx.pdf")

    def test_state_only_describes_the_current_file(self):
        doc = {"kind": "artifact", "mime": PPTX, "blob_key": "art/u/b.pptx",
               "pptx_pdf": {"for": "art/u/a.pptx", "state": "ready"}}
        self.assertIsNone(pptx_preview.pdf_key_of(doc))
        self.assertIsNone(pptx_preview.state_of(doc))
        doc["pptx_pdf"]["for"] = "art/u/b.pptx"
        self.assertEqual(pptx_preview.pdf_key_of(doc), "art/u/b.pptx.pdf")
        self.assertEqual(pptx_preview.state_of(doc), "ready")
        self.assertEqual(pptx_preview.viewer_target(doc), ("art/u/b.pptx.pdf", "application/pdf"))
        self.assertIsNone(pptx_preview.state_of({**doc, "mime": "application/pdf"}))

    def test_slide_text_lists_every_slide(self):
        total, slides = pptx_preview._deck_slides(DECK)
        self.assertEqual(total, 3)
        self.assertEqual([s["slide"] for s in slides], [1, 2, 3])
        self.assertIn("walrus", slides[1]["text"])
        self.assertTrue(slides[2]["text"].startswith("Questions"))


class Queue(FilesTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.converted: list[int] = []
        self.fail_with: str | None = None
        pptx_preview._BACKFILL["next"] = 0.0      # the backfill's throttle starts fresh per test

        async def fake_convert(data: bytes) -> bytes:
            self.converted.append(len(data))
            if self.fail_with:
                raise pptx_preview.ConvertError(self.fail_with)
            return make_pdf(3)

        for p in (mock.patch.object(settings, "pptx_convert", None),
                  mock.patch.object(pptx_preview, "binary", lambda: "/usr/bin/soffice"),
                  mock.patch.object(pptx_preview, "CONVERTER", fake_convert)):
            p.start()
            self.addCleanup(p.stop)

    def put(self, name: str, data: bytes) -> str:
        key = f"art/{self.user_id}/{name}"
        self.r2.objects[key] = {"data": data, "content_type": PPTX, "public": False}
        return key

    async def confirm(self, name: str, data: bytes, **extra) -> tuple[dict, str]:
        key = self.put(name, data)
        r = await self.http.post("/api/v1/artifacts", headers=self.auth,
                                 json={"blob_key": key, "filename": name, "custom_slug": "board", **extra})
        self.assertEqual(r.status_code, 201, r.text)
        return r.json(), key

    async def read(self) -> dict:
        r = await self.http.get("/api/v1/documents/board", headers=self.auth)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def test_upload_converts_then_opens_in_the_pdf_viewer(self):
        body, key = await self.confirm("board.pptx", DECK)
        self.assertEqual(body["pdf_preview"], "converting")
        self.assertIn(f"/v/pptx/{key}", body["artifact_url"])
        doc = await self.read()
        self.assertEqual((doc["pdf_preview"], doc["renderer"]), ("converting", "pptx"))

        self.assertEqual(await pptx_preview.tick(self.db), 1)
        pdf_key = f"{key}.pdf"
        self.assertTrue(self.r2.objects[pdf_key]["data"].startswith(b"%PDF-"))
        self.assertEqual(self.r2.objects[pdf_key]["content_type"], "application/pdf")
        self.assertTrue(self.r2.objects[pdf_key]["public"])          # a public link: so is its PDF
        doc = await self.read()
        self.assertEqual(doc["pdf_preview"], "ready")
        self.assertIn(f"/v/pdf/{pdf_key}", doc["artifact_url"])
        self.assertIn(f"/r/{key}", doc["download_url"])              # the deck is still the download
        self.assertFalse(doc["download_url"].endswith(".pdf"))
        row = await self.db[pptx_preview.COLL].find_one({"_id": key})
        self.assertEqual((row["state"], row["pages"], row["slide_count"]), ("ready", 3, 3))
        # Nothing left to do.
        self.assertEqual(await pptx_preview.tick(self.db), 0)
        self.assertEqual(len(self.converted), 1)

        info = (await self.http.get("/api/v1/files/board", headers=self.auth)).json()
        self.assertEqual(info["pdf_preview"], "ready")

    async def test_failure_keeps_the_slide_viewer(self):
        self.fail_with = "timed out after 120 s"
        _body, key = await self.confirm("board.pptx", DECK)
        await pptx_preview.tick(self.db)
        doc = await self.read()
        self.assertEqual(doc["pdf_preview"], "failed")
        self.assertIn(f"/v/pptx/{key}", doc["artifact_url"])
        self.assertNotIn(f"{key}.pdf", self.r2.objects)
        row = await self.db[pptx_preview.COLL].find_one({"_id": key})
        self.assertIn("timed out", row["error"])

    async def test_private_deck_gets_a_private_signed_pdf(self):
        _body, key = await self.confirm("board.pptx", DECK, access_level="private")
        await pptx_preview.tick(self.db)
        self.assertFalse(self.r2.objects[f"{key}.pdf"]["public"])
        doc = await self.read()
        self.assertIn(f"/v/pdf/{key}.pdf?t=", doc["artifact_url"])

    async def test_narrowing_closes_the_pdf_too(self):
        _body, key = await self.confirm("board.pptx", DECK)
        await pptx_preview.tick(self.db)
        raw = await self.doc("board")
        self.assertTrue(await publicity.apply(raw, False, epoch=7))
        self.assertFalse(self.r2.objects[f"{key}.pdf"]["public"])
        self.assertEqual(self.r2.objects[f"{key}.pdf"]["ae"], "7")

    async def test_each_version_keeps_its_own_pdf(self):
        _body, v1 = await self.confirm("board.pptx", DECK)
        await pptx_preview.tick(self.db)
        v2 = self.put("v2.pptx", DECK2)
        r = await self.http.put("/api/v1/artifacts/board/file", headers=self.auth,
                                json={"blob_key": v2, "filename": "v2.pptx"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["pdf_preview"], "converting")
        self.assertIn(f"/v/pptx/{v2}", r.json()["artifact_url"])
        self.assertFalse(self.r2.objects[f"{v1}.pdf"]["public"])     # an old version is never public
        await pptx_preview.tick(self.db)
        doc = await self.read()
        self.assertIn(f"/v/pdf/{v2}.pdf", doc["artifact_url"])
        self.assertIn(f"{v1}.pdf", self.r2.objects)                  # version 1 kept its PDF
        self.assertEqual(len(self.converted), 2)

        r = await self.http.post("/api/v1/files/board/versions/1/restore", headers=self.auth)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["pdf_preview"], "ready")           # no new conversion needed
        doc = await self.read()
        self.assertIn(f"/v/pdf/{v1}.pdf", doc["artifact_url"])
        self.assertTrue(self.r2.objects[f"{v1}.pdf"]["public"])
        self.assertEqual(len(self.converted), 2)

    async def test_deleting_the_document_deletes_its_pdfs(self):
        _body, key = await self.confirm("board.pptx", DECK)
        await pptx_preview.tick(self.db)
        raw = await self.doc("board")
        self.assertTrue(await lifecycle.destroy(self.db, raw))
        self.assertNotIn(f"{key}.pdf", self.r2.objects)
        self.assertEqual(await self.db[pptx_preview.COLL].count_documents({}), 0)

    async def test_deleted_before_conversion_is_dropped(self):
        _body, key = await self.confirm("board.pptx", DECK)
        await self.db["documents"].delete_one({"slug": "board"})
        await pptx_preview.tick(self.db)
        self.assertEqual(self.converted, [])
        self.assertEqual(await self.db[pptx_preview.COLL].count_documents({}), 0)

    async def test_off_means_the_slide_viewer_as_before(self):
        with mock.patch.object(settings, "pptx_convert", False):
            body, key = await self.confirm("board.pptx", DECK)
            self.assertIsNone(body["pdf_preview"])
            self.assertEqual(await pptx_preview.tick(self.db), 0)
        self.assertEqual(await self.db[pptx_preview.COLL].count_documents({}), 0)
        self.assertIn(f"/v/pptx/{key}", (await self.read())["artifact_url"])

    async def test_older_decks_are_backfilled(self):
        with mock.patch.object(settings, "pptx_convert", False):
            _body, key = await self.confirm("board.pptx", DECK)
        self.assertIsNone((await self.doc("board")).get("pptx_pdf"))
        await pptx_preview.tick(self.db)
        self.assertEqual((await self.read())["pdf_preview"], "ready")

    async def test_other_files_are_never_queued(self):
        key = f"art/{self.user_id}/report.pdf"
        self.r2.objects[key] = {"data": make_pdf(1), "content_type": "application/pdf", "public": False}
        r = await self.http.post("/api/v1/artifacts", headers=self.auth,
                                 json={"blob_key": key, "filename": "report.pdf", "custom_slug": "board"})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertIsNone(r.json()["pdf_preview"])
        self.assertEqual(await self.db[pptx_preview.COLL].count_documents({}), 0)

    async def test_slide_texts_for_mcp(self):
        await self.confirm("board.pptx", DECK)
        raw = await self.doc("board")
        out = await pptx_preview.slide_texts(self.db, raw)              # before conversion: from the deck
        self.assertEqual(out["total_slides"], 3)
        self.assertEqual(out["pdf_preview"], "converting")
        await pptx_preview.tick(self.db)
        raw = await self.doc("board")
        out = await pptx_preview.slide_texts(self.db, raw, slide_from=2, slide_to=2)
        self.assertEqual(out["total_slides"], 3)
        self.assertEqual([s["slide"] for s in out["slides"]], [2])
        self.assertIn("Notes: mention the walrus discount", out["slides"][0]["text"])
        self.assertEqual(out["pdf_preview"], "ready")
        self.assertIsNone(await pptx_preview.slide_texts(self.db, {**raw, "mime": "application/pdf"}))

    async def test_too_large_fails_without_converting(self):
        with mock.patch.object(settings, "pptx_convert_max_bytes", 100):
            await self.confirm("board.pptx", DECK)
            await pptx_preview.tick(self.db)
        self.assertEqual(self.converted, [])
        self.assertEqual((await self.read())["pdf_preview"], "failed")


FAKE_SOFFICE = """#!/bin/sh
# A stand-in for soffice: --outdir <dir> <file>; the test writes the mode in.
out=""; last=""
while [ $# -gt 0 ]; do
  case "$1" in --outdir) out="$2"; shift ;; *) last="$1" ;; esac
  shift
done
case "$MD_FAKE_MODE" in
  sleep) sleep 30 ;;
  nothing) exit 1 ;;
  *) printf '%%PDF-1.4 fake' > "$out/$(basename "$last" .pptx).pdf" ;;
esac
"""


class Subprocess(unittest.IsolatedAsyncioTestCase):
    """pptx_preview.convert's process handling, with a fake soffice (no LibreOffice in CI)."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="md-fake-soffice-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.exe = os.path.join(self.tmp, "soffice")
        with open(self.exe, "w") as f:
            f.write(FAKE_SOFFICE)
        os.chmod(self.exe, os.stat(self.exe).st_mode | stat.S_IEXEC)
        p = mock.patch.object(settings, "pptx_convert_bin", self.exe)
        p.start()
        self.addCleanup(p.stop)

    async def test_returns_the_pdf(self):
        with open(self.exe, "w") as f:
            f.write(FAKE_SOFFICE.replace('"$MD_FAKE_MODE"', '"ok"'))
        self.assertTrue((await pptx_preview.convert(DECK)).startswith(b"%PDF-"))

    async def test_no_output_is_an_error(self):
        with open(self.exe, "w") as f:
            f.write(FAKE_SOFFICE.replace('"$MD_FAKE_MODE"', '"nothing"'))
        with self.assertRaises(pptx_preview.ConvertError) as cm:
            await pptx_preview.convert(DECK)
        self.assertIn("no PDF came out", str(cm.exception))

    async def test_timeout_kills_it(self):
        with open(self.exe, "w") as f:
            f.write(FAKE_SOFFICE.replace('"$MD_FAKE_MODE"', '"sleep"'))
        with self.assertRaises(pptx_preview.ConvertError) as cm:
            await pptx_preview.convert(DECK, timeout=0.5)
        self.assertIn("timed out", str(cm.exception))

    async def test_missing_binary(self):
        with mock.patch.object(settings, "pptx_convert_bin", os.path.join(self.tmp, "nope")):
            self.assertIsNone(pptx_preview.binary())
            with self.assertRaises(pptx_preview.ConvertError):
                await pptx_preview.convert(DECK)


@unittest.skipUnless(SOFFICE, "LibreOffice not installed")
class RealConversion(unittest.IsolatedAsyncioTestCase):
    async def test_converts_a_deck_one_page_per_slide(self):
        with mock.patch.object(settings, "pptx_convert_bin", SOFFICE):
            pdf = await pptx_preview.convert(DECK, timeout=180)
        self.assertTrue(pdf.startswith(b"%PDF-"))
        self.assertGreaterEqual(pptx_preview._page_count(pdf) or 0, 1)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
