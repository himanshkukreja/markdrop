from dataclasses import dataclass
from datetime import datetime
from typing import Literal

# How a document is reachable by people who were not named on it individually.
#
# `link` is what every document has always been and remains the default: anyone
# holding the URL can read it. The others narrow that, and none of them widen
# it — a named grant is the only thing that adds a reader, and it is layered on
# top rather than replacing the level.
AccessLevel = Literal["private", "link", "workspace"]

# What a named person may do. Deliberately only two: "can read" and "can also
# change the text" are the two questions people actually have. Anything finer
# (comment, suggest, re-share only) is a permission system, and a publishing
# tool that grows one by accident ends up with two systems deciding who can read
# a document and the quieter one winning.
GrantRole = Literal["viewer", "editor"]

ROLE_RANK: dict[str, int] = {"viewer": 0, "editor": 1}


def role_allows(actual: str | None, required: GrantRole) -> bool:
    if actual is None:
        return False
    return ROLE_RANK.get(actual, -1) >= ROLE_RANK[required]


@dataclass
class Grant:
    """One person's access to one document.

    Keyed on **email**, not on a user id, because the person being shared with
    very often has no account yet. Access therefore begins the moment they are
    signed in as that address — whether the account existed beforehand or was
    created afterwards. That removes the entire accept/decline dance: there is
    nothing to accept, because proving the address *is* the acceptance.

    `user_id` is filled in opportunistically the first time a matching account
    reads the document, purely so listings can show a name instead of an email.
    """

    id: str
    document_id: str
    email: str  # always lower-cased
    role: GrantRole
    created_at: datetime
    granted_by_email: str | None = None
    user_id: str | None = None
    # Whether a notification was actually sent, so the UI can say "invited" vs
    # "added quietly" rather than implying an email that never left.
    notified: bool = False
