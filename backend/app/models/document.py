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
    id: str | None = None  # str(_id); populated when the query includes _id

