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


class AccessResponse(BaseModel):
    level: Literal["private", "link", "workspace"]
    allow_resharing: bool
    is_password_protected: bool
    # End-to-end encrypted documents can be *reached* by these rules, but the
    # key is in the link's fragment and has never reached the server — so the UI
    # must say that sharing the address is what actually unlocks it.
    encrypted: bool
    in_workspace: bool
    your_role: Literal["owner", "editor", "viewer"]
    # Derived server-side so the client never re-implements the rules and gets
    # them subtly different.
    can_manage: bool
    can_share: bool
    grants: list[GrantResponse]
