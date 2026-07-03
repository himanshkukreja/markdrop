import re
import secrets

# Base58 alphabet — no 0, O, I, l to avoid confusion
ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

# Slugs that would collide with frontend routes / API paths. A user-chosen or
# changed slug may not be one of these (case-insensitive).
RESERVED_SLUGS = frozenset(
    {
        "admin", "share", "auth", "api", "login", "logout", "signup",
        "dashboard", "me", "new", "health", "settings", "account",
        "about", "terms", "privacy", "_next", "static", "favicon.ico",
        "robots.txt", "sitemap.xml",
    }
)

_SLUG_PATTERN = re.compile(r"^[a-zA-Z0-9_-]+$")


def generate_slug(length: int = 7) -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(length))


def is_reserved_slug(slug: str) -> bool:
    return slug.lower() in RESERVED_SLUGS


def is_valid_slug(slug: str) -> bool:
    return bool(_SLUG_PATTERN.match(slug)) and 3 <= len(slug) <= 50
