from dataclasses import dataclass
from datetime import datetime


@dataclass
class Folder:
    """A place to put documents, scoped to one workspace.

    Organisation only: a folder never appears in a URL and never changes who can
    read a document. Moving a document between folders is a filing decision, not
    a permission one — which is what keeps this feature from quietly becoming an
    access-control system that nothing else in the codebase knows about.
    """

    id: str
    workspace_id: str
    name: str
    parent_id: str | None
    created_at: datetime
    updated_at: datetime
