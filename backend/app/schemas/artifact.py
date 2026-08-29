"""Request/response models for artifacts (non-markdown shareable files)."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class ArtifactUploadUrlRequest(BaseModel):
    """Step 1 of the upload: ask for a presigned PUT."""

    filename: str = Field(..., min_length=1, max_length=255)
    content_type: str = Field(..., max_length=255)
    # Declared size; advisory only. The real size is verified against R2 after
    # the upload, because a presigned PUT can't enforce a length range.
    size_bytes: int = Field(..., ge=1)


class ArtifactUploadUrlResponse(BaseModel):
    upload_url: str
    blob_key: str
    mime: str
    # Echo the header the client MUST send — the presigned signature binds it.
    required_content_type: str
    expires_in: int


class ArtifactCreateRequest(BaseModel):
    """Step 2: confirm an uploaded blob and mint the shareable document."""

    blob_key: str = Field(..., min_length=1, max_length=300)
    title: str | None = Field(None, max_length=200)
    filename: str | None = Field(None, max_length=255)
    custom_slug: str | None = Field(
        None, min_length=3, max_length=50, pattern=r"^[a-zA-Z0-9_-]+$"
    )
    expires_in: Literal["never", "1d", "7d", "30d", "custom"] = "never"
    custom_expires_at: datetime | None = None
    read_password: str | None = Field(None, min_length=1, max_length=100)


class ArtifactPasteRequest(BaseModel):
    """Paste-an-HTML-page shortcut — no presigned round trip for small pages."""

    content: str = Field(..., min_length=1)
    title: str | None = Field(None, max_length=200)
    custom_slug: str | None = Field(
        None, min_length=3, max_length=50, pattern=r"^[a-zA-Z0-9_-]+$"
    )
    expires_in: Literal["never", "1d", "7d", "30d", "custom"] = "never"
    custom_expires_at: datetime | None = None
    read_password: str | None = Field(None, min_length=1, max_length=100)


class ArtifactResponse(BaseModel):
    slug: str
    url: str
    title: str | None
    kind: str = "artifact"
    mime: str
    renderer: str            # html | pdf | sheet | image | text | download
    type_label: str
    size_bytes: int
    original_filename: str | None = None
    # Sandbox-origin URL the viewer iframes. Carries a short-lived token when
    # the document is password-protected.
    artifact_url: str
    # Raw bytes for saving to disk — artifact_url may be a viewer page.
    download_url: str
    created_at: datetime
    updated_at: datetime
    expires_at: datetime | None = None
    views: int = 0
    is_password_protected: bool = False
    is_owner: bool = False


class ArtifactCreateResponse(ArtifactResponse):
    edit_secret: str


class ArtifactStatusResponse(BaseModel):
    """Drives UI gating — the feature stays hidden until R2 is wired up."""

    configured: bool
    origin_isolated: bool
    # False when running on a subdomain of the app: still safe from token
    # theft, but sharing domain reputation with markdrop.in. Surfaced so the
    # admin UI can nudge toward a separate site.
    origin_separate_site: bool = False
    max_file_bytes: int
    quota_bytes: int
    used_bytes: int = 0
    accepted_types: list[str] = []


class ArtifactSettingsRequest(BaseModel):
    """Owner-editable settings. Every field is optional — omitted means unchanged.

    Separate from ``DocumentUpdate`` because that schema requires ``content``,
    which an artifact doesn't have (its bytes live in R2).
    """

    title: str | None = Field(None, max_length=200)
    # "" clears the password; None leaves it alone.
    read_password: str | None = Field(None, max_length=100)
    remove_password: bool = False
    expires_in: Literal["never", "1d", "7d", "30d", "custom"] | None = None
    custom_expires_at: datetime | None = None


class ArtifactReplaceRequest(BaseModel):
    """Swap the underlying file while keeping the slug, password and expiry."""

    blob_key: str = Field(..., min_length=1, max_length=300)
    filename: str | None = Field(None, max_length=255)
