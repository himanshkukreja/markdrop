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
