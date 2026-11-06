"""Card previews from untrusted binaries, in a child process (services/card_preview.py runs it).

    python card_preview_proc.py <image|pdf|docx|pptx|xlsx>     stdin: the file's bytes
                                                         stdout: one JSON object

Images, PDFs and Office files are decoded here and never in the API process: a decoder bug, a
decompression bomb or a pathological file costs this process (CPU- and memory-limited, and
killed by the parent at its time limit), not the server. Only the standard library, Pillow and,
when installed, pypdfium2 (a PDF's first page as a picture) or pypdf (its text) are imported.

Output (every key optional):

    thumb   base64 WebP, at most THUMB_W wide (an image; a PDF's first page, top part)
    w, h    the thumbnail's size
    pages   a PDF's page count; a deck's slide count
    blocks  [{"t": "h1"|"h2"|"h3"|"p"|"li", "x": text}]   (a Word file; a deck's first slide; a PDF
                                                          without pdfium)
    rows    [[cell, …], …]                                (a spreadsheet's first cells)
"""

from __future__ import annotations

import base64
import io
import json
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

THUMB_W = 560          # card bands are ≤ 360 CSS px wide; 560 is sharp enough at 1.5x and small
THUMB_MAX_H = 560      # images: the longest side is capped too (cover-cropped by the card)
PAGE_CROP = 0.75       # a PDF's page: the top part, 4:3 (the band shows the top of the sheet)
QUALITY = 72
MAX_PIXELS = 60_000_000  # a larger image is refused rather than decoded
MAX_BLOCKS = 14
MAX_CELL = 48
ROWS, COLS = 8, 6
MAX_MEMBER = 8 * 1024 * 1024  # an Office file's XML part, uncompressed


def _limit_resources() -> None:
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_CPU, (20, 20))
        cap = 1536 * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (cap, cap))
    except Exception:  # not every platform enforces these (macOS ignores RLIMIT_AS)
        pass


def _webp(img) -> dict:
    out = io.BytesIO()
    img.save(out, "WEBP", quality=QUALITY, method=4)
    return {"thumb": base64.b64encode(out.getvalue()).decode(), "w": img.width, "h": img.height}


def _flatten(img):
    """RGB on white (transparency, palettes, CMYK, 16-bit)."""
    from PIL import Image

    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        rgba = img.convert("RGBA")
        bg = Image.new("RGB", rgba.size, (255, 255, 255))
        bg.paste(rgba, mask=rgba.split()[-1])
        return bg
    return img.convert("RGB") if img.mode != "RGB" else img


def image(data: bytes) -> dict:
    from PIL import Image, ImageOps

    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    with Image.open(io.BytesIO(data)) as im:
        if im.width * im.height > MAX_PIXELS:
            return {}
        im.draft("RGB", (THUMB_W * 2, THUMB_MAX_H * 2))  # JPEG: decode at a reduced scale
        im.seek(0)  # an animation: its first frame
        img = ImageOps.exif_transpose(im) or im
        img = _flatten(img)
        img.thumbnail((THUMB_W, THUMB_MAX_H), Image.LANCZOS)
        return _webp(img)


def _clean(text: str, n: int = 280) -> str:
    text = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:n]


def pdf(data: bytes) -> dict:
    try:
        import pypdfium2 as pdfium
    except ImportError:
        return _pdf_text(data)
    doc = pdfium.PdfDocument(data)
    try:
        n = len(doc)
        if n == 0:
            return {"pages": 0}
        page = doc[0]
        w, h = page.get_size()
        if w <= 0 or h <= 0:
            return {"pages": n}
        scale = min(THUMB_W / w, 4.0)
        # Only the top of the page is shown: render that part alone.
        crop_h = max(0.0, h - (THUMB_W * PAGE_CROP) / scale)
        bitmap = page.render(scale=scale, crop=(0, crop_h, 0, 0), fill_color=(255, 255, 255, 255))
        img = bitmap.to_pil().convert("RGB")
        return {**_webp(img), "pages": n}
    finally:
        doc.close()


def _pdf_text(data: bytes) -> dict:
    """No pdfium here: the first page's text, as paragraphs."""
    try:
        from pypdf import PdfReader
    except ImportError:
        return {}
    reader = PdfReader(io.BytesIO(data))
    if reader.is_encrypted:
        return {}
    n = len(reader.pages)
    text = reader.pages[0].extract_text() if n else ""
    blocks = []
    for para in re.split(r"\n\s*\n|\n(?=[A-Z0-9•\-])", text or ""):
        x = _clean(para)
        if x:
            blocks.append({"t": "p", "x": x})
        if len(blocks) >= MAX_BLOCKS:
            break
    return {"pages": n, "blocks": blocks}


def _member(z: zipfile.ZipFile, name: str) -> bytes | None:
    try:
        info = z.getinfo(name)
    except KeyError:
        return None
    if info.file_size > MAX_MEMBER:
        return None
    data = z.read(info)
    # Office XML never has a document type declaration; one here is a trick (entity expansion).
    if b"<!DOCTYPE" in data[:4096] or b"<!ENTITY" in data[:4096]:
        return None
    return data


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def docx(data: bytes) -> dict:
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        xml = _member(z, "word/document.xml")
    if xml is None:
        return {}
    blocks: list[dict] = []
    for _ev, el in ET.iterparse(io.BytesIO(xml), events=("end",)):
        if el.tag != f"{W}p":
            continue
        text = _clean("".join(t.text or "" for t in el.iter(f"{W}t")))
        style = ""
        ppr = el.find(f"{W}pPr")
        if ppr is not None:
            ps = ppr.find(f"{W}pStyle")
            if ps is not None:
                style = (ps.get(f"{W}val") or "").lower()
            if ppr.find(f"{W}numPr") is not None and not style.startswith(("heading", "title")):
                style = "list"
        el.clear()
        if not text:
            continue
        if style in ("title", "heading1"):
            t = "h1"
        elif style == "heading2":
            t = "h2"
        elif style.startswith("heading"):
            t = "h3"
        elif style.startswith("list"):
            t = "li"
        else:
            t = "p"
        blocks.append({"t": t, "x": text})
        if len(blocks) >= MAX_BLOCKS:
            break
    return {"blocks": blocks}


A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"


def pptx(data: bytes) -> dict:
    """The first slide as blocks (its title as h1, then its text, bullets as li) and the count."""
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        pres = _member(z, "ppt/presentation.xml")
        rels = _member(z, "ppt/_rels/presentation.xml.rels")
        if pres is None or rels is None:
            return {}
        targets = {r.get("Id"): r.get("Target") or "" for r in ET.fromstring(rels)}
        ids = [s.get(f"{REL}id") for s in ET.fromstring(pres).iter(f"{P}sldId")]
        order = [targets.get(i) for i in ids if targets.get(i)]
        if not order:
            return {}
        first = order[0].lstrip("/")
        slide = _member(z, first if first.startswith("ppt/") else f"ppt/{first}")
    if slide is None:
        return {"pages": len(order)}
    blocks: list[dict] = []
    for sp in ET.fromstring(slide).iter(f"{P}sp"):
        ph = sp.find(f"{P}nvSpPr/{P}nvPr/{P}ph")
        kind = (ph.get("type") or "") if ph is not None else None
        if kind in ("dt", "ftr", "sldNum"):
            continue
        title = kind in ("title", "ctrTitle")
        bulleted = ph is not None and kind in ("", "body", "obj")
        for para in sp.iter(f"{A}p"):
            text = _clean("".join(t.text or "" for t in para.iter(f"{A}t")))
            if not text:
                continue
            ppr = para.find(f"{A}pPr")
            no_bullet = ppr is not None and ppr.find(f"{A}buNone") is not None
            has_bullet = ppr is not None and (ppr.find(f"{A}buChar") is not None or ppr.find(f"{A}buAutoNum") is not None)
            t = "h1" if title else "li" if (bulleted and not no_bullet) or has_bullet else "p"
            blocks.append({"t": t, "x": text})
            if len(blocks) >= MAX_BLOCKS:
                break
        if len(blocks) >= MAX_BLOCKS:
            break
    # The title first, wherever its shape sits in the slide's list.
    blocks.sort(key=lambda b: b["t"] != "h1")
    return {"blocks": blocks, "pages": len(order)}


S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PKG_REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"


def _first_sheet(z: zipfile.ZipFile) -> str:
    """The workbook's first sheet's part (its order in workbook.xml, not its file name)."""
    wb, rels = _member(z, "xl/workbook.xml"), _member(z, "xl/_rels/workbook.xml.rels")
    if wb and rels:
        try:
            first = next((s for s in ET.fromstring(wb).iter(f"{S}sheet")), None)
            rid = first.get(f"{REL}id") if first is not None else None
            for r in ET.fromstring(rels).iter(f"{PKG_REL}Relationship"):
                if r.get("Id") == rid and r.get("Target"):
                    target = r.get("Target").lstrip("/")
                    return target if target.startswith("xl/") else f"xl/{target}"
        except ET.ParseError:
            pass
    return "xl/worksheets/sheet1.xml"


def _col(ref: str) -> int:
    n = 0
    for ch in ref:
        if not ch.isalpha():
            break
        n = n * 26 + (ord(ch.upper()) - 64)
    return n - 1


def xlsx(data: bytes) -> dict:
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        sheet = _member(z, _first_sheet(z))
        shared_xml = _member(z, "xl/sharedStrings.xml")
    if sheet is None:
        return {}
    grid: list[list[str]] = []
    wanted: set[int] = set()
    cells: list[tuple[int, int, str, str]] = []  # row, col, type, value
    for _ev, el in ET.iterparse(io.BytesIO(sheet), events=("end",)):
        if el.tag != f"{S}row":
            continue
        r = len(grid)
        grid.append([])
        for c in el.iter(f"{S}c"):
            col = _col(c.get("r") or "") if c.get("r") else len([x for x in cells if x[0] == r])
            if col < 0 or col >= COLS:
                continue
            t = c.get("t") or "n"
            if t == "inlineStr":
                v = "".join(x.text or "" for x in c.iter(f"{S}t"))
            else:
                ve = c.find(f"{S}v")
                v = ve.text if ve is not None and ve.text is not None else ""
            if t == "s" and v.isdigit():
                wanted.add(int(v))
            cells.append((r, col, t, v))
        el.clear()
        if len(grid) >= ROWS:
            break
    shared: dict[int, str] = {}
    if wanted and shared_xml:
        top = max(wanted)
        i = 0
        for _ev, el in ET.iterparse(io.BytesIO(shared_xml), events=("end",)):
            if el.tag != f"{S}si":
                continue
            if i in wanted:
                shared[i] = "".join(x.text or "" for x in el.iter(f"{S}t"))
            el.clear()
            i += 1
            if i > top:
                break
    rows = [["" for _ in range(COLS)] for _ in grid]
    for r, col, t, v in cells:
        if t == "s":
            v = shared.get(int(v), "") if v.isdigit() else ""
        elif t == "b":
            v = "TRUE" if v == "1" else "FALSE"
        elif t == "n" and v:
            try:
                f = float(v)
                v = str(int(f)) if f.is_integer() and abs(f) < 1e15 else f"{f:.6g}"
            except ValueError:
                pass
        rows[r][col] = _clean(v, MAX_CELL)
    # Drop trailing empty columns and rows.
    width = max((max((i + 1 for i, x in enumerate(row) if x), default=0) for row in rows), default=0)
    rows = [row[:width] for row in rows]
    while rows and not any(rows[-1]):
        rows.pop()
    return {"rows": rows} if rows and width else {}


KINDS = {"image": image, "pdf": pdf, "docx": docx, "pptx": pptx, "xlsx": xlsx}


def run(kind: str, data: bytes) -> dict:
    fn = KINDS.get(kind)
    if fn is None or not data:
        return {}
    try:
        return fn(data)
    except Exception:
        return {}


def main() -> None:
    _limit_resources()
    kind = sys.argv[1] if len(sys.argv) > 1 else ""
    data = sys.stdin.buffer.read()
    sys.stdout.write(json.dumps(run(kind, data)))


if __name__ == "__main__":
    main()
