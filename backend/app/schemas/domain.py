from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class DomainCreate(BaseModel):
    host: str = Field(..., min_length=3, max_length=253)
    # Declared behaviour, not a naming convention: any hostname may take either
    # kind. See models/domain.DomainKind.
    kind: Literal["app", "cdn"]


class DnsRecord(BaseModel):
    type: str
    name: str
    value: str


class DomainResponse(BaseModel):
    id: str
    host: str
    kind: Literal["app", "cdn"]
    status: Literal["pending", "verified", "failed", "lapsed"]
    created_at: datetime
    verified_at: datetime | None = None
    last_checked_at: datetime | None = None
    last_error: str | None = None
    attached: bool = False
    is_primary: bool = False
    # Everything the customer needs to paste into their DNS panel. Admins and
    # the owner only: for viewers and members these (and every other setup
    # detail below) are null, because the TXT value is the proof of ownership
    # and anyone holding it could re-claim the host elsewhere.
    dns_record_name: str | None = None
    dns_record_type: str | None = "TXT"
    dns_record_value: str | None = None
    dns_target_name: str | None = None
    dns_target_type: str | None = None
    dns_target_value: str | None = None
    # Surfaced rather than buried in docs: serving artifacts from a subdomain of
    # a site the customer uses for anything else is a real, if accepted, risk.
    warning: str | None = None
    # Lifecycle. `live` = verified and attached: the only state that serves,
    # receives tenant tokens and gets CORS. `routing_ok` = whether the routing
    # record was seen at the last check (None = never checked).
    live: bool = False
    routing_ok: bool | None = None
    # Whether the ownership TXT record was seen at the last check (None = never
    # checked). With `routing_ok` it tells the UI which record is missing.
    txt_ok: bool | None = None
    failures: int = 0
    first_failed_at: datetime | None = None
    lapsed_at: datetime | None = None
    # When a still-unverified claim is dropped.
    expires_at: datetime | None = None
    # The routing record(s) to add. One entry when we are sure whether the host
    # is an apex; both (A and CNAME) when we can't tell (e.g. an unlisted
    # second-level registry like example.co.xx), so the customer picks the one
    # their panel accepts. `dns_target_*` above is the first entry.
    apex_certain: bool | None = True
    dns_routing_options: list[DnsRecord] = []


class DomainListResponse(BaseModel):
    domains: list[DomainResponse]


class DnsProviderHint(BaseModel):
    """Who runs this domain's DNS, so the instructions can use their words.

    Everything is optional: an unrecognised provider falls back to the generic
    instructions, which is what every customer sees today.
    """

    detected: bool = False
    provider_id: str | None = None
    provider_name: str | None = None
    panel_url: str | None = None
    host_field: str | None = None
    # The two record names as this provider wants them typed -- relative to the
    # zone where that's what the panel expects, which is the single most common
    # way a correct value still ends up in the wrong place.
    record_host: str | None = None
    target_host: str | None = None
    note: str | None = None
    nameservers: list[str] = []


class HostResolution(BaseModel):
    """What the edge needs to render a request on a custom host."""

    host: str
    workspace_id: str
    kind: Literal["app", "cdn"]
    site_name: str | None = None
    favicon_url: str | None = None
    logo_url: str | None = None
    accent_color: str | None = None
    # Which well the tenant header puts the logo on (D38); None = follow the reader's theme.
    logo_well: Literal["light", "dark", "checker"] | None = None
    hide_markdrop_branding: bool = False
    viewer_chrome: Literal["full", "minimal", "none"] = "full"
    require_auth_to_view: bool = False
