"""Seed the page builder's real-stack world (db markdrop_docs_demo_5) through the sandbox API.

People: Ada Owner (workspace owner), Ben Member (member), Cy Stranger (signed in, not a member),
Wes Admin (admin). Acme workspace with a Guides folder holding three files (an image, a PDF and an
HTML page) and a Markdown document, all "workspace" access; a public classic document owned by Ben;
the custom domain acme.localhost (verified, live). Writes seed.json to $PB_STACK.
"""
import json
import os
import sys
from pathlib import Path

import httpx
from pymongo import MongoClient

WT = Path(__file__).resolve().parents[4]
ROOT = Path(str(WT).split("/.claude/worktrees/")[0])  # the main checkout (fixtures, .work)
OUT = Path(os.environ.get("PB_STACK") or ROOT / ".work" / "page-builder" / "stack")
API = "http://127.0.0.1:8230"
# The docs media's rendered demo files (git-ignored; `npm run docs:media` makes them).
FIX = Path(os.environ.get("PB_FIXTURES") or ROOT / "frontend" / "scripts" / "docs-media" / ".data" / "fixtures")
DB = MongoClient("mongodb://127.0.0.1:27019")["markdrop_docs_demo_5"]
http = httpx.Client(base_url=API, timeout=60)


def call(method, path, token=None, **kw):
    headers = kw.pop("headers", {})
    if token:
        headers["Authorization"] = f"Bearer {token}"
    r = http.request(method, path, headers=headers, **kw)
    if r.status_code >= 400:
        sys.exit(f"{method} {path} → {r.status_code}: {r.text[:400]}")
    return r.json() if r.content else None


def upload(token, data, filename, mime, title, slug, **filing):
    u = call("POST", "/api/v1/artifacts/upload-url", token,
             json={"filename": filename, "content_type": mime, "size_bytes": len(data)})
    httpx.put(u["upload_url"], content=data, headers={"Content-Type": u["required_content_type"]}, timeout=60).raise_for_status()
    return call("POST", "/api/v1/artifacts", token,
                json={"blob_key": u["blob_key"], "title": title, "filename": filename, "custom_slug": slug, **filing})


for c in DB.list_collection_names():
    DB[c].drop()

people = {"owner": ("ada@acme.test", "Ada Owner"), "member": ("ben@acme.test", "Ben Member"),
          "stranger": ("cy@else.test", "Cy Stranger"), "admin": ("wes@acme.test", "Wes Admin")}
users = {k: call("POST", "/__sandbox/user", json={"email": e, "name": n}) for k, (e, n) in people.items()}
ada = users["owner"]["token"]
ws = call("POST", "/api/v1/workspaces", ada, json={"name": "Acme"})
ws_id = ws["id"]
from datetime import datetime, timezone  # noqa: E402

now = datetime.now(timezone.utc)
for key, role in (("member", "member"), ("admin", "admin")):
    u = users[key]
    DB["memberships"].insert_one({"workspace_id": ws_id, "user_id": u["id"], "role": role, "created_at": now,
                                  "email": u["email"], "name": u["name"]})
folder = call("POST", f"/api/v1/workspaces/{ws_id}/folders", ada, json={"name": "Guides"})
filing = {"workspace": ws_id, "folder": folder["id"], "access_level": "workspace"}

pdf = (FIX / "q3-board-deck-v1.pdf").read_bytes()
png = (FIX / "team-photo.png").read_bytes()
HTML = b"""<!doctype html><meta charset="utf-8"><title>Pricing calculator</title><style>body{font:15px system-ui;margin:0;padding:24px;background:#fff;color:#111}h2{margin:0 0 12px}label{display:block;margin:10px 0 4px}input{font:inherit;padding:6px 8px;width:120px}.t{margin-top:16px;font-size:28px;font-weight:700;color:#2150d8}</style><h2>Pricing calculator</h2><label>Seats <input id=s type=number value=12></label><label>Price per seat ($) <input id=p type=number value=9></label><div class=t id=t></div><script>const f=()=>t.textContent='$'+(s.value*p.value).toLocaleString()+' / month';s.oninput=p.oninput=f;f()</script>"""
upload(ada, png, "team-photo.png", "image/png", "Team offsite photo", "team-photo", **filing)
upload(ada, pdf, "q3-report.pdf", "application/pdf", "Q3 report", "q3-report", **filing)
upload(ada, HTML, "pricing.html", "text/html", "Pricing calculator", "pricing-calc", **filing)
call("POST", "/api/v1/documents", ada, json={
    "title": "Launch plan", "custom_slug": "launch-plan", "expires_in": "never", **filing,
    "content": "# Launch plan\n\nWe ship the page builder on November 10. Owners: Ada (frontend), Ben (backend). Rollout in three waves, starting with the Acme workspace.\n"})
CLASSIC = "# Handbook\n\nHow we work: write things down, ship small, and keep the customer in the room.\n\n## Principles\n\n- Write it down\n- Ship small\n\n| a | b |\n|---|:-:|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n\n> A quote with *emphasis*.\n"
call("POST", "/api/v1/documents", users["member"]["token"], json={
    "title": "Public handbook", "custom_slug": "public-handbook", "expires_in": "never", "content": CLASSIC})
# The sandbox route refuses *.localhost (reserved), so the verified row goes in directly.
dom = call("POST", "/__sandbox/domain", json={"workspace_id": ws_id, "host": "docs.acme.com", "primary": True})
DB["domains"].insert_one({"host": "acme.localhost", "workspace_id": ws_id, "kind": "app", "status": "verified",
                          "verification_token": "markdrop-verify=local", "created_at": now, "verified_at": now,
                          "last_checked_at": now, "attached": True, "attached_via": "dns", "is_primary": False,
                          "txt_ok": True, "routing_ok": True, "failures": 0, "first_failed_at": None, "last_error": None})

out = {"users": users, "ws": ws_id, "folder": folder["id"], "folder_slug": folder.get("slug"), "domain": dom}
(OUT / "seed.json").write_text(json.dumps(out, indent=1))
print(json.dumps({"ws": ws_id, "folder": folder, "domain": dom}, indent=1)[:800])
