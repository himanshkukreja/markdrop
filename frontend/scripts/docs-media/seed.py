#!/usr/bin/env python3
"""Seed the docs media demo world into the sandbox stack (stack/stack.sh start first).

    backend/.venv/bin/python frontend/scripts/docs-media/seed.py            # reset + seed
    backend/.venv/bin/python frontend/scripts/docs-media/seed.py --rebase   # shift every timestamp so
                                                                             # "now" in the data = now
    STACK_ID=2 backend/.venv/bin/python frontend/scripts/docs-media/seed.py # instance 2 (see stack.sh)

Idempotent: every run empties the demo database (markdrop_docs_demo only — refused otherwise),
the fake R2 and the fake DNS, then rebuilds the same world. Writes .data/fixtures.json, which the
capture runner reads (ids, slugs, the demo clock).

The world (matches the docs media plan):
  users      Riya Sharma (owner of everything, riya@acme.com), Alex Chen (Acme member = Can edit),
             Sam Lee (viewer), Maya Patel (admin), "Dana" (dana@globex.com, not in Acme: requests
             access), Jordan Park (owns the brand-new, empty Northwind workspace; Riya is its admin)
  workspace  Acme — site name "Acme", teal accent #0F766E, logo + favicon; folders Guides › Setup,
             Releases (12 items), Sales; docs.acme.com live + default, help.acme.com awaiting DNS;
             a pending invitation (lee@contractors.io)
  documents  ~24 Markdown documents (getting-started with code, mermaid and KaTeX; release notes
             v2.0–v2.4; meeting notes; q3-plan (anonymous, edit secret in fixtures.json);
             q3-plan-internal (private); pricing-faq (password acme-2027); board-prep (end-to-end
             encrypted; key in fixtures.json); …) and 12 files: Q3 Board Deck.pdf (v1 → v2, page 4
             changes), product-demo.mp4 (40 s, v1 → v2), q3-forecast.xlsx (3 sheets), pipeline.csv,
             onboarding-handbook.docx, a PNG diagram, team-photo.png, q3-dashboard.html,
             api-response.json, a zipped help site, an HEVC .mov, an HTML landing page
  sharing    grants (incl. priya@northwind.com without email), two docs shared with Riya, a pending
             access request from Dana on q3-plan-internal
  account    API tokens My laptop / Nightly report / VS Code; connected apps Claude and Cursor
  analytics  120 days of synthesised views, link-preview fetches and engagement sessions (video
             retention + replays + slow phone starts + failures, PDF page drop after page 3,
             document sections, code copies, link clicks, internal member views, UTM campaigns)

Emails use @acme.com because the API's email validation rejects reserved TLDs like .test; email
is the console transport, so nothing is ever sent.
"""

from __future__ import annotations

import argparse
import io
import json
import math
import os
import random
import re
import shutil
import subprocess
import sys
import time
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from bson import ObjectId
from pymongo import MongoClient

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import demo_content as C  # noqa: E402

# STACK_ID=N (default 0) seeds instance N: API 8180+10N, db markdrop_docs_demo_N, data .data/N/.
# The rendered demo files (.data/fixtures/) are shared by every instance.
STACK_ID = int(os.environ.get("STACK_ID") or 0)
BASE_DATA = Path(os.environ.get("DOCS_MEDIA_DATA") or (HERE / ".data")).resolve()
DATA = BASE_DATA if STACK_ID == 0 else BASE_DATA / str(STACK_ID)
FIX = BASE_DATA / "fixtures"
API = os.environ.get("DOCS_MEDIA_API", f"http://127.0.0.1:{8180 + 10 * STACK_ID}")
ENV_FILE = HERE / "stack" / ".env"
if not ENV_FILE.exists():
    ENV_FILE = HERE / "stack" / ".env.example"


def env_value(key: str, default: str = "") -> str:
    for line in ENV_FILE.read_text().splitlines():
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip().strip("'\"")
    return default


MONGO_URI = env_value("MARKDROP_MONGODB_URI", "mongodb://127.0.0.1:27019")
DB_NAME = env_value("MARKDROP_MONGODB_DB", "markdrop_docs_demo")
if STACK_ID:
    DB_NAME = f"markdrop_docs_demo_{STACK_ID}"
if not DB_NAME.startswith("markdrop_docs_demo") or (urlsplit(MONGO_URI).hostname or "") not in ("127.0.0.1", "localhost"):
    sys.exit(f"seed.py: refusing to touch {MONGO_URI}/{DB_NAME} (local markdrop_docs_demo only)")
if (urlsplit(API).hostname or "") not in ("127.0.0.1", "localhost"):
    sys.exit("seed.py: DOCS_MEDIA_API must be local")

db = MongoClient(MONGO_URI, tz_aware=True)[DB_NAME]
http = httpx.Client(base_url=API, timeout=60)
RNG = random.Random(20261030)


def minute(dt: datetime) -> datetime:
    return dt.replace(second=0, microsecond=0)


def call(method: str, path: str, token: str | None = None, **kw):
    headers = kw.pop("headers", {})
    if token:
        headers["Authorization"] = f"Bearer {token}"
    r = http.request(method, path, headers=headers, **kw)
    if r.status_code >= 400:
        raise SystemExit(f"{method} {path} → {r.status_code}: {r.text[:400]}")
    return r.json() if r.content and r.headers.get("content-type", "").startswith("application/json") else None


# ── Files ─────────────────────────────────────────────────────────────────────


def ensure_fixtures() -> None:
    need = ["q3-board-deck-v1.pdf", "q3-board-deck-v2.pdf", "product-demo-v1.mp4", "product-demo-v2.mp4",
            "hevc-recording.mov", "acme-architecture.png", "team-photo.png", "acme-logo.png", "acme-favicon.png"]
    if all((FIX / n).exists() for n in need):
        return
    print("· rendering demo files (make_fixtures.mjs)…")
    node = shutil.which("node") or str(Path.home() / ".nvm/versions/node/v22.18.0/bin/node")
    env = {**os.environ, "PATH": f"{Path(node).parent}:/opt/homebrew/bin:{os.environ.get('PATH', '')}"}
    subprocess.run([node, str(HERE / "make_fixtures.mjs")], check=True, cwd=HERE.parent.parent, env=env)


def _xml_esc(v: str) -> str:
    return v.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def xlsx_bytes(sheets: dict[str, list[list]]) -> bytes:
    """A minimal valid .xlsx (inline strings, formulas, bold header row) — no openpyxl needed."""
    def col(i: int) -> str:
        s = ""
        i += 1
        while i:
            i, r = divmod(i - 1, 26)
            s = chr(65 + r) + s
        return s

    def sheet_xml(rows):
        out = []
        for r, row in enumerate(rows, 1):
            cells = []
            for c, v in enumerate(row):
                ref = f"{col(c)}{r}"
                if isinstance(v, (int, float)):
                    cells.append(f'<c r="{ref}"><v>{v}</v></c>')
                elif isinstance(v, str) and v.startswith("="):
                    cells.append(f'<c r="{ref}"><f>{_xml_esc(v[1:])}</f></c>')
                else:
                    style = ' s="1"' if r == 1 else ""
                    cells.append(f'<c r="{ref}" t="inlineStr"{style}><is><t>{_xml_esc(str(v))}</t></is></c>')
            out.append(f'<row r="{r}">{"".join(cells)}</row>')
        return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                f'<sheetData>{"".join(out)}</sheetData></worksheet>')

    names = list(sheets)
    ns_main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    ns_rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    files = {
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        + "".join(f'<Override PartName="/xl/worksheets/sheet{i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for i in range(len(names)))
        + "</Types>",
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        "xl/workbook.xml": f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="{ns_main}" xmlns:r="{ns_rel}"><sheets>'
        + "".join(f'<sheet name="{_xml_esc(n)}" sheetId="{i + 1}" r:id="rId{i + 1}"/>' for i, n in enumerate(names)) + "</sheets></workbook>",
        "xl/_rels/workbook.xml.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + "".join(f'<Relationship Id="rId{i + 1}" Type="{ns_rel}/worksheet" Target="worksheets/sheet{i + 1}.xml"/>' for i in range(len(names)))
        + f'<Relationship Id="rId{len(names) + 1}" Type="{ns_rel}/styles" Target="styles.xml"/></Relationships>',
        "xl/styles.xml": f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="{ns_main}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>',
    }
    for i, n in enumerate(names):
        files[f"xl/worksheets/sheet{i + 1}.xml"] = sheet_xml(sheets[n])
    return _zip(files)


def _zip(files: dict[str, str | bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, body in files.items():
            z.writestr(name, body)
    return buf.getvalue()


FORECAST = {
    "Summary": [["Quarter", "Bookings ($k)", "MRR end ($k)", "Net retention"],
                ["Q1 2026", 820, 398, "118%"], ["Q2 2026", 960, 455, "121%"],
                ["Q3 2026", 1140, 601, "124%"], ["Q4 2026 (forecast)", 1320, 688, "125%"]],
    "By region": [["Region", "Q3 actual ($k)", "Q4 forecast ($k)", "Change"],
                  ["North America", 610, 690, "=C2/B2-1"], ["Europe", 320, 385, "=C3/B3-1"],
                  ["Asia Pacific", 150, 182, "=C4/B4-1"], ["Latin America", 60, 63, "=C5/B5-1"]],
    "Assumptions": [["Assumption", "Value", "Note"],
                    ["Win rate", "28%", "Trailing two quarters"], ["Average deal ($k)", 96, "Enterprise only"],
                    ["Sales cycle (days)", 54, "Median, Q3"], ["Gross churn / month", "1.3%", "Flat vs Q2"]],
}


def docx_bytes(title: str, blocks: list[tuple[str, str]]) -> bytes:
    """A minimal .docx: Title / Heading 1 / Heading 2 / normal / bullet paragraphs."""
    ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

    def para(style: str, text: str) -> str:
        ppr = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style != "Normal" else ""
        return f'<w:p>{ppr}<w:r><w:t xml:space="preserve">{_xml_esc(text)}</w:t></w:r></w:p>'

    body = para("Title", title) + "".join(para(st, t) for st, t in blocks)
    styles = "".join(
        f'<w:style w:type="paragraph" w:styleId="{sid}"><w:name w:val="{name}"/><w:rPr>{rpr}</w:rPr></w:style>'
        for sid, name, rpr in (("Normal", "Normal", '<w:sz w:val="22"/>'), ("Title", "Title", '<w:b/><w:sz w:val="48"/>'),
                               ("Heading1", "heading 1", '<w:b/><w:sz w:val="32"/>'),
                               ("Heading2", "heading 2", '<w:b/><w:sz w:val="26"/>'),
                               ("ListBullet", "List Bullet", '<w:sz w:val="22"/>')))
    return _zip({
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        "word/_rels/document.xml.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
        "word/document.xml": f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {ns}><w:body>{body}</w:body></w:document>',
        "word/styles.xml": f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles {ns}>{styles}</w:styles>',
    })


HANDBOOK = [
    ("Normal", "Everything a new Acme employee needs in the first month. Owned by People Ops; last reviewed October 2026."),
    ("Heading1", "Your first week"),
    ("ListBullet", "• Laptop, badge and SSO on day one"),
    ("ListBullet", "• An onboarding buddy from your team"),
    ("ListBullet", "• Product training on Tuesday and Thursday mornings"),
    ("Heading1", "How we work"),
    ("Heading2", "Communication"),
    ("Normal", "Default to public channels. Decisions are written down in the team's decision log, not left in threads."),
    ("Heading2", "Working hours"),
    ("Normal", "Core hours are 11:00–15:00 in your time zone. Outside them, nobody expects an answer."),
    ("Heading1", "Benefits"),
    ("ListBullet", "• 25 days of holiday plus public holidays"),
    ("ListBullet", "• A yearly learning budget of $1,500"),
    ("ListBullet", "• Home-office setup budget of $800"),
    ("Heading1", "Who to ask"),
    ("Normal", "People Ops: people@acme.com · IT: #it-help · Security: security@acme.com"),
]


def seal(title: str, content: str) -> tuple[str, str]:
    """End-to-end encrypt like the browser (frontend/src/lib/e2e.ts): AES-GCM-256, 12-byte IV,
    envelope `mdx1.<b64url iv>.<b64url ct‖tag>` of JSON {t, c}. Returns (envelope, key for #k=)."""
    import base64

    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    def b64(b: bytes) -> str:
        return base64.urlsafe_b64encode(b).decode().rstrip("=")

    key = bytes(RNG.getrandbits(8) for _ in range(32))
    iv = bytes(RNG.getrandbits(8) for _ in range(12))
    ct = AESGCM(key).encrypt(iv, json.dumps({"t": title, "c": content}).encode(), None)
    return f"mdx1.{b64(iv)}.{b64(ct)}", b64(key)


def upload(token: str, data: bytes, filename: str, mime: str, title: str, slug: str, **filing) -> dict:
    u = call("POST", "/api/v1/artifacts/upload-url", token,
             json={"filename": filename, "content_type": mime, "size_bytes": len(data)})
    r = httpx.put(u["upload_url"], content=data, headers={"Content-Type": u["required_content_type"]}, timeout=60)
    r.raise_for_status()
    body = {"blob_key": u["blob_key"], "title": title, "filename": filename, "custom_slug": slug, **filing}
    return call("POST", "/api/v1/artifacts", token, json=body)


def replace(token: str, slug: str, data: bytes, filename: str, mime: str) -> dict:
    """A new version of a file, same link (PUT /api/v1/artifacts/<slug>/file)."""
    u = call("POST", "/api/v1/artifacts/upload-url", token,
             json={"filename": filename, "content_type": mime, "size_bytes": len(data)})
    httpx.put(u["upload_url"], content=data, headers={"Content-Type": u["required_content_type"]}, timeout=60).raise_for_status()
    return call("PUT", f"/api/v1/artifacts/{slug}/file", token, json={"blob_key": u["blob_key"], "filename": filename})


def publish(token: str, title: str, content: str, slug: str, **filing) -> dict:
    return call("POST", "/api/v1/documents", token,
                json={"title": title, "content": content, "custom_slug": slug, "expires_in": "never", **filing})


# ── Analytics synthesis ───────────────────────────────────────────────────────
# Rows are written straight into `events` and `engage_sessions` in the shapes services/analytics.py
# and services/engage.py store (see backend tests/test_creator_analytics.py), because the ingest
# endpoints stamp the server's "now" and a month of history can't be posted in real time.

DAYS = 120
COUNTRIES = [("US", 30), ("IN", 18), ("GB", 10), ("DE", 9), ("CA", 6), ("FR", 5), ("AU", 5), ("SG", 4),
             ("NL", 4), ("BR", 3), ("JP", 3), ("ES", 3)]
CHANNELS = [("Direct", None, 34), ("Email", None, 10), ("Social", "https://www.linkedin.com/", 12),
            ("Search", "https://www.google.com/", 14), ("Referral", "https://news.ycombinator.com/", 6),
            ("Referral", "https://acme.slack.com/", 12), ("AI assistants", "https://claude.ai/", 4),
            ("Campaign", None, 8)]
DEVICES = [(("Desktop", "macOS", "Chrome"), 30), (("Desktop", "Windows", "Chrome"), 18),
           (("Desktop", "macOS", "Safari"), 10), (("Desktop", "Windows", "Edge"), 8),
           (("Mobile", "iOS", "Safari"), 18), (("Mobile", "Android", "Chrome"), 11),
           (("Tablet", "iOS", "Safari"), 3), (("Desktop", "Linux", "Firefox"), 2)]
CAMPAIGNS = [("newsletter", "email", "october-update"), ("linkedin", "social", "q3-launch"),
             ("partner", "referral", "northwind-webinar")]


def pick(options):
    total = sum(o[-1] for o in options)
    x = RNG.uniform(0, total)
    for o in options:
        x -= o[-1]
        if x <= 0:
            return o
    return options[-1]


def when(now: datetime, days: int = DAYS) -> datetime:
    """A time in the last `days`: busier on weekdays, in working hours, and more recently."""
    while True:
        d = int(days * (RNG.random() ** 1.8))
        t = now - timedelta(days=d, hours=RNG.uniform(0, 24))
        if t > now - timedelta(minutes=5):
            continue
        if t.weekday() >= 5 and RNG.random() < 0.6:
            continue
        if not (7 <= t.hour <= 22) and RNG.random() < 0.7:
            continue
        return t


def visitor() -> dict:
    country = pick(COUNTRIES)[0]
    ch, ref, _ = pick(CHANNELS)
    device, os_, browser = pick(DEVICES)[0]
    utm = None
    if ch in ("Email", "Campaign"):
        utm = RNG.choice(CAMPAIGNS) if ch == "Campaign" else CAMPAIGNS[0]
    return {"ip_hash": f"demo-{RNG.getrandbits(48):012x}", "country": country, "region": None, "city": None,
            "channel": ch, "referrer": ref, "device": device, "os": os_, "browser": browser,
            "utm_source": utm[0] if utm else None, "utm_medium": utm[1] if utm else None,
            "utm_campaign": utm[2] if utm else None, "internal": False}


def members_as_visitors(n: int) -> list[dict]:
    """Workspace members reading their own team's links: counted as internal (hidden by default)."""
    out = []
    for _ in range(n):
        v = visitor()
        v.update({"internal": True, "channel": "Direct", "referrer": None, "country": "US",
                  "utm_source": None, "utm_medium": None, "utm_campaign": None})
        out.append(v)
    return out


def session_row(doc: dict, kind: str, started: datetime, v: dict, ver=None, **fields) -> dict:
    active = fields.get("active_s", 30)
    row = {
        "sid": f"demo{RNG.getrandbits(64):016x}", "doc_id": str(doc["_id"]), "owner_id": doc.get("owner_id"),
        "kind": kind, "ver": ver if kind != "doc" else None, "started_at": started,
        "updated_at": started + timedelta(seconds=active + 5), "seq": 4, "ended": True,
        "ip_hash": v["ip_hash"], "country": v["country"], "region": None, "city": None, "device": v["device"],
        "os": v["os"], "browser": v["browser"], "channel": v["channel"], "ref": v["referrer"],
        "utm_source": v["utm_source"], "utm_medium": v["utm_medium"], "utm_campaign": v["utm_campaign"],
        "internal": v.get("internal", False), "active_s": 30, "depth": 0, "reached": [], "sec": {}, "copies": {},
        "links": {}, "prints": 0, "pages": {}, "npages": None, "pmax": 0, "rv": {}, "media": None,
    }
    row.update(fields)
    return row


def view_row(doc: dict, ts: datetime, v: dict, ver=None) -> dict:
    return {"doc_id": str(doc["_id"]), "owner_id": doc.get("owner_id"), "type": "view", "ts": ts,
            "country": v["country"], "region": None, "city": None, "referrer": v["referrer"],
            "ip_hash": v["ip_hash"], "channel": v["channel"], "utm_source": v["utm_source"],
            "utm_medium": v["utm_medium"], "utm_campaign": v["utm_campaign"], "ver": ver,
            "internal": v.get("internal", False), "device": v["device"], "os": v["os"], "browser": v["browser"]}


def previews(doc: dict, now: datetime, counts: dict[str, int]) -> None:
    """Link-preview fetches (Slack, LinkedIn, WhatsApp unfurling the link): share signals."""
    rows = [{"doc_id": str(doc["_id"]), "owner_id": doc.get("owner_id"), "type": "preview", "platform": p,
             "ts": when(now, 60)} for p, n in counts.items() for _ in range(n)]
    if rows:
        db["events"].insert_many(rows)


def views(doc: dict, now: datetime, n: int, ver_split: float | None = None, internal: int = 0) -> list[dict]:
    pool = [visitor() for _ in range(max(10, int(n * 0.72)))]
    rows = []
    for _ in range(n):
        ts = when(now)
        ver = None
        if ver_split is not None:
            ver = 2 if ts > now - timedelta(days=ver_split) else 1
        rows.append(view_row(doc, ts, RNG.choice(pool), ver))
    inside = members_as_visitors(4)
    rows += [view_row(doc, when(now), RNG.choice(inside)) for _ in range(internal)]
    db["events"].insert_many(rows)
    db["documents"].update_one({"_id": doc["_id"]}, {"$set": {"views": n + internal}})
    return pool


def heading_ids(md: str) -> list[str]:
    out = []
    for line in md.splitlines():
        m = re.match(r"^(##+)\s+(.*)", line)
        if m:
            out.append(re.sub(r"[^a-z0-9]+", "-", m.group(2).lower()).strip("-"))
    return out


def synth_doc(doc: dict, md: str, now: datetime, n_views: int, sessions: int,
              links: list[str] | None = None) -> None:
    ids = heading_ids(md)
    pool = views(doc, now, n_views, internal=max(3, n_views // 25))
    rows = []
    for _ in range(sessions):
        v = RNG.choice(pool)
        # Most readers get through the first sections; a clear share leave before "Define your
        # first metric" (the 4th section); fewer reach the end.
        n = max(1, round(len(ids) * min(1.0, RNG.betavariate(2.0, 1.4) * 1.12)))
        if n >= 4 and RNG.random() < 0.3:
            n = 3
        reached = ids[:n]
        sec = {h: round(RNG.uniform(6, 60) * (1.8 if i in (1, 2) else 1), 1) for i, h in enumerate(reached)}
        active = int(sum(sec.values()) + RNG.uniform(5, 30))
        copies, clicked = {}, {}
        if len(reached) > 1 and RNG.random() < 0.42:
            copies[f"7f3a9c|{reached[1]}"] = 1
        if len(reached) > 2 and RNG.random() < 0.25:
            copies[f"b81e04|{reached[2]}"] = 1
        if links and len(reached) >= 3 and RNG.random() < 0.3:
            clicked[RNG.choice(links)] = 1
        depth = RNG.randint(92, 100) if n == len(ids) else min(89, int(n / len(ids) * 100 + RNG.uniform(-6, 6)))
        rows.append(session_row(doc, "doc", when(now), v, active_s=active, depth=depth,
                                reached=reached, sec=sec, copies=copies, links=clicked,
                                prints=1 if RNG.random() < 0.03 else 0))
    if rows:
        db["engage_sessions"].insert_many(rows)


def synth_pdf(doc: dict, now: datetime, n_views: int, sessions: int, v2_days: float) -> None:
    pool = views(doc, now, n_views, ver_split=v2_days, internal=6)
    rows = []
    for _ in range(sessions):
        v = RNG.choice(pool)
        # Most readers make it through the agenda and highlights, then the biggest drop is after
        # page 3; a second, smaller one after pricing (page 8).
        last = 1
        for p in range(2, 13):
            keep = 0.55 if p == 4 else 0.8 if p == 9 else 0.95
            if RNG.random() > keep:
                break
            last = p
        pages = {str(p): round(RNG.uniform(5, 26) * (2.4 if p in (4, 8) else 1), 1) for p in range(1, last + 1)}
        rv = {"4": 1} if last >= 5 and RNG.random() < 0.3 else {}
        started = when(now)
        ver = 2 if started > now - timedelta(days=v2_days) else 1
        rows.append(session_row(doc, "pdf", started, v, ver=ver, active_s=int(sum(pages.values())), npages=12,
                                pmax=last, pages=pages, rv=rv, depth=int(last / 12 * 100)))
    db["engage_sessions"].insert_many(rows)


def synth_video(doc: dict, now: datetime, dur: float, n_views: int, sessions: int, v2_days: float) -> None:
    pool = views(doc, now, n_views, ver_split=v2_days, internal=8)
    rows = []
    for i in range(sessions):
        v = RNG.choice(pool)
        phone = v["device"] == "Mobile"
        empty = {"dur": dur, "segs": [], "plays": 0, "ended": 0, "watched_s": 0, "startup_ms": None, "speed": {},
                 "fs_s": 0, "pip_s": 0, "muted_s": 0, "rebuf_n": 0, "rebuf_ms": 0, "err": None, "seeks": 0,
                 "dropped": 0, "frames": 0}
        if RNG.random() < 0.07:  # opened the page, never pressed play
            media = empty
        elif i % 41 == 7:  # a failed play: what the playback-health panel is for
            media = {**empty, "err": RNG.choice(["network", "decode"])}
        else:
            # A cliff after the title card (~0:06), a steady decline, a hold to the end card,
            # and a replayed stretch over the dashboards scene (0:11–0:17).
            r = RNG.random()
            if r < 0.22:
                end = RNG.uniform(3, 7)
            elif r < 0.56:
                end = dur
            else:
                end = min(dur, 7 + RNG.expovariate(1 / 15))
            segs = [[0.0, round(end, 2)]]
            if end > 18 and RNG.random() < 0.33:
                segs.append([11.0, 17.5])
            if end >= dur - 0.5 and RNG.random() < 0.15:  # skipped the middle on a re-watch
                segs.append([30.0, round(dur, 2)])
            watched = sum(e - s for s, e in segs)
            speed = {"1": round(watched, 1)} if RNG.random() > 0.14 else {"1．5": round(watched, 1)}
            slow = phone and RNG.random() < 0.45
            media = {"dur": dur, "segs": segs, "plays": 1, "ended": 1 if end >= dur - 0.5 else 0,
                     "watched_s": round(min(watched, dur), 1),
                     "startup_ms": int(RNG.uniform(5600, 9000)) if slow else int(RNG.lognormvariate(6.6, 0.4)),
                     "speed": speed, "fs_s": round(watched * 0.6, 1) if RNG.random() < 0.18 else 0, "pip_s": 0,
                     "muted_s": round(watched, 1) if RNG.random() < 0.22 else 0,
                     "rebuf_n": 1 if (slow or RNG.random() < 0.04) else 0, "rebuf_ms": 1800 if slow else 0,
                     "err": None, "seeks": len(segs) - 1, "dropped": 0, "frames": int(watched * 30)}
        started = when(now)
        ver = 2 if started > now - timedelta(days=v2_days) else 1
        rows.append(session_row(doc, "video", started, v, ver=ver,
                                active_s=int(media["watched_s"] + RNG.uniform(3, 12)), media=media))
    db["engage_sessions"].insert_many(rows)


# ── Rebase ────────────────────────────────────────────────────────────────────


def rebase() -> None:
    meta_file = DATA / "fixtures.json"
    meta = json.loads(meta_file.read_text())
    old = datetime.fromisoformat(meta["demo_now"])
    new = minute(datetime.now(timezone.utc))
    delta = new - old
    if abs(delta) < timedelta(minutes=1):
        print("rebase: already current")
        return
    n = 0
    for name in db.list_collection_names():
        if name.startswith("system."):
            continue
        coll = db[name]
        for row in coll.find({}):
            sets = {k: v + delta for k, v in row.items() if isinstance(v, datetime)}
            if sets:
                coll.update_one({"_id": row["_id"]}, {"$set": sets})
                n += 1
    meta["demo_now"] = new.isoformat()
    meta_file.write_text(json.dumps(meta, indent=2))
    print(f"rebase: shifted {n} rows by {delta}; demo_now = {new.isoformat()}")


# ── Seed ──────────────────────────────────────────────────────────────────────


def reset() -> None:
    for name in db.list_collection_names():
        if not name.startswith("system."):
            db[name].delete_many({})
    shutil.rmtree(DATA / "r2", ignore_errors=True)
    (DATA / "r2").mkdir(parents=True, exist_ok=True)
    (DATA / "dns.json").write_text("{}")


def wait_media(token: str, slug: str, timeout: float = 40) -> dict | None:
    end = time.time() + timeout
    while time.time() < end:
        doc = call("GET", f"/api/v1/documents/{slug}", token)
        if doc.get("media") and doc.get("poster_url"):
            return doc
        time.sleep(1)
    print(f"  ! no media/poster for {slug} after {timeout}s (ffprobe/ffmpeg?)")
    return None


def seed() -> dict:
    ensure_fixtures()
    try:
        http.get("/__sandbox/health").raise_for_status()
    except Exception:
        sys.exit(f"seed.py: the sandbox API isn't answering at {API} — run stack/stack.sh start")
    reset()
    now = minute(datetime.now(timezone.utc))

    # ── People ──
    people = {
        "riya": ("riya@acme.com", "Riya Sharma"),
        "alex": ("alex@acme.com", "Alex Chen"),
        "sam": ("sam@acme.com", "Sam Lee"),
        "maya": ("maya@acme.com", "Maya Patel"),
        "dana": ("dana@globex.com", "Dana"),  # not in Acme: requests access, signs in on docs.acme.com
        "jordan": ("jordan@northwind.com", "Jordan Park"),  # owns the Northwind workspace
    }
    users = {k: call("POST", "/__sandbox/user", json={"email": e, "name": n}) for k, (e, n) in people.items()}
    riya = users["riya"]["token"]

    # ── Acme: members, folders, branding, domains, an invitation ──
    ws = call("POST", "/api/v1/workspaces", riya, json={"name": "Acme"})
    ws_id = ws["id"]
    for key, role in (("alex", "member"), ("sam", "viewer"), ("maya", "admin")):
        u = users[key]
        db["memberships"].insert_one({"workspace_id": ws_id, "user_id": u["id"], "role": role,
                                      "created_at": now - timedelta(days=50), "email": u["email"], "name": u["name"]})
    folders = {name: call("POST", f"/api/v1/workspaces/{ws_id}/folders", riya, json={"name": name})
               for name in ("Guides", "Releases", "Sales")}
    folders["Setup"] = call("POST", f"/api/v1/workspaces/{ws_id}/folders", riya,
                            json={"name": "Setup", "parent_id": folders["Guides"]["id"]})
    # The logo is the square mark: it sits in square slots (sidebar, workspace header, preview
    # card) beside the site name, where a wide wordmark would shrink to nothing.
    logo = call("POST", f"/api/v1/workspaces/{ws_id}/branding/logo", riya,
                files={"file": ("acme-logo.png", (FIX / "acme-favicon.png").read_bytes(), "image/png")})
    favicon = call("POST", f"/api/v1/workspaces/{ws_id}/branding/favicon", riya,
                   files={"file": ("acme-favicon.png", (FIX / "acme-favicon.png").read_bytes(), "image/png")})
    call("PUT", f"/api/v1/workspaces/{ws_id}", riya, json={
        "branding": {"site_name": "Acme", "accent_color": "#0F766E", "logo_url": logo["url"],
                     "favicon_url": favicon["url"], "hide_markdrop_branding": False},
        "settings": {"viewer_chrome": "full", "require_auth_to_view": False,
                     "members_can_share_folders": True, "default_access": "workspace"},
    })
    live = call("POST", "/__sandbox/domain", json={"workspace_id": ws_id, "host": "docs.acme.com", "primary": True})
    # help.acme.com: added, DNS not published yet ("Awaiting DNS").
    pending = call("POST", f"/api/v1/workspaces/{ws_id}/domains", riya, json={"host": "help.acme.com", "kind": "app"})
    call("POST", f"/api/v1/workspaces/{ws_id}/invitations", riya, json={"email": "lee@contractors.io", "role": "member"})

    # ── Northwind: brand new and empty, Riya is an admin ("Get set up") ──
    nw = call("POST", "/api/v1/workspaces", users["jordan"]["token"], json={"name": "Northwind"})
    db["memberships"].insert_one({"workspace_id": nw["id"], "user_id": users["riya"]["id"], "role": "admin",
                                  "created_at": now - timedelta(days=2), "email": "riya@acme.com", "name": "Riya Sharma"})

    # ── Documents ── (key, title, content, slug, folder, access, age)
    F = {k: v["id"] for k, v in folders.items()}
    docs_spec = [
        ("getting_started", "Getting started with Acme", C.GETTING_STARTED, "getting-started", "Setup", "link", timedelta(hours=2)),
        ("connect_postgres", "Connecting Postgres", C.CONNECT_POSTGRES, "connect-postgres", "Setup", "workspace", timedelta(days=3, hours=4)),
        ("alert_rules", "Alert rules reference", C.ALERT_RULES, "alert-rules", "Guides", "workspace", timedelta(days=6)),
        ("onboarding_guide", "Onboarding guide", C.ONBOARDING_GUIDE, "onboarding-guide", "Guides", "workspace", timedelta(days=1, hours=2)),
        ("release_24", "Release notes — v2.4", C.RELEASE_24, "release-notes-2-4", "Releases", "workspace", timedelta(days=2, hours=1)),
        ("release_23", "Release notes — v2.3", C.RELEASE_23, "release-notes-2-3", "Releases", "link", timedelta(days=30)),
        ("release_22", "Release notes — v2.2", C.RELEASE_22, "release-notes-2-2", "Releases", "link", timedelta(days=65)),
        ("release_21", "Release notes — v2.1", C.RELEASE_21, "release-notes-2-1", "Releases", "link", timedelta(days=93)),
        ("release_20", "Release notes — v2.0", C.RELEASE_20, "release-notes-2-0", "Releases", "link", timedelta(days=122)),
        ("meeting_oct_28", "Product sync — October 28", C.MEETING_OCT_28, "meeting-notes-oct-28", "Releases", "workspace", timedelta(days=2, hours=5)),
        ("meeting_oct_21", "Product sync — October 21", C.MEETING_OCT_21, "meeting-notes-oct-21", "Releases", "link", timedelta(days=9)),
        ("meeting_oct_14", "Product sync — October 14", C.MEETING_OCT_14, "meeting-notes-oct-14", "Releases", "link", timedelta(days=16)),
        ("launch_notes", "Launch notes: Workflows beta", C.LAUNCH_NOTES, "launch-notes", "Releases", "link", timedelta(days=1, hours=3)),
        ("roadmap_2027", "Roadmap 2027 (draft)", C.ROADMAP_2027, "roadmap-2027", "Releases", "private", timedelta(days=4)),
        ("incident", "Incident report — delayed Stripe syncs (Oct 9)", C.INCIDENT_REPORT, "incident-stripe-oct-9", "Releases", "link", timedelta(days=20)),
        ("sales_playbook", "Sales playbook", C.SALES_PLAYBOOK, "sales-playbook", "Sales", "private", timedelta(days=7)),
        ("security_faq", "Enterprise security FAQ", C.SECURITY_FAQ, "security-faq", "Sales", "link", timedelta(days=9)),
        # Riya's own (not filed)
        ("q3_plan_internal", "Q3 plan — internal notes", C.Q3_PLAN_INTERNAL, "q3-plan-internal", None, "private", timedelta(hours=5)),
        ("offsite", "Product team offsite — November 13–14", C.OFFSITE, "offsite-lisbon", None, "link", timedelta(days=4)),
        ("api_changelog", "Metrics API v2 — changelog draft", C.API_CHANGELOG, "metrics-api-v2", None, "link", timedelta(days=12)),
        ("readme", "acme-cli", C.CLI_README, "acme-cli-readme", None, "link", timedelta(days=3)),
    ]
    slugs, ages, contents = {}, {}, {}
    for key, title, content, slug, folder, access, age in docs_spec:
        filing = {"workspace": ws_id, "folder": F[folder]} if folder else {}
        publish(riya, title, content, slug, access_level=access, **filing)
        slugs[key], ages[key], contents[key] = slug, age, content
    # A read password, an end-to-end encrypted one, and an anonymous one with an edit secret.
    call("POST", "/api/v1/documents", riya, json={"title": "Pricing FAQ (draft)", "content": C.PRICING_FAQ,
                                                  "custom_slug": "pricing-faq", "read_password": "acme-2027"})
    slugs["pricing_faq"], ages["pricing_faq"] = "pricing-faq", timedelta(days=2, hours=3)
    envelope, e2e_key = seal("Board prep — private notes", C.BOARD_PREP)
    enc = call("POST", "/api/v1/documents", riya, json={"title": None, "content": envelope, "encrypted": True,
                                                        "custom_slug": "board-prep"})
    slugs["board_prep"], ages["board_prep"] = enc["slug"], timedelta(days=1, hours=7)
    anon = call("POST", "/api/v1/documents", json={"title": "Q3 plan", "content": C.Q3_PLAN, "custom_slug": "q3-plan"})
    slugs["q3_plan"], ages["q3_plan"] = "q3-plan", timedelta(days=1)

    # ── Files ── (key, bytes, filename, mime, title, slug, folder, access, age)
    xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    files_spec = [
        ("q3_deck", (FIX / "q3-board-deck-v1.pdf").read_bytes(), "Q3 Board Deck.pdf", "application/pdf", "Q3 Board Deck", "q3-board-deck", "Sales", "link", timedelta(hours=26)),
        ("product_demo", (FIX / "product-demo-v1.mp4").read_bytes(), "product-demo.mp4", "video/mp4", "Product demo", "product-demo", "Releases", "link", timedelta(days=8)),
        ("forecast", xlsx_bytes(FORECAST), "q3-forecast.xlsx", xlsx, "Q3 forecast", "q3-forecast", "Sales", "workspace", timedelta(days=5)),
        ("pipeline", C.PIPELINE_CSV.encode(), "pipeline.csv", "text/csv", "Sales pipeline — Q4", "pipeline", "Sales", "workspace", timedelta(days=1, hours=6)),
        ("handbook", docx_bytes("Acme onboarding handbook", HANDBOOK), "onboarding-handbook.docx", docx, "Onboarding handbook", "onboarding-handbook", "Guides", "workspace", timedelta(days=11)),
        ("architecture", (FIX / "acme-architecture.png").read_bytes(), "acme-architecture.png", "image/png", "System architecture", "architecture-diagram", "Setup", "workspace", timedelta(days=10)),
        ("dashboard_html", C.q3_dashboard_html().encode(), "q3-dashboard.html", "text/html", "Q3 dashboard", "q3-dashboard", None, "link", timedelta(days=2, hours=8)),
        ("api_response", C.API_RESPONSE_JSON.encode(), "api-response.json", "application/json", "Metrics API response", "api-response", None, "link", timedelta(days=6)),
        ("team_photo", (FIX / "team-photo.png").read_bytes(), "team-photo.png", "image/png", "Team photo — Lisbon", "team-photo", None, "link", timedelta(days=13)),
        ("help_site", _zip(C.help_site_files()), "acme-help-site.zip", "application/zip", "Acme Help Center", "acme-help", None, "link", timedelta(days=5, hours=2)),
        ("hevc", (FIX / "hevc-recording.mov").read_bytes(), "screen-recording.mov", "video/quicktime", "Screen recording (iPhone)", "screen-recording", None, "link", timedelta(days=3, hours=2)),
        ("landing", C.WORKFLOWS_LANDING.encode(), "workflows-beta.html", "text/html", "Workflows beta landing page", "workflows-beta", None, "link", timedelta(days=2, hours=8)),
    ]
    for key, data, filename, mime, title, slug, folder, access, age in files_spec:
        filing = {"workspace": ws_id, "folder": F[folder]} if folder else {}
        upload(riya, data, filename, mime, title, slug, access_level=access, **filing)
        slugs[key], ages[key] = slug, age
    wait_media(riya, slugs["product_demo"])
    # Second versions: the deck's page 4 changes; the video gets a new end card.
    replace(riya, slugs["q3_deck"], (FIX / "q3-board-deck-v2.pdf").read_bytes(), "Q3 Board Deck.pdf", "application/pdf")
    replace(riya, slugs["product_demo"], (FIX / "product-demo-v2.mp4").read_bytes(), "product-demo.mp4", "video/mp4")
    video = wait_media(riya, slugs["product_demo"])

    # ── Sharing ──
    for slug, email, role in (
        (slugs["onboarding_guide"], "alex@acme.com", "editor"),
        (slugs["onboarding_guide"], "sam@acme.com", "viewer"),
        (slugs["onboarding_guide"], "priya@northwind.com", "viewer"),
        (slugs["q3_deck"], "jordan@northwind.com", "viewer"),
        (slugs["q3_plan_internal"], "alex@acme.com", "editor"),
        (slugs["sales_playbook"], "maya@acme.com", "editor"),
    ):
        call("POST", f"/api/v1/documents/{slug}/access/people", riya, json={"email": email, "role": role, "notify": False})
    # Shared *with* Riya (her "Shared with me"): two of Alex's documents.
    alex = users["alex"]["token"]
    for title, content, slug in (("Runner load-test plan", "# Runner load-test plan\n\nTarget: 2,000 workflow runs per minute per region.\n\n## Scenarios\n\n- Burst of 10× normal traffic for 5 minutes\n- Slow Slack API (2 s latency)\n- Webhook targets returning 500\n", "runner-load-test"),
                                 ("Tile caching proposal", "# Tile caching proposal\n\nCache tile results for dashboards with more than 20 tiles, keyed by query hash and data version.\n", "tile-caching")):
        call("POST", "/api/v1/documents", alex, json={"title": title, "content": content, "custom_slug": slug,
                                                      "access_level": "private"})
        call("POST", f"/api/v1/documents/{slug}/access/people", alex, json={"email": "riya@acme.com", "role": "editor", "notify": False})
        slugs[slug.replace("-", "_")], ages[slug.replace("-", "_")] = slug, timedelta(hours=RNG.choice([3, 20]))
    req = call("POST", f"/api/v1/documents/{slugs['q3_plan_internal']}/access-requests", users["dana"]["token"],
               json={"message": "Hi, I need this for Thursday's review."})

    # ── Account: API tokens, connected apps ──
    tokens = {}
    for name, used, prefix in (("My laptop", timedelta(hours=2), "mdk_4Qx7aLp2"),
                               ("Nightly report", timedelta(days=1, hours=1), "mdk_Zr8mT1qe"),
                               ("VS Code", None, "mdk_9bKe0sWd")):
        t = call("POST", "/api/v1/me/tokens", riya, json={"name": name})
        db["api_tokens"].update_one({"_id": ObjectId(t["id"])}, {"$set": {
            "prefix": prefix, "last_used_at": (now - used) if used else None,
            "created_at": now - timedelta(days=RNG.choice([9, 21, 34]))}})
        tokens[name] = t["id"]
    db["oauth_grants"].insert_many([
        {"user_id": users["riya"]["id"], "client_id": "https://claude.ai/oauth/mcp-client-metadata",
         "client_name": "Claude", "client_uri": "https://claude.ai", "logo_uri": None,
         "scopes": ["documents:read", "documents:write"], "created_at": now - timedelta(days=4),
         "last_used_at": now - timedelta(minutes=50)},
        {"user_id": users["riya"]["id"], "client_id": "https://cursor.com/oauth/mcp-client-metadata",
         "client_name": "Cursor", "client_uri": "https://cursor.com", "logo_uri": None,
         "scopes": ["documents:read"], "created_at": now - timedelta(days=1, hours=2), "last_used_at": None},
    ])

    # ── Timestamps: the world is ~four months old; documents have the ages above ──
    for key, slug in slugs.items():
        created = now - ages[key] - timedelta(minutes=RNG.randint(5, 90))
        db["documents"].update_one({"slug": slug}, {"$set": {"created_at": created, "updated_at": now - ages[key],
                                                              "demo_seed": True}})
    for key, v1_age in (("q3_deck", timedelta(days=9)), ("product_demo", timedelta(days=21))):
        raw_doc = db["documents"].find_one({"slug": slugs[key]})
        db["documents"].update_one({"_id": raw_doc["_id"]}, {"$set": {"created_at": now - v1_age}})
        rows = list(db["file_versions"].find({"doc_id": str(raw_doc["_id"])}).sort("version", 1))
        for row, age in zip(rows, (v1_age, ages[key])):
            db["file_versions"].update_one({"_id": row["_id"]}, {"$set": {"created_at": now - age}})
    db["users"].update_many({}, {"$set": {"created_at": now - timedelta(days=130)}})
    db["users"].update_one({"email": "dana@globex.com"}, {"$set": {"created_at": now - timedelta(days=20)}})
    db["workspaces"].update_many({"name": "Acme"}, {"$set": {"created_at": now - timedelta(days=125)}})
    db["workspaces"].update_many({"name": "Northwind"}, {"$set": {"created_at": now - timedelta(days=2)}})
    db["memberships"].update_many({"workspace_id": ws_id, "role": "owner"}, {"$set": {"created_at": now - timedelta(days=125)}})
    db["domains"].update_many({"host": "docs.acme.com"}, {"$set": {
        "created_at": now - timedelta(days=40), "verified_at": now - timedelta(days=40),
        "last_checked_at": now - timedelta(hours=6)}})
    db["domains"].update_many({"host": "help.acme.com"}, {"$set": {"created_at": now - timedelta(minutes=25)}})
    db["access_requests"].update_many({}, {"$set": {"created_at": now - timedelta(minutes=40)}})
    db["document_grants"].update_many({}, {"$set": {"created_at": now - timedelta(days=1)}})
    db["invitations"].update_many({}, {"$set": {"created_at": now - timedelta(days=1, hours=4)}})

    # ── Analytics ──
    def raw(key):
        return db["documents"].find_one({"slug": slugs[key]})

    synth_doc(raw("getting_started"), contents["getting_started"], now, 612, 402,
              links=["get．acme．com/cli|install-the-cli", "acme．com/start|before-you-begin",
                     "docs．acme．com/guides/alert-rules|next-steps"])
    for key, n_views, n_sess in (("release_24", 236, 150), ("connect_postgres", 128, 84), ("security_faq", 74, 41),
                                 ("onboarding_guide", 66, 40), ("launch_notes", 58, 33), ("offsite", 24, 12),
                                 ("release_23", 41, 22), ("meeting_oct_28", 22, 14)):
        synth_doc(raw(key), contents[key], now, n_views, n_sess)
    synth_pdf(raw("q3_deck"), now, 188, 141, v2_days=1.1)
    dur = float(((video or {}).get("media") or {}).get("duration_s") or 40.6)
    synth_video(raw("product_demo"), now, dur, 520, 384, v2_days=8)
    previews(raw("product_demo"), now, {"Slack": 14, "LinkedIn": 6, "WhatsApp": 4})
    previews(raw("getting_started"), now, {"Slack": 9, "LinkedIn": 3})
    previews(raw("q3_deck"), now, {"Slack": 5})

    out = {
        "demo_now": now.isoformat(),
        "api": API,
        "users": {k: {"id": u["id"], "email": u["email"], "name": u["name"]} for k, u in users.items()},
        "workspace": {"id": ws_id, "name": "Acme", "folders": F},
        "northwind": {"id": nw["id"]},
        "domains": {"live": live, "pending": {"id": pending["id"], "host": pending["host"]}},
        "docs": slugs,
        "edit_secrets": {"q3-plan": anon["edit_secret"]},
        "e2e_keys": {slugs["board_prep"]: e2e_key},
        "read_passwords": {"pricing-faq": "acme-2027"},
        "access_request": req["id"],
        "tokens": tokens,
    }
    (DATA / "fixtures.json").write_text(json.dumps(out, indent=2))
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--rebase", action="store_true", help="shift every timestamp so the demo's now is now")
    args = ap.parse_args()
    if args.rebase:
        rebase()
    else:
        t = time.time()
        world = seed()
        print(f"seeded {DB_NAME} in {time.time() - t:.1f}s: {len(world['docs'])} documents, "
              f"workspace {world['workspace']['id']}, domain {world['domains']['live']['host']}; "
              f"fixtures → {DATA / 'fixtures.json'}")
