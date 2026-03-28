from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.document import Document
from app.schemas.document import DocumentCreate, DocumentUpdate
from app.utils.security import generate_edit_secret, verify_edit_secret
from app.utils.slug import generate_slug

settings = get_settings()


async def create_document(db: AsyncSession, data: DocumentCreate) -> tuple[Document, str]:
    """Create a document. Returns (document, raw_edit_secret)."""
    raw_secret, secret_hash = generate_edit_secret()

    for _ in range(settings.slug_max_retries):
        slug = generate_slug(settings.slug_length)
        doc = Document(
            slug=slug,
            content=data.content,
            edit_secret_hash=secret_hash,
        )
        db.add(doc)
        try:
            await db.commit()
            await db.refresh(doc)
            return doc, raw_secret
        except IntegrityError:
            await db.rollback()
            continue

    raise HTTPException(status_code=503, detail="Could not generate unique slug. Try again.")


async def get_document(db: AsyncSession, slug: str) -> Document:
    result = await db.execute(select(Document).where(Document.slug == slug))
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    return doc


async def update_document(
    db: AsyncSession, slug: str, data: DocumentUpdate, edit_secret: str
) -> Document:
    doc = await get_document(db, slug)

    if not verify_edit_secret(edit_secret, doc.edit_secret_hash):
        raise HTTPException(status_code=403, detail="Invalid edit secret")

    doc.content = data.content
    await db.commit()
    await db.refresh(doc)
    return doc


async def delete_document(db: AsyncSession, slug: str, edit_secret: str) -> None:
    doc = await get_document(db, slug)

    if not verify_edit_secret(edit_secret, doc.edit_secret_hash):
        raise HTTPException(status_code=403, detail="Invalid edit secret")

    await db.delete(doc)
    await db.commit()
