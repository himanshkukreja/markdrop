import re
from datetime import datetime, timedelta, timezone

import bcrypt
from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError

from app.config import get_settings
from app.models.document import Document
from app.schemas.document import DocumentCreate, DocumentUpdate
from app.utils.security import generate_edit_secret
from app.utils.slug import generate_slug, is_reserved_slug, is_valid_slug, slugify

settings = get_settings()

_EXPIRY_DELTA: dict[str, timedelta | None] = {
    "never": None,
    "1d": timedelta(days=1),
    "7d": timedelta(days=7),
    "30d": timedelta(days=30),
}


def _doc_from_mongo(raw: dict) -> Document:
    return Document(
        id=str(raw["_id"]) if raw.get("_id") is not None else None,
        slug=raw["slug"],
        title=raw.get("title"),
        content=raw["content"],
        edit_secret_hash=raw["edit_secret_hash"],
        created_at=raw["created_at"],
        updated_at=raw["updated_at"],
        expires_at=raw.get("expires_at"),
        views=raw.get("views", 0),
        read_password_hash=raw.get("read_password_hash"),
        owner_id=raw.get("owner_id"),
        export_pdf_count=raw.get("export_pdf_count", 0),
        copy_url_count=raw.get("copy_url_count", 0),
        rev=raw.get("rev", 1),
        google_doc_id=raw.get("google_doc_id"),
        google_doc_url=raw.get("google_doc_url"),
        google_doc_synced_rev=raw.get("google_doc_synced_rev"),
        google_doc_synced_at=raw.get("google_doc_synced_at"),
        vscode_synced=raw.get("vscode_synced", False),
        # Absent on every document created before the feature existed, which is
        # exactly what False means — no migration needed.
        encrypted=raw.get("encrypted", False),
        workspace_id=raw.get("workspace_id"),
        folder_id=raw.get("folder_id"),
        kind=raw.get("kind", "markdown"),
        mime=raw.get("mime"),
        blob_key=raw.get("blob_key"),
        size_bytes=raw.get("size_bytes"),
        folder_path=raw.get("folder_path") or [],
        access_level=raw.get("access_level") or "link",
        allow_resharing=raw.get("allow_resharing", True),
        original_filename=raw.get("original_filename"),
        bundle_prefix=raw.get("bundle_prefix"),
        file_version=raw.get("file_version") or 1,
        sha256=raw.get("sha256"),
        media=raw.get("media"),
        poster_key=raw.get("poster_key"),
        access_epoch=int(raw.get("access_epoch") or 0),
        old_slugs=list(raw.get("old_slugs") or []),
    )


def _check_expiry(expires_in: str | None, custom_expires_at: datetime | None,
                  now: datetime) -> None:
    """A5: an expiry must be in the future (≥ now + 60 s); ``custom`` needs a date."""
    if expires_in == "custom":
        if custom_expires_at is None:
            raise HTTPException(status_code=422, detail="Choose a date for the custom expiry.")
        when = custom_expires_at if custom_expires_at.tzinfo else custom_expires_at.replace(tzinfo=timezone.utc)
        if when < now + timedelta(seconds=60):
            raise HTTPException(status_code=422, detail="The expiry date must be in the future.")


async def _slug_free(db: AsyncIOMotorDatabase, slug: str, owner_id: str | None) -> bool:
    from app.services import lifecycle

    return not await lifecycle.slug_unavailable(db, slug, owner_id)


async def create_document(
    db: AsyncIOMotorDatabase,
    data: DocumentCreate,
    owner_id: str | None = None,
    preferred_slug: str | None = None,
    via_vscode: bool = False,
    extra: dict | None = None,
) -> tuple[Document, str]:
    raw_secret, secret_hash = generate_edit_secret()
    now = datetime.now(timezone.utc)

    if data.expires_in == "custom":
        _check_expiry("custom", data.custom_expires_at, now)
        expires_at = data.custom_expires_at
    else:
        delta = _EXPIRY_DELTA.get(data.expires_in)
        expires_at = (now + delta) if delta else None

    read_pwd_hash = None
    if data.read_password:
        read_pwd_hash = bcrypt.hashpw(data.read_password.encode(), bcrypt.gensalt()).decode()

    def _build(slug: str) -> dict:
        return {
            "slug": slug,
            "title": data.title or None,
            "content": data.content,
            "edit_secret_hash": secret_hash,
            "created_at": now,
            "updated_at": now,
            "expires_at": expires_at,
            "views": 0,
            "export_pdf_count": 0,
            "copy_url_count": 0,
            "rev": 1,
            "read_password_hash": read_pwd_hash,
            "owner_id": owner_id,
            "vscode_synced": via_vscode,
            "encrypted": data.encrypted,
            # Private at creation is only meaningful for a signed-in author:
            # there is nobody to be "only me" for otherwise, and it would lock
            # an anonymous publisher out of the document they just made. The
            # edit secret still opens it either way.
            "access_level": data.access_level if owner_id else "link",
            "access_epoch": 0,
            **(extra or {}),
        }

    # Custom slug path. A slug another document answered at before a rename,
    # or one freed by someone else's delete in the last 30 days, is taken (Q4).
    if data.custom_slug:
        if is_reserved_slug(data.custom_slug):
            raise HTTPException(status_code=409, detail="This URL is reserved. Please choose another.")
        if not await _slug_free(db, data.custom_slug, owner_id):
            raise HTTPException(status_code=409, detail="This URL is already taken. Please choose another.")
        doc_dict = _build(data.custom_slug)
        try:
            await db["documents"].insert_one(doc_dict)
        except DuplicateKeyError:
            raise HTTPException(status_code=409, detail="This URL is already taken. Please choose another.")
        from app.services import lifecycle

        await lifecycle.clear_tombstone(db, data.custom_slug)
        await _schedule_expiry(db, doc_dict)
        return _doc_from_mongo(doc_dict), raw_secret

    # Preferred slug path (e.g. from a filename): try it, then add a short
    # random suffix on collision, then fall through to a fully random slug.
    if preferred_slug:
        base = slugify(preferred_slug)
        if len(base) >= 3 and not is_reserved_slug(base):
            candidates = [base] + [
                f"{base}-{generate_slug(4)}" for _ in range(settings.slug_max_retries)
            ]
            for slug in candidates:
                if not await _slug_free(db, slug, owner_id):
                    continue
                doc_dict = _build(slug)
                try:
                    await db["documents"].insert_one(doc_dict)
                except DuplicateKeyError:
                    continue
                await _schedule_expiry(db, doc_dict)
                return _doc_from_mongo(doc_dict), raw_secret

    # Random slug path with retry
    for _ in range(settings.slug_max_retries):
        slug = generate_slug(settings.slug_length)
        if not await _slug_free(db, slug, owner_id):
            continue
        doc_dict = _build(slug)
        try:
            await db["documents"].insert_one(doc_dict)
        except DuplicateKeyError:
            continue
        await _schedule_expiry(db, doc_dict)
        return _doc_from_mongo(doc_dict), raw_secret

    raise HTTPException(status_code=503, detail="Could not generate unique slug. Try again.")


async def _schedule_expiry(db: AsyncIOMotorDatabase, doc_dict: dict) -> None:
    """B3: a document born with an expiry gets its purge booked for that moment."""
    if doc_dict.get("expires_at") is None:
        return
    from app.services import revalidate

    try:
        await revalidate.schedule_expiry(db, doc_dict)
    except Exception:  # pragma: no cover - the sweeper still purges it
        import logging

        logging.getLogger(__name__).warning("scheduling the expiry purge of %s failed",
                                            doc_dict.get("slug"), exc_info=True)


async def find_for_read(db: AsyncIOMotorDatabase, slug: str) -> tuple[dict | None, bool]:
    """The row at ``slug``, or the row that used to answer at it before a
    rename (Q4). Returns (row, moved)."""
    raw = await db["documents"].find_one({"slug": slug})
    if raw is not None:
        return raw, False
    moved = await db["documents"].find_one({"old_slugs": slug})
    return moved, moved is not None


async def read_document(db: AsyncIOMotorDatabase, slug: str, actor, ctx) -> dict:
    """The row at exactly ``slug`` if the actor may read it, else the read
    denial (access.can, policy §2.6). Read-only — no side effects: views are
    counted by the browser beacon."""
    from app.services import access

    raw = await db["documents"].find_one({"slug": slug})
    await access.require(actor, raw, "read", ctx)
    return raw


def _settings_requested(data: DocumentUpdate) -> bool:
    """A3: any of these present (non-null) is a settings change, owner-only.
    ``read_password: ""`` counts — it removes the password."""
    return (
        data.read_password is not None
        or bool(data.remove_password)
        or data.expires_in is not None
        or data.custom_expires_at is not None
    )


async def update_document(
    db: AsyncIOMotorDatabase,
    slug: str,
    data: DocumentUpdate,
    actor,
    ctx,
) -> dict:
    """Content via can(edit_content); password/expiry via can(edit_settings).
    A request carrying any settings field from someone who may only edit the
    text is refused whole (403) — nothing is written."""
    from app.services import access, transitions

    raw = await db["documents"].find_one({"slug": slug})
    await access.require(actor, raw, "edit_content", ctx)
    settings_change = _settings_requested(data)
    if settings_change:
        await access.require(actor, raw, "edit_settings", ctx)

    now = datetime.now(timezone.utc)
    sets: dict = {"title": data.title or None, "updated_at": now}
    # Artifacts keep their bytes in R2 — `content` is only a search stand-in, so
    # never let a markdown-shaped edit overwrite it.
    if raw.get("kind") != "artifact":
        sets["content"] = data.content

    narrows = False
    if data.remove_password or data.read_password == "":
        sets["read_password_hash"] = None
    elif data.read_password:
        sets["read_password_hash"] = bcrypt.hashpw(
            data.read_password.encode(), bcrypt.gensalt()
        ).decode()
        narrows = True  # A3: new or changed password ⇒ epoch bump, bytes guarded

    if data.expires_in is not None:
        _check_expiry(data.expires_in, data.custom_expires_at, now)
        if data.expires_in == "never":
            sets["expires_at"] = None
        elif data.expires_in == "custom":
            sets["expires_at"] = data.custom_expires_at
        else:
            delta = _EXPIRY_DELTA.get(data.expires_in)
            sets["expires_at"] = (now + delta) if delta else None
    elif data.custom_expires_at is not None:
        _check_expiry("custom", data.custom_expires_at, now)
        sets["expires_at"] = data.custom_expires_at

    after = await transitions.change(
        db, raw, sets=sets, inc={"rev": 1}, narrows=narrows or None,
        cas={"slug": slug},
    )
    ctx.forget(raw)
    return after


async def delete_document(db: AsyncIOMotorDatabase, slug: str, actor, ctx) -> None:
    """Owner or edit secret (D4). Everything goes with it: bytes, old versions,
    posters, grants; caches are purged and the slug is reserved for the same
    owner for 30 days (A8)."""
    from app.services import access, lifecycle

    raw = await db["documents"].find_one({"slug": slug})
    await access.require(actor, raw, "delete", ctx)
    if not await lifecycle.destroy(db, raw):
        raise HTTPException(status_code=404, detail="Document not found")


async def claim_document(db: AsyncIOMotorDatabase, slug: str, actor, ctx) -> Document:
    """Attach an owner-less document to the signed-in account (edit secret)."""
    from app.services import access

    raw = await db["documents"].find_one({"slug": slug})
    if raw is not None and raw.get("owner_id") == actor.user_id:
        return _doc_from_mongo(raw)  # idempotent
    await access.require(actor, raw, "claim", ctx)
    updated = await db["documents"].find_one_and_update(
        {"_id": raw["_id"], "owner_id": None},
        {"$set": {"owner_id": actor.user_id}},
        return_document=True,
    )
    if updated is None:
        raise HTTPException(status_code=409, detail="This document is already owned by another account")
    return _doc_from_mongo(updated)


async def copy_document(db: AsyncIOMotorDatabase, slug: str, actor, ctx) -> tuple[Document, str]:
    """Import a copy of a readable document into the caller's account.

    Copy = read (any reader could select-all and paste), through the full read
    rule — grants, membership, scope and password included. The copy is a new
    document owned by the caller with no password and no expiry, and it is born
    **private** unless the source is plainly public (Q3).
    """
    from app.services import access, publicity

    raw = await db["documents"].find_one({"slug": slug})
    await access.require(actor, raw, "copy", ctx)
    if raw.get("encrypted"):
        raise HTTPException(
            status_code=422,
            detail="Encrypted documents can't be copied on the server. "
                   "Open the document and use Save a copy there.",
        )
    plain_public = publicity.is_public(
        raw, require_auth=await publicity.workspace_requires_auth(db, raw.get("workspace_id")))
    data = DocumentCreate(
        title=raw.get("title"),
        content=raw["content"],
        custom_slug=None,
        expires_in="never",
        read_password=None,
        access_level="link" if plain_public else "private",
    )
    return await create_document(db, data, owner_id=actor.user_id,
                                 preferred_slug=raw.get("title") or None)


async def change_slug(db: AsyncIOMotorDatabase, slug: str, new_slug: str, actor, ctx) -> dict:
    """Rename (owner or edit secret, D4). The old slug joins ``old_slugs``:
    readers who can open the document are redirected from it, and nobody else
    can ever claim it (Q4)."""
    from app.services import access, lifecycle, live, revalidate

    if not is_valid_slug(new_slug):
        raise HTTPException(
            status_code=422,
            detail="Slug must be 3-50 chars: letters, numbers, hyphens or underscores.",
        )
    if is_reserved_slug(new_slug):
        raise HTTPException(status_code=409, detail="This URL is reserved. Please choose another.")

    raw = await db["documents"].find_one({"slug": slug})
    await access.require(actor, raw, "rename_slug", ctx)
    if new_slug == slug:
        return raw
    if await lifecycle.slug_unavailable(db, new_slug, raw.get("owner_id"), doc_id=raw["_id"]):
        raise HTTPException(status_code=409, detail="This URL is already taken. Please choose another.")
    if raw.get("workspace_id"):
        from app.services import folder as folder_service

        # B5: never onto the address of a folder next to it on the workspace's domain.
        await folder_service.assert_doc_fits(db, raw["workspace_id"], raw.get("folder_id"), new_slug)

    now = datetime.now(timezone.utc)
    old_slugs = [s for s in (raw.get("old_slugs") or []) if s != new_slug]
    if slug not in old_slugs:
        old_slugs.append(slug)
    try:
        after = await db["documents"].find_one_and_update(
            {"_id": raw["_id"], "slug": slug},
            {"$set": {"slug": new_slug, "old_slugs": old_slugs, "updated_at": now}},
            return_document=True,
        )
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail="This URL is already taken. Please choose another.")
    if after is None:
        raise HTTPException(status_code=409, detail="This document changed meanwhile. Try again.")
    await lifecycle.clear_tombstone(db, new_slug)
    await revalidate.purge_doc(db, after, extra_slugs=[slug])
    live.gone(slug)
    ctx.forget(raw)
    return after


# Long enough for any title anyone types into a search box; bounded because the
# pattern runs against every row the owner (or workspace) has.
MAX_SEARCH_LEN = 200


def search_clause(q: str | None) -> list[dict] | None:
    """A case-insensitive substring match on slug or title, as an `$or` list.

    `q` is the user's text, not a pattern: it is escaped, so "c++", "(draft" or
    "a.b" search for exactly those characters instead of erroring (an unbalanced
    bracket is a 500 from Mongo) or turning into a catastrophic-backtracking
    regex that pins the database. Returns None for a blank query.
    """
    q = (q or "").strip()[:MAX_SEARCH_LEN]
    if not q:
        return None
    pattern = re.escape(q)
    return [
        {"slug": {"$regex": pattern, "$options": "i"}},
        {"title": {"$regex": pattern, "$options": "i"}},
    ]


async def list_user_documents(
    db: AsyncIOMotorDatabase,
    user_id: str,
    page: int,
    limit: int,
    q: str | None,
    kind: str | None = None,
) -> tuple[list[Document], int]:
    """Return (documents, total) owned by the user, newest first. Expired
    documents are gone (I11) even before the sweeper deletes them."""
    query: dict = {"owner_id": user_id, "$and": [{"$or": [
        {"expires_at": None}, {"expires_at": {"$gt": datetime.now(timezone.utc)}}]}]}
    if kind in ("markdown", "document"):
        # Documents created before artifacts existed have no `kind` field.
        query["kind"] = {"$ne": "artifact"}
    elif kind == "artifact":
        query["kind"] = "artifact"
    search = search_clause(q)
    if search:
        query["$or"] = search
    total = await db["documents"].count_documents(query)
    skip = (page - 1) * limit
    # Include _id so the owner can act on the document by its stable id
    # (e.g. the Google Docs export endpoint, which keys on _id like sync does).
    cursor = (
        db["documents"].find(query).sort("created_at", -1).skip(skip).limit(limit)
    )
    docs = [_doc_from_mongo(d) for d in await cursor.to_list(length=limit)]
    return docs, total


async def count_user_documents(db: AsyncIOMotorDatabase, user_id: str) -> dict:
    """How many documents and artifacts this user owns.

    One grouped aggregation rather than a query per kind: the dashboard sidebar
    renders all three counts together, and they must not cost three round trips.
    """
    rows = await db["documents"].aggregate([
        {"$match": {"owner_id": user_id, "$or": [
            {"expires_at": None}, {"expires_at": {"$gt": datetime.now(timezone.utc)}}]}},
        {"$group": {"_id": {"$ifNull": ["$kind", "markdown"]}, "n": {"$sum": 1}}},
    ]).to_list(length=10)
    by_kind = {r["_id"]: r["n"] for r in rows}
    markdown = sum(n for k, n in by_kind.items() if k != "artifact")
    artifact = by_kind.get("artifact", 0)
    return {
        "count_all": markdown + artifact,
        "count_markdown": markdown,
        "count_artifact": artifact,
    }


_EVENT_COUNTER = {
    "view": "views",
    "export_pdf": "export_pdf_count",
    "copy_url": "copy_url_count",
}


async def report_document(
    db: AsyncIOMotorDatabase, slug: str, reason: str | None, ip: str | None
) -> bool:
    """Flag a document for abuse. Stored only when the slug exists (and has not
    expired); the caller answers 202 either way, so this is no oracle (I5)."""
    import hashlib

    raw = await db["documents"].find_one_and_update(
        {"slug": slug, "$or": [{"expires_at": None},
                               {"expires_at": {"$gt": datetime.now(timezone.utc)}}]},
        {"$inc": {"report_count": 1}}, projection={"_id": 1}
    )
    if not raw:
        return False
    ip_hash = (
        hashlib.sha256((settings.ip_hash_salt + ip).encode()).hexdigest() if ip else None
    )
    await db["reports"].insert_one(
        {
            "doc_id": str(raw["_id"]),
            "slug": slug,
            "reason": (reason or None),
            "ip_hash": ip_hash,
            "ts": datetime.now(timezone.utc),
        }
    )
    return True


async def register_event(
    db: AsyncIOMotorDatabase, raw: dict, event_type: str
) -> tuple[str, str | None] | None:
    """Bump the counter for an event type on a document the caller was allowed
    to record against. Returns (doc_id, owner_id) or None."""
    field = _EVENT_COUNTER[event_type]
    updated = await db["documents"].find_one_and_update(
        {"_id": raw["_id"]},
        {"$inc": {field: 1}},
        projection={"_id": 1, "owner_id": 1},
        return_document=True,
    )
    if not updated:
        return None
    return str(updated["_id"]), updated.get("owner_id")


async def get_owned_doc_id(
    db: AsyncIOMotorDatabase, slug: str, user_id: str
) -> str | None:
    """Return the document's id if owned by the user, else None (404/403 upstream)."""
    raw = await db["documents"].find_one(
        {"slug": slug}, {"_id": 1, "owner_id": 1, "expires_at": 1}
    )
    if not raw or _expired(raw):
        return None
    if raw.get("owner_id") != user_id:
        return None
    return str(raw["_id"])


def _expired(raw: dict) -> bool:
    from app.services import publicity

    return publicity.is_expired(raw)


# ── Sync (VS Code extension) — operate by immutable _id, owner-scoped ────────────


async def get_owned_document_by_id(
    db: AsyncIOMotorDatabase, doc_id: str, user_id: str
) -> Document | None:
    if not ObjectId.is_valid(doc_id):
        return None
    raw = await db["documents"].find_one({"_id": ObjectId(doc_id)})
    # can(sync) / can(gdocs_export) = the owner (policy §4.1 #38), and an
    # expired document is gone everywhere (I11).
    if not raw or raw.get("owner_id") != user_id or _expired(raw):
        return None
    return _doc_from_mongo(raw)


async def mark_vscode_synced(db: AsyncIOMotorDatabase, doc_id: str) -> None:
    """Flag a document as VS Code-synced (idempotent, one-time write).

    Called from the sync pull/rev endpoints so any document the extension is
    actively tracking lights up the "Synced with VS Code" badge — including
    docs published before the flag existed — without needing a fresh push.
    """
    if not ObjectId.is_valid(doc_id):
        return
    await db["documents"].update_one(
        {"_id": ObjectId(doc_id), "vscode_synced": {"$ne": True}},
        {"$set": {"vscode_synced": True}},
    )


async def set_google_doc_link(
    db: AsyncIOMotorDatabase,
    doc_id: str,
    user_id: str,
    *,
    google_doc_id: str,
    google_doc_url: str | None,
    synced_rev: int,
) -> Document | None:
    """Record which Google Doc a document is exported to and at what rev.

    Owner-scoped: returns None if the document isn't owned by ``user_id``.
    """
    if not ObjectId.is_valid(doc_id):
        return None
    updated = await db["documents"].find_one_and_update(
        {"_id": ObjectId(doc_id), "owner_id": user_id},
        {
            "$set": {
                "google_doc_id": google_doc_id,
                "google_doc_url": google_doc_url,
                "google_doc_synced_rev": synced_rev,
                "google_doc_synced_at": datetime.now(timezone.utc),
            }
        },
        return_document=True,
    )
    return _doc_from_mongo(updated) if updated else None


async def sync_push(
    db: AsyncIOMotorDatabase,
    doc_id: str,
    user_id: str,
    content: str,
    title: str | None,
    base_rev: int,
) -> tuple[str, Document | None]:
    """Push content with optimistic concurrency.

    Returns ("ok", doc) | ("conflict", current_doc) | ("notfound", None).
    Only content + title change — password/expiry/slug are left untouched.
    """
    if not ObjectId.is_valid(doc_id):
        return ("notfound", None)
    raw = await db["documents"].find_one({"_id": ObjectId(doc_id)})
    if not raw or raw.get("owner_id") != user_id or _expired(raw):
        return ("notfound", None)

    cur_rev = raw.get("rev", 1)
    if base_rev != cur_rev:
        return ("conflict", _doc_from_mongo(raw))

    now = datetime.now(timezone.utc)
    # Compare-and-swap on rev so a concurrent writer can't be clobbered.
    updated = await db["documents"].find_one_and_update(
        {"_id": ObjectId(doc_id), "rev": cur_rev},
        {
            "$set": {
                "content": content,
                "title": title or None,
                "updated_at": now,
                "vscode_synced": True,
            },
            "$inc": {"rev": 1},
        },
        return_document=True,
    )
    if not updated:
        fresh = await db["documents"].find_one({"_id": ObjectId(doc_id)})
        return ("conflict", _doc_from_mongo(fresh))
    return ("ok", _doc_from_mongo(updated))
