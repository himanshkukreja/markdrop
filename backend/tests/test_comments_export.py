"""Exports with comments (Track C, services/comments/export.py + services/page_export.py): the Markdown appendix,
Word (.docx) with margin comments or footnotes, the threads for the PDF, who gets comments, and the MCP option."""

from __future__ import annotations

import io
import zipfile
from xml.etree import ElementTree as ET

from tests._comments_reach import ReachWorld, T, now, timedelta

from app.services.comments import export as cx

WNS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def docx_parts(data: bytes) -> dict[str, str]:
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return {n: z.read(n).decode() for n in z.namelist()}


def text_of(xml: str) -> str:
    root = ET.fromstring(xml)
    return "".join(t.text or "" for t in root.iter(f"{WNS}t"))


class Exports(ReachWorld):
    async def discussed(self, state: str = "W") -> dict:
        doc = await self.item(state, title="Launch plan")
        t0 = now() - timedelta(hours=1)
        risk = await self.thread(doc, "wa", quote="payments API", block_id="b-risk01", body="Load test it first", at=t0)
        await self.message(risk, "owner", "Booked for Tuesday", at=t0 + timedelta(minutes=5))
        ship = await self.thread(doc, "owner", quote="Ship the frontend", body="Is Friday real?", at=t0 + timedelta(minutes=1))
        page = await self.thread(doc, "wm", quote=None, block_id=None, kind="page", body="Overall: looks good",
                                 at=t0 + timedelta(minutes=2))
        done = await self.thread(doc, "wm", quote="one more hire", block_id=None, body="Which role?",
                                 status="resolved", at=t0 + timedelta(minutes=3))
        return {"doc": doc, "risk": risk, "ship": ship, "page": page, "done": done}

    async def export(self, slug: str, who: str | None = "owner", **params):
        return await self.http.get(f"/api/v1/documents/{slug}/export", params=params,
                                   headers=self.session(who) if who else None)

    # ── Markdown ──

    async def test_markdown_appendix_in_page_order(self):
        w = await self.discussed()
        r = await self.export(w["doc"]["slug"], format="md", comments="footnotes")
        self.assertEqual(r.status_code, 200, r.text)
        md = r.text
        self.assertIn("Ship the frontend by Friday.", md)
        head, _, appendix = md.partition("## Comments")
        self.assertTrue(appendix, md)
        order = [appendix.index(s) for s in ("On the whole page", "“Ship the frontend”", "“payments API”",
                                             "“one more hire”")]
        self.assertEqual(order, sorted(order))
        self.assertIn("1. **On the whole page** · Open", appendix)
        self.assertIn("WA, ", appendix)
        self.assertIn("> Load test it first", appendix)
        self.assertIn("↳ OWNER", appendix)
        self.assertIn("Resolved by WM", appendix)
        self.assertEqual(r.headers["x-markdrop-export-comments"], "4")
        # Open threads only.
        r = await self.export(w["doc"]["slug"], format="md", comments="footnotes", comment_status="open")
        self.assertNotIn("one more hire", r.text.partition("## Comments")[2])
        # Without the option: no appendix.
        r = await self.export(w["doc"]["slug"], format="md")
        self.assertNotIn("## Comments", r.text)

    async def test_no_comments_for_someone_who_cant_see_them(self):
        w = await self.discussed("UL")                     # anyone with the link reads it; comments aren't public
        r = await self.export(w["doc"]["slug"], None, format="md", comments="margin")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn("## Comments", r.text)
        self.assertNotIn("Load test it first", r.text)
        self.assertEqual(r.headers["x-markdrop-export-comments"], "none")
        # Shown publicly by the owner: an anonymous reader may see (and export) them.
        await self.db["documents"].update_one({"_id": w["doc"]["_id"]}, {"$set": {"comments_public": True}})
        r = await self.export(w["doc"]["slug"], None, format="md", comments="margin")
        self.assertIn("Load test it first", r.text)
        # Deleted threads never leave.
        await self.db[T].update_one({"_id": w["risk"]["_id"]}, {"$set": {"deleted_at": now()}})
        r = await self.export(w["doc"]["slug"], None, format="md", comments="margin")
        self.assertNotIn("Load test it first", r.text)

    # ── Word ──

    async def test_word_with_margin_comments(self):
        w = await self.discussed()
        r = await self.export(w["doc"]["slug"], format="docx", comments="margin")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.headers["content-type"], cx.DOCX_MIME)
        self.assertIn('filename="Launch plan.docx"', r.headers["content-disposition"])
        parts = docx_parts(r.content)
        for p in ("[Content_Types].xml", "word/document.xml", "word/styles.xml", "word/comments.xml",
                  "word/footnotes.xml", "word/numbering.xml", "word/_rels/document.xml.rels"):
            self.assertIn(p, parts)
            ET.fromstring(parts[p])                          # well-formed XML
        doc = parts["word/document.xml"]
        self.assertEqual(doc.count("<w:commentRangeStart"), 4)
        self.assertEqual(doc.count("<w:commentReference"), 4)
        self.assertIn("Ship the frontend by Friday.", text_of(doc))
        self.assertIn('w:val="Title"', doc)
        comments = parts["word/comments.xml"]
        self.assertIn("Load test it first", text_of(comments))
        self.assertIn("Booked for Tuesday", text_of(comments))
        self.assertIn('w:author="WA"', comments)
        # The quoted words are exactly what the comment spans.
        root = ET.fromstring(doc)
        spans = []
        for p in root.iter(f"{WNS}p"):
            inside, buf = None, []
            for el in p.iter():
                if el.tag == f"{WNS}commentRangeStart":
                    inside, buf = el.get(f"{WNS}id"), []
                elif el.tag == f"{WNS}commentRangeEnd":
                    spans.append("".join(buf))
                    inside = None
                elif el.tag == f"{WNS}t" and inside is not None:
                    buf.append(el.text or "")
        self.assertIn("payments API", spans)
        self.assertIn("Ship the frontend", spans)
        self.assertIn("Launch plan", spans)                  # the page comment sits on the title

    async def test_word_with_footnotes_and_a_changed_thread(self):
        w = await self.discussed()
        await self.thread(w["doc"], "wa", quote="words that are gone", block_id=None, anchor_status="changed",
                          body="This changed")
        r = await self.export(w["doc"]["slug"], format="docx", comments="footnotes")
        parts = docx_parts(r.content)
        self.assertEqual(parts["word/document.xml"].count("<w:footnoteReference"), 4)
        notes = text_of(parts["word/footnotes.xml"])
        self.assertIn("Load test it first", notes)
        self.assertIn("on “payments API”", notes)
        body = text_of(parts["word/document.xml"])
        self.assertIn("Comments on text that changed", body)
        self.assertIn("This changed", body)

    async def test_word_without_comments_and_its_limits(self):
        w = await self.discussed()
        r = await self.export(w["doc"]["slug"], format="docx")
        parts = docx_parts(r.content)
        self.assertNotIn("<w:commentRangeStart", parts["word/document.xml"])
        self.assertIn("Exported from Markdrop", text_of(parts["word/document.xml"]))
        r = await self.export(w["doc"]["slug"], format="docx", subpages=1)
        self.assertEqual((r.status_code, r.json()["code"]), (422, "bad_format"))

    def test_word_from_rich_markdown_is_well_formed(self):
        md = ("# Title\n\nSome **bold**, *em*, ~~gone~~, `code` and a [link](https://example.com).\n\n"
              "- one\n  - nested\n- [x] done\n\n1. first\n2. second\n\n> quoted\n\n```py\nx = 1 < 2\n```\n\n"
              "| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n\n![alt](https://x/y.png)\n\nLine one  \nline two & <tags>\n")
        t = cx.ExportThread(n=1, id="x", anchor_type="text", quote="bold", status="open", changed=False, section=None,
                            messages=[cx.ExportMessage(author="Ana", at=now(), body="Why <bold>?")])
        data = cx.to_docx(md, title="Title", url="https://markdrop.in/x", threads=[t])
        parts = docx_parts(data)
        for name, xml in parts.items():
            ET.fromstring(xml)
        doc = parts["word/document.xml"]
        self.assertIn("<w:hyperlink", doc)
        self.assertIn("<w:tbl>", doc)
        self.assertIn("☑ done", text_of(doc))
        self.assertIn("x = 1 &lt; 2", doc)
        self.assertIn("Why &lt;bold&gt;?", parts["word/comments.xml"])
        self.assertIn("https://example.com", parts["word/_rels/document.xml.rels"])

    # ── PDF (the browser prints; the server gives the threads) ──

    async def test_threads_for_the_pdf(self):
        w = await self.discussed()
        r = await self.http.get(f"/api/v1/documents/{w['doc']['slug']}/comments/export", headers=self.session("wv"))
        self.assertEqual(r.status_code, 200, r.text)
        th = r.json()["threads"]
        self.assertEqual([t["n"] for t in th], [1, 2, 3, 4])
        self.assertEqual(th[0]["anchor_type"], "page")
        self.assertEqual(th[1]["quote"], "Ship the frontend")
        self.assertEqual(th[2]["messages"][1]["body"], "Booked for Tuesday")
        self.assertEqual(th[2]["section"], "Risks")
        r = await self.http.get(f"/api/v1/documents/{w['doc']['slug']}/comments/export?status=open",
                                headers=self.session("wv"))
        self.assertEqual(len(r.json()["threads"]), 3)
        self.assertEqual((await self.http.get(f"/api/v1/documents/{w['doc']['slug']}/comments/export")).status_code, 401)

    # ── MCP ──

    async def test_mcp_export_page_with_comments(self):
        w = await self.discussed()
        out = await self.mcp("owner", "export_page", {"document": w["doc"]["slug"], "comments": "footnotes"},
                             write=False)
        self.assertIn("## Comments", out["content"])
        self.assertEqual(out["comments"], 4)
        out = await self.mcp("owner", "export_page", {"document": w["doc"]["slug"], "format": "word",
                                                      "comments": "margin", "comment_status": "open"}, write=False)
        self.assertEqual((out["format"], out["filename"], out["comments"]), ("word", "Launch plan.docx", 3))
        path = out["download_url"].split("https://api.markdrop.in", 1)[1]
        r = await self.http.get(path)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(docx_parts(r.content)["word/document.xml"].count("<w:commentRangeStart"), 3)
        status, res = await self.mcp_call(await self.mcp_token("owner", write=False), "export_page",
                                          {"document": w["doc"]["slug"], "format": "html", "comments": "margin"})
        self.assertTrue(res["isError"])
