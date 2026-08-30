from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    app_name: str = "Markdrop"
    debug: bool = False

    mongodb_uri: str = "mongodb://localhost:27017"
    mongodb_db: str = "markdrop"

    redis_url: str = "redis://localhost:6379"

    slug_length: int = 7
    slug_max_retries: int = 5
    max_content_chars: int = 500_000

    rate_limit_create: str = "10/minute"
    rate_limit_read: str = "60/minute"

    cors_origins: list[str] = ["http://localhost:3000"]

    # Public URL of the frontend — used for OAuth/email redirect links.
    frontend_url: str = "http://localhost:3000"
    # Public URL of this backend API — used to build the email magic-link.
    api_base_url: str = "http://localhost:8080"

    # Admin panel — override ALL THREE in production .env
    admin_username: str = "admin"
    admin_password: str = "changeme"
    admin_secret: str = "change-this-jwt-secret-in-production"  # JWT signing key

    # ── User authentication (optional login) ──────────────────────────────────
    # JWT signing key for USER sessions (separate from admin_secret). Override!
    auth_secret: str = "change-this-user-jwt-secret-in-production"
    access_token_ttl_hours: int = 24 * 30  # 30-day session tokens

    # Google OAuth 2.0 (Phase 1) — create a client at console.cloud.google.com
    google_client_id: str = ""
    google_client_secret: str = ""
    google_redirect_uri: str = "http://localhost:8080/api/v1/auth/google/callback"

    # Google Docs integration — a SEPARATE, opt-in OAuth flow (incremental auth)
    # that additionally requests the `drive.file` scope + offline access so we can
    # create/update Google Docs on the user's behalf. Register this redirect URI
    # in the same OAuth client. The encryption key protects refresh tokens at rest
    # (generate with: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())").
    google_docs_redirect_uri: str = "http://localhost:8080/api/v1/google/callback"
    token_encryption_key: str = ""  # Fernet key; REQUIRED for Google Docs in prod

    # Passwordless email login via Resend (Phase 2)
    resend_api_key: str = ""
    email_from: str = "login@markdrop.in"
    email_from_name: str = "Markdrop"
    # Where replies actually land. The From addresses are send-only mailboxes
    # with no inbox, so without this a reply — "I can't sign in", "unsubscribe
    # me" — is silently dropped. Override per environment via
    # MARKDROP_EMAIL_REPLY_TO.
    email_reply_to: str = "kukreja.him@gmail.com"
    login_challenge_ttl_minutes: int = 15
    otp_length: int = 6
    login_max_attempts: int = 5

    # ── Artifacts (HTML / PDF / spreadsheet hosting on Cloudflare R2) ─────────
    # Rendered artifacts are served from a SEPARATE ORIGIN, never markdrop.in.
    # User-authored HTML on our own origin could read the session token out of
    # localStorage and the edit secrets / read passwords out of sessionStorage,
    # so isolation here is a hard security requirement, not a nicety.
    r2_account_id: str = ""
    r2_access_key_id: str = ""
    r2_secret_access_key: str = ""
    r2_bucket: str = ""
    # Defaults to https://<account_id>.r2.cloudflarestorage.com when blank.
    r2_endpoint: str = ""
    # Public origin serving rendered artifacts (Cloudflare Worker + R2 binding),
    # e.g. https://markdropusercontent.com. MUST NOT be markdrop.in or a
    # subdomain of it — see `artifact_origin_is_isolated` below.
    artifact_origin: str = ""
    # HMAC key for the short-lived access tokens the Worker validates on
    # private (password-protected / unlisted) artifacts.
    artifact_signing_key: str = ""
    artifact_url_ttl_seconds: int = 900
    # Escape hatch: serve artifacts from a SUBDOMAIN of the app (e.g.
    # artifacts.markdrop.in). A subdomain is still a distinct origin, so it does
    # block the localStorage/sessionStorage theft — but it shares cookie scope
    # and, more importantly, shares domain reputation: phishing hosted there can
    # get markdrop.in itself flagged by Safe Browsing. Prefer a separate
    # registrable domain; *.workers.dev is on the Public Suffix List and counts
    # as one, for free. Must be set deliberately — the default stays safe.
    artifact_allow_subdomain_origin: bool = False
    # Quotas — R2's free tier is 10 GB, so cap both per-file and per-account.
    artifact_max_bytes: int = 25 * 1024 * 1024
    artifact_user_quota_bytes: int = 250 * 1024 * 1024
    # Presigned PUT validity. Short: the client uploads immediately.
    artifact_upload_ttl_seconds: int = 600

    @property
    def r2_endpoint_url(self) -> str:
        if self.r2_endpoint:
            return self.r2_endpoint.rstrip("/")
        return f"https://{self.r2_account_id}.r2.cloudflarestorage.com"

    @property
    def artifact_origin_is_separate_site(self) -> bool:
        """True when the artifact origin is a different *registrable* site.

        This is the strong form: different site means isolated cookies AND
        independent domain reputation, so a takedown lands on the artifact
        origin instead of the product. Note ``*.workers.dev`` / ``*.pages.dev``
        satisfy this for free — they're Public Suffix List entries, so each
        subdomain is its own site.
        """
        if not self.artifact_origin:
            return False
        from urllib.parse import urlparse

        art = (urlparse(self.artifact_origin).hostname or "").lower()
        app = (urlparse(self.frontend_url).hostname or "").lower()
        if not art or not app:
            return False
        base = ".".join(app.split(".")[-2:])  # markdrop.in
        return art != app and not art.endswith("." + base) and art != base

    @property
    def artifact_origin_is_isolated(self) -> bool:
        """Whether we'll serve artifacts from the configured origin at all.

        Always true for a separate site. For a subdomain of the app we require
        the operator to opt in explicitly, and we still refuse the app's own
        origin outright — serving user HTML there would expose the session
        token in localStorage, which no flag should be able to enable.
        """
        if not self.artifact_origin:
            return False
        if self.artifact_origin_is_separate_site:
            return True
        if not self.artifact_allow_subdomain_origin:
            return False
        from urllib.parse import urlparse

        art = (urlparse(self.artifact_origin).hostname or "").lower()
        app = (urlparse(self.frontend_url).hostname or "").lower()
        # A subdomain is permitted under the flag; the exact same host never is.
        return bool(art) and art != app

    @property
    def artifacts_configured(self) -> bool:
        return bool(
            self.r2_account_id
            and self.r2_access_key_id
            and self.r2_secret_access_key
            and self.r2_bucket
            and self.artifact_origin
            and self.artifact_signing_key
        )

    # Analytics geo-IP (Phase 4) — MaxMind GeoLite2 City DB
    geoip_db_path: str = ""  # e.g. /opt/markdrop/geoip/GeoLite2-City.mmdb
    ip_hash_salt: str = "change-this-ip-hash-salt-in-production"

    model_config = {"env_file": ".env", "env_prefix": "MARKDROP_"}


@lru_cache
def get_settings() -> Settings:
    return Settings()
