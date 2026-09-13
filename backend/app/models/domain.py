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

DomainStatus = Literal["pending", "verified", "failed"]


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
