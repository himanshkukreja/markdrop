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

