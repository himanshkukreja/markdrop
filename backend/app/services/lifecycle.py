"""Lifecycle rules that touch many things at once (access policy §3, §5.5).

* slug reservation — tombstones after delete/expiry (30 days, same owner only)
  and ``old_slugs`` after a rename (permanent, that document only) — Q4;
* destroying a document (delete A8, expiry A6): bytes closed then deleted,
  versions, posters, grants, purge, live ``gone``, then the row;
* leaving a workspace (D2/W3): the level conversion that never widens (I8);
* workspace-wide transitions: require_auth toggles (W1/W2) and deletion (W3);
* membership transitions: grants made through a workspace role die or shrink
  with that role (M1/M2, I9);
* the expiry sweeper and the reconciler (background.py runs them).
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from bson import ObjectId
from fastapi import HTTPException
from fastapi.concurrency import run_in_threadpool
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError

from app.services import live, publicity, revalidate

log = logging.getLogger(__name__)

TOMBSTONES = "slug_tombstones"
TOMBSTONE_DAYS = 30


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Slug reservation ──────────────────────────────────────────────────────────


async def slug_unavailable(db: AsyncIOMotorDatabase, slug: str, owner_id: str | None,
                           doc_id=None) -> bool:
    """True when ``slug`` is reserved against this owner/document: a live
    tombstone of someone else's (or an anonymous) deleted document, or another
    document's former slug."""
    if not slug:
        return False
    tomb = await db[TOMBSTONES].find_one({"slug": slug})
    if tomb is not None:
        until = publicity.aware(tomb.get("until"))
        if until is not None and until > _now():
            if tomb.get("owner_id") is None or tomb.get("owner_id") != owner_id:
                return True
    query: dict = {"old_slugs": slug}
    if doc_id is not None:
        query["_id"] = {"$ne": doc_id}
    return bool(await db["documents"].find_one(query, {"_id": 1}))


async def tombstone(db: AsyncIOMotorDatabase, slugs, owner_id: str | None) -> None:
    until = _now() + timedelta(days=TOMBSTONE_DAYS)
    for slug in {s for s in slugs if s}:
        try:
            await db[TOMBSTONES].update_one(
                {"slug": slug},
                {"$set": {"slug": slug, "owner_id": owner_id, "until": until, "created_at": _now()}},
                upsert=True,
            )
        except DuplicateKeyError:  # pragma: no cover - concurrent upsert
            pass


async def clear_tombstone(db: AsyncIOMotorDatabase, slug: str) -> None:
    await db[TOMBSTONES].delete_one({"slug": slug})


# ── Destroying a document (A6 expiry, A8 delete) ─────────────────────────────


async def _delete_objects(raw: dict) -> None:
    from app.services import r2

    if raw.get("kind") != "artifact" or not r2.is_configured():
        return
    if raw.get("bundle_prefix"):
        await run_in_threadpool(r2.delete_prefix, raw["bundle_prefix"])
    elif raw.get("blob_key"):
        await run_in_threadpool(r2.delete, raw["blob_key"])


async def destroy(db: AsyncIOMotorDatabase, raw: dict, *, reason: str = "delete") -> bool:
    """Remove a document and everything that hangs off it. Returns False when
    the row was already gone (someone else got there first).

    Order: tell sockets and caches, close the bytes (so a failure to delete
    them never leaves them public), delete the row (CAS on _id), then the
    objects, old versions, posters and grants. Its slug and former slugs are
    reserved for the same owner for 30 days."""
    from app.services import file_versions

    slug = raw.get("slug")
    doc_id = str(raw["_id"])
    if publicity._has_bytes(raw):
        if not await publicity.apply(raw, False, epoch=publicity.epoch_of(raw) + 1):
            log.warning("closing %s before %s failed", slug, reason)
    res = await db["documents"].delete_one({"_id": raw["_id"]})
    if res.deleted_count == 0:
        return False
    await tombstone(db, [slug, *(raw.get("old_slugs") or [])], raw.get("owner_id"))
    await revalidate.purge_doc(db, raw, extra_slugs=raw.get("old_slugs") or [])
    live.gone(slug)
    await db["document_grants"].delete_many({"document_id": doc_id})
    try:
        await _delete_objects(raw)
        if raw.get("kind") == "artifact":
            await file_versions.forget_document(db, doc_id, raw)
    except Exception:
        log.warning("deleting the stored bytes of %s failed (already private)", slug, exc_info=True)
    return True


# ── Leaving a workspace (D2, W3) ──────────────────────────────────────────────


def level_after_leaving(raw: dict, require_auth: bool) -> str:
    """I8: ``workspace`` ⇒ ``private``; a ``link`` document leaving a
    sign-in-required workspace ⇒ ``private`` (Q2). Otherwise unchanged."""
    level = raw.get("access_level") or "link"
    if level == "workspace":
        return "private"
    if level == "link" and require_auth:
        return "private"
    return level


async def release_from_workspace(db: AsyncIOMotorDatabase, raw: dict, workspace_id: str, *,
                                 require_auth: bool | None = None) -> dict:
    """D2: take a document out of ``workspace_id`` (CAS on it), convert its
    level so leaving never widens, drop grants that came through the
    workspace, purge. Returns the row after."""
    from app.services import transitions

    if require_auth is None:
        require_auth = await publicity.workspace_requires_auth(db, workspace_id)
    level = level_after_leaving(raw, require_auth)
    current = raw.get("access_level") or "link"
    sets = {"workspace_id": None, "folder_id": None, "folder_path": [], "access_level": level,
            "updated_at": _now()}
    try:
        after = await transitions.change(
            db, raw, sets=sets, cas={"workspace_id": workspace_id},
            narrows=level != current, require_auth_after=False,
        )
    except HTTPException as exc:
        if exc.status_code == 409:
            raise HTTPException(status_code=404, detail="That document isn't in this workspace.")
        raise
    await db["document_grants"].delete_many({"document_id": str(raw["_id"]), "granted_via": workspace_id})
    if level == current:
        live.access_changed(raw.get("slug"))
    return after


async def release_db_first(db: AsyncIOMotorDatabase, raw: dict, workspace_id: str, *,
                           require_auth: bool) -> dict | None:
    """D2 conversion that cannot be blocked by storage (W3, dangling refs — C1).

    One CAS on ``{_id, workspace_id: W}`` writes the *safe* state first: out of
    the workspace, level converted so leaving never widens, ``access_dirty``
    set and — when the audience shrinks — the access epoch bumped (signed links
    and read tickets die with it). Only then are the bytes re-derived; a
    storage failure leaves the row dirty for the reconciler, and the bytes can
    only be *more* closed than the row says (they were guarded inside the
    workspace, or the level didn't change). Returns the row after, or None when
    the document was no longer in ``workspace_id``."""
    from pymongo import ReturnDocument

    level = level_after_leaving(raw, require_auth)
    current = raw.get("access_level") or "link"
    narrows = level != current
    update: dict = {"$set": {"workspace_id": None, "folder_id": None, "folder_path": [],
                             "access_level": level, "access_dirty": True, "updated_at": _now()}}
    if narrows:
        update["$inc"] = {"access_epoch": 1}
    after = await db["documents"].find_one_and_update(
        {"_id": raw["_id"], "workspace_id": workspace_id}, update,
        return_document=ReturnDocument.AFTER)
    if after is None:
        return None
    await db["document_grants"].delete_many({"document_id": str(raw["_id"]), "granted_via": workspace_id})
    try:
        await revalidate.purge_doc(db, after, extra_slugs=raw.get("old_slugs") or [])
        await revalidate.enqueue(db, tags=[f"wsl:{workspace_id}"])
    except Exception:  # pragma: no cover - the outbox write itself failed
        log.warning("purge after releasing %s failed", raw.get("slug"), exc_info=True)
    live.access_changed(raw.get("slug"))
    if publicity._has_bytes(after):
        public = publicity.is_public(after, require_auth=False)
        if await publicity.apply(after, public, epoch=publicity.epoch_of(after)):
            await db["documents"].update_one(
                {"_id": after["_id"], "access_epoch": after.get("access_epoch"),
                 "workspace_id": None, "access_level": level},
                {"$set": {"access_dirty": False}})
        else:
            log.warning("re-deriving the bytes of %s after leaving %s failed; left dirty",
                        raw.get("slug"), workspace_id)
    else:
        await db["documents"].update_one(
            {"_id": after["_id"], "access_epoch": after.get("access_epoch"), "workspace_id": None},
            {"$set": {"access_dirty": False}})
    return after


# ── Workspace-wide (W1, W2, W3) ───────────────────────────────────────────────


async def require_auth_toggled(db: AsyncIOMotorDatabase, workspace_id: str, on: bool) -> dict:
    """W1/W2: every filed document's audience changes at once. ON: epoch bump
    and guard every L/LP document's bytes; OFF: open L documents. Purge every
    document plus the workspace listing and host tags."""
    from app.services import transitions

    changed = 0
    slugs: list[str] = []
    rows = await db["documents"].find({"workspace_id": workspace_id}).to_list(length=20_000)
    for raw in rows:
        slugs.append(raw.get("slug"))
        slugs.extend(s for s in (raw.get("old_slugs") or []) if isinstance(s, str))
        if on:
            if (raw.get("access_level") or "link") != "link":
                continue
            try:
                await transitions.change(db, raw, sets={}, narrows=True, require_auth_after=True,
                                         purge=False)
                changed += 1
            except HTTPException:
                # Left dirty for the reconciler; it re-derives from the row.
                await db["documents"].update_one({"_id": raw["_id"]}, {"$set": {"access_dirty": True}})
        else:
            if publicity.is_public(raw, require_auth=False) and publicity._has_bytes(raw):
                if not await publicity.apply(raw, True, epoch=publicity.epoch_of(raw)):
                    await db["documents"].update_one({"_id": raw["_id"]}, {"$set": {"access_dirty": True}})
                changed += 1
            live.publish(raw.get("slug"), int(raw.get("rev") or 1))
    await revalidate.enqueue(db, slugs=slugs, tags=[f"wsl:{workspace_id}", *await _host_tags(db, workspace_id)])
    return {"documents": len(rows), "changed": changed}


async def _host_tags(db: AsyncIOMotorDatabase, workspace_id: str) -> list[str]:
    rows = await db["domains"].find({"workspace_id": workspace_id}, {"host": 1}).to_list(length=200)
    return [f"host:{r['host']}" for r in rows if r.get("host")]


async def release_workspace_documents(db: AsyncIOMotorDatabase, workspace_id: str,
                                      require_auth: bool, *, passes: int = 3) -> tuple[int, int]:
    """W3 for the documents: each one released with the D2 conversion, the
    database first (``release_db_first``) so a storage hiccup can never leave
    a document filed in a workspace that is about to disappear (C1). Repeats
    while documents keep arriving. Returns (released, still filed)."""
    n = 0
    for _ in range(max(1, passes)):
        rows = await db["documents"].find({"workspace_id": workspace_id}).to_list(length=20_000)
        if not rows:
            break
        for raw in rows:
            try:
                if await release_db_first(db, raw, workspace_id, require_auth=require_auth) is not None:
                    n += 1
            except Exception:
                log.warning("releasing %s from %s failed", raw.get("slug"), workspace_id, exc_info=True)
    await db["document_grants"].delete_many({"granted_via": workspace_id})
    remaining = await db["documents"].count_documents({"workspace_id": workspace_id})
    return n, remaining


# ── Membership (M1, M2) ───────────────────────────────────────────────────────


async def _descendants(db: AsyncIOMotorDatabase, roots: list[dict], workspace_id: str) -> list[dict]:
    """Every grant re-shared (directly or not) from ``roots`` — the grants whose
    ``parent_grant_id`` chain leads to one of them (C2). Bounded walk."""
    out: list[dict] = []
    frontier = [str(r["_id"]) for r in roots]
    seen = set(frontier)
    hops = 0
    while frontier and hops < 50:
        hops += 1
        rows = await db["document_grants"].find(
            {"parent_grant_id": {"$in": frontier}, "granted_via": workspace_id}).to_list(length=20_000)
        frontier = []
        for r in rows:
            rid = str(r["_id"])
            if rid not in seen:
                seen.add(rid)
                out.append(r)
                frontier.append(rid)
    return out


async def member_left(db: AsyncIOMotorDatabase, workspace_id: str, user_id: str) -> int:
    """M1: grants this person made through their workspace role are deleted —
    and so is every grant re-shared from those (C2: no laundering through a
    grantee)."""
    from app.services import live

    roots = await db["document_grants"].find(
        {"granted_via": workspace_id, "granted_by_user_id": user_id}).to_list(length=20_000)
    rows = roots + await _descendants(db, roots, workspace_id)
    if not rows:
        return 0
    res = await db["document_grants"].delete_many({"_id": {"$in": [r["_id"] for r in rows]}})
    for doc_id in {r["document_id"] for r in rows}:
        try:
            d = await db["documents"].find_one({"_id": ObjectId(doc_id)}, {"slug": 1})
        except Exception:
            d = None
        if d:
            live.access_changed(d.get("slug"))
    return res.deleted_count


async def member_demoted(db: AsyncIOMotorDatabase, workspace_id: str, user_id: str,
                         new_role: str) -> int:
    """M2: demoted to viewer ⇒ editor grants they made through the workspace
    become viewer grants, and so do editor grants re-shared from those (C2)."""
    if new_role != "viewer":
        return 0
    roots = await db["document_grants"].find(
        {"granted_via": workspace_id, "granted_by_user_id": user_id}).to_list(length=20_000)
    rows = roots + await _descendants(db, roots, workspace_id)
    res = await db["document_grants"].update_many(
        {"_id": {"$in": [r["_id"] for r in rows]}, "role": "editor"}, {"$set": {"role": "viewer"}})
    return res.modified_count


async def drop_orphaned_delegations(db: AsyncIOMotorDatabase, *, limit: int = 5000,
                                    since: datetime | None = None) -> int:
    """Reconciler (C7): a grant whose authority is gone — its granter is no
    longer a member of ``granted_via`` (or no longer may give that role), or
    the grant it was re-shared from was removed — is deleted. Covers a grant
    written while its granter was being removed."""
    from app.services import access

    dropped = 0
    query: dict = {"$or": [{"granted_via": {"$nin": [None]}}, {"parent_grant_id": {"$nin": [None]}}]}
    if since is not None:
        query["created_at"] = {"$gte": since}
    rows = await db["document_grants"].find(query).limit(limit).to_list(length=limit)
    for g in rows:
        if not await access.grant_authority_holds(db, g):
            res = await db["document_grants"].delete_one({"_id": g["_id"]})
            dropped += res.deleted_count
    return dropped


# ── Expiry sweeper (A6) ───────────────────────────────────────────────────────


async def sweep_expired(db: AsyncIOMotorDatabase, *, limit: int = 100) -> int:
    """Destroy documents whose ``expires_at`` has passed. A row whose bytes
    can't be deleted is at least made private (``destroy`` closes first)."""
    n = 0
    rows = await db["documents"].find(
        {"expires_at": {"$ne": None, "$lte": _now()}}).limit(limit).to_list(length=limit)
    for raw in rows:
        try:
            if await destroy(db, raw, reason="expiry"):
                n += 1
        except Exception:
            log.warning("expiring %s failed", raw.get("slug"), exc_info=True)
    return n


# ── Reconciler (§5.5) ─────────────────────────────────────────────────────────


async def reconcile_document(db: AsyncIOMotorDatabase, raw: dict) -> bool:
    """Re-derive one document's derived state. Returns True when it is clean."""
    ws_id = raw.get("workspace_id")
    if ws_id:
        try:
            exists = await db["workspaces"].find_one({"_id": ObjectId(ws_id)}, {"_id": 1})
        except Exception:
            exists = None
        if exists is None:
            # Dangling: released from a workspace whose require_auth is
            # unknown — and unknown never means open (C1, I8): W ⇒ private,
            # link ⇒ private. Database first; the bytes follow.
            await release_db_first(db, raw, ws_id, require_auth=True)
            raw = await db["documents"].find_one({"_id": raw["_id"]}) or raw
    if publicity.is_expired(raw):
        await destroy(db, raw, reason="expiry")
        return True
    if not publicity._has_bytes(raw):
        await db["documents"].update_one(
            {"_id": raw["_id"], "access_epoch": raw.get("access_epoch")}, {"$set": {"access_dirty": False}})
        return True
    public = await publicity.doc_is_public(db, raw)
    if not await publicity.apply(raw, public, epoch=publicity.epoch_of(raw)):
        return False
    res = await db["documents"].update_one(
        {"_id": raw["_id"], "access_epoch": raw.get("access_epoch"),
         "access_level": raw.get("access_level"), "read_password_hash": raw.get("read_password_hash"),
         "workspace_id": raw.get("workspace_id")},
        {"$set": {"access_dirty": False}})
    return res.matched_count == 1


async def reconcile_once(db: AsyncIOMotorDatabase, *, limit: int = 200, full: bool = False) -> dict:
    """Dirty rows (and with ``full``, dangling workspace refs and orphan grants)."""
    fixed = failed = 0
    async for raw in db["documents"].find({"access_dirty": True}).limit(limit):
        try:
            if await reconcile_document(db, raw):
                fixed += 1
            else:
                failed += 1
        except Exception:
            failed += 1
            log.warning("reconciling %s failed", raw.get("slug"), exc_info=True)
    orphans = 0
    try:
        # Every pass: grants written in the last few minutes (the window in
        # which a grant can race its granter's removal); the full pass: all.
        orphans += await drop_orphaned_delegations(
            db, since=None if full else _now() - timedelta(minutes=10))
    except Exception:
        log.warning("dropping orphaned delegated grants failed", exc_info=True)
    if full:
        ws_ids = await db["documents"].distinct("workspace_id", {"workspace_id": {"$ne": None}})
        for ws_id in ws_ids:
            try:
                exists = await db["workspaces"].find_one({"_id": ObjectId(ws_id)}, {"_id": 1})
            except Exception:
                exists = None
            if exists is None:
                async for raw in db["documents"].find({"workspace_id": ws_id}).limit(limit):
                    await reconcile_document(db, raw)
                    fixed += 1
        doc_ids = await db["document_grants"].distinct("document_id")
        for doc_id in doc_ids:
            try:
                present = await db["documents"].find_one({"_id": ObjectId(doc_id)}, {"_id": 1})
            except Exception:
                present = None
            if present is None:
                res = await db["document_grants"].delete_many({"document_id": doc_id})
                orphans += res.deleted_count
    return {"fixed": fixed, "failed": failed, "orphan_grants": orphans}


# ── Data migrations (idempotent; run at startup) ─────────────────────────────


async def migrate(db: AsyncIOMotorDatabase) -> dict:
    """1. filed docs with no stored ``allow_resharing`` ⇒ false;
    2. ``workspace`` level with no (or a dangling) workspace ⇒ private;
    3. dangling workspace refs released: whether that workspace required
       sign-in is unknown, so ``link`` ⇒ ``private`` too (C1 — never assume a
       deleted workspace was open); epoch bumped, left dirty for the bytes."""
    out = {}
    res = await db["documents"].update_many(
        {"workspace_id": {"$ne": None}, "allow_resharing": {"$exists": False}},
        {"$set": {"allow_resharing": False}})
    out["resharing_defaulted"] = res.modified_count
    res = await db["documents"].update_many(
        {"access_level": "workspace", "workspace_id": None},
        {"$set": {"access_level": "private", "access_dirty": True}})
    out["workspace_level_released"] = res.modified_count
    dangling = 0
    for ws_id in await db["documents"].distinct("workspace_id", {"workspace_id": {"$ne": None}}):
        try:
            exists = await db["workspaces"].find_one({"_id": ObjectId(ws_id)}, {"_id": 1})
        except Exception:
            exists = None
        if exists is None:
            res = await db["documents"].update_many(
                {"workspace_id": ws_id, "access_level": {"$in": ["workspace", "link", None]}},
                {"$set": {"access_level": "private"}, "$inc": {"access_epoch": 1}})
            res2 = await db["documents"].update_many(
                {"workspace_id": ws_id},
                {"$set": {"workspace_id": None, "folder_id": None, "folder_path": [],
                          "access_dirty": True}})
            dangling += res2.modified_count
    out["dangling_released"] = dangling
    # 4. Artifacts filed in a require-sign-in workspace: before D3 their bytes
    #    followed only level + password, so link ones are still public in R2.
    #    Mark them dirty; the reconciler closes them under the one rule.
    #    One-shot (recorded in `migrations`), so a restart doesn't re-copy
    #    every object of those workspaces.
    marker = "require_auth_bytes_v1"
    if await db["migrations"].find_one({"_id": marker}):
        return out
    await db["migrations"].update_one({"_id": marker}, {"$set": {"at": _now()}}, upsert=True)
    ra_ids = [str(w["_id"]) async for w in db["workspaces"].find(
        {"settings.require_auth_to_view": True}, {"_id": 1})]
    if ra_ids:
        res = await db["documents"].update_many(
            {"workspace_id": {"$in": ra_ids}, "kind": "artifact", "access_dirty": {"$ne": True}},
            {"$set": {"access_dirty": True}})
        out["require_auth_bytes_queued"] = res.modified_count
    return out


async def ensure_expiry_ttl(db: AsyncIOMotorDatabase) -> int:
    """The Mongo TTL index on ``expires_at`` becomes a one-day backstop: the
    sweeper deletes expired documents properly (A6). Returns the setting."""
    from pymongo.errors import OperationFailure

    target = 86400
    info = await db["documents"].index_information()
    for name, spec in info.items():
        if spec.get("key") == [("expires_at", 1)]:
            if spec.get("expireAfterSeconds") == target:
                return target
            try:
                await db.command("collMod", "documents",
                                 index={"keyPattern": {"expires_at": 1}, "expireAfterSeconds": target})
                return target
            except (OperationFailure, NotImplementedError, AttributeError, TypeError):
                await db["documents"].drop_index(name)
                break
    await db["documents"].create_index("expires_at", expireAfterSeconds=target, sparse=True)
    return target
