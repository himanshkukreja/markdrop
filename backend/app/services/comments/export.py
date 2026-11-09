"""Exports with comments (Track C): an item's comment threads in its Markdown, Word and PDF exports.

* **Markdown** — an appendix, ``## Comments``: each thread numbered in page order, what it's about (the quoted
  text or "the whole page"), its status, and every message with its author and date.
* **Word (.docx)** — the page as a Word document (services/page_export.py ``format=docx``) with the threads as
  real Word comments in the margin (``style=margin``: anchored on the quoted words, or the whole paragraph for a
  block comment, or the title for a page comment) or as footnotes after the quoted words (``style=footnotes``).
  A thread whose text changed since and can't be placed goes to a "Comments" section at the end.
* **PDF** — printed by the reader's browser (components/pages/export): ``GET …/comments/export`` gives it the same
  ordered, numbered threads, which it shows as numbered notes beside the text or as footnotes.

Who: only someone who may see the item's comments now (``perms.view``) gets them; otherwise the export goes out
without comments and says so in its notes. Deleted messages and threads never leave; replies keep their order.
"""

from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from xml.sax.saxutils import escape as _xesc

from bson import ObjectId

STYLES = ("footnotes", "margin")
STATUSES = ("open", "all")
MAX_THREADS = 500
NOT_ALLOWED_NOTE = "Comments weren't included: you can't see the comments on this page."


# ── Collecting ────────────────────────────────────────────────────────────────


@dataclass
class ExportMessage:
    author: str
    at: datetime | None
    body: str
    ai: bool = False


@dataclass
class ExportThread:
    n: int
    id: str
    anchor_type: str            # text | block | page
    quote: str | None           # the words it's about (text), the block's text (block), None (page)
    status: str                 # open | resolved
    changed: bool               # its text changed since ("text was changed")
    section: str | None
    messages: list[ExportMessage] = field(default_factory=list)
    suggestion: str | None = None
    resolved_by: str | None = None

    def as_dict(self) -> dict:
        return {"n": self.n, "id": self.id, "anchor_type": self.anchor_type, "quote": self.quote,
                "status": self.status, "changed": self.changed, "section": self.section,
                "suggestion": self.suggestion, "resolved_by": self.resolved_by,
                "messages": [{"author": m.author, "at": _iso(m.at), "body": m.body, "ai": m.ai} for m in self.messages]}


def _aware(v: datetime | None) -> datetime | None:
    if v is None:
        return None
    return v if v.tzinfo else v.replace(tzinfo=timezone.utc)


def _iso(v: datetime | None) -> str | None:
    v = _aware(v)
    return v.isoformat().replace("+00:00", "Z") if v else None


def _day(v: datetime | None) -> str:
    v = _aware(v)
    return f"{v.strftime('%b')} {v.day}, {v.year}" if v else ""


async def can_include(db, actor, raw: dict, ctx) -> bool:
    from app.services.comments import perms

    try:
        return (await perms.perms_for(db, actor, raw, ctx)).view
    except Exception:
        return False


async def collect(db, actor, raw: dict, ctx, *, status: str = "all") -> list[ExportThread] | None:
    """The item's threads in page order (numbered from 1), or None when ``actor`` may not see its comments."""
    from app.services.comments import analytics, notify_email

    if not await can_include(db, actor, raw, ctx):
        return None
    q: dict[str, Any] = {"doc_id": str(raw["_id"]), "deleted_at": None}
    if status == "open":
        q["status"] = "open"
    threads = await db["comment_threads"].find(q).sort("created_at", 1).limit(MAX_THREADS).to_list(length=MAX_THREADS)
    if not threads:
        return []
    msgs: dict[Any, list[dict]] = {}
    async for m in db["comment_messages"].find({"thread_id": {"$in": [t["_id"] for t in threads]}, "deleted_at": None}
                                               ).sort("created_at", 1):
        msgs.setdefault(m["thread_id"], []).append(m)
    secs = analytics.Sections(raw.get("content"))
    users = {str(t.get("resolved_by")) for t in threads if t.get("resolved_by")}
    names = {}
    if users:
        names = {str(u["_id"]): u.get("name") or (u.get("email") or "").split("@")[0]
                 async for u in db["users"].find({"_id": {"$in": [ObjectId(u) for u in users if ObjectId.is_valid(u)]}},
                                                 {"name": 1, "email": 1})}

    def order(t: dict) -> tuple:
        a = t.get("anchor") or {}
        if (a.get("type") or "page") == "page":
            return (0, 0, _aware(t["created_at"]))
        line = secs.line_of(t)
        return (1 if line is not None else 2, line if line is not None else 0, a.get("start") or 0, _aware(t["created_at"]))

    out: list[ExportThread] = []
    for i, t in enumerate(sorted(threads, key=order), start=1):
        a = t.get("anchor") or {}
        typ = a.get("type") or "page"
        ms = [ExportMessage(author=m.get("author_name") or "Someone", at=m.get("created_at"), body=(m.get("body") or "").strip(),
                            ai=bool(m.get("ai"))) for m in msgs.get(t["_id"], []) if (m.get("body") or "").strip()]
        sug = t.get("suggestion") or {}
        out.append(ExportThread(
            n=i, id=str(t["_id"]), anchor_type=typ,
            quote=None if typ == "page" else (((a.get("quote") or {}).get("exact") if typ == "text" else None)
                                              or a.get("block_text") or notify_email.anchor_quote(t)),
            status=t.get("status") or "open", changed=t.get("anchor_status") == "changed",
            section=None if typ == "page" else secs.of(t)[1],
            messages=ms, suggestion=sug.get("text") if sug.get("state") == "open" else None,
            resolved_by=names.get(str(t.get("resolved_by"))) if t.get("status") == "resolved" else None))
    return out


# ── Markdown: the appendix ────────────────────────────────────────────────────


def _md_inline(s: str) -> str:
    return re.sub(r"([\\`*_\[\]<>])", r"\\\1", " ".join((s or "").split()))


def markdown_appendix(threads: list[ExportThread]) -> str:
    """``## Comments`` for the end of a Markdown export ("" when there are none)."""
    if not threads:
        return ""
    lines = ["## Comments", ""]
    for t in threads:
        about = "On the whole page" if t.anchor_type == "page" else f"On “{_md_inline(_cut(t.quote, 200))}”"
        state = "Resolved" + (f" by {_md_inline(t.resolved_by)}" if t.resolved_by else "") if t.status == "resolved" else "Open"
        extra = " · text changed since" if t.changed else ""
        lines.append(f"{t.n}. **{about}** · {state}{extra}")
        for k, m in enumerate(t.messages):
            who = _md_inline(m.author) + (" (AI)" if m.ai else "")
            lines.append(f"   - {'' if k == 0 else '↳ '}{who}, {_day(m.at)}:")
            lines.extend(f"     > {ln}" if ln.strip() else "     >" for ln in m.body.split("\n"))
        if t.suggestion:
            lines.append(f"   - Suggested edit: “{_md_inline(_cut(t.suggestion, 400))}”")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _cut(s: str | None, n: int) -> str:
    s = " ".join((s or "").split())
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


# ── Word (.docx) ──────────────────────────────────────────────────────────────

DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
_W = ('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"')
_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_ILLEGAL = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")


def _x(s: Any) -> str:
    return _xesc(_ILLEGAL.sub("", str(s or "")), {'"': "&quot;"})


@dataclass
class Run:
    text: str
    b: bool = False
    i: bool = False
    s: bool = False
    code: bool = False
    link: str | None = None       # relationship id
    br: bool = False


@dataclass
class Para:
    style: str | None = None
    num: tuple[int, int] | None = None   # (numId, level)
    pieces: list = field(default_factory=list)   # Run | str (raw xml)
    rule: bool = False

    def text(self) -> str:
        return "".join((" " if p.br else p.text) for p in self.pieces if isinstance(p, Run))


@dataclass
class Table:
    rows: list[list[Para]]
    header: bool = True


class _Doc:
    def __init__(self) -> None:
        self.blocks: list[Para | Table] = []
        self.links: dict[str, str] = {}      # url → rId
        self.nums: list[tuple[int, int]] = []   # (numId, abstractId); 1 = bullets
        self.footnotes: list[str] = []          # <w:footnote> xml
        self.comments: list[str] = []           # <w:comment> xml

    def link(self, url: str) -> str:
        if url not in self.links:
            self.links[url] = f"rIdL{len(self.links) + 1}"
        return self.links[url]

    def new_ordered(self) -> int:
        nid = 2 + sum(1 for _ in self.nums)
        self.nums.append((nid, 1))
        return nid

    def paras(self):
        for b in self.blocks:
            if isinstance(b, Para):
                yield b
            else:
                for row in b.rows:
                    yield from row


def _markdown_to_doc(markdown: str) -> _Doc:
    """Portable Markdown (page_export.to_markdown) → paragraphs, lists, quotes, code and tables."""
    from markdown_it import MarkdownIt

    md = MarkdownIt("commonmark", {"html": False}).enable(["table", "strikethrough"])
    tokens = md.parse(markdown or "")
    doc = _Doc()
    lists: list[tuple[str, int]] = []      # (kind, numId)
    quote = 0
    table: Table | None = None
    row: list[Para] | None = None
    first_h1 = [True]
    i = 0

    def para(style: str | None = None) -> Para:
        p = Para(style=style)
        if lists:
            kind, nid = lists[-1]
            p.num = (nid, min(len(lists) - 1, 8))
        elif quote and style is None:
            p.style = "Quote"
        return p

    def inline(tok, p: Para) -> None:
        state = {"b": 0, "i": 0, "s": 0, "link": None}
        for c in tok.children or []:
            t = c.type
            if t == "text":
                txt = c.content
                if not p.pieces and lists:
                    txt = re.sub(r"^\[ \]\s+", "☐ ", re.sub(r"^\[[xX]\]\s+", "☑ ", txt))
                p.pieces.append(Run(txt, b=state["b"] > 0, i=state["i"] > 0, s=state["s"] > 0, link=state["link"]))
            elif t == "code_inline":
                p.pieces.append(Run(c.content, code=True, link=state["link"]))
            elif t in ("softbreak",):
                p.pieces.append(Run(" ", link=state["link"]))
            elif t == "hardbreak":
                p.pieces.append(Run("", br=True))
            elif t == "strong_open":
                state["b"] += 1
            elif t == "strong_close":
                state["b"] -= 1
            elif t == "em_open":
                state["i"] += 1
            elif t == "em_close":
                state["i"] -= 1
            elif t == "s_open":
                state["s"] += 1
            elif t == "s_close":
                state["s"] -= 1
            elif t == "link_open":
                href = c.attrGet("href") or ""
                state["link"] = doc.link(href) if re.match(r"^(https?:|mailto:)", href) else None
            elif t == "link_close":
                state["link"] = None
            elif t == "image":
                alt = c.content or (c.attrGet("alt") or "")
                p.pieces.append(Run(f"[Image: {alt}]" if alt else "[Image]", i=True))
            elif t in ("html_inline",):
                p.pieces.append(Run(c.content))

    while i < len(tokens):
        tok = tokens[i]
        t = tok.type
        if t == "heading_open":
            level = int(tok.tag[1])
            style = "Title" if level == 1 and first_h1[0] else f"Heading{min(level, 4)}"
            first_h1[0] = False if level == 1 else first_h1[0]
            p = Para(style=style)
            inline(tokens[i + 1], p)
            doc.blocks.append(p)
            i += 3
            continue
        if t == "paragraph_open":
            p = para()
            inline(tokens[i + 1], p)
            if table is None:
                doc.blocks.append(p)
            i += 3
            continue
        if t in ("bullet_list_open", "ordered_list_open"):
            nid = 1 if t == "bullet_list_open" else doc.new_ordered()
            lists.append(("bullet" if nid == 1 else "ordered", nid))
        elif t in ("bullet_list_close", "ordered_list_close"):
            lists.pop()
        elif t == "blockquote_open":
            quote += 1
        elif t == "blockquote_close":
            quote -= 1
        elif t in ("fence", "code_block"):
            for ln in (tok.content or "").rstrip("\n").split("\n"):
                doc.blocks.append(Para(style="Code", pieces=[Run(ln or " ", code=True)]))
        elif t == "hr":
            doc.blocks.append(Para(rule=True))
        elif t == "table_open":
            table = Table(rows=[])
        elif t == "table_close":
            if table is not None and table.rows:
                doc.blocks.append(table)
            table = None
        elif t == "tr_open":
            row = []
        elif t == "tr_close":
            if table is not None and row is not None:
                table.rows.append(row)
            row = None
        elif t in ("th_open", "td_open"):
            p = Para(style="TableText")
            if tokens[i + 1].type == "inline":
                inline(tokens[i + 1], p)
                if t == "th_open":
                    for r in p.pieces:
                        if isinstance(r, Run):
                            r.b = True
            if row is not None:
                row.append(p)
        i += 1
    return doc


def _split(p: Para, offset: int) -> int:
    """Make a piece boundary at text ``offset``; returns the index of the first piece at or after it."""
    pos = 0
    for k, piece in enumerate(p.pieces):
        if not isinstance(piece, Run):
            continue
        n = 1 if piece.br else len(piece.text)
        if pos == offset:
            return k
        if pos < offset < pos + n and not piece.br:
            cut = offset - pos
            a = Run(**{**piece.__dict__, "text": piece.text[:cut]})
            b = Run(**{**piece.__dict__, "text": piece.text[cut:]})
            p.pieces[k:k + 1] = [a, b]
            return k + 1
        pos += n
    return len(p.pieces)


def _find(p: Para, needle: str | None) -> tuple[int, int] | None:
    words = (needle or "").split()
    if not words:
        return None
    m = re.search(r"\s+".join(re.escape(w) for w in words), p.text())
    return (m.start(), m.end()) if m else None


def _norm(s: str | None) -> str:
    return " ".join((s or "").split()).casefold()


def _comment_body(t: ExportThread, *, footnote: bool) -> list[tuple[str, bool]]:
    """Lines (text, bold-lead) of one thread as a Word comment / footnote."""
    lines: list[tuple[str, bool]] = []
    head = f"Comment {t.n}" + (" · Resolved" if t.status == "resolved" else "") + (" · text changed" if t.changed else "")
    if footnote or t.anchor_type == "page":
        lines.append((head + (f" · on “{_cut(t.quote, 120)}”" if footnote and t.quote else "")
                      + (" · on the whole page" if t.anchor_type == "page" else ""), True))
    for k, m in enumerate(t.messages):
        lines.append((f"{m.author}{' (AI)' if m.ai else ''}, {_day(m.at)}: {m.body}", False))
    if t.suggestion:
        lines.append((f"Suggested edit: “{t.suggestion}”", False))
    return lines


def _run_xml(r: Run) -> str:
    props = []
    if r.code:
        props.append('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F1F3F5"/>')
    if r.b:
        props.append("<w:b/>")
    if r.i:
        props.append("<w:i/>")
    if r.s:
        props.append("<w:strike/>")
    if r.link:
        props.append('<w:rStyle w:val="Hyperlink"/>')
    rpr = f"<w:rPr>{''.join(props)}</w:rPr>" if props else ""
    if r.br:
        return f"<w:r>{rpr}<w:br/></w:r>"
    return f'<w:r>{rpr}<w:t xml:space="preserve">{_x(r.text)}</w:t></w:r>'


def _para_xml(p: Para) -> str:
    ppr = []
    if p.style:
        ppr.append(f'<w:pStyle w:val="{p.style}"/>')
    elif p.num:
        ppr.append('<w:pStyle w:val="ListParagraph"/>')
    if p.num:
        ppr.append(f'<w:numPr><w:ilvl w:val="{p.num[1]}"/><w:numId w:val="{p.num[0]}"/></w:numPr>')
    if p.rule:
        ppr.append('<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D0D5DD"/></w:pBdr>')
    out = [f"<w:p>{'<w:pPr>' + ''.join(ppr) + '</w:pPr>' if ppr else ''}"]
    link: str | None = None
    for piece in p.pieces:
        if isinstance(piece, Run):
            if piece.link != link:
                if link:
                    out.append("</w:hyperlink>")
                if piece.link:
                    out.append(f'<w:hyperlink r:id="{piece.link}">')
                link = piece.link
            out.append(_run_xml(piece))
        else:
            if link:
                out.append("</w:hyperlink>")
                link = None
            out.append(piece)
    if link:
        out.append("</w:hyperlink>")
    out.append("</w:p>")
    return "".join(out)


def _table_xml(t: Table) -> str:
    cols = max(len(r) for r in t.rows)
    border = '<w:{0} w:val="single" w:sz="4" w:space="0" w:color="D0D5DD"/>'
    borders = "".join(border.format(s) for s in ("top", "left", "bottom", "right", "insideH", "insideV"))
    out = [f'<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>{borders}</w:tblBorders></w:tblPr>',
           "<w:tblGrid>" + "".join('<w:gridCol w:w="2000"/>' for _ in range(cols)) + "</w:tblGrid>"]
    for k, row in enumerate(t.rows):
        trpr = "<w:trPr><w:tblHeader/></w:trPr>" if k == 0 and t.header else ""
        cells = "".join(f"<w:tc><w:tcPr><w:tcW w:w=\"0\" w:type=\"auto\"/></w:tcPr>{_para_xml(p)}</w:tc>" for p in row)
        cells += "".join("<w:tc><w:p/></w:tc>" for _ in range(cols - len(row)))
        out.append(f"<w:tr>{trpr}{cells}</w:tr>")
    out.append("</w:tbl>")
    return "".join(out)


def _note_paras(lines: list[tuple[str, bool]], style: str, *, ref: str | None = None) -> str:
    out = []
    for k, (text, bold) in enumerate(lines):
        lead = ref if (k == 0 and ref) else ""
        rpr = "<w:rPr><w:b/></w:rPr>" if bold else ""
        out.append(f'<w:p><w:pPr><w:pStyle w:val="{style}"/></w:pPr>{lead}'
                   f'<w:r>{rpr}<w:t xml:space="preserve">{_x(text)}</w:t></w:r></w:p>')
    return "".join(out)


def _place(doc: _Doc, threads: list[ExportThread], style: str, author: str) -> list[ExportThread]:
    """Anchor each thread on the paragraphs; returns the ones that couldn't be placed."""
    paras = list(doc.paras())
    title = next((p for p in paras if p.style == "Title"), paras[0] if paras else None)
    left: list[ExportThread] = []
    for t in threads:
        target: Para | None = None
        span: tuple[int, int] | None = None
        if t.anchor_type == "page":
            target = title
            span = (0, len(title.text())) if title is not None else None
        else:
            for p in paras:
                if p.style == "Title":
                    continue
                hit = _find(p, t.quote) if t.anchor_type == "text" else None
                if hit:
                    target, span = p, hit
                    break
            if target is None and t.quote:
                want = _norm(t.quote)[:60]
                for p in paras:
                    if p.style != "Title" and want and want in _norm(p.text()):
                        target, span = p, (0, len(p.text()))
                        break
        if target is None or span is None:
            left.append(t)
            continue
        cid = len(doc.comments) + len(doc.footnotes) + 1
        if style == "margin":
            date = _iso(t.messages[0].at) if t.messages else None
            who = t.messages[0].author if t.messages else author
            body = _note_paras(_comment_body(t, footnote=False), "CommentText",
                               ref='<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r>')
            doc.comments.append(f'<w:comment w:id="{cid}" w:author="{_x(who)}" w:initials="{_x(_initials(who))}"'
                                + (f' w:date="{date}"' if date else "") + f">{body}</w:comment>")
            end = _split(target, span[1])
            target.pieces.insert(end, f'<w:commentRangeEnd w:id="{cid}"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/>'
                                      f'</w:rPr><w:commentReference w:id="{cid}"/></w:r>')
            start = _split(target, span[0])
            target.pieces.insert(start, f'<w:commentRangeStart w:id="{cid}"/>')
        else:
            body = _note_paras(_comment_body(t, footnote=True), "FootnoteText",
                               ref='<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>'
                                   '<w:r><w:t xml:space="preserve"> </w:t></w:r>')
            doc.footnotes.append(f'<w:footnote w:id="{cid}">{body}</w:footnote>')
            end = _split(target, span[1])
            target.pieces.insert(end, f'<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr>'
                                      f'<w:footnoteReference w:id="{cid}"/></w:r>')
    return left


def _initials(name: str) -> str:
    parts = [p for p in re.split(r"\s+", name or "") if p]
    return "".join(p[0] for p in parts[:2]).upper() or "M"


_STYLES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles {W}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri" w:eastAsia="Calibri"/>
<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
<w:pPr><w:spacing w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="48"/><w:szCs w:val="48"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:color w:val="667085"/><w:sz w:val="18"/></w:rPr></w:style>
{HEADINGS}
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="D0D5DD"/></w:pBdr><w:ind w:left="360"/></w:pPr>
<w:rPr><w:color w:val="475467"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/>
<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:shd w:val="clear" w:color="auto" w:fill="F1F3F5"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/>
<w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/>
<w:pPr><w:spacing w:after="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/>
<w:pPr><w:spacing w:after="40" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="18"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="CommentText"><w:name w:val="annotation text"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="CommentReference"><w:name w:val="annotation reference"/><w:rPr><w:sz w:val="16"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="2563EB"/><w:u w:val="single"/></w:rPr></w:style>
</w:styles>"""


def _headings_xml() -> str:
    sizes = {1: 36, 2: 30, 3: 26, 4: 23}
    return "\n".join(
        f'<w:style w:type="paragraph" w:styleId="Heading{n}"><w:name w:val="heading {n}"/><w:basedOn w:val="Normal"/>'
        f'<w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="{280 if n < 3 else 200}" w:after="80"/>'
        f'<w:outlineLvl w:val="{n - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="{s}"/><w:szCs w:val="{s}"/></w:rPr></w:style>'
        for n, s in sizes.items())


def _numbering_xml(doc: _Doc) -> str:
    def levels(kind: str) -> str:
        out = []
        for lvl in range(9):
            if kind == "bullet":
                fmt, text = "bullet", ["•", "◦", "▪"][lvl % 3]
            else:
                fmt, text = ["decimal", "lowerLetter", "lowerRoman"][lvl % 3], f"%{lvl + 1}."
            out.append(f'<w:lvl w:ilvl="{lvl}"><w:start w:val="1"/><w:numFmt w:val="{fmt}"/><w:lvlText w:val="{text}"/>'
                       f'<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="{720 + 360 * lvl}" w:hanging="360"/></w:pPr></w:lvl>')
        return "".join(out)

    nums = ['<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'] + [
        f'<w:num w:numId="{nid}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/>'
        f'</w:lvlOverride></w:num>' for nid, _ in doc.nums]
    return (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering {_W}>'
            f'<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>{levels("bullet")}</w:abstractNum>'
            f'<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>{levels("ordered")}</w:abstractNum>'
            + "".join(nums) + "</w:numbering>")


def to_docx(markdown: str, *, title: str, url: str, threads: list[ExportThread] | None = None,
            style: str = "margin", exported_at: datetime | None = None) -> bytes:
    """The page (portable Markdown) as a .docx, with its comment threads as Word comments (``margin``) or
    footnotes (``footnotes``). Pure: no database, no network."""
    doc = _markdown_to_doc(markdown)
    at = _aware(exported_at) or datetime.now(timezone.utc)
    # Under the title: where it came from.
    sub = Para(style="Subtitle", pieces=[Run("Exported from Markdrop · "), Run(url, link=doc.link(url)),
                                         Run(f" · {_day(at)}")])
    k = next((n for n, b in enumerate(doc.blocks) if isinstance(b, Para) and b.style == "Title"), None)
    if k is None:
        doc.blocks.insert(0, Para(style="Title", pieces=[Run(title or "Untitled")]))
        k = 0
    doc.blocks.insert(k + 1, sub)
    left = _place(doc, list(threads or []), "margin" if style == "margin" else "footnotes", "Markdrop") if threads else []
    if left:
        doc.blocks.append(Para(style="Heading2", pieces=[Run("Comments on text that changed" if all(t.changed for t in left)
                                                             else "Comments")]))
        for t in left:
            lines = _comment_body(t, footnote=True)
            for j, (text, bold) in enumerate(lines):
                doc.blocks.append(Para(pieces=[Run(text, b=bold)], style="Quote" if j else None))
    body = "".join(_para_xml(b) if isinstance(b, Para) else _table_xml(b) for b in doc.blocks)
    document = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {_W}><w:body>{body}'
                '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" '
                'w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>')
    rels = [f'<Relationship Id="rIdStyles" Type="{_REL}/styles" Target="styles.xml"/>',
            f'<Relationship Id="rIdNumbering" Type="{_REL}/numbering" Target="numbering.xml"/>',
            f'<Relationship Id="rIdFootnotes" Type="{_REL}/footnotes" Target="footnotes.xml"/>',
            f'<Relationship Id="rIdComments" Type="{_REL}/comments" Target="comments.xml"/>']
    rels += [f'<Relationship Id="{rid}" Type="{_REL}/hyperlink" Target="{_x(u)}" TargetMode="External"/>'
             for u, rid in doc.links.items()]
    footnotes = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes {_W}>'
                 '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>'
                 '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>'
                 + "".join(doc.footnotes) + "</w:footnotes>")
    comments = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments {_W}>'
                + "".join(doc.comments) + "</w:comments>")
    ct = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          '<Default Extension="xml" ContentType="application/xml"/>'
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
          '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
          '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
          '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>'
          '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>'
          '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
          '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
          '</Types>')
    root_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                 f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                 f'<Relationship Id="rId1" Type="{_REL}/officeDocument" Target="word/document.xml"/>'
                 '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
                 f'<Relationship Id="rId3" Type="{_REL}/extended-properties" Target="docProps/app.xml"/>'
                 '</Relationships>')
    stamp = at.strftime("%Y-%m-%dT%H:%M:%SZ")
    core = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
            'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
            f'<dc:title>{_x(title)}</dc:title><dc:creator>Markdrop</dc:creator>'
            f'<dcterms:created xsi:type="dcterms:W3CDTF">{stamp}</dcterms:created>'
            f'<dcterms:modified xsi:type="dcterms:W3CDTF">{stamp}</dcterms:modified></cp:coreProperties>')
    app = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
           '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
           '<Application>Markdrop</Application></Properties>')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", ct)
        z.writestr("_rels/.rels", root_rels)
        z.writestr("docProps/core.xml", core)
        z.writestr("docProps/app.xml", app)
        z.writestr("word/document.xml", document)
        z.writestr("word/styles.xml", _STYLES.replace("{W}", _W).replace("{HEADINGS}", _headings_xml()))
        z.writestr("word/numbering.xml", _numbering_xml(doc))
        z.writestr("word/footnotes.xml", footnotes)
        z.writestr("word/comments.xml", comments)
        z.writestr("word/_rels/document.xml.rels",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   + "".join(rels) + "</Relationships>")
    return buf.getvalue()
