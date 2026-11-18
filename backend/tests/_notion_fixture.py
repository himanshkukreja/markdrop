"""Synthetic Notion exports (Markdown & CSV, with subpages) for the Notion import tests.

The shapes follow what Notion's export writes: "<Title> <32-hex>.md" pages with a folder of the same name
for their sub-pages and files, URL-encoded relative links, a database as "<Name> <id>.csv" plus
"<Name> <id>_all.csv" and a folder of row pages (each starting with its properties), callouts as
<aside>, toggles as <details>, and a whole-workspace export as a zip of zips.
"""

from __future__ import annotations

import io
import struct
import zipfile
import zlib
from urllib.parse import quote

ROOT = "a1" * 16          # "Projects"
ROADMAP = "b2" * 16
NOTES = "c3" * 16
TASKS = "d4" * 16          # the database
ROW1 = "e5" * 16
ROW2 = "f6" * 16
OTHER = "0a" * 16          # a second top-level page


def png(w: int = 2, h: int = 2) -> bytes:
    def chunk(t: bytes, d: bytes) -> bytes:
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + b"\xff\x00\x00" * w for _ in range(h))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def q(path: str) -> str:
    return quote(path)


def files(*, roadmap_text: str = "We ship in **Q1**.", extra_row: bool = False) -> dict[str, bytes]:
    root = f"Projects {ROOT}"
    tasks = f"Tasks {TASKS}"
    out: dict[str, str | bytes] = {}
    out[f"{root}.md"] = f"""# Projects

<aside>
💡 Read the roadmap first. See [Notes]({q(root)}/{q(f'Notes {NOTES}.md')}).

</aside>

## Overview

Plain text with a [link](https://example.com) and $E=mc^2$ inline.

[Roadmap]({q(root)}/{q(f'Roadmap {ROADMAP}.md')})

[Notes]({q(root)}/{q(f'Notes {NOTES}.md')})

[Tasks]({q(root)}/{q(tasks)}.csv)

![Team photo]({q(root)}/{q('team photo.png')})

[spec.pdf]({q(root)}/{q('spec.pdf')})

- [ ] Write the plan
- [x] Pick a name
    - nested bullet

1. First
2. Second

<details>
<summary>More details</summary>

Hidden text inside a toggle.

</details>

> A quote from someone.

```python
print("hi")
```

$$
\\int_0^1 x\\,dx
$$

| Name | Role |
| --- | --- |
| Ada | Eng |
| Grace | [Ops](https://ops.example) |

---

https://www.youtube.com/watch?v=dQw4w9WgXcQ

[https://news.example.com/post](https://news.example.com/post)

Link to the other page: [Other](https://www.notion.so/Other-{OTHER}?pvs=21)
"""
    out[f"{root}/Roadmap {ROADMAP}.md"] = f"# Roadmap\n\n{roadmap_text}\n\nBack to [Projects](../{q(root)}.md).\n"
    out[f"{root}/Notes {NOTES}.md"] = "# Notes\n\nSome notes.\n"
    out[f"{root}/team photo.png"] = png()
    out[f"{root}/spec.pdf"] = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
    header = "﻿Name,Status,Tags,Due,Done,Estimate,Owner,Website,Related\n"
    rows = [
        f"Ship v2,In progress,\"web, api\",\"November 20, 2026\",No,3,Ada Lovelace,https://a.example,\"Fix bug ({q(tasks)}/{q(f'Fix bug {ROW2}.md')})\"",
        "Fix bug,Done,api,\"November 18, 2026 → November 19, 2026\",Yes,1.5,Grace Hopper,,",
    ]
    if extra_row:
        rows.append("Third task,Not started,web,,No,,,,")
    out[f"{root}/{tasks}.csv"] = header + "\n".join(rows[:1]) + "\n"          # a filtered view
    out[f"{root}/{tasks}_all.csv"] = header + "\n".join(rows) + "\n"
    out[f"{root}/{tasks}/Ship v2 {ROW1}.md"] = (
        "# Ship v2\n\nStatus: In progress\nTags: web, api\nDue: November 20, 2026\n\nThe release plan.\n")
    out[f"{root}/{tasks}/Fix bug {ROW2}.md"] = "# Fix bug\n\nStatus: Done\n\nRoot cause: a typo.\n"
    out[f"Other {OTHER}.md"] = f"# Other\n\nSee [Roadmap]({q(root)}/{q(f'Roadmap {ROADMAP}.md')}).\n"
    return {k: (v.encode() if isinstance(v, str) else v) for k, v in out.items()}


def zip_bytes(entries: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in entries.items():
            z.writestr(name, data)
    return buf.getvalue()


def export_zip(**kw) -> bytes:
    return zip_bytes(files(**kw))


def workspace_export(**kw) -> bytes:
    """"Export all workspace content": a zip holding zips (split in two parts)."""
    f = files(**kw)
    names = sorted(f)
    half = len(names) // 2
    part1 = zip_bytes({n: f[n] for n in names[:half]})
    part2 = zip_bytes({n: f[n] for n in names[half:]})
    uid = "12345678-1234-1234-1234-123456789abc"
    return zip_bytes({f"Export-{uid}-Part-1.zip": part1, f"Export-{uid}-Part-2.zip": part2})


def html_export() -> bytes:
    return zip_bytes({f"Projects {ROOT}.html": b"<html><body><h1>Projects</h1></body></html>"})
