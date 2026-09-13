"""Workspace invitations — consent-based membership.

The rule this module exists to enforce: **nobody joins a workspace without
saying yes.** Being a member means your documents can be read and your name
appears to strangers, so it cannot be something an admin does to you.

Everything else here follows from that, plus one more: the invite link is a
bearer credential that travels through email, which is a forwardable, archived,
frequently-breached medium. So the link alone is never enough to join. It has to
be presented by someone signed in as the address it was sent to.

Token handling mirrors `services.email_auth`: a URL-safe random token goes out in
the mail and only its SHA-256 hash is stored, so a database leak yields nothing
usable.
"""

import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.models.invitation import Invitation, InviteRole
from app.models.user import User
from app.models.workspace import ROLE_RANK

INVITE_TTL_DAYS = 7

# A workspace with a hundred outstanding invitations is either a mistake or
# someone using us to mail strangers. Either way, stop.
MAX_PENDING_INVITES = 100
MAX_MEMBERS = 200

# How long a resolved invitation stays visible in the admin list before the TTL
# index sweeps it. Long enough to answer "did that ever get accepted?".
HISTORY_DAYS = 30


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _to_invitation(raw: dict) -> Invitation:
    return Invitation(
        id=str(raw["_id"]),
        workspace_id=raw["workspace_id"],
        email=raw["email"],
        role=raw["role"],
        status=raw["status"],
        created_at=raw["created_at"],
        expires_at=raw["expires_at"],
        invited_by_name=raw.get("invited_by_name"),
        invited_by_email=raw.get("invited_by_email"),
        responded_at=raw.get("responded_at"),
    )


# ── Reads ─────────────────────────────────────────────────────────────────────


async def list_invitations(db: AsyncIOMotorDatabase, workspace_id: str) -> list[Invitation]:
    rows = await db["invitations"].find({"workspace_id": workspace_id}).to_list(length=500)
    rows.sort(key=lambda r: r["created_at"], reverse=True)
    return [_to_invitation(r) for r in rows]


async def find_by_token(db: AsyncIOMotorDatabase, token: str) -> Invitation | None:
    raw = await db["invitations"].find_one({"token_hash": _hash(token)})
    return _to_invitation(raw) if raw else None


# ── Create ────────────────────────────────────────────────────────────────────


async def create_invitation(
    db: AsyncIOMotorDatabase,
    workspace_id: str,
    email: str,
    role: InviteRole,
    inviter: User,
) -> tuple[Invitation, str]:
    """Create (or refresh) an invitation. Returns the record and the raw token.

    The raw token is returned rather than stored: this is the only moment it
    exists in plaintext, and the caller's one job with it is to put it in an
    email.
    """
    if role == "owner":  # defence in depth; the schema already refuses it
        raise HTTPException(status_code=422, detail="Transfer ownership instead.")

    email = email.strip().lower()

    # Already in? Say so plainly instead of mailing them a link that would no-op.
    existing_member = await db["memberships"].find_one(
        {"workspace_id": workspace_id, "email": email}, {"_id": 1}
    )
    if existing_member:
        raise HTTPException(
            status_code=409, detail="That person is already in this workspace."
        )

    members = await db["memberships"].count_documents({"workspace_id": workspace_id})
    if members >= MAX_MEMBERS:
        raise HTTPException(
            status_code=429, detail=f"A workspace can have at most {MAX_MEMBERS} members."
        )

    pending = await db["invitations"].count_documents(
        {"workspace_id": workspace_id, "status": "pending"}
    )
    if pending >= MAX_PENDING_INVITES:
        raise HTTPException(
            status_code=429,
            detail=f"There are already {MAX_PENDING_INVITES} invitations waiting. "
            "Revoke some before sending more.",
        )

    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(days=INVITE_TTL_DAYS)
    doc = {
        "workspace_id": workspace_id,
        "email": email,
        "role": role,
        "status": "pending",
        "token_hash": _hash(token),
        "invited_by_user_id": inviter.id,
        "invited_by_name": inviter.name,
        "invited_by_email": inviter.email,
        "created_at": now,
        "expires_at": expires_at,
        "responded_at": None,
        # Swept by a TTL index. Resolved invites are history, not state.
        "purge_at": expires_at + timedelta(days=HISTORY_DAYS),
    }

    # Re-inviting the same address replaces the outstanding invitation rather
    # than stacking a second one. This is also the "resend" path: a lapsed invite
    # is still `status: pending`, so asking again simply mints a fresh token and
    # pushes the expiry out. Any older token stops working the moment its hash is
    # overwritten, which is what you want if the first mail went astray.
    result = await db["invitations"].find_one_and_update(
        {"workspace_id": workspace_id, "email": email, "status": "pending"},
        {"$set": doc},
        upsert=True,
        return_document=True,
    )
    return _to_invitation(result), token


async def revoke_invitation(db: AsyncIOMotorDatabase, workspace_id: str, invite_id: str) -> None:
    try:
        oid = ObjectId(invite_id)
    except Exception:
        raise HTTPException(status_code=404, detail="Invitation not found")
    # Scoped by workspace_id in the query itself, so an admin of workspace A can
    # never act on an invitation belonging to workspace B by guessing its id.
    result = await db["invitations"].update_one(
        {"_id": oid, "workspace_id": workspace_id, "status": "pending"},
        {"$set": {"status": "revoked", "responded_at": datetime.now(timezone.utc)}},
    )
    if result.matched_count == 0:
        raise HTTPException(
            status_code=404, detail="That invitation is no longer waiting for a reply."
        )


# ── Respond ───────────────────────────────────────────────────────────────────


def _guard_open(invite: Invitation) -> None:
    """Refuse anything that isn't a live, unexpired invitation."""
    state = invite.effective_status
    if state == "expired":
        raise HTTPException(
            status_code=410,
            detail="This invitation has expired. Ask for a new one.",
        )
    if state == "accepted":
        raise HTTPException(status_code=409, detail="This invitation was already accepted.")
    if state == "declined":
        raise HTTPException(status_code=409, detail="This invitation was already declined.")
    if state == "revoked":
        raise HTTPException(status_code=410, detail="This invitation was withdrawn.")


async def accept_invitation(
    db: AsyncIOMotorDatabase, token: str, user: User
) -> tuple[str, str]:
    """Join the workspace. Returns (workspace_id, role).

    Requires a signed-in user whose address matches the invitation. The token on
    its own is not sufficient, and deliberately so: mail gets forwarded, shared
    inboxes have many readers, and archives get breached. Binding to the address
    means a leaked link is useless to anyone who cannot also authenticate as its
    recipient.
    """
    invite = await find_by_token(db, token)
    if invite is None:
        raise HTTPException(status_code=404, detail="This invitation link isn't valid.")
    _guard_open(invite)

    if (user.email or "").strip().lower() != invite.email:
        # 403 with both addresses named. Telling them which account to use is the
        # difference between a fixable problem and a dead end -- and it discloses
        # nothing, since whoever holds the token was already sent that address.
        raise HTTPException(
            status_code=403,
            detail=f"This invitation was sent to {invite.email}. "
            f"You're signed in as {user.email}.",
        )

    workspace = await db["workspaces"].find_one({"_id": ObjectId(invite.workspace_id)})
    if workspace is None:
        raise HTTPException(status_code=404, detail="That workspace no longer exists.")

    now = datetime.now(timezone.utc)

    # Consume the invitation first, conditioned on it still being pending. Two
    # simultaneous clicks both reach here; only the one that wins this atomic
    # update proceeds to touch membership.
    claimed = await db["invitations"].update_one(
        {"_id": ObjectId(invite.id), "status": "pending"},
        {"$set": {"status": "accepted", "responded_at": now, "accepted_user_id": user.id},
         "$unset": {"token_hash": ""}},
    )
    if claimed.matched_count == 0:
        raise HTTPException(status_code=409, detail="This invitation was already used.")

    existing = await db["memberships"].find_one(
        {"workspace_id": invite.workspace_id, "user_id": user.id}, {"role": 1}
    )
    if existing:
        # Already a member under a different address, or added between send and
        # accept. Never write the invited role over what they have: an invitation
        # to "viewer" must not be a way to demote the workspace owner.
        if ROLE_RANK.get(existing["role"], -1) >= ROLE_RANK[invite.role]:
            return invite.workspace_id, existing["role"]

    await db["memberships"].update_one(
        {"workspace_id": invite.workspace_id, "user_id": user.id},
        {"$set": {
            "workspace_id": invite.workspace_id,
            "user_id": user.id,
            "role": invite.role,
            "created_at": now,
            "email": user.email,
            "name": user.name,
        }},
        upsert=True,
    )
    return invite.workspace_id, invite.role


async def decline_invitation(db: AsyncIOMotorDatabase, token: str) -> None:
    """Decline. Deliberately does not require a session.

    The person saying no may well not have an account, and making them create one
    in order to refuse would be absurd. Holding the token is proof enough for a
    decision that only ever removes access.
    """
    invite = await find_by_token(db, token)
    if invite is None:
        raise HTTPException(status_code=404, detail="This invitation link isn't valid.")
    _guard_open(invite)
    # The hash is left in place. Declining and revoking both leave a link that
    # someone may well click again -- from the same email -- and "this link isn't
    # valid" is a worse answer than "you already declined this". Only acceptance
    # clears the hash, because that is the one transition where the token was
    # actually spent as a credential. Nothing further can be done with a resolved
    # invitation either way: `_guard_open` refuses every non-pending state.
    await db["invitations"].update_one(
        {"_id": ObjectId(invite.id), "status": "pending"},
        {"$set": {"status": "declined", "responded_at": datetime.now(timezone.utc)}},
    )
