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


class MemberRoleRequest(BaseModel):
    role: Literal["admin", "member", "viewer"]


# ── Invitations ───────────────────────────────────────────────────────────────


class InviteCreateRequest(BaseModel):
    email: EmailStr
    role: Literal["admin", "member", "viewer"] = "member"


class InviteResponse(BaseModel):
    """The admin-facing view of an invitation. Deliberately has no token field:
    the raw token exists for exactly as long as it takes to compose the email,
    and putting it in an API response would turn any workspace admin into a
    credential oracle for an address they do not control."""

    id: str
    email: str
    role: Role
    status: Literal["pending", "accepted", "declined", "revoked", "expired"]
    created_at: datetime
    expires_at: datetime
    invited_by_name: str | None = None
    responded_at: datetime | None = None


class InviteListResponse(BaseModel):
    invitations: list[InviteResponse]


class InvitePreview(BaseModel):
    """What the person holding the link is shown before deciding.

    Names the workspace, the inviter and the address it was sent to, and nothing
    else — in particular not who else is a member. The recipient already knows
    their own address; everything here was in the email they were sent.
    """

    workspace_name: str
    role: Role
    email: str
    invited_by_name: str | None = None
    status: Literal["pending", "accepted", "declined", "revoked", "expired"]
    expires_at: datetime
    # Resolved server-side so the page can greet the right person without the
    # client having to compare addresses itself.
    signed_in_as: str | None = None
    email_matches: bool = False
    already_member: bool = False


class InviteAcceptResponse(BaseModel):
    workspace_id: str
    workspace_name: str
    role: Role


class BrandingAssetResponse(BaseModel):
    url: str
    kind: Literal["favicon", "logo"]


class WorkspaceDeleteRequest(BaseModel):
    """The workspace's own name, typed back. See `services.workspace.delete_workspace`."""

    confirm_name: str = Field(..., min_length=1, max_length=80)


class WorkspaceDeleteResponse(BaseModel):
    documents_released: int
    domains_removed: int
    members_removed: int
