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
        # Artifact routes
        "artifacts", "artifact", "upload", "builder",
        # Tenant rewrite target (/h/<host>/<slug>). Unreachable anyway while
        # slugs are min 3 chars; reserved so that limit can change safely.
        "h",
        # Marketing page for custom domains and white-labelling. Reserved before
        # the page shipped, so a document can never shadow it.
        "enterprise",
        # Every other top-level frontend route (frontend/src/app). Without these
        # a document could claim /invite or /extension and shadow the real page
        # -- or worse, sit at an address people are trained to trust.
        "invite", "extension", "dev-preview", "dev-kit-frames",
        "dev-kit-publish", "dev-reading", "fonts", "icon.svg",
        # Static folders served from frontend/public at the top level.
        "email",
        # The MCP server's public page (/mcp) and the OAuth consent screen
        # (/oauth/consent). The API host serves /mcp and /oauth/* too, so a
        # document at either address would read like part of the sign-in flow.
        "mcp", "oauth",
        # Workspaces v2: shared folder pages (markdrop.in/f/<share id>) and the
        # in-app workspace view (/w/<workspace id>). Keep in sync with
        # services/traffic.py APP_ROUTES and frontend lib/analyticsPath.ts.
        "f", "w",
        # The analytics proxy (/mdp/*, frontend next.config.ts) skips the
        # middleware on every host, so neither a document nor a top-level
        # folder on a custom domain could ever be served there.
        "mdp",
        # Simpler workspaces UI: Shared with me, Recent, and the owner's
        # access-request page (/requests/<id>). Same lists as above.
        "shared", "recent", "requests",
        # Markdrop Guides (/guides, the guide builder) and its old address
        # (/docs-studio, a permanent redirect to /guides in next.config.ts).
        "guides", "docs-studio",
    }
)

# Reserved for documents (markdrop.in/<slug>) only. A workspace's own domain
# rewrites every path to its documents and folders and serves none of these app
# pages, so a top-level *folder* called "Shared", "Recent" or "Guides" (common
# names) shadows nothing and stays allowed.
APP_ONLY_SLUGS = frozenset({"shared", "recent", "requests", "guides"})

_SLUG_PATTERN = re.compile(r"^[a-zA-Z0-9_-]+$")


def generate_slug(length: int = 7) -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(length))


def is_reserved_slug(slug: str) -> bool:
    return slug.lower() in RESERVED_SLUGS


def is_reserved_folder_slug(slug: str) -> bool:
    """Top-level folder slugs: the document list minus the app-only pages."""
    value = slug.lower()
    return value in RESERVED_SLUGS and value not in APP_ONLY_SLUGS


def is_valid_slug(slug: str) -> bool:
    return bool(_SLUG_PATTERN.match(slug)) and 3 <= len(slug) <= 50


# A trailing file extension: at least one letter, so a version like "2.0" keeps
# its ".0" while "report.pdf" loses its ".pdf".
_EXT_RE = re.compile(r"\.[a-zA-Z][a-zA-Z0-9]{0,4}$")


def slugify(name: str) -> str:
    """Turn an arbitrary string (e.g. a filename) into a slug candidate.

    Normalizes to a clean URL path: drops a trailing file extension, folds
    accents to ASCII, lowercases, and turns underscores (and any other
    non-alphanumeric char) into hyphens, then collapses/trims/truncates. So
    ``candidate_search_test_queries.md`` → ``candidate-search-test-queries``
    and ``Q3 Report FINAL.pdf`` → ``q3-report-final``.

    May return "" (or a <3-char string) — callers should fall back to a random
    slug in that case.
    """
    import unicodedata

    s = _EXT_RE.sub("", name.strip())
    # Fold accents rather than dropping them: "résumé" should be "resume",
    # not "r-sum".
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    s = s.lower()                              # normalize case
    s = re.sub(r"[^a-z0-9]+", "-", s)          # underscores + anything else → hyphen
    s = re.sub(r"-{2,}", "-", s).strip("-")    # collapse + trim hyphens
    return s[:40].strip("-")
