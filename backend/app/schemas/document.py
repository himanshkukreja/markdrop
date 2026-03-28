from datetime import datetime

from pydantic import BaseModel, Field


class DocumentCreate(BaseModel):
    content: str = Field(..., min_length=1, max_length=256 * 1024)


class DocumentUpdate(BaseModel):
    content: str = Field(..., min_length=1, max_length=256 * 1024)


class DocumentResponse(BaseModel):
    slug: str
    url: str
    content: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class DocumentCreateResponse(DocumentResponse):
    edit_secret: str
