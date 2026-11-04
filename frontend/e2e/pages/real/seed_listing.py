"""A busy second workspace for the workspace listing (fix/ws-listing): owners on rows, the List / Grid /
Cards switch and the folder-click timing. Run AFTER seed.py (it reuses seed.json's people and adds to
the same db; it never wipes):

    STACK_ID=12 DOCS_MEDIA_DATA=… PB_STACK=… python seed_listing.py

"Senseloaf" (Ada owns it; Ben and Wes edit, Vic views, Cy is an outsider): 12 top-level folders,
nested three deep, ~180 items by three owners (pages, Markdown documents, files), a few private
ones, realistic Markdown bodies (~6 KB) and spread-out update times. Plus "Gallery" (feat/card-previews):
one of everything the Cards view previews (pages with covers, Markdown, four HTML files, a PDF, images,
a video, CSV, XLSX, JSON, DOCX), an end-to-end encrypted document, a password-protected one and a
private one of Ada's; their slugs are in seed-listing.json's "gallery". Writes seed-listing.json to
$PB_STACK.
"""
import json
import os
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from pymongo import MongoClient

STACK_ID = int(os.environ.get("STACK_ID", "5"))
API = os.environ.get("PB_API", f"http://127.0.0.1:{8180 + 10 * STACK_ID}")
DB_NAME = os.environ.get("PB_DB", f"markdrop_docs_demo_{STACK_ID}")
assert DB_NAME.startswith("markdrop_docs_demo"), "seed_listing only writes to a sandbox db"
OUT = Path(os.environ.get("PB_STACK") or ".")
DB = MongoClient("mongodb://127.0.0.1:27019")[DB_NAME]
http = httpx.Client(base_url=API, timeout=60)
rng = random.Random(7)


def call(method, path, token=None, **kw):
    headers = kw.pop("headers", {})
    if token:
        headers["Authorization"] = f"Bearer {token}"
    r = http.request(method, path, headers=headers, **kw)
    if r.status_code >= 400:
        sys.exit(f"{method} {path} → {r.status_code}: {r.text[:400]}")
    return r.json() if r.content else None


seed = json.loads((OUT / "seed.json").read_text())
U = seed["users"]
ada, ben, wes, vic, cy = U["owner"], U["member"], U["admin"], U["reader"], U["stranger"]
# A profile photo for Ben (an https picture, as Google sign-in gives), so avatars show both kinds.
DB["users"].update_one({"email": ben["email"]}, {"$set": {"picture": "https://www.gravatar.com/avatar/00000000000000000000000000000000?d=identicon&s=64"}})

ws = call("POST", "/api/v1/workspaces", ada["token"], json={"name": "Senseloaf"})["id"]
now = datetime.now(timezone.utc)
for u, role in ((ben, "member"), (wes, "admin"), (vic, "viewer")):
    DB["memberships"].insert_one({"workspace_id": ws, "user_id": u["id"], "role": role, "created_at": now,
                                  "email": u["email"], "name": u["name"]})


def folder(name, parent=None):
    return call("POST", f"/api/v1/workspaces/{ws}/folders", ada["token"], json={"name": name, "parent_id": parent})["id"]


TOP = ["Product", "Engineering", "Design", "Marketing", "Sales", "Customer success", "Hiring",
       "Finance", "Legal", "Research", "Operations", "Archive"]
folders = {n: folder(n) for n in TOP}
nested = {
    "Specs": folder("Specs", folders["Product"]),
    "Backend": folder("Backend", folders["Engineering"]),
    "Frontend": folder("Frontend", folders["Engineering"]),
    "Campaigns": folder("Campaigns", folders["Marketing"]),
    "Interviews": folder("Interviews", folders["Research"]),
}
nested["2026"] = folder("2026", nested["Specs"])
nested["API"] = folder("API", nested["Backend"])
nested["Q4"] = folder("Q4", nested["Campaigns"])

PARA = ("We keep this short and write it down so the next person doesn't have to ask. The plan below is "
        "what we agreed in the weekly sync; anything that changed since is marked. ")
BODY = "\n\n".join(f"## Section {i}\n\n" + PARA * 6 for i in range(1, 9))  # ~6 KB

owners = [ada, ben, wes]
WORDS = ["Roadmap", "Onboarding", "Pricing", "Launch", "Retro", "Runbook", "Checklist", "Brief", "Notes",
         "Plan", "Review", "Playbook", "FAQ", "Proposal", "Guide", "Summary"]
made = []


def doc(title, owner, folder_id, access="workspace"):
    r = call("POST", "/api/v1/documents", owner["token"], json={
        "title": title, "content": f"# {title}\n\n{BODY}\n", "expires_in": "never",
        "workspace": ws, "folder": folder_id, "access_level": access})
    made.append(r["slug"])
    return r["slug"]


def page(title, owner, folder_id):
    payload = {"title": title, "content": f"# {title}\n\n{PARA * 4}\n", "workspace": ws}
    if folder_id:
        payload["folder"] = folder_id
    r = call("POST", "/api/v1/pages", owner["token"], json=payload)["document"]["slug"]
    made.append(r)
    return r


PNG = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                    "1f15c4890000000d49444154789c6360f8cfc0f01f0005000201e2b2"
                    "cf6f0000000049454e44ae426082")


def upload(title, filename, owner, folder_id):
    u = call("POST", "/api/v1/artifacts/upload-url", owner["token"],
             json={"filename": filename, "content_type": "image/png", "size_bytes": len(PNG)})
    httpx.put(u["upload_url"], content=PNG, headers={"Content-Type": u["required_content_type"]}, timeout=60).raise_for_status()
    r = call("POST", "/api/v1/artifacts", owner["token"], json={
        "blob_key": u["blob_key"], "title": title, "filename": filename, "workspace": ws, "folder": folder_id,
        "access_level": "workspace"})
    made.append(r["slug"])


n = 0
places = [*folders.values(), *nested.values()]
for fid in places:
    count = 60 if fid == folders["Archive"] else rng.randint(6, 11)
    for i in range(count):
        owner = owners[n % 3]
        title = f"{rng.choice(WORDS)} {n + 1:03d}"
        if i % 4 == 0:
            page(title, owner, fid)
        elif i == 3:
            upload(f"Diagram {n + 1:03d}", f"diagram-{n + 1}.png", owner, fid)
        else:
            doc(title, owner, fid, "private" if i == 5 else "workspace")
        n += 1
for i in range(8):
    doc(f"Top-level note {i + 1}", owners[i % 3], None)

# Spread update times over the last 60 days (newest first in the listing).
for slug in made:
    t = now - timedelta(minutes=rng.randint(5, 60 * 24 * 60))
    DB["documents"].update_one({"slug": slug}, {"$set": {"updated_at": t.replace(tzinfo=None)}})

# ── Gallery: one of everything the Cards view previews (feat/card-previews) ──
import io  # noqa: E402
import zipfile  # noqa: E402

FIX = Path(os.environ.get("PB_FIXTURES") or Path(__file__).resolve().parents[3] / "scripts" / "docs-media" / ".data" / "fixtures")
gallery = folder("Gallery")
G: dict[str, str] = {}


def upload_bytes(key, title, filename, data, ctype, owner=ada, access="workspace"):
    u = call("POST", "/api/v1/artifacts/upload-url", owner["token"],
             json={"filename": filename, "content_type": ctype, "size_bytes": len(data)})
    httpx.put(u["upload_url"], content=data, headers={"Content-Type": u["required_content_type"]}, timeout=60).raise_for_status()
    r = call("POST", "/api/v1/artifacts", owner["token"], json={
        "blob_key": u["blob_key"], "title": title, "filename": filename, "workspace": ws, "folder": gallery,
        "access_level": access})
    G[key] = r["slug"]


def gdoc(key, title, content, owner=ada, access="workspace", **extra):
    r = call("POST", "/api/v1/documents", owner["token"], json={
        "title": title, "content": content, "expires_in": "never", "workspace": ws, "folder": gallery,
        "access_level": access, **extra})
    G[key] = r["slug"]


def gpage(key, title, content, owner=ada):
    r = call("POST", "/api/v1/pages", owner["token"], json={"title": title, "content": content, "workspace": ws, "folder": gallery})
    G[key] = r["document"]["slug"]


HTML = {
    "dash": ("Q3 revenue dashboard", """<!doctype html><html><head><title>Q3 revenue</title><style>
body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#0f172a;color:#e2e8f0}
header{padding:28px 40px;background:linear-gradient(120deg,#4f46e5,#0ea5e9)}h1{margin:0;font-size:34px;color:#fff}
.k{display:flex;gap:20px;padding:28px 40px}.c{flex:1;padding:22px;border-radius:14px;background:#1e293b}.c b{display:block;font-size:30px;color:#fff}
.bars{display:flex;align-items:flex-end;gap:14px;height:220px;padding:0 40px}.bars i{flex:1;border-radius:8px 8px 0 0;background:#38bdf8}
</style></head><body><header><h1>Q3 revenue</h1><p>Updated <span id=t>today</span></p></header>
<div class=k><div class=c>Revenue<b>$4.2M</b>+18% vs Q2</div><div class=c>New customers<b>312</b>+9%</div><div class=c>Churn<b>1.4%</b>-0.3 pt</div></div>
<div class=bars><i style="height:40%"></i><i style="height:55%"></i><i style="height:48%"></i><i style="height:70%"></i><i style="height:82%"></i><i style="height:94%"></i></div>
<script>document.getElementById('t').textContent=new Date().toDateString()</script></body></html>"""),
    "pricing": ("Pricing page draft", """<!doctype html><html><head><title>Pricing</title><style>
body{margin:0;font:16px/1.5 Georgia,serif;background:#fffbeb;color:#292524;text-align:center}h1{font-size:44px;margin:48px 0 8px}
.p{display:flex;gap:24px;justify-content:center;padding:32px}.t{width:260px;padding:28px;border:2px solid #f59e0b;border-radius:18px;background:#fff}
.t b{font-size:40px;display:block}</style></head><body><h1>Simple pricing</h1><p>Start free. Upgrade when your team grows.</p>
<div class=p><div class=t>Free<b>$0</b>For one person</div><div class=t>Team<b>$12</b>Per member a month</div><div class=t>Business<b>$24</b>SSO and audit log</div></div></body></html>"""),
    "status": ("Status page", """<!doctype html><html><head><title>Acme status</title><style>
body{margin:0;font:15px/1.5 -apple-system,sans-serif;background:#f8fafc;color:#0f172a}main{max-width:900px;margin:40px auto}
.ok{padding:22px 26px;border-radius:12px;background:#16a34a;color:#fff;font-size:22px;font-weight:600}
li{display:flex;justify-content:space-between;padding:16px 4px;border-bottom:1px solid #e2e8f0}li span{color:#16a34a}</style></head>
<body><main><h1>Acme status</h1><div class=ok>All systems operational</div><ul style="list-style:none;padding:0">
<li>API <span>Operational</span></li><li>Dashboard <span>Operational</span></li><li>Webhooks <span>Operational</span></li></ul></main></body></html>"""),
    "release": ("Release notes 4.2", """<!doctype html><html><head><title>Release 4.2</title><style>
body{margin:0;font:15px/1.6 ui-sans-serif,system-ui;background:#fff;color:#111}article{max-width:780px;margin:48px auto}
.tag{display:inline-block;padding:2px 10px;border-radius:99px;background:#ede9fe;color:#6d28d9;font-weight:600}</style></head>
<body><article><span class=tag>New</span><h1>Release 4.2</h1><p>Faster search, offline drafts and <b>a new export</b>.</p>
<h2>Highlights</h2><ul><li>Search results in under 100 ms</li><li>Drafts save without a connection</li><li>Export to PDF and Word</li></ul></article></body></html>"""),
}
for k, (title, html) in HTML.items():
    upload_bytes(k, title, f"{k}.html", html.encode(), "text/html")

gpage("page", "Launch checklist", "---\nicon: 🚀\ncover: gallery:ascent\n---\nEverything we need before the public launch on the 14th.\n\n"
      "## This week\n\n- [x] Freeze the pricing page\n- [x] Final copy review\n- [ ] Load test the API\n- [ ] Brief the support team\n\n"
      "## Owners\n\n1. Ada: launch post\n2. Ben: status page\n3. Wes: on-call rota\n")
gpage("page2", "Design principles", "---\nicon: 🎨\ncover: gallery:bubbles\n---\n> Clarity over cleverness.\n\n"
      "We design for the person in a hurry. Every screen answers one question.\n\n- One primary action per screen\n- Words before icons\n- Motion only when it explains\n")
gpage("page3", "Weekly notes", "---\nicon: 📝\n---\n## Monday sync\n\nShipped the new onboarding. Activation is up 6% week on week.\n\n"
      "- Hiring: two offers out\n- Infra: Postgres upgrade on Thursday\n- Next: pricing experiment\n")
gdoc("md", "API rate limits", "# API rate limits\n\nEvery key gets **600 requests a minute**. Bursts above that get a `429` with `Retry-After`.\n\n"
     "```bash\ncurl -H \"Authorization: Bearer $KEY\" \\\n  https://api.acme.com/v1/usage\n```\n\n| Plan | Per minute |\n| --- | --- |\n| Free | 60 |\n| Team | 600 |\n")
gdoc("md2", "Onboarding guide", "# Onboarding guide\n\nWelcome to the team! This guide walks you through your first week.\n\n## Day one\n\n"
     "- Get your laptop from IT\n- Join #general and #eng\n- Set up 2FA\n\n## Day two\n\nPair with your buddy on a small fix and ship it.\n")
gdoc("pw", "Board memo (password)", "# Board memo\n\nConfidential numbers for the board.\n", access="link", read_password="hunter22")
gdoc("enc", None, "mdx2.c2FsdHNhbHRzYWx0c2FsdA.Y2lwaGVydGV4dGNpcGhlcnRleHQ", encrypted=True)
gdoc("private", "Ada's private draft", "# Not for you\n\nOnly Ada can read this.\n", access="private")
upload_bytes("pdf", "Q3 board deck", "q3-board-deck.pdf", (FIX / "q3-board-deck-v1.pdf").read_bytes(), "application/pdf")
upload_bytes("photo", "Team offsite", "team-photo.png", (FIX / "team-photo.png").read_bytes(), "image/png")
upload_bytes("arch", "Architecture", "architecture.png", (FIX / "acme-architecture.png").read_bytes(), "image/png")
upload_bytes("video", "Product demo", "product-demo.mp4", (FIX / "product-demo-v1.mp4").read_bytes(), "video/mp4")
upload_bytes("csv", "Pipeline by region", "pipeline.csv",
             b"Region,Deals,Value,Win rate\nNorth America,42,$1.2M,31%\nEurope,35,$880K,28%\nAsia Pacific,21,$610K,24%\nLatin America,9,$140K,19%\n", "text/csv")


def _xlsx(rows):
    S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    strings, xr = [], []
    for r, row in enumerate(rows, 1):
        cells = []
        for c, v in enumerate(row):
            ref = f"{chr(65 + c)}{r}"
            if isinstance(v, (int, float)):
                cells.append(f'<c r="{ref}"><v>{v}</v></c>')
            else:
                strings.append(v)
                cells.append(f'<c r="{ref}" t="s"><v>{len(strings) - 1}</v></c>')
        xr.append(f'<row r="{r}">{"".join(cells)}</row>')
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        z.writestr("xl/workbook.xml", f'<workbook xmlns="{S}" xmlns:r="{R}"><sheets><sheet name="Plan" sheetId="1" r:id="rId1"/></sheets></workbook>')
        z.writestr("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="x"/></Relationships>')
        z.writestr("xl/worksheets/sheet1.xml", f'<worksheet xmlns="{S}"><sheetData>{"".join(xr)}</sheetData></worksheet>')
        z.writestr("xl/sharedStrings.xml", f'<sst xmlns="{S}">{"".join(f"<si><t>{x}</t></si>" for x in strings)}</sst>')
    return b.getvalue()


upload_bytes("xlsx", "Hiring plan", "hiring-plan.xlsx", _xlsx([
    ["Team", "Role", "Q1", "Q2", "Owner"], ["Engineering", "Backend", 2, 3, "Wes"], ["Engineering", "Frontend", 1, 2, "Wes"],
    ["Design", "Product designer", 1, 1, "Ada"], ["Sales", "Account exec", 3, 4, "Ben"], ["Support", "Lead", 1, 0, "Ben"]]),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
upload_bytes("json", "Feature flags", "feature-flags.json",
             json.dumps({"search_v2": {"enabled": True, "rollout": 0.5}, "offline_drafts": {"enabled": False}, "export_word": {"enabled": True}}).encode(),
             "application/json")


def _docx(paras):
    W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    body = "".join(f'<w:p>{f"<w:pPr><w:pStyle w:val=\"{st}\"/></w:pPr>" if st else ""}<w:r><w:t>{t}</w:t></w:r></w:p>' for st, t in paras)
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        z.writestr("word/document.xml", f'<w:document xmlns:w="{W}"><w:body>{body}</w:body></w:document>')
    return b.getvalue()


upload_bytes("docx", "Employee handbook", "handbook.docx", _docx([
    ("Title", "Employee handbook"), ("", "This handbook explains how we work, what we expect from each other and what you can expect from us."),
    ("Heading1", "Time off"), ("", "Take the time you need. Tell your team a week ahead for anything longer than three days."),
    ("ListParagraph", "Public holidays where you live"), ("ListParagraph", "Two wellness days a quarter")]),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document")

# Newest first, in a mix that shows every kind on the first screen.
order = ["dash", "page", "pdf", "md", "photo", "csv", "video", "page2", "pricing", "docx", "xlsx", "enc", "md2", "arch",
         "status", "json", "page3", "release", "pw", "private"]
for i, k in enumerate(order):
    DB["documents"].update_one({"slug": G[k]}, {"$set": {"updated_at": (now - timedelta(minutes=2 + i)).replace(tzinfo=None)}})
DB["documents"].update_one({"slug": G["enc"]}, {"$set": {"title": None}})

out = {"ws": ws, "folders": {**folders, "Gallery": gallery}, "nested": nested, "items": len(made), "gallery": G,
       "users": {"owner": ada, "member": ben, "admin": wes, "reader": vic, "stranger": cy}}
(OUT / "seed-listing.json").write_text(json.dumps(out, indent=1))
print(json.dumps({"ws": ws, "items": len(made), "folders": len(folders) + len(nested)}))
