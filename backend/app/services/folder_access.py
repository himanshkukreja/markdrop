"""Who can open what's in a folder: people and teams, inherited by everything inside (2026-11-17).

A folder may name **people** (by email, like a share) and **teams** (services/teams.py), each with a role
(viewer / editor), and may be **restricted**. Everything filed in it — pages, documents, files, sub-pages and
subfolders, including what is created, uploaded or moved in later — inherits that:

* **Named people and teams get in.** Their role reaches every item inside that isn't private, like a share
  of each one ("Inherited from sales/ · Sales team"). Adding someone to the team gives them all of it.
  Workspace viewers reach through a team as viewers.
* **Restricted: nobody else does.** Workspace members who aren't named (and aren't workspace admins) get
  nothing from their membership, and nobody gets in through the link, whatever each item's own setting
  says — an item can't be more open than its folder. Its owner and the people it was shared with by
  name still open it. An editor can open one item beyond its folder (``folder_override``, logged).
* A subfolder adds to its parents: their people and teams reach it too, and a restriction anywhere above
  applies below. A folder's "New items start as" may be ``folder`` (the folder's people and teams).

**How it is evaluated.** The rule lives on the folders (``folders.access``), never copied onto items, and is
read at decision time: :class:`Rules` holds one workspace's folder tree (one query, cached per request on
``access.Ctx``; a workspace with no rules costs one indexed ``limit(1)`` lookup), and ``access.facts`` /
``access.readable_filter`` ask it for the item's ``folder_id``. So moves, new items and team membership
changes take effect at once, and listings stay one Mongo query (a ``folder_id $in/$nin`` clause over at
most 500 folders). Only the *bytes* can't be decided per request: whether a file's stored object (and a
page's images, and the cached anonymous render) may be public without a token is a flag on the item,
``folder_capped``, that ``publicity.is_public`` reads. It is written through ``transitions.change``
(close before open, epoch bump, purge) when an item is created, filed or moved, and re-applied over a
folder's items when its rule changes (:func:`reapply`: inline for small folders, else a background job
with progress, resumed by the reconciler).
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

log = logging.getLogger(__name__)

LOG = "folder_access_log"
JOBS = "folder_access_jobs"
ROLES = ("viewer", "editor")
# A folder's "New items start as": the three item levels, plus ``folder`` (the folder's people and teams:
# stored on the item as ``workspace``, which the restriction narrows to them).
DEFAULTS = ("private", "folder", "workspace", "link")
MAX_PEOPLE = 200
MAX_TEAMS = 50
MAX_DEPTH = 10
INLINE_MAX = 100          # items re-applied in the request; more go to a background job
JOB_BATCH = 50
NOTIFY_MAX = 200          # people told about one share (a team of 500 still gets the access)
LIST_IN_EMAIL = 10
_RANK = {None: 0, "viewer": 1, "editor": 2}
_UNSET: Any = object()


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _oid(v: Any) -> ObjectId | None:
    if isinstance(v, ObjectId):
        return v
    try:
        return ObjectId(str(v))
    except Exception:
        return None


def _max(a: str | None, b: str | None) -> str | None:
    return a if _RANK.get(a, 0) >= _RANK.get(b, 0) else b


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db["folders"].create_index("access.people.email", sparse=True)
    # load_rules' "does this workspace have any folder rule" (one per request): only ruled folders are in it.
    await db["folders"].create_index([("workspace_id", 1)], name="folder_access_rules",
                                     partialFilterExpression={"access": {"$exists": True}})
    await db[LOG].create_index([("workspace_id", 1), ("folder_id", 1), ("at", -1)])
    await db[LOG].create_index([("doc_id", 1), ("at", -1)], sparse=True)
    await db[JOBS].create_index("state")


# ── The rule ──────────────────────────────────────────────────────────────────


@dataclass
class Entry:
    role: str
    source: str               # the folder (id) that names them


@dataclass
class Rule:
    """One folder's effective rule: its own entries and its ancestors'."""

    folder_id: str
    restricted: bool = False
    restricted_by: str | None = None      # the nearest restricted folder (itself or above)
    people: dict[str, Entry] = field(default_factory=dict)
    teams: dict[str, Entry] = field(default_factory=dict)

    @property
    def empty(self) -> bool:
        return not (self.restricted or self.people or self.teams)


class Rules:
    """One workspace's folder rules (see the module docstring). ``any`` is False for the (usual) workspace
    without a single folder rule: every question then answers "no folder rule" without work."""

    def __init__(self, workspace_id: str, folders: dict[str, dict] | None = None):
        self.workspace_id = workspace_id
        self.folders = folders or {}
        self.any = any(f.get("access") for f in self.folders.values())
        self._rule: dict[str, Rule | None] = {}
        self._paths: dict[str, list[str]] = {}

    def chain(self, fid: str | None) -> list[dict]:
        out, seen, cur = [], set(), fid
        for _ in range(MAX_DEPTH):
            if not cur or cur in seen or cur not in self.folders:
                break
            seen.add(cur)
            row = self.folders[cur]
            out.append(row)
            cur = row.get("parent_id")
        return out

    def rule(self, fid: str | None) -> Rule | None:
        if not self.any or not fid:
            return None
        fid = str(fid)
        if fid in self._rule:
            return self._rule[fid]
        r = Rule(fid)
        for row in self.chain(fid):
            a = row.get("access") or {}
            src = str(row["_id"])
            if a.get("restricted") and not r.restricted:
                r.restricted, r.restricted_by = True, src
            for p in a.get("people") or []:
                e, role = p.get("email"), p.get("role")
                if e and role in ROLES and _RANK[role] > _RANK.get((r.people.get(e) or Entry(None, "")).role, 0):
                    r.people[e] = Entry(role, src)
            for t in a.get("teams") or []:
                tid, role = str(t.get("team_id") or ""), t.get("role")
                if tid and role in ROLES and _RANK[role] > _RANK.get((r.teams.get(tid) or Entry(None, "")).role, 0):
                    r.teams[tid] = Entry(role, src)
        out = None if r.empty else r
        self._rule[fid] = out
        return out

    def path(self, fid: str | None) -> str:
        """``sales/q4/`` (slugs from the top), for "Inherited from sales/"."""
        if not fid:
            return ""
        segs = [row.get("slug") or str(row["_id"]) for row in reversed(self.chain(str(fid)))]
        return "/".join(segs) + "/" if segs else ""

    def name(self, fid: str | None) -> str | None:
        row = self.folders.get(str(fid)) if fid else None
        return row.get("name") if row else None

    def role_for(self, fid: str | None, email: str, member_teams: set[str] | frozenset,
                 ws_role: str | None) -> tuple[str | None, dict | None]:
        """The role the folder's people / teams give this person on an item inside (None: nothing), and how
        (``{"kind": "person"|"team", "folder_id", "team_id"?}``). Teams count only for current members of the
        workspace; a workspace viewer reaches through a team as a viewer."""
        r = self.rule(fid)
        if r is None:
            return None, None
        role, via = None, None
        e = r.people.get(email) if email else None
        if e is not None:
            role, via = e.role, {"kind": "person", "folder_id": e.source}
        if ws_role is not None and r.teams:
            for tid in member_teams:
                t = r.teams.get(tid)
                if t is None:
                    continue
                trole = "viewer" if ws_role == "viewer" else t.role
                if _RANK[trole] > _RANK.get(role, 0):
                    role, via = trole, {"kind": "team", "folder_id": t.source, "team_id": tid}
        return role, via

    def restricted_ids(self) -> list[str]:
        return [fid for fid in self.folders if (self.rule(fid) or Rule(fid)).restricted]

    def hidden_ids(self, email: str, member_teams, ws_role: str | None, admin: bool) -> list[str]:
        """Restricted folders whose items this person's membership doesn't reach."""
        if admin:
            return []
        return [fid for fid in self.restricted_ids() if self.role_for(fid, email, member_teams, ws_role)[0] is None]

    def granted_ids(self, email: str, member_teams, ws_role: str | None) -> list[str]:
        if not self.any:
            return []
        return [fid for fid in self.folders if self.role_for(fid, email, member_teams, ws_role)[0] is not None]


EMPTY = Rules("")


async def load_rules(db: AsyncIOMotorDatabase, workspace_id: str | None) -> Rules:
    if not workspace_id:
        return EMPTY
    if await db["folders"].find_one({"workspace_id": workspace_id, "access": {"$exists": True}}, {"_id": 1}) is None:
        return Rules(workspace_id)
    rows = await db["folders"].find({"workspace_id": workspace_id},
                                    {"name": 1, "slug": 1, "parent_id": 1, "access": 1}).to_list(length=1000)
    return Rules(workspace_id, {str(r["_id"]): r for r in rows})


async def load_tree(db: AsyncIOMotorDatabase, workspace_id: str) -> Rules:
    """Every folder of the workspace, rule or not (paths for the settings dialog)."""
    rows = await db["folders"].find({"workspace_id": workspace_id},
                                    {"name": 1, "slug": 1, "parent_id": 1, "access": 1}).to_list(length=1000)
    return Rules(workspace_id, {str(r["_id"]): r for r in rows})


async def capped_for(db: AsyncIOMotorDatabase, workspace_id: str | None, folder_id: str | None) -> bool:
    """Whether an item filed in ``folder_id`` (without an override) is narrowed by a restriction."""
    if not workspace_id or not folder_id:
        return False
    r = (await load_rules(db, workspace_id)).rule(folder_id)
    return bool(r and r.restricted)


async def stamp_new(db: AsyncIOMotorDatabase, fields: dict) -> dict:
    """The byte flags for a document about to be inserted with these fields (``document.create_document``):
    a sub-page copies its parent's; anything else filed in a restricted folder is capped."""
    out: dict = {}
    parent = _oid(fields.get("parent_id")) if fields.get("parent_id") is not None else None
    if parent is not None:
        row = await db["documents"].find_one({"_id": parent}, {"folder_capped": 1, "folder_override": 1})
        for k in ("folder_capped", "folder_override"):
            if row and row.get(k):
                out[k] = row[k]
        return out
    if await capped_for(db, fields.get("workspace_id"), fields.get("folder_id")):
        out["folder_capped"] = True
    return out


async def effective_default(db: AsyncIOMotorDatabase, workspace_id: str, folder_id: str | None,
                            own: str | None) -> str | None:
    """``folder`` ⇒ ``workspace`` (narrowed to the folder's people by its restriction); none of its own in a
    restricted folder ⇒ ``workspace`` too (new items there reach the folder's people, never the link)."""
    if own == "folder":
        return "workspace"
    if own in ("private", "workspace", "link"):
        return own
    if folder_id and await capped_for(db, workspace_id, folder_id):
        return "workspace"
    return None


# ── Who may change it ─────────────────────────────────────────────────────────


async def manager(actor, ctx, workspace_id: str, folder: dict, rules: Rules) -> bool:
    """Workspace admins, the folder's creator (a member), and its editors (named, or through a team)."""
    from app.models.workspace import role_allows

    uid = actor.user_id
    if not uid or actor.cred == "tenant":
        return False
    ws_role = await ctx.role(workspace_id, uid)
    if ws_role is None:
        return False
    if role_allows(ws_role, "admin"):
        return True
    if folder.get("created_by") == uid and role_allows(ws_role, "member"):
        return True
    tv = await ctx.team_view(workspace_id, uid)
    role, _ = rules.role_for(str(folder["_id"]), actor.email, tv.member_teams, ws_role)
    return role == "editor"


async def _folder(db: AsyncIOMotorDatabase, workspace_id: str, folder_id: str) -> dict:
    o = _oid(folder_id)
    row = await db["folders"].find_one({"_id": o, "workspace_id": workspace_id}) if o else None
    if row is None:
        raise HTTPException(status_code=404, detail="Folder not found")
    return row


# ── Reading it ────────────────────────────────────────────────────────────────


async def _people_names(db: AsyncIOMotorDatabase, emails: list[str]) -> dict[str, dict]:
    if not emails:
        return {}
    return {(u.get("email") or "").lower(): u async for u in db["users"].find(
        {"email": {"$in": emails}}, {"email": 1, "name": 1, "picture": 1})}


async def describe(db: AsyncIOMotorDatabase, actor, ctx, workspace_id: str, folder_id: str) -> dict:
    """The folder's access as the folder settings dialog and get_folder_access show it. Workspace members."""
    from app.services import folder as folder_service
    from app.services import teams as teams_service

    if await ctx.role(workspace_id, actor.user_id) is None:
        raise HTTPException(status_code=404, detail="Folder not found")
    row = await _folder(db, workspace_id, folder_id)
    rules = await load_tree(db, workspace_id)
    fid = str(row["_id"])
    r = rules.rule(fid) or Rule(fid)
    own = row.get("access") or {}
    tv = await ctx.team_view(workspace_id, actor.user_id)
    can = await manager(actor, ctx, workspace_id, row, rules)
    names = await _people_names(db, list(r.people))
    people = []
    for email, e in sorted(r.people.items(), key=lambda kv: kv[0]):
        u = names.get(email) or {}
        # Addresses are for the folder's managers (as the members list shows emails to admins only).
        people.append({"email": email if can or email == actor.email else None,
                       "name": u.get("name") or (None if can else "Someone"), "role": e.role,
                       "inherited_from": None if e.source == fid else rules.path(e.source),
                       "has_account": bool(u)})
    teams = []
    for tid, e in r.teams.items():
        t = tv.teams.get(tid)
        teams.append({"id": tid, "name": (t or {}).get("name") or "Deleted team", "role": e.role,
                      "members": len((t or {}).get("member_ids") or []), "exists": t is not None,
                      "inherited_from": None if e.source == fid else rules.path(e.source)})
    teams.sort(key=lambda x: (x["name"] or "").casefold())
    own_default = row.get("default_access") if row.get("default_access") in DEFAULTS else None
    job = await db[JOBS].find_one({"_id": f"{workspace_id}:{fid}"})
    log_rows = (await db[LOG].find({"workspace_id": workspace_id, "folder_id": fid}).sort("at", -1).limit(10)
                .to_list(10)) if can else []
    team_opts = []
    if can:
        team_opts = sorted(({"id": tid, "name": t.get("name"), "members": len(t.get("member_ids") or []),
                             "visibility": t.get("visibility")} for tid, t in tv.teams.items()
                            if (tv.admin or tid in tv.member_teams or t.get("visibility") == "open")),
                           key=lambda x: (x["name"] or "").casefold())
    eff_default = await folder_service.effective_default_access(db, workspace_id, fid)
    return {
        "workspace_id": workspace_id, "folder_id": fid, "name": row.get("name"), "path": rules.path(fid),
        "restricted": r.restricted, "restricted_here": bool(own.get("restricted")),
        "restricted_by": None if not r.restricted or r.restricted_by == fid else rules.path(r.restricted_by),
        "people": people, "teams": teams,
        "default_access": own_default, "effective_default_access": eff_default,
        "summary": summary_text(r, rules, fid, teams),
        "can_manage": can, "team_options": team_opts,
        "job": _job_out(job),
        "log": [{"at": x["at"], "by": x.get("by_name") or x.get("by_email"), "text": x.get("text")} for x in log_rows],
    }


def summary_text(r: Rule, rules: Rules, fid: str, teams: list[dict]) -> str:
    who = []
    if teams:
        who.append(", ".join(f"{t['name']} team" for t in teams[:3]) + (f" and {len(teams) - 3} more" if len(teams) > 3 else ""))
    if r.people:
        n = len(r.people)
        who.append(f"{n} {'person' if n == 1 else 'people'}")
    named = " and ".join(who)
    if r.restricted:
        where = "" if r.restricted_by == fid else f" (restricted at {rules.path(r.restricted_by)})"
        return (f"Restricted{where}: only {named or 'the people added to each item'}, item owners and workspace "
                "admins can open what's inside.")
    if named:
        return f"{named[0].upper()}{named[1:]} can open what's inside, in addition to each item's own setting."
    return "Each item's own setting decides who can open it."


def _job_out(job: dict | None) -> dict | None:
    if not job:
        return None
    return {"state": job.get("state"), "done": int(job.get("done") or 0), "total": int(job.get("total") or 0),
            "updated_at": job.get("updated_at")}


async def explain(actor, raw: dict, ctx) -> dict | None:
    """Why the caller can open ``raw`` — ``{role, source, text, folder?}``. None when they can't."""
    from app.services import access

    d = await access.can(actor, raw, "read", ctx)
    if not d.allowed:
        return None
    f = await access.facts(actor, raw, ctx)
    folder = None
    rules = await ctx.folder_rules(f.ws_id) if f.ws_id else EMPTY
    fid = (raw.get("folder_id") or None) if f.ws_id else None
    r = rules.rule(fid) if fid else None
    if r is not None:
        folder = {"id": fid, "path": rules.path(fid), "restricted": r.restricted,
                  "restricted_by": rules.path(r.restricted_by) if r.restricted else None,
                  "override": bool(raw.get("folder_override")), "capped": f.capped}
    role = f.doc_role
    if f.is_owner:
        source, text = "owner", "You own it"
    elif f.secret_ok:
        source, text = "edit_link", "You opened it with its edit link"
    elif f.grant_role is not None and _RANK.get(f.grant_role, 0) >= _RANK.get(f.folder_role, 0):
        source, text = "shared", f"Shared with you directly ({'can edit' if f.grant_role == 'editor' else 'can view'})"
        if f.inherited:
            text = "Shared with you on a page above it"
    elif f.folder_role is not None and f.folder_via is not None:
        via = f.folder_via
        where = f"Inherited from {rules.path(via['folder_id'])}"
        if via["kind"] == "team":
            tv = await ctx.team_view(f.ws_id, actor.user_id)
            tname = (tv.teams.get(via["team_id"]) or {}).get("name") or "a team"
            source, text = "folder_team", f"{where} · {tname} team"
        else:
            source, text = "folder_person", f"{where} · shared with you"
    elif f.member_doc_role is not None:
        from app.models.workspace import role_allows

        wname = f.ws.name if f.ws is not None else "the workspace"
        if f.capped and role_allows(f.ws_role, "admin"):
            source, text = "workspace_admin", f"Workspace admin of {wname} (admins see restricted folders)"
        else:
            source, text = "workspace", f"Member of {wname}"
    else:
        source, text = "link", "Anyone with the link"
    return {"role": role, "source": source, "text": text, "folder": folder}


# ── Changing it ───────────────────────────────────────────────────────────────


async def _log(db: AsyncIOMotorDatabase, actor, workspace_id: str, folder_id: str | None, text: str,
               doc_id: str | None = None, **extra) -> None:
    try:
        await db[LOG].insert_one({"workspace_id": workspace_id, "folder_id": folder_id, "doc_id": doc_id,
                                  "by": actor.user_id, "by_email": actor.email or None,
                                  "by_name": getattr(actor.user, "name", None) or actor.email or None,
                                  "via": "mcp" if actor.cred == "mcp" else None,
                                  "text": text[:300], "at": now_utc(), **extra})
    except Exception:  # pragma: no cover - logging never fails the change
        log.warning("folder access log failed", exc_info=True)


async def _resolve_team(db: AsyncIOMotorDatabase, workspace_id: str, ref: str) -> dict:
    from app.services import teams as teams_service

    t = await teams_service.get_team(db, workspace_id, str(ref))
    if t is None:
        raise HTTPException(status_code=404, detail=f"No team {ref!r} in this workspace (see list_teams).")
    return t


def _norm_people(people: list) -> list[dict]:
    from app.services import access

    out: dict[str, str] = {}
    for p in people or []:
        email, role = (p, "viewer") if isinstance(p, str) else (p.get("email"), p.get("role") or "viewer")
        email = access.normalize_email(email)
        if not email or "@" not in email:
            raise HTTPException(status_code=422, detail=f"{email or 'That'} isn't an email address.")
        if role not in ROLES:
            raise HTTPException(status_code=422, detail="role is viewer or editor")
        out[email] = role
    if len(out) > MAX_PEOPLE:
        raise HTTPException(status_code=422, detail=f"A folder can name at most {MAX_PEOPLE} people; add a team instead.")
    return [{"email": e, "role": r} for e, r in out.items()]


async def _norm_teams(db: AsyncIOMotorDatabase, workspace_id: str, teams: list, tv) -> list[dict]:
    from app.services import teams as teams_service

    out: dict[str, str] = {}
    for t in teams or []:
        ref, role = (t, "editor") if isinstance(t, str) else (t.get("team") or t.get("id") or t.get("team_id"),
                                                              t.get("role") or "editor")
        if role not in ROLES:
            raise HTTPException(status_code=422, detail="role is viewer or editor")
        row = await _resolve_team(db, workspace_id, ref)
        tid = str(row["_id"])
        if not (tv.admin or tid in tv.member_teams or row.get("visibility") == "open"):
            raise HTTPException(status_code=404, detail=f"No team {ref!r} in this workspace (see list_teams).")
        if teams_service.is_general(row):
            pass  # everyone: allowed (a restricted folder open to the whole workspace, explicitly)
        out[tid] = role
    if len(out) > MAX_TEAMS:
        raise HTTPException(status_code=422, detail=f"A folder can name at most {MAX_TEAMS} teams.")
    return [{"team_id": t, "role": r} for t, r in out.items()]


async def update(db: AsyncIOMotorDatabase, actor, ctx, workspace_id: str, folder_id: str, *,
                 restricted: Any = _UNSET, people: Any = _UNSET, teams: Any = _UNSET,
                 add_people: list | None = None, add_teams: list | None = None,
                 remove_people: list | None = None, remove_teams: list | None = None,
                 default_access: Any = _UNSET) -> dict:
    """Change a folder's own rule. ``people`` / ``teams`` replace its own lists; ``add_*`` / ``remove_*``
    change them. Returns ``{"added_people": [...], "added_teams": [...], "changed": bool}`` (who newly
    reaches it, for the notification). Managers only (:func:`manager`)."""
    from app.services import access

    row = await _folder(db, workspace_id, folder_id)
    rules = await ctx.folder_rules(workspace_id)
    if not await manager(actor, ctx, workspace_id, row, rules):
        raise HTTPException(status_code=403, detail="Only workspace admins, the folder's creator and its editors "
                                                    "can change who can access it.")
    tv = await ctx.team_view(workspace_id, actor.user_id)
    own = dict(row.get("access") or {})
    before_people = {p["email"]: p["role"] for p in own.get("people") or []}
    before_teams = {str(t["team_id"]): t["role"] for t in own.get("teams") or []}
    new_people = dict(before_people)
    new_teams = dict(before_teams)
    if people is not _UNSET:
        new_people = {p["email"]: p["role"] for p in _norm_people(people or [])}
    if teams is not _UNSET:
        new_teams = {t["team_id"]: t["role"] for t in await _norm_teams(db, workspace_id, teams or [], tv)}
    for p in _norm_people(add_people or []):
        new_people[p["email"]] = p["role"]
    for t in await _norm_teams(db, workspace_id, add_teams or [], tv):
        new_teams[t["team_id"]] = t["role"]
    for e in remove_people or []:
        new_people.pop(access.normalize_email(e), None)
    for ref in remove_teams or []:
        try:
            t = await _resolve_team(db, workspace_id, ref)
            new_teams.pop(str(t["_id"]), None)
        except HTTPException:
            new_teams.pop(str(ref), None)
    if len(new_people) > MAX_PEOPLE or len(new_teams) > MAX_TEAMS:
        raise HTTPException(status_code=422, detail=f"A folder can name at most {MAX_PEOPLE} people and {MAX_TEAMS} teams.")
    was_restricted = bool(own.get("restricted"))
    now_restricted = was_restricted if restricted is _UNSET else bool(restricted)
    sets: dict = {}
    unset: dict = {}
    by = actor.user_id
    now = now_utc()
    people_rows = [{"email": e, "role": r, "by": by, "at": now} if before_people.get(e) != r else
                   next(p for p in own.get("people") or [] if p["email"] == e) for e, r in new_people.items()]
    team_rows = [{"team_id": t, "role": r, "by": by, "at": now} if before_teams.get(t) != r else
                 next(x for x in own.get("teams") or [] if str(x["team_id"]) == t) for t, r in new_teams.items()]
    access_row = {"restricted": now_restricted, "people": people_rows, "teams": team_rows,
                  "updated_at": now, "updated_by": by}
    if not now_restricted and not people_rows and not team_rows:
        unset["access"] = ""
    else:
        sets["access"] = access_row
    if default_access is not _UNSET:
        if default_access is not None and default_access not in DEFAULTS:
            raise HTTPException(status_code=422, detail="default_access is private, folder, workspace or link")
        if default_access is None:
            unset["default_access"] = ""
        else:
            sets["default_access"] = default_access
    upd: dict = {}
    if sets:
        upd["$set"] = {**sets, "updated_at": now}
    if unset:
        upd["$unset"] = unset
    if upd:
        await db["folders"].update_one({"_id": row["_id"]}, upd)
    ctx.forget()
    fid = str(row["_id"])
    texts = []
    if now_restricted != was_restricted:
        texts.append("restricted the folder" if now_restricted else "removed the restriction")
    added_p = [e for e, r in new_people.items() if _RANK[r] > _RANK.get(before_people.get(e), 0)]
    added_t = [t for t, r in new_teams.items() if _RANK[r] > _RANK.get(before_teams.get(t), 0)]
    gone_p = [e for e in before_people if e not in new_people]
    gone_t = [t for t in before_teams if t not in new_teams]
    for e in added_p:
        texts.append(f"gave {e} {new_people[e]} access")
    for e in gone_p:
        texts.append(f"removed {e}")
    for t in added_t:
        texts.append(f"gave the {(tv.teams.get(t) or {}).get('name') or 'team'} team {new_teams[t]} access")
    for t in gone_t:
        texts.append(f"removed the {(tv.teams.get(t) or {}).get('name') or 'team'} team")
    if default_access is not _UNSET and default_access != row.get("default_access"):
        texts.append(f"set new items to start as {default_access or 'the workspace default'}")
    if texts:
        await _log(db, actor, workspace_id, fid, "; ".join(texts))
    changed_access = bool(added_p or added_t or gone_p or gone_t or now_restricted != was_restricted)
    if changed_access:
        await after_rule_change(db, workspace_id, [fid])
    return {"added_people": added_p, "added_teams": added_t, "changed": changed_access,
            "role_of": {**new_people, **{f"team:{t}": r for t, r in new_teams.items()}}}


async def share(db: AsyncIOMotorDatabase, actor, ctx, workspace_id: str, folder_id: str, *,
                emails: list[str] | None = None, teams: list[str] | None = None, role: str = "viewer",
                notify: bool = True, message: str | None = None, restrict: bool | None = None) -> dict:
    """Share a folder with people and/or teams (``role`` for all of them): they reach everything inside that
    isn't private, now and later. With ``notify``, ONE notification (and one email) per person — not one
    per item — for the people newly given access (a team's members too, at most ``NOTIFY_MAX``)."""
    if role not in ROLES:
        raise HTTPException(status_code=422, detail="role is viewer or editor")
    if not emails and not teams:
        raise HTTPException(status_code=422, detail="Name people (emails) or teams to share the folder with.")
    res = await update(db, actor, ctx, workspace_id, folder_id,
                       add_people=[{"email": e, "role": role} for e in emails or []],
                       add_teams=[{"team": t, "role": role} for t in teams or []],
                       **({} if restrict is None else {"restricted": bool(restrict)}))
    told: dict[str, bool] = {}
    if notify:
        told = await notify_people(db, actor, ctx, workspace_id, folder_id, res["added_people"], res["added_teams"],
                                   role=role, message=message)
    return {**res, "notified": told}


async def _recipients(db: AsyncIOMotorDatabase, workspace_id: str, emails: list[str], team_ids: list[str],
                      actor_email: str) -> list[str]:
    out = list(dict.fromkeys(emails))
    if team_ids:
        ids = set()
        async for t in db["teams"].find({"_id": {"$in": [_oid(t) for t in team_ids if _oid(t)]},
                                         "workspace_id": workspace_id}, {"member_ids": 1}):
            ids.update(t.get("member_ids") or [])
        oids = [_oid(u) for u in ids if _oid(u)]
        if oids:
            async for u in db["users"].find({"_id": {"$in": oids}}, {"email": 1}):
                from app.services import access

                e = access.normalize_email(u.get("email"))
                if e and e not in out:
                    out.append(e)
    return [e for e in out if e and e != actor_email][:NOTIFY_MAX]


async def readable_items(db: AsyncIOMotorDatabase, user_row: dict | None, email: str, workspace_id: str,
                         folder_ids: list[str], limit: int = LIST_IN_EMAIL) -> tuple[list[dict], int]:
    """What someone can open in these folders (for the share email): (first rows, how many)."""
    from app.models.user import User
    from app.services import access

    if user_row is not None:
        user = User(id=str(user_row["_id"]), email=user_row.get("email") or email, name=user_row.get("name"),
                    created_at=now_utc(), updated_at=now_utc())
        actor = access.Actor.of(user)
    else:
        # No account yet: what the address will open once it signs up (a stand-in with no id reaches nothing
        # through a membership; folder people are keyed on the address).
        user = User(id=f"pending:{email}", email=email, created_at=now_utc(), updated_at=now_utc())
        actor = access.Actor.of(user)
    ctx = access.Ctx(db)
    rows = await db["documents"].find(
        {"workspace_id": workspace_id, "folder_id": {"$in": folder_ids}, "parent_id": None,
         "access_level": {"$ne": "private"}, "template": {"$ne": True}},
        {"content": 0}).sort("updated_at", -1).to_list(length=500)
    out, n = [], 0
    for r in rows:
        if (await access.can(actor, r, "read", ctx)).allowed:
            n += 1
            if len(out) < limit:
                out.append(r)
    return out, n


async def notify_people(db: AsyncIOMotorDatabase, actor, ctx, workspace_id: str, folder_id: str,
                        emails: list[str], team_ids: list[str], *, role: str, message: str | None) -> dict[str, bool]:
    """One bell notification (for an account) and one email per person newly given access to the folder."""
    from app.services import folder as folder_service
    from app.services import mailer, notifications, urls

    recipients = await _recipients(db, workspace_id, emails, team_ids, actor.email)
    if not recipients:
        return {}
    row = await _folder(db, workspace_id, folder_id)
    folders = await folder_service.list_folders(db, workspace_id)
    sub = folder_service.subtree_ids(folders, str(row["_id"]))
    ws = await ctx.workspace(workspace_id)
    sharer = getattr(actor.user, "name", None) or actor.email or "Someone"
    message = (message or "").strip()[:500] or None
    out: dict[str, bool] = {}
    for email in recipients:
        user_row = await db["users"].find_one({"email": email}, {"email": 1, "name": 1})
        items, n = await readable_items(db, user_row, email, workspace_id, sub)
        member = bool(user_row) and await ctx.role(workspace_id, str(user_row["_id"])) is not None
        link = (urls.markdrop_url(f"w/{workspace_id}/f/{row['_id']}") if member
                else (urls.markdrop_url(items[0]["slug"]) if items else urls.markdrop_url("")))
        sent = False
        if mailer.is_configured():
            try:
                await mailer.send_folder_share_email(
                    to_email=email, folder_name=row.get("name") or "a folder",
                    workspace_name=ws.name if ws is not None else None, url=link, sharer_name=sharer, role=role,
                    items=[(i.get("title") or f"/{i['slug']}", urls.markdrop_url(i["slug"])) for i in items],
                    total=n, message=message)
                sent = True
            except Exception:
                log.warning("folder share email failed", exc_info=True)
        if user_row is not None:
            try:
                await notifications.notify_folder(db, str(user_row["_id"]), workspace_id, str(row["_id"]), actor,
                                                  {"message": message, "role": role, "label": row.get("name"),
                                                   "count": n})
            except Exception:
                log.warning("folder share notification failed", exc_info=True)
        out[email] = sent
    return out


async def set_override(db: AsyncIOMotorDatabase, actor, ctx, raw: dict, on: bool, reason: str | None = None) -> dict:
    """Open one item beyond its restricted folder (``on``), or put it back under the folder. Its editors (a
    signed-in owner or editor, not an edit link); logged in the folder's log and the page's history."""
    from app.services import access, page_history

    if raw is None:
        raise HTTPException(status_code=404, detail="Document not found")
    if not actor.user_id:
        raise HTTPException(status_code=401, detail="Sign in to do that.")
    d = await access.can(actor, raw, "edit_content", ctx)
    f = await access.facts(actor, raw, ctx)
    if not d.allowed or f.role not in ("owner", "editor"):
        raise HTTPException(status_code=403, detail="Only the item's editors can open it beyond its folder.")
    if raw.get("parent_id") is not None:
        raise HTTPException(status_code=409, detail="Sub-pages follow the page they're in. Change it on the top page.")
    ws_id = raw.get("workspace_id")
    rules = await ctx.folder_rules(ws_id) if ws_id else EMPTY
    r = rules.rule(raw.get("folder_id"))
    if on and not (r and r.restricted):
        raise HTTPException(status_code=409, detail="Its folder isn't restricted, so there's nothing to open it beyond.")
    if bool(raw.get("folder_override")) == bool(on):
        return raw
    oids = [raw["_id"], *await _descendants(db, raw["_id"])]
    value = {"by": actor.user_id, "by_email": actor.email, "at": now_utc(), "reason": (reason or "").strip()[:300] or None}
    if on:
        await db["documents"].update_many({"_id": {"$in": oids}}, {"$set": {"folder_override": value}})
    else:
        await db["documents"].update_many({"_id": {"$in": oids}}, {"$unset": {"folder_override": ""}})
    ctx.forget()
    fresh = await db["documents"].find_one({"_id": raw["_id"]}) or raw
    after = await sync_doc(db, fresh)
    title = raw.get("title") or f"/{raw.get('slug')}"
    text = (f"opened “{title}” beyond its restricted folder" + (f" ({value['reason']})" if on and value["reason"] else "")
            if on else f"put “{title}” back under its folder's restriction")
    await _log(db, actor, ws_id, raw.get("folder_id"), text, doc_id=str(raw["_id"]))
    await page_history.record_event(db, after, actor, text=text[0].upper() + text[1:],
                                    event={"kind": "folder_override", "on": bool(on)})
    from app.services import live

    live.access_changed(raw.get("slug"))
    return after


async def _descendants(db: AsyncIOMotorDatabase, root: ObjectId) -> list[ObjectId]:
    from app.services import teams as teams_service

    return await teams_service._descendants(db, root)


# ── Bytes: keep ``folder_capped`` in step (see the module docstring) ─────────


async def desired_capped(db: AsyncIOMotorDatabase, raw: dict, rules: Rules | None = None) -> bool:
    if raw.get("parent_id") is not None:
        parent = await db["documents"].find_one({"_id": _oid(raw["parent_id"])}, {"folder_capped": 1})
        return bool(parent and parent.get("folder_capped"))
    if raw.get("folder_override") or not raw.get("workspace_id") or not raw.get("folder_id"):
        return False
    rules = rules or await load_rules(db, raw["workspace_id"])
    r = rules.rule(raw["folder_id"])
    return bool(r and r.restricted)


async def sync_doc(db: AsyncIOMotorDatabase, raw: dict, rules: Rules | None = None) -> dict:
    """Write the item's ``folder_capped`` to match its folder (``transitions.change``: closing bytes before
    narrowing, opening after widening, purging the cached render; sub-pages follow through the cascade)."""
    from app.services import transitions

    want = await desired_capped(db, raw, rules)
    if want == bool(raw.get("folder_capped")):
        return raw
    if want:
        return await transitions.change(db, raw, sets={"folder_capped": True},
                                        cas={"workspace_id": raw.get("workspace_id")}, narrows=None)
    return await transitions.change(db, raw, sets={}, unset=["folder_capped"],
                                    cas={"workspace_id": raw.get("workspace_id")})


async def _items_under(db: AsyncIOMotorDatabase, workspace_id: str, folder_ids: list[str]) -> list[ObjectId]:
    rows = await db["documents"].find({"workspace_id": workspace_id, "folder_id": {"$in": folder_ids},
                                       "parent_id": None}, {"_id": 1}).to_list(length=100_000)
    return [r["_id"] for r in rows]


async def after_rule_change(db: AsyncIOMotorDatabase, workspace_id: str, folder_ids: list[str]) -> dict:
    """A folder's rule (or place in the tree) changed: re-apply the byte flag over every item below, and
    tell open pages to re-check. Small folders now; big ones in a background job with progress."""
    from app.services import folder as folder_service
    from app.services import live

    folders = await folder_service.list_folders(db, workspace_id)
    sub: list[str] = []
    for fid in folder_ids:
        sub.extend(x for x in folder_service.subtree_ids(folders, fid) if x not in sub)
    ids = await _items_under(db, workspace_id, sub)
    async for d in db["documents"].find({"_id": {"$in": ids[:2000]}}, {"slug": 1}):
        live.access_changed(d.get("slug"))
    key = f"{workspace_id}:{folder_ids[0]}" if folder_ids else workspace_id
    if len(ids) <= INLINE_MAX:
        await _apply(db, workspace_id, ids)
        await db[JOBS].delete_one({"_id": key})
        return {"state": "done", "done": len(ids), "total": len(ids)}
    now = now_utc()
    await db[JOBS].update_one({"_id": key}, {"$set": {"workspace_id": workspace_id, "folder_ids": sub,
                                                      "state": "running", "done": 0, "total": len(ids),
                                                      "started_at": now, "updated_at": now}}, upsert=True)
    task = asyncio.get_running_loop().create_task(run_job(db, key))
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)
    return {"state": "running", "done": 0, "total": len(ids)}


_TASKS: set = set()


async def _apply(db: AsyncIOMotorDatabase, workspace_id: str, ids: list[ObjectId]) -> int:
    rules = await load_rules(db, workspace_id)
    n = 0
    for i in range(0, len(ids), JOB_BATCH):
        for raw in await db["documents"].find({"_id": {"$in": ids[i:i + JOB_BATCH]}}).to_list(length=JOB_BATCH):
            try:
                await sync_doc(db, raw, rules)
            except Exception:
                # A racing write (409) or storage hiccup: the reconciler's pass (run_pending) tries again.
                log.warning("folder access: re-apply failed for %s", raw.get("slug"), exc_info=True)
            n += 1
    return n


async def run_job(db: AsyncIOMotorDatabase, key: str) -> None:
    job = await db[JOBS].find_one({"_id": key})
    if job is None:
        return
    ws = job["workspace_id"]
    ids = await _items_under(db, ws, job.get("folder_ids") or [])
    done = 0
    for i in range(0, len(ids), JOB_BATCH):
        await _apply(db, ws, ids[i:i + JOB_BATCH])
        done = min(len(ids), i + JOB_BATCH)
        await db[JOBS].update_one({"_id": key}, {"$set": {"done": done, "total": len(ids), "updated_at": now_utc()}})
    await db[JOBS].update_one({"_id": key}, {"$set": {"state": "done", "done": len(ids), "total": len(ids),
                                                      "updated_at": now_utc()}})


async def run_pending(db: AsyncIOMotorDatabase) -> int:
    """The reconciler's pass: finish re-apply jobs a stopped process left running (no update for 2 minutes)."""
    from datetime import timedelta

    n = 0
    stale = now_utc() - timedelta(minutes=2)
    async for job in db[JOBS].find({"state": "running", "updated_at": {"$lt": stale}}).limit(5):
        await db[JOBS].update_one({"_id": job["_id"]}, {"$set": {"updated_at": now_utc()}})
        await run_job(db, job["_id"])
        n += 1
    return n


# ── Search (services/search.py doc_filter: a superset, every hit re-decided by access.can) ──


async def search_parts(db: AsyncIOMotorDatabase, actor, ctx, member_ws: list[str]) -> tuple[list[str], list[dict]]:
    """(folder ids a member's search must skip, extra ``$or`` branches for folders that name the caller —
    in their workspaces and in workspaces they aren't in)."""
    hidden: list[str] = []
    ors: list[dict] = []
    uid, email = actor.user_id, actor.email
    if not uid:
        return hidden, ors
    workspaces = list(member_ws)
    if email:
        for w in await db["folders"].distinct("workspace_id", {"access.people.email": email}):
            if w not in workspaces:
                workspaces.append(w)
    for w in workspaces:
        rules = await ctx.folder_rules(w)
        if not rules.any:
            continue
        role = await ctx.role(w, uid)
        member_teams = (await ctx.team_view(w, uid)).member_teams if role else set()
        if role:
            from app.models.workspace import role_allows

            hidden.extend(rules.hidden_ids(email, member_teams, role, role_allows(role, "admin")))
        granted = rules.granted_ids(email, member_teams, role)
        if granted:
            ors.append({"workspace_id": w, "folder_id": {"$in": granted}, "access_level": {"$ne": "private"}})
    return hidden, ors


async def item_folder_access(actor, raw: dict, ctx) -> dict | None:
    """An item's folder rule as its access panel shows it (None when its folder has none)."""
    ws_id = raw.get("workspace_id")
    fid = raw.get("folder_id")
    if not ws_id or not fid:
        return None
    rules = await ctx.folder_rules(ws_id)
    r = rules.rule(fid)
    if r is None:
        return None
    from app.services import access

    f = await access.facts(actor, raw, ctx)
    can_override = bool(actor.user_id and actor.cred != "tenant" and f.role in ("owner", "editor")
                        and raw.get("parent_id") is None and r.restricted)
    tv = await ctx.team_view(ws_id, actor.user_id) if actor.user_id else None
    teams = [{"name": ((tv.teams.get(t) if tv else None) or {}).get("name") or "Deleted team"} for t in r.teams]
    return {"folder_id": fid, "path": rules.path(fid), "name": rules.name(fid), "restricted": r.restricted,
            "restricted_by": rules.path(r.restricted_by) if r.restricted else None,
            "override": bool(raw.get("folder_override")), "can_override": can_override,
            "summary": summary_text(r, rules, fid, teams)}
