"""Card previews (feat/card-previews): ``POST /workspaces/{id}/items/previews``.

* Access: a preview only for an item the caller can open right now, by ``access.can(read)``.
  Everything else answers ``{"state": "locked"}``, the same bytes for "private to someone else",
  "in another workspace", "expired" and "no such item" (no oracle). Members only, like the listing.
  End-to-end encrypted documents answer ``{"state": "encrypted"}`` and nothing else.
* Nothing is HTML: Markdown, pages and HTML files come back as plain-text blocks; other items'
  labels are left out; an HTML file's live render is its signed URL on the artifact origin.
* Pictures (images, a PDF's first page, a video's poster, a page's uploaded cover) are WebP data
  URIs made in a child process and cached in ``card_previews``, which a delete clears.
* MCP: ``list_workspace_items`` with ``previews: true`` adds each item's opening text.

Runs in the access-policy world (tests/_access_env.py). Never backend/.env.
"""

from __future__ import annotations

import asyncio
import io
import json
import zipfile
from datetime import datetime, timedelta, timezone

from tests._access_env import ORIGIN, AccessWorld

from PIL import Image

from app.services import card_preview, lifecycle


def png(w=1200, h=800, color=(30, 120, 200)) -> bytes:
    b = io.BytesIO()
    Image.new("RGB", (w, h), color).save(b, "PNG")
    return b.getvalue()


def pdf() -> bytes:
    b = io.BytesIO()
    Image.new("RGB", (612, 792), (255, 255, 255)).save(b, "PDF")
    return b.getvalue()


def docx(paragraphs: list[tuple[str, str]]) -> bytes:
    W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    body = "".join(
        f'<w:p>{f"<w:pPr><w:pStyle w:val=\"{style}\"/></w:pPr>" if style else ""}<w:r><w:t>{text}</w:t></w:r></w:p>'
        for style, text in paragraphs)
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("word/document.xml", f'<?xml version="1.0"?><w:document xmlns:w="{W}"><w:body>{body}</w:body></w:document>')
    return b.getvalue()


def xlsx(rows: list[list[str]]) -> bytes:
    S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    strings: list[str] = []
    xml_rows = []
    for r, row in enumerate(rows, 1):
        cells = []
        for c, v in enumerate(row):
            ref = f"{chr(65 + c)}{r}"
            if v.replace(".", "", 1).isdigit():
                cells.append(f'<c r="{ref}"><v>{v}</v></c>')
            else:
                strings.append(v)
                cells.append(f'<c r="{ref}" t="s"><v>{len(strings) - 1}</v></c>')
        xml_rows.append(f'<row r="{r}">{"".join(cells)}</row>')
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("xl/workbook.xml", f'<workbook xmlns="{S}" xmlns:r="{R}"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>')
        z.writestr("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/data.xml" Type="x"/></Relationships>')
        z.writestr("xl/worksheets/data.xml", f'<worksheet xmlns="{S}"><sheetData>{"".join(xml_rows)}</sheetData></worksheet>')
        z.writestr("xl/sharedStrings.xml", f'<sst xmlns="{S}">{"".join(f"<si><t>{s}</t></si>" for s in strings)}</sst>')
    return b.getvalue()


class CardPreviews(AccessWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        card_preview._RUNNING.clear()
        card_preview._RENDERS = None
        await card_preview.ensure_indexes(self.db)

    async def previews(self, who: str, slugs: list[str], ws: str = "W1", headers: dict | None = None):
        return await self.http.post(f"/api/v1/workspaces/{self.ws[ws]}/items/previews",
                                    json={"slugs": slugs}, headers=headers if headers is not None else self.session(who))

    async def settled(self, who: str, slug: str, ws: str = "W1") -> dict:
        """A preview once its picture is made (pending → ok)."""
        for _ in range(40):
            r = await self.previews(who, [slug], ws)
            self.assertEqual(r.status_code, 200, r.text)
            p = r.json()["previews"][slug]
            if p["state"] != "pending":
                return p
            await asyncio.sleep(0.25)
        self.fail(f"{slug} stayed pending")

    async def file(self, state: str, data: bytes, mime: str, filename: str, owner: str = "owner", **extra) -> dict:
        d = await self.mkdoc(state, owner=owner, kind="artifact", **extra)
        key = d["blob_key"].rsplit(".", 1)[0] + "." + filename.rsplit(".", 1)[-1]
        self.r2.put_bytes(key, data, mime, False)
        await self.db["documents"].update_one({"_id": d["_id"]}, {"$set": {
            "blob_key": key, "mime": mime, "size_bytes": len(data), "original_filename": filename, "sha256": "s1"}})
        return await self.doc(d["slug"])

    # ── Access ──

    async def test_markdown_for_a_member_is_text_blocks(self):
        d = await self.mkdoc("W", content="# Launch plan\n\nShip **it** <script>alert(1)</script>\n\n- [x] docs\n- tests\n")
        r = await self.previews("wm", [d["slug"]])
        self.assertEqual(r.status_code, 200, r.text)
        p = r.json()["previews"][d["slug"]]
        self.assertEqual(p["state"], "ok")
        self.assertEqual(p["type"], "markdown")
        self.assertEqual(p["blocks"][0], {"t": "h1", "x": "Launch plan"})
        self.assertIn({"t": "todo", "x": "docs", "done": True}, p["blocks"])
        self.assertNotIn("<", json.dumps(p))  # never HTML, never the script

    async def test_only_what_the_caller_can_open(self):
        mine = await self.mkdoc("P", owner="wm")
        theirs = await self.mkdoc("P", owner="owner")           # private to its owner (and grants)
        team = await self.mkdoc("W")
        pw = await self.mkdoc("LP")                               # a member's role opens it, as on click
        other_ws = await self.mkdoc("W", ws="W2", owner="wm2")
        expired = await self.mkdoc("W", expires_at=datetime.now(timezone.utc) - timedelta(hours=1))
        slugs = [mine["slug"], theirs["slug"], team["slug"], pw["slug"], other_ws["slug"], expired["slug"], "no-such-slug"]
        for who in ("wm", "wa", "wo", "wv"):
            r = await self.previews(who, slugs)
            self.assertEqual(r.status_code, 200, r.text)
            got = r.json()["previews"]
            self.assertEqual(got[team["slug"]]["state"], "ok", who)
            self.assertEqual(got[pw["slug"]]["state"], "ok", who)
            for s in (theirs["slug"], other_ws["slug"], expired["slug"], "no-such-slug"):
                self.assertEqual(got[s], {"state": "locked"}, (who, s))  # one answer, nothing else
            self.assertEqual(got[mine["slug"]]["state"], "ok" if who == "wm" else "locked", who)
        # The owner of the private document sees it.
        r = await self.previews("owner", [theirs["slug"]])
        self.assertEqual(r.json()["previews"][theirs["slug"]]["state"], "ok")

    async def test_outsiders_get_nothing(self):
        d = await self.mkdoc("L")
        for who in ("stranger", "gv", "former", "invitee", "wm2"):
            r = await self.previews(who, [d["slug"]])
            self.assertIn(r.status_code, (403, 404), (who, r.text))
            self.assertNotIn("Body", r.text)
        r = await self.previews("", [d["slug"]], headers={})
        self.assertEqual(r.status_code, 401)

    async def test_narrowing_locks_it_at_once(self):
        d = await self.mkdoc("W", owner="owner")
        self.assertEqual((await self.previews("wm", [d["slug"]])).json()["previews"][d["slug"]]["state"], "ok")
        await self.db["documents"].update_one({"_id": d["_id"]}, {"$set": {"access_level": "private"}, "$inc": {"access_epoch": 1}})
        self.assertEqual((await self.previews("wm", [d["slug"]])).json()["previews"][d["slug"]], {"state": "locked"})

    async def test_sign_in_workspace_and_tenant_token(self):
        d = await self.mkdoc("RW")
        self.assertEqual((await self.previews("wm", [d["slug"]], "WR")).json()["previews"][d["slug"]]["state"], "ok")
        # A workspace domain's session has no listing, so no previews either (routers/auth.py).
        items = await self.http.get(f"/api/v1/workspaces/{self.ws['WR']}/items", headers=self.tenant("wm", "WR"))
        r = await self.previews("wm", [d["slug"]], "WR", headers=self.tenant("wm", "WR"))
        self.assertEqual(r.status_code, items.status_code)
        self.assertEqual(r.status_code, 401)

    async def test_encrypted_says_nothing(self):
        d = await self.mkdoc("W", encrypted=True, content="ciphertext-AAAA", title=None)
        p = (await self.previews("wm", [d["slug"]])).json()["previews"][d["slug"]]
        self.assertEqual(p, {"state": "encrypted"})

    async def test_limits(self):
        r = await self.previews("wm", [f"s{i}" for i in range(card_preview.MAX_SLUGS + 1)])
        self.assertEqual(r.status_code, 422)
        r = await self.previews("wm", ["../../x", "a" * 80])
        self.assertEqual(r.json()["previews"], {"../../x": {"state": "locked"}, "a" * 80: {"state": "locked"}})

    # ── Documents and pages ──

    async def test_page_cover_icon_and_labels_left_out(self):
        secret = await self.mkdoc("P", owner="owner", title="Secret plan")
        body = ("---\nicon: 🚀\ncover: gallery:ascent\ncover_y: 30\n---\n"
                f"Intro with :markdrop[Secret plan]{{src=\"{secret['slug']}\"}} and :person[Dana Kim]{{id=\"u1\"}}.\n\n"
                f"::markdrop{{src=\"{secret['slug']}\" title=\"Secret plan\"}}\n\n## Next steps\n")
        page = await self.mkdoc("W", owner="owner", editor="blocks", content=body)
        p = (await self.previews("wm", [page["slug"]])).json()["previews"][page["slug"]]
        self.assertEqual(p["type"], "page")
        self.assertEqual(p["icon"], "🚀")
        self.assertEqual(p["cover"], {"gallery": "ascent", "y": 30})
        self.assertNotIn("Secret", json.dumps(p))
        self.assertIn({"t": "h2", "x": "Next steps"}, p["blocks"])
        self.assertIn("@Dana Kim", p["blocks"][0]["x"])  # members are in the page's circle

    async def test_page_uploaded_cover_is_a_thumbnail(self):
        page = await self.mkdoc("W", owner="owner", editor="blocks", content="---\ncover: asset:cover0001\n---\nHello\n")
        key = f"pa/{page['_id']}/cover0001.png"
        self.r2.put_bytes(key, png(), "image/png", False)
        await self.db["page_assets"].insert_one({"_id": "cover0001", "doc_id": str(page["_id"]), "key": key, "mime": "image/png"})
        p = await self.settled("wm", page["slug"])
        self.assertTrue(p["cover"]["src"].startswith("data:image/webp;base64,"), p)

    async def test_a_long_document_is_cut_at_a_line(self):
        long = "# Title\n\n" + ("word " * 30 + "\n") * 600
        d = await self.mkdoc("W", content=long)
        p = (await self.previews("wm", [d["slug"]])).json()["previews"][d["slug"]]
        self.assertLessEqual(len(p["blocks"]), card_preview.MAX_BLOCKS)
        self.assertLess(len(json.dumps(p)), 6000)

    # ── Files ──

    async def test_html_file_text_and_live_url(self):
        html = b"<html><head><title>Q3 report</title><script>steal()</script></head><body><h1>Revenue</h1><p>Up 12%</p></body></html>"
        d = await self.file("W", html, "text/html", "report.html")
        p = await self.settled("wm", d["slug"])
        self.assertEqual(p["type"], "html")
        self.assertEqual(p["blocks"][:2], [{"t": "h1", "x": "Revenue"}, {"t": "p", "x": "Up 12%"}])
        self.assertNotIn("steal", json.dumps(p))
        self.assertTrue(p["live"].startswith(f"{ORIGIN}/r/{d['blob_key']}?t="), p["live"])  # signed: not public
        self.assertGreater(p["live_ttl"], 0)

    async def test_image_pdf_and_poster_are_webp_thumbnails(self):
        img = await self.file("W", png(), "image/png", "shot.png")
        doc = await self.file("W", pdf(), "application/pdf", "spec.pdf")
        vid = await self.file("W", b"\x00" * 64, "video/mp4", "demo.mp4")
        poster = vid["blob_key"] + ".poster.jpg"
        b = io.BytesIO()
        Image.new("RGB", (1280, 720), (10, 10, 10)).save(b, "JPEG")
        self.r2.put_bytes(poster, b.getvalue(), "image/jpeg", False)
        await self.db["documents"].update_one({"_id": vid["_id"]}, {"$set": {"poster_key": poster, "media": {"duration_s": 42.25}}})
        for d, kind in ((img, "image"), (doc, "pdf"), (vid, "video")):
            p = await self.settled("wm", d["slug"])
            self.assertEqual(p["type"], kind)
            self.assertTrue(p["src"].startswith("data:image/webp;base64,"), (kind, p))
            self.assertLessEqual(p["w"], 560)
        self.assertEqual((await self.settled("wm", doc["slug"]))["pages"], 1)
        self.assertEqual((await self.settled("wm", vid["slug"]))["duration"], 42.2)
        # Cached: made once, kept by the source object.
        self.assertGreaterEqual(await self.db[card_preview.COLL].count_documents({"doc": str(img["_id"])}), 1)

    async def test_sheets_text_and_word(self):
        csv_doc = await self.file("W", b"name,score\nAda,9\nLin,7\n", "text/csv", "scores.csv")
        x = await self.file("W", xlsx([["Region", "Q1"], ["North", "12"], ["South", "9.5"]]),
                            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "q.xlsx")
        t = await self.file("W", b'{"b": [1, 2], "a": "x"}', "application/json", "data.json")
        w = await self.file("W", docx([("Title", "Handbook"), ("", "Welcome aboard"), ("ListParagraph", "Badge")]),
                            "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "h.docx")
        self.assertEqual((await self.settled("wm", csv_doc["slug"]))["rows"], [["name", "score"], ["Ada", "9"], ["Lin", "7"]])
        self.assertEqual((await self.settled("wm", x["slug"]))["rows"], [["Region", "Q1"], ["North", "12"], ["South", "9.5"]])
        self.assertEqual((await self.settled("wm", t["slug"]))["lines"][:2], ["{", '  "b": ['])
        self.assertEqual((await self.settled("wm", w["slug"]))["blocks"],
                         [{"t": "h1", "x": "Handbook"}, {"t": "p", "x": "Welcome aboard"}, {"t": "li", "x": "Badge"}])

    async def test_svg_broken_and_audio_have_no_picture(self):
        svg = await self.file("W", b'<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>', "image/svg+xml", "a.svg")
        bad = await self.file("W", b"%PDF-1.4 not really", "application/pdf", "bad.pdf")
        audio = await self.file("W", b"ID3", "audio/mpeg", "a.mp3")
        for d in (svg, bad, audio):
            p = await self.settled("wm", d["slug"])
            self.assertEqual(p["state"], "ok")
            self.assertEqual(set(p), {"state", "type"}, p)

    async def test_unreadable_files_make_nothing(self):
        d = await self.file("P", png(), "image/png", "private.png", owner="owner")
        r = await self.previews("wm", [d["slug"]])
        self.assertEqual(r.json()["previews"][d["slug"]], {"state": "locked"})
        await asyncio.sleep(0.2)
        self.assertEqual(await self.db[card_preview.COLL].count_documents({}), 0)

    async def test_delete_clears_the_cache(self):
        d = await self.file("W", png(), "image/png", "shot.png")
        await self.settled("wm", d["slug"])
        self.assertGreater(await self.db[card_preview.COLL].count_documents({"doc": str(d["_id"])}), 0)
        await lifecycle.destroy(self.db, await self.doc(d["slug"]))
        self.assertEqual(await self.db[card_preview.COLL].count_documents({"doc": str(d["_id"])}), 0)

    # ── MCP ──

    async def test_mcp_list_items_with_previews(self):
        md = await self.mkdoc("W", owner="wm", content="# Roadmap\n\n- Q1 launch\n")
        enc = await self.mkdoc("W", owner="wm", encrypted=True, content="AAAA")
        hidden = await self.mkdoc("P", owner="owner", content="# Hidden thing\n")
        token = await self.mcp_token("wm", write=False)
        status, res = await self.mcp_call(token, "list_workspace_items", {"workspace": self.ws["W1"], "previews": True, "limit": 20})
        self.assertEqual(status, 200)
        self.assertFalse(res.get("isError"), res)
        items = {i["slug"]: i for i in res["structuredContent"]["items"]}
        self.assertEqual(items[md["slug"]]["preview"], "Roadmap / - Q1 launch")
        self.assertIn("encrypted", items[enc["slug"]]["preview"])
        self.assertNotIn(hidden["slug"], items)
        self.assertNotIn("Hidden thing", json.dumps(res))
        # Without the flag: no preview key, as before.
        status, res = await self.mcp_call(token, "list_workspace_items", {"workspace": self.ws["W1"]})
        self.assertNotIn("preview", res["structuredContent"]["items"][0])
