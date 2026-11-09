"""Teams inside a workspace (Sales, Marketing, Engineering…) — spec .work/briefs/teams-v1.md, contract .work/teams/CONTRACT.md.

    routers/teams.py        /api/v1/workspaces/{ws}/teams…, /projects…, /items/{id}/teams, /teams-review…
    mcp/teams_tools.py      list_teams, get_team, create_team, … (CONTRACT §8)
    services/access.py      ``Facts.team_ok`` + :func:`clause` inside ``readable_filter`` (the one access rule)

The workspace is the company (login, members, limits, people, company-wide pages). Teams live inside it, each
with its own space: items carry ``team_ids`` / ``project_ids`` (absent ⇒ company-wide, never stored empty).

**The rule** (CONTRACT §2): an item with teams is open to the workspace membership only when the viewer can read
one of its teams or projects — every team they belong to, every *open* team, every open project of a readable
team and every project they are a member of; workspace admins read all. Reading only through an *open* team or
project (not a member of any of the item's teams/projects) gives viewer, not editor. Owner, people grants, the
edit secret and the link level are untouched: a deliberate share keeps working; team privacy governs discovery
(listings, search, Ask, memory) — :func:`access.discoverable`.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase

TEAMS = "teams"
PROJECTS = "team_projects"
BRIEFS = "team_briefs"
REVIEW = "team_review"

MAX_TEAMS = 100
MAX_PROJECTS = 200
NAME_MAX = 60
DESC_MAX = 280
MAX_JIRA = 10
COLORS = ("blue", "green", "amber", "red", "violet", "pink", "teal", "gray")
VISIBILITY = ("open", "private")


class Refused(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status, self.detail = status, detail


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def oid(v: Any) -> ObjectId | None:
    if isinstance(v, ObjectId):
        return v
    try:
        return ObjectId(str(v))
    except Exception:
        return None


def slugify(name: str) -> str:
    s = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode("ascii").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s[:40] or "team"


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[TEAMS].create_index([("workspace_id", 1), ("slug", 1)], unique=True)
    await db[TEAMS].create_index([("workspace_id", 1), ("member_ids", 1)])
    await db[PROJECTS].create_index([("workspace_id", 1), ("slug", 1)], unique=True)
    await db[PROJECTS].create_index([("workspace_id", 1), ("team_ids", 1)])
    await db[BRIEFS].create_index([("team_id", 1), ("week", 1)], unique=True)
    await db["documents"].create_index("team_ids", sparse=True)
    await db["documents"].create_index("project_ids", sparse=True)


# ── The rule ──────────────────────────────────────────────────────────────────


def ids_of(doc: dict | None, key: str) -> list[str]:
    v = (doc or {}).get(key)
    return [str(x) for x in v] if isinstance(v, list) else []


def company_wide(doc: dict | None) -> bool:
    return not ids_of(doc, "team_ids") and not ids_of(doc, "project_ids")


@dataclass
class TeamView:
    """What one person can see of one workspace's teams (cached per request on ``access.Ctx``)."""

    workspace_id: str
    uid: str | None
    admin: bool = False
    teams: dict[str, dict] = field(default_factory=dict)          # id → team row (all of the workspace)
    projects: dict[str, dict] = field(default_factory=dict)       # id → project row
    member_teams: set[str] = field(default_factory=set)
    readable_teams: set[str] = field(default_factory=set)
    member_projects: set[str] = field(default_factory=set)
    readable_projects: set[str] = field(default_factory=set)

    def lead_of(self, tid: str) -> bool:
        t = self.teams.get(tid)
        return bool(t and self.uid and self.uid in (t.get("lead_ids") or []))

    def can_manage(self, tid: str) -> bool:
        return self.admin or self.lead_of(tid)

    def team_readable(self, tid: str) -> bool:
        return tid in self.readable_teams

    def project_readable(self, pid: str) -> bool:
        return pid in self.readable_projects


def project_members(p: dict, teams: dict[str, dict]) -> set[str]:
    out = set(p.get("member_ids") or [])
    for tid in p.get("team_ids") or []:
        out.update((teams.get(str(tid)) or {}).get("member_ids") or [])
    return out


def build_view(workspace_id: str, uid: str | None, role: str | None, teams: list[dict], projects: list[dict]) -> TeamView:
    from app.models.workspace import role_allows

    v = TeamView(workspace_id, uid, admin=role_allows(role, "admin"))
    v.teams = {str(t["_id"]): t for t in teams}
    v.projects = {str(p["_id"]): p for p in projects}
    for tid, t in v.teams.items():
        mine = bool(uid) and uid in (t.get("member_ids") or [])
        if mine:
            v.member_teams.add(tid)
        if v.admin or mine or t.get("visibility") == "open":
            v.readable_teams.add(tid)
    for pid, p in v.projects.items():
        mine = bool(uid) and uid in project_members(p, v.teams)
        if mine:
            v.member_projects.add(pid)
        linked_readable = any(str(t) in v.readable_teams for t in p.get("team_ids") or [])
        if v.admin or mine or (p.get("visibility") == "open" and linked_readable):
            v.readable_projects.add(pid)
    return v


async def load_view(db: AsyncIOMotorDatabase, workspace_id: str, uid: str | None, role: str | None) -> TeamView:
    teams = await db[TEAMS].find({"workspace_id": workspace_id}).to_list(length=MAX_TEAMS + 10)
    projects = await db[PROJECTS].find({"workspace_id": workspace_id}).to_list(length=MAX_PROJECTS + 10)
    return build_view(workspace_id, uid, role, teams, projects)


def item_ok(view: TeamView, doc: dict | None) -> bool:
    """CONTRACT §2: company-wide, or admin, or one readable team / project."""
    if company_wide(doc) or view.admin:
        return True
    return (any(t in view.readable_teams for t in ids_of(doc, "team_ids"))
            or any(p in view.readable_projects for p in ids_of(doc, "project_ids")))


def item_member(view: TeamView, doc: dict | None) -> bool:
    """A member of one of its teams/projects (or admin, or company-wide): edits like today."""
    if company_wide(doc) or view.admin:
        return True
    return (any(t in view.member_teams for t in ids_of(doc, "team_ids"))
            or any(p in view.member_projects for p in ids_of(doc, "project_ids")))


def clause(view: TeamView | None) -> dict | None:
    """Mongo: the rows of this workspace :func:`item_ok` admits (None: no narrowing, i.e. admin)."""
    if view is not None and view.admin:
        return None
    teams = sorted(view.readable_teams) if view else []
    projects = sorted(view.readable_projects) if view else []
    ors: list[dict] = [{"team_ids": None, "project_ids": None}]
    if teams:
        ors.append({"team_ids": {"$in": teams}})
    if projects:
        ors.append({"project_ids": {"$in": projects}})
    return {"$or": ors}


def multi_clause(views: list[TeamView]) -> dict:
    """Search across several workspaces: the union of the readable teams (ids are global)."""
    teams = sorted({t for v in views for t in v.readable_teams})
    projects = sorted({p for v in views for p in v.readable_projects})
    ors: list[dict] = [{"team_ids": None, "project_ids": None}]
    if teams:
        ors.append({"team_ids": {"$in": teams}})
    if projects:
        ors.append({"project_ids": {"$in": projects}})
    return {"$or": ors}


# ── Spaces (CONTRACT §3) ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class Space:
    kind: str = "all"          # all | company | team | project
    id: str | None = None

    @property
    def key(self) -> str:
        return f"{self.kind}:{self.id}" if self.id else self.kind


def parse_space(raw: str | None) -> Space:
    s = (raw or "").strip()
    if not s or s == "all":
        return Space()
    if s == "company":
        return Space("company")
    kind, _, ident = s.partition(":")
    if kind in ("team", "project") and ident and oid(ident) is not None:
        return Space(kind, ident)
    raise ValueError("space must be all, company, team:<id> or project:<id>")


def space_ok(view: TeamView, space: Space) -> bool:
    if space.kind == "team":
        return space.id in view.readable_teams
    if space.kind == "project":
        return space.id in view.readable_projects
    return True


def team_project_ids(view: TeamView, tid: str) -> list[str]:
    return [pid for pid, p in view.projects.items() if tid in [str(t) for t in p.get("team_ids") or []]]


def space_clause(view: TeamView, space: Space) -> dict | None:
    """Mongo narrowing for a space (None for ``all``). The caller already applied the rule."""
    if space.kind == "all":
        return None
    if space.kind == "company":
        return {"team_ids": None, "project_ids": None}
    if space.kind == "project":
        return {"project_ids": space.id}
    pids = team_project_ids(view, space.id or "")
    ors: list[dict] = [{"team_ids": space.id}]
    if pids:
        ors.append({"project_ids": {"$in": pids}})
    return {"$or": ors}


def in_space(view: TeamView, space: Space, doc: dict | None) -> bool:
    if space.kind == "all":
        return True
    if space.kind == "company":
        return company_wide(doc)
    if space.kind == "project":
        return space.id in ids_of(doc, "project_ids")
    if space.id in ids_of(doc, "team_ids"):
        return True
    pids = set(team_project_ids(view, space.id or ""))
    return bool(pids & set(ids_of(doc, "project_ids")))


def labels(view: TeamView | None, doc: dict | None) -> list[dict]:
    """``[{id, name, color, icon, kind}]`` of the item's teams/projects the viewer may read (for chips)."""
    if view is None:
        return []
    out = []
    for tid in ids_of(doc, "team_ids"):
        t = view.teams.get(tid)
        if t is not None and tid in view.readable_teams:
            out.append({"id": tid, "kind": "team", "name": t.get("name"), "color": t.get("color"), "icon": t.get("icon")})
    for pid in ids_of(doc, "project_ids"):
        p = view.projects.get(pid)
        if p is not None and pid in view.readable_projects:
            out.append({"id": pid, "kind": "project", "name": p.get("name"), "color": p.get("color"), "icon": p.get("icon")})
    return out


# ── Cards ─────────────────────────────────────────────────────────────────────


def _person(p: dict) -> dict:
    return {"id": p["id"], "name": p.get("name"), "email": p.get("email"), "picture": p.get("avatar_url")}


async def people(db: AsyncIOMotorDatabase, workspace_id: str) -> dict[str, dict]:
    from app.services import workspace as ws_service

    return {p["id"]: _person(p) for p in await ws_service.mention_people(db, workspace_id, viewer_id=None, emails=True)}


def team_card(view: TeamView, t: dict) -> dict:
    tid = str(t["_id"])
    uid = view.uid
    my_role = ("lead" if uid in (t.get("lead_ids") or []) else "member" if uid in (t.get("member_ids") or []) else None) if uid else None
    readable = tid in view.readable_teams
    return {"id": tid, "name": t.get("name"), "slug": t.get("slug"), "icon": t.get("icon"), "color": t.get("color") or "blue",
            "description": t.get("description") or "", "visibility": t.get("visibility") or "open",
            "member_count": len(t.get("member_ids") or []), "lead_ids": list(t.get("lead_ids") or []), "my_role": my_role,
            "can_read": readable, "can_manage": view.can_manage(tid), "can_admin": view.admin,
            "project_ids": team_project_ids(view, tid) if readable else []}


def team_full(view: TeamView, t: dict, ppl: dict[str, dict]) -> dict:
    out = team_card(view, t)
    if not out["can_read"]:
        return out
    leads = set(t.get("lead_ids") or [])
    out.update(
        members=[{**ppl[u], "role": "lead" if u in leads else "member"} for u in (t.get("member_ids") or []) if u in ppl],
        slack_channel=t.get("slack_channel"), jira_projects=list(t.get("jira_projects") or []),
        digest=t.get("digest") or {"enabled": True, "email": True, "slack": True},
        admins_can_see=True, created_at=t.get("created_at"))
    return out


def project_card(view: TeamView, p: dict) -> dict:
    pid = str(p["_id"])
    uid = view.uid
    members = project_members(p, view.teams)
    my_role = ("lead" if uid in (p.get("lead_ids") or []) else "member" if uid in members else None) if uid else None
    return {"id": pid, "name": p.get("name"), "slug": p.get("slug"), "icon": p.get("icon"), "color": p.get("color") or "violet",
            "description": p.get("description") or "", "team_ids": [str(t) for t in p.get("team_ids") or []],
            "visibility": p.get("visibility") or "open", "status": p.get("status") or "active",
            "member_count": len(members), "my_role": my_role, "can_read": pid in view.readable_projects,
            "can_manage": project_manage(view, p)}


def project_manage(view: TeamView, p: dict) -> bool:
    return (view.admin or (bool(view.uid) and view.uid in (p.get("lead_ids") or []))
            or any(view.lead_of(str(t)) for t in p.get("team_ids") or []))


def project_full(view: TeamView, p: dict, ppl: dict[str, dict]) -> dict:
    out = project_card(view, p)
    if out["can_read"]:
        leads = set(p.get("lead_ids") or [])
        out["members"] = [{**ppl[u], "role": "lead" if u in leads else "member"}
                          for u in sorted(project_members(p, view.teams)) if u in ppl]
        out["extra_member_ids"] = list(p.get("member_ids") or [])
        out["lead_ids"] = list(leads)
        out["teams"] = [team_card(view, view.teams[str(t)]) for t in p.get("team_ids") or [] if str(t) in view.teams]
    return out


# ── Teams: CRUD ───────────────────────────────────────────────────────────────


def _clean(text: Any, n: int) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()[:n]


async def _ws_members(db: AsyncIOMotorDatabase, workspace_id: str) -> set[str]:
    return {m["user_id"] for m in await db["memberships"].find({"workspace_id": workspace_id}, {"user_id": 1}).to_list(length=5000)}


async def _unique_slug(db: AsyncIOMotorDatabase, coll: str, workspace_id: str, name: str, skip: ObjectId | None = None) -> str:
    base = slugify(name)
    for i in range(0, 200):
        cand = base if i == 0 else f"{base}-{i + 1}"
        q: dict = {"workspace_id": workspace_id, "slug": cand}
        if skip is not None:
            q["_id"] = {"$ne": skip}
        if await db[coll].find_one(q, {"_id": 1}) is None:
            return cand
    return f"{base}-{ObjectId()}"


def _check_style(body: dict, out: dict) -> None:
    if "icon" in body:
        icon = _clean(body.get("icon"), 16) or None
        out["icon"] = icon
    if "color" in body and body.get("color") is not None:
        if body["color"] not in COLORS:
            raise Refused(422, "color must be one of " + ", ".join(COLORS))
        out["color"] = body["color"]
    if "description" in body:
        out["description"] = _clean(body.get("description"), DESC_MAX)


async def _name_free(db: AsyncIOMotorDatabase, coll: str, workspace_id: str, name: str, skip: ObjectId | None = None) -> None:
    q: dict = {"workspace_id": workspace_id, "name_key": name.casefold()}
    if skip is not None:
        q["_id"] = {"$ne": skip}
    if await db[coll].find_one(q, {"_id": 1}) is not None:
        raise Refused(409, "That name is already taken in this workspace.")


async def create_team(db: AsyncIOMotorDatabase, view: TeamView, body: dict, *, from_group: str | None = None) -> dict:
    if not view.admin:
        raise Refused(403, "Only workspace admins can create teams.")
    ws = view.workspace_id
    name = _clean(body.get("name"), NAME_MAX)
    if not name:
        raise Refused(422, "Give the team a name.")
    if await db[TEAMS].count_documents({"workspace_id": ws}) >= MAX_TEAMS:
        raise Refused(409, f"A workspace can have {MAX_TEAMS} teams.")
    await _name_free(db, TEAMS, ws, name)
    vis = body.get("visibility") or "open"
    if vis not in VISIBILITY:
        raise Refused(422, "visibility must be open or private")
    members = await _ws_members(db, ws)
    leads = [u for u in dict.fromkeys(body.get("lead_ids") or []) if u in members]
    mem = [u for u in dict.fromkeys([*leads, *(body.get("member_ids") or [])]) if u in members]
    if not leads and view.uid in members:
        leads = [view.uid]
        mem = list(dict.fromkeys([view.uid, *mem]))
    now = now_utc()
    row = {"workspace_id": ws, "name": name, "name_key": name.casefold(), "slug": await _unique_slug(db, TEAMS, ws, name),
           "icon": None, "color": "blue", "description": "", "visibility": vis, "lead_ids": leads, "member_ids": mem,
           "slack_channel": None, "jira_projects": [], "digest": {"enabled": True, "email": True, "slack": True},
           "from_group_id": from_group, "created_by": view.uid, "created_at": now, "updated_at": now}
    _check_style(body, row)
    row["_id"] = (await db[TEAMS].insert_one(row)).inserted_id
    _changed(mem)
    return row


async def get_team(db: AsyncIOMotorDatabase, workspace_id: str, ref: str) -> dict | None:
    """By id, slug or (case-insensitive) name."""
    o = oid(ref) if ref and len(ref) == 24 else None
    if o is not None:
        row = await db[TEAMS].find_one({"_id": o, "workspace_id": workspace_id})
        if row is not None:
            return row
    return (await db[TEAMS].find_one({"workspace_id": workspace_id, "slug": ref})
            or await db[TEAMS].find_one({"workspace_id": workspace_id, "name_key": (ref or "").strip().casefold()}))


def _changed(user_ids) -> None:
    """Their open sockets re-check what they may read (CONTRACT §7)."""
    from app.services import live, viewers

    for u in set(user_ids or []):
        try:
            viewers.access_changed_for(u)
        except Exception:
            live.user_access_changed(u)


async def update_team(db: AsyncIOMotorDatabase, view: TeamView, team: dict, body: dict) -> dict:
    tid = str(team["_id"])
    if not view.can_manage(tid):
        raise Refused(403, "Only the team's leads and workspace admins can change it.")
    sets: dict = {}
    if body.get("name") is not None:
        name = _clean(body["name"], NAME_MAX)
        if not name:
            raise Refused(422, "Give the team a name.")
        await _name_free(db, TEAMS, view.workspace_id, name, team["_id"])
        sets.update(name=name, name_key=name.casefold())
    _check_style(body, sets)
    if body.get("visibility") is not None:
        if not view.admin:
            raise Refused(403, "Only workspace admins can change a team's visibility.")
        if body["visibility"] not in VISIBILITY:
            raise Refused(422, "visibility must be open or private")
        sets["visibility"] = body["visibility"]
    if "slack_channel" in body:
        ch = body.get("slack_channel")
        if ch is not None:
            if not isinstance(ch, dict) or not _clean(ch.get("id"), 40):
                raise Refused(422, "slack_channel needs an id")
            ch = {"id": _clean(ch.get("id"), 40), "name": _clean(ch.get("name"), 80) or None}
        sets["slack_channel"] = ch
    if body.get("jira_projects") is not None:
        keys = [k for k in dict.fromkeys(_clean(k, 20).upper() for k in body["jira_projects"]) if re.fullmatch(r"[A-Z][A-Z0-9_]{0,19}", k)]
        sets["jira_projects"] = keys[:MAX_JIRA]
    if body.get("digest") is not None:
        d = body["digest"] or {}
        sets["digest"] = {k: bool(d.get(k, True)) for k in ("enabled", "email", "slack")}
    if not sets:
        return team
    sets["updated_at"] = now_utc()
    row = await db[TEAMS].find_one_and_update({"_id": team["_id"]}, {"$set": sets}, return_document=True)
    if "visibility" in sets and sets["visibility"] != team.get("visibility"):
        await _items_access_changed(db, {"team_ids": tid})
        _changed(await _ws_members(db, view.workspace_id))
    return row


async def _items_access_changed(db: AsyncIOMotorDatabase, q: dict) -> None:
    from app.services import live

    async for d in db["documents"].find(q, {"slug": 1}).limit(2000):
        live.access_changed(d.get("slug"))


async def delete_team(db: AsyncIOMotorDatabase, view: TeamView, team: dict) -> None:
    if not view.admin:
        raise Refused(403, "Only workspace admins can delete a team.")
    tid = str(team["_id"])
    await _pull(db, "team_ids", tid)
    await db[PROJECTS].update_many({"workspace_id": view.workspace_id}, {"$pull": {"team_ids": tid}})
    await db[BRIEFS].delete_many({"team_id": tid})
    await db[TEAMS].delete_one({"_id": team["_id"]})
    _changed(team.get("member_ids"))


async def _pull(db: AsyncIOMotorDatabase, key: str, ident: str) -> None:
    """Take a team / project off everything; rows left with none become company-wide again."""
    for coll in ("documents", "folders", "meetings"):
        await db[coll].update_many({key: ident}, {"$pull": {key: ident}})
        await db[coll].update_many({key: {"$size": 0}}, {"$unset": {key: ""}})


async def add_members(db: AsyncIOMotorDatabase, view: TeamView, team: dict, user_ids: list[str]) -> dict:
    if not view.can_manage(str(team["_id"])):
        raise Refused(403, "Only the team's leads and workspace admins can add people.")
    members = await _ws_members(db, view.workspace_id)
    add = [u for u in dict.fromkeys(user_ids) if u in members]
    if not add:
        raise Refused(422, "Pick people who are members of this workspace.")
    row = await db[TEAMS].find_one_and_update({"_id": team["_id"]}, {"$addToSet": {"member_ids": {"$each": add}},
                                                                   "$set": {"updated_at": now_utc()}}, return_document=True)
    _changed(add)
    return row


async def remove_member(db: AsyncIOMotorDatabase, view: TeamView, team: dict, uid: str) -> dict:
    tid = str(team["_id"])
    if not (view.can_manage(tid) or uid == view.uid):
        raise Refused(403, "Only the team's leads and workspace admins can remove people.")
    if uid not in (team.get("member_ids") or []):
        raise Refused(404, "Not a member of this team.")
    leads = team.get("lead_ids") or []
    if uid in leads and len(leads) == 1 and len(team.get("member_ids") or []) > 1 and not view.admin:
        raise Refused(409, "A team needs a lead. Ask a workspace admin to pick another lead first.")
    row = await db[TEAMS].find_one_and_update({"_id": team["_id"]}, {"$pull": {"member_ids": uid, "lead_ids": uid},
                                                                   "$set": {"updated_at": now_utc()}}, return_document=True)
    _changed([uid])
    return row


async def set_leads(db: AsyncIOMotorDatabase, view: TeamView, team: dict, lead_ids: list[str]) -> dict:
    if not view.admin:
        raise Refused(403, "Only workspace admins pick a team's leads.")
    members = await _ws_members(db, view.workspace_id)
    leads = [u for u in dict.fromkeys(lead_ids) if u in members]
    if not leads:
        raise Refused(422, "A team needs at least one lead.")
    row = await db[TEAMS].find_one_and_update(
        {"_id": team["_id"]}, {"$set": {"lead_ids": leads, "updated_at": now_utc()},
                               "$addToSet": {"member_ids": {"$each": leads}}}, return_document=True)
    _changed(leads)
    return row


# ── Suggested teams (from the old Team groups) ───────────────────────────────


async def suggested(db: AsyncIOMotorDatabase, view: TeamView) -> list[dict]:
    if not view.admin:
        return []
    from app.services import team_extras

    taken = {t.get("from_group_id") for t in view.teams.values()} | {(t.get("name") or "").casefold() for t in view.teams.values()}
    state = await db[REVIEW].find_one({"workspace_id": view.workspace_id}) or {}
    dismissed = set(state.get("dismissed_groups") or [])
    out = []
    for g in await team_extras.list_groups(db, view.workspace_id):
        if g["id"] in taken or g["name"].casefold() in taken or g["id"] in dismissed:
            continue
        out.append({"group_id": g["id"], "name": g["name"], "member_ids": g["member_ids"], "member_count": len(g["member_ids"])})
    return out


async def accept_suggested(db: AsyncIOMotorDatabase, view: TeamView, group_id: str, body: dict) -> dict:
    from app.services import team_extras

    g = next((g for g in await team_extras.list_groups(db, view.workspace_id) if g["id"] == group_id), None)
    if g is None:
        raise Refused(404, "Suggestion not found.")
    return await create_team(db, view, {"name": body.get("name") or g["name"], "visibility": body.get("visibility") or "open",
                                        "lead_ids": body.get("lead_ids") or [], "member_ids": g["member_ids"],
                                        **{k: body[k] for k in ("icon", "color", "description") if k in body}},
                             from_group=group_id)


async def dismiss_suggested(db: AsyncIOMotorDatabase, view: TeamView, group_id: str) -> None:
    if not view.admin:
        raise Refused(403, "Only workspace admins can do that.")
    await db[REVIEW].update_one({"workspace_id": view.workspace_id}, {"$addToSet": {"dismissed_groups": group_id}}, upsert=True)


# ── Projects ──────────────────────────────────────────────────────────────────


async def create_project(db: AsyncIOMotorDatabase, view: TeamView, body: dict) -> dict:
    ws = view.workspace_id
    tids = [t for t in dict.fromkeys(body.get("team_ids") or []) if t in view.teams]
    if not tids:
        raise Refused(422, "Link the project to at least one team.")
    if not (view.admin or any(view.lead_of(t) for t in tids)):
        raise Refused(403, "Only workspace admins and the leads of a linked team can create a project.")
    name = _clean(body.get("name"), NAME_MAX)
    if not name:
        raise Refused(422, "Give the project a name.")
    if await db[PROJECTS].count_documents({"workspace_id": ws}) >= MAX_PROJECTS:
        raise Refused(409, f"A workspace can have {MAX_PROJECTS} projects.")
    await _name_free(db, PROJECTS, ws, name)
    vis = body.get("visibility") or ("private" if any(view.teams[t].get("visibility") == "private" for t in tids) else "open")
    if vis not in VISIBILITY:
        raise Refused(422, "visibility must be open or private")
    members = await _ws_members(db, ws)
    now = now_utc()
    row = {"workspace_id": ws, "name": name, "name_key": name.casefold(), "slug": await _unique_slug(db, PROJECTS, ws, name),
           "icon": None, "color": "violet", "description": "", "team_ids": tids,
           "member_ids": [u for u in dict.fromkeys(body.get("member_ids") or []) if u in members],
           "lead_ids": [view.uid] if view.uid in members else [], "visibility": vis, "status": "active",
           "created_by": view.uid, "created_at": now, "updated_at": now}
    _check_style(body, row)
    row["_id"] = (await db[PROJECTS].insert_one(row)).inserted_id
    return row


async def get_project(db: AsyncIOMotorDatabase, workspace_id: str, ref: str) -> dict | None:
    o = oid(ref) if ref and len(ref) == 24 else None
    if o is not None:
        row = await db[PROJECTS].find_one({"_id": o, "workspace_id": workspace_id})
        if row is not None:
            return row
    return (await db[PROJECTS].find_one({"workspace_id": workspace_id, "slug": ref})
            or await db[PROJECTS].find_one({"workspace_id": workspace_id, "name_key": (ref or "").strip().casefold()}))


async def update_project(db: AsyncIOMotorDatabase, view: TeamView, p: dict, body: dict) -> dict:
    if not project_manage(view, p):
        raise Refused(403, "Only workspace admins, the project's leads and the leads of a linked team can change it.")
    sets: dict = {}
    if body.get("name") is not None:
        name = _clean(body["name"], NAME_MAX)
        if not name:
            raise Refused(422, "Give the project a name.")
        await _name_free(db, PROJECTS, view.workspace_id, name, p["_id"])
        sets.update(name=name, name_key=name.casefold())
    _check_style(body, sets)
    if body.get("team_ids") is not None:
        tids = [t for t in dict.fromkeys(body["team_ids"]) if t in view.teams]
        if not tids:
            raise Refused(422, "Link the project to at least one team.")
        new = set(tids) - {str(t) for t in p.get("team_ids") or []}
        if new and not (view.admin or all(view.lead_of(t) or t in view.member_teams for t in new)):
            raise Refused(403, "You can link only teams you're in.")
        sets["team_ids"] = tids
    if body.get("member_ids") is not None:
        members = await _ws_members(db, view.workspace_id)
        sets["member_ids"] = [u for u in dict.fromkeys(body["member_ids"]) if u in members]
    if body.get("visibility") is not None:
        if body["visibility"] not in VISIBILITY:
            raise Refused(422, "visibility must be open or private")
        sets["visibility"] = body["visibility"]
    if body.get("status") is not None:
        if body["status"] not in ("active", "archived"):
            raise Refused(422, "status must be active or archived")
        sets["status"] = body["status"]
    if not sets:
        return p
    sets["updated_at"] = now_utc()
    row = await db[PROJECTS].find_one_and_update({"_id": p["_id"]}, {"$set": sets}, return_document=True)
    if {"team_ids", "member_ids", "visibility"} & sets.keys():
        await _items_access_changed(db, {"project_ids": str(p["_id"])})
        _changed(project_members(p, view.teams) | project_members(row, view.teams))
    return row


async def delete_project(db: AsyncIOMotorDatabase, view: TeamView, p: dict) -> None:
    if not view.admin:
        raise Refused(403, "Only workspace admins can delete a project.")
    await _pull(db, "project_ids", str(p["_id"]))
    await db[PROJECTS].delete_one({"_id": p["_id"]})


# ── Items in teams (move / share) ────────────────────────────────────────────


def _norm_sets(view: TeamView, team_ids, project_ids) -> tuple[list[str], list[str]]:
    tids = [t for t in dict.fromkeys(str(x) for x in team_ids or []) if t in view.teams]
    pids = [p for p in dict.fromkeys(str(x) for x in project_ids or []) if p in view.projects]
    if len(tids) != len(set(str(x) for x in team_ids or [])) or len(pids) != len(set(str(x) for x in project_ids or [])):
        raise Refused(404, "Team or project not found.")
    return tids, pids


def check_change(view: TeamView, before_t: list[str], before_p: list[str], tids: list[str], pids: list[str]) -> None:
    """Adding needs membership of the target (admins: any); removing needs membership of it (or admin)."""
    if view.admin:
        return
    for t in set(tids) ^ set(before_t):
        if t not in view.member_teams:
            raise Refused(403, f"You're not in the team {view.teams[t].get('name')!r}.")
    for p in set(pids) ^ set(before_p):
        if p not in view.member_projects:
            raise Refused(403, f"You're not in the project {view.projects[p].get('name')!r}.")


def team_update(tids: list[str], pids: list[str]) -> dict:
    sets, unset = {}, {}
    (sets if tids else unset)["team_ids"] = tids if tids else ""
    (sets if pids else unset)["project_ids"] = pids if pids else ""
    out: dict = {}
    if sets:
        out["$set"] = sets
    if unset:
        out["$unset"] = unset
    return out


async def _descendants(db: AsyncIOMotorDatabase, root: ObjectId) -> list[ObjectId]:
    from app.services import access

    out, frontier = [], [root]
    for _ in range(access.MAX_PAGE_DEPTH):
        kids = await db["documents"].find({"parent_id": {"$in": frontier}}, {"_id": 1}).to_list(length=2000)
        frontier = [k["_id"] for k in kids]
        if not frontier:
            break
        out.extend(frontier)
    return out


async def apply_to_doc(db: AsyncIOMotorDatabase, raw: dict, tids: list[str], pids: list[str]) -> list[str]:
    """Write the set on an item, its sub-pages and — for a meeting page — its meeting row + transcript.
    Returns the slugs touched (for live events)."""
    from app.services import meetings

    ids = [raw["_id"], *await _descendants(db, raw["_id"])]
    m = await db[meetings.COLL].find_one({"$or": [{"doc_id": raw["_id"]}, {"transcript_doc_id": raw["_id"]}]},
                                         {"doc_id": 1, "transcript_doc_id": 1})
    if m is not None:
        for k in ("doc_id", "transcript_doc_id"):
            if m.get(k) is not None and m[k] not in ids:
                ids.append(m[k])
        await db[meetings.COLL].update_one({"_id": m["_id"]}, team_update(tids, pids))
    upd = team_update(tids, pids)
    await db["documents"].update_many({"_id": {"$in": ids}}, upd)
    return [d["slug"] for d in await db["documents"].find({"_id": {"$in": ids}}, {"slug": 1}).to_list(length=len(ids)) if d.get("slug")]


def notify_moved(slugs: list[str], tids: list[str], pids: list[str]) -> None:
    from app.services import live

    for s in slugs:
        live.notify(s, {"type": "teams", "team_ids": tids, "project_ids": pids})
        live.access_changed(s)


async def set_item_teams(db: AsyncIOMotorDatabase, actor, ctx, raw: dict, team_ids, project_ids) -> dict:
    from app.services import access

    ws = raw.get("workspace_id")
    if not ws:
        raise Refused(409, "Add it to a workspace first.")
    d = await access.can(actor, raw, "move_in_workspace", ctx)
    if not d.allowed:
        raise Refused(d.status if d.status != 200 else 403, d.detail or "You can't move this item.")
    view = await ctx.team_view(ws, actor.user_id)
    tids, pids = _norm_sets(view, team_ids, project_ids)
    check_change(view, ids_of(raw, "team_ids"), ids_of(raw, "project_ids"), tids, pids)
    slugs = await apply_to_doc(db, raw, tids, pids)
    notify_moved(slugs, tids, pids)
    ctx.forget()
    raw = {**raw, "team_ids": tids, "project_ids": pids}
    return await item_teams(db, actor, ctx, raw)


async def item_teams(db: AsyncIOMotorDatabase, actor, ctx, raw: dict) -> dict:
    from app.services import access

    ws = raw.get("workspace_id")
    view = await ctx.team_view(ws, actor.user_id)
    can_change = (await access.can(actor, raw, "move_in_workspace", ctx)).allowed
    opt_t = [team_card(view, t) for tid, t in view.teams.items() if view.admin or tid in view.member_teams]
    opt_p = [project_card(view, p) for pid, p in view.projects.items() if view.admin or pid in view.member_projects]
    lab = labels(view, raw)
    return {"team_ids": ids_of(raw, "team_ids"), "project_ids": ids_of(raw, "project_ids"),
            "teams": [x for x in lab if x["kind"] == "team"], "projects": [x for x in lab if x["kind"] == "project"],
            "can_change": can_change,
            "options": {"teams": sorted(opt_t, key=lambda c: (c["name"] or "").casefold()),
                        "projects": sorted(opt_p, key=lambda c: (c["name"] or "").casefold())}}


async def set_folder_teams(db: AsyncIOMotorDatabase, actor, ctx, workspace_id: str, folder_id: str, team_ids, project_ids,
                           apply_to_items: bool) -> dict:
    from app.services import folder as folder_service

    f = await db["folders"].find_one({"_id": oid(folder_id), "workspace_id": workspace_id})
    if f is None:
        raise Refused(404, "Folder not found.")
    view = await ctx.team_view(workspace_id, actor.user_id)
    from app.models.workspace import role_allows

    if not role_allows(await ctx.role(workspace_id, actor.user_id), "member"):
        raise Refused(403, "Only workspace members can do that.")
    tids, pids = _norm_sets(view, team_ids, project_ids)
    check_change(view, ids_of(f, "team_ids"), ids_of(f, "project_ids"), tids, pids)
    folders = await folder_service.list_folders(db, workspace_id)
    sub = folder_service.subtree_ids(folders, folder_id)
    await db["folders"].update_many({"_id": {"$in": [oid(x) for x in sub]}, "workspace_id": workspace_id}, team_update(tids, pids))
    applied = 0
    if apply_to_items:
        rows = await db["documents"].find({"workspace_id": workspace_id, "folder_id": {"$in": sub}, "deleted_at": None},
                                          {"slug": 1, "parent_id": 1}).to_list(length=5000)
        for r in rows:
            slugs = await apply_to_doc(db, r, tids, pids)
            notify_moved(slugs, tids, pids)
            applied += 1
    ctx.forget()
    return {"team_ids": tids, "project_ids": pids, "applied": applied}


async def jira_default(db: AsyncIOMotorDatabase, slug: str | None) -> str | None:
    """The first Jira project of the first team (with any) the item belongs to."""
    if not slug:
        return None
    raw = await db["documents"].find_one({"slug": slug}, {"team_ids": 1})
    for tid in ids_of(raw, "team_ids"):
        t = await db[TEAMS].find_one({"_id": oid(tid)}, {"jira_projects": 1})
        if t and t.get("jira_projects"):
            return t["jira_projects"][0]
    return None
