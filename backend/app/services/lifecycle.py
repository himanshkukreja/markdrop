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

import asyncio
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
    tombstone of someone else's (or an anonymous) deleted document, another
    document's former slug, or anything in the trash (for everyone, its owner
    included: a restore must find its address free — services/trash.py)."""
    if not slug:
        return False
    from app.services import trash

    if await trash.holds_slug(db, slug):
        return True
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
        from app.services import media

        if media.may_have_frames(raw["blob_key"]):
            # Frames creator analytics cached for this video (best effort).
            try:
                await run_in_threadpool(r2.delete_prefix, media.frames_prefix(raw["blob_key"]))
            except Exception:  # pragma: no cover
                pass


async def destroy(db: AsyncIOMotorDatabase, raw: dict, *, reason: str = "delete",
                  trashed: bool = False) -> bool:
    """Remove a document and everything that hangs off it. Returns False when
    the row was already gone (someone else got there first).

    Order: tell sockets and caches, close the bytes (so a failure to delete
    them never leaves them public), delete the row (CAS on _id), then the
    objects, old versions, posters and grants. Its slug and former slugs are
    reserved for the same owner for 30 days.

    ``trashed``: ``raw`` is a document in the trash (services/trash.py:
    "Delete forever" and the 30-day purge); its trash row is what goes. One
    whose id is live again in ``documents`` is never destroyed (only the
    leftover trash row is dropped)."""
    from app.services import file_versions

    slug = raw.get("slug")
    doc_id = str(raw["_id"])
    coll = "documents"
    if trashed:
        from app.services import trash

        coll = trash.COLL
        if await db["documents"].find_one({"_id": raw["_id"]}, {"_id": 1}):
            await db[coll].delete_one({"_id": raw["_id"]})
            return False
    if publicity._has_bytes(raw):
        if not await publicity.apply(raw, False, epoch=publicity.epoch_of(raw) + 1):
            log.warning("closing %s before %s failed", slug, reason)
    # Reserved *before* the row goes (C6): the unique index protects the slug
    # while the row exists, the tombstone from the moment it doesn't — never a
    # gap in which someone else's create could take it.
    await tombstone(db, [slug, *(raw.get("old_slugs") or [])], raw.get("owner_id"))
    # Sub-pages still under it (an expiry, or a delete that chose "lift") move
    # up a level, keeping exactly the access they had (services/pages.py).
    from app.services import page_assets, pages

    await pages.lift_children(db, raw)
    res = await db[coll].delete_one({"_id": raw["_id"]})
    if res.deleted_count == 0:
        return False
    await page_assets.forget_document(db, doc_id)
    from app.services import card_preview

    await card_preview.forget_document(db, doc_id)
    from app.services import search_index

    await search_index.drop(db, raw["_id"])
    from app.services import page_history, page_links

    await page_history.forget_document(db, doc_id)
    from app.services import signoffs

    await signoffs.forget_document(db, doc_id)
    from app.services.comments import service as comments_service

    await comments_service.on_item_deleted(db, doc_id)

    await page_links.forget(db, doc_id)
    await revalidate.purge_doc(db, raw, extra_slugs=raw.get("old_slugs") or [], inline=True)  # B2
    live.gone(slug)
    await db["document_grants"].delete_many({"document_id": doc_id})
    # Creator analytics: its engagement sessions and anyone shown as live on it.
    from app.services import engage, presence

    await db[engage.COLL].delete_many({"doc_id": doc_id})
    engage.forget_doc(doc_id)
    from app.services import doc_views

    await doc_views.forget_document(db, doc_id)
    from app.services import analytics_ai_doc

    await analytics_ai_doc.forget_document(db, doc_id)
    presence.forget_doc(doc_id)
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
            narrows=level != current, require_auth_after=False, inline_purge=True,
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
    from app.services import page_assets

    if not await page_assets.apply(db, after, publicity.is_public(after, require_auth=False)):
        log.warning("re-deriving the images of %s after leaving %s failed", raw.get("slug"), workspace_id)
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


#   W1/W2 — require sign-in, in two parts (C-N8, D3):
#
#   1. ``begin_require_auth`` — in the request, a handful of database writes.
#      The gate itself is read live from the workspace row (publicity.
#      workspace_requires_auth), so the API answers 401 from the moment the
#      setting is written. On top of that, one ``update_many`` bumps the access
#      epoch of every document whose audience shrinks (read tickets and signed
#      links already handed out die with it), marks each one ``access_dirty``
#      and ``ra_pending`` ({ws, gen, at}), and the purge jobs for every cached
#      render are written to the outbox in one bulk write.
#   2. ``run_require_auth`` — everything slow, in the background: each marked
#      document's stored bytes and page images re-derived from its current row
#      and the current setting (bounded parallelism), and the purges sent.
#      ``ra_pending`` is the durable cursor: a runner that dies leaves the rest
#      marked, and the next one (the request's own kick, the background loop
#      after a restart) carries on. One runner per workspace (a lease on the
#      workspace row, renewed while it works).
#
#   Toggling back while a runner works: every toggle bumps ``require_auth_gen``
#   and re-marks the documents with it, and a runner clears a mark only with a
#   compare-and-set on the gen it read, so a document it handled under the old
#   setting stays marked and is handled again with the new one.

RA_PENDING = "ra_pending"
REQUIRE_AUTH_LEASE = timedelta(seconds=60)
# How many documents a runner works on at once (each one is a few R2 calls).
RA_CONCURRENCY = 8
# How many cached-render purges are in flight at once while a runner works.
RA_PURGE_CONCURRENCY = 16
RA_BATCH = 500
# A mark older than this, with nobody working on it, is the reconciler's.
RA_STALE = timedelta(minutes=10)
_RUNNERS: dict[str, asyncio.Task] = {}


def _ra_affected(workspace_id: str) -> dict:
    """Documents of the workspace whose audience the setting decides: link
    level (stored, or by default), and pages that take their parent's access."""
    return {"workspace_id": workspace_id,
            "$or": [{"access_level": {"$in": ["link", None]}},
                    {"parent_id": {"$ne": None}, "access_inherit": {"$ne": False}}]}


def _ws_oid(workspace_id: str) -> ObjectId | None:
    try:
        return ObjectId(workspace_id)
    except Exception:
        return None


async def begin_require_auth(db: AsyncIOMotorDatabase, workspace_id: str) -> dict | None:
    """The synchronous part of W1/W2 (see above). Returns None when the
    documents already reflect the current setting."""
    from pymongo import ReturnDocument

    oid = _ws_oid(workspace_id)
    if oid is None:
        return None
    result: dict | None = None
    for _attempt in range(5):
        row = await db["workspaces"].find_one({"_id": oid}, {"settings": 1, "require_auth_applied": 1})
        if row is None:
            return result
        want = bool((row.get("settings") or {}).get("require_auth_to_view"))
        applied = row.get("require_auth_applied")
        if applied is None:
            # Never toggled since C-N8: nothing to reconcile.
            await db["workspaces"].update_one({"_id": oid, "require_auth_applied": {"$exists": False}},
                                              {"$set": {"require_auth_applied": want}})
            return result
        if bool(applied) == want:
            return result
        # The generation and the setting from one snapshot of the row: a
        # toggle landing after this bumps the generation again and re-marks.
        # (``require_auth_running`` before anything is marked: the background
        # loop resumes a runner that died, whatever happens next.)
        row = await db["workspaces"].find_one_and_update(
            {"_id": oid}, {"$inc": {"require_auth_gen": 1}, "$set": {"require_auth_running": True}},
            projection={"settings": 1, "require_auth_gen": 1}, return_document=ReturnDocument.AFTER)
        if row is None:
            return result
        gen = int(row.get("require_auth_gen") or 0)
        want = bool((row.get("settings") or {}).get("require_auth_to_view"))
        result = await _mark_for_require_auth(db, workspace_id, want, gen)
        # The generation moves again once the marks are in, and the job is
        # (re)declared running: a runner that looked for marks before they
        # landed can't record the job as finished (its compare-and-set on the
        # generation fails), and one that already did is overruled here.
        await db["workspaces"].update_one(
            {"_id": oid},
            {"$inc": {"require_auth_gen": 1},
             "$set": {"require_auth_running": True,
                      "require_auth_job": {"want": want, "gen": gen, "total": result["changed"],
                                           "started_at": _now(), "finished_at": None}}})
        # What was marked is what is applied; the loop then re-reads the
        # setting, so a toggle that wrote in between (and may have found
        # "applied" equal to its value, so did nothing) gets its own round.
        await db["workspaces"].update_one({"_id": oid}, {"$set": {"require_auth_applied": want}})
    log.warning("require sign-in of %s kept changing while it was applied", workspace_id)
    return result


async def _mark_for_require_auth(db: AsyncIOMotorDatabase, workspace_id: str, want: bool, gen: int) -> dict:
    """One ``update_many``: every affected document marked (and, turning
    sign-in on, its epoch bumped); sockets told; every cached render's purge
    written to the outbox (sent by the runner)."""
    mark = {"ws": workspace_id, "gen": gen, "at": _now()}
    update: dict = {"$set": {"access_dirty": True, RA_PENDING: mark}}
    if want:
        update["$inc"] = {"access_epoch": 1}
    res = await db["documents"].update_many(_ra_affected(workspace_id), update)
    # Open sockets re-check (a narrowing closes them); every cached render of
    # the workspace goes, the unaffected documents' too (their gate and
    # branding differ under sign-in).
    rows = await db["documents"].find({"workspace_id": workspace_id},
                                      {"slug": 1, "old_slugs": 1, "rev": 1, RA_PENDING: 1}).to_list(length=20_000)
    slugs: list[str] = []
    for r in rows:
        slugs.append(r.get("slug"))
        slugs.extend(s for s in (r.get("old_slugs") or []) if isinstance(s, str))
        if (r.get(RA_PENDING) or {}).get("gen") == gen:
            if want:
                live.access_changed(r.get("slug"))
            else:
                live.publish(r.get("slug"), int(r.get("rev") or 1))
    await revalidate.enqueue(db, slugs=slugs, tags=[f"wsl:{workspace_id}", *await _host_tags(db, workspace_id)],
                             attempt_now=False)
    return {"documents": len(rows), "changed": res.modified_count, "want": want, "gen": gen}


async def _apply_marked(db: AsyncIOMotorDatabase, raw: dict) -> bool:
    """Re-derive one marked document's bytes and page images from its row and
    the *current* setting, then clear its mark — only if nobody re-marked or
    changed it meanwhile (else it is handled again). A failure leaves it
    dirty for the reconciler. Returns True when it is clean."""
    from app.services import page_assets

    mark = raw.get(RA_PENDING) or {}
    ok = True
    try:
        public = await publicity.doc_is_public(db, raw)
        if publicity._has_bytes(raw):
            ok = await publicity.apply(raw, public, epoch=publicity.epoch_of(raw))
        ok = await page_assets.sync(db, raw) and ok
    except Exception:
        log.warning("re-deriving %s for sign-in failed", raw.get("slug"), exc_info=True)
        ok = False
    marked = {"_id": raw["_id"], f"{RA_PENDING}.ws": mark.get("ws"), f"{RA_PENDING}.gen": mark.get("gen")}
    if ok:
        res = await db["documents"].update_one(
            {**marked, "access_epoch": raw.get("access_epoch"), "access_level": raw.get("access_level"),
             "read_password_hash": raw.get("read_password_hash"), "workspace_id": raw.get("workspace_id")},
            {"$set": {"access_dirty": False}, "$unset": {RA_PENDING: ""}})
        if res.matched_count:
            return True
    # Re-marked (handled again with the newer setting) or changed by someone
    # else (their own transition re-derived it; the reconciler checks).
    await db["documents"].update_one(marked, {"$unset": {RA_PENDING: ""}})
    return False


async def _take_ra_lease(db: AsyncIOMotorDatabase, oid: ObjectId, holder: str) -> bool:
    now = _now()
    res = await db["workspaces"].update_one(
        {"_id": oid, "$or": [{"require_auth_lock": None}, {"require_auth_lock": {"$lt": now}},
                             {"require_auth_lock_holder": holder}]},
        {"$set": {"require_auth_lock": now + REQUIRE_AUTH_LEASE, "require_auth_lock_holder": holder}})
    return res.matched_count == 1


async def run_require_auth(db: AsyncIOMotorDatabase, workspace_id: str) -> dict | None:
    """The background part of W1/W2: work through every document marked by
    this workspace until none is left. None when another runner holds the
    workspace's lease (it picks up anything marked meanwhile)."""
    import secrets

    oid = _ws_oid(workspace_id)
    if oid is None:
        return None
    holder = secrets.token_hex(8)
    if not await _take_ra_lease(db, oid, holder):
        return None
    lost = asyncio.Event()

    async def heartbeat() -> None:
        while True:
            await asyncio.sleep(REQUIRE_AUTH_LEASE.total_seconds() / 4)
            if not await _take_ra_lease(db, oid, holder):
                lost.set()
                return

    beat = asyncio.get_running_loop().create_task(heartbeat())
    done = failed = 0
    try:
        for _round in range(1000):
            if lost.is_set():
                break
            rows = await db["documents"].find({f"{RA_PENDING}.ws": workspace_id}).limit(RA_BATCH).to_list(
                length=RA_BATCH)
            if not rows:
                break
            # Every cached render of the workspace (the outbox already holds
            # the jobs; only the due ones go), bounded, alongside the bytes.
            keys = await _workspace_purge_keys(db, workspace_id)
            purge = asyncio.get_running_loop().create_task(
                revalidate.run_due(db, keys=keys, limit=len(keys) * 2, concurrency=RA_PURGE_CONCURRENCY))
            queue = list(reversed(rows))

            async def lane() -> None:
                nonlocal done, failed
                while queue and not lost.is_set():
                    raw = queue.pop()
                    if await _apply_marked(db, raw):
                        done += 1
                    else:
                        failed += 1

            await asyncio.gather(*(lane() for _ in range(min(RA_CONCURRENCY, len(rows)))))
            try:
                await purge
            except Exception:  # pragma: no cover - the outbox keeps them
                log.warning("purges for %s's sign-in change failed; left to the worker", workspace_id,
                            exc_info=True)
        if not lost.is_set() and (done or failed) and not await publicity.workspace_requires_auth(db, workspace_id):
            # Reopened: renders cached while the objects were catching up carry
            # signed links (publicity.unsigned_ok), which lapse. Once more,
            # now that the objects are public.
            keys = await revalidate.rearm(db, await _workspace_purge_keys(db, workspace_id))
            await revalidate.run_due(db, keys=keys, limit=len(keys) * 2, concurrency=RA_PURGE_CONCURRENCY)
        if not lost.is_set():
            # Finished — unless a toggle overlapped: the generation is read
            # before the last look for marks, and a toggle bumps it before and
            # after it marks (begin_require_auth).
            ws = await db["workspaces"].find_one({"_id": oid}, {"require_auth_gen": 1})
            gen = (ws or {}).get("require_auth_gen")
            if ws is not None and not await db["documents"].find_one({f"{RA_PENDING}.ws": workspace_id},
                                                                      {"_id": 1}):
                await db["workspaces"].update_one(
                    {"_id": oid, "require_auth_gen": gen},
                    {"$set": {"require_auth_job.finished_at": _now()}, "$unset": {"require_auth_running": ""}})
    finally:
        beat.cancel()
        await db["workspaces"].update_one({"_id": oid, "require_auth_lock_holder": holder},
                                          {"$set": {"require_auth_lock": None, "require_auth_lock_holder": None}})
    return {"done": done, "failed": failed}


async def _workspace_purge_keys(db: AsyncIOMotorDatabase, workspace_id: str) -> list[str]:
    rows = await db["documents"].find({"workspace_id": workspace_id}, {"slug": 1, "old_slugs": 1}).to_list(
        length=20_000)
    keys = [revalidate.doc_key(s) for r in rows
            for s in [r.get("slug"), *(r.get("old_slugs") or [])] if isinstance(s, str) and s]
    return keys + [revalidate.tag_key(t) for t in [f"wsl:{workspace_id}", *await _host_tags(db, workspace_id)]]


def kick_require_auth(db: AsyncIOMotorDatabase, workspace_id: str) -> asyncio.Task | None:
    """Start a runner in this process now (one per workspace per process; the
    lease keeps it to one overall). Returns its task."""
    task = _RUNNERS.get(workspace_id)
    if task is not None and not task.done():
        return task
    try:
        task = asyncio.get_running_loop().create_task(run_require_auth(db, workspace_id))
    except RuntimeError:
        return None
    _RUNNERS[workspace_id] = task

    def _done(t: asyncio.Task) -> None:
        if _RUNNERS.get(workspace_id) is t:
            _RUNNERS.pop(workspace_id, None)
        if not t.cancelled() and t.exception() is not None:
            log.warning("require sign-in runner for %s failed", workspace_id, exc_info=t.exception())

    task.add_done_callback(_done)
    return task


async def require_auth_progress(db: AsyncIOMotorDatabase, workspace_id: str, row: dict | None = None) -> dict | None:
    """``{"state": "applying" | "done", "pending", "total", "want"}`` for the
    settings page, or None when no sign-in change was ever applied in the
    background. ``pending`` counts documents whose bytes, images and cached
    renders still follow the old setting (the gate itself already doesn't)."""
    oid = _ws_oid(workspace_id)
    if oid is None:
        return None
    if row is None or "require_auth_job" not in row:
        row = await db["workspaces"].find_one({"_id": oid}, {"require_auth_job": 1, "require_auth_running": 1})
    job = (row or {}).get("require_auth_job")
    if not job:
        return None
    pending = 0
    if row.get("require_auth_running") or not job.get("finished_at"):
        pending = await db["documents"].count_documents({f"{RA_PENDING}.ws": workspace_id})
    applying = bool(pending) or (bool(row.get("require_auth_running")) and not job.get("finished_at"))
    total = max(int(job.get("total") or 0), pending)
    return {"state": "applying" if applying else "done", "pending": pending, "total": total,
            "want": bool(job.get("want"))}


async def sync_require_auth(db: AsyncIOMotorDatabase, workspace_id: str, *,
                            wait: float = 10.0) -> dict | None:
    """C-N8: make the documents reflect the workspace's *current*
    ``require_auth_to_view`` — never the value a request saw before it wrote.

    The database part is done before this returns (``begin_require_auth``:
    the gate holds from here on); the rest runs in the background and this
    waits for it up to ``wait`` seconds — a small workspace is done by then,
    a big one answers with progress (``require_auth_progress``) and carries
    on. Returns None when there was nothing to do."""
    begun = await begin_require_auth(db, workspace_id)
    if begun is None:
        # Nothing new. One still applying (another request's, or a stopped
        # process's) is nudged along, without waiting for it.
        progress = await require_auth_progress(db, workspace_id)
        if progress is not None and progress["state"] == "applying":
            kick_require_auth(db, workspace_id)
        return None
    task = kick_require_auth(db, workspace_id)
    deadline = asyncio.get_running_loop().time() + max(0.0, wait)
    while True:
        if task is not None and not task.done():
            left = deadline - asyncio.get_running_loop().time()
            if left <= 0:
                break
            await asyncio.wait({task}, timeout=min(left, 0.25))
            continue
        progress = await require_auth_progress(db, workspace_id)
        if progress is None or progress["state"] == "done" or asyncio.get_running_loop().time() >= deadline:
            break
        # Another process's runner holds the lease: watch it finish (bounded).
        await asyncio.sleep(0.1)
        task = kick_require_auth(db, workspace_id)
    progress = await require_auth_progress(db, workspace_id)
    return {**(begun or {}), "progress": progress}


async def resume_require_auth(db: AsyncIOMotorDatabase) -> int:
    """Background loop: finish what a stopped process left (its runner's
    lease lapses), and apply a setting a request wrote but died before
    applying. Returns how many workspaces were worked on."""
    n = 0
    now = _now()
    ids: list = []
    async for w in db["workspaces"].find(
            {"require_auth_running": True,
             "$or": [{"require_auth_lock": None}, {"require_auth_lock": {"$lt": now}}]}, {"_id": 1}):
        ids.append(w["_id"])
    last = _RESUME_SCAN.get("t")
    if last is None or now - last >= RESUME_SCAN_EVERY:
        _RESUME_SCAN["t"] = now
        ids.extend(await _unapplied_workspaces(db))
    for oid in dict.fromkeys(ids):
        wid = str(oid)
        try:
            await begin_require_auth(db, wid)
            res = await run_require_auth(db, wid)
            if res is not None:
                n += 1
        except Exception:
            log.warning("resuming the sign-in change of %s failed", wid, exc_info=True)
    return n


RESUME_SCAN_EVERY = timedelta(seconds=60)
_RESUME_SCAN: dict[str, datetime] = {}


async def _unapplied_workspaces(db: AsyncIOMotorDatabase) -> list:
    """Workspaces whose setting differs from what their documents reflect (a
    request that wrote the setting and died before marking anything)."""
    ids: list = []
    try:
        async for w in db["workspaces"].find(
                {"require_auth_applied": {"$exists": True},
                 "$expr": {"$ne": [{"$toBool": "$require_auth_applied"},
                                   {"$toBool": {"$ifNull": ["$settings.require_auth_to_view", False]}}]}},
                {"_id": 1}):
            ids.append(w["_id"])
    except Exception:  # pragma: no cover - a store without $expr
        pass
    return ids


async def _host_tags(db: AsyncIOMotorDatabase, workspace_id: str) -> list[str]:
    rows = await db["domains"].find({"workspace_id": workspace_id}, {"host": 1}).to_list(length=200)
    return [f"host:{r['host']}" for r in rows if r.get("host")]


async def release_workspace_documents(db: AsyncIOMotorDatabase, workspace_id: str,
                                      require_auth: bool, *, passes: int = 3,
                                      purge_keys: list[str] | None = None) -> tuple[int, int]:
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
                    if purge_keys is not None:
                        purge_keys.extend(revalidate.doc_key(x) for x in
                                          [raw.get("slug"), *(raw.get("old_slugs") or [])] if x)
            except Exception:
                log.warning("releasing %s from %s failed", raw.get("slug"), workspace_id, exc_info=True)
    await db["document_grants"].delete_many({"granted_via": workspace_id})
    remaining = await db["documents"].count_documents({"workspace_id": workspace_id})
    return n, remaining


# ── Membership (M1, M2) ───────────────────────────────────────────────────────


async def _settle_documents(db: AsyncIOMotorDatabase, doc_ids) -> int:
    from app.services import access

    changed = 0
    for doc_id in sorted({d for d in doc_ids if d}):
        try:
            changed += await access.settle_document_grants(db, doc_id)
        except Exception:
            log.warning("settling the grants of %s failed", doc_id, exc_info=True)
    return changed


async def _docs_resting_on(db: AsyncIOMotorDatabase, workspace_id: str, user_id: str) -> list[str]:
    """Documents with a grant this person made, or one made through
    ``workspace_id`` (re-shares of those inherit ``granted_via``)."""
    ids = set(await db["document_grants"].distinct("document_id", {"granted_by_user_id": user_id}))
    ids |= set(await db["document_grants"].distinct("document_id", {"granted_via": workspace_id}))
    return list(ids)


async def member_left(db: AsyncIOMotorDatabase, workspace_id: str, user_id: str) -> int:
    """M1: grants this person made through their workspace role give nothing
    any more (read time, access.GrantGraph) — and neither does anything
    re-shared from them, however deep (C2, C-N1). Housekeeping deletes them
    now, synchronously; live readers re-check."""
    from app.services import live

    doc_ids = await _docs_resting_on(db, workspace_id, user_id)
    changed = await _settle_documents(db, doc_ids)
    if changed:
        for doc_id in doc_ids:
            try:
                d = await db["documents"].find_one({"_id": ObjectId(doc_id)}, {"slug": 1})
            except Exception:
                d = None
            if d:
                live.access_changed(d.get("slug"))
    return changed


async def member_demoted(db: AsyncIOMotorDatabase, workspace_id: str, user_id: str,
                         new_role: str) -> int:
    """M2: demoted to viewer ⇒ editor grants they made through the workspace
    give viewer only, and so does everything re-shared from those (C2).
    Stored roles are lowered to match."""
    if new_role != "viewer":
        return 0
    return await _settle_documents(db, await _docs_resting_on(db, workspace_id, user_id))


_DELEGATION_CURSOR: dict = {"after": None}


async def drop_orphaned_delegations(db: AsyncIOMotorDatabase, *, limit: int = 5000,
                                    since: datetime | None = None) -> int:
    """Reconciler housekeeping (read-time validity already applies): settle
    the documents of delegated grants — recent ones (``since``) every pass,
    plus the next ``limit`` older ones in ``_id`` order (a rotating cursor,
    so every delegated grant is looked at regardless of when it was made).
    Returns how many rows were deleted or lowered."""
    delegated: dict = {"$or": [{"granted_via": {"$nin": [None]}}, {"parent_grant_id": {"$nin": [None]}}]}
    doc_ids: set[str] = set()
    if since is not None:
        rows = await db["document_grants"].find(
            {**delegated, "created_at": {"$gte": since}}, {"document_id": 1}).limit(limit).to_list(length=limit)
        doc_ids |= {r["document_id"] for r in rows}
    query = dict(delegated)
    if _DELEGATION_CURSOR["after"] is not None:
        query = {"$and": [delegated, {"_id": {"$gt": _DELEGATION_CURSOR["after"]}}]}
    rows = await db["document_grants"].find(query, {"document_id": 1}).sort("_id", 1).limit(limit).to_list(length=limit)
    _DELEGATION_CURSOR["after"] = rows[-1]["_id"] if len(rows) == limit else None
    doc_ids |= {r["document_id"] for r in rows}
    return await _settle_documents(db, doc_ids)


# ── Expiry sweeper (A6) ───────────────────────────────────────────────────────


async def sweep_expired(db: AsyncIOMotorDatabase, *, limit: int = 100) -> int:
    """Destroy documents whose ``expires_at`` has passed. A row whose bytes
    can't be deleted is at least made private (``destroy`` closes first)."""
    n = 0
    rows = await db["documents"].find(
        {"expires_at": {"$ne": None, "$lte": _now()}}).limit(limit).to_list(length=limit)
    # B-N4: one bounded, concurrent flush for the whole pass — a mass expiry
    # must not wait ≈ one purge round trip per document.
    async with revalidate.batch(db):
        for raw in rows:
            try:
                if await destroy(db, raw, reason="expiry"):
                    n += 1
            except Exception:
                log.warning("expiring %s failed", raw.get("slug"), exc_info=True)
    return n


async def next_expiry(db: AsyncIOMotorDatabase, within: timedelta) -> datetime | None:
    """The earliest ``expires_at`` still ahead of now and within ``within``."""
    now = _now()
    row = await db["documents"].find_one(
        {"expires_at": {"$gt": now, "$lte": now + within}}, {"expires_at": 1},
        sort=[("expires_at", 1)])
    return publicity.aware(row.get("expires_at")) if row else None


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
    from app.services import page_assets

    if not await page_assets.sync(db, raw):
        return False
    # A stale sign-in mark (its runner is long gone) is cleared with the row:
    # compare-and-set on it, so a fresh one is never lost.
    clean = {"$set": {"access_dirty": False}, "$unset": {RA_PENDING: ""}}
    if not publicity._has_bytes(raw):
        await db["documents"].update_one(
            {"_id": raw["_id"], "access_epoch": raw.get("access_epoch"), RA_PENDING: raw.get(RA_PENDING)}, clean)
        return True
    public = await publicity.doc_is_public(db, raw)
    if not await publicity.apply(raw, public, epoch=publicity.epoch_of(raw)):
        return False
    res = await db["documents"].update_one(
        {"_id": raw["_id"], "access_epoch": raw.get("access_epoch"),
         "access_level": raw.get("access_level"), "read_password_hash": raw.get("read_password_hash"),
         "workspace_id": raw.get("workspace_id"), RA_PENDING: raw.get(RA_PENDING)},
        clean)
    return res.matched_count == 1


async def reconcile_once(db: AsyncIOMotorDatabase, *, limit: int = 200, full: bool = False) -> dict:
    """Dirty rows (and with ``full``, dangling workspace refs and orphan grants)."""
    fixed = failed = 0
    # Documents a workspace's sign-in runner is working through are its own
    # (two writers on one object could leave it open); a mark older than
    # RA_STALE means that runner is gone and nobody resumed it.
    query = {"access_dirty": True, "$or": [{RA_PENDING: None}, {f"{RA_PENDING}.at": {"$lt": _now() - RA_STALE}}]}
    async for raw in db["documents"].find(query).limit(limit):
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
        # C8: documents pointing at a folder that no longer exists go to
        # their workspace's root.
        from app.services import folder as folder_service

        for fid in await db["documents"].distinct("folder_id", {"folder_id": {"$ne": None}}):
            try:
                exists = await db["folders"].find_one({"_id": ObjectId(fid)}, {"_id": 1})
            except Exception:
                exists = None
            if exists is None:
                async for raw in db["documents"].find({"folder_id": fid}).limit(limit):
                    await folder_service.unfile_if_folder_gone(db, raw)
                    fixed += 1
        from app.services import trash

        doc_ids = await db["document_grants"].distinct("document_id")
        for doc_id in doc_ids:
            try:
                present = await db["documents"].find_one({"_id": ObjectId(doc_id)}, {"_id": 1})
            except Exception:
                present = None
            if present is None and doc_id in await trash.trashed_ids(db, [doc_id]):
                present = {"_id": doc_id}  # in the trash: its grants come back with it
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
    # 3b. Documents that share an address with a folder next to them (B5).
    #     New ones are refused; old ones are listed here (the workspace's
    #     domain serves the folder unless the document's owner is an admin).
    try:
        from app.services import folder as folder_service

        clashes = await folder_service.list_slug_collisions(db)
    except Exception:
        clashes = []
        log.warning("listing folder/document address collisions failed", exc_info=True)
    for c in clashes:
        log.warning("address collision in workspace %s: folder %s and document %s both answer at %r",
                    c["workspace_id"], c["folder_id"], c["document_id"], c["slug"])
    out["slug_collisions"] = len(clashes)
    # 3c. Delegated grants made before authority was recorded (C-N4): link
    #     each re-share to the granter's own grant (or workspace role), so its
    #     validity follows the chain at read time. One-shot.
    try:
        out["grant_authority_linked"] = await _link_legacy_grants(db)
    except Exception:
        log.warning("linking legacy re-shared grants failed", exc_info=True)
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


async def _link_legacy_grants(db: AsyncIOMotorDatabase) -> int:
    """Grants written before ``granted_by_user_id``/``parent_grant_id``
    existed carry only ``granted_by_email``. The owner's become owner roots;
    anyone else's point at the granter's own grant (or their membership of
    the document's workspace), and with neither they record the granter and
    give nothing (the owner sees them as inactive)."""
    from app.services import access

    marker = "grant_authority_v1"
    if await db["migrations"].find_one({"_id": marker}):
        return 0
    linked = 0
    emails: dict[str, str | None] = {}

    async def uid_for(email: str) -> str | None:
        if email not in emails:
            row = await db["users"].find_one({"email": email}, {"_id": 1})
            emails[email] = str(row["_id"]) if row else None
        return emails[email]

    owners: dict[str, tuple] = {}
    query = {"$or": [{"granted_by_user_id": None},
                     {"parent_grant_id": None, "granted_via": None}]}
    async for g in db["document_grants"].find(query):
        doc_id = g["document_id"]
        if doc_id not in owners:
            try:
                d = await db["documents"].find_one({"_id": ObjectId(doc_id)}, {"owner_id": 1, "workspace_id": 1})
            except Exception:
                d = None
            owner_email = None
            if d and d.get("owner_id"):
                try:
                    u = await db["users"].find_one({"_id": ObjectId(d["owner_id"])}, {"email": 1})
                except Exception:
                    u = None
                owner_email = access.normalize_email((u or {}).get("email"))
            owners[doc_id] = (d, owner_email)
        d, owner_email = owners[doc_id]
        if d is None or not d.get("owner_id"):
            continue
        granter_email = access.normalize_email(g.get("granted_by_email"))
        granter = g.get("granted_by_user_id")
        if granter is None and (not granter_email or granter_email == owner_email):
            granter = d["owner_id"]
        if granter is None:
            granter = await uid_for(granter_email) or f"email:{granter_email}"
        sets: dict = {"granted_by_user_id": granter}
        if granter != d["owner_id"] and not g.get("parent_grant_id") and not g.get("granted_via"):
            own = await db["document_grants"].find_one(
                {"document_id": doc_id, "email": granter_email, "_id": {"$ne": g["_id"]}},
                {"_id": 1, "granted_via": 1}) if granter_email else None
            if own is not None:
                sets.update(parent_grant_id=str(own["_id"]), granted_via=own.get("granted_via"))
            elif d.get("workspace_id") and await db["memberships"].find_one(
                    {"workspace_id": d["workspace_id"], "user_id": granter}, {"_id": 1}):
                sets["granted_via"] = d["workspace_id"]
        if any(g.get(k) != v for k, v in sets.items()):
            await db["document_grants"].update_one({"_id": g["_id"]}, {"$set": sets})
            linked += 1
    await db["migrations"].update_one({"_id": marker}, {"$set": {"at": _now(), "linked": linked}},
                                      upsert=True)
    return linked


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
