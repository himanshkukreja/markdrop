"""One workspace item of every kind, for the open-from-the-listing check (open.mjs, fix/open-flash). Run
AFTER seed.py (it reuses seed.json's people and adds to the same db; it never wipes):

    STACK_ID=23 PB_STACK=… PB_FIXTURES=… python seed_open.py

"Openers" (Ada owns it; Ben is a member): a page, a classic Markdown document, and files (HTML, PDF,
CSV sheet, MP4 video), all "workspace" access and filed at the top. Writes seed-open.json to $PB_STACK.
"""
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import httpx
from pymongo import MongoClient

WT = Path(__file__).resolve().parents[4]
ROOT = Path(str(WT).split("/.claude/worktrees/")[0])
STACK_ID = int(os.environ.get("STACK_ID", "5"))
API = f"http://127.0.0.1:{8180 + 10 * STACK_ID}"
DB_NAME = f"markdrop_docs_demo_{STACK_ID}"
OUT = Path(os.environ.get("PB_STACK") or ".")
FIX = Path(os.environ.get("PB_FIXTURES") or ROOT / "frontend" / "scripts" / "docs-media" / ".data" / "fixtures")
DB = MongoClient("mongodb://127.0.0.1:27019")[DB_NAME]
http = httpx.Client(base_url=API, timeout=60)


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
ada, ben = U["owner"], U["member"]
ws = call("POST", "/api/v1/workspaces", ada["token"], json={"name": "Openers"})["id"]
DB["memberships"].insert_one({"workspace_id": ws, "user_id": ben["id"], "role": "member",
                              "created_at": datetime.now(timezone.utc), "email": ben["email"], "name": ben["name"]})
filing = {"workspace": ws, "access_level": "workspace"}
BODY = "\n\n".join(f"## Part {i}\n\n" + "Everything we agreed, written down so nobody has to ask twice. " * 8 for i in range(1, 7))


def upload(data, filename, mime, title, slug):
    u = call("POST", "/api/v1/artifacts/upload-url", ada["token"],
             json={"filename": filename, "content_type": mime, "size_bytes": len(data)})
    httpx.put(u["upload_url"], content=data, headers={"Content-Type": u["required_content_type"]}, timeout=60).raise_for_status()
    return call("POST", "/api/v1/artifacts", ada["token"],
                json={"blob_key": u["blob_key"], "title": title, "filename": filename, "custom_slug": slug, **filing})["slug"]


items = {}
items["page"] = call("POST", "/api/v1/pages", ada["token"], json={
    "title": "Open flash page", "content": f"# Open flash page\n\n{BODY}\n", "workspace": ws})["document"]["slug"]
items["doc"] = call("POST", "/api/v1/documents", ada["token"], json={
    "title": "Open flash doc", "custom_slug": "open-flash-doc", "expires_in": "never", **filing,
    "content": f"# Open flash doc\n\n{BODY}\n"})["slug"]
HTML = b"""<!doctype html><meta charset="utf-8"><title>Open flash html</title><style>body{font:15px system-ui;margin:0;padding:24px}</style><h2>Open flash html</h2><p>An HTML artifact.</p>"""
items["html"] = upload(HTML, "flash.html", "text/html", "Open flash html", "open-flash-html")
items["pdf"] = upload((FIX / "q3-board-deck-v1.pdf").read_bytes(), "flash.pdf", "application/pdf", "Open flash pdf", "open-flash-pdf")
CSV = "\n".join(["Region,Q1,Q2,Q3"] + [f"Region {i},{i * 10},{i * 12},{i * 15}" for i in range(1, 40)]).encode()
items["sheet"] = upload(CSV, "flash.csv", "text/csv", "Open flash sheet", "open-flash-sheet")
items["video"] = upload((FIX / "product-demo-v1.mp4").read_bytes(), "flash.mp4", "video/mp4", "Open flash video", "open-flash-video")

out = {"ws": ws, "items": items, "users": {"owner": ada, "member": ben}}
(OUT / "seed-open.json").write_text(json.dumps(out, indent=1))
print(json.dumps(out["items"]))
