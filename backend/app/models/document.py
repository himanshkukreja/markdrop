from dataclasses import dataclass
from datetime import datetime


@dataclass
class Document:
    slug: str
    content: str
    edit_secret_hash: str
    created_at: datetime
    updated_at: datetime
    title: str | None = None
    expires_at: datetime | None = None
    views: int = 0
    read_password_hash: str | None = None
    owner_id: str | None = None
    export_pdf_count: int = 0
    copy_url_count: int = 0
    rev: int = 1  # bumped on every content change; drives sync concurrency
    # Google Docs export link (optional). synced_rev records the doc `rev` that
    # was last pushed to Google, so the UI can tell when the Doc is stale.
    google_doc_id: str | None = None
    google_doc_url: str | None = None
    google_doc_synced_rev: int | None = None
    google_doc_synced_at: datetime | None = None
    # True once the document has been published or synced from the VS Code
    # extension — drives the "Synced with VS Code" badge on the doc + dashboard.
    vscode_synced: bool = False
    id: str | None = None  # str(_id); populated when the query includes _id

