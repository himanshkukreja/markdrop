from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.config import get_settings

MAX_CONTENT = get_settings().max_content_chars
# Sync carries artifacts as well as markdown, and an HTML file is routinely
# larger than a markdown note. The real limits are enforced in the sync handler
# (markdown: max_content_chars; artifacts: artifact.MAX_SYNC_BYTES, 25 MB) with a
# 413 the editor can show. This bound only has to sit above them: when it was
# 10M characters, an 11 MB HTML page failed validation with a bare 422 that
# echoed the whole file back. nginx caps the body at 32 MB before this.
MAX_SYNC_CONTENT = 32 * 1024 * 1024


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
    # Declares that `content`/`title` are already an AES-GCM envelope produced by
    # the client. The server never verifies this — it cannot, having no key — it
    # only records it so that every path which would read, render, export or
    # overwrite plaintext refuses instead of producing garbage.
    encrypted: bool = False
    # Who can open it, chosen at creation. "link" is the default and is what
    # every document has always been, so an unset field changes nothing.
    # "workspace" is only meaningful once the document is in one, which happens
    # after creation — the client sends it with the share step, not here.
    access_level: Literal["private", "link"] = "link"

    @model_validator(mode="after")
    def validate_custom_expiry(self):
        if self.expires_in == "custom" and self.custom_expires_at is None:
            raise ValueError("custom_expires_at is required when expires_in is 'custom'")
        if self.expires_in == "custom" and self.custom_expires_at is not None:
            from datetime import timedelta, timezone

            when = self.custom_expires_at
            if when.tzinfo is None:
                when = when.replace(tzinfo=timezone.utc)
            if when < datetime.now(timezone.utc) + timedelta(seconds=60):
                raise ValueError("custom_expires_at must be in the future")
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
    # Folder slugs from the root down, empty for anything not filed. A reader
    # arriving at /data/reports/<slug> is checked against this, so a document
    # answers only at the address that actually describes where it is filed.
    folder_path: list[str] = []
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
    # Opaque analytics reference (services/doc_ref.py), for every reader.
    ref: str | None = None
    google_doc_url: str | None = None
    google_doc_stale: bool = False  # True when the doc changed since last export
    # Public provenance flag: published/synced from the VS Code extension.
    vscode_synced: bool = False
    # End-to-end encrypted: `content` is ciphertext and only a client holding the
    # key from the URL fragment can render it.
    encrypted: bool = False
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
    # Video poster frame (raw image URL, signed when guarded) and ffprobe's
    # reading of a video or audio file; null until known.
    poster_url: str | None = None
    media: dict | None = None
    # ── Access policy additions (additive) ───────────────────────────────────
    # The document's address on its workspace's live primary domain, else null.
    workspace_url: str | None = None
    # How it is reachable ("link" | "private" | "workspace") and where it is filed.
    access_level: str = "link"
    workspace_id: str | None = None
    # What the caller may do, computed by access.can() so the client never
    # re-derives it: {edit, replace, settings, access, rename, delete, share,
    # move, unshare}.
    can: dict | None = None
    # HMAC ticket for the live socket (?t=) and the view/read beacons ("ticket"),
    # needed for any document an anonymous visitor could not read (§2.7).
    read_ticket: str | None = None
    # Bumped on every narrowing (services/publicity.py). Pages put it on the OG
    # image URL (`e=`) so a narrowed document's card is re-fetched (§5.1 #4).
    access_epoch: int = 0

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
    # The read ticket from GET /documents/{slug}; required (silently) for any
    # document an anonymous visitor could not read.
    ticket: str | None = Field(None, max_length=2048)
    # The page's own document.referrer, sent by the browser. The request's
    # Referer header can't be used: this beacon is fired *from* markdrop.in,
    # so that header only ever names markdrop.in.
    referrer: str | None = Field(None, max_length=2048)


class ReportRequest(BaseModel):
    reason: str | None = Field(None, max_length=500)


# ── Sync (VS Code extension) ───────────────────────────────────────────────────


class SyncCreateRequest(BaseModel):
    title: str | None = Field(None, max_length=200)
    content: str = Field(..., min_length=1, max_length=MAX_SYNC_CONTENT)
    # Preferred slug (e.g. the filename) — slugified server-side, auto-suffixed on clash.
    desired_slug: str | None = Field(None, max_length=100)


class SyncPushRequest(BaseModel):
    title: str | None = Field(None, max_length=200)
    content: str = Field(..., min_length=1, max_length=MAX_SYNC_CONTENT)
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
    # Only on rows the caller owns (A1): others never get the internal id.
    id: str | None = None
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
    # End-to-end encrypted: title and preview come back empty because the server
    # holds only ciphertext. The dashboard shows the slug and a badge instead.
    encrypted: bool = False
    # Artifacts (kind="artifact"): the dashboard shows type + size instead of a
    # markdown preview, since `content_preview` is only a filename stand-in.
    kind: str = "markdown"
    mime: str | None = None
    renderer: str | None = None
    type_label: str | None = None
    size_bytes: int | None = None
    original_filename: str | None = None
    # ── Workspace library ────────────────────────────────────────────────────
    # Null on a private document, which is every document by default. Present on
    # the owner's own dashboard too, so it can badge what is shared and with whom.
    workspace_id: str | None = None
    folder_id: str | None = None
    # Folder slugs from the root down. The document's address on its workspace's
    # own domain is these segments followed by the slug.
    folder_path: list[str] = []
    # Only filled in on the shared-library listing, where "whose is this?" is a
    # question the reader actually has. Never on a private listing, where the
    # answer is always "yours".
    # How the document is reachable, and how many people are named on it, so a
    # list row can state its access without a request per row.
    access_level: str = "link"
    shared_with_count: int = 0
    shared_by_name: str | None = None
    shared_by_email: str | None = None
    is_mine: bool = True


class MyDocListResponse(BaseModel):
    documents: list[MyDocListItem]
    total: int
    page: int
    pages: int
    # The page size actually applied (`per_page`, else `limit`).
    per_page: int = 20
    # Totals per kind, regardless of the active filter — the sidebar shows all
    # three at once, and three separate requests to render three numbers is
    # exactly the fan-out that tripped the API rate limit before.
    count_all: int = 0
    count_markdown: int = 0
    count_artifact: int = 0



class LibraryAddRequest(BaseModel):
    document_id: str
    folder_id: str | None = None


class LibraryFolderRequest(BaseModel):
    folder_id: str | None = None
