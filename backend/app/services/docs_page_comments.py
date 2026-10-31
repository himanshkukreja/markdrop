"""Review comments on a Markdrop Guides page, anchored to the text they're about.

A comment quotes the text it's about (``quote``) with a little context either side
(``prefix`` / ``suffix``), so the editor can find it again after edits around it;
if the quote is gone, the editor shows the comment as detached rather than losing
it. ``rev`` is the draft rev the comment was written against (a comment is stored
per page version: the editor can tell "written on an older version").

Editors, reviewers and admins read and write them; viewers don't see them (they
are working notes, not part of the guide). A comment has a flat list of replies
and can be resolved and reopened by anyone who can see it; it can be deleted by
its author or a Guides admin. There are no notifications: the editor shows open
counts per page (``summary``).
"""

from __future__ import annotations

import secrets

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import ReturnDocument

from app.models.user import User
from app.services import docs_site_store as store
from app.services.docs_site_store import PAGES, aware, now

COMMENTS = "docs_page_comments"
MAX_COMMENTS_PER_PAGE = 300
MAX_REPLIES = 100


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[COMMENTS].create_index([("site_id", 1), ("page_id", 1), ("at", 1)])
    await db[COMMENTS].create_index([("site_id", 1), ("resolved", 1)])


def _text(value: str | None, what: str) -> str:
    out = (value or "").replace("\x00", "").strip()
    if not out:
        raise HTTPException(status_code=422, detail=f"Write {what} first.")
    return out


def view(c: dict, names: dict[str, str], user: User, role: str) -> dict:
    return {
        "id": str(c["_id"]),
        "page_id": str(c["page_id"]),
        "rev": c.get("rev"),
        "quote": c.get("quote") or "",
        "prefix": c.get("prefix") or "",
        "suffix": c.get("suffix") or "",
        "body": c.get("body") or "",
        "by": c.get("by"),
        "by_name": names.get(c.get("by") or ""),
        "at": aware(c.get("at")),
        "replies": [{"id": r.get("id"), "body": r.get("body") or "", "by": r.get("by"),
                     "by_name": names.get(r.get("by") or ""), "at": aware(r.get("at"))}
                    for r in c.get("replies") or []],
        "resolved": bool(c.get("resolved")),
        "resolved_by": c.get("resolved_by"),
        "resolved_by_name": names.get(c.get("resolved_by") or "") if c.get("resolved_by") else None,
        "resolved_at": aware(c.get("resolved_at")),
        "can_delete": c.get("by") == user.id or store.is_admin(role),
    }


def _people(rows: list[dict]) -> list[str]:
    ids = []
    for c in rows:
        ids += [c.get("by"), c.get("resolved_by")] + [r.get("by") for r in c.get("replies") or []]
    return ids


async def _one_view(db: AsyncIOMotorDatabase, c: dict, user: User, role: str) -> dict:
    return view(c, await store.user_names(db, _people([c])), user, role)


async def list_comments(db: AsyncIOMotorDatabase, site: dict, page: dict, user: User, role: str) -> dict:
    rows = await db[COMMENTS].find({"site_id": site["_id"], "page_id": page["_id"]}).sort("at", 1).to_list(
        length=MAX_COMMENTS_PER_PAGE + 50)
    names = await store.user_names(db, _people(rows))
    return {"comments": [view(c, names, user, role) for c in rows],
            "open": sum(1 for c in rows if not c.get("resolved"))}


async def add(db: AsyncIOMotorDatabase, site: dict, page: dict, user: User, role: str, *, quote: str,
              prefix: str | None, suffix: str | None, body: str) -> dict:
    quote = (quote or "").replace("\x00", "")
    if not quote.strip():
        raise HTTPException(status_code=422, detail="Select the text the comment is about.")
    body = _text(body, "a comment")
    if await db[COMMENTS].count_documents({"site_id": site["_id"], "page_id": page["_id"]}) >= MAX_COMMENTS_PER_PAGE:
        raise HTTPException(status_code=409, detail=f"A page can have at most {MAX_COMMENTS_PER_PAGE} comments. "
                                                    "Delete some resolved ones first.")
    row = {
        "site_id": site["_id"],
        "page_id": page["_id"],
        "rev": (page.get("draft") or {}).get("rev"),
        "quote": quote,
        "prefix": (prefix or "").replace("\x00", ""),
        "suffix": (suffix or "").replace("\x00", ""),
        "body": body,
        "by": user.id,
        "at": now(),
        "replies": [],
        "resolved": False,
        "resolved_by": None,
        "resolved_at": None,
    }
    row["_id"] = (await db[COMMENTS].insert_one(row)).inserted_id
    return await _one_view(db, row, user, role)


async def _load(db: AsyncIOMotorDatabase, site: dict, page: dict, comment_id: str) -> dict:
    c = await db[COMMENTS].find_one({"_id": store.oid(comment_id, "Comment"), "site_id": site["_id"],
                                     "page_id": page["_id"]})
    if c is None:
        raise HTTPException(status_code=404, detail="Comment not found")
    return c


async def reply(db: AsyncIOMotorDatabase, site: dict, page: dict, user: User, role: str, comment_id: str,
                body: str) -> dict:
    c = await _load(db, site, page, comment_id)
    entry = {"id": secrets.token_hex(8), "body": _text(body, "a reply"), "by": user.id, "at": now()}
    # The cap in the same step as the push: two replies at once can't pass it together.
    updated = await db[COMMENTS].find_one_and_update(
        {"_id": c["_id"], f"replies.{MAX_REPLIES - 1}": {"$exists": False}},
        {"$push": {"replies": entry}}, return_document=ReturnDocument.AFTER)
    if updated is None:
        if await db[COMMENTS].count_documents({"_id": c["_id"]}) == 0:
            raise HTTPException(status_code=404, detail="Comment not found")
        raise HTTPException(status_code=409, detail=f"A comment can have at most {MAX_REPLIES} replies. "
                                                    "Start a new comment instead.")
    return await _one_view(db, updated, user, role)


async def resolve(db: AsyncIOMotorDatabase, site: dict, page: dict, user: User, role: str, comment_id: str,
                  resolved: bool) -> dict:
    c = await _load(db, site, page, comment_id)
    sets = ({"resolved": True, "resolved_by": user.id, "resolved_at": now()} if resolved
            else {"resolved": False, "resolved_by": None, "resolved_at": None})
    if bool(c.get("resolved")) == resolved:
        return await _one_view(db, c, user, role)  # already so: keep who resolved it and when
    updated = await db[COMMENTS].find_one_and_update({"_id": c["_id"]}, {"$set": sets},
                                                     return_document=ReturnDocument.AFTER)
    if updated is None:
        raise HTTPException(status_code=404, detail="Comment not found")
    return await _one_view(db, updated, user, role)


async def delete(db: AsyncIOMotorDatabase, site: dict, page: dict, user: User, role: str, comment_id: str) -> None:
    c = await _load(db, site, page, comment_id)
    if c.get("by") != user.id and not store.is_admin(role):
        raise HTTPException(status_code=403, detail="Only the person who wrote a comment, or a Guides admin, "
                                                    "can delete it.")
    await db[COMMENTS].delete_one({"_id": c["_id"]})


async def summary(db: AsyncIOMotorDatabase, site: dict) -> dict:
    """{pages: {page_id: open comments}} for the guide's pages that have any (deleted pages left out)."""
    counts: dict[ObjectId, int] = {}
    async for row in db[COMMENTS].aggregate([
        {"$match": {"site_id": site["_id"], "resolved": False}},
        {"$group": {"_id": "$page_id", "n": {"$sum": 1}}},
    ]):
        counts[row["_id"]] = row["n"]
    if not counts:
        return {"pages": {}}
    alive = await db[PAGES].find({"_id": {"$in": list(counts)}, "site_id": site["_id"], "deleted_at": None},
                                 {"_id": 1}).to_list(length=len(counts))
    return {"pages": {str(p["_id"]): counts[p["_id"]] for p in alive}}
