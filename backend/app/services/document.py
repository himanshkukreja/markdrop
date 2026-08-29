from datetime import datetime, timedelta, timezone

import bcrypt
from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError

from app.config import get_settings
from app.models.document import Document
from app.schemas.document import DocumentCreate, DocumentUpdate
from app.utils.security import generate_edit_secret, verify_edit_secret
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
        kind=raw.get("kind", "markdown"),
        mime=raw.get("mime"),
        blob_key=raw.get("blob_key"),
        size_bytes=raw.get("size_bytes"),
        original_filename=raw.get("original_filename"),
        bundle_prefix=raw.get("bundle_prefix"),
    )


def _authorize(raw: dict, edit_secret: str | None, user_id: str | None) -> None:
    """Authorize an edit/delete via EITHER document ownership OR the edit secret.

    Raises 403 if neither proves authority.
    """
    if user_id and raw.get("owner_id") == user_id:
        return
    if edit_secret and verify_edit_secret(edit_secret, raw["edit_secret_hash"]):
        return
    raise HTTPException(status_code=403, detail="Not authorized to modify this document")


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
            **(extra or {}),
        }

    # Custom slug path
    if data.custom_slug:
        if is_reserved_slug(data.custom_slug):
            raise HTTPException(status_code=409, detail="This URL is reserved. Please choose another.")
        doc_dict = _build(data.custom_slug)
        try:
            await db["documents"].insert_one(doc_dict)
            return _doc_from_mongo(doc_dict), raw_secret
        except DuplicateKeyError:
            raise HTTPException(status_code=409, detail="This URL is already taken. Please choose another.")

    # Preferred slug path (e.g. from a filename): try it, then add a short
    # random suffix on collision, then fall through to a fully random slug.
    if preferred_slug:
        base = slugify(preferred_slug)
        if len(base) >= 3 and not is_reserved_slug(base):
            candidates = [base] + [
                f"{base}-{generate_slug(4)}" for _ in range(settings.slug_max_retries)
            ]
            for slug in candidates:
                doc_dict = _build(slug)
                try:
                    await db["documents"].insert_one(doc_dict)
                    return _doc_from_mongo(doc_dict), raw_secret
                except DuplicateKeyError:
                    continue

    # Random slug path with retry
    for _ in range(settings.slug_max_retries):
        doc_dict = _build(generate_slug(settings.slug_length))
        try:
            await db["documents"].insert_one(doc_dict)
            return _doc_from_mongo(doc_dict), raw_secret
        except DuplicateKeyError:
            continue

    raise HTTPException(status_code=503, detail="Could not generate unique slug. Try again.")


async def get_document(
    db: AsyncIOMotorDatabase,
    slug: str,
    read_password: str | None = None,
    edit_secret: str | None = None,
    user_id: str | None = None,
) -> Document:
    # Read-only fetch — NO side effects. Views are counted by a browser beacon
    # (POST /{slug}/events type=view), so server-side rendering on Vercel does
    # not inflate the count or poison geo with the SSR server's location.
    raw = await db["documents"].find_one({"slug": slug})
    if not raw:
        raise HTTPException(status_code=404, detail="Document not found")

    if raw.get("read_password_hash"):
        # The owner (logged in, or holding a valid edit secret) bypasses the gate.
        owner_bypasses = user_id and raw.get("owner_id") == user_id
        edit_secret_bypasses = edit_secret and verify_edit_secret(edit_secret, raw["edit_secret_hash"])
        if not (owner_bypasses or edit_secret_bypasses):
            if not read_password:
                raise HTTPException(status_code=401, detail="Password required")
            if not bcrypt.checkpw(read_password.encode(), raw["read_password_hash"].encode()):
                raise HTTPException(status_code=403, detail="Incorrect password")

    return _doc_from_mongo(raw)


async def update_document(
    db: AsyncIOMotorDatabase,
    slug: str,
    data: DocumentUpdate,
    edit_secret: str | None = None,
    user_id: str | None = None,
) -> Document:
    raw = await db["documents"].find_one({"slug": slug}, {"_id": 0})
    if not raw:
        raise HTTPException(status_code=404, detail="Document not found")

    _authorize(raw, edit_secret, user_id)

    now = datetime.now(timezone.utc)
    updates: dict = {"title": data.title or None, "updated_at": now}
    # Artifacts keep their bytes in R2 — `content` is only a search stand-in, so
    # never let a markdown-shaped edit overwrite it. Title, password and expiry
    # below still apply, which is what an artifact owner actually needs.
    if raw.get("kind") != "artifact":
        updates["content"] = data.content

    # Password update: remove or set new
    if data.remove_password or data.read_password == "":
        updates["read_password_hash"] = None
    elif data.read_password:
        updates["read_password_hash"] = bcrypt.hashpw(
            data.read_password.encode(), bcrypt.gensalt()
        ).decode()

    # Expiry update
    if data.expires_in is not None:
        if data.expires_in == "never":
            updates["expires_at"] = None
        elif data.expires_in == "custom" and data.custom_expires_at:
            updates["expires_at"] = data.custom_expires_at
        else:
            delta = _EXPIRY_DELTA.get(data.expires_in)
            updates["expires_at"] = (now + delta) if delta else None

    await db["documents"].update_one({"slug": slug}, {"$set": updates, "$inc": {"rev": 1}})
    raw.update(updates)
    raw["rev"] = raw.get("rev", 1) + 1
    return _doc_from_mongo(raw)


async def delete_document(
    db: AsyncIOMotorDatabase,
    slug: str,
    edit_secret: str | None = None,
    user_id: str | None = None,
) -> str | None:
    """Delete a document. Returns its R2 blob key when it was an artifact, so
    the caller can free the object too — otherwise the bytes would linger and
    keep counting against the owner's quota."""
    raw = await db["documents"].find_one(
        {"slug": slug}, {"_id": 0, "edit_secret_hash": 1, "owner_id": 1, "blob_key": 1, "bundle_prefix": 1}
    )
    if not raw:
        raise HTTPException(status_code=404, detail="Document not found")

    _authorize(raw, edit_secret, user_id)

    await db["documents"].delete_one({"slug": slug})
    # A bundle is many objects under one prefix — hand that back in preference
    # to the single entry key so the caller can clear all of them.
    return raw.get("bundle_prefix") or raw.get("blob_key")


async def claim_document(
    db: AsyncIOMotorDatabase, slug: str, edit_secret: str, user_id: str
) -> Document:
    """Attach an (anonymous) document to a user account, proven via edit secret."""
    raw = await db["documents"].find_one({"slug": slug}, {"_id": 0})
    if not raw:
        raise HTTPException(status_code=404, detail="Document not found")

    existing_owner = raw.get("owner_id")
    if existing_owner == user_id:
        return _doc_from_mongo(raw)  # idempotent
    if existing_owner:
        raise HTTPException(status_code=409, detail="This document is already owned by another account")

    if not verify_edit_secret(edit_secret, raw["edit_secret_hash"]):
        raise HTTPException(status_code=403, detail="Invalid edit secret")

    await db["documents"].update_one({"slug": slug}, {"$set": {"owner_id": user_id}})
    raw["owner_id"] = user_id
    return _doc_from_mongo(raw)


async def copy_document(
    db: AsyncIOMotorDatabase,
    slug: str,
    user_id: str,
    read_password: str | None = None,
) -> tuple[Document, str]:
    """Import a copy of a readable document into ``user_id``'s account.

    The copy is a brand-new document owned by the user: fresh slug, no read
    password, and no expiry (import = keep it). Only title + content carry over.
    Authorization to read the source reuses ``get_document`` (public docs, or a
    protected doc unlocked with ``read_password`` / owned by the caller).
    """
    source = await get_document(db, slug, read_password=read_password, user_id=user_id)

    data = DocumentCreate(
        title=source.title,
        content=source.content,
        custom_slug=None,
        expires_in="never",      # drop any expiry — an imported copy is kept
        read_password=None,      # drop any read password
    )
    # Prefer a slug derived from the title for a friendly URL; create_document
    # auto-suffixes on collision and falls back to a random slug.
    return await create_document(db, data, owner_id=user_id, preferred_slug=source.title or None)


async def change_slug(
    db: AsyncIOMotorDatabase,
    slug: str,
    new_slug: str,
    edit_secret: str | None = None,
    user_id: str | None = None,
) -> Document:
    """Rename a document's slug. Analytics stay intact (events key on doc _id)."""
    if not is_valid_slug(new_slug):
        raise HTTPException(
            status_code=422,
            detail="Slug must be 3-50 chars: letters, numbers, hyphens or underscores.",
        )
    if is_reserved_slug(new_slug):
        raise HTTPException(status_code=409, detail="This URL is reserved. Please choose another.")

    raw = await db["documents"].find_one({"slug": slug}, {"_id": 0})
    if not raw:
        raise HTTPException(status_code=404, detail="Document not found")

    _authorize(raw, edit_secret, user_id)

    if new_slug == slug:
        return _doc_from_mongo(raw)

    now = datetime.now(timezone.utc)
    try:
        await db["documents"].update_one(
            {"slug": slug}, {"$set": {"slug": new_slug, "updated_at": now}}
        )
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail="This URL is already taken. Please choose another.")

    raw["slug"] = new_slug
    raw["updated_at"] = now
    return _doc_from_mongo(raw)


async def list_user_documents(
    db: AsyncIOMotorDatabase,
    user_id: str,
    page: int,
    limit: int,
    q: str | None,
    kind: str | None = None,
) -> tuple[list[Document], int]:
    """Return (documents, total) owned by the user, newest first."""
    query: dict = {"owner_id": user_id}
    if kind == "markdown":
        # Documents created before artifacts existed have no `kind` field.
        query["kind"] = {"$ne": "artifact"}
    elif kind == "artifact":
        query["kind"] = "artifact"
    if q:
        query["$or"] = [
            {"slug": {"$regex": q, "$options": "i"}},
            {"title": {"$regex": q, "$options": "i"}},
        ]
    total = await db["documents"].count_documents(query)
    skip = (page - 1) * limit
    # Include _id so the owner can act on the document by its stable id
    # (e.g. the Google Docs export endpoint, which keys on _id like sync does).
    cursor = (
        db["documents"].find(query).sort("created_at", -1).skip(skip).limit(limit)
    )
    docs = [_doc_from_mongo(d) for d in await cursor.to_list(length=limit)]
    return docs, total


_EVENT_COUNTER = {
    "view": "views",
    "export_pdf": "export_pdf_count",
    "copy_url": "copy_url_count",
}


async def report_document(
    db: AsyncIOMotorDatabase, slug: str, reason: str | None, ip: str | None
) -> bool:
    """Flag a document for abuse. Increments report_count + logs a report."""
    import hashlib

    raw = await db["documents"].find_one_and_update(
        {"slug": slug}, {"$inc": {"report_count": 1}}, projection={"_id": 1}
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
    db: AsyncIOMotorDatabase, slug: str, event_type: str
) -> tuple[str, str | None] | None:
    """Bump the counter for an event type. Returns (doc_id, owner_id) or None."""
    field = _EVENT_COUNTER[event_type]
    raw = await db["documents"].find_one_and_update(
        {"slug": slug},
        {"$inc": {field: 1}},
        projection={"_id": 1, "owner_id": 1},
        return_document=True,
    )
    if not raw:
        return None
    return str(raw["_id"]), raw.get("owner_id")


async def get_owned_doc_id(
    db: AsyncIOMotorDatabase, slug: str, user_id: str
) -> str | None:
    """Return the document's id if owned by the user, else None (404/403 upstream)."""
    raw = await db["documents"].find_one(
        {"slug": slug}, {"_id": 1, "owner_id": 1}
    )
    if not raw:
        return None
    if raw.get("owner_id") != user_id:
        return None
    return str(raw["_id"])


# ── Sync (VS Code extension) — operate by immutable _id, owner-scoped ────────────


async def get_owned_document_by_id(
    db: AsyncIOMotorDatabase, doc_id: str, user_id: str
) -> Document | None:
    if not ObjectId.is_valid(doc_id):
        return None
    raw = await db["documents"].find_one({"_id": ObjectId(doc_id)})
    if not raw or raw.get("owner_id") != user_id:
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
    if not raw or raw.get("owner_id") != user_id:
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
