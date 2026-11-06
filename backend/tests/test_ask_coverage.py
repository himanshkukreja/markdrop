"""Whole-length search and Ask (.work/briefs/ask-coverage.md): transcripts in windows (every minute
searchable, the best window quoted with its time and anchor), Office / PDF / CSV / caption text with
where it is (page, slide, sheet, minute), video captions (API, player URL, search by minute) and the
text around a video on the pages that embed it (only for someone who can read that page), the
untrusted-file limits (ZIP bombs, DOCTYPEs, encrypted files refused), access (a private file's text
never reaches anyone else), and the resumable coverage pass. The model is always the fake client.
"""

from __future__ import annotations

import io
import zipfile

from tests._access_env import AccessWorld, now  # noqa: F401  (pins settings first)
from tests.test_ask_markdrop import AskWorld
from tests.test_pages_ai import prompt_of
from tests.test_search import make_pdf

import unittest

from app.services import file_text, meetings, search_chunks, search_index

from tests.ask_eval.fixtures import FILLER, W_NS, _zip, long_vtt, make_docx, make_pptx, make_xlsx, vtt  # noqa: E402


# ── Extraction (pure) ─────────────────────────────────────────────────────────


class Extraction(unittest.TestCase):
    def test_docx_sections(self):
        data = make_docx([("Title", "Payments spec"), (None, "Intro text."), ("Heading1", "Rollout plan"),
                          (None, "We roll out the ledger to Brazil in phase two.")])
        parts = file_text.extract(data, file_text.DOCX).parts
        self.assertEqual(parts[-1].label, "Rollout plan")
        self.assertIn("Brazil", parts[-1].text)
        self.assertIn("Payments spec", file_text.extract(data, file_text.DOCX).text)

    def test_pptx_slides_and_notes(self):
        data = make_pptx([("Welcome", "say hello"), ("Pricing tiers", "mention the walrus discount")])
        parts = file_text.extract(data, file_text.PPTX).parts
        self.assertEqual([p.label for p in parts], ["slide 1", "slide 2"])
        self.assertIn("Notes: mention the walrus discount", parts[1].text)
        self.assertEqual(parts[1].frag, "slide=2")
        self.assertNotIn("\n2", parts[1].text)      # the notes page's own slide number

    def test_xlsx_sheets_rows(self):
        data = make_xlsx({"Budget": [["Item", "Cost"], ["Gecko servers", "1200"]], "Team": [["Name"], ["Ada"]]})
        parts = file_text.extract(data, file_text.XLSX).parts
        self.assertIn("Sheets: Budget, Team", parts[0].text)
        budget = next(p for p in parts if p.label == "sheet Budget")
        self.assertIn("Gecko servers | 1200", budget.text)

    def test_csv_pdf_text(self):
        parts = file_text.extract(b"name,city\nAda,London\nBo,Lima\n", "text/csv").parts
        self.assertIn("Bo | Lima", parts[0].text)
        pdf = make_pdf("Annual narwhal report")
        if pdf:
            parts = file_text.extract(pdf, "application/pdf").parts
            self.assertEqual((parts[0].label, parts[0].frag), ("page 1", "page=1"))
            self.assertIn("narwhal", parts[0].text)

    def test_captions_vtt_srt(self):
        v = vtt([(0, "hello"), (300, "the tapir moment")])
        parts = file_text.caption_parts(v)
        self.assertEqual([(p.label, p.frag) for p in parts], [("0:00", "t=0"), ("5:00", "t=300")])
        srt = "1\n00:00:01,000 --> 00:00:03,000\nFirst line\n\n2\n00:12:34,500 --> 00:12:36,000\nOkapi spotted\n"
        out = file_text.to_vtt(srt)
        self.assertTrue(out.startswith("WEBVTT"))
        self.assertIn("00:12:34.500 --> 00:12:36.000", out)
        self.assertEqual(file_text.caption_parts(out)[-1].label, "12:34")
        with self.assertRaises(file_text.Refused):
            file_text.to_vtt("just some words, no cues")

    def test_refused(self):
        # A ZIP bomb: one member that inflates enormously.
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("word/document.xml", b"\0" * (30 * 1024 * 1024))
        with self.assertRaises(file_text.Refused):
            file_text.extract(buf.getvalue(), file_text.DOCX)
        # A DOCTYPE (entity expansion).
        bomb = _zip({"word/document.xml": '<?xml version="1.0"?><!DOCTYPE lol [<!ENTITY a "aaaa">]>'
                                          f'<w:document xmlns:w="{W_NS}"><w:body>&a;</w:body></w:document>'})
        with self.assertRaises(file_text.Refused):
            file_text.extract(bomb, file_text.DOCX)
        # A password-protected Office file is an OLE container, not a ZIP.
        with self.assertRaises(file_text.Refused):
            file_text.extract(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\0" * 600, file_text.DOCX)
        # An encrypted PDF.
        from pypdf import PdfReader, PdfWriter

        pdf = make_pdf("secret walrus")
        if pdf:
            w = PdfWriter()
            for p in PdfReader(io.BytesIO(pdf)).pages:
                w.add_page(p)
            w.encrypt("pw")
            out = io.BytesIO()
            w.write(out)
            with self.assertRaises(file_text.Refused):
                file_text.extract(out.getvalue(), "application/pdf")
        # Huge text is capped.
        self.assertLessEqual(len(file_text.extract(b"word " * 200_000, "text/plain").text), file_text.MAX_TEXT)


class Chunking(unittest.TestCase):
    def test_transcript_windows_overlap_and_cap(self):
        segs = [{"speaker": ["Ada", "Bo"][i % 2], "t": i * 30, "text": f"line {i} {FILLER}"} for i in range(400)]
        md = meetings.transcript_markdown(segs, approx=False)
        rows = search_chunks.transcript_chunks(md)
        self.assertGreater(len(rows), 10)
        self.assertEqual((rows[0]["l"], rows[0]["f"], rows[0]["k"]), ("0:00", "b-t0001", 1))
        # Every line is in some window, consecutive windows share a line, labels are the first line's time.
        for a, b in zip(rows, rows[1:]):
            self.assertEqual(a["x"].split("\n")[-1], b["x"].split("\n")[0])
            self.assertLessEqual(len(a["x"]), search_chunks.CHUNK_CHARS + 600)
        self.assertIn("line 399", rows[-1]["x"])
        self.assertEqual(rows[0]["sp"], ["Ada", "Bo"])
        # A 3-hour-plus transcript stops at the cap.
        big = [{"speaker": "Ada", "t": i * 10, "text": FILLER * 3} for i in range(3000)]
        rows = search_chunks.transcript_chunks(meetings.transcript_markdown(big, approx=False))
        self.assertLessEqual(sum(len(r["x"]) for r in rows), search_chunks.MAX_TOTAL + search_chunks.CHUNK_CHARS * 2)

    def test_split_text(self):
        text = " ".join(f"w{i}" for i in range(3000))
        parts = search_chunks.split_text(text, size=1000, overlap=100)
        self.assertGreater(len(parts), 10)
        self.assertTrue(parts[0].startswith("w0 "))
        self.assertIn("w2999", parts[-1])
        self.assertEqual(search_chunks.split_text("short"), ["short"])


# ── Search and Ask, end to end (fake model) ───────────────────────────────────


class Coverage(AskWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await search_chunks.ensure_indexes(self.db)

    async def find(self, who: str, q: str) -> dict:
        r = await self.http.get("/api/v1/search", params={"q": q}, headers=self.session(who))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def file(self, who: str, slug: str, title: str, data: bytes, mime: str, *, state: str = "W",
                   filename: str = "f.bin", **kw) -> dict:
        raw = await self.mkdoc(state, owner=who, kind="artifact", slug=slug, title=title, grants=False, **kw)
        self.r2.put_bytes(raw["blob_key"], data, mime, False)
        await self.db["documents"].update_one({"_id": raw["_id"]}, {"$set": {"mime": mime, "size_bytes": len(data),
                                                                              "original_filename": filename}})
        raw.update(mime=mime)
        return raw

    async def settle(self) -> None:
        await self.index_all()
        for _ in range(5):
            if not await search_index.extract_pending(self.db) and not await search_index.around_pending(self.db):
                break

    async def test_transcript_minute_70_is_found_and_quoted(self):
        m = await self.import_meeting(sources=[{"name": "Vendor sync.vtt", "text": long_vtt()}])
        await self.settle()
        t = await self.db["documents"].find_one({"slug": m["transcript_slug"]})
        self.assertGreater(len(t["content"]), search_index.DOC_TEXT * 1.5)   # the old index stopped well before
        row = await self.db[search_index.COLL].find_one({"_id": t["_id"]})
        self.assertNotIn("zephyr", row["w"])
        self.assertGreater(row["nc"], 15)
        # Search finds the meeting by a word said at minute 70, and quotes that moment.
        res = await self.find("wm", "zephyr contract")
        self.assertEqual(res["items"][0]["slug"], m["slug"])
        sn = res["items"][0]["snippet"]
        self.assertTrue(sn["text"].startswith("1:10:00 · "), sn["text"])
        self.assertIn("Zephyr", sn["text"])
        self.assertRegex(res["items"][0]["moment_url"], rf"/{m['transcript_slug']}#b-t\d{{4}}$")
        k = int(res["items"][0]["moment_url"].rsplit("#b-t", 1)[1])
        mrow = await self.db[meetings.COLL].find_one({"transcript_slug": m["transcript_slug"]})
        self.assertIn("Zephyr", mrow["segments"][k - 1]["text"])       # the link lands on the line itself
        # Ask sends the minute-70 line, labelled, and cites it with its time.
        self.fake.calls.clear()
        done = self.done(await self.ask("wm", "When does the Zephyr contract renew?"))
        p = self.prompts()
        self.assertRegex(p, r"\[\d+-s\d+\] 1:10:00 Kabir Singh: The Zephyr vendor contract renews")
        moment = next(c for c in done["citations"] if "-s" in c["label"])
        self.assertEqual(moment["at"], "1:10:00")
        self.assertFalse([c for c in done["citations"] if c["title"] == "Transcript"])   # cited by its meeting
        # The chunked transcript is not re-chunked when nothing changed.
        before = await self.db[search_chunks.COLL].find_one({"p": t["_id"]}, sort=[("n", 1)])
        await search_index.index_doc(self.db, t["_id"])
        after = await self.db[search_chunks.COLL].find_one({"p": t["_id"]}, sort=[("n", 1)])
        self.assertEqual(before["_id"], after["_id"])

    async def test_restricted_meeting_transcript_never_reaches_others(self):
        m = await self.import_meeting(sources=[{"name": "Vendor sync.vtt", "text": long_vtt()}])
        await self.settle()
        page = await self.db["documents"].find_one({"slug": m["slug"]})
        tr = await self.db["documents"].find_one({"slug": m["transcript_slug"]})
        for d in (page, tr):
            await self.db["documents"].update_one({"_id": d["_id"]}, {"$set": {"access_level": "private"}})
        await search_index.index_doc(self.db, tr["_id"])
        self.assertEqual((await self.find("wm", "zephyr"))["items"], [])
        self.fake.calls.clear()
        await self.ask("wm", "When does the Zephyr contract renew?")
        sent = "\n".join(prompt_of(c) for c in self.ask_calls() if "untrusted_document" in prompt_of(c))
        self.assertNotIn("Zephyr vendor contract", sent)

    async def test_office_files_with_locations(self):
        await self.file("owner", "spec", "Payments spec", make_docx([
            ("Title", "Payments spec"), ("Heading1", "Rollout plan"), (None, "Phase two brings the ledger to Brazil.")]),
            file_text.DOCX, filename="spec.docx")
        await self.file("owner", "deck", "Q4 deck", make_pptx([("Welcome", "hi"), ("Pricing", "the walrus discount is 15%")]),
                        file_text.PPTX, filename="deck.pptx")
        await self.file("owner", "budget", "Budget 2027", make_xlsx({"Servers": [["Item", "Cost"], ["Gecko cluster", "1200"]]}),
                        file_text.XLSX, filename="budget.xlsx")
        pdf = make_pdf("Annual narwhal revenue grew")
        if pdf:
            await self.file("owner", "report", "Annual report", pdf, "application/pdf", filename="r.pdf")
        await self.settle()
        res = await self.find("wm", "brazil ledger")
        self.assertEqual(res["items"][0]["slug"], "spec")
        self.assertIn("Rollout plan", res["items"][0]["snippet"]["text"])
        res = await self.find("wm", "walrus discount")
        self.assertEqual(res["items"][0]["slug"], "deck")
        self.assertTrue(res["items"][0]["snippet"]["text"].startswith("Slide 2 · "))
        self.assertTrue(res["items"][0]["url"].endswith("#slide=2"))
        res = await self.find("wm", "gecko cluster")
        self.assertEqual(res["items"][0]["slug"], "budget")
        if pdf:
            res = await self.find("wm", "narwhal")
            self.assertTrue(res["items"][0]["url"].endswith("#page=1"))
        # Ask: passages labelled with where they are; a cited passage links there.
        self.fake.calls.clear()
        done = self.done(await self.ask("wm", "What is the walrus discount?"))
        p = self.prompts()
        self.assertRegex(p, r"\[\d+-s1\] slide 2: .*walrus discount")
        passage = next(c for c in done["citations"] if "-s" in c["label"])
        self.assertEqual((passage["source_kind"], passage["moment"]), ("passage", "slide 2"))
        self.assertTrue(passage["url"].endswith("#slide=2"))

    async def test_private_file_text_never_reaches_another_user(self):
        await self.file("owner", "secret-plan", "Plan", make_docx([(None, "The okapi acquisition closes in May.")]),
                        file_text.DOCX, state="P", filename="p.docx")
        await self.settle()
        self.assertEqual([i["slug"] for i in (await self.find("owner", "okapi"))["items"]], ["secret-plan"])
        self.assertEqual((await self.find("wm", "okapi"))["items"], [])
        self.fake.calls.clear()
        await self.ask("wm", "When does the okapi acquisition close?")
        self.assertNotIn("okapi acquisition", "\n".join(prompt_of(c) for c in self.ask_calls()
                                                        if "untrusted_document" in prompt_of(c)))

    async def test_encrypted_and_password_files_are_never_read(self):
        await self.file("owner", "enc", "Enc", make_docx([(None, "tapir secret")]), file_text.DOCX, encrypted=True)
        await self.file("owner", "pw", "Pw", make_docx([(None, "tapir hidden")]), file_text.DOCX, state="LP")
        await self.settle()
        self.assertEqual(await self.db[search_chunks.COLL].count_documents({}), 0)
        self.assertEqual((await self.find("owner", "tapir"))["items"], [])

    async def test_video_captions_api_search_and_ask(self):
        video = await self.file("owner", "demo", "Product demo", b"\0" * 100, "video/mp4", filename="demo.mp4")
        srt = "1\n00:00:01,000 --> 00:00:03,000\nWelcome to the demo\n\n2\n00:12:34,000 --> 00:12:38,000\n" \
              "Here the capybara export button saves a report\n"
        r = await self.http.put("/api/v1/artifacts/demo/captions", headers=self.session("owner"),
                                json={"file_name": "demo.srt", "content": srt})
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["captions_name"], "demo.srt")
        self.assertRegex(body["captions_url"], r"/r/art/.+\.captions\.vtt\?t=")     # signed: a workspace file
        raw = await self.db["documents"].find_one({"_id": video["_id"]})
        self.assertTrue(self.r2.get_bytes(raw["captions_key"], 10_000).startswith(b"WEBVTT"))
        # Readers get it on the document too.
        d = await self.http.get("/api/v1/documents/demo", headers=self.session("wm"))
        self.assertEqual(d.status_code, 200, d.text)
        self.assertTrue(d.json()["captions_url"])
        await self.settle()
        res = await self.find("wm", "capybara export")
        self.assertEqual(res["items"][0]["slug"], "demo")
        self.assertTrue(res["items"][0]["snippet"]["text"].startswith("12:34 · "))
        self.assertTrue(res["items"][0]["url"].endswith("#t=754"))
        self.fake.calls.clear()
        done = self.done(await self.ask("wm", "Where is the capybara export button?"))
        passage = next(c for c in done["citations"] if "-s" in c["label"])
        self.assertEqual((passage["at"], passage["moment"]), ("12:34", "12:34"))
        self.assertTrue(passage["url"].endswith("#t=754"))
        # Who may: an editor of the file; never a viewer; never a non-video.
        r = await self.http.put("/api/v1/artifacts/demo/captions", headers=self.session("wv"),
                                json={"file_name": "x.vtt", "content": vtt([(0, "x")])})
        self.assertIn(r.status_code, (403, 404))
        html = await self.mkdoc("W", owner="owner", kind="artifact", slug="page-html", grants=False)
        r = await self.http.put("/api/v1/artifacts/page-html/captions", headers=self.session("owner"),
                                json={"file_name": "x.vtt", "content": vtt([(0, "x")])})
        self.assertEqual(r.status_code, 422)
        self.assertTrue(html)
        r = await self.http.put("/api/v1/artifacts/demo/captions", headers=self.session("owner"),
                                json={"file_name": "x.txt", "content": "hello"})
        self.assertEqual(r.status_code, 422)
        # Removing them: the object goes, and so does the text.
        old_key = raw["captions_key"]
        r = await self.http.delete("/api/v1/artifacts/demo/captions", headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIsNone(r.json()["captions_url"])
        self.assertIsNone(self.r2.get_bytes(old_key, 100))
        await self.settle()
        self.assertEqual((await self.find("wm", "capybara"))["items"], [])

    async def test_text_around_a_video_only_for_readers_of_that_page(self):
        await self.file("owner", "walkthrough", "Walkthrough", b"\0" * 10, "video/mp4", filename="w.mp4")
        await self.put("launch-notes", "Launch notes", "# Launch notes\n\nThe pangolin onboarding flow, recorded:\n\n"
                       '::markdrop{src="walkthrough"}\n\nMore later.', state="P")
        from app.services import page_links

        await page_links.reindex(self.db, await self.db["documents"].find_one({"slug": "launch-notes"}))
        await self.settle()
        row = await self.db[search_chunks.COLL].find_one({"src": "around"})
        self.assertIsNotNone(row)
        # The owner (who can read the page) finds the video by the page's words; a member can't.
        self.assertIn("walkthrough", [i["slug"] for i in (await self.find("owner", "pangolin"))["items"]])
        self.assertEqual((await self.find("wm", "pangolin"))["items"], [])
        # The page stops embedding it: the text goes.
        await self.db["documents"].update_one({"slug": "launch-notes"}, {"$set": {"content": "# Launch notes\n\nNothing."}})
        await page_links.reindex(self.db, await self.db["documents"].find_one({"slug": "launch-notes"}))
        await self.settle()
        self.assertEqual(await self.db[search_chunks.COLL].count_documents({"src": "around"}), 0)

    async def test_coverage_pass_is_resumable_and_skips_unchanged(self):
        m = await self.import_meeting(sources=[{"name": "Vendor sync.vtt", "text": long_vtt(30, at_min=20)}])
        for i in range(5):
            await self.file("owner", f"doc{i}", f"Doc {i}", make_docx([(None, f"quokka {i}")]), file_text.DOCX)
        await self.settle()
        # As prod before this release: rows without windows or a coverage stamp.
        await self.db[search_chunks.COLL].delete_many({})
        await self.db[search_index.COLL].update_many({}, {"$unset": {"cv": "", "nc": "", "ch": ""},
                                                          "$set": {"fx": "none"}})
        await self.db[search_index.META].delete_many({"_id": "coverage"})
        out = await search_index.coverage_tick(self.db, batch=2)
        self.assertFalse(out["done"])
        state = await self.db[search_index.META].find_one({"_id": "coverage"})
        self.assertIsNotNone(state["cursor"])
        for _ in range(20):
            await search_index.extract_pending(self.db)
            if (await search_index.coverage_tick(self.db, batch=2))["done"]:
                break
        await search_index.extract_pending(self.db)
        self.assertTrue((await search_index.coverage_tick(self.db))["done"])
        self.assertGreater(await self.db[search_chunks.COLL].count_documents({"src": "transcript"}), 3)
        self.assertEqual(await self.db[search_chunks.COLL].count_documents({"src": "file"}), 5)
        self.assertEqual(len((await self.find("wm", "quokka"))["items"]), 5)
        # A second pass at the same version touches nothing (no R2 fetch again).
        await self.db[search_index.META].delete_many({"_id": "coverage"})
        fetched = []
        orig = self.r2.get_bytes
        self.r2.get_bytes = lambda *a, **k: fetched.append(a) or orig(*a, **k)
        try:
            for _ in range(10):
                if (await search_index.coverage_tick(self.db))["done"]:
                    break
            await search_index.extract_pending(self.db)
        finally:
            self.r2.get_bytes = orig
        self.assertEqual(fetched, [])
        status = await search_index.status(self.db)
        self.assertTrue(status["coverage"]["done"])
        self.assertTrue(m)

    async def test_mcp_set_captions(self):
        await self.file("owner", "clip", "Clip", b"\0" * 10, "video/mp4", filename="clip.mp4")
        tok = await self.mcp_token("owner", write=True)
        code, res = await self.mcp_call(tok, "set_captions", {"document": "clip", "file_name": "clip.vtt",
                                                              "content": vtt([(65, "the axolotl appears")])})
        self.assertEqual(code, 200)
        self.assertFalse(res.get("isError"), res)
        self.assertEqual(res["structuredContent"]["captions"], "clip.vtt")
        await self.settle()
        self.assertEqual([i["slug"] for i in (await self.find("wm", "axolotl"))["items"]], ["clip"])
        # A reader can't; removing works.
        code, res = await self.mcp_call(await self.mcp_token("wv", write=True), "set_captions",
                                        {"document": "clip", "content": vtt([(0, "x")])})
        self.assertTrue(res.get("isError"))
        code, res = await self.mcp_call(tok, "set_captions", {"document": "clip", "remove": True})
        self.assertFalse(res.get("isError"), res)
        self.assertIsNone(res["structuredContent"]["captions"])

    async def test_ai_search_reads_the_matching_page_of_a_file(self):
        slides = [("Intro", "x")] + [(f"Slide {i}", "filler") for i in range(2, 6)] + [("Rollout", "the narwhal migration starts in May")]
        await self.file("owner", "deck2", "Migration deck", make_pptx(slides), file_text.PPTX, filename="m.pptx")
        await self.settle()
        self.fake.calls.clear()
        r = await self.http.post("/api/v1/search/ask", json={"question": "when does the narwhal migration start?"},
                                 headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        sent = "\n".join(prompt_of(c) for c in self.fake.calls if "untrusted_document" in prompt_of(c))
        self.assertIn("(slide 6) ", sent)
        self.assertIn("narwhal migration starts in May", sent)

    async def test_password_on_then_off_reads_the_file_again(self):
        f = await self.file("owner", "plan2", "Plan", make_docx([(None, "The ibex launch is in June.")]), file_text.DOCX)
        await self.settle()
        self.assertEqual([i["slug"] for i in (await self.find("wm", "ibex"))["items"]], ["plan2"])
        await self.db["documents"].update_one({"_id": f["_id"]}, {"$set": {"read_password_hash": "x"}})
        await search_index.index_doc(self.db, f["_id"])
        self.assertEqual(await self.db[search_chunks.COLL].count_documents({"p": f["_id"]}), 0)
        self.assertEqual((await self.find("owner", "ibex"))["items"], [])
        await self.db["documents"].update_one({"_id": f["_id"]}, {"$set": {"read_password_hash": None}})
        await search_index.index_doc(self.db, f["_id"])
        await self.settle()
        self.assertEqual([i["slug"] for i in (await self.find("wm", "ibex"))["items"]], ["plan2"])
