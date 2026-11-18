"""Move a folder to another team (2026-11-19; brief .work/briefs/jason-folders-todos.md §1).

    GET  /api/v1/workspaces/{ws}/folders/{id}/move-to-team?team=…   what would move (the confirm dialog's counts)
    POST /api/v1/workspaces/{ws}/folders/{id}/move-to-team          move it ({team, parent_id?})
    GET  /api/v1/workspaces/{ws}/folders/{id}/move-to-team/job      progress of a big move
    MCP  move_folder_to_team (dry_run: the same preview)

The folder and everything below it — subfolders, pages with their sub-pages, documents, files, meeting pages'
rows — leave the source team's Files & pages for the target team's (``team_ids`` on the folders and the items,
services/teams.py; General = company-wide = no team id). What that does to who can open what:

* **Visible to the whole workspace** (``workspace``) ⇒ visible to the target team only (the team rule:
  its members; an *open* team is still readable by the workspace, as viewers). Project tags of projects
  the target team isn't linked to are dropped (they would keep the item open to the old team's project).
* **Private** stays private (the access level is never touched).
* **People an item was shared with by name** keep it (grants are never touched).
* **Public links** keep working (the link level is never touched: prospects may hold them) — the preview
  lists them, and folder share links in the subtree too.
* **Folder access rules** (services/folder_access.py) are kept: a grant to the source team now names the
  target team (same role); a rule the folder inherited from a parent it leaves is copied onto it first, so
  nothing below becomes more open than it was (restriction, people, other teams).

Where it lands: under its current parent when that folder is in the target team, else under ``parent_id``
(a folder of the target team) when given, else at the top of the workspace (old addresses redirect,
services/folder.py). Logged in the folder's access log ("Moved from Sales to Marketing…").

Who may: workspace admins, or a lead of every team the folder is in (General: its leads) who is also a member
of the target team. Up to :data:`INLINE_MAX` items move in the request; more go to a background job with
progress (resumed by the reconciler, :func:`run_pending`), the folders and the rule having moved first —
until an item's turn it stays readable by the source team only, never by anyone new.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import teams as T

log = logging.getLogger(__name__)

JOBS = "folder_move_jobs"
INLINE_MAX = 100
BATCH = 50
LISTED = 25          # public links named in the preview (the rest counted)
MAX_ITEMS = 20_000

_TASKS: set = set()


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[JOBS].create_index("state")


def _key(workspace_id: str, folder_id: str) -> str:
    return f"{workspace_id}:{folder_id}"


def _job_out(job: dict | None) -> dict | None:
    if not job:
        return None
    return {"state": job.get("state"), "done": int(job.get("done") or 0), "total": int(job.get("total") or 0),
            "to_team": job.get("to_team_name")}


# ── The plan ──────────────────────────────────────────────────────────────────


async def _folder(db: AsyncIOMotorDatabase, workspace_id: str, folder_id: str) -> dict:
    o = T.oid(folder_id)
    row = await db["folders"].find_one({"_id": o, "workspace_id": workspace_id}) if o is not None else None
    if row is None:
        raise T.Refused(404, "Folder not found.")
    if row.get("meetings") or row.get("meetings_sub"):
        raise T.Refused(409, "Meetings folders belong to their team's Meetings; move single meetings instead.")
    if row.get("hidden"):
        raise T.Refused(409, "Deal folders follow their deal; they can't be moved to another team.")
    return row


def source_ids(view: T.TeamView, folder: dict) -> list[str]:
    """The teams the folder is in now (General when none)."""
    own = [t for t in T.ids_of(folder, "team_ids") if t in view.teams]
    if own:
        return own
    return [view.general_id] if view.general_id else []


def may_move(view: T.TeamView, ws_role: str | None, sources: list[str], target: str) -> bool:
    """Admins; or a lead of every source team who is also a member of the target team (the safe rule)."""
    from app.models.workspace import role_allows

    if view.admin:
        return True
    if not role_allows(ws_role, "member") or not sources:
        return False
    return all(view.lead_of(s) for s in sources) and (target in view.member_teams or view.lead_of(target))


async def _all_ids(db: AsyncIOMotorDatabase, top: list[ObjectId]) -> list[ObjectId]:
    """The items and every sub-page below them (one query per level)."""
    from app.services import access

    out, seen, frontier = list(top), set(top), list(top)
    for _ in range(access.MAX_PAGE_DEPTH):
        if not frontier:
            break
        kids = await db["documents"].find({"parent_id": {"$in": frontier}}, {"_id": 1}).to_list(length=MAX_ITEMS)
        frontier = [k["_id"] for k in kids if k["_id"] not in seen]
        seen.update(frontier)
        out.extend(frontier)
    return out


async def _subtree(db: AsyncIOMotorDatabase, workspace_id: str, folder_id: str) -> list[str]:
    from app.services import folder as folder_service

    return folder_service.subtree_ids(await folder_service.list_folders(db, workspace_id), folder_id)


async def _top_items(db: AsyncIOMotorDatabase, workspace_id: str, sub: list[str]) -> list[ObjectId]:
    rows = await db["documents"].find({"workspace_id": workspace_id, "folder_id": {"$in": sub}, "parent_id": None},
                                      {"_id": 1}).to_list(length=MAX_ITEMS)
    return [r["_id"] for r in rows]


def _kept_projects(view: T.TeamView, target: str) -> set[str]:
    if T.is_general(view.teams.get(target)):
        return set(view.projects)
    return {pid for pid, p in view.projects.items() if target in [str(t) for t in p.get("team_ids") or []]}


async def _target(db: AsyncIOMotorDatabase, view: T.TeamView, ref: str | None) -> dict:
    if not ref:
        raise T.Refused(422, "Choose the team to move the folder to.")
    row = await T.get_team(db, view.workspace_id, str(ref))
    if row is None or str(row["_id"]) not in view.readable_teams | view.member_teams:
        raise T.Refused(404, "Team not found.")
    return row


async def _landing(db: AsyncIOMotorDatabase, view: T.TeamView, folder: dict, target: str, sub: list[str],
                   parent_ref: str | None) -> tuple[str | None, bool]:
    """(the parent the folder will sit under, whether that is a re-parent)."""
    general = T.is_general(view.teams.get(target))

    def in_target(row: dict | None) -> bool:
        if row is None:
            return False
        tids = T.ids_of(row, "team_ids")
        return (not tids) if general else (target in tids)

    if parent_ref:
        p = await db["folders"].find_one({"_id": T.oid(parent_ref), "workspace_id": view.workspace_id})
        if p is None or str(p["_id"]) in sub:
            raise T.Refused(422, "That folder can't hold this one.")
        if not in_target(p) or p.get("meetings") or p.get("meetings_sub") or p.get("hidden"):
            raise T.Refused(422, "Choose a folder of the team you're moving it to.")
        return str(p["_id"]), str(p["_id"]) != folder.get("parent_id")
    cur = folder.get("parent_id")
    if cur:
        p = await db["folders"].find_one({"_id": T.oid(cur), "workspace_id": view.workspace_id})
        if in_target(p):
            return cur, False
        return None, True
    return None, False


async def preview(db: AsyncIOMotorDatabase, actor, ctx, workspace_id: str, folder_id: str, team_ref: str | None,
                  parent_ref: str | None = None) -> dict:
    """What moving the folder to the team would do: the confirm dialog's counts (and the MCP dry run)."""
    from app.services import access, folder_access
    from app.services.workspace_items import display_title

    folder = await _folder(db, workspace_id, folder_id)
    view = await ctx.team_view(workspace_id, actor.user_id)
    role = await ctx.role(workspace_id, actor.user_id)
    target = await _target(db, view, team_ref)
    tid = str(target["_id"])
    fid = str(folder["_id"])
    sources = source_ids(view, folder)
    sub = await _subtree(db, workspace_id, fid)
    parent, reparent = await _landing(db, view, folder, tid, sub, parent_ref)
    top = await _top_items(db, workspace_id, sub)
    ids = await _all_ids(db, top)
    rows = await db["documents"].find(
        {"_id": {"$in": ids}},
        {"slug": 1, "title": 1, "kind": 1, "editor": 1, "original_filename": 1, "access_level": 1,
         "read_password_hash": 1, "folder_capped": 1, "folder_override": 1, "team_ids": 1, "project_ids": 1,
         "workspace_id": 1, "folder_id": 1, "parent_id": 1, "owner_id": 1}).to_list(length=MAX_ITEMS)
    pages = files = docs = ws_vis = private = 0
    links: list[dict] = []
    link_count = 0
    keep_p = _kept_projects(view, tid)
    dropped_projects: set[str] = set()
    for r in rows:
        if r.get("kind") == "artifact":
            files += 1
        elif r.get("editor") == "blocks":
            pages += 1
        else:
            docs += 1
        level = r.get("access_level") or "link"
        dropped_projects.update(p for p in T.ids_of(r, "project_ids") if p not in keep_p)
        if level == "private":
            private += 1
        elif level == "workspace" or r.get("folder_capped"):
            ws_vis += 1
        else:
            link_count += 1
            # Named only when the caller can open it (and up to LISTED); the rest are counted.
            full = await db["documents"].find_one({"_id": r["_id"]}) if len(links) < LISTED else None
            if full is not None and (await access.can(actor, full, "read", ctx)).allowed:
                links.append({"slug": r.get("slug"), "title": display_title(r),
                              "kind": "file" if r.get("kind") == "artifact" else
                              ("page" if r.get("editor") == "blocks" else "document"),
                              "password": bool(r.get("read_password_hash"))})
    shared = len(await db["document_grants"].distinct("document_id", {"document_id": {"$in": [str(i) for i in ids]}})) \
        if ids else 0
    frows = await db["folders"].find({"_id": {"$in": [T.oid(x) for x in sub]}},
                                     {"name": 1, "share": 1, "access": 1}).to_list(length=len(sub))
    folder_links = [f["name"] for f in frows if (f.get("share") or {}).get("level") == "link" and (f.get("share") or {}).get("id")]
    rules = await folder_access.load_tree(db, workspace_id)
    repoint = sum(1 for f in frows for t in (f.get("access") or {}).get("teams") or []
                  if str(t.get("team_id")) in sources and str(t.get("team_id")) != tid)
    inherited = False
    if reparent and folder.get("parent_id"):
        r = rules.rule(folder["parent_id"])
        inherited = r is not None
    job = await db[JOBS].find_one({"_id": _key(workspace_id, fid), "state": "running"})
    same = sources == [tid] or (not T.ids_of(folder, "team_ids") and T.is_general(target))
    return {
        "folder": {"id": fid, "name": folder.get("name"), "path": rules.path(fid)},
        "from_teams": [T.team_card(view, view.teams[s]) for s in sources if s in view.teams],
        "to_team": T.team_card(view, target),
        "to_team_open": target.get("visibility") == "open" and not T.is_general(target),
        "parent_id": parent, "parent_path": rules.path(parent) if parent else None,
        "moves_to_top": reparent and parent is None,
        "can_move": may_move(view, role, sources, tid) and not same,
        "same_team": same,
        "counts": {"folders": len(sub), "items": len(rows), "pages": pages, "documents": docs, "files": files,
                   "workspace_to_team": ws_vis, "private": private, "public_links": link_count + len(folder_links),
                   "shared_with_people": shared, "team_grants_repointed": repoint,
                   "projects_dropped": len(dropped_projects)},
        "public_links": links, "public_links_more": link_count - len(links), "folder_links": folder_links[:LISTED],
        "keeps_inherited_rule": inherited,
        "background": len(top) > INLINE_MAX,
        "job": _job_out(job),
    }


# ── The move ──────────────────────────────────────────────────────────────────


def _merge(dst: dict[str, dict], key: str, entry: dict) -> None:
    rank = {"viewer": 1, "editor": 2}
    have = dst.get(key)
    if have is None or rank.get(entry.get("role"), 0) > rank.get(have.get("role"), 0):
        dst[key] = entry


async def _carry_rules(db: AsyncIOMotorDatabase, actor, workspace_id: str, folder: dict, sub: list[str],
                       sources: list[str], target: str, reparent: bool) -> list[str]:
    """Keep the folder rules: copy an inherited rule onto the folder it leaves its parent with (so nothing
    below gets more open), and re-point grants to a source team at the target team. Returns log lines."""
    from app.services import folder_access

    rules = await folder_access.load_tree(db, workspace_id)
    fid = str(folder["_id"])
    now = now_utc()
    texts: list[str] = []
    rows = await db["folders"].find({"_id": {"$in": [T.oid(x) for x in sub]}, "access": {"$exists": True}},
                                    {"access": 1}).to_list(length=len(sub))
    by_id = {str(r["_id"]): r for r in rows}
    if reparent and folder.get("parent_id"):
        up = rules.rule(folder["parent_id"])
        if up is not None:
            own = dict((by_id.get(fid) or {}).get("access") or {})
            people = {p["email"]: p for p in own.get("people") or []}
            teams = {str(t["team_id"]): t for t in own.get("teams") or []}
            for e, ent in up.people.items():
                _merge(people, e, {"email": e, "role": ent.role, "by": actor.user_id, "at": now})
            for t, ent in up.teams.items():
                _merge(teams, t, {"team_id": t, "role": ent.role, "by": actor.user_id, "at": now})
            own.update({"restricted": bool(own.get("restricted") or up.restricted), "people": list(people.values()),
                        "teams": list(teams.values()), "updated_at": now, "updated_by": actor.user_id})
            by_id[fid] = {"_id": folder["_id"], "access": own}
            texts.append("kept the access rule it had from " + (rules.path(folder["parent_id"]) or "its parent"))
    repointed = 0
    for x, row in by_id.items():
        a = dict(row.get("access") or {})
        teams: dict[str, dict] = {}
        changed = x == fid and bool(texts)
        for t in a.get("teams") or []:
            t_id = str(t.get("team_id"))
            if t_id in sources and t_id != target:
                _merge(teams, target, {**t, "team_id": target, "by": actor.user_id, "at": now})
                changed = True
                repointed += 1
            else:
                _merge(teams, t_id, t)
        if not changed:
            continue
        a["teams"] = list(teams.values())
        await db["folders"].update_one({"_id": row["_id"]}, {"$set": {"access": a}})
    if repointed:
        texts.append(f"re-pointed {repointed} team grant(s) to the new team")
    return texts


async def move(db: AsyncIOMotorDatabase, actor, ctx, workspace_id: str, folder_id: str, team_ref: str | None,
               parent_ref: str | None = None) -> dict:
    """Move the folder (and everything in it) to the team. Returns the preview's counts plus ``job``
    (``state`` done | running, ``done``, ``total``)."""
    from app.services import folder as folder_service
    from app.services import folder_access, revalidate

    if not actor.user_id or actor.cred == "tenant":
        raise T.Refused(401, "Sign in on markdrop.in to move folders between teams.")
    plan = await preview(db, actor, ctx, workspace_id, folder_id, team_ref, parent_ref)
    if plan["same_team"]:
        raise T.Refused(409, f"The folder is already in {plan['to_team']['name']}.")
    if not plan["can_move"]:
        raise T.Refused(403, "Only workspace admins, or a lead of the folder's team who is also in the team "
                             "you're moving it to, can move a folder between teams.")
    fid = plan["folder"]["id"]
    key = _key(workspace_id, fid)
    if await db[JOBS].find_one({"_id": key, "state": "running"}):
        raise T.Refused(409, "This folder is already moving. Wait for it to finish.")
    folder = await _folder(db, workspace_id, fid)
    view = await ctx.team_view(workspace_id, actor.user_id)
    target = str(plan["to_team"]["id"])
    sources = source_ids(view, folder)
    sub = await _subtree(db, workspace_id, fid)
    parent, reparent = await _landing(db, view, folder, target, sub, parent_ref)
    tids = [] if T.is_general(view.teams.get(target)) else [target]
    keep_p = _kept_projects(view, target)

    # 1. The rule first (before leaving a parent whose rule it inherited): nothing below opens up.
    texts = await _carry_rules(db, actor, workspace_id, folder, sub, sources, target, reparent)
    # 2. The folders: in the target team's Files & pages.
    frows = await db["folders"].find({"_id": {"$in": [T.oid(x) for x in sub]}}, {"project_ids": 1}).to_list(length=len(sub))
    for f in frows:
        pids = [p for p in T.ids_of(f, "project_ids") if p in keep_p]
        await db["folders"].update_one({"_id": f["_id"]}, T.team_update(tids, pids))
    # 3. Its place: under a folder of the target team, or the top of the workspace.
    if reparent:
        async with revalidate.batch(db):
            await folder_service.update_folder(db, workspace_id, fid, parent_id=parent, reparent=True,
                                               on_conflict="suffix", actor=actor, ctx=ctx)
    ctx.forget()
    # 4. The items (and their sub-pages, meeting rows): now, or in a background job.
    top = await _top_items(db, workspace_id, sub)
    from_names = ", ".join(t["name"] or "a team" for t in plan["from_teams"]) or "the workspace"
    to_name = plan["to_team"]["name"]
    c = plan["counts"]
    summary = (f"moved the folder from {from_names} to {to_name} ({c['items']} item(s), {c['folders']} folder(s); "
               f"{c['workspace_to_team']} workspace-visible now team-only, {c['public_links']} public link(s) kept)")
    await folder_access._log(db, actor, workspace_id, fid, "; ".join([summary, *texts]), kind="move_team",
                             from_team_ids=sources, to_team_id=target)
    now = now_utc()
    job_row = {"workspace_id": workspace_id, "folder_id": fid, "team_ids": tids, "keep_projects": sorted(keep_p),
               "ids": top, "done": 0, "total": len(top), "to_team_name": to_name, "by": actor.user_id,
               "state": "running", "started_at": now, "updated_at": now}
    if len(top) <= INLINE_MAX:
        await _apply(db, job_row, top)
        await db[JOBS].delete_one({"_id": key})
        job = {"state": "done", "done": len(top), "total": len(top), "to_team": to_name}
        await _after(db, workspace_id, fid)
    else:
        await db[JOBS].replace_one({"_id": key}, job_row, upsert=True)
        task = asyncio.get_running_loop().create_task(run_job(db, key))
        _TASKS.add(task)
        task.add_done_callback(_TASKS.discard)
        job = {"state": "running", "done": 0, "total": len(top), "to_team": to_name}
    ctx.forget()
    return {**plan, "moved": True, "job": job}


async def _apply(db: AsyncIOMotorDatabase, job: dict, ids: list[ObjectId]) -> int:
    tids = list(job.get("team_ids") or [])
    keep_p = set(job.get("keep_projects") or [])
    n = 0
    for i in range(0, len(ids), BATCH):
        for raw in await db["documents"].find({"_id": {"$in": ids[i:i + BATCH]}},
                                              {"slug": 1, "project_ids": 1, "team_ids": 1}).to_list(length=BATCH):
            pids = [p for p in T.ids_of(raw, "project_ids") if p in keep_p]
            try:
                slugs = await T.apply_to_doc(db, raw, tids, pids)
                T.notify_moved(slugs, tids, pids)
            except Exception:  # pragma: no cover - the reconciler's pass tries again
                log.warning("folder move: item %s failed", raw.get("slug"), exc_info=True)
            n += 1
    return n


async def _after(db: AsyncIOMotorDatabase, workspace_id: str, folder_id: str) -> None:
    from app.services import folder_access

    if (await folder_access.load_rules(db, workspace_id)).any:
        await folder_access.after_rule_change(db, workspace_id, [folder_id])


async def run_job(db: AsyncIOMotorDatabase, key: str) -> None:
    job = await db[JOBS].find_one({"_id": key})
    if job is None or job.get("state") != "running":
        return
    ids = list(job.get("ids") or [])
    done = int(job.get("done") or 0)
    while done < len(ids):
        chunk = ids[done:done + BATCH]
        await _apply(db, job, chunk)
        done += len(chunk)
        await db[JOBS].update_one({"_id": key}, {"$set": {"done": done, "updated_at": now_utc()}})
    await _after(db, job["workspace_id"], job["folder_id"])
    await db[JOBS].update_one({"_id": key}, {"$set": {"state": "done", "done": len(ids), "updated_at": now_utc()},
                                             "$unset": {"ids": ""}})


async def run_pending(db: AsyncIOMotorDatabase) -> int:
    """The reconciler's pass: finish moves a stopped process left running (no progress for 2 minutes)."""
    n = 0
    stale = now_utc() - timedelta(minutes=2)
    async for job in db[JOBS].find({"state": "running", "updated_at": {"$lt": stale}}, {"_id": 1}).limit(3):
        await db[JOBS].update_one({"_id": job["_id"]}, {"$set": {"updated_at": now_utc()}})
        await run_job(db, job["_id"])
        n += 1
    return n


async def status(db: AsyncIOMotorDatabase, actor, ctx, workspace_id: str, folder_id: str) -> dict:
    from app.models.workspace import role_allows

    if not role_allows(await ctx.role(workspace_id, actor.user_id), "viewer"):
        raise T.Refused(404, "Folder not found.")
    job = await db[JOBS].find_one({"_id": _key(workspace_id, str(folder_id))})
    return {"job": _job_out(job)}


def http(exc: T.Refused) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=exc.detail)

