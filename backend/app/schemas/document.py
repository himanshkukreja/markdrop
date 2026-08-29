from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.config import get_settings

MAX_CONTENT = get_settings().max_content_chars


class DocumentCreate(BaseModel):
    title: str | None = Field(None, max_length=200)
    content: str = Field(..., min_length=1, max_length=MAX_CONTENT)
    custom_slug: str | None = Field(
        None,
        min_length=3,
        max_length=50,
        pattern=r"^[a-zA-Z0-9_-]+$",
    )
    expires_in: Literal["never", "1d", "7d", "30d", "custom"] = "never"
    custom_expires_at: datetime | None = None
    read_password: str | None = Field(None, min_length=1, max_length=100)

    @model_validator(mode="after")
    def validate_custom_expiry(self):
        if self.expires_in == "custom" and self.custom_expires_at is None:
            raise ValueError("custom_expires_at is required when expires_in is 'custom'")
        return self


class DocumentUpdate(BaseModel):
    title: str | None = Field(None, max_length=200)
    content: str = Field(..., min_length=1, max_length=MAX_CONTENT)
    # Optional: update or clear the read password. Empty string = remove password.
    read_password: str | None = Field(None, max_length=100)
    remove_password: bool = False
    # Optional: update expiry. None = don't change. "never" = clear expiry.
    expires_in: Literal["never", "1d", "7d", "30d", "custom"] | None = None
    custom_expires_at: datetime | None = None


class DocumentResponse(BaseModel):
    slug: str
    url: str
    title: str | None
    content: str
    created_at: datetime
    updated_at: datetime
    expires_at: datetime | None = None
    views: int = 0
    is_password_protected: bool = False
    is_owned: bool = False   # document has been claimed by some account
    is_owner: bool = False   # the requesting user owns this document
    # Owner-only fields (null/false for everyone else) — power the Google Docs
    # sync button on the document page.
    id: str | None = None
    google_doc_url: str | None = None
    google_doc_stale: bool = False  # True when the doc changed since last export
    # Public provenance flag: published/synced from the VS Code extension.
    vscode_synced: bool = False
    # ── Artifacts ────────────────────────────────────────────────────────────
    # For kind="artifact" the body lives in R2 and renders on the isolated
    # artifact origin; `content` is not the document. All null for markdown.
    kind: str = "markdown"
    mime: str | None = None
    renderer: str | None = None
    type_label: str | None = None
    size_bytes: int | None = None
    original_filename: str | None = None
    artifact_url: str | None = None
    download_url: str | None = None

    model_config = {"from_attributes": True}


class DocumentCreateResponse(DocumentResponse):
    edit_secret: str


class DocumentCopyRequest(BaseModel):
    # Only needed when copying a password-protected source the caller has
    # unlocked; the copy itself is always created WITHOUT a password.
    read_password: str | None = Field(None, max_length=100)


class SlugChangeRequest(BaseModel):
    new_slug: str = Field(..., min_length=3, max_length=50, pattern=r"^[a-zA-Z0-9_-]+$")


class EventRequest(BaseModel):
    type: Literal["view", "export_pdf", "copy_url"]


class ReportRequest(BaseModel):
    reason: str | None = Field(None, max_length=500)


# ── Sync (VS Code extension) ───────────────────────────────────────────────────


class SyncCreateRequest(BaseModel):
    title: str | None = Field(None, max_length=200)
    content: str = Field(..., min_length=1, max_length=MAX_CONTENT)
    # Preferred slug (e.g. the filename) — slugified server-side, auto-suffixed on clash.
    desired_slug: str | None = Field(None, max_length=100)


class SyncPushRequest(BaseModel):
    title: str | None = Field(None, max_length=200)
    content: str = Field(..., min_length=1, max_length=MAX_CONTENT)
    base_rev: int = Field(..., ge=0)


class SyncDocResponse(BaseModel):
    id: str
    slug: str
    url: str
    title: str | None
    content: str
    rev: int
    updated_at: datetime


class SyncRevResponse(BaseModel):
    id: str
    rev: int
    updated_at: datetime


class MyDocListItem(BaseModel):
    id: str
    slug: str
    url: str
    title: str | None
    content_preview: str
    created_at: datetime
    updated_at: datetime
    expires_at: datetime | None = None
    views: int = 0
    export_pdf_count: int = 0
    copy_url_count: int = 0
    is_password_protected: bool = False
    # Google Docs export state
    google_doc_url: str | None = None
    google_doc_stale: bool = False  # True when the doc changed since last export
    vscode_synced: bool = False
    # Artifacts (kind="artifact"): the dashboard shows type + size instead of a
    # markdown preview, since `content_preview` is only a filename stand-in.
    kind: str = "markdown"
    mime: str | None = None
    renderer: str | None = None
    type_label: str | None = None
    size_bytes: int | None = None
    original_filename: str | None = None


class MyDocListResponse(BaseModel):
    documents: list[MyDocListItem]
    total: int
    page: int
    pages: int

