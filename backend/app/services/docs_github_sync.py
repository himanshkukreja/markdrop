"""Markdrop Guides: a guide imported from a GitHub repository, and kept in sync with it.

The link (``docs_sites.github``)::

    {installation_id: int | None, owner, name, repo_id, branch, path, format, mode: "drafts"|"publish",
     sync: bool, public: bool, status: "idle"|"queued"|"syncing"|"error", last_synced_sha,
     last_synced_at, last_error, last_job_id, last_applied_at, connected_by, connected_at,
     openapi_paths}

``installation_id`` is None for a public repository read without the app (an import, never a
sync: syncing needs the app's webhook). ``path`` is the project folder (docs_github_detect).

Every import and sync is an ``import`` job (payload ``{source: {kind: "github", …}, trigger,
sync_id, requested_by, pusher}``) that runs where imports run (GitHub Actions; the runner downloads
the repository at the commit and converts it: frontend/scripts/docs-import/github.mjs), and comes
back to :func:`apply_github`, which diffs it against the guide:

- GitHub is the source of truth for the pages it brought (``page.origin = {kind: "github", path,
  sha}``): they are created, updated (a new draft revision; history keeps every earlier one,
  studio edits included), moved (a page whose file was renamed keeps its id; the old address
  redirects) and deleted when their file goes.
- Pages made in the studio are never touched. On the first sync of a guide that already had pages
  (connecting an existing guide), a page at the same address is taken over by GitHub; after that a
  file whose address belongs to a studio page is left out (and reported).
- ``mode: "publish"`` publishes after a sync that changed something (the usual publish pipeline:
  quotas, coalescing, the build queue), as the person who connected the repository.

Each run is a row in ``docs_github_syncs`` (Settings › GitHub's history). Installations of the app
linked to a workspace (or to one person, for personal guides) are in ``docs_github_installations``;
webhook delivery ids in ``docs_github_deliveries`` (7 days) make a redelivery a no-op.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from app.config import get_settings
from app.models.user import User
from app.services import docs_github_app as gh
from app.services import docs_github_detect as detect
from app.services import docs_jobs
from app.services.docs_jobs import ASSETS, JOBS, PAGES, SITES, VERSIONS, now  # noqa: F401
from app.services.docs_snapshot import valid_page_path

log = logging.getLogger("markdrop.docs_github_sync")

INSTALLS = "docs_github_installations"
SYNCS = "docs_github_syncs"
DELIVERIES = "docs_github_deliveries"
MODES = ("drafts", "publish")
TRIGGERS = ("import", "connect", "push", "manual")
HISTORY = 20


# ── Indexes ──────────────────────────────────────────────────────────────────


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[INSTALLS].create_index([("installation_id", 1), ("workspace_id", 1), ("owner_id", 1)], unique=True)
    await db[INSTALLS].create_index([("workspace_id", 1)])
    await db[SYNCS].create_index([("site_id", 1), ("created_at", -1)])
    await db[SYNCS].create_index([("job_id", 1)])
    await db[DELIVERIES].create_index([("at", 1)], expireAfterSeconds=7 * 24 * 3600)
    await db[SITES].create_index([("github.installation_id", 1), ("github.owner_lc", 1), ("github.name_lc", 1)],
                                 sparse=True)


# ── Scopes and installations ──────────────────────────────────────────────────


def scope_of_site(site: dict) -> tuple[str | None, str | None]:
    """(workspace_id, owner_id) whose installations a site may use: its workspace's, or for a
    personal guide its owner's."""
    return (site.get("workspace_id") or None, None if site.get("workspace_id") else site.get("owner_id"))


def _scope_query(workspace_id: str | None, owner_id: str | None) -> dict:
    return {"workspace_id": workspace_id} if workspace_id else {"workspace_id": None, "owner_id": owner_id}


async def require_scope_admin(db: AsyncIOMotorDatabase, user: User, workspace_id: str | None) -> tuple[str | None, str | None]:
    """The scope a caller manages GitHub for: a workspace where they are a Guides admin (404 for a
    non-member, 403 for someone else), or "personal" (themselves)."""
    from app.services import docs_studio_roles as roles
    from app.services import workspace as ws_service

    if not workspace_id or workspace_id == "personal":
        return None, user.id
    ws = await ws_service.get_workspace(db, workspace_id)
    ws_role = await ws_service.role_for(db, workspace_id, user.id) if ws else None
    if ws is None or ws_role is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    access = await roles.workspace_role(db, workspace_id, user.id, ws_role)
    if not roles.role_at_least(access.role, "admin"):
        raise HTTPException(status_code=403, detail="Only Guides admins can connect GitHub.")
    return workspace_id, None


def installation_view(row: dict) -> dict:
    acct = row.get("account") or {}
    iid = int(row["installation_id"])
    login = acct.get("login") or ""
    manage = (f"{gh.web_base()}/organizations/{login}/settings/installations/{iid}"
              if acct.get("type") == "Organization" else f"{gh.web_base()}/settings/installations/{iid}")
    return {
        "installation_id": iid,
        "account": {"login": login, "type": acct.get("type") or "User", "avatar_url": acct.get("avatar_url")},
        "repository_selection": row.get("repository_selection") or "selected",
        "suspended": bool(row.get("suspended")),
        "manage_url": manage,
    }


async def list_installations(db: AsyncIOMotorDatabase, workspace_id: str | None, owner_id: str | None) -> list[dict]:
    rows = await db[INSTALLS].find({**_scope_query(workspace_id, owner_id), "deleted_at": None}) \
        .sort("linked_at", 1).to_list(length=50)
    return [installation_view(r) for r in rows]


async def scope_installation(db: AsyncIOMotorDatabase, workspace_id: str | None, owner_id: str | None,
                             installation_id: Any) -> dict:
    """The installation, linked to this scope and usable (404 otherwise: never confirm one exists)."""
    try:
        iid = int(installation_id)
    except (TypeError, ValueError):
        raise HTTPException(status_code=404, detail="That GitHub account isn't connected here.") from None
    row = await db[INSTALLS].find_one({**_scope_query(workspace_id, owner_id), "installation_id": iid, "deleted_at": None})
    if row is None:
        raise HTTPException(status_code=404, detail="That GitHub account isn't connected here.")
    if row.get("suspended"):
        raise HTTPException(status_code=409, detail="The Markdrop Guides app is suspended on that GitHub account. "
                                                    "Unsuspend it on GitHub to use it again.")
    return row


def app_matches(inst: dict) -> bool:
    s = get_settings()
    return str(inst.get("app_id") or "") == str(s.docs_github_app_id) or \
        (inst.get("app_slug") and inst.get("app_slug") == s.docs_github_app_slug)


async def connect(db: AsyncIOMotorDatabase, user: User, *, code: str, state: str,
                  installation_id: int | None) -> dict:
    """The end of the install / authorize round trip: prove which installations this GitHub user
    can reach (their OAuth code, used once) and link them to the scope the state names."""
    if not gh.configured():
        raise HTTPException(status_code=503, detail="The Markdrop Guides GitHub App isn't set up yet.")
    st = gh.verify_state(state, user.id)
    if st is None:
        raise HTTPException(status_code=400, detail="This link has expired or was made for someone else. "
                                                    "Start again from Markdrop.")
    workspace_id, owner_id = await require_scope_admin(db, user, st["workspace_id"])
    try:
        token = await gh.exchange_code(code)
    except gh.GitHubError as e:
        raise HTTPException(status_code=e.status, detail=e.message) from None
    try:
        reachable = [i for i in await gh.user_installations(token) if app_matches(i)]
    except gh.GitHubError as e:
        raise HTTPException(status_code=e.status if e.status != 404 else 502, detail=e.message) from None
    finally:
        await gh.revoke_user_token(token)
    if installation_id is not None and int(installation_id) not in {int(i["id"]) for i in reachable}:
        raise HTTPException(status_code=403, detail="Your GitHub account can't open that installation. "
                                                    "Ask an owner of the GitHub account to connect it.")
    wanted = [i for i in reachable if installation_id is None or int(i["id"]) == int(installation_id)]
    at = now()
    linked: list[int] = []
    for inst in wanted:
        acct = inst.get("account") or {}
        await db[INSTALLS].update_one(
            {"installation_id": int(inst["id"]), "workspace_id": workspace_id, "owner_id": owner_id},
            {"$set": {"account": {"login": acct.get("login"), "type": acct.get("type"), "id": acct.get("id"),
                                  "avatar_url": acct.get("avatar_url")},
                      "repository_selection": inst.get("repository_selection"),
                      "suspended": bool(inst.get("suspended_at")), "deleted_at": None, "updated_at": at},
             "$setOnInsert": {"linked_by": user.id, "linked_at": at}},
            upsert=True)
        linked.append(int(inst["id"]))
    await docs_jobs.log_event(db, "docs_github_connected", None, user.id, installations=len(linked),
                              workspace_id=workspace_id)
    return {"installations": await list_installations(db, workspace_id, owner_id), "linked": linked,
            "return_to": safe_return(st["return_to"]), "workspace_id": workspace_id or "personal"}


def safe_return(path: Any) -> str:
    p = str(path or "")
    if not p.startswith("/guides") or p.startswith("//") or "\\" in p or any(c in p for c in "\r\n\t "):
        return "/guides"
    return p[:500]


async def unlink_installation(db: AsyncIOMotorDatabase, workspace_id: str | None, owner_id: str | None,
                              installation_id: int) -> None:
    res = await db[INSTALLS].update_one(
        {**_scope_query(workspace_id, owner_id), "installation_id": int(installation_id), "deleted_at": None},
        {"$set": {"deleted_at": now()}})
    if not res.matched_count:
        raise HTTPException(status_code=404, detail="That GitHub account isn't connected here.")


# ── The link on a site ────────────────────────────────────────────────────────


def link_view(site: dict) -> dict | None:
    g = site.get("github")
    if not isinstance(g, dict) or not g.get("owner"):
        return None
    sha = g.get("last_synced_sha")
    return {
        "installation_id": g.get("installation_id"),
        "owner": g.get("owner"),
        "name": g.get("name"),
        "branch": g.get("branch"),
        "path": g.get("path") or "",
        "format": g.get("format") or "auto",
        "detected_format": g.get("detected_format"),
        "mode": g.get("mode") or "drafts",
        "sync": bool(g.get("sync")),
        "public": bool(g.get("public")),
        "status": g.get("status") or "idle",
        "last_synced_sha": sha,
        "last_synced_at": docs_jobs.aware(g.get("last_synced_at")),
        "last_commit_url": gh.commit_url(g["owner"], g["name"], sha),
        "last_error": g.get("last_error"),
        "last_job_id": str(g["last_job_id"]) if g.get("last_job_id") else None,
        "html_url": gh.repo_url(g["owner"], g["name"], g.get("branch"), g.get("path") or None),
        "openapi_paths": list(g.get("openapi_paths") or []),
        "connected_at": docs_jobs.aware(g.get("connected_at")),
    }


def new_link(*, owner: str, name: str, branch: str, path: str, installation_id: int | None, fmt: str | None,
             mode: str | None, sync: bool, user_id: str, repo_id: Any = None) -> dict:
    return {
        "installation_id": int(installation_id) if installation_id else None,
        "owner": owner, "name": name, "owner_lc": owner.lower(), "name_lc": name.lower(), "repo_id": repo_id,
        "branch": branch, "path": detect.norm_folder(path), "format": fmt if fmt in detect.FORMATS else "auto",
        "mode": mode if mode in MODES else "drafts", "sync": bool(sync and installation_id), "public": not installation_id,
        "status": "queued", "last_synced_sha": None, "last_synced_at": None, "last_error": None, "last_job_id": None,
        "last_applied_at": None, "connected_by": user_id, "connected_at": now(), "openapi_paths": [],
    }


async def check_repo_access(db: AsyncIOMotorDatabase, site_scope: tuple[str | None, str | None], owner: str,
                            name: str, installation_id: int | None, want_sync: bool) -> dict:
    """The repository, as the guide will read it: through a linked installation, or (none) as a
    public repository. Sync needs the app."""
    if installation_id:
        if not gh.configured():
            raise HTTPException(status_code=503, detail="Private repositories and sync need the Markdrop Guides "
                                                        "GitHub App, which isn't set up yet.")
        await scope_installation(db, *site_scope, installation_id)
    elif want_sync:
        raise HTTPException(status_code=422, detail="Keeping a guide in sync needs the Markdrop Guides GitHub App "
                                                    "on the repository. Connect GitHub, or import once without sync.")
    try:
        repo = await gh.get_repo(owner, name, installation_id)
    except gh.GitHubError as e:
        raise HTTPException(status_code=e.status, detail=e.message) from None
    if not installation_id and repo["private"]:
        raise HTTPException(status_code=404, detail="We couldn't find that repository. Check the address, "
                                                    "or connect GitHub for a private one.")
    return repo


async def start_job(db: AsyncIOMotorDatabase, site: dict, *, trigger: str, user_id: str | None,
                    sha: str | None = None, pusher: str | None = None) -> dict:
    """Queue an import job for the site's link (a waiting one takes the newer commit instead), with
    its history row."""
    from app.services.docs_site_jobs import enqueue_job

    g = site.get("github") or {}
    source = {"kind": "github", "owner": g["owner"], "name": g["name"], "branch": g["branch"], "path": g.get("path") or "",
              "format": g.get("format") or "auto", "installation_id": g.get("installation_id"), "sha": sha}
    t = now()
    waiting = await db[JOBS].find_one_and_update(
        {"kind": "import", "site_id": site["_id"], "status": "queued", "payload.source.kind": "github"},
        {"$set": {"payload.source": source, "payload.pusher": pusher, "updated_at": t}},
        return_document=ReturnDocument.AFTER)
    if waiting is not None:
        await db[SYNCS].update_one({"job_id": waiting["_id"]}, {"$set": {"sha": sha, "pusher": pusher}})
        return waiting
    sync_id = ObjectId()
    job = await enqueue_job(db, "import", site["_id"], {
        "source": source, "trigger": trigger, "sync_id": str(sync_id), "requested_by": user_id, "pusher": pusher})
    await db[SYNCS].insert_one({
        "_id": sync_id, "site_id": site["_id"], "job_id": job["_id"], "trigger": trigger, "sha": sha, "pusher": pusher,
        "status": "queued", "pages": None, "published_build": None, "error": None, "warnings": [],
        "created_at": t, "finished_at": None, "by": user_id})
    await db[SITES].update_one({"_id": site["_id"]}, {"$set": {"github.status": "queued", "github.last_job_id": job["_id"],
                                                               "last_import_job_id": job["_id"]}})
    return job


async def syncs_today(db: AsyncIOMotorDatabase, site_id: ObjectId) -> int:
    start = now().replace(hour=0, minute=0, second=0, microsecond=0)
    return await db[SYNCS].count_documents({"site_id": site_id, "created_at": {"$gte": start}})


async def connect_site(db: AsyncIOMotorDatabase, site: dict, user: User, body: dict) -> tuple[dict, dict]:
    """Settings › GitHub: link an existing guide to a repository and start its first sync."""
    scope = scope_of_site(site)
    iid = body.get("installation_id") or None
    repo = await check_repo_access(db, scope, body["owner"], body["name"], iid, bool(body.get("sync")))
    link = new_link(owner=repo["owner"] or body["owner"], name=repo["name"] or body["name"], branch=body["branch"],
                    path=body.get("path") or "", installation_id=iid, fmt=body.get("format"), mode=body.get("mode"),
                    sync=bool(body.get("sync")), user_id=user.id, repo_id=repo.get("id"))
    link["first_sync"] = True
    await db[SITES].update_one({"_id": site["_id"]}, {"$set": {"github": link, "updated_at": now()}})
    site["github"] = link
    job = await start_job(db, site, trigger="connect", user_id=user.id)
    site = await db[SITES].find_one({"_id": site["_id"]})
    return site, job


async def update_link(db: AsyncIOMotorDatabase, site: dict, body: dict) -> dict:
    g = site.get("github")
    if not isinstance(g, dict):
        raise HTTPException(status_code=409, detail="This guide isn't connected to GitHub.")
    sets: dict = {}
    if body.get("mode") is not None:
        if body["mode"] not in MODES:
            raise HTTPException(status_code=422, detail="Mode is drafts or publish.")
        sets["github.mode"] = body["mode"]
    if body.get("sync") is not None:
        if body["sync"] and not g.get("installation_id"):
            raise HTTPException(status_code=422, detail="Keeping a guide in sync needs the Markdrop Guides GitHub App "
                                                        "on the repository.")
        sets["github.sync"] = bool(body["sync"])
    if body.get("format") is not None:
        if body["format"] not in (*detect.FORMATS, "auto"):
            raise HTTPException(status_code=422, detail="Unknown format.")
        sets["github.format"] = body["format"]
    if body.get("branch") is not None:
        sets["github.branch"] = body["branch"]
    if sets:
        sets["updated_at"] = now()
        await db[SITES].update_one({"_id": site["_id"]}, {"$set": sets})
    return await db[SITES].find_one({"_id": site["_id"]})


async def sync_now(db: AsyncIOMotorDatabase, site: dict, user: User) -> dict:
    g = site.get("github")
    if not isinstance(g, dict):
        raise HTTPException(status_code=409, detail="This guide isn't connected to GitHub.")
    if g.get("installation_id"):
        await scope_installation(db, *scope_of_site(site), g["installation_id"])
    if await syncs_today(db, site["_id"]) >= get_settings().docs_github_syncs_per_site_per_day:
        raise HTTPException(status_code=429, detail=f"A guide syncs at most {get_settings().docs_github_syncs_per_site_per_day} "
                                                    "times a day. Try again tomorrow (UTC).")
    return await start_job(db, site, trigger="manual", user_id=user.id)


async def disconnect(db: AsyncIOMotorDatabase, site: dict, user: User) -> None:
    """Stop syncing; the pages stay and become studio pages (their origin is cleared)."""
    if not isinstance(site.get("github"), dict):
        raise HTTPException(status_code=409, detail="This guide isn't connected to GitHub.")
    await db[SITES].update_one({"_id": site["_id"]}, {"$unset": {"github": ""}, "$set": {"updated_at": now()}})
    await db[PAGES].update_many({"site_id": site["_id"], "origin.kind": "github"}, {"$unset": {"origin": ""}})
    # A sync still waiting would bring the pages back: it is cancelled.
    async for j in db[JOBS].find({"kind": "import", "site_id": site["_id"], "status": "queued",
                                  "payload.source.kind": "github"}):
        await docs_jobs.fail(db, j["_id"], None, "The guide was disconnected from GitHub.")
        await db[SYNCS].update_one({"job_id": j["_id"]}, {"$set": {"status": "failed", "finished_at": now(),
                                                                   "error": "Disconnected before it ran."}})
    await docs_jobs.log_event(db, "docs_github_disconnected", site["_id"], user.id)


# ── History ───────────────────────────────────────────────────────────────────


def _short(sha: Any) -> str | None:
    return str(sha)[:7] if sha else None


async def history(db: AsyncIOMotorDatabase, site: dict, limit: int = HISTORY) -> list[dict]:
    rows = await db[SYNCS].find({"site_id": site["_id"]}).sort("created_at", -1).to_list(length=limit)
    jobs = {j["_id"]: j async for j in db[JOBS].find({"_id": {"$in": [r["job_id"] for r in rows if r.get("job_id")]}},
                                                      {"status": 1, "error": 1, "finished_at": 1, "updated_at": 1})}
    g = site.get("github") or {}
    owner, name = g.get("owner"), g.get("name")
    out = []
    for r in rows:
        status, error = r.get("status"), r.get("error")
        j = jobs.get(r.get("job_id"))
        # The job is the truth while the row isn't final (a sweeper may have failed it).
        if status in ("queued", "running") and j is not None:
            if j["status"] == "failed":
                status, error = "failed", j.get("error") or error
            elif j["status"] == "running":
                status = "running"
        out.append({
            "id": str(r["_id"]), "job_id": str(r["job_id"]) if r.get("job_id") else None,
            "trigger": r.get("trigger"), "sha": r.get("sha"), "short_sha": _short(r.get("sha")),
            "commit_url": gh.commit_url(owner, name, r.get("sha")) if owner else None,
            "pusher": r.get("pusher"), "status": status, "pages": r.get("pages"),
            "published_build": r.get("published_build"), "error": error, "warnings": r.get("warnings") or [],
            "created_at": docs_jobs.aware(r.get("created_at")), "finished_at": docs_jobs.aware(r.get("finished_at")),
        })
    return out


async def link_status(db: AsyncIOMotorDatabase, site: dict) -> dict | None:
    """The link with its status checked against its last job (a failed or swept job reads as error)."""
    view = link_view(site)
    if view is None:
        return None
    jid = (site.get("github") or {}).get("last_job_id")
    if jid and view["status"] in ("queued", "syncing"):
        j = await db[JOBS].find_one({"_id": jid}, {"status": 1, "error": 1})
        if j and j["status"] == "failed":
            view["status"], view["last_error"] = "error", j.get("error") or view["last_error"]
        elif j and j["status"] == "running":
            view["status"] = "syncing"
    return view


# ── The job: spec and result ──────────────────────────────────────────────────


async def import_spec(db: AsyncIOMotorDatabase, job: dict) -> dict:
    """What the runner needs (docs-platform/runner/lib.mjs runImport, kind "github"). For the app,
    a short-lived download link from GitHub (the runner never sees an installation token)."""
    src = (job.get("payload") or {}).get("source") or {}
    owner, name = src.get("owner"), src.get("name")
    ref = src.get("sha") or src.get("branch") or "main"
    iid = src.get("installation_id")
    try:
        url = await gh.tarball_url(owner, name, ref, iid)
    except gh.GitHubError as e:
        raise LookupError(f"GitHub: {e.message}") from None
    await db[SYNCS].update_one({"job_id": job["_id"]}, {"$set": {"status": "running"}})
    await db[SITES].update_one({"_id": job["site_id"], "github.last_job_id": job["_id"]}, {"$set": {"github.status": "syncing"}})
    return {
        "job": {"id": str(job["_id"]), "kind": "import", "site_id": str(job["site_id"]), "attempt": int(job.get("attempts") or 1)},
        "import": {"kind": "github", "site_id": str(job["site_id"]), "repo": {"owner": owner, "name": name},
                   "branch": src.get("branch"), "ref": ref, "path": src.get("path") or "",
                   "format": src.get("format") or "auto", "tarball_url": url,
                   "sync": (job.get("payload") or {}).get("trigger") in ("push", "manual")},
    }


async def job_failed(db: AsyncIOMotorDatabase, job: dict, error: str) -> None:
    """The runner reported a failed GitHub import: the history row and the link say so."""
    if ((job.get("payload") or {}).get("source") or {}).get("kind") != "github":
        return
    t = now()
    await db[SYNCS].update_one({"job_id": job["_id"]}, {"$set": {"status": "failed", "error": str(error)[:500], "finished_at": t}})
    await db[SITES].update_one({"_id": job["site_id"], "github.last_job_id": job["_id"]},
                               {"$set": {"github.status": "error", "github.last_error": str(error)[:500]}})


def _same(cur: dict, fields: dict, markdown: str, extra: dict) -> bool:
    d = cur.get("draft") or {}
    return all((cur.get(k) or None) == (v or None) for k, v in fields.items()) and \
        (d.get("markdown") or "") == markdown and (d.get("frontmatter_extra") or {}) == (extra or {})


def _merge_nav(imported: list[dict], old: list[dict], studio_ids: set[str], home_id: str | None) -> list[dict]:
    """GitHub's groups, then the studio's own pages where they were: in a group of the same name, or
    in their old group after GitHub's."""
    nav = [{"group": g["group"], "pages": list(g["pages"])} for g in imported]
    by_name = {g["group"]: g for g in nav}
    placed = {p for g in nav for p in g["pages"]}
    for g in old or []:
        keep = [p for p in g.get("pages") or [] if p in studio_ids and p not in placed and p != home_id]
        if not keep:
            continue
        if g.get("group") in by_name:
            by_name[g["group"]]["pages"].extend(keep)
        else:
            row = {"group": g.get("group") or "Pages", "pages": keep}
            nav.append(row)
            by_name[row["group"]] = row
        placed.update(keep)
    if home_id and home_id not in placed:
        if nav:
            nav[0]["pages"].insert(0, home_id)
        else:
            nav = [{"group": "Getting started", "pages": [home_id]}]
    elif home_id and nav and nav[0]["pages"][:1] != [home_id]:
        for g in nav:
            if home_id in g["pages"]:
                g["pages"].remove(home_id)
        nav[0]["pages"].insert(0, home_id)
    return [g for g in nav if g["pages"]][:100]


async def apply_github(db: AsyncIOMotorDatabase, job: dict, worker: str | None, data: dict) -> dict:
    """Store a GitHub import or sync (the runner's result): see the module docstring."""
    from app.services import docs_import_job as imp
    from app.services import docs_site_pages as pages_service
    from app.services import docs_site_settings as site_settings
    from app.services import docs_site_store as store

    cfg = get_settings()
    payload = job.get("payload") or {}
    trigger = payload.get("trigger") or "import"
    site = await db[SITES].find_one({"_id": job["site_id"], "deleted_at": None})
    if site is None:
        await docs_jobs.fail(db, job["_id"], worker, "the site no longer exists")
        return {"ok": False}
    g = site.get("github")
    if not isinstance(g, dict):
        await docs_jobs.fail(db, job["_id"], worker, "The guide was disconnected from GitHub.")
        await db[SYNCS].update_one({"job_id": job["_id"]}, {"$set": {"status": "failed", "finished_at": now(),
                                                                     "error": "Disconnected before it finished."}})
        return {"ok": False}
    # An older run finishing after a newer one already applied: nothing to do.
    applied = docs_jobs.aware(g.get("last_applied_at"))
    if applied and docs_jobs.aware(job.get("created_at")) and docs_jobs.aware(job["created_at"]) < applied:
        result = {"ok": True, "superseded": True}
        await docs_jobs.complete(db, job["_id"], worker, result)
        await db[SYNCS].update_one({"job_id": job["_id"]}, {"$set": {"status": "done", "finished_at": now(),
                                                                     "warnings": ["A newer commit was already synced."]}})
        return result

    by = payload.get("requested_by") or g.get("connected_by") or site.get("owner_id")
    first = trigger in ("import", "connect") or bool(g.get("first_sync"))
    commit = str(data.get("commit") or "")[:40] or None
    origins = data.get("origins") if isinstance(data.get("origins"), dict) else {}
    pages_in = [p for p in (data.get("pages") or []) if isinstance(p, dict)]
    skipped: list[str] = []
    notes: list[str] = []
    t = now()
    if worker:
        await docs_jobs.set_progress(db, job["_id"], worker, {"step": "save", "done": 0, "total": len(pages_in),
                                                              "message": "Saving pages"})

    existing = await db[PAGES].find({"site_id": site["_id"], "deleted_at": None}).to_list(length=cfg.docs_pages_per_site + 100)
    by_origin = {(p.get("origin") or {}).get("path"): p for p in existing if (p.get("origin") or {}).get("kind") == "github"}
    by_path = {p["path"]: p for p in existing if p.get("path")}
    room = cfg.docs_pages_per_site - len(existing)
    matched: set = set()
    ids_by_path: dict[str, Any] = {}
    counts = {"created": 0, "updated": 0, "deleted": 0, "unchanged": 0, "moved": 0, "adopted": 0}

    for i, p in enumerate(pages_in):
        path = p.get("path")
        if not valid_page_path(path):
            skipped.append(f"{str(path)[:80]}: not a usable page path")
            continue
        repo_file = origins.get(path) if isinstance(origins.get(path), str) else None
        markdown = str(p.get("markdown") or "")
        if len(markdown) > cfg.docs_page_max_chars:
            skipped.append(f"{path}: longer than {cfg.docs_page_max_chars} characters, cut")
            markdown = markdown[:cfg.docs_page_max_chars]
        fields = {"title": imp._s(p.get("title"), 200) or path, "description": imp._s(p.get("description"), 500),
                  "icon": imp._s(p.get("icon"), 60) or None, "hidden": bool(p.get("hidden"))}
        extra = p.get("frontmatter_extra") if isinstance(p.get("frontmatter_extra"), dict) else {}
        origin = {"kind": "github", "path": repo_file, "sha": commit}
        cur = by_origin.get(repo_file) if repo_file else None
        if cur is not None and cur["_id"] in matched:
            cur = None
        if cur is None:
            at_path = by_path.get(path)
            if at_path is not None and at_path["_id"] not in matched:
                is_github = (at_path.get("origin") or {}).get("kind") == "github"
                if is_github or first:
                    cur = at_path
                    if not is_github:
                        counts["adopted"] += 1
                else:
                    skipped.append(f"{path}: a page made in the studio has this address; kept the studio page")
                    continue
            elif at_path is not None:
                skipped.append(f"{path}: two files map to this address; kept the first")
                continue
        if cur is not None:
            matched.add(cur["_id"])
            sets: dict = {"origin": origin}
            if cur.get("path") != path:
                other = by_path.get(path)
                if other is not None and other["_id"] != cur["_id"]:
                    skipped.append(f"{path}: the address is taken by another page; {repo_file} stays at {cur.get('path')}")
                    path = cur.get("path")
                elif cur.get("path") == "/":
                    skipped.append(f"{path}: the home page keeps its address")
                    path = "/"
                else:
                    old = cur["path"]
                    sets["path"] = path
                    by_path.pop(old, None)
                    by_path[path] = cur
                    counts["moved"] += 1
                    try:
                        await pages_service._redirect_move(db, site, old, path)
                    except Exception:  # noqa: BLE001 - a redirect must not fail the sync
                        log.warning("github sync: redirect %s → %s not kept", old, path, exc_info=True)
            if _same(cur, fields, markdown, extra) and "path" not in sets:
                await db[PAGES].update_one({"_id": cur["_id"]}, {"$set": sets})
                counts["unchanged"] += 1
            else:
                rev = int((cur.get("draft") or {}).get("rev") or 0) + 1
                draft = {"markdown": markdown, "frontmatter_extra": extra, "rev": rev, "updated_by": by, "updated_at": t}
                try:
                    await db[PAGES].update_one({"_id": cur["_id"]}, {"$set": {**fields, **sets, "draft": draft}})
                except DuplicateKeyError:
                    skipped.append(f"{path}: a page with this address appeared meanwhile")
                    continue
                row = {**cur, **fields, **sets, "draft": draft}
                try:
                    await db[VERSIONS].insert_one(store.version_row(row, by=by, at=t, kind="import"))
                except DuplicateKeyError:
                    pass
                counts["updated"] += 1
            ids_by_path[path] = cur["_id"]
        else:
            if room <= 0:
                skipped.append(f"{path}: over the {cfg.docs_pages_per_site}-page limit")
                continue
            row = {"site_id": site["_id"], "path": path, **fields, "origin": origin,
                   "draft": {"markdown": markdown, "frontmatter_extra": extra, "rev": 1, "updated_by": by, "updated_at": t},
                   "published": None, "lock": None, "created_at": t, "deleted_at": None}
            try:
                row["_id"] = (await db[PAGES].insert_one(row)).inserted_id
            except DuplicateKeyError:
                skipped.append(f"{path}: a page with this address appeared meanwhile")
                continue
            try:
                await db[VERSIONS].insert_one(store.version_row(row, by=by, at=t, kind="import"))
            except DuplicateKeyError:
                pass
            room -= 1
            counts["created"] += 1
            by_path[path] = row
            matched.add(row["_id"])
            ids_by_path[path] = row["_id"]
        if worker and (i + 1) % 25 == 0:
            await docs_jobs.set_progress(db, job["_id"], worker, {"step": "save", "done": i + 1, "total": len(pages_in),
                                                                  "message": "Saving pages"})

    # Pages whose file is gone from the repository (only GitHub's own pages).
    gone = [p for p in existing if (p.get("origin") or {}).get("kind") == "github" and p["_id"] not in matched]
    for p in gone:
        if p.get("path") == "/":
            await db[PAGES].update_one({"_id": p["_id"]}, {"$unset": {"origin": ""}})
            notes.append("The repository no longer has a home page: the guide keeps its own, now edited here.")
            continue
        await db[PAGES].update_one({"_id": p["_id"], "deleted_at": None},
                                   {"$set": {"deleted_at": t, "deleted_by": by, "deleted_path": p.get("path"), "lock": None},
                                    "$unset": {"path": ""}})
        counts["deleted"] += 1

    # The nav: GitHub's groups (page ids), the studio's own pages kept where they were.
    fresh = await db[SITES].find_one({"_id": site["_id"]}) or site
    imported_nav: list[dict] = []
    nav_meta: dict = {}
    for grp in data.get("nav") if isinstance(data.get("nav"), list) else []:
        if not isinstance(grp, dict) or not isinstance(grp.get("pages"), list):
            continue
        ids = [str(ids_by_path[x]) for x in grp["pages"] if isinstance(x, str) and x in ids_by_path][:1000]
        if not ids or len(imported_nav) >= 100:
            continue
        gname = imp._s(grp.get("group"), 80) or "Pages"
        imported_nav.append({"group": gname, "pages": ids})
        meta = {k: imp._s(grp[k], 60) for k in ("icon", "tab") if grp.get(k)}
        if meta:
            nav_meta[gname] = meta
    remaining = await db[PAGES].find({"site_id": site["_id"], "deleted_at": None}, {"origin": 1, "path": 1}).to_list(length=None)
    studio_ids = {str(p["_id"]) for p in remaining if (p.get("origin") or {}).get("kind") != "github"}
    home = next((p for p in remaining if p.get("path") == "/"), None)
    old_nav = ((fresh.get("settings") or {}).get("nav") or []) if not (first and trigger == "import") else []
    nav = _merge_nav(imported_nav, old_nav, studio_ids, str(home["_id"]) if home else None)
    live_ids = {str(p["_id"]) for p in remaining}
    nav = [{"group": x["group"], "pages": [pid for pid in x["pages"] if pid in live_ids]} for x in nav]
    nav = [x for x in nav if x["pages"]]

    imported = data.get("site") if isinstance(data.get("site"), dict) else {}
    settings_doc = dict(fresh.get("settings") or site_settings.default_settings())
    settings_doc["nav"] = nav
    brand_extra: dict = {}
    if first:
        brand, brand_extra = imp._brand(imported.get("brand"))
        look = imp.imported_look(imported.get("theme"))
        if brand or look:
            theme = dict(settings_doc.get("theme") or {})
            if look and imp.design_untouched(theme):
                theme.update(look)
            if brand and not (theme.get("brand") or {}).get("logo_url"):
                theme["brand"] = {**(theme.get("brand") or {}), **brand}
            settings_doc["theme"] = theme
    try:
        settings_doc = site_settings.validate(settings_doc)
    except site_settings.SettingsError:
        settings_doc["theme"] = (fresh.get("settings") or {}).get("theme") or site_settings.default_settings()["theme"]
        settings_doc = site_settings.validate(settings_doc)
        brand_extra = {}
        skipped.append("the repository's brand (logo or colour) couldn't be used")
    new_extra = imp.engine_extra_from(imported, data)
    new_extra["source"] = "github"
    if first:
        extra_doc = new_extra
        if brand_extra:
            extra_doc["brand"] = brand_extra
    else:
        extra_doc = dict(fresh.get("engine_extra") or {})
        for k in ("tabs", "redirects", "embed_hosts", "videos"):
            if new_extra.get(k):
                extra_doc[k] = new_extra[k]
            else:
                extra_doc.pop(k, None)
        extra_doc["source"] = "github"
    if nav_meta:
        extra_doc["nav"] = nav_meta
    else:
        extra_doc.pop("nav", None)

    report = imp.summarize_report(data.get("report"))
    openapi = [x for x in (data.get("openapi") or []) if isinstance(x, dict) and isinstance(x.get("path"), str)][:10]
    openapi_paths = [x["path"][:300] for x in openapi]
    detected = (data.get("report") or {}).get("repoFormat") if isinstance(data.get("report"), dict) else None
    await db[SITES].update_one({"_id": site["_id"]}, {"$set": {
        "settings": settings_doc, "engine_extra": extra_doc, "updated_at": t,
        "github.status": "idle", "github.last_error": None, "github.last_synced_sha": commit,
        "github.last_synced_at": t, "github.last_applied_at": docs_jobs.aware(job.get("created_at")) or t,
        "github.first_sync": False, "github.openapi_paths": openapi_paths,
        **({"github.detected_format": detected} if isinstance(detected, str) and detected in detect.FORMATS else {}),
    }})

    assets = data.get("assets") if isinstance(data.get("assets"), dict) else {}
    asset_rows = await imp._asset_rows(db, site["_id"], by, assets)
    changed = counts["created"] + counts["updated"] + counts["deleted"]
    published = None
    warnings: list[str] = []
    mode = g.get("mode") or "drafts"
    if mode == "publish" and (changed or first):
        published, warn = await _publish(db, site["_id"], g.get("connected_by") or by, commit)
        if warn:
            warnings.append(warn)
    owner, name = g.get("owner"), g.get("name")
    result = {
        "ok": True,
        "pages": {"created": counts["created"], "updated": counts["updated"], "total": len(ids_by_path),
                  "hidden": sum(1 for p in pages_in if p.get("hidden") and p.get("path") in ids_by_path)},
        "nav_groups": len(nav),
        "assets": {**{k: v for k, v in assets.items() if isinstance(k, str) and isinstance(v, int) and not isinstance(v, bool)},
                   "rows": asset_rows},
        "report": report,
        "skipped": (skipped + notes)[:100],
        "github": {"sha": commit, "short_sha": _short(commit), "commit_url": gh.commit_url(owner, name, commit),
                   "format": detected or g.get("format"), "trigger": trigger,
                   "pages": {k: counts[k] for k in ("created", "updated", "deleted", "unchanged", "moved", "adopted")},
                   "openapi": openapi_paths, "published_build": published, "mode": mode, "sync": bool(g.get("sync")),
                   "repo": f"{owner}/{name}", "warnings": warnings},
    }
    await docs_jobs.complete(db, job["_id"], worker, result)
    await db[SYNCS].update_one({"job_id": job["_id"]}, {"$set": {
        "status": "done", "finished_at": now(), "sha": commit, "error": None, "published_build": published,
        "pages": {k: counts[k] for k in ("created", "updated", "deleted", "unchanged")}, "warnings": warnings + notes[:3]}})
    await docs_jobs.log_event(db, "docs_import_finished", site["_id"], by, source="github", trigger=trigger,
                              pages=len(ids_by_path), changed=changed, assets=assets.get("files"),
                              took=docs_jobs.duration_bucket(job.get("created_at"), t))
    return result


async def _publish(db: AsyncIOMotorDatabase, site_id: ObjectId, user_id: str | None, commit: str | None) -> tuple[int | None, str | None]:
    """mode "publish": publish as the person who connected the repository. (build number, warning)."""
    from app.services import docs_site_publish as publishing
    from app.services.user import get_user_by_id

    site = await db[SITES].find_one({"_id": site_id, "deleted_at": None})
    user = await get_user_by_id(db, user_id) if user_id else None
    if site is None or user is None:
        return None, "Not published automatically: the person who connected the repository no longer has an account."
    try:
        out = await publishing.publish(db, site, "admin", user, note=f"GitHub {(commit or '')[:7]}".strip(),
                                       enforce_review=False)
    except HTTPException as e:
        return None, f"Not published automatically: {e.detail if isinstance(e.detail, str) else 'the publish was refused'}"
    return out.get("number"), None


# ── Webhook ───────────────────────────────────────────────────────────────────


async def first_delivery(db: AsyncIOMotorDatabase, delivery: str | None, event: str) -> bool:
    """False for a delivery id seen before (GitHub's redelivery, or a retry)."""
    if not delivery:
        return True
    try:
        await db[DELIVERIES].insert_one({"_id": str(delivery)[:100], "event": event, "at": now()})
        return True
    except DuplicateKeyError:
        return False


def _touches(paths: list[str], folder: str) -> bool:
    return any(detect.under(p, folder) for p in paths) if folder else bool(paths)


async def handle_event(db: AsyncIOMotorDatabase, event: str, body: dict) -> dict:
    """One verified webhook delivery → what was done (for the log and the response)."""
    inst = body.get("installation") if isinstance(body.get("installation"), dict) else {}
    iid = inst.get("id")
    if event == "ping":
        return {"ok": True, "event": "ping"}
    if event == "installation":
        action = body.get("action")
        if iid and action == "deleted":
            await db[INSTALLS].update_many({"installation_id": int(iid)}, {"$set": {"deleted_at": now()}})
            await db[SITES].update_many({"github.installation_id": int(iid)},
                                        {"$set": {"github.sync": False, "github.status": "error",
                                                  "github.last_error": "The Markdrop Guides app was removed from the GitHub account."}})
            gh.forget_installation(int(iid))
        elif iid and action in ("suspend", "unsuspend"):
            await db[INSTALLS].update_many({"installation_id": int(iid)}, {"$set": {"suspended": action == "suspend"}})
            if action == "suspend":
                gh.forget_installation(int(iid))
        elif iid and action in ("created", "new_permissions_accepted"):
            await db[INSTALLS].update_many({"installation_id": int(iid)},
                                           {"$set": {"repository_selection": inst.get("repository_selection"), "suspended": False}})
        return {"ok": True, "event": event, "action": action}
    if event == "installation_repositories":
        removed = [r.get("full_name", "").lower() for r in body.get("repositories_removed") or [] if isinstance(r, dict)]
        n = 0
        for full in removed:
            if "/" not in full:
                continue
            owner, name = full.split("/", 1)
            res = await db[SITES].update_many(
                {"github.installation_id": int(iid or 0), "github.owner_lc": owner, "github.name_lc": name},
                {"$set": {"github.sync": False, "github.status": "error",
                          "github.last_error": "The repository was removed from the Markdrop Guides app on GitHub."}})
            n += res.modified_count
        await db[INSTALLS].update_many({"installation_id": int(iid or 0)},
                                       {"$set": {"repository_selection": body.get("repository_selection")
                                                 or inst.get("repository_selection")}})
        return {"ok": True, "event": event, "paused": n}
    if event != "push":
        return {"ok": True, "event": event, "ignored": True}

    repo = body.get("repository") if isinstance(body.get("repository"), dict) else {}
    full = str(repo.get("full_name") or "")
    ref = str(body.get("ref") or "")
    if not iid or "/" not in full or not ref.startswith("refs/heads/") or body.get("deleted"):
        return {"ok": True, "event": "push", "ignored": True}
    owner, name = full.lower().split("/", 1)
    branch = ref[len("refs/heads/"):]
    sha = str(body.get("after") or "")
    commits = [c for c in body.get("commits") or [] if isinstance(c, dict)]
    changed: list[str] = []
    for c in commits:
        for k in ("added", "removed", "modified"):
            changed.extend(str(x) for x in c.get(k) or [] if isinstance(x, str))
    head = body.get("head_commit") if isinstance(body.get("head_commit"), dict) else None
    if head and not commits:
        for k in ("added", "removed", "modified"):
            changed.extend(str(x) for x in head.get(k) or [] if isinstance(x, str))
    # GitHub lists at most 20 commits (and a force push may list none): then assume it touches the docs.
    unknown = len(commits) >= 20 or bool(body.get("forced")) or (not commits and not head)
    pusher = str(((body.get("pusher") or {}).get("name")) or ((body.get("sender") or {}).get("login")) or "")[:100] or None
    started = []
    skipped = []
    async for site in db[SITES].find({"deleted_at": None, "github.installation_id": int(iid), "github.owner_lc": owner,
                                      "github.name_lc": name, "github.branch": branch, "github.sync": True}):
        g = site["github"]
        if not unknown and not _touches(changed, detect.watched_prefix(g.get("format") or "auto", g.get("path") or "")):
            skipped.append(str(site["_id"]))
            continue
        if await syncs_today(db, site["_id"]) >= get_settings().docs_github_syncs_per_site_per_day:
            await db[SITES].update_one({"_id": site["_id"]}, {"$set": {
                "github.last_error": "Today's sync limit is reached: the next push after midnight (UTC) syncs again."}})
            skipped.append(str(site["_id"]))
            continue
        job = await start_job(db, site, trigger="push", user_id=g.get("connected_by"), sha=sha or None, pusher=pusher)
        started.append(str(job["_id"]))
    return {"ok": True, "event": "push", "jobs": started, "skipped": len(skipped)}


# ── OpenAPI found in the repository ───────────────────────────────────────────


async def attach_openapi(db: AsyncIOMotorDatabase, site: dict, user: User, path: str) -> dict:
    """Use an OpenAPI file found in the repository as the guide's API reference (fetched from GitHub
    at the last synced commit, then the usual checks: services/docs_api_spec.py)."""
    from fastapi.concurrency import run_in_threadpool

    from app.services import docs_api_spec as api_spec

    g = site.get("github")
    if not isinstance(g, dict):
        raise HTTPException(status_code=409, detail="This guide isn't connected to GitHub.")
    if path not in (g.get("openapi_paths") or []):
        raise HTTPException(status_code=404, detail="That file wasn't found in the repository's last sync.")
    ref = g.get("last_synced_sha") or g.get("branch")
    try:
        data = await gh.file_bytes(g["owner"], g["name"], ref, path, g.get("installation_id"), max_bytes=api_spec.MAX_BYTES)
    except gh.GitHubError as e:
        raise HTTPException(status_code=e.status, detail=e.message) from None
    if data is None:
        raise HTTPException(status_code=404, detail=f"We couldn't read {path} from GitHub (missing or over 5 MB).")
    try:
        spec, summary, out = await run_in_threadpool(api_spec.prepare, data)
    except api_spec.SpecError as e:
        raise HTTPException(status_code=422, detail=str(e)) from None
    source = {"kind": "github", "filename": path.rsplit("/", 1)[-1][:200], "path": path[:300],
              "repo": f"{g['owner']}/{g['name']}"}
    row = await api_spec._store(db, site, user.id, spec, summary, out, source)
    await api_spec._log(db, site, user.id, "github", row)
    return await api_spec.status(db, await db[SITES].find_one({"_id": site["_id"]}))
