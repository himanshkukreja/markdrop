from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

# A name whose address something already holds there: "error" (default) = 409
# saying what holds it; "suffix" = take the next free address (-2, -3…).
OnConflict = Literal["error", "suffix"]
ON_CONFLICT_HELP = ("When the folder's address is already taken where it goes: `error` (default) returns "
                    "409 saying what holds it; `suffix` takes the next free address (name-2, name-3…).")


class FolderCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    parent_id: str | None = None
    on_conflict: OnConflict = Field("error", description=ON_CONFLICT_HELP)


class FolderUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=80)
    # Distinguishes "don't touch the parent" from "move to the root", which a
    # plain optional field cannot express.
    parent_id: str | None = None
    reparent: bool = False
    on_conflict: OnConflict = Field("error", description=ON_CONFLICT_HELP)


class FolderResponse(BaseModel):
    id: str
    workspace_id: str
    name: str
    parent_id: str | None = None
    created_at: datetime
    updated_at: datetime
    # The URL segment for this folder, and the full path from the root. `path`
    # is what a link is built from, so callers never have to walk the tree.
    slug: str = ""
    path: list[str] = []


class FolderListResponse(BaseModel):
    folders: list[FolderResponse]


class FolderDeleteResponse(BaseModel):
    unfiled_documents: int
    # mode=trash (the default): what went to the trash with it (services/trash.py).
    trashed: bool = False
    trashed_documents: int = 0
    trashed_folders: int = 0


class DocumentMoveRequest(BaseModel):
    slug: str = Field(..., min_length=1, max_length=50)
    folder_id: str | None = None
