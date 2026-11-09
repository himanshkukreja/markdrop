"""Meetings into teams, and the one-time guided review (Teams, CONTRACT §4.6-4.7).

**Suggestions.** A team is suggested for a meeting when its members include at least two of the
attendees, or half (or more) of the attendees who are workspace members; or when earlier meetings of
the same series went to it. A mixed meeting goes to every matching team.

**On import** the suggestions are applied at once (``routing.state = "auto"``) — before the summary is
written and before anything is posted — so a team's meeting never sits company-wide waiting for someone
to confirm it. Whoever imports (or any editor) can change it: ``PUT /api/v1/meetings/{id}/teams``
(``state = "confirmed"``). A caller that names teams up front (``chosen``) skips the suggestion.
"""

from __future__ import annotations

import contextvars

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import teams as T

REVIEW_MAX = 200
SERIES_LOOKBACK = 20

# Teams the importer picked (the import routes set it around the import call); None: suggest.
chosen: contextvars.ContextVar[tuple[list[str], list[str]] | None] = contextvars.ContextVar("team_routing_chosen", default=None)


def _attendee_ids(row: dict) -> set[str]:
    return {a.get("user_id") for a in row.get("attendees") or [] if a.get("user_id")}


async def suggest(db: AsyncIOMotorDatabase, workspace_id: str, row: dict, teams: list[dict] | None = None) -> list[dict]:
    """``[{team_id, name, reason: attendees|series, matched}]`` best first."""
    teams = teams if teams is not None else await db[T.TEAMS].find({"workspace_id": workspace_id}).to_list(length=T.MAX_TEAMS + 10)
    if not teams:
        return []
    uids = _attendee_ids(row)
    members = {m["user_id"] for m in await db["memberships"].find(
        {"workspace_id": workspace_id, "user_id": {"$in": list(uids)}}, {"user_id": 1}).to_list(length=1000)} if uids else set()
    out: dict[str, dict] = {}
    for t in teams:
        matched = len(members & set(t.get("member_ids") or []))
        if matched and (matched >= 2 or matched * 2 >= len(members)):
            out[str(t["_id"])] = {"team_id": str(t["_id"]), "name": t.get("name"), "reason": "attendees", "matched": matched}
    series = (row.get("series") or "").strip()
    if series:
        q = {"workspace_id": workspace_id, "series": series, "team_ids": {"$exists": True}}
        if row.get("_id") is not None:
            q["_id"] = {"$ne": row["_id"]}
        names = {str(t["_id"]): t.get("name") for t in teams}
        async for r in db["meetings"].find(q, {"team_ids": 1}).sort("date", -1).limit(SERIES_LOOKBACK):
            for tid in r.get("team_ids") or []:
                if tid in names and tid not in out:
                    out[tid] = {"team_id": tid, "name": names[tid], "reason": "series", "matched": 0}
    return sorted(out.values(), key=lambda s: (s["reason"] != "series", -s["matched"], (s["name"] or "").casefold()))


async def route_new(db: AsyncIOMotorDatabase, row: dict) -> dict | None:
    """Called once a new meeting's pages exist (services/meetings._create_row)."""
    pick = chosen.get()
    if pick is not None:
        tids, pids = pick
        state, sug = "confirmed", []
    else:
        sug = await suggest(db, row["workspace_id"], row)
        if not sug:
            return None
        tids, pids, state = [s["team_id"] for s in sug], [], "auto"
    if not tids and not pids:
        return None
    raw = await db["documents"].find_one({"_id": row.get("doc_id")}, {"slug": 1, "parent_id": 1})
    if raw is None:
        return None
    await T.apply_to_doc(db, raw, tids, pids)
    routing = {"state": state, "suggestions": sug, "at": T.now_utc()}
    await db["meetings"].update_one({"_id": row["_id"]}, {"$set": {"routing": routing}})
    return routing


async def check_chosen(actor, ctx, workspace_id: str, team_ids: list[str], project_ids: list[str]) -> tuple[list[str], list[str]]:
    """Teams an importer picked: ones they're in (workspace admins: any)."""
    view = await ctx.team_view(workspace_id, actor.user_id)
    tids, pids = T._norm_sets(view, team_ids, project_ids)
    T.check_change(view, [], [], tids, pids)
    return tids, pids


async def annotate_preview(db: AsyncIOMotorDatabase, workspace_id: str, previews: list[dict]) -> None:
    """``team_suggestions`` on each previewed meeting, from its attendees' names (CONTRACT §4.6)."""
    from app.services import meetings
    from app.services import workspace_memory as wm

    people = meetings.People(await wm.members_of(db, workspace_id))
    teams = await db[T.TEAMS].find({"workspace_id": workspace_id}).to_list(length=T.MAX_TEAMS + 10)
    for p in previews:
        att = []
        for name in p.get("attendees") or []:
            m = people.match(name)
            if m:
                att.append({"user_id": m.get("id"), "name": name})
        p["team_suggestions"] = await suggest(db, workspace_id, {"attendees": att, "series": p.get("series")}, teams) if teams else []


async def meeting_teams(db: AsyncIOMotorDatabase, actor, ctx, row: dict) -> dict:
    ws = row["workspace_id"]
    view = await ctx.team_view(ws, actor.user_id)
    routing = row.get("routing") or {}
    sug = routing.get("suggestions") if routing.get("state") == "auto" else None
    if sug is None:
        sug = await suggest(db, ws, row, list(view.teams.values()))
    lab = T.labels(view, row)
    return {"team_ids": T.ids_of(row, "team_ids"), "project_ids": T.ids_of(row, "project_ids"),
            "teams": [x for x in lab if x["kind"] == "team"], "projects": [x for x in lab if x["kind"] == "project"],
            "state": routing.get("state"),
            "suggestions": [s for s in sug if s["team_id"] in view.readable_teams],
            "options": [T.team_card(view, t) for tid, t in view.teams.items() if view.admin or tid in view.member_teams]}


async def set_meeting_teams(db: AsyncIOMotorDatabase, actor, ctx, row: dict, team_ids, project_ids) -> dict:
    raw = await db["documents"].find_one({"_id": row.get("doc_id")})
    if raw is None:
        raise T.Refused(404, "Meeting not found")
    await T.set_item_teams(db, actor, ctx, raw, team_ids, project_ids)
    await db["meetings"].update_one({"_id": row["_id"]}, {"$set": {"routing.state": "confirmed", "routing.by": actor.user_id,
                                                                    "routing.at": T.now_utc()}})
    row = await db["meetings"].find_one({"_id": row["_id"]}, {"segments": 0})
    return await meeting_teams(db, actor, ctx, row)


# ── Guided review (admins) ───────────────────────────────────────────────────


async def review(db: AsyncIOMotorDatabase, view: T.TeamView) -> dict:
    if not view.admin:
        raise T.Refused(403, "Only workspace admins can do the review.")
    ws = view.workspace_id
    teams = list(view.teams.values())
    state = await db[T.REVIEW].find_one({"workspace_id": ws}) or {}
    ppl = await T.people(db, ws)
    meetings_out = []
    rows = await db["meetings"].find({"workspace_id": ws, "team_ids": {"$exists": False}, "project_ids": {"$exists": False}},
                                     {"segments": 0, "notes": 0, "generated": 0}).sort("date", -1).limit(REVIEW_MAX).to_list(length=REVIEW_MAX)
    for r in rows:
        sug = await suggest(db, ws, r, teams) if teams else []
        meetings_out.append({"id": str(r["_id"]), "title": r.get("title"), "date": r.get("date"), "series": r.get("series"),
                             "attendees": [a.get("name") for a in r.get("attendees") or [] if a.get("name")][:12],
                             "team_ids": [], "suggest": [s["team_id"] for s in sug],
                             "reason": sug[0]["reason"] if sug else None})
    # Pages: by the folder's team, else by the owner's single team.
    folders = {str(f["_id"]): f for f in await db["folders"].find({"workspace_id": ws}).to_list(length=5000)}
    by_member: dict[str, list[str]] = {}
    for t in teams:
        for u in t.get("member_ids") or []:
            by_member.setdefault(u, []).append(str(t["_id"]))
    pages_out = []
    meeting_docs = {r.get("doc_id") for r in rows} | {r.get("transcript_doc_id") for r in rows}
    docs = await db["documents"].find(
        {"workspace_id": ws, "team_ids": {"$exists": False}, "project_ids": {"$exists": False}, "deleted_at": None,
         "parent_id": None, "template": {"$ne": True}, "hidden_in_listings": {"$ne": True}, "access_level": {"$ne": "private"}},
        {"content": 0}).sort("updated_at", -1).limit(REVIEW_MAX * 2).to_list(length=REVIEW_MAX * 2)
    for d in docs:
        if d["_id"] in meeting_docs or len(pages_out) >= REVIEW_MAX:
            continue
        f = folders.get(d.get("folder_id") or "")
        sug, reason = [], None
        if f is not None and T.ids_of(f, "team_ids"):
            sug, reason = T.ids_of(f, "team_ids"), "folder"
        elif len(by_member.get(d.get("owner_id") or "", [])) == 1:
            sug, reason = by_member[d["owner_id"]], "author"
        pages_out.append({"id": str(d["_id"]), "slug": d.get("slug"), "title": d.get("title") or d.get("original_filename"),
                          "kind": "page" if d.get("editor") == "blocks" else ("file" if d.get("kind") == "artifact" else "doc"),
                          "folder": {"id": str(f["_id"]), "name": f.get("name")} if f else None,
                          "owner": ppl.get(d.get("owner_id") or ""), "team_ids": [], "suggest": sug, "reason": reason})
    folders_out = []
    for fid, f in folders.items():
        if T.ids_of(f, "team_ids") or T.ids_of(f, "project_ids"):
            continue
        owners = [o["owner_id"] async for o in db["documents"].find(
            {"workspace_id": ws, "folder_id": fid, "deleted_at": None}, {"owner_id": 1}).limit(200)]
        counts: dict[str, int] = {}
        for o in owners:
            for tid in by_member.get(o or "", []):
                counts[tid] = counts.get(tid, 0) + 1
        top = [t for t, n in counts.items() if owners and n * 3 >= len(owners) * 2]
        folders_out.append({"id": fid, "name": f.get("name"), "item_count": len(owners), "suggest": top[:1],
                            "reason": "author" if top else None})
    return {"suggested_teams": await T.suggested(db, view), "meetings": meetings_out, "pages": pages_out,
            "folders": folders_out[:REVIEW_MAX], "done": bool(state.get("done_at"))}


async def apply(db: AsyncIOMotorDatabase, actor, ctx, view: T.TeamView, moves: list[dict]) -> dict:
    if not view.admin:
        raise T.Refused(403, "Only workspace admins can do the review.")
    ws = view.workspace_id
    n = 0
    for mv in moves[:1000]:
        kind, ident, tids = mv.get("kind"), mv.get("id"), mv.get("team_ids") or []
        if kind == "folder":
            await T.set_folder_teams(db, actor, ctx, ws, ident, tids, [], True)
            n += 1
            continue
        if kind == "meeting":
            row = await db["meetings"].find_one({"_id": T.oid(ident), "workspace_id": ws}, {"segments": 0})
            if row is None:
                continue
            await set_meeting_teams(db, actor, ctx, row, tids, [])
            n += 1
            continue
        if kind == "page":
            raw = await db["documents"].find_one({"_id": T.oid(ident), "workspace_id": ws})
            if raw is None:
                continue
            await T.set_item_teams(db, actor, ctx, raw, tids, [])
            n += 1
    return {"applied": n}


async def done(db: AsyncIOMotorDatabase, view: T.TeamView) -> None:
    if not view.admin:
        raise T.Refused(403, "Only workspace admins can do the review.")
    await db[T.REVIEW].update_one({"workspace_id": view.workspace_id}, {"$set": {"done_at": T.now_utc()}}, upsert=True)


async def pending(db: AsyncIOMotorDatabase, view: T.TeamView) -> dict | None:
    """The sidebar chip: admins, once teams exist, until the review is marked done."""
    if not view.admin or not view.teams:
        return None
    state = await db[T.REVIEW].find_one({"workspace_id": view.workspace_id}) or {}
    if state.get("done_at"):
        return None
    n = await db["meetings"].count_documents({"workspace_id": view.workspace_id, "team_ids": {"$exists": False},
                                              "project_ids": {"$exists": False}}, limit=REVIEW_MAX)
    return {"pending": n}
