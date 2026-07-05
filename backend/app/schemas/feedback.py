"""Schemas for the bug-report / feature-request feature."""

from typing import Literal

from pydantic import BaseModel, Field


class FeedbackCreate(BaseModel):
    type: Literal["bug", "feature"]
    message: str = Field(..., min_length=3, max_length=4000)
    # Optional so anonymous visitors can submit without one; a follow-up address.
    email: str | None = Field(None, max_length=254)
    # The page the user was on when they opened the form (context for triage).
    page_url: str | None = Field(None, max_length=500)
