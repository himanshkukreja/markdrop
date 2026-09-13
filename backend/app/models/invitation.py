from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal

# An invitation is *pending* until someone resolves it. The three terminal
# states are kept apart rather than collapsed into "not pending" because the
# workspace admin needs to tell them apart: declined means the person said no,
# revoked means we withdrew it, accepted means they're in.
InviteStatus = Literal["pending", "accepted", "declined", "revoked"]

# Only roles below owner. A workspace has exactly one owner and it changes by
# transfer, never by invitation — see `services.workspace.set_member_role`.
InviteRole = Literal["admin", "member", "viewer"]


@dataclass
class Invitation:
    id: str
    workspace_id: str
    email: str  # always lower-cased; this is what acceptance is bound to
    role: InviteRole
    status: InviteStatus
    created_at: datetime
    expires_at: datetime
    invited_by_name: str | None = None
    invited_by_email: str | None = None
    responded_at: datetime | None = None

    @property
    def is_expired(self) -> bool:
        exp = self.expires_at
        if exp.tzinfo is None:  # Mongo hands back naive UTC
            exp = exp.replace(tzinfo=timezone.utc)
        return exp < datetime.now(timezone.utc)

    @property
    def effective_status(self) -> str:
        """What to show a human. Expiry is a fact about the clock rather than a
        state transition -- nothing writes "expired" to the database -- so it has
        to be derived on read, or a lapsed invite would read as still pending."""
        if self.status == "pending" and self.is_expired:
            return "expired"
        return self.status
