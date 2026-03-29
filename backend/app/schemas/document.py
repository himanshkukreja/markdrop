from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

MAX_CONTENT = 20_000


class DocumentCreate(BaseModel):
    title: str | None = Field(None, max_length=200)
    content: str = Field(..., min_length=1, max_length=MAX_CONTENT)
    custom_slug: str | None = Field(
        None,
        min_length=3,
        max_length=50,
        pattern=r"^[a-zA-Z0-9_-]+$",
    )
    expires_in: Literal["never", "1d", "7d", "30d", "custom"] = "never"
    custom_expires_at: datetime | None = None
    @model_validator(mode="after")
    def validate_custom_expiry(self):
        if self.expires_in == "custom" and self.custom_expires_at is None:
            raise ValueError("custom_expires_at is required when expires_in is 'custom'")
        return self


class DocumentUpdate(BaseModel):
    title: str | None = Field(None, max_length=200)
    content: str = Field(..., min_length=1, max_length=MAX_CONTENT)


class DocumentResponse(BaseModel):
    slug: str
    url: str
    title: str | None
    content: str
    created_at: datetime
    updated_at: datetime
    expires_at: datetime | None = None
    views: int = 0

    model_config = {"from_attributes": True}


class DocumentCreateResponse(DocumentResponse):
    edit_secret: str


