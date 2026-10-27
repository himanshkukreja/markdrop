"""Request/response models for the file upload and versions API (routers/files.py)."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

SLUG_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"


class UploadCreateRequest(BaseModel):
    file_name: str = Field(..., min_length=1, max_length=255)
    size_bytes: int = Field(..., ge=1)
    # Resolved with the file name against the artifact type registry, as the
    # web upload does; "application/octet-stream" falls back to the extension.
    content_type: str = Field("", max_length=255)
    sha256: str = Field(..., pattern=r"^[0-9a-fA-F]{64}$")
    # Replace the file behind this link instead of creating a new one.
    target_slug: str | None = Field(None, pattern=SLUG_PATTERN)
    title: str | None = Field(None, max_length=200)
    # New uploads only (a replaced file keeps its link's settings).
    access: Literal["link", "private", "password", "workspace"] | None = None
    password: str | None = Field(None, min_length=1, max_length=100)
    # Workspace id to file the upload into (the caller must be a member).
    workspace: str | None = Field(None, min_length=1, max_length=64)
    # Folder of that workspace: an id or a slug path like "guides/setup". It
    # must exist (folders are never created implicitly here).
    folder: str | None = Field(None, min_length=1, max_length=400)
    # New uploads only: a custom address (markdrop.in/<slug>). Taken or reserved
    # ⇒ 409 here, before a byte moves — never a silent rename. Default: derived
    # from the file name.
    slug: str | None = Field(None, min_length=3, max_length=50, pattern=r"^[a-zA-Z0-9_-]+$")


class UploadPartUrl(BaseModel):
    part_number: int
    url: str


class UploadSessionResponse(BaseModel):
    upload_id: str
    part_size: int
    parts: list[UploadPartUrl]
    expires_at: datetime


class UploadUrlsRequest(BaseModel):
    # Omitted or empty: every part R2 hasn't received yet.
    part_numbers: list[int] | None = Field(None, max_length=10_000)


class UploadedPart(BaseModel):
    part_number: int = Field(..., ge=1, le=10_000)
    etag: str = Field(..., min_length=1, max_length=200)


class UploadCompleteRequest(BaseModel):
    # Omitted or empty: use the parts R2 has received (the sha256 check still
    # guards what was stored).
    parts: list[UploadedPart] | None = Field(None, max_length=10_000)


class UploadResult(BaseModel):
    # The canonical address: the workspace's live custom domain when the file is
    # filed in one, else markdrop.in (same as markdrop_url).
    url: str
    markdrop_url: str | None = None
    workspace_url: str | None = None
    # Set when the upload asked for a workspace but couldn't be filed there at
    # commit (e.g. membership removed meanwhile). The file then stays private.
    workspace_error: str | None = None
    slug: str
    version: int
    size_bytes: int
    content_type: str
    sha256: str


class UploadPartStatus(BaseModel):
    part_number: int
    etag: str
    size: int


class UploadStatusResponse(BaseModel):
    upload_id: str
    # uploading | verifying | done | failed | expired | cancelled
    state: str
    file_name: str
    content_type: str
    size_bytes: int
    sha256: str
    part_size: int
    part_count: int
    parts_uploaded: list[UploadPartStatus]
    target_slug: str | None = None
    expires_at: datetime
    verified_bytes: int | None = None
    result: UploadResult | None = None
    error: str | None = None


class MediaInfo(BaseModel):
    duration_s: float | None = None
    width: int | None = None
    height: int | None = None
    video_codec: str | None = None
    audio_codec: str | None = None


class FileInfoResponse(BaseModel):
    slug: str
    url: str
    markdrop_url: str | None = None
    workspace_url: str | None = None
    title: str | None = None
    content_type: str
    size_bytes: int
    sha256: str | None = None
    version: int
    updated_at: datetime
    created_at: datetime
    media: MediaInfo | None = None
    poster_url: str | None = None
    download_url: str | None = None
    access: str


class FileVersion(BaseModel):
    version: int
    size_bytes: int
    sha256: str | None = None
    content_type: str
    created_at: datetime | None = None
    current: bool
    media: MediaInfo | None = None
    filename: str | None = None


class FileVersionsResponse(BaseModel):
    versions: list[FileVersion]
