"""User authentication router — the optional-login feature.

Phase 0 ships the session primitives:
  - require_user / optional_user  FastAPI dependencies
  - GET  /api/v1/auth/me          current user profile
  - POST /api/v1/auth/logout      stateless (client drops the token)

Google (Phase 1) and email magic-link/OTP (Phase 2) endpoints are added to
this same router.
"""

import jwt
from fastapi import APIRouter, Depends, HTTPException, Request
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.database import get_database
from app.models.user import User
from app.schemas.auth import UserResponse
from app.services import user as user_service
from app.utils.auth import decode_access_token

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _bearer_token(request: Request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth.removeprefix("Bearer ").strip()
    return None


async def optional_user(request: Request) -> User | None:
    """Return the authenticated user, or None if no/invalid token is present.

    Never raises — for endpoints that behave differently when logged in
    (e.g. auto-claiming a document on create).
    """
    token = _bearer_token(request)
    if not token:
        return None
    try:
        payload = decode_access_token(token)
    except jwt.InvalidTokenError:
        return None
    user_id = payload.get("sub")
    if not user_id:
        return None
    return await user_service.get_user_by_id(get_database(), user_id)


async def require_user(request: Request) -> User:
    """Return the authenticated user or raise 401."""
    token = _bearer_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required")
    try:
        payload = decode_access_token(token)
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Session expired — please log in again")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid session token")

    user = await user_service.get_user_by_id(get_database(), payload.get("sub", ""))
    if user is None:
        raise HTTPException(status_code=401, detail="User no longer exists")
    return user


def _to_user_response(user: User) -> UserResponse:
    return UserResponse(
        id=user.id,
        email=user.email,
        name=user.name,
        picture=user.picture,
        providers=user.providers,
        created_at=user.created_at,
    )


@router.get("/me", response_model=UserResponse)
async def get_me(user: User = Depends(require_user)):
    return _to_user_response(user)


@router.post("/logout")
async def logout(_: User = Depends(require_user)):
    # Sessions are stateless JWTs; the client discards the token.
    # A server-side revocation list can be added in a hardening phase.
    return {"status": "ok"}
