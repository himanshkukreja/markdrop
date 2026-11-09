"""The assistant: one "Ask Markdrop" everywhere (owner decision 2026-11-05, .work/assistant/SPEC.md).

    POST /api/v1/ask {question, scope?, context?, thread_id?, intent?}   (SSE, routers/ask.py)
    GET  /api/v1/ask/context?page=&workspace=&folder=&meeting=           what the panel offers here

One conversation UI (components/chat) and this one entry point replace Ask Markdrop home, Ask this
meeting, Ask across meetings and Ask in page. The scope says what to answer from; the engines stay
where they were:

    doc         ask_markdrop, intent "page": this doc first, then its workspace's meetings (their
                recorded decisions, action items… — services/meeting_memory.py) and documents; the
                reader's section and selection go with the question            → AI search budget
    meetings    meetings_ai: one meeting (``meeting``) or the workspace's meetings, narrowed to a
                series and dates (or what the question names)                 → Meetings AI budget
    folder      ask_markdrop, only items filed in that folder or below it      → AI search budget
    workspace   ask_markdrop inside the workspace                               → AI search budget
    mine        ask_markdrop over the asker's own items outside any workspace ("Ask my files")
                                                                                → AI search budget
    everything  ask_markdrop as on the home (catch-up / my action items too)    → AI search budget

**One thread** across scopes and screens (``ask_threads``, 90 days): each turn keeps its scope
(``{kind, label}``); a follow-up sends the thread's readable turns to whichever engine answers it.
Reopening a thread decides every cited item again (a meeting closed to you hides that turn).

**Access** is the engines' own, strictly per cited item: nothing here widens it. A folder scope only
narrows the search; a workspace / folder / meetings scope needs membership of that workspace.

**Citations** come out in one shape whatever answered (:func:`meeting_citation` maps the meetings
engine's): ``{label, key, title, url, kind, slug, moment, quote, subtitle, speaker, at, meeting_id}``.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any, AsyncIterator

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import access, ask_markdrop, meeting_scope, meetings, meetings_ai

log = logging.getLogger("markdrop.assistant")

KINDS = ("doc", "meetings", "folder", "workspace", "mine", "everything", "team", "project")
VIA = "assistant"
_ID = re.compile(r"^[0-9a-f]{24}$")


@dataclass
class Scope:
    kind: str = "everything"
    page: str | None = None
    workspace: str | None = None
    folder: str | None = None
    meeting: str | None = None
    series: str | None = None
    since: str | None = None
    until: str | None = None
    team: str | None = None
    project: str | None = None
    space: str | None = None       # Teams (CONTRACT §3): narrows any kind; kind team / project set it


def parse_scope(raw: dict | None) -> Scope:
    """A scope from the request body (ValueError when it doesn't make sense)."""
    if not raw:
        return Scope()
    kind = str(raw.get("kind") or "everything")
    if kind not in KINDS:
        raise ValueError("scope.kind must be one of " + ", ".join(KINDS))

    def clean(name: str, n: int = 200) -> str | None:
        v = raw.get(name)
        v = str(v).strip()[:n] if v is not None else ""
        return v or None

    sc = Scope(kind=kind, page=clean("page"), workspace=clean("workspace", 40), folder=clean("folder", 40),
               meeting=clean("meeting", 40), series=clean("series", 60), since=clean("since", 10),
               until=clean("until", 10), team=clean("team", 40), project=clean("project", 40),
               space=clean("space", 40))
    for name in ("workspace", "folder", "meeting", "team", "project"):
        v = getattr(sc, name)
        if v is not None and not _ID.match(v):
            raise ValueError(f"scope.{name} is not an id")
    if kind == "doc" and not sc.page:
        raise ValueError("scope.page is needed for kind doc")
    if kind in ("folder", "workspace") and not sc.workspace:
        raise ValueError(f"scope.workspace is needed for kind {kind}")
    if kind == "folder" and not sc.folder:
        raise ValueError("scope.folder is needed for kind folder")
    if kind == "meetings" and not (sc.workspace or sc.meeting):
        raise ValueError("scope.workspace or scope.meeting is needed for kind meetings")
    if kind == "meetings":
        meeting_scope.checked(sc.series, sc.since, sc.until)   # ValueError on a bad date
    if kind in ("team", "project"):
        ident = sc.team if kind == "team" else sc.project
        if not ident or not sc.workspace:
            raise ValueError(f"scope.{kind} and scope.workspace are needed for kind {kind}")
        sc.space = f"{kind}:{ident}"
    if sc.space:
        from app.services import teams as teams_service

        teams_service.parse_space(sc.space)   # ValueError on a bad one
        if sc.space == "all":
            sc.space = None
    return sc


def engine_of(scope: Scope) -> str:
    """Which budget answers: "meetings_ai" for the Meetings scope, else "search_ai" (documented)."""
    return meetings_ai.FEATURE if scope.kind == "meetings" else ask_markdrop.FEATURE


# ── Labels ────────────────────────────────────────────────────────────────────


async def _ws_name(db: AsyncIOMotorDatabase, ws: str | None) -> str | None:
    if not ws:
        return None
    from bson import ObjectId

    row = await db["workspaces"].find_one({"_id": ObjectId(ws)}, {"name": 1}) if _ID.match(ws) else None
    return (row or {}).get("name")


async def _folder_name(db: AsyncIOMotorDatabase, folder: str | None) -> str | None:
    if not folder or not _ID.match(folder):
        return None
    from bson import ObjectId

    row = await db["folders"].find_one({"_id": ObjectId(folder)}, {"name": 1})
    return (row or {}).get("name")


def meetings_label(series: str | None, since: str | None, until: str | None, *, meeting: str | None = None) -> str:
    if meeting:
        return f"This meeting · {meeting}"
    bits = ["Meetings"]
    if series:
        bits.append(series)
    if since or until:
        bits.append(meeting_scope.range_label(since, until))
    return " · ".join(bits)


async def label_of(db: AsyncIOMotorDatabase, scope: Scope, *, page_title: str | None = None,
                   meeting_title: str | None = None) -> str:
    """"This doc · Q3 PRD", "Meetings · Daily Standup · last month", "This folder · Specs"…
    Names only of things the asker can open (the caller decided access first)."""
    if scope.kind == "doc":
        return f"This page · {page_title}" if page_title else "This page"
    if scope.kind == "mine":
        return "My files"
    if scope.kind == "meetings":
        return meetings_label(scope.series, scope.since, scope.until, meeting=meeting_title if scope.meeting else None)
    if scope.kind == "folder":
        name = await _folder_name(db, scope.folder)
        return f"This folder · {name}" if name else "This folder"
    if scope.kind in ("team", "project"):
        from app.services import teams as teams_service

        get = teams_service.get_team if scope.kind == "team" else teams_service.get_project
        row = await get(db, scope.workspace or "", (scope.team if scope.kind == "team" else scope.project) or "")
        return f"{'Team' if scope.kind == 'team' else 'Project'} · {row['name']}" if row else scope.kind.title()
    if scope.kind == "workspace":
        name = await _ws_name(db, scope.workspace)
        return f"Whole company · {name}" if name and scope.space is None and await _has_teams(db, scope.workspace) else (
            f"Workspace · {name}" if name else "Workspace")
    return "Everything"


async def _has_teams(db: AsyncIOMotorDatabase, workspace_id: str | None) -> bool:
    from app.services import teams as teams_service

    return bool(workspace_id) and await db[teams_service.TEAMS].find_one({"workspace_id": workspace_id}, {"_id": 1}) is not None


# ── Citations from the meetings engine ────────────────────────────────────────


def meeting_citation(c: dict, rows: dict[str, dict]) -> dict:
    """A meetings_ai citation ({label, kind page|segment, text, href, slug, meeting_id, key, speaker, at,
    quote}) in the assistant's one shape. ``rows``: meeting id → its row (title, date, series)."""
    row = rows.get(str(c.get("meeting_id") or "")) or {}
    title = row.get("title") or "Meeting"
    when = meetings.fmt_date(row.get("date")) if row.get("date") else None
    subtitle = " · ".join(x for x in (when, row.get("series")) if x) or None
    seg = c.get("kind") == "segment"
    moment = (f"{c.get('speaker') or 'Someone'} · {c['at']}" if c.get("at") else c.get("speaker")) if seg else None
    return {
        "label": c.get("label"), "key": c.get("key"), "title": title if row else (c.get("text") or title),
        "url": c.get("href"), "web_url": c.get("href"), "kind": "page", "slug": c.get("slug"),
        "moment": moment, "quote": c.get("quote"), "subtitle": subtitle, "speaker": c.get("speaker"),
        "at": c.get("at"), "meeting_id": c.get("meeting_id"), "source_kind": "moment" if seg else "meeting",
    }


async def _meeting_rows(db: AsyncIOMotorDatabase, ids: list[str]) -> dict[str, dict]:
    oids = [meetings.oid(i) for i in dict.fromkeys(ids) if i]
    oids = [o for o in oids if o is not None]
    if not oids:
        return {}
    rows = await db[meetings.COLL].find({"_id": {"$in": oids}}, {"title": 1, "date": 1, "series": 1}).to_list(length=len(oids))
    return {str(r["_id"]): r for r in rows}


# ── Ask ───────────────────────────────────────────────────────────────────────


async def ask(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, question: str, *,
              scope: Scope, context: dict | None = None, thread_id: str | None = None,
              intent: str | None = None, via: str = VIA, save: bool = True) -> AsyncIterator[tuple[str, dict]]:
    """Events as ask_markdrop.ask (``status``, ``results``, ``delta``, ``done``, ``limit``, ``error``);
    ``done`` also carries ``scope {kind, label}`` and ``engine`` (the budget it counted towards)."""
    uid = actor.user_id
    if not uid:
        yield ask_markdrop.ev("limit", reason="signin", message=ask_markdrop.message("signin"))
        return
    if scope.kind in ("meetings", "folder", "workspace", "team", "project") and scope.workspace:
        try:
            await meetings.require_member(db, scope.workspace, uid, write=False)
        except Exception:
            yield ask_markdrop.ev("error", detail="Workspace not found", code="not_found")
            return
    if scope.space:
        from app.services import teams as teams_service

        sp = teams_service.parse_space(scope.space)
        tv = await ctx.team_view(scope.workspace, uid) if scope.workspace else None
        if sp.kind in ("team", "project") and (tv is None or not teams_service.space_ok(tv, sp)):
            yield ask_markdrop.ev("error", detail="Team not found" if sp.kind == "team" else "Project not found",
                                  code="not_found")
            return
        # Every retrieval path (search candidates, team memory, meetings) reads the space from ctx.
        ctx.space = scope.space
    if scope.kind == "meetings":
        async for item in _ask_meetings(db, actor, ctx, question, scope=scope, thread_id=thread_id, via=via, save=save):
            yield item
        return

    page_title = None
    if scope.kind == "doc":
        raw = await db["documents"].find_one({"slug": scope.page}, {"title": 1, "encrypted": 1})
        page_title = None if raw is None or raw.get("encrypted") else raw.get("title")
    label = await label_of(db, scope, page_title=page_title)
    record = {"kind": scope.kind, "label": label}
    kw: dict[str, Any] = {"thread_id": thread_id, "via": via, "save": save, "turn_extra": {"scope": record}}
    if scope.kind == "doc":
        kw.update(intent="page", page=scope.page, context=context)
    elif scope.kind in ("folder", "workspace", "team", "project"):
        kw.update(intent=intent, scope=scope.workspace, folder=scope.folder if scope.kind == "folder" else None)
    elif scope.kind == "mine":
        kw.update(intent=intent, mine=True)
    else:
        kw.update(intent=intent)
    async for event, data in ask_markdrop.ask(db, actor, ctx, question, **kw):
        if event == "done":
            data = {**data, "scope": record, "engine": ask_markdrop.FEATURE}
        yield event, data


async def _ask_meetings(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, question: str, *,
                        scope: Scope, thread_id: str | None, via: str, save: bool) -> AsyncIterator[tuple[str, dict]]:
    """The Meetings scope: meetings_ai answers (Meetings AI budget); the turn joins the one thread."""
    uid = actor.user_id
    thread = None
    turns: list[dict] = []
    if thread_id:
        thread = await ask_markdrop._thread_row(db, uid, thread_id)
        if thread is None:
            yield ask_markdrop.ev("error", detail="That conversation isn't there any more.", code="not_found")
            return
        turns = await ask_markdrop._decide_turns(db, actor, ctx, thread.get("turns") or [])
    history = [{"question": t["question"], "answer": ask_markdrop.strip_cites(t.get("answer") or "")}
               for t in turns if not t.get("withheld") and t.get("question")]
    meeting_title = None
    if scope.meeting:
        row = await meetings.get_row(db, scope.meeting)
        if row is None or await meetings.readable(db, row, actor, ctx) is None:
            yield ask_markdrop.ev("error", detail="Meeting not found", code="not_found")
            return
        if scope.workspace and row.get("workspace_id") != scope.workspace:
            yield ask_markdrop.ev("error", detail="Meeting not found", code="not_found")
            return
        meeting_title = row.get("title") or "Meeting"
        gen = meetings_ai.ask_meeting(db, actor, ctx, scope.meeting, question, history=history, via=via)
    else:
        gen = meetings_ai.ask_meetings(db, actor, ctx, scope.workspace, question, via=via, series=scope.series,
                                       since=scope.since, until=scope.until, history=history)
    label = meetings_label(scope.series, scope.since, scope.until, meeting=meeting_title)
    ranked_rows: dict[str, dict] = {}
    async for event, data in gen:
        if event == "results":
            items = data.get("items") or []
            for it in items:
                ranked_rows[str(it.get("id"))] = it
            sc = data.get("scope")
            yield ask_markdrop.ev("results", items=[_meeting_item(it) for it in items], scope=sc,
                                  note=scope_note(sc) if sc and not scope.meeting else None)
            continue
        if event != "done":
            yield event, data
            continue
        sc = data.get("scope")
        used_label = scope_note(sc) if sc and not scope.meeting else label
        rows = await _meeting_rows(db, [c.get("meeting_id") or scope.meeting for c in data.get("citations") or []])
        if scope.meeting:
            for c in data.get("citations") or []:
                c.setdefault("meeting_id", scope.meeting)
        citations = [meeting_citation(c, rows) for c in data.get("citations") or []]
        answer = data.get("answer") or ""
        record = {"kind": "meetings", "label": used_label}
        tid = None
        if save and answer.strip():
            try:
                tid = await ask_markdrop._save_turn(db, uid, thread, {
                    "q": question.strip()[:ask_markdrop.MAX_QUESTION], "a": answer, "intent": "meetings",
                    "citations": citations, "request_id": data.get("request_id"), "scope": record}, via)
            except Exception:   # the answer still arrives when saving it fails
                log.warning("assistant: conversation not saved", exc_info=True)
        yield ask_markdrop.ev("done", request_id=data.get("request_id"), thread_id=tid, intent="meetings",
                              answer=answer, citations=citations,
                              ranked=[_meeting_item(x) for x in data.get("ranked") or []],
                              usage=data.get("usage"), truncated=bool(data.get("truncated")), scope=record,
                              meetings_scope=sc, engine=meetings_ai.FEATURE)


def scope_note(sc: dict) -> str:
    """The meetings an answer used: "Meetings · Daily Standup · Oct 2026", or "From your question: …" when
    the engine read the series / dates from the question."""
    label = meetings_label(sc.get("series"), sc.get("since"), sc.get("until"))
    return "From your question: " + label.removeprefix("Meetings · ") if sc.get("detected") else label


def _meeting_item(it: dict) -> dict:
    """A meeting the meetings engine read, shaped like a search result (the chat's "reading" list)."""
    when = meetings.fmt_date(it.get("date")) if it.get("date") else None
    return {"key": f"m:{it.get('id')}", "kind": "meeting", "title": it.get("title") or "Meeting",
            "url": f"/{it['slug']}" if it.get("slug") else None, "slug": it.get("slug"), "n": it.get("n"),
            "subtitle": " · ".join(x for x in (when, it.get("series")) if x) or None}


# ── What the panel offers here ────────────────────────────────────────────────

MAX_WORKSPACES = 20


async def member_workspaces(db: AsyncIOMotorDatabase, uid: str | None, *, first: str | None = None) -> list[dict]:
    """[{id, name}] of the person's workspaces (``first`` first, then by name), at most MAX_WORKSPACES."""
    if not uid:
        return []
    from bson import ObjectId

    ids = [m["workspace_id"] for m in await db["memberships"].find({"user_id": uid}, {"workspace_id": 1}).to_list(length=200)
           if _ID.match(str(m.get("workspace_id") or ""))]
    rows = await db["workspaces"].find({"_id": {"$in": [ObjectId(i) for i in ids]}}, {"name": 1}).to_list(length=200)
    out = sorted(({"id": str(r["_id"]), "name": r.get("name") or "Workspace"} for r in rows),
                 key=lambda w: (w["id"] != first, (w["name"] or "").lower()))
    return out[:MAX_WORKSPACES]



async def context_for(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, *, page: str | None = None,
                      workspace: str | None = None, folder: str | None = None, meeting: str | None = None) -> dict:
    """The scopes the assistant offers where the person is, the default one, and the AI status of
    both features. Only what they can open is named; anything else is left out (never an error)."""
    uid = actor.user_id
    out: dict[str, Any] = {"scopes": [], "default": "everything", "page": None, "workspace": None, "folder": None,
                           "meeting": None, "series": [], "can_insert": False}
    ws = workspace if workspace and _ID.match(workspace) else None
    if page:
        raw = await db["documents"].find_one({"slug": page.strip()[:200]}, {"content": 0})
        if (raw is not None and not raw.get("deleted_at") and not raw.get("encrypted") and raw.get("kind") != "artifact"
                and (await access.can(actor, raw, "read", ctx)).allowed):
            can_edit = (await access.can(actor, raw, "edit_content", ctx)).allowed
            out["page"] = {"slug": raw["slug"], "title": raw.get("title"), "editor": raw.get("editor") or "markdown",
                           "meeting_id": raw.get("meeting_id"), "meeting_role": raw.get("meeting_role")}
            out["can_insert"] = bool(can_edit)
            ws = raw.get("workspace_id") or ws
            if raw.get("meeting_id") and not meeting:
                meeting = raw.get("meeting_id")
            out["scopes"].append({"kind": "doc", "label": "This page", "sub": raw.get("title") or None})
            out["default"] = "doc"
    member = False
    if ws:
        try:
            await meetings.require_member(db, ws, uid, write=False)
            member = True
        except Exception:
            member = False
    if member:
        out["workspace"] = {"id": ws, "name": await _ws_name(db, ws)}
        if meeting and _ID.match(meeting):
            row = await meetings.get_row(db, meeting)
            if row is not None and row.get("workspace_id") == ws and await meetings.readable(db, row, actor, ctx) is not None:
                out["meeting"] = {"id": str(row["_id"]), "title": row.get("title"), "date": row.get("date"),
                                  "series": row.get("series")}
                if out["default"] == "everything" or (out["page"] and out["page"].get("meeting_id")):
                    out["default"] = "meetings"
        series = [s for s in await db[meetings.COLL].distinct("series", {"workspace_id": ws}) if s]
        out["series"] = sorted(series, key=str.lower)[:50]
        out["scopes"].append({"kind": "meetings", "label": "Meetings", "sub": out["meeting"]["title"] if out["meeting"] else None})
        if folder and _ID.match(folder) and await ask_markdrop.folder_subtree(db, ws, folder) is not None:
            out["folder"] = {"id": folder, "name": await _folder_name(db, folder)}
            out["scopes"].append({"kind": "folder", "label": "This folder", "sub": out["folder"]["name"]})
            if out["default"] == "everything":
                out["default"] = "folder"
        out["scopes"].append({"kind": "workspace", "label": "Workspace", "sub": out["workspace"]["name"]})
        if out["default"] == "everything" and workspace:
            out["default"] = "meetings" if meeting else "workspace"
    out["scopes"].append({"kind": "mine", "label": "My files", "sub": None})
    out["scopes"].append({"kind": "everything", "label": "Everything", "sub": None})
    # Every workspace the person belongs to (Ask <Workspace>: a chip each, the current one first).
    out["workspaces"] = await member_workspaces(db, uid, first=out["workspace"]["id"] if out["workspace"] else None)
    out["status"] = {
        "search": await ask_markdrop.status(db, uid),
        "meetings": await meetings_ai.status(db, uid, out["workspace"]["id"] if out["workspace"] else None)
        if out["workspace"] else None,
    }
    return out
