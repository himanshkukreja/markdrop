#!/usr/bin/env python3
"""budget-2026.xlsx: the landing page's sample spreadsheet (fictional Acme numbers, three tabs).

    python3 frontend/scripts/landing-samples/make_budget.py

A minimal valid .xlsx written by hand (inline strings, numbers, formulas, a bold header row), the same
way scripts/docs-media/seed.py makes its sheets, so it needs no openpyxl.
"""
import io
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent

BUDGET = {
    "Summary": [
        ["Line", "Q1 ($k)", "Q2 ($k)", "Q3 ($k)", "Q4 ($k)", "Year ($k)"],
        ["Hosting", 41, 43, 46, 48, "=SUM(B2:E2)"],
        ["Design", 88, 90, 115, 96, "=SUM(B3:E3)"],
        ["Support", 32, 34, 33, 36, "=SUM(B4:E4)"],
        ["Events", 12, 30, 18, 40, "=SUM(B5:E5)"],
        ["Tools", 21, 21, 24, 24, "=SUM(B6:E6)"],
        ["Total", "=SUM(B2:B6)", "=SUM(C2:C6)", "=SUM(D2:D6)", "=SUM(E2:E6)", "=SUM(F2:F6)"],
    ],
    "Headcount": [
        ["Team", "People", "Open roles", "Cost / year ($k)"],
        ["Engineering", 38, 4, 3650],
        ["Design", 6, 1, 540],
        ["Support", 12, 2, 820],
        ["Sales", 16, 3, 1270],
        ["Total", "=SUM(B2:B5)", "=SUM(C2:C5)", "=SUM(D2:D5)"],
    ],
    "Tools": [
        ["Tool", "Seats", "Cost / month ($)", "Owner"],
        ["Design", 14, 630, "Design"],
        ["CI minutes", "-", 2400, "Engineering"],
        ["Support desk", 12, 1080, "Support"],
        ["CRM", 18, 2250, "Sales"],
        ["Markdrop", 70, 0, "Everyone"],
    ],
}

# Cached values for the formulas, so viewers that read values (not formulas) show the totals.
def _values(rows):
    out = [list(r) for r in rows]
    for r, row in enumerate(out):
        for c, v in enumerate(row):
            if isinstance(v, str) and v.startswith("=SUM("):
                a, b = v[5:-1].split(":")
                col_a, row_a = ord(a[0]) - 65, int(a[1:]) - 1
                col_b, row_b = ord(b[0]) - 65, int(b[1:]) - 1
                total = 0
                for rr in range(row_a, row_b + 1):
                    for cc in range(col_a, col_b + 1):
                        x = out[rr][cc]
                        total += x if isinstance(x, (int, float)) else 0
                out[r][c] = (v, total)
    return out


def _esc(v: str) -> str:
    return v.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _col(i: int) -> str:
    s = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def _sheet_xml(rows) -> str:
    out = []
    for r, row in enumerate(_values(rows), 1):
        cells = []
        for c, v in enumerate(row):
            ref = f"{_col(c)}{r}"
            bold = ' s="1"' if r == 1 or row[0] == "Total" else ""
            if isinstance(v, tuple):
                cells.append(f'<c r="{ref}"{bold}><f>{_esc(v[0][1:])}</f><v>{v[1]}</v></c>')
            elif isinstance(v, (int, float)):
                cells.append(f'<c r="{ref}"{bold}><v>{v}</v></c>')
            else:
                cells.append(f'<c r="{ref}" t="inlineStr"{bold}><is><t>{_esc(str(v))}</t></is></c>')
        out.append(f'<row r="{r}">{"".join(cells)}</row>')
    widths = '<cols><col min="1" max="1" width="18" customWidth="1"/><col min="2" max="6" width="14" customWidth="1"/></cols>'
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            f'{widths}<sheetData>{"".join(out)}</sheetData></worksheet>')


def xlsx_bytes(sheets) -> bytes:
    names = list(sheets)
    main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    files = {
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        + "".join(f'<Override PartName="/xl/worksheets/sheet{i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for i in range(len(names)))
        + "</Types>",
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        "xl/workbook.xml": f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="{main}" xmlns:r="{rel}"><sheets>'
        + "".join(f'<sheet name="{_esc(n)}" sheetId="{i + 1}" r:id="rId{i + 1}"/>' for i, n in enumerate(names)) + "</sheets></workbook>",
        "xl/_rels/workbook.xml.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + "".join(f'<Relationship Id="rId{i + 1}" Type="{rel}/worksheet" Target="worksheets/sheet{i + 1}.xml"/>' for i in range(len(names)))
        + f'<Relationship Id="rId{len(names) + 1}" Type="{rel}/styles" Target="styles.xml"/></Relationships>',
        "xl/styles.xml": f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="{main}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>',
    }
    for i, n in enumerate(names):
        files[f"xl/worksheets/sheet{i + 1}.xml"] = _sheet_xml(sheets[n])
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, body in files.items():
            z.writestr(name, body)
    return buf.getvalue()


if __name__ == "__main__":
    out = HERE / "budget-2026.xlsx"
    out.write_bytes(xlsx_bytes(BUDGET))
    print("wrote", out)
