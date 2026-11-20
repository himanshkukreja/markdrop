"""What changed since I last looked (AI quality stage 4, .work/briefs/ai-quality-phase2.md).

    POST /api/v1/workspaces/{ws}/visit {space?}                 the website marks a look (workspace Home, a team, a project)
    GET  /api/v1/workspaces/{ws}/changes?team=&project=&since=  the Home widget "What changed" (no AI)
    MCP ``what_changed(workspace, since?, team?, project?)``     Ask: "what changed since I last looked?" (intent what_changed)

**Last looked.** ``space_visits`` keeps, per person and space (``ws:<id>``, ``team:<id>``, ``project:<id>``), when
they were last there (``seen``) and when their previous look ended (``since``): a look that comes more than
:data:`SESSION_GAP` after the last one moves ``since`` to that last one. So "since I last looked" is the end of the
previous look, not this one; never visited (or only this look): the last :data:`DEFAULT_DAYS` days.

**What changed** comes from Ask's facts index (services/ai_index.py), every row decided for this reader the same way
Ask decides it (``access.discoverable`` per document, the team / project space, comment permissions, teams only
those the reader can read, names only where they may see people on the item): documents created and updated,
meetings held, decisions recorded in those meetings, new action items, comment threads with activity.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import access, ai_index

log = logging.getLogger("markdrop.what_changed")

COLL = "space_visits"
SESSION_GAP = timedelta(minutes=30)
DEFAULT_DAYS = 7
MAX_DAYS = 90
ROWS = 12


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: Any) -> datetime | None:
    if not isinstance(dt, datetime):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def space_key(workspace_id: str, team: str | None = None, project: str | None = None) -> str:
    if project:
        return f"project:{project}"
    if team:
        return f"team:{team}"
    return f"ws:{workspace_id}"


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[COLL].create_index("user_id")


async def visit(db: AsyncIOMotorDatabase, user_id: str, workspace_id: str, space: str) -> dict:
    """Mark a look at ``space``; returns {seen, since}. The caller checked the person may open the space."""
    now = now_utc()
    _id = f"{user_id}|{space}"
    row = await db[COLL].find_one({"_id": _id})
    if row is None:
        await db[COLL].update_one({"_id": _id}, {"$setOnInsert": {"user_id": user_id, "space": space,
                                                                  "workspace_id": workspace_id, "since": None},
                                                 "$set": {"seen": now}}, upsert=True)
        return {"seen": now, "since": None}
    seen = _aware(row.get("seen"))
    since = _aware(row.get("since"))
    upd: dict = {"seen": now}
    if seen is None or now - seen > SESSION_GAP:
        upd["since"] = since = seen
    await db[COLL].update_one({"_id": _id}, {"$set": upd})
    return {"seen": now, "since": since}


async def last_looked(db: AsyncIOMotorDatabase, user_id: str, space: str) -> datetime | None:
    """When the person's previous look at ``space`` ended (None: never, or only the look going on now)."""
    row = await db[COLL].find_one({"_id": f"{user_id}|{space}"}, {"since": 1, "seen": 1})
    if row is None:
        return None
    since, seen = _aware(row.get("since")), _aware(row.get("seen"))
    if seen is not None and now_utc() - seen > SESSION_GAP:
        return seen            # they haven't been back since: the last look is the mark
    return since


def _iso(v: Any) -> str | None:
    if isinstance(v, datetime):
        return _aware(v).isoformat()
    return str(v)[:10] if v else None


@dataclass
class Changes:
    workspace_id: str
    since: datetime
    basis: str                     # visit | default | given
    space: str
    sections: dict[str, list[dict]] = field(default_factory=dict)
    totals: dict[str, int] = field(default_factory=dict)
    docs: list[dict] = field(default_factory=list)     # documents rows behind the items (readable), for Ask's candidates

    def as_dict(self) -> dict:
        return {"workspace_id": self.workspace_id, "since": self.since.isoformat(), "basis": self.basis,
                "space": self.space, "totals": self.totals, **self.sections}

    @property
    def empty(self) -> bool:
        return not any(self.totals.values())


async def changes(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, workspace_id: str, *,
                  since: datetime | None = None, team: str | None = None, project: str | None = None,
                  limit: int = ROWS) -> Changes:
    """What changed in a workspace (or one of its teams / projects) since ``since`` (default: since this reader last
    looked there), decided for this reader."""
    from app.services import ai_summaries, ask_route, meeting_memory, urls

    uid = actor.user_id or ""
    space = space_key(workspace_id, team, project)
    now = now_utc()
    basis = "given"
    if since is None:
        since = await last_looked(db, uid, space)
        basis = "visit" if since is not None else "default"
    since = _aware(since) or now - timedelta(days=DEFAULT_DAYS)
    if since is None or since > now:
        since = now - timedelta(days=DEFAULT_DAYS)
    since = max(since, now - timedelta(days=MAX_DAYS))
    out = Changes(workspace_id, since, basis if since is not None else "default", space)
    limit = max(1, min(int(limit or ROWS), 50))
    wss = [workspace_id]
    names = ask_route._Names(db, actor, ctx)
    await names.load(wss)
    teams = await ask_route._team_names(ctx, uid, wss)

    def f(**kw) -> ai_index.Filter:
        return ai_index.Filter(workspaces=wss, team=team, project=project, since_at=since, **kw)

    def url(raw: dict | None, block: str | None = None) -> str | None:
        slug = (raw or {}).get("slug")
        return urls.markdrop_url(slug) + (f"#{block}" if block else "") if slug else None

    async def who(raw: dict | None, user: str | None) -> str | None:
        if not user:
            return None
        if user == uid:
            return "you"
        return names.names.get(user) if await names.sees(raw) else None

    def add_doc(raw: dict | None) -> None:
        if raw is not None and all(d["_id"] != raw["_id"] for d in out.docs):
            out.docs.append(raw)

    # Meetings held since (by the day they were held), with their two-line summaries.
    met = await ai_index.query(db, actor, ctx, f(kind="meeting", limit=limit))
    sums = await ai_summaries.get(db, [r["doc"] for r in met.rows])
    out.sections["meetings"] = []
    for r in met.rows:
        raw = r.get("_doc")
        out.sections["meetings"].append({"key": f"d:{r['doc']}", "title": r.get("mtitle") or r.get("title") or "Meeting", "date": r.get("date"),
                                         "series": r.get("series"), "url": url(raw), "summary": sums.get(r["doc"]),
                                         "teams": [teams[t]["name"] for t in r.get("teams") or [] if t in teams]})
        add_doc(raw)
    out.totals["meetings"] = met.total
    # Documents: new ones, then the others that changed.
    new = await ai_index.query(db, actor, ctx, f(kind="doc", on="created", limit=limit))
    upd = await ai_index.query(db, actor, ctx, f(kind="doc", on="updated", limit=limit + new.total))
    new_ids = {r["doc"] for r in new.rows} | {r["doc"] for r in upd.rows
                                              if (c := _aware(r.get("created"))) is not None and c >= since}
    out.sections["documents_new"], out.sections["documents_updated"] = [], []
    for r in new.rows:
        raw = r.get("_doc")
        out.sections["documents_new"].append({"key": f"d:{r['doc']}", "title": r.get("title") or "Untitled", "kind": r.get("kind"), "url": url(raw),
                                              "at": _iso(r.get("created")), "by": await who(raw, r.get("creator")),
                                              "status": r.get("status")})
        add_doc(raw)
    changed = [r for r in upd.rows if r["doc"] not in new_ids]
    for r in changed[:limit]:
        raw = r.get("_doc")
        out.sections["documents_updated"].append({"key": f"d:{r['doc']}", "title": r.get("title") or "Untitled", "kind": r.get("kind"), "url": url(raw),
                                                  "at": _iso(r.get("updated")),
                                                  "by": await who(raw, r.get("last_editor") or r.get("creator")),
                                                  "status": r.get("status")})
        add_doc(raw)
    out.totals["documents_new"] = new.total
    out.totals["documents_updated"] = max(0, upd.total - len([r for r in upd.rows if r["doc"] in new_ids]))
    # Decisions recorded in the meetings held since (only from meeting pages this reader may read).
    q: dict = {"workspace_id": {"$in": wss}, "kind": "decision",
               "date": {"$gte": min(r.get("date") or "9999" for r in met.rows)} if met.rows else {"$gte": "9999"}}
    facts = await db[meeting_memory.COLL].find(q, {"doc_id": 1, "date": 1, "meeting_title": 1, "text": 1}).sort(
        [("date", -1), ("ord", 1)]).limit(200).to_list(length=200)
    met_docs = {r["doc"] for r in met.rows}
    keep = [x for x in facts if ai_index._oid(x.get("doc_id")) in met_docs]
    out.sections["decisions"] = [{"key": f"d:{ai_index._oid(x.get('doc_id'))}", "text": x.get("text"), "meeting": x.get("meeting_title"), "date": x.get("date"),
                                  "url": url(next((r.get("_doc") for r in met.rows if r["doc"] == ai_index._oid(x.get("doc_id"))), None))}
                                 for x in keep[:limit]]
    out.totals["decisions"] = len(keep)
    # New action items (from meetings held and pages changed since): open ones first.
    acts = await ai_index.query(db, actor, ctx, f(kind="action", limit=limit * 2))
    acts_rows = sorted(acts.rows, key=lambda r: bool(r.get("done")))[:limit]
    out.sections["action_items"] = []
    for r in acts_rows:
        raw = r.get("_doc")
        out.sections["action_items"].append({"key": f"d:{r['doc']}", "text": r.get("text"), "done": bool(r.get("done")), "on": r.get("title"),
                                             "owner": await who(raw, r.get("owner")) or (r.get("owner_name") if await names.sees(raw) else None),
                                             "due": r.get("due"), "url": url(raw, r.get("block"))})
    out.totals["action_items"] = acts.total
    # Comment threads with activity since.
    com = await ai_index.query(db, actor, ctx, f(kind="comment", limit=limit))
    out.sections["comments"] = []
    for r in com.rows:
        raw = r.get("_doc") or {}
        out.sections["comments"].append({"key": f"d:{r['doc']}", "on": raw.get("title") or "Untitled", "status": r.get("status"),
                                         "by": await who(raw, r.get("author")), "text": r.get("text"),
                                         "at": _iso(r.get("updated")), "url": url(raw)})
        add_doc(raw)
    out.totals["comments"] = com.total
    return out


def _when(v: Any) -> str:
    from app.services import ask_route

    return ask_route._fmt(v)


def sections(ch: Changes, *, label: str | None = None) -> list[tuple[str, list[tuple[str | None, str]]]]:
    """The changes as (heading, [(item key, line)]) groups (Ask's index block, MCP); the first heading says the window."""
    t, s = ch.totals, ch.sections
    where = f" in {label}" if label else ""
    when = (f"since {_when(ch.since)}"
            + {"visit": " (when this person last looked)", "default": f" (no earlier visit: the last {DEFAULT_DAYS} days)",
               "given": ""}[ch.basis])
    out: list[tuple[str, list[tuple[str | None, str]]]] = [
        (f"What changed{where} {when} — meetings held: {t.get('meetings', 0)}",
         [(m.get("key"), f"{_when(m['date'])} · {m['title']}" + (f" — {m['summary']}" if m.get("summary") else ""))
          for m in s.get("meetings", [])]),
        (f"Decisions recorded in those meetings: {t.get('decisions', 0)}",
         [(d.get("key"), f"{d['meeting'] or 'Meeting'} ({_when(d['date'])}): {d['text']}") for d in s.get("decisions", [])]),
        (f"New documents{where} {when}: {t.get('documents_new', 0)}",
         [(d.get("key"), f"{d['title']} ({d['kind']}, created {_when(d['at'])}" + (f" by {d['by']}" if d.get("by") else "") + ")")
          for d in s.get("documents_new", [])]),
        (f"Documents updated{where} {when}: {t.get('documents_updated', 0)}",
         [(d.get("key"), f"{d['title']} ({d['kind']}, updated {_when(d['at'])}" + (f", last edit by {d['by']}" if d.get("by") else "")
           + (f", status {d['status']}" if d.get("status") else "") + ")") for d in s.get("documents_updated", [])]),
        (f"Action items written down {when}: {t.get('action_items', 0)}",
         [(a.get("key"), f"[{'done' if a['done'] else 'open'}] {a['text']}" + (f" — {a['owner']}" if a.get("owner") else "")
           + (f" ({a['on']})" if a.get("on") else "")) for a in s.get("action_items", [])]),
        (f"Comment threads with activity {when}: {t.get('comments', 0)}",
         [(c.get("key"), f"[{c['status']}] on “{c['on']}”" + (f" by {c['by']}" if c.get("by") else "") + f": “{c.get('text') or ''}”")
          for c in s.get("comments", [])]),
    ]
    return out


def text(ch: Changes, *, label: str | None = None) -> str:
    parts = []
    for head, rows in sections(ch, label=label):
        parts.append("\n".join([head] + [f"- {t}" for _k, t in rows]))
    return "\n\n".join(parts)
