from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError

from app.config import get_settings
from app.models.document import Document
from app.schemas.document import DocumentCreate, DocumentUpdate
from app.utils.security import generate_edit_secret, verify_edit_secret
from app.utils.slug import generate_slug

settings = get_settings()

_EXPIRY_DELTA: dict[str, timedelta | None] = {
    "never": None,
    "1d": timedelta(days=1),
    "7d": timedelta(days=7),
    "30d": timedelta(days=30),
}


def _doc_from_mongo(raw: dict) -> Document:
    return Document(
        slug=raw["slug"],
        title=raw.get("title"),
        content=raw["content"],
        edit_secret_hash=raw["edit_secret_hash"],
        created_at=raw["created_at"],
        updated_at=raw["updated_at"],
        expires_at=raw.get("expires_at"),
        views=raw.get("views", 0),
    )


async def create_document(db: AsyncIOMotorDatabase, data: DocumentCreate) -> tuple[Document, str]:
    raw_secret, secret_hash = generate_edit_secret()
    now = datetime.now(timezone.utc)

    if data.expires_in == "custom":
        expires_at = data.custom_expires_at
    else:
        delta = _EXPIRY_DELTA.get(data.expires_in)
        expires_at = (now + delta) if delta else None

    # Custom slug path
    if data.custom_slug:
        slug = data.custom_slug
        doc_dict = {
            "slug": slug,
            "title": data.title or None,
            "content": data.content,
            "edit_secret_hash": secret_hash,
            "created_at": now,
            "updated_at": now,
            "expires_at": expires_at,
            "views": 0,
        }
        try:
            await db["documents"].insert_one(doc_dict)
            return _doc_from_mongo(doc_dict), raw_secret
        except DuplicateKeyError:
            raise HTTPException(status_code=409, detail="This URL is already taken. Please choose another.")

    # Random slug path with retry
    for _ in range(settings.slug_max_retries):
        slug = generate_slug(settings.slug_length)
        doc_dict = {
            "slug": slug,
            "title": data.title or None,
            "content": data.content,
            "edit_secret_hash": secret_hash,
            "created_at": now,
            "updated_at": now,
            "expires_at": expires_at,
            "views": 0,
        }
        try:
            await db["documents"].insert_one(doc_dict)
            return _doc_from_mongo(doc_dict), raw_secret
        except DuplicateKeyError:
            continue

    raise HTTPException(status_code=503, detail="Could not generate unique slug. Try again.")


async def get_document(db: AsyncIOMotorDatabase, slug: str) -> Document:
    raw = await db["documents"].find_one_and_update(
        {"slug": slug},
        {"$inc": {"views": 1}},
        projection={"_id": 0},
        return_document=True,
    )
    if not raw:
        raise HTTPException(status_code=404, detail="Document not found")
    return _doc_from_mongo(raw)


async def update_document(
    db: AsyncIOMotorDatabase, slug: str, data: DocumentUpdate, edit_secret: str
) -> Document:
    raw = await db["documents"].find_one({"slug": slug}, {"_id": 0})
    if not raw:
        raise HTTPException(status_code=404, detail="Document not found")

    if not verify_edit_secret(edit_secret, raw["edit_secret_hash"]):
        raise HTTPException(status_code=403, detail="Invalid edit secret")

    now = datetime.now(timezone.utc)
    await db["documents"].update_one(
        {"slug": slug},
        {"$set": {"title": data.title or None, "content": data.content, "updated_at": now}},
    )
    raw.update({"title": data.title or None, "content": data.content, "updated_at": now})
    return _doc_from_mongo(raw)


async def delete_document(db: AsyncIOMotorDatabase, slug: str, edit_secret: str) -> None:
    raw = await db["documents"].find_one({"slug": slug}, {"_id": 0, "edit_secret_hash": 1})
    if not raw:
        raise HTTPException(status_code=404, detail="Document not found")

    if not verify_edit_secret(edit_secret, raw["edit_secret_hash"]):
        raise HTTPException(status_code=403, detail="Invalid edit secret")

    await db["documents"].delete_one({"slug": slug})


