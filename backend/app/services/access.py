"""Who may read and who may change a document.

There is one rule this module exists to make unavoidable: **a document's
reachability only ever narrows by level, and only ever widens by a named
grant.** Everything else is detail.

    private    owner (and named people)
    link       anyone holding the URL — the historical default, and still it
    workspace  members of the workspace it is shared into

A grant is layered *on top* of the level rather than replacing it, which is why
"anyone with the link can read, and these three can edit" is expressible without
a fourth level. It is also why revoking a grant can never accidentally open a
document up: removing something additive cannot widen anything.

Grants key on **email**, not user id. The person being shared with frequently has
no account yet, so access begins the moment they are signed in as that address —
whether the account already existed or they made one afterwards. There is no
accept step because proving the address is the acceptance.

Encryption is the one place this cannot help. With an end-to-end encrypted
document the key lives in the URL fragment and has never reached this server, so
granting somebody access grants them ciphertext. The API still enforces the
level (it is the owner's wish, and it still stops a stranger fetching the
envelope), but the UI has to say plainly that the link is what actually unlocks
it.
"""

from datetime import datetime, timezone

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.models.access import Grant, GrantRole, role_allows

MAX_GRANTS_PER_DOCUMENT = 200


def _to_grant(raw: dict) -> Grant:
    return Grant(
        id=str(raw["_id"]),
        document_id=raw["document_id"],
        email=raw["email"],
        role=raw["role"],
        created_at=raw["created_at"],
        granted_by_email=raw.get("granted_by_email"),
        user_id=raw.get("user_id"),
        notified=bool(raw.get("notified")),
    )


def _clean_email(email: str) -> str:
    return (email or "").strip().lower()


# ── Reads ─────────────────────────────────────────────────────────────────────


async def list_grants(db: AsyncIOMotorDatabase, document_id: str) -> list[Grant]:
    rows = await db["document_grants"].find({"document_id": document_id}).to_list(
        length=MAX_GRANTS_PER_DOCUMENT
    )
    rows.sort(key=lambda r: r["created_at"])
    return [_to_grant(r) for r in rows]


async def grant_for(
    db: AsyncIOMotorDatabase, document_id: str, email: str | None
) -> Grant | None:
    """This person's named grant on this document, if any."""
    email = _clean_email(email or "")
    if not email:
        return None
    raw = await db["document_grants"].find_one({"document_id": document_id, "email": email})
    return _to_grant(raw) if raw else None


async def effective_role(
    db: AsyncIOMotorDatabase,
    raw_doc: dict,
    user_id: str | None,
    user_email: str | None,
) -> str | None:
    """What this viewer may do: "owner", "editor", "viewer", or None.

    Ordered most-privileged first so the strongest claim wins. A workspace member
    and a named viewer on the same document get the better of the two, never the
    worse — otherwise being *added* to a document could take access away.
    """
    document_id = str(raw_doc["_id"]) if raw_doc.get("_id") is not None else None

    if user_id and raw_doc.get("owner_id") == user_id:
        return "owner"

    # Workspace membership, if the document was shared into one.
    workspace_id = raw_doc.get("workspace_id")
    if workspace_id and user_id:
        from app.services import workspace as ws_service

        ws_role = await ws_service.role_for(db, workspace_id, user_id)
        if ws_role is not None:
            # Viewers of a workspace read; everyone above them also edits. This
            # mirrors `_authorize_write` in services.document, which is the
            # other half of the same rule.
            return "editor" if ws_role != "viewer" else "viewer"

    if document_id:
        grant = await grant_for(db, document_id, user_email)
        if grant is not None:
            return grant.role

    return None


async def can_read(
    db: AsyncIOMotorDatabase,
    raw_doc: dict,
    user_id: str | None,
    user_email: str | None,
) -> bool:
    """Whether this viewer may see the document at all.

    `link` is checked first and without touching the database: it is the default
    for every document that has ever existed here, and the overwhelming majority
    of reads must not pay for a permission lookup they cannot fail.
    """
    level = raw_doc.get("access_level") or "link"
    if level == "link":
        return True
    return await effective_role(db, raw_doc, user_id, user_email) is not None


# ── Writes ────────────────────────────────────────────────────────────────────


async def set_level(
    db: AsyncIOMotorDatabase, raw_doc: dict, level: str, user_id: str | None
) -> None:
    """Change how the document is reachable. Owner only.

    Not delegated, ever. Someone the owner shared a document with may bring in
    another named person -- that is a bounded act the owner can see and undo --
    but turning a private document into a public one is a different kind of
    decision and stays with the person whose document it is.
    """
    if level not in ("private", "link", "workspace"):
        raise HTTPException(status_code=422, detail="Unknown access level.")
    if not user_id or raw_doc.get("owner_id") != user_id:
        raise HTTPException(
            status_code=403, detail="Only the document's owner can change who it's visible to."
        )
    if level == "workspace" and not raw_doc.get("workspace_id"):
        raise HTTPException(
            status_code=422,
            detail="Share this document with a workspace first, then it can be workspace-only.",
        )
    await db["documents"].update_one(
        {"_id": raw_doc["_id"]},
        {"$set": {"access_level": level, "updated_at": datetime.now(timezone.utc)}},
    )


async def add_grant(
    db: AsyncIOMotorDatabase,
    raw_doc: dict,
    email: str,
    role: GrantRole,
    actor_id: str | None,
    actor_email: str | None,
) -> Grant:
    """Give a named person access.

    Delegation is deliberately bounded. Anyone with a grant may bring somebody
    else in, because that is how a document actually circulates in a team and
    forcing every addition through the owner just means people forward the link
    instead. But they may not grant *above* their own level: a viewer can add
    viewers, not editors. Without that, one viewer is enough to mint an editor,
    and the owner's decision about who can change the text stops meaning
    anything.

    The owner can switch delegation off entirely per document.
    """
    document_id = str(raw_doc["_id"])
    email = _clean_email(email)
    if not email:
        raise HTTPException(status_code=422, detail="Enter an email address.")

    actor_role = await effective_role(db, raw_doc, actor_id, actor_email)
    if actor_role is None:
        raise HTTPException(status_code=404, detail="Document not found")

    if actor_role != "owner":
        if not raw_doc.get("allow_resharing", True):
            raise HTTPException(
                status_code=403,
                detail="Only the owner can share this document.",
            )
        if not role_allows(actor_role, role):
            raise HTTPException(
                status_code=403,
                detail="You can't give someone more access than you have.",
            )

    if _clean_email(raw_doc.get("owner_email") or "") == email:
        raise HTTPException(status_code=409, detail="That's the owner of this document.")

    count = await db["document_grants"].count_documents({"document_id": document_id})
    if count >= MAX_GRANTS_PER_DOCUMENT:
        raise HTTPException(
            status_code=429,
            detail=f"A document can be shared with at most {MAX_GRANTS_PER_DOCUMENT} people.",
        )

    now = datetime.now(timezone.utc)
    doc = {
        "document_id": document_id,
        "email": email,
        "role": role,
        "granted_by_email": actor_email,
        "created_at": now,
        "notified": False,
    }
    # Re-sharing with someone who already has access changes their role rather
    # than stacking a second row or failing on the unique index.
    result = await db["document_grants"].find_one_and_update(
        {"document_id": document_id, "email": email},
        {"$set": doc},
        upsert=True,
        return_document=True,
    )
    return _to_grant(result)


async def mark_notified(db: AsyncIOMotorDatabase, grant_id: str) -> None:
    await db["document_grants"].update_one(
        {"_id": ObjectId(grant_id)}, {"$set": {"notified": True}}
    )


async def remove_grant(
    db: AsyncIOMotorDatabase,
    raw_doc: dict,
    email: str,
    actor_id: str | None,
    actor_email: str | None,
) -> None:
    """Take someone's access away.

    The owner can remove anybody. Anyone else can remove only themselves --
    leaving a document you were shared on is always allowed, and revoking other
    people is the owner's call. Letting a delegate revoke would mean the person
    you invited could lock you out of your own circulation.
    """
    document_id = str(raw_doc["_id"])
    email = _clean_email(email)
    is_owner = bool(actor_id) and raw_doc.get("owner_id") == actor_id

    if not is_owner and email != _clean_email(actor_email or ""):
        raise HTTPException(
            status_code=403, detail="Only the owner can remove someone else's access."
        )

    await db["document_grants"].delete_one({"document_id": document_id, "email": email})


async def set_resharing(
    db: AsyncIOMotorDatabase, raw_doc: dict, allow: bool, user_id: str | None
) -> None:
    """Owner-only switch: may the people I shared with share it onward?"""
    if not user_id or raw_doc.get("owner_id") != user_id:
        raise HTTPException(
            status_code=403, detail="Only the document's owner can change this."
        )
    await db["documents"].update_one(
        {"_id": raw_doc["_id"]}, {"$set": {"allow_resharing": bool(allow)}}
    )


async def attach_user(db: AsyncIOMotorDatabase, document_id: str, email: str, user_id: str) -> None:
    """Record which account a grant turned out to belong to.

    Cosmetic only -- access is by address either way -- but it lets a share list
    show a person's name once they have signed in at least once.
    """
    await db["document_grants"].update_one(
        {"document_id": document_id, "email": _clean_email(email), "user_id": None},
        {"$set": {"user_id": user_id}},
    )
