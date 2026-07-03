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

    # Passwordless email login via Resend (Phase 2)
    resend_api_key: str = ""
    email_from: str = "login@markdrop.in"
    email_from_name: str = "Markdrop"
    login_challenge_ttl_minutes: int = 15
    otp_length: int = 6
    login_max_attempts: int = 5

    # Analytics geo-IP (Phase 4) — MaxMind GeoLite2 City DB
    geoip_db_path: str = ""  # e.g. /opt/markdrop/geoip/GeoLite2-City.mmdb
    ip_hash_salt: str = "change-this-ip-hash-salt-in-production"

    model_config = {"env_file": ".env", "env_prefix": "MARKDROP_"}


@lru_cache
def get_settings() -> Settings:
    return Settings()
