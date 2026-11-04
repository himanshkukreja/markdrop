"""A realistic, busy workspace for the app rail's tree (workspace › folders › pages › sub-pages,
files): the sidebar navigation audit's world. Standalone: it wipes its own db and seeds through the
sandbox API it is pointed at.

    STACK_ID=7 python run_api.py            # the sandbox API (scripts/docs-media/stack): :8250, db _7
    PB_API=http://127.0.0.1:8250 PB_DB=markdrop_docs_demo_7 python seed_nav.py

Ada owns "Acme" (5 top-level folders, nested 3 deep, ~40 pages with emoji icons and sub-pages 3
levels down, files and Markdown documents among them, an empty folder, a very long folder name and
page title), "Senseloaf" (two folders) and "Lab" (empty). Writes seed-nav.json to $PB_STACK (or
the current folder).
"""
import json
import os
import sys
from pathlib import Path

import httpx
from pymongo import MongoClient

API = os.environ.get("PB_API", "http://127.0.0.1:8250")
DB_NAME = os.environ.get("PB_DB", "markdrop_docs_demo_7")
assert DB_NAME.startswith("markdrop_docs_demo"), "seed_nav only writes to a sandbox db"
OUT = Path(os.environ.get("PB_STACK") or ".")
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


# A 1×1 PNG and a tiny HTML page (no fixtures needed).
PNG = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                    "1f15c4890000000d49444154789c6360f8cfc0f01f0005000201e2b2"
                    "cf6f0000000049454e44ae426082")
HTML = b"<!doctype html><meta charset=utf-8><title>Calc</title><h1>Calculator</h1>"


def upload(token, data, filename, mime, title, ws, folder):
    u = call("POST", "/api/v1/artifacts/upload-url", token,
             json={"filename": filename, "content_type": mime, "size_bytes": len(data)})
    httpx.put(u["upload_url"], content=data, headers={"Content-Type": u["required_content_type"]}, timeout=60).raise_for_status()
    return call("POST", "/api/v1/artifacts", token,
                json={"blob_key": u["blob_key"], "title": title, "filename": filename,
                      "workspace": ws, "folder": folder, "access_level": "workspace"})


for c in DB.list_collection_names():
    DB[c].drop()

ada = call("POST", "/__sandbox/user", json={"email": "ada@acme.test", "name": "Ada Owner"})
ben = call("POST", "/__sandbox/user", json={"email": "ben@acme.test", "name": "Ben Member"})
T = ada["token"]


def workspace(name):
    return call("POST", "/api/v1/workspaces", T, json={"name": name})["id"]


def folder(ws, name, parent=None):
    return call("POST", f"/api/v1/workspaces/{ws}/folders", T, json={"name": name, "parent_id": parent})["id"]


def page(title, *, ws=None, folder_id=None, parent=None, icon=None, body="Notes."):
    content = (f"---\nicon: {icon}\n---\n\n" if icon else "") + f"# {title}\n\n{body}\n"
    payload = {"title": title, "content": content}
    if parent:
        payload["parent"] = parent
    else:
        payload["workspace"] = ws
        if folder_id:
            payload["folder"] = folder_id
    return call("POST", "/api/v1/pages", T, json=payload)["document"]["slug"]


def doc(title, ws, folder_id):
    return call("POST", "/api/v1/documents", T, json={
        "title": title, "content": f"# {title}\n\nA Markdown document.\n", "expires_in": "never",
        "workspace": ws, "folder": folder_id, "access_level": "workspace"})["slug"]


acme = workspace("Acme")
DB["memberships"].insert_one({"workspace_id": acme, "user_id": ben["id"], "role": "member",
                              "email": ben["email"], "name": ben["name"]})
eng = folder(acme, "Engineering")
backend = folder(acme, "Backend", eng)
api_f = folder(acme, "API", backend)
infra = folder(acme, "Infrastructure", backend)
frontend = folder(acme, "Frontend", eng)
mkt = folder(acme, "Marketing")
camp = folder(acme, "Campaigns", mkt)
c26 = folder(acme, "2026", camp)
design = folder(acme, "Design")
handbook = folder(acme, "Handbook")
archive = folder(acme, "Archive")  # stays empty
long_f = folder(acme, "Customer research interviews and synthesis notes, Q3 to Q4")

# Engineering: pages with sub-pages three levels deep.
arch = page("Architecture overview", ws=acme, folder_id=eng, icon="🏗️")
svc = page("Services", parent=arch, icon="🧩")
for n, ic in (("Auth service", "🔐"), ("Billing service", "💳"), ("Search service", "🔎")):
    s = page(n, parent=svc, icon=ic)
    page("Runbook", parent=s)
page("Data model", parent=arch, icon="🗂️")
page("Decisions log", parent=arch)
page("On-call rotation", ws=acme, folder_id=eng, icon="📟")
page("Engineering onboarding checklist for new hires joining the platform team", ws=acme, folder_id=eng, icon="✅")
rfc = page("RFCs", ws=acme, folder_id=eng, icon="📝")
for i in range(1, 7):
    page(f"RFC-{i:03d}: proposal {i}", parent=rfc)
page("Rate limiting", ws=acme, folder_id=api_f, icon="🚦")
page("Versioning policy", ws=acme, folder_id=api_f)
page("Terraform layout", ws=acme, folder_id=infra, icon="🌍")
page("Component library", ws=acme, folder_id=frontend, icon="🎨")
doc("Changelog (Markdown)", acme, eng)
upload(T, HTML, "calc.html", "text/html", "Latency calculator", acme, backend)
upload(T, PNG, "diagram.png", "image/png", "System diagram", acme, eng)

# Marketing
launch = page("Launch plan", ws=acme, folder_id=mkt, icon="🚀")
page("Press kit", parent=launch, icon="📰")
page("Social posts", parent=launch)
page("Brand voice", ws=acme, folder_id=mkt, icon="🗣️")
page("Spring campaign", ws=acme, folder_id=c26, icon="🌸")
page("Q3 webinar", ws=acme, folder_id=camp)
upload(T, PNG, "banner.png", "image/png", "Hero banner", acme, c26)

# Design, Handbook
page("Design principles", ws=acme, folder_id=design, icon="✨")
page("Icon grid", ws=acme, folder_id=design)
upload(T, PNG, "logo.png", "image/png", "Logo", acme, design)
hb = page("Employee handbook", ws=acme, folder_id=handbook, icon="📘")
for n in ("Benefits", "Time off", "Expenses", "Equipment", "Security basics"):
    page(n, parent=hb)
page("Interview 01 — Northwind", ws=acme, folder_id=long_f)

# Top of the workspace
page("Team home", ws=acme, icon="🏠")
page("Weekly sync notes", ws=acme, icon="🗓️")
page("Untitled ideas", ws=acme)
doc("Read me", acme, None)

sense = workspace("Senseloaf")
s1 = folder(sense, "Product")
folder(sense, "Sales")
page("Roadmap", ws=sense, folder_id=s1, icon="🗺️")
workspace("Lab")

out = {"users": {"owner": ada, "member": ben}, "ws": acme, "senseloaf": sense,
       "folders": {"eng": eng, "backend": backend, "api": api_f, "infra": infra, "frontend": frontend,
                   "mkt": mkt, "camp": camp, "c26": c26, "design": design, "handbook": handbook,
                   "archive": archive, "long": long_f},
       "pages": {"arch": arch, "svc": svc, "rfc": rfc, "launch": launch, "handbook": hb}}
(OUT / "seed-nav.json").write_text(json.dumps(out, indent=1))
print(json.dumps({"ws": acme, "pages": out["pages"]}))
