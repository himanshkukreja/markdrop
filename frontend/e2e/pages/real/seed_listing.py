"""A busy second workspace for the workspace listing (fix/ws-listing): owners on rows, the List / Grid /
Cards switch and the folder-click timing. Run AFTER seed.py (it reuses seed.json's people and adds to
the same db; it never wipes):

    STACK_ID=12 DOCS_MEDIA_DATA=… PB_STACK=… python seed_listing.py

"Senseloaf" (Ada owns it; Ben and Wes edit, Vic views, Cy is an outsider): 12 top-level folders,
nested three deep, ~180 items by three owners (pages, Markdown documents, files), a few private
ones, realistic Markdown bodies (~6 KB) and spread-out update times. Writes seed-listing.json to
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

out = {"ws": ws, "folders": folders, "nested": nested, "items": len(made),
       "users": {"owner": ada, "member": ben, "admin": wes, "reader": vic, "stranger": cy}}
(OUT / "seed-listing.json").write_text(json.dumps(out, indent=1))
print(json.dumps({"ws": ws, "items": len(made), "folders": len(folders) + len(nested)}))
