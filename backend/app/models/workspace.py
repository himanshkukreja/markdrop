from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

# Ordered by authority — `ROLE_RANK` turns "is this role enough?" into a
# comparison instead of a set of if-statements scattered across routers.
Role = Literal["owner", "admin", "member", "viewer"]
ROLE_RANK: dict[str, int] = {"viewer": 0, "member": 1, "admin": 2, "owner": 3}


def role_allows(actual: str | None, required: Role) -> bool:
    """Whether ``actual`` carries at least the authority of ``required``."""
    if actual is None:
        return False
    return ROLE_RANK.get(actual, -1) >= ROLE_RANK[required]


@dataclass
class Branding:
    """White-label surfaces. Every field is optional and falls back to Markdrop's
    own, so a workspace that sets nothing is indistinguishable from today."""

    site_name: str | None = None          # replaces "Markdrop" in titles + cards
    favicon_url: str | None = None        # document + artifact pages
    logo_url: str | None = None           # preview cards
    accent_color: str | None = None       # hex, e.g. "#3b82f6"
    hide_markdrop_branding: bool = False  # drop the wordmark from preview cards

    @classmethod
    def from_dict(cls, raw: dict | None) -> "Branding":
        raw = raw or {}
        return cls(
            site_name=raw.get("site_name"),
            favicon_url=raw.get("favicon_url"),
            logo_url=raw.get("logo_url"),
            accent_color=raw.get("accent_color"),
            hide_markdrop_branding=bool(raw.get("hide_markdrop_branding")),
        )


@dataclass
class WorkspaceSettings:
    """Behaviour toggles that only ever apply on a workspace's *own* domains.

    `viewer_chrome="none"` hides the control that leaves immersive mode, which is
    also the only route an anonymous visitor has to the Report action. That is
    acceptable on a domain whose owner is accountable for the content and has
    said so; it is never acceptable on markdrop.in, so the domain check is not
    optional — see `services/workspace.chrome_for`.
    """

    viewer_chrome: Literal["full", "minimal", "none"] = "full"
    require_auth_to_view: bool = False    # private CDN: no anonymous reads at all

    @classmethod
    def from_dict(cls, raw: dict | None) -> "WorkspaceSettings":
        raw = raw or {}
        chrome = raw.get("viewer_chrome")
        return cls(
            viewer_chrome=chrome if chrome in ("full", "minimal", "none") else "full",
            require_auth_to_view=bool(raw.get("require_auth_to_view")),
        )


@dataclass
class Workspace:
    id: str
    name: str
    owner_id: str
    created_at: datetime
    updated_at: datetime
    branding: Branding = field(default_factory=Branding)
    settings: WorkspaceSettings = field(default_factory=WorkspaceSettings)


@dataclass
class Membership:
    workspace_id: str
    user_id: str
    role: Role
    created_at: datetime
    # Denormalised so member lists don't need a second query per row.
    email: str | None = None
    name: str | None = None
