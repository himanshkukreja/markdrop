from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

# Ordered by authority — `ROLE_RANK` turns "is this role enough?" into a
# comparison instead of a set of if-statements scattered across routers.
Role = Literal["owner", "admin", "member", "viewer"]
ROLE_RANK: dict[str, int] = {"viewer": 0, "member": 1, "admin": 2, "owner": 3}

# Background a workspace logo is drawn on. See `Branding.logo_well`.
LogoWell = Literal["light", "dark", "checker"]
LOGO_WELLS: tuple[str, ...] = ("light", "dark", "checker")


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
    # The surface the logo sits on. None means automatic: follow the reader's
    # theme. A fixed well exists for logos drawn for one background only (a
    # white wordmark disappears on Mist). Older rows have no key and read None.
    logo_well: LogoWell | None = None

    @classmethod
    def from_dict(cls, raw: dict | None) -> "Branding":
        raw = raw or {}
        return cls(
            site_name=raw.get("site_name"),
            favicon_url=raw.get("favicon_url"),
            logo_url=raw.get("logo_url"),
            accent_color=raw.get("accent_color"),
            hide_markdrop_branding=bool(raw.get("hide_markdrop_branding")),
            logo_well=raw.get("logo_well") if raw.get("logo_well") in LOGO_WELLS else None,
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
    # D3: only members and named grantees read anything filed here (never "any
    # signed-in account"), and every file's bytes are guarded.
    require_auth_to_view: bool = False
    # D2: may members (not only admins) share a folder as a link? Default yes.
    members_can_share_folders: bool = True
    # What the app preselects for "Who can open it" when filing here.
    default_access: Literal["link", "workspace", "private"] = "workspace"

    @classmethod
    def from_dict(cls, raw: dict | None) -> "WorkspaceSettings":
        raw = raw or {}
        chrome = raw.get("viewer_chrome")
        default_access = raw.get("default_access")
        return cls(
            viewer_chrome=chrome if chrome in ("full", "minimal", "none") else "full",
            require_auth_to_view=bool(raw.get("require_auth_to_view")),
            members_can_share_folders=bool(raw.get("members_can_share_folders", True)),
            default_access=default_access if default_access in ("link", "workspace", "private")
            else "workspace",
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
    # Set by the owner's delete before anything is released (C-N5): nothing
    # new may be filed, moved or created in it from then on.
    deleting: bool = False


@dataclass
class Membership:
    workspace_id: str
    user_id: str
    role: Role
    created_at: datetime
    # Denormalised so member lists don't need a second query per row.
    email: str | None = None
    name: str | None = None
