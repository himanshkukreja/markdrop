"""Team briefs — the weekly bridge between teams (Teams, CONTRACT §4.5).

Every Monday (9 am, workspace time; the same loop as Team's weekly summary) each team gets a brief of
last week: highlights, decisions and blockers from **its** memory — only lines whose source is a team
item every member of the team can read (workspace or link access, no password, no restricted meeting),
so a brief never carries what a 1:1 or a private page said. It is written by the same Team memory AI
under its existing limit (rule-based lines without it) and published at once.

Every workspace member can read every team's brief (a private team's too: that is the bridge), but a
line's sources are shown only to people who may open them. Leads (and workspace admins) can edit, hide
or add lines at any time; a re-draft keeps their edits. With the team's digest on, a published brief is
emailed to its members and posted to its Slack channel.
"""

from __future__ import annotations

import html
import logging
import uuid
from datetime import datetime

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import access
from app.services import teams as T
from app.services import workspace_memory as wm

log = logging.getLogger("markdrop.team_briefs")

LINE_MAX = 300
MAX_LINES = 30


def _kind(h: dict) -> str:
    from app.services import team_extras

    if h.get("kind") == "decision":
        return "decision"
    if team_extras._SHIPPED.search(h.get("text") or ""):
        return "shipped"
    return "focus" if h.get("kind") == "working_on" else "update"


def _src(x: dict | None) -> dict | None:
    if not x or not x.get("href"):
        return None
    return {"title": x.get("title"), "href": x["href"]}


async def _tz(db: AsyncIOMotorDatabase, workspace_id: str):
    from app.services import team_extras

    wsrow = await db["workspaces"].find_one({"_id": T.oid(workspace_id)}, {"settings": 1}) or {}
    return team_extras.tz_of((wsrow.get("settings") or {}).get("timezone"))


async def draft(db: AsyncIOMotorDatabase, team: dict, *, now: datetime | None = None, ai: bool = True) -> dict | None:
    """Compose (or re-compose) this week's brief of ``team`` and publish it. None: Team memory is off."""
    from app.services import team_extras

    ws_id = team["workspace_id"]
    ws = await wm.ws_info(db, ws_id)
    if ws is None or not ws.on:
        return None
    now = now or T.now_utc()
    view = await T.load_view(db, ws_id, None, "owner")
    space = T.Space("team", str(team["_id"]))
    s = await team_extras.compose(db, ws, await _tz(db, ws_id), now, ai=ai and ws.ai_on, summary=True, team=(view, space))
    lines: list[dict] = []
    for h in s["highlights"]:
        lines.append({"kind": _kind(h), "text": h["text"], "person_id": (h.get("person") or {}).get("id"),
                      "sources": [x for x in (_src(y) for y in h.get("sources") or []) if x]})
    for d in s["decisions"]:
        lines.append({"kind": "decision", "text": d["text"], "person_id": (d.get("person") or {}).get("id"),
                      "sources": [x for x in [_src(d.get("source"))] if x]})
    for b in s["blockers"]:
        lines.append({"kind": "blocker", "text": b["text"], "person_id": (b.get("person") or {}).get("id"),
                      "sources": [x for x in [_src(b.get("source"))] if x]})
    old = await db[T.BRIEFS].find_one({"team_id": str(team["_id"]), "week": s["week"]})
    kept = [ln for ln in (old or {}).get("lines") or [] if ln.get("edited_by")]
    hidden = {wm.norm(ln.get("original") or ln["text"]) for ln in (old or {}).get("lines") or [] if ln.get("hidden")}
    seen = {wm.norm(ln.get("original") or ln["text"]) for ln in kept}
    out = list(kept)
    for ln in lines:
        n = wm.norm(ln["text"])
        if n in seen:
            continue
        seen.add(n)
        out.append({"id": uuid.uuid4().hex[:12], **ln, "text": wm.clean(ln["text"], LINE_MAX), "hidden": n in hidden,
                    "edited_by": None, "edited_at": None, "original": None})
    start = datetime.fromisoformat(s["highlights_from"])
    row = {"workspace_id": ws_id, "team_id": str(team["_id"]), "week": s["week"],
           "label": f"Week of {start.strftime('%b')} {start.day}", "lines": out[:MAX_LINES],
           "generated_at": now, "published_at": (old or {}).get("published_at") or now, "ai": bool(ai and ws.ai_on)}
    await db[T.BRIEFS].update_one({"team_id": row["team_id"], "week": row["week"]}, {"$set": row}, upsert=True)
    return await db[T.BRIEFS].find_one({"team_id": row["team_id"], "week": row["week"]})


async def brief_out(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, view: T.TeamView, row: dict,
                    ppl: dict[str, dict] | None = None) -> dict:
    can_edit = view.can_manage(row["team_id"])
    ppl = ppl if ppl is not None else await T.people(db, row["workspace_id"])
    slugs = {src["href"].lstrip("/").split("#")[0] for ln in row.get("lines") or [] for src in ln.get("sources") or []}
    ok: set[str] = set()
    if slugs:
        for d in await db["documents"].find({"slug": {"$in": list(slugs)}}, {"content": 0}).to_list(length=len(slugs)):
            if not d.get("deleted_at") and await access.discoverable(actor, d, ctx):
                ok.add(d["slug"])
    lines = []
    for ln in row.get("lines") or []:
        if ln.get("hidden") and not can_edit:
            continue
        item = {"id": ln["id"], "kind": ln.get("kind") or "update", "text": ln["text"],
                "person": ppl.get(ln.get("person_id") or ""), "edited": bool(ln.get("edited_by")),
                "sources": [s for s in ln.get("sources") or [] if s["href"].lstrip("/").split("#")[0] in ok]}
        if can_edit:
            item["hidden"] = bool(ln.get("hidden"))
        lines.append(item)
    return {"id": str(row["_id"]), "team_id": row["team_id"], "week": row["week"], "label": row.get("label"),
            "published_at": row.get("published_at"), "ai": bool(row.get("ai")), "can_edit": can_edit, "lines": lines}


async def list_briefs(db: AsyncIOMotorDatabase, team_id: str, limit: int = 8) -> list[dict]:
    rows = await db[T.BRIEFS].find({"team_id": team_id}).sort("week", -1).limit(limit).to_list(length=limit)
    return [{"id": str(r["_id"]), "week": r["week"], "label": r.get("label"), "published_at": r.get("published_at"),
             "line_count": sum(1 for ln in r.get("lines") or [] if not ln.get("hidden"))} for r in rows]


async def get_brief(db: AsyncIOMotorDatabase, team_id: str, ref: str) -> dict | None:
    if ref == "latest":
        return await db[T.BRIEFS].find_one({"team_id": team_id}, sort=[("week", -1)])
    o = T.oid(ref)
    if o is not None:
        return await db[T.BRIEFS].find_one({"_id": o, "team_id": team_id})
    return await db[T.BRIEFS].find_one({"team_id": team_id, "week": ref})


async def edit_line(db: AsyncIOMotorDatabase, view: T.TeamView, row: dict, line_id: str, *, text: str | None = None,
                    hidden: bool | None = None) -> dict:
    if not view.can_manage(row["team_id"]):
        raise T.Refused(403, "Only the team's leads and workspace admins can edit its brief.")
    lines = row.get("lines") or []
    ln = next((x for x in lines if x["id"] == line_id), None)
    if ln is None:
        raise T.Refused(404, "Line not found.")
    if text is not None:
        t = wm.clean(text, LINE_MAX)
        if not t:
            raise T.Refused(422, "A line needs text (hide it instead).")
        if t != ln["text"]:
            ln["original"] = ln.get("original") or ln["text"]
            ln["text"] = t
            ln["edited_by"], ln["edited_at"] = view.uid, T.now_utc()
    if hidden is not None:
        ln["hidden"] = bool(hidden)
    await db[T.BRIEFS].update_one({"_id": row["_id"]}, {"$set": {"lines": lines}})
    return await db[T.BRIEFS].find_one({"_id": row["_id"]})


async def add_line(db: AsyncIOMotorDatabase, view: T.TeamView, row: dict, text: str, kind: str | None = None) -> dict:
    if not view.can_manage(row["team_id"]):
        raise T.Refused(403, "Only the team's leads and workspace admins can edit its brief.")
    t = wm.clean(text, LINE_MAX)
    if not t:
        raise T.Refused(422, "A line needs text.")
    if len(row.get("lines") or []) >= MAX_LINES:
        raise T.Refused(409, f"A brief has at most {MAX_LINES} lines.")
    kind = kind if kind in ("shipped", "decision", "update", "blocker", "focus", "note") else "note"
    ln = {"id": uuid.uuid4().hex[:12], "kind": kind, "text": t, "person_id": view.uid, "sources": [], "hidden": False,
          "edited_by": view.uid, "edited_at": T.now_utc(), "original": None}
    await db[T.BRIEFS].update_one({"_id": row["_id"]}, {"$push": {"lines": ln}})
    return await db[T.BRIEFS].find_one({"_id": row["_id"]})


# ── Weekly + digest ──────────────────────────────────────────────────────────


async def weekly(db: AsyncIOMotorDatabase, ws: wm.WsInfo, now: datetime | None = None) -> int:
    """Monday from 9 am (workspace time): each team without this week's brief gets one (+ its digest)."""
    from app.services import team_extras

    now = now or T.now_utc()
    local = now.astimezone(await _tz(db, ws.id))
    if local.weekday() != 0 or local.hour < team_extras.WEEKLY_HOUR:
        return 0
    week = team_extras.week_key(local.date())
    n = 0
    async for team in db[T.TEAMS].find({"workspace_id": ws.id}):
        if await db[T.BRIEFS].find_one({"team_id": str(team["_id"]), "week": week}, {"_id": 1}) is not None:
            continue
        try:
            row = await draft(db, team, now=now)
        except Exception:
            log.warning("team brief of %s failed", team["_id"], exc_info=True)
            continue
        if row is not None:
            n += 1
            await digest(db, team, row)
    return n


async def digest(db: AsyncIOMotorDatabase, team: dict, row: dict) -> dict:
    """The brief to the team's members (email) and its Slack channel, when the team's digest is on."""
    from app.services import mailer, slack, slack_api, urls

    d = team.get("digest") or {"enabled": True, "email": True, "slack": True}
    out = {"emails": 0, "slack": None}
    lines = [ln for ln in row.get("lines") or [] if not ln.get("hidden")]
    if not d.get("enabled", True) or not lines:
        return out
    ws = await db["workspaces"].find_one({"_id": T.oid(team["workspace_id"])}, {"name": 1}) or {}
    link = urls.markdrop_url(f"w/{team['workspace_id']}/teams/{team.get('slug')}")
    title = f"{team.get('name')} — {row.get('label') or 'This week'}"
    if d.get("slack", True) and (team.get("slack_channel") or {}).get("id"):
        inst = await slack.install_for_workspace(db, team["workspace_id"])
        token = slack.bot_token(inst) if inst else None
        if token:
            text = f"*{title}*\n" + "\n".join(f"• {ln['text']}" for ln in lines[:12]) + f"\n<{link}|Open the team>"
            try:
                await slack_api.call("chat.postMessage", token, channel=team["slack_channel"]["id"], text=text,
                                     unfurl_links=False, unfurl_media=False)
                out["slack"] = "posted"
            except Exception as exc:
                out["slack"] = getattr(exc, "error", "failed")
    if d.get("email", True) and mailer.is_configured():
        users = await db["users"].find({"_id": {"$in": [T.oid(u) for u in team.get("member_ids") or [] if T.oid(u)]}},
                                       {"email": 1}).to_list(length=500)
        body = (f"<h2 style=\"font:600 18px system-ui\">{html.escape(title)}</h2><ul>"
                + "".join(f"<li style=\"font:15px system-ui;margin:6px 0\">{html.escape(ln['text'])}</li>" for ln in lines[:20])
                + f"</ul><p><a href=\"{html.escape(link)}\">Open {html.escape(team.get('name') or 'the team')} in Markdrop</a></p>")
        text = title + "\n\n" + "\n".join(f"- {ln['text']}" for ln in lines[:20]) + f"\n\n{link}"
        for u in users:
            if not u.get("email"):
                continue
            try:
                await mailer._post({"from": mailer._sender("share"), "to": [u["email"]],
                                    "subject": f"{title} · {ws.get('name') or 'Markdrop'}",
                                    "reply_to": mailer.settings.email_reply_to, "html": body, "text": text},
                                   kind="digest", ref=f"teambrief:{row['_id']}")
                out["emails"] += 1
            except Exception:
                log.warning("team brief email failed", exc_info=True)
    await db[T.BRIEFS].update_one({"_id": row["_id"]}, {"$set": {"delivery": out}})
    return out
