"""Export (services/page_export.py, routers/page_export.py, MCP export_page).

Portable Markdown for every block, the HTML file's escaping, locked items (never a
title), who may export (allow_export), sub-pages filtered by access, images in the
zip and inlined in HTML, encrypted documents, and the MCP tool with its download
link. The access-policy world: the test MongoDB (or mongomock) and an in-memory R2;
never backend/.env.
"""

from __future__ import annotations

import io
import re
import zipfile
from html import unescape
from html.parser import HTMLParser

from tests.test_pages import PageWorld, png  # noqa: F401  (pins settings first)

from app.services import page_export as E
from app.services import page_props

LOCKED = "Locked item"


def ctx(markdown: str = "", **kw) -> E.PageCtx:
    base = dict(slug="s", title="Launch plan", url="https://markdrop.in/s", props=page_props.parse(markdown),
                embeds={}, images={}, public=False, public_urls={}, crumbs=[])
    base.update(kw)
    return E.PageCtx(**base)


OK = {"state": "ok", "kind": "document", "renderer": "markdown", "title": "Open Doc", "url": "https://markdrop.in/open-doc"}
DENIED = {"state": "denied", "kind": None}


# ── Portable Markdown, block by block ────────────────────────────────────────


class PortableMarkdown(PageWorld):
    def md(self, src: str, **kw) -> str:
        out = E.to_markdown(src, ctx(src, **kw))
        # The title heading comes first; the rest is the body.
        self.assertTrue(out.startswith("# "), out)
        return out.split("\n", 2)[2] if out.count("\n") >= 2 else ""

    async def test_title_icon_and_front_matter(self):
        out = E.to_markdown("---\nicon: 🚀\nfull_width: true\n---\nHello\n", ctx("---\nicon: 🚀\n---\n"))
        self.assertTrue(out.startswith("# 🚀 Launch plan\n\nHello"), out)
        self.assertNotIn("full_width", out)
        self.assertNotIn("---", out)

    async def test_plain_markdown_unchanged(self):
        src = ("Some **bold**, *italic*, ~~strike~~ and `code`, a [link](https://example.com).\n\n"
               "- a\n  - nested\n1. one\n- [ ] todo\n- [x] done\n\n> quote\n\n---\n\n"
               "| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```python\nprint(':span[x]{color=red}')\n```\n\n"
               "$E = mc^2$\n\n$$\nx^2\n$$\n\n```mermaid\ngraph TD\n  A --> B\n```")
        self.assertEqual(self.md(src).strip(), src.strip())

    async def test_block_options_dropped(self):
        src = ('A paragraph. {#b-k3x9a1 color="green"}\n\n## Title {bg="blue"}\n\n- Item {bg="pink"}\n'
               '- [ ] A to-do {color="orange"}\n\n> A quote {color="gray"}\n\n| Ada {bg="yellow"} | x |\n'
               '| --- | --- |\n| 1 | 2 {color="red"} |\n\n{header-column widths="120,240,"}\n\n'
               '```js\nx\n```\n{caption="A small example"}\n\nNot options {like this}. Escaped \\{#b-abcd}')
        out = self.md(src)
        self.assertIn("A paragraph.\n", out)
        self.assertIn("## Title\n", out)
        self.assertIn("- Item\n- [ ] A to-do\n", out)
        self.assertIn("> A quote\n", out)
        self.assertIn("| Ada | x |", out)
        self.assertIn("| 1 | 2 |", out)
        self.assertNotIn("widths", out)
        self.assertIn("```\n*A small example*", out)
        self.assertIn("Not options {like this}.", out)
        self.assertIn("\\{#b-abcd}", out)
        self.assertNotIn("color=", out)
        self.assertNotIn("bg=", out)

    async def test_callouts_are_labelled_quotes(self):
        out = self.md(":::tip[A title]{icon=\"🔥\" color=\"blue\"}\nDo *this*.\n\nThen that.\n:::\n\n"
                      ":::warning\nCareful.\n:::\n\n:::info\nInfo.\n:::")
        self.assertIn("> **🔥 Tip: A title**\n>\n> Do *this*.\n>\n> Then that.", out)
        self.assertIn("> **⚠️ Warning**\n>\n> Careful.", out)
        self.assertIn("> **ℹ️ Note**\n>\n> Info.", out)

    async def test_toggles(self):
        out = self.md(':::details{summary="Why <now>?"}\nBecause.\n:::\n\n:::details{summary="FAQ" heading=2}\n'
                      "Answers.\n:::\n\n:::details[Label form]\nBody.\n:::")
        self.assertIn("<details>\n<summary>Why &lt;now&gt;?</summary>\n\nBecause.\n\n</details>", out)
        self.assertIn("## FAQ\n\nAnswers.", out)
        self.assertIn("<summary>Label form</summary>", out)

    async def test_columns_indent_and_buttons(self):
        out = self.md('::::columns\n:::column{width="40%"}\nLeft.\n:::\n\n:::column\nRight.\n:::\n::::\n\n'
                      "Parent.\n\n:::indent\nNested.\n:::\n\n:::button{label=\"Add\"}\n- [ ] New task\n:::\n\nEnd.")
        self.assertEqual(out.strip(), "Left.\n\nRight.\n\nParent.\n\nNested.\n\nEnd.")

    async def test_nested_containers(self):
        out = self.md(":::::columns\n::::column\n:::note\nIn a column.\n:::\n::::\n::::column\nB\n::::\n:::::")
        self.assertIn("> **ℹ️ Note**\n>\n> In a column.", out)
        self.assertIn("\n\nB", out)
        self.assertNotIn(":::", out)

    async def test_chips_are_text(self):
        out = self.md('Due :date[2026-11-10], owner :person[Ada Lovelace]{id="6650f0c2a1"} and :person[]{id="x"}, '
                      'press :kbd[⌘ K], :span[red **word**]{color="red"}, :span[hi]{bg="yellow"}, :u[under], '
                      'time 10:30 and a:span[not]{color=red} and :unknown[x]{y=1}.')
        self.assertEqual(out.strip(), "Due Nov 10, 2026, owner @Ada Lovelace and a person, press `⌘ K`, red **word**, "
                                      "hi, under, time 10:30 and a:span[not]{color=red} and :unknown[x]{y=1}.")

    async def test_items_links_and_locked(self):
        src = (':markdrop[Secret plan]{src="secret"} and :markdrop[Open]{src="open-doc"}.\n\n'
               '::markdrop{src=secret title="Top secret"}\n::markdrop{src="https://markdrop.in/open-doc" mode=card}\n'
               "::page{src=kid}\n::markdrop{src=gone}")
        kid = {**OK, "title": "Kid page", "url": "https://markdrop.in/kid"}
        out = self.md(src, embeds={"secret": DENIED, "open-doc": OK, "kid": kid, "gone": {"state": "missing"}})
        self.assertIn(f"*{LOCKED}* and [Open Doc](https://markdrop.in/open-doc).", out)
        self.assertEqual(out.count(LOCKED), 3)
        self.assertIn("📄 [Open Doc](https://markdrop.in/open-doc)", out)
        self.assertIn("📄 [Kid page](https://markdrop.in/kid)", out)
        for leak in ("Secret plan", "Top secret", "secret", "gone"):
            self.assertNotIn(leak, out)

    async def test_bookmark_embed_toc_breadcrumb(self):
        src = ('::breadcrumb\n\n::toc\n\n# One\n\n## Two\n\n### Three\n\n#### Four\n\n'
               '::bookmark{url="https://example.com/p" title="The post" description="What it says"}\n'
               '::embed{src="https://www.youtube.com/watch?v=dQw4w9WgXcQ"}\n::bookmark{url="javascript:alert(1)"}')
        out = self.md(src, crumbs=[{"title": "Parent"}])
        self.assertIn("*Parent / Launch plan*", out)
        self.assertIn("- [One](#one)\n  - [Two](#two)\n    - [Three](#three)\n\n# One", out)
        self.assertNotIn("[Four]", out)
        self.assertIn("[The post](https://example.com/p) — What it says", out)
        self.assertIn("[YouTube: https://www.youtube.com/watch?v=dQw4w9WgXcQ](https://www.youtube.com/watch?v=dQw4w9WgXcQ)", out)
        self.assertNotIn("](javascript", out)

    async def test_images(self):
        src = '![A chart](asset:abcdef123456 "Its caption"){width="60%" align="left"}\n\n![Web](https://e.com/x.png)'
        img = E.Image("abcdef123456", "pa/d/abcdef123456.png", "image/png", "png")
        private = self.md(src, images={"abcdef123456": img})
        self.assertIn("_[Image: A chart]_", private)
        self.assertNotIn("asset:", private)
        self.assertIn("![Web](https://e.com/x.png)", private)
        public = self.md(src, images={"abcdef123456": img}, public=True,
                         public_urls={"abcdef123456": "https://cdn.example/r/pa/d/abcdef123456.png"})
        self.assertIn('![A chart](https://cdn.example/r/pa/d/abcdef123456.png "Its caption")', public)
        zipped = E.Image("abcdef123456", "pa/d/abcdef123456.png", "image/png", "png", path="images/001-abcdef12.png")
        z = self.md(src, images={"abcdef123456": zipped}, mode="zip")
        self.assertIn('![A chart](images/001-abcdef12.png "Its caption")', z)
        self.assertNotIn("width=", z)

    async def test_every_page_syntax_construct_leaves_no_directive(self):
        """The sample page from the reference: nothing of the directive syntax is left."""
        from pathlib import Path

        sample = Path(__file__).parent / "fixtures" / "export_sample.md"
        src = sample.read_text()
        out = E.to_markdown(src, ctx(src, embeds={"open-doc": OK, "kid": {**OK, "title": "Kid"}}))
        out = re.sub(r"`[^`\n]+`", "", out)  # inline code keeps what it says
        for bit in (":::", "::markdrop", ":span[", ":person[", ":date[", ":kbd[", ":u[", "::page", "::toc",
                    "::bookmark", "::embed", "{#b-", 'color="', "asset:"):
            self.assertNotIn(bit, out, bit)


# ── HTML: the look, and nothing an author wrote ever runs ───────────────────


class _Scan(HTMLParser):
    def __init__(self):
        super().__init__()
        self.scripts: list[dict] = []
        self.handlers: list[tuple[str, str]] = []
        self.urls: list[str] = []
        self.tags: list[str] = []

    def handle_starttag(self, tag, attrs):
        self.tags.append(tag)
        a = dict(attrs)
        if tag == "script":
            self.scripts.append(a)
        for k, v in attrs:
            if k.startswith("on"):
                self.handlers.append((tag, k))
            if k in ("href", "src", "action", "formaction", "xlink:href") and v:
                self.urls.append(v)


class HtmlExport(PageWorld):
    def html(self, src: str, **kw) -> str:
        c = ctx(src, **kw)
        return E.html_document(E.to_html_body(src, c), c)

    async def test_author_html_never_runs(self):
        evil = ('<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n[x](javascript:alert(3))\n\n'
                '![i](javascript:alert(4))\n\n:span[<b onmouseover=alert(5)>]{color="red"}\n\n'
                '::bookmark{url="javascript:alert(6)" title="<script>alert(7)</script>"}\n\n'
                '::bookmark{url="https://ok.example" title="\\"><script>alert(8)</script>" image="javascript:x"}\n\n'
                ':::note[<svg onload=alert(9)>]\nx\n:::\n\n:::details{summary="<iframe src=javascript:alert(10)>"}\ny\n:::\n\n'
                '```html\n</code></pre><script>alert(11)</script>\n```\n\n'
                '| <script>alert(12)</script> |\n| --- |\n| x |\n\n:kbd[<script>]\n\n'
                ':markdrop[<script>]{src="x\\" onload=\\"alert(13)"}\n\n<!-- comment --><style>body{}</style>')
        out = self.html(evil, title='T</title><script>alert(14)</script>')
        scan = _Scan()
        scan.feed(out)
        self.assertEqual(scan.scripts, [], out)
        self.assertEqual(scan.handlers, [])
        for u in scan.urls:
            self.assertFalse(u.strip().lower().startswith(("javascript:", "vbscript:", "data:text")), u)
        self.assertNotIn("<iframe", out)
        self.assertNotIn("<svg", out)
        self.assertNotIn("<style>body{}", out)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", out)
        self.assertIn("script-src 'none'", unescape(out))

    async def test_math_and_mermaid_scripts_are_ours_only(self):
        out = self.html("$x^2$ and\n\n```mermaid\ngraph TD\n  A --> B\n```\n\n<script>alert(1)</script>")
        scan = _Scan()
        scan.feed(out)
        self.assertEqual(len(scan.scripts), 1)
        nonce = scan.scripts[0].get("nonce")
        self.assertTrue(nonce)
        self.assertIn(f"script-src 'nonce-{nonce}' https://cdn.jsdelivr.net", unescape(out))
        self.assertIn('<pre class="mermaid">graph TD\n  A --&gt; B\n</pre>', out)
        self.assertIn('<span class="math inline">x^2</span>', out)

    async def test_blocks_look_like_the_page(self):
        src = ('---\nicon: 🚀\ncover: gallery:dawn\nfull_width: true\nfont: serif\n---\n'
               'Para {#b-k3x9a1 color="green"}\n\n## Head {bg="blue"}\n\n- Item {bg="pink"}\n\n'
               ':::tip[Title]{color="blue"}\nBody\n:::\n\n:::details{summary="More"}\nHidden\n:::\n\n'
               '::::columns\n:::column{width="40%"}\nL\n:::\n:::column\nR\n:::\n::::\n\n'
               '| A {bg="yellow"} |\n| --- |\n| 1 |\n\n::markdrop{src=secret title="Top secret"}\n\n'
               '![A](asset:abcdef123456 "Cap"){width="60%" align="left"}')
        img = E.Image("abcdef123456", "k", "image/png", "png", data_uri="data:image/png;base64,iVBORw0K")
        out = self.html(src, embeds={"secret": DENIED}, images={"abcdef123456": img})
        self.assertIn('<p data-color="green" id="b-k3x9a1">Para</p>', out)
        self.assertIn('<h2 data-bg="blue" id="head">Head</h2>', out)
        self.assertIn('<li data-bg="pink">Item</li>', out)
        self.assertIn('class="callout" data-kind="tip" data-bg="blue"', out)
        self.assertIn('<details class="toggle" open>', out)
        self.assertIn('<div class="column" style="flex:0 1 40%">', out)
        self.assertIn('<th data-bg="yellow">A</th>', out)
        self.assertIn(LOCKED, out)
        self.assertNotIn("Top secret", out)
        self.assertIn('<figure class="figure" style="--w:60%" data-align="left"><img src="data:image/png;base64,iVBORw0K"', out)
        self.assertIn("<figcaption>Cap</figcaption>", out)
        self.assertIn('class="page wide serif"', out)
        self.assertIn("/page-covers/dawn.webp", out)
        self.assertIn('<span class="icon" aria-hidden="true">🚀</span><h1 class="title">Launch plan</h1>', out)
        self.assertIn("@media print", out)


# ── Through the API ──────────────────────────────────────────────────────────


class ExportApi(PageWorld):
    async def export(self, slug: str, who: str | None = "owner", **params):
        params.setdefault("format", "md")
        params = {k: (str(v).lower() if isinstance(v, bool) else v) for k, v in params.items()}
        return await self.http.get(f"/api/v1/documents/{slug}/export", params=params,
                                   headers=self.session(who) if who else {})

    async def test_locked_embeds_never_name_the_item(self):
        secret = await self.mkdoc("UP", title="Top secret roadmap")
        open_doc = await self.mkdoc("UL", title="Public notes")
        page = await self.create(content=(f':markdrop[Top secret roadmap]{{src="{secret["slug"]}"}} and '
                                          f':markdrop[Public notes]{{src="{open_doc["slug"]}"}}\n\n'
                                          f'::markdrop{{src="{secret["slug"]}" title="Top secret roadmap"}}\n'
                                          f'::markdrop{{src="{open_doc["slug"]}" mode="card"}}\n'))
        for fmt in ("md", "html"):
            r = await self.export(page["slug"], "stranger", format=fmt)
            self.assertEqual(r.status_code, 200, r.text)
            self.assertNotIn("Top secret roadmap", r.text)
            self.assertNotIn(secret["slug"], r.text)
            self.assertIn(LOCKED, r.text)
            self.assertIn("Public notes", r.text)
            anon = await self.export(page["slug"], None, format=fmt)
            self.assertEqual(anon.status_code, 200)
            self.assertNotIn("Top secret roadmap", anon.text)
        mine = await self.export(page["slug"], "owner")
        self.assertIn("[Top secret roadmap](", mine.text)
        self.assertNotIn(LOCKED, mine.text)

    async def test_headers_and_file_name(self):
        page = await self.create(title="Q3 plan: “launch”/ops", content="Hello")
        r = await self.export(page["slug"])
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.headers["content-type"].startswith("text/markdown"))
        cd = r.headers["content-disposition"]
        self.assertTrue(cd.startswith("attachment; "), cd)
        self.assertIn("filename*=UTF-8''", cd)
        self.assertNotIn("/", cd.split("filename=")[1].split(";")[0])
        self.assertEqual(r.headers["cache-control"], "no-store")
        h = await self.export(page["slug"], format="html")
        self.assertTrue(h.headers["content-type"].startswith("text/html"))
        self.assertIn("sandbox", h.headers["content-security-policy"])
        self.assertTrue(h.text.startswith("<!doctype html>"))

    async def test_readers_need_allow_export(self):
        page = await self.create(content="---\nallow_export: false\n---\n# Private notes\n")
        for who in ("stranger", None):
            r = await self.export(page["slug"], who)
            self.assertEqual(r.status_code, 403, (who, r.text))
            self.assertEqual(r.json()["code"], "export_off")
        self.assertEqual((await self.export(page["slug"], "owner")).status_code, 200)
        # An edit secret makes an editor.
        r = await self.http.get(f"/api/v1/documents/{page['slug']}/export", params={"format": "md"},
                                headers={"X-Edit-Secret": "wrong"})
        self.assertEqual(r.status_code, 403)
        # A reader who can't read it at all learns nothing more than a 404.
        await self.set_level(page["slug"], "private")
        self.assertEqual((await self.export(page["slug"], "stranger")).status_code, 404)

    async def test_allow_export_is_a_page_property(self):
        self.assertTrue(E.allows_readers("# x"))
        self.assertFalse(E.allows_readers("---\nallow_export: false\n---\n"))
        self.assertEqual(page_props.apply("x", {"allow_export": False}), "---\nallow_export: false\n---\nx")
        self.assertEqual(page_props.apply("---\nallow_export: false\n---\nx", {"allow_export": True}), "x")

    async def test_encrypted_and_files_refused(self):
        enc = await self.mkdoc("UL", encrypted=True, content="mdx1.aaaaaaaaaaaaaaaaaaaa.bbbb")
        r = await self.export(enc["slug"])
        self.assertEqual(r.status_code, 422)
        self.assertEqual(r.json()["code"], "encrypted")
        self.assertIn("Download Markdown", r.json()["detail"])
        art = await self.mkdoc("UL", kind="artifact")
        r = await self.export(art["slug"])
        self.assertEqual(r.status_code, 422)
        self.assertEqual(r.json()["code"], "not_markdown")

    async def test_bad_format(self):
        page = await self.create(content="x")
        self.assertEqual((await self.export(page["slug"], format="pdf")).status_code, 422)

    async def test_subpages_only_those_the_exporter_can_open(self):
        top = await self.create(title="Handbook", content="::toc\n\n# Top\n\n::page{src=PLACEHOLDER}\n")
        open_kid = await self.sub(top["slug"], title="Open chapter", content="Open body")
        closed = await self.sub(top["slug"], title="Closed chapter", content="Closed body")
        grandkid = await self.sub(closed["slug"], title="Deep chapter", content="Deep body")
        await self.set_level(closed["slug"], "private")
        raw = await self.doc(top["slug"])
        await self.db["documents"].update_one({"_id": raw["_id"]}, {"$set": {"content": raw["content"].replace(
            "PLACEHOLDER", open_kid["slug"])}})

        def names(r) -> dict[str, str]:
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.headers["content-type"], "application/zip")
            z = zipfile.ZipFile(io.BytesIO(r.content))
            return {n: z.read(n).decode() for n in z.namelist()}

        files = names(await self.export(top["slug"], "stranger", subpages=True))
        self.assertEqual(set(files), {"Handbook/page.md", "Handbook/Open chapter/page.md"})
        everything = "\n".join(files) + "\n".join(files.values())
        for leak in ("Closed chapter", "Closed body", "Deep chapter", closed["slug"], grandkid["slug"]):
            self.assertNotIn(leak, everything)
        self.assertIn("[Open chapter](Open%20chapter/page.md)", files["Handbook/page.md"].replace("<Open chapter/page.md>", "Open%20chapter/page.md"))
        self.assertIn("## Pages inside", files["Handbook/page.md"])

        owner = names(await self.export(top["slug"], "owner", subpages=True))
        self.assertEqual(set(owner), {"Handbook/page.md", "Handbook/Open chapter/page.md",
                                      "Handbook/Closed chapter/page.md",
                                      "Handbook/Closed chapter/Deep chapter/page.md"})
        html = names(await self.export(top["slug"], "owner", format="html", subpages=True))
        self.assertIn("Handbook/Closed chapter/Deep chapter/page.html", html)

    async def test_subpage_with_export_off_left_out_for_readers(self):
        top = await self.create(title="Top", content="x")
        await self.sub(top["slug"], title="No export", content="---\nallow_export: false\n---\nsecret words")
        r = await self.export(top["slug"], "stranger", subpages=True)
        z = zipfile.ZipFile(io.BytesIO(r.content))
        self.assertEqual(sorted(z.namelist()), ["Top/EXPORT-NOTES.txt", "Top/page.md"])
        self.assertIn("1 sub-page couldn't be exported", z.read("Top/EXPORT-NOTES.txt").decode())
        self.assertNotIn("secret words", b"".join(z.read(n) for n in z.namelist()).decode())

    async def test_images_zip_and_inline_html(self):
        page = await self.create(title="Pics", content="x")
        data = png((10, 200, 30), (4, 3))
        up = await self.upload(page["slug"], self.session("owner"), data)
        self.assertEqual(up.status_code, 201, up.text)
        aid = up.json()["id"]
        raw = await self.doc(page["slug"])
        await self.db["documents"].update_one({"_id": raw["_id"]}, {"$set": {
            "content": f'---\ncover: asset:{aid}\n---\n![Green](asset:{aid} "A caption")\n'}})
        r = await self.export(page["slug"], format="zip")
        z = zipfile.ZipFile(io.BytesIO(r.content))
        imgs = [n for n in z.namelist() if n.startswith("Pics/images/")]
        self.assertEqual(len(imgs), 1)
        self.assertEqual(z.read(imgs[0]), data)
        md = z.read("Pics/page.md").decode()
        rel = imgs[0].removeprefix("Pics/")
        self.assertIn(f'![Green]({rel} "A caption")', md)
        self.assertTrue(md.startswith(f"![Cover]({rel})"))
        h = await self.export(page["slug"], format="html")
        self.assertIn("data:image/png;base64,", h.text)
        self.assertNotIn("asset:", h.text)
        # A single .md of a private page doesn't carry expiring links.
        await self.set_level(page["slug"], "private")
        one = await self.export(page["slug"], format="md")
        self.assertIn("_[Image: Green]_", one.text)
        self.assertNotIn("?t=", one.text)

    async def test_too_many_subpages(self):
        top = await self.create(title="Big", content="x")
        from unittest import mock

        await self.sub(top["slug"], title="A", content="a")
        await self.sub(top["slug"], title="B", content="b")
        with mock.patch.object(E, "MAX_PAGES", 2):
            r = await self.export(top["slug"], subpages=True)
        self.assertEqual(r.status_code, 413)
        self.assertEqual(r.json()["code"], "too_many_pages")


# ── MCP ──────────────────────────────────────────────────────────────────────


class ExportMcp(PageWorld):
    async def test_tool_listed(self):
        from app.mcp import tools as mcp_tools

        tool = next(t for t in mcp_tools.TOOLS if t.name == "export_page")
        self.assertEqual(tool.scope, "documents:read")
        self.assertTrue(tool.annotations["readOnlyHint"])

    async def test_markdown_and_html_come_back(self):
        secret = await self.mkdoc("UP", title="Hidden thing")
        page = await self.create(title="Notes", content=f':::note\nHi\n:::\n\n::markdrop{{src="{secret["slug"]}"}}')
        token = await self.mcp_token("stranger", write=False)
        status, res = await self.mcp_call(token, "export_page", {"document": page["slug"]})
        self.assertEqual(status, 200)
        self.assertFalse(res.get("isError"), res)
        out = res["structuredContent"]
        self.assertIn("> **ℹ️ Note**", out["content"])
        self.assertIn(LOCKED, out["content"])
        self.assertNotIn("Hidden thing", out["content"])
        self.assertEqual(out["filename"], "Notes.md")
        status, res = await self.mcp_call(token, "export_page", {"document": page["slug"], "format": "html"})
        self.assertTrue(res["structuredContent"]["content"].startswith("<!doctype html>"))
        # The link works without a sign-in, for a while, for that page only.
        url = res["structuredContent"]["download_url"]
        path = url.removeprefix("https://api.markdrop.in")
        r = await self.http.get(path)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn("Hidden thing", r.text)
        other = await self.create(title="Other", content="x")
        bad = path.replace(page["slug"], other["slug"])
        self.assertEqual((await self.http.get(bad)).status_code, 404)
        self.assertEqual((await self.http.get(path + "x")).status_code, 404)

    async def test_zip_link_and_subpages(self):
        page = await self.create(title="Root", content="x")
        await self.sub(page["slug"], title="Kid", content="kid body")
        token = await self.mcp_token("owner")
        status, res = await self.mcp_call(token, "export_page", {"document": page["slug"], "include_subpages": True})
        out = res["structuredContent"]
        self.assertNotIn("content", out)
        self.assertEqual(out["pages"], 2)
        r = await self.http.get(out["download_url"].removeprefix("https://api.markdrop.in"))
        z = zipfile.ZipFile(io.BytesIO(r.content))
        self.assertEqual(sorted(z.namelist()), ["Root/Kid/page.md", "Root/page.md"])

    async def test_link_rechecks_access(self):
        page = await self.create(title="Was open", content="x")
        token = await self.mcp_token("stranger", write=False)
        _s, res = await self.mcp_call(token, "export_page", {"document": page["slug"]})
        path = res["structuredContent"]["download_url"].removeprefix("https://api.markdrop.in")
        await self.set_level(page["slug"], "private")
        self.assertEqual((await self.http.get(path)).status_code, 404)

    async def test_refusals(self):
        page = await self.create(content="---\nallow_export: false\n---\nx")
        token = await self.mcp_token("stranger", write=False)
        _s, res = await self.mcp_call(token, "export_page", {"document": page["slug"]})
        self.assertTrue(res["isError"])
        self.assertIn("turned off exporting", res["content"][0]["text"])
        owner = await self.mcp_token("owner", write=False)
        _s, res = await self.mcp_call(owner, "export_page", {"document": page["slug"]})
        self.assertFalse(res.get("isError"), res)
        enc = await self.mkdoc("UL", encrypted=True, content="mdx1.aaaaaaaaaaaaaaaaaaaa.bbbb")
        _s, res = await self.mcp_call(owner, "export_page", {"document": enc["slug"]})
        self.assertTrue(res["isError"])
        self.assertIn("encrypted", res["content"][0]["text"])

    async def test_set_page_properties_allow_export(self):
        page = await self.create(content="x")
        token = await self.mcp_token("owner")
        _s, res = await self.mcp_call(token, "set_page_properties", {"document": page["slug"], "allow_export": False})
        self.assertFalse(res.get("isError"), res)
        raw = await self.doc(page["slug"])
        self.assertIn("allow_export: false", raw["content"])
        self.assertTrue(re.search(r"^---\n", raw["content"]))
