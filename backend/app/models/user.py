from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class User:
    id: str  # stringified Mongo ObjectId
    email: str
    created_at: datetime
    updated_at: datetime
    name: str | None = None
    picture: str | None = None
    google_sub: str | None = None
    providers: list[str] = field(default_factory=list)
    last_login_at: datetime | None = None
    # Encrypted Google OAuth refresh token (Fernet). Present only when the user
    # has opted into the Google Docs integration. Never expose this over the API.
    google_refresh_token_enc: str | None = None
    # Weekly analytics digest: "weekly" (the default) or "off".
    analytics_digest: str = "weekly"
    # An email when someone mentions you or asks for your sign-off (services/notifications.py).
    mention_emails: bool = True
    # How often those emails come, per kind: instant | hourly | daily | off (notifications.email_modes).
    email_notify: dict = field(default_factory=lambda: {"mention": "hourly", "signoff_requested": "instant"})
