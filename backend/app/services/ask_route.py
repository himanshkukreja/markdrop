"""Ask's light routing and the index block (AI quality stage 2, .work/briefs/ai-quality-phase2.md).

The expansion call (services/ask_markdrop.py ``EXPAND_SYSTEM``) also classifies the question — ``route``:
{type: lookup | list | count | person | time | team, people, team, since, until, items, title}. From it,
:func:`build` asks Markdrop's own records before the word search runs:

* **count / list / time** → Layer 1 (services/ai_index.py): the exact rows (documents created or updated by
  someone or in a window, meetings someone attended or held in a window, open action items by owner, comment
  threads, a team's backlog) with exact totals;
* **person** → a person card (Layer 2): their teams, what they created, meetings in the last two weeks, open
  action items, and what Team memory says they are working on;
* **team** (and every question asked inside a team) → the team overview (R4): roster and lead, what each member
  is working on, the latest brief, open backlog by category, the last two weeks of team meetings, recently
  updated team documents.

The block goes to the model inside ``<untrusted_index>`` (titles and names are people's words), its rows pointing
at the numbered items ([n]) — the documents it lists join the candidates first, so they can be cited.

**Access.** Every row comes from ``ai_index.query`` (decided per row for this asker: ``access.discoverable``,
the request's team space, comment permissions, a backlog item's team and calls); a person's teams and a team's
overview only for teams the asker can read; names only where the asker may see people on that item
(``pages.sees_people``); memory lines through ``workspace_memory.visible`` (per source). Workspaces with AI off,
and every scope narrower than a workspace (a folder, "my files"), get no block.

:func:`system_text` renders a team's backlog page or a to-do page item per line (open first, no empty headings)
instead of a 600-character excerpt.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import access, ai_index, ask_context

log = logging.getLogger("markdrop.ask")

TYPES = ("lookup", "list", "count", "person", "time", "team")
ITEMS = ("documents", "meetings", "action_items", "comments", "backlog", "any")
ROWS = 25                   # rows shown per section (the count is exact either way)
CAND_DOCS = 12              # listed documents that join the candidates
MAX_PEOPLE = 3
BLOCK_CHARS = 9000
RECENT_DAYS = 14
_CREATED = re.compile(r"\b(creat\w*|wrote|written|write|authored|new|added|started|drafted)\b", re.I)
_DONE = re.compile(r"\b(done|completed|finished|closed|ticked)\b", re.I)
_COUNT = re.compile(r"\bhow many\b|\bnumber of\b|\bcount\b", re.I)
_LIST = re.compile(r"\b(list|which|all|every|what are|show me)\b", re.I)
_TEAMISH = re.compile(r"\b(team|teams|squad|department)\b", re.I)


# ── The route ─────────────────────────────────────────────────────────────────


@dataclass
class Route:
    type: str = "lookup"
    people: list[str] = field(default_factory=list)
    team: str | None = None
    since: date | None = None
    until: date | None = None
    items: str = "any"
    title: str | None = None

    def as_meta(self) -> dict:
        return {"type": self.type, "items": self.items, "people": len(self.people), "team": bool(self.team),
                "window": bool(self.since or self.until)}


def _date(v: Any, today: date) -> date | None:
    try:
        d = date.fromisoformat(str(v)[:10])
    except (TypeError, ValueError):
        return None
    if d > today + timedelta(days=366) or d < today - timedelta(days=3660):
        return None
    return d


def parse(data: Any, question: str, today: date) -> Route:
    """The expansion's ``route`` object, checked; words of the question fill what it left out."""
    from app.services import meeting_scope

    r = Route()
    d = data if isinstance(data, dict) else {}
    t = str(d.get("type") or "").strip().lower()
    r.type = t if t in TYPES else ("count" if _COUNT.search(question or "") else "lookup")
    it = str(d.get("items") or "").strip().lower().replace(" ", "_")
    r.items = it if it in ITEMS else "any"
    r.people = [str(p).strip()[:60] for p in (d.get("people") or []) if isinstance(p, str) and p.strip()][:MAX_PEOPLE]
    team = d.get("team")
    r.team = str(team).strip()[:60] if isinstance(team, str) and team.strip() else None
    title = d.get("title")
    r.title = str(title).strip()[:40] if isinstance(title, str) and title.strip() else None
    r.since, r.until = _date(d.get("since"), today), _date(d.get("until"), today)
    if r.since is None and r.until is None:
        s, u = meeting_scope.dates_from(question or "", today)
        r.since, r.until = _date(s, today), _date(u, today)
    if r.since and r.until and r.since > r.until:
        r.since, r.until = r.until, r.since
    if r.type == "lookup" and (r.since or r.until) and r.items != "any":
        r.type = "time"
    return r


# ── The block ─────────────────────────────────────────────────────────────────


@dataclass
class Row:
    key: str | None
    text: str


@dataclass
class Section:
    head: str
    rows: list[Row] = field(default_factory=list)
    tail: str = ""


@dataclass
class Index:
    sections: list[Section] = field(default_factory=list)
    docs: list[dict] = field(default_factory=list)       # documents rows to add as candidates, in order
    kinds: list[str] = field(default_factory=list)

    @property
    def empty(self) -> bool:
        return not self.sections

    def render(self, numbers: dict[str, int]) -> str:
        from app.services import pages_ai

        if not self.sections:
            return ""
        parts = ["Markdrop's records for this question (exact counts and lists of what this person can open; "
                 "\"[n]\" is the numbered item):"]
        used = 0
        for s in self.sections:
            lines = [s.head]
            for r in s.rows:
                n = numbers.get(r.key or "")
                lines.append(f"- [{n}] {r.text}" if n else f"- {r.text}")
            if s.tail:
                lines.append(s.tail)
            text = "\n".join(lines)
            if used + len(text) > BLOCK_CHARS and used:
                break
            parts.append(text)
            used += len(text)
        return pages_ai.wrap("index", "\n\n".join(parts))


def _fmt(d: Any) -> str:
    if isinstance(d, datetime):
        d = d.date()
    if isinstance(d, str):
        try:
            d = date.fromisoformat(d[:10])
        except ValueError:
            return d
    if isinstance(d, date):
        return f"{d.strftime('%b')} {d.day}, {d.year}"
    return ""


def _window_text(since: date | None, until: date | None) -> str:
    if since and until:
        return f" between {_fmt(since)} and {_fmt(until)}" if since != until else f" on {_fmt(since)}"
    if since:
        return f" since {_fmt(since)}"
    if until:
        return f" until {_fmt(until)}"
    return ""


class _Names:
    """Member names by id (a workspace's), and whether this asker may see people on an item."""

    def __init__(self, db, actor, ctx):
        self.db, self.actor, self.ctx = db, actor, ctx
        self.names: dict[str, str] = {}
        self._sees: dict[Any, bool] = {}

    async def load(self, wss: list[str]) -> None:
        from app.services import workspace_memory

        for w in wss:
            for m in await workspace_memory.members_of(self.db, w):
                self.names.setdefault(m["id"], m["name"])

    async def sees(self, raw: dict | None) -> bool:
        from app.services import pages

        if raw is None:
            return False
        k = raw.get("_id")
        if k not in self._sees:
            self._sees[k] = await pages.sees_people(self.actor, raw, self.ctx)
        return self._sees[k]


async def _team_names(ctx: access.Ctx, uid: str, wss: list[str]) -> dict[str, dict]:
    """Readable teams of these workspaces: id → team row (with ``workspace_id``)."""
    from app.services import teams as teams_service

    out: dict[str, dict] = {}
    for w in wss:
        view = await ctx.team_view(w, uid)
        for tid in view.readable_teams:
            t = view.teams.get(tid) or {}
            if t and not teams_service.is_general(t):
                out[tid] = {**t, "workspace_id": w}
    return out


def _match_team(name: str | None, teams: dict[str, dict]) -> str | None:
    if not name:
        return None
    n = name.casefold().strip()
    n = re.sub(r"\s+team$", "", n)
    for tid, t in teams.items():
        if (t.get("name") or "").casefold() == n:
            return tid
    for tid, t in teams.items():
        tn = (t.get("name") or "").casefold()
        if tn and (tn in n or n in tn) and len(n) >= 3:
            return tid
    return None


def _team_label(row: dict, teams: dict[str, dict]) -> str:
    names = [teams[t]["name"] for t in row.get("teams") or [] if t in teams]
    return ", ".join(names)


async def _doc_line(row: dict, names: _Names, teams: dict[str, dict], *, show_creator: bool = True) -> str:
    raw = row.get("_doc")
    bits = [row.get("kind") or "page"]
    who = names.names.get(row.get("creator") or "") if show_creator and await names.sees(raw) else None
    bits.append(f"created {_fmt(row.get('created'))}" + (f" by {who}" if who else ""))
    if row.get("updated") and _fmt(row.get("updated")) != _fmt(row.get("created")):
        last = names.names.get(row.get("last_editor") or "") if await names.sees(raw) else None
        bits.append(f"updated {_fmt(row.get('updated'))}" + (f" (last edit by {last})" if last else ""))
    if row.get("status"):
        bits.append(f"status {row['status']}")
    tl = _team_label(row, teams)
    if tl:
        bits.append(f"team {tl}")
    if row.get("c_open"):
        bits.append(f"{row['c_open']} open comment thread{'s' if row['c_open'] != 1 else ''}")
    return f"{row.get('title') or 'Untitled'} — " + ", ".join(bits)


async def _meeting_line(row: dict, names: _Names) -> str:
    att = row.get("attendee_names") or []
    t = row.get("mtitle") or row.get("title") or "Meeting"
    s = f"{_fmt(row.get('date'))} · {t}" + (f" ({row['series']})" if row.get("series") and row["series"] != t else "")
    if att and await names.sees(row.get("_doc")):
        s += " — attendees: " + ", ".join(att[:10]) + (f" +{len(att) - 10}" if len(att) > 10 else "")
    return s


def _action_line(row: dict) -> str:
    where = row.get("title") or "a page"
    s = f"[{'done' if row.get('done') else 'open'}] {row.get('text')} — {where}"
    if row.get("date"):
        s += f", {_fmt(row['date'])}"
    if row.get("due"):
        s += f" (due {_fmt(row['due'])})"
    return s


def _people_ids(people: ask_context.People, route: Route, members: dict[str, str]) -> list[dict]:
    """The members this question is about: those name resolution found (both Rahuls for "Rahul"), else the
    route's names matched to members by full / first name."""
    if people.named:
        return people.named[:MAX_PEOPLE]
    out = []
    for p in route.people:
        pf = p.casefold().strip()
        hits = [{"id": k, "name": v} for k, v in members.items() if v.casefold() == pf]
        if not hits:
            hits = [{"id": k, "name": v} for k, v in members.items() if v.casefold().split()[0] == pf.split()[0]]
        out += hits[:2]
    return list({x["id"]: x for x in out}.values())[:MAX_PEOPLE]


async def _wss(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, scope: str | None) -> list[str]:
    from app.services import pages_ai, workspace as ws_service

    if scope:
        cands = [scope]
    else:
        cands = [w.id for w, _r in await ws_service.list_for_user(db, actor.user_id)]
        if actor.tenant_ws:
            cands = [w for w in cands if w == actor.tenant_ws]
    out = []
    for w in cands[:10]:
        if await ctx.role(w, actor.user_id) is not None and await pages_ai.workspace_on(db, w):
            out.append(w)
    return out


def _space_team(ctx: access.Ctx) -> str | None:
    from app.services import teams as teams_service

    if not ctx.space:
        return None
    sp = teams_service.parse_space(ctx.space)
    return sp.id if sp.kind == "team" else None


async def build(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, question: str, route: Route,
                people: ask_context.People, scope: str | None, *, narrowed: bool = False) -> Index:
    """The index block for this question (empty when it isn't a counting / listing / person / time / team question,
    or the scope is narrower than a workspace)."""
    out = Index()
    uid = actor.user_id
    if not uid or narrowed:
        return out
    wss = await _wss(db, actor, ctx, scope)
    if not wss:
        return out
    names = _Names(db, actor, ctx)
    await names.load(wss)
    teams = await _team_names(ctx, uid, wss)
    space_team = _space_team(ctx)
    team = space_team or (_match_team(route.team, teams) if (route.team or route.type == "team") else None)
    who = _people_ids(people, route, names.names)
    since, until = route.since, route.until
    q = question or ""
    t, items = route.type, route.items
    structured = t in ("list", "count", "time") or bool(since or until)

    def add_docs(rows: list[dict], cap: int = CAND_DOCS) -> None:
        for r in rows:
            raw = r.get("_doc") if "_doc" in r else r
            if raw is not None and all(d["_id"] != raw["_id"] for d in out.docs) and len(out.docs) < cap:
                out.docs.append(raw)

    try:
        if team and team in teams:
            secs, raws = await _team_overview(db, actor, ctx, team, teams, names, wss)
            out.sections += secs
            add_docs(raws)
            out.kinds.append("team")
        if t == "person" or (who and t in ("lookup", "person") and not structured and items == "any"):
            for p in who[:MAX_PEOPLE]:
                sec = await _person_card(db, actor, ctx, p, wss, teams, names)
                if sec is not None:
                    out.sections.append(sec)
                    out.kinds.append("person")
        if structured or items != "any":
            docs_wanted = items == "documents" or (items == "any" and (route.title or (who and t in ("list", "count"))
                                                                         or (t == "time" or (since or until))))
            meet_wanted = items == "meetings" or (items == "any" and (t == "time" or (since or until)) and not who)
            on = "created" if _CREATED.search(q) else "updated"
            team_f = team if team in teams else None
            loose = items == "any"          # a period, not a kind of item: meetings first, a short list of documents
            if meet_wanted and loose:
                await _meetings_section(db, actor, ctx, out, who, wss, team_f, teams, names, route, since, until, add_docs)
                meet_wanted = False
            if docs_wanted:
                for p in (who or [None]):
                    f = ai_index.Filter(kind="doc", workspaces=wss, creator=(p or {}).get("id"), team=team_f,
                                        since=since, until=until, on=on if (since or until) else "updated",
                                        title=route.title, limit=10 if loose and not (p or route.title) else ROWS)
                    res = await ai_index.query(db, actor, ctx, f)
                    head = ("Documents" + (f" titled with “{route.title}”" if route.title else "")
                            + (f" created by {p['name']} (pages Markdrop keeps, like backlogs and to-dos, not counted)" if p else "")
                            + (f" in team {teams[team_f]['name']}" if team_f else "")
                            + (f" {on}{_window_text(since, until)}" if (since or until) else "")
                            + f": {res.total}" + (" or more" if res.capped else ""))
                    sec = Section(head)
                    for r in res.rows:
                        sec.rows.append(Row(f"d:{r['doc']}", await _doc_line(r, names, teams, show_creator=p is None)))
                    if res.total > len(res.rows):
                        sec.tail = f"(+{res.total - len(res.rows)} more not listed)"
                    out.sections.append(sec)
                    if not (loose and not (p or route.title)):
                        add_docs(res.rows)
                    out.kinds.append("documents")
            if meet_wanted:
                await _meetings_section(db, actor, ctx, out, who, wss, team_f, teams, names, route, since, until, add_docs)
            if items == "action_items":
                done = True if _DONE.search(q) and not re.search(r"\b(open|pending|outstanding|not done)\b", q, re.I) else False
                for p in (who or [None]):
                    f = ai_index.Filter(kind="action", workspaces=wss, owner=(p or {}).get("id"), team=team_f,
                                        since=since, until=until, done=done, limit=40)
                    res = await ai_index.query(db, actor, ctx, f)
                    head = (f"{'Done' if done else 'Open'} action items" + (f" owned by {p['name']}" if p else "")
                            + (f" in team {teams[team_f]['name']}" if team_f else "") + _window_text(since, until)
                            + f": {res.total}")
                    sec = Section(head)
                    for r in res.rows:
                        sec.rows.append(Row(f"d:{r['doc']}", _action_line(r)))
                    out.sections.append(sec)
                    add_docs(res.rows)
                    out.kinds.append("actions")
            if items == "comments":
                for p in (who or [None]):
                    f = ai_index.Filter(kind="comment", workspaces=wss, author=(p or {}).get("id"), since=since, until=until,
                                        limit=ROWS)
                    res = await ai_index.query(db, actor, ctx, f)
                    sec = Section("Comment threads" + (f" {p['name']} started or replied to" if p else "")
                                  + _window_text(since, until) + f": {res.total}")
                    for r in res.rows:
                        raw = r.get("_doc") or {}
                        by = names.names.get(r.get("author") or "") if await names.sees(raw) else None
                        sec.rows.append(Row(f"d:{r['doc']}", f"[{r.get('status')}] on “{raw.get('title') or 'Untitled'}”"
                                            + (f" by {by}" if by else "") + f", {_fmt(r.get('updated'))}: “{r.get('text') or ''}”"))
                    out.sections.append(sec)
                    add_docs(res.rows)
                    out.kinds.append("comments")
            if items == "backlog" and not (team and team in teams):
                for tid in ([team_f] if team_f else list(teams)[:4]):
                    sec = await _backlog_section(db, actor, ctx, tid, teams, names)
                    if sec is not None:
                        out.sections.append(sec)
                        out.kinds.append("backlog")
    except Exception:
        log.warning("ask route: index block failed", exc_info=True)
    return out


async def _meetings_section(db, actor, ctx, out: Index, who: list[dict], wss: list[str], team_f: str | None, teams: dict,
                            names: _Names, route: Route, since, until, add_docs) -> None:
    from app.services import ai_summaries

    for p in (who or [None]):
        f = ai_index.Filter(kind="meeting", workspaces=wss, attendee=(p or {}).get("id"), team=team_f,
                            since=since, until=until, series=route.title, limit=ROWS)
        res = await ai_index.query(db, actor, ctx, f)
        head = ("Meetings" + (f" “{route.title}”" if route.title else "")
                + (f" {p['name']} attended" if p else "") + (f" in team {teams[team_f]['name']}" if team_f else "")
                + _window_text(since, until) + f": {res.total}" + (" or more" if res.capped else ""))
        sums = await ai_summaries.get(db, [r["doc"] for r in res.rows[:ROWS]]) if res.total <= ROWS else {}
        sec = Section(head)
        for r in res.rows:
            sm = sums.get(r["doc"])
            sec.rows.append(Row(f"d:{r['doc']}", await _meeting_line(r, names) + (f" — {sm}" if sm else "")))
        if res.total > len(res.rows):
            sec.tail = f"(+{res.total - len(res.rows)} more not listed)"
        out.sections.append(sec)
        add_docs(res.rows)
        out.kinds.append("meetings")


async def _backlog_section(db, actor, ctx, tid: str, teams: dict, names: _Names, *, limit: int = 30) -> Section | None:
    f = ai_index.Filter(kind="backlog", workspaces=[teams[tid]["workspace_id"]], team=tid, status="open", limit=500)
    res = await ai_index.query(db, actor, ctx, f)
    if not res.total:
        return Section(f"Open backlog items of team {teams[tid]['name']}: 0")
    from app.services import team_backlog

    by_cat: dict[str, list[dict]] = {}
    for r in res.rows:
        by_cat.setdefault(r.get("category") or "task", []).append(r)
    sec = Section(f"Open backlog items of team {teams[tid]['name']}: {res.total} ("
                  + ", ".join(f"{team_backlog.category_label(c)} {len(v)}" for c, v in by_cat.items()) + ")")
    n = 0
    for c, v in by_cat.items():
        for r in v:
            if n >= limit:
                break
            owner = names.names.get(r.get("owner") or "")
            sec.rows.append(Row(None, f"{team_backlog.category_label(c)}: {r.get('text')}"
                                + (f" — {owner}" if owner else "") + (" (in progress)" if r.get("status") == "in_progress" else "")))
            n += 1
    if res.total > n:
        sec.tail = f"(+{res.total - n} more not listed)"
    return sec


async def _person_card(db, actor, ctx, p: dict, wss: list[str], teams: dict, names: _Names) -> Section | None:
    """Layer 2: one person, as this asker may see them."""
    from app.services import workspace_memory

    uid = p["id"]
    mem = await db["memberships"].find_one({"user_id": uid, "workspace_id": {"$in": wss}}, {"workspace_id": 1})
    ws = (mem or {}).get("workspace_id") or wss[0]
    tms = [f"{t['name']}{' (lead)' if uid in (t.get('lead_ids') or []) else ''}" for t in teams.values()
           if uid in (t.get("member_ids") or [])]
    sec = Section(f"Person: {p['name']}" + (f" — teams: {', '.join(sorted(tms))}" if tms else " — no team the asker can see"))
    today = ctx.now.date() if getattr(ctx, "now", None) else datetime.now(timezone.utc).date()
    created = await ai_index.query(db, actor, ctx, ai_index.Filter(kind="doc", workspaces=wss, creator=uid, limit=8))
    if created.total:
        sec.rows.append(Row(None, f"Created {created.total} document{'s' if created.total != 1 else ''} (newest: "
                            + "; ".join(f"{r.get('title') or 'Untitled'} ({_fmt(r.get('updated'))}"
                                        + (f", {r['status']}" if r.get("status") else "") + ")" for r in created.rows[:8]) + ")"))
    since = today - timedelta(days=RECENT_DAYS)
    met = await ai_index.query(db, actor, ctx, ai_index.Filter(kind="meeting", workspaces=wss, attendee=uid, since=since, limit=10))
    if met.total:
        sec.rows.append(Row(None, f"Meetings in the last {RECENT_DAYS} days: {met.total} ("
                            + "; ".join(f"{_fmt(r.get('date'))} {r.get('mtitle') or r.get('title')}" for r in met.rows[:10]) + ")"))
    acts = await ai_index.query(db, actor, ctx, ai_index.Filter(kind="action", workspaces=wss, owner=uid, done=False, limit=8))
    if acts.total:
        sec.rows.append(Row(None, f"Open action items: {acts.total} ("
                            + "; ".join(f"{r.get('text')} — {r.get('title')}" + (f", due {_fmt(r['due'])}" if r.get("due") else "")
                                        for r in acts.rows[:8]) + ")"))
    try:
        info = await workspace_memory.ws_info(db, ws)
        if info is not None and info.on:
            prof = await workspace_memory.person_profile(db, actor, ctx, info, uid)
            if prof:
                lines = [x.get("text") for x in (prof.get("working_on") or [])[:4]]
                lines += [x.get("text") for x in (prof.get("updates") or [])[:3]]
                lines = [x for x in dict.fromkeys(lines) if x]
                if lines:
                    sec.rows.append(Row(None, "Team memory, working on / recent: " + "; ".join(lines)))
    except Exception:
        log.warning("ask route: person memory failed", exc_info=True)
    return sec


async def _team_overview(db, actor, ctx, tid: str, teams: dict, names: _Names,
                         wss: list[str]) -> tuple[list[Section], list[dict]]:
    """R4: one team as this asker may see it."""
    from app.services import workspace_memory

    t = teams[tid]
    ws = t["workspace_id"]
    lead_ids = t.get("lead_ids") or []
    members = [m for m in t.get("member_ids") or []]
    roster = [f"{names.names.get(m, 'Former member')}{' (lead)' if m in lead_ids else ''}" for m in members]
    out = [Section(f"Team: {t.get('name')} ({t.get('visibility') or 'open'} team) — {len(members)} members: " + ", ".join(roster))]
    now = ctx.now if getattr(ctx, "now", None) else datetime.now(timezone.utc)
    try:
        info = await workspace_memory.ws_info(db, ws)
        if info is not None and info.on:
            v = await workspace_memory.visible(db, actor, ctx, ws)
            sec = Section("What each member is working on (Team memory):")
            for m in members:
                ln = workspace_memory.now_line(v.by_subject(m), None, now)
                if ln and ln.get("text"):
                    sec.rows.append(Row(None, f"{names.names.get(m, 'Former member')}: {ln['text']}"))
            if sec.rows:
                out.append(sec)
    except Exception:
        log.warning("ask route: team memory failed", exc_info=True)
    try:
        b = await db["team_briefs"].find_one({"team_id": tid}, sort=[("week", -1)])
        lines = [ln["text"] for ln in (b or {}).get("lines") or [] if not ln.get("hidden") and ln.get("kind") != "pipeline"]
        if lines:
            sec = Section(f"Latest team brief ({b.get('label') or b.get('week')}):")
            sec.rows = [Row(None, x) for x in lines[:10]]
            out.append(sec)
    except Exception:
        log.warning("ask route: team brief failed", exc_info=True)
    bl = await _backlog_section(db, actor, ctx, tid, teams, names)
    if bl is not None:
        out.append(bl)
    since = now.date() - timedelta(days=RECENT_DAYS)
    met = await ai_index.query(db, actor, ctx, ai_index.Filter(kind="meeting", workspaces=[ws], team=tid, since=since, limit=15))
    from app.services import ai_summaries

    sums = await ai_summaries.get(db, [r["doc"] for r in met.rows])
    sec = Section(f"Team meetings in the last {RECENT_DAYS} days: {met.total}")
    for r in met.rows:
        s = sums.get(r["doc"])
        sec.rows.append(Row(f"d:{r['doc']}", await _meeting_line(r, names) + (f" — {s}" if s else "")))
    out.append(sec)
    docs = await ai_index.query(db, actor, ctx, ai_index.Filter(kind="doc", workspaces=[ws], team=tid, limit=12))
    sec = Section(f"Team documents, newest first: {docs.total}")
    for r in docs.rows:
        sec.rows.append(Row(f"d:{r['doc']}", await _doc_line(r, names, teams)))
    out.append(sec)
    # The newest meetings and documents join the candidates, so their notes and text come too.
    raws = [r["_doc"] for r in met.rows[:6] if r.get("_doc")] + [r["_doc"] for r in docs.rows[:6] if r.get("_doc")]
    return out, raws


# ── System pages as items, one per line ───────────────────────────────────────

_TASK = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s+(.+?)\s*$")
_HEAD = re.compile(r"^\s{0,3}#{1,6}\s+(.*?)\s*$")
SYSTEM_LINES = 60


async def system_text(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, raw: dict) -> str | None:
    """A team's backlog page as its open items (from the backlog, as the asker may see them), grouped by category;
    a to-do page as its task lines, open first, under their headings (empty headings left out). None for other
    pages. ``raw`` is already decided readable."""
    from app.services import pages

    if raw.get("backlog_team_id"):
        from app.services import team_backlog

        team = await db["teams"].find_one({"_id": ai_index._oid(raw["backlog_team_id"])})
        if team is None:
            return None
        lead = actor.user_id in (team.get("lead_ids") or [])
        got = await team_backlog.items_for(db, team, actor.user, lead, include_done=False)
        items = got.get("items") or []
        if not items:
            return "The team's backlog has no open items."
        lines = [f"Open backlog items ({len(items)}), by category:"]
        for it in items[:SYSTEM_LINES]:
            owner = (it.get("owner") or {}).get("name")
            lines.append(f"- {it.get('category_label')}: {it.get('text')}" + (f" — {owner}" if owner else "")
                         + (f" ({it.get('status_label')})" if it.get("status") == "in_progress" else "")
                         + (f" · {it['mentions']} calls" if (it.get("mentions") or 0) > 1 else ""))
        if len(items) > SYSTEM_LINES:
            lines.append(f"(+{len(items) - SYSTEM_LINES} more)")
        return "\n".join(lines)
    if raw.get("todo_team_id") or raw.get("todo_user_id"):
        content = await pages.content_for(actor, raw, ctx) or ""
        head = None
        groups: list[tuple[str | None, list[tuple[bool, str]]]] = []
        for line in content.split("\n"):
            h = _HEAD.match(line)
            if h:
                head = ask_context.plain(h.group(1))
                continue
            m = _TASK.match(line)
            if not m:
                continue
            text = ask_context.plain(m.group(2))
            if not text:
                continue
            if not groups or groups[-1][0] != head:
                groups.append((head, []))
            groups[-1][1].append((m.group(1) != " ", text))
        if not groups:
            return None
        n_open = sum(1 for _h, xs in groups for d, _t in xs if not d)
        n_done = sum(1 for _h, xs in groups for d, _t in xs if d)
        lines = [f"To-dos: {n_open} open, {n_done} done."]
        shown = 0
        for h, xs in groups:
            xs = sorted(xs, key=lambda x: x[0])
            if h:
                lines.append(f"{h}:")
            for d, text in xs:
                if shown >= SYSTEM_LINES:
                    break
                lines.append(f"- [{'done' if d else 'open'}] {text}")
                shown += 1
        return "\n".join(lines)
    return None
