from datetime import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field


class GrantResponse(BaseModel):
    email: str
    role: Literal["viewer", "editor"]
    created_at: datetime
    granted_by_email: str | None = None
    # Whether a notification actually left. The UI says "invited" or "added
    # quietly" from this rather than implying an email that never went.
    notified: bool = False


class GrantCreate(BaseModel):
    email: EmailStr
    role: Literal["viewer", "editor"] = "viewer"
    notify: bool = True
    message: str | None = Field(None, max_length=500)


class LevelUpdate(BaseModel):
    level: Literal["private", "link", "workspace"]


class ResharingUpdate(BaseModel):
    allow: bool


class BatchLevelUpdate(BaseModel):
    slugs: list[str] = Field(..., min_length=1, max_length=200)
    level: Literal["private", "link", "workspace"]


class AccessResponse(BaseModel):
    level: Literal["private", "link", "workspace"]
    allow_resharing: bool
    is_password_protected: bool
    # End-to-end encrypted documents can be *reached* by these rules, but the
    # key is in the link's fragment and has never reached the server — so the UI
    # must say that sharing the address is what actually unlocks it.
    encrypted: bool
    in_workspace: bool
    # Which workspace, so the share box can suggest its members rather than
    # making someone remember and retype addresses they already have.
    workspace_id: str | None = None
    workspace_name: str | None = None
    folder_id: str | None = None
    # access.can() for the caller: {edit_content, replace_file, edit_settings,
    # change_access, rename, delete, share, unshare, move}.
    can: dict | None = None
    your_role: Literal["owner", "editor", "viewer"]
    # Who owns it, so the share list can name a person rather than guessing from
    # whatever string the caller happened to pass as a title.
    owner_name: str | None = None
    owner_email: str | None = None
    # The viewer's own address, so a grantee can find their row to leave.
    your_email: str | None = None
    # Derived server-side so the client never re-implements the rules and gets
    # them subtly different.
    can_manage: bool
    can_share: bool
    grants: list[GrantResponse]


# ── Share-dialog suggestions ──────────────────────────────────────────────────


class ContactItem(BaseModel):
    """Someone the signed-in user may be offered as a share suggestion.

    Only ever drawn from people the user already has a relationship with — see
    `routers.me.list_contacts`. Never a global user search.
    """

    email: str
    name: str | None = None
    # Why they are suggested: "shared" = you granted them access to a document;
    # "workspace" = they are in a workspace you belong to. When both are true,
    # "shared" wins (it is the more recent, more specific relationship).
    source: Literal["shared", "workspace"]


class ContactListResponse(BaseModel):
    contacts: list[ContactItem]
