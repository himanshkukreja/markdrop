from typing import Literal
from datetime import datetime

from pydantic import BaseModel, EmailStr, Field


class UserResponse(BaseModel):
    id: str
    email: str
    name: str | None = None
    picture: str | None = None
    providers: list[str] = []
    created_at: datetime


class TokenResponse(BaseModel):
    token: str
    expires_at: datetime
    user: UserResponse


class EmailRequest(BaseModel):
    email: EmailStr


class EmailVerifyRequest(BaseModel):
    email: EmailStr
    code: str


class NameUpdateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)


# ── API tokens (VS Code extension / sync) ──────────────────────────────────────


class TokenCreateRequest(BaseModel):
    name: str = Field("API token", max_length=80)


class ApiTokenItem(BaseModel):
    id: str
    name: str
    prefix: str
    created_at: datetime
    last_used_at: datetime | None = None


class ApiTokenCreateResponse(ApiTokenItem):
    token: str  # raw token — shown only once


class ApiTokenListResponse(BaseModel):
    tokens: list[ApiTokenItem]


# ── Email campaigns (admin) ────────────────────────────────────────────────────


class AudiencePreviewRequest(BaseModel):
    audience: Literal["all", "with_documents", "with_artifacts", "recent", "custom"] = "all"
    recent_days: int = Field(30, ge=1, le=3650)
    emails: list[str] = Field(default_factory=list)


class AudiencePreviewResponse(BaseModel):
    count: int
    sample: list[str] = []


class CampaignCreateRequest(BaseModel):
    subject: str = Field(..., min_length=1, max_length=200)
    html: str = Field(..., min_length=1, max_length=400_000)
    # Kept separate from the login sender: a complaint about an announcement
    # shouldn't damage deliverability of the sign-in codes people need.
    sender: str | None = Field(None, max_length=200)
    audience: Literal["all", "with_documents", "with_artifacts", "recent", "custom"] = "all"
    recent_days: int = Field(30, ge=1, le=3650)
    emails: list[str] = Field(default_factory=list)


class CampaignTestRequest(BaseModel):
    subject: str = Field(..., min_length=1, max_length=200)
    html: str = Field(..., min_length=1, max_length=400_000)
    sender: str | None = Field(None, max_length=200)
    to_email: str = Field(..., max_length=200)


class CampaignItem(BaseModel):
    id: str
    subject: str
    audience: str
    status: str
    total: int = 0
    sent: int = 0
    failed: int = 0
    created_at: datetime
    finished_at: datetime | None = None


class CampaignListResponse(BaseModel):
    campaigns: list[CampaignItem]


class CampaignRenderRequest(BaseModel):
    subject: str = Field(..., min_length=1, max_length=200)
    html: str = Field(..., min_length=1, max_length=400_000)
    audience: Literal["all", "with_documents", "with_artifacts", "recent", "custom"] = "all"
    recent_days: int = Field(30, ge=1, le=3650)
    emails: list[str] = Field(default_factory=list)
    # How many rendered samples to return.
    limit: int = Field(3, ge=1, le=10)
    # Preview a single arbitrary address (the test-send path). Mirrors what
    # send_test does, so a test address that isn't a registered user still
    # previews instead of resolving to nobody.
    preview_email: str | None = Field(None, max_length=200)


class RenderedSample(BaseModel):
    email: str
    name: str | None = None
    html: str
    unsubscribe_url: str


class CampaignRenderResponse(BaseModel):
    total: int
    samples: list[RenderedSample]
