"""Apply an access-affecting change to one document, in the policy's order.

I4 — close before open:

* **Narrowing** (fewer readers, or a new password): mark the row dirty and bump
  its ``access_epoch`` (revokes signed links and read tickets), make the bytes
  private under the new epoch, write the purge jobs, and only then write the
  narrower state. A failure to close the bytes is a 502 with the row still at
  its old (wider) state *and* still marked dirty: the system is never more open
  than the database says.
* **Widening / neutral**: write the row first, then open the bytes; a failure
  to open is only logged (the reconciler retries — ``access_dirty`` stays set).

I12 — every write is a compare-and-set on the fields the decision read
(``cas``), so a racing unshare / refile / level change makes one side 409.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import ReturnDocument

from app.services import live, publicity, revalidate

log = logging.getLogger(__name__)

CONFLICT = "This document changed while that was being saved. Try again."


async def change(
    db: AsyncIOMotorDatabase,
    raw: dict,
    *,
    sets: dict,
    unset: list[str] | None = None,
    cas: dict | None = None,
    inc: dict | None = None,
    narrows: bool | None = None,
    require_auth_after: bool | None = None,
    extra_slugs: tuple = (),
    live_event: str | None = None,
    purge: bool = True,
    inline_purge: bool = False,
) -> dict:
    """Write ``sets``/``unset``/``inc`` to the document, ordered per I4.

    ``narrows`` defaults to "the bytes stop being public". Pass True for any
    change that shrinks the audience or rotates the password (epoch bump).
    Returns the row after the change."""
    unset = list(unset or [])
    ra_before = await publicity.workspace_requires_auth(db, raw.get("workspace_id"))
    after_shape = {**raw, **sets}
    for k in unset:
        after_shape.pop(k, None)
    if require_auth_after is None:
        if "workspace_id" in sets or "workspace_id" in unset:
            require_auth_after = await publicity.workspace_requires_auth(
                db, after_shape.get("workspace_id"))
        else:
            require_auth_after = ra_before
    pub_before = publicity.is_public(raw, require_auth=ra_before)
    pub_after = publicity.is_public(after_shape, require_auth=require_auth_after)
    if narrows is None:
        narrows = pub_before and not pub_after
    has_bytes = publicity._has_bytes(raw)
    filt = {"_id": raw["_id"], **(cas or {})}
    update: dict = {}
    if unset:
        update["$unset"] = {k: "" for k in unset}
    if inc:
        update["$inc"] = dict(inc)

    if narrows:
        epoch = publicity.epoch_of(raw) + 1
        bumped = await db["documents"].update_one(
            {**filt, "access_epoch": raw.get("access_epoch")},
            {"$set": {"access_dirty": True}, "$inc": {"access_epoch": 1}},
        )
        if bumped.matched_count == 0:
            raise HTTPException(status_code=409, detail=CONFLICT)
        if has_bytes:
            await publicity.close({**raw, "access_epoch": epoch}, epoch)
        keys: list[str] = []
        if purge:
            # Durable first (the jobs exist before anything narrows), sent
            # only after the narrower row is written — a purge delivered
            # before that would let the frontend re-cache the old state.
            keys = await revalidate.purge_doc(db, {**raw, **after_shape}, extra_slugs=extra_slugs,
                                              attempt=False)
            if raw.get("workspace_id") and raw.get("workspace_id") != after_shape.get("workspace_id"):
                keys += await revalidate.enqueue(db, tags=[f"wsl:{raw['workspace_id']}"],
                                                 attempt_now=False)
        update["$set"] = {**sets, "access_dirty": False}
        after = await db["documents"].find_one_and_update(
            {**filt, "access_epoch": epoch}, update, return_document=ReturnDocument.AFTER)
        # B-N1: the jobs were written before the row, so a worker may have
        # claimed and sent one in between — with the old state. Re-arm them
        # now that the narrower row is in: at least one more send sees it.
        keys = await revalidate.rearm(db, keys)
        if after is None:
            # Bytes are closed and the row kept its old state: more closed than
            # the database says, which the reconciler repairs (I4).
            await revalidate.flush(db, keys)
            raise HTTPException(status_code=409, detail=CONFLICT)
        # B2: a narrowing answers only once the cached wider render is gone
        # (bounded wait; the outbox retries anything slower).
        await revalidate.flush(db, keys)
        live.access_changed(raw.get("slug"))
        if after.get("slug") != raw.get("slug"):
            live.access_changed(after.get("slug"))
        if sets.get("expires_at") is not None:
            await revalidate.schedule_expiry(db, after)  # B3
        return after

    opens = has_bytes and pub_after and not pub_before
    update["$set"] = {**sets, **({"access_dirty": True} if opens else {})}
    after = await db["documents"].find_one_and_update(filt, update, return_document=ReturnDocument.AFTER)
    if after is None:
        raise HTTPException(status_code=409, detail=CONFLICT)
    if opens:
        if await publicity.apply(after, True, epoch=publicity.epoch_of(after)):
            await db["documents"].update_one(
                {"_id": after["_id"], "access_epoch": after.get("access_epoch")},
                {"$set": {"access_dirty": False}})
            after["access_dirty"] = False
        else:
            log.warning("opening %s failed; left for the reconciler", after.get("slug"))
    if purge:
        # ``inline_purge``: not narrower by level, but closing somewhere — e.g.
        # leaving a workspace takes the document off that workspace's domain —
        # so the answer waits for the purge too (B2).
        keys = await revalidate.purge_doc(db, after, extra_slugs=extra_slugs,
                                          attempt=not inline_purge)
        if raw.get("workspace_id") and raw.get("workspace_id") != after.get("workspace_id"):
            keys += await revalidate.enqueue(db, tags=[f"wsl:{raw['workspace_id']}"],
                                             attempt_now=not inline_purge)
        if inline_purge:
            await revalidate.flush(db, keys)
    if sets.get("expires_at") is not None:
        # B3: the cached renders go when the document does.
        await revalidate.schedule_expiry(db, after)
    if live_event == "access":
        live.access_changed(after.get("slug"))
    else:
        live.publish(after.get("slug"), int(after.get("rev") or 1))
    return after


def now_utc() -> datetime:
    return datetime.now(timezone.utc)
