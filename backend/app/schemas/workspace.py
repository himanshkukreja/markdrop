from datetime import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field, field_validator

Role = Literal["owner", "admin", "member", "viewer"]


class BrandingPayload(BaseModel):
    """Every field optional — an unset workspace looks exactly like Markdrop."""

    site_name: str | None = Field(None, max_length=60)
    favicon_url: str | None = Field(None, max_length=500)
    logo_url: str | None = Field(None, max_length=500)
    accent_color: str | None = Field(None, pattern=r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
    hide_markdrop_branding: bool = False

    @field_validator("favicon_url", "logo_url")
    @classmethod
    def _http_urls_only(cls, v: str | None) -> str | None:
        """These end up in `<link rel="icon" href>` and in an <img> on the
        preview card. An unchecked string there is stored XSS via `javascript:`,
        and `data:` is just as good a vector, so allow neither: an absolute
        http(s) URL is the only thing either use actually needs."""
        if v is None:
            return None
        v = v.strip()
        if not v:
            return None
        if not v.startswith(("http://", "https://")):
            raise ValueError("Must be an absolute http:// or https:// URL")
        return v


class SettingsPayload(BaseModel):
    viewer_chrome: Literal["full", "minimal", "none"] = "full"
    require_auth_to_view: bool = False


class WorkspaceCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)


class WorkspaceUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=80)
    branding: BrandingPayload | None = None
    settings: SettingsPayload | None = None


class WorkspaceResponse(BaseModel):
    id: str
    name: str
    owner_id: str
    created_at: datetime
    updated_at: datetime
    branding: BrandingPayload
    settings: SettingsPayload
    # The caller's own role, so the UI can hide what they can't do without a
    # second request per workspace.
    role: Role


class WorkspaceListResponse(BaseModel):
    workspaces: list[WorkspaceResponse]


class MemberResponse(BaseModel):
    user_id: str
    role: Role
    email: str | None = None
    name: str | None = None
    created_at: datetime


class MemberListResponse(BaseModel):
    members: list[MemberResponse]


class MemberAddRequest(BaseModel):
    email: EmailStr
    role: Literal["admin", "member", "viewer"] = "member"


class MemberRoleRequest(BaseModel):
    role: Literal["admin", "member", "viewer"]
