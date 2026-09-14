from datetime import datetime

from pydantic import BaseModel, Field


class FolderCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    parent_id: str | None = None


class FolderUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=80)
    # Distinguishes "don't touch the parent" from "move to the root", which a
    # plain optional field cannot express.
    parent_id: str | None = None
    reparent: bool = False


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


class DocumentMoveRequest(BaseModel):
    slug: str = Field(..., min_length=1, max_length=50)
    folder_id: str | None = None
