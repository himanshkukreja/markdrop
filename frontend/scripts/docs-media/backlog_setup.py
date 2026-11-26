#!/usr/bin/env python3
"""Docs media: a Sales team backlog (/teams/backlog) in the docs-media stack (stack/stack.sh start; seed.py first).

Runs the REAL app in this process against the stack's database, with a fake model (the meetings' notes and the
backlog's sorting), so the calls land exactly as they would in production: Sales (Riya lead, Alex member), three
calls (Northwind renewal, Globex intro, Q4 pipeline review, plus an older Initech check-in) with action items and customer asks, each given a
priority, then a "Weekly prioritization" call whose decisions change some of them (and one it couldn't match), and
the team's "Sales — Backlog" page sorted into categories, most urgent first. Writes the page's slug and the meetings' slugs to
.data/<N>/backlog.json for the shots (shots/q-backlog.mjs).

    STACK_ID=9 backend/.venv/bin/python frontend/scripts/docs-media/backlog_setup.py
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace as NS

HERE = Path(__file__).resolve().parent
STACK_ID = int(os.environ.get("STACK_ID", "0") or 0)
DATA = HERE / ".data" / (str(STACK_ID) if STACK_ID else "")
API = f"http://127.0.0.1:{8180 + 10 * STACK_ID}"

for key in [k for k in os.environ if k.startswith("MARKDROP_")]:
    del os.environ[key]
for line in (HERE / "stack" / ".env").read_text().splitlines():
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        v = v.strip()
        os.environ[k.strip()] = v[1:-1] if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"" else v
os.environ["MARKDROP_MONGODB_DB"] = f"markdrop_docs_demo_{STACK_ID}" if STACK_ID else "markdrop_docs_demo"
os.environ["MARKDROP_ANTHROPIC_API_KEY"] = "sk-docs-media-fake"
os.chdir(HERE / "stack")
sys.path.insert(0, str(HERE.parents[2] / "backend"))

import httpx  # noqa: E402

from app.config import get_settings  # noqa: E402

settings = get_settings()
assert settings.mongodb_db.startswith("markdrop_docs_demo"), settings.mongodb_db

DAY = lambda n: (date.today() - timedelta(days=n)).isoformat()  # noqa: E731

CALLS = {
    "Northwind renewal call": {
        "date": DAY(6), "guest": ("Grace Liu", "grace@northwind.com"),
        "lines": ["Riya Sharma: Thanks for making time, Grace.", "Grace Liu: Our analysts want usage reports they can open in Excel.",
                  "Grace Liu: And SSO login fails on Safari for a few of us.", "Alex Chen: I will send the renewal pricing deck this week.",
                  "Riya Sharma: I'll book the security review with your IT team."],
        "actions": [("Send the renewal pricing deck", "Alex Chen", "Friday"), ("Book the security review with their IT team", "Riya Sharma", None)],
        "asks": [("Export usage reports to CSV", "feature", "s2"), ("SSO login fails on Safari", "bug", "s3"),
                 ("Bulk-edit permissions on folders", "improvement", None)],
    },
    "Globex intro call": {
        "date": DAY(3), "guest": ("Omar Haddad", "omar@globex.com"),
        "lines": ["Omar Haddad: We need the reports as CSV files for finance.", "Omar Haddad: Do you have a Salesforce integration for deal notes?",
                  "Omar Haddad: Does the API support webhooks?", "Alex Chen: I will share two customer references.",
                  "Riya Sharma: I'll draft the pilot proposal."],
        "actions": [("Share two customer references", "Alex Chen", None), ("Draft the pilot proposal", "Riya Sharma", "next week")],
        "asks": [("Export reports as CSV files", "feature", "s1"), ("Salesforce integration for deal notes", "feature", "s2"),
                 ("Does the API support webhooks?", "question", "s3")],
    },
    "Initech check-in": {
        "date": DAY(48), "guest": ("Peter Gibbons", "peter@initech.com"),
        "lines": ["Peter Gibbons: We need an audit log we can export for compliance.",
                  "Peter Gibbons: Search is slow on our big workspace.", "Alex Chen: I will send the security whitepaper."],
        "actions": [("Send the security whitepaper", "Alex Chen", None)],
        "asks": [("Export the audit log", "feature", "s1"), ("Search is slow on large workspaces", "bug", "s2")],
    },
    "Q4 pipeline review": {
        "date": DAY(1), "guest": None,
        "lines": ["Riya Sharma: Let's go through the pipeline.", "Alex Chen: I will update the forecast sheet.",
                  "Riya Sharma: Dark mode for the reports keeps coming up."],
        "actions": [("Update the forecast sheet", "Alex Chen", None)],
        "asks": [("Dark mode for reports", "improvement", "s3")],
    },
    "Weekly prioritization": {
        "date": DAY(0), "guest": None,
        "lines": ["Riya Sharma: Safari login is blocking Northwind, that's our top priority.",
                  "Riya Sharma: The Salesforce integration is a P1 for the Globex pilot.",
                  "Alex Chen: Dark mode can wait, let's drop it for now.", "Alex Chen: And the onboarding thing can wait too."],
        "actions": [], "asks": [],
        "said": [{"about": "Safari login bug", "priority": "urgent", "speaker": "Riya Sharma",
                  "quote": "Safari login is blocking Northwind, that's our top priority"},
                 {"about": "Salesforce integration", "priority": "high", "speaker": "Riya Sharma",
                  "quote": "The Salesforce integration is a P1 for the Globex pilot"},
                 {"about": "Dark mode", "priority": "wont_do", "speaker": "Alex Chen", "quote": "Dark mode can wait, let's drop it"},
                 {"about": "the onboarding thing", "priority": "low", "speaker": "Alex Chen", "quote": "the onboarding thing can wait"}],
    },
}
#: The (fake) model's priority for each item, with its reason.
PRIO = {
    "Send the renewal pricing deck": ("high", "Due Friday for the Northwind renewal"),
    "Export usage reports to CSV": ("high", "Asked by Northwind and Globex"),
    "Export reports as CSV files": ("high", "Asked again by Globex"),
    "SSO login fails on Safari": ("high", "Customers can't log in"),
    "Bulk-edit permissions on folders": ("low", "Nice to have"),
    "Draft the pilot proposal": ("urgent", "Due next week for the Globex pilot"),
    "Does the API support webhooks?": ("low", "No deadline"),
    "Dark mode for reports": ("low", "Keeps coming up, no customer waiting"),
    "Search is slow on large workspaces": ("high", "Initech hits it daily"),
}


def _cat(text: str) -> str:
    t = text.lower()
    return "follow_up" if any(w in t for w in ("pricing", "references", "proposal", "send", "share")) else "task"


def script(params: dict) -> str:
    system = params["system"][0]["text"] if isinstance(params.get("system"), list) else str(params.get("system") or "")
    user = "\n".join(b.get("text", "") for b in params["messages"][-1]["content"] if isinstance(b, dict))
    title = (re.search(r"Title: ([^\n]+)", user) or [None, ""])[1].strip()
    call = CALLS.get(title)
    if system.startswith("You write the team's notes") and call:
        return json.dumps({"summary": f"{title}.", "highlights": [], "decisions": [], "open_questions": [], "topics": [],
                           "action_items": [{"text": t, "owner": o, "due": d, "cite": None} for t, o, d in call["actions"]],
                           "type": "Customer" if call["guest"] else "Review"})
    if system.startswith("You keep a team's backlog") and call:
        acts = re.findall(r"^(A\d+): (.+)$", user, re.M)

        def pr(t: str) -> dict:
            p, why = PRIO.get(re.sub(r" · due .*$", "", t), ("medium", None))
            return {"priority": p, "why": why}

        return json.dumps({"actions": [{"id": i, "category": _cat(t), **pr(t)} for i, t in acts],
                           "asks": [{"text": t, "category": c, "cite": s, **pr(t)} for t, c, s in call["asks"]],
                           "priorities": call.get("said") or []})
    if system.startswith("You match priority decisions"):
        items = dict(re.findall(r"^(E\d+): (.+)$", user, re.M))
        out = []
        for sid, about, cands in re.findall(r"^(S\d+): (.+?) → .*\n\s+could be: (.+)$", user, re.M):
            key = {"Safari login bug": "safari", "Salesforce integration": "salesforce", "Dark mode": "dark mode"}.get(about)
            hit = next((e for e in [c.strip() for c in cands.split(",")] if key and key in items[e].lower()), None)
            if hit:
                out.append({"decision": sid, "item": hit, "confidence": 0.94})
        return json.dumps({"matches": out})
    if system.startswith("You match new backlog items"):
        existing = dict(re.findall(r"^(E\d+): (.+)$", user, re.M))
        same = []
        for n, text in re.findall(r"^(N\d+): (.+)$", user, re.M):
            e = next((k for k, v in existing.items() if "csv" in text and "csv" in v), None)
            if e:
                same.append({"new": n, "existing": e})
        return json.dumps({"same": same})
    return "{}"


class _Stream:
    def __init__(self, text: str):
        self.text = text

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    def __aiter__(self):
        async def gen():
            yield NS(type="text", text=self.text)
        return gen()

    async def get_final_message(self):
        return NS(content=[NS(type="text", text=self.text)], stop_reason="end_turn",
                  usage=NS(input_tokens=500, output_tokens=200, cache_creation_input_tokens=0, cache_read_input_tokens=0))


class _Messages:
    def stream(self, **params):
        return _Stream(script(params))

    async def create(self, **params):
        return await _Stream(script(params)).get_final_message()


FAKE = NS(messages=_Messages())


async def main() -> None:
    from app.database import connect, get_database
    from app.main import app
    from app.services import ai_usage, docs_agent, meetings, team_backlog as TB, todo_pages as TP
    from bson import ObjectId

    docs_agent.get_client = lambda: FAKE
    settings.meetings_ai_enabled = settings.team_backlog_enabled = True
    ai_usage.invalidate_settings()
    from app.limiter import limiter

    limiter.enabled = False
    await connect()
    db = get_database()
    await TB.ensure_indexes(db)
    fx = json.loads((DATA / "fixtures.json").read_text())
    ws = fx["workspace"]["id"]
    riya, alex = fx["users"]["riya"]["id"], fx["users"]["alex"]["id"]
    async with httpx.AsyncClient(timeout=30) as sb:
        token = (await sb.post(f"{API}/__sandbox/mint", json={"user_id": riya})).json()["token"]
    H = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", timeout=120) as http:
        base = f"/api/v1/workspaces/{ws}"
        teams = (await http.get(f"{base}/teams", headers=H)).json()["teams"]
        sales = next((t for t in teams if t["name"] == "Sales"), None)
        if sales is None:
            r = await http.post(f"{base}/teams", headers=H, json={"name": "Sales", "visibility": "open", "icon": "💼", "color": "green",
                                                                  "lead_ids": [riya], "member_ids": [riya, alex]})
            assert r.status_code == 201, r.text
            sales = r.json()
        tid = sales["id"]
        out = {"team": tid, "meetings": {}}
        await db[TB.ITEMS].delete_many({"team_id": tid})       # a fresh run: priorities from the calls again
        await db["meetings"].update_many({"workspace_id": ws}, {"$unset": {"backlog_ai": "", "backlog_prio": ""}})
        for title, c in CALLS.items():
            have = await db["meetings"].find_one({"workspace_id": ws, "title": title})
            if have is None:
                r = await http.post("/api/v1/meetings/import", headers=H, json={
                    "workspace": ws, "wait": True, "title": title, "date": c["date"], "restricted": False, "team_ids": [tid],
                    "sources": [{"name": f"{title} - Transcript", "text": "\n".join(c["lines"])}]})
                assert r.status_code == 200, r.text
                have = await db["meetings"].find_one({"_id": ObjectId(r.json()["meetings"][0]["id"])})
            if c["guest"]:
                name, email = c["guest"]
                if not any(a.get("email") == email for a in have.get("attendees") or []):
                    await db["meetings"].update_one({"_id": have["_id"]}, {"$push": {"attendees": {"name": name, "email": email}}})
            out["meetings"][title] = have.get("slug") or (await db["documents"].find_one({"_id": have["doc_id"]}))["slug"]
        await TP.drain()
        await TB.drain()
        stats = await TB.sync_team(db, tid)
        await TB.drain()
        raw = await TB.page_of(db, tid)
        out["slug"] = raw["slug"]
        # Kept by the capture's cleanup (stack/run_api.py: documents without the seed's marker go before each shot).
        await db["documents"].update_many({"workspace_id": ws, "demo_seed": {"$ne": True}}, {"$set": {"demo_seed": True}})
        (DATA / "backlog.json").write_text(json.dumps(out, indent=2))
        print(f"Sales backlog: /{raw['slug']} · {stats.meetings} calls · "
              f"{await db[TB.ITEMS].count_documents({'team_id': tid})} items → {DATA / 'backlog.json'}")
    _ = meetings


if __name__ == "__main__":
    asyncio.run(main())
