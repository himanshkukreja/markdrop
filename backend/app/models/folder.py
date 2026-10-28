from dataclasses import dataclass
from datetime import datetime


@dataclass
class Folder:
    """A place to put documents, scoped to one workspace.

    Folders *do* appear in URLs -- a document filed under Data/Reports is served
    at ``/data/reports/<slug>`` on the workspace's own domain. They still do not
    change **who** can read a document: read access comes from the document's own
    password, expiry and workspace, exactly as before. Filing decides where a
    document appears and what its address is; it never decides who gets in.

    Keeping those two apart matters. The moment a folder grants or withholds
    access, there are two systems deciding who can read a document and the
    quieter one wins by accident.
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


FOLDER_DEFAULT_LEVELS = ("private", "workspace", "link")
