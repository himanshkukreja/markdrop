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


def slugify(name: str) -> str:
    """Turn an arbitrary string (e.g. a filename) into a slug candidate.

    Normalizes to a clean URL path: lowercases, and turns underscores (and any
    other non-alphanumeric char) into hyphens, then collapses/trims/truncates.
    So ``candidate_search_test_queries.md`` → ``candidate-search-test-queries``.
    May return "" (or a <3-char string) — callers should fall back to a random
    slug in that case.
    """
    s = re.sub(r"\.m(d|arkdown|dx)$", "", name.strip(), flags=re.IGNORECASE)  # drop .md/.mdx
    s = s.lower()                              # normalize case
    s = re.sub(r"[^a-z0-9]+", "-", s)          # underscores + anything else → hyphen
    s = re.sub(r"-{2,}", "-", s).strip("-")    # collapse + trim hyphens
    return s[:40].strip("-")
