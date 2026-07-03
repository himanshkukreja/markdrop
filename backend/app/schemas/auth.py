from datetime import datetime

from pydantic import BaseModel, EmailStr, Field


class UserResponse(BaseModel):
    id: str
    email: str
    name: str | None = None
    picture: str | None = None
    providers: list[str] = []
    created_at: datetime


class TokenResponse(BaseModel):
    token: str
    expires_at: datetime
    user: UserResponse


class EmailRequest(BaseModel):
    email: EmailStr


class EmailVerifyRequest(BaseModel):
    email: EmailStr
    code: str


class NameUpdateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
