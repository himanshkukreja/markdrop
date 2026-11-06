"""Jira on the Team board, in Ask and in MCP listings.

**Which issues.** Per workspace: assigned to one of its members (matched by their own Atlassian
connection, else by their Markdrop email: services/jira.member_accounts), in the projects the
workspace follows, updated in the last 30 days (``JQL``: ``assignee in (…) AND project in (…) AND
updated >= -30d``). Fetched on demand and cached for :data:`TTL` (5 minutes); the webhooks keep each
cached issue's status, assignee and due date fresh in between.

**Who sees what** (decided, owner brief 2026-11-06):

* A viewer whose own Atlassian account is connected and reaches the site sees issue details — but
  only issues that *their* connection returns for that JQL (asked as them, cached per viewer for
  5 minutes). An issue they couldn't open in Jira never reaches them.
* A viewer who isn't connected sees **counts only** (to do / in progress / done lately / overdue /
  blocked per person, from the site connector's sync), never a key, summary or link, and a prompt
  to connect. The counts cover only the projects an admin chose for the workspace.

Status categories: Jira's own (To do = "new", In progress = "indeterminate", Done = "done").
Overdue: a due date before today and not done. Blocked: a status whose name contains "block", a
"blocked" label, or the Flagged field when Jira returns it.
"""

from __future__ import annotations

import logging
import re
from datetime import date, datetime, timedelta
from typing import Any

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import access, jira, jira_api

log = logging.getLogger("markdrop.jira")

CACHE = "jira_ws_cache"
TTL = timedelta(minutes=5)
RESOLVED_DAYS = 14
TOP = 3
MAX_ISSUES = 300


def _jql(accounts: list[str], projects: list[str]) -> str:
    acc = ", ".join(f'"{a}"' for a in accounts)
    q = f"assignee in ({acc}) AND updated >= -30d"
    q += " AND project in (" + ", ".join(f'"{p}"' for p in projects) + ")"
    return q + " ORDER BY updated DESC"


def _today() -> date:
    return jira.now_utc().date()


def _overdue(it: dict, today: date) -> bool:
    if (it.get("status") or {}).get("category") == "done" or not it.get("due"):
        return False
    try:
        return date.fromisoformat(str(it["due"])[:10]) < today
    except ValueError:
        return False


def _recent_done(it: dict, today: date) -> bool:
    if (it.get("status") or {}).get("category") != "done":
        return False
    r = str(it.get("resolved") or it.get("updated") or "")[:10]
    try:
        return date.fromisoformat(r) >= today - timedelta(days=RESOLVED_DAYS)
    except ValueError:
        return False


async def _keys(db: AsyncIOMotorDatabase, cache_id: str, user_id: str, site: dict, jql: str, *,
                refresh: bool = False) -> list[str] | None:
    """The issue keys ``user_id``'s connection returns for ``jql`` (cached TTL under ``cache_id``)."""
    row = await db[CACHE].find_one({"_id": cache_id})
    fresh = jira.now_utc() - TTL
    if row is not None and not refresh and row.get("jql") == jql and (jira._aware(row.get("at")) or fresh) > fresh:
        return row.get("keys") or []
    try:
        found = await jira.search_as(db, user_id, site, jql, limit=MAX_ISSUES)
    except (jira_api.JiraError, jira.NotConnected) as exc:
        log.info("jira team: search as %s failed: %s", user_id, exc)
        return (row or {}).get("keys") if row is not None else None
    keys = [it["key"] for it in found]
    await db[CACHE].update_one({"_id": cache_id}, {"$set": {"keys": keys, "jql": jql, "at": jira.now_utc(),
                                                             "workspace_id": cache_id.split(":", 1)[0]}}, upsert=True)
    return keys


async def issues_for(db: AsyncIOMotorDatabase, workspace_id: str, viewer_id: str | None, *,
                     refresh: bool = False) -> dict:
    """{mode: off | counts | details, site, accounts {user: account}, issues [cached issue rows]}."""
    site = await jira.site_for(db, workspace_id) if jira.configured() else None
    if site is None:
        return {"mode": "off", "site": None, "accounts": {}, "issues": []}
    connected = await jira.can_use(db, viewer_id, site["cloud_id"])
    if not site.get("projects"):
        # No project chosen for the Team board (owner decision 2026-11-06): nothing from Jira, a prompt.
        return {"mode": "no_projects", "site": site, "accounts": {}, "issues": [], "connected": connected}
    lookup = viewer_id if connected else await jira.connector(db, site)
    accounts = await jira.member_accounts(db, workspace_id, site["cloud_id"], lookup_as=lookup)
    if not accounts:
        return {"mode": "details" if connected else "counts", "site": site, "accounts": {}, "issues": []}
    jql = _jql(sorted(set(accounts.values())), site.get("projects") or [])
    if connected:
        keys = await _keys(db, f"{workspace_id}:{viewer_id}", viewer_id, site, jql, refresh=refresh)
    else:
        conn = await jira.connector(db, site)
        keys = await _keys(db, f"{workspace_id}:*", conn, site, jql, refresh=refresh) if conn else None
    if keys is None:
        return {"mode": "details" if connected else "counts", "site": site, "accounts": accounts, "issues": [], "error": True}
    rows = {r["key"]: r async for r in db[jira.ISSUES].find({"_id": {"$in": [f"{site['cloud_id']}:{k}" for k in keys]}})}
    issues = [rows[k] for k in keys if k in rows]
    return {"mode": "details" if connected else "counts", "site": site, "accounts": accounts, "issues": issues}


def _counts(items: list[dict], today: date) -> dict:
    return {
        "todo": sum(1 for i in items if i["status"]["category"] == "new"),
        "in_progress": sum(1 for i in items if i["status"]["category"] == "indeterminate"),
        "done_recent": sum(1 for i in items if _recent_done(i, today)),
        "overdue": sum(1 for i in items if _overdue(i, today)),
        "blocked": sum(1 for i in items if i.get("blocked") and i["status"]["category"] != "done"),
    }


def _rank(i: dict, today: date) -> tuple:
    return (not _overdue(i, today), not i.get("blocked"), i["status"]["category"] != "indeterminate",
            str(i.get("due") or "9999"), str(i.get("updated") or ""))


def _card_issue(i: dict, today: date) -> dict:
    return {**jira.public_issue(i), "overdue": _overdue(i, today)}


async def board(db: AsyncIOMotorDatabase, actor: access.Actor, workspace_id: str, *, refresh: bool = False) -> dict:
    """The Team board's Jira part for this viewer: per person counts (+ the top 3 open issues in
    details mode), and the team's totals by status, overdue, blocked and project."""
    got = await issues_for(db, workspace_id, actor.user_id, refresh=refresh)
    site = got["site"]
    out: dict[str, Any] = {"configured": jira.configured(), "mode": got["mode"], "site": None, "people": {},
                           "team": None, "error": bool(got.get("error"))}
    if site is None:
        return out
    out["site"] = {"name": site.get("name"), "url": site.get("url"), "projects": site.get("projects") or []}
    today = _today()
    by_acc: dict[str, str] = {v: k for k, v in got["accounts"].items()}
    per: dict[str, list[dict]] = {}
    for i in got["issues"]:
        uid = by_acc.get((i.get("assignee") or {}).get("account_id") or "")
        if uid:
            per.setdefault(uid, []).append(i)
    details = got["mode"] == "details"
    for uid in got["accounts"]:
        items = per.get(uid, [])
        open_ = sorted((i for i in items if i["status"]["category"] != "done"), key=lambda i: _rank(i, today))
        out["people"][uid] = {"matched": True, "counts": _counts(items, today),
                              "top": [_card_issue(i, today) for i in open_[:TOP]] if details else []}
    allv = got["issues"]
    projects: dict[str, dict] = {}
    for i in allv:
        p = (i.get("project") or {})
        if not p.get("key"):
            continue
        row = projects.setdefault(p["key"], {"key": p["key"], "name": p.get("name") or p["key"], "open": 0, "overdue": 0, "done_recent": 0})
        if i["status"]["category"] != "done":
            row["open"] += 1
        row["overdue"] += _overdue(i, today)
        row["done_recent"] += _recent_done(i, today)
    out["team"] = {**_counts(allv, today), "projects": sorted(projects.values(), key=lambda r: -r["open"]),
                   "connected_people": len(got["accounts"])}
    if details:
        out["team"]["overdue_issues"] = [_card_issue(i, today) for i in sorted(
            (i for i in allv if _overdue(i, today)), key=lambda i: str(i.get("due") or ""))][:10]
        out["team"]["blocked_issues"] = [_card_issue(i, today) for i in allv
                                         if i.get("blocked") and i["status"]["category"] != "done"][:10]
    return out


async def person(db: AsyncIOMotorDatabase, actor: access.Actor, workspace_id: str, user_id: str) -> dict:
    """A person's page: their issues grouped (In progress, To do, Blocked, Overdue, Done lately) in
    details mode; counts only otherwise."""
    got = await issues_for(db, workspace_id, actor.user_id)
    site = got["site"]
    out: dict[str, Any] = {"configured": jira.configured(), "mode": got["mode"], "site": None, "matched": False,
                           "counts": None, "groups": []}
    if site is None:
        return out
    out["site"] = {"name": site.get("name"), "url": site.get("url")}
    acc = got["accounts"].get(user_id)
    if not acc:
        return out
    today = _today()
    items = [i for i in got["issues"] if (i.get("assignee") or {}).get("account_id") == acc]
    out.update(matched=True, counts=_counts(items, today))
    if got["mode"] != "details":
        return out
    groups = [
        ("overdue", "Overdue", [i for i in items if _overdue(i, today)]),
        ("blocked", "Blocked", [i for i in items if i.get("blocked") and i["status"]["category"] != "done" and not _overdue(i, today)]),
        ("in_progress", "In progress", [i for i in items if i["status"]["category"] == "indeterminate"
                                         and not i.get("blocked") and not _overdue(i, today)]),
        ("todo", "To do", [i for i in items if i["status"]["category"] == "new" and not i.get("blocked") and not _overdue(i, today)]),
        ("done", "Done lately", [i for i in items if _recent_done(i, today)]),
    ]
    out["groups"] = [{"key": k, "label": label, "issues": [_card_issue(i, today) for i in sorted(xs, key=lambda i: _rank(i, today))]}
                     for k, label, xs in groups if xs]
    return out


# ── Listing (MCP) ─────────────────────────────────────────────────────────────

STATUS_CAT = {"todo": "new", "to do": "new", "in_progress": "indeterminate", "in progress": "indeterminate", "done": "done"}


async def list_issues(db: AsyncIOMotorDatabase, actor: access.Actor, workspace_id: str, *, person_id: str | None = None,
                      project: str | None = None, status: str | None = None, limit: int = 50) -> dict:
    """Issues this person's own connection can open: the workspace's (members' issues in its projects,
    last 30 days), filtered. Not connected: a 409 saying so."""
    site = await jira.site_for(db, workspace_id) if jira.configured() else None
    if site is None:
        return {"mode": "off", "issues": [], "site": None}
    if not await jira.can_use(db, actor.user_id, site["cloud_id"]):
        return {"mode": "counts", "issues": [], "site": {"name": site.get("name"), "url": site.get("url")}}
    got = await issues_for(db, workspace_id, actor.user_id)
    today = _today()
    items = got["issues"]
    if person_id:
        acc = got["accounts"].get(person_id)
        items = [i for i in items if acc and (i.get("assignee") or {}).get("account_id") == acc]
    if project:
        items = [i for i in items if (i.get("project") or {}).get("key") == project.strip().upper()]
    if status:
        s = status.strip().lower()
        if s == "overdue":
            items = [i for i in items if _overdue(i, today)]
        elif s == "blocked":
            items = [i for i in items if i.get("blocked") and i["status"]["category"] != "done"]
        elif s in STATUS_CAT:
            items = [i for i in items if i["status"]["category"] == STATUS_CAT[s]]
    by_acc = {v: k for k, v in got["accounts"].items()}
    out = []
    for i in items[:limit]:
        row = _card_issue(i, today)
        row["member_id"] = by_acc.get((i.get("assignee") or {}).get("account_id") or "")
        out.append(row)
    return {"mode": "details", "issues": out, "total": len(items), "site": {"name": site.get("name"), "url": site.get("url")}}


# ── Ask ───────────────────────────────────────────────────────────────────────

_JIRA_Q = re.compile(r"\b(jira|tickets?|issues?|bugs?|stories|story|epics?|sprint|backlog|assigned|blocked|overdue)\b", re.I)
_KEY_IN_Q = re.compile(r"\b([A-Z][A-Z0-9_]{1,19}-[1-9][0-9]{0,8})\b")
ASK_MAX = 12


def wants_jira(question: str) -> bool:
    return bool(_JIRA_Q.search(question or "") or _KEY_IN_Q.search(question or ""))


async def ask_issues(db: AsyncIOMotorDatabase, actor: access.Actor, question: str, workspace_ids: list[str]) -> list[dict]:
    """Issues for a question about tickets ("what's Sam working on in Jira", "which tickets are
    blocked", "status of PAY-123"), read through the asker's own connection only. [] when the
    question isn't about tickets or the asker isn't connected."""
    if not jira.configured() or not wants_jira(question) or not actor.user_id:
        return []
    from app.services import workspace as ws_service, workspace_memory as wm

    out: list[dict] = []
    keys = list(dict.fromkeys(_KEY_IN_Q.findall(question or "")))[:10]
    for ws in workspace_ids[:5]:
        site = await jira.site_for(db, ws)
        if site is None or not await jira.can_use(db, actor.user_id, site["cloud_id"]):
            continue
        if keys:
            from app.services import jira_links

            got = await jira_links.viewer_issues(db, actor.user_id, site, keys)
            out += [{**i, "_ws": ws} for i in got.values()]
            continue
        members = await ws_service.mention_people(db, ws, viewer_id=actor.user_id, emails=False)
        named = wm.match_people(question, members, actor.user_id)
        got = await issues_for(db, ws, actor.user_id)
        today = _today()
        items = got["issues"]
        if named:
            accs = {got["accounts"].get(m["id"]) for m in named} - {None}
            items = [i for i in items if (i.get("assignee") or {}).get("account_id") in accs]
        ql = question.lower()
        if "blocked" in ql or "blocker" in ql:
            items = [i for i in items if i.get("blocked") and i["status"]["category"] != "done"]
        elif "overdue" in ql or "late" in ql:
            items = [i for i in items if _overdue(i, today)]
        elif re.search(r"\b(done|closed|resolved|finished|shipped)\b", ql):
            items = [i for i in items if _recent_done(i, today)]
        else:
            items = [i for i in items if i["status"]["category"] != "done"] or items
        out += [{**i, "_ws": ws} for i in sorted(items, key=lambda i: _rank(i, today))]
    return out[:ASK_MAX]


def ask_text(i: dict) -> str:
    """How an issue reads to the model (one candidate)."""
    bits = [f"{i['key']}: {i.get('summary') or ''}",
            f"Status: {(i.get('status') or {}).get('name') or '?'}"
            + {"new": " (to do)", "indeterminate": " (in progress)", "done": " (done)"}.get((i.get("status") or {}).get("category"), "")]
    if i.get("assignee"):
        bits.append(f"Assignee: {i['assignee'].get('name')}")
    else:
        bits.append("Assignee: unassigned")
    if i.get("due"):
        bits.append(f"Due: {i['due']}" + (" (overdue)" if _overdue(i, _today()) else ""))
    if i.get("priority"):
        bits.append(f"Priority: {i['priority']}")
    if i.get("blocked"):
        bits.append("Blocked: yes")
    if (i.get("project") or {}).get("name"):
        bits.append(f"Project: {i['project']['name']}")
    if i.get("updated"):
        bits.append(f"Updated: {str(i['updated'])[:10]}")
    return "\n".join(bits)
