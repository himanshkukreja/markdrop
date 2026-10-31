"""Request bodies for /api/v1/docs-sites (routers/docs_sites.py, docs_site_pages.py).

Responses are plain dicts built by the services (docs_site_store.site_view,
docs_site_pages.page_view, …); the routes are app-internal and kept out of the
public OpenAPI schema.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.services.docs_site_templates import TEMPLATES

_GH_NAME = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$")
_GH_BRANCH = re.compile(r"^[A-Za-z0-9._/-]{1,200}$")
_HOST_LABEL = re.compile(r"^(?!-)[a-z0-9-]{1,63}(?<!-)$")
# A last label like these makes a browser (and Node's URL) read the whole host as an IPv4
# address: "127.1", "0x7f.0.0.1", "2130706433", "0177.0.0.1".
_NUMERIC_LABEL = re.compile(r"^(?:0x[0-9a-f]*|[0-9]+)$")
_PRIVATE_SUFFIXES = (".localhost", ".local", ".internal", ".intranet", ".lan", ".home.arpa", ".corp", ".arpa")


def public_https_url(url: str) -> bool:
    """A plain public https:// address: no IP address in any spelling, no credentials, the
    default port, a dotted DNS name that isn't a local one. Syntax only: where the name points
    is checked by the importer when it connects (frontend/scripts/docs-import/lib/guard.mjs)."""
    from urllib.parse import urlsplit

    if not isinstance(url, str) or any(c in url for c in "\\\x00\t\r\n "):
        return False
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return False
    if parts.scheme != "https" or "@" in parts.netloc or port not in (None, 443):
        return False
    host = (parts.hostname or "").rstrip(".")
    if not host or "[" in parts.netloc or ":" in host:
        return False
    try:
        host = host.encode("idna").decode("ascii").lower()
    except UnicodeError:
        return False
    labels = host.split(".")
    if len(labels) < 2 or not all(_HOST_LABEL.match(x) for x in labels) or _NUMERIC_LABEL.match(labels[-1]):
        return False
    return host != "localhost" and not host.endswith(_PRIVATE_SUFFIXES)


class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class GitHubRepo(_Body):
    owner: str = Field(..., min_length=1, max_length=100)
    name: str = Field(..., min_length=1, max_length=100)
    branch: str = Field("main", min_length=1, max_length=200)
    path: str = Field("/", max_length=300)

    @field_validator("owner", "name")
    @classmethod
    def _name(cls, v):
        if not _GH_NAME.match(v):
            raise ValueError("Not a valid GitHub name.")
        return v

    @field_validator("branch")
    @classmethod
    def _branch(cls, v):
        if not _GH_BRANCH.match(v) or ".." in v:
            raise ValueError("Not a valid branch name.")
        return v

    @field_validator("path")
    @classmethod
    def _path(cls, v):
        v = "/" + v.strip().strip("/")
        if ".." in v.split("/"):
            raise ValueError("Not a valid folder.")
        return v


class Source(_Body):
    kind: Literal["blank", "template", "gitbook", "github"] = "blank"
    template: Literal[TEMPLATES] | None = None  # type: ignore[valid-type]
    url: str | None = Field(None, max_length=2048)
    repo: GitHubRepo | None = None

    @model_validator(mode="after")
    def _by_kind(self):
        if self.kind == "template" and not self.template:
            raise ValueError(f"Choose a template: {', '.join(TEMPLATES)}.")
        if self.kind == "gitbook":
            url = (self.url or "").strip()
            if not public_https_url(url):
                raise ValueError("Give the public https:// address of your GitBook site.")
            self.url = url
        if self.kind == "github" and self.repo is None:
            raise ValueError("Choose a GitHub repository.")
        return self


class SiteCreate(_Body):
    workspace_id: str | None = None
    name: str = Field(..., min_length=1, max_length=80)
    slug: str = Field(..., min_length=1, max_length=60)
    source: Source = Field(default_factory=Source)


class SiteUpdate(_Body):
    name: str | None = Field(None, min_length=1, max_length=80)
    slug: str | None = Field(None, min_length=1, max_length=60)
    # Partial: merged onto the stored settings, then the whole is validated
    # (services/docs_site_settings.py). access.password (write-only) sets the
    # password; nav is changed with PUT /nav.
    settings: dict[str, Any] | None = None


class PageCreate(_Body):
    path: str = Field(..., min_length=1, max_length=200)
    title: str = Field(..., min_length=1, max_length=200)
    group: str | None = Field(None, max_length=80)
    after_page_id: str | None = None
    markdown: str = ""
    description: str = Field("", max_length=500)
    icon: str | None = Field(None, max_length=60)


class PageUpdate(_Body):
    base_rev: int
    markdown: str | None = None
    title: str | None = Field(None, max_length=200)
    description: str | None = Field(None, max_length=500)
    icon: str | None = Field(None, max_length=60)
    hidden: bool | None = None
    path: str | None = Field(None, max_length=200)
    frontmatter_extra: dict[str, Any] | None = None


class NavGroupIn(_Body):
    group: str = Field(..., min_length=1, max_length=80)
    pages: list[str] = Field(default_factory=list, max_length=1000)


class NavUpdate(_Body):
    nav: list[NavGroupIn] = Field(..., max_length=100)


class PublishRequest(_Body):
    note: str | None = Field(None, max_length=500)


class ReviewCreate(_Body):
    note: str | None = Field(None, max_length=2000)


class ReviewDecision(_Body):
    comment: str | None = Field(None, max_length=2000)


StudioRole = Literal["admin", "reviewer", "editor", "viewer", "none"]


class StudioRoleUpdate(_Body):
    """A Docs Studio role: for a workspace member ("none" removes it), or a site override
    ("none" hides the site from them)."""
    role: StudioRole


class StudioMemberRole(_Body):
    user_id: str = Field(..., min_length=1, max_length=64)
    role: StudioRole


class StudioMembersUpdate(_Body):
    members: list[StudioMemberRole] = Field(..., min_length=1, max_length=200)
