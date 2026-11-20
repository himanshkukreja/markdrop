"""Person cards (AI quality stage 4): one member at a glance, as this reader may see them.

    GET /api/v1/people/{user_id}/card?workspace=   hover / click on a person (mentions, avatars, Team and People pages)
    Ask: a question about a person brings their card(s) on ``done.people`` (rendered above the answer)
    MCP ``person_card`` (app/mcp/index_tools.py)

The card: name, avatar, workspace role, title (Team memory's role line), teams (only teams the reader can open, with
"lead"), how many documents they created and the newest, the meetings they attended in the last
:data:`RECENT_DAYS` days, their open action items (and how many look done), and what Team memory says they are
working on. Every list comes from Ask's facts index (services/ai_index.py) decided for this reader
(``access.discoverable`` per document, the request's team space); names and titles only of things the reader may
open; Team memory lines through ``workspace_memory.person_profile`` (its own per-source visibility).

Only a member of a workspace the person is in gets a card (else 404): the people list of a workspace is open to its
members, nothing more.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import access, ai_index

log = logging.getLogger("markdrop.person_cards")

RECENT_DAYS = 14
DOCS = 5
MEETINGS = 5
ITEMS = 5
WORKING_ON = 4


async def shared_workspace(db: AsyncIOMotorDatabase, ctx: access.Ctx, viewer: str, user_id: str,
                           prefer: str | None = None) -> str | None:
    """A workspace both are members of (``prefer`` first), with AI-side features allowed for the reader."""
    mine = {m["workspace_id"] async for m in db["memberships"].find({"user_id": viewer}, {"workspace_id": 1})}
    theirs = {m["workspace_id"] async for m in db["memberships"].find({"user_id": user_id}, {"workspace_id": 1})}
    both = mine & theirs
    if prefer and prefer in both:
        return prefer
    return sorted(both)[0] if both else None


def _fmt(d) -> str:
    from app.services import ask_route

    return ask_route._fmt(d)


async def card(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, workspace_id: str, user_id: str, *,
               names=None, teams: dict | None = None, memory: bool = True, big: bool = False) -> dict | None:
    """The card, or None when the reader isn't a member of the workspace or the person isn't in it."""
    from app.services import ask_route, likely_done, urls, workspace_memory

    viewer = actor.user_id
    if not viewer or await ctx.role(workspace_id, viewer) is None:
        return None
    members = await workspace_memory.members_of(db, workspace_id)
    m = next((x for x in members if x["id"] == user_id), None)
    if m is None:
        return None
    wss = [workspace_id]
    if teams is None:
        teams = await ask_route._team_names(ctx, viewer, wss)
    if names is None:
        names = ask_route._Names(db, actor, ctx)
        await names.load(wss)
    tms = sorted(({"id": tid, "name": t.get("name"), "lead": user_id in (t.get("lead_ids") or [])}
                  for tid, t in teams.items() if user_id in (t.get("member_ids") or [])), key=lambda t: (not t["lead"], t["name"] or ""))

    def link(raw: dict | None, block: str | None = None) -> str | None:
        slug = (raw or {}).get("slug")
        return urls.markdrop_url(slug) + (f"#{block}" if block else "") if slug else None

    n_docs, n_meet, n_items = (8, 10, 8) if big else (DOCS, MEETINGS, ITEMS)      # Ask reads more than a hover shows
    created = await ai_index.query(db, actor, ctx, ai_index.Filter(kind="doc", workspaces=wss, creator=user_id, limit=n_docs))
    now = ctx.now if getattr(ctx, "now", None) else datetime.now(timezone.utc)
    since = now.date() - timedelta(days=RECENT_DAYS)
    met = await ai_index.query(db, actor, ctx, ai_index.Filter(kind="meeting", workspaces=wss, attendee=user_id,
                                                               since=since, limit=n_meet))
    acts = await ai_index.query(db, actor, ctx, ai_index.Filter(kind="action", workspaces=wss, owner=user_id, done=False,
                                                                limit=n_items))
    evs = await ask_route._likely(db, actor, ctx, acts.rows) if acts.rows else {}
    out = {
        "id": user_id, "name": m.get("name") or "Member", "avatar_url": m.get("avatar_url"), "role": m.get("role"),
        "title": None, "you": user_id == viewer, "workspace_id": workspace_id,
        "profile_url": f"/team/{workspace_id}/people/{user_id}",
        "teams": tms,
        "created": {"total": created.total, "items": [
            {"title": r.get("title") or "Untitled", "kind": r.get("kind"), "url": link(r.get("_doc")),
             "updated": ai_index._day(r.get("updated")), "status": r.get("status")} for r in created.rows]},
        "meetings": {"days": RECENT_DAYS, "total": met.total, "items": [
            {"title": r.get("mtitle") or r.get("title") or "Meeting", "date": r.get("date"), "url": link(r.get("_doc"))}
            for r in met.rows]},
        "open_items": {"total": acts.total, "likely_done": len(evs), "items": [
            {"text": _own(r.get("text"), m.get("name")), "on": r.get("title"), "url": link(r.get("_doc"), r.get("block")), "due": r.get("due"),
             "likely_done": likely_done.note(evs[r["_id"]]) if r["_id"] in evs else None} for r in acts.rows]},
        "working_on": [],
    }
    if memory:
        try:
            info = await workspace_memory.ws_info(db, workspace_id)
            if info is not None and info.on:
                prof = await workspace_memory.person_profile(db, actor, ctx, info, user_id)
                if prof:
                    out["title"] = (prof.get("person") or {}).get("title")
                    lines = [x.get("text") for x in (prof.get("working_on") or [])[:WORKING_ON]]
                    lines += [x.get("text") for x in (prof.get("updates") or [])[:3]]
                    out["working_on"] = [x for x in dict.fromkeys(lines) if x][:WORKING_ON + 2]
        except Exception:
            log.warning("person card: memory failed", exc_info=True)
    return out


def _own(text: str | None, name: str | None) -> str | None:
    """An action item's text without its owner's name in front ("Riya Sharma Draft the pilot" → "Draft the pilot")."""
    t = (text or "").strip()
    n = (name or "").strip()
    if n and t.casefold().startswith(n.casefold()):
        rest = t[len(n):].lstrip(" :–-")
        return rest[:1].upper() + rest[1:] if rest else t
    return text


def text_lines(c: dict) -> tuple[str, list[str]]:
    """The card as a heading and lines (Ask's index block, MCP)."""
    tms = [f"{t['name']}{' (lead)' if t.get('lead') else ''}" for t in c.get("teams") or []]
    head = f"Person: {c['name']}" + (f" — teams: {', '.join(tms)}" if tms else " — no team the asker can see")
    if c.get("title"):
        head += f" — {c['title']}"
    rows: list[str] = []
    cr = c.get("created") or {}
    if cr.get("total"):
        rows.append(f"Created {cr['total']} document{'s' if cr['total'] != 1 else ''} (newest: "
                    + "; ".join(f"{d['title']} ({_fmt(d.get('updated'))}" + (f", {d['status']}" if d.get("status") else "") + ")"
                                for d in cr.get("items") or []) + ")")
    mt = c.get("meetings") or {}
    if mt.get("total"):
        rows.append(f"Meetings in the last {mt.get('days')} days: {mt['total']} ("
                    + "; ".join(f"{_fmt(x.get('date'))} {x['title']}" for x in mt.get("items") or []) + ")")
    oi = c.get("open_items") or {}
    if oi.get("total"):
        rows.append(f"Open action items: {oi['total']}" + (f", {oi['likely_done']} of them likely done (not ticked)" if oi.get("likely_done") else "")
                    + " (" + "; ".join(f"{x['text']} — {x.get('on')}" + (f", due {_fmt(x['due'])}" if x.get("due") else "")
                                       + (f" [{x['likely_done']}]" if x.get("likely_done") else "") for x in oi.get("items") or []) + ")")
    if c.get("working_on"):
        rows.append("Team memory, working on / recent: " + "; ".join(c["working_on"]))
    return head, rows
