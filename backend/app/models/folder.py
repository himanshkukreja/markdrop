from dataclasses import dataclass
from datetime import datetime


@dataclass
class Folder:
    """A place to put documents, scoped to one workspace.

    Folders appear in URLs -- a document filed under Data/Reports is served at
    ``/data/reports/<slug>`` on the workspace's own domain.

    Since 2026-11-17 a folder may also say who can open what is inside
    (``access``: people, teams, restricted -- services/folder_access.py). That
    rule is evaluated inside the one access decision (services/access.py
    ``facts``), never by a second system: a folder's people and teams act like a
    share of every non-private item inside, and a restriction narrows them.
    """

    id: str
    workspace_id: str
    name: str
    parent_id: str | None
    created_at: datetime
    updated_at: datetime
    # URL segment, derived from the name. Unique among siblings, and never a
    # reserved word -- see `services.folder`.
    slug: str = ""
    # Folder share (D2): {id, level: "link"|"workspace", created_at, created_by}.
    # A share only *filters* — it never grants access to any document.
    share: dict | None = None
    # What new items filed here start as ("private" | "workspace" | "link");
    # None = the workspace's ``settings.default_access``. A preselection for
    # new items only: it never changes a document that is already filed.
    default_access: str | None = None
    # The workspace's Meetings folder (services/meetings.py): imported calls are filed here.
    meetings: bool = False
    # A subfolder of it (services/meeting_series.py): Meetings/<Series> or Meetings/Other meetings.
    meetings_sub: bool = False
    # Kept out of the file tree and browse (HubSpot's Deals folder and the deal folders in it,
    # services/hubspot_folders.py): reached from the team's Deals section; search still finds the items.
    hidden: bool = False


# "folder": the folder's people and teams (services/folder_access.py).
FOLDER_DEFAULT_LEVELS = ("private", "folder", "workspace", "link")
