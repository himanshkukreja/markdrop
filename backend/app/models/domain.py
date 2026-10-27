from dataclasses import dataclass
from datetime import datetime
from typing import Literal

# What a host is permitted to serve. This is a *declared behaviour*, never
# inferred from the hostname — cdn.acme.com may serve documents and
# docs.acme.com may serve artifacts if that is what the owner wants. The name is
# entirely theirs; the kind decides only what we will put on it.
#
#   "app"  — documents and the Markdrop UI. Sessions exist on this origin, so
#            user-authored HTML must never be served from it.
#   "cdn"  — artifacts only. No app, no login, no session to steal, which is
#            what makes it safe to serve arbitrary user HTML there.
#
# One host is one kind. A host that served both would put attacker-controlled
# HTML on an origin holding the customer's session — the single rule the whole
# architecture is built to preserve.
DomainKind = Literal["app", "cdn"]

# "lapsed": was verified, then its DNS stopped proving it (TXT or routing record
# gone) for long enough that it was taken off the air. Serves nothing until an
# admin checks it again and both records are back.
DomainStatus = Literal["pending", "verified", "failed", "lapsed"]


@dataclass
class Domain:
    id: str
    host: str                 # lowercase, no scheme, no port, no trailing dot
    workspace_id: str
    kind: DomainKind
    status: DomainStatus
    verification_token: str   # value of the _markdrop-verify TXT record
    created_at: datetime
    verified_at: datetime | None = None
    last_checked_at: datetime | None = None
    last_error: str | None = None
    # True once the host has been attached to the hosting project (Vercel) so
    # TLS is issued. Separate from `status`: DNS ownership and edge routing are
    # different facts and fail independently.
    attached: bool = False
    # Which of a workspace's verified app domains is *the* one: the host printed
    # on preview cards and used for the links the library hands out. A workspace
    # with several domains otherwise had its oldest one silently chosen for it.
    is_primary: bool = False
    # Lifecycle (services/domain_monitor.py). `failures` counts consecutive
    # failed re-checks since `first_failed_at`; a run of them spanning the lapse
    # window lapses the domain.
    failures: int = 0
    first_failed_at: datetime | None = None
    lapsed_at: datetime | None = None
    # Whether the routing record (CNAME to the edge target, or the apex A
    # record) was seen at the last check; None = never checked.
    routing_ok: bool | None = None
    # Pending rows only: when the unverified claim is dropped (TTL index).
    expires_at: datetime | None = None
