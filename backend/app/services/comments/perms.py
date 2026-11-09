"""Who may see, write, resolve and manage comments on an item (CONTRACT §3).

Everything rides on the access layer (services/access.py): reading the item is ``access.can(actor, raw,
"read", ctx)`` (a password sent with the request counts), editing is ``can(edit_content)``, the per-item
switches are the owner's (``set_resharing``, as "Show who's viewing"), moderation is the owner or a workspace
admin. Comments themselves add three rules: only signed-in people write; anonymous readers see nothing unless
the owner turned on "Show comments publicly"; encrypted, file, owner-less, template and trashed items have no
comments at all.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from fastapi import HTTPException

from app.services import access


@dataclass
class CommentPerms:
    eligible: bool = False
    enabled: bool = False
    view: bool = False
    comment: bool = False
    resolve_any: bool = False
    accept: bool = False
    assign: bool = False
    settings: bool = False
    moderate: bool = False
    reason: str | None = None
    # Not part of the wire shape: what the decision read.
    public: bool = False
    workspace_enabled: bool = True
    role: str | None = None

    def as_dict(self) -> dict:
        d = asdict(self)
        for k in ("public", "workspace_enabled", "role"):
            d.pop(k, None)
        return d


def eligible(raw: dict | None) -> bool:
    """Can this item have comments at all."""
    if not raw:
        return False
    if raw.get("encrypted") or raw.get("kind") == "artifact":
        return False
    if not raw.get("owner_id"):
        return False
    if raw.get("template") is True or raw.get("deleted_at") is not None:
        return False
    return True


def ineligible_reason(raw: dict | None) -> str:
    if not raw:
        return "not_supported"
    if raw.get("encrypted"):
        return "encrypted"
    if raw.get("kind") == "artifact":
        return "not_supported"
    if not raw.get("owner_id"):
        return "ownerless"
    return "not_supported"


async def perms_for(db, actor: access.Actor, raw: dict | None, ctx: access.Ctx) -> CommentPerms:
    p = CommentPerms()
    if not eligible(raw):
        p.reason = ineligible_reason(raw)
        return p
    p.eligible = True
    p.public = raw.get("comments_public") is True
    read = await access.can(actor, raw, "read", ctx)
    if not read.allowed:
        p.reason = "no_access"
        return p
    f = await access.facts(actor, raw, ctx)
    p.role = f.doc_role
    ws_on = True
    if f.ws is not None:
        ws_on = getattr(f.ws.settings, "comments_enabled", True) is not False
    p.workspace_enabled = ws_on
    uid = actor.user_id
    p.settings = bool(uid) and (await access.can(actor, raw, "set_resharing", ctx)).allowed
    if raw.get("comments_off") is True or not ws_on:
        p.reason = "off" if raw.get("comments_off") is True else "workspace_off"
        return p
    p.enabled = True
    if not uid:
        p.view = p.public
        p.reason = "signin"
        return p
    p.view = True
    p.comment = True
    edit = (await access.can(actor, raw, "edit_content", ctx)).allowed
    p.resolve_any = edit
    p.accept = edit
    p.assign = edit
    from app.models.workspace import role_allows

    p.moderate = bool(f.is_owner or role_allows(f.ws_role, "admin"))
    return p


async def can_view_comments(db, actor, raw, ctx) -> bool:
    return (await perms_for(db, actor, raw, ctx)).view


async def can_comment(db, actor, raw, ctx) -> bool:
    return (await perms_for(db, actor, raw, ctx)).comment


async def can_resolve(db, actor, raw, ctx, thread: dict) -> bool:
    p = await perms_for(db, actor, raw, ctx)
    return p.comment and (p.resolve_any or (bool(actor.user_id) and actor.user_id in (thread.get("created_by"), thread.get("assignee"))))


async def can_accept(db, actor, raw, ctx) -> bool:
    return (await perms_for(db, actor, raw, ctx)).accept


def _err(status: int, detail: str, code: str) -> HTTPException:
    """``{"detail": …, "code": …}`` (services/pages.PageError's handler answers with the body)."""
    from app.services.pages import PageError

    return PageError(status, {"detail": detail, "code": code})


def unavailable() -> HTTPException:
    return _err(404, "Comments aren't available on this item.", "comments_unavailable")


async def require(db, actor, raw, ctx, what: str, thread: dict | None = None) -> CommentPerms:
    """``what``: view | comment | resolve | accept | assign | settings | moderate. Raises the right HTTPException."""
    if raw is None:
        raise HTTPException(status_code=404, detail="Document not found")
    if not eligible(raw):
        # The item's own read rule answers first: no existence oracle through comments.
        await access.require(actor, raw, "read", ctx)
        raise unavailable()
    await access.require(actor, raw, "read", ctx)
    p = await perms_for(db, actor, raw, ctx)
    if what == "settings":
        if not p.settings:
            raise _err(403, "Only the owner can change comment settings.", "forbidden")
        return p
    if not p.enabled:
        raise _err(403, "Comments are turned off here.", "comments_off")
    if what == "view":
        if not p.view:
            raise _err(401, "Sign in to see comments.", "signin")
        return p
    if not actor.user_id:
        raise _err(401, "Sign in to comment.", "signin")
    if actor.cred == "mcp" and access.MCP_WRITE not in actor.scopes:
        raise _err(403, "insufficient_scope", "scope")
    if what == "comment":
        return p
    if what == "resolve":
        # The person who started it, its assignee (resolving completes the task) and editors.
        if p.resolve_any or (thread is not None and actor.user_id in (thread.get("created_by"), thread.get("assignee"))):
            return p
        raise _err(403, "Only the person who started this thread or an editor can resolve it.", "forbidden")
    if what == "accept":
        if p.accept:
            return p
        raise _err(403, "Only editors can accept suggested edits.", "forbidden")
    if what == "assign":
        if p.assign or (thread is not None and thread.get("created_by") == actor.user_id):
            return p
        raise _err(403, "Only editors and the thread's author can assign it.", "forbidden")
    if what == "moderate":
        if p.moderate:
            return p
        raise _err(403, "Only the owner or a workspace admin can do that.", "forbidden")
    raise ValueError(what)
