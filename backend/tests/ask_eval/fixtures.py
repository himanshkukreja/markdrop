"""Tiny Office / caption fixtures, built with the standard library only (no new modules, so the eval
world can seed them on a baseline checkout too): .docx, .pptx, .xlsx, WebVTT, a long meeting transcript."""

from __future__ import annotations

import io
import zipfile

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
S_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"


def _zip(files: dict[str, str | bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            z.writestr(name, data)
    return buf.getvalue()


def make_docx(paragraphs: list[tuple[str | None, str]]) -> bytes:
    """[(style or None, text)] → a .docx."""
    body = []
    for style, text in paragraphs:
        ppr = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
        body.append(f"<w:p>{ppr}<w:r><w:t>{text}</w:t></w:r></w:p>")
    doc = f'<?xml version="1.0"?><w:document xmlns:w="{W_NS}"><w:body>{"".join(body)}</w:body></w:document>'
    return _zip({"[Content_Types].xml": "<Types/>", "word/document.xml": doc})


def make_pptx(slides: list[tuple[str, str]]) -> bytes:
    """[(slide text, notes)] → a .pptx with a slide list and notes pages."""
    files: dict[str, str] = {"[Content_Types].xml": "<Types/>"}
    ids, rels = [], []
    for n, (text, notes) in enumerate(slides, 1):
        ids.append(f'<p:sldId id="{255 + n}" r:id="rId{n}"/>')
        rels.append(f'<Relationship Id="rId{n}" Type="slide" Target="slides/slide{n}.xml"/>')
        files[f"ppt/slides/slide{n}.xml"] = (f'<p:sld xmlns:p="{P_NS}" xmlns:a="{A_NS}"><p:cSld><p:spTree><p:sp><p:txBody>'
                                             f'<a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>')
        files[f"ppt/slides/_rels/slide{n}.xml.rels"] = (f'<Relationships xmlns="{REL}"><Relationship Id="rId9" '
                                                        f'Type="notesSlide" Target="../notesSlides/notesSlide{n}.xml"/></Relationships>')
        files[f"ppt/notesSlides/notesSlide{n}.xml"] = (f'<p:notes xmlns:p="{P_NS}" xmlns:a="{A_NS}"><a:p><a:r><a:t>{notes}'
                                                       f'</a:t></a:r></a:p><a:p><a:r><a:t>{n}</a:t></a:r></a:p></p:notes>')
    files["ppt/presentation.xml"] = (f'<p:presentation xmlns:p="{P_NS}" xmlns:r="{R_NS}"><p:sldIdLst>{"".join(ids)}'
                                     f'</p:sldIdLst></p:presentation>')
    files["ppt/_rels/presentation.xml.rels"] = f'<Relationships xmlns="{REL}">{"".join(rels)}</Relationships>'
    return _zip(files)


def make_xlsx(sheets: dict[str, list[list[str]]]) -> bytes:
    shared: list[str] = []
    files: dict[str, str] = {"[Content_Types].xml": "<Types/>"}
    entries, rels = [], []
    for n, (name, rows) in enumerate(sheets.items(), 1):
        entries.append(f'<sheet name="{name}" sheetId="{n}" r:id="rId{n}"/>')
        rels.append(f'<Relationship Id="rId{n}" Type="worksheet" Target="worksheets/sheet{n}.xml"/>')
        xml_rows = []
        for r_i, row in enumerate(rows, 1):
            cells = []
            for c_i, val in enumerate(row):
                ref = f"{chr(65 + c_i)}{r_i}"
                if val.replace(".", "").isdigit():
                    cells.append(f'<c r="{ref}"><v>{val}</v></c>')
                else:
                    shared.append(val)
                    cells.append(f'<c r="{ref}" t="s"><v>{len(shared) - 1}</v></c>')
            xml_rows.append(f'<row r="{r_i}">{"".join(cells)}</row>')
        files[f"xl/worksheets/sheet{n}.xml"] = f'<worksheet xmlns="{S_NS}"><sheetData>{"".join(xml_rows)}</sheetData></worksheet>'
    files["xl/workbook.xml"] = f'<workbook xmlns="{S_NS}" xmlns:r="{R_NS}"><sheets>{"".join(entries)}</sheets></workbook>'
    files["xl/_rels/workbook.xml.rels"] = f'<Relationships xmlns="{REL}">{"".join(rels)}</Relationships>'
    files["xl/sharedStrings.xml"] = f'<sst xmlns="{S_NS}">' + "".join(f"<si><t>{s}</t></si>" for s in shared) + "</sst>"
    return _zip(files)


def clock(s: int) -> str:
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}.000"


FILLER = ("We walked through the dashboard numbers again and agreed the onboarding funnel needs another look "
          "before the quarterly review, then talked about hiring for the support rotation and travel budgets.")


def long_vtt(minutes: int = 90, *, at_min: int = 70, line: str = "The Zephyr vendor contract renews on March 3 "
             "and Kabir will negotiate the price down to forty thousand.") -> str:
    """A ``minutes``-long WebVTT transcript, a cue every 20 s, ``line`` said by Kabir at ``at_min``."""
    out = ["WEBVTT", ""]
    speakers = ["Ada Lovelace", "Bo Chen", "Priya Sharma"]
    for i, t in enumerate(range(0, minutes * 60, 20)):
        who = speakers[i % 3]
        text = f"{FILLER} Item {i}."
        if t == at_min * 60:
            who, text = "Kabir Singh", line
        out += [f"{clock(t)} --> {clock(t + 19)}", f"<v {who}>{text}", ""]
    return "\n".join(out)


def vtt(cues: list[tuple[int, str]]) -> str:
    out = ["WEBVTT", ""]
    for t, text in cues:
        out += [f"{clock(t)} --> {clock(t + 4)}", text, ""]
    return "\n".join(out)
